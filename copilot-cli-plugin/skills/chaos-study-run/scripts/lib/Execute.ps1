#Requires -Version 7.0
<#
.SYNOPSIS
    Consent, plan integrity, and the Chaos Studio V2 scenario lifecycle.

.DESCRIPTION
    Four ideas govern this file.

    Nothing runs without consent. Consent is a phrase the operator types, and
    the phrase names the action, the workspace it lands in and a hash of the
    plan. It cannot be given by accident, it cannot be given in advance, and it
    cannot be inherited from an environment variable - this suite deliberately
    ignores STARTCHAOS_NONINTERACTIVE, because "unattended" is not a reason to
    skip the one gate that bounds production risk.

    Consent applies to a specific plan. If the plan changed after it was shown,
    the hash no longer matches and execution stops. The thing consented to is
    provably the thing that runs.

    Nothing executes on an unvalidated configuration. Chaos Studio validates a
    scenario configuration against the live scope and the workspace identity's
    permissions. A configuration that is not `Succeeded` will start a run that
    fails within seconds with an opaque error, so this file refuses to execute
    until validation succeeds - after offering the permission fix the service
    itself recommends.

    Injection is bounded and abortable. The configuration carries the filters
    and exclusions frozen at scope time, and cancellation runs in a finally
    block so an interrupted study still cancels the run it started.

    Every Azure operation here goes through Invoke-ChaosStudyOperation, the
    adapter seam, rather than calling a CLI directly. The seam speaks the Chaos
    Studio V2 surface - workspaces, scopes, scenarios, scenario configurations
    and scenario runs - and can either execute against ambient credentials or
    hand the operation to an authenticated host and resume when its result
    arrives. Nothing in this file assumes it holds credentials of its own.
#>

Set-StrictMode -Version Latest

. (Join-Path $PSScriptRoot '..' '..' '..' 'chaos-study' 'scripts' 'lib' 'Common.ps1')
. (Join-Path $PSScriptRoot '..' '..' '..' 'chaos-study' 'scripts' 'lib' 'ApiVersions.ps1')
. (Join-Path $PSScriptRoot '..' '..' '..' 'chaos-study' 'scripts' 'lib' 'Operation.ps1')
. (Join-Path $PSScriptRoot '..' '..' '..' 'chaos-study' 'scripts' 'lib' 'Residue.ps1')
. (Join-Path $PSScriptRoot '..' '..' '..' 'chaos-study' 'scripts' 'lib' 'ConfigurationPayload.ps1')
# The run recomputes the effective-plan hash before arming, so it needs the same
# plan model scope froze it with. Omitting this made Get-ChaosEffectivePlanHash
# an undefined command AFTER config create and validate had already run, leaking
# the configuration the study had just built.
. (Join-Path $PSScriptRoot '..' '..' '..' 'chaos-study' 'scripts' 'lib' 'ExecutionPlan.ps1')

# -- Adapter resolution ----------------------------------------------------

function Get-ChaosExecutionAdapter {
    <#
    .SYNOPSIS
        Resolve the adapter a control-plane operation must run through.

    .DESCRIPTION
        Deliberately has no default. Read-only evidence collection may fall back
        to the ambient CLI because the worst case is a missing signal; creating
        a configuration or starting a run may not, because the worst case is an
        operation that silently ran somewhere the operator did not intend. An
        unresolvable adapter stops the study instead.
    #>
    param(
        [Parameter(Mandatory)][AllowNull()][object]$Plan,
        [AllowNull()][AllowEmptyString()][string]$Adapter
    )

    if (-not [string]::IsNullOrWhiteSpace($Adapter)) { return $Adapter }
    if ($null -ne $Plan -and ($Plan.PSObject.Properties.Name -contains 'adapter') -and
        -not [string]::IsNullOrWhiteSpace([string]$Plan.adapter)) {
        return [string]$Plan.adapter
    }
    throw 'AdapterUnavailable: no execution adapter was resolved for this operation, and there is no implicit fallback for control-plane work. Re-run scoping so the plan records an adapter, or pass -Adapter explicitly.'
}

function Get-ChaosConfigurationScopingArgument {
    <#
    .SYNOPSIS
        The arguments that identify a scenario configuration.

    .DESCRIPTION
        The subscription is part of the identity, not ambient context. Without
        it every configuration call lands in whatever subscription `az` happens
        to have selected, so a study scoped to one subscription could create,
        validate, execute and then fail to clean up a configuration in another.
    #>
    param(
        [Parameter(Mandatory)][object]$Plan,
        [Parameter(Mandatory)][string]$ConfigurationName
    )
    $cliArgs = @(
        '-n', $ConfigurationName,
        '-g', $Plan.workspace.resourceGroup,
        '--workspace-name', $Plan.workspace.name,
        '--scenario-name', $Plan.scenario.name
    )

    $subscriptionId = $null
    if (@($Plan.workspace.PSObject.Properties.Name) -contains 'subscriptionId') {
        $subscriptionId = [string]$Plan.workspace.subscriptionId
    }
    if (-not [string]::IsNullOrWhiteSpace($subscriptionId)) {
        $cliArgs += @('--subscription', $subscriptionId)
    }

    return , @($cliArgs)
}

function Get-ChaosPlanConfigurationBody {
    <#
    .SYNOPSIS
        The configuration payload this plan describes.

    .DESCRIPTION
        One builder for the body the run sends and the body the effective-plan
        hash covers, so "what was consented to" and "what executes" cannot
        diverge through a second projection.
    #>
    param([Parameter(Mandatory)][object]$Plan)

    $blast = $null
    if ($Plan.scope.PSObject.Properties.Name -contains 'blastRadius') { $blast = $Plan.scope.blastRadius }
    return New-ChaosConfigurationBody -ScenarioParameters @(Get-ChaosScenarioParameterList -Plan $Plan) -BlastRadius $blast
}

# -- Plan integrity --------------------------------------------------------

function Get-ChaosPlanFingerprint {
    <#
    .SYNOPSIS
        Recompute the plan hash over everything except the hash itself.
    #>
    param([Parameter(Mandatory)][object]$Plan)

    $copy = [ordered]@{}
    $names = if ($Plan -is [System.Collections.IDictionary]) { @($Plan.Keys) } else { @($Plan.PSObject.Properties | ForEach-Object { $_.Name }) }
    foreach ($name in $names) {
        if ($name -eq 'frozenConfigHash') { continue }
        $copy["$name"] = if ($Plan -is [System.Collections.IDictionary]) { $Plan[$name] } else { $Plan.$name }
    }
    return Get-ChaosDigest -InputObject $copy
}

function Assert-ChaosPlanIntegrity {
    <#
    .SYNOPSIS
        Refuse to run a plan that was edited after it was frozen.
    #>
    param([Parameter(Mandatory)][object]$Plan)

    $declared = $Plan.frozenConfigHash
    $actual = Get-ChaosPlanFingerprint -Plan $Plan
    if ($declared -eq $actual) { return $true }

    Write-ChaosStudyFailure -Title 'The plan changed after it was frozen' -Message @"
This plan declares frozenConfigHash $declared but its current contents hash to $actual.

Consent is bound to a specific plan. Because the contents no longer match, any
consent given for this study refers to something other than what would run, so
execution stops here.
"@ -Remediation 'Re-run chaos-study-scope to produce a fresh, self-consistent plan.'
    exit (Get-ChaosStudyExitCode -Name 'ConfigurationDrift')
}

# -- Consent ---------------------------------------------------------------

function Get-ChaosConsentPhrase {
    <#
    .SYNOPSIS
        The exact phrase the operator must type to authorise injection.

    .DESCRIPTION
        The phrase names the action and the workspace it lands in so it cannot
        be typed without reading it, and carries the plan hash so it cannot be
        reused for a different plan.
    #>
    param([Parameter(Mandatory)][object]$Plan)

    $shortHash = ([string]$Plan.frozenConfigHash).Substring(0, 8)
    return "inject $($Plan.action.name) into $($Plan.workspace.name) $shortHash"
}

