<#
.SYNOPSIS
    State file management for the startchaos plugin.

.DESCRIPTION
    Provides Read-State, Save-State, and Set-StateProperty functions that
    persist plugin progress to $env:STARTCHAOS_STATE_PATH as pretty-printed JSON.

    Every write stamps stateSchemaVersion and updatedAt. Writes are atomic
    (write to temp file then rename) to prevent corruption on crashes.

.NOTES
    State schema version: 1
#>

# ── Constants ───────────────────────────────────────────
$script:StateSchemaVersion = 1
$script:DefaultStatePath = $null

function Get-StatePath {
    <# Returns the resolved state file path. #>
    if ($env:STARTCHAOS_STATE_PATH) {
        return $env:STARTCHAOS_STATE_PATH
    }
    # Fallback: current directory
    return Join-Path $PWD 'startchaos-state.json'
}

function New-EmptyState {
    <# Returns a new empty state object with the v1 schema. #>
    $now = (Get-Date).ToUniversalTime().ToString('o')
    return [ordered]@{
        stateSchemaVersion = $script:StateSchemaVersion
        createdAt          = $now
        updatedAt          = $now
        context            = [ordered]@{
            subscriptionId   = $null
            subscriptionName = $null
            resourceGroup    = $null
            location         = 'westus2'
            tenantId         = $null
            signedInUser     = $null
        }
        auth               = [ordered]@{
            status     = 'pending'
            method     = $null
            verifiedAt = $null
            lastError  = $null
        }
        workspace          = [ordered]@{
            status    = 'pending'
            name      = $null
            id        = $null
            identity  = [ordered]@{
                type                          = $null
                principalId                   = $null
                userAssignedIdentityResourceId = $null
            }
            scopes    = @()
            rbac      = @()
            lroUrl    = $null
            lastError = $null
        }
        setup              = [ordered]@{
            status                = 'pending'
            evaluation            = [ordered]@{
                status       = $null
                lastPolledAt = $null
            }
            recommendedScenarios  = @()
            selectedScenarioId    = $null
            configuration         = [ordered]@{
                name       = $null
                id         = $null
                parameters = @()
                validation = [ordered]@{
                    lastResult    = $null
                    permissionFix = [ordered]@{
                        state   = $null
                        summary = @{}
                    }
                }
            }
            lastError             = $null
        }
        run                = [ordered]@{
            status            = 'pending'
            scenarioRunId     = $null
            lastObservedState = $null
            actions           = @()
            errors            = @()
            lastError         = $null
        }
    }
}

function Read-State {
    <#
    .SYNOPSIS
        Reads the current state file and returns it as a hashtable.
    .DESCRIPTION
        If the file does not exist, returns a new empty state.
    .OUTPUTS
        [ordered] hashtable representing the state.
    #>
    [CmdletBinding()]
    param()

    $path = Get-StatePath

    if (-not (Test-Path $path)) {
        [Console]::Error.WriteLine("[State] No state file at $path — returning empty state")
        return New-EmptyState
    }

    try {
        $raw = Get-Content -Path $path -Raw -Encoding utf8
        $parsed = $raw | ConvertFrom-Json -AsHashtable
        [Console]::Error.WriteLine("[State] Loaded state from $path (schema v$($parsed.stateSchemaVersion))")
        return $parsed
    } catch {
        [Console]::Error.WriteLine("[State] ERROR reading $path : $_")
        throw "Failed to read state file at ${path}: $_"
    }
}

function Save-State {
    <#
    .SYNOPSIS
        Writes the state hashtable to disk atomically.
    .DESCRIPTION
        Stamps stateSchemaVersion and updatedAt on every write.
        Uses write-to-temp + rename for atomic persistence.
    .PARAMETER State
        The state hashtable to persist.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [hashtable]$State
    )

    $path = Get-StatePath

    # Stamp metadata on every write
    $State['stateSchemaVersion'] = $script:StateSchemaVersion
    $State['updatedAt'] = (Get-Date).ToUniversalTime().ToString('o')

    # Ensure createdAt is set
    if (-not $State['createdAt']) {
        $State['createdAt'] = $State['updatedAt']
    }

    $json = $State | ConvertTo-Json -Depth 32

    # Atomic write: temp file + rename
    $dir = Split-Path $path -Parent
    if ($dir -and -not (Test-Path $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }

    $tempPath = "${path}.tmp.$([System.IO.Path]::GetRandomFileName())"

    try {
        $json | Out-File -FilePath $tempPath -Encoding utf8 -NoNewline
        Move-Item -Path $tempPath -Destination $path -Force
        [Console]::Error.WriteLine("[State] Saved state to $path")
    } catch {
        # Clean up temp file on failure
        if (Test-Path $tempPath) {
            Remove-Item $tempPath -Force -ErrorAction SilentlyContinue
        }
        throw "Failed to save state to ${path}: $_"
    }
}

function Set-StateProperty {
    <#
    .SYNOPSIS
        Sets a single dot-delimited property on the state and saves.
    .DESCRIPTION
        Reads the current state, sets the property at the given path,
        and saves atomically. Supports nested dot notation
        (e.g. "auth.status", "workspace.identity.principalId").
    .PARAMETER PropertyPath
        Dot-delimited property path (e.g. "auth.status").
    .PARAMETER Value
        The value to set.
    .EXAMPLE
        Set-StateProperty -PropertyPath 'auth.status' -Value 'done'
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$PropertyPath,

        [Parameter(Mandatory, ValueFromPipeline)]
        [AllowNull()]
        [AllowEmptyString()]
        [object]$Value
    )

    $state = Read-State

    # Navigate to the parent, then set the leaf
    $parts = $PropertyPath.Split('.')
    $current = $state

    for ($i = 0; $i -lt ($parts.Count - 1); $i++) {
        $key = $parts[$i]
        # (Re)initialize the slot whenever it is missing, $null, or not a
        # dictionary — otherwise the next iteration would try to index into
        # $null (or a scalar) and throw "Cannot index into a null array."
        $needsInit = $false
        if (-not ($current -is [System.Collections.IDictionary])) {
            throw "Set-StateProperty: cannot navigate '$PropertyPath' — segment before '$key' is not a dictionary (type: $($current.GetType().FullName))."
        }
        if (-not $current.Contains($key)) {
            $needsInit = $true
        } elseif ($null -eq $current[$key] -or -not ($current[$key] -is [System.Collections.IDictionary])) {
            $needsInit = $true
        }
        if ($needsInit) {
            $current[$key] = [ordered]@{}
        }
        $current = $current[$key]
    }

    if (-not ($current -is [System.Collections.IDictionary])) {
        throw "Set-StateProperty: cannot set leaf '$PropertyPath' — parent is not a dictionary."
    }

    $leafKey = $parts[-1]
    $current[$leafKey] = $Value

    Save-State -State $state
    [Console]::Error.WriteLine("[State] Set $PropertyPath = $Value")
}

# When imported via Import-Module, all functions are exported by default.
# When dot-sourced, functions are available in the calling scope.
