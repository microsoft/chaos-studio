#Requires -Version 7.0
<#
.SYNOPSIS
    Turn a reliability question into a frozen, executable study plan.

.DESCRIPTION
    Scoping decides whether a study is worth running, and it does that before
    anything is injected. Four questions in order:

      1. What is the lifecycle root?
         A Chaos Studio workspace. Its scopes decide which resources exist as
         far as this study is concerned. Reused when it is already there,
         created only when you ask for it.

      2. What did the platform actually find in that scope?
         The workspace's discovered resources. An empty scope is a blocking
         failure, because a run against nothing succeeds and reads like proof
         of resilience.

      3. What can the platform actually do here?
         Scenarios and actions are read live from Chaos Studio for the scope's
         region. This suite ships no catalogue of faults and never falls back
         to one - if discovery fails, scoping stops.

      4. Would the result mean anything?
         A study with no numeric objective, no signal, or an action whose
         schema is unsatisfied produces a document, not evidence.

    Only when all four hold is a plan written, and the plan is hashed so the
    consent given later provably refers to it.

    Nothing here injects anything.

.EXAMPLE
    ./Invoke-ChaosStudyScope.ps1 -SubscriptionId <sub> -ResourceGroup rg `
        -WorkspaceName ws -ListScenarios

.EXAMPLE
    ./Invoke-ChaosStudyScope.ps1 -SubscriptionId <sub> -ResourceGroup rg `
        -WorkspaceName ws -Scenario 'zone-down' -Action 'shutdown' `
        -SteadyState 'successRate >= 99.5' -SignalSource 'metrics:Availability' `
        -FilterZone 1
#>

[CmdletBinding(DefaultParameterSetName = 'Plan')]
param(
    [Parameter(Mandatory)][string]$SubscriptionId,

    # The resource group holding the Chaos Studio workspace.
    [Parameter(Mandatory)][string]$ResourceGroup,

    # The workspace under which this study runs. Workspaces are the lifecycle
    # root: scopes, discovered resources, scenarios and runs all hang off one.
    [Parameter(Mandatory)][string]$WorkspaceName,

    # Create the workspace when it does not exist. Without this, a missing
    # workspace is an error rather than an implicit provisioning action.
    [switch]$CreateWorkspace,

    # ARM resource ids the workspace should observe. Required with
    # -CreateWorkspace; ignored when the workspace already exists.
    [string[]]$Scope = @(),

    # Region for a workspace being created. Defaults to the region of the
    # first scoped resource id when it can be resolved.
    [string]$Location,

    # Use a user-assigned managed identity instead of a system-assigned one.
    [string]$UserAssignedIdentity,

    # Print the scenarios the workspace recommends, then exit without planning.
    [Parameter(ParameterSetName = 'ListScenarios')][switch]$ListScenarios,

    # Print the actions Chaos Studio reports for the scope's region, then exit.
    [Parameter(ParameterSetName = 'ListActions')][switch]$ListActions,

    # The scenario to configure and execute: its name or id, as returned by
    # -ListScenarios. Matched against the live list.
    [Parameter(ParameterSetName = 'Plan', Mandatory)]
    [Parameter(ParameterSetName = 'Brief')]
    [string]$Scenario,

    # The action this study is about: its name, canonical URN, or display name,
    # as returned by -ListActions. Matched against the live list. The scenario
    # is what executes; the action is what the study claims to have tested, and
    # the readiness gates are evaluated against it.
    [Parameter(ParameterSetName = 'Plan', Mandatory)]
    [Parameter(ParameterSetName = 'Brief')]
    [string]$Action,

    # The numeric objective this study tries to break, e.g. 'successRate >= 99.5'.
    [Parameter(ParameterSetName = 'Plan', Mandatory)]
    [Parameter(ParameterSetName = 'Brief')]
    [string]$SteadyState,

    # A confirmed study brief from chaos-study-design. Every parameter not given
    # explicitly on this command line is hydrated from it, so a decision the
    # customer already confirmed is never retyped — and anything passed
    # explicitly still wins, so the brief is a starting point, not a cage.
    [Parameter(ParameterSetName = 'Brief', Mandatory)][string]$Brief,

    # How long this study WATCHES. It is not how long the platform injects:
    # that is the scenario's own duration parameter, resolved separately and
    # gated below, because a five-minute observation budget over a scenario
    # whose default is fifteen minutes is a fifteen-minute fault.
    [ValidateRange(1, 240)][int]$DurationMinutes = 10,
    [ValidateRange(0, 240)][int]$BaselineMinutes = 5,
    [ValidateRange(0, 240)][int]$RecoveryMinutes = 10,

    # Confirm, in seconds, how long the fault actually runs. Required when the
    # configured fault outlives the observation budget - repeating the number
    # is the acknowledgement, because it cannot be given without reading it.
    [AllowNull()][object]$AcknowledgeFaultDurationSeconds,

    # Accept starting a fault whose length the live scenario contract does not
    # declare. Nothing is assumed on your behalf if you omit this.
    [switch]$AcceptUnknownFaultDuration,

    # Scenario parameters, keyed by the names in the scenario's live parameter
    # list. Frozen onto the plan as the {key,value} pairs the service takes.
    # These are what the configuration API accepts; anything the *action*
    # declares goes in -ActionParameters instead.
    [hashtable]$Parameters,

    # Action parameters, keyed by the names in the selected action's live
    # parameter schema. Kept separate from -Parameters because the two schemas
    # are different documents: checking a scenario's duration against an
    # action's schema rejects a study the service would have accepted.
    [hashtable]$ActionParameters,

    [string]$Hypothesis,

    # How the injected action is expected to falsify the steady state: the
    # action's effect, the code or dependency failure it provokes, and how that
    # reaches the predicate. Required for a falsifiable study; a missing or empty
    # value is a blocking readiness failure (exit 10), not a silent omission.
    [string]$FailureMechanism,

    # A concrete reference (file, symbol, or architecture note) that anchors the
    # mechanism in the system under study, so its truthfulness can be reviewed.
    # Empty is untraceable and blocks at readiness.
    [string]$MechanismEvidence,

    # The probe that proves the mechanism landed, as a hashtable with keys:
    #   signal | query        the exact signal (or KQL) the mechanism moves
    #   expectedDirection     up | down | appears | disappears | crosses
    #   condition             optional threshold/predicate the direction is about
    #   resourceCorrelation   the resource the probe must resolve to
    # The probe signal must be one of -SignalSource and resolve to a scoped
    # resource, or readiness blocks it as untraceable (exit 10).
    [hashtable]$MechanismProbe,

    # Signal sources: 'metrics:<name>' or 'logs:<workspaceId>#<kql>'.
    [string[]]$SignalSource = @(),

    # Exercise arithmetic (Req E). A fault only proves something if work reaches
    # the path it breaks, so the study computes the exposure it is about to buy
    # and refuses to run when that exposure rounds to nothing. Every input here
    # is optional and stays null when unsupplied - an unmeasured rate must never
    # become an assumed one.
    #
    #   EventRatePerSecond      how often work reaches the vulnerable path
    #   VulnerableWindowSeconds how long that path is actually vulnerable. Left
    #                           unset it is inferred from the injection window,
    #                           but only for continuous actions, where the two
    #                           genuinely coincide. For discrete actions the
    #                           configured duration is an observation budget,
    #                           not a fault duration, so nothing is inferred.
    #   EligibleFraction        share of that work the blast radius can reach
    [double]$EventRatePerSecond,
    [double]$VulnerableWindowSeconds,
    [ValidateRange(0, 1)][double]$EligibleFraction,
    [string[]]$ExerciseAssumption = @(),

    # Run a study whose computed exposure is below the threshold. The result is
    # recorded as not-exercised rather than as evidence of resilience.
    [switch]$AcceptWeakExercise,

    # Blast radius. These become the scenario configuration's filters and
    # exclusions, which is the only mechanism V2 offers for bounding a run.
    [string[]]$FilterLocation = @(),
    [ValidateSet('1', '2', '3', 'zone-redundant')][string[]]$FilterZone = @(),
    [string]$FilterPhysicalZone,
    [string[]]$ExcludeResource = @(),
    [string[]]$ExcludeType = @(),
    [hashtable]$ExcludeTag,

    [string]$StudyRoot,

    # Plan without probing Azure. The plan carries limitation L10 and is not
    # evidence that the study can run.
    [switch]$SkipDiscovery,

    # Which operation adapter turns preflight config.create/validate into either
    # an in-process Azure call ('local-az') or a durable pause/resume against a
    # host that owns auth ('external'). Frozen onto the plan so the run reaches
    # Azure the same way it was scoped.
    [ValidateSet('local-az', 'external')][string]$Adapter = 'local-az',

    # Accept a partial scenario - one whose preflight execution plan runs fewer
    # legs than it declares. Must be the exact phrase printed when a partial
    # scenario is first detected; it is bound to the plan and the effective legs.
    # Without it a partial scenario is fail-closed (exit 20).
    [string]$AcceptPartialScenario
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot '..' '..' 'chaos-study' 'scripts' 'lib' 'Common.ps1')
. (Join-Path $PSScriptRoot '..' '..' 'chaos-study' 'scripts' 'lib' 'ApiVersions.ps1')
. (Join-Path $PSScriptRoot '..' '..' 'chaos-study' 'scripts' 'lib' 'Study.ps1')
. (Join-Path $PSScriptRoot '..' '..' 'chaos-study' 'scripts' 'lib' 'Operation.ps1')
. (Join-Path $PSScriptRoot '..' '..' 'chaos-study' 'scripts' 'lib' 'Residue.ps1')
. (Join-Path $PSScriptRoot '..' '..' 'chaos-study' 'scripts' 'lib' 'Exercise.ps1')
. (Join-Path $PSScriptRoot '..' '..' 'chaos-study' 'scripts' 'lib' 'ConfigurationPayload.ps1')
. (Join-Path $PSScriptRoot '..' '..' 'chaos-study' 'scripts' 'lib' 'FaultDuration.ps1')
. (Join-Path $PSScriptRoot 'lib' 'ActionDiscovery.ps1')
. (Join-Path $PSScriptRoot 'lib' 'Workspace.ps1')
. (Join-Path $PSScriptRoot 'lib' 'Readiness.ps1')
. (Join-Path $PSScriptRoot 'lib' 'BriefHandoff.ps1')

