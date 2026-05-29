<#
.SYNOPSIS
    Discovers the Log Analytics workspace associated with each targeted
    Azure resource via its diagnostic settings.

.DESCRIPTION
    For each unique ARM resource ID:
        GET {resourceId}/providers/Microsoft.Insights/diagnosticSettings
            ?api-version=<diagnosticSettings>

    Picks the first setting whose properties.workspaceId is non-null and
    verifies the workspace is reachable via a cheap GET on the workspace
    resource itself.

    Per-resource results are cached in a hashtable keyed by lowercased
    resource ID, so repeated calls within the same invocation never hit
    ARM twice for the same resource. Callers may pass an existing cache
    via -Cache to share across invocations.

    Multiple resources resolving to different workspaces are returned as a
    single map; downstream callers can group by workspace and issue one
    KQL request per workspace.

    Parallel fan-out uses PowerShell 7's `ForEach-Object -Parallel` with
    a default throttle of 4 (overridable via -ThrottleLimit).

.PARAMETER ResourceIds
    Array of fully-qualified Azure resource IDs.

.PARAMETER Cache
    Optional shared hashtable used as a per-resource cache. The function
    both reads cached entries from and writes new entries to this map.

.PARAMETER ThrottleLimit
    Maximum parallel ARM calls. Default: 4 (matches `Constants.ps1`).

.OUTPUTS
    [hashtable] keyed by resource ID with values shaped:
        @{
            resourceId        = '<arm-id>'
            workspaceId       = '<la-arm-id>'  # null when unavailable
            workspaceVerified = $true|$false
            status            = 'available' | 'unavailable'
            reason            = $null | 'no_diagnostic_setting'
                                       | 'no_workspace_destination'
                                       | 'workspace_unreachable'
                                       | 'error:<message>'
        }

.NOTES
    Failure mode: if no setting and no user-supplied workspace → emit a
    per-resource `status = "unavailable"` marker and continue with
    metrics-only correlation. Callers MUST NOT throw on a single
    unavailable resource.
#>
function Get-DiagnosticSettings {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [AllowEmptyCollection()]
        [string[]]$ResourceIds,

        [Parameter()]
        [hashtable]$Cache,

        [Parameter()]
        [int]$ThrottleLimit
    )

    . "$PSScriptRoot/Constants.ps1"
    $sharedDir = Join-Path (Split-Path (Split-Path $PSScriptRoot)) '_shared'
    . (Join-Path $sharedDir 'Invoke-AzRest.ps1')

    if (-not $PSBoundParameters.ContainsKey('ThrottleLimit')) {
        $ThrottleLimit = $script:ChaosImpactDefault_DiagThrottleLimit
    }
    if (-not $Cache) { $Cache = @{} }

    if ($ResourceIds.Count -eq 0) {
        return $Cache
    }

    # Dedupe and split cached vs. uncached
    $uniqueIds = $ResourceIds | Sort-Object -Unique
    $toQuery = @()
    foreach ($id in $uniqueIds) {
        $key = $id.ToLowerInvariant()
        if (-not $Cache.ContainsKey($key)) { $toQuery += $id }
    }

    if ($toQuery.Count -eq 0) {
        return $Cache
    }

    $diagApi = $script:ChaosImpactApi_DiagnosticSettings
    $workspaceApi = $script:ChaosImpactApi_LogAnalyticsWorkspace

    # ── Parallel fan-out ────────────────────────────────
    # ForEach-Object -Parallel runs each item in a fresh runspace, so we
    # must re-dot-source helpers inside the script block and use `$using:`
    # to capture variables from the parent scope.
    $invokeAzRestPath = Join-Path $sharedDir 'Invoke-AzRest.ps1'

    $results = $toQuery | ForEach-Object -ThrottleLimit $ThrottleLimit -Parallel {
        $resourceId = $_
        . $using:invokeAzRestPath

        $entry = [ordered]@{
            resourceId        = $resourceId
            workspaceId       = $null
            workspaceVerified = $false
            status            = 'unavailable'
            reason            = $null
        }

        try {
            $diagUri = "$resourceId/providers/Microsoft.Insights/diagnosticSettings"
            $resp = Invoke-AzRest -Method GET -Uri $diagUri -ApiVersion $using:diagApi
            $settings = @($resp.body.value)

            if ($settings.Count -eq 0) {
                $entry.reason = 'no_diagnostic_setting'
            } else {
                $workspaceTarget = $null
                foreach ($s in $settings) {
                    $wsId = $s.properties.workspaceId
                    if ($wsId) { $workspaceTarget = $wsId; break }
                }

                if (-not $workspaceTarget) {
                    $entry.reason = 'no_workspace_destination'
                } else {
                    $entry.workspaceId = $workspaceTarget
                    # Verify the workspace is reachable (cheap GET).
                    try {
                        $wsResp = Invoke-AzRest -Method GET -Uri $workspaceTarget -ApiVersion $using:workspaceApi
                        if ($wsResp.body) {
                            $entry.workspaceVerified = $true
                            $entry.status = 'available'
                        } else {
                            $entry.reason = 'workspace_unreachable'
                        }
                    } catch {
                        $entry.reason = 'workspace_unreachable'
                    }
                }
            }
        } catch {
            $entry.reason = "error:$($_.Exception.Message)"
        }

        [pscustomobject]@{ key = $resourceId.ToLowerInvariant(); entry = $entry }
    }

    foreach ($r in $results) {
        $Cache[$r.key] = $r.entry
    }

    return $Cache
}
