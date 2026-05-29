<#
.SYNOPSIS
    Pester 5 unit tests for the chaos-impact skill entry point.

.DESCRIPTION
    Covers:
      - Constants getter shape + pinned API versions
      - Get-ChaosImpactContext state-file bootstrap (parameters override
        state; state fills gaps; explicit args take precedence)
      - Test-ChaosImpactContext missing-field detection
      - Get-ChaosImpactTargetedResources flattening, parent collapse, cap
      - Resolve-ChaosImpactOutputDir precedence
      - Exit-code contract: exit 2 when context is missing (subprocess)

    Run:   Invoke-Pester -Path ./tests/Invoke-ChaosImpact.Tests.ps1
#>

BeforeAll {
    $script:SkillRoot   = Split-Path $PSScriptRoot -Parent
    $script:ScriptsDir  = Join-Path $script:SkillRoot 'scripts'
    $script:PluginRoot  = Split-Path (Split-Path $script:SkillRoot -Parent) -Parent
    $script:EntryScript = Join-Path $script:ScriptsDir 'Invoke-ChaosImpact.ps1'

    # Dot-source dependencies + the entry script (guarded so its main body
    # does not execute under dot-source).
    . (Join-Path (Join-Path $script:PluginRoot 'skills/_shared') 'State.ps1')
    . (Join-Path $script:ScriptsDir 'Constants.ps1')
    . $script:EntryScript

    function New-TempStateFile {
        param([hashtable]$State)
        $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("chaos-impact-state-{0}.json" -f ([guid]::NewGuid()))
        ($State | ConvertTo-Json -Depth 32) | Out-File -FilePath $tmp -Encoding utf8 -NoNewline
        return $tmp
    }
}

Describe 'Constants.ps1' {
    It 'returns all pinned API versions' {
        $c = Get-ChaosImpactConstants
        $c.apiVersions.diagnosticSettings       | Should -Be '2021-05-01-preview'
        $c.apiVersions.metrics                  | Should -Be '2024-02-01'
        $c.apiVersions.logAnalytics             | Should -Be 'v1'
        $c.apiVersions.activityLog              | Should -Be '2015-04-01'
        $c.apiVersions.alertsManagement         | Should -Be '2023-05-01-preview'
        $c.apiVersions.alertsManagementFallback | Should -Be '2018-05-05'
        $c.apiVersions.resourceHealth           | Should -Be '2022-10-01'
        $c.apiVersions.chaosStudio              | Should -Be '2026-05-01-preview'
    }

    It 'exposes tunable defaults' {
        $c = Get-ChaosImpactConstants
        $c.defaults.maxResources      | Should -Be 50
        $c.defaults.buffer            | Should -Be 'PT5M'
        $c.defaults.diagThrottleLimit | Should -Be 4
    }
}

