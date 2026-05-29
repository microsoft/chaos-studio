<#
.SYNOPSIS
    Fan-out wrapper that queries every Azure Monitor surface relevant to a
    chaos run (metrics, logs, activity log, alerts, service health) and
    returns a single structured signal bundle.

.DESCRIPTION
    All ARM / Log Analytics traffic goes through `Invoke-AzRest`. The function
    performs five independent fan-outs:

      1. Metrics       — one GET per resource, throttled to 4 in parallel.
                         Metric name list pulled from
                         `templates/metrics/defaults.json` keyed by resource
                         type; resources without a defaults entry skip metrics.
      2. Logs (KQL)    — one POST per workspace, throttled to 4 in parallel.
                         Token resource = https://api.loganalytics.io.
                         Resources without a workspace mapping are flagged
                         `unavailable` (caller continues with metrics-only).
      3. Activity Log  — one GET per unique resource (Activity Log $filter
                         only supports a single `resourceUri eq ''` clause).
      4. Alerts        — single subscription-scoped GET; pinned to
                         `2023-05-01-preview`; falls back to `2018-05-05`
                         when the preview surface returns 4xx.
      5. ServiceHealth — single subscription-scoped GET on
                         `Microsoft.ResourceHealth/events`.

    Every per-call error is captured as a coverage marker; this function
    never throws on a partial-discovery failure — the caller decides whether
    to exit nonzero.

.PARAMETER ResourceIds
    Already-deduped, already-capped (MaxResources) set of parent ARM IDs.

.PARAMETER WorkspaceMap
    Hashtable output of Get-DiagnosticSettings.ps1 (resourceId.ToLower() →
    @{ workspaceId; status; reason; ... }).

.PARAMETER ActionWindows
    Array of @{ ActionName; Start; End; TargetResourceIds }. Used to compute
    the overall fan-out window (min Start − buffer, max End + buffer).

.PARAMETER Buffer
    ISO-8601 duration (default PT5M).

.PARAMETER SubscriptionId
    Subscription used for the subscription-scoped calls (alerts, service health,
    activity log).

.PARAMETER MaxRows
    KQL row cap injected into the templated queries. Default 500.

.PARAMETER ThrottleLimit
    Parallelism cap for metrics + logs fan-out. Default 4 (matches Constants).

.OUTPUTS
    [hashtable] with shape:
        @{
          metrics  = @( @{resourceId; metricName; dataPoints=@(@{timeStamp; average; maximum})} )
          logs     = @( @{workspaceId; rows=@(...); kql; status?} )
          activity = @( @{resourceId; events=@(...)} )
          alerts   = @( @{name; severity; firedTime; targetResourceId} )
          health   = @( @{title; eventType; startTime; affectedRegions=@(...)} )
          coverage = @{
            logsAvailableFor      = @(...)
            logsUnavailableFor    = @(...)
            logsUnavailableReason = @{ resourceId = reason }
          }
        }
#>

# ═══════════════════════════════════════════════════════
# Pure helpers (testable in isolation; no ARM calls)
# ═══════════════════════════════════════════════════════

function Test-IsApiVersionError {
    <#
    .SYNOPSIS
        Returns $true only when the exception/error message looks like an
        API-version rejection (HTTP 400/404 with API-version text, or the
        well-known InvalidApiVersionParameter / NoRegisteredProviderFound
        ARM error codes). All other errors (401/403/429/5xx/network) → $false
        so the caller propagates them instead of silently falling back.
    #>
    [CmdletBinding()]
    param([Parameter()][string]$Message)
    if (-not $Message) { return $false }
    $m = $Message
    if ($m -match '(?i)\bInvalidApiVersionParameter\b') { return $true }
    if ($m -match '(?i)\bNoRegisteredProviderFound\b')  { return $true }
    if ($m -match '(?i)api[ -]?version')                { return $true }
    if ($m -match '(?i)\b(400|404)\b' -and $m -match '(?i)(unsupported|invalid|not.*found|api)') { return $true }
    return $false
}

function Get-ArmResourceType {
    <#
    .SYNOPSIS
        Extracts the canonical 'Provider/typeSegment[/sub...]' from an ARM ID.
        Returns $null when the ID does not contain /providers/.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$ResourceId)
    if ($ResourceId -notmatch '/providers/(?<rest>.+)$') { return $null }
    $segs = $Matches['rest'] -split '/'
    if ($segs.Count -lt 2) { return $null }
    $parts = @($segs[0], $segs[1])
    for ($i = 3; $i -lt $segs.Count; $i += 2) { $parts += $segs[$i] }
    return ($parts -join '/')
}

