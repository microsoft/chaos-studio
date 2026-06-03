<#
.SYNOPSIS
    Step driver for the setup-scenario skill.
.DESCRIPTION
    Discovers recommended scenarios, presents them to the user, builds a
    ScenarioConfiguration, validates it, and auto-fixes permissions if needed.
    
    Follows 5 fixed sub-steps: refresh → evaluate → list → configure → validate.
#>
[CmdletBinding()]
param(
    [Parameter()][string]$ParameterMode,                 # 'manual' or 'autofill' — if omitted, script pauses for orchestrator to prompt
    [Parameter()][string]$ScenarioName,                 # e.g. 'EntraOutage-1.0' — bypasses prompt
    [Parameter()][hashtable]$ParameterValues = @{}      # key-value overrides applied on top of defaults (e.g. @{ duration = 'PT5M' })
)

$sharedDir = Join-Path (Split-Path (Split-Path (Split-Path $PSScriptRoot))) 'scripts'
. (Join-Path $sharedDir 'State.ps1')
. (Join-Path $sharedDir 'Render.ps1')
. (Join-Path $sharedDir 'Invoke-AzRest.ps1')
. (Join-Path $sharedDir 'Wait-AzureLro.ps1')
. (Join-Path $sharedDir 'Validate-AndFix.ps1')

$state = Read-State

# Short-circuit
if ($state.setup.status -eq 'done') {
    Write-Card -Title 'Setup' -Status '✅ Already complete' -Properties ([ordered]@{
        'Scenario'      = $state.setup.selectedScenarioId
        'Configuration' = $state.setup.configuration.id
    })
    exit 0
}

if ($state.workspace.status -ne 'done') {
    Write-Error-Card -Title 'Workspace Required' -ErrorMessage 'Workspace must be created first.'
    exit 1
}

$sub = $state.context.subscriptionId
$rg = $state.context.resourceGroup
$wsName = $state.workspace.name
$wsBase = "/subscriptions/$sub/resourceGroups/$rg/providers/Microsoft.Chaos/workspaces/$wsName"

Set-StateProperty -PropertyPath 'setup.status' -Value 'in_progress'

