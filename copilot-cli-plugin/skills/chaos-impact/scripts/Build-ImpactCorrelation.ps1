<#
.SYNOPSIS
    Pure-function correlation + classification engine for chaos-impact.

.DESCRIPTION
    Given a ScenarioRun resource and the raw signal bundle produced by
    Get-MonitorSignals.ps1, derives per-action windows, classifies every
    in-scope signal as one of:
        chaosAttributed | baseline | unexplained
    and assigns a severity bucket (info | low | med | high | crit).

    The script performs **no** ARM / Monitor calls; it is safe to dot-source
    and unit-test in isolation.

    When invoked normally (`& Build-ImpactCorrelation.ps1 -ScenarioRun ... -Signals ...`)
    it runs the engine and emits the per-action result array. When dot-sourced
    (`. ./Build-ImpactCorrelation.ps1`) only the helper functions are exposed.

.PARAMETER ScenarioRun
    The full ScenarioRun resource object — must expose
    `.properties.startedAt`, `.properties.completedAt`, and
    `.properties.scenarioRunSummary` (array of action summaries).

.PARAMETER Signals
    The output of Get-MonitorSignals.ps1. Shape:
        @{
          metrics  = @( @{resourceId; metricName; dataPoints=@(@{timeStamp; average; maximum})} )
          logs     = @( @{workspaceId; rows=@(@{TimeGenerated; Level; _ResourceId; count})} )
          activity = @( @{resourceId; events=@(@{eventTimestamp; operationName; level})} )
          alerts   = @( @{name; severity; firedTime; targetResourceId} )
          health   = @( @{title; eventType; startTime; affectedRegions=@(...)} )
          coverage = @{...}
        }

.PARAMETER Buffer
    ISO-8601 duration; expanded window = ±Buffer around the action window,
    baseline window = [start-2×Buffer, start-Buffer]. Default PT5M.

.PARAMETER MetricDefaults
    Hashtable / PSCustomObject loaded from templates/metrics/defaults.json,
    keyed by ARM resource type. Each entry: { metrics=[...]; thresholds={...} }.

.OUTPUTS
    [object[]] — one entry per action with shape:
        @{
          actionName        = '...'
          startedAt         = '...'
          completedAt       = '...'
          windowSource      = 'action'|'run'
          targetedResources = @('<id>', ...)
          signals = @{
            chaosAttributed = @( <Signal> )
            baseline        = @( <Signal> )
            unexplained     = @( <Signal> )
          }
        }
    where a <Signal> is:
        @{
          resourceId; signalType; name; timestamp; value;
          severity; actionName; rationale
        }
#>
[CmdletBinding()]
param(
    [Parameter()]$ScenarioRun,
    [Parameter()]$Signals,
    [Parameter()][string]$Buffer = 'PT5M',
    [Parameter()]$MetricDefaults
)

# ═══════════════════════════════════════════════════════
# Helpers
# ═══════════════════════════════════════════════════════

function ConvertFrom-IsoDuration {
    <#
    .SYNOPSIS
        Parses an ISO-8601 duration (e.g. PT5M, PT1H30M) → [TimeSpan].
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Iso)
    return [System.Xml.XmlConvert]::ToTimeSpan($Iso)
}

function ConvertTo-ParentResourceId {
    <#
    .SYNOPSIS
        Collapses VMSS-instance / AKS-child resource IDs onto their parent
        cluster/scale-set ID. Returns the input unchanged if no rule matches.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$ResourceId)
    $parent = $ResourceId
    if ($parent -match '^(?<base>/subscriptions/.+?/providers/Microsoft\.Compute/virtualMachineScaleSets/[^/]+)/virtualMachines/.+$') {
        $parent = $Matches['base']
    } elseif ($parent -match '^(?<base>/subscriptions/.+?/providers/Microsoft\.ContainerService/managedClusters/[^/]+)/.+$') {
        $parent = $Matches['base']
    }
    return $parent
}

