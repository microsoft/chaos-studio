# Hydration of scope inputs from a confirmed chaos-study-design brief.
#
# The design phase ends with a customer-confirmed decision. Retyping that
# decision into the scope command is where it drifts: a predicate is reworded,
# a probe direction is dropped, an exclusion is forgotten, and the study that
# runs is quietly not the study that was agreed. This module carries the brief
# across the seam verbatim.
#
# Two rules govern everything here.
#
#   1. Explicit wins. A parameter present in $PSBoundParameters is never
#      overwritten. The brief fills gaps; it does not overrule the operator.
#
#   2. Never widen, never invent. A brief value that cannot be mapped onto a
#      typed scope parameter is reported and dropped, not guessed at. The
#      failure mode being avoided is a blast-radius exclusion that silently
#      fails to translate, leaving the run broader than the customer agreed.

Set-StrictMode -Version Latest

$ChaosBriefHandoffVersion = 'study-brief.v1'

function Get-ChaosBriefValue {
    <#
    .SYNOPSIS
        Read a member from a brief object, tolerating both the hashtable shape
        written in-process and the PSCustomObject shape read back from JSON.
    #>
    param(
        [Parameter(Mandatory)][AllowNull()][object]$InputObject,
        [Parameter(Mandatory)][string]$Name
    )
    return (Get-ChaosMember -InputObject $InputObject -Name $Name)
}

function ConvertFrom-ChaosBriefBlastRadius {
    <#
    .SYNOPSIS
        Translate the brief's blast-radius strings into the typed scope flags.

    .DESCRIPTION
        The design phase records blast radius as intent, in 'key=value' form,
        because at design time there is no live scope to validate against. Only
        the keys below have a scope parameter to land in. Anything else is
        returned in .unmapped so the caller can print it and require the
        operator to state it explicitly - an unrecognised exclusion that were
        silently dropped would widen the run past what was agreed.
    #>
    param(
        [AllowNull()][object]$Filters,
        [AllowNull()][object]$Exclusions
    )

    $result = [ordered]@{
        FilterLocation      = @()
        FilterZone          = @()
        FilterPhysicalZone  = $null
        ExcludeResource     = @()
        ExcludeType         = @()
        ExcludeTag          = @{}
        unmapped            = @()
    }

    $split = {
        param([string]$Text)
        $idx = $Text.IndexOf('=')
        if ($idx -lt 1) { return $null }
        return [pscustomobject]@{
            key   = $Text.Substring(0, $idx).Trim()
            value = $Text.Substring($idx + 1).Trim()
        }
    }

    foreach ($raw in (Get-ChaosItems -InputObject $Filters)) {
        $text = [string]$raw
        if ([string]::IsNullOrWhiteSpace($text)) { continue }
        $pair = & $split $text
        if ($null -eq $pair -or [string]::IsNullOrWhiteSpace($pair.value)) {
            $result['unmapped'] += "filter: $text"
            continue
        }
        switch ($pair.key.ToLowerInvariant()) {
            'location' { $result['FilterLocation'] += $pair.value }
            'region' { $result['FilterLocation'] += $pair.value }
            'zone' { $result['FilterZone'] += $pair.value }
            'physicalzone' { $result['FilterPhysicalZone'] = $pair.value }
            default { $result['unmapped'] += "filter: $text" }
        }
    }

    foreach ($raw in (Get-ChaosItems -InputObject $Exclusions)) {
        $text = [string]$raw
        if ([string]::IsNullOrWhiteSpace($text)) { continue }
        $pair = & $split $text
        if ($null -eq $pair -or [string]::IsNullOrWhiteSpace($pair.value)) {
            $result['unmapped'] += "exclusion: $text"
            continue
        }
        switch ($pair.key.ToLowerInvariant()) {
            'resource' { $result['ExcludeResource'] += $pair.value }
            'type' { $result['ExcludeType'] += $pair.value }
            'resourcetype' { $result['ExcludeType'] += $pair.value }
            'tag' {
                $tagIdx = $pair.value.IndexOf(':')
                if ($tagIdx -lt 1) {
                    $result['unmapped'] += "exclusion: $text"
                }
                else {
                    $result['ExcludeTag'][$pair.value.Substring(0, $tagIdx).Trim()] = $pair.value.Substring($tagIdx + 1).Trim()
                }
            }
            default { $result['unmapped'] += "exclusion: $text" }
        }
    }

    return $result
}

