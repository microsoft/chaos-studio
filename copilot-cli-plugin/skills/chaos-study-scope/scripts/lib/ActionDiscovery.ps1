#Requires -Version 7.0
<#
.SYNOPSIS
    Live discovery of the actions Chaos Studio can actually run.

.DESCRIPTION
    This suite ships no catalogue of faults. There is exactly one source of
    truth for what can be injected, and it is the service:

      GET /subscriptions/{sub}/providers/Microsoft.Chaos
            /locations/{region}/actions?api-version=...

    Everything downstream - the action a study records, its parameters, the
    resource types it applies to, the roles it needs, whether it is continuous
    or discrete - is read from that response at scope time and recorded in the
    plan. Nothing is inferred from a name and nothing is hardcoded.

    That constraint is deliberate rather than incidental. A bundled catalogue
    goes stale silently: it keeps describing faults after they are renamed,
    versioned or withdrawn, and a plan built from it names a fault the platform
    will refuse. The failure surfaces during a change window, as a null result
    that reads like a pass. Reading the live list means a study can only ever
    plan something the platform has just said it supports.

    The corollary is that there is no fallback. When discovery cannot run, this
    file fails loudly with exit code 16 rather than degrading to a guess. An
    error that stops scoping costs a few minutes; a fabricated action costs a
    change window and produces evidence nobody should trust.
#>

Set-StrictMode -Version Latest

. (Join-Path $PSScriptRoot '..' '..' '..' 'chaos-study' 'scripts' 'lib' 'Common.ps1')
. (Join-Path $PSScriptRoot '..' '..' '..' 'chaos-study' 'scripts' 'lib' 'ApiVersions.ps1')
. (Join-Path $PSScriptRoot '..' '..' '..' 'chaos-study' 'scripts' 'lib' 'Operation.ps1')

# -- Region resolution -----------------------------------------------------

function Resolve-ChaosResourceRegion {
    <#
    .SYNOPSIS
        Read a resource's region from ARM.

    .DESCRIPTION
        The actions list is region-scoped, so the region has to be right before
        anything else can be asked. It is read from the scoped resource rather
        than guessed or defaulted, because a wrong region silently returns a
        different - usually smaller - set of actions, and the study would then
        plan against an inventory that does not describe where it will run.

        Returns $null when the region cannot be read. Callers treat that as a
        hard stop, not as permission to pick one.
    #>
    param(
        [Parameter(Mandatory)][string]$ResourceId,
        [AllowNull()][AllowEmptyString()][string]$Adapter,
        [AllowNull()][AllowEmptyString()][string]$StudyPath
    )

    try {
        $response = Invoke-ChaosStudyOperation -Kind 'resource.get' -Arguments @{ resourceId = $ResourceId } `
            -ExpectedSchema 'any.v1' -Adapter $Adapter -StudyPath $StudyPath -OperationHint 'read resource region'
    } catch {
        Write-ChaosStudyNote -Message "Could not read '$ResourceId' to resolve its region: $($_.Exception.Message)" -Level 'warn'
        return $null
    }

    if (-not $response -or -not $response.body) { return $null }
    if ($response.body.PSObject.Properties.Name -notcontains 'location') { return $null }

    $location = [string]$response.body.location
    if ([string]::IsNullOrWhiteSpace($location)) { return $null }
    return $location
}

# -- The live actions list -------------------------------------------------

function ConvertTo-ChaosActionRecord {
    <#
    .SYNOPSIS
        Project one service action into the shape the rest of the suite uses.

    .DESCRIPTION
        Only fields the service actually returned are populated. Anything
        absent stays $null so a later step can say "the service did not tell
        us" instead of presenting a default as fact.
    #>
    param([Parameter(Mandatory)][object]$Action)

    $properties = $null
    if ($Action.PSObject.Properties.Name -contains 'properties') { $properties = $Action.properties }

    $read = {
        param($name)
        if ($null -eq $properties) { return $null }
        if ($properties.PSObject.Properties.Name -notcontains $name) { return $null }
        return $properties.$name
    }

    # `supportedTargetTypes` is the actions endpoint's own field name in the V2
    # response. It is read verbatim because inventing a different source would
    # be inventing evidence, but it is projected onto V2 vocabulary - a list of
    # ARM resource types this action applies to - so nothing downstream has to
    # reason about resource kinds the workspace does not model.
    $appliesTo = @()
    $supported = & $read 'supportedTargetTypes'
    foreach ($entry in @($supported)) {
        if ($null -eq $entry) { continue }
        $resourceType = if ($entry.PSObject.Properties.Name -contains 'targetType') { [string]$entry.targetType } else { $null }
        if ([string]::IsNullOrWhiteSpace($resourceType)) { continue }
        $permissions = @()
        if ($entry.PSObject.Properties.Name -contains 'requiredPermissions') {
            $permissions = @($entry.requiredPermissions | Where-Object { $null -ne $_ })
        }
        $appliesTo += [pscustomobject]@{
            resourceType        = $resourceType
            requiredPermissions = $permissions
        }
    }

    $name = if ($Action.PSObject.Properties.Name -contains 'name') { [string]$Action.name } else { $null }

    return [pscustomobject]@{
        name             = $name
        actionName       = [string](& $read 'actionName')
        canonicalId      = [string](& $read 'canonicalId')
        actionType       = [string](& $read 'actionType')
        displayName      = [string](& $read 'displayName')
        description      = [string](& $read 'description')
        version          = [string](& $read 'version')
        parametersSchema = & $read 'parametersSchema'
        recommendedRoles = @((& $read 'recommendedRoles') | Where-Object { $null -ne $_ })
        appliesTo        = @($appliesTo)
    }
}

function Get-ChaosAvailableAction {
    <#
    .SYNOPSIS
        Every action Chaos Studio reports for a region, as the service returns
        them.

    .DESCRIPTION
        Throws on any failure. Discovery is the foundation the whole plan rests
        on, so a partial or unreadable answer must not be quietly rounded down
        to an empty list - an empty list and a failed call lead to opposite
        conclusions, and only one of them is a reason to keep going.

        The response is paged defensively via nextLink even though the current
        service returns a single page.
    #>
    param(
        [Parameter(Mandatory)][string]$SubscriptionId,
        [Parameter(Mandatory)][string]$Region,
        [AllowNull()][AllowEmptyString()][string]$Adapter,
        [AllowNull()][AllowEmptyString()][string]$StudyPath
    )

    $uri = "/subscriptions/$SubscriptionId/providers/Microsoft.Chaos/locations/$Region/actions"

    $actions = [System.Collections.Generic.List[object]]::new()
    $page = 0
    while ($uri) {
        $page++
        if ($page -gt 20) { throw "The actions list did not terminate after $page pages." }

        $response = Invoke-ChaosStudyOperation -Kind 'actions.list' -Arguments @{ uri = $uri } `
            -ExpectedSchema 'any.v1' -Adapter $Adapter -StudyPath $StudyPath -OperationHint "list actions in $Region"
        if (-not $response -or -not $response.body) {
            throw "The actions endpoint returned no body for region '$Region'."
        }

        $body = $response.body
        if ($body.PSObject.Properties.Name -contains 'value') {
            foreach ($entry in @($body.value)) {
                if ($null -eq $entry) { continue }
                [void]$actions.Add((ConvertTo-ChaosActionRecord -Action $entry))
            }
        }

        $uri = $null
        if ($body.PSObject.Properties.Name -contains 'nextLink') {
            $next = [string]$body.nextLink
            if (-not [string]::IsNullOrWhiteSpace($next)) { $uri = $next }
        }
    }

    return , @($actions.ToArray())
}

