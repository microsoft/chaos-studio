#requires -Version 7.0
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

<#
    Fault duration is not the observation budget.

    `-DurationMinutes` is how long this suite WATCHES. The scenario's own
    duration parameter is how long the platform INJECTS. They are different
    numbers with different owners, and conflating them is a safety defect:
    a study described to a customer as "five minutes" will inject for the
    scenario's default - fifteen minutes on the services observed so far -
    because the service default is applied when nobody overrides it.

    Everything here resolves the injection number from evidence only:
    an explicit scenario parameter the operator supplied, or a default the
    live scenario contract declared. When neither exists the answer is
    "unknown" and the caller must stop and say so. Nothing in this file
    guesses a unit, assumes a default, or converts a bare number into a
    duration - a wrong guess here is exactly the failure it exists to prevent.
#>

# Scenario parameters that carry injection time. Matched case-insensitively
# against the live scenario contract - this selects among names the SERVICE
# declared, it does not invent a parameter that is not there.
$script:ChaosFaultDurationParameterPattern = '(?i)^(duration|faultDuration|injectionDuration|runDuration|actionDuration)$'

function ConvertFrom-ChaosIso8601Duration {
    <#
    .SYNOPSIS
        ISO-8601 duration text -> whole seconds, or $null when it is not
        an ISO-8601 duration.

    .DESCRIPTION
        Returns $null rather than a number for anything it cannot read,
        including a bare number such as "15". A bare number has no unit,
        and choosing one (minutes? seconds?) is the assumption this whole
        file exists to refuse. Months and years are also refused: they have
        no fixed length, so they cannot become seconds honestly.
    #>
    [CmdletBinding()]
    param([AllowNull()][AllowEmptyString()][string]$Value)

    if ([string]::IsNullOrWhiteSpace($Value)) { return $null }
    $text = $Value.Trim()

    # PnDTnHnMnS. Weeks (PnW) are accepted; months and years are not, because
    # their length depends on a calendar position we do not have.
    if ($text -match '(?i)^P(?:\d+Y|\d+M(?!.*T))') { return $null }

    if ($text -match '(?i)^P(\d+(?:\.\d+)?)W$') {
        return [int][math]::Round([double]$Matches[1] * 604800)
    }

    $pattern = '(?i)^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$'
    if ($text -notmatch $pattern) { return $null }

    $days = if ($Matches[1]) { [double]$Matches[1] } else { 0 }
    $hours = if ($Matches[2]) { [double]$Matches[2] } else { 0 }
    $minutes = if ($Matches[3]) { [double]$Matches[3] } else { 0 }
    $seconds = if ($Matches[4]) { [double]$Matches[4] } else { 0 }

    $total = ($days * 86400) + ($hours * 3600) + ($minutes * 60) + $seconds
    # "P" or "PT" alone parses but means nothing.
    if ($total -le 0) { return $null }
    return [int][math]::Round($total)
}

function Format-ChaosDurationSeconds {
    <#
    .SYNOPSIS
        Seconds -> a phrase an operator can check against what they were told.
    #>
    [CmdletBinding()]
    param([AllowNull()][object]$Seconds)

    if ($null -eq $Seconds) { return 'unknown' }
    $value = [int]$Seconds
    if ($value -lt 60) { return "$value second(s)" }
    if ($value % 60 -eq 0) { return "$([int]($value / 60)) minute(s)" }
    return "$([math]::Round($value / 60.0, 1)) minute(s)"
}

function Get-ChaosScenarioDurationParameter {
    <#
    .SYNOPSIS
        The scenario parameter that carries injection time, as the live
        contract declared it - or $null when the contract declares none.
    #>
    [CmdletBinding()]
    param([AllowNull()][object]$Scenario)

    if ($null -eq $Scenario) { return $null }
    if ($Scenario.PSObject.Properties.Name -notcontains 'parameters') { return $null }

    foreach ($parameter in @($Scenario.parameters)) {
        if ($null -eq $parameter) { continue }
        if ($parameter.PSObject.Properties.Name -notcontains 'name') { continue }
        $name = [string]$parameter.name
        if ($name -match $script:ChaosFaultDurationParameterPattern) { return $parameter }
    }
    return $null
}

