# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

<#
.SYNOPSIS
    Validate the system analysis that has to happen before anyone is questioned.

.DESCRIPTION
    This file does not read the customer's code. An agent does that, because
    reading a codebase is a judgement task and a PowerShell script would only be
    able to fake it. What this file owns is the part a script is actually good
    at: refusing to let the analysis be skipped, and refusing to let a claim be
    recorded without something that can be checked.

    The rule is simple and absolute:

        every required area is either OBSERVED with a citation,
        or declared UNAVAILABLE with a reason.

    There is no third option, because the third option is where invented
    evidence comes from. "The service retries on 503" with no file and no line
    is indistinguishable from a guess, and a study built on a guessed mechanism
    proves nothing no matter how cleanly it runs.

    Requires Common.ps1 to be dot-sourced first.
#>

Set-StrictMode -Version Latest

# The areas a reliability study depends on knowing. Each carries the reason it
# is here, which is what gets printed as the analysis checklist.
$ChaosAnalysisAreas = [ordered]@{
    code        = 'Application code and the request path under study'
    deployment  = 'Deployment, IaC and configuration - what is actually running'
    dependencies = 'The dependency graph: what this component calls and is called by'
    resilience  = 'Retry, fallback, circuit-breaker, timeout and bulkhead behaviour'
    persistence = 'Persistence paths and what is at risk of loss or corruption'
    workload    = 'Workload shape and event rate on the vulnerable path'
    telemetry   = 'Existing telemetry and SLIs - what can be measured today'
    identity    = 'Deployment and build identity - which version this is about'
}

function Get-ChaosAnalysisAreas {
    <#
    .SYNOPSIS
        The required analysis areas and why each is required.
    #>
    return $ChaosAnalysisAreas
}

function ConvertTo-ChaosObservation {
    <#
    .SYNOPSIS
        Normalise one observation, rejecting an uncitable claim.

    .DESCRIPTION
        A citation is a file path, a symbol, a resource id, a dashboard, or a
        document - anything a reviewer could open. It is not "the code" and it
        is not "observed". The check is deliberately shallow: it enforces that
        SOMETHING checkable was named, and leaves whether the citation actually
        supports the claim to code review, which is where that judgement belongs.
    #>
    param(
        [Parameter(Mandatory)][object]$Observation,
        [Parameter(Mandatory)][string]$Area
    )
    $statement = [string](Get-ChaosMember -InputObject $Observation -Name 'statement')
    $citation = [string](Get-ChaosMember -InputObject $Observation -Name 'citation')
    if ([string]::IsNullOrWhiteSpace($statement)) {
        throw "DesignIncomplete: an observation in area '$Area' has no statement."
    }
    if ([string]::IsNullOrWhiteSpace($citation)) {
        throw "DesignIncomplete: observation '$statement' (area '$Area') has no citation. Name the file, symbol, resource id or document it came from, or declare the area unavailable instead of asserting it."
    }
    if ($citation.Trim().Length -lt 3) {
        throw "DesignIncomplete: citation '$citation' (area '$Area') is too short to be checkable."
    }
    return [ordered]@{
        statement = $statement.Trim()
        citation  = $citation.Trim()
        note      = [string](Get-ChaosMember -InputObject $Observation -Name 'note')
    }
}

function ConvertTo-ChaosAnalysis {
    <#
    .SYNOPSIS
        Validate and normalise the agent's system analysis.

    .DESCRIPTION
        Takes the raw object the agent produced (from -ObservationFile or built
        inline) and returns the analysis section of the brief. Throws
        DesignIncomplete when an area is neither observed nor declared
        unavailable, which the caller maps to exit 24.

        Accepted input shape:

          {
            "areas":       { "<area>": [ { "statement": .., "citation": .. } ] },
            "unavailable": [ { "area": "<area>", "reason": ".." } ],
            "workload":    { "eventRatePerSecond": .., "source": ".." },
            "telemetryGaps": [ ".." ]
          }
    #>
    param([Parameter(Mandatory)][object]$Raw)

    $areasIn = Get-ChaosMember -InputObject $Raw -Name 'areas'
    $unavailableIn = @(Get-ChaosItems -InputObject (Get-ChaosMember -InputObject $Raw -Name 'unavailable'))

    $unavailable = [System.Collections.Generic.List[object]]::new()
    $unavailableAreas = @()
    foreach ($entry in $unavailableIn) {
        if ($null -eq $entry) { continue }
        $area = [string](Get-ChaosMember -InputObject $entry -Name 'area')
        $reason = [string](Get-ChaosMember -InputObject $entry -Name 'reason')
        if ([string]::IsNullOrWhiteSpace($area)) { throw 'DesignIncomplete: an unavailable entry has no area.' }
        if (-not $ChaosAnalysisAreas.Contains($area)) {
            throw "DesignIncomplete: unknown analysis area '$area'. Known areas: $(($ChaosAnalysisAreas.Keys) -join ', ')."
        }
        if ([string]::IsNullOrWhiteSpace($reason)) {
            throw "DesignIncomplete: area '$area' is declared unavailable with no reason. Say what could not be read and why, so the report can carry it as a real limitation."
        }
        $unavailable.Add([ordered]@{ area = $area; reason = $reason.Trim() }) | Out-Null
        $unavailableAreas += $area
    }

    $areas = [ordered]@{}
    $missing = @()
    foreach ($area in $ChaosAnalysisAreas.Keys) {
        $observations = @(Get-ChaosItems -InputObject (Get-ChaosMember -InputObject $areasIn -Name $area))
        $normalised = [System.Collections.Generic.List[object]]::new()
        foreach ($observation in $observations) {
            if ($null -eq $observation) { continue }
            $normalised.Add((ConvertTo-ChaosObservation -Observation $observation -Area $area)) | Out-Null
        }
        if ($normalised.Count -eq 0 -and $unavailableAreas -notcontains $area) {
            $missing += $area
        }
        $areas[$area] = @($normalised)
    }

    if ($missing.Count -gt 0) {
        $detail = ($missing | ForEach-Object { "  $_  - $($ChaosAnalysisAreas[$_])" }) -join "`n"
        throw @"
DesignIncomplete: the system analysis has areas that were neither observed nor declared unavailable:

$detail

Read them and record what you found with citations, or declare each one unavailable with the reason it could not be read. Leaving an area silent is how a guess becomes a finding.
"@
    }

    $workload = Get-ChaosMember -InputObject $Raw -Name 'workload'
    return [ordered]@{
        performedAt   = Get-ChaosUtcNow
        areas         = $areas
        unavailable   = @($unavailable)
        workload      = if ($null -eq $workload) { $null } else { ConvertTo-ChaosWorkload -Raw $workload }
        telemetryGaps = @(Get-ChaosItems -InputObject (Get-ChaosMember -InputObject $Raw -Name 'telemetryGaps') | Where-Object { $_ })
        observedCount = @($areas.Values | ForEach-Object { @($_).Count } | Measure-Object -Sum).Sum
    }
}