function Assert-ChaosConsent {
    <#
    .SYNOPSIS
        Stop unless the operator supplied the exact consent phrase.

    .DESCRIPTION
        Deliberately ignores STARTCHAOS_NONINTERACTIVE. Every other gate in
        this suite can be relaxed for automation; this one cannot, because it
        is the only thing standing between a script and a production incident.
    #>
    param(
        [Parameter(Mandatory)][object]$Plan,
        [AllowNull()][AllowEmptyString()][string]$Consent
    )

    $expected = Get-ChaosConsentPhrase -Plan $Plan
    if ($Consent -and $Consent.Trim() -ceq $expected) { return $true }

    $reason = if ([string]::IsNullOrWhiteSpace($Consent)) {
        'No consent phrase was supplied.'
    } else {
        'The consent phrase did not match this plan exactly (comparison is case-sensitive).'
    }

    $count = $Plan.scope.projectedResourceCount
    $countText = if ($null -eq $count) { 'an unknown number of' } else { "$count" }
    $regionText = if ([string]::IsNullOrWhiteSpace($Plan.scope.region)) { '(not resolved)' } else { [string]$Plan.scope.region }

    Write-ChaosStudyFailure -Title 'Injection not authorised' -Message @"
$reason

This study would run scenario $($Plan.scenario.name) - action $($Plan.action.displayName) -
  workspace   $($Plan.workspace.name) ($($Plan.workspace.resourceGroup))
  region      $regionText
  reaching    $countText scoped resource(s) after filters and exclusions
for $($Plan.windows.injectMinutes) minutes.

To authorise it, pass this phrase exactly:

  $expected
"@ -Remediation "-DryRun:`$false -Consent '$expected'"
    exit (Get-ChaosStudyExitCode -Name 'ConsentDeclined')
}

# -- Scenario configuration ------------------------------------------------

function Get-ChaosStudyConfigurationName {
    <#
    .SYNOPSIS
        Deterministic configuration name derived from the study id.

    .DESCRIPTION
        Deriving it means an interrupted study can find and cancel the
        configuration it created, rather than leaking a resource whose name it
        no longer knows.
    #>
    param([Parameter(Mandatory)][string]$StudyId)
    $suffix = ($StudyId -replace '[^A-Za-z0-9]', '').ToLowerInvariant()
    if ($suffix.Length -gt 40) { $suffix = $suffix.Substring($suffix.Length - 40) }
    return "study-$suffix"
}

function Get-ChaosScenarioParameterList {
    <#
    .SYNOPSIS
        The scenario parameters frozen at scope time, in the {key,value} shape
        `az chaos scenario config create --parameters` expects.

    .DESCRIPTION
        Scope already normalised and sorted these, so this only re-projects
        them after the JSON round-trip through the store. Values are carried as
        strings because that is what the configuration API accepts; anything
        structured is canonically JSON-encoded so the same input always
        produces the same configuration.
    #>
    param([Parameter(Mandatory)][object]$Plan)

    $frozen = $null
    if ($Plan.scenario.PSObject.Properties.Name -contains 'parameters') { $frozen = $Plan.scenario.parameters }
    if ($null -eq $frozen) { return @() }

    $pairs = @()
    foreach ($entry in @($frozen)) {
        if ($null -eq $entry) { continue }
        $key = [string]$entry.key
        if ([string]::IsNullOrWhiteSpace($key)) { continue }
        $value = $entry.value
        $encoded = if ($value -is [string]) {
            $value
        } elseif ($value -is [bool]) {
            $value.ToString().ToLowerInvariant()
        } elseif ($null -ne $value -and $value -isnot [string] -and $value -is [System.Collections.IEnumerable]) {
            ConvertTo-ChaosCanonicalJson -InputObject $value
        } else {
            [string]$value
        }
        $pairs += @{ key = $key; value = $encoded }
    }
    return $pairs
}

function Get-ChaosBlastRadiusArgument {
    <#
    .SYNOPSIS
        Read the plan's frozen blast radius and project it through the canonical
        projection shared with preflight.

    .DESCRIPTION
        The projection itself lives in ConfigurationPayload.ps1 so that preflight
        and execution cannot drift apart - they used to have separate copies, and
        the preflight copy simply omitted the blast radius. This function now does
        only the part that is genuinely plan-specific: finding the blast radius
        inside a plan object.
    #>
    param([Parameter(Mandatory)][object]$Plan)

    $blast = $null
    if ($Plan.scope.PSObject.Properties.Name -contains 'blastRadius') { $blast = $Plan.scope.blastRadius }
    return Get-ChaosBlastRadiusProjection -BlastRadius $blast
}

function New-ChaosStudyConfiguration {
    <#
    .SYNOPSIS
        Create the scenario configuration this study will execute.

    .DESCRIPTION
        The configuration is the frozen plan expressed as a Chaos Studio
        resource: which scenario, with which parameters, constrained by which
        filters and exclusions. Creating it changes nothing in the target
        system - execution is a separate, separately-consented step.

        Structured arguments go through Invoke-ChaosStudyAzChaos -JsonArg, which writes
        them to a temp file. On Windows `az` is a .cmd shim that mangles
        unquoted JSON braces, so passing them inline is not reliable.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][object]$Plan,
        [Parameter(Mandatory)][string]$ConfigurationName,
        [AllowNull()][AllowEmptyString()][string]$Adapter,
        [AllowNull()][AllowEmptyString()][string]$StudyPath
    )

    $cliArgs = Get-ChaosConfigurationScopingArgument -Plan $Plan -ConfigurationName $ConfigurationName

    # One builder, shared with preflight. If the plan froze a preflight digest,
    # refuse to send anything that does not match it: the validation that
    # authorised this run described THAT payload, not a similar one.
    $blast = $null
    if ($Plan.scope.PSObject.Properties.Name -contains 'blastRadius') { $blast = $Plan.scope.blastRadius }
    $jsonArg = Get-ChaosPlanConfigurationBody -Plan $Plan

    $frozenDigest = $null
    if (($Plan.PSObject.Properties.Name -contains 'declaredVsEffective') -and $null -ne $Plan.declaredVsEffective) {
        $dve = $Plan.declaredVsEffective
        if ((@($dve.PSObject.Properties.Name) -contains 'preflight') -and $null -ne $dve.preflight -and
            (@($dve.preflight.PSObject.Properties.Name) -contains 'bodyDigest')) {
            $frozenDigest = [string]$dve.preflight.bodyDigest
        }
    }
    if (-not [string]::IsNullOrWhiteSpace($frozenDigest)) {
        $actualDigest = Get-ChaosConfigurationBodyDigest -Body $jsonArg
        if ($actualDigest -ne $frozenDigest) {
            throw ("The configuration validated at preflight is not the configuration this run would send " +
                "(validated $frozenDigest, now $actualDigest). The preflight result describes a different blast radius, " +
                'so it cannot authorise this run. Re-run chaos-study-scope to revalidate.')
        }
    }

    $created = Invoke-ChaosStudyOperation -Kind 'config.create' -Arguments @{ cliArgs = $cliArgs } `
        -Body $jsonArg `
        -ExpectedSchema 'any.v1' -Adapter (Get-ChaosExecutionAdapter -Plan $Plan -Adapter $Adapter) `
        -StudyPath $StudyPath -OperationHint 'scenario config create'

    if ($null -eq $created) {
        throw "Chaos Studio did not return a scenario configuration for '$ConfigurationName'. The configuration was not created, so nothing was executed."
    }
    return $created
}

function Remove-ChaosStudyConfiguration {
    <#
    .SYNOPSIS
        Delete a scenario configuration, tolerating one that is already gone.

    .DESCRIPTION
        An authoritative not-found means the object is already absent, which is
        the outcome the caller wanted, so it is swallowed. Every other failure
        is rethrown with the service's own message: a delete the service
        rejected must never be recorded as one it accepted, because the residue
        ledger would then report a removal with nothing to explain why the
        object is still present.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][object]$Plan,
        [Parameter(Mandatory)][string]$ConfigurationName,
        [AllowNull()][AllowEmptyString()][string]$Adapter,
        [AllowNull()][AllowEmptyString()][string]$StudyPath
    )

    $cliArgs = (Get-ChaosConfigurationScopingArgument -Plan $Plan -ConfigurationName $ConfigurationName) + @('--yes')
    try {
        return Invoke-ChaosStudyOperation -Kind 'config.delete' -Arguments @{ cliArgs = $cliArgs } `
            -ExpectedSchema 'any.v1' -Adapter (Get-ChaosExecutionAdapter -Plan $Plan -Adapter $Adapter) `
            -StudyPath $StudyPath -OperationHint 'scenario config delete'
    } catch {
        if (Test-ChaosNotFoundError -Text $_.Exception.Message) { return $null }
        throw
    }
}

# -- Validation and permissions --------------------------------------------

function Test-ChaosStudyConfigurationAbsent {
    <#
    .SYNOPSIS
        Read back a scenario configuration to see whether it is actually gone.

    .DESCRIPTION
        Deletion is asynchronous, so the only honest way to say a
        configuration was removed is to look for it and not find it. Returns
        $true for absent, $false for still present, and $null when the read
        itself could not be performed - which the ledger records as
        'verification-unavailable' rather than quietly counting as removed.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][object]$Plan,
        [Parameter(Mandatory)][string]$ConfigurationName,
        [AllowNull()][AllowEmptyString()][string]$Adapter,
        [AllowNull()][AllowEmptyString()][string]$StudyPath
    )

    $cliArgs = Get-ChaosConfigurationScopingArgument -Plan $Plan -ConfigurationName $ConfigurationName
    try {
        Invoke-ChaosStudyOperation -Kind 'config.show' -Arguments @{ cliArgs = $cliArgs } `
            -ExpectedSchema 'any.v1' -Adapter (Get-ChaosExecutionAdapter -Plan $Plan -Adapter $Adapter) `
            -StudyPath $StudyPath -OperationHint 'scenario config show' | Out-Null
    } catch {
        # Only an authoritative not-found proves absence. Anything else - a
        # throttle, an auth failure, a timeout - proves nothing, so it stays
        # $null and the ledger records verification-unavailable.
        if (Test-ChaosNotFoundError -Text $_.Exception.Message) { return $true }
        return $null
    }
    # The read succeeded, so the configuration is still there.
    return $false
}

function Test-ChaosStudyScenarioRunAbsent {
    <#
    .SYNOPSIS
        Read back a scenario run to see whether it has actually stopped.

    .DESCRIPTION
        A run is not a resource that disappears - cancelling it moves it to a
        terminal state. "Absent" here therefore means "no longer executing":
        the run either cannot be found, or reports a terminal status. A run
        still reporting a live state after a cancel is exactly the case that
        must not be printed as cleaned up.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][object]$Plan,
        [Parameter(Mandatory)][string]$RunId,
        [AllowNull()][AllowEmptyString()][string]$Adapter,
        [AllowNull()][AllowEmptyString()][string]$StudyPath
    )

    $run = $null
    try {
        $run = Get-ChaosStudyScenarioRun -Plan $Plan -RunId $RunId -Adapter $Adapter -StudyPath $StudyPath -Strict
    } catch {
        if (Test-ChaosNotFoundError -Text $_.Exception.Message) { return $true }
        return $null
    }
    # The strict read throws on failure and is caught above, so reaching here
    # with $null means the service answered with nothing at all - still not
    # something that can be claimed as absence.
    if ($null -eq $run) { return $null }

    $status = Get-ChaosScenarioRunStatus -Run $run
    if ([string]::IsNullOrWhiteSpace([string]$status)) { return $null }
    return (Test-ChaosScenarioRunTerminal -Status ([string]$status))
}

function Get-ChaosConfigurationValidation {
    <#
    .SYNOPSIS
        Run validation and return the latest validation result.

    .DESCRIPTION
        `validate` is long-running and its own response is sometimes thinner
        than the stored result, so the stored result is read back and preferred.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][object]$Plan,
        [Parameter(Mandatory)][string]$ConfigurationName,
        [AllowNull()][AllowEmptyString()][string]$Adapter,
        [AllowNull()][AllowEmptyString()][string]$StudyPath
    )

    $cliArgs = Get-ChaosConfigurationScopingArgument -Plan $Plan -ConfigurationName $ConfigurationName
    $resolvedAdapter = Get-ChaosExecutionAdapter -Plan $Plan -Adapter $Adapter

    Invoke-ChaosStudyOperation -Kind 'config.validate' -Arguments @{ cliArgs = $cliArgs } `
        -ExpectedSchema 'any.v1' -Adapter $resolvedAdapter -StudyPath $StudyPath `
        -OperationHint 'scenario config validate' | Out-Null

    return Invoke-ChaosStudyOperation -Kind 'config.showValidation' -Arguments @{ cliArgs = $cliArgs } `
        -ExpectedSchema 'any.v1' -Adapter $resolvedAdapter -StudyPath $StudyPath `
        -OperationHint 'scenario config show-validation'
}

function Get-ChaosValidationStatus {
    <#
    .SYNOPSIS
        Read the status out of a validation result, whatever shape it arrives in.
    #>
    param([AllowNull()][object]$Validation)

    if ($null -eq $Validation) { return $null }
    if ($Validation.PSObject.Properties.Name -contains 'properties' -and $null -ne $Validation.properties) {
        if ($Validation.properties.PSObject.Properties.Name -contains 'status') { return [string]$Validation.properties.status }
    }
    if ($Validation.PSObject.Properties.Name -contains 'status') { return [string]$Validation.status }
    return $null
}

