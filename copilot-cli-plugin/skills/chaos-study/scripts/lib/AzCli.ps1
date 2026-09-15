<#
.SYNOPSIS
    The study suite's own Azure CLI transport.

.DESCRIPTION
    The suite ships as six skill directories and is packaged that way - the
    published bundles contain `skills/` and nothing else. It previously reached
    up four directory levels for the plugin's shared `Invoke-AzChaos` and
    `Invoke-AzRest`, which exist in this repository but not in the published
    package, so the local-az adapter could never initialise once the suite was
    installed on its own. Owning the transport here removes that hidden
    dependency: the six directories are the whole unit.

    The names are study-specific on purpose. Defining functions called
    `Invoke-AzChaos`/`Invoke-AzRest` would collide with the plugin's own
    definitions when both are loaded, and which one won would depend on load
    order - precisely the kind of ambiguity that produced this defect. A
    distinct name is always unambiguous.

    Behaviour is a faithful re-implementation of the plugin's shared helpers
    (same repository, same licence), preserving the details that are load
    bearing on Windows:

      * `az` is a .cmd shim, so cmd.exe re-tokenises arguments. JSON bodies go
        through temp files as `--arg @file`, and URIs containing `&` are quoted.
      * The `chaos` extension is ensured at most once per process.
      * Diagnostics go to stderr only. stdout stays clean because callers parse
        it as JSON.

    This file is dot-sourced by Adapters.ps1, which is the only file in the
    suite permitted to name Azure operations.
#>

Set-StrictMode -Version Latest

# Process-scoped guard so the extension check runs at most once per session.
$script:ChaosStudyExtensionEnsured = $false

function Initialize-ChaosStudyAzExtension {
    <#
    .SYNOPSIS
        Ensure the `chaos` Azure CLI extension is present and current.

    .DESCRIPTION
        An out-of-date extension surfaces later as an unrecognised command or
        unknown flag, with nothing pointing at the real requirement, so an
        already-installed extension is refreshed once rather than trusted.
    #>
    [CmdletBinding()]
    param()

    if ($script:ChaosStudyExtensionEnsured) { return }

    $installed = $null
    try {
        $installed = & az extension list --query "[?name=='chaos'].name | [0]" -o tsv 2>$null
    } catch {
        $installed = $null
    }

    if (-not $installed) {
        [Console]::Error.WriteLine("[chaos-study] Installing the 'chaos' Azure CLI extension...")
        & az extension add --name chaos --only-show-errors 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) {
            throw "Failed to install the 'chaos' Azure CLI extension. Ensure Azure CLI 2.75+ is installed, then run: az extension add --name chaos"
        }
    } else {
        [Console]::Error.WriteLine("[chaos-study] Ensuring the 'chaos' extension is up to date...")
        & az extension update --name chaos --only-show-errors 2>&1 | Out-Null
    }

    $script:ChaosStudyExtensionEnsured = $true
}

function Split-ChaosStudyAzOutput {
    <#
    .SYNOPSIS
        Split a merged `2>&1` capture back into stdout and stderr text.

    .DESCRIPTION
        Redirecting stderr into the success stream is the only reliable way to
        capture both from a native command, so error records are separated back
        out here by type rather than by guessing at content.
    #>
    [CmdletBinding()]
    param([AllowNull()][object[]]$Output)

    $stdoutLines = @()
    $stderrLines = @()
    foreach ($line in @($Output)) {
        if ($null -eq $line) { continue }
        if ($line -is [System.Management.Automation.ErrorRecord]) {
            $stderrLines += $line.ToString()
        } else {
            $stdoutLines += $line.ToString()
        }
    }

    return [pscustomobject]@{
        stdout = ($stdoutLines -join "`n")
        stderr = (($stderrLines -join "`n").Trim())
    }
}

function ConvertFrom-ChaosStudyAzJson {
    <#
    .SYNOPSIS
        Parse CLI output as JSON, falling back to the raw text.

    .DESCRIPTION
        Some commands answer with a bare string rather than JSON. Returning the
        text is honest; inventing an object around it would not be.
    #>
    [CmdletBinding()]
    param([AllowNull()][AllowEmptyString()][string]$Text)

    if ([string]::IsNullOrWhiteSpace($Text)) { return $null }
    try { return ($Text | ConvertFrom-Json) } catch { return $Text }
}