Describe 'Get-ChaosImpactContext (state-file bootstrap)' {
    BeforeEach {
        $script:OriginalStatePath = $env:STARTCHAOS_STATE_PATH
    }
    AfterEach {
        if ($script:_tempState -and (Test-Path $script:_tempState)) {
            Remove-Item $script:_tempState -Force -ErrorAction SilentlyContinue
        }
        $env:STARTCHAOS_STATE_PATH = $script:OriginalStatePath
    }

    It 'returns nulls when no state file and no parameters supplied' {
        $env:STARTCHAOS_STATE_PATH = Join-Path ([System.IO.Path]::GetTempPath()) "nonexistent-$([guid]::NewGuid()).json"
        $ctx = Get-ChaosImpactContext
        $ctx.subscriptionId | Should -BeNullOrEmpty
        $ctx.resourceGroup  | Should -BeNullOrEmpty
        $ctx.workspaceName  | Should -BeNullOrEmpty
        $ctx.scenarioName   | Should -BeNullOrEmpty
        $ctx.scenarioRunId  | Should -BeNullOrEmpty
    }

    It 'populates context entirely from the state file when no parameters supplied' {
        $state = @{
            stateSchemaVersion = 1
            context   = @{ subscriptionId = 'sub-1'; resourceGroup = 'rg-1' }
            workspace = @{ name = 'ws-1' }
            setup     = @{ selectedScenarioId = '/subscriptions/x/.../scenarios/ZoneDown-1.0' }
            run       = @{ scenarioRunId = 'run-abc' }
        }
        $script:_tempState = New-TempStateFile -State $state
        $env:STARTCHAOS_STATE_PATH = $script:_tempState

        $ctx = Get-ChaosImpactContext
        $ctx.subscriptionId | Should -Be 'sub-1'
        $ctx.resourceGroup  | Should -Be 'rg-1'
        $ctx.workspaceName  | Should -Be 'ws-1'
        $ctx.scenarioName   | Should -Be 'ZoneDown-1.0'
        $ctx.scenarioRunId  | Should -Be 'run-abc'
    }

    It 'lets explicit parameters override the state file' {
        $state = @{
            stateSchemaVersion = 1
            context   = @{ subscriptionId = 'sub-fromState' }
            workspace = @{ name = 'ws-fromState' }
            setup     = @{ selectedScenarioId = '/x/scenarios/FromState' }
            run       = @{ scenarioRunId = 'run-fromState' }
        }
        $script:_tempState = New-TempStateFile -State $state
        $env:STARTCHAOS_STATE_PATH = $script:_tempState

        $ctx = Get-ChaosImpactContext -SubscriptionId 'sub-OVERRIDE' -ScenarioName 'Scen-OVERRIDE'
        $ctx.subscriptionId | Should -Be 'sub-OVERRIDE'
        $ctx.workspaceName  | Should -Be 'ws-fromState'
        $ctx.scenarioName   | Should -Be 'Scen-OVERRIDE'
    }
}

Describe 'Test-ChaosImpactContext' {
    It 'reports every missing required field' {
        $missing = Test-ChaosImpactContext -Context ([ordered]@{
            subscriptionId = $null; resourceGroup = $null
            workspaceName  = $null; scenarioName  = $null; scenarioRunId = $null
        })
        $missing | Should -HaveCount 5
    }

    It 'returns empty when all fields present' {
        $missing = Test-ChaosImpactContext -Context ([ordered]@{
            subscriptionId = 's'; resourceGroup = 'r'
            workspaceName  = 'w'; scenarioName  = 'sc'; scenarioRunId = 'rid'
        })
        $missing | Should -BeNullOrEmpty
    }

    It 'flags only the unset fields' {
        $missing = Test-ChaosImpactContext -Context ([ordered]@{
            subscriptionId = 's'; resourceGroup = ''
            workspaceName  = 'w'; scenarioName  = $null; scenarioRunId = 'rid'
        })
        ($missing | Sort-Object) | Should -Be @('resourceGroup', 'scenarioName')
    }
}