$ChaosStudyPlanVersion = 'study-plan.v3'

# -- Brief hydration -------------------------------------------------------
# Runs before anything else so every downstream reference sees final values.
# Explicit arguments always win: the brief fills gaps, it never overrides a
# decision the caller stated on this command line.
if ($PSCmdlet.ParameterSetName -eq 'Brief') {
    $hydrated = Import-ChaosBriefHandoff -BriefPath $Brief -Bound $PSBoundParameters
    foreach ($name in $hydrated.Keys) {
        Set-Variable -Name $name -Value $hydrated[$name] -Force
    }
    foreach ($required in @('Scenario', 'Action', 'SteadyState')) {
        $value = Get-Variable -Name $required -ValueOnly -ErrorAction SilentlyContinue
        if ([string]::IsNullOrWhiteSpace($value)) {
            Write-ChaosStudyFailure -Title 'Brief is incomplete' `
                -Message "The brief does not supply -$required and it was not passed explicitly." `
                -Remediation "Pass -$required, or re-run chaos-study-design so the confirmed brief carries it."
            exit (Get-ChaosStudyExitCode 'DesignIncomplete')
        }
    }
    Write-ChaosStudyNote "Hydrated $($hydrated.Count) parameter(s) from brief $(Split-Path $Brief -Leaf)."
}

# -- Steady state ----------------------------------------------------------

function ConvertFrom-ChaosSteadyState {
    <#
    .SYNOPSIS
        Parse 'signal <op> threshold[unit]' into a structured predicate.

    .DESCRIPTION
        The predicate has to be falsifiable, which in practice means it has to
        be a comparison against a number. Free text like "the service is
        healthy" is rejected here rather than at report time, because a study
        whose objective cannot be violated cannot teach anything.
    #>
    param([AllowNull()][AllowEmptyString()][string]$Text)

    if ([string]::IsNullOrWhiteSpace($Text)) { return $null }
    if ($Text -notmatch '^\s*([A-Za-z][A-Za-z0-9_.]*)\s*(>=|<=|>|<|==)\s*(-?[0-9]+(?:\.[0-9]+)?)\s*([A-Za-z%/]*)\s*$') {
        throw "Steady state '$Text' is not parseable. Use the form 'signal >= number[unit]', for example 'successRate >= 99.5' or 'p95Latency <= 400ms'."
    }
    return [pscustomobject]@{
        raw        = $Text.Trim()
        signal     = $Matches[1]
        comparison = $Matches[2]
        threshold  = [double]$Matches[3]
        unit       = if ($Matches[4]) { $Matches[4] } else { $null }
    }
}

