# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

<#
.SYNOPSIS
    Candidate hypotheses: what could be worth testing, ranked, and whether the
    platform can actually test it.

.DESCRIPTION
    A candidate is a complete, falsifiable proposal - not a fault name. Naming a
    fault is easy and tells nobody anything; the hard part is saying which code
    path breaks, how you would know, and what result would prove you wrong. So
    every candidate here has to carry the whole chain before it can be ranked:

        dependency edge -> failure mechanism -> predicate impact -> probe

    Two things this file deliberately refuses to do:

      * It will not invent an action. Candidates describe what they NEED from
        the platform; whether that exists is decided by live discovery against
        Microsoft.Chaos/locations/{region}/actions, never by a bundled list.
      * It will not quietly downgrade "we could not ask Azure" into "nothing is
        available". Those lead to opposite decisions. When discovery has not
        run, candidates are marked provisional and the brief carries L15.

    Requires Common.ps1 to be dot-sourced first.
#>

Set-StrictMode -Version Latest

# Fields without which a candidate cannot be evaluated, and the reason each is
# non-negotiable. Printed verbatim when one is missing, because "field required"
# teaches nothing.
$ChaosCandidateRequired = [ordered]@{
    title                = 'A one-line name for the hypothesis.'
    dependencyEdge       = 'Which caller-to-dependency edge is under test. Without it there is nothing to point the action at.'
    codePath             = 'The code path that runs when that edge degrades - file, symbol or route.'
    failureMechanism     = 'How the action effect becomes a code or dependency failure, and how that failure reaches the predicate. This is the causal claim the study is testing.'
    mechanismEvidence    = 'The file, symbol or architecture reference the mechanism was read from. A mechanism nobody can check is a guess.'
    mechanismProbe       = 'The exact data-plane signal that shows the mechanism actually engaged, with the direction expected. Without it, an unrelated signal moving looks like proof.'
    hypothesis           = 'The prediction, stated so that it can come back false.'
    steadyStatePredicate = 'The measurable condition that defines "still working", with its threshold.'
}

$ChaosConfidenceRank = @{ high = 3; medium = 2; low = 1 }

