<#
.SYNOPSIS
    Entry point for the chaos-impact skill. Resolves a ScenarioRun, walks
    its targeted resources, queries Azure Monitor over the run window
    plus a buffer, and emits a Markdown + JSON impact report.

.DESCRIPTION
    Epic 2 scope (skeleton): parameter parsing, state-file bootstrap,
    run resolution via Invoke-AzRest, targeted-resource flattening with
    MaxResources cap, diagnostic-settings discovery, and emission of a
    correlation-less coverage summary. Epics 3–4 add the Monitor query
    fan-out, classification, and full renderer.

    Exit codes:
      0  Report (or coverage skeleton) emitted successfully.
      1  Hard error — details on stderr / in an error card.
      2  Missing run context — caller must re-invoke with the missing
         parameters (or populate the state file first).
      3  Log Analytics workspace not discoverable for ≥ 1 resource AND
         -LogAnalyticsWorkspaceId not supplied.
      4  Permission gap (reserved for Epic 3).

.NOTES
    Reads (does NOT write) ${env:STARTCHAOS_STATE_PATH}. When invoked
    standalone, callers must supply all four context parameters.
#>
[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [string]$ScenarioRunId,

    [Parameter()][string]$SubscriptionId,
    [Parameter()][string]$ResourceGroup,
    [Parameter()][string]$WorkspaceName,
    [Parameter()][string]$ScenarioName,

    [Parameter()][string]$Buffer = 'PT5M',

    [Parameter()][string]$LogAnalyticsWorkspaceId,

    [Parameter()][ValidateRange(1, 500)]
    [int]$MaxResources = 50,

    [Parameter()][string]$OutputDir,

    [Parameter()][switch]$IncludeBaseline,

    [Parameter()][ValidateSet('markdown', 'json', 'both')]
    [string]$Format = 'both',

    [Parameter()][switch]$AllowPartial
)

# ── Load shared + local scripts ─────────────────────────
$sharedDir = Join-Path (Split-Path (Split-Path $PSScriptRoot)) '_shared'
. (Join-Path $sharedDir 'State.ps1')
. (Join-Path $sharedDir 'Render.ps1')
. (Join-Path $sharedDir 'Invoke-AzRest.ps1')
. "$PSScriptRoot/Constants.ps1"
. "$PSScriptRoot/Get-DiagnosticSettings.ps1"
. "$PSScriptRoot/Get-MonitorSignals.ps1"

# Default -IncludeBaseline to $true when caller did not pass it explicitly.
if (-not $PSBoundParameters.ContainsKey('IncludeBaseline')) {
    $IncludeBaseline = $true
}

# ═══════════════════════════════════════════════════════
# Helpers
# ═══════════════════════════════════════════════════════

function Get-ChaosImpactContext {
    <#
    .SYNOPSIS
        Resolves run context (subscription / RG / workspace / scenario /
        runId) by overlaying explicit parameters on top of state-file
        values. Returns the merged context as an ordered hashtable.
    #>
    [CmdletBinding()]
    param(
        [Parameter()][string]$SubscriptionId,
        [Parameter()][string]$ResourceGroup,
        [Parameter()][string]$WorkspaceName,
        [Parameter()][string]$ScenarioName,
        [Parameter()][string]$ScenarioRunId
    )

    $state = $null
    try {
        $state = Read-State
    } catch {
        [Console]::Error.WriteLine("[chaos-impact] State file unreadable: $_ (continuing with parameters only)")
        $state = $null
    }

    $ctx = $state.context
    $setup = $state.setup
    $run = $state.run

    $scenarioFromState = $null
    if ($setup -and $setup.selectedScenarioId) {
        $scenarioFromState = ($setup.selectedScenarioId -split '/')[-1]
    }

    return [ordered]@{
        subscriptionId = if ($SubscriptionId) { $SubscriptionId } elseif ($ctx) { $ctx.subscriptionId } else { $null }
        resourceGroup  = if ($ResourceGroup)  { $ResourceGroup }  elseif ($ctx) { $ctx.resourceGroup }  else { $null }
        workspaceName  = if ($WorkspaceName)  { $WorkspaceName }  elseif ($state -and $state.workspace) { $state.workspace.name } else { $null }
        scenarioName   = if ($ScenarioName)   { $ScenarioName }   else { $scenarioFromState }
        scenarioRunId  = if ($ScenarioRunId)  { $ScenarioRunId }  elseif ($run) { $run.scenarioRunId } else { $null }
    }
}

