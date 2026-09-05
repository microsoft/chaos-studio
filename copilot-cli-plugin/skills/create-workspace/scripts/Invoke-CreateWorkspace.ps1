<#
.SYNOPSIS
    Step driver for the create-workspace skill.
.DESCRIPTION
    Provisions a Microsoft.Chaos/workspaces resource, binds a managed identity,
    validates scopes, and grants Reader RBAC on each scope.

    Workspace lifecycle uses the `az chaos` CLI extension (via Invoke-AzChaos).
    Non-Chaos ARM reads (the user-assigned identity resource) and role
    assignments still use Invoke-AzRest / az CLI.
    State is persisted to the shared state file via State.ps1.
.NOTES
    This script is invoked by the start-chaos orchestrator, not directly by users.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$ResourceGroup,
    [Parameter(Mandatory)][string]$WorkspaceName,
    [Parameter()][string]$Location = 'westus2',
    [Parameter()][ValidateSet('SystemAssigned','UserAssigned')][string]$IdentityType = 'SystemAssigned',
    [Parameter()][string]$UserAssignedIdentityResourceId,
    [Parameter(Mandatory)][string[]]$Scopes
)

# ── Load shared scripts ─────────────────────────────────
$sharedDir = Join-Path (Split-Path (Split-Path (Split-Path $PSScriptRoot))) 'scripts'
. (Join-Path $sharedDir 'State.ps1')
. (Join-Path $sharedDir 'Render.ps1')
. (Join-Path $sharedDir 'Invoke-AzRest.ps1')
. (Join-Path $sharedDir 'Invoke-AzChaos.ps1')
. (Join-Path $sharedDir 'Rbac.ps1')

# ── Read state ──────────────────────────────────────────
$state = Read-State

# Short-circuit if already done
if ($state.workspace.status -eq 'done') {
    Write-Card -Title 'Workspace' -Status '✅ Already created' -Properties ([ordered]@{
        'Name' = $state.workspace.name
        'ID'   = $state.workspace.id
    })
    exit 0
}

# Verify auth
if ($state.auth.status -ne 'done') {
    Write-Error-Card -Title 'Auth Required' -ErrorMessage 'Azure CLI auth has not been completed. Run the auth pre-flight first.'
    exit 1
}

$subscriptionId = $state.context.subscriptionId

