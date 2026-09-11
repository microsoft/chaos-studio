#Requires -Version 7.0
<#
.SYNOPSIS
    Preconditions that decide whether a study's result will mean anything.

.DESCRIPTION
    Running a study is cheap. Running one whose result cannot be interpreted is
    expensive, because it consumes a change window and then produces a document
    that looks like evidence. These gates check, before any fault is planned,
    the conditions that separate those two outcomes:

      steady state    without a numeric objective stated in advance there is
                      nothing to breach, so there is nothing to pass either
      scope           the workspace has to have discovered something, or the
                      run touches nothing and reports success
      action fit      the action must be one the service reports for a resource
                      type in scope, with the parameters its schema requires
      observability   without a signal source the study can only prove the
                      control plane accepted the scenario run
      blast radius    a window long enough to observe, short enough to bound

    Gates are `blocking` or `advisory`. Blocking gates stop scoping with exit
    code 10. Advisory gates become limitations on the report - they weaken the
    conclusion without invalidating it.

    A gate that cannot be evaluated returns 'unknown', never 'pass'. The two
    lead to different next actions and collapsing them loses the distinction
    exactly when it matters.

    Nothing here knows what kind of resource is being studied. Every fact about
    the fault comes from the live action record discovered at scope time.
#>

Set-StrictMode -Version Latest

. (Join-Path $PSScriptRoot '..' '..' '..' 'chaos-study' 'scripts' 'lib' 'Common.ps1')
. (Join-Path $PSScriptRoot '..' '..' '..' 'chaos-study' 'scripts' 'lib' 'SignalIdentity.ps1')
. (Join-Path $PSScriptRoot '..' '..' '..' 'chaos-study' 'scripts' 'lib' 'ExecutionPlan.ps1')
. (Join-Path $PSScriptRoot 'ActionDiscovery.ps1')

function New-ChaosReadinessGate {
    param(
        [Parameter(Mandatory)][string]$Id,
        [Parameter(Mandatory)][string]$Title,
        [Parameter(Mandatory)][ValidateSet('pass', 'fail', 'unknown')][string]$Status,
        [Parameter(Mandatory)][ValidateSet('blocking', 'advisory')][string]$Severity,
        [Parameter(Mandatory)][string]$Detail,
        [AllowNull()][AllowEmptyString()][string]$Remediation = $null,
        [AllowNull()][AllowEmptyString()][string]$LimitationCode = $null
    )
    return [pscustomobject]@{
        id             = $Id
        title          = $Title
        status         = $Status
        severity       = $Severity
        detail         = $Detail
        remediation    = $Remediation
        limitationCode = $LimitationCode
    }
}

function Test-ChaosSteadyStatePredicate {
    <#
    .SYNOPSIS
        Blocking: a study without a stated objective cannot fail, so it cannot
        pass either.
    #>
    param([AllowNull()][object]$Predicate)

    if ($null -eq $Predicate -or -not $Predicate.signal -or $null -eq $Predicate.threshold) {
        return New-ChaosReadinessGate -Id 'steady-state' -Title 'Steady state is defined numerically' `
            -Status 'fail' -Severity 'blocking' `
            -Detail 'No steady-state predicate was supplied. Without a signal, a comparison and a threshold stated before injection, there is no definition of "breached", so the study cannot produce a verdict - only a narrative.' `
            -Remediation 'Re-run with -SteadyState "successRate >= 99.5" (or a latency objective).'
    }

    return New-ChaosReadinessGate -Id 'steady-state' -Title 'Steady state is defined numerically' `
        -Status 'pass' -Severity 'blocking' `
        -Detail "Steady state: $($Predicate.signal) $($Predicate.comparison) $($Predicate.threshold)$($Predicate.unit)."
}

function Test-ChaosScopePopulated {
    <#
    .SYNOPSIS
        Blocking: did the workspace actually discover anything to act on?

    .DESCRIPTION
        A workspace whose scopes resolve to no discovered resources will accept
        a scenario configuration and run it to a clean Succeeded. Nothing was
        touched, so nothing broke, and the report reads like a pass. That is the
        single most misleading outcome this suite can produce, so an empty scope
        stops scoping outright.

        That verdict depends on having actually looked. When discovery was
        deliberately skipped the count is not zero, it is unknown, and the gate
        says so instead of failing: reporting "no resources" for a question we
        never asked would be inventing evidence. The plan then carries L10 and
        the run refuses to arm until discovery has confirmed the scope.
    #>
    param(
        [AllowNull()][AllowEmptyCollection()][object[]]$ScopedResources,
        [switch]$DiscoverySkipped,
        [AllowNull()][object]$DiscoveredCount
    )

    $count = @(@($ScopedResources) | Where-Object { $null -ne $_ }).Count

    if ($DiscoverySkipped) {
        return New-ChaosReadinessGate -Id 'scope-populated' -Title 'Workspace scope contains resources' `
            -Status 'unknown' -Severity 'blocking' -LimitationCode 'L10' `
            -Detail 'Discovery was skipped, so the workspace was never asked what it discovered. Whether the scope resolves to any resource at all is unverified.' `
            -Remediation 'Re-scope without -SkipDiscovery before running this study, so an empty scope cannot be mistaken for a resilient result.'
    }

    # An empty workspace and a blast radius that filtered everything away are
    # different problems with different fixes. Telling an operator to refresh
    # recommendations when their own exclusions emptied the scope sends them to
    # the wrong place, so the two are reported separately.
    $discovered = if ($null -ne $DiscoveredCount) { [int]$DiscoveredCount } else { $count }

    if ($count -eq 0 -and $discovered -gt 0) {
        return New-ChaosReadinessGate -Id 'scope-populated' -Title 'Workspace scope contains resources' `
            -Status 'fail' -Severity 'blocking' `
            -Detail "The workspace discovered $discovered resource(s), but the blast radius removed all of them. A scenario run against an empty scope succeeds without touching anything, which is indistinguishable from a resilient result." `
            -Remediation 'Widen or drop the blast-radius filters and exclusions. The workspace itself is populated, so refreshing recommendations will not change this.'
    }

    if ($count -eq 0) {
        return New-ChaosReadinessGate -Id 'scope-populated' -Title 'Workspace scope contains resources' `
            -Status 'fail' -Severity 'blocking' `
            -Detail 'The workspace reported no discovered resources. A scenario run against an empty scope succeeds without touching anything, which is indistinguishable from a resilient result.' `
            -Remediation 'Check the workspace scopes cover the resources you meant to study, then run az chaos workspace refresh-recommendation and re-scope.'
    }

    return New-ChaosReadinessGate -Id 'scope-populated' -Title 'Workspace scope contains resources' `
        -Status 'pass' -Severity 'blocking' `
        -Detail "The workspace reported $count discovered resource(s) in scope."
}

