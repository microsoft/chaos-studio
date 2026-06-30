<#
.SYNOPSIS
    Phase E of the chaos-impact pipeline — renders the Markdown report card
    and the JSON sidecar from the correlation engine's in-memory model.

.DESCRIPTION
    Consumes the output of `Build-ImpactCorrelation.ps1` (Phase D) plus the
    coverage / queries / errors metadata from `Get-MonitorSignals.ps1`
    (Phase C) and the raw ScenarioRun resource, then emits two artifacts:

      - impact-<runId>.md    Markdown report (human-readable)
      - impact-<runId>.json  JSON sidecar    (conforms to
                              schema/impact-report.schema.json, version 1)

    Both files are written atomically (temp + rename) using the same
    discipline as State.ps1, so concurrent re-runs cannot leave partial
    artifacts behind. On any error the temp files are removed.

    Dot-source-detection: when sourced for testing (`. ./New-ImpactReport.ps1`)
    the main body is skipped so the helper functions can be tested in
    isolation. When invoked normally (`& ./New-ImpactReport.ps1 -...`) the
    main body runs and writes both artifacts.

.PARAMETER CorrelationResult
    Output of `Build-ImpactCorrelation.ps1`. Array of per-action result
    objects with .actionName, .startedAt, .completedAt, .windowSource,
    .targetedResources, and .signals.{chaosAttributed, baseline,
    unexplained, platformEvent}.

.PARAMETER ScenarioRunId
    The run identifier (used in the filename and report header).

.PARAMETER ScenarioRun
    The raw ScenarioRun resource (for run-level metadata: properties.status,
    properties.startedAt, properties.completedAt, etc.).

.PARAMETER Coverage
    Coverage hashtable. Shape mirrors what Invoke-ChaosImpact.ps1 already
    builds: resourcesTotal, resourcesSampled, skippedDueToCap, maxResources,
    logsAvailableFor, logsUnavailableFor, logsUnavailableReason.

.PARAMETER Queries
    Hashtable @{ kql = @(...); metrics = @(...) } describing the queries
    issued by Phase C (used for the queries[] section of the JSON sidecar).

.PARAMETER Errors
    Optional array of error records / strings to surface in the report.

.PARAMETER OutputDir
    Destination directory (will be created if absent).

.PARAMETER Format
    'markdown', 'json', or 'both' (default 'both').

.PARAMETER Buffer
    ISO-8601 duration used as the correlation buffer (rendered in the header).

.PARAMETER WorkspaceContext
    Optional [ordered]@{subscriptionId; resourceGroup; name} hashtable used
    in the report header / sidecar's workspace block. When omitted, falls
    back to fields parsed from the ScenarioRun.id.

.PARAMETER ScenarioContext
    Optional @{name; version} hashtable for the scenario block. Falls back
    to parsing the ScenarioRun.id when omitted.

.OUTPUTS
    [pscustomobject] with .markdownPath and .jsonPath of the written files.
    Both paths may be $null when -Format excludes the corresponding
    artifact.
#>
[CmdletBinding()]
param(
    [Parameter()]$CorrelationResult,
    [Parameter()][string]$ScenarioRunId,
    [Parameter()]$ScenarioRun,
    [Parameter()]$Coverage,
    [Parameter()]$Queries,
    [Parameter()]$Errors = @(),
    [Parameter()][string]$OutputDir,
    [Parameter()][ValidateSet('markdown', 'json', 'both')]
    [string]$Format = 'both',
    [Parameter()][string]$Buffer = 'PT5M',
    [Parameter()]$WorkspaceContext,
    [Parameter()]$ScenarioContext
)

# ═══════════════════════════════════════════════════════
# Helpers (testable in isolation)
# ═══════════════════════════════════════════════════════

function Write-AtomicFile {
    <#
    .SYNOPSIS
        Atomically writes $Content to $Path using the same temp + rename
        pattern as Save-State (skills/_shared/State.ps1). Leaves no .tmp
        files behind on failure.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Content
    )
    $tempPath = "$Path.tmp.$([System.IO.Path]::GetRandomFileName())"
    try {
        $Content | Out-File -FilePath $tempPath -Encoding utf8 -NoNewline
        Move-Item -Path $tempPath -Destination $Path -Force
    } catch {
        if (Test-Path $tempPath) {
            Remove-Item $tempPath -Force -ErrorAction SilentlyContinue
        }
        throw
    }
}

