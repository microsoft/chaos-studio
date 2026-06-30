<#
.SYNOPSIS
    Polls an Azure long-running operation (LRO) until it reaches a terminal state.

.DESCRIPTION
    Supports three LRO polling patterns used by Microsoft.Chaos:
      azure-async  — polls the Azure-AsyncOperation URL for status
      location     — polls the Location URL, 202 = in-progress, 200 = done
      content      — polls the resource URL directly for provisioningState / status

    Honours the Retry-After response header. Total polling is capped at 30 minutes.

.PARAMETER PollUrl
    The URL to poll. For azure-async, this is the Azure-AsyncOperation header value.
    For location, this is the Location header value.
    For content, this is the resource URL.

.PARAMETER Style
    Polling pattern: azure-async, location, or content.

.PARAMETER IntervalSeconds
    Default polling interval when Retry-After is absent. Default: 10.

.PARAMETER TimeoutMinutes
    Maximum total polling time. Default: 30.

.OUTPUTS
    [PSCustomObject] with properties:
      .status   — terminal status string (Succeeded, Failed, Canceled, etc.)
      .finalUrl — the URL that returned the terminal response
      .body     — parsed JSON body of the terminal response
#>
function Wait-AzureLro {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$PollUrl,

        [Parameter(Mandatory)]
        [ValidateSet('azure-async', 'location', 'content')]
        [string]$Style,

        [Parameter()]
        [int]$IntervalSeconds = 10,

        [Parameter()]
        [int]$TimeoutMinutes = 30
    )

    $deadline = (Get-Date).AddMinutes($TimeoutMinutes)
    $terminalStates = @('Succeeded', 'Failed', 'Canceled', 'Cancelled', 'Deleted')

    [Console]::Error.WriteLine("[Wait-AzureLro] Polling ($Style) $PollUrl — timeout ${TimeoutMinutes}m")

    while ((Get-Date) -lt $deadline) {

        # ── Poll ────────────────────────────────────────────
        try {
            $response = Invoke-AzRest -Method GET -Uri $PollUrl
        } catch {
            # Content-style: 404 means the resource isn't created yet
            if ($Style -eq 'content' -and $_.Exception.Message -match '404') {
                [Console]::Error.WriteLine("[Wait-AzureLro] 404 on content-style poll — treating as 'not yet started'")
                Start-Sleep -Seconds $IntervalSeconds
                continue
            }
            throw
        }

        $body = $response.body
        $headers = $response.headers

        # ── Determine current status ───────────────────────
        $status = $null

        switch ($Style) {
            'azure-async' {
                $status = $body.status
                if (-not $status) { $status = $body.Status }
            }
            'location' {
                # 200 = complete, body has the resource
                # 202 = still running — but Invoke-AzRest returns the body of any 2xx
                if ($body.status)           { $status = $body.status }
                elseif ($body.Status)       { $status = $body.Status }
                else                        { $status = 'Succeeded' }  # 200 with no status field = done
            }
            'content' {
                $status = $body.properties.provisioningState
                if (-not $status) { $status = $body.status }
                if (-not $status) { $status = $body.properties.status }
                if (-not $status) { $status = 'InProgress' }
            }
        }

        [Console]::Error.WriteLine("[Wait-AzureLro] Status: $status")

        # ── Terminal? ──────────────────────────────────────
        if ($status -in $terminalStates) {
            return [PSCustomObject]@{
                status   = $status
                finalUrl = $PollUrl
                body     = $body
            }
        }

        # ── Wait for next poll ─────────────────────────────
        $delay = $IntervalSeconds
        if ($headers -and $headers['Retry-After']) {
            $retryAfter = 0
            if ([int]::TryParse($headers['Retry-After'], [ref]$retryAfter)) {
                $delay = [Math]::Max(1, $retryAfter)
            }
        }

        $remaining = ($deadline - (Get-Date)).TotalSeconds
        if ($remaining -le 0) { break }
        $delay = [Math]::Min($delay, [int]$remaining)

        [Console]::Error.WriteLine("[Wait-AzureLro] Sleeping ${delay}s (remaining: $([int]$remaining)s)")
        Start-Sleep -Seconds $delay
    }

    # ── Timeout ─────────────────────────────────────────
    [Console]::Error.WriteLine("[Wait-AzureLro] TIMEOUT after ${TimeoutMinutes} minutes")
    return [PSCustomObject]@{
        status   = 'TimedOut'
        finalUrl = $PollUrl
        body     = $null
    }
}

# When imported via Import-Module, all functions are exported by default.
# When dot-sourced, functions are available in the calling scope.
