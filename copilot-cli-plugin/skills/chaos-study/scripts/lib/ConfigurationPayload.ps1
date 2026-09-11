# Configuration payload - the single builder for every scenario configuration
# body this suite sends, whether it is a preflight validation or the real run.
#
# There used to be two builders. The preflight one sent only `parameters`, so a
# configuration that was validated WITHOUT exclusions was used to predict what a
# run WITH exclusions would do. The preflight said an excluded resource would be
# targeted, and the two payloads could never be compared because they were never
# the same object. Anything that sends a configuration body now comes through
# here, so preflight and execution are the same bytes by construction.

Set-StrictMode -Version Latest

# The members the service understands, per side. Anything else in a blast radius
# is a member this suite does not know how to transmit - see
# Get-ChaosBlastRadiusProjection for why that is fatal rather than ignored.
$script:ChaosBlastRadiusMembers = @{
    filters    = @('locations', 'zones', 'physicalZones')
    exclusions = @('resources', 'types', 'tags')
}

function Get-ChaosPayloadMemberName {
    <#
    .SYNOPSIS
        Member names of a hashtable or a PSCustomObject, without caring which.

    .DESCRIPTION
        A blast radius is an ordered hashtable when it is built in-process and a
        PSCustomObject when it has been round-tripped through the plan file.
        Both shapes reach this module, so every reader goes through here.
    #>
    param([AllowNull()][object]$InputObject)

    if ($null -eq $InputObject) { return , @() }
    if ($InputObject -is [System.Collections.IDictionary]) {
        return , @($InputObject.Keys | ForEach-Object { [string]$_ })
    }
    return , @($InputObject.PSObject.Properties | ForEach-Object { $_.Name })
}

function Get-ChaosPayloadMemberValue {
    <#
    .SYNOPSIS
        Read one member from either shape.
    #>
    param([AllowNull()][object]$InputObject, [Parameter(Mandatory)][string]$Name)

    if ($null -eq $InputObject) { return $null }
    if ($InputObject -is [System.Collections.IDictionary]) {
        if (-not $InputObject.Contains($Name)) { return $null }
        return $InputObject[$Name]
    }
    if (@($InputObject.PSObject.Properties.Name) -notcontains $Name) { return $null }
    return $InputObject.$Name
}

function Test-ChaosPayloadValueEmpty {
    <#
    .SYNOPSIS
        Is this member absent for transmission purposes?

    .DESCRIPTION
        Empty is not the same as absent on the wire. `{"locations":[]}` means
        "no locations", which matches nothing and would quietly turn a study
        into a no-op that still reports success. Omitting the member means
        "unconstrained". Empty members are therefore dropped, never serialised.
    #>
    param([AllowNull()][object]$Value)

    if ($null -eq $Value) { return $true }
    if ($Value -is [string]) { return [string]::IsNullOrWhiteSpace($Value) }
    if ($Value -is [System.Collections.IDictionary]) { return ($Value.Count -eq 0) }
    if ($Value -is [System.Collections.IEnumerable]) { return (@($Value).Count -eq 0) }
    return $false
}

