# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

<#
.SYNOPSIS
    Canonical wrapper around the `az chaos` CLI extension for all Chaos Studio Workspaces
    control-plane calls in the startchaos plugin.

.DESCRIPTION
    Chaos Studio Workspaces operations (Workspace lifecycle, Scenario discovery, Scenario
    configuration, validation, permission remediation, and run execution) MUST go
    through this function rather than raw `az rest` calls. Using the first-party
    `az chaos` command group keeps the plugin consistent with the supported CLI
    surface, gets LRO polling / retry semantics for free, and means the plugin
    always speaks the same API version the installed extension targets.

    The helper:
      * Ensures the `chaos` extension is installed (idempotent, once per process).
      * Injects `--subscription $env:AZ_SUBSCRIPTION_ID` when set (unless the
        caller already passed `--subscription`).
      * Forces `-o json --only-show-errors` and parses stdout into an object.
      * Emits progress on stderr and returns parsed JSON on stdout — matching the
        Invoke-AzRest contract it replaces.

    Non-Chaos ARM calls (managed-identity reads, role assignments) still go through
    Invoke-AzRest / az CLI, because those resources are outside the `az chaos`
    surface.

.PARAMETER ChaosArgs
    The `az chaos` argument vector WITHOUT the leading `az chaos` (e.g.
    @('workspace','show','-g',$rg,'--workspace-name',$ws)).

.PARAMETER JsonArg
    Optional hashtable of argument-name -> object. Each value is serialized to a
    temp JSON file and passed as `--<name> @<file>`. Use this for complex JSON
    values (--parameters, --filters, --exclusions) so Windows cmd.exe never
    re-tokenizes braces/quotes.

.PARAMETER AllowFailure
    When set, a non-zero exit returns $null instead of throwing. Used for
    best-effort reads (e.g. probing for a not-yet-populated "latest" endpoint).

.OUTPUTS
    The parsed JSON result (PSCustomObject or array), or $null when the command
    produced no output / failed under -AllowFailure.
#>

# Process-scoped guard so the extension check runs at most once per session.
$script:ChaosExtensionEnsured = $false

function Initialize-ChaosExtension {
    [CmdletBinding()]
    param()

    if ($script:ChaosExtensionEnsured) { return }

    $installed = $null
    try {
        $installed = & az extension list --query "[?name=='chaos'].name | [0]" -o tsv 2>$null
    } catch {
        $installed = $null
    }

    if (-not $installed) {
        [Console]::Error.WriteLine("[Invoke-AzChaos] Installing the 'chaos' Azure CLI extension...")
        & az extension add --name chaos --only-show-errors 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) {
            throw "Failed to install the 'chaos' Azure CLI extension. Ensure Azure CLI 2.75+ is installed, then run: az extension add --name chaos"
        }
    } else {
        # An out-of-date extension (or CLI < 2.75) surfaces later as an
        # unrecognized-command / unknown-flag error with nothing pointing at the
        # requirement. Refresh the already-installed extension once per session so
        # the command surface matches this plugin's expectations.
        [Console]::Error.WriteLine("[Invoke-AzChaos] Ensuring the 'chaos' extension is up to date...")
        & az extension update --name chaos --only-show-errors 2>&1 | Out-Null
    }

    $script:ChaosExtensionEnsured = $true
}

function Invoke-AzChaos {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [AllowEmptyString()]
        [string[]]$ChaosArgs,

        [Parameter()]
        [hashtable]$JsonArg,

        [Parameter()]
        [switch]$AllowFailure
    )

    Initialize-ChaosExtension

    # ── Assemble the full argument vector ───────────────────
    $azArgs = @('chaos') + $ChaosArgs

    # Inject subscription from the environment when the caller hasn't set one.
    if ($env:AZ_SUBSCRIPTION_ID -and ($ChaosArgs -notcontains '--subscription')) {
        $azArgs += @('--subscription', $env:AZ_SUBSCRIPTION_ID)
    }

    $azArgs += @('--only-show-errors', '-o', 'json')

    # ── Serialise complex JSON args to temp files (@file) ───
    # Windows `az` is a .cmd shim; unquoted JSON braces/quotes get mangled by
    # cmd.exe re-tokenization. Passing `--<name> @<file>` sidesteps that.
    $tempFiles = @()
    if ($JsonArg) {
        foreach ($name in $JsonArg.Keys) {
            $value = $JsonArg[$name]
            $json = if ($value -is [string]) { $value } else { $value | ConvertTo-Json -Depth 32 -Compress }
            $tempFile = [System.IO.Path]::GetTempFileName()
            [System.IO.File]::WriteAllText($tempFile, $json, [System.Text.UTF8Encoding]::new($false))
            $tempFiles += $tempFile
            $azArgs += @("--$name", "@$tempFile")
        }
    }

    [Console]::Error.WriteLine("[Invoke-AzChaos] az $(($azArgs | Where-Object { $_ -notmatch '^@' }) -join ' ')")

    try {
        $rawOutput = & az @azArgs 2>&1
        $exitCode = $LASTEXITCODE

        $stdoutLines = @()
        $stderrLines = @()
        foreach ($line in $rawOutput) {
            if ($line -is [System.Management.Automation.ErrorRecord]) {
                $stderrLines += $line.ToString()
            } else {
                $stdoutLines += $line.ToString()
            }
        }
        $stdoutText = ($stdoutLines -join "`n").Trim()

        if ($exitCode -ne 0) {
            if ($AllowFailure) { return $null }
            $errorMsg = ($stderrLines -join "`n").Trim()
            if (-not $errorMsg) { $errorMsg = $stdoutText }
            if (-not $errorMsg) { $errorMsg = "az chaos exited with code $exitCode" }
            [Console]::Error.WriteLine("[Invoke-AzChaos] ERROR: $errorMsg")
            $hint = "If 'az chaos' is unrecognized or a flag is unknown, ensure Azure CLI 2.75+ and update the extension: az extension update --name chaos"
            throw "az chaos $($ChaosArgs -join ' ') failed: $errorMsg`n$hint"
        }

        if (-not $stdoutText) { return $null }
        try {
            return $stdoutText | ConvertFrom-Json
        } catch {
            return $stdoutText
        }
    } finally {
        foreach ($f in $tempFiles) {
            if (Test-Path $f -ErrorAction SilentlyContinue) {
                Remove-Item $f -Force -ErrorAction SilentlyContinue
            }
        }
    }
}

# When imported via Import-Module, all functions are exported by default.
# When dot-sourced, functions are available in the calling scope.