function Test-ChaosActionScopeFit {
    <#
    .SYNOPSIS
        Blocking: does the service report this action for a type in scope?

    .DESCRIPTION
        The answer comes from the action record the service returned, not from
        a local expectation about what the action ought to support. When no
        resource type in scope appears in the action's applicability list the
        run has nothing to act on, and finding that out here costs nothing.
    #>
    param(
        [Parameter(Mandatory)][object]$Action,
        [AllowNull()][AllowEmptyCollection()][string[]]$ScopedResourceTypes
    )

    $supported = @($Action.appliesTo | ForEach-Object { $_.resourceType })
    $inScope = @(@($ScopedResourceTypes) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })

    if ($inScope.Count -eq 0) {
        # An unverified action has no appliesTo list; appending an empty join
        # would print a dangling "for: ." and imply the service said nothing.
        $supportedText = if ($supported.Count -gt 0) { " The service reports this action for: $($supported -join ', ')." } else { '' }
        return New-ChaosReadinessGate -Id 'action-scope-fit' -Title 'Action applies to a resource in scope' `
            -Status 'unknown' -Severity 'advisory' `
            -Detail "No resource type could be read from the workspace scope, so its fit with action '$($Action.name)' is unverified.$supportedText" `
            -LimitationCode 'L10'
    }

    $overlap = @($inScope | Where-Object { $supported -contains $_ })
    if ($overlap.Count -eq 0) {
        return New-ChaosReadinessGate -Id 'action-scope-fit' -Title 'Action applies to a resource in scope' `
            -Status 'fail' -Severity 'blocking' `
            -Detail "Chaos Studio reports action '$($Action.name)' for $($supported -join ', '), none of which are in scope ($($inScope -join ', ')). The run would act on nothing." `
            -Remediation 'Run scoping with -ListActions to see the actions the service reports for the resource types this workspace discovered.'
    }

    return New-ChaosReadinessGate -Id 'action-scope-fit' -Title 'Action applies to a resource in scope' `
        -Status 'pass' -Severity 'blocking' `
        -Detail "The service reports action '$($Action.name)' for $($overlap -join ', '), which is in scope."
}