function ConvertFrom-ChaosMechanismProbe {
    <#
    .SYNOPSIS
        Normalise the -MechanismProbe hashtable into the structure frozen onto
        the plan.

    .DESCRIPTION
        The probe is what turns "a signal moved" into "the signal this mechanism
        predicts moved, on the resource it predicts". Its fields are structured
        here so freezing, hashing and later proof all read one shape:

          signal | query        the exact measurement the mechanism moves
          expectedDirection     up | down | appears | disappears | crosses
          condition             optional threshold the direction is about
          resourceCorrelation   the resource the probe must resolve to

        When a query-based probe uses a numeric direction (up, down or
        crosses), its result set must project a numeric column the proof step
        can read: one named 'value', 'count', 'last', 'mean', or the probe's
        own signal name. A query that returns only custom-named columns (say
        'HealthScore') leaves the proof step nothing to compare, and the report
        reports that as a probe configuration gap rather than a disproof.
        The appears/disappears directions need no such column - they turn on
        the rows' presence alone.

        Presence and traceability are enforced by the readiness gate, not here:
        a null probe returns $null so the gate can report it as missing rather
        than this throwing before the gate ever runs. What this does reject is a
        probe whose direction is not one the proof step knows how to evaluate,
        because a freely-typed direction can never be checked.
    #>
    param([AllowNull()][object]$Table)

    if ($null -eq $Table) { return $null }

    $read = {
        param($name)
        $value = $null
        if ($Table -is [System.Collections.IDictionary]) {
            if ($Table.Contains($name)) { $value = $Table[$name] }
        }
        elseif ($Table.PSObject.Properties.Name -contains $name) {
            $value = $Table.$name
        }
        if ($value -is [string]) { $value = $value.Trim() }
        if ($value -is [string] -and [string]::IsNullOrWhiteSpace($value)) { return $null }
        return $value
    }

    $direction = & $read 'expectedDirection'
    $allowed = @('up', 'down', 'appears', 'disappears', 'crosses')
    if ($null -ne $direction -and $allowed -notcontains [string]$direction) {
        throw "Mechanism probe expectedDirection '$direction' is not recognised. Use one of: $($allowed -join ', ')."
    }

    return [pscustomobject]@{
        signal              = & $read 'signal'
        query               = & $read 'query'
        expectedDirection   = if ($null -ne $direction) { [string]$direction } else { $null }
        condition           = & $read 'condition'
        resourceCorrelation = & $read 'resourceCorrelation'
    }
}

function Get-ChaosPreflightConfigurationName {
    <#
    .SYNOPSIS
        Deterministic preflight configuration name derived from the study id.

    .DESCRIPTION
        Deriving it means the same study always names its preflight
        configuration the same way, so the run can find and reuse - or clean up -
        the exact resource scope validated it, rather than guessing a name.
    #>
    param([Parameter(Mandatory)][string]$StudyId)
    $suffix = ($StudyId -replace '[^A-Za-z0-9]', '').ToLowerInvariant()
    if ($suffix.Length -gt 34) { $suffix = $suffix.Substring($suffix.Length - 34) }
    return "preflight-$suffix"
}

function Get-ChaosPreflightValidationStatus {
    <#
    .SYNOPSIS
        Read the status out of a preflight validation result, whatever shape it
        arrives in (`status` or ARM-style `properties.status`).
    #>
    param([AllowNull()][object]$Validation)
    if ($null -eq $Validation) { return $null }
    if (($Validation.PSObject.Properties.Name -contains 'properties') -and $null -ne $Validation.properties -and
        ($Validation.properties.PSObject.Properties.Name -contains 'status')) {
        return [string]$Validation.properties.status
    }
    if ($Validation.PSObject.Properties.Name -contains 'status') { return [string]$Validation.status }
    return $null
}