function Get-DefaultMetricNames {
    <#
    .SYNOPSIS
        Returns the metric-name list for a resource type from MetricDefaults
        (hashtable OR PSCustomObject). Empty array when the type is missing.
    #>
    [CmdletBinding()]
    param(
        [Parameter()]$MetricDefaults,
        [Parameter()][string]$ResourceType
    )
    if (-not $MetricDefaults -or -not $ResourceType) { return @() }
    $entry = $null
    if ($MetricDefaults -is [System.Collections.IDictionary]) {
        if ($MetricDefaults.Contains($ResourceType)) { $entry = $MetricDefaults[$ResourceType] }
    } else {
        $p = $MetricDefaults.PSObject.Properties[$ResourceType]
        if ($p) { $entry = $p.Value }
    }
    if (-not $entry) { return @() }
    $names = if ($entry -is [System.Collections.IDictionary]) { $entry['metrics'] } else { $entry.metrics }
    return @($names)
}

function Get-LogsCoverage {
    <#
    .SYNOPSIS
        Splits ResourceIds into (available, unavailable) plus a reason map and
        a workspaceId → [resourceIds] grouping for the per-workspace KQL fan-out.
        Pure — no ARM calls.
    .OUTPUTS
        [pscustomobject] with .available, .unavailable, .reasons, .workspaceToIds.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][AllowEmptyCollection()][string[]]$ResourceIds,
        [Parameter()][hashtable]$WorkspaceMap
    )
    if (-not $WorkspaceMap) { $WorkspaceMap = @{} }
    $available = @(); $unavailable = @(); $reasons = @{}
    $wsToIds = @{}
    foreach ($id in $ResourceIds) {
        $key = $id.ToLowerInvariant()
        $entry = $WorkspaceMap[$key]
        if ($entry -and $entry.status -eq 'available' -and $entry.workspaceId) {
            $available += $id
            if (-not $wsToIds.ContainsKey($entry.workspaceId)) { $wsToIds[$entry.workspaceId] = @() }
            $wsToIds[$entry.workspaceId] += $id
        } else {
            $unavailable += $id
            $reasons[$id] = if ($entry) { $entry.reason } else { 'not_queried' }
        }
    }
    return [pscustomobject]@{
        available      = $available
        unavailable    = $unavailable
        reasons        = $reasons
        workspaceToIds = $wsToIds
    }
}

function New-UnavailableLogMarker {
    <#
    .SYNOPSIS
        Builds the `status='unavailable'` marker object for a resource with
        no usable workspace mapping.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$ResourceId,
        [Parameter()][string]$Reason
    )
    return [pscustomobject]@{
        workspaceId = $null
        rows        = @()
        kql         = $null
        status      = 'unavailable'
        resourceId  = $ResourceId
        reason      = if ($Reason) { $Reason } else { 'not_queried' }
    }
}

function Invoke-AlertsWithFallback {
    <#
    .SYNOPSIS
        Calls AlertsManagement first with the pinned preview API; falls back
        to the stable API ONLY when the preview call fails with an
        API-version error. Any other failure (auth, throttling, 5xx, network)
        propagates to the caller — we never silently mask non-version errors.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Uri,
        [Parameter(Mandatory)][string]$PreviewApi,
        [Parameter(Mandatory)][string]$FallbackApi,
        [Parameter()][scriptblock]$Invoker  # test seam; defaults to Invoke-AzRest
    )
    $call = if ($Invoker) { $Invoker } else { { param($u, $v) Invoke-AzRest -Method GET -Uri $u -ApiVersion $v } }
    try {
        return & $call $Uri $PreviewApi
    } catch {
        if (Test-IsApiVersionError -Message $_.Exception.Message) {
            [Console]::Error.WriteLine("[Get-MonitorSignals] alerts preview API rejected; falling back to $FallbackApi")
            return & $call $Uri $FallbackApi
        }
        throw
    }
}