function ConvertTo-ChaosCandidate {
    <#
    .SYNOPSIS
        Validate and normalise one candidate hypothesis.

    .DESCRIPTION
        Throws DesignIncomplete naming the missing field and why it matters.
        Presence is what a script can check; whether the mechanism is true stays
        with the agent and with code review, which is why every candidate also
        has to cite where it came from.
    #>
    param(
        [Parameter(Mandatory)][object]$Raw,
        [int]$Index = 0
    )

    $label = [string](Get-ChaosMember -InputObject $Raw -Name 'title')
    if ([string]::IsNullOrWhiteSpace($label)) { $label = "candidate #$($Index + 1)" }

    $candidate = [ordered]@{}
    foreach ($field in $ChaosCandidateRequired.Keys) {
        $value = Get-ChaosMember -InputObject $Raw -Name $field
        if ($field -eq 'mechanismProbe') {
            $candidate[$field] = ConvertTo-ChaosCandidateProbe -Raw $value -Label $label
            continue
        }
        $text = [string]$value
        if ([string]::IsNullOrWhiteSpace($text)) {
            throw "DesignIncomplete: $label is missing '$field'. $($ChaosCandidateRequired[$field])"
        }
        $candidate[$field] = $text.Trim()
    }

    $evidence = @(Get-ChaosItems -InputObject (Get-ChaosMember -InputObject $Raw -Name 'evidence') | Where-Object { $_ })
    if ($evidence.Count -eq 0) {
        throw "DesignIncomplete: $label cites no evidence. List the files, symbols or resources this hypothesis was read from - a candidate with no citations cannot be reviewed, only believed."
    }

    $confidence = [string](Get-ChaosMember -InputObject $Raw -Name 'confidence')
    if ([string]::IsNullOrWhiteSpace($confidence)) { $confidence = 'low' }
    $confidence = $confidence.Trim().ToLowerInvariant()
    if (-not $ChaosConfidenceRank.ContainsKey($confidence)) {
        throw "DesignIncomplete: $label has confidence '$confidence'. Use high, medium or low."
    }

    $candidate['id'] = [string](Get-ChaosMember -InputObject $Raw -Name 'id')
    if ([string]::IsNullOrWhiteSpace($candidate['id'])) { $candidate['id'] = "C$($Index + 1)" }
    $candidate['confidence'] = $confidence
    $candidate['evidence'] = @($evidence | ForEach-Object { [string]$_ })
    $candidate['signals'] = @(Get-ChaosItems -InputObject (Get-ChaosMember -InputObject $Raw -Name 'signals') | Where-Object { $_ } | ForEach-Object { [string]$_ })
    $candidate['collateralRisks'] = @(Get-ChaosItems -InputObject (Get-ChaosMember -InputObject $Raw -Name 'collateralRisks') | Where-Object { $_ } | ForEach-Object { [string]$_ })
    $candidate['telemetryGaps'] = @(Get-ChaosItems -InputObject (Get-ChaosMember -InputObject $Raw -Name 'telemetryGaps') | Where-Object { $_ } | ForEach-Object { [string]$_ })
    $candidate['abortCriteria'] = [string](Get-ChaosMember -InputObject $Raw -Name 'abortCriteria')
    $candidate['blastRadius'] = ConvertTo-ChaosCandidateBlastRadius -Raw (Get-ChaosMember -InputObject $Raw -Name 'blastRadius')
    $candidate['exposure'] = ConvertTo-ChaosCandidateExposure -Raw (Get-ChaosMember -InputObject $Raw -Name 'exposure')
    $candidate['actionRequirements'] = ConvertTo-ChaosActionRequirement -Raw (Get-ChaosMember -InputObject $Raw -Name 'actionRequirements') -Label $label
    $candidate['availability'] = [ordered]@{ state = 'unknown'; reason = 'Live action discovery has not run yet.'; matchedActions = @(); matchedScenarios = @() }
    $candidate['rank'] = 0
    return $candidate
}

function ConvertTo-ChaosCandidateProbe {
    <#
    .SYNOPSIS
        Normalise the mechanism probe - the signal that proves the fault
        actually engaged.

    .DESCRIPTION
        The probe is the difference between "something moved during the window"
        and "the thing we predicted moved, in the direction we predicted". A
        probe without a direction is the former, which is why direction is
        required rather than defaulted.
    #>
    param(
        [Parameter(Mandatory)][AllowNull()][object]$Raw,
        [Parameter(Mandatory)][string]$Label
    )
    if ($null -eq $Raw) {
        throw "DesignIncomplete: $Label has no mechanismProbe. $($ChaosCandidateRequired['mechanismProbe'])"
    }
    if ($Raw -is [string]) {
        throw "DesignIncomplete: $Label gave mechanismProbe as free text. It needs a structured probe: { signal, direction, condition, resource } - a sentence cannot be evaluated against the action window."
    }
    $signal = [string](Get-ChaosMember -InputObject $Raw -Name 'signal')
    $direction = [string](Get-ChaosMember -InputObject $Raw -Name 'direction')
    if ([string]::IsNullOrWhiteSpace($signal)) { throw "DesignIncomplete: $Label has a mechanismProbe with no signal." }
    if ([string]::IsNullOrWhiteSpace($direction)) {
        throw "DesignIncomplete: $Label has a mechanismProbe with no expected direction. Say which way the signal should move (increase, decrease, appear) or an unrelated wobble will read as proof."
    }
    return [ordered]@{
        signal    = $signal.Trim()
        direction = $direction.Trim()
        condition = [string](Get-ChaosMember -InputObject $Raw -Name 'condition')
        resource  = [string](Get-ChaosMember -InputObject $Raw -Name 'resource')
        query     = [string](Get-ChaosMember -InputObject $Raw -Name 'query')
    }
}