function Get-ChaosValidationError {
    <#
    .SYNOPSIS
        Project validation errors into a flat, reportable list.
    #>
    param([AllowNull()][object]$Validation)

    if ($null -eq $Validation) { return @() }
    $container = if ($Validation.PSObject.Properties.Name -contains 'properties' -and $null -ne $Validation.properties) { $Validation.properties } else { $Validation }

    $errors = @()
    foreach ($field in @('validationErrors', 'errors')) {
        if ($container.PSObject.Properties.Name -notcontains $field) { continue }
        foreach ($item in @($container.$field)) {
            if ($null -eq $item) { continue }
            $errors += [ordered]@{
                code     = if ($item.PSObject.Properties.Name -contains 'errorCode') { [string]$item.errorCode } else { $null }
                message  = if ($item.PSObject.Properties.Name -contains 'errorMessage') { [string]$item.errorMessage } else { [string]$item }
                resource = if ($item.PSObject.Properties.Name -contains 'resourceId') { [string]$item.resourceId } else { $null }
            }
        }
    }
    return $errors
}

function Repair-ChaosConfigurationPermission {
    <#
    .SYNOPSIS
        Ask Chaos Studio to grant the workspace identity the roles it says the
        run needs, then report what it did.

    .DESCRIPTION
        The service decides the grants; this only requests and reports them.
        With -WhatIf nothing is created, which is how the caller learns what
        would change before any of it does.

        The result is read back with show-permission-fix because the command
        does not always echo a body of its own.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][object]$Plan,
        [Parameter(Mandatory)][string]$ConfigurationName,
        [switch]$WhatIf,
        [AllowNull()][AllowEmptyString()][string]$Adapter,
        [AllowNull()][AllowEmptyString()][string]$StudyPath
    )

    $scoping = Get-ChaosConfigurationScopingArgument -Plan $Plan -ConfigurationName $ConfigurationName
    $resolvedAdapter = Get-ChaosExecutionAdapter -Plan $Plan -Adapter $Adapter

    $fixArgs = if ($WhatIf) { $scoping + @('--what-if') } else { $scoping }

    Invoke-ChaosStudyOperation -Kind 'config.fixPermissions' -Arguments @{ cliArgs = $fixArgs } `
        -ExpectedSchema 'any.v1' -Adapter $resolvedAdapter -StudyPath $StudyPath `
        -OperationHint $(if ($WhatIf) { 'scenario config fix-permissions --what-if' } else { 'scenario config fix-permissions' }) | Out-Null

    return Invoke-ChaosStudyOperation -Kind 'config.showPermissionFix' -Arguments @{ cliArgs = $scoping } `
        -ExpectedSchema 'any.v1' -Adapter $resolvedAdapter -StudyPath $StudyPath `
        -OperationHint 'scenario config show-permission-fix'
}

function Get-ChaosPermissionFixSummary {
    <#
    .SYNOPSIS
        Project a permission-fix result into a flat, reportable shape.

    .DESCRIPTION
        Counts the service did not report stay null. A fix that reported
        nothing is not the same as a fix that granted nothing, and writing zero
        would put a number in the study record that nobody measured.
    #>
    param([AllowNull()][object]$FixResult)

    if ($null -eq $FixResult) { return $null }

    $container = $FixResult
    if ($FixResult.PSObject.Properties.Name -contains 'properties' -and $null -ne $FixResult.properties) {
        $container = $FixResult.properties
    }

    $summary = $null
    if ($container.PSObject.Properties.Name -contains 'summary') { $summary = $container.summary }
    $hasSummary = ($null -ne $summary)

    return [ordered]@{
        state         = if ($container.PSObject.Properties.Name -contains 'state') { $container.state } else { $null }
        whatIfMode    = if ($container.PSObject.Properties.Name -contains 'whatIfMode') { $container.whatIfMode } else { $null }
        totalRequired = if ($hasSummary -and $summary.PSObject.Properties.Name -contains 'totalRequired') { $summary.totalRequired } else { $null }
        succeeded     = if ($hasSummary -and $summary.PSObject.Properties.Name -contains 'succeeded') { $summary.succeeded } else { $null }
        failed        = if ($hasSummary -and $summary.PSObject.Properties.Name -contains 'failed') { $summary.failed } else { $null }
        skipped       = if ($hasSummary -and $summary.PSObject.Properties.Name -contains 'skipped') { $summary.skipped } else { $null }
    }
}

function Test-ChaosPermissionFixApplicable {
    <#
    .SYNOPSIS
        Decide whether a --what-if preview describes grants worth applying.

    .DESCRIPTION
        Applying changes who can reach the scoped resources, so it happens only
        when the service actually named grants to make. A preview that reports
        nothing - because the call failed, returned no body, or found nothing
        to grant - is not read as permission to widen access. The validation
        gate then refuses the run and says why, which is the honest outcome.
    #>
    param([AllowNull()][object]$FixResult)

    $summary = Get-ChaosPermissionFixSummary -FixResult $FixResult
    if ($null -eq $summary) { return $false }
    if ($null -eq $summary.totalRequired) { return $false }

    $total = 0
    if ([int]::TryParse([string]$summary.totalRequired, [ref]$total)) { return ($total -gt 0) }
    return $false
}

function Format-ChaosPermissionFixSummary {
    <#
    .SYNOPSIS
        Render a permission-fix summary as operator-facing lines.
    #>
    param([AllowNull()][object]$Summary)

    if ($null -eq $Summary) { return '  (the service returned no permission-fix result)' }

    $lines = @()
    foreach ($field in @('state', 'totalRequired', 'succeeded', 'failed', 'skipped')) {
        $value = $Summary.$field
        $text = if ($null -eq $value) { 'not reported' } else { [string]$value }
        $lines += "  - $field`: $text"
    }
    return ($lines -join "`n")
}

function Get-ChaosPermissionGrantDetail {
    <#
    .SYNOPSIS
        Pull the individual grants out of a permission-fix result, when the
        service names them.

    .DESCRIPTION
        The fix-permissions contract guarantees counts, not a list. Some
        responses carry the individual assignments and some do not, so this
        looks for the collection under the property names the service has used
        and returns null - never an empty list - when it finds none. Null means
        "the service did not tell us"; an empty list would claim it told us
        there were none, and those are different facts.
    #>
    param([AllowNull()][object]$FixResult)

    if ($null -eq $FixResult) { return $null }

    $container = $FixResult
    if ($FixResult.PSObject.Properties.Name -contains 'properties' -and $null -ne $FixResult.properties) {
        $container = $FixResult.properties
    }

    foreach ($name in @('permissionAssignments', 'roleAssignments', 'assignments', 'requiredPermissions', 'permissions')) {
        if ($container.PSObject.Properties.Name -contains $name) {
            $value = $container.$name
            if ($null -ne $value) {
                $list = @($value)
                if ($list.Count -gt 0) { return $list }
            }
        }
    }
    return $null
}

function Get-ChaosPermissionGrantSet {
    <#
    .SYNOPSIS
        Normalise a permission-fix preview into the grant set an approval binds
        to, plus a hash of it.

    .DESCRIPTION
        Approval has to name what is being approved, and it has to stop being
        valid the moment that changes. Hashing the normalised grant set gives
        both: the operator sees the roles and scopes, and a preview that later
        widens produces a different hash and therefore needs a fresh approval.

        The hash covers the configuration and workspace as well as the grants,
        so an approval for one study can never be replayed against another.
    #>
    param(
        [Parameter(Mandatory)][object]$Plan,
        [Parameter(Mandatory)][string]$ConfigurationName,
        [AllowNull()][object]$FixResult
    )

    $summary = Get-ChaosPermissionFixSummary -FixResult $FixResult
    $details = Get-ChaosPermissionGrantDetail -FixResult $FixResult

    $roles = $null
    $scopes = $null
    $missingActions = $null
    if ($null -ne $details) {
        $roles = @($details | ForEach-Object {
                foreach ($p in @('roleDefinitionName', 'roleName', 'roleDefinitionId', 'role')) {
                    if ($_.PSObject.Properties.Name -contains $p -and $_.$p) { return [string]$_.$p }
                }
                $null
            } | Where-Object { $_ } | Sort-Object -Unique)
        $scopes = @($details | ForEach-Object {
                foreach ($p in @('scope', 'resourceId', 'targetResourceId')) {
                    if ($_.PSObject.Properties.Name -contains $p -and $_.$p) { return [string]$_.$p }
                }
                $null
            } | Where-Object { $_ } | Sort-Object -Unique)
        $missingActions = @($details | ForEach-Object {
                foreach ($p in @('missingActions', 'actions', 'action')) {
                    if ($_.PSObject.Properties.Name -contains $p -and $_.$p) { return @($_.$p) }
                }
                @()
            } | ForEach-Object { $_ } | Where-Object { $_ } | Sort-Object -Unique)
        if ($roles.Count -eq 0) { $roles = $null }
        if ($scopes.Count -eq 0) { $scopes = $null }
        if ($null -eq $missingActions -or $missingActions.Count -eq 0) { $missingActions = $null }
    }

    $grantSet = [ordered]@{
        workspace         = [string]$Plan.workspace.name
        resourceGroup     = [string]$Plan.workspace.resourceGroup
        configurationName = $ConfigurationName
        workspacePrincipal = if ($Plan.workspace.PSObject.Properties.Name -contains 'principalId') { $Plan.workspace.principalId } else { $null }
        totalRequired     = if ($null -eq $summary) { $null } else { $summary.totalRequired }
        recommendedRoles  = $roles
        scopes            = $scopes
        missingActions    = $missingActions
    }

    $hash = Get-ChaosDigest -InputObject $grantSet
    return [pscustomobject]@{
        grantSet = $grantSet
        hash     = $hash
        details  = $details
    }
}

function Get-ChaosPermissionApprovalPhrase {
    <#
    .SYNOPSIS
        The exact phrase that approves widening RBAC for this study.

    .DESCRIPTION
        Deliberately different in shape from the injection phrase. Approving a
        role assignment and approving a fault are different decisions with
        different blast radii - one outlives the study - so neither phrase can
        be mistaken for, or satisfy, the other. It carries the grant-set hash so
        approving a smaller set never authorises a larger one.
    #>
    param(
        [Parameter(Mandatory)][object]$Plan,
        [Parameter(Mandatory)][string]$GrantSetHash
    )

    $shortGrant = ([string]$GrantSetHash).Substring(0, 8)
    return "grant access on $($Plan.workspace.name) $shortGrant"
}

function Test-ChaosPermissionApproval {
    <#
    .SYNOPSIS
        Whether the operator supplied the exact approval phrase for this grant
        set. Case-sensitive, like every other consent in this suite.
    #>
    param(
        [Parameter(Mandatory)][object]$Plan,
        [Parameter(Mandatory)][string]$GrantSetHash,
        [AllowNull()][AllowEmptyString()][string]$Approval
    )

    if ([string]::IsNullOrWhiteSpace($Approval)) { return $false }
    $expected = Get-ChaosPermissionApprovalPhrase -Plan $Plan -GrantSetHash $GrantSetHash
    return ($Approval.Trim() -ceq $expected)
}