function Test-ChaosActionParameterFit {
    <#
    .SYNOPSIS
        Blocking: do the supplied *action* parameters satisfy the action's live
        schema?

    .DESCRIPTION
        Actions and scenarios each publish their own parameter schema and the
        two are not interchangeable. A scenario parameter such as a duration is
        declared by the scenario, never by the action, so checking it against
        the action's schema rejects a perfectly valid study. This gate is
        deliberately narrow: it sees only what the caller supplied as action
        parameters. Scenario parameters are checked by
        Test-ChaosScenarioParameterFit against the scenario's own live spec.
    #>
    param(
        [Parameter(Mandatory)][object]$Action,
        [AllowNull()][object]$ActionParameters
    )

    $Parameters = $ActionParameters
    $schema = $Action.parametersSchema
    if ($null -eq $schema) {
        return New-ChaosReadinessGate -Id 'action-parameters' -Title 'Action parameters match the service schema' `
            -Status 'unknown' -Severity 'advisory' `
            -Detail "Chaos Studio returned no parameter schema for action '$($Action.name)', so the supplied action parameters could not be checked before injection." `
            -LimitationCode 'L10'
    }

    $problems = ConvertTo-ChaosList (Test-ChaosActionParameters -Schema $schema -Parameters $Parameters)
    if ($problems.Count -gt 0) {
        return New-ChaosReadinessGate -Id 'action-parameters' -Title 'Action parameters match the service schema' `
            -Status 'fail' -Severity 'blocking' `
            -Detail ($problems -join ' ') `
            -Remediation 'Run scoping with -ListActions to print this action''s parameter schema, then supply -ActionParameters accordingly. Values the scenario declares - a duration, for example - belong in -Parameters, not -ActionParameters.'
    }

    $specs = ConvertTo-ChaosList (Get-ChaosActionParameterSpec -Schema $schema)
    $requiredNames = @($specs | Where-Object { $_.required } | ForEach-Object { $_.name })
    $detail = if ($requiredNames.Count -gt 0) {
        "All required parameters supplied: $($requiredNames -join ', ')."
    } else {
        'This action declares no required parameters.'
    }

    return New-ChaosReadinessGate -Id 'action-parameters' -Title 'Action parameters match the service schema' `
        -Status 'pass' -Severity 'blocking' -Detail $detail
}

function Test-ChaosScenarioParameterFit {
    <#
    .SYNOPSIS
        Do the supplied scenario parameters satisfy the scenario's live spec?

    .DESCRIPTION
        The configuration API takes scenario parameters, so this is the schema
        that actually governs what -Parameters may contain. Two states matter
        and they are graded differently.

        When the scenario came from live discovery its parameter list is
        authoritative, so a missing required parameter or an unrecognised key
        is blocking - the platform would reject the configuration, and finding
        that here costs nothing.

        When the scenario is unverified-offline there is no spec to check
        against. That is recorded as a provisional advisory, not a pass and not
        a rejection: the service's own configuration validation stays the
        authority, which is the only honest answer when the suite never saw the
        schema. Guessing in either direction would either block a valid study
        or claim a check that never happened.
    #>
    param(
        [AllowNull()][object]$Scenario,
        [AllowNull()][object]$Parameters
    )

    $supplied = @()
    if ($null -ne $Parameters) {
        $supplied = if ($Parameters -is [System.Collections.IDictionary]) {
            @($Parameters.Keys | ForEach-Object { [string]$_ })
        } else {
            @($Parameters.PSObject.Properties | ForEach-Object { $_.Name })
        }
    }
    $supplied = @($supplied | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })

    $specs = @()
    if ($null -ne $Scenario -and $Scenario.PSObject.Properties.Name -contains 'parameters') {
        $specs = @(@($Scenario.parameters) | Where-Object { $null -ne $_ })
    }

    $discovered = ($null -ne $Scenario -and $Scenario.PSObject.Properties.Name -contains 'discovered' -and $Scenario.discovered -eq $true)

    if ($specs.Count -eq 0) {
        $detail = if ($supplied.Count -gt 0) {
            "The scenario published no parameter list, so $($supplied.Count) supplied parameter(s) - $($supplied -join ', ') - could not be checked here. Chaos Studio validates the configuration before the run starts and remains the authority."
        } else {
            'The scenario published no parameter list and none were supplied. Chaos Studio validates the configuration before the run starts.'
        }
        return New-ChaosReadinessGate -Id 'scenario-parameters' -Title 'Scenario parameters match the service schema' `
            -Status 'unknown' -Severity 'advisory' -Detail $detail -LimitationCode 'L10'
    }

    $known = @($specs | ForEach-Object { [string]$_.name } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    $requiredNames = @($specs | Where-Object { $_.required -eq $true } | ForEach-Object { [string]$_.name })

    $problems = @()
    foreach ($name in $requiredNames) {
        if ($supplied -notcontains $name) {
            $problems += "The scenario requires parameter '$name' but it was not supplied."
        }
    }
    foreach ($name in $supplied) {
        if ($known -notcontains $name) {
            $problems += "Parameter '$name' is not declared by scenario '$($Scenario.name)'. Declared: $($known -join ', ')."
        }
    }

    if ($problems.Count -gt 0) {
        # Only a live spec is trustworthy enough to reject on. An offline record
        # carrying a stale list must not block a study the service would accept.
        $severity = if ($discovered) { 'blocking' } else { 'advisory' }
        $status = if ($discovered) { 'fail' } else { 'unknown' }
        $limitation = if ($discovered) { $null } else { 'L10' }
        return New-ChaosReadinessGate -Id 'scenario-parameters' -Title 'Scenario parameters match the service schema' `
            -Status $status -Severity $severity `
            -Detail ($problems -join ' ') `
            -Remediation 'Run scoping with -ListScenarios to print this scenario''s parameter list, then supply -Parameters accordingly. Values the action declares belong in -ActionParameters.' `
            -LimitationCode $limitation
    }

    $detail = if ($requiredNames.Count -gt 0) {
        "All required scenario parameters supplied: $($requiredNames -join ', ')."
    } else {
        'This scenario declares no required parameters.'
    }
    return New-ChaosReadinessGate -Id 'scenario-parameters' -Title 'Scenario parameters match the service schema' `
        -Status 'pass' -Severity 'blocking' -Detail $detail
}

function Test-ChaosObservabilityCoverage {
    <#
    .SYNOPSIS
        Advisory: is any signal source configured that could prove the fault
        landed?
    #>
    param(
        [Parameter(Mandatory)][AllowEmptyCollection()][string[]]$AvailableSources,
        [AllowNull()][object]$SteadyState = $null
    )

    if (@($AvailableSources).Count -eq 0) {
        return New-ChaosReadinessGate -Id 'observability' -Title 'A signal can prove the fault landed' `
            -Status 'fail' -Severity 'advisory' `
            -Detail 'No signal source was configured. The study can still run, but it will only be able to prove that the control plane accepted the scenario run - never that the fault reached the workload. Every finding will carry mechanismProven: false.' `
            -Remediation 'Re-run with -SignalSource "metrics:<metricName>" or -SignalSource "logs:<workspaceId>#<kql>".' `
            -LimitationCode 'L3'
    }

    # A predicate naming a signal that nothing collects is the quietest way for
    # a study to be useless: it runs, it reports, and the objective is simply
    # never evaluated. That is caught here rather than discovered in the report.
    #
    # The objective names a *signal*; a source names *where the number comes
    # from*. For `logs:<workspaceId>#<kql>` those differ entirely, so the match
    # is made against the columns the KQL projects - never against the workspace
    # id, which is what previously refused every valid log objective.
    if ($null -ne $SteadyState) {
        $signal = [string]$SteadyState.signal
        $matched = @()
        $undecidable = @()
        foreach ($source in @($AvailableSources)) {
            $test = Test-ChaosSourceProducesSignal -Spec $source -SignalName $signal
            if ($test.matched -eq $true) { $matched += $source }
            elseif ($null -eq $test.matched) { $undecidable += $test.reason }
        }

        if ($matched.Count -eq 0 -and $undecidable.Count -gt 0) {
            # Unknown is not a refusal. The study may proceed, but it must say
            # that its own objective might never be evaluated.
            return New-ChaosReadinessGate -Id 'observability' -Title 'A signal can prove the fault landed' `
                -Status 'fail' -Severity 'advisory' `
                -Detail "The steady-state objective is about '$signal', but no configured source can be shown to produce it: $($undecidable -join ' ')" `
                -Remediation "Give the query's output column an explicit alias matching the objective, for example ``| summarize $signal = ...``." `
                -LimitationCode 'L2'
        }

        if ($matched.Count -eq 0) {
            return New-ChaosReadinessGate -Id 'observability' -Title 'A signal can prove the fault landed' `
                -Status 'fail' -Severity 'blocking' `
                -Detail "The steady-state objective is about '$signal', but no configured signal source produces it (configured: $($AvailableSources -join ', ')). The study would run to completion and never evaluate its own objective." `
                -Remediation "Name the source after the signal the objective uses, for example -SignalSource 'metrics:$signal', or project that column from the log query (``| summarize $signal = ...``)." `
                -LimitationCode 'L2'
        }
    }

    return New-ChaosReadinessGate -Id 'observability' -Title 'A signal can prove the fault landed' `
        -Status 'pass' -Severity 'advisory' `
        -Detail "Signal sources: $($AvailableSources -join ', ')."
}