try {
    # ── Step 1: Validate inputs ─────────────────────────
    if ($IdentityType -eq 'UserAssigned' -and -not $UserAssignedIdentityResourceId) {
        Write-Error-Card -Title 'Missing Parameter' -ErrorMessage 'UserAssigned identity requires -UserAssignedIdentityResourceId.'
        exit 1
    }

    foreach ($scope in $Scopes) {
        if ($scope -notmatch '^/subscriptions/') {
            Write-Error-Card -Title 'Invalid Scope' -ErrorMessage "Scope must be a valid ARM ID: $scope"
            exit 1
        }
    }

    # ── Step 2: Build `az chaos workspace create` args ──
    $createArgs = @(
        'workspace', 'create'
        '--resource-group', $ResourceGroup
        '--workspace-name', $WorkspaceName
        '--location', $Location
    )
    $createArgs += '--scopes'
    $createArgs += $Scopes
    if ($IdentityType -eq 'UserAssigned') {
        $createArgs += @('--mi-user-assigned', $UserAssignedIdentityResourceId)
    } else {
        $createArgs += @('--mi-system-assigned', '')
    }

    Write-Card -Title 'Creating Workspace' -Status '🔄 In Progress' -Properties ([ordered]@{
        'Subscription'   = $subscriptionId
        'Resource Group' = $ResourceGroup
        'Name'           = $WorkspaceName
        'Location'       = $Location
        'Identity'       = $IdentityType
        'Scopes'         = ($Scopes -join ', ')
    })

    Set-StateProperty -PropertyPath 'workspace.status' -Value 'in_progress'
    Set-StateProperty -PropertyPath 'workspace.name' -Value $WorkspaceName
    Set-StateProperty -PropertyPath 'context.resourceGroup' -Value $ResourceGroup
    Set-StateProperty -PropertyPath 'context.location' -Value $Location

    # ── Step 3: Create workspace (LRO awaited by the CLI) ─
    # `az chaos workspace create` polls the provisioning LRO to completion and
    # returns the final workspace resource, so no manual async / resource-GET
    # polling loop is required.
    $workspace = Invoke-AzChaos -ChaosArgs $createArgs

    if (-not $workspace -or $workspace.properties.provisioningState -ne 'Succeeded') {
        $ps = if ($workspace) { $workspace.properties.provisioningState } else { 'Unknown' }
        $errMsg = "Workspace provisioning ended in state '$ps'"
        Set-StateProperty -PropertyPath 'workspace.lastError' -Value $errMsg
        Write-Error-Card -Title 'Workspace Creation Failed' -ErrorMessage $errMsg
        exit 1
    }

    Set-StateProperty -PropertyPath 'workspace.id' -Value $workspace.id

    Write-Card -Title 'Workspace Created' -Status '✅ Succeeded' -Properties ([ordered]@{
        'ARM ID'            = $workspace.id
        'Provisioning State' = $workspace.properties.provisioningState
    })

    # ── Step 5: Resolve identity principalId ────────────
    $principalId = $null

    if ($IdentityType -eq 'SystemAssigned') {
        $principalId = $workspace.identity.principalId
    } else {
        # UserAssigned: GET the UAMI resource
        $uamiResponse = Invoke-AzRest -Method GET -Uri $UserAssignedIdentityResourceId -ApiVersion '2023-01-31'
        $principalId = $uamiResponse.body.properties.principalId
    }

    if (-not $principalId) {
        Write-Error-Card -Title 'Identity Resolution Failed' -ErrorMessage 'Could not resolve principalId from the workspace identity.'
        Set-StateProperty -PropertyPath 'workspace.lastError' -Value 'principalId not found'
        exit 1
    }

    Set-StateProperty -PropertyPath 'workspace.identity.type' -Value $IdentityType
    Set-StateProperty -PropertyPath 'workspace.identity.principalId' -Value $principalId

    Write-Card -Title 'Identity Resolved' -Status '✅' -Properties ([ordered]@{
        'Type'        = $IdentityType
        'Principal ID' = $principalId
    })

    # ── Step 6: Grant Reader RBAC ───────────────────────
    $rbacResults = @()
    foreach ($scope in $Scopes) {
        $canAssign = Test-CallerCanAssignRoles -Scope $scope
        if ($canAssign) {
            $result = Grant-Reader -Scope $scope -PrincipalId $principalId
            $rbacResults += @{ scope = $scope; status = $result }
        } else {
            $remediation = Build-RoleAssignmentRemediation -Scope $scope -PrincipalId $principalId
            Write-Error-Card -Title 'RBAC Permission Required' `
                -ErrorMessage "Cannot auto-assign Reader on scope: $scope" `
                -RemediationCommand $remediation.command `
                -Details $remediation.description
            $rbacResults += @{ scope = $scope; status = 'pending' }
        }
    }

    Set-StateProperty -PropertyPath 'workspace.scopes' -Value @($Scopes)
    Set-StateProperty -PropertyPath 'workspace.rbac' -Value $rbacResults

    # Check if any RBAC is pending
    $pending = $rbacResults | Where-Object { $_.status -eq 'pending' }
    if ($pending) {
        Write-Card -Title 'RBAC Status' -Status '⚠️ Manual Action Required' `
            -Body "Some role assignments require manual action. Run the remediation commands above, then re-run the orchestrator to continue."
        Set-StateProperty -PropertyPath 'workspace.lastError' -Value 'rbac-pending'
        exit 1
    }

    Write-Table -Data $rbacResults -Columns @('scope', 'status') -Title 'RBAC Assignments'

    # ── Step 7: Mark done ───────────────────────────────
    Set-StateProperty -PropertyPath 'workspace.status' -Value 'done'

    Write-Card -Title 'CreateWorkspace Complete' -Status '✅ Done' -Properties ([ordered]@{
        'Workspace' = $workspace.id
        'Identity'  = "$IdentityType ($principalId)"
        'Scopes'    = ($Scopes -join ', ')
    })

    exit 0

} catch {
    $errorMsg = $_.Exception.Message
    Set-StateProperty -PropertyPath 'workspace.lastError' -Value $errorMsg
    Set-StateProperty -PropertyPath 'workspace.status' -Value 'failed'
    Write-Error-Card -Title 'CreateWorkspace Error' -ErrorMessage $errorMsg
    exit 1
}