function Select-ChaosActionForResourceType {
    <#
    .SYNOPSIS
        Narrow the live list to the actions that apply to one ARM resource type.
    #>
    param(
        [Parameter(Mandatory)][AllowEmptyCollection()][object[]]$Actions,
        [AllowNull()][AllowEmptyString()][string]$ResourceType
    )

    if ([string]::IsNullOrWhiteSpace($ResourceType)) { return , @($Actions) }

    $matched = @($Actions | Where-Object {
            @($_.appliesTo | ForEach-Object { $_.resourceType }) -contains $ResourceType
        })
    return , @($matched)
}

function Find-ChaosAction {
    <#
    .SYNOPSIS
        Resolve a user-supplied action reference against the live list.

    .DESCRIPTION
        Accepts the action name, its canonical URN, or its display name. The
        match must be unambiguous: an ambiguous reference is an error rather
        than a pick, because silently choosing between two faults changes what
        the study tests without telling anyone.
    #>
    param(
        [Parameter(Mandatory)][AllowEmptyCollection()][object[]]$Actions,
        [Parameter(Mandatory)][string]$Reference
    )

    $needle = $Reference.Trim()
    if ([string]::IsNullOrWhiteSpace($needle)) { return $null }

    foreach ($field in @('name', 'canonicalId', 'actionName', 'displayName')) {
        $exact = @($Actions | Where-Object { $_.$field -and ([string]$_.$field) -ieq $needle })
        if ($exact.Count -eq 1) { return $exact[0] }
        if ($exact.Count -gt 1) {
            $names = ($exact | ForEach-Object { $_.name }) -join ', '
            throw "Action reference '$Reference' matched $($exact.Count) live actions ($names). Use the canonical URN to disambiguate."
        }
    }

    $partial = @($Actions | Where-Object {
            ($_.name -and ([string]$_.name).ToLowerInvariant().Contains($needle.ToLowerInvariant())) -or
            ($_.canonicalId -and ([string]$_.canonicalId).ToLowerInvariant().Contains($needle.ToLowerInvariant()))
        })
    if ($partial.Count -eq 1) { return $partial[0] }
    if ($partial.Count -gt 1) {
        $names = ($partial | ForEach-Object { $_.name }) -join ', '
        throw "Action reference '$Reference' matched $($partial.Count) live actions ($names). Use the canonical URN to disambiguate."
    }

    return $null
}

# -- Parameters ------------------------------------------------------------

