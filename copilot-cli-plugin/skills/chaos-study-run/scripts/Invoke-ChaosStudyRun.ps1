#Requires -Version 7.0
<#
.SYNOPSIS
    Execute a frozen chaos study plan as a Chaos Studio V2 scenario run, and
    record what happened.

.DESCRIPTION
    This is the only script in the suite that changes production. It is
    therefore the most conservative one:

      * It refuses to run a plan that changed after it was frozen.
      * It does nothing without an explicit, plan-specific consent phrase.
      * It defaults to a dry run, so the unarmed path is the default path.
      * It refuses to execute a scenario configuration that did not validate.
      * It cancels the scenario run and deletes the configuration it created,
        even on failure.

    Evidence is collected in three windows - before, during and after - and
    written verbatim. A signal that could not be read is recorded as null with
    a reason. Nothing is inferred, interpolated or filled in.

.EXAMPLE
    ./Invoke-ChaosStudyRun.ps1
    Previews the latest planned study without touching anything.

.EXAMPLE
    ./Invoke-ChaosStudyRun.ps1 -DryRun:$false -Consent 'inject <action> into <workspace> 3d1f87dd'
    Runs it.
#>

[CmdletBinding()]
param(
    [string]$StudyId = 'latest',
    [string]$StudyRoot,
    [bool]$DryRun = $true,
    [string]$Consent,
    [string[]]$SignalSource = @(),
    [int]$PollSeconds = 20,
    [switch]$KeepConfiguration,
    [switch]$Force,
    [ValidateSet('local-az', 'external')][string]$Adapter,
    [string]$ApprovePermissions
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$libDir = Join-Path $PSScriptRoot 'lib'
$sharedLib = Join-Path $PSScriptRoot '..' '..' 'chaos-study' 'scripts' 'lib'
. (Join-Path $sharedLib 'Common.ps1')
. (Join-Path $sharedLib 'ApiVersions.ps1')
. (Join-Path $sharedLib 'Study.ps1')
. (Join-Path $sharedLib 'Exercise.ps1')
. (Join-Path $sharedLib 'AbortCriteria.ps1')
. (Join-Path $libDir 'Signals.ps1')
. (Join-Path $libDir 'Execute.ps1')

# -- Locate the study ------------------------------------------------------

$findArgs = @{ StudyId = $StudyId }
if ($StudyRoot) { $findArgs['StudyRoot'] = $StudyRoot }
$study = Find-ChaosStudy @findArgs

if (-not $study) {
    Write-ChaosStudyFailure -Title 'No study to run' -Message @"
Could not find a study matching '$StudyId'.
"@ -Remediation 'Run the chaos-study-scope skill first to plan a study.'
    exit (Get-ChaosStudyExitCode -Name 'Error')
}

$studyPath = $study.path
$plan = Read-ChaosJsonFile -Path (Get-ChaosArtifactReader -StudyPath $studyPath -Artifact 'plan').path

if (-not $plan) {
    Write-ChaosStudyFailure -Title 'Study has no plan' -Message @"
Study $($study.studyId) exists but contains no study plan, so there is nothing
to execute.
"@ -Remediation 'Re-run the chaos-study-scope skill for this workspace.'
    exit (Get-ChaosStudyExitCode -Name 'Error')
}

if ($study.state -eq 'SEALED') {
    Write-ChaosStudyFailure -Title 'Study is sealed' -Message @"
Study $($study.studyId) has already been reported and sealed. Sealed studies are
immutable so that a report always describes the run it was generated from.
"@ -Remediation 'Run the chaos-study-scope skill to plan a fresh study, then run that one.'
    exit (Get-ChaosStudyExitCode -Name 'StudyAlreadySealed')
}

if ($study.state -eq 'EXECUTED' -and -not $DryRun) {
    # Checked BEFORE the -Force gate on purpose. `run start` is not idempotent, so
    # if the service accepted a start whose id we never learned, re-arming would
    # inject a second fault on top of one that may still be running. -Force means
    # "overwrite my evidence", never "start another fault blind".
    $acceptedReader = Get-ChaosArtifactReader -StudyPath $studyPath -Artifact 'runRecord'
    if ($acceptedReader.found) {
        $acceptedRecord = Read-ChaosJsonFile -Path $acceptedReader.path
        if ($acceptedRecord -and $acceptedRecord.PSObject.Properties['scenarioRun'] -and $acceptedRecord.scenarioRun `
                -and [string]::IsNullOrWhiteSpace([string]$acceptedRecord.scenarioRun.runId) `
                -and $acceptedRecord.scenarioRun.PSObject.Properties['accepted'] `
                -and [bool]$acceptedRecord.scenarioRun.accepted) {
            Write-ChaosStudyFailure -Title 'A scenario run was accepted but never identified' -Message @"
Study $($study.studyId) started a scenario run that Azure accepted, but the run id
was never resolved. That run may still be executing. Starting again would inject a
second fault on top of it.
"@ -Remediation 'List the runs on this scenario, confirm the accepted run has stopped, then plan a new study. -Force does not bypass this.'
            exit (Get-ChaosStudyExitCode -Name 'Error')
        }
    }
}

if ($study.state -eq 'EXECUTED' -and -not $Force -and -not $DryRun) {
    # A run record exists - but a record is written even when the run never
    # started (configuration refused, consent withdrawn, permissions denied).
    # Blocking on the record alone strands a study that holds no evidence and
    # forces -Force, which is the flag that DOES overwrite real evidence.
    # Only a recorded runId means something actually ran.
    $priorRunId = $null
    $priorReader = Get-ChaosArtifactReader -StudyPath $studyPath -Artifact 'runRecord'
    if ($priorReader.found) {
        $priorRecord = Read-ChaosJsonFile -Path $priorReader.path
        if ($priorRecord -and $priorRecord.PSObject.Properties['scenarioRun'] -and $priorRecord.scenarioRun) {
            $priorRunId = [string]$priorRecord.scenarioRun.runId
        }
    }

    if (-not [string]::IsNullOrWhiteSpace($priorRunId)) {
        Write-ChaosStudyFailure -Title 'Study has already been executed' -Message @"
Study $($study.studyId) already holds run $priorRunId. Running it again would
overwrite evidence from the first execution.
"@ -Remediation 'Plan a new study, or pass -Force if you intend to overwrite this one.'
        exit (Get-ChaosStudyExitCode -Name 'Error')
    }

    Write-ChaosStudyNote -Level 'warn' -Message @"
A run record exists for study $($study.studyId) but it names no scenario run, so
nothing was ever injected and there is no evidence to lose. Re-arming it.
"@
}

Assert-ChaosPlanIntegrity -Plan $plan | Out-Null

$configurationName = Get-ChaosStudyConfigurationName -StudyId $study.studyId
$sources = @($SignalSource)
if ($sources.Count -eq 0 -and $plan.signals.configuredSources) {
    $sources = @($plan.signals.configuredSources)
}

# Two different counts, and only one of them is the blast radius.
#
# `projectedResourceCount` is how many resources the discovery pass found in
# the workspace. The number that matters is how many legs the execution plan
# will actually run, which is what the service resolved from the frozen
# configuration - on a real run those differed 14 to 1, and the panel showed
# the 14.
#
# $null means unknown, never zero: a plan scoped with -SkipDiscovery has no
# effective count, and rendering that as "0 targets" would read as a study
# that touches nothing.
$effectiveCount = $null
$effectiveCountKnown = $false
if ($plan.PSObject.Properties['declaredVsEffective'] -and $plan.declaredVsEffective) {
    $dve = $plan.declaredVsEffective
    if ($dve.PSObject.Properties['legs'] -and $dve.legs) {
        if ($dve.legs.PSObject.Properties['executable']) {
            $effectiveCount = $dve.legs.executable
            $effectiveCountKnown = ($null -ne $effectiveCount)
        }
    }
}

# Workspace inventory stays on screen as context, clearly secondary.
$discoveryCount = $plan.scope.projectedResourceCount
$discoveryText = if ($null -eq $discoveryCount) { '(not resolved)' } else { "$discoveryCount of $($plan.scope.discoveredResourceCount) discovered" }

$targetText = if ($effectiveCountKnown) {
    $noun = if ([int]$effectiveCount -eq 1) { 'target' } else { 'targets' }
    "$effectiveCount $noun the service will act on (from $discoveryText)"
}
else {
    "(not resolved) - discovery saw $discoveryText"
}

# The observation budget and the fault's actual length are different numbers.
# Labelling the budget "Injection" is what let a "5-minute study" configure a
# 15-minute fault, so both are shown, named for what they are.
$faultDurationText = '(not recorded by this plan)'
if ($plan.PSObject.Properties['faultDuration'] -and $plan.faultDuration) {
    if (-not [string]::IsNullOrWhiteSpace([string]$plan.faultDuration.statement)) {
        $faultDurationText = [string]$plan.faultDuration.statement
    }
}

# Anything the local projection could not verify - a declared filter the
# service will enforce, a resource whose zone discovery never reported. The
# operator sees it before consenting, not afterwards in the report.
$projectionSummary = @()
if ($plan.scope.PSObject.Properties['projectionSummary']) {
    $projectionSummary = @($plan.scope.projectionSummary | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) })
}

# -- Abort criteria --------------------------------------------------------
#
# Read from the frozen plan, not regenerated here, so what the operator is
# asked to watch for is what was agreed when the plan was scoped and consented
# to. A plan frozen before this field existed has no record either way, which
# is reported as unknown rather than assumed to be fine.
#
# The structured half - signal, condition, resource correlation - is what the
# poll loop below actually measures against. It is carried through verbatim
# from the frozen plan; nothing here derives a threshold, because a number this
# script invented is not a stop rule the customer agreed to.
$abortStated = $false
$abortStatement = $null
$abortSource = 'unknown'
$abortMonitored = $false
$abortWatch = $null
$abortReason = 'This plan predates structured abort criteria. Re-run chaos-study-scope to record the stop rule the customer stated.'
$abortRecorded = $false
$abortArmable = $false
$abortCriterion = $null
if ($plan.safety.PSObject.Properties['abortCriteria'] -and $plan.safety.abortCriteria) {
    $abortRecorded = $true
    $ac = $plan.safety.abortCriteria
    $abortCriterion = $ac
    $abortArmable = [bool](Get-ChaosMember -InputObject $ac -Name 'evaluable')
    $abortStated = [bool](Get-ChaosMember -InputObject $ac -Name 'stated')
    $abortStatement = [string](Get-ChaosMember -InputObject $ac -Name 'statement')
    if ([string]::IsNullOrWhiteSpace($abortStatement)) { $abortStatement = $null }
    $rawSource = [string](Get-ChaosMember -InputObject $ac -Name 'source')
    if (-not [string]::IsNullOrWhiteSpace($rawSource)) { $abortSource = $rawSource }
    $abortMonitored = [bool](Get-ChaosMember -InputObject $ac -Name 'monitored')
    $abortWatch = [string](Get-ChaosMember -InputObject $ac -Name 'watch')
    if ([string]::IsNullOrWhiteSpace($abortWatch)) { $abortWatch = $null }
    $abortReason = [string](Get-ChaosMember -InputObject $ac -Name 'reason')
    if ([string]::IsNullOrWhiteSpace($abortReason)) { $abortReason = $null }
}

# The bounded safe policy for the monitor, named once so the dry run can state
# it and the poll loop can enforce exactly what was stated.
$abortUnmeasuredTolerance = 3
$abortLookbackMinutes = 5
if ($abortArmable -and -not $abortWatch -and $abortCriterion) {
    $abortWatch = (@(
        [string](Get-ChaosMember -InputObject $abortCriterion -Name 'signal')
        [string](Get-ChaosMember -InputObject $abortCriterion -Name 'conditionText')
    ) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }) -join ' '
    if ([string]::IsNullOrWhiteSpace($abortWatch)) { $abortWatch = $null }
}
$abortMonitored = [bool]($abortArmable -and $abortWatch)

# -- Dry run ---------------------------------------------------------------

if ($DryRun) {
    $phrase = Get-ChaosConsentPhrase -Plan $plan
    $previewWindow = New-ChaosWindow -Name 'preview' -Start (ConvertTo-ChaosUtcIso -Instant (Get-Date).ToUniversalTime().AddMinutes(-1)) -End (Get-ChaosUtcNow)
    $preview = Invoke-ChaosSignalCollection -Plan $plan -Window $previewWindow -Sources $sources -DryRun

    $blast = Get-ChaosBlastRadiusArgument -Plan $plan
    $configPreview = [ordered]@{
        workspace     = $plan.workspace.name
        resourceGroup = $plan.workspace.resourceGroup
        scenario      = $plan.scenario.name
        configuration = $configurationName
        parameters    = @(Get-ChaosScenarioParameterList -Plan $plan)
        filters       = $blast.filters
        exclusions    = $blast.exclusions
    }

    Write-ChaosStudyPanel -Title "Dry run - study $($study.studyId)" -Status 'info' -Body @"
Nothing has been injected. This is what would happen.

$($plan.question.hypothesis)
"@ -Properties ([ordered]@{
        'Workspace'          = "$($plan.workspace.name) ($($plan.workspace.resourceGroup))"
        'Region'             = if ($plan.scope.region) { $plan.scope.region } else { '(not resolved)' }
        'Targets'            = $targetText
        'Scenario'           = $plan.scenario.name
        'Action'             = $plan.action.displayName
        'Action URN'         = $(if ([string]::IsNullOrWhiteSpace($plan.action.canonicalId)) { '(not resolved - discovery skipped)' } else { [string]$plan.action.canonicalId })
        'Fault runs for'     = $faultDurationText
        'Observation budget' = "$($plan.windows.injectMinutes) minutes (how long evidence is collected, NOT the fault's length)"
        'Baseline'           = "$($plan.windows.baselineMinutes) minutes before injection"
        'Recovery'           = "$($plan.windows.recoveryMinutes) minutes after injection"
        'Configuration'      = $configurationName
    })

    foreach ($statement in $projectionSummary) {
        Write-ChaosStudyNote -Message ([string]$statement) -Level 'warn'
    }

    Write-ChaosStudyTable -Title 'Evidence that would be collected' -Data @(
        foreach ($signal in $preview) {
            [pscustomobject]@{
                Source = $signal.source
                Status = if ($signal.caveat) { $signal.caveat } else { 'would be collected' }
            }
        }
    )

    # Lead with the customer's own words. The derived conditions follow them so
    # nobody mistakes this suite's defaults for something a human agreed to.
    $abortLines = @()
    if ($abortStated -and $abortStatement) {
        $abortLines += "  - $abortStatement"
        $abortLines += '    (stated by the customer during the design interview)'
    }
    foreach ($condition in @($plan.safety.abortConditions)) {
        $line = "  - $condition"
        if ($abortStated -and $abortStatement -and $condition -like "*$abortStatement*") { continue }
        $abortLines += $line
    }
    if ($abortLines.Count -gt 0) {
        $abortBody = $abortLines -join "`n"
        if (-not $abortArmable) {
            $abortBody += "`n`nThis plan carries no measurable stop rule, so arming will be REFUSED."
            $abortBody += "`n$(if ($abortReason) { $abortReason } else { 'No signal, condition and resource correlation are recorded.' })"
            $abortBody += "`nEverything above is prose or a default this suite derived. Nothing here"
            $abortBody += "`nwill be inferred into a threshold on the customer's behalf."
        }
        else {
            $abortBody += "`n`nMeasured during injection, every $PollSeconds seconds: $abortWatch"
            $abortBody += "`nIf that condition is met the run is cancelled automatically, once, and"
            $abortBody += "`nthen tracked until it actually reaches a terminal state."
            $abortBody += "`nIf the signal cannot be measured for $abortUnmeasuredTolerance consecutive polls the run is also"
            $abortBody += "`ncancelled: an unreadable steady state is not a healthy one."
            $abortBody += "`nEverything else on this list is watched by the operator."
        }
        Write-ChaosStudyPanel -Title 'Abort if any of these happen' -Status 'warning' -Body $abortBody
    }

    Write-ChaosStudyPanel -Title 'To run it' -Status 'info' -Body @"
Injection requires a consent phrase that names the blast radius and pins this
exact plan. Type it exactly:

  $phrase
"@ -JsonPreview ($configPreview | ConvertTo-Json -Depth 20)

    Write-ChaosStudyNote -Message 'Dry run complete. Nothing was changed.'
    exit (Get-ChaosStudyExitCode -Name 'Success')
}

# -- Armed path ------------------------------------------------------------

Assert-ChaosConsent -Plan $plan -Consent $Consent | Out-Null

if ($plan.discovery.region -and $plan.scope.region -and -not $Force) {
    # Discovery and the resolved scope must agree, or the action list this plan
    # was chosen from describes a different region than the one that will run.
    if ($plan.discovery.region -ne $plan.scope.region) {
        Write-ChaosStudyFailure -Title 'Plan region is inconsistent' -Message @"
This plan discovered actions in region '$($plan.discovery.region)' but its scope
resolves to '$($plan.scope.region)'. The action chosen may not exist in the
region that would actually run.
"@ -Remediation 'Re-run chaos-study-scope so discovery and scope agree, or pass -Force to proceed anyway.'
        exit (Get-ChaosStudyExitCode -Name 'ScopeUnverified')
    }
}

# Zero legs is the empty-run case, and the effective plan is the honest source
# for it: a workspace can hold fourteen resources while the frozen configuration
# resolves to none of them. Unknown is not zero - a plan scoped with discovery
# skipped has no effective count and must not be refused for it.
if ($effectiveCountKnown -and [int]$effectiveCount -eq 0 -and -not $Force) {
    Write-ChaosStudyFailure -Title 'Nothing is in scope' -Message @"
The effective execution plan resolves to zero targets. Discovery saw
$discoveryText, but after filters and exclusions the service would act on
nothing. A scenario run against an empty scope succeeds without touching
anything, which would produce a report claiming resilience that was never
tested.
"@ -Remediation 'Re-run chaos-study-scope with a wider scope or fewer exclusions, or pass -Force to record the empty run deliberately.'
    exit (Get-ChaosStudyExitCode -Name 'ScopeUnverified')
}
elseif (-not $effectiveCountKnown -and $plan.scope.projectedResourceCount -eq 0 -and -not $Force) {
    # No effective plan to read, so fall back to the discovery count rather than
    # arming blind.
    Write-ChaosStudyFailure -Title 'Nothing is in scope' -Message @"
This plan has no effective execution plan to check, and discovery reached zero
resources. A scenario run against an empty scope succeeds without touching
anything, which would produce a report claiming resilience that was never
tested.
"@ -Remediation 'Re-run chaos-study-scope with a wider scope or fewer exclusions, or pass -Force to record the empty run deliberately.'
    exit (Get-ChaosStudyExitCode -Name 'ScopeUnverified')
}

# An abort criterion nobody stated is not one, and one nobody can measure is
# not enforceable. Refusing here rather than printing generic boilerplate is the
# point: the operator is about to watch a live fault, and "stop if it looks bad"
# is not something a poll loop can act on.
#
# Deliberately NOT inventing a threshold from the customer's prose. "Stop if
# the store front starts erroring" stays the sentence the customer said; turning
# it into errorRate > 0.05 would put a number in front of a fault that nobody
# signed off.
#
# There is no -Force path out of this. A waiver here would be indistinguishable
# from arming an unmonitored fault, which is the exact failure this gate exists
# to prevent.
if (-not $abortArmable) {
    $abortRemediation = if (-not $abortRecorded) {
        'This plan was frozen before abort criteria were recorded. Re-run chaos-study-scope to produce a plan that carries them.'
    }
    elseif ($abortStated) {
        "The customer's stop rule is recorded as prose and cannot be evaluated. Re-run chaos-study-scope with -AbortCriteria giving the signal, the condition and the resource it applies to, confirmed with the customer - for example: signal=orderSuccessPercent; condition=< 90; resource=storefront."
    }
    else {
        'Re-run chaos-study-design and answer the abort question, then re-scope. Or pass -AbortCriteria to chaos-study-scope with the stop rule the customer stated.'
    }

    Write-ChaosStudyFailure -Title 'No enforceable abort criterion to arm against' -Message @"
$(if ($abortReason) { $abortReason } else { 'This plan carries no measurable customer-stated abort criterion.' })
$(if ($abortStatement) { "`nRecorded statement: $abortStatement`nIt is kept verbatim. No threshold will be inferred from it." } else { '' })
Injection is about to start and there is no stop rule this run can measure.
Arming would mean the fault runs with nothing watching it, so it is refused.
"@ -Remediation $abortRemediation
    exit (Get-ChaosStudyExitCode -Name 'ScopeUnverified')
}

if (Get-Command Ensure-AzLogin -ErrorAction SilentlyContinue) { Ensure-AzLogin | Out-Null }

$startedAt = Get-ChaosUtcNow
Add-ChaosCommandTrailEntry -StudyPath $studyPath -Phase 'run' -Command 'Invoke-ChaosStudyRun' `
    -Note "consented; configuration $configurationName in workspace $($plan.workspace.name)" | Out-Null

# The baseline window is fixed here, but read later. It covers the minutes
# immediately before anything was touched, so bounding it now keeps it honest
# even though configuration and validation happen first.
$preWindow = New-ChaosWindow -Name 'pre' -Start (ConvertTo-ChaosUtcIso -Instant (Get-Date).ToUniversalTime().AddMinutes(-1 * $plan.windows.baselineMinutes)) -End $startedAt

$injectStart = $null
$injectEnd = $null
$configurationCreated = $false
$configurationResidueKind = $null
$runId = $null
$runObservation = $null
# RJ-1. A `run start --no-wait` that returns 200 with no parsable body leaves the
# fault RUNNING while the suite holds no run id. These three track that state
# separately from `$runId` so the finally block can tell "never started" (safe to
# clean up) apart from "started, identity unknown" (must NOT be cleaned up).
$runAccepted = $false
$runTracked = $false
$runIdentification = $null
$validationStatus = $null
$permissionFix = $null
$outcome = 'unknown'
$failureMessage = $null
# Seeded because the run record is written even when the try block fails part
# way through, and an unassigned variable would fault under Set-StrictMode
# while reporting a failure - hiding the failure behind a scripting error.
$preEvidence = @()
$duringEvidence = @()

try {
    # Configuration and validation come first. A configuration that cannot
    # validate is a run that fails within seconds, and discovering that after a
    # baseline window has already elapsed wastes the window and leaves a study
    # that has to be planned again from scratch.
    #
    # Reuse the validated preflight configuration when it still matches the
    # scoped effective plan; otherwise re-create one and prove its effective plan
    # is identical before validating. Either way, what runs is provably what was
    # scoped and consented to.
    Write-ChaosStudyNote -Message "Resolving the scenario configuration for $configurationName."
    $resolvedConfig = Resolve-ChaosRunConfiguration -Plan $plan -ConfigurationName $configurationName -Adapter $Adapter -StudyPath $studyPath -PermissionApproval $ApprovePermissions
    $configurationName = $resolvedConfig.configurationName
    if (-not $resolvedConfig.reused) {
        $configurationCreated = $true
        $configurationResidueKind = 'executionConfiguration'
        Add-ChaosExecutionResidueEntry -StudyPath $studyPath -ConfigurationName $configurationName `
            -Workspace $plan.workspace -Adapter $Adapter | Out-Null
        Add-ChaosCommandTrailEntry -StudyPath $studyPath -Phase 'run' -Command 'az chaos scenario config create' `
            -Arguments @($configurationName) -ExitCode 0 | Out-Null
    } else {
        # The preflight configuration created during scope is what runs. It is
        # still this study's residue, so cleanup targets that ledger entry
        # rather than leaving it behind under a different kind.
        $configurationResidueKind = 'preflightConfiguration'
    }

    $validation = $resolvedConfig.validation
    $validationStatus = $resolvedConfig.status
    $permissionFix = $resolvedConfig.permissionFix

    if ($null -ne $permissionFix) {
        Add-ChaosCommandTrailEntry -StudyPath $studyPath -Phase 'run' -Command 'az chaos scenario config fix-permissions --what-if' `
            -Arguments @($configurationName, "applicable=$($permissionFix.applicable)", "approved=$($permissionFix.approved)") -ExitCode 0 | Out-Null
        Save-ChaosStudyArtifact -StudyPath $studyPath -RelativePath 'permission-approval.json' -Content $permissionFix | Out-Null
    }

    if ($resolvedConfig.approvalRequired) {
        # Injection consent has already been given, and it is not enough. A role
        # assignment outlives this study and changes who can reach these resources
        # afterwards, so it gets its own decision, made against the grants the
        # service actually named. The study stops here and can be resumed with the
        # approval; nothing has been granted and nothing has been injected.
        $grants = $resolvedConfig.grantSet
        Write-ChaosStudyCard -Title 'Permission approval required before this study can run' -Body @"
The scenario configuration did not validate because the workspace identity is
missing access. Chaos Studio previewed the grants it needs. Nothing has been
changed - this is a preview.

$(Format-ChaosPermissionFixSummary -Summary $permissionFix.preview)
  - workspace: $($grants.workspace)
  - recommended roles: $(if ($null -eq $grants.recommendedRoles) { 'not reported by the service' } else { ($grants.recommendedRoles -join ', ') })
  - scopes: $(if ($null -eq $grants.scopes) { 'not reported by the service' } else { ($grants.scopes -join ', ') })

These grants persist after the study ends. Approving them is a separate decision
from approving the fault, and neither implies the other.

To approve them, re-run this study adding:

  -ApprovePermissions '$($resolvedConfig.approvalPhrase)'

The phrase is bound to the grants above. If the preview changes, it stops working
and you will be asked again.
"@
        exit (Get-ChaosStudyExitCode -Name 'PermissionApprovalRequired')
    }

    Assert-ChaosConfigurationValidated -Validation $validation -ConfigurationName $configurationName | Out-Null

    Write-ChaosStudyNote -Message "Collecting baseline evidence over the $($plan.windows.baselineMinutes) minutes before this run began."
    $preEvidence = Invoke-ChaosSignalCollection -Plan $plan -Window $preWindow -Sources $sources
    Save-ChaosStudyArtifact -StudyPath $studyPath -RelativePath 'evidence/pre/signals.json' -Content $preEvidence | Out-Null

    Write-ChaosStudyNote -Message 'Starting the scenario run.'
    $injectStart = Get-ChaosUtcNow
    # Enumeration may only identify the run when this execution created the
    # configuration itself. Reusing the preflight configuration means a
    # concurrent caller could be starting a run on it too, which no amount of
    # list diffing can disambiguate.
    $started = Start-ChaosStudyScenarioRun -Plan $plan -ConfigurationName $configurationName -Validation $validation -ConfigurationExclusive (-not $resolvedConfig.reused) -Adapter $Adapter -StudyPath $studyPath
    # The call returned, so Azure ACCEPTED the start. That is true whether or not
    # we managed to learn the run id, and it is the fact the rest of this block
    # has to respect: a fault is live either way.
    $runAccepted = $true
    $runId = $started.runId
    $runTracked = [bool]$started.tracked
    $runIdentification = [pscustomobject]@{
        tracked     = $runTracked
        resolution  = [string]$started.resolution
        reason      = [string]$started.reason
        candidates  = ConvertTo-ChaosList $started.candidates
        startedAt   = [string]$started.startedAtUtc
        enumeration = $started.enumeration
    }

    if ($runTracked) {
        Add-ChaosScenarioRunResidueEntry -StudyPath $studyPath -RunId $runId -Workspace $plan.workspace `
            -ScenarioName $plan.scenario.name -ConfigurationName $configurationName -Adapter $Adapter | Out-Null
        Add-ChaosCommandTrailEntry -StudyPath $studyPath -Phase 'run' -Command 'az chaos scenario run start' `
            -Arguments @($configurationName, $runId) -ExitCode 0 | Out-Null
    }
    else {
        # Residue is still recorded, keyed on the configuration, because an
        # unidentified run is the MOST dangerous residue this suite can leave -
        # not the least. Losing the id is not licence to forget the fault.
        $untrackedResidueId = "accepted-untracked:$configurationName"
        Add-ChaosScenarioRunResidueEntry -StudyPath $studyPath -RunId $untrackedResidueId -Workspace $plan.workspace `
            -ScenarioName $plan.scenario.name -ConfigurationName $configurationName -Adapter $Adapter | Out-Null
        Add-ChaosCommandTrailEntry -StudyPath $studyPath -Phase 'run' -Command 'az chaos scenario run start' `
            -Arguments @($configurationName, "accepted-untracked=$($runIdentification.resolution)") -ExitCode 0 | Out-Null
        Write-ChaosStudyNote -Level 'warn' -Message "The scenario run was accepted but could not be identified ($($runIdentification.reason)). The fault IS running. This study will observe the injection window and then stop, but it cannot poll, cancel, or confirm the run - and it will NOT delete the configuration."
    }

    if ($runTracked) {
        # The stop rule is measured here, not restated here. Chaos Studio has no
        # server-side abort hook, so if this loop does not evaluate the criterion
        # and cancel the run, nothing does. A note that repeats the rule while the
        # fault runs unwatched is worse than no note at all, because it reads like
        # enforcement.
        $script:abortCancelIssued = $false
        $script:abortCancelError = $null
        $script:abortBreach = $null
        $script:abortUnmeasuredStreak = 0
        $script:abortMonitorState = 'watching'
        $script:abortMonitorDetail = $null

        # Cancellation is latched: a breach that persists across polls must not
        # fire a second cancel at the service. Acceptance is also not the end -
        # the loop keeps polling until the run itself reports terminal.
        $abortCancel = {
            param([string]$Reason, [string]$Detail)
            if ($script:abortCancelIssued) { return }
            $script:abortCancelIssued = $true
            Write-ChaosStudyNote -Level 'warn' -Message "ABORT: $Reason. Cancelling scenario run $runId.$(if ($Detail) { " $Detail" })"
            try {
                Stop-ChaosStudyScenarioRun -Plan $plan -RunId $runId -Adapter $Adapter -StudyPath $studyPath | Out-Null
                Write-ChaosStudyNote -Level 'warn' -Message "Cancellation accepted for run $runId. Acceptance is not termination; this study keeps polling until the run reports a terminal state."
            }
            catch {
                $script:abortCancelError = $_.Exception.Message
                Write-ChaosStudyNote -Level 'warn' -Message "Cancellation of run $runId FAILED: $($script:abortCancelError). The fault may still be live. Cancel it manually: az chaos scenario run cancel --run-id $runId"
            }
        }

        $waited = Wait-ChaosScenarioRunWindow -Plan $plan -RunId $runId -Minutes $plan.windows.injectMinutes -PollSeconds $PollSeconds `
            -Adapter $Adapter -StudyPath $studyPath `
            -OnPoll {
                param($status)
                Write-ChaosStudyNote -Message "Scenario run $runId is $status. Abort if: $abortWatch"

                $pollEnd = [datetime]::UtcNow
                $pollWindow = New-ChaosWindow -Name 'abort' -Start $pollEnd.AddMinutes(-$abortLookbackMinutes) -End $pollEnd
                $pollSignals = Invoke-ChaosSignalCollection -Plan $plan -Window $pollWindow -Sources $sources -Adapter $Adapter -StudyPath $studyPath
                $verdict = Test-ChaosAbortCriterion -Criterion $abortCriterion -Signals $pollSignals -Sources $sources

                if ($null -eq $verdict.breached) {
                    # Unknown is not healthy. Count it, say so, and fail closed
                    # once the bounded tolerance is spent.
                    $script:abortUnmeasuredStreak++
                    Write-ChaosStudyNote -Level 'warn' -Message "Abort criterion could not be measured on this poll: $($verdict.detail). That is $($script:abortUnmeasuredStreak) of $abortUnmeasuredTolerance consecutive unmeasured polls; an unreadable steady state is not counted as a healthy one."
                    if ($script:abortUnmeasuredStreak -ge $abortUnmeasuredTolerance) {
                        $script:abortMonitorState = 'monitoring-unavailable'
                        $script:abortMonitorDetail = [string]$verdict.detail
                        & $abortCancel "the abort criterion has not been measurable for $($script:abortUnmeasuredStreak) consecutive polls, so the blast radius is unobserved" "Last measurement attempt: $($verdict.detail)"
                    }
                    return
                }

                $script:abortUnmeasuredStreak = 0
                if ($verdict.breached) {
                    $script:abortBreach = $verdict
                    $script:abortMonitorState = 'breached'
                    $script:abortMonitorDetail = "$($verdict.key) = $($verdict.value)"
                    & $abortCancel 'the customer-stated abort criterion was breached' "Measured $($verdict.key) = $($verdict.value) against $(Get-ChaosMember -InputObject $abortCriterion -Name 'conditionText')."
                }
            }

        $injectEnd = Get-ChaosUtcNow
        $runObservation = Get-ChaosScenarioRunObservation -Run $waited.run
        $outcome = if ($runObservation.status) { $runObservation.status } else { 'unknown' }

        if ($waited.endedEarly -and $outcome -ne 'Succeeded') {
            Write-ChaosStudyNote -Message "The scenario run reached '$outcome' before the injection window elapsed." -Level 'warn'
        }

        # Cancellation acceptance is not termination. If the run never reported a
        # terminal state the fault may still be live, and saying otherwise here is
        # how a study claims recovery it never observed.
        if ($script:abortCancelIssued) {
            $terminal = Test-ChaosScenarioRunTerminal -Status $outcome
            $abortWhy = if ($script:abortMonitorState -eq 'breached') {
                "the abort criterion was breached ($script:abortMonitorDetail)"
            }
            else {
                "the abort criterion became unmeasurable ($script:abortMonitorDetail)"
            }
            if ($script:abortCancelError) {
                Write-ChaosStudyNote -Level 'warn' -Message "Injection was aborted because $abortWhy, but the cancel call FAILED: $($script:abortCancelError). Final observed run status is '$outcome'. Treat the fault as potentially still live and confirm manually."
            }
            elseif ($terminal) {
                Write-ChaosStudyNote -Level 'warn' -Message "Injection was aborted because $abortWhy. Run $runId reached terminal status '$outcome'."
            }
            else {
                Write-ChaosStudyNote -Level 'warn' -Message "Injection was aborted because $abortWhy. Cancellation was accepted but run $runId last reported '$outcome', which is not terminal. The fault may still be live; this study is not claiming it stopped."
            }
        }
    }
    else {
        # No id means no polling. Wait out the configured injection window anyway
        # so the evidence below covers the period the fault was actually live,
        # then report the outcome as unknown rather than inventing one.
        Write-ChaosStudyNote -Message "Waiting out the $($plan.windows.injectMinutes) minute injection window without run telemetry."
        Start-Sleep -Seconds ($plan.windows.injectMinutes * 60)
        $injectEnd = Get-ChaosUtcNow
        $outcome = 'AcceptedUntracked'
    }

    Write-ChaosStudyNote -Message 'Collecting evidence from the injection window.'
    $duringWindow = New-ChaosWindow -Name 'during' -Start $injectStart -End $injectEnd
    $duringEvidence = Invoke-ChaosSignalCollection -Plan $plan -Window $duringWindow -Sources $sources
    Save-ChaosStudyArtifact -StudyPath $studyPath -RelativePath 'evidence/during/signals.json' -Content $duringEvidence | Out-Null
} catch {
    $failureMessage = $_.Exception.Message
    $outcome = 'Failed'
    Write-ChaosStudyNote -Message "Injection failed: $failureMessage" -Level 'warn'
} finally {
    # Cleanup is observed, not assumed. Each removal reports what actually
    # happened and that outcome is written to the residue ledger, so a failure
    # here survives as unresolved residue (L14) instead of disappearing into a
    # pipeline. Nothing in this block throws; the study may already be unwinding
    # from a real failure and masking it would be worse than any of this.
    if ($runId) {
        # Cancelling a run that already reached a terminal state is not cleanup:
        # the service rejects it, and that rejection would then be written down
        # as unresolved residue for a run that is not running. Verify instead.
        $alreadyTerminal = $false
        try { $alreadyTerminal = [bool](Test-ChaosScenarioRunTerminal -Status ([string]$outcome)) } catch { $alreadyTerminal = $false }

        if ($alreadyTerminal) {
            Write-ChaosStudyNote -Message "Scenario run $runId already ended as '$outcome'; confirming it is no longer executing rather than cancelling it."
            $observedAbsent = $null
            $observeError = $null
            try {
                $observedAbsent = Test-ChaosStudyScenarioRunAbsent -Plan $plan -RunId $runId -Adapter $Adapter -StudyPath $studyPath
            } catch {
                $observeError = $_.Exception.Message
            }

            $terminalStatus = if ($observedAbsent -eq $true) { 'verified-absent' }
            elseif ($observedAbsent -eq $false) { 'still-present' }
            else { 'verification-unavailable' }

            $terminalError = if ($terminalStatus -eq 'verified-absent') { $null }
            elseif ($observeError) { $observeError }
            else { "Run reported '$outcome' but a read-back could not confirm it stopped." }

            Set-ChaosResidueCleanup -StudyPath $studyPath -Kind 'scenarioRun' -Id $runId `
                -Status $terminalStatus -ErrorText $terminalError `
                -Command "az chaos scenario run show --run-id $runId" | Out-Null

            if ($terminalStatus -ne 'verified-absent') {
                Write-ChaosStudyNote -Message "Scenario run $runId is not confirmed stopped (state: $terminalStatus). $terminalError" -Level 'warn'
            }
        }
        else {
            Write-ChaosStudyNote -Message "Cancelling scenario run $runId."
            $cancelResidue = Invoke-ChaosResidueRemoval -StudyPath $studyPath -Kind 'scenarioRun' -Id $runId -Removal {
                Stop-ChaosStudyScenarioRun -Plan $plan -RunId $runId -Adapter $Adapter -StudyPath $studyPath
            } -VerifyAbsent {
                Test-ChaosStudyScenarioRunAbsent -Plan $plan -RunId $runId -Adapter $Adapter -StudyPath $studyPath
            } -VerifyAttempts 6 -VerifyDelaySeconds 5
            if (-not $cancelResidue.removed) {
                Write-ChaosStudyNote -Message "Scenario run $runId is not confirmed stopped (state: $($cancelResidue.status)). $($cancelResidue.error)" -Level 'warn'
            }
            Add-ChaosCommandTrailEntry -StudyPath $studyPath -Phase 'run' -Command 'az chaos scenario run cancel' `
                -Arguments @($runId, "cleanup=$($cancelResidue.status)") -ExitCode $(if ($cancelResidue.removed) { 0 } else { 1 }) | Out-Null
        }
    }
    elseif ($runAccepted) {
        # Accepted but unidentified. There is nothing to cancel by id and nothing
        # to read back, so the only honest ledger entry is "still present". This
        # deliberately leaves unresolved residue rather than closing the study
        # clean over a fault that may still be injecting.
        $untrackedResidueId = "accepted-untracked:$configurationName"
        $untrackedReason = if ($runIdentification) { [string]$runIdentification.reason } else { 'The run id was never resolved.' }
        Set-ChaosResidueCleanup -StudyPath $studyPath -Kind 'scenarioRun' -Id $untrackedResidueId `
            -Status 'still-present' `
            -ErrorText "Azure accepted the start but the run could not be identified ($untrackedReason), so it could not be polled or cancelled." `
            -Command "az chaos scenario run list -g $($plan.workspace.resourceGroup) --workspace-name $($plan.workspace.name) --scenario-name $($plan.scenario.name)" | Out-Null
        Write-ChaosStudyNote -Level 'warn' -Message "An accepted scenario run for '$configurationName' was never identified and is recorded as unresolved residue. Check the runs on that scenario and cancel it yourself if it is still executing."
    }
    if ($configurationResidueKind) {
        if ($runAccepted -and -not $runTracked) {
            # Deleting the configuration under a run we cannot observe is how the
            # live study ended up tearing down a live fault. Refuse.
            Set-ChaosResidueCleanup -StudyPath $studyPath -Kind $configurationResidueKind -Id $configurationName `
                -Status 'skipped' `
                -ErrorText 'Kept on purpose: a scenario run was accepted but never identified, so deleting this configuration could tear down a fault that is still injecting. Confirm the run has stopped, then delete it yourself.' | Out-Null
            Write-ChaosStudyNote -Level 'warn' -Message "Keeping scenario configuration $configurationName because an accepted run could not be confirmed stopped."
        }
        elseif ($KeepConfiguration) {
            Set-ChaosResidueCleanup -StudyPath $studyPath -Kind $configurationResidueKind -Id $configurationName `
                -Status 'skipped' -ErrorText 'Kept on purpose (-KeepConfiguration).' | Out-Null
        } else {
            Write-ChaosStudyNote -Message "Deleting scenario configuration $configurationName."
            $configResidue = Invoke-ChaosResidueRemoval -StudyPath $studyPath -Kind $configurationResidueKind -Id $configurationName -Removal {
                Remove-ChaosStudyConfiguration -Plan $plan -ConfigurationName $configurationName -Adapter $Adapter -StudyPath $studyPath
            } -VerifyAbsent {
                Test-ChaosStudyConfigurationAbsent -Plan $plan -ConfigurationName $configurationName -Adapter $Adapter -StudyPath $studyPath
            } -VerifyAttempts 6 -VerifyDelaySeconds 5 -RemovalAttempts 2
            if (-not $configResidue.removed) {
                Write-ChaosStudyNote -Message "Scenario configuration $configurationName is not confirmed deleted (state: $($configResidue.status)). $($configResidue.error)" -Level 'warn'
            }
            Add-ChaosCommandTrailEntry -StudyPath $studyPath -Phase 'run' -Command 'az chaos scenario config delete' `
                -Arguments @($configurationName, "cleanup=$($configResidue.status)") -ExitCode $(if ($configResidue.removed) { 0 } else { 1 }) | Out-Null
        }
    }
}

if (-not $injectStart) { $injectStart = $startedAt }
if (-not $injectEnd) { $injectEnd = Get-ChaosUtcNow }
if (-not (Test-Path -LiteralPath (Join-Path $studyPath 'evidence' 'during' 'signals.json'))) {
    $duringWindow = New-ChaosWindow -Name 'during' -Start $injectStart -End $injectEnd
    $duringEvidence = Invoke-ChaosSignalCollection -Plan $plan -Window $duringWindow -Sources $sources -DryRun
    Save-ChaosStudyArtifact -StudyPath $studyPath -RelativePath 'evidence/during/signals.json' -Content $duringEvidence | Out-Null
}

if ($runAccepted -and -not $runTracked) {
    Write-ChaosStudyNote -Level 'warn' -Message "The scenario run was never identified, so this study cannot tell whether the fault stopped. Treat the 'post' window as elapsed time, not as evidence of recovery."
}
Write-ChaosStudyNote -Message "Waiting $($plan.windows.recoveryMinutes) minutes for recovery."
Start-Sleep -Seconds ($plan.windows.recoveryMinutes * 60)
$postWindow = New-ChaosWindow -Name 'post' -Start $injectEnd -End (Get-ChaosUtcNow)
$postEvidence = Invoke-ChaosSignalCollection -Plan $plan -Window $postWindow -Sources $sources
Save-ChaosStudyArtifact -StudyPath $studyPath -RelativePath 'evidence/post/signals.json' -Content $postEvidence | Out-Null

# -- Run record ------------------------------------------------------------

$allSignals = @($preEvidence) + @($duringEvidence) + @($postEvidence)
$coverage = Test-ChaosSignalCoverage -Signals $allSignals

# Was the vulnerable path actually exercised? This is deliberately separate from
# whether the predicate held. A run that touched no resources, or whose frozen
# arithmetic predicted no vulnerable events, proves nothing about resilience -
# and the report has to be able to say so rather than reading zero failures as
# a pass.
$frozenExercise = $null
if ($plan.PSObject.Properties.Name -contains 'exercise' -and $null -ne $plan.exercise) {
    $frozenExercise = $plan.exercise.model
}
$exerciseEvidence = Get-ChaosExerciseEvidence -Model $frozenExercise `
    -ObservedEvents $(if ($null -ne $runObservation -and $null -ne $runObservation.resourcesTouched -and $runObservation.resourcesTouched -eq 0) { 0 } else { $null }) `
    -ObservationSource $(if ($null -ne $runObservation) { 'scenario run summary (resources touched)' } else { $null })

$observationWindow = New-ChaosWindow -Name 'observation' -Start $injectStart -End $injectEnd
# What the service says about when the action was actually applied. For a
# discrete action this is usually a much narrower slice of the observation
# window, and where the service says nothing it stays unknown rather than
# borrowing the configured duration.
$actionWindow = Get-ChaosActionWindow -Observation $runObservation -ActionType $(
    if ($plan.PSObject.Properties.Name -contains 'action' -and $null -ne $plan.action -and $plan.action.PSObject.Properties.Name -contains 'actionType') { [string]$plan.action.actionType } else { '' }
) -ObservationWindow $observationWindow

$runRecord = [ordered]@{
    recordVersion = 'run-record.v3'
    studyId       = $study.studyId
    scopeHash     = $study.scopeHash
    planHash      = $plan.frozenConfigHash
    startedAt     = $startedAt
    completedAt   = Get-ChaosUtcNow
    workspace     = [ordered]@{
        subscriptionId = $plan.workspace.subscriptionId
        resourceGroup  = $plan.workspace.resourceGroup
        name           = $plan.workspace.name
        id             = $plan.workspace.id
    }
    configuration = [ordered]@{
        name             = $configurationName
        scenario         = $plan.scenario.name
        scenarioId       = $plan.scenario.id
        validationStatus = $validationStatus
        permissionFix    = $permissionFix
        retained         = [bool]$KeepConfiguration
    }
    scenarioRun   = [ordered]@{
        runId          = $runId
        outcome        = $outcome
        observation    = $runObservation
        failure        = $failureMessage
        accepted       = $runAccepted
        tracked        = $runTracked
        identification = $runIdentification
    }
    windows       = [ordered]@{
        pre         = $preWindow
        # 'during' is retained under its old name because it is what the
        # evidence files actually cover: everything we measured between
        # starting and finishing the run. It is an observation window.
        during      = $observationWindow
        observation = $observationWindow
        action      = $actionWindow
        post        = $postWindow
    }
    evidence      = [ordered]@{
        pre    = 'evidence/pre/signals.json'
        during = 'evidence/during/signals.json'
        post   = 'evidence/post/signals.json'
    }
    coverage      = $coverage
    exercise      = $exerciseEvidence
    residue       = Get-ChaosResidueSummary -StudyPath $studyPath
}

Save-ChaosStudyArtifact -StudyPath $studyPath -RelativePath (Get-ChaosArtifactFileName -Artifact 'runRecord') -Content $runRecord | Out-Null

$status = if ($failureMessage) { 'error' } elseif ($coverage.missing -gt 0) { 'warning' } else { 'success' }
$touched = if ($null -ne $runObservation -and $null -ne $runObservation.resourcesTouched) { $runObservation.resourcesTouched } else { 'not reported' }
$residueSummary = $runRecord.residue
$residueText = if ($residueSummary.total -eq 0) {
    'nothing created'
} elseif ($residueSummary.unresolved -eq 0) {
    "$($residueSummary.resolved) of $($residueSummary.total) removed"
} else {
    "$($residueSummary.unresolved) of $($residueSummary.total) NOT confirmed removed"
}

Write-ChaosStudyPanel -Title "Run complete - study $($study.studyId)" -Status $status -Body @"
The scenario run has stopped. Cleanup outcomes are recorded in the residue
ledger, including anything that could not be confirmed removed. Evidence is
recorded; it has not yet been interpreted.
"@ -Properties ([ordered]@{
    'Scenario run'      = if ($runId) { $runId } elseif ($runAccepted) { '(accepted, never identified - see residue)' } else { '(never started)' }
    'Outcome'           = $outcome
    'Resources touched' = $touched
    'Signals measured'  = "$($coverage.measured) of $($coverage.total)"
    'Residue'           = $residueText
    'Study directory'   = $studyPath
})

if ($coverage.missing -gt 0) {
    Write-ChaosStudyPanel -Title 'Some evidence is missing' -Status 'warning' -Body (
        @($coverage.caveats | ForEach-Object { "  - $_" }) -join "`n"
    )
}

Write-ChaosStudyNote -Message 'Next: run the chaos-study-report skill to interpret this run.'

if ($failureMessage) { exit (Get-ChaosStudyExitCode -Name 'Error') }
exit (Get-ChaosStudyExitCode -Name 'Success')