function ConvertTo-ChaosCandidateBlastRadius {
    <#
    .SYNOPSIS
        Normalise the suggested blast radius. Suggestion only - the customer
        confirms it in the interview and scope enforces it.
    #>
    param([AllowNull()][object]$Raw)
    if ($null -eq $Raw) { return [ordered]@{ filters = @(); exclusions = @(); note = $null } }
    return [ordered]@{
        filters    = @(Get-ChaosItems -InputObject (Get-ChaosMember -InputObject $Raw -Name 'filters') | Where-Object { $_ } | ForEach-Object { [string]$_ })
        exclusions = @(Get-ChaosItems -InputObject (Get-ChaosMember -InputObject $Raw -Name 'exclusions') | Where-Object { $_ } | ForEach-Object { [string]$_ })
        note       = [string](Get-ChaosMember -InputObject $Raw -Name 'note')
    }
}

function ConvertTo-ChaosCandidateExposure {
    <#
    .SYNOPSIS
        Normalise the exposure arithmetic inputs. Unknown stays null.

    .DESCRIPTION
        These feed the readiness gate that catches a study expecting zero
        vulnerable events. Guessing a rate here would defeat that gate entirely,
        so an absent input stays absent and is reported as unknown rather than
        filled in with something reasonable-looking.
    #>
    param([AllowNull()][object]$Raw)
    $number = {
        param($value)
        if ($null -eq $value -or ($value -is [string] -and [string]::IsNullOrWhiteSpace($value))) { return $null }
        return [double]$value
    }
    if ($null -eq $Raw) {
        return [ordered]@{ eventRatePerSecond = $null; vulnerableWindowSeconds = $null; eligibleFraction = $null; assumption = $null }
    }
    return [ordered]@{
        eventRatePerSecond      = & $number (Get-ChaosMember -InputObject $Raw -Name 'eventRatePerSecond')
        vulnerableWindowSeconds = & $number (Get-ChaosMember -InputObject $Raw -Name 'vulnerableWindowSeconds')
        eligibleFraction        = & $number (Get-ChaosMember -InputObject $Raw -Name 'eligibleFraction')
        assumption              = [string](Get-ChaosMember -InputObject $Raw -Name 'assumption')
    }
}

function ConvertTo-ChaosActionRequirement {
    <#
    .SYNOPSIS
        What the candidate needs the platform to be able to do.

    .DESCRIPTION
        Stated as requirements, not as an action name, because the action name
        is not knowable before discovery runs. A candidate says "I need
        something that makes this resource type unreachable"; discovery decides
        whether such a thing exists in this region today.
    #>
    param(
        [AllowNull()][object]$Raw,
        [Parameter(Mandatory)][string]$Label
    )
    if ($null -eq $Raw) {
        throw "DesignIncomplete: $Label has no actionRequirements. Say which resource type must be affected and what effect is needed, so live discovery can decide whether the platform can do it."
    }
    $resourceType = [string](Get-ChaosMember -InputObject $Raw -Name 'resourceType')
    $effect = [string](Get-ChaosMember -InputObject $Raw -Name 'effect')
    if ([string]::IsNullOrWhiteSpace($resourceType)) {
        throw "DesignIncomplete: $Label has actionRequirements with no resourceType (for example Microsoft.Compute/virtualMachines)."
    }
    if ([string]::IsNullOrWhiteSpace($effect)) {
        throw "DesignIncomplete: $Label has actionRequirements with no effect. Describe what has to happen to the resource, not which fault to use."
    }
    return [ordered]@{
        resourceType = $resourceType.Trim()
        effect       = $effect.Trim()
        keywords     = @(Get-ChaosItems -InputObject (Get-ChaosMember -InputObject $Raw -Name 'keywords') | Where-Object { $_ } | ForEach-Object { [string]$_ })
        continuous   = Get-ChaosMember -InputObject $Raw -Name 'continuous'
    }
}

