# Exercise arithmetic (Req E).
#
# A chaos study only proves something if the fault had work to fail. Injecting
# a fault for ten minutes into a path that receives one request an hour proves
# nothing, yet the run completes cleanly and the report is tempted to read that
# silence as resilience. It is not resilience; it is an unexercised system.
#
# This module turns that intuition into arithmetic the plan can freeze and a
# reviewer can check. It is deliberately small and deliberately honest: every
# input the operator does not supply stays null and propagates as null, because
# assuming a rate we were never told is how a study invents its own evidence.
#
# The model is a Poisson exposure calculation:
#
#   lambda  events per second reaching the vulnerable path
#   t       seconds the path is actually vulnerable
#   lambda*t          expected number of vulnerable events
#   1 - exp(-lambda*t) probability of at least one vulnerable event
#
# Poisson is the right default because chaos faults are injected without regard
# to the arrival process: events arrive independently and the fault window is
# fixed, which is exactly the Poisson setting. Where that assumption is wrong -
# a batch job that fires once on a schedule, a synthetic prober on a fixed
# interval - the assumptions list says so and the number is presented as an
# estimate rather than a measurement.

Set-StrictMode -Version Latest

$ChaosExerciseModelVersion = 'exercise-model.v1'

# Below this many expected vulnerable events a study cannot distinguish
# "nothing broke" from "nothing was tried". It is a low bar on purpose: at 1.0
# expected events the probability of at least one is only 63%, so anything
# under it is a coin toss dressed as a result.
$ChaosWeakExerciseThreshold = 1.0

function ConvertTo-ChaosExerciseNumber {
    <#
    .SYNOPSIS
        Read one numeric exercise input, keeping "not supplied" distinct from zero.

    .DESCRIPTION
        Zero and null mean very different things here. A declared event rate of
        zero is a statement - "nothing reaches this path" - and should block the
        study. A null rate is an admission that nobody measured it, and should
        surface as unknown. Coercing one into the other would let a study either
        invent exposure it never had or block on an input it was never given.

        Negative values are rejected rather than clamped: a negative rate or a
        negative window is a mistake in the caller, and silently reading it as
        zero would hide that mistake inside the arithmetic.
    #>
    param(
        [AllowNull()][object]$Value,
        [Parameter(Mandatory)][string]$Name
    )

    if ($null -eq $Value) { return $null }
    if ($Value -is [string] -and [string]::IsNullOrWhiteSpace($Value)) { return $null }

    $parsed = 0.0
    if (-not [double]::TryParse([string]$Value, [ref]$parsed)) {
        throw "The exercise input '$Name' must be a number; received '$Value'."
    }
    if ([double]::IsNaN($parsed) -or [double]::IsInfinity($parsed)) {
        throw "The exercise input '$Name' must be a finite number; received '$Value'."
    }
    if ($parsed -lt 0) {
        throw "The exercise input '$Name' cannot be negative; received '$Value'."
    }

    return $parsed
}