function Get-ChaosRoleAssignmentSnapshot {
    <#
    .SYNOPSIS
        A read-only snapshot of the role assignments on a scope.

    .DESCRIPTION
        Taken either side of a repair so the study can report the assignments it
        actually created rather than the count the service was asked for. Read
        failures are not fatal and are not silently treated as "no assignments":
        the snapshot returns null, and a null on either side means the delta is
        unknown rather than empty.
    #>
    param(
        [Parameter(Mandatory)][string]$Scope,
        [AllowNull()][AllowEmptyString()][string]$Adapter,
        [AllowNull()][AllowEmptyString()][string]$StudyPath
    )

    if ([string]::IsNullOrWhiteSpace($Scope)) { return $null }

    try {
        $response = Invoke-ChaosStudyOperation -Kind 'roleAssignments.list' -Arguments @{ scope = $Scope } `
            -ExpectedSchema 'any.v1' -Adapter $Adapter -StudyPath $StudyPath `
            -OperationHint 'role assignment list'
    } catch {
        return $null
    }

    if ($null -eq $response) { return $null }
    $body = if ($response.PSObject.Properties.Name -contains 'body') { $response.body } else { $response }
    if ($null -eq $body) { return $null }
    if ($body.PSObject.Properties.Name -contains 'value') { return @($body.value) }
    return @($body)
}

function Get-ChaosRoleAssignmentDelta {
    <#
    .SYNOPSIS
        The assignments present after a repair that were not present before.

    .DESCRIPTION
        Returns null when either snapshot is unknown. A repair whose effect
        could not be observed must not be reported as having granted nothing -
        that is the difference between "we checked and it was clean" and "we
        could not check", and only one of those is safe to act on.
    #>
    param(
        [AllowNull()][object]$Before,
        [AllowNull()][object]$After
    )

    if ($null -eq $Before -or $null -eq $After) { return $null }

    $beforeIds = @{}
    foreach ($item in @($Before)) {
        if ($null -ne $item -and $item.PSObject.Properties.Name -contains 'id' -and $item.id) { $beforeIds[[string]$item.id] = $true }
    }

    $new = @()
    foreach ($item in @($After)) {
        if ($null -eq $item) { continue }
        if (-not ($item.PSObject.Properties.Name -contains 'id') -or -not $item.id) { continue }
        if (-not $beforeIds.ContainsKey([string]$item.id)) { $new += $item }
    }
    return @($new)
}

function Resolve-ChaosConfigurationValidation {
    <#
    .SYNOPSIS
        Validate a scenario configuration and, when it fails for want of access,
        preview the grants it needs - applying them only under a separate,
        grant-bound approval.

    .DESCRIPTION
        Validation always runs, and it runs before any evidence is collected or
        anything is injected, because a configuration that cannot validate is a
        run that will fail in seconds - and finding that out after a baseline
        window has already elapsed wastes the window and the operator's time.

        Widening RBAC is not part of approving a fault. An injection ends when
        the run ends; a role assignment does not, and it changes who can reach
        the scoped resources long after this study is forgotten. So the two
        decisions are separated: this function previews with --what-if and, if
        grants are needed, returns approvalRequired without changing anything.
        The caller surfaces the exact approval phrase and stops. Only a
        subsequent call carrying that phrase applies the grants.

        When grants are applied, role assignments are snapshotted either side of
        the repair so the study records what was actually created rather than
        what the service was asked to create, and each new assignment is written
        to the residue ledger with the command that removes it.

        This does not decide whether to execute. Assert-ChaosConfigurationValidated
        is the gate, and Start-ChaosStudyScenarioRun applies it again.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][object]$Plan,
        [Parameter(Mandatory)][string]$ConfigurationName,
        [AllowNull()][AllowEmptyString()][string]$Adapter,
        [AllowNull()][AllowEmptyString()][string]$StudyPath,
        [AllowNull()][AllowEmptyString()][string]$PermissionApproval
    )

    $validation = Get-ChaosConfigurationValidation -Plan $Plan -ConfigurationName $ConfigurationName -Adapter $Adapter -StudyPath $StudyPath
    $status = Get-ChaosValidationStatus -Validation $validation

    if ($status -eq 'Succeeded') {
        return [pscustomobject]@{
            validation       = $validation
            status           = $status
            permissionFix    = $null
            approvalRequired = $false
            approvalPhrase   = $null
            grantSet         = $null
        }
    }

    $statusText = if ($status) { $status } else { 'no status' }
    $before = [ordered]@{
        status = $status
        errors = @(Get-ChaosValidationError -Validation $validation)
    }

    Write-ChaosStudyNote -Message "Validation reported '$statusText'. Asking Chaos Studio which role assignments are missing." -Level 'warn'

    $preview = Repair-ChaosConfigurationPermission -Plan $Plan -ConfigurationName $ConfigurationName -WhatIf -Adapter $Adapter -StudyPath $StudyPath
    $previewSummary = Get-ChaosPermissionFixSummary -FixResult $preview
    $applicable = Test-ChaosPermissionFixApplicable -FixResult $preview
    $grant = Get-ChaosPermissionGrantSet -Plan $Plan -ConfigurationName $ConfigurationName -FixResult $preview

    $permissionFix = [ordered]@{
        attempted        = $true
        applicable       = [bool]$applicable
        preview          = $previewSummary
        grantSet         = $grant.grantSet
        grantSetHash     = $grant.hash
        grantDetails     = $grant.details
        approved         = $false
        approvalPhrase   = $null
        applied          = $null
        grantsObserved   = $null
        validationBefore = $before
        validationAfter  = $null
    }

    if (-not $applicable) {
        # The service named nothing to grant. Widening access on the strength of
        # a result that reported nothing would be inventing a reason to change
        # RBAC, so nothing happens and the gate below refuses the run.
        Write-ChaosStudyCard -Title 'Validation failed and no grants were named' -Body @"
Validation reported '$statusText'. Chaos Studio was asked which role assignments
are missing and named none, so nothing has been changed.

$(Format-ChaosPermissionFixSummary -Summary $previewSummary)

The validation gate will refuse this run.
"@
        $permissionFix.validationAfter = $before
        return [pscustomobject]@{
            validation       = $validation
            status           = $status
            permissionFix    = $permissionFix
            approvalRequired = $false
            approvalPhrase   = $null
            grantSet         = $grant.grantSet
        }
    }

    $phrase = Get-ChaosPermissionApprovalPhrase -Plan $Plan -GrantSetHash $grant.hash
    $permissionFix.approvalPhrase = $phrase

    if (-not (Test-ChaosPermissionApproval -Plan $Plan -GrantSetHash $grant.hash -Approval $PermissionApproval)) {
        # Not approved. Nothing is granted, and the caller decides how to stop.
        $permissionFix.validationAfter = $before
        return [pscustomobject]@{
            validation       = $validation
            status           = $status
            permissionFix    = $permissionFix
            approvalRequired = $true
            approvalPhrase   = $phrase
            grantSet         = $grant.grantSet
        }
    }

    Write-ChaosStudyNote -Message 'Permission approval accepted. Applying the role assignments Chaos Studio reported as missing.' -Level 'warn'

    $scope = if ($Plan.workspace.PSObject.Properties.Name -contains 'id') { [string]$Plan.workspace.id } else { $null }
    $beforeAssignments = Get-ChaosRoleAssignmentSnapshot -Scope $scope -Adapter $Adapter -StudyPath $StudyPath

    $applied = Repair-ChaosConfigurationPermission -Plan $Plan -ConfigurationName $ConfigurationName -Adapter $Adapter -StudyPath $StudyPath
    $appliedSummary = Get-ChaosPermissionFixSummary -FixResult $applied
    $permissionFix.approved = $true
    $permissionFix.applied = $appliedSummary

    if ($null -ne $appliedSummary) {
        if ($appliedSummary.whatIfMode -eq $true) {
            # The fix was requested without --what-if, so this means the service
            # previewed instead of acting and nothing was granted.
            Write-ChaosStudyNote -Message 'Chaos Studio reported whatIfMode on an applied fix, so no role assignments were actually created.' -Level 'warn'
        }
        $failedCount = 0
        if ($null -ne $appliedSummary.failed -and [int]::TryParse([string]$appliedSummary.failed, [ref]$failedCount) -and $failedCount -gt 0) {
            Write-ChaosStudyNote -Message "$failedCount role assignment(s) could not be created; the workspace identity may lack roleAssignments/write on the scope." -Level 'warn'
        }
    }

    $afterAssignments = Get-ChaosRoleAssignmentSnapshot -Scope $scope -Adapter $Adapter -StudyPath $StudyPath
    $created = Get-ChaosRoleAssignmentDelta -Before $beforeAssignments -After $afterAssignments
    # A null element here would become a grant we claim to have created but cannot
    # name - the residue ledger must never carry an entry it cannot point at.
    if ($null -ne $created) { $created = @($created | Where-Object { $null -ne $_ }) }
    $permissionFix.grantsObserved = if ($null -eq $created) { $null } else { @($created | ForEach-Object { [string]$_.id }) }

    if ($null -ne $created -and -not [string]::IsNullOrWhiteSpace($StudyPath)) {
        foreach ($assignment in @($created)) {
            $props = if ($assignment.PSObject.Properties.Name -contains 'properties') { $assignment.properties } else { $assignment }
            Add-ChaosRoleAssignmentResidueEntry -StudyPath $StudyPath -AssignmentId ([string]$assignment.id) `
                -RoleDefinitionId $(if ($props -and $props.PSObject.Properties.Name -contains 'roleDefinitionId') { [string]$props.roleDefinitionId } else { $null }) `
                -PrincipalId $(if ($props -and $props.PSObject.Properties.Name -contains 'principalId') { [string]$props.principalId } else { $null }) `
                -Scope $scope -Adapter $Adapter -ApprovalPhrase $phrase | Out-Null
        }
    }

    # Re-validation is a read. If RBAC has not propagated yet this reports a
    # failure and the gate refuses the run - which is correct. Retrying the read
    # is safe; retrying the grant would create duplicate assignments to work
    # around a delay that is not this study's to fix.
    Write-ChaosStudyNote -Message 'Re-validating the configuration after the permission repair.'
    $validation = Get-ChaosConfigurationValidation -Plan $Plan -ConfigurationName $ConfigurationName -Adapter $Adapter -StudyPath $StudyPath
    $status = Get-ChaosValidationStatus -Validation $validation

    $permissionFix.validationAfter = [ordered]@{
        status = $status
        errors = @(Get-ChaosValidationError -Validation $validation)
    }

    return [pscustomobject]@{
        validation       = $validation
        status           = $status
        permissionFix    = $permissionFix
        approvalRequired = $false
        approvalPhrase   = $phrase
        grantSet         = $grant.grantSet
    }
}

function Assert-ChaosConfigurationValidated {
    <#
    .SYNOPSIS
        Refuse to execute a configuration that did not validate cleanly.

    .DESCRIPTION
        This is a hard gate, not a warning. A configuration in any state other
        than Succeeded produces a run that fails in seconds with an error that
        names neither the resource nor the missing permission, which is far
        harder to diagnose than a refusal here.

        By the time this runs, Resolve-ChaosConfigurationValidation has already
        previewed and applied whatever grants the service reported as missing.
        So reaching this gate means repair was either impossible or
        insufficient, and the remediation says so rather than suggesting a
        switch that would repeat what already happened.
    #>
    param(
        [AllowNull()][object]$Validation,
        [Parameter(Mandatory)][string]$ConfigurationName
    )

    $status = Get-ChaosValidationStatus -Validation $Validation
    if ($status -eq 'Succeeded') { return $true }

    $errors = @(Get-ChaosValidationError -Validation $Validation)
    $detail = if ($errors.Count -gt 0) {
        ($errors | ForEach-Object {
            $where = if ($_.resource) { " on $($_.resource)" } else { '' }
            "  - $($_.code)$where`: $($_.message)"
        }) -join "`n"
    } else {
        '  (the service reported no error detail)'
    }

    $looksLikePermissions = @($errors | Where-Object {
        "$($_.code) $($_.message)" -match '(?i)(permission|authoriz|forbidden|rbac|roleassignment)'
    }).Count -gt 0

    $remediation = if ($looksLikePermissions) {
        'Chaos Studio already previewed and applied the grants it reported as missing, and validation still failed. Role assignments can take a few minutes to propagate, so retrying often succeeds; if it does not, grant the workspace identity the roles named above manually, or ask someone with User Access Administrator on the scope to run az chaos scenario config fix-permissions.'
    } else {
        'Re-run chaos-study-scope against a scope the workspace can actually reach, then plan again.'
    }

    Write-ChaosStudyFailure -Title 'Scenario configuration did not validate' -Message @"