function Resolve-ChaosCandidateAvailability {
    <#
    .SYNOPSIS
        Intersect candidates with what the platform actually offers here, today.

    .DESCRIPTION
        Three outcomes, kept distinct on purpose:

          available   the region offers at least one action for this resource
                      type; the matches are listed for the customer to choose
          unavailable discovery ran and offers nothing for this resource type.
                      A real answer: the study cannot be run as designed
          provisional discovery did NOT run. Not the same as unavailable, and
                      collapsing the two is how a plugin ends up recommending a
                      fault that does not exist in the customer's region

        Matching is by resource type first, because that is the field the
        service is authoritative about. Keywords only reorder the matches within
        a resource type - they never manufacture one.
    #>
    param(
        [Parameter(Mandatory)][AllowEmptyCollection()][object[]]$Candidates,
        [AllowNull()][object[]]$Actions,
        [AllowNull()][object[]]$Scenarios,
        [AllowNull()][AllowEmptyString()][string]$UnavailableReason
    )

    foreach ($candidate in $Candidates) {
        if ($null -eq $candidate) { continue }
        $requirement = Get-ChaosMember -InputObject $candidate -Name 'actionRequirements'
        $resourceType = [string](Get-ChaosMember -InputObject $requirement -Name 'resourceType')

        if ($null -eq $Actions) {
            $candidate.availability = [ordered]@{
                state            = 'provisional'
                reason           = if ([string]::IsNullOrWhiteSpace($UnavailableReason)) { 'Live action discovery did not run, so platform availability is unverified.' } else { $UnavailableReason }
                matchedActions   = @()
                matchedScenarios = @()
            }
            continue
        }

        $matches = @($Actions | Where-Object {
                $null -ne $_ -and (@(Get-ChaosItems -InputObject (Get-ChaosMember -InputObject $_ -Name 'appliesTo') | ForEach-Object { [string](Get-ChaosMember -InputObject $_ -Name 'resourceType') }) -contains $resourceType)
            })

        if ($matches.Count -eq 0) {
            $candidate.availability = [ordered]@{
                state            = 'unavailable'
                reason           = "Live discovery returned no action for '$resourceType' in this region. This hypothesis cannot be tested with Chaos Studio as designed."
                matchedActions   = @()
                matchedScenarios = @()
            }
            continue
        }

        $keywords = @(Get-ChaosItems -InputObject (Get-ChaosMember -InputObject $requirement -Name 'keywords') | Where-Object { $_ })
        $ordered = @($matches | Sort-Object -Descending -Property @{ Expression = {
                    $score = 0
                    $text = "$([string](Get-ChaosMember -InputObject $_ -Name 'name')) $([string](Get-ChaosMember -InputObject $_ -Name 'displayName')) $([string](Get-ChaosMember -InputObject $_ -Name 'description'))"
                    foreach ($keyword in $keywords) {
                        if ($text -match ('(?i)' + [regex]::Escape([string]$keyword))) { $score++ }
                    }
                    $score
                }
            })

        $candidate.availability = [ordered]@{
            state            = 'available'
            reason           = "Live discovery returned $($matches.Count) action(s) applicable to '$resourceType'."
            matchedActions   = @($ordered | ForEach-Object {
                    [ordered]@{
                        name        = [string](Get-ChaosMember -InputObject $_ -Name 'name')
                        canonicalId = [string](Get-ChaosMember -InputObject $_ -Name 'canonicalId')
                        actionType  = [string](Get-ChaosMember -InputObject $_ -Name 'actionType')
                        displayName = [string](Get-ChaosMember -InputObject $_ -Name 'displayName')
                    }
                })
            matchedScenarios = @(Select-ChaosCandidateScenario -Scenarios $Scenarios -ResourceType $resourceType)
        }
    }

    return @($Candidates)
}

