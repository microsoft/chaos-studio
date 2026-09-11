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

if ($study.state -eq 'EXECUTED' -and -not $Force -and -not $DryRun) {
    Write-ChaosStudyFailure -Title 'Study has already been executed' -Message @"
Study $($study.studyId) already holds a run record. Running it again would
overwrite evidence from the first execution.
"@ -Remediation 'Plan a new study, or pass -Force if you intend to overwrite this one.'
    exit (Get-ChaosStudyExitCode -Name 'Error')
}

Assert-ChaosPlanIntegrity -Plan $plan | Out-Null

$configurationName = Get-ChaosStudyConfigurationName -StudyId $study.studyId
$sources = @($SignalSource)
if ($sources.Count -eq 0 -and $plan.signals.configuredSources) {
    $sources = @($plan.signals.configuredSources)
}

$projectedCount = $plan.scope.projectedResourceCount
$projectedText = if ($null -eq $projectedCount) { '(not resolved)' } else { "$projectedCount of $($plan.scope.discoveredResourceCount) discovered" }

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
        'Scoped resources'   = $projectedText
        'Scenario'           = $plan.scenario.name
        'Action'             = $plan.action.displayName
        'Action URN'         = $(if ([string]::IsNullOrWhiteSpace($plan.action.canonicalId)) { '(not resolved - discovery skipped)' } else { [string]$plan.action.canonicalId })
        'Injection'          = "$($plan.windows.injectMinutes) minutes"
        'Baseline'           = "$($plan.windows.baselineMinutes) minutes before injection"
        'Recovery'           = "$($plan.windows.recoveryMinutes) minutes after injection"
        'Configuration'      = $configurationName
    })

    Write-ChaosStudyTable -Title 'Evidence that would be collected' -Data @(
        foreach ($signal in $preview) {
            [pscustomobject]@{
                Source = $signal.source
                Status = if ($signal.caveat) { $signal.caveat } else { 'would be collected' }
            }
        }
    )

    if (@($plan.safety.abortConditions).Count -gt 0) {
        Write-ChaosStudyPanel -Title 'Abort if any of these happen' -Status 'warning' -Body (
            @($plan.safety.abortConditions | ForEach-Object { "  - $_" }) -join "`n"
        )
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

if ($plan.scope.projectedResourceCount -eq 0 -and -not $Force) {
    Write-ChaosStudyFailure -Title 'Nothing is in scope' -Message @"
After filters and exclusions this plan reaches zero resources. A scenario run
against an empty scope succeeds without touching anything, which would produce a
report claiming resilience that was never tested.
"@ -Remediation 'Re-run chaos-study-scope with a wider scope or fewer exclusions, or pass -Force to record the empty run deliberately.'
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
    $started = Start-ChaosStudyScenarioRun -Plan $plan -ConfigurationName $configurationName -Validation $validation -Adapter $Adapter -StudyPath $studyPath
    $runId = $started.runId
    Add-ChaosScenarioRunResidueEntry -StudyPath $studyPath -RunId $runId -Workspace $plan.workspace `
        -ScenarioName $plan.scenario.name -ConfigurationName $configurationName -Adapter $Adapter | Out-Null
    Add-ChaosCommandTrailEntry -StudyPath $studyPath -Phase 'run' -Command 'az chaos scenario run start' `
        -Arguments @($configurationName, $runId) -ExitCode 0 | Out-Null

    $waited = Wait-ChaosScenarioRunWindow -Plan $plan -RunId $runId -Minutes $plan.windows.injectMinutes -PollSeconds $PollSeconds `
        -Adapter $Adapter -StudyPath $studyPath `
        -OnPoll { param($status) Write-ChaosStudyNote -Message "Scenario run $runId is $status." }

    $injectEnd = Get-ChaosUtcNow
    $runObservation = Get-ChaosScenarioRunObservation -Run $waited.run
    $outcome = if ($runObservation.status) { $runObservation.status } else { 'unknown' }

    if ($waited.endedEarly -and $outcome -ne 'Succeeded') {
        Write-ChaosStudyNote -Message "The scenario run reached '$outcome' before the injection window elapsed." -Level 'warn'
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
    if ($configurationResidueKind) {
        if ($KeepConfiguration) {
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
        runId       = $runId
        outcome     = $outcome
        observation = $runObservation
        failure     = $failureMessage
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
    'Scenario run'      = if ($runId) { $runId } else { '(never started)' }
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