function Test-ChaosActionReversibility {
    <#
    .SYNOPSIS
        Advisory: can this action be stopped once it has started?

    .DESCRIPTION
        The service classifies actions as Cancelable, Continuous or Discrete.
        A discrete action completes on its own and cannot be called back, so
        the injection window is a description of what happened rather than a
        bound on it. That changes how much blast radius is acceptable, and the
        operator should be told before consenting, not after.
    #>
    param([Parameter(Mandatory)][object]$Action)

    $type = [string]$Action.actionType

    if ([string]::IsNullOrWhiteSpace($type)) {
        return New-ChaosReadinessGate -Id 'reversibility' -Title 'Injection can be stopped early' `
            -Status 'unknown' -Severity 'advisory' `
            -Detail "Chaos Studio did not report an action type for '$($Action.name)', so whether the fault can be cancelled mid-window is unknown." `
            -LimitationCode 'L10'
    }

    if ($type -ieq 'Discrete') {
        return New-ChaosReadinessGate -Id 'reversibility' -Title 'Injection can be stopped early' `
            -Status 'fail' -Severity 'advisory' `
            -Detail "Action '$($Action.name)' is Discrete: it runs to completion and cannot be cancelled once started. Cancelling the scenario run stops the next action, not this one, so the blast radius is set entirely by the parameters and the configured filters." `
            -Remediation 'Confirm the parameters bound the impact acceptably before consenting; there is no abort once injection begins.' `
            -LimitationCode 'L6'
    }

    return New-ChaosReadinessGate -Id 'reversibility' -Title 'Injection can be stopped early' `
        -Status 'pass' -Severity 'advisory' `
        -Detail "Action '$($Action.name)' is $type, so cancelling the scenario run stops the fault."
}

function Test-ChaosMechanismTraceable {
    <#
    .SYNOPSIS
        Blocking: is there a falsifiable, traceable mechanism behind this study?

    .DESCRIPTION
        A study that cannot say *how* the action would breach the steady state
        is a guess dressed as an experiment. Three inputs make the claim
        falsifiable and reviewable, and all three must be present and traceable
        before the plan is written:

          failureMechanism    the action's effect, the code or dependency
                              failure it provokes, and how that reaches the
                              predicate
          mechanismEvidence   a concrete reference (file, symbol, architecture)
                              that anchors the mechanism in the real system
          mechanismProbe      the exact signal that proves the mechanism landed,
                              the direction it should move, and the resource it
                              must resolve to

        Traceability is what this gate can check by script: the probe's signal
        must be one the study actually collects, and its resourceCorrelation
        must resolve to a resource in scope. Truthfulness - whether the stated
        mechanism is the real one - is the agent's and code review's
        responsibility, which is exactly why mechanismEvidence must cite
        something a reviewer can open.

        A gap here is blocking, not advisory: without a traceable mechanism the
        report's mechanismProven can only ever be an accident of correlation.
    #>
    param(
        [AllowNull()][AllowEmptyString()][string]$FailureMechanism,
        [AllowNull()][AllowEmptyString()][string]$MechanismEvidence,
        [AllowNull()][object]$MechanismProbe,
        [AllowEmptyCollection()][string[]]$AvailableSources = @(),
        [AllowNull()][AllowEmptyCollection()][string[]]$ScopedResourceIds = @()
    )

    $problems = @()

    if ([string]::IsNullOrWhiteSpace($FailureMechanism)) {
        $problems += 'no failureMechanism was stated, so the study cannot say how the action would breach the steady state'
    }
    if ([string]::IsNullOrWhiteSpace($MechanismEvidence)) {
        $problems += 'no mechanismEvidence was cited, so the mechanism is not anchored to anything a reviewer can open'
    }

    if ($null -eq $MechanismProbe) {
        $problems += 'no mechanismProbe was supplied, so nothing was named that would prove the mechanism reached the system'
    }
    else {
        $signal = if ($MechanismProbe.PSObject.Properties.Name -contains 'signal') { [string]$MechanismProbe.signal } else { '' }
        $query = if ($MechanismProbe.PSObject.Properties.Name -contains 'query') { [string]$MechanismProbe.query } else { '' }
        $direction = if ($MechanismProbe.PSObject.Properties.Name -contains 'expectedDirection') { [string]$MechanismProbe.expectedDirection } else { '' }
        $correlation = if ($MechanismProbe.PSObject.Properties.Name -contains 'resourceCorrelation') { [string]$MechanismProbe.resourceCorrelation } else { '' }

        if ([string]::IsNullOrWhiteSpace($signal) -and [string]::IsNullOrWhiteSpace($query)) {
            $problems += 'the mechanismProbe names neither a signal nor a query, so there is nothing to measure'
        }
        elseif (-not [string]::IsNullOrWhiteSpace($signal)) {
            # The probe's own signal has to be one the study actually collects,
            # otherwise the proof step would have no series to read.
            #
            # This uses the same canonical identity helper as the steady-state
            # objective. A source spec is not a signal name: for
            # `logs:<workspaceId>#<kql>` the signal is a column the query
            # projects, never the workspace id, so comparing the two directly
            # refused every valid log-backed probe.
            $matched = @()
            $undecidable = @()
            foreach ($source in @($AvailableSources)) {
                $test = Test-ChaosSourceProducesSignal -Spec $source -SignalName $signal
                if ($test.matched -eq $true) { $matched += $source }
                elseif ($null -eq $test.matched) { $undecidable += $test.reason }
            }

            if ($matched.Count -eq 0) {
                $sourceList = if (@($AvailableSources).Count -gt 0) { $AvailableSources -join ', ' } else { 'none' }
                if ($undecidable.Count -gt 0) {
                    $problems += "the mechanismProbe signal '$signal' cannot be shown to come from any configured source ($($undecidable -join ' ')); give the query's output column an explicit alias, for example ``| summarize $signal = ...``"
                }
                else {
                    $problems += "the mechanismProbe signal '$signal' is not among the configured signal sources ($sourceList), so it is untraceable"
                }
            }
        }
        elseif (-not [string]::IsNullOrWhiteSpace($query)) {
            # A query-based probe may name its workspace as
            # 'logs:<workspaceId>#<kql>'. When it does, a configured source for
            # THAT workspace must exist - a logs source for a different
            # workspace does not make this probe traceable. Without a workspace
            # prefix, any logs source is enough to run the query against.
            $probeWorkspaceId = $null
            if ($query -like 'logs:*') {
                $probeRest = $query.Substring('logs:'.Length)
                if ($probeRest.Contains('#')) {
                    $probeWsPart = $probeRest.Split('#', 2)[0]
                    if (-not [string]::IsNullOrWhiteSpace($probeWsPart)) { $probeWorkspaceId = $probeWsPart.Trim() }
                }
            }
            if (-not [string]::IsNullOrWhiteSpace($probeWorkspaceId)) {
                $matchedWs = @($AvailableSources | Where-Object {
                        $_ -eq "logs:$probeWorkspaceId" -or $_ -like "logs:$probeWorkspaceId#*"
                    })
                if ($matchedWs.Count -eq 0) {
                    $sourceList = if (@($AvailableSources).Count -gt 0) { $AvailableSources -join ', ' } else { 'none' }
                    $problems += "the mechanismProbe query targets workspace '$probeWorkspaceId' but no matching logs: signal source is configured ($sourceList), so it is untraceable"
                }
            }
            else {
                $hasLogSource = @($AvailableSources | Where-Object { $_ -like 'logs:*' }).Count -gt 0
                if (-not $hasLogSource) {
                    $problems += 'the mechanismProbe uses a query but no logs: signal source is configured for it to run against, so it is untraceable'
                }
            }
        }

        if ([string]::IsNullOrWhiteSpace($direction)) {
            $problems += 'the mechanismProbe has no expectedDirection, so its movement cannot be judged for or against the mechanism'
        }

        if ([string]::IsNullOrWhiteSpace($correlation)) {
            $problems += 'the mechanismProbe has no resourceCorrelation, so a movement could not be tied to the resource under study'
        }
        else {
            # When discovery ran, the correlated resource must be one in scope.
            # When it was skipped the scope is unknown, not empty, so presence is
            # all that can be checked - resolution is deferred rather than faked.
            $ids = @(@($ScopedResourceIds) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
            if ($ids.Count -gt 0) {
                $resolves = @($ids | Where-Object { $_ -eq $correlation -or $_ -like "*$correlation" -or $correlation -like "*$_" })
                if ($resolves.Count -eq 0) {
                    $problems += "the mechanismProbe resourceCorrelation '$correlation' does not resolve to any resource in scope, so it is untraceable"
                }
            }
        }
    }

    if ($problems.Count -gt 0) {
        return New-ChaosReadinessGate -Id 'mechanism-traceable' -Title 'The failure mechanism is stated and traceable' `
            -Status 'fail' -Severity 'blocking' `
            -Detail ('A falsifiable study needs a traceable mechanism, but ' + ($problems -join '; ') + '.') `
            -Remediation 'Re-run scoping with -FailureMechanism, -MechanismEvidence, and a -MechanismProbe whose signal is one of -SignalSource and whose resourceCorrelation is a resource in scope. Read the application code and runtime topology first; the evidence reference must cite something a reviewer can open.'
    }

    return New-ChaosReadinessGate -Id 'mechanism-traceable' -Title 'The failure mechanism is stated and traceable' `
        -Status 'pass' -Severity 'blocking' `
        -Detail "Mechanism stated and its probe ($(if ($MechanismProbe.signal) { $MechanismProbe.signal } else { 'query' }), expected to $($MechanismProbe.expectedDirection)) traces to a configured signal and a scoped resource. Truthfulness of the mechanism remains the agent's and reviewer's responsibility."
}

function Test-ChaosInjectionWindow {
    <#
    .SYNOPSIS
        Advisory: is the window long enough to observe anything?
    #>
    param([Parameter(Mandatory)][int]$InjectMinutes)

    if ($InjectMinutes -le 3) {
        return New-ChaosReadinessGate -Id 'injection-window' -Title 'Injection window is long enough to observe' `
            -Status 'fail' -Severity 'advisory' `
            -Detail "The injection window is $InjectMinutes minute(s). Metric ingestion and aggregation commonly lag by more than that, so a clean result may mean the window closed before the effect became visible." `
            -Remediation 'Re-run with -DurationMinutes 10 or longer.' `
            -LimitationCode 'L7'
    }

    return New-ChaosReadinessGate -Id 'injection-window' -Title 'Injection window is long enough to observe' `
        -Status 'pass' -Severity 'advisory' `
        -Detail "Injection window: $InjectMinutes minutes."
}

function Invoke-ChaosReadinessGates {
    <#
    .SYNOPSIS
        Run every gate and return the collected verdict.
    #>
    param(
        [Parameter(Mandatory)][object]$Action,
        [AllowNull()][object]$Scenario = $null,
        [AllowNull()][AllowEmptyCollection()][string[]]$ScopedResourceTypes,
        [AllowNull()][AllowEmptyCollection()][object[]]$ScopedResources,
        [AllowNull()][object]$Parameters,
        [AllowNull()][object]$ActionParameters = $null,
        [AllowNull()][object]$SteadyState,
        [Parameter(Mandatory)][int]$InjectMinutes,
        [AllowEmptyCollection()][string[]]$AvailableSources = @(),
        [AllowNull()][AllowEmptyString()][string]$FailureMechanism = $null,
        [AllowNull()][AllowEmptyString()][string]$MechanismEvidence = $null,
        [AllowNull()][object]$MechanismProbe = $null,
        [AllowNull()][object]$ExerciseModel = $null,
        [switch]$AcceptWeakExercise,
        [switch]$DiscoverySkipped,
        [AllowNull()][object]$DiscoveredCount = $null
    )

    $scopedResourceIds = @(@($ScopedResources) | Where-Object { $_ } | ForEach-Object {
            if ($_ -is [string]) { $_ }
            elseif ($_.PSObject.Properties.Name -contains 'resourceId') { [string]$_.resourceId }
            else { [string]$_ }
        } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })

    $gates = @(
        Test-ChaosSteadyStatePredicate -Predicate $SteadyState
        Test-ChaosScopePopulated -ScopedResources $ScopedResources -DiscoverySkipped:$DiscoverySkipped -DiscoveredCount $DiscoveredCount
        Test-ChaosActionScopeFit -Action $Action -ScopedResourceTypes $ScopedResourceTypes
        Test-ChaosActionParameterFit -Action $Action -ActionParameters $ActionParameters
        Test-ChaosScenarioParameterFit -Scenario $Scenario -Parameters $Parameters
        Test-ChaosMechanismTraceable -FailureMechanism $FailureMechanism -MechanismEvidence $MechanismEvidence `
            -MechanismProbe $MechanismProbe -AvailableSources $AvailableSources -ScopedResourceIds $scopedResourceIds
        Test-ChaosActionReversibility -Action $Action
        Test-ChaosInjectionWindow -InjectMinutes $InjectMinutes
        Test-ChaosObservabilityCoverage -AvailableSources $AvailableSources -SteadyState $SteadyState
        Test-ChaosExerciseSufficient -Model $ExerciseModel -Accepted:$AcceptWeakExercise
    )

    $blockingFailures = @($gates | Where-Object { $_.severity -eq 'blocking' -and $_.status -eq 'fail' })
    $limitations = @($gates | Where-Object { $_.status -ne 'pass' -and $_.limitationCode } | ForEach-Object { $_.limitationCode } | Select-Object -Unique)

    return [pscustomobject]@{
        gates            = $gates
        ready            = ($blockingFailures.Count -eq 0)
        blockingFailures = $blockingFailures
        limitationCodes  = $limitations
    }
}