function ConvertFrom-ChaosBriefParameterTable {
    <#
    .SYNOPSIS
        Fold a brief's parameter record into the hashtable scope takes.

    .DESCRIPTION
        A brief may carry parameters either as the {key,value} pairs the
        service uses or as a plain object. Both are accepted; anything else
        yields no table rather than a partially-understood one, because a
        half-read parameter set is worse than an absent one - the study would
        run configured differently from what the customer confirmed.
    #>
    param([AllowNull()][object]$InputObject)

    if ($null -eq $InputObject) { return $null }

    $table = @{}
    $pairsSeen = $false
    foreach ($item in @(Get-ChaosItems -InputObject $InputObject | Where-Object { $null -ne $_ })) {
        $key = Get-ChaosBriefValue -InputObject $item -Name 'key'
        if ($null -eq $key) { continue }
        $pairsSeen = $true
        if ([string]::IsNullOrWhiteSpace([string]$key)) { continue }
        $table[[string]$key] = Get-ChaosBriefValue -InputObject $item -Name 'value'
    }
    if ($pairsSeen) { return $table }

    if ($InputObject -is [System.Collections.IDictionary]) {
        foreach ($key in $InputObject.Keys) {
            if ([string]::IsNullOrWhiteSpace([string]$key)) { continue }
            $table[[string]$key] = $InputObject[$key]
        }
        return $table
    }

    if ($InputObject -is [string] -or $InputObject -is [System.ValueType]) { return $null }

    foreach ($property in $InputObject.PSObject.Properties) {
        if ([string]::IsNullOrWhiteSpace($property.Name)) { continue }
        $table[$property.Name] = $property.Value
    }
    return $table
}