function Invoke-ChaosStudyAzChaos {
    <#
    .SYNOPSIS
        Run an `az chaos ...` command and return its parsed JSON result.

    .PARAMETER ChaosArgs
        The arguments following `az chaos`.

    .PARAMETER JsonArg
        Named complex arguments, written to temp files and passed as
        `--<name> @<file>` so cmd.exe cannot mangle the JSON.

    .PARAMETER AllowFailure
        Return $null on a non-zero exit instead of throwing. Used for
        best-effort reads, never to hide a failed mutation.

    .OUTPUTS
        The parsed JSON result, the raw text when the output is not JSON, or
        $null when there was no output or the command failed under
        -AllowFailure.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][AllowEmptyString()][string[]]$ChaosArgs,
        [Parameter()][AllowNull()][hashtable]$JsonArg,
        [Parameter()][switch]$AllowFailure
    )

    Initialize-ChaosStudyAzExtension

    $azArgs = @('chaos') + @($ChaosArgs)

    # Inject the subscription from the environment only when the caller has not
    # already pinned one, so an explicit choice is never overridden.
    if ($env:AZ_SUBSCRIPTION_ID -and (@($ChaosArgs) -notcontains '--subscription')) {
        $azArgs += @('--subscription', $env:AZ_SUBSCRIPTION_ID)
    }

    $azArgs += @('--only-show-errors', '-o', 'json')

    $tempFiles = @()
    try {
        if ($null -ne $JsonArg) {
            foreach ($name in $JsonArg.Keys) {
                $value = $JsonArg[$name]
                # -InputObject, never the pipeline: piping a single-element array
                # enumerates it, so a one-parameter list serialises as a bare object
                # and the CLI rejects it for wanting a list. -InputObject preserves
                # cardinality for zero, one, and many alike.
                $json = if ($value -is [string]) { $value } else { ConvertTo-Json -InputObject $value -Depth 32 -Compress }
                $tempFile = [System.IO.Path]::GetTempFileName()
                [System.IO.File]::WriteAllText($tempFile, $json, [System.Text.UTF8Encoding]::new($false))
                $tempFiles += $tempFile
                $azArgs += @("--$name", "@$tempFile")
            }
        }

        [Console]::Error.WriteLine("[chaos-study] az $((@($azArgs) | Where-Object { $_ -notmatch '^@' }) -join ' ')")

        $rawOutput = & az @azArgs 2>&1
        $exitCode = $LASTEXITCODE
        $split = Split-ChaosStudyAzOutput -Output $rawOutput
        $stdoutText = $split.stdout.Trim()

        if ($exitCode -ne 0) {
            if ($AllowFailure) { return $null }
            $errorMsg = $split.stderr
            if (-not $errorMsg) { $errorMsg = $stdoutText }
            if (-not $errorMsg) { $errorMsg = "az chaos exited with code $exitCode" }
            [Console]::Error.WriteLine("[chaos-study] ERROR: $errorMsg")
            $hint = "If 'az chaos' is unrecognized or a flag is unknown, ensure Azure CLI 2.75+ and update the extension: az extension update --name chaos"
            throw "az chaos $(@($ChaosArgs) -join ' ') failed: $errorMsg`n$hint"
        }

        return (ConvertFrom-ChaosStudyAzJson -Text $stdoutText)
    } finally {
        foreach ($file in $tempFiles) {
            if (Test-Path $file -ErrorAction SilentlyContinue) {
                Remove-Item $file -Force -ErrorAction SilentlyContinue
            }
        }
    }
}