try {
    # ── Step 1: Check/Trigger evaluation ────────────────
    Write-Card -Title 'Checking Recommendations' -Status '🔄'
    
    $evalUri = "$wsBase/evaluations/latest"
    $evalResponse = $null
    $needsRefresh = $false
    try {
        $evalResponse = Invoke-AzRest -Method GET -Uri $evalUri
        # If the previous evaluation failed, trigger a fresh refresh
        $prevStatus = $evalResponse.body.properties.status
        if ($prevStatus -in @('Failed', 'Canceled')) {
            [Console]::Error.WriteLine("[Setup] Previous evaluation status was '$prevStatus' — triggering fresh refresh")
            $needsRefresh = $true
        }
    } catch {
        if ($_.Exception.Message -match '(?i)(404|Not Found|NotFound)') {
            # No evaluation yet — trigger refresh
            $needsRefresh = $true
        } else {
            throw
        }
    }

    if ($needsRefresh) {
        Write-Card -Title 'Triggering Recommendation Refresh' -Status '🔄'
        $refreshUri = "$wsBase/refreshRecommendations"
        $refreshResp = Invoke-AzRest -Method POST -Uri $refreshUri
    }

    # ── Step 2: Poll evaluation ─────────────────────────
    $terminalEvalStates = @('Succeeded', 'PartiallySucceeded', 'Failed', 'Canceled')
    $maxEvalPolls = 60
    $evalPoll = 0

    while ($evalPoll -lt $maxEvalPolls) {
        $evalResp = Invoke-AzRest -Method GET -Uri $evalUri
        $evalStatus = $evalResp.body.properties.status

        Set-StateProperty -PropertyPath 'setup.evaluation.status' -Value $evalStatus
        Set-StateProperty -PropertyPath 'setup.evaluation.lastPolledAt' -Value (Get-Date).ToUniversalTime().ToString('o')

        if ($evalStatus -in $terminalEvalStates) {
            Write-Card -Title 'Evaluation Complete' -Status "✅ $evalStatus" -Properties ([ordered]@{
                'Scenarios Evaluated'  = $evalResp.body.properties.numScenariosToEvaluate
                'Succeeded'            = $evalResp.body.properties.numScenariosEvaluatedSucceeded
                'Failed'               = $evalResp.body.properties.numScenariosEvaluatedFailed
            })
            break
        }

        Write-Card -Title 'Evaluation In Progress' -Status "🔄 $evalStatus" -Body "Poll $evalPoll — waiting..."
        
        $delay = 10
        if ($evalResp.headers -and $evalResp.headers['Retry-After']) {
            [int]::TryParse($evalResp.headers['Retry-After'], [ref]$delay) | Out-Null
        }
        Start-Sleep -Seconds $delay
        $evalPoll++
    }

    # ── Step 3: List & filter scenarios ─────────────────
    $scenariosUri = "$wsBase/scenarios"
    $scenariosResp = Invoke-AzRest -Method GET -Uri $scenariosUri
    $allScenarios = @($scenariosResp.body.value)

    $recommended = @($allScenarios | Where-Object {
        $_.properties.recommendation.recommendationStatus -eq 'Recommended'
    })

    if ($recommended.Count -eq 0) {
        Write-Card -Title 'No Recommended Scenarios' -Status '⚠️' `
            -Body 'No scenarios are recommended for your workspace scope. This typically means no applicable resources were discovered. Try broadening your workspace scope or adding more resources.'
        Set-StateProperty -PropertyPath 'setup.status' -Value 'done'
        Set-StateProperty -PropertyPath 'setup.note' -Value 'no-recommendations'
        exit 0
    }

    # Render the list
    $scenarioTable = @()
    for ($i = 0; $i -lt $recommended.Count; $i++) {
        $s = $recommended[$i]
        $scenarioTable += [ordered]@{
            '#'           = $i + 1
            'Name'        = $s.name
            'Description' = if ($s.properties.description.Length -gt 80) { $s.properties.description.Substring(0,77) + '...' } else { $s.properties.description }
            'Version'     = $s.properties.version
        }
    }
    Write-Table -Data $scenarioTable -Title "Recommended Scenarios ($($recommended.Count))"

    Set-StateProperty -PropertyPath 'setup.recommendedScenarios' -Value @($recommended | ForEach-Object {
        @{ id = $_.id; name = $_.name; description = $_.properties.description }
    })

    # ── Scenario selection ──────────────────────────────
    # Priority: -ScenarioName arg > $env:STARTCHAOS_SCENARIO > auto (only if 1 recommended) > pause-for-user
    $resolvedName = $ScenarioName
    if (-not $resolvedName -and $env:STARTCHAOS_SCENARIO) {
        $resolvedName = $env:STARTCHAOS_SCENARIO
    }

    $selectedScenario = $null
    if ($resolvedName) {
        $selectedScenario = $recommended | Where-Object { $_.name -eq $resolvedName } | Select-Object -First 1
        if (-not $selectedScenario) {
            throw "Requested scenario '$resolvedName' is not in the recommended list. Available: $(($recommended | ForEach-Object { $_.name }) -join ', ')"
        }
    } elseif ($recommended.Count -eq 1) {
        $selectedScenario = $recommended[0]
        Write-Card -Title 'Auto-selected' -Body "Only one recommended scenario: $($selectedScenario.name)"
    } else {
        # Multiple recommended and no explicit choice → pause for orchestrator to prompt user
        Set-StateProperty -PropertyPath 'setup.awaitingSelection' -Value $true
        Set-StateProperty -PropertyPath 'setup.status' -Value 'awaiting_input'
        Write-Card -Title 'Scenario Selection Required' -Status '⏸️' -Body @"
Multiple scenarios are recommended for your workspace scope.
Please choose one and re-invoke this skill with ``-ScenarioName <name>`` (or set ``$env:STARTCHAOS_SCENARIO``).

Available: $(($recommended | ForEach-Object { $_.name }) -join ', ')
"@
        exit 2
    }

    Set-StateProperty -PropertyPath 'setup.selectedScenarioId' -Value $selectedScenario.id
    Set-StateProperty -PropertyPath 'setup.awaitingSelection' -Value $false

    Write-Card -Title 'Selected Scenario' -Status '✅' -Properties ([ordered]@{
        'Name'        = $selectedScenario.name
        'Description' = $selectedScenario.properties.description
        'Version'     = $selectedScenario.properties.version
    })

    # ── Step 4: Build parameters ────────────────────────
    $scenarioParams = @($selectedScenario.properties.parameters)
    $configParams = @()

    if ($scenarioParams.Count -gt 0) {
        Write-Table -Data ($scenarioParams | ForEach-Object {
            [ordered]@{
                'Name'     = $_.name
                'Type'     = $_.type
                'Required' = $_.required
                'Default'  = $_.default
                'Description' = $_.description
            }
        }) -Title 'Scenario Parameters'
    }

    # If ParameterMode was not provided and there are parameters, pause for orchestrator to prompt
    if (-not $ParameterMode -and $scenarioParams.Count -gt 0) {
        Set-StateProperty -PropertyPath 'setup.awaitingParameterMode' -Value $true
        Set-StateProperty -PropertyPath 'setup.status' -Value 'awaiting_input'
        Write-Card -Title 'Parameter Mode Required' -Status '⏸️' -Body @"
The scenario has $($scenarioParams.Count) parameter(s).
Please choose how to fill them and re-invoke this skill with ``-ParameterMode autofill`` or ``-ParameterMode manual``.
"@
        exit 3
    }

    # Default to autofill when there are no parameters (nothing to prompt for)
    if (-not $ParameterMode) { $ParameterMode = 'autofill' }

    foreach ($param in $scenarioParams) {
        $value = $null
        if ($ParameterValues.ContainsKey($param.name)) {
            # Explicit override from caller takes priority
            $value = $ParameterValues[$param.name]
        } elseif ($ParameterMode -eq 'autofill') {
            $value = $param.default
            if (-not $value -and $param.required) {
                # For ARM ID parameters, try workspace scope
                if ($param.type -eq 'string' -and $param.name -match 'resourceId|ResourceId|scope') {
                    $value = $state.workspace.scopes[0]
                }
            }
        }
        # Only add if we have a value
        if ($value) {
            $configParams += @{ key = $param.name; value = "$value" }
        }
    }

    # ── Step 5: Create ScenarioConfiguration ────────────
    $configName = "config-" + [System.Guid]::NewGuid().ToString().Substring(0, 8)
    $scenarioName = $selectedScenario.name
    $configUri = "$wsBase/scenarios/$scenarioName/configurations/$configName"

    $configBody = @{
        properties = @{
            scenarioId = $selectedScenario.id
            parameters = $configParams
        }
    }

    Write-Card -Title 'Creating Configuration' -Status '🔄' -JsonPreview $configBody

    $configResp = Invoke-AzRest -Method PUT -Uri $configUri -Body $configBody

    # Poll if async
    if ($configResp.headers -and $configResp.headers['Azure-AsyncOperation']) {
        $asyncUrl = $configResp.headers['Azure-AsyncOperation']
        $lroResult = Wait-AzureLro -PollUrl $asyncUrl -Style 'azure-async'
        if ($lroResult.status -ne 'Succeeded') {
            throw "Configuration provisioning $($lroResult.status)"
        }
    }

    # GET to confirm
    $configGetResp = Invoke-AzRest -Method GET -Uri $configUri
    Set-StateProperty -PropertyPath 'setup.configuration.name' -Value $configName
    Set-StateProperty -PropertyPath 'setup.configuration.id' -Value $configGetResp.body.id
    Set-StateProperty -PropertyPath 'setup.configuration.parameters' -Value $configParams

    Write-Card -Title 'Configuration Created' -Status '✅' -Properties ([ordered]@{
        'Name' = $configName
        'ID'   = $configGetResp.body.id
    })

    # ── Step 6: Validate + auto-fix permissions ─────────
    # Data-plane ops (validate / fixResourcePermissions / execute) require 2026-05-01-preview.
    # Validation is ALWAYS run; fixResourcePermissions is invoked whenever
    # validation returns anything other than 'Succeeded' or reports validationErrors.
    try {
        Invoke-ValidateAndFix -ConfigUri $configUri -StateBasePath 'setup.configuration' -ApiVersion '2026-05-01-preview'
    } catch {
        $vfErr = $_.Exception.Message
        Set-StateProperty -PropertyPath 'setup.lastError' -Value $vfErr
        Set-StateProperty -PropertyPath 'setup.status'    -Value 'failed'
        # Error card already rendered by the helper for 403 cases.
        if ($vfErr -notmatch '^fixResourcePermissions 403') {
            Write-Error-Card -Title 'Validation Error' -ErrorMessage $vfErr
        }
        exit 1
    }
    $valStatus = (Read-State).setup.configuration.validation.lastResult

    # ── Step 7: Mark done ───────────────────────────────
    # NOTE: We do not gate setup.status on $valStatus -eq 'Succeeded' — the
    # run-scenario skill enforces the strict pre-execute gate. Setup is "done"
    # as long as configuration was created and validation has been attempted.
    Set-StateProperty -PropertyPath 'setup.status' -Value 'done'

    Write-Card -Title 'SetupScenario Complete' -Status '✅ Done' -Properties ([ordered]@{
        'Scenario'      = $selectedScenario.name
        'Configuration' = $configName
        'Validation'    = $valStatus
    })

    exit 0

} catch {
    $errorMsg = $_.Exception.Message
    Set-StateProperty -PropertyPath 'setup.lastError' -Value $errorMsg
    Set-StateProperty -PropertyPath 'setup.status' -Value 'failed'
    Write-Error-Card -Title 'SetupScenario Error' -ErrorMessage $errorMsg
    exit 1
}