Describe 'Get-ChaosImpactTargetedResources' {
    It 'returns empty sets when run body has no summary' {
        $r = Get-ChaosImpactTargetedResources -RunBody $null -MaxResources 50
        $r.all     | Should -BeNullOrEmpty
        $r.sampled | Should -BeNullOrEmpty
    }

    It 'deduplicates identical resource IDs across actions' {
        $body = [pscustomobject]@{ properties = [pscustomobject]@{ scenarioRunSummary = @(
            [pscustomobject]@{ resources = @( [pscustomobject]@{ id = '/subscriptions/s/rg/r/providers/Microsoft.Storage/storageAccounts/a' } ) }
            [pscustomobject]@{ resources = @( [pscustomobject]@{ id = '/subscriptions/s/rg/r/providers/Microsoft.Storage/storageAccounts/a' } ) }
        ) } }
        $r = Get-ChaosImpactTargetedResources -RunBody $body -MaxResources 50
        $r.all     | Should -HaveCount 1
        $r.sampled | Should -HaveCount 1
    }

    It 'collapses VMSS instance IDs to the parent scale set' {
        $body = [pscustomobject]@{ properties = [pscustomobject]@{ scenarioRunSummary = @(
            [pscustomobject]@{ resources = @(
                [pscustomobject]@{ id = '/subscriptions/s/resourceGroups/rg/providers/Microsoft.Compute/virtualMachineScaleSets/vmss1/virtualMachines/0' }
                [pscustomobject]@{ id = '/subscriptions/s/resourceGroups/rg/providers/Microsoft.Compute/virtualMachineScaleSets/vmss1/virtualMachines/1' }
                [pscustomobject]@{ id = '/subscriptions/s/resourceGroups/rg/providers/Microsoft.Compute/virtualMachineScaleSets/vmss2/virtualMachines/0' }
            ) }
        ) } }
        $r = Get-ChaosImpactTargetedResources -RunBody $body -MaxResources 50
        $r.all | Should -HaveCount 2
        $r.all | Should -Contain '/subscriptions/s/resourceGroups/rg/providers/Microsoft.Compute/virtualMachineScaleSets/vmss1'
        $r.all | Should -Contain '/subscriptions/s/resourceGroups/rg/providers/Microsoft.Compute/virtualMachineScaleSets/vmss2'
    }

    It 'collapses AKS sub-resources to the parent managedCluster' {
        $body = [pscustomobject]@{ properties = [pscustomobject]@{ scenarioRunSummary = @(
            [pscustomobject]@{ resources = @(
                [pscustomobject]@{ id = '/subscriptions/s/resourceGroups/rg/providers/Microsoft.ContainerService/managedClusters/k1/agentPools/p1' }
            ) }
        ) } }
        $r = Get-ChaosImpactTargetedResources -RunBody $body -MaxResources 50
        $r.all[0] | Should -Be '/subscriptions/s/resourceGroups/rg/providers/Microsoft.ContainerService/managedClusters/k1'
    }

    It 'applies the MaxResources cap and reports the overflow' {
        $resources = 1..10 | ForEach-Object {
            [pscustomobject]@{ id = "/subscriptions/s/resourceGroups/rg/providers/Microsoft.Storage/storageAccounts/a$_" }
        }
        $body = [pscustomobject]@{ properties = [pscustomobject]@{ scenarioRunSummary = @(
            [pscustomobject]@{ resources = $resources }
        ) } }
        $r = Get-ChaosImpactTargetedResources -RunBody $body -MaxResources 3
        $r.all             | Should -HaveCount 10
        $r.sampled         | Should -HaveCount 3
        $r.skippedDueToCap | Should -HaveCount 7
    }
}

Describe 'Resolve-ChaosImpactOutputDir' {
    BeforeEach {
        $script:OrigSessionDir = $env:STARTCHAOS_SESSION_DIR
        $env:STARTCHAOS_SESSION_DIR = $null
    }
    AfterEach {
        $env:STARTCHAOS_SESSION_DIR = $script:OrigSessionDir
    }

    It 'honours an explicit -OutputDir, creating it if absent' {
        $target = Join-Path ([System.IO.Path]::GetTempPath()) "chaos-impact-out-$([guid]::NewGuid())"
        try {
            $resolved = Resolve-ChaosImpactOutputDir -OutputDir $target
            Test-Path $resolved | Should -BeTrue
        } finally {
            if (Test-Path $target) { Remove-Item $target -Recurse -Force -ErrorAction SilentlyContinue }
        }
    }

    It 'falls back to STARTCHAOS_SESSION_DIR when -OutputDir omitted' {
        $env:STARTCHAOS_SESSION_DIR = ([System.IO.Path]::GetTempPath()).TrimEnd([System.IO.Path]::DirectorySeparatorChar)
        $resolved = Resolve-ChaosImpactOutputDir
        # Resolve to canonical form for comparison
        $resolved.TrimEnd([System.IO.Path]::DirectorySeparatorChar) |
            Should -Be (Resolve-Path $env:STARTCHAOS_SESSION_DIR).Path.TrimEnd([System.IO.Path]::DirectorySeparatorChar)
    }
}