function Invoke-ChaosStudyAzRest {
    <#
    .SYNOPSIS
        Issue an ARM request through `az rest` and return body and headers.

    .PARAMETER Method
        The HTTP method.

    .PARAMETER Uri
        An absolute URI, or an ARM path. `{subscriptionId}` is substituted from
        $env:AZ_SUBSCRIPTION_ID, and the api-version is appended when absent.

    .PARAMETER Body
        Request body; an object is serialised. Sent via a temp file so Windows
        cannot strip the quoting.

    .PARAMETER ApiVersion
        The api-version to append when the URI does not already carry one.

    .PARAMETER AllowFailure
        Return $null instead of throwing when the request fails. Intended for
        genuinely optional reads - the role-assignment snapshots behind the
        residue ledger, for instance, where the caller may simply lack
        Microsoft.Authorization/roleAssignments/read. A study must record that
        it could not see the grants; it must not die because of it. Never use
        this to paper over a mutation.

    .OUTPUTS
        [pscustomobject] with .body (parsed JSON or raw text) and .headers, or
        $null when -AllowFailure is set and the request failed.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][ValidateSet('GET', 'PUT', 'PATCH', 'POST', 'DELETE')][string]$Method,
        [Parameter(Mandatory)][string]$Uri,
        [Parameter()][AllowNull()][object]$Body,
        [Parameter()][string]$ApiVersion = '2026-05-01-preview',
        [Parameter()][switch]$AllowFailure
    )

    $fullUri = $Uri

    if ($env:AZ_SUBSCRIPTION_ID) {
        $fullUri = $fullUri -replace '\{subscriptionId\}', $env:AZ_SUBSCRIPTION_ID
    }

    # A relative path is resolved against ARM. The endpoint is overridable only
    # so a regional endpoint can be targeted during manifest rollout.
    if ($fullUri -notmatch '^https?://') {
        $armEndpoint = if ($env:STARTCHAOS_ARM_ENDPOINT) {
            $env:STARTCHAOS_ARM_ENDPOINT.TrimEnd('/')
        } else {
            'https://management.azure.com'
        }
        if (-not $fullUri.StartsWith('/')) { $fullUri = "/$fullUri" }
        $fullUri = "${armEndpoint}${fullUri}"
    }

    if ($fullUri -notmatch '[?&]api-version=') {
        $separator = if ($fullUri.Contains('?')) { '&' } else { '?' }
        $fullUri = "${fullUri}${separator}api-version=${ApiVersion}"
    }

    # On Windows `az` is a .cmd shim and cmd.exe splits an unquoted URL on `&`,
    # which silently truncates every query string that has more than one term.
    $uriArg = if ($IsWindows -ne $false -and $fullUri.Contains('&')) {
        '"' + $fullUri + '"'
    } else {
        $fullUri
    }

    $azArgs = @(
        'rest'
        '--method', $Method
        '--uri', $uriArg
        '--resource', 'https://management.azure.com/'
        '--headers', 'Content-Type=application/json'
        '--output', 'json'
    )

    $tempBodyFile = $null
    try {
        if ($null -ne $Body) {
            $bodyJson = if ($Body -is [string]) { $Body } else { ConvertTo-Json -InputObject $Body -Depth 32 -Compress }
            $tempBodyFile = [System.IO.Path]::GetTempFileName()
            [System.IO.File]::WriteAllText($tempBodyFile, $bodyJson, [System.Text.UTF8Encoding]::new($false))
            $azArgs += @('--body', "@$tempBodyFile")
        }

        [Console]::Error.WriteLine("[chaos-study] $Method $fullUri")

        $rawOutput = & az @azArgs 2>&1
        $exitCode = $LASTEXITCODE
        $split = Split-ChaosStudyAzOutput -Output $rawOutput

        if ($exitCode -ne 0) {
            $errorMsg = $split.stderr
            if (-not $errorMsg) { $errorMsg = "az rest exited with code $exitCode" }
            [Console]::Error.WriteLine("[chaos-study] ERROR: $errorMsg")
            if ($AllowFailure) { return $null }
            throw "Invoke-ChaosStudyAzRest failed ($Method $fullUri): $errorMsg"
        }

        $responseHeaders = @{}
        foreach ($line in @($split.stderr -split "`n")) {
            if ($line -match '^\s*([\w-]+):\s*(.+)$') {
                $responseHeaders[$Matches[1]] = $Matches[2].Trim()
            }
        }

        return [pscustomobject]@{
            body    = (ConvertFrom-ChaosStudyAzJson -Text $split.stdout)
            headers = $responseHeaders
        }
    } finally {
        if ($tempBodyFile -and (Test-Path $tempBodyFile -ErrorAction SilentlyContinue)) {
            Remove-Item $tempBodyFile -Force -ErrorAction SilentlyContinue
        }
    }
}