function New-ChaosPreflightConfiguration {
    <#
    .SYNOPSIS
        Create and validate a deterministic preflight configuration, and return
        the validation result whose execution plan the effective-leg model reads.

    .DESCRIPTION
        This runs before any fault consent. It creates a temporary scenario
        configuration named for the study, validates it, and returns the
        validation result untouched so Resolve-ChaosEffectiveLegs can inspect the
        execution plan the platform computed. Both calls go through the operation
        seam, so the same adapter (local-az or external) reaches Azure here as
        will reach it at run time; an external adapter pauses durably (exit 18)
        exactly as it would anywhere else.
    #>
    param(
        [Parameter(Mandatory)][string]$StudyId,
        [Parameter(Mandatory)][string]$ResourceGroup,
        [Parameter(Mandatory)][string]$WorkspaceName,
        [Parameter(Mandatory)][string]$ScenarioName,
        [AllowNull()][AllowEmptyCollection()][object[]]$Parameters = @(),
        [AllowNull()][object]$BlastRadius,
        [Parameter(Mandatory)][string]$Adapter,
        [Parameter(Mandatory)][string]$StudyPath
    )

    $name = Get-ChaosPreflightConfigurationName -StudyId $StudyId
    $scoping = @('-n', $name, '-g', $ResourceGroup, '--workspace-name', $WorkspaceName, '--scenario-name', $ScenarioName)

    # The SAME builder the run uses. Preflight exists to predict execution, and a
    # payload that omitted the blast radius would validate a configuration nobody
    # is going to run - it would report an excluded resource as targeted.
    $body = New-ChaosConfigurationBody -ScenarioParameters @($Parameters) -BlastRadius $BlastRadius

    $created = Invoke-ChaosStudyOperation -Kind 'config.create' -Arguments @{ cliArgs = $scoping } -Body $body `
        -ExpectedSchema 'configuration.v1' -Adapter $Adapter -StudyPath $StudyPath -OperationHint 'preflight config create'

    $validation = Invoke-ChaosStudyOperation -Kind 'config.validate' -Arguments @{ cliArgs = $scoping } `
        -ExpectedSchema 'validation.v1' -Adapter $Adapter -StudyPath $StudyPath -OperationHint 'preflight config validate'

    $status = Get-ChaosPreflightValidationStatus -Validation $validation

    # If validation failed, ask the service which grants are missing - in what-if
    # mode only. This happens before any consent, so the operator learns that RBAC
    # would have to be widened while there is still nothing at stake, rather than
    # discovering it mid-run. Nothing is granted here under any circumstances.
    $permissionPreview = $null
    if ($status -ne 'Succeeded') {
        $permissionPreview = Invoke-ChaosStudyOperation -Kind 'config.fixPermissions' `
            -Arguments @{ cliArgs = ($scoping + @('--what-if')) } `
            -ExpectedSchema 'permissionFix.v1' -Adapter $Adapter -StudyPath $StudyPath `
            -OperationHint 'preflight fix-permissions --what-if'
    }

    return [pscustomobject]@{
        name              = $name
        adapter           = $Adapter
        created           = $created
        validation        = $validation
        status            = $status
        permissionPreview = $permissionPreview
        # The exact payload that was validated, plus its digest. The run refuses
        # to execute a body that does not digest to this, so "what was reviewed"
        # and "what executes" are the same bytes rather than the same intent.
        body              = $body
        bodyDigest        = (Get-ChaosConfigurationBodyDigest -Body $body)
        # executionPlan intentionally aliases the same validation object: config
        # validate returns the execution plan inline, so Resolve-ChaosEffectiveLegs
        # reads the plan straight from it. Not a copy-paste error - do not "dedupe".
        executionPlan     = $validation
    }
}

function ConvertTo-ChaosScenarioParameter {
    <#
    .SYNOPSIS
        Turn a parameter hashtable into the {key,value} pairs the service takes.

    .DESCRIPTION
        Sorted by key so that two plans built from the same intent hash the
        same. Without that, the consent hash would drift on hashtable
        enumeration order alone.
    #>
    param([AllowNull()][object]$Table)

    if ($null -eq $Table) { return , @() }

    $names = @()
    if ($Table -is [System.Collections.IDictionary]) {
        $names = @($Table.Keys | ForEach-Object { [string]$_ })
    }
    else {
        $names = @($Table.PSObject.Properties | ForEach-Object { $_.Name })
    }

    $pairs = @()
    foreach ($name in ($names | Sort-Object)) {
        $value = if ($Table -is [System.Collections.IDictionary]) { $Table[$name] } else { $Table.$name }
        $pairs += [ordered]@{ key = $name; value = $value }
    }
    return , @($pairs)
}

# -- Workspace -------------------------------------------------------------
#
# The workspace is the lifecycle root. Everything after this point is scoped by
# it, so it is resolved first and its absence is fatal unless the operator
# explicitly asked for one to be created.

$workspaceId = Get-ChaosWorkspaceId -SubscriptionId $SubscriptionId -ResourceGroup $ResourceGroup -WorkspaceName $WorkspaceName

# Discovery has to run before the study directory exists, because the study is
# keyed by a hash of what discovery returns. Under the external adapter those
# operations still pause durably; they do it in a staging directory that is
# folded into the study once it is created.
$stagingPath = Get-ChaosStudyStagingPath -Key $workspaceId -StudyRoot $StudyRoot

$workspace = $null
$workspaceCreated = $false
$scopedResources = @()
$evaluation = $null
$region = $null

if ($SkipDiscovery) {
    Write-ChaosStudyNote -Message 'Discovery skipped. The plan will record what you asked for, not what the platform confirmed, and will carry limitation L10.'
}
else {
    if (-not (Test-ChaosCliAvailable -Adapter $Adapter -StudyPath $stagingPath)) {
        Assert-ChaosActionDiscovery -Reason "No operation adapter is available for '$Adapter', so the workspace could not be resolved." `
            -Remediation 'Install the Azure CLI and sign in with az login, or run with -Adapter external so the host executes the operations.'
    }

    $resolved = Resolve-ChaosStudyWorkspace -SubscriptionId $SubscriptionId -ResourceGroup $ResourceGroup `
        -WorkspaceName $WorkspaceName -Scopes $Scope -Location $Location `
        -UserAssignedIdentityId $UserAssignedIdentity -CreateWorkspace:$CreateWorkspace `
        -Adapter $Adapter -StudyPath $stagingPath
    $workspace = $resolved.workspace
    $workspaceCreated = [bool]$resolved.created

    $scopedResources = ConvertTo-ChaosList (Get-ChaosStudyScopedResource -ResourceGroup $ResourceGroup -WorkspaceName $WorkspaceName `
        -SubscriptionId $SubscriptionId -Adapter $Adapter -StudyPath $stagingPath)
    $evaluation = Assert-ChaosWorkspaceEvaluation -ResourceGroup $ResourceGroup -WorkspaceName $WorkspaceName `
        -SubscriptionId $SubscriptionId -Adapter $Adapter -StudyPath $stagingPath

    # The location is passed as an explicit string. Passing -Workspace here bound
    # by prefix to -WorkspaceLocation and stringified the whole record into
    # "@{name=...; location=...}", which then travelled into the actions URI.
    $region = Get-ChaosScopeRegion -WorkspaceLocation ([string]$workspace.location) -ScopedResources $scopedResources
    if (-not $region) {
        Assert-ChaosActionDiscovery -Reason 'The workspace scope spans more than one region, so there is no single region whose action inventory applies to it.' `
            -Remediation 'Narrow the workspace scopes to one region, or pass -FilterLocation to bound the run and re-scope against that region.'
    }
}

# -- Live discovery --------------------------------------------------------
#
# This block is the reason the suite has no bundled fault list. Everything the
# plan says about the action originates here, in a response the service
# produced moments ago.

$availableActions = @()
$scenarios = @()
$discoveryPerformedAt = $null

