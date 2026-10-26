Set-StrictMode -Version Latest

# Abort criteria: the customer's stop rule, carried from the design interview
# through the frozen plan to runtime enforcement.
#
# The one rule this file exists to enforce: a stop rule that cannot be evaluated
# is not a stop rule. A sentence like "stop if the store front starts erroring"
# is a real human intent and is preserved verbatim as provenance, but it is
# never parsed into a threshold - inventing `errorRate > 0.05` from that prose
# would put a number in front of a live fault that nobody signed off on. The
# suite refuses to arm instead, and asks the customer for the measurable form.
#
# Signal identity is resolved in exactly one place for the whole suite, so this
# file borrows the matcher rather than re-deriving which column is which.
# Common is loaded explicitly - this library is dot-sourced from three different
# entry points and must not depend on which of them happened to load it first.
. (Join-Path $PSScriptRoot 'Common.ps1')
. (Join-Path $PSScriptRoot 'SignalIdentity.ps1')

function ConvertFrom-ChaosProbeCondition {
    <#
    .SYNOPSIS
        Parse a condition string into something evaluable.

    .DESCRIPTION
        The condition is the falsifiable half of a probe or an abort criterion:
        `>= 80`, `cpu >= 80`, `< 10 ms`. Without it, "the number moved" is all
        that can be said - and a CPU that drifted 1.59 to 2.06 under ordinary
        load moved, which is exactly how a study once declared a fault landed
        when the agent had failed to install. So the operator and the threshold
        are parsed here, and anything that cannot be parsed is reported as
        unparseable rather than being quietly reduced to a direction check.

        This is the canonical definition for the whole suite. It lives in the
        shared library because both the report's mechanism probe and the run's
        abort monitor evaluate against it, and two copies would drift.

    .OUTPUTS
        { raw; operator; threshold; unit; parsed; reason }
        parsed:$false always carries a reason the operator can act on.
    #>
    param([AllowNull()][AllowEmptyString()][string]$Condition)

    if ([string]::IsNullOrWhiteSpace($Condition)) {
        return [pscustomobject]@{
            raw = $Condition; operator = $null; threshold = $null; unit = $null
            parsed = $false
            reason = 'the probe carries no condition, so there is no threshold the mechanism can be held to'
        }
    }

    $raw = $Condition.Trim()
    # `<signal> <op> <number> [unit]` or just `<op> <number> [unit]`.
    $match = [regex]::Match($raw, '(>=|<=|==|!=|=>|=<|>|<)\s*(-?[0-9]+(?:\.[0-9]+)?)\s*([A-Za-z%/]*)')
    if (-not $match.Success) {
        return [pscustomobject]@{
            raw = $raw; operator = $null; threshold = $null; unit = $null
            parsed = $false
            reason = "no comparison operator and numeric threshold could be read from '$raw'"
        }
    }

    $operator = switch ($match.Groups[1].Value) {
        '=>' { '>=' }
        '=<' { '<=' }
        default { $match.Groups[1].Value }
    }
    $threshold = 0.0
    if (-not [double]::TryParse($match.Groups[2].Value, [ref]$threshold)) {
        return [pscustomobject]@{
            raw = $raw; operator = $operator; threshold = $null; unit = $null
            parsed = $false
            reason = "the threshold in '$raw' is not a number"
        }
    }

    $unit = $match.Groups[3].Value
    return [pscustomobject]@{
        raw       = $raw
        operator  = $operator
        threshold = $threshold
        unit      = if ([string]::IsNullOrWhiteSpace($unit)) { $null } else { $unit }
        parsed    = $true
        reason    = $null
    }
}

function Test-ChaosProbeCondition {
    <#
    .SYNOPSIS
        Does one measured value satisfy a parsed condition?

    .OUTPUTS
        $true, $false, or $null when the condition or the value is unusable.
        Unusable is never a pass.
    #>
    param(
        [Parameter(Mandatory)][AllowNull()][object]$Condition,
        [AllowNull()][object]$Value
    )
    if ($null -eq $Condition -or -not $Condition.parsed) { return $null }
    if ($null -eq $Value) { return $null }
    $actual = 0.0
    if (-not [double]::TryParse([string]$Value, [ref]$actual)) { return $null }
    $threshold = [double]$Condition.threshold
    switch ([string]$Condition.operator) {
        '>=' { return $actual -ge $threshold }
        '>'  { return $actual -gt $threshold }
        '<=' { return $actual -le $threshold }
        '<'  { return $actual -lt $threshold }
        '==' { return $actual -eq $threshold }
        '!=' { return $actual -ne $threshold }
        default { return $null }
    }
}