function Get-ChaosBlastRadiusProjection {
    <#
    .SYNOPSIS
        Project a blast radius into the filters/exclusions the service accepts.

    .DESCRIPTION
        Returns an object with `filters` and `exclusions`, each either a
        transmittable object or $null for "unconstrained". Empty members are
        dropped (see Test-ChaosPayloadValueEmpty).

        An unknown member that actually carries a value is FATAL. A blast radius
        exists to narrow what a fault may touch; silently dropping a member this
        suite cannot map would widen the run beyond what the operator reviewed
        and consented to. Failing loudly is the only safe response - the caller
        can then either drop the constraint deliberately or stop.
    #>
    [CmdletBinding()]
    param([AllowNull()][object]$BlastRadius)

    $result = [ordered]@{ filters = $null; exclusions = $null }
    if ($null -eq $BlastRadius) { return [pscustomobject]$result }

    $unmappable = @()

    foreach ($side in @('filters', 'exclusions')) {
        $source = Get-ChaosPayloadMemberValue -InputObject $BlastRadius -Name $side
        if ($null -eq $source) { continue }

        $known = $script:ChaosBlastRadiusMembers[$side]
        $projected = [ordered]@{}

        foreach ($name in (Get-ChaosPayloadMemberName -InputObject $source)) {
            $value = Get-ChaosPayloadMemberValue -InputObject $source -Name $name
            if (Test-ChaosPayloadValueEmpty -Value $value) { continue }
            if ($known -notcontains $name) {
                $unmappable += "$side.$name"
                continue
            }
            $projected[$name] = $value
        }

        if ($projected.Count -gt 0) { $result[$side] = [pscustomobject]$projected }
    }

    if ($unmappable.Count -gt 0) {
        throw ("This blast radius carries constraint(s) this suite cannot transmit: $($unmappable -join ', '). " +
            'Sending the configuration without them would widen the run beyond the reviewed blast radius, so nothing was sent. ' +
            "Supported members are filters: $($script:ChaosBlastRadiusMembers.filters -join ', '); exclusions: $($script:ChaosBlastRadiusMembers.exclusions -join ', ').")
    }

    return [pscustomobject]$result
}

function New-ChaosConfigurationBody {
    <#
    .SYNOPSIS
        Build the one scenario configuration body used for preflight AND run.

    .DESCRIPTION
        Returns $null when there is nothing to send, so callers can omit the
        body entirely rather than posting an empty object.

        ScenarioParameters is the {key,value} list the service takes. It is
        emitted with its cardinality preserved - a single parameter is still a
        list - because the CLI rejects a bare object where it expects an array.
    #>
    [CmdletBinding()]
    param(
        [AllowNull()][AllowEmptyCollection()][object[]]$ScenarioParameters = @(),
        [AllowNull()][object]$BlastRadius
    )

    $body = [ordered]@{}

    $parameters = @($ScenarioParameters | Where-Object { $null -ne $_ })
    if ($parameters.Count -gt 0) { $body['parameters'] = @($parameters) }

    $blast = Get-ChaosBlastRadiusProjection -BlastRadius $BlastRadius
    if ($null -ne $blast.filters) { $body['filters'] = $blast.filters }
    if ($null -ne $blast.exclusions) { $body['exclusions'] = $blast.exclusions }

    if ($body.Count -eq 0) { return $null }
    return $body
}

function Get-ChaosConfigurationBodyDigest {
    <#
    .SYNOPSIS
        Stable digest of a configuration body, for freezing and comparison.

    .DESCRIPTION
        Two bodies that would produce the same configuration must digest the
        same, so the preflight that was validated can be proven identical to the
        payload that is about to execute. A null body is a real state ("nothing
        constrained, no parameters") and digests as such rather than throwing.
    #>
    [CmdletBinding()]
    param([AllowNull()][object]$Body)

    if ($null -eq $Body) { return Get-ChaosDigest -InputObject '(no configuration body)' }
    return Get-ChaosDigest -InputObject $Body
}

function Assert-ChaosConfigurationBodyMatch {
    <#
    .SYNOPSIS
        Refuse to execute a body that differs from the one that was validated.

    .DESCRIPTION
        The preflight exists to predict the run. If the payload drifted between
        the two, the prediction describes a different configuration than the one
        about to execute, and every conclusion drawn from it - including which
        resources were excluded - is void.
    #>
    [CmdletBinding()]
    param(
        [AllowNull()][object]$ValidatedBody,
        [AllowNull()][object]$ExecutionBody,
        [AllowNull()][AllowEmptyString()][string]$Context = 'execution'
    )

    $validated = Get-ChaosConfigurationBodyDigest -Body $ValidatedBody
    $execution = Get-ChaosConfigurationBodyDigest -Body $ExecutionBody
    if ($validated -eq $execution) { return $true }

    throw ("The configuration validated at preflight is not the configuration this $Context would send " +
        "(validated $validated, now $execution). The preflight result describes a different blast radius, " +
        'so it cannot be used to authorise this run. Re-run chaos-study-scope to revalidate.')
}