function Get-WorkspaceContextFromRun {
    <#
    .SYNOPSIS
        Parses subscriptionId / resourceGroup / workspaceName out of a
        ScenarioRun resource ID. Returns nulls when the ID is missing or
        malformed.
    #>
    [CmdletBinding()]
    param([Parameter()]$ScenarioRun)
    $ctx = [ordered]@{ subscriptionId = ''; resourceGroup = ''; name = '' }
    if (-not $ScenarioRun -or -not $ScenarioRun.id) { return $ctx }
    if ($ScenarioRun.id -match '/subscriptions/(?<sub>[^/]+)/resourceGroups/(?<rg>[^/]+)/providers/Microsoft\.Chaos/workspaces/(?<ws>[^/]+)') {
        $ctx.subscriptionId = $Matches['sub']
        $ctx.resourceGroup  = $Matches['rg']
        $ctx.name           = $Matches['ws']
    }
    return $ctx
}

function Get-ScenarioContextFromRun {
    <#
    .SYNOPSIS
        Parses scenario name (and version when available) out of the
        ScenarioRun resource ID / properties.
    #>
    [CmdletBinding()]
    param([Parameter()]$ScenarioRun)
    $ctx = [ordered]@{ name = '' }
    if (-not $ScenarioRun) { return $ctx }
    if ($ScenarioRun.id -and $ScenarioRun.id -match '/scenarios/(?<scen>[^/]+)') {
        $ctx.name = $Matches['scen']
    }
    if ($ScenarioRun.properties -and $ScenarioRun.properties.scenarioVersion) {
        $ctx.version = "$($ScenarioRun.properties.scenarioVersion)"
    }
    return $ctx
}

function Test-RunIsPartial {
    <#
    .SYNOPSIS
        Returns $true when the ScenarioRun is still in flight (status =
        Running / Pending / Provisioning / Cancelling), which means the
        report covers an incomplete window.
    #>
    [CmdletBinding()]
    param([Parameter()]$ScenarioRun)
    if (-not $ScenarioRun -or -not $ScenarioRun.properties) { return $false }
    $status = "$($ScenarioRun.properties.status)"
    if (-not $status) { return $false }
    return ($status -in @('Running', 'Pending', 'Provisioning', 'Cancelling'))
}

function Get-ShortResourceId {
    <#
    .SYNOPSIS
        Returns the trailing 2 path segments of an ARM ID (e.g.
        '.../virtualMachines/vmA' → 'virtualMachines/vmA') for compact
        Markdown table rendering. Falls back to the full ID when the input
        is too short.
    #>
    [CmdletBinding()]
    param([Parameter()][string]$ResourceId)
    if (-not $ResourceId) { return '' }
    $segs = $ResourceId -split '/'
    if ($segs.Count -lt 2) { return $ResourceId }
    return ($segs[-2] + '/' + $segs[-1])
}