function Test-ChaosImpactContext {
    <#
    .SYNOPSIS
        Validates that all required context fields are present. Returns
        an array of missing field names (empty when context is complete).
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][hashtable]$Context)

    $required = @('subscriptionId', 'resourceGroup', 'workspaceName', 'scenarioName', 'scenarioRunId')
    return @($required | Where-Object { -not $Context[$_] })
}

function Get-ChaosImpactTargetedResources {
    <#
    .SYNOPSIS
        Flattens scenarioRunSummary[*].resources[*].id into the unique set
        of parent resource IDs, collapsing instance-level targets (VMSS /
        AKS) to their parent before deduplication.
    .OUTPUTS
        [pscustomobject] with .all (unique parent IDs), .sampled (capped
        to MaxResources), .skippedDueToCap (overflow IDs), and .raw
        (the original ids in order).
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][AllowNull()]$RunBody,
        [Parameter(Mandatory)][int]$MaxResources
    )

    $rawIds = @()
    if ($RunBody -and $RunBody.properties -and $RunBody.properties.scenarioRunSummary) {
        foreach ($action in @($RunBody.properties.scenarioRunSummary)) {
            foreach ($r in @($action.resources)) {
                if ($r -and $r.id) { $rawIds += $r.id }
            }
        }
    }

    # Collapse instance-level segments (e.g. /virtualMachineScaleSets/{n}/virtualMachines/{i}
    # → /virtualMachineScaleSets/{n}; /managedClusters/{n}/agentPools/{p}/.../node → /managedClusters/{n}).
    $collapsed = foreach ($id in $rawIds) {
        $parent = $id
        if ($parent -match '^(?<base>/subscriptions/.+?/providers/Microsoft\.Compute/virtualMachineScaleSets/[^/]+)/virtualMachines/.+$') {
            $parent = $Matches['base']
        } elseif ($parent -match '^(?<base>/subscriptions/.+?/providers/Microsoft\.ContainerService/managedClusters/[^/]+)/.+$') {
            $parent = $Matches['base']
        }
        $parent
    }

    $unique = @($collapsed | Sort-Object -Unique)
    $sampled = @($unique | Select-Object -First $MaxResources)
    $skipped = @($unique | Select-Object -Skip $MaxResources)

    return [pscustomobject]@{
        all             = $unique
        sampled         = $sampled
        skippedDueToCap = $skipped
        raw             = $rawIds
    }
}