function New-ChaosExerciseModel {
    <#
    .SYNOPSIS
        Compute the exposure the study is about to buy, or say honestly that it
        cannot be computed.

    .DESCRIPTION
        Three inputs decide whether a study exercises anything:

          eventRatePerSecond      how often work reaches the vulnerable path
          vulnerableWindowSeconds how long that path is actually vulnerable -
                                  the action's active window, not the study's
                                  observation budget
          eligibleFraction        the share of that work the blast radius can
                                  actually reach (0..1)

        From those:

          lambda        = eventRatePerSecond * eligibleFraction
          expectedEvents = lambda * vulnerableWindowSeconds
          probAtLeastOne = 1 - exp(-expectedEvents)

        If any required input is missing the result is null - not zero, not a
        guess. `known` says which case the caller is in, so a report can write
        "exposure unknown" instead of quietly printing 0.00 and letting a reader
        conclude the path was never hit.

        The assumptions are returned alongside the numbers and frozen with them,
        because an exposure figure without its assumptions is unfalsifiable: a
        reviewer who cannot see that we assumed independent arrivals cannot tell
        us we were wrong.
    #>
    [CmdletBinding()]
    param(
        [AllowNull()][object]$EventRatePerSecond = $null,
        [AllowNull()][object]$VulnerableWindowSeconds = $null,
        [AllowNull()][object]$EligibleFraction = $null,
        [AllowNull()][AllowEmptyCollection()][string[]]$Assumption = @(),
        [double]$Threshold = $ChaosWeakExerciseThreshold
    )

    $rate = ConvertTo-ChaosExerciseNumber -Value $EventRatePerSecond -Name 'eventRatePerSecond'
    $window = ConvertTo-ChaosExerciseNumber -Value $VulnerableWindowSeconds -Name 'vulnerableWindowSeconds'
    $fraction = ConvertTo-ChaosExerciseNumber -Value $EligibleFraction -Name 'eligibleFraction'

    if ($null -ne $fraction -and $fraction -gt 1) {
        throw "The exercise input 'eligibleFraction' is a share between 0 and 1; received '$EligibleFraction'."
    }

    $assumptions = @(@($Assumption) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | ForEach-Object { $_.Trim() })

    $expected = $null
    $probability = $null
    $lambda = $null
    $missing = @()

    if ($null -eq $rate) { $missing += 'eventRatePerSecond' }
    if ($null -eq $window) { $missing += 'vulnerableWindowSeconds' }

    if ($missing.Count -eq 0) {
        # An unstated eligible fraction means the whole rate is eligible. That is
        # the optimistic reading, and it is the safe one here: it can only make
        # the computed exposure larger, so it can never let a weak study pass the
        # gate by understating what it missed.
        $effectiveFraction = if ($null -eq $fraction) { 1.0 } else { $fraction }
        if ($null -eq $fraction) {
            $assumptions += 'eligibleFraction was not supplied; the whole event rate is assumed eligible, which overstates rather than understates exposure.'
        }

        $lambda = $rate * $effectiveFraction
        $expected = $lambda * $window
        $probability = 1.0 - [math]::Exp(-1.0 * $expected)
        $assumptions += 'Events are assumed to arrive independently of the fault window (Poisson); a scheduled or batched arrival process invalidates this estimate.'
    }

    $known = ($null -ne $expected)

    return [pscustomobject]@{
        modelVersion   = $ChaosExerciseModelVersion
        inputs         = [ordered]@{
            eventRatePerSecond      = $rate
            vulnerableWindowSeconds = $window
            eligibleFraction        = $fraction
        }
        lambdaPerSecond = $lambda
        expectedEvents = $expected
        probAtLeastOne = $probability
        known          = $known
        missingInputs  = @($missing)
        threshold      = $Threshold
        weak           = ($known -and $expected -lt $Threshold)
        # Rounded to whole events, not to two places: expecting 0.006 events is
        # expecting no events, and reporting it as "0.01" would dress a
        # non-exercise up as a small one.
        roundsToZero   = ($known -and ([math]::Round($expected, [System.MidpointRounding]::AwayFromZero) -eq 0))
        assumptions    = @($assumptions)
    }
}

function Format-ChaosExerciseModel {
    <#
    .SYNOPSIS
        One line a human can read before consenting.
    #>
    param([Parameter(Mandatory)][object]$Model)

    if (-not $Model.known) {
        $missing = if (@($Model.missingInputs).Count -gt 0) { @($Model.missingInputs) -join ', ' } else { 'unknown inputs' }
        return "Exposure unknown - no exercise arithmetic was possible ($missing not supplied)."
    }

    $expected = [math]::Round([double]$Model.expectedEvents, 2)
    $probability = [math]::Round(100.0 * [double]$Model.probAtLeastOne, 1)
    return "Expected vulnerable events: $expected (P(at least one) = $probability%)."
}