function ConvertTo-ImpactReportModel {
    <#
    .SYNOPSIS
        Pure transform: builds the schema-conforming in-memory model used
        by both the JSON and Markdown emitters. Centralising this means a
        single point of change when the schema evolves.
    #>
    [CmdletBinding()]
    param(
        [Parameter()][AllowNull()]$CorrelationResult,
        [Parameter()][string]$ScenarioRunId,
        [Parameter()][AllowNull()]$ScenarioRun,
        [Parameter()][AllowNull()]$Coverage,
        [Parameter()][AllowNull()]$Queries,
        [Parameter()][AllowNull()]$Errors,
        [Parameter()][string]$Buffer = 'PT5M',
        [Parameter()][AllowNull()]$WorkspaceContext,
        [Parameter()][AllowNull()]$ScenarioContext
    )

    $ws = if ($WorkspaceContext) { $WorkspaceContext } else { Get-WorkspaceContextFromRun -ScenarioRun $ScenarioRun }
    $sc = if ($ScenarioContext)  { $ScenarioContext }  else { Get-ScenarioContextFromRun  -ScenarioRun $ScenarioRun }

    $startedAt   = if ($ScenarioRun -and $ScenarioRun.properties) { $ScenarioRun.properties.startedAt }   else { $null }
    $completedAt = if ($ScenarioRun -and $ScenarioRun.properties) { $ScenarioRun.properties.completedAt } else { $null }

    $actions = @()
    foreach ($a in @($CorrelationResult)) {
        if (-not $a) { continue }
        $sigs = [ordered]@{
            chaosAttributed = @($a.signals.chaosAttributed)
            baseline        = @($a.signals.baseline)
            unexplained     = @($a.signals.unexplained)
        }
        if ($a.signals.PSObject.Properties['platformEvent'] -or
            ($a.signals -is [System.Collections.IDictionary] -and $a.signals.Contains('platformEvent'))) {
            $sigs.platformEvent = @($a.signals.platformEvent)
        }
        $actions += [ordered]@{
            name              = "$($a.actionName)"
            startedAt         = $a.startedAt
            completedAt       = $a.completedAt
            windowSource      = if ($a.windowSource) { "$($a.windowSource)" } else { 'unknown' }
            targetedResources = @($a.targetedResources)
            signals           = $sigs
        }
    }

    $cov = if ($Coverage -is [System.Collections.IDictionary]) { $Coverage } else { @{} }
    $coverageBlock = [ordered]@{
        resourcesTotal        = if ($cov.Contains('resourcesTotal'))   { [int]$cov['resourcesTotal'] }   else { 0 }
        resourcesSampled      = if ($cov.Contains('resourcesSampled')) { [int]$cov['resourcesSampled'] } else { 0 }
        skippedDueToCap       = @($cov['skippedDueToCap'])
        maxResources          = if ($cov.Contains('maxResources')) { [int]$cov['maxResources'] } else { 0 }
        logsAvailableFor      = @($cov['logsAvailableFor'])
        logsUnavailableFor    = @($cov['logsUnavailableFor'])
        logsUnavailableReason = if ($cov['logsUnavailableReason']) { $cov['logsUnavailableReason'] } else { @{} }
    }

    $queriesBlock = [ordered]@{
        kql     = @()
        metrics = @()
    }
    if ($Queries) {
        $kql = if ($Queries -is [System.Collections.IDictionary]) { $Queries['kql'] } else { $Queries.kql }
        $metrics = if ($Queries -is [System.Collections.IDictionary]) { $Queries['metrics'] } else { $Queries.metrics }
        # Normalise: every entry must be an object so the schema check passes.
        $queriesBlock.kql = @(@($kql) | Where-Object { $_ } | ForEach-Object {
            if ($_ -is [System.Collections.IDictionary] -or $_ -is [pscustomobject]) { $_ } else { @{ raw = "$_" } }
        })
        $queriesBlock.metrics = @(@($metrics) | Where-Object { $_ } | ForEach-Object {
            if ($_ -is [System.Collections.IDictionary] -or $_ -is [pscustomobject]) { $_ } else { @{ raw = "$_" } }
        })
    }

    return [ordered]@{
        impactReportSchemaVersion = 1
        generatedAt   = (Get-Date).ToUniversalTime().ToString('o')
        scenarioRunId = "$ScenarioRunId"
        workspace     = [ordered]@{
            subscriptionId = "$($ws.subscriptionId)"
            resourceGroup  = "$($ws.resourceGroup)"
            name           = "$($ws.name)"
        }
        scenario      = [ordered]@{
            name    = "$($sc.name)"
            version = if ($sc.version) { "$($sc.version)" } else { $null }
        }
        window        = [ordered]@{
            startedAt   = $startedAt
            completedAt = $completedAt
            bufferIso   = $Buffer
            partial     = (Test-RunIsPartial -ScenarioRun $ScenarioRun)
        }
        actions       = $actions
        coverage      = $coverageBlock
        queries       = $queriesBlock
        errors        = @($Errors)
    }
}