Describe 'Get-DiagnosticSettings' {
    BeforeAll {
        # Build a parallel directory tree that mirrors the real layout so the
        # function's relative `$sharedDir` resolution lands on a stub
        # Invoke-AzRest.ps1 — required because `ForEach-Object -Parallel`
        # dot-sources the helper inside each runspace and Pester's Mock
        # cannot reach into those runspaces.
        $script:DiagRoot      = Join-Path ([System.IO.Path]::GetTempPath()) "chaos-impact-diag-$([guid]::NewGuid())"
        $script:DiagScripts   = Join-Path $script:DiagRoot 'skills/chaos-impact/scripts'
        $script:DiagShared    = Join-Path $script:DiagRoot 'skills/_shared'
        New-Item -ItemType Directory -Path $script:DiagScripts, $script:DiagShared -Force | Out-Null

        Copy-Item (Join-Path $script:ScriptsDir 'Constants.ps1')             (Join-Path $script:DiagScripts 'Constants.ps1')
        Copy-Item (Join-Path $script:ScriptsDir 'Get-DiagnosticSettings.ps1') (Join-Path $script:DiagScripts 'Get-DiagnosticSettings.ps1')

        $script:DiagResponseFile = Join-Path $script:DiagRoot 'mock-responses.json'

        $stub = @'
function Invoke-AzRest {
    [CmdletBinding()] param(
        [Parameter(Mandatory)][string]$Method,
        [Parameter(Mandatory)][string]$Uri,
        [Parameter()][string]$ApiVersion,
        [Parameter()]$Body
    )
    $path = $env:CHAOS_IMPACT_TEST_RESPONSES
    if (-not $path -or -not (Test-Path $path)) {
        throw "stub Invoke-AzRest: no response file at '$path'"
    }
    $map = Get-Content -Raw -LiteralPath $path | ConvertFrom-Json -AsHashtable
    foreach ($k in $map.Keys) {
        if ($Uri -like $k) {
            $r = $map[$k]
            if ($r.ContainsKey('throw')) { throw $r['throw'] }
            $code = if ($r.ContainsKey('statusCode')) { $r['statusCode'] } else { 200 }
            return [pscustomobject]@{ statusCode = $code; body = $r['body'] }
        }
    }
    throw "stub Invoke-AzRest: no scripted response for '$Uri'"
}
'@
        Set-Content -LiteralPath (Join-Path $script:DiagShared 'Invoke-AzRest.ps1') -Value $stub -Encoding utf8

        # Dot-source the *test copy* so $PSScriptRoot resolves into the temp tree.
        . (Join-Path $script:DiagScripts 'Get-DiagnosticSettings.ps1')

        $env:CHAOS_IMPACT_TEST_RESPONSES = $script:DiagResponseFile

        function Set-DiagMockResponses {
            param([hashtable]$Map)
            ($Map | ConvertTo-Json -Depth 32) | Out-File -FilePath $script:DiagResponseFile -Encoding utf8 -NoNewline
        }
    }

    AfterAll {
        Remove-Item env:CHAOS_IMPACT_TEST_RESPONSES -ErrorAction SilentlyContinue
        if (Test-Path $script:DiagRoot) {
            Remove-Item $script:DiagRoot -Recurse -Force -ErrorAction SilentlyContinue
        }
    }

    It 'returns cache unchanged when ResourceIds is empty' {
        $cache = @{ 'preexisting' = @{ resourceId = 'preexisting'; status = 'available' } }
        $result = Get-DiagnosticSettings -ResourceIds @() -Cache $cache
        $result.Count | Should -Be 1
        $result['preexisting'].status | Should -Be 'available'
    }

    It 'marks no_diagnostic_setting when value is empty' {
        $id = '/subscriptions/s/resourceGroups/rg/providers/Microsoft.Storage/storageAccounts/n1'
        Set-DiagMockResponses -Map @{
            "*$id*diagnosticSettings*" = @{ body = @{ value = @() } }
        }
        $result = Get-DiagnosticSettings -ResourceIds @($id) -ThrottleLimit 1
        $entry = $result[$id.ToLowerInvariant()]
        $entry.status | Should -Be 'unavailable'
        $entry.reason | Should -Be 'no_diagnostic_setting'
    }

    It 'marks no_workspace_destination when no setting has a workspaceId' {
        $id = '/subscriptions/s/resourceGroups/rg/providers/Microsoft.Storage/storageAccounts/n2'
        Set-DiagMockResponses -Map @{
            "*$id*diagnosticSettings*" = @{ body = @{ value = @(
                @{ properties = @{ workspaceId = $null } }
            ) } }
        }
        $result = Get-DiagnosticSettings -ResourceIds @($id) -ThrottleLimit 1
        $result[$id.ToLowerInvariant()].reason | Should -Be 'no_workspace_destination'
    }

    It 'marks workspace_unreachable when the workspace GET throws' {
        $id = '/subscriptions/s/resourceGroups/rg/providers/Microsoft.Storage/storageAccounts/n3'
        $ws = '/subscriptions/s/resourceGroups/rg/providers/Microsoft.OperationalInsights/workspaces/w1'
        Set-DiagMockResponses -Map @{
            "*$id*diagnosticSettings*" = @{ body = @{ value = @( @{ properties = @{ workspaceId = $ws } } ) } }
            "*$ws"                      = @{ throw = 'workspace gone' }
        }
        $result = Get-DiagnosticSettings -ResourceIds @($id) -ThrottleLimit 1
        $entry = $result[$id.ToLowerInvariant()]
        $entry.workspaceId       | Should -Be $ws
        $entry.workspaceVerified | Should -BeFalse
        $entry.reason            | Should -Be 'workspace_unreachable'
    }

    It 'captures the underlying error message when the diag-settings GET throws' {
        $id = '/subscriptions/s/resourceGroups/rg/providers/Microsoft.Storage/storageAccounts/n4'
        Set-DiagMockResponses -Map @{
            "*$id*diagnosticSettings*" = @{ throw = 'arm 403 forbidden' }
        }
        $result = Get-DiagnosticSettings -ResourceIds @($id) -ThrottleLimit 1
        $result[$id.ToLowerInvariant()].reason | Should -BeLike 'error:*arm 403 forbidden*'
    }

    It 'marks status=available when workspace is reachable' {
        $id = '/subscriptions/s/resourceGroups/rg/providers/Microsoft.Storage/storageAccounts/n5'
        $ws = '/subscriptions/s/resourceGroups/rg/providers/Microsoft.OperationalInsights/workspaces/w2'
        Set-DiagMockResponses -Map @{
            "*$id*diagnosticSettings*" = @{ body = @{ value = @( @{ properties = @{ workspaceId = $ws } } ) } }
            "*$ws"                      = @{ body = @{ properties = @{ provisioningState = 'Succeeded' } } }
        }
        $result = Get-DiagnosticSettings -ResourceIds @($id) -ThrottleLimit 1
        $entry = $result[$id.ToLowerInvariant()]
        $entry.status            | Should -Be 'available'
        $entry.workspaceVerified | Should -BeTrue
        $entry.workspaceId       | Should -Be $ws
    }

    It 'does not call Invoke-AzRest for resources already in the cache' {
        $cachedId = '/subscriptions/s/resourceGroups/rg/providers/Microsoft.Storage/storageAccounts/cached'
        $cache = @{
            ($cachedId.ToLowerInvariant()) = [ordered]@{
                resourceId        = $cachedId
                workspaceId       = $null
                workspaceVerified = $false
                status            = 'unavailable'
                reason            = 'no_diagnostic_setting'
            }
        }
        # Empty response map — the stub throws on any uri lookup. Cache hit must
        # prevent any ARM call from being attempted.
        Set-DiagMockResponses -Map @{}
        $result = Get-DiagnosticSettings -ResourceIds @($cachedId) -Cache $cache
        $result[$cachedId.ToLowerInvariant()].reason | Should -Be 'no_diagnostic_setting'
    }
}