function Get-ResourceTypeFromId {
    <#
    .SYNOPSIS
        Extracts the canonical `Provider/typeSegment[/sub...]` from an ARM ID.
        Examples:
          /subscriptions/.../providers/Microsoft.Compute/virtualMachines/x
              → Microsoft.Compute/virtualMachines
          /subscriptions/.../providers/Microsoft.Sql/servers/s/databases/d
              → Microsoft.Sql/servers/databases
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$ResourceId)
    if ($ResourceId -notmatch '/providers/(?<rest>.+)$') { return $null }
    $segments = $Matches['rest'] -split '/'
    if ($segments.Count -lt 2) { return $null }
    # segments: [provider, type, name, (subtype, subname, ...)]
    $parts = @($segments[0], $segments[1])
    for ($i = 3; $i -lt $segments.Count; $i += 2) {
        $parts += $segments[$i]
    }
    return ($parts -join '/')
}

function Get-MetricThreshold {
    <#
    .SYNOPSIS
        Looks up the threshold for (resourceType, metricName) in MetricDefaults.
        Returns $null if undefined → caller treats as "no magnitude test".
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]$MetricDefaults,
        [Parameter(Mandatory)][string]$ResourceType,
        [Parameter(Mandatory)][string]$MetricName
    )
    if (-not $MetricDefaults) { return $null }
    # Support both hashtable and PSCustomObject (ConvertFrom-Json output).
    $typeEntry = $null
    if ($MetricDefaults -is [System.Collections.IDictionary]) {
        if ($MetricDefaults.Contains($ResourceType)) { $typeEntry = $MetricDefaults[$ResourceType] }
    } else {
        $typeEntry = $MetricDefaults.PSObject.Properties[$ResourceType]
        if ($typeEntry) { $typeEntry = $typeEntry.Value }
    }
    if (-not $typeEntry) { return $null }

    $thresholds = if ($typeEntry -is [System.Collections.IDictionary]) {
        $typeEntry['thresholds']
    } else {
        $typeEntry.thresholds
    }
    if (-not $thresholds) { return $null }

    if ($thresholds -is [System.Collections.IDictionary]) {
        if ($thresholds.Contains($MetricName)) { return [double]$thresholds[$MetricName] }
        return $null
    }
    $prop = $thresholds.PSObject.Properties[$MetricName]
    if ($prop) { return [double]$prop.Value }
    return $null
}

function Get-SeverityFromAlertSev {
    <#
    .SYNOPSIS
        Maps an AlertsManagement severity string (Sev0..Sev4) to our bucket.
    #>
    [CmdletBinding()]
    param([Parameter()][string]$AlertSeverity)
    switch -Regex ($AlertSeverity) {
        '^Sev0$' { return 'crit' }
        '^Sev1$' { return 'high' }
        '^Sev2$' { return 'med' }
        '^Sev3$' { return 'low' }
        '^Sev4$' { return 'info' }
        default  { return 'info' }
    }
}

function Get-SeverityFromMetricDelta {
    <#
    .SYNOPSIS
        Bucket = |delta| / threshold: >3× crit, >2× high, >1× med, else low.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][double]$Delta,
        [Parameter(Mandatory)][double]$Threshold
    )
    if ($Threshold -le 0) { return 'low' }
    $ratio = [Math]::Abs($Delta) / $Threshold
    if ($ratio -gt 3.0) { return 'crit' }
    if ($ratio -gt 2.0) { return 'high' }
    if ($ratio -gt 1.0) { return 'med' }
    return 'low'
}

function Get-SeverityFromLogRatio {
    <#
    .SYNOPSIS
        Bucket = count_in_window / count_in_baseline: >5 crit, >3 high, >1.5 med, else low.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][double]$Ratio)
    if ($Ratio -gt 5.0)  { return 'crit' }
    if ($Ratio -gt 3.0)  { return 'high' }
    if ($Ratio -gt 1.5)  { return 'med' }
    return 'low'
}