function Get-ChaosActionParameterSpec {
    <#
    .SYNOPSIS
        Flatten an action's JSON Schema into a list a human can read.

    .DESCRIPTION
        The service returns a full draft-04 schema per action. This pulls out
        the top-level properties, their types, whether they are required and
        any enum, which is what a operator needs to see to fill the action in.
        The schema itself is kept intact on the plan; this is a view of it, not
        a replacement for it.
    #>
    param([AllowNull()][object]$Schema)

    if ($null -eq $Schema) { return , @() }
    if ($Schema.PSObject.Properties.Name -notcontains 'properties') { return , @() }

    $required = @()
    if ($Schema.PSObject.Properties.Name -contains 'required') {
        $required = @($Schema.required | Where-Object { $null -ne $_ } | ForEach-Object { [string]$_ })
    }

    $specs = @()
    foreach ($property in $Schema.properties.PSObject.Properties) {
        $definition = $property.Value
        $type = $null
        $description = $null
        $enum = @()

        if ($null -ne $definition) {
            if ($definition.PSObject.Properties.Name -contains 'type') { $type = [string]$definition.type }
            if ($definition.PSObject.Properties.Name -contains 'description') { $description = [string]$definition.description }
            if ($definition.PSObject.Properties.Name -contains 'enum') {
                $enum = @($definition.enum | Where-Object { $null -ne $_ } | ForEach-Object { [string]$_ })
            }
        }

        $specs += [pscustomobject]@{
            name        = $property.Name
            type        = $type
            required    = ($required -contains $property.Name)
            description = $description
            enum        = $enum
        }
    }

    return , @($specs | Sort-Object -Property @{ Expression = { -not $_.required } }, 'name')
}

function Test-ChaosActionParameters {
    <#
    .SYNOPSIS
        Check supplied parameters against the action's live schema.

    .DESCRIPTION
        Two failures matter and they are different. A missing required
        parameter means the platform will reject the scenario configuration -
        better to find that now than in a change window. An unrecognised
        parameter means the operator believes they configured something they
        did not, which is the more dangerous of the two because the study still
        runs.

        Returns the problems rather than throwing, so the caller can present
        them together instead of one per attempt.
    #>
    param(
        [AllowNull()][object]$Schema,
        [AllowNull()][object]$Parameters
    )

    $problems = @()
    $specs = ConvertTo-ChaosList (Get-ChaosActionParameterSpec -Schema $Schema)
    if ($specs.Count -eq 0) { return , @($problems) }

    $supplied = @()
    if ($null -ne $Parameters) {
        $supplied = if ($Parameters -is [System.Collections.IDictionary]) {
            @($Parameters.Keys | ForEach-Object { [string]$_ })
        } else {
            @($Parameters.PSObject.Properties.Name)
        }
    }

    foreach ($spec in $specs) {
        if ($spec.required -and $supplied -notcontains $spec.name) {
            $problems += "Required parameter '$($spec.name)' was not supplied. The service schema for this action marks it required, so the scenario configuration would be rejected."
        }
    }

    $known = @($specs | ForEach-Object { $_.name })
    foreach ($name in $supplied) {
        if ($known -notcontains $name) {
            $problems += "Parameter '$name' is not in this action's schema. It would be sent and ignored, so the study would not test what the parameter implies. Known parameters: $($known -join ', ')."
        }
    }

    foreach ($spec in $specs) {
        if ($spec.enum.Count -eq 0) { continue }
        if ($supplied -notcontains $spec.name) { continue }
        $value = if ($Parameters -is [System.Collections.IDictionary]) { $Parameters[$spec.name] } else { $Parameters.$($spec.name) }
        if ($null -eq $value) { continue }
        if ($spec.enum -notcontains ([string]$value)) {
            $problems += "Parameter '$($spec.name)' is '$value', which is not one of the values the schema allows: $($spec.enum -join ', ')."
        }
    }

    return , @($problems)
}

# -- Failure --------------------------------------------------------------

function Assert-ChaosActionDiscovery {
    <#
    .SYNOPSIS
        Stop with exit code 16 when the live action list could not be read.

    .DESCRIPTION
        This is the loud failure the no-fallback rule requires. It exists so
        that the alternative - continuing with an assumed action - is not
        reachable by accident.
    #>
    param(
        [Parameter(Mandatory)][string]$Reason,
        [AllowNull()][AllowEmptyString()][string]$Remediation = $null
    )

    $message = @"
$Reason

This suite plans studies only against actions Chaos Studio reports as available
right now. It ships no bundled list of faults to fall back to, because a stale
list produces plans the platform will refuse - and it produces them at the
moment they are hardest to debug.

Scoping stopped before writing a study plan.
"@

    $fix = if ([string]::IsNullOrWhiteSpace($Remediation)) {
        'Confirm az login, the subscription, and that the region is one Chaos Studio serves, then re-run scoping.'
    } else { $Remediation }

    Write-ChaosStudyFailure -Title 'Live action discovery unavailable' -Message $message -Remediation $fix
    exit (Get-ChaosStudyExitCode -Name 'ActionDiscoveryUnavailable')
}