function Assert-ChaosReadiness {
    <#
    .SYNOPSIS
        Fail loudly when a blocking gate failed.

    .DESCRIPTION
        Most blocking failures are readiness failures (exit 10). Insufficient
        exposure gets its own exit code (21) because it is a different kind of
        problem with a different fix: the study is well-formed, it simply would
        not exercise anything, and the caller needs to change load or window
        rather than change the plan.
    #>
    param([Parameter(Mandatory)][object]$Readiness)

    if ($Readiness.ready) { return }

    $lines = $Readiness.blockingFailures | ForEach-Object { "  - [$($_.id)] $($_.detail)" }
    $remediation = ($Readiness.blockingFailures | Where-Object { $_.remediation } | Select-Object -First 1).remediation

    $exposureOnly = (@($Readiness.blockingFailures | Where-Object { $_.id -ne 'exercise-sufficient' }).Count -eq 0)
    $exitName = if ($exposureOnly) { 'InsufficientExposure' } else { 'ReadinessFailed' }

    Write-ChaosStudyFailure -Title 'Study preconditions not met' `
        -Message ("This study would not produce an interpretable result:`n" + ($lines -join "`n") + "`n`nScoping stopped before writing a study plan.") `
        -Remediation $remediation

    exit (Get-ChaosStudyExitCode -Name $exitName)
}