Describe 'Exit-code contract (subprocess)' {
    It 'exits 2 with a clear error when no context can be resolved' {
        $missingState = Join-Path ([System.IO.Path]::GetTempPath()) "nonexistent-$([guid]::NewGuid()).json"
        $env:STARTCHAOS_STATE_PATH = $missingState
        try {
            $output = & pwsh -NoProfile -NonInteractive -Command "& '$($script:EntryScript)' -ScenarioRunId 'run-xyz'; exit `$LASTEXITCODE" 2>&1
            $LASTEXITCODE | Should -Be 2
            ($output -join "`n") | Should -Match 'Missing Run Context|subscriptionId|resourceGroup'
        } finally {
            Remove-Item env:STARTCHAOS_STATE_PATH -ErrorAction SilentlyContinue
        }
    }

    It 'does not exit 3 (or attempt diag-settings discovery) when -LogAnalyticsWorkspaceId is "none"' {
        # Stage a temp tree with the real entry script + stubbed _shared so we
        # can drive the script end-to-end without an Azure tenant. Verifies:
        #   (a) Get-DiagnosticSettings is never invoked (no requests for
        #       /diagnosticSettings recorded in the stub log)
        #   (b) script exits 0 (NOT 3) even though no logs are available
        #   (c) coverage block reports the sampled resources as having no logs
        $root    = Join-Path ([System.IO.Path]::GetTempPath()) "chaos-impact-none-$([guid]::NewGuid())"
        $scripts = Join-Path $root 'skills/chaos-impact/scripts'
        $shared  = Join-Path $root 'skills/_shared'
        New-Item -ItemType Directory -Path $scripts, $shared -Force | Out-Null

        try {
            foreach ($f in 'Constants.ps1','Get-DiagnosticSettings.ps1','Get-MonitorSignals.ps1','Build-ImpactCorrelation.ps1','New-ImpactReport.ps1','Invoke-ChaosImpact.ps1') {
                Copy-Item (Join-Path $script:ScriptsDir $f) (Join-Path $scripts $f)
            }
            # Copy templates + schema (renderer + correlation engine read them).
            $templatesSrc = Join-Path $script:SkillRoot 'templates'
            $schemaSrc    = Join-Path $script:SkillRoot 'schema'
            if (Test-Path $templatesSrc) {
                Copy-Item $templatesSrc (Join-Path $root 'skills/chaos-impact/templates') -Recurse -Force
            }
            if (Test-Path $schemaSrc) {
                Copy-Item $schemaSrc (Join-Path $root 'skills/chaos-impact/schema') -Recurse -Force
            }
            # Real State.ps1 is fine — Read-State just returns null when the
            # file does not exist.
            Copy-Item (Join-Path (Join-Path $script:PluginRoot 'skills/_shared') 'State.ps1') (Join-Path $shared 'State.ps1')

            $callLog = Join-Path $root 'calls.log'
            $runBodyFile = Join-Path $root 'run-body.json'

            $sampledId = '/subscriptions/sub-1/resourceGroups/rg/providers/Microsoft.Storage/storageAccounts/n1'
            $runBody = @{
                properties = @{
                    startedAt          = '2025-01-01T00:00:00Z'
                    completedAt        = '2025-01-01T00:10:00Z'
                    scenarioRunSummary = @( @{ resources = @( @{ id = $sampledId } ) } )
                }
            }
            ($runBody | ConvertTo-Json -Depth 32) | Out-File -FilePath $runBodyFile -Encoding utf8 -NoNewline

            $azStub = @"
function Invoke-AzRest {
    [CmdletBinding()] param(
        [Parameter(Mandatory)][string]`$Method,
        [Parameter(Mandatory)][string]`$Uri,
        [Parameter()][string]`$ApiVersion,
        [Parameter()]`$Body
    )
    Add-Content -Path '$callLog' -Value `$Uri
    if (`$Uri -like '*/scenarios/*/runs/*') {
        `$body = Get-Content -Raw -LiteralPath '$runBodyFile' | ConvertFrom-Json
        return [pscustomobject]@{ statusCode = 200; body = `$body }
    }
    throw "unexpected ARM call: `$Uri"
}
"@
            Set-Content -LiteralPath (Join-Path $shared 'Invoke-AzRest.ps1') -Value $azStub -Encoding utf8

            # Render.ps1 stub — Invoke-ChaosImpact.ps1 calls Write-Card / Write-Error-Card.
            $renderStub = @'
function Write-Card       { param($Title,$Status,$Properties,$Details) [Console]::Error.WriteLine("[card] $Title $Status") }
function Write-Error-Card { param($Title,$ErrorMessage,$RemediationCommand,$Details) [Console]::Error.WriteLine("[err] $Title :: $ErrorMessage") }
'@
            Set-Content -LiteralPath (Join-Path $shared 'Render.ps1') -Value $renderStub -Encoding utf8

            $outDir = Join-Path $root 'out'
            New-Item -ItemType Directory -Path $outDir -Force | Out-Null

            $entry = Join-Path $scripts 'Invoke-ChaosImpact.ps1'
            $env:STARTCHAOS_STATE_PATH = Join-Path $root 'nonexistent-state.json'
            try {
                $cmd = "& '$entry' -ScenarioRunId 'run-xyz' -SubscriptionId 'sub-1' -ResourceGroup 'rg' -WorkspaceName 'ws' -ScenarioName 'scen' -LogAnalyticsWorkspaceId none -OutputDir '$outDir' -Format json; exit `$LASTEXITCODE"
                & pwsh -NoProfile -NonInteractive -Command $cmd 2>&1 | Out-Null
                $exit = $LASTEXITCODE
            } finally {
                Remove-Item env:STARTCHAOS_STATE_PATH -ErrorAction SilentlyContinue
            }

            $exit | Should -Be 0

            # No diagnostic-settings calls must have been made.
            $calls = if (Test-Path $callLog) { Get-Content $callLog } else { @() }
            ($calls | Where-Object { $_ -like '*diagnosticSettings*' }) | Should -BeNullOrEmpty

            # Coverage block reflects no log availability for the sampled resource.
            $jsonReport = Get-ChildItem $outDir -Filter '*.json' | Select-Object -First 1
            $jsonReport | Should -Not -BeNullOrEmpty
            $report = Get-Content -Raw $jsonReport.FullName | ConvertFrom-Json
            $report.coverage.resourcesSampled    | Should -Be 1
            $report.coverage.logsAvailableFor    | Should -BeNullOrEmpty
            $report.coverage.logsUnavailableFor  | Should -Contain $sampledId
        } finally {
            if (Test-Path $root) { Remove-Item $root -Recurse -Force -ErrorAction SilentlyContinue }
        }
    }

    It 'accepts -ScenarioRunId positionally' {
        # Parameter parsing only — confirm AST binds the first positional arg.
        $ast = [System.Management.Automation.Language.Parser]::ParseFile($script:EntryScript, [ref]$null, [ref]$null)
        $paramBlock = $ast.ParamBlock
        $first = $paramBlock.Parameters[0]
        $first.Name.VariablePath.UserPath | Should -Be 'ScenarioRunId'
        # Position 0 attribute must be present
        $hasPos = $first.Attributes | Where-Object {
            $_.TypeName.Name -eq 'Parameter' -and
            ($_.NamedArguments | Where-Object { $_.ArgumentName -eq 'Position' -and $_.Argument.Value -eq 0 })
        }
        $hasPos | Should -Not -BeNullOrEmpty
    }
}