Configuration '$ConfigurationName' validated as $(if ($status) { $status } else { 'an unreported status' }).

$detail

Chaos Studio validates a configuration against the live scope and the workspace
identity's permissions. Executing an unvalidated configuration produces a run
that fails within seconds without naming the cause, so this study stops here
instead.
"@ -Remediation $remediation
    exit (Get-ChaosStudyExitCode -Name 'ValidationFailed')
}

# -- Preflight reuse + effective-plan equality (Req C) ---------------------
#
# Scope validated a deterministic preflight configuration and froze the exact
# effective plan (which legs run) into the study plan. A run must either reuse
# that same validated configuration, or - if it has to re-create one - prove the
# re-created configuration's effective plan is identical before it may start.
# Either way, what executes is provably what was scoped and consented to, not a
# configuration that quietly drifted between scope and run.

function Get-ChaosRunEffectivePlanHash {
    <#
    .SYNOPSIS
        Recompute the effective-plan hash for a validation result.

    .DESCRIPTION
        This used to be a run-side MIRROR of the scope projection, and it
        carried a documented limitation: it could not expand shapes the scope
        side could, so a plan that actually matched could fail the equality
        gate. There is no mirror any more. Scope and run both call
        Get-ChaosEffectivePlanHash in chaos-study/scripts/lib/ExecutionPlan.ps1,
        so the two hashes cannot drift by construction.
    #>
    param(
        [AllowNull()][object]$Validation,
        [AllowNull()][object]$ConfigurationBody
    )
    return Get-ChaosEffectivePlanHash -ExecutionPlan $Validation -ConfigurationBody $ConfigurationBody
}

function Assert-ChaosEffectivePlanEquality {
    <#
    .SYNOPSIS
        Refuse to run a re-created configuration whose effective plan differs
        from the one scope froze and the operator consented to.
    #>
    param(
        [AllowNull()][AllowEmptyString()][string]$Expected,
        [AllowNull()][AllowEmptyString()][string]$Actual,
        [Parameter(Mandatory)][string]$ConfigurationName
    )

    # Fail closed on an absent hash on either side: a missing hash is not proof
    # of equality, and two empty strings must never pass this gate vacuously.
    if ([string]::IsNullOrWhiteSpace($Expected) -or [string]::IsNullOrWhiteSpace($Actual)) {
        Write-ChaosStudyFailure -Title 'The effective-plan equality proof is missing a hash' -Message @"
Proving the re-created configuration '$ConfigurationName' matches the scoped plan
requires both the frozen effective-plan hash and the one recomputed for this run,
but at least one is empty. Without both, equality cannot be proven, so the run
stops rather than proceeding on an unverified plan.
"@ -Remediation 'Re-run chaos-study-scope to produce a plan that carries a frozen effective-plan hash, then run against that plan.'
        exit (Get-ChaosStudyExitCode -Name 'ScopeUnverified')
    }

    if ($Expected -eq $Actual) { return $true }

    # A hash frozen by an older suite covered a NARROWER description of the plan
    # (leg counts and selectors, without the action identities, fault parameters
    # or configured duration). Reinterpreting it against today's projection would
    # re-use consent that was never given for what the hash now covers, so an
    # out-of-version hash is refused outright rather than migrated.
    if (-not (Test-ChaosEffectivePlanHashCurrent -Hash $Expected)) {
        Write-ChaosStudyFailure -Title 'The frozen effective-plan hash predates this suite''s plan model' -Message @"
The plan carries an effective-plan hash ($Expected) produced by an earlier
version of the effective-plan projection. That older hash did not cover the
action identities, the fault parameters or the actual configured duration, so it
cannot prove that configuration '$ConfigurationName' is what you consented to.

The hash is not migrated, because migrating it would silently re-use consent
given for a different, narrower description of the plan.
"@ -Remediation 'Re-run chaos-study-scope to re-scope this study, review the refreshed plan, and consent to it again before running.'
        exit (Get-ChaosStudyExitCode -Name 'ScopeUnverified')
    }

    Write-ChaosStudyFailure -Title 'The re-created configuration does not match the scoped plan' -Message @"
Scope froze an effective plan hashing to $Expected, but the configuration
'$ConfigurationName' re-created for this run has an effective plan hashing to
$Actual.

Consent is bound to the legs scope validated. Because a different set of legs
would now run, executing this configuration would inject something other than
what was scoped and consented to, so the run stops here.
"@ -Remediation 'Re-run chaos-study-scope to produce a fresh plan whose effective legs match the scope you intend to run, then consent to that plan.'
    exit (Get-ChaosStudyExitCode -Name 'ScopeUnverified')
}

function Resolve-ChaosRunConfiguration {
    <#
    .SYNOPSIS
        Provide a validated configuration to run: reuse the exact validated
        preflight configuration when it still matches, otherwise re-create one
        and prove its effective plan equals the scoped one before validating it.

    .DESCRIPTION
        Reuse is preferred because the preflight configuration is the one scope
        actually validated; reusing it removes any chance of drift between scope
        and run. Reuse is allowed only when the preflight configuration still
        validates Succeeded and its effective plan still hashes to the frozen
        value. Otherwise the run re-creates its own configuration, asserts exact
        effective-plan equality against the frozen hash, and revalidates before
        returning. When the plan carries no frozen effective plan (e.g. discovery
        was skipped at scope time) this falls back to the historical create +
        validate path unchanged.

        Returns { configurationName; validation; status; permissionFix; reused;
        approvalRequired; approvalPhrase; grantSet }.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][object]$Plan,
        [Parameter(Mandatory)][string]$ConfigurationName,
        [AllowNull()][AllowEmptyString()][string]$Adapter,
        [AllowNull()][AllowEmptyString()][string]$StudyPath,
        [AllowNull()][AllowEmptyString()][string]$PermissionApproval
    )

    $dve = $null
    if (($Plan.PSObject.Properties.Name -contains 'declaredVsEffective') -and $null -ne $Plan.declaredVsEffective) {
        $dve = $Plan.declaredVsEffective
    }
    $frozenHash = if ($dve -and ($dve.PSObject.Properties.Name -contains 'effectivePlanHash')) { [string]$dve.effectivePlanHash } else { $null }
    $preflightName = if ($dve -and $dve.preflight -and ($dve.preflight.PSObject.Properties.Name -contains 'configurationName')) { [string]$dve.preflight.configurationName } else { $null }

    # Refuse an out-of-version frozen hash BEFORE creating anything. Falling
    # through would create a configuration only to refuse it a moment later,
    # leaving residue behind for a plan that was never runnable.
    if (-not [string]::IsNullOrWhiteSpace($frozenHash)) {
        Assert-ChaosEffectivePlanEquality -Expected $frozenHash -Actual $frozenHash -ConfigurationName $ConfigurationName | Out-Null
    }

    # One body for what the run sends and what the hash covers.
    $configurationBody = Get-ChaosPlanConfigurationBody -Plan $Plan

    # 1. Reuse the exact validated preflight configuration when it still holds.
    if (-not [string]::IsNullOrWhiteSpace($preflightName) -and -not [string]::IsNullOrWhiteSpace($frozenHash)) {
        $preflightValidation = Get-ChaosConfigurationValidation -Plan $Plan -ConfigurationName $preflightName -Adapter $Adapter -StudyPath $StudyPath
        $preflightStatus = Get-ChaosValidationStatus -Validation $preflightValidation
        if ($preflightStatus -eq 'Succeeded') {
            $preflightHash = Get-ChaosRunEffectivePlanHash -Validation $preflightValidation -ConfigurationBody $configurationBody
            if ($preflightHash -eq $frozenHash) {
                Write-ChaosStudyNote -Message "Reusing the validated preflight configuration $preflightName; its effective plan still matches the scoped one."
                return [pscustomobject]@{
                    configurationName = $preflightName
                    validation        = $preflightValidation
                    status            = $preflightStatus
                    permissionFix     = $null
                    reused            = $true
                    approvalRequired  = $false
                    approvalPhrase    = $null
                    grantSet          = $null
                }
            }
            Write-ChaosStudyNote -Message "The preflight configuration $preflightName no longer matches the scoped effective plan; re-creating a fresh configuration." -Level 'warn'
        }
        else {
            Write-ChaosStudyNote -Message "The preflight configuration $preflightName is not reusable (validation '$preflightStatus'); re-creating a fresh configuration." -Level 'warn'
        }
    }

    # 2. Re-create, prove effective-plan equality when a plan was frozen, then return.
    New-ChaosStudyConfiguration -Plan $Plan -ConfigurationName $ConfigurationName -Adapter $Adapter -StudyPath $StudyPath | Out-Null
    $resolved = Resolve-ChaosConfigurationValidation -Plan $Plan -ConfigurationName $ConfigurationName -Adapter $Adapter -StudyPath $StudyPath -PermissionApproval $PermissionApproval

    if ($resolved.approvalRequired) {
        # Grants are needed and have not been approved. Return before proving
        # effective-plan equality: the configuration validated for want of access,
        # so its effective plan is not evidence of drift and reporting it as such
        # would bury the real reason under a misleading one.
        return [pscustomobject]@{
            configurationName = $ConfigurationName
            validation        = $resolved.validation
            status            = $resolved.status
            permissionFix     = $resolved.permissionFix
            reused            = $false
            approvalRequired  = $true
            approvalPhrase    = $resolved.approvalPhrase
            grantSet          = $resolved.grantSet
        }
    }

    if (-not [string]::IsNullOrWhiteSpace($frozenHash)) {
        # $resolved.validation is the object equality is proved over. Equality is
        # proved here - rather than after a re-fetch - so the returned plan is
        # identical to the one the proof covered, and to avoid a redundant
        # validate/show round-trip on every re-created run. When no plan was frozen
        # (discovery skipped at scope time) this proof is skipped and the historical
        # create + validate result is returned unchanged.
        $actualHash = Get-ChaosRunEffectivePlanHash -Validation $resolved.validation -ConfigurationBody $configurationBody
        Assert-ChaosEffectivePlanEquality -Expected $frozenHash -Actual $actualHash -ConfigurationName $ConfigurationName | Out-Null
    }

    return [pscustomobject]@{
        configurationName = $ConfigurationName
        validation        = $resolved.validation
        status            = $resolved.status
        permissionFix     = $resolved.permissionFix
        reused            = $false
        approvalRequired  = $false
        approvalPhrase    = $resolved.approvalPhrase
        grantSet          = $resolved.grantSet
    }
}