function Test-TimestampInWindow {
    <#
    .SYNOPSIS
        Returns $true if $Timestamp falls inside [$Start, $End] (inclusive).
        Accepts strings (ISO-8601) or [DateTime].
    #>
    [CmdletBinding()]
    param(
        [Parameter()]$Timestamp,
        [Parameter(Mandatory)][DateTime]$Start,
        [Parameter(Mandatory)][DateTime]$End
    )
    if (-not $Timestamp) { return $false }
    try {
        $ts = if ($Timestamp -is [DateTime]) {
                if ($Timestamp.Kind -eq [System.DateTimeKind]::Unspecified) {
                    [DateTime]::SpecifyKind($Timestamp, [System.DateTimeKind]::Utc)
                } else {
                    $Timestamp.ToUniversalTime()
                }
              }
              else { [DateTime]::Parse($Timestamp, $null, [System.Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime() }
    } catch { return $false }
    return ($ts -ge $Start -and $ts -le $End)
}

function Get-MetricBaselineAverage {
    <#
    .SYNOPSIS
        Averages the `average` field of data points falling inside the
        baseline window. Returns $null if no points qualify.
    #>
    [CmdletBinding()]
    param(
        [Parameter()][array]$DataPoints,
        [Parameter(Mandatory)][DateTime]$BaselineStart,
        [Parameter(Mandatory)][DateTime]$BaselineEnd
    )
    if (-not $DataPoints -or $DataPoints.Count -eq 0) { return $null }
    $vals = @()
    foreach ($p in $DataPoints) {
        $ts = if ($p.timeStamp) { $p.timeStamp } elseif ($p.TimeGenerated) { $p.TimeGenerated } else { $null }
        if (-not (Test-TimestampInWindow -Timestamp $ts -Start $BaselineStart -End $BaselineEnd)) { continue }
        $v = if ($null -ne $p.average) { $p.average } elseif ($null -ne $p.maximum) { $p.maximum } else { $null }
        if ($null -ne $v) { $vals += [double]$v }
    }
    if ($vals.Count -eq 0) { return $null }
    return ($vals | Measure-Object -Average).Average
}

function Test-ResourceIdMatch {
    <#
    .SYNOPSIS
        Case-insensitive set-membership test that compares parent-collapsed IDs.
    #>
    [CmdletBinding()]
    param(
        [Parameter()][string]$ResourceId,
        [Parameter()][string[]]$TargetSet
    )
    if (-not $ResourceId -or -not $TargetSet -or $TargetSet.Count -eq 0) { return $false }
    $parent = (ConvertTo-ParentResourceId -ResourceId $ResourceId).ToLowerInvariant()
    foreach ($t in $TargetSet) {
        if ($t -and $parent -eq (ConvertTo-ParentResourceId -ResourceId $t).ToLowerInvariant()) { return $true }
    }
    return $false
}

# ═══════════════════════════════════════════════════════
# Main classifier
# ═══════════════════════════════════════════════════════

function Build-ImpactCorrelation {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]$ScenarioRun,
        [Parameter(Mandatory)]$Signals,
        [Parameter()][string]$Buffer = 'PT5M',
        [Parameter()]$MetricDefaults
    )

    $bufferSpan = ConvertFrom-IsoDuration -Iso $Buffer

    # Helper: coerce a string/DateTime input to a UTC DateTime. Necessary
    # because ConvertFrom-Json eagerly converts ISO-8601 strings to
    # [DateTime] (Kind=Utc), and [DateTime]::Parse(DateTime,...) round-trips
    # through a culture-formatted string that loses the Utc kind — making
    # the subsequent .ToUniversalTime() shift by the local UTC offset.
    $toUtc = {
        param($v)
        if ($null -eq $v) { return $null }
        if ($v -is [DateTime]) {
            if ($v.Kind -eq [System.DateTimeKind]::Unspecified) {
                return [DateTime]::SpecifyKind($v, [System.DateTimeKind]::Utc)
            }
            return $v.ToUniversalTime()
        }
        return [DateTime]::Parse($v, $null, [System.Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime()
    }

    # ── Resolve overall run window (used as fallback for action timing) ──
    $runStartedAt   = $null
    $runCompletedAt = $null
    if ($ScenarioRun -and $ScenarioRun.properties) {
        if ($ScenarioRun.properties.startedAt)   { $runStartedAt   = & $toUtc $ScenarioRun.properties.startedAt }
        if ($ScenarioRun.properties.completedAt) { $runCompletedAt = & $toUtc $ScenarioRun.properties.completedAt }
    }

    $actions = @()
    if ($ScenarioRun -and $ScenarioRun.properties -and $ScenarioRun.properties.scenarioRunSummary) {
        $actions = @($ScenarioRun.properties.scenarioRunSummary)
    }

    $results = @()

    foreach ($action in $actions) {
        # ── Step 1: derive action window with run-fallback ──
        $windowSource = 'action'
        $aStart = $null; $aEnd = $null
        if ($action.startedAt -and $action.completedAt) {
            try {
                $aStart = & $toUtc $action.startedAt
                $aEnd   = & $toUtc $action.completedAt
            } catch { $aStart = $null; $aEnd = $null }
        }
        if (-not $aStart -or -not $aEnd) {
            $aStart = $runStartedAt
            $aEnd   = $runCompletedAt
            $windowSource = 'run'
        }
        if (-not $aStart -or -not $aEnd) {
            # Insufficient timing context → emit empty action bucket and continue.
            $results += [ordered]@{
                actionName        = $action.actionName
                startedAt         = $action.startedAt
                completedAt       = $action.completedAt
                windowSource      = 'unknown'
                targetedResources = @()
                signals = [ordered]@{
                    chaosAttributed = @()
                    baseline        = @()
                    unexplained     = @()
                    platformEvent   = @()
                }
            }
            continue
        }

        $expandedStart = $aStart.Add(-$bufferSpan)
        $expandedEnd   = $aEnd.Add($bufferSpan)
        $baselineStart = $aStart.Add(-$bufferSpan + -$bufferSpan)
        $baselineEnd   = $aStart.Add(-$bufferSpan)

        # ── Step 2: target set T(A) (parent-collapsed, unique) ──
        $targetIds = @()
        foreach ($r in @($action.resources)) {
            if ($r -and $r.id) { $targetIds += (ConvertTo-ParentResourceId -ResourceId $r.id) }
        }
        $targetIds = @($targetIds | Sort-Object -Unique)

        $chaosBucket = @()
        $baselineBucket = @()
        $unexplainedBucket = @()
        $platformBucket = @()

        # ── Step 3a: metrics ──
        foreach ($m in @($Signals.metrics)) {
            if (-not $m -or -not $m.resourceId) { continue }
            $resourceType = Get-ResourceTypeFromId -ResourceId $m.resourceId
            $threshold = if ($resourceType) { Get-MetricThreshold -MetricDefaults $MetricDefaults -ResourceType $resourceType -MetricName $m.metricName } else { $null }
            $baselineAvg = Get-MetricBaselineAverage -DataPoints $m.dataPoints -BaselineStart $baselineStart -BaselineEnd $baselineEnd
            $targetOk = Test-ResourceIdMatch -ResourceId $m.resourceId -TargetSet $targetIds

            foreach ($p in @($m.dataPoints)) {
                $ts = if ($p.timeStamp) { $p.timeStamp } elseif ($p.TimeGenerated) { $p.TimeGenerated } else { $null }
                $val = if ($null -ne $p.average) { [double]$p.average } elseif ($null -ne $p.maximum) { [double]$p.maximum } else { $null }
                if ($null -eq $val) { continue }

                $inExpanded = Test-TimestampInWindow -Timestamp $ts -Start $expandedStart -End $expandedEnd
                $inBaseline = Test-TimestampInWindow -Timestamp $ts -Start $baselineStart -End $baselineEnd

                $delta = if ($null -ne $baselineAvg) { $val - [double]$baselineAvg } else { $val }
                $magnitudeHit = ($null -ne $threshold) -and ([Math]::Abs($delta) -gt $threshold)

                $sig = [ordered]@{
                    resourceId  = $m.resourceId
                    signalType  = 'metric'
                    name        = $m.metricName
                    timestamp   = $ts
                    value       = $val
                    severity    = 'info'
                    actionName  = $null
                    rationale   = $null
                }

                if ($inExpanded -and $targetOk -and $magnitudeHit) {
                    $sig.severity   = Get-SeverityFromMetricDelta -Delta $delta -Threshold $threshold
                    $sig.actionName = $action.actionName
                    $sig.rationale  = "Metric '$($m.metricName)' delta $([Math]::Round($delta,3)) exceeds threshold $threshold inside action window (±$Buffer); resource matches target set."
                    $chaosBucket += $sig
                } elseif ($inBaseline -and $targetOk) {
                    $sig.severity  = 'low'
                    $sig.rationale = "Sampled inside baseline window for '$($m.metricName)'; treated as pre-existing noise."
                    $baselineBucket += $sig
                } elseif ($inExpanded -and -not $targetOk) {
                    # Per-action unexplained: target match is scoped to THIS action
                    # only, so any in-window movement on a non-target is unexplained
                    # from this action's perspective (it may be chaos-attributed
                    # under a different action's evaluation pass).
                    $sig.severity  = if ($null -ne $threshold) { Get-SeverityFromMetricDelta -Delta $delta -Threshold $threshold } else { 'low' }
                    $sig.rationale = "Metric movement on a resource not in this action's target set during its window."
                    $unexplainedBucket += $sig
                }
                # otherwise: below noise floor → skip
            }
        }

        # ── Step 3b: logs (per-row classification) ──
        foreach ($lw in @($Signals.logs)) {
            if (-not $lw -or -not $lw.rows) { continue }
            foreach ($row in @($lw.rows)) {
                $rid = $row._ResourceId
                if (-not $rid) { $rid = $row.resourceId }
                $ts  = if ($row.TimeGenerated) { $row.TimeGenerated } else { $row.timestamp }
                $count = if ($null -ne $row.count) { [double]$row.count } elseif ($null -ne $row.runCount) { [double]$row.runCount } else { 1.0 }
                $baseCount = if ($null -ne $row.baseCount) { [double]$row.baseCount } else { 0.0 }
                $ratio = if ($baseCount -gt 0) { $count / $baseCount } else { $count }

                $inExpanded = Test-TimestampInWindow -Timestamp $ts -Start $expandedStart -End $expandedEnd
                $inBaseline = Test-TimestampInWindow -Timestamp $ts -Start $baselineStart -End $baselineEnd
                $targetOk   = $rid -and (Test-ResourceIdMatch -ResourceId $rid -TargetSet $targetIds)

                $sig = [ordered]@{
                    resourceId  = $rid
                    signalType  = 'log'
                    name        = if ($row.Category) { "$($row.Category)/$($row.Level)" } else { 'log' }
                    timestamp   = $ts
                    value       = $count
                    severity    = 'info'
                    actionName  = $null
                    rationale   = $null
                }

                if ($inExpanded -and $targetOk -and $ratio -gt 1.5) {
                    $sig.severity   = Get-SeverityFromLogRatio -Ratio $ratio
                    $sig.actionName = $action.actionName
                    $sig.rationale  = "Log volume $count vs baseline $baseCount (ratio $([Math]::Round($ratio,2))) inside action window."
                    $chaosBucket += $sig
                } elseif ($inBaseline -and $targetOk) {
                    $sig.severity  = 'low'
                    $sig.rationale = "Log rows observed in baseline window."
                    $baselineBucket += $sig
                } elseif ($inExpanded -and -not $targetOk -and $rid) {
                    $sig.severity  = Get-SeverityFromLogRatio -Ratio $ratio
                    $sig.rationale = "Log volume on a resource not in this action's target set during its window."
                    $unexplainedBucket += $sig
                }
            }
        }

        # ── Step 3c: activity log ──
        foreach ($a in @($Signals.activity)) {
            if (-not $a) { continue }
            $rid = $a.resourceId
            foreach ($ev in @($a.events)) {
                $ts = if ($ev.eventTimestamp) { $ev.eventTimestamp } elseif ($ev.timestamp) { $ev.timestamp } else { $null }
                $inExpanded = Test-TimestampInWindow -Timestamp $ts -Start $expandedStart -End $expandedEnd
                $targetOk   = $rid -and (Test-ResourceIdMatch -ResourceId $rid -TargetSet $targetIds)
                $opName = if ($ev.operationName -and $ev.operationName.value) { $ev.operationName.value } else { 'activity' }

                $sig = [ordered]@{
                    resourceId  = $rid
                    signalType  = 'activity'
                    name        = $opName
                    timestamp   = $ts
                    value       = if ($ev.status -and $ev.status.value) { $ev.status.value } else { $null }
                    severity    = 'info'
                    actionName  = $null
                    rationale   = $null
                }

                if ($inExpanded -and $targetOk) {
                    $sig.actionName = $action.actionName
                    $sig.rationale  = "Activity log event '$opName' on targeted resource inside action window."
                    $chaosBucket += $sig
                } elseif ($inExpanded -and -not $targetOk -and $rid) {
                    $sig.rationale = "Activity log event on a resource not in this action's target set during its window."
                    $unexplainedBucket += $sig
                }
            }
        }

        # ── Step 3d: alerts ──
        foreach ($al in @($Signals.alerts)) {
            if (-not $al) { continue }
            $rid = $al.targetResourceId
            $ts  = $al.firedTime
            $inExpanded = Test-TimestampInWindow -Timestamp $ts -Start $expandedStart -End $expandedEnd
            $targetOk   = $rid -and (Test-ResourceIdMatch -ResourceId $rid -TargetSet $targetIds)

            $sig = [ordered]@{
                resourceId  = $rid
                signalType  = 'alert'
                name        = $al.name
                timestamp   = $ts
                value       = $al.severity
                severity    = Get-SeverityFromAlertSev -AlertSeverity $al.severity
                actionName  = $null
                rationale   = $null
            }

            if ($inExpanded -and $targetOk) {
                $sig.actionName = $action.actionName
                $sig.rationale  = "Alert '$($al.name)' (sev $($al.severity)) fired on targeted resource inside action window."
                $chaosBucket += $sig
            } elseif ($inExpanded -and -not $targetOk -and $rid) {
                $sig.rationale = "Alert fired on a resource not in this action's target set during its window."
                $unexplainedBucket += $sig
            }
        }

        # ── Step 3e: service health → 'platformEvent' bucket ──
        # Service Health events are documented Azure platform incidents with a
        # known cause; they are explicitly NOT 'unexplained'.
        foreach ($h in @($Signals.health)) {
            if (-not $h) { continue }
            $ts = if ($h.startTime) { $h.startTime } elseif ($h.impactStartTime) { $h.impactStartTime } else { $null }
            if (-not (Test-TimestampInWindow -Timestamp $ts -Start $expandedStart -End $expandedEnd)) { continue }
            $sig = [ordered]@{
                resourceId  = $null
                signalType  = 'servicehealth'
                name        = $h.title
                timestamp   = $ts
                value       = $h.eventType
                severity    = 'info'
                actionName  = $null
                rationale   = "Known Azure platform event (Service Health '$($h.eventType)': '$($h.title)') active during this action's window — attributed to the platform, not to chaos."
            }
            $platformBucket += $sig
        }

        $results += [ordered]@{
            actionName        = $action.actionName
            startedAt         = if ($windowSource -eq 'action') { $action.startedAt }   else { $ScenarioRun.properties.startedAt }
            completedAt       = if ($windowSource -eq 'action') { $action.completedAt } else { $ScenarioRun.properties.completedAt }
            windowSource      = $windowSource
            targetedResources = $targetIds
            signals = [ordered]@{
                chaosAttributed = $chaosBucket
                baseline        = $baselineBucket
                unexplained     = $unexplainedBucket
                platformEvent   = $platformBucket
            }
        }
    }

    return ,$results
}

# ═══════════════════════════════════════════════════════
# Entry point (skipped when dot-sourced for tests)
# ═══════════════════════════════════════════════════════

if ($MyInvocation.InvocationName -ne '.') {
    if (-not $ScenarioRun) { throw "Build-ImpactCorrelation.ps1: -ScenarioRun is required." }
    if (-not $Signals)     { throw "Build-ImpactCorrelation.ps1: -Signals is required." }
    Build-ImpactCorrelation -ScenarioRun $ScenarioRun -Signals $Signals -Buffer $Buffer -MetricDefaults $MetricDefaults
}