if (-not $SkipDiscovery) {
    try {
        $availableActions = ConvertTo-ChaosList (Get-ChaosAvailableAction -SubscriptionId $SubscriptionId -Region $region `
            -Adapter $Adapter -StudyPath $stagingPath)
    }
    catch {
        Assert-ChaosActionDiscovery -Reason "The live action list for region '$region' could not be read: $($_.Exception.Message)" `
            -Remediation 'Confirm the subscription is registered for Microsoft.Chaos and that you can reach management.azure.com, then re-run scoping.'
    }

    if ($availableActions.Count -eq 0) {
        Assert-ChaosActionDiscovery -Reason "Chaos Studio reports no actions for region '$region'." `
            -Remediation 'Pick a region where Chaos Studio publishes actions, or move the scoped resources.'
    }

    $scenarios = ConvertTo-ChaosList (Get-ChaosStudyScenario -ResourceGroup $ResourceGroup -WorkspaceName $WorkspaceName `
        -SubscriptionId $SubscriptionId -Adapter $Adapter -StudyPath $stagingPath)
    $discoveryPerformedAt = Get-ChaosUtcNow
}

# -- Listing modes ---------------------------------------------------------

if ($ListScenarios) {
    if ($SkipDiscovery) {
        Write-ChaosStudyFailure -Title 'Nothing to list' `
            -Message '-ListScenarios reads the workspace recommendations from the service, so it cannot be combined with -SkipDiscovery.'
        exit (Get-ChaosStudyExitCode -Name 'Error')
    }

    $lines = @("Scenarios recommended for workspace '$WorkspaceName'", '')
    if ($scenarios.Count -eq 0) {
        $lines += 'The workspace has no scenarios yet. Run az chaos workspace refresh-recommendation, wait for the evaluation to finish, then list again.'
    }
    else {
        foreach ($item in $scenarios) {
            $flag = if ($item.recommendationStatus -eq 'Recommended') { 'recommended' } else { [string]$item.recommendationStatus }
            $lines += "- $($item.name)  [$flag]"
            if ($item.description) { $lines += "    $($item.description)" }
            $required = @($item.parameters | Where-Object { $_.required } | ForEach-Object { $_.name })
            if ($required.Count -gt 0) { $lines += ("    required parameters: " + ($required -join ', ')) }
        }
    }
    $lines += ''
    $lines += "Read from the workspace at $discoveryPerformedAt. Discovered resources in scope: $(@($scopedResources).Count)."

    Write-ChaosStudyCard -Title 'Live scenario recommendations' -Body ($lines -join "`n")
    exit (Get-ChaosStudyExitCode -Name 'Success')
}

if ($ListActions) {
    if ($SkipDiscovery) {
        Write-ChaosStudyFailure -Title 'Nothing to list' `
            -Message '-ListActions reads the live action inventory from the service, so it cannot be combined with -SkipDiscovery.'
        exit (Get-ChaosStudyExitCode -Name 'Error')
    }

    $scopeTypes = @(@($scopedResources) | ForEach-Object { [string]$_.resourceType } | Where-Object { $_ } | Select-Object -Unique)
    $shown = $availableActions
    if ($scopeTypes.Count -gt 0) {
        $narrowed = @()
        foreach ($type in $scopeTypes) {
            $narrowed += ConvertTo-ChaosList (Select-ChaosActionForResourceType -Actions $availableActions -ResourceType $type)
        }
        $narrowed = @($narrowed | Sort-Object -Property name -Unique)
        if ($narrowed.Count -gt 0) { $shown = $narrowed }
    }

    $lines = @("Actions Chaos Studio reports for region '$region'", '')
    foreach ($item in $shown) {
        $lines += "- $($item.name)  [$($item.actionType)]"
        $lines += "    $([string]$item.canonicalId)"
        if ($item.description) { $lines += "    $($item.description)" }
    }
    $lines += ''
    $lines += "$($shown.Count) of $($availableActions.Count) action(s) shown, read live at $discoveryPerformedAt."
    $lines += "Scoped resource types: $(if ($scopeTypes.Count) { $scopeTypes -join ', ' } else { 'none discovered' })."

    Write-ChaosStudyCard -Title 'Live action inventory' -Body ($lines -join "`n")
    exit (Get-ChaosStudyExitCode -Name 'Success')
}

# -- Resolve the scenario --------------------------------------------------

$selectedScenario = $null

if ($SkipDiscovery) {
    $selectedScenario = [pscustomobject]@{
        id                   = $null
        name                 = $Scenario
        displayName          = $Scenario
        description          = $null
        version              = $null
        recommendationStatus = $null
        parameters           = @()
        discovered           = $false
    }
}
else {
    $found = Find-ChaosStudyScenario -Scenarios $scenarios -Name $Scenario
    if (-not $found) {
        $names = @($scenarios | ForEach-Object { $_.name })
        Write-ChaosStudyFailure -Title 'Scenario not recommended for this workspace' `
            -Message "The workspace does not offer a scenario matching '$Scenario'. It offers: $(if ($names.Count) { $names -join ', ' } else { 'nothing yet' })." `
            -Remediation 'Run scoping with -ListScenarios, or refresh the workspace recommendations first.'
        exit (Get-ChaosStudyExitCode -Name 'ScopeUnverified')
    }
    $selectedScenario = $found | Add-Member -NotePropertyName discovered -NotePropertyValue $true -PassThru
}

# -- Fault duration vs observation budget (safety) -------------------------
# -DurationMinutes above is the observation budget. The scenario's own
# duration parameter is what the platform actually injects for, and when
# nobody overrides it the service applies its default. Those two numbers are
# resolved and displayed separately here, and when the fault outlives the
# budget - or its length is undeclared - the plan cannot be written until the
# operator states the real number back. Consent given against a budget must
# not become consent to something longer.
$faultDuration = Resolve-ChaosFaultDuration -Scenario $selectedScenario `
    -ScenarioParameters $Parameters -ObservationBudgetMinutes $DurationMinutes

try {
    $faultDuration = Assert-ChaosFaultDurationAcknowledged -FaultDuration $faultDuration `
        -AcknowledgedSeconds $AcknowledgeFaultDurationSeconds `
        -AcceptUnknownFaultDuration:$AcceptUnknownFaultDuration
}
catch {
    Write-ChaosStudyFailure -Title 'Fault duration not acknowledged' `
        -Message ([string]$_.Exception.Message -replace '^ChaosFaultDurationUnacknowledged:\s*', '') `
        -Remediation 'The observation budget (-DurationMinutes) is how long this study watches; it does not shorten the fault.'
    exit (Get-ChaosStudyExitCode -Name 'ScopeUnverified')
}

if ($faultDuration.exceedsObservationBudget -eq $true) {
    Write-ChaosStudyNote -Level 'warn' -Message ("$($faultDuration.statement) Observation ends first, so the recovery window measures a system still under fault. Cancel the run explicitly to stop injection early.")
}

# -- Resolve the action ----------------------------------------------------

$selectedAction = $null

if ($SkipDiscovery) {
    $selectedAction = [pscustomobject]@{
        name             = $Action
        canonicalId      = $null
        displayName      = $Action
        description      = $null
        actionType       = $null
        version          = $null
        parametersSchema = $null
        recommendedRoles = @()
        appliesTo        = @()
        discovered       = $false
    }
}
else {
    $match = Find-ChaosAction -Actions $availableActions -Reference $Action
    if (-not $match) {
        Write-ChaosStudyFailure -Title 'Action not available in this region' `
            -Message "Chaos Studio reports $($availableActions.Count) action(s) for region '$region', none of which match '$Action'." `
            -Remediation 'Run scoping with -ListActions to see what the service reports here.'
        exit (Get-ChaosStudyExitCode -Name 'ActionDiscoveryUnavailable')
    }
    $selectedAction = $match | Add-Member -NotePropertyName discovered -NotePropertyValue $true -PassThru
}

# -- Objective and blast radius --------------------------------------------

$predicate = ConvertFrom-ChaosSteadyState -Text $SteadyState

# Not $mechanismProbe: the [hashtable]$MechanismProbe parameter shares that
# name case-insensitively, and the assignment would coerce this object
# into a hashtable, losing its declared field order.
$probeSpec = ConvertFrom-ChaosMechanismProbe -Table $MechanismProbe

$blastRadius = New-ChaosBlastRadius -Locations $FilterLocation -Zones $FilterZone -PhysicalZones $FilterPhysicalZone `
    -ExcludeResources $ExcludeResource -ExcludeTypes $ExcludeType -ExcludeTags $ExcludeTag

# A blast-radius filter that cannot be evaluated is a hard stop, not an empty
# scope: silently producing zero targets is indistinguishable from a workspace
# with nothing in it, and the operator would go looking for the wrong problem.
try {
    $projected = ConvertTo-ChaosList (Resolve-ChaosBlastRadiusResource -ScopedResources $scopedResources -BlastRadius $blastRadius)
}
catch {
    Write-ChaosStudyFailure -Title 'Blast-radius filter cannot be evaluated' `
        -Message ([string]$_.Exception.Message) `
        -Remediation 'Chaos Studio''s discoveredResources payload does not publish every attribute. Narrow the study with a selector the payload does carry - -ExcludeResource or -ExcludeType - rather than one the service never returns.'
    exit (Get-ChaosStudyExitCode -Name 'Error')
}

# -- Readiness -------------------------------------------------------------

$scopeTypesForGates = @(@($projected) | ForEach-Object { [string]$_.resourceType } | Where-Object { $_ } | Select-Object -Unique)

# Exercise arithmetic. The vulnerable window is only inferred from the injection
# window when the live action is continuous, because that is the one case where
# the configured duration really is how long the fault is present. For a discrete
# action the same number is an observation budget, and treating it as fault time
# is precisely the error Req F exists to prevent - so nothing is inferred and the
# gate reports the exposure as unknown until someone supplies it.
$actionType = if ($selectedAction.PSObject.Properties.Name -contains 'actionType') { [string]$selectedAction.actionType } else { '' }
$actionIsContinuous = (Test-ChaosActionIsContinuous -ActionType $actionType) -eq $true

$vulnerableWindow = $null
$exerciseAssumptions = @($ExerciseAssumption)
if ($PSBoundParameters.ContainsKey('VulnerableWindowSeconds')) {
    $vulnerableWindow = $VulnerableWindowSeconds
}
elseif ($actionIsContinuous) {
    $vulnerableWindow = $DurationMinutes * 60
    $exerciseAssumptions += "vulnerableWindowSeconds was inferred from the $DurationMinutes-minute injection window because '$($selectedAction.name)' is a $actionType action, so the fault is present for the whole window."
}

$exerciseModel = New-ChaosExerciseModel `
    -EventRatePerSecond $(if ($PSBoundParameters.ContainsKey('EventRatePerSecond')) { $EventRatePerSecond } else { $null }) `
    -VulnerableWindowSeconds $vulnerableWindow `
    -EligibleFraction $(if ($PSBoundParameters.ContainsKey('EligibleFraction')) { $EligibleFraction } else { $null }) `
    -Assumption $exerciseAssumptions

$readiness = Invoke-ChaosReadinessGates -Action $selectedAction `
    -Scenario $selectedScenario `
    -ScopedResourceTypes $scopeTypesForGates `
    -ScopedResources $projected `
    -Parameters $Parameters `
    -ActionParameters $ActionParameters `
    -SteadyState $predicate `
    -InjectMinutes $DurationMinutes `
    -AvailableSources $SignalSource `
    -FailureMechanism $FailureMechanism `
    -MechanismEvidence $MechanismEvidence `
    -MechanismProbe $probeSpec `
    -ExerciseModel $exerciseModel `
    -AcceptWeakExercise:$AcceptWeakExercise `
    -DiscoverySkipped:$SkipDiscovery `
    -DiscoveredCount $(if ($SkipDiscovery) { $null } else { @($scopedResources).Count })

$limitationCodes = @($readiness.limitationCodes)
if ($SkipDiscovery -and $limitationCodes -notcontains 'L10') { $limitationCodes += 'L10' }

foreach ($gate in $readiness.gates) {
    $marker = switch ($gate.status) { 'pass' { 'ok' } 'fail' { 'FAIL' } default { '??' } }
    Write-ChaosStudyNote -Message "[$marker] $($gate.title)$(if ($gate.status -ne 'pass') { " - $($gate.detail)" })"
}

Assert-ChaosReadiness -Readiness $readiness

# -- Freeze the plan -------------------------------------------------------
#
# Everything above this line is discovery. Everything below is a commitment.
# frozenConfigHash is computed last, over every field that precedes it, so the
# consent captured at run time provably refers to this exact configuration.

$effectiveScopes = if ($workspace) { @($workspace.scopes) } else { @($Scope) }

$scopeHash = Get-ChaosScopeHash -SubscriptionId $SubscriptionId -ResourceGroup $ResourceGroup `
    -WorkspaceName $WorkspaceName -Scope $effectiveScopes -Region $region

# -- Preflight configuration + effective legs (Req C) ----------------------
#
# Before any fault consent, validate a deterministic configuration and inspect
# the execution plan the platform computes for it. A scenario that would run
# nothing, or fewer legs than its name implies, is caught here rather than after
# a change window has already been spent. The study directory is created now so
# the preflight configuration is recorded in this study's residue ledger.

$study = New-ChaosStudy -ScopeHash $scopeHash -StudyRoot $StudyRoot
Move-ChaosStudyStaging -StudyPath $study.path -StagingPath $stagingPath | Out-Null
$scenarioParameterList = ConvertTo-ChaosList (ConvertTo-ChaosScenarioParameter -Table $Parameters)
# Deliberately NOT named $actionParameters: PowerShell variable names are
# case-insensitive, so that would bind to the [hashtable]$ActionParameters
# parameter and throw converting Object[] to Hashtable - after every gate had
# already passed. Locals derived from a typed parameter always take a distinct
# name, and the static check suite fails the build if one shadows a typed param.
$actionParameterList = ConvertTo-ChaosList (ConvertTo-ChaosScenarioParameter -Table $ActionParameters)
$declaredVsEffective = $null

if (-not $SkipDiscovery) {
    Write-ChaosStudyNote -Message "Validating a preflight configuration for scenario '$($selectedScenario.name)' to see which legs would actually run."

    $preflight = New-ChaosPreflightConfiguration -StudyId $study.studyId `
        -ResourceGroup $ResourceGroup -WorkspaceName $WorkspaceName -ScenarioName $selectedScenario.name `
        -Parameters $scenarioParameterList -BlastRadius $blastRadius -Adapter $Adapter -StudyPath $study.path

    $effectiveLegs = Resolve-ChaosEffectiveLegs -ExecutionPlan $preflight.executionPlan

    Assert-ChaosScenarioNameHonest -ScenarioName $selectedScenario.name -DisplayName $selectedScenario.displayName -EffectiveLegs $effectiveLegs | Out-Null

    $legsDecision = Assert-ChaosEffectiveLegs -EffectiveLegs $effectiveLegs -ScopeHash $scopeHash `
        -ScenarioName $selectedScenario.name -AcceptPartialScenario $AcceptPartialScenario `
        -DeclaredExclusions (@($ExcludeResource) + @($ExcludeType) + @($ExcludeTag))

    if ($legsDecision.limitationCodes -contains 'L11' -and $limitationCodes -notcontains 'L11') {
        $limitationCodes += 'L11'
    }

    # The effective plan is what a run must reproduce exactly before it may
    # start. Scope and run now compute this from the SAME code path
    # (Get-ChaosEffectivePlanHash), so equality means "the same legs execute"
    # rather than "two similar projections happened to agree".
    # Computed before the residue entry so the ledger records the real hash, not null.
    $effectivePlanProjection = @(Get-ChaosEffectivePlanProjection -EffectiveLegs $effectiveLegs)
    $effectivePlanHash = Get-ChaosDigest -InputObject $effectivePlanProjection

    Add-ChaosPreflightResidueEntry -StudyPath $study.path -ConfigurationName $preflight.name `
        -Workspace ([pscustomobject]@{ resourceGroup = $ResourceGroup; name = $WorkspaceName; scenario = $selectedScenario.name }) `
        -Adapter $Adapter -ValidationStatus $preflight.status -EffectivePlanHash $effectivePlanHash | Out-Null

    # Only when this study created it. A reused workspace is someone else's
    # resource and must never be listed here as ours to remove.
    if ($workspaceCreated) {
        Add-ChaosWorkspaceResidueEntry -StudyPath $study.path -WorkspaceName $WorkspaceName -ResourceGroup $ResourceGroup `
            -WorkspaceId ([string]$workspace.id) -SubscriptionId $SubscriptionId -Adapter $Adapter | Out-Null
    }

    Add-ChaosCommandTrailEntry -StudyPath $study.path -Command 'az chaos scenario config validate' -Phase 'scope' `
        -Arguments @($preflight.name, "executable=$($effectiveLegs.executable)", "total=$($effectiveLegs.total)") `
        -ExitCode 0 -Note "preflight legs $($effectiveLegs.executable) of $($effectiveLegs.total)" | Out-Null

    $declaredVsEffective = [ordered]@{
        adapter    = $Adapter
        preflight  = [ordered]@{
            configurationName = $preflight.name
            validationStatus  = $preflight.status
            # Digest of the exact configuration body that was validated. The run
            # rebuilds the body from this plan and refuses to execute unless it
            # digests to this - so the blast radius that was reviewed is provably
            # the blast radius that executes.
            bodyDigest        = $preflight.bodyDigest
            # What-if only. Present when preflight validation failed and the
            # service named the grants it would need; null when it validated or
            # when the service named nothing. Never a grant that was applied -
            # applying one is a separate, separately consented decision at run time.
            permissionPreview = $preflight.permissionPreview
        }
        decision   = $legsDecision.kind
        accepted   = [bool]$legsDecision.accepted
        legs       = [ordered]@{
            total      = $effectiveLegs.total
            executable = $effectiveLegs.executable
            skipped    = @($effectiveLegs.skipped)
        }
    }
    $declaredVsEffective['effectivePlanHash'] = $effectivePlanHash
    # The legs the hash was taken over, not merely their digest. A run that
    # refuses on a hash mismatch can then say WHICH leg changed instead of
    # only that something did - and a reader can audit the frozen plan
    # without re-deriving it from the service.
    $declaredVsEffective['effectivePlan'] = @($effectivePlanProjection)

    if ($null -ne $preflight.permissionPreview) {
        Add-ChaosCommandTrailEntry -StudyPath $study.path -Command 'az chaos scenario config fix-permissions --what-if' -Phase 'scope' `
            -Arguments @($preflight.name) -ExitCode 0 -Note 'preview only; nothing granted' | Out-Null
        Write-ChaosStudyNote -Message 'Preflight validation failed on access. The grants it would need are previewed in the plan; approving them is a separate step at run time.' -Level 'warn'
    }
}
else {
    # Discovery was skipped, so there is no execution plan to inspect. The
    # legs are unknown, not empty, and the plan already carries L10 to say so.
    $declaredVsEffective = [ordered]@{
        adapter           = $Adapter
        preflight         = $null
        decision          = 'unknown'
        accepted          = $false
        legs              = [ordered]@{ total = $null; executable = $null; skipped = @() }
        effectivePlanHash = $null
        effectivePlan     = @()
    }
}

$plan = [ordered]@{
    planVersion = $ChaosStudyPlanVersion
    createdAt   = Get-ChaosUtcNow
    scopeHash   = $scopeHash
    adapter     = $Adapter

    question    = [ordered]@{
        hypothesis  = if ($Hypothesis) { $Hypothesis } else { "The system holds $($predicate.raw) while '$($selectedAction.name)' is injected." }
        steadyState = $predicate
    }

    mechanism   = [ordered]@{
        # Frozen falsifiability inputs. Presence and traceability were enforced
        # by Test-ChaosMechanismTraceable before this plan was written; the
        # report proves the probe over the actual action window, and never
        # accepts unrelated signal movement as proof.
        failureMechanism    = if ([string]::IsNullOrWhiteSpace($FailureMechanism)) { $null } else { $FailureMechanism.Trim() }
        mechanismEvidence   = if ([string]::IsNullOrWhiteSpace($MechanismEvidence)) { $null } else { $MechanismEvidence.Trim() }
        mechanismProbe      = $probeSpec
    }

    exercise    = [ordered]@{
        # Frozen exposure arithmetic. Its assumptions travel with it so a
        # reviewer can disagree with the forecast, and weakAccepted records that
        # a study known to prove little was run deliberately - which the report
        # must repeat rather than presenting the run as a passed test.
        model        = $exerciseModel
        weakAccepted = [bool]$AcceptWeakExercise
    }

    workspace   = [ordered]@{
        subscriptionId      = $SubscriptionId
        resourceGroup       = $ResourceGroup
        name                = $WorkspaceName
        id                  = $workspaceId
        location            = if ($workspace) { $workspace.location } else { $Location }
        provisioningState   = if ($workspace) { $workspace.provisioningState } else { $null }
        identityType        = if ($workspace) { $workspace.identityType } else { $null }
        identityPrincipalId = if ($workspace) { $workspace.principalId } else { $null }
        scopes              = @($effectiveScopes)
        createdByThisStudy  = $workspaceCreated
    }

    scope       = [ordered]@{
        region                 = $region
        # A skipped discovery means the counts are unknown, not zero. Recording 0
        # would let the consent card, the report and the readiness gates all claim
        # a verified-empty scope that nobody ever verified.
        discoveredResourceCount = $(if ($SkipDiscovery) { $null } else { @($scopedResources).Count })
        resourceTypes          = @(@($scopedResources) | ForEach-Object { [string]$_.resourceType } | Where-Object { $_ } | Select-Object -Unique)
        resources              = @($scopedResources)
        blastRadius            = [ordered]@{
            filters    = $blastRadius.filters
            exclusions = $blastRadius.exclusions
        }
        projectedResourceCount = $(if ($SkipDiscovery) { $null } else { @($projected).Count })
        projectedResources     = @(@($projected) | ForEach-Object { [string]$_.resourceId })
    }

    scenario    = [ordered]@{
        source               = if ($selectedScenario.discovered) { 'live-recommendation' } else { 'unverified-offline' }
        id                   = $selectedScenario.id
        name                 = $selectedScenario.name
        displayName          = $selectedScenario.displayName
        description          = $selectedScenario.description
        version              = $selectedScenario.version
        recommendationStatus = $selectedScenario.recommendationStatus
        parameterSpec        = @($selectedScenario.parameters)
        parameters           = @($scenarioParameterList)
    }

    declaredVsEffective = $declaredVsEffective

    action      = [ordered]@{
        # Every field below came from the service's own action record.
        source           = if ($selectedAction.discovered) { 'live-discovery' } else { 'unverified-offline' }
        name             = $selectedAction.name
        canonicalId      = $selectedAction.canonicalId
        displayName      = $selectedAction.displayName
        description      = $selectedAction.description
        actionType       = $selectedAction.actionType
        version          = $selectedAction.version
        appliesTo        = @($selectedAction.appliesTo)
        recommendedRoles = @($selectedAction.recommendedRoles)
        parametersSchema = $selectedAction.parametersSchema
        # Action parameters are frozen separately from the scenario's: they are
        # validated against a different schema and must be reproduced exactly on
        # rerun, so they cannot share one bucket.
        parameters       = @($actionParameterList)
    }

    windows     = [ordered]@{
        baselineMinutes = $BaselineMinutes
        # How long this study watches, and only that. The fault's own length
        # is recorded beside it, never merged into it.
        injectMinutes   = $DurationMinutes
        recoveryMinutes = $RecoveryMinutes
        interval        = 60
    }

    # What the platform actually injects for, resolved from the live scenario
    # contract, plus the acknowledgement that was given for it. Kept separate
    # from `windows` so no reader can mistake the observation budget for the
    # fault's length - the confusion this field exists to end.
    faultDuration = [ordered]@{
        source                   = $faultDuration.source
        parameterName            = $faultDuration.parameterName
        rawValue                 = $faultDuration.rawValue
        seconds                  = $faultDuration.seconds
        observationBudgetSeconds = $faultDuration.observationBudgetSeconds
        exceedsObservationBudget = $faultDuration.exceedsObservationBudget
        acknowledged             = [bool]$faultDuration.acknowledged
        acknowledgedSeconds      = $faultDuration.acknowledgedSeconds
        reason                   = $faultDuration.reason
        statement                = $faultDuration.statement
    }

    safety      = [ordered]@{
        reversible      = ($selectedAction.actionType -and $selectedAction.actionType -ine 'Discrete')
        requiresConsent = $true
        abortConditions = @(
            "Steady state $($predicate.raw) is breached beyond the recovery window."
            'Any signal source stops reporting for longer than two intervals.'
        )
    }

    signals     = [ordered]@{
        configuredSources = @($SignalSource)
    }

    readiness   = [ordered]@{
        gates           = @($readiness.gates)
        limitationCodes = @($limitationCodes)
    }

    discovery   = [ordered]@{
        region                  = $region
        endpoint                = if ($region) { "Microsoft.Chaos/locations/$region/actions" } else { $null }
        apiVersion              = Get-ChaosApiVersion -Name 'chaosActions'
        actionsFound            = $availableActions.Count
        scenariosFound          = @($scenarios).Count
        discoveredResourceCount = $(if ($SkipDiscovery) { $null } else { @($scopedResources).Count })
        workspaceEvaluation     = $evaluation
        performedAt             = $discoveryPerformedAt
    }
}

$plan['frozenConfigHash'] = Get-ChaosDigest -InputObject $plan

# -- Persist ---------------------------------------------------------------

Save-ChaosStudyArtifact -StudyPath $study.path -RelativePath (Get-ChaosArtifactFileName -Artifact 'plan') -Content $plan | Out-Null

Add-ChaosCommandTrailEntry -StudyPath $study.path -Command 'chaos-study-scope' `
    -Arguments ([ordered]@{
        workspace     = $WorkspaceName
        scenario      = $selectedScenario.name
        action        = $selectedAction.name
        region        = $region
        skipDiscovery = [bool]$SkipDiscovery
    }) `
    -ExitCode 0 -Note "Plan frozen at $($plan['frozenConfigHash'])" | Out-Null

# -- Report ----------------------------------------------------------------

$planPath = Resolve-ChaosStudyPath -StudyRoot $study.studyRoot -ScopeHash $scopeHash -StudyId $study.studyId -Artifact 'plan'
$actionTypeText = if ($selectedAction.actionType) { $selectedAction.actionType } else { 'unknown type' }
$regionText = if ([string]::IsNullOrWhiteSpace($region)) { 'region not resolved' } else { $region }
$urnText = if ([string]::IsNullOrWhiteSpace($selectedAction.canonicalId)) { 'not resolved (discovery skipped)' } else { $selectedAction.canonicalId }
$resourceText = if ($SkipDiscovery) { 'not resolved (discovery skipped)' } else { "$(@($projected).Count) of $(@($scopedResources).Count) discovered resource(s) after filters" }

$summary = @(
    "Study       $($study.studyId)"
    "Scope       $scopeHash"
    "Workspace   $WorkspaceName ($ResourceGroup) in $regionText"
    "Resources   $resourceText"
    "Scenario    $($selectedScenario.name)"
    "Action      $($selectedAction.displayName)  [$actionTypeText]"
    "URN         $urnText"
    "Objective   $($predicate.raw)"
    "Windows     $BaselineMinutes m baseline, $DurationMinutes m observe, $RecoveryMinutes m recovery"
    "Fault runs  $($faultDuration.statement)"
    "Frozen at   $($plan['frozenConfigHash'])"
    "Plan        $planPath"
) -join "`n"

Write-ChaosStudyCard -Title 'Study planned - nothing has been injected' -Body $summary

$advisories = @($readiness.gates | Where-Object { $_.status -ne 'pass' })
if ($advisories.Count -gt 0) {
    Write-Output ''
    Write-Output '### Caveats carried into this study'
    foreach ($advisory in $advisories) {
        Write-Output "- **$($advisory.title)** ($($advisory.status)): $($advisory.detail)"
    }
}

if ($limitationCodes.Count -gt 0) {
    Write-ChaosStudyNote -Message ('The report will carry limitations: ' + ($limitationCodes -join ', ') + '.')
}

if (@($SignalSource).Count -eq 0) {
    Write-ChaosStudyNote -Message 'No signal source configured. This study can only show that the control plane accepted the scenario run, never that the fault reached the workload.' -Level 'warn'
}

Write-Output ''
Write-Output 'Next: review the plan, then run it with explicit consent.'
Write-Output "  chaos-study-run  -StudyId $($study.studyId) -DryRun:`$false -Consent '<typed consent>'"

exit (Get-ChaosStudyExitCode -Name 'Success')