function ConvertFrom-ChaosAbortCriteria {
    <#
    .SYNOPSIS
        Normalise a raw abort criterion into the structured record the plan
        freezes and the run evaluates.

    .DESCRIPTION
        Mirrors ConvertFrom-ChaosMechanismProbe: a $null input produces $null
        output so the caller's gate can report it missing rather than this
        throwing mid-normalisation.

        Free text is deliberately NOT parsed. A string input is kept whole as
        the customer's statement and marked evaluable:$false with a reason. The
        alternative - regexing a number out of an English sentence - is how a
        threshold nobody agreed to ends up gating a live fault.

    .OUTPUTS
        $null, or
        { stated; statement; source; signal; query; aggregate; conditionText;
          condition; resourceCorrelation; evaluable; reason }

        `evaluable` is the only field the arming gate reads. `statement` and
        `source` survive regardless, because the human intent is worth keeping
        even when it cannot be machine-checked.
    #>
    param([AllowNull()][object]$Raw)

    if ($null -eq $Raw) { return $null }

    $prose = $null
    if ($Raw -is [string]) { $prose = [string]$Raw }

    if ($null -ne $prose) {
        $trimmed = $prose.Trim()
        if ([string]::IsNullOrWhiteSpace($trimmed)) { return $null }
        return [ordered]@{
            stated              = $true
            statement           = $trimmed
            source              = 'customer'
            signal              = $null
            query               = $null
            aggregate           = $null
            conditionText       = $null
            condition           = $null
            resourceCorrelation = $null
            evaluable           = $false
            reason              = "the abort criterion is prose - '$trimmed' - and prose cannot be evaluated against a live signal. It needs a measurable form: { signal, condition, resourceCorrelation }."
        }
    }

    $statement = [string](Get-ChaosMember -InputObject $Raw -Name 'statement')
    if ([string]::IsNullOrWhiteSpace($statement)) { $statement = $null }

    $source = [string](Get-ChaosMember -InputObject $Raw -Name 'source')
    if ([string]::IsNullOrWhiteSpace($source)) { $source = 'unknown' }

    $signal = [string](Get-ChaosMember -InputObject $Raw -Name 'signal')
    if ([string]::IsNullOrWhiteSpace($signal)) { $signal = $null }

    $query = [string](Get-ChaosMember -InputObject $Raw -Name 'query')
    if ([string]::IsNullOrWhiteSpace($query)) { $query = $null }

    # Which summarised point of a series the threshold applies to. `last` is the
    # most recent sample, which is what "is it breaching right now" means.
    $aggregate = [string](Get-ChaosMember -InputObject $Raw -Name 'aggregate')
    if ([string]::IsNullOrWhiteSpace($aggregate)) { $aggregate = 'last' }

    $conditionText = [string](Get-ChaosMember -InputObject $Raw -Name 'condition')
    if ([string]::IsNullOrWhiteSpace($conditionText)) { $conditionText = $null }

    $correlation = [string](Get-ChaosMember -InputObject $Raw -Name 'resourceCorrelation')
    if ([string]::IsNullOrWhiteSpace($correlation)) { $correlation = $null }

    $condition = $null
    if ($conditionText) { $condition = ConvertFrom-ChaosProbeCondition -Condition $conditionText }

    $reasons = @()
    if (-not $signal -and -not $query) {
        $reasons += 'it names neither a signal nor a query, so there is nothing to measure'
    }
    if ($null -eq $condition) {
        $reasons += 'it carries no condition, so there is no threshold to breach'
    }
    elseif (-not $condition.parsed) {
        $reasons += $condition.reason
    }

    $evaluable = ($reasons.Count -eq 0)
    $reason = if ($evaluable) { $null } else { ($reasons -join '; ') }

    # A criterion with a measurable shape counts as stated even if the customer
    # never wrote a sentence: the structure IS the statement.
    $stated = [bool]($statement -or $evaluable)

    return [ordered]@{
        stated              = $stated
        statement           = $statement
        source              = $source
        signal              = $signal
        query               = $query
        aggregate           = $aggregate
        conditionText       = $conditionText
        condition           = $condition
        resourceCorrelation = $correlation
        evaluable           = $evaluable
        reason              = $reason
    }
}

