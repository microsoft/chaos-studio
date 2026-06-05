<#
.SYNOPSIS
    Azure CLI auth pre-flight for the startchaos plugin.

.DESCRIPTION
    Guarantees the CLI session has an active, intended Azure subscription
    before any ARM call.  Flow:

      1. If state.auth.status is already "done" (and -ForceReauth is not set),
         short-circuit with an "auth ok" card.
      2. Probe existing session via `az account show`.  When the account state
         is "Enabled", accept it without re-prompting.
      3. Otherwise prompt for a subscription (GUID or display name), run
         device-code login, set the subscription, and verify.

    All results are persisted atomically via Save-State.  Any `az` failure
    renders an Error card with verbatim stderr and a remediation command,
    then exits non-zero.

.NOTES
    EPIC-002 tasks T2.1–T2.6.
    Non-interactive mode: set STARTCHAOS_NONINTERACTIVE=1 and supply the
    target subscription in STARTCHAOS_SUBSCRIPTION.
#>

# ── Dependencies ────────────────────────────────────────
. "$PSScriptRoot\State.ps1"
. "$PSScriptRoot\Render.ps1"

# ── Helpers ─────────────────────────────────────────────

function _Invoke-AzCli {
    <# Runs an az CLI command, returns parsed JSON on success or throws with stderr. #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$Command
    )

    $stderr = $null
    try {
        $raw = Invoke-Expression $Command 2>&1 | ForEach-Object {
            if ($_ -is [System.Management.Automation.ErrorRecord]) {
                $stderr += $_.ToString()
            } else {
                $_
            }
        }
        $rawText = ($raw | Where-Object { $_ -isnot [System.Management.Automation.ErrorRecord] }) -join "`n"

        if ($LASTEXITCODE -ne 0) {
            throw $stderr
        }

        if ($rawText) {
            return $rawText | ConvertFrom-Json -AsHashtable
        }
        return $null
    } catch {
        throw $_
    }
}

# ── Main Function ───────────────────────────────────────

