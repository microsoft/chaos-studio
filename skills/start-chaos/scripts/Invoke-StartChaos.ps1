<#
.SYNOPSIS
    Master orchestrator for the full Chaos Studio v2 pipeline.
.DESCRIPTION
    Drives all four phases in sequence: auth → workspace → setup → run.
    Reads state to resume from the first non-done phase.

    Exit codes:
      0  — Pipeline completed successfully
      1  — Error (check state for details)
      4  — Workspace inputs required (pass -ResourceGroup, -WorkspaceName, -Scopes)
      2  — Scenario selection required (read state.setup.recommendedScenarios)
      3  — Parameter mode required (pass -ParameterMode autofill|manual)

    The caller (AI orchestrator) should:
      1. Run this script with no args
      2. On exit 4: prompt for workspace inputs, re-run with them
      3. On exit 2: prompt for scenario choice, re-run with -ScenarioName
      4. On exit 3: prompt for parameter mode, re-run with -ParameterMode
      5. On exit 0: done — final summary is already rendered
.NOTES
    All user-facing output is Markdown cards via Render.ps1.
#>
[CmdletBinding()]
param(
    # Phase 1 — Workspace inputs (required when state.workspace.status != 'done')
    [Parameter()][string]$ResourceGroup,
    [Parameter()][string]$WorkspaceName,
    [Parameter()][string]$Location = 'westus2',
    [Parameter()][ValidateSet('SystemAssigned','UserAssigned')][string]$IdentityType = 'SystemAssigned',
    [Parameter()][string]$UserAssignedIdentityResourceId,
    [Parameter()][string[]]$Scopes,

    # Phase 2 — Setup inputs (provided after exit codes 2/3)
    [Parameter()][string]$ScenarioName,
    [Parameter()][string]$ParameterMode,
    [Parameter()][hashtable]$ParameterValues = @{},

    # Auth
    [Parameter()][switch]$ForceReauth
)

# ── Load shared scripts ─────────────────────────────────
$sharedDir = Join-Path (Split-Path (Split-Path (Split-Path $PSScriptRoot))) 'scripts'
. (Join-Path $sharedDir 'State.ps1')
. (Join-Path $sharedDir 'Render.ps1')
. (Join-Path $sharedDir 'Ensure-AzLogin.ps1')

$pipelineStart = Get-Date

# ── Read state ──────────────────────────────────────────
$state = Read-State

# ═══════════════════════════════════════════════════════
# Phase 0 — Auth Pre-flight
# ═══════════════════════════════════════════════════════
if ($state.auth.status -ne 'done' -or $ForceReauth) {
    Ensure-AzLogin -ForceReauth:$ForceReauth
    $state = Read-State

    if ($state.auth.status -ne 'done') {
        Write-Error-Card -Title 'Auth Failed' -ErrorMessage 'Azure CLI authentication did not complete. Check the error above.'
        exit 1
    }
}

# ═══════════════════════════════════════════════════════
# Phase 1 — Create Workspace
# ═══════════════════════════════════════════════════════
if ($state.workspace.status -ne 'done') {
    # Check if we have the required inputs
    if (-not $ResourceGroup -or -not $WorkspaceName -or -not $Scopes -or $Scopes.Count -eq 0) {
        Set-StateProperty -PropertyPath 'workspace.awaitingInputs' -Value $true

        Write-Card -Title 'Workspace Inputs Required' -Status '⏸️' -Body @"
A Chaos workspace must be created. Please provide the following inputs and re-run:

- **-ResourceGroup**: Azure resource group name
- **-WorkspaceName**: Name for the new workspace
- **-Location**: Azure region (default: westus2)
- **-IdentityType**: SystemAssigned or UserAssigned (default: SystemAssigned)
- **-Scopes**: ARM resource ID(s) for the workspace scope
"@
        exit 4
    }

    Set-StateProperty -PropertyPath 'workspace.awaitingInputs' -Value $false

    $wsScript = Join-Path (Split-Path (Split-Path $PSScriptRoot)) 'create-workspace' 'scripts' 'Invoke-CreateWorkspace.ps1'
    $wsArgs = @{
        ResourceGroup = $ResourceGroup
        WorkspaceName = $WorkspaceName
        Location      = $Location
        IdentityType  = $IdentityType
        Scopes        = $Scopes
    }
    if ($UserAssignedIdentityResourceId) {
        $wsArgs['UserAssignedIdentityResourceId'] = $UserAssignedIdentityResourceId
    }

    & $wsScript @wsArgs
    if ($LASTEXITCODE -ne 0) {
        exit 1
    }

    $state = Read-State
}

# ═══════════════════════════════════════════════════════
# Phase 2 — Setup Scenario
# ═══════════════════════════════════════════════════════
if ($state.setup.status -ne 'done') {
    $setupScript = Join-Path (Split-Path (Split-Path $PSScriptRoot)) 'setup-scenario' 'scripts' 'Invoke-SetupScenario.ps1'
    $setupArgs = @{}

    if ($ScenarioName) { $setupArgs['ScenarioName'] = $ScenarioName }
    if ($ParameterMode) { $setupArgs['ParameterMode'] = $ParameterMode }
    if ($ParameterValues.Count -gt 0) { $setupArgs['ParameterValues'] = $ParameterValues }

    & $setupScript @setupArgs
    $setupExit = $LASTEXITCODE

    # Exit code 2 = scenario selection needed
    # Exit code 3 = parameter mode needed
    if ($setupExit -in @(2, 3)) {
        exit $setupExit
    }
    if ($setupExit -ne 0) {
        exit 1
    }

    $state = Read-State

    # If setup finished with no-recommendations, we're done
    if ($state.setup.note -eq 'no-recommendations') {
        Write-Card -Title 'Pipeline Complete' -Status '⚠️ No Scenarios' `
            -Body 'No recommended scenarios were found for your workspace scope. Try broadening your scope or adding more resources.'
        exit 0
    }
}

# ═══════════════════════════════════════════════════════
# Phase 3 — Run Scenario
# ═══════════════════════════════════════════════════════
if ($state.run.status -ne 'done') {
    $runScript = Join-Path (Split-Path (Split-Path $PSScriptRoot)) 'run-scenario' 'scripts' 'Invoke-RunScenario.ps1'

    & $runScript
    if ($LASTEXITCODE -ne 0) {
        exit 1
    }

    $state = Read-State
}

# ═══════════════════════════════════════════════════════
# Final Summary
# ═══════════════════════════════════════════════════════
$elapsed = ((Get-Date) - $pipelineStart).ToString('hh\:mm\:ss')

# If we resumed and the run was already done, use stored run data
$scenarioName = ($state.setup.selectedScenarioId -split '/')[-1]

Write-Card -Title 'Chaos Experiment Complete' -Status '✅ Success' -Properties ([ordered]@{
    'Subscription'   = "$($state.context.subscriptionName) ($($state.context.subscriptionId))"
    'Workspace'      = $state.workspace.id
    'Scenario'       = $scenarioName
    'Configuration'  = $state.setup.configuration.name
    'Run ID'         = $state.run.scenarioRunId
    'Run Status'     = $state.run.lastObservedState
    'Pipeline Time'  = $elapsed
})

if ($state.run.reportPath -and (Test-Path $state.run.reportPath)) {
    Write-Card -Title 'Run Report' -Status '📄' -Properties ([ordered]@{
        'Path' = $state.run.reportPath
        'Open' = "file:///$([uri]::EscapeUriString($state.run.reportPath.Replace('\','/')))"
    })
}

exit 0