function Get-MonitorSignals {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [AllowEmptyCollection()]
        [string[]]$ResourceIds,

        [Parameter()]
        [hashtable]$WorkspaceMap,

        [Parameter()]
        [AllowEmptyCollection()]
        [array]$ActionWindows,

        [Parameter()]
        [string]$Buffer = 'PT5M',

        [Parameter(Mandatory)]
        [string]$SubscriptionId,

        [Parameter()]
        [int]$MaxRows = 500,

        [Parameter()]
        [int]$ThrottleLimit
    )

    . "$PSScriptRoot/Constants.ps1"
    $sharedDir = Join-Path (Split-Path (Split-Path $PSScriptRoot)) '_shared'
    . (Join-Path $sharedDir 'Invoke-AzRest.ps1')

    if (-not $PSBoundParameters.ContainsKey('ThrottleLimit')) {
        $ThrottleLimit = $script:ChaosImpactDefault_DiagThrottleLimit
    }
    if (-not $WorkspaceMap) { $WorkspaceMap = @{} }

    # ── Window math ─────────────────────────────────────
    $bufferSpan = [System.Xml.XmlConvert]::ToTimeSpan($Buffer)
    $allStarts = @(); $allEnds = @()
    foreach ($w in @($ActionWindows)) {
        if ($w.Start) { $allStarts += [DateTime]::Parse($w.Start, $null, [System.Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime() }
        if ($w.End)   { $allEnds   += [DateTime]::Parse($w.End,   $null, [System.Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime() }
    }
    if ($allStarts.Count -eq 0 -or $allEnds.Count -eq 0) {
        throw "Get-MonitorSignals: ActionWindows must contain at least one window with Start and End."
    }
    $globalStart = ($allStarts | Measure-Object -Minimum).Minimum.Add(-$bufferSpan)
    $globalEnd   = ($allEnds   | Measure-Object -Maximum).Maximum.Add($bufferSpan)
    $tStartIso = $globalStart.ToString("yyyy-MM-ddTHH:mm:ssZ")
    $tEndIso   = $globalEnd.ToString("yyyy-MM-ddTHH:mm:ssZ")
    $timespan  = "$tStartIso/$tEndIso"

    # ── Load metric defaults ────────────────────────────
    $defaultsPath = Join-Path (Split-Path $PSScriptRoot) 'templates/metrics/defaults.json'
    $metricDefaults = @{}
    if (Test-Path $defaultsPath) {
        $metricDefaults = Get-Content $defaultsPath -Raw | ConvertFrom-Json
    }

    function _GetResourceType { param([string]$Id) return Get-ArmResourceType -ResourceId $Id }
    function _GetMetricNames  { param($Defaults, [string]$Type) return Get-DefaultMetricNames -MetricDefaults $Defaults -ResourceType $Type }

    # ═══════════════════════════════════════════════════════
    # 1. Metrics fan-out
    # ═══════════════════════════════════════════════════════
    $metricsApi = $script:ChaosImpactApi_Metrics
    $invokeAzRestPath = Join-Path $sharedDir 'Invoke-AzRest.ps1'

    $metricJobs = @()
    foreach ($id in $ResourceIds) {
        $rtype = _GetResourceType -Id $id
        $names = _GetMetricNames -Defaults $metricDefaults -Type $rtype
        if ($names.Count -eq 0) { continue }
        $metricJobs += [pscustomobject]@{ resourceId = $id; names = $names }
    }

    $metricsResults = @()
    if ($metricJobs.Count -gt 0) {
        $metricsResults = $metricJobs | ForEach-Object -ThrottleLimit $ThrottleLimit -Parallel {
            $job = $_
            . $using:invokeAzRestPath
            $api = $using:metricsApi
            $span = $using:timespan
            $rid = $job.resourceId
            $nameList = ($job.names -join ',')
            $uri = "$rid/providers/Microsoft.Insights/metrics" +
                   "?metricnames=$([uri]::EscapeDataString($nameList))" +
                   "&timespan=$([uri]::EscapeDataString($span))" +
                   "&interval=PT1M" +
                   "&aggregation=Average,Maximum"
            $out = @()
            try {
                $resp = Invoke-AzRest -Method GET -Uri $uri -ApiVersion $api
                foreach ($metric in @($resp.body.value)) {
                    $dp = @()
                    foreach ($ts in @($metric.timeseries)) {
                        foreach ($d in @($ts.data)) {
                            $dp += [pscustomobject]@{
                                timeStamp = $d.timeStamp
                                average   = $d.average
                                maximum   = $d.maximum
                            }
                        }
                    }
                    $out += [pscustomobject]@{
                        resourceId = $rid
                        metricName = if ($metric.name -and $metric.name.value) { $metric.name.value } else { $metric.name }
                        dataPoints = $dp
                    }
                }
            } catch {
                [Console]::Error.WriteLine("[Get-MonitorSignals] metrics error for $rid : $($_.Exception.Message)")
            }
            $out
        }
        $metricsResults = @($metricsResults)
    }

    # ═══════════════════════════════════════════════════════
    # 2. Logs (KQL) fan-out
    # ═══════════════════════════════════════════════════════
    $logsCoverage = Get-LogsCoverage -ResourceIds $ResourceIds -WorkspaceMap $WorkspaceMap
    $logsAvailable        = $logsCoverage.available
    $logsUnavailable      = $logsCoverage.unavailable
    $logsUnavailableReason = $logsCoverage.reasons
    $workspaceToIds       = $logsCoverage.workspaceToIds

    $logsTemplatePath = Join-Path (Split-Path $PSScriptRoot) 'templates/kql/resource-logs.kql'
    $errSpikeTemplatePath = Join-Path (Split-Path $PSScriptRoot) 'templates/kql/error-spike.kql'
    $logsTemplate = if (Test-Path $logsTemplatePath) { Get-Content $logsTemplatePath -Raw } else { $null }
    $errSpikeTemplate = if (Test-Path $errSpikeTemplatePath) { Get-Content $errSpikeTemplatePath -Raw } else { $null }

    # Baseline window for error-spike template.
    $baseStart = ($allStarts | Measure-Object -Minimum).Minimum.Add(-$bufferSpan + -$bufferSpan)
    $baseEnd   = ($allStarts | Measure-Object -Minimum).Minimum.Add(-$bufferSpan)
    $baseStartIso = $baseStart.ToString("yyyy-MM-ddTHH:mm:ssZ")
    $baseEndIso   = $baseEnd.ToString("yyyy-MM-ddTHH:mm:ssZ")

    $logResults = @()
    foreach ($wsId in $workspaceToIds.Keys) {
        $ids = $workspaceToIds[$wsId]
        $idsJson = ($ids | ForEach-Object { '"' + $_ + '"' }) -join ','
        $idsJson = "[$idsJson]"

        $kql = $logsTemplate
        if ($kql) {
            $kql = $kql.Replace('{resourceIdsJson}', $idsJson).Replace('{tStart}', $tStartIso).Replace('{tEnd}', $tEndIso)
            # MaxRows: replace `| take 500` if MaxRows differs.
            if ($MaxRows -ne 500) { $kql = $kql -replace 'take 500', "take $MaxRows" }
        }

        $errKql = $errSpikeTemplate
        if ($errKql) {
            $errKql = $errKql.Replace('{resourceIdsJson}', $idsJson).Replace('{tStart}', $tStartIso).Replace('{tEnd}', $tEndIso).Replace('{baseStart}', $baseStartIso).Replace('{baseEnd}', $baseEndIso)
        }

        foreach ($q in @(@{ kql = $kql }, @{ kql = $errKql })) {
            if (-not $q.kql) { continue }
            $body = @{ query = $q.kql; timespan = "$tStartIso/$tEndIso" }
            $uri = "$($script:ChaosImpactEndpoint_LogAnalytics)/v1/workspaces/$wsId/query"
            try {
                # NOTE: Invoke-AzRest currently passes --resource https://management.azure.com.
                # We invoke `az rest` directly so we can request a Log Analytics-scoped token.
                $bodyJson = $body | ConvertTo-Json -Depth 8 -Compress
                $tmp = [System.IO.Path]::GetTempFileName()
                [System.IO.File]::WriteAllText($tmp, $bodyJson, [System.Text.UTF8Encoding]::new($false))
                try {
                    $raw = & az rest --method POST --uri $uri `
                        --resource $script:ChaosImpactEndpoint_LogAnalytics `
                        --headers 'Content-Type=application/json' `
                        --body "@$tmp" --output json 2>&1
                    if ($LASTEXITCODE -ne 0) { throw ($raw -join "`n") }
                    $parsed = ($raw -join "`n") | ConvertFrom-Json
                } finally {
                    Remove-Item $tmp -Force -ErrorAction SilentlyContinue
                }
                $rows = @()
                foreach ($table in @($parsed.tables)) {
                    $cols = @($table.columns | ForEach-Object { $_.name })
                    foreach ($r in @($table.rows)) {
                        $row = [ordered]@{}
                        for ($i = 0; $i -lt $cols.Count; $i++) { $row[$cols[$i]] = $r[$i] }
                        $rows += [pscustomobject]$row
                    }
                }
                $logResults += [pscustomobject]@{
                    workspaceId = $wsId
                    rows        = $rows
                    kql         = $q.kql
                    status      = 'ok'
                }
            } catch {
                [Console]::Error.WriteLine("[Get-MonitorSignals] LA query failed for $wsId : $($_.Exception.Message)")
                $logResults += [pscustomobject]@{
                    workspaceId = $wsId
                    rows        = @()
                    kql         = $q.kql
                    status      = "error:$($_.Exception.Message)"
                }
            }
        }
    }
    # Markers for resources without a workspace mapping.
    foreach ($id in $logsUnavailable) {
        $logResults += New-UnavailableLogMarker -ResourceId $id -Reason $logsUnavailableReason[$id]
    }

    # ═══════════════════════════════════════════════════════
    # 3. Activity Log — one call per unique resourceUri
    # ═══════════════════════════════════════════════════════
    $activityApi = $script:ChaosImpactApi_ActivityLog
    $activityResults = @()
    if ($ResourceIds.Count -gt 0) {
        $activityResults = $ResourceIds | ForEach-Object -ThrottleLimit $ThrottleLimit -Parallel {
            $rid = $_
            . $using:invokeAzRestPath
            $api = $using:activityApi
            $sub = $using:SubscriptionId
            $s = $using:tStartIso
            $e = $using:tEndIso
            $filter = "eventTimestamp ge '$s' and eventTimestamp le '$e' and resourceUri eq '$rid'"
            $uri = "/subscriptions/$sub/providers/Microsoft.Insights/eventtypes/management/values" +
                   "?`$filter=$([uri]::EscapeDataString($filter))"
            try {
                $resp = Invoke-AzRest -Method GET -Uri $uri -ApiVersion $api
                [pscustomobject]@{ resourceId = $rid; events = @($resp.body.value) }
            } catch {
                [Console]::Error.WriteLine("[Get-MonitorSignals] activity-log error for $rid : $($_.Exception.Message)")
                [pscustomobject]@{ resourceId = $rid; events = @() }
            }
        }
        $activityResults = @($activityResults)
    }

    # ═══════════════════════════════════════════════════════
    # 4. Alerts — single subscription-scoped GET
    # ═══════════════════════════════════════════════════════
    $alertsResults = @()
    try {
        $alertsUri = "/subscriptions/$SubscriptionId/providers/Microsoft.AlertsManagement/alerts" +
                     "?timeRange=custom&customTimeRange=$([uri]::EscapeDataString("$tStartIso/$tEndIso"))"
        $resp = Invoke-AlertsWithFallback `
            -Uri              $alertsUri `
            -PreviewApi       $script:ChaosImpactApi_AlertsManagement `
            -FallbackApi      $script:ChaosImpactApi_AlertsManagementFallback
        foreach ($a in @($resp.body.value)) {
            $essentials = $a.properties.essentials
            $alertsResults += [pscustomobject]@{
                name             = $a.name
                severity         = $essentials.severity
                firedTime        = $essentials.startDateTime
                targetResourceId = $essentials.targetResource
            }
        }
    } catch {
        [Console]::Error.WriteLine("[Get-MonitorSignals] alerts error: $($_.Exception.Message)")
    }

    # ═══════════════════════════════════════════════════════
    # 5. Service Health — single subscription-scoped GET
    # ═══════════════════════════════════════════════════════
    $healthResults = @()
    try {
        $healthFilter = "eventType eq 'ServiceIssue' and impactStartTime ge '$tStartIso'"
        $healthUri = "/subscriptions/$SubscriptionId/providers/Microsoft.ResourceHealth/events" +
                     "?`$filter=$([uri]::EscapeDataString($healthFilter))"
        $resp = Invoke-AzRest -Method GET -Uri $healthUri -ApiVersion $script:ChaosImpactApi_ResourceHealth
        foreach ($e in @($resp.body.value)) {
            $p = $e.properties
            $healthResults += [pscustomobject]@{
                title           = $p.title
                eventType       = $p.eventType
                startTime       = $p.impactStartTime
                affectedRegions = @($p.impact | ForEach-Object { $_.impactedService })
            }
        }
    } catch {
        [Console]::Error.WriteLine("[Get-MonitorSignals] service-health error: $($_.Exception.Message)")
    }

    return @{
        metrics  = $metricsResults
        logs     = $logResults
        activity = $activityResults
        alerts   = $alertsResults
        health   = $healthResults
        coverage = @{
            logsAvailableFor      = $logsAvailable
            logsUnavailableFor    = $logsUnavailable
            logsUnavailableReason = $logsUnavailableReason
        }
    }
}