function ConvertTo-ChaosWorkload {
    <#
    .SYNOPSIS
        Normalise the measured workload shape. Unmeasured stays null.

    .DESCRIPTION
        The event rate feeds the exposure arithmetic downstream, where a wrong
        number is worse than no number: it produces a confident expectation of
        vulnerable events that never existed. So a rate is only carried when its
        source is named.
    #>
    param([Parameter(Mandatory)][object]$Raw)
    $rate = Get-ChaosMember -InputObject $Raw -Name 'eventRatePerSecond'
    $source = [string](Get-ChaosMember -InputObject $Raw -Name 'source')
    if ($null -ne $rate -and [string]::IsNullOrWhiteSpace($source)) {
        throw "DesignIncomplete: workload eventRatePerSecond was given without a source. Name the metric, dashboard or log query it came from - an unsourced rate becomes an assumed one downstream."
    }
    return [ordered]@{
        eventRatePerSecond = if ($null -eq $rate) { $null } else { [double]$rate }
        source             = if ([string]::IsNullOrWhiteSpace($source)) { $null } else { $source.Trim() }
        note               = [string](Get-ChaosMember -InputObject $Raw -Name 'note')
    }
}

function Get-ChaosAnalysisFact {
    <#
    .SYNOPSIS
        Look up whether the analysis already established a fact, and with what
        citation.

    .DESCRIPTION
        This is what stops the interview asking the customer things their own
        code already answered. It returns a descriptor { established, citation,
        statement } so a question can be pre-filled and marked established
        rather than asked.
    #>
    param(
        [Parameter(Mandatory)][AllowNull()][object]$Analysis,
        [Parameter(Mandatory)][string]$Area
    )
    $none = [pscustomobject]@{ established = $false; citation = $null; statement = $null }
    if ($null -eq $Analysis) { return $none }
    $areas = Get-ChaosMember -InputObject $Analysis -Name 'areas'
    $observations = @(Get-ChaosItems -InputObject (Get-ChaosMember -InputObject $areas -Name $Area))
    $first = $observations | Where-Object { $_ } | Select-Object -First 1
    if ($null -eq $first) { return $none }
    return [pscustomobject]@{
        established = $true
        citation    = [string](Get-ChaosMember -InputObject $first -Name 'citation')
        statement   = [string](Get-ChaosMember -InputObject $first -Name 'statement')
    }
}

function Get-ChaosAnalysisVocabulary {
    <#
    .SYNOPSIS
        Every concrete name the analysis established: components, dependencies,
        symbols, signals.

    .DESCRIPTION
        Used to test whether an interview answer is actually about this system
        or is generic chaos-engineering noise. A purpose that mentions nothing
        from the customer's own analysis is a purpose nobody has thought about
        yet.
    #>
    param([Parameter(Mandatory)][AllowNull()][object]$Analysis)
    $words = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    if ($null -eq $Analysis) { return @() }
    $areas = Get-ChaosMember -InputObject $Analysis -Name 'areas'
    foreach ($area in $ChaosAnalysisAreas.Keys) {
        foreach ($observation in @(Get-ChaosItems -InputObject (Get-ChaosMember -InputObject $areas -Name $area))) {
            if ($null -eq $observation) { continue }
            $text = "$([string](Get-ChaosMember -InputObject $observation -Name 'statement')) $([string](Get-ChaosMember -InputObject $observation -Name 'citation'))"
            foreach ($token in [regex]::Matches($text, '[A-Za-z][A-Za-z0-9_.\-]{3,}')) {
                $words.Add($token.Value) | Out-Null
            }
        }
    }
    return @($words)
}