function ConvertTo-ImpactReportMarkdown {
    <#
    .SYNOPSIS
        Renders the schema model as a Markdown report. Pure-function; no I/O.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)]$Model, [Parameter()][string]$Buffer = 'PT5M')

    $md = @()
    $scenarioName = if ($Model.scenario.name) { $Model.scenario.name } else { '<unknown>' }
    $runStatus = '—'
    $md += "# Chaos Impact Report — $scenarioName / run $($Model.scenarioRunId)"
    $md += ''
    $md += "**Run window**: $($Model.window.startedAt) → $($Model.window.completedAt)   (buffer ±$Buffer)"
    $md += "**Workspace**: $($Model.workspace.resourceGroup)/$($Model.workspace.name)    **Resources targeted**: $($Model.coverage.resourcesTotal)"
    $md += ''
    if ($Model.window.partial) {
        $md += '> ⚠️ Partial report — the run was still in progress at generation time. Re-run after completion for a final view.'
        $md += ''
    }

    # ── Summary ──
    $chaosCount = 0; $baseCount = 0; $unexCount = 0; $platCount = 0
    $chaosResources = @{}
    foreach ($a in @($Model.actions)) {
        $chaosCount += @($a.signals.chaosAttributed).Count
        $baseCount  += @($a.signals.baseline).Count
        $unexCount  += @($a.signals.unexplained).Count
        if ($a.signals.platformEvent) { $platCount += @($a.signals.platformEvent).Count }
        foreach ($s in @($a.signals.chaosAttributed)) {
            if ($s.resourceId) { $chaosResources[$s.resourceId] = $true }
        }
    }
    $md += '## Summary'
    $md += ''
    $md += "- **$(@($Model.actions).Count)** action(s)."
    $md += "- **$chaosCount** chaos-attributed signal(s) across **$($chaosResources.Count)** resource(s)."
    $md += "- **$baseCount** baseline signal(s) (suppressed from per-action sections)."
    $md += "- **$unexCount** unexplained signal(s) — review recommended."
    if ($platCount -gt 0) {
        $md += "- **$platCount** platform event(s) (Azure Service Health)."
    }
    $md += ''

    # ── Per-action sections ──
    $idx = 0
    foreach ($a in @($Model.actions)) {
        $idx++
        $md += "## Action $idx — $($a.name) ($($a.startedAt) → $($a.completedAt))"
        $md += ''
        if (@($a.targetedResources).Count -gt 0) {
            $md += "**Targeted resources** ($(@($a.targetedResources).Count)):"
            foreach ($t in @($a.targetedResources)) { $md += ('- `' + $t + '`') }
            $md += ''
        }
        $md += '### Chaos-attributed signals'
        $md += ''
        if (@($a.signals.chaosAttributed).Count -eq 0) {
            $md += '*No chaos-attributed signals detected for this action.*'
        } else {
            $md += '| Resource | Signal | Type | Value | Severity | Rationale |'
            $md += '|---|---|---|---|---|---|'
            foreach ($s in @($a.signals.chaosAttributed)) {
                $short = Get-ShortResourceId -ResourceId $s.resourceId
                $rationale = if ($s.rationale) { ($s.rationale -replace '\|', '\|') } else { '' }
                $md += ('| `' + $short + '` | ' + $s.name + ' | ' + $s.signalType + ' | ' + $s.value + ' | **' + $s.severity + '** | ' + $rationale + ' |')
            }
        }
        $md += ''

        if (@($a.signals.unexplained).Count -gt 0) {
            $md += "### Unexplained signals (this action's window)"
            $md += ''
            $md += '| Resource | Signal | Type | Value | Severity |'
            $md += '|---|---|---|---|---|'
            foreach ($s in @($a.signals.unexplained)) {
                $short = Get-ShortResourceId -ResourceId $s.resourceId
                $md += ('| `' + $short + '` | ' + $s.name + ' | ' + $s.signalType + ' | ' + $s.value + ' | ' + $s.severity + ' |')
            }
            $md += ''
        }
    }

    # ── Cross-action unexplained summary ──
    $md += '## Unexplained Signals'
    $md += ''
    if ($unexCount -eq 0) {
        $md += '*None.*'
    } else {
        $md += "Aggregated $unexCount unexplained signal(s) across all action windows. See per-action sections above for details."
    }
    $md += ''

    # ── Platform events ──
    if ($platCount -gt 0) {
        $md += '## Platform Events'
        $md += ''
        $md += '| Action | Event | Type | Time |'
        $md += '|---|---|---|---|'
        foreach ($a in @($Model.actions)) {
            foreach ($s in @($a.signals.platformEvent)) {
                $md += "| $($a.name) | $($s.name) | $($s.value) | $($s.timestamp) |"
            }
        }
        $md += ''
    }

    # ── Coverage / Caveats ──
    $md += '## Coverage / Caveats'
    $md += ''
    $md += "- Resources sampled: $($Model.coverage.resourcesSampled) / $($Model.coverage.resourcesTotal) (cap: $($Model.coverage.maxResources))."
    $md += "- Log signals available for $(@($Model.coverage.logsAvailableFor).Count) / $($Model.coverage.resourcesSampled) sampled resources."
    if (@($Model.coverage.logsUnavailableFor).Count -gt 0) {
        $md += "- $(@($Model.coverage.logsUnavailableFor).Count) resource(s) without usable diagnostic settings — metrics-only correlation:"
        foreach ($id in @($Model.coverage.logsUnavailableFor)) {
            $reasonMap = $Model.coverage.logsUnavailableReason
            $reason = $null
            if ($reasonMap) {
                if ($reasonMap -is [System.Collections.IDictionary]) {
                    if ($reasonMap.Contains($id)) { $reason = $reasonMap[$id] }
                } else {
                    $p = $reasonMap.PSObject.Properties[$id]
                    if ($p) { $reason = $p.Value }
                }
            }
            if (-not $reason) { $reason = 'unknown' }
            $md += ('  - `' + $id + '` — reason: ' + $reason)
        }
    }
    if (@($Model.coverage.skippedDueToCap).Count -gt 0) {
        $md += "- $(@($Model.coverage.skippedDueToCap).Count) resource(s) exceeded MaxResources and were not sampled."
    }
    $md += ''

    # ── Errors ──
    if (@($Model.errors).Count -gt 0) {
        $md += '## Errors'
        $md += ''
        foreach ($e in @($Model.errors)) {
            $md += "- $e"
        }
        $md += ''
    }

    return ($md -join "`n")
}