function Ensure-AzLogin {
    <#
    .SYNOPSIS
        Ensures the CLI session is authenticated to Azure with the intended
        subscription before any ARM call.

    .DESCRIPTION
        Checks for an existing session, prompts for device-code login when
        needed, verifies the active subscription, and persists all auth
        context to the plugin state file.

    .PARAMETER ForceReauth
        When set, re-runs the auth flow even when state.auth.status is
        already "done".

    .EXAMPLE
        Ensure-AzLogin
        # Uses existing session if available; prompts otherwise.

    .EXAMPLE
        Ensure-AzLogin -ForceReauth
        # Always re-runs the auth flow.
    #>
    [CmdletBinding()]
    param(
        [Parameter()]
        [switch]$ForceReauth
    )

    $state = Read-State

    # ── Short-circuit when already authenticated ────────
    if (($state.auth.status -eq 'done') -and (-not $ForceReauth)) {
        [Console]::Error.WriteLine('[Auth] Already authenticated — skipping re-auth')
        Write-Card -Title 'Azure Authentication' -Status '✅ Done' `
            -Body 'Session is already authenticated.' `
            -Properties ([ordered]@{
                'Subscription'  = $state.context.subscriptionName
                'SubscriptionId' = $state.context.subscriptionId
                'Tenant'        = $state.context.tenantId
                'User'          = $state.context.signedInUser
                'Method'        = $state.auth.method
            })
        return
    }

    # ── Step 1: Probe existing session (T2.1) ───────────
    $authMethod = $null
    $account = $null

    try {
        $account = _Invoke-AzCli -Command 'az account show -o json --only-show-errors'
    } catch {
        [Console]::Error.WriteLine("[Auth] No active session detected: $_")
        $account = $null
    }

    if ($account -and $account.state -eq 'Enabled') {
        [Console]::Error.WriteLine('[Auth] Active session found — using existing credentials')
        $authMethod = 'existing-session'
        _Complete-Auth -Account $account -Method $authMethod -State $state
        return
    }

    # ── Step 2: Prompt for subscription (T2.2) ──────────
    $subscriptionInput = $null

    if ($env:STARTCHAOS_NONINTERACTIVE -eq '1') {
        $subscriptionInput = $env:STARTCHAOS_SUBSCRIPTION
        if (-not $subscriptionInput) {
            $errMsg = 'STARTCHAOS_NONINTERACTIVE=1 but STARTCHAOS_SUBSCRIPTION is not set.'
            $state.auth.lastError = $errMsg
            Save-State -State $state
            Write-Error-Card -Title 'Authentication Failed' `
                -ErrorMessage $errMsg `
                -RemediationCommand '$env:STARTCHAOS_SUBSCRIPTION = "<subscription-id-or-name>"'
            exit 1
        }
    } else {
        $subscriptionInput = Read-Host 'Enter the Azure subscription ID or display name to log into:'
    }

    $subscriptionInput = ($subscriptionInput ?? '').Trim()

    if (-not $subscriptionInput) {
        $errMsg = 'Subscription input was empty. A subscription ID or display name is required.'
        $state.auth.lastError = $errMsg
        Save-State -State $state
        Write-Error-Card -Title 'Authentication Failed' `
            -ErrorMessage $errMsg `
            -RemediationCommand 'az account list -o table'
        exit 1
    }

    # ── Step 3: Device-code login + set + verify (T2.3) ─
    $authMethod = 'device-code'

    # 3a — device-code login
    try {
        [Console]::Error.WriteLine('[Auth] Starting device-code login …')
        _Invoke-AzCli -Command 'az login --use-device-code --only-show-errors -o json' | Out-Null
    } catch {
        $errMsg = "az login failed: $_"
        $state.auth.lastError = $errMsg
        Save-State -State $state
        Write-Error-Card -Title 'Authentication Failed' `
            -ErrorMessage $errMsg `
            -RemediationCommand 'az login --use-device-code'
        exit 1
    }

    # 3b — set subscription
    try {
        [Console]::Error.WriteLine("[Auth] Setting subscription to '$subscriptionInput' …")
        _Invoke-AzCli -Command "az account set --subscription `"$subscriptionInput`" --only-show-errors" | Out-Null
    } catch {
        $errMsg = "az account set failed: $_"
        $state.auth.lastError = $errMsg
        Save-State -State $state
        Write-Error-Card -Title 'Authentication Failed' `
            -ErrorMessage $errMsg `
            -RemediationCommand 'az account list -o table'
        exit 1
    }

    # 3c — verify
    try {
        $account = _Invoke-AzCli -Command 'az account show -o json --only-show-errors'
    } catch {
        $errMsg = "az account show (verify) failed: $_"
        $state.auth.lastError = $errMsg
        Save-State -State $state
        Write-Error-Card -Title 'Authentication Failed' `
            -ErrorMessage $errMsg `
            -RemediationCommand 'az account show -o json'
        exit 1
    }

    # Verify the active subscription matches what the user requested
    if (($account.id -ne $subscriptionInput) -and ($account.name -ne $subscriptionInput)) {
        $errMsg = "Active subscription '$($account.name)' ($($account.id)) does not match requested '$subscriptionInput'."
        $state.auth.lastError = $errMsg
        Save-State -State $state
        Write-Error-Card -Title 'Subscription Mismatch' `
            -ErrorMessage $errMsg `
            -RemediationCommand 'az account list -o table'
        exit 1
    }

    _Complete-Auth -Account $account -Method $authMethod -State $state
}

function _Complete-Auth {
    <# Persists auth results to state and renders the "auth ok" card. #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [hashtable]$Account,

        [Parameter(Mandatory)]
        [string]$Method,

        [Parameter(Mandatory)]
        [hashtable]$State
    )

    $now = (Get-Date).ToUniversalTime().ToString('o')

    # Resolve signed-in user — az account show nests it under .user.name
    $signedInUser = $null
    if ($Account.user -and $Account.user.name) {
        $signedInUser = $Account.user.name
    }

    # ── T2.4: Persist to state ──────────────────────────
    $State.auth.status     = 'done'
    $State.auth.method     = $Method
    $State.auth.verifiedAt = $now
    $State.auth.lastError  = $null

    $State.context.subscriptionId   = $Account.id
    $State.context.subscriptionName = $Account.name
    $State.context.tenantId         = $Account.tenantId
    $State.context.signedInUser     = $signedInUser

    Save-State -State $State

    # ── T2.5: Render "auth ok" card ─────────────────────
    Write-Card -Title 'Azure Authentication' -Status '✅ Done' `
        -Properties ([ordered]@{
            'Subscription'   = $Account.name
            'Subscription ID' = $Account.id
            'Tenant'         = $Account.tenantId
            'Signed-in User' = $signedInUser
            'Method'         = $Method
        })
}

# When imported via Import-Module, all functions are exported by default.
# When dot-sourced, functions are available in the calling scope.