# -- Effective legs (declared vs effective, Req C) -------------------------
#
# A scenario declares what it would do; a validated configuration's execution
# plan is what the platform will actually run. Those two can diverge - a filter
# excludes a resource, an action does not apply to a target, a permission is
# missing - and when they do, the scenario's name and the study's conclusion
# can both overstate what was exercised. These helpers turn the execution plan
# into a declared-vs-effective leg model that later gates and the plan freeze
# can reason about, never inventing a leg the platform did not report.

# The execution-plan readers used to live here, and the run side kept its own
# near-copy. They drifted. Both now use the one model in
# chaos-study/scripts/lib/ExecutionPlan.ps1; these two names are kept because
# they are the vocabulary the readiness gates and the scope script already
# speak.

function Resolve-ChaosEffectiveLegs {
    <#
    .SYNOPSIS
        Turn a preflight execution plan into the declared-vs-effective leg model
        shared with the run side.
    #>
    param([AllowNull()][object]$ExecutionPlan)
    return Resolve-ChaosEffectiveLeg -ExecutionPlan $ExecutionPlan
}

function Get-ChaosExecutionPlanLegs {
    <#
    .SYNOPSIS
        The flat leg list for an execution plan. Errors encountered while
        reading it are reported by Resolve-ChaosEffectiveLegs, not hidden here.
    #>
    param([AllowNull()][object]$ExecutionPlan)
    return @((Get-ChaosExecutionPlanLeg -ExecutionPlan $ExecutionPlan).legs)
}

function Get-ChaosPartialScenarioPhrase {
    <#
    .SYNOPSIS
        The exact phrase an operator must type to accept a partial scenario.

    .DESCRIPTION
        The phrase carries the executable-of-total count and a short binding
        hash over the plan identity and effective legs, so it cannot be typed
        without reading the divergence, and cannot be reused for a different
        plan or a different set of skipped legs.
    #>
    param(
        [Parameter(Mandatory)][object]$EffectiveLegs,
        [Parameter(Mandatory)][string]$BindingHash
    )
    $short = if ($BindingHash.Length -ge 8) { $BindingHash.Substring(0, 8) } else { $BindingHash }
    return "accept partial scenario $($EffectiveLegs.executable) of $($EffectiveLegs.total) $short"
}

function Get-ChaosEffectiveLegsBindingHash {
    <#
    .SYNOPSIS
        A deterministic hash binding an acceptance phrase to the scope, scenario
        and exact effective legs it was shown for.
    #>
    param(
        [Parameter(Mandatory)][string]$ScopeHash,
        [Parameter(Mandatory)][string]$ScenarioName,
        [Parameter(Mandatory)][object]$EffectiveLegs
    )
    $binding = [ordered]@{
        scopeHash  = $ScopeHash
        scenario   = $ScenarioName
        total      = $EffectiveLegs.total
        executable = $EffectiveLegs.executable
        skipped    = @(@($EffectiveLegs.skipped) | ForEach-Object { [string]$_.legSelector } | Sort-Object)
    }
    return Get-ChaosDigest -InputObject $binding
}