function Import-ChaosBriefHandoff {
    <#
    .SYNOPSIS
        Read a confirmed brief and return the scope parameters it supplies.

    .DESCRIPTION
        Returns a hashtable of parameter name -> value covering only the
        parameters the brief can supply and the caller did not. The caller
        assigns them into scope before any other work, so every downstream
        reference sees the final value.

        A brief that is not CONFIRMED is refused. The confirmation phrase is
        what makes the customer's agreement a fact rather than a conversation,
        and scoping from an unconfirmed brief would execute a recommendation
        nobody accepted.
    #>
    param(
        [Parameter(Mandatory)][string]$BriefPath,
        [Parameter(Mandatory)][hashtable]$Bound
    )

    $file = $BriefPath
    if (Test-Path -LiteralPath $file -PathType Container) {
        $file = Join-Path $file 'study-brief.v1.json'
    }
    if (-not (Test-Path -LiteralPath $file)) {
        throw "BriefNotFound: no study brief at '$BriefPath'. Run chaos-study-design and pass the path it prints."
    }

    $brief = Get-Content -LiteralPath $file -Raw | ConvertFrom-Json
    $version = [string](Get-ChaosBriefValue -InputObject $brief -Name 'briefVersion')
    if ($version -ne $ChaosBriefHandoffVersion) {
        throw "BriefIncompatible: brief '$file' is version '$version'; this scope understands '$ChaosBriefHandoffVersion'. Re-run chaos-study-design rather than reinterpreting an artifact written by a different contract."
    }

    $state = [string](Get-ChaosBriefValue -InputObject $brief -Name 'state')
    if ($state -cne 'CONFIRMED') {
        throw "BriefNotConfirmed: brief '$file' is in state '$state'. Only a CONFIRMED brief may be scoped - the customer has not yet accepted a recommendation."
    }

    $handoff = Get-ChaosBriefValue -InputObject $brief -Name 'handoff'
    if ($null -eq $handoff) {
        throw "BriefIncomplete: brief '$file' is confirmed but carries no handoff section."
    }

    $out = @{}
    $take = {
        param([string]$Name, [object]$Value)
        if ($Bound.ContainsKey($Name)) { return }
        if ($null -eq $Value) { return }
        if ($Value -is [string] -and [string]::IsNullOrWhiteSpace($Value)) { return }
        if ($Value -is [array] -and $Value.Count -eq 0) { return }
        $out[$Name] = $Value
    }

    & $take 'SteadyState' ([string](Get-ChaosBriefValue -InputObject $handoff -Name 'steadyState'))
    & $take 'Hypothesis' ([string](Get-ChaosBriefValue -InputObject $handoff -Name 'hypothesis'))
    & $take 'FailureMechanism' ([string](Get-ChaosBriefValue -InputObject $handoff -Name 'failureMechanism'))
    & $take 'MechanismEvidence' ([string](Get-ChaosBriefValue -InputObject $handoff -Name 'mechanismEvidence'))
    & $take 'SignalSource' (@(Get-ChaosItems -InputObject (Get-ChaosBriefValue -InputObject $handoff -Name 'signals') | Where-Object { $_ } | ForEach-Object { [string]$_ }))

    # The probe changes shape across the seam: design records what the analyst
    # observed, scope records what the readiness gate evaluates. Renaming here,
    # once, is better than two contracts drifting.
    $probe = Get-ChaosBriefValue -InputObject $handoff -Name 'mechanismProbe'
    if ($null -ne $probe -and -not $Bound.ContainsKey('MechanismProbe')) {
        $table = @{}
        $signal = [string](Get-ChaosBriefValue -InputObject $probe -Name 'signal')
        $query = [string](Get-ChaosBriefValue -InputObject $probe -Name 'query')
        $direction = [string](Get-ChaosBriefValue -InputObject $probe -Name 'direction')
        $condition = [string](Get-ChaosBriefValue -InputObject $probe -Name 'condition')
        $resource = [string](Get-ChaosBriefValue -InputObject $probe -Name 'resource')
        if (-not [string]::IsNullOrWhiteSpace($signal)) { $table['signal'] = $signal }
        if (-not [string]::IsNullOrWhiteSpace($query)) { $table['query'] = $query }
        if (-not [string]::IsNullOrWhiteSpace($direction)) { $table['expectedDirection'] = $direction }
        if (-not [string]::IsNullOrWhiteSpace($condition)) { $table['condition'] = $condition }
        if (-not [string]::IsNullOrWhiteSpace($resource)) { $table['resourceCorrelation'] = $resource }
        if ($table.Count -gt 0) { $out['MechanismProbe'] = $table }
    }

    # Exposure inputs. An unmeasured input stays absent rather than becoming
    # zero, because zero is a measurement and absent is not.
    $exposure = Get-ChaosBriefValue -InputObject $handoff -Name 'exposure'
    if ($null -ne $exposure) {
        foreach ($map in @(
                @{ brief = 'eventRatePerSecond'; scope = 'EventRatePerSecond' },
                @{ brief = 'vulnerableWindowSeconds'; scope = 'VulnerableWindowSeconds' },
                @{ brief = 'eligibleFraction'; scope = 'EligibleFraction' })) {
            $value = Get-ChaosBriefValue -InputObject $exposure -Name $map.brief
            if ($null -ne $value) { & $take $map.scope ([double]$value) }
        }
        $assumption = [string](Get-ChaosBriefValue -InputObject $exposure -Name 'assumption')
        if (-not [string]::IsNullOrWhiteSpace($assumption)) { & $take 'ExerciseAssumption' (@($assumption)) }
    }

    # Blast radius. Anything that does not map is surfaced, never approximated.
    $blast = Get-ChaosBriefValue -InputObject $handoff -Name 'blastRadius'
    if ($null -ne $blast) {
        $mapped = ConvertFrom-ChaosBriefBlastRadius `
            -Filters (Get-ChaosBriefValue -InputObject $blast -Name 'filters') `
            -Exclusions (Get-ChaosBriefValue -InputObject $blast -Name 'exclusions')

        & $take 'FilterLocation' (@($mapped['FilterLocation']))
        & $take 'FilterZone' (@($mapped['FilterZone']))
        & $take 'FilterPhysicalZone' $mapped['FilterPhysicalZone']
        & $take 'ExcludeResource' (@($mapped['ExcludeResource']))
        & $take 'ExcludeType' (@($mapped['ExcludeType']))
        if ($mapped['ExcludeTag'].Count -gt 0) { & $take 'ExcludeTag' $mapped['ExcludeTag'] }

        foreach ($note in (Get-ChaosItems -InputObject $mapped['unmapped'])) {
            Write-ChaosStudyNote "Brief blast-radius entry '$note' has no scope parameter and was NOT applied. Pass it explicitly if it must constrain this run."
        }
    }

    # Parameters cross the seam as two separate tables. Scope validates the
    # scenario set against the scenario's live spec and the action set against
    # the action's schema, so folding them together here would reroute a value
    # into the wrong validator - the exact defect this split exists to prevent.
    foreach ($map in @(
            @{ brief = 'parameters'; scope = 'Parameters' },
            @{ brief = 'actionParameters'; scope = 'ActionParameters' })) {
        if ($Bound.ContainsKey($map.scope)) { continue }
        $table = ConvertFrom-ChaosBriefParameterTable -InputObject (Get-ChaosBriefValue -InputObject $handoff -Name $map.brief)
        if ($null -ne $table -and $table.Count -gt 0) { $out[$map.scope] = $table }
    }

    # Scenario and action come from live discovery, not from the brief, unless
    # discovery already ran during design and matched exactly one. An ambiguous
    # match is left unset so the operator chooses against the live list.
    $constraints = Get-ChaosBriefValue -InputObject $handoff -Name 'discoveryConstraints'
    if ($null -ne $constraints) {
        $actions = @(Get-ChaosItems -InputObject (Get-ChaosBriefValue -InputObject $constraints -Name 'matchedActions') | Where-Object { $_ })
        $scenarios = @(Get-ChaosItems -InputObject (Get-ChaosBriefValue -InputObject $constraints -Name 'matchedScenarios') | Where-Object { $_ })
        if ($actions.Count -eq 1) { & $take 'Action' ([string](Get-ChaosBriefValue -InputObject $actions[0] -Name 'name')) }
        if ($scenarios.Count -eq 1) { & $take 'Scenario' ([string](Get-ChaosBriefValue -InputObject $scenarios[0] -Name 'name')) }
    }

    return $out
}