function Resolve-ChaosImpactOutputDir {
    <#
    .SYNOPSIS
        Returns the absolute output directory, creating it if needed.
        Precedence: -OutputDir > $env:STARTCHAOS_SESSION_DIR > $PWD.
    #>
    [CmdletBinding()]
    param([Parameter()][string]$OutputDir)

    $dir = if ($OutputDir) { $OutputDir }
           elseif ($env:STARTCHAOS_SESSION_DIR) { $env:STARTCHAOS_SESSION_DIR }
           else { (Get-Location).Path }

    if (-not (Test-Path $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
    return (Resolve-Path $dir).Path
}

# ═══════════════════════════════════════════════════════
# Main
# ═══════════════════════════════════════════════════════

# Dot-source-detection: when this script is sourced for testing, skip the
# main body so individual functions can be tested in isolation.
if ($MyInvocation.InvocationName -eq '.') { return }

try {
    # ── Step 1 — Resolve context ────────────────────────
    $context = Get-ChaosImpactContext `
        -SubscriptionId $SubscriptionId `
        -ResourceGroup  $ResourceGroup  `
        -WorkspaceName  $WorkspaceName  `
        -ScenarioName   $ScenarioName   `
        -ScenarioRunId  $ScenarioRunId

    $missing = Test-ChaosImpactContext -Context $context
    if ($missing.Count -gt 0) {
        Write-Error-Card -Title 'Missing Run Context' `
            -ErrorMessage ("Cannot resolve the ScenarioRun. Missing: " + ($missing -join ', ')) `
            -RemediationCommand "& Invoke-ChaosImpact.ps1 -SubscriptionId <id> -ResourceGroup <rg> -WorkspaceName <ws> -ScenarioName <scen> -ScenarioRunId <runId>"
        exit 2
    }

    # ── Step 2 — Pull the ScenarioRun ───────────────────
    $env:AZ_SUBSCRIPTION_ID = $context.subscriptionId
    $runUri = "/subscriptions/$($context.subscriptionId)/resourceGroups/$($context.resourceGroup)" +
              "/providers/Microsoft.Chaos/workspaces/$($context.workspaceName)" +
              "/scenarios/$($context.scenarioName)/runs/$($context.scenarioRunId)"

    Write-Card -Title 'Resolving ScenarioRun' -Status '🔄' -Properties ([ordered]@{
        'Subscription' = $context.subscriptionId
        'Workspace'    = "$($context.resourceGroup)/$($context.workspaceName)"
        'Scenario'     = $context.scenarioName
        'Run ID'       = $context.scenarioRunId
    })

    $runResp = Invoke-AzRest -Method GET -Uri $runUri -ApiVersion $script:ChaosImpactApi_ChaosStudio
    $runBody = $runResp.body

    if (-not $runBody) {
        Write-Error-Card -Title 'ScenarioRun Not Found' `
            -ErrorMessage "ARM returned an empty body for $runUri" `
            -RemediationCommand "az rest --method GET --uri 'https://management.azure.com$($runUri)?api-version=$($script:ChaosImpactApi_ChaosStudio)'"
        exit 1
    }

    # ── Step 3 — Flatten + cap targeted resources ───────
    $targets = Get-ChaosImpactTargetedResources -RunBody $runBody -MaxResources $MaxResources

    # ── Step 4 — Diagnostic-settings discovery ──────────
    $diagCache = @{}
    if ($targets.sampled.Count -gt 0 -and $LogAnalyticsWorkspaceId -ne 'none') {
        $diagCache = Get-DiagnosticSettings -ResourceIds $targets.sampled -Cache $diagCache
    }

    $logsAvailable = @()
    $logsUnavailable = @()
    $logsUnavailableReason = @{}
    foreach ($id in $targets.sampled) {
        $key = $id.ToLowerInvariant()
        $entry = $diagCache[$key]
        if ($entry -and $entry.status -eq 'available') {
            $logsAvailable += $id
        } else {
            $logsUnavailable += $id
            $reason = if ($entry) { $entry.reason } else { 'not_queried' }
            $logsUnavailableReason[$id] = $reason
        }
    }

    # Exit 3 — partial discovery without user override.
    if ($logsUnavailable.Count -gt 0 -and -not $LogAnalyticsWorkspaceId) {
        Write-Error-Card -Title 'Log Analytics Workspace Not Discoverable' `
            -ErrorMessage ("$($logsUnavailable.Count)/$($targets.sampled.Count) resources have no usable diagnostic setting. " +
                "Re-run with -LogAnalyticsWorkspaceId <id> to supply one, or -LogAnalyticsWorkspaceId none to skip log signals.") `
            -Details ("**Resources without logs:**`n" + (($logsUnavailable | ForEach-Object { "- $_" }) -join "`n"))
        exit 3
    }

    # ═══════════════════════════════════════════════════
    # Phase C — Query Azure Monitor (Epic 3)
    # ═══════════════════════════════════════════════════
    $signals = $null
    $correlationResult = @()
    if ($targets.sampled.Count -gt 0 -and $LogAnalyticsWorkspaceId -ne 'none') {
        # Build per-action windows; actions without per-action timestamps
        # inherit the overall run window.
        $actionWindows = @()
        foreach ($a in @($runBody.properties.scenarioRunSummary)) {
            $aStart = if ($a.startedAt)   { $a.startedAt }   else { $runBody.properties.startedAt }
            $aEnd   = if ($a.completedAt) { $a.completedAt } else { $runBody.properties.completedAt }
            $aTargets = @()
            foreach ($r in @($a.resources)) { if ($r -and $r.id) { $aTargets += $r.id } }
            $actionWindows += @{
                ActionName        = $a.actionName
                Start             = $aStart
                End               = $aEnd
                TargetResourceIds = $aTargets
            }
        }

        # Materialize the workspace map in the shape Get-MonitorSignals expects
        # (resourceId.ToLower() → @{workspaceId; status; reason}); the diag-cache
        # already matches that shape.
        $signals = Get-MonitorSignals `
            -ResourceIds     $targets.sampled `
            -WorkspaceMap    $diagCache `
            -ActionWindows   $actionWindows `
            -Buffer          $Buffer `
            -SubscriptionId  $context.subscriptionId `
            -MaxRows         500

        # ═══════════════════════════════════════════════
        # Phase D — Correlate & classify (Epic 3)
        # ═══════════════════════════════════════════════
        $metricDefaultsPath = Join-Path (Split-Path $PSScriptRoot) 'templates/metrics/defaults.json'
        $metricDefaults = if (Test-Path $metricDefaultsPath) {
            Get-Content $metricDefaultsPath -Raw | ConvertFrom-Json
        } else { $null }

        $correlationResult = & "$PSScriptRoot/Build-ImpactCorrelation.ps1" `
            -ScenarioRun     $runBody `
            -Signals         $signals `
            -Buffer          $Buffer `
            -MetricDefaults  $metricDefaults

        # Persist intermediate state for debugging / re-runs.
        try {
            $statePath = Join-Path (Resolve-ChaosImpactOutputDir -OutputDir $OutputDir) "impact-$($context.scenarioRunId).state.json"
            @{
                scenarioRunId   = $context.scenarioRunId
                generatedAt     = (Get-Date).ToUniversalTime().ToString('o')
                signals         = $signals
                correlation     = $correlationResult
            } | ConvertTo-Json -Depth 32 | Out-File -FilePath $statePath -Encoding utf8 -NoNewline
            [Console]::Error.WriteLine("[chaos-impact] Wrote intermediate state $statePath")
        } catch {
            [Console]::Error.WriteLine("[chaos-impact] Warning: failed to write intermediate state: $($_.Exception.Message)")
        }
    }

    # ── Step 5 — Render artifacts via New-ImpactReport (Epic 4) ─────────
    $outDir = Resolve-ChaosImpactOutputDir -OutputDir $OutputDir

    # Build the coverage object in the shape New-ImpactReport expects.
    $coverageForRender = [ordered]@{
        resourcesTotal        = $targets.all.Count
        resourcesSampled      = $targets.sampled.Count
        skippedDueToCap       = $targets.skippedDueToCap
        maxResources          = $MaxResources
        logsAvailableFor      = $logsAvailable
        logsUnavailableFor    = $logsUnavailable
        logsUnavailableReason = $logsUnavailableReason
    }

    # Queries metadata: pass the per-workspace KQL results + per-resource
    # metric responses so the JSON sidecar can carry the query trail.
    $queriesForRender = [ordered]@{
        kql     = if ($signals -and $signals.logs)    { @($signals.logs) }    else { @() }
        metrics = if ($signals -and $signals.metrics) { @($signals.metrics) } else { @() }
    }

    $workspaceContext = [ordered]@{
        subscriptionId = $context.subscriptionId
        resourceGroup  = $context.resourceGroup
        name           = $context.workspaceName
    }
    $scenarioContext = [ordered]@{
        name = $context.scenarioName
    }

    # Phase E — delegate JSON + Markdown emission to New-ImpactReport.ps1.
    $renderResult = & "$PSScriptRoot/New-ImpactReport.ps1" `
        -CorrelationResult $correlationResult `
        -ScenarioRunId     $context.scenarioRunId `
        -ScenarioRun       $runBody `
        -Coverage          $coverageForRender `
        -Queries           $queriesForRender `
        -Errors            @() `
        -OutputDir         $outDir `
        -Format            $Format `
        -Buffer            $Buffer `
        -WorkspaceContext  $workspaceContext `
        -ScenarioContext   $scenarioContext

    Write-Card -Title 'Chaos Impact — Report' -Status '✅ Rendered' -Properties ([ordered]@{
        'Run ID'              = $context.scenarioRunId
        'Window'              = "$($runBody.properties.startedAt) → $($runBody.properties.completedAt)"
        'Resources (total)'   = $targets.all.Count
        'Resources (sampled)' = $targets.sampled.Count
        'Logs available'      = "$($logsAvailable.Count) / $($targets.sampled.Count)"
        'Markdown'            = $renderResult.markdownPath
        'JSON sidecar'        = $renderResult.jsonPath
    })

    exit 0

} catch {
    Write-Error-Card -Title 'chaos-impact Failed' `
        -ErrorMessage $_.Exception.Message `
        -Details ($_.ScriptStackTrace)
    exit 1
}