# -- Scenario run ----------------------------------------------------------

function Get-ChaosStudyRunScopeArguments {
    <#
    .SYNOPSIS
        The identity arguments every run-lifecycle call shares, including the
        subscription.

    .DESCRIPTION
        The configuration calls already pin the subscription (see
        Get-ChaosConfigurationScopingArgument). The run calls did not, so
        polling and - more seriously - cancelling were addressed to whatever
        subscription `az` happened to have selected. `run cancel` is the abort
        path for a live fault, so resolving it against ambient context is the
        one place where a wrong default is most expensive.

        Emitting the subscription only when the plan carries one keeps this
        backward compatible with plans written before the field existed.
    #>
    param([Parameter(Mandatory)][object]$Plan)

    $arguments = @{
        resourceGroup = $Plan.workspace.resourceGroup
        workspaceName = $Plan.workspace.name
        scenarioName  = $Plan.scenario.name
    }
    if (@($Plan.workspace.PSObject.Properties.Name) -contains 'subscriptionId') {
        $subscriptionId = [string]$Plan.workspace.subscriptionId
        if (-not [string]::IsNullOrWhiteSpace($subscriptionId)) {
            $arguments['subscriptionId'] = $subscriptionId
        }
    }
    return $arguments
}

function ConvertTo-ChaosScenarioRunSummary {
    <#
    .SYNOPSIS
        Reduce one run object from `scenario run list` to the fields used to
        identify it, without inventing any of them.

    .DESCRIPTION
        A field that cannot be read stays $null. That matters for the
        configuration name: an unreadable name must not be treated as "not my
        run" (which would drop the real run) nor as "my run" (which would adopt
        someone else's). The caller keeps unknown-configuration runs as weaker
        candidates and refuses to choose when that is all it has.
    #>
    param([Parameter(Mandatory)][AllowNull()][object]$Run)

    if ($null -eq $Run) { return $null }

    $names = @($Run.PSObject.Properties.Name)
    $id = if ($names -contains 'id') { [string]$Run.id } else { $null }
    $name = if ($names -contains 'name') { [string]$Run.name } else { $null }
    if ([string]::IsNullOrWhiteSpace($name) -and -not [string]::IsNullOrWhiteSpace($id) -and $id -match '/runs/([^/?]+)') {
        $name = $Matches[1]
    }

    $properties = if ($names -contains 'properties') { $Run.properties } else { $null }
    $propertyNames = if ($null -ne $properties) { @($properties.PSObject.Properties.Name) } else { @() }

    $configurationName = $null
    foreach ($candidate in @('configurationName', 'configName', 'experimentConfigurationName')) {
        if ($names -contains $candidate -and -not [string]::IsNullOrWhiteSpace([string]$Run.$candidate)) {
            $configurationName = [string]$Run.$candidate
            break
        }
        if ($propertyNames -contains $candidate -and -not [string]::IsNullOrWhiteSpace([string]$properties.$candidate)) {
            $configurationName = [string]$properties.$candidate
            break
        }
    }

    $createdAt = $null
    foreach ($candidate in @('createdDateUtc', 'createdAt', 'startedAt', 'startDateTime', 'statusUpdatedAt')) {
        if ($names -contains $candidate -and -not [string]::IsNullOrWhiteSpace([string]$Run.$candidate)) {
            $createdAt = [string]$Run.$candidate
            break
        }
        if ($propertyNames -contains $candidate -and -not [string]::IsNullOrWhiteSpace([string]$properties.$candidate)) {
            $createdAt = [string]$properties.$candidate
            break
        }
    }

    if ([string]::IsNullOrWhiteSpace($name) -and [string]::IsNullOrWhiteSpace($id)) { return $null }

    return [pscustomobject]@{
        id                = $id
        name              = $name
        configurationName = $configurationName
        createdAtUtc      = $createdAt
    }
}

function Get-ChaosScenarioRunInventory {
    <#
    .SYNOPSIS
        Enumerate the scenario's runs, reporting readability separately from
        emptiness.

    .DESCRIPTION
        `available = $false` means the list could not be read. `available =
        $true` with an empty set means the service reported no runs. Those are
        different facts and the caller acts differently on each, so they are
        never collapsed into one empty array.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][object]$Plan,
        [AllowNull()][AllowEmptyString()][string]$Adapter,
        [AllowNull()][AllowEmptyString()][string]$StudyPath
    )

    $raw = $null
    try {
        $raw = Invoke-ChaosStudyOperation -Kind 'run.list' -Arguments (Get-ChaosStudyRunScopeArguments -Plan $Plan) `
            -ExpectedSchema 'any.v1' -Adapter (Get-ChaosExecutionAdapter -Plan $Plan -Adapter $Adapter) `
            -StudyPath $StudyPath -OperationHint 'scenario run list'
    } catch {
        return [pscustomobject]@{ available = $false; runs = @(); error = $_.Exception.Message }
    }

    if ($null -eq $raw) {
        return [pscustomobject]@{ available = $false; runs = @(); error = 'scenario run list returned no readable result' }
    }

    $items = $null
    if ($raw -is [System.Collections.IEnumerable] -and -not ($raw -is [string])) {
        $items = ConvertTo-ChaosList $raw
    } elseif (@($raw.PSObject.Properties.Name) -contains 'value') {
        $items = ConvertTo-ChaosList $raw.value
    } else {
        $items = ConvertTo-ChaosList $raw
    }

    $runs = [System.Collections.Generic.List[object]]::new()
    foreach ($item in $items) {
        $summary = ConvertTo-ChaosScenarioRunSummary -Run $item
        if ($null -ne $summary) { $runs.Add($summary) | Out-Null }
    }

    return [pscustomobject]@{ available = $true; runs = $runs.ToArray(); error = $null }
}

function Resolve-ChaosStartedScenarioRun {
    <#
    .SYNOPSIS
        Identify the run a just-accepted start created, or report honestly that
        it could not be identified.

    .DESCRIPTION
        This never picks "the latest run", and never picks a run merely because
        it was the only candidate. Two studies can be running against one
        scenario - against one *configuration*, even - so adopting a run on
        circumstantial grounds would attach polling, abort monitoring,
        cancellation and the absence probe to somebody else's fault.

        Enumeration is inherently weak evidence, because a run list is eventually
        consistent: if another caller starts a run on the same configuration in
        the same seconds, the list can surface THEIR run before ours. Set
        difference plus an exact configuration match plus a candidate count of
        one still describes that case exactly. So a count of one is not, on its
        own, permission to claim the run.

        Enumeration may therefore only bind when the configuration is
        demonstrably exclusive to this execution - the study created it under its
        own study-scoped name during this run (ConfigurationExclusive) and the
        pre-start enumeration showed no run on it. A shared or pre-existing
        configuration can never be bound this way, however clean the picture
        looks.

        Positive service correlation - the start response carrying the run
        identity - is the only strong evidence, and it is resolved by the caller
        before this function is ever reached.

        Anything less is accepted-untracked. That is deliberately the unhelpful
        answer: the run is live either way, so the caller must keep the
        configuration, warn, and refuse to claim the fault ended.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][AllowNull()][object]$Before,
        [Parameter(Mandatory)][AllowNull()][object]$After,
        [Parameter(Mandatory)][string]$ConfigurationName,
        # True only when this execution created the configuration under its own
        # study-scoped name. Defaults to false so that a caller which cannot
        # establish exclusivity gets the safe answer rather than the useful one.
        [bool]$ConfigurationExclusive = $false
    )

    $empty = {
        param($Reason, $Candidates)
        return @{ runId = $null; tracked = $false; resolution = 'unidentified'; reason = $Reason; candidates = (ConvertTo-ChaosList $Candidates) }
    }

    if ($null -eq $After -or -not $After.available) {
        return (& $empty 'enumeration-unavailable' @())
    }

    $afterRuns = ConvertTo-ChaosList $After.runs

    # Prefer the set difference. A run that already existed before the start is
    # by definition not the run this start created.
    $candidates = $afterRuns
    $baselineUsable = ($null -ne $Before -and $Before.available)
    if ($baselineUsable) {
        $known = @{}
        foreach ($run in (ConvertTo-ChaosList $Before.runs)) {
            $key = if (-not [string]::IsNullOrWhiteSpace($run.name)) { $run.name } else { $run.id }
            if (-not [string]::IsNullOrWhiteSpace($key)) { $known[$key] = $true }
        }
        $candidates = @($afterRuns | Where-Object {
                $key = if (-not [string]::IsNullOrWhiteSpace($_.name)) { $_.name } else { $_.id }
                -not $known.ContainsKey($key)
            })
    }

    # Without a baseline there is no set difference, and without a set difference
    # a run bearing this configuration name is just as likely to be an earlier
    # study's run on the same configuration as it is to be the one this start
    # created. Being the only candidate is not evidence of anything. Since the
    # id is used to poll and to CANCEL, a plausible guess is worse than no id.
    if (-not $baselineUsable) {
        return (& $empty 'enumeration-unavailable' $afterRuns)
    }

    if ($candidates.Count -eq 0) {
        return (& $empty 'no-new-run-observed' @())
    }

    # Binding needs the configuration name as well as the set difference. A new
    # run whose configuration the service did not report, or reported as some
    # other configuration, cannot be proven to be ours: another caller starting
    # a run on this scenario in the same seconds produces exactly that picture.
    # Adopting it would aim polling, abort monitoring and cancel at somebody
    # else's fault.
    $configMatched = @($candidates | Where-Object { $_.configurationName -eq $ConfigurationName })

    if ($configMatched.Count -gt 1) {
        # Two new runs on our own configuration. Exact config match is not proof
        # against a concurrent start on that same configuration.
        return (& $empty 'ambiguous' $configMatched)
    }
    if ($configMatched.Count -eq 0) {
        return (& $empty 'ambiguous' $candidates)
    }

    # Exactly one new run bearing our configuration name. That is still not
    # ownership: run lists are eventually consistent, so a concurrent caller's
    # run can appear while ours has not yet surfaced, producing this same
    # picture. The only thing that narrows it is exclusivity of the
    # configuration itself.
    if (-not $ConfigurationExclusive) {
        return (& $empty 'configuration-not-exclusive' $configMatched)
    }

    # Exclusivity is claimed, so verify it rather than trusting it. A run already
    # sitting on this configuration before the start means the configuration is
    # being used by someone else, which disproves the claim outright.
    $priorOnConfiguration = @((ConvertTo-ChaosList $Before.runs) | Where-Object { $_.configurationName -eq $ConfigurationName })
    if ($priorOnConfiguration.Count -gt 0) {
        return (& $empty 'configuration-not-exclusive' $configMatched)
    }

    return @{ runId = [string]$configMatched[0].name; tracked = $true; resolution = 'enumerated'; reason = $null; candidates = $configMatched }
}