function Select-ChaosAbortMeasurement {
    <#
    .SYNOPSIS
        Pull the one number an abort criterion is held to out of a collected
        signal result.

    .DESCRIPTION
        Get-ChaosSignalValueMap returns either named columns (a KQL projection)
        or a summarised series (first/last/min/max/mean/count). Both shapes are
        handled, in a fixed order, and the key actually used is reported so the
        operator can see which number the decision was made on.

        Ambiguity is refused. If several columns could plausibly be the signal
        and none matches by name, this returns $null rather than picking one -
        aborting a live study on the wrong number is worse than not aborting.

    .OUTPUTS
        { value; key; detail } - `value` is $null when nothing usable was found.
    #>
    param(
        [Parameter(Mandatory)][AllowNull()][object]$Signal,
        [AllowNull()][AllowEmptyString()][string]$SignalName,
        [AllowNull()][AllowEmptyString()][string]$Aggregate
    )

    if ($null -eq $Signal) {
        return [pscustomobject]@{ value = $null; key = $null; detail = 'no signal result' }
    }

    $map = Get-ChaosSignalValueMap -Signal $Signal
    $keys = @($map.Keys)
    if ($keys.Count -eq 0) {
        return [pscustomobject]@{ value = $null; key = $null; detail = 'the signal carried no measured values' }
    }

    # 1. A column named like the signal. This is the log/projection case.
    if (-not [string]::IsNullOrWhiteSpace($SignalName)) {
        foreach ($key in $keys) {
            if (Test-ChaosSignalNameMatch -Candidate ([string]$key) -SignalName $SignalName) {
                return [pscustomobject]@{ value = $map[$key]; key = [string]$key; detail = "column '$key'" }
            }
        }
    }

    # 2. A summarised series: read the aggregate the criterion asked for.
    $wanted = if ([string]::IsNullOrWhiteSpace($Aggregate)) { 'last' } else { $Aggregate }
    foreach ($key in $keys) {
        if ([string]$key -ieq $wanted) {
            return [pscustomobject]@{ value = $map[$key]; key = [string]$key; detail = "$wanted of the series" }
        }
    }

    # 3. Exactly one measurement, and the signal already matched by identity.
    if ($keys.Count -eq 1) {
        $only = $keys[0]
        return [pscustomobject]@{ value = $map[$only]; key = [string]$only; detail = "the only measured value ('$only')" }
    }

    return [pscustomobject]@{
        value  = $null
        key    = $null
        detail = "the signal produced $($keys.Count) values ($($keys -join ', ')) and none is named '$SignalName' or '$wanted', so which one the threshold applies to is ambiguous"
    }
}

function Test-ChaosAbortCriterion {
    <#
    .SYNOPSIS
        Evaluate the frozen abort criterion against freshly collected signals.

    .DESCRIPTION
        The condition on an abort criterion describes the BREACH, not the happy
        path: "errorRate > 5" means stop when the error rate exceeds 5. So a
        satisfied condition is a breach.

        The result is tri-state on purpose. $null means the criterion could not
        be measured this poll - it is never a pass and never a breach, and the
        caller is expected to react to a run of $nulls rather than treat them as
        "all clear". Silently continuing on unmeasurable data is the exact
        failure mode this whole file exists to prevent.

    .OUTPUTS
        { breached; value; key; signal; detail }
        breached: $true (stop), $false (keep going), $null (could not measure).
    #>
    param(
        [Parameter(Mandatory)][AllowNull()][object]$Criterion,
        [AllowNull()][object[]]$Signals,
        [AllowNull()][object[]]$Sources
    )

    if ($null -eq $Criterion) {
        return [pscustomobject]@{ breached = $null; value = $null; key = $null; signal = $null; detail = 'no abort criterion on this plan' }
    }

    $evaluable = [bool](Get-ChaosMember -InputObject $Criterion -Name 'evaluable')
    if (-not $evaluable) {
        $why = [string](Get-ChaosMember -InputObject $Criterion -Name 'reason')
        if ([string]::IsNullOrWhiteSpace($why)) { $why = 'the criterion is not in an evaluable form' }
        return [pscustomobject]@{ breached = $null; value = $null; key = $null; signal = $null; detail = $why }
    }

    $signalName = [string](Get-ChaosMember -InputObject $Criterion -Name 'signal')
    $aggregate = [string](Get-ChaosMember -InputObject $Criterion -Name 'aggregate')
    $condition = Get-ChaosMember -InputObject $Criterion -Name 'condition'

    $match = $null
    if (-not [string]::IsNullOrWhiteSpace($signalName)) {
        $match = Select-ChaosSignalByName -Signals $Signals -SignalName $signalName -Sources $Sources
    }
    elseif (@($Signals).Count -eq 1) {
        # A query-only criterion over a single configured source: there is only
        # one thing it could be measuring.
        $match = @($Signals)[0]
    }

    if ($null -eq $match) {
        return [pscustomobject]@{
            breached = $null; value = $null; key = $null; signal = $signalName
            detail = "signal '$signalName' was not measured in this poll"
        }
    }

    $measurement = Select-ChaosAbortMeasurement -Signal $match -SignalName $signalName -Aggregate $aggregate
    if ($null -eq $measurement.value) {
        return [pscustomobject]@{
            breached = $null; value = $null; key = $null; signal = $signalName
            detail = $measurement.detail
        }
    }

    $verdict = Test-ChaosProbeCondition -Condition $condition -Value $measurement.value
    $conditionText = [string](Get-ChaosMember -InputObject $Criterion -Name 'conditionText')

    if ($null -eq $verdict) {
        return [pscustomobject]@{
            breached = $null; value = $measurement.value; key = $measurement.key; signal = $signalName
            detail = "'$($measurement.value)' from $($measurement.detail) could not be compared against '$conditionText'"
        }
    }

    $detail = if ($verdict) {
        "$signalName is $($measurement.value) ($($measurement.detail)), which satisfies the abort condition '$conditionText'"
    }
    else {
        "$signalName is $($measurement.value) ($($measurement.detail)); the abort condition '$conditionText' is not met"
    }

    return [pscustomobject]@{
        breached = $verdict
        value    = $measurement.value
        key      = $measurement.key
        signal   = $signalName
        detail   = $detail
    }
}