function Get-ChaosEffectiveLegsDecision {
    <#
    .SYNOPSIS
        Classify effective legs as all-executable, partial, or none, without any
        side effects, so the decision is testable in isolation.

    .DESCRIPTION
        Returns { kind = 'all'|'partial'|'none'; accepted; expectedPhrase;
        limitationCodes[] }. `none` (nothing executable) is unverifiable;
        `partial` is only accepted when the supplied phrase matches exactly
        (case-sensitive), and always carries L11.
    #>
    param(
        [Parameter(Mandatory)][object]$EffectiveLegs,
        [Parameter(Mandatory)][string]$BindingHash,
        [AllowNull()][AllowEmptyString()][string]$AcceptPartialScenario = $null
    )

    if ($EffectiveLegs.total -le 0 -or $EffectiveLegs.executable -le 0) {
        return [pscustomobject]@{ kind = 'none'; accepted = $false; expectedPhrase = $null; limitationCodes = @() }
    }

    if ($EffectiveLegs.executable -lt $EffectiveLegs.total) {
        $expected = Get-ChaosPartialScenarioPhrase -EffectiveLegs $EffectiveLegs -BindingHash $BindingHash
        $accepted = ($AcceptPartialScenario -and $AcceptPartialScenario.Trim() -ceq $expected)
        return [pscustomobject]@{
            kind            = 'partial'
            accepted        = [bool]$accepted
            expectedPhrase  = $expected
            limitationCodes = @('L11')
        }
    }

    return [pscustomobject]@{ kind = 'all'; accepted = $true; expectedPhrase = $null; limitationCodes = @() }
}