function Start-ChaosStudyScenarioRun {
    <#
    .SYNOPSIS
        Execute a validated configuration and identify the run it created,
        without ever reporting an accepted start as "never started".

    .DESCRIPTION
        The validation result is a required argument, and it is asserted here as
        the last thing before the run starts. The caller has already applied the
        same gate; this repeats it so that the guarantee belongs to the function
        that starts the run rather than to the order of statements in one
        caller. A future caller that reorders the sequence, or forgets the gate
        entirely, still cannot execute an unvalidated configuration.

        `--no-wait` is documented to return the run id parsed from the Location
        header, and it has been observed to exit 0 with an empty body for a run
        the service genuinely created. Previously that empty body failed the
        'run.v1' schema and threw AFTER the fault was live, which the caller
        then handled as a run that never started - it deleted the configuration
        underneath an injecting fault and slept through the outage.

        So the start is now accepted on its own terms and identification is a
        separate, best-effort step: use the id the response carries; otherwise
        diff the scenario's runs across the start. When identification fails the
        result is accepted-untracked, never an exception and never a guess. A
        run that cannot be identified is still a run that is happening.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][object]$Plan,
        [Parameter(Mandatory)][string]$ConfigurationName,
        [Parameter(Mandatory)][AllowNull()][object]$Validation,
        # True only when this execution created the configuration rather than
        # reusing one that already existed. Enumeration-based identification is
        # refused without it, because a shared configuration cannot distinguish
        # this study's run from a concurrent caller's.
        [bool]$ConfigurationExclusive = $false,
        [AllowNull()][AllowEmptyString()][string]$Adapter,
        [AllowNull()][AllowEmptyString()][string]$StudyPath
    )

    Assert-ChaosConfigurationValidated -Validation $Validation -ConfigurationName $ConfigurationName | Out-Null

    # Baseline BEFORE the start, so the run this start creates can be told from
    # the runs that were already there. Read failures are tolerated; they only
    # weaken identification, and identification never gates the start.
    $before = Get-ChaosScenarioRunInventory -Plan $Plan -Adapter $Adapter -StudyPath $StudyPath
    $startedAtUtc = Get-ChaosUtcNow

    $arguments = Get-ChaosStudyRunScopeArguments -Plan $Plan
    $arguments['configName'] = $ConfigurationName
    $started = Invoke-ChaosStudyOperation -Kind 'run.start' -Arguments $arguments `
        -ExpectedSchema 'runStart.v1' -Adapter (Get-ChaosExecutionAdapter -Plan $Plan -Adapter $Adapter) `
        -StudyPath $StudyPath -OperationHint 'scenario run start'

    $runId = $null
    $resolution = $null
    if ($null -ne $started) {
        $startedNames = @($started.PSObject.Properties.Name)
        if ($startedNames -contains 'name' -and -not [string]::IsNullOrWhiteSpace([string]$started.name)) {
            $runId = [string]$started.name
            $resolution = 'response'
        } elseif ($startedNames -contains 'id' -and [string]$started.id -match '/runs/([^/?]+)') {
            $runId = $Matches[1]
            $resolution = 'response-id'
        }
    }

    $after = $null
    $identified = $null
    if ([string]::IsNullOrWhiteSpace($runId)) {
        $after = Get-ChaosScenarioRunInventory -Plan $Plan -Adapter $Adapter -StudyPath $StudyPath
        $identified = Resolve-ChaosStartedScenarioRun -Before $before -After $after -ConfigurationName $ConfigurationName -ConfigurationExclusive $ConfigurationExclusive
        $runId = $identified.runId
        $resolution = $identified.resolution
    }

    $tracked = -not [string]::IsNullOrWhiteSpace($runId)
    $reason = if ($tracked) { $null } elseif ($null -ne $identified) { $identified.reason } else { 'enumeration-unavailable' }
    $candidates = if ($null -ne $identified) { ConvertTo-ChaosList $identified.candidates } else { @() }

    if (-not $tracked) {
        Write-ChaosStudyNote -Level 'warn' -Message "Chaos Studio accepted the run for configuration '$ConfigurationName' but it could not be identified ($reason). The fault is running and cannot be polled or cancelled from here - cancel it from the portal. The configuration will be kept so the run is not orphaned."
    }

    return [pscustomobject]@{
        runId        = $runId
        tracked      = $tracked
        resolution   = $resolution
        reason       = $reason
        candidates   = $candidates
        response     = $started
        startedAtUtc = $startedAtUtc
        enumeration  = [pscustomobject]@{
            beforeAvailable = [bool]($null -ne $before -and $before.available)
            beforeCount     = if ($null -ne $before -and $before.available) { @($before.runs).Count } else { $null }
            afterAvailable  = [bool]($null -ne $after -and $after.available)
            afterCount      = if ($null -ne $after -and $after.available) { @($after.runs).Count } else { $null }
        }
    }
}

function Get-ChaosStudyScenarioRun {
    <#
    .SYNOPSIS
        Read the current state of a scenario run.

    .PARAMETER Strict
        Route through the non-swallowing read. Polling wants a transient read
        failure to be survivable, so it uses the tolerant op; an absence probe
        needs the error text, because "not found" and "the call failed" both
        arrive as $null from the tolerant one and only the first proves the run
        is gone.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][object]$Plan,
        [Parameter(Mandatory)][string]$RunId,
        [AllowNull()][AllowEmptyString()][string]$Adapter,
        [AllowNull()][AllowEmptyString()][string]$StudyPath,
        [Parameter()][switch]$Strict
    )

    $kind = if ($Strict) { 'run.showStrict' } else { 'run.show' }
    $arguments = Get-ChaosStudyRunScopeArguments -Plan $Plan
    $arguments['runId'] = $RunId
    return Invoke-ChaosStudyOperation -Kind $kind -Arguments $arguments `
        -ExpectedSchema 'any.v1' -Adapter (Get-ChaosExecutionAdapter -Plan $Plan -Adapter $Adapter) `
        -StudyPath $StudyPath -OperationHint 'scenario run show'
}

function Stop-ChaosStudyScenarioRun {
    <#
    .SYNOPSIS
        Cancel a scenario run, tolerating one that already finished.

    .DESCRIPTION
        `run.cancel` is deliberately strict, so a cancel the service rejected
        raises instead of quietly returning nothing. Two rejections are benign
        and are swallowed here: the run cannot be found, and the run has already
        reached a terminal state. Both mean the thing this cancel exists to stop
        is already stopped. Everything else is rethrown, and the caller records
        it as failed residue with the error text attached - an abort that did not
        take must never read as one that did.

        This is called from a finally block but is not responsible for keeping
        that block safe; `Invoke-ChaosResidueRemoval` wraps the removal in its
        own catch and turns a raise into a recorded outcome.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][object]$Plan,
        [Parameter(Mandatory)][string]$RunId,
        [AllowNull()][AllowEmptyString()][string]$Adapter,
        [AllowNull()][AllowEmptyString()][string]$StudyPath
    )

    try {
        $arguments = Get-ChaosStudyRunScopeArguments -Plan $Plan
        $arguments['runId'] = $RunId
        return Invoke-ChaosStudyOperation -Kind 'run.cancel' -Arguments $arguments `
            -ExpectedSchema 'any.v1' -Adapter (Get-ChaosExecutionAdapter -Plan $Plan -Adapter $Adapter) `
            -StudyPath $StudyPath -OperationHint 'scenario run cancel'
    } catch {
        $text = [string]$_.Exception.Message
        if (Test-ChaosNotFoundError -Text $text) { return $null }
        if (Test-ChaosAlreadyTerminalError -Text $text) { return $null }
        throw
    }
}

function Test-ChaosAlreadyTerminalError {
    <#
    .SYNOPSIS
        True when a cancel was refused because the run had already stopped.

    .DESCRIPTION
        Matches only phrasings that assert the run is no longer running. It is
        deliberately narrow: treating an unrecognised refusal as "already
        stopped" would be the same fabricated-absence bug this suite keeps
        finding, so anything unmatched stays a real failure.
    #>
    param([AllowNull()][AllowEmptyString()][string]$Text)

    if ([string]::IsNullOrWhiteSpace($Text)) { return $false }
    $patterns = @(
        'already\s+(completed|finished|cancell?ed|stopped|terminated)',
        'is\s+not\s+(running|active|in\s+progress)',
        'no\s+longer\s+running',
        'in\s+a\s+terminal\s+state',
        'cannot\s+be\s+cancell?ed'
    )
    foreach ($p in $patterns) {
        if ($Text -match $p) { return $true }
    }
    return $false
}

function Get-ChaosScenarioRunStatus {
    <#
    .SYNOPSIS
        Read the run status, whatever shape the response arrives in.
    #>
    param([AllowNull()][object]$Run)

    if ($null -eq $Run) { return $null }
    if ($Run.PSObject.Properties.Name -contains 'properties' -and $null -ne $Run.properties) {
        if ($Run.properties.PSObject.Properties.Name -contains 'status') { return [string]$Run.properties.status }
    }
    if ($Run.PSObject.Properties.Name -contains 'status') { return [string]$Run.status }
    return $null
}

function Test-ChaosScenarioRunTerminal {
    <#
    .SYNOPSIS
        True when a run has reached a state it will not leave.
    #>
    param([AllowNull()][string]$Status)
    return ($Status -in @('Succeeded', 'Failed', 'Canceled', 'Cancelled'))
}

