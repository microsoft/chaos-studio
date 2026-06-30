<#
.SYNOPSIS
    Step driver for the run-scenario skill.
.DESCRIPTION
    Executes a ScenarioConfiguration and streams ScenarioRun status until terminal state.
    Follows 5 fixed sub-steps: confirm → validate/fix-permissions → execute → resolve-run → poll.
#>
[CmdletBinding()]
param()

$sharedDir = Join-Path (Split-Path (Split-Path (Split-Path $PSScriptRoot))) 'scripts'
. (Join-Path $sharedDir 'State.ps1')
. (Join-Path $sharedDir 'Render.ps1')
. (Join-Path $sharedDir 'Invoke-AzRest.ps1')
. (Join-Path $sharedDir 'Wait-AzureLro.ps1')
. (Join-Path $sharedDir 'New-RunReport.ps1')
. (Join-Path $sharedDir 'Rbac.ps1')
. (Join-Path $sharedDir 'Validate-AndFix.ps1')

$state = Read-State

# Short-circuit
if ($state.run.status -eq 'done') {
    Write-Card -Title 'Run' -Status '✅ Already complete' -Properties ([ordered]@{
        'Run ID' = $state.run.scenarioRunId
        'Status' = $state.run.lastObservedState
    })
    exit 0
}

if ($state.setup.status -ne 'done') {
    Write-Error-Card -Title 'Setup Required' -ErrorMessage 'Scenario setup must be completed first.'
    exit 1
}

$sub = $state.context.subscriptionId
$rg = $state.context.resourceGroup
$wsName = $state.workspace.name
$scenarioId = $state.setup.selectedScenarioId
$configName = $state.setup.configuration.name
$configId = $state.setup.configuration.id

# Extract scenario name from the scenario ID
$scenarioName = ($scenarioId -split '/')[-1]

$wsBase = "/subscriptions/$sub/resourceGroups/$rg/providers/Microsoft.Chaos/workspaces/$wsName"
$configBase = "$wsBase/scenarios/$scenarioName/configurations/$configName"

Set-StateProperty -PropertyPath 'run.status' -Value 'in_progress'