function Get-ChaosPartialAttribution {
    <#
    .SYNOPSIS
        Explain WHY the scenario is partial: the operator's own exclusions, or
        something the platform decided on its own.

    .DESCRIPTION
        Defect #11. "1 of 2 legs will run" reads like a malfunction when in fact
        the operator asked for exactly that by excluding a resource. Conversely,
        a leg the platform dropped for its own reasons is a genuine surprise and
        must not be laundered into "you asked for this". So each skipped leg is
        attributed to a declared exclusion when its selector or reason names one,
        and left as unattributed otherwise. Attribution is evidence, not excuse:
        the acceptance phrase is still required either way.
    #>
    param(
        [AllowNull()][AllowEmptyCollection()][object[]]$Skipped,
        [AllowNull()][AllowEmptyCollection()][string[]]$DeclaredExclusions
    )

    $declared = @(@($DeclaredExclusions) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    $requested = @()
    $other = @()

    foreach ($leg in @($Skipped)) {
        $sel = [string]$leg.legSelector
        $reason = [string]$leg.reason
        $matched = $false
        foreach ($ex in $declared) {
            # Either side may be the qualified form, so compare both ways.
            if ((-not [string]::IsNullOrWhiteSpace($sel)) -and
                ($sel.IndexOf($ex, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 -or
                 $ex.IndexOf($sel, [System.StringComparison]::OrdinalIgnoreCase) -ge 0)) { $matched = $true; break }
            if ((-not [string]::IsNullOrWhiteSpace($reason)) -and
                $reason.IndexOf($ex, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) { $matched = $true; break }
        }
        # The platform's own word for it. Only trusted when the operator
        # actually declared exclusions, so a service-side "excluded" for an
        # unrelated reason is never credited to the operator.
        if ((-not $matched) -and $declared.Count -gt 0 -and (-not [string]::IsNullOrWhiteSpace($reason)) -and
            $reason -match '(?i)exclud') { $matched = $true }

        if ($matched) { $requested += $leg } else { $other += $leg }
    }

    return [pscustomobject]@{
        requested   = @($requested)
        other       = @($other)
        allRequested = (@($other).Count -eq 0 -and @($requested).Count -gt 0)
    }
}

function Assert-ChaosEffectiveLegs {
    <#
    .SYNOPSIS
        Enforce the effective-legs decision: all-skipped stops with exit 14, a
        partial scenario is fail-closed unless the bound acceptance phrase is
        supplied. Returns the decision (with L11) when the study may proceed.

    .DESCRIPTION
        An unexecutable scope is unverifiable, so all-skipped reuses
        ScopeUnverified (14). A partial scenario would run fewer legs than its
        name implies, so it is refused (PartialScenarioUnaccepted, 20) until the
        operator types the phrase that names N-of-M and pins these exact legs.
    #>
    param(
        [Parameter(Mandatory)][object]$EffectiveLegs,
        [Parameter(Mandatory)][string]$ScopeHash,
        [Parameter(Mandatory)][string]$ScenarioName,
        [AllowNull()][AllowEmptyString()][string]$AcceptPartialScenario = $null,
        [AllowNull()][AllowEmptyCollection()][string[]]$DeclaredExclusions = @()
    )

    $binding = Get-ChaosEffectiveLegsBindingHash -ScopeHash $ScopeHash -ScenarioName $ScenarioName -EffectiveLegs $EffectiveLegs
    $decision = Get-ChaosEffectiveLegsDecision -EffectiveLegs $EffectiveLegs -BindingHash $binding -AcceptPartialScenario $AcceptPartialScenario

    if ($decision.kind -eq 'none') {
        Write-ChaosStudyFailure -Title 'Every leg of this scenario is skipped' -Message @"
The preflight configuration validated, but its execution plan runs 0 of
$($EffectiveLegs.total) leg(s). A scenario that executes nothing succeeds without
touching anything, which would read as resilience that was never tested.

$(Format-ChaosSkippedLegs -Skipped $EffectiveLegs.skipped)
$(Format-ChaosPlanReadability -EffectiveLegs $EffectiveLegs)
"@ -Remediation 'Re-run chaos-study-scope with a wider scope, fewer exclusions, or an action that applies to the resources in scope.'
        exit (Get-ChaosStudyExitCode -Name 'ScopeUnverified')
    }

    if ($decision.kind -eq 'partial' -and -not $decision.accepted) {
        $reason = if ([string]::IsNullOrWhiteSpace($AcceptPartialScenario)) {
            'No -AcceptPartialScenario phrase was supplied.'
        } else {
            'The -AcceptPartialScenario phrase did not match these exact legs (comparison is case-sensitive).'
        }
        $attr = Get-ChaosPartialAttribution -Skipped $EffectiveLegs.skipped -DeclaredExclusions $DeclaredExclusions
        $why = if ($attr.allRequested) {
            "This is partial because YOU excluded $(@($attr.requested).Count) leg(s) - it is not a platform`nmalfunction. Confirming below records that the scenario ran reduced ON PURPOSE."
        } elseif (@($attr.requested).Count -gt 0) {
            "$(@($attr.requested).Count) leg(s) were dropped by your own exclusions; $(@($attr.other).Count) were skipped for`nreasons the platform decided. Read the second group carefully before accepting."
        } else {
            "None of these were dropped by your exclusions - the platform skipped them on its`nown. Confirm you understand why before accepting a reduced scenario."
        }
        Write-ChaosStudyFailure -Title "Partial scenario - $($EffectiveLegs.executable) of $($EffectiveLegs.total) legs will run" -Message @"
$reason

$why

Legs that WILL run: $($EffectiveLegs.executable) of $($EffectiveLegs.total).

Legs that will NOT run:
$(Format-ChaosSkippedLegs -Skipped $EffectiveLegs.skipped)
$(Format-ChaosPlanReadability -EffectiveLegs $EffectiveLegs)

To proceed with the partial scenario anyway (this is recorded as limitation L11),
pass this phrase exactly:

  $($decision.expectedPhrase)
"@ -Remediation "-AcceptPartialScenario '$($decision.expectedPhrase)'"
        exit (Get-ChaosStudyExitCode -Name 'PartialScenarioUnaccepted')
    }

    return $decision
}

function Format-ChaosPlanReadability {
    <#
    .SYNOPSIS
        Surface plan-read errors and undetermined legs so an UNREADABLE plan is
        never mistaken for an EMPTY one.

    .DESCRIPTION
        "0 legs" and "0 legs we could read" look identical to an operator but
        mean opposite things: one is a scope that safely excluded everything,
        the other is a plan the suite failed to parse. Whenever the reader
        recorded an error, or left a leg undetermined, say so here.
    #>
    param([Parameter(Mandatory)][object]$EffectiveLegs)

    $lines = @()
    $undet = @()
    if ($EffectiveLegs.PSObject.Properties.Name -contains 'undetermined') { $undet = @($EffectiveLegs.undetermined) }
    if ($undet.Count -gt 0) {
        $lines += ''
        $lines += "$($undet.Count) leg(s) carried NO readable run/skip flag and are counted as neither. They"
        $lines += 'are excluded from the executable count because assuming either way would'
        $lines += 'misstate the blast radius:'
        $lines += (Format-ChaosSkippedLegs -Skipped $undet)
    }
    $errs = @()
    if ($EffectiveLegs.PSObject.Properties.Name -contains 'errors') { $errs = @($EffectiveLegs.errors) }
    if ($errs.Count -gt 0) {
        $lines += ''
        $lines += 'The execution plan could not be fully read. This is NOT the same as an empty'
        $lines += 'plan - treat the leg counts above as incomplete:'
        $lines += (@($errs) | ForEach-Object { "  - $_" })
    }
    if ($lines.Count -eq 0) { return '' }
    return ($lines -join "`n")
}

function Format-ChaosSkippedLegs {
    <#
    .SYNOPSIS
        Render skipped legs as operator-facing lines.
    #>
    param([AllowNull()][AllowEmptyCollection()][object[]]$Skipped)

    if ($null -eq $Skipped -or @($Skipped).Count -eq 0) { return '  (the platform named no skipped legs)' }
    return (@($Skipped) | ForEach-Object {
            $sel = if ([string]::IsNullOrWhiteSpace([string]$_.legSelector)) { '(unnamed leg)' } else { [string]$_.legSelector }
            $act = if ([string]::IsNullOrWhiteSpace([string]$_.action)) { '' } else { " [$($_.action)]" }
            "  - $sel$act`: $($_.reason)"
        }) -join "`n"
}

function Assert-ChaosScenarioNameHonest {
    <#
    .SYNOPSIS
        Block a scenario name that implies legs which will not run.

    .DESCRIPTION
        A name like "zone-1-down" claims a specific zone. If the executable legs
        contain no leg for that zone, the name overstates what the study
        exercises, so the resulting report would mislead. This guard checks the
        concrete, machine-readable claim - zone numbers named in the scenario or
        its display name - against the zones present in the executable legs, and
        stops (ScopeUnverified, 14) when a claimed zone is absent. Generic names
        with no zone number are left alone; truthfulness of the wider claim
        remains the agent's and reviewer's responsibility.
    #>
    param(
        [Parameter(Mandatory)][string]$ScenarioName,
        [AllowNull()][AllowEmptyString()][string]$DisplayName = $null,
        [Parameter(Mandatory)][object]$EffectiveLegs
    )

    $nameText = @($ScenarioName, $DisplayName) -join ' '
    $claimedZones = @([regex]::Matches($nameText, '(?i)zone[\s_-]?([0-9]+)') | ForEach-Object { $_.Groups[1].Value })
    $claimedZones += @([regex]::Matches($nameText, '(?i)\baz([0-9]+)\b') | ForEach-Object { $_.Groups[1].Value })
    $claimedZones = @($claimedZones | Where-Object { $_ } | Select-Object -Unique)
    if ($claimedZones.Count -eq 0) { return $true }

    $executableText = (@($EffectiveLegs.executableSelectors) -join ' ')
    $runnableZones = @([regex]::Matches($executableText, '(?i)zone[\s_-]?([0-9]+)') | ForEach-Object { $_.Groups[1].Value })
    $runnableZones += @([regex]::Matches($executableText, '(?i)\baz([0-9]+)\b') | ForEach-Object { $_.Groups[1].Value })
    $runnableZones = @($runnableZones | Where-Object { $_ } | Select-Object -Unique)

    $missing = @($claimedZones | Where-Object { $runnableZones -notcontains $_ })
    if ($missing.Count -eq 0) { return $true }

    Write-ChaosStudyFailure -Title 'Scenario name claims a zone that will not run' -Message @"
The scenario name '$ScenarioName' names zone(s) $($missing -join ', '), but the
preflight execution plan has no executable leg for $(if ($missing.Count -gt 1) { 'those zones' } else { 'that zone' }).
Running it would produce a report whose title overstates what was exercised, so
scoping stops here.

Executable legs cover zone(s): $(if ($runnableZones.Count -gt 0) { $runnableZones -join ', ' } else { '(none identifiable)' }).
"@ -Remediation 'Choose a scenario whose name matches the zones actually in scope, or widen the scope so the named zone has an executable leg.'
    exit (Get-ChaosStudyExitCode -Name 'ScopeUnverified')
}