function Get-ChaosActionWindow {
    <#
    .SYNOPSIS
        When was the action actually live? Not when we were watching.

    .DESCRIPTION
        The configured duration is a budget, not a measurement, and the two
        coincide only for a continuous action that ran the whole window. For a
        discrete action the fault is an instant somewhere inside the window;
        labelling the whole window "action active" would inflate the exposure
        by minutes and let a study claim a resilience it never tested.

        So the window is derived, in order of preference, from what the service
        reported:

          continuous  the run's own start/end interval, else the per-leg times,
                      else - only as a last resort - the interval we observed,
                      marked approximate.
          discrete    the per-leg action times and nothing else. With no per-leg
                      times the window is unknown, and unknown is recorded as
                      unknown. The configured duration is never substituted.

        An unrecognised actionType is treated as discrete, because that is the
        assumption that cannot overstate what was tested.
    #>
    [CmdletBinding()]
    param(
        [AllowNull()][object]$Observation,
        [AllowNull()][AllowEmptyString()][string]$ActionType,
        [AllowNull()][object]$ObservationWindow
    )

    $continuous = Test-ChaosActionIsContinuous -ActionType $ActionType

    $window = [ordered]@{
        actionType = if ([string]::IsNullOrWhiteSpace($ActionType)) { $null } else { [string]$ActionType }
        continuous = $continuous
        startUtc   = $null
        endUtc     = $null
        source     = $null
        timing     = 'unknown'
        legsTotal  = 0
        legsTimed  = 0
        detail     = $null
    }

    # -- per-leg times ---------------------------------------------------
    $legStarts = @()
    $legEnds = @()
    $legsTotal = 0
    $legsFullyTimed = 0
    $obsActions = Get-ChaosMember -InputObject $Observation -Name 'actions'
    if ($null -ne $obsActions) {
        foreach ($leg in @($obsActions | Where-Object { $null -ne $_ })) {
            if ($null -eq $leg) { continue }
            $legsTotal++
            $s = ConvertFrom-ChaosUtcIsoOrNull -Text ([string]$leg.startedAt)
            $e = ConvertFrom-ChaosUtcIsoOrNull -Text ([string]$leg.completedAt)
            if ($null -ne $s) { $legStarts += $s }
            if ($null -ne $e) { $legEnds += $e }
            if ($null -ne $s -and $null -ne $e) { $legsFullyTimed++ }
        }
    }
    $window['legsTotal'] = $legsTotal
    $window['legsTimed'] = $legsFullyTimed

    $legStart = if ($legStarts.Count -gt 0) { ($legStarts | Sort-Object)[0] } else { $null }
    $legEnd = if ($legEnds.Count -gt 0) { ($legEnds | Sort-Object)[-1] } else { $null }

    # -- run interval ----------------------------------------------------
    $runStart = $null
    $runEnd = $null
    if ($null -ne $Observation) {
        $runStart = ConvertFrom-ChaosUtcIsoOrNull -Text ([string](Get-ChaosMember -InputObject $Observation -Name 'startedAt'))
        $runEnd = ConvertFrom-ChaosUtcIsoOrNull -Text ([string](Get-ChaosMember -InputObject $Observation -Name 'completedAt'))
    }

    $set = {
        param($start, $end, $source, $timing, $detail)
        $window['startUtc'] = if ($null -ne $start) { ConvertTo-ChaosUtcIso -Instant $start } else { $null }
        $window['endUtc'] = if ($null -ne $end) { ConvertTo-ChaosUtcIso -Instant $end } else { $null }
        $window['source'] = $source
        $window['timing'] = $timing
        $window['detail'] = $detail
        return [pscustomobject]$window
    }

    if ($continuous -eq $true) {
        if ($null -ne $runStart -and $null -ne $runEnd) {
            return & $set $runStart $runEnd 'run' 'exact' "The action is continuous, so it was live for the whole scenario run interval the service reported."
        }
        if ($null -ne $legStart -and $null -ne $legEnd) {
            return & $set $legStart $legEnd 'perLeg' 'exact' "The action is continuous and the service reported per-leg start and completion times; the window spans them."
        }
        if ($null -ne $ObservationWindow) {
            return & $set (ConvertFrom-ChaosUtcIsoOrNull -Text ([string]$ObservationWindow.startUtc)) (ConvertFrom-ChaosUtcIsoOrNull -Text ([string]$ObservationWindow.endUtc)) 'observation' 'approximate' "The service reported no run or per-leg times, so the interval we observed stands in for the action window. It includes the time taken to start and cancel the run."
        }
        return & $set $null $null $null 'unknown' 'The action is continuous but neither the service nor the local observation supplied an interval.'
    }

    # Discrete, or an actionType we do not recognise. Either way the configured
    # duration is not evidence of anything, so it is not used.
    $kindText = if ($continuous -eq $false) { 'discrete' } else { "of an unrecognised type ('$ActionType'), so it is treated as discrete" }

    if ($null -ne $legStart) {
        $end = if ($null -ne $legEnd) { $legEnd } else { $legStart }
        $timing = if ($legsFullyTimed -eq $legsTotal -and $legsTotal -gt 0) { 'exact' } else { 'approximate' }
        $detail = if ($timing -eq 'exact') {
            "The action is $kindText; the window spans the per-leg start and completion times the service reported for all $legsTotal leg(s)."
        }
        else {
            "The action is $kindText; only $legsFullyTimed of $legsTotal leg(s) reported both a start and a completion, so the window is approximate."
        }
        return & $set $legStart $end 'perLeg' $timing $detail
    }

    return & $set $null $null $null 'unknown' "The action is $kindText and the service reported no per-leg times, so when it was actually applied is unknown. The configured duration is an observation budget and is deliberately not substituted for it."
}

function Get-ChaosScenarioRunObservation {
    <#
    .SYNOPSIS
        Flatten a scenario run into what the report needs: which actions ran,
        against which resources, and what went wrong.

    .DESCRIPTION
        Absent detail is recorded as null rather than as an empty success. A
        report that cannot say what happened must say so.
    #>
    param([AllowNull()][object]$Run)

    $observation = [ordered]@{
        status          = Get-ChaosScenarioRunStatus -Run $Run
        startedAt       = $null
        completedAt     = $null
        actions         = @()
        errors          = @()
        resourcesTouched = $null
    }
    if ($null -eq $Run) { return $observation }

    $props = if ($Run.PSObject.Properties.Name -contains 'properties' -and $null -ne $Run.properties) { $Run.properties } else { $Run }

    if ($props.PSObject.Properties.Name -contains 'startTime') { $observation['startedAt'] = [string]$props.startTime }
    if ($props.PSObject.Properties.Name -contains 'endTime') { $observation['completedAt'] = [string]$props.endTime }

    $resourceCount = 0
    $sawResources = $false
    if ($props.PSObject.Properties.Name -contains 'scenarioRunSummary') {
        foreach ($entry in @($props.scenarioRunSummary)) {
            if ($null -eq $entry) { continue }
            $resources = @()
            if ($entry.PSObject.Properties.Name -contains 'resources' -and $null -ne $entry.resources) {
                $sawResources = $true
                $resources = @($entry.resources | ForEach-Object { [string]$_ })
                $resourceCount += $resources.Count
            }
            $observation['actions'] += [ordered]@{
                actionUrn   = if ($entry.PSObject.Properties.Name -contains 'actionUrn') { [string]$entry.actionUrn } else { $null }
                state       = if ($entry.PSObject.Properties.Name -contains 'state') { [string]$entry.state } else { $null }
                startedAt   = if ($entry.PSObject.Properties.Name -contains 'startedAt') { [string]$entry.startedAt } else { $null }
                completedAt = if ($entry.PSObject.Properties.Name -contains 'completedAt') { [string]$entry.completedAt } else { $null }
                resources   = $resources
            }
        }
    }
    if ($sawResources) { $observation['resourcesTouched'] = $resourceCount }

    if ($props.PSObject.Properties.Name -contains 'errors') {
        foreach ($item in @($props.errors)) {
            if ($null -eq $item) { continue }
            $observation['errors'] += [ordered]@{
                code    = if ($item.PSObject.Properties.Name -contains 'errorCode') { [string]$item.errorCode } else { $null }
                message = if ($item.PSObject.Properties.Name -contains 'errorMessage') { [string]$item.errorMessage } else { [string]$item }
            }
        }
    }

    if ($props.PSObject.Properties.Name -contains 'executionErrors' -and $null -ne $props.executionErrors) {
        foreach ($kind in @('permission', 'resource')) {
            if ($props.executionErrors.PSObject.Properties.Name -notcontains $kind) { continue }
            foreach ($item in @($props.executionErrors.$kind)) {
                if ($null -eq $item) { continue }
                $observation['errors'] += [ordered]@{
                    code    = $kind
                    message = ConvertTo-ChaosCanonicalJson -InputObject $item
                }
            }
        }
    }

    return $observation
}

function Wait-ChaosScenarioRunWindow {
    <#
    .SYNOPSIS
        Hold for the injection window, polling the run and returning early if
        it reaches a terminal state.

    .DESCRIPTION
        Returning early matters: a run that failed on the first resource should
        not be reported as "injected for ten minutes". The last observed run is
        returned so the caller records what actually happened rather than what
        was planned.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][object]$Plan,
        [Parameter(Mandatory)][string]$RunId,
        [Parameter(Mandatory)][int]$Minutes,
        [int]$PollSeconds = 20,
        [scriptblock]$OnPoll,
        [AllowNull()][AllowEmptyString()][string]$Adapter,
        [AllowNull()][AllowEmptyString()][string]$StudyPath
    )

    $deadline = [datetime]::UtcNow.AddMinutes($Minutes)
    $last = $null
    $terminal = $false

    while ([datetime]::UtcNow -lt $deadline) {
        $last = Get-ChaosStudyScenarioRun -Plan $Plan -RunId $RunId -Adapter $Adapter -StudyPath $StudyPath
        $status = Get-ChaosScenarioRunStatus -Run $last
        if ($OnPoll) { & $OnPoll $status }
        if (Test-ChaosScenarioRunTerminal -Status $status) { $terminal = $true; break }

        $remaining = ($deadline - [datetime]::UtcNow).TotalSeconds
        if ($remaining -le 0) { break }
        Start-Sleep -Seconds ([Math]::Min($PollSeconds, [Math]::Ceiling($remaining)))
    }

    if (-not $terminal -and $null -eq $last) {
        $last = Get-ChaosStudyScenarioRun -Plan $Plan -RunId $RunId -Adapter $Adapter -StudyPath $StudyPath
    }

    return [pscustomobject]@{
        run              = $last
        endedEarly       = $terminal
        observedAt       = Get-ChaosUtcNow
    }
}