function Select-ChaosCandidateScenario {
    <#
    .SYNOPSIS
        Workspace-recommended scenarios that mention this resource type.

    .DESCRIPTION
        Advisory. A recommendation is the platform's opinion about the
        customer's discovered resources, which is useful context but is not the
        study's hypothesis and must not become it.
    #>
    param(
        [AllowNull()][object[]]$Scenarios,
        [Parameter(Mandatory)][string]$ResourceType
    )
    if ($null -eq $Scenarios) { return @() }
    $short = ($ResourceType -split '/')[-1]
    return @($Scenarios | Where-Object {
            if ($null -eq $_) { return $false }
            $text = "$([string](Get-ChaosMember -InputObject $_ -Name 'name')) $([string](Get-ChaosMember -InputObject $_ -Name 'displayName')) $([string](Get-ChaosMember -InputObject $_ -Name 'description'))"
            return ($text -match ('(?i)' + [regex]::Escape($short)))
        } | ForEach-Object {
            [ordered]@{
                name        = [string](Get-ChaosMember -InputObject $_ -Name 'name')
                displayName = [string](Get-ChaosMember -InputObject $_ -Name 'displayName')
            }
        })
}

function Set-ChaosCandidateRank {
    <#
    .SYNOPSIS
        Rank candidates so the customer is shown a shortlist rather than a pile.

    .DESCRIPTION
        Order: availability first (an untestable hypothesis cannot lead the
        list, however interesting), then confidence, then how much evidence
        backs it, then whether the exposure arithmetic can even be computed.
        Ranking is advisory - the customer chooses, and the reasons are printed
        alongside so the ordering can be argued with.
    #>
    param([Parameter(Mandatory)][AllowEmptyCollection()][object[]]$Candidates)

    $availabilityRank = @{ available = 3; provisional = 2; unknown = 1; unavailable = 0 }
    $sorted = @($Candidates | Where-Object { $_ } | Sort-Object -Descending -Property `
        @{ Expression = { $availabilityRank[[string](Get-ChaosMember -InputObject (Get-ChaosMember -InputObject $_ -Name 'availability') -Name 'state')] } }, `
        @{ Expression = { $ChaosConfidenceRank[[string](Get-ChaosMember -InputObject $_ -Name 'confidence')] } }, `
        @{ Expression = { @(Get-ChaosItems -InputObject (Get-ChaosMember -InputObject $_ -Name 'evidence')).Count } }, `
        @{ Expression = { if ($null -ne (Get-ChaosMember -InputObject (Get-ChaosMember -InputObject $_ -Name 'exposure') -Name 'eventRatePerSecond')) { 1 } else { 0 } } })

    $rank = 0
    foreach ($candidate in $sorted) {
        $rank++
        Set-ChaosValue -InputObject $candidate -Name 'rank' -Value $rank
    }
    return @($sorted)
}

function Get-ChaosCandidateById {
    <#
    .SYNOPSIS
        Resolve a candidate reference by id, rank or exact title.
    #>
    param(
        [Parameter(Mandatory)][AllowEmptyCollection()][object[]]$Candidates,
        [Parameter(Mandatory)][string]$Reference
    )
    $needle = $Reference.Trim()
    foreach ($field in @('id', 'title')) {
        $hit = @($Candidates | Where-Object { $_ -and ([string](Get-ChaosMember -InputObject $_ -Name $field)) -ieq $needle })
        if ($hit.Count -eq 1) { return $hit[0] }
    }
    $rank = 0
    if ([int]::TryParse($needle, [ref]$rank)) {
        $hit = @($Candidates | Where-Object { $_ -and [int](Get-ChaosMember -InputObject $_ -Name 'rank') -eq $rank })
        if ($hit.Count -eq 1) { return $hit[0] }
    }
    $known = ($Candidates | ForEach-Object { "$([string](Get-ChaosMember -InputObject $_ -Name 'id')) ($([string](Get-ChaosMember -InputObject $_ -Name 'title')))" }) -join '; '
    throw "No candidate matches '$Reference'. Known candidates: $known"
}
