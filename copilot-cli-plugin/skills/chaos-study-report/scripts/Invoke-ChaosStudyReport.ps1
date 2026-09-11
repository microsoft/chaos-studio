#Requires -Version 7.0
<#
.SYNOPSIS
    Interpret an executed study and seal it with a report.

.DESCRIPTION
    This script reads only what the run already wrote. It issues no queries, so
    it cannot quietly substitute fresh data for the evidence the study actually
    collected - the report describes the run, not the present.

    Sealing makes the study immutable. From that point the report and the
    evidence it cites cannot drift apart, which is what makes the report
    citable.

.EXAMPLE
    ./Invoke-ChaosStudyReport.ps1
    Reports on the latest executed study and seals it.

.EXAMPLE
    ./Invoke-ChaosStudyReport.ps1 -StudyId 20260101T120000Z-ab12cd34 -NoSeal
    Renders a report for review without sealing.
#>

[CmdletBinding()]
param(
    [string]$StudyId = 'latest',
    [string]$StudyRoot,
    [string]$OutputPath,
    [switch]$NoSeal,
    [switch]$Open
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$libDir = Join-Path $PSScriptRoot 'lib'
$sharedLib = Join-Path $PSScriptRoot '..' '..' 'chaos-study' 'scripts' 'lib'
. (Join-Path $sharedLib 'Common.ps1')
. (Join-Path $sharedLib 'ApiVersions.ps1')
. (Join-Path $sharedLib 'Study.ps1')
. (Join-Path $libDir 'Findings.ps1')
. (Join-Path $libDir 'Report.ps1')

$findArgs = @{ StudyId = $StudyId }
if ($StudyRoot) { $findArgs['StudyRoot'] = $StudyRoot }
$study = Find-ChaosStudy @findArgs

if (-not $study) {
    Write-ChaosStudyFailure -Title 'No study to report on' -Message "Could not find a study matching '$StudyId'." `
        -Remediation 'Run the chaos-study-history skill to list studies, or chaos-study-scope to plan a new one.'
    exit (Get-ChaosStudyExitCode -Name 'Error')
}

$studyPath = $study.path
$plan = Read-ChaosJsonFile -Path (Get-ChaosArtifactReader -StudyPath $studyPath -Artifact 'plan').path
$runRecord = Read-ChaosJsonFile -Path (Get-ChaosArtifactReader -StudyPath $studyPath -Artifact 'runRecord').path

if (-not $plan -or -not $runRecord) {
    Write-ChaosStudyFailure -Title 'Study has not been executed' -Message @"
Study $($study.studyId) is in state $($study.state). A report describes a run,
and this study has no run record to describe.
"@ -Remediation 'Run the chaos-study-run skill for this study first.'
    exit (Get-ChaosStudyExitCode -Name 'Error')
}

$evidence = [ordered]@{
    pre    = @(Read-ChaosJsonFile -Path (Join-Path $studyPath 'evidence' 'pre' 'signals.json'))
    during = @(Read-ChaosJsonFile -Path (Join-Path $studyPath 'evidence' 'during' 'signals.json'))
    post   = @(Read-ChaosJsonFile -Path (Join-Path $studyPath 'evidence' 'post' 'signals.json'))
}

$findings = Build-StudyFindings -Plan $plan -RunRecord $runRecord -Evidence $evidence

$commandTrail = @()
$trailPath = Join-Path $studyPath 'commands.jsonl'
if (Test-Path -LiteralPath $trailPath) {
    $commandTrail = @(
        foreach ($line in [System.IO.File]::ReadAllLines($trailPath)) {
            if (-not [string]::IsNullOrWhiteSpace($line)) { $line | ConvertFrom-Json }
        }
    )
}

$manifest = Read-ChaosJsonFile -Path (Join-Path $studyPath 'manifest.json')

# Adapter provenance rides in the appendix so a reviewer can re-derive the
# request and result hashes of every operation the host executed on our behalf.
# A hand-written report has no provenance to show.
$provenance = @(Get-ChaosOperationProvenance -StudyPath $studyPath)

$html = New-ChaosStudyReportHtml -Plan $plan -RunRecord $runRecord -Findings $findings -Evidence $evidence -Manifest $manifest -CommandTrail $commandTrail -Provenance $provenance

if ($study.state -eq 'SEALED') {
    # A sealed study is immutable, so the report is rendered beside it -- in the
    # scope directory of the study store, never in the caller's working
    # directory, which is frequently a git repository we must not pollute.
    $fallback = if ($OutputPath) { $OutputPath } else { Join-Path (Split-Path -Parent $studyPath) "report-$($study.studyId).html" }
    Write-ChaosTextFile -Path $fallback -Content $html
    Write-ChaosStudyPanel -Title 'Study already sealed' -Status 'info' -Body @"
Study $($study.studyId) is sealed, so its stored artifacts were left untouched.
A fresh render was written outside the study directory instead.
"@ -Properties ([ordered]@{ 'Report' = $fallback; 'Predicate verdict' = $findings.predicateVerdict; 'Study verdict' = $findings.studyVerdict })
    exit (Get-ChaosStudyExitCode -Name 'Success')
}

Save-ChaosStudyArtifact -StudyPath $studyPath -RelativePath (Get-ChaosArtifactFileName -Artifact 'findings') -Content $findings | Out-Null
Save-ChaosStudyArtifact -StudyPath $studyPath -RelativePath 'report.html' -Content $html -AsText -SkipRedaction | Out-Null
Add-ChaosCommandTrailEntry -StudyPath $studyPath -Phase 'report' -Command 'Invoke-ChaosStudyReport' -ExitCode 0 -Note "$($findings.predicateVerdict) / $($findings.studyVerdict)" | Out-Null

$reportPath = Join-Path $studyPath 'report.html'
if ($OutputPath) {
    Write-ChaosTextFile -Path $OutputPath -Content $html
    $reportPath = $OutputPath
}

if (-not $NoSeal) {
    $identity = [ordered]@{
        workspace     = [string]$plan.workspace.name
        workspaceId   = [string]$plan.workspace.id
        region        = [string]$plan.scope.region
        scenario      = [string]$plan.scenario.name
        scenarioId    = [string]$plan.scenario.id
        action        = [string]$plan.action.name
        actionUrn     = [string]$plan.action.canonicalId
        actionType    = [string]$plan.action.actionType
        scopeCount    = $plan.scope.projectedResourceCount
        predicate     = [string]$plan.question.steadyState.raw
        windows       = [ordered]@{
            baselineMinutes = $plan.windows.baselineMinutes
            injectMinutes   = $plan.windows.injectMinutes
            recoveryMinutes = $plan.windows.recoveryMinutes
        }
        planHash      = [string]$plan.frozenConfigHash
    }
    Complete-ChaosStudy -StudyPath $studyPath -Identity $identity -Summary ([ordered]@{
        predicateVerdict = $findings.predicateVerdict
        studyVerdict     = $findings.studyVerdict
        verdict          = $findings.studyVerdict
        findingsVersion  = $findings.findingsVersion
        mechanismProven  = $findings.mechanismProven
        findingCount     = @($findings.findings).Count
        worstSeverity    = $(if (@($findings.findings).Count -gt 0) { @($findings.findings)[0].severity } else { 'none' })
    }) | Out-Null
}

# Status colour follows the study verdict, because that is what the operator has
# to act on. Critical collateral is an error even when the predicate held.
$status = switch -Wildcard ($findings.studyVerdict) {
    'Steady state held'            { 'success' }
    'Degraded but recovered'       { 'warning' }
    'Steady state breached'        { 'error' }
    'Critical collateral damage*'  { 'error' }
    default                        { 'info' }
}

# The body states what the evidence showed. The hypothesis is what we believed
# beforehand, so it is labelled as such rather than printed as a conclusion --
# an "Inconclusive" verdict above a confident-sounding hypothesis reads as a pass.
# The predicate sentence and the study sentence are written separately: a study
# may have done damage without the declared objective ever moving, and saying
# "steady state breached" in that case would be false.
$predicateSentence = switch ($findings.predicateVerdict) {
    'Held' {
        'The steady-state objective held while the action was live.'
    }
    'Breached' {
        'The steady-state objective was breached while the action was live.'
    }
    'Not exercised' {
        'The steady-state objective did not move, but too little work reached the vulnerable path for that to mean anything. Treat this as untested rather than passed.'
    }
    default {
        'The signal behind the steady-state objective could not be read for the action window, so no predicate outcome can be stated.'
    }
}

$conclusion = switch -Wildcard ($findings.studyVerdict) {
    'Steady state held' {
        "$predicateSentence The action was also proven to have landed, so the result can be read as resilience to it."
    }
    'Degraded but recovered' {
        "$predicateSentence Other signals degraded during the action and returned to their objectives afterwards."
    }
    'Steady state breached' {
        "$predicateSentence It had not recovered by the end of the recovery window."
    }
    'Critical collateral damage*' {
        "$predicateSentence The study nonetheless caused critical damage outside the predicate, which is why the study verdict is worse than the predicate verdict."
    }
    'Not exercised' {
        $predicateSentence
    }
    default {
        "$predicateSentence The action could not be proven to have reached the scoped resources, so this study cannot support any claim about resilience to it."
    }
}

$cardBody = @"
$conclusion

Hypothesis stated before injection: $($plan.question.hypothesis)
"@

Write-ChaosStudyPanel -Title $findings.studyVerdict -Status $status -Body $cardBody -Properties ([ordered]@{
    'Study'             = $study.studyId
    'Predicate verdict' = $findings.predicateVerdict
    'Study verdict'     = $findings.studyVerdict
    'Mechanism proven'  = $findings.mechanismProven
    'Findings'          = @($findings.findings).Count
    'Limitations'       = (@($findings.limitations | ForEach-Object { $_.code }) -join ', ')
    'Report'            = $reportPath
    'Sealed'            = (-not $NoSeal)
})

if (@($findings.findings).Count -gt 0) {
    Write-ChaosStudyTable -Title 'Findings' -Data @(
        foreach ($finding in $findings.findings) {
            [pscustomobject]@{
                Severity   = $finding.severity
                Kind       = $finding.kind
                Confidence = $finding.confidence
                Finding    = $finding.title
            }
        }
    )
}

if ($Open -and $IsWindows) { Start-Process $reportPath }

Write-ChaosStudyNote -Message 'Next: run the chaos-study-history skill to compare this study with earlier ones.'
exit (Get-ChaosStudyExitCode -Name 'Success')