function Resolve-ChaosFaultDuration {
    <#
    .SYNOPSIS
        How long the platform will actually inject, beside how long we watch.

    .DESCRIPTION
        Resolution order, evidence only:

          1. A value the operator supplied for the scenario's duration
             parameter. This is the configured duration and it wins.
          2. The default the live scenario contract declares for that
             parameter. This is the number that applies when nobody
             overrides it - the fifteen minutes behind a "five-minute" study.
          3. Nothing. The answer is unknown, and the caller must stop.

        `acknowledgementRequired` is true whenever the number is unknown, or
        known and longer than the observation budget. Those are the two cases
        where consent given against the budget would be consent to something
        larger than what was described.
    #>
    [CmdletBinding()]
    param(
        [AllowNull()][object]$Scenario,
        [AllowNull()][hashtable]$ScenarioParameters,
        [Parameter(Mandatory)][int]$ObservationBudgetMinutes
    )

    $budgetSeconds = $ObservationBudgetMinutes * 60
    $parameter = Get-ChaosScenarioDurationParameter -Scenario $Scenario

    $source = 'unknown'
    $parameterName = $null
    $rawValue = $null
    $reason = $null

    if ($null -ne $parameter) {
        $parameterName = [string]$parameter.name

        $supplied = $null
        if ($null -ne $ScenarioParameters) {
            foreach ($key in $ScenarioParameters.Keys) {
                if ([string]$key -ieq $parameterName) { $supplied = $ScenarioParameters[$key]; break }
            }
        }

        if ($null -ne $supplied -and -not [string]::IsNullOrWhiteSpace([string]$supplied)) {
            $source = 'configured'
            $rawValue = [string]$supplied
        }
        else {
            # Both spellings, for the same reason the projection reads both:
            # a default that is present but unread is a fault length nobody sees.
            $declared = $null
            foreach ($field in @('default', 'defaultValue')) {
                if ($parameter.PSObject.Properties.Name -contains $field -and
                    $null -ne $parameter.$field -and
                    -not [string]::IsNullOrWhiteSpace([string]$parameter.$field)) {
                    $declared = [string]$parameter.$field
                    break
                }
            }
            if ($null -ne $declared) {
                $source = 'scenario-default'
                $rawValue = $declared
            }
            else {
                $reason = "The scenario declares a '$parameterName' parameter but no default, and none was supplied, so how long the fault runs is decided by the service and is not visible here."
            }
        }
    }
    else {
        $reason = 'The live scenario contract declares no duration parameter, so how long the fault runs is not visible from its metadata.'
    }

    $seconds = ConvertFrom-ChaosIso8601Duration -Value $rawValue
    if ($null -ne $rawValue -and $null -eq $seconds) {
        # Readable value, unreadable unit. Report it verbatim and keep the
        # number unknown - inventing "15 means minutes" is the defect.
        $reason = "The scenario's '$parameterName' value '$rawValue' is not an ISO-8601 duration, so it cannot be compared with the observation budget without assuming a unit."
    }

    $exceeds = $null
    if ($null -ne $seconds) { $exceeds = ($seconds -gt $budgetSeconds) }

    $acknowledgementRequired = ($null -eq $seconds) -or ($exceeds -eq $true)

    $statement = if ($null -eq $seconds) {
        "Fault duration unknown; observation budget $(Format-ChaosDurationSeconds -Seconds $budgetSeconds)."
    }
    elseif ($exceeds) {
        "Fault runs $(Format-ChaosDurationSeconds -Seconds $seconds) ($rawValue, $source) but observation ends after $(Format-ChaosDurationSeconds -Seconds $budgetSeconds) - the fault outlives the study."
    }
    else {
        "Fault runs $(Format-ChaosDurationSeconds -Seconds $seconds) ($rawValue, $source), within the $(Format-ChaosDurationSeconds -Seconds $budgetSeconds) observation budget."
    }

    return [pscustomobject]@{
        source                       = $source
        parameterName                = $parameterName
        rawValue                     = $rawValue
        seconds                      = $seconds
        observationBudgetMinutes     = $ObservationBudgetMinutes
        observationBudgetSeconds     = $budgetSeconds
        exceedsObservationBudget     = $exceeds
        acknowledgementRequired      = $acknowledgementRequired
        acknowledgedSeconds          = $null
        acknowledged                 = $false
        reason                       = $reason
        statement                    = $statement
    }
}

function Assert-ChaosFaultDurationAcknowledged {
    <#
    .SYNOPSIS
        Gate the fault duration before consent can mean anything.

    .DESCRIPTION
        When the number is known, acknowledgement is the number itself: the
        operator must repeat the seconds the platform will inject for. A
        checkbox would let someone approve a fifteen-minute injection while
        still believing the study is five minutes; repeating the number
        cannot be done without reading it.

        When the number is unknown there is no number to repeat, so the
        acknowledgement is an explicit acceptance that the study will start a
        fault of undeclared length. Both paths mutate the record so the plan
        carries what was acknowledged, not merely that something was.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][object]$FaultDuration,
        [AllowNull()][object]$AcknowledgedSeconds,
        [switch]$AcceptUnknownFaultDuration
    )

    if (-not $FaultDuration.acknowledgementRequired) {
        $FaultDuration.acknowledged = $true
        $FaultDuration.acknowledgedSeconds = $FaultDuration.seconds
        return $FaultDuration
    }

    if ($null -eq $FaultDuration.seconds) {
        if ($AcceptUnknownFaultDuration) {
            $FaultDuration.acknowledged = $true
            return $FaultDuration
        }
        throw "ChaosFaultDurationUnacknowledged: $($FaultDuration.statement) $($FaultDuration.reason) Re-run with -AcceptUnknownFaultDuration to start a fault whose length the service has not declared, or supply the scenario's duration parameter explicitly via -Parameters."
    }

    if ($null -eq $AcknowledgedSeconds) {
        throw "ChaosFaultDurationUnacknowledged: $($FaultDuration.statement) Re-run with -AcknowledgeFaultDurationSeconds $($FaultDuration.seconds) to confirm you have read how long the fault actually runs."
    }

    $claimed = [int]$AcknowledgedSeconds
    if ($claimed -ne [int]$FaultDuration.seconds) {
        throw "ChaosFaultDurationUnacknowledged: -AcknowledgeFaultDurationSeconds $claimed does not match the configured fault duration of $([int]$FaultDuration.seconds) second(s). $($FaultDuration.statement)"
    }

    $FaultDuration.acknowledged = $true
    $FaultDuration.acknowledgedSeconds = $claimed
    return $FaultDuration
}