function Test-ChaosExerciseSufficient {
    <#
    .SYNOPSIS
        Blocking readiness gate: will this study exercise anything?

    .DESCRIPTION
        Three outcomes, and the difference between them matters more than the
        numbers:

          unknown  the arithmetic could not be done. Advisory, with limitation
                   L12: we cannot claim the study was well exercised, but we
                   also cannot claim it was not, and blocking on an input the
                   operator may genuinely not have would push people to invent
                   one.
          weak     the arithmetic says the fault will probably meet no work.
                   Blocking, because a clean result here is meaningless and
                   would be read as resilience.
          adequate proceed.

        Weak exercise can be accepted explicitly. That acceptance is a
        deliberate act - the operator is saying "I know this proves little and
        I want to run it anyway", typically to rehearse the mechanics - and it
        is recorded on the plan so the report can say the same thing rather than
        presenting a hollow run as a passed test.
    #>
    param(
        [AllowNull()][object]$Model,
        [switch]$Accepted
    )

    if ($null -eq $Model) {
        $Model = New-ChaosExerciseModel
    }

    if (-not $Model.known) {
        return New-ChaosReadinessGate -Id 'exercise-sufficient' -Title 'The fault will meet enough work to prove something' `
            -Status 'fail' -Severity 'advisory' `
            -Detail ((Format-ChaosExerciseModel -Model $Model) + ' Without an event rate and a vulnerable window the study cannot tell "nothing broke" from "nothing was tried".') `
            -Remediation 'Supply -EventRatePerSecond and -VulnerableWindowSeconds (and -EligibleFraction where the blast radius covers only part of the traffic) so the exposure can be computed.' `
            -LimitationCode 'L12'
    }

    if ($Model.weak) {
        $detail = (Format-ChaosExerciseModel -Model $Model) +
        " That is below the threshold of $($Model.threshold) expected event(s), so a clean result would say nothing about resilience."

        if ($Accepted) {
            return New-ChaosReadinessGate -Id 'exercise-sufficient' -Title 'The fault will meet enough work to prove something' `
                -Status 'fail' -Severity 'advisory' `
                -Detail ($detail + ' Weak exercise was explicitly accepted, so the study will run and the report will record that its result is not evidence of resilience.') `
                -Remediation 'Raise the event rate, widen the eligible fraction, or lengthen the vulnerable window before drawing any conclusion from this run.' `
                -LimitationCode 'L12'
        }

        return New-ChaosReadinessGate -Id 'exercise-sufficient' -Title 'The fault will meet enough work to prove something' `
            -Status 'fail' -Severity 'blocking' `
            -Detail $detail `
            -Remediation 'Increase load on the vulnerable path, widen the blast radius, or lengthen the action window. To run anyway and record the result as not-exercised, pass -AcceptWeakExercise.' `
            -LimitationCode 'L12'
    }

    return New-ChaosReadinessGate -Id 'exercise-sufficient' -Title 'The fault will meet enough work to prove something' `
        -Status 'pass' -Severity 'blocking' `
        -Detail (Format-ChaosExerciseModel -Model $Model)
}

function Get-ChaosExerciseEvidence {
    <#
    .SYNOPSIS
        Compare the exposure the plan predicted with the work actually observed.

    .DESCRIPTION
        The plan's arithmetic is a forecast. After the run there may be a real
        measurement - a request count, an invocation count - over the actual
        action window. Where there is, it is the better evidence and it decides
        whether the path was exercised. Where there is not, the forecast stands
        in, clearly labelled as a forecast.

        `exercised` is deliberately tri-valued. $true means work demonstrably
        met the fault; $false means it demonstrably did not; $null means we do
        not know. Only the middle case justifies the "Not exercised" verdict,
        and only a real observation or a computed near-zero exposure can produce
        it - an absent measurement never does.
    #>
    [CmdletBinding()]
    param(
        [AllowNull()][object]$Model = $null,
        [AllowNull()][object]$ObservedEvents = $null,
        [AllowNull()][AllowEmptyString()][string]$ObservationSource = $null
    )

    $observed = ConvertTo-ChaosExerciseNumber -Value $ObservedEvents -Name 'observedEvents'

    $exercised = $null
    $basis = 'unknown'
    $detail = 'Neither a measured event count nor a computable exposure estimate was available, so whether the fault met any work is unknown.'

    if ($null -ne $observed) {
        $basis = 'observed'
        $exercised = ($observed -gt 0)
        $source = if ([string]::IsNullOrWhiteSpace($ObservationSource)) { 'the collected signals' } else { $ObservationSource }
        $detail = if ($exercised) {
            "$observed event(s) reached the vulnerable path during the action window, measured from $source."
        }
        else {
            "No events reached the vulnerable path during the action window, measured from $source. Nothing was tried, so nothing was proven."
        }
    }
    elseif ($null -ne $Model -and $Model.known) {
        $basis = 'estimated'
        # An estimate can only justify a negative finding, never a positive one.
        # Predicting three events does not mean three arrived; predicting
        # effectively none does mean the study cannot claim it exercised
        # anything.
        if ($Model.roundsToZero) {
            $exercised = $false
            $detail = (Format-ChaosExerciseModel -Model $Model) + ' No measurement was available, and the predicted exposure rounds to zero, so the path is treated as not exercised.'
        }
        else {
            $detail = (Format-ChaosExerciseModel -Model $Model) + ' No measurement of actual events was available, so this remains a forecast rather than evidence.'
        }
    }

    return [pscustomobject]@{
        exercised      = $exercised
        basis          = $basis
        observedEvents = $observed
        source         = if ([string]::IsNullOrWhiteSpace($ObservationSource)) { $null } else { $ObservationSource }
        expectedEvents = if ($null -ne $Model -and $Model.known) { $Model.expectedEvents } else { $null }
        detail         = $detail
    }
}