try {
    # ── Step 1: Confirm execution ───────────────────────
    $skipConfirm = ($env:STARTCHAOS_NONINTERACTIVE -eq '1')

    Write-Card -Title 'Execute Scenario' -Status '⚡ Ready' -Properties ([ordered]@{
        'Scenario'       = $scenarioName
        'Configuration'  = $configName
        'Parameters'     = ($state.setup.configuration.parameters | ForEach-Object { "$($_.key)=$($_.value)" }) -join ', '
        'Workspace Scope' = ($state.workspace.scopes -join ', ')
    })

    if (-not $skipConfirm) {
        # Confirmation is handled by the orchestrator agent (start-chaos skill).
        # In direct invocation, proceeding automatically.
    }

    # ── Step 2: Validate + auto-fix permissions ─────────
    # ALWAYS validate before execute. If validation returns anything other than
    # 'Succeeded', the shared helper invokes fixResourcePermissions and
    # re-validates. Execution is STRICTLY gated on the final status below.
    $dataPlaneApi = '2026-05-01-preview'
    try {
        Invoke-ValidateAndFix -ConfigUri $configBase -StateBasePath 'setup.configuration' -ApiVersion $dataPlaneApi
    } catch {
        $vfErr = $_.Exception.Message
        Set-StateProperty -PropertyPath 'run.lastError' -Value $vfErr
        Set-StateProperty -PropertyPath 'run.status'    -Value 'failed'
        if ($vfErr -notmatch '^fixResourcePermissions 403') {
            Write-Error-Card -Title 'Pre-Run Validation Error' -ErrorMessage $vfErr
        }
        exit 1
    }
    $valStatus = (Read-State).setup.configuration.validation.lastResult

    # ── Step 2b: STRICT pre-execute gate ────────────────
    # The scenario MUST NOT run unless validation is 'Succeeded'. Proceeding
    # with 'RequiresAttention'/'Failed' historically led to scenario runs that
    # failed in seconds with opaque server-side errors.
    if ($valStatus -ne 'Succeeded') {
        $gateMsg = "Pre-run validation status is ``$valStatus`` (expected ``Succeeded``). Refusing to execute the scenario. The fixResourcePermissions step ran but did not fully resolve the issue — inspect ``setup.configuration.validation`` in the state file, then either grant the missing roles manually or re-run after the workspace identity has been elevated."
        Set-StateProperty -PropertyPath 'run.lastError' -Value $gateMsg
        Set-StateProperty -PropertyPath 'run.status'    -Value 'failed'
        Write-Error-Card -Title 'Execution Blocked — Validation Not Succeeded' -ErrorMessage $gateMsg
        exit 1
    }

    # ── Step 3: Execute ─────────────────────────────────
    Write-Card -Title 'Executing' -Status '🔄 Starting...'

    $executeUri = "$configBase/execute"
    $execResp = Invoke-AzRest -Method POST -Uri $executeUri -ApiVersion $dataPlaneApi

    # ── Step 4: Resolve ScenarioRun ID ──────────────────
    $runId = $null
    $locationUrl = $null

    if ($execResp.headers -and $execResp.headers['Location']) {
        $locationUrl = $execResp.headers['Location']
        # The Location header points to the run resource
        # Extract run ID from the URL: .../runs/{runId}?api-version=...
        if ($locationUrl -match '/runs/([^?/]+)') {
            $runId = $Matches[1]
        }
    }

    if (-not $runId) {
        # Fallback: list runs and find the newest
        Write-Card -Title 'Resolving Run ID' -Status '🔄' -Body 'Location header did not contain run ID, listing runs...'
        $runsUri = "$wsBase/scenarios/$scenarioName/runs"
        $runsResp = Invoke-AzRest -Method GET -Uri $runsUri
        $runs = @($runsResp.body.value | Where-Object {
            $_.properties.scenarioConfigurationName -eq $configName
        } | Sort-Object { $_.properties.startTime } -Descending)

        if ($runs.Count -gt 0) {
            $runId = $runs[0].name
        } else {
            throw "Could not resolve ScenarioRun ID after execution"
        }
    }

    Set-StateProperty -PropertyPath 'run.scenarioRunId' -Value $runId
    $runUri = "$wsBase/scenarios/$scenarioName/runs/$runId"

    Write-Card -Title 'Run Started' -Status '🔄' -Properties ([ordered]@{
        'Run ID' = $runId
    })

    # ── Step 5: Poll run status ─────────────────────────
    $terminalStates = @('Succeeded', 'Failed', 'Canceled')
    $startTime = Get-Date
    $maxPollMinutes = 30
    $deadline = $startTime.AddMinutes($maxPollMinutes)
    $lastRenderedStatus = $null
    $lastRenderedActions = $null

    while ((Get-Date) -lt $deadline) {
        $runResp = Invoke-AzRest -Method GET -Uri $runUri
        $runBody = $runResp.body
        $runStatus = $runBody.properties.status
        $elapsed = ((Get-Date) - $startTime).ToString('hh\:mm\:ss')

        Set-StateProperty -PropertyPath 'run.lastObservedState' -Value $runStatus

        # Build status card
        $statusProps = [ordered]@{
            'Status'  = $runStatus
            'Elapsed' = $elapsed
            'Run ID'  = $runId
        }

        if ($runBody.properties.startTime) {
            $statusProps['Started'] = $runBody.properties.startTime
        }

        # Per-action summary
        $summary = @($runBody.properties.scenarioRunSummary)
        # Build a fingerprint of current action states to detect changes
        $actionFingerprint = ($summary | ForEach-Object { "$($_.actionUrn):$($_.state)" }) -join ','

        if ($summary.Count -gt 0) {
            Set-StateProperty -PropertyPath 'run.actions' -Value @($summary | ForEach-Object {
                @{
                    actionUrn   = $_.actionUrn
                    state       = $_.state
                    startedAt   = $_.startedAt
                    completedAt = $_.completedAt
                }
            })

            # Only render when status or action states change
            if ($runStatus -ne $lastRenderedStatus -or $actionFingerprint -ne $lastRenderedActions) {
                Write-Card -Title "Scenario Run" -Status "🔄 $runStatus" -Properties $statusProps
                Write-Table -Data ($summary | ForEach-Object {
                    [ordered]@{
                        'Action'    = $_.actionUrn
                        'State'     = $_.state
                        'Started'   = if ($_.startedAt) { $_.startedAt } else { '—' }
                        'Completed' = if ($_.completedAt) { $_.completedAt } else { '—' }
                        'Resources' = if ($_.resources) { $_.resources.Count } else { 0 }
                    }
                }) -Title 'Action Summary'
                $lastRenderedStatus = $runStatus
                $lastRenderedActions = $actionFingerprint
            }
        } else {
            if ($runStatus -ne $lastRenderedStatus) {
                Write-Card -Title "Scenario Run" -Status "🔄 $runStatus" -Properties $statusProps
                $lastRenderedStatus = $runStatus
            }
        }

        # Check terminal
        if ($runStatus -in $terminalStates) {
            # Capture errors
            $errors = @()
            if ($runBody.properties.executionErrors) {
                $execErrors = $runBody.properties.executionErrors
                if ($execErrors.permission) { $errors += $execErrors.permission }
                if ($execErrors.resource) { $errors += $execErrors.resource }
            }
            if ($runBody.properties.errors) {
                $errors += $runBody.properties.errors
            }

            Set-StateProperty -PropertyPath 'run.errors' -Value $errors
            Set-StateProperty -PropertyPath 'run.status' -Value $(if ($runStatus -eq 'Succeeded') { 'done' } else { 'failed' })
            Set-StateProperty -PropertyPath 'run.lastObservedState' -Value $runStatus

            # Final summary
            $finalProps = [ordered]@{
                'Status'   = $runStatus
                'Run ID'   = $runId
                'Started'  = $runBody.properties.startTime
                'Ended'    = $runBody.properties.endTime
                'Duration' = $elapsed
            }

            if ($summary.Count -gt 0) {
                $stateCounts = $summary | Group-Object -Property state | ForEach-Object { "$($_.Name): $($_.Count)" }
                $finalProps['Actions'] = $stateCounts -join ', '
            }

            if ($errors.Count -gt 0) {
                $finalProps['Errors'] = $errors.Count
            }

            $statusEmoji = switch ($runStatus) {
                'Succeeded' { '✅' }
                'Failed'    { '❌' }
                'Canceled'  { '⚠️' }
                default     { '❓' }
            }

            Write-Card -Title 'Scenario Run Complete' -Status "$statusEmoji $runStatus" -Properties $finalProps

            if ($errors.Count -gt 0) {
                Write-Table -Data ($errors | ForEach-Object {
                    if ($_.resourceId) {
                        [ordered]@{
                            'Resource'  = $_.resourceId
                            'Missing'   = ($_.missingPermissions -join ', ')
                            'Recommended' = ($_.recommendedRoles -join ', ')
                        }
                    } elseif ($_.errorCode) {
                        [ordered]@{
                            'Code'    = $_.errorCode
                            'Message' = $_.errorMessage
                        }
                    }
                }) -Title 'Execution Errors'
            }

            if ($runStatus -ne 'Succeeded') {
                Set-StateProperty -PropertyPath 'run.lastError' -Value "Run completed with status: $runStatus"
            }

            # ── Emit structured HTML report ─────────────
            try {
                $reportPath = New-RunReport -RunBody $runBody -State (Read-State)
                Set-StateProperty -PropertyPath 'run.reportPath' -Value $reportPath
                Write-Card -Title 'Run Report' -Status '📄 Generated' -Properties ([ordered]@{
                    'Path' = $reportPath
                    'Open' = "file:///$([uri]::EscapeUriString($reportPath.Replace('\','/')))"
                })
            } catch {
                Write-Warning "Failed to generate HTML report: $($_.Exception.Message)"
            }

            exit $(if ($runStatus -eq 'Succeeded') { 0 } else { 1 })
        }

        # Wait
        $delay = 10
        if ($runResp.headers -and $runResp.headers['Retry-After']) {
            [int]::TryParse($runResp.headers['Retry-After'], [ref]$delay) | Out-Null
        }
        Start-Sleep -Seconds $delay
    }

    # Timeout
    Set-StateProperty -PropertyPath 'run.lastError' -Value 'Polling timed out'
    Write-Error-Card -Title 'Run Timeout' -ErrorMessage "Scenario run polling exceeded $maxPollMinutes minutes. The run may still be in progress." `
        -RemediationCommand "az rest --method GET --uri `"$runUri`" --headers Content-Type=application/json"
    exit 1

} catch {
    $errorMsg = $_.Exception.Message
    Set-StateProperty -PropertyPath 'run.lastError' -Value $errorMsg
    Set-StateProperty -PropertyPath 'run.status' -Value 'failed'
    Write-Error-Card -Title 'RunScenario Error' -ErrorMessage $errorMsg
    exit 1
}