function ConvertTo-ImpactReportJson {
    <#
    .SYNOPSIS
        Serialises the schema model to compact-but-readable JSON. Pure-function.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)]$Model)
    return ($Model | ConvertTo-Json -Depth 32)
}

# ═══════════════════════════════════════════════════════
# Entry point (skipped when dot-sourced for tests)
# ═══════════════════════════════════════════════════════

if ($MyInvocation.InvocationName -eq '.') { return }

if (-not $ScenarioRunId) { throw "New-ImpactReport.ps1: -ScenarioRunId is required." }
if (-not $OutputDir)     { throw "New-ImpactReport.ps1: -OutputDir is required." }

if (-not (Test-Path $OutputDir)) {
    New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null
}
$OutputDir = (Resolve-Path $OutputDir).Path

$model = ConvertTo-ImpactReportModel `
    -CorrelationResult $CorrelationResult `
    -ScenarioRunId     $ScenarioRunId `
    -ScenarioRun       $ScenarioRun `
    -Coverage          $Coverage `
    -Queries           $Queries `
    -Errors            $Errors `
    -Buffer            $Buffer `
    -WorkspaceContext  $WorkspaceContext `
    -ScenarioContext   $ScenarioContext

$baseName = "impact-$ScenarioRunId"
$mdPath = $null; $jsonPath = $null

if ($Format -in @('json', 'both')) {
    $jsonPath = Join-Path $OutputDir "$baseName.json"
    Write-AtomicFile -Path $jsonPath -Content (ConvertTo-ImpactReportJson -Model $model)
    [Console]::Error.WriteLine("[New-ImpactReport] Wrote $jsonPath")
}
if ($Format -in @('markdown', 'both')) {
    $mdPath = Join-Path $OutputDir "$baseName.md"
    Write-AtomicFile -Path $mdPath -Content (ConvertTo-ImpactReportMarkdown -Model $model -Buffer $Buffer)
    [Console]::Error.WriteLine("[New-ImpactReport] Wrote $mdPath")
}

# Surface the Markdown path on stdout so callers can chain it.
if ($mdPath) { Write-Output $mdPath }

[pscustomobject]@{
    markdownPath = $mdPath
    jsonPath     = $jsonPath
}
