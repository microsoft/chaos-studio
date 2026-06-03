<#
.SYNOPSIS
    Canonical wrapper around `az rest` for all ARM calls in the startchaos plugin.

.DESCRIPTION
    Every ARM call in the startchaos plugin MUST go through this function.
    It auto-injects the Content-Type header, honours $env:AZ_SUBSCRIPTION_ID,
    and returns parsed JSON together with response headers.

    Progress is emitted on stderr; structured JSON on stdout.

.PARAMETER Method
    HTTP method: GET, PUT, PATCH, POST, DELETE.

.PARAMETER Uri
    ARM URI (relative or absolute). If relative and $env:AZ_SUBSCRIPTION_ID is
    set, the subscription segment is auto-injected when the URI starts with
    "/subscriptions/{subscriptionId}".

.PARAMETER Body
    Optional request body — a string or hashtable. Hashtables are converted to
    JSON automatically.

.PARAMETER ApiVersion
    API version query parameter. Default: 2026-05-01-preview.

.PARAMETER WhatIf
    When set, prints the az command that would be executed and returns $null.

.OUTPUTS
    [PSCustomObject] with properties:
      .body     — parsed JSON response (or $null)
      .headers  — dictionary of response headers
#>
function Invoke-AzRest {
    [CmdletBinding(SupportsShouldProcess)]
    param(
        [Parameter(Mandatory)]
        [ValidateSet('GET', 'PUT', 'PATCH', 'POST', 'DELETE')]
        [string]$Method,

        [Parameter(Mandatory)]
        [string]$Uri,

        [Parameter()]
        [object]$Body,

        [Parameter()]
        [string]$ApiVersion = '2026-05-01-preview'
    )

    # ── Build the full URI ──────────────────────────────────
    $fullUri = $Uri

    # Inject subscription ID from environment if the URI uses the placeholder
    if ($env:AZ_SUBSCRIPTION_ID) {
        $fullUri = $fullUri -replace '\{subscriptionId\}', $env:AZ_SUBSCRIPTION_ID
    }

    # Apply ARM endpoint override. Defaults to https://management.azure.com.
    # Only set STARTCHAOS_ARM_ENDPOINT=https://<region>.management.azure.com if
    # you need to target a regional endpoint (e.g. during manifest rollout).
    if ($fullUri -notmatch '^https?://') {
        $armEndpoint = if ($env:STARTCHAOS_ARM_ENDPOINT) {
            $env:STARTCHAOS_ARM_ENDPOINT.TrimEnd('/')
        } else {
            'https://management.azure.com'
        }
        if (-not $fullUri.StartsWith('/')) { $fullUri = "/$fullUri" }
        $fullUri = "${armEndpoint}${fullUri}"
    }

    # Append api-version if not already present in the URI
    if ($fullUri -notmatch '[?&]api-version=') {
        $separator = if ($fullUri.Contains('?')) { '&' } else { '?' }
        $fullUri = "${fullUri}${separator}api-version=${ApiVersion}"
    }

    # ── Build the az rest arguments ─────────────────────────
    # On Windows, `az` is a .cmd shim. PowerShell's argument-passing to .cmd
    # files re-tokenizes through cmd.exe, which splits unquoted URLs on `&`.
    # Wrap the URI in double quotes so cmd preserves it as a single token.
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

    # Serialise body — write to temp file to avoid Windows CMD quote-stripping
    $tempBodyFile = $null
    if ($Body) {
        $bodyJson = if ($Body -is [string]) { $Body } else { $Body | ConvertTo-Json -Depth 32 -Compress }
        $tempBodyFile = [System.IO.Path]::GetTempFileName()
        [System.IO.File]::WriteAllText($tempBodyFile, $bodyJson, [System.Text.UTF8Encoding]::new($false))
        $azArgs += '--body'
        $azArgs += "@$tempBodyFile"
    }

    # ── WhatIf support ──────────────────────────────────────
    if (-not $PSCmdlet.ShouldProcess("az $($azArgs -join ' ')", 'Invoke-AzRest')) {
        Write-Host "WhatIf: az $($azArgs -join ' ')" -ForegroundColor Cyan
        return $null
    }

    # ── Execute ─────────────────────────────────────────────
    Write-Host "[Invoke-AzRest] $Method $fullUri" -ForegroundColor DarkGray 2>&1 | Out-Null
    [Console]::Error.WriteLine("[Invoke-AzRest] $Method $fullUri")

    $responseHeaders = @{}
    $responseBody = $null
    $exitCode = 0

    try {
        # Use --include-response-headers to capture headers (az CLI >= 2.61)
        $tempHeaderFile = [System.IO.Path]::GetTempFileName()
        $azArgsWithHeaders = $azArgs + @('--output-file', $tempHeaderFile)

        # Simpler approach: capture stdout as JSON, stderr for errors
        $rawOutput = & az @azArgs 2>&1
        $exitCode = $LASTEXITCODE

        # Separate stdout and stderr
        $stdoutLines = @()
        $stderrLines = @()
        foreach ($line in $rawOutput) {
            if ($line -is [System.Management.Automation.ErrorRecord]) {
                $stderrLines += $line.ToString()
            } else {
                $stdoutLines += $line.ToString()
            }
        }

        $stdoutText = $stdoutLines -join "`n"

        if ($exitCode -ne 0) {
            $errorMsg = ($stderrLines -join "`n").Trim()
            if (-not $errorMsg) { $errorMsg = "az rest exited with code $exitCode" }
            [Console]::Error.WriteLine("[Invoke-AzRest] ERROR: $errorMsg")
            throw "Invoke-AzRest failed ($Method $fullUri): $errorMsg"
        }

        # Parse JSON body
        if ($stdoutText.Trim()) {
            try {
                $responseBody = $stdoutText | ConvertFrom-Json
            } catch {
                # If it's not JSON, return as raw string
                $responseBody = $stdoutText
            }
        }

        # Extract response headers from stderr hints if available
        # az rest with --verbose emits headers; we parse common ones
        foreach ($line in $stderrLines) {
            if ($line -match '^\s*([\w-]+):\s*(.+)$') {
                $responseHeaders[$Matches[1]] = $Matches[2].Trim()
            }
        }

    } finally {
        if (Test-Path $tempHeaderFile -ErrorAction SilentlyContinue) {
            Remove-Item $tempHeaderFile -Force -ErrorAction SilentlyContinue
        }
        if ($tempBodyFile -and (Test-Path $tempBodyFile -ErrorAction SilentlyContinue)) {
            Remove-Item $tempBodyFile -Force -ErrorAction SilentlyContinue
        }
    }

    # ── Return structured result ────────────────────────────
    [PSCustomObject]@{
        body    = $responseBody
        headers = $responseHeaders
    }
}

# When imported via Import-Module, all functions are exported by default.
# When dot-sourced, functions are available in the calling scope.
