<#
.SYNOPSIS
    Pester 5 unit tests for Build-ImpactCorrelation.ps1 (pure-function
    correlation + classification engine).

.DESCRIPTION
    Coverage:
      - Chaos-attributed hit (in-window, target-match, magnitude exceeds threshold)
      - Baseline-only noise (signal in baseline window, comparable rate)
      - Unexplained signal (in-window but resource NOT in any action's targets)
      - Mixed scenario (multiple signals across multiple actions)
      - Per-action timing fallback (windowSource='run' when action timing absent)
      - Severity bucket boundaries (med / high / crit)

    No external calls — Build-ImpactCorrelation.ps1 is pure-function.

    Run:   Invoke-Pester -Path ./tests/Build-ImpactCorrelation.Tests.ps1
#>

BeforeAll {
    $script:SkillRoot   = Split-Path $PSScriptRoot -Parent
    $script:ScriptsDir  = Join-Path $script:SkillRoot 'scripts'
    $script:EngineScript = Join-Path $script:ScriptsDir 'Build-ImpactCorrelation.ps1'

    # Dot-source: brings Build-ImpactCorrelation and all helper functions into scope.
    . $script:EngineScript

    # ── Fixture builders ─────────────────────────────────
    function New-Run {
        param(
            [Parameter(Mandatory)][string]$Started,
            [Parameter(Mandatory)][string]$Completed,
            [Parameter()][array]$Actions = @()
        )
        return [pscustomobject]@{
            properties = [pscustomobject]@{
                startedAt          = $Started
                completedAt        = $Completed
                scenarioRunSummary = $Actions
            }
        }
    }

    function New-Action {
        param(
            [Parameter(Mandatory)][string]$Name,
            [Parameter()][string]$Started,
            [Parameter()][string]$Completed,
            [Parameter()][string[]]$ResourceIds = @()
        )
        $resources = @($ResourceIds | ForEach-Object { [pscustomobject]@{ id = $_ } })
        $obj = [ordered]@{
            actionName = $Name
            resources  = $resources
        }
        if ($Started)   { $obj.startedAt   = $Started }
        if ($Completed) { $obj.completedAt = $Completed }
        return [pscustomobject]$obj
    }

    function New-MetricSignal {
        param(
            [Parameter(Mandatory)][string]$ResourceId,
            [Parameter(Mandatory)][string]$MetricName,
            [Parameter(Mandatory)][array]$Points  # @(@{t='...'; avg=10.0}, ...)
        )
        $dp = @($Points | ForEach-Object {
            [pscustomobject]@{ timeStamp = $_.t; average = $_.avg; maximum = $_.avg }
        })
        return [pscustomobject]@{
            resourceId = $ResourceId
            metricName = $MetricName
            dataPoints = $dp
        }
    }

    # Stable fixture timing (UTC).
    $script:RunStart = '2026-05-29T10:00:00Z'
    $script:RunEnd   = '2026-05-29T10:30:00Z'
    $script:Buffer   = 'PT5M'

    # VM resource targeted by the chaos action.
    $script:TargetedVm = '/subscriptions/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/resourceGroups/rgA/providers/Microsoft.Compute/virtualMachines/vmA'
    # VM resource NOT targeted by any action (used to produce unexplained signals).
    $script:NonTargetedVm = '/subscriptions/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/resourceGroups/rgA/providers/Microsoft.Compute/virtualMachines/vmZ'

    # Threshold = 20 for "Percentage CPU" per defaults.json contract.
    $script:MetricDefaults = @{
        'Microsoft.Compute/virtualMachines' = @{
            metrics    = @('Percentage CPU')
            thresholds = @{ 'Percentage CPU' = 20 }
        }
    }
}

Describe 'Helper functions' {
    It 'ConvertFrom-IsoDuration parses PT5M' {
        $ts = ConvertFrom-IsoDuration -Iso 'PT5M'
        $ts.TotalMinutes | Should -Be 5
    }
    It 'ConvertTo-ParentResourceId collapses VMSS instance IDs' {
        $id = '/subscriptions/s/resourceGroups/rg/providers/Microsoft.Compute/virtualMachineScaleSets/vmss1/virtualMachines/0'
        ConvertTo-ParentResourceId -ResourceId $id |
            Should -Be '/subscriptions/s/resourceGroups/rg/providers/Microsoft.Compute/virtualMachineScaleSets/vmss1'
    }
    It 'ConvertTo-ParentResourceId collapses AKS child IDs' {
        $id = '/subscriptions/s/resourceGroups/rg/providers/Microsoft.ContainerService/managedClusters/aks1/agentPools/np/foo'
        ConvertTo-ParentResourceId -ResourceId $id |
            Should -Be '/subscriptions/s/resourceGroups/rg/providers/Microsoft.ContainerService/managedClusters/aks1'
    }
    It 'Get-ResourceTypeFromId extracts Microsoft.Compute/virtualMachines' {
        Get-ResourceTypeFromId -ResourceId $script:TargetedVm |
            Should -Be 'Microsoft.Compute/virtualMachines'
    }
    It 'Get-ResourceTypeFromId extracts nested types (Sql databases)' {
        $id = '/subscriptions/s/resourceGroups/rg/providers/Microsoft.Sql/servers/s1/databases/d1'
        Get-ResourceTypeFromId -ResourceId $id |
            Should -Be 'Microsoft.Sql/servers/databases'
    }
    It 'Get-SeverityFromAlertSev maps Sev0..Sev4' {
        Get-SeverityFromAlertSev -AlertSeverity 'Sev0' | Should -Be 'crit'
        Get-SeverityFromAlertSev -AlertSeverity 'Sev1' | Should -Be 'high'
        Get-SeverityFromAlertSev -AlertSeverity 'Sev2' | Should -Be 'med'
        Get-SeverityFromAlertSev -AlertSeverity 'Sev3' | Should -Be 'low'
        Get-SeverityFromAlertSev -AlertSeverity 'Sev4' | Should -Be 'info'
    }
    It 'Get-MetricThreshold supports PSCustomObject defaults' {
        $defaults = ([pscustomobject]@{
            'Microsoft.Compute/virtualMachines' = [pscustomobject]@{
                metrics    = @('Percentage CPU')
                thresholds = [pscustomobject]@{ 'Percentage CPU' = 20 }
            }
        })
        Get-MetricThreshold -MetricDefaults $defaults -ResourceType 'Microsoft.Compute/virtualMachines' -MetricName 'Percentage CPU' |
            Should -Be 20.0
    }
    It 'Test-TimestampInWindow handles inclusive bounds' {
        $start = [DateTime]::Parse('2026-05-29T10:00:00Z').ToUniversalTime()
        $end   = [DateTime]::Parse('2026-05-29T10:30:00Z').ToUniversalTime()
        Test-TimestampInWindow -Timestamp '2026-05-29T10:15:00Z' -Start $start -End $end | Should -BeTrue
        Test-TimestampInWindow -Timestamp '2026-05-29T09:59:59Z' -Start $start -End $end | Should -BeFalse
    }
}

Describe 'Build-ImpactCorrelation — chaos-attributed hit' {
    It 'classifies a target-matched in-window metric spike as chaosAttributed' {
        $action = New-Action -Name 'cpuPressure' `
            -Started   '2026-05-29T10:10:00Z' `
            -Completed '2026-05-29T10:20:00Z' `
            -ResourceIds @($script:TargetedVm)
        $run = New-Run -Started $script:RunStart -Completed $script:RunEnd -Actions @($action)

        # Baseline (10:00–10:05) avg=10; spike at 10:15 = 80 → delta=70, threshold=20, ratio=3.5× → crit.
        $metric = New-MetricSignal -ResourceId $script:TargetedVm -MetricName 'Percentage CPU' -Points @(
            @{ t = '2026-05-29T10:00:30Z'; avg = 10.0 },
            @{ t = '2026-05-29T10:04:00Z'; avg = 10.0 },
            @{ t = '2026-05-29T10:15:00Z'; avg = 80.0 }
        )
        $signals = @{ metrics = @($metric); logs=@(); activity=@(); alerts=@(); health=@() }

        $result = Build-ImpactCorrelation -ScenarioRun $run -Signals $signals -Buffer $script:Buffer -MetricDefaults $script:MetricDefaults
        $result.Count | Should -Be 1
        $result[0].actionName        | Should -Be 'cpuPressure'
        $result[0].windowSource      | Should -Be 'action'
        $result[0].signals.chaosAttributed.Count | Should -BeGreaterThan 0
        $hit = $result[0].signals.chaosAttributed | Where-Object { $_.timestamp -eq '2026-05-29T10:15:00Z' }
        $hit | Should -Not -BeNullOrEmpty
        $hit.signalType  | Should -Be 'metric'
        $hit.actionName  | Should -Be 'cpuPressure'
        $hit.severity    | Should -Be 'crit'
    }
}

Describe 'Build-ImpactCorrelation — baseline-only noise' {
    It 'classifies a metric sample inside the baseline window as baseline' {
        $action = New-Action -Name 'cpuPressure' `
            -Started   '2026-05-29T10:10:00Z' `
            -Completed '2026-05-29T10:20:00Z' `
            -ResourceIds @($script:TargetedVm)
        $run = New-Run -Started $script:RunStart -Completed $script:RunEnd -Actions @($action)

        # Baseline window = [10:00, 10:05]. Comparable values both inside.
        $metric = New-MetricSignal -ResourceId $script:TargetedVm -MetricName 'Percentage CPU' -Points @(
            @{ t = '2026-05-29T10:00:30Z'; avg = 12.0 },
            @{ t = '2026-05-29T10:04:00Z'; avg = 13.0 }
        )
        $signals = @{ metrics = @($metric); logs=@(); activity=@(); alerts=@(); health=@() }

        $result = Build-ImpactCorrelation -ScenarioRun $run -Signals $signals -Buffer $script:Buffer -MetricDefaults $script:MetricDefaults
        $result[0].signals.chaosAttributed.Count | Should -Be 0
        $result[0].signals.baseline.Count        | Should -BeGreaterThan 0
        $result[0].signals.baseline[0].signalType | Should -Be 'metric'
        $result[0].signals.baseline[0].severity   | Should -Be 'low'
    }
}

Describe 'Build-ImpactCorrelation — unexplained signal' {
    It 'classifies an in-window metric spike on a non-targeted resource as unexplained' {
        $action = New-Action -Name 'cpuPressure' `
            -Started   '2026-05-29T10:10:00Z' `
            -Completed '2026-05-29T10:20:00Z' `
            -ResourceIds @($script:TargetedVm)
        $run = New-Run -Started $script:RunStart -Completed $script:RunEnd -Actions @($action)

        # Spike on NonTargetedVm during the action window.
        $metric = New-MetricSignal -ResourceId $script:NonTargetedVm -MetricName 'Percentage CPU' -Points @(
            @{ t = '2026-05-29T10:15:00Z'; avg = 95.0 }
        )
        $signals = @{ metrics = @($metric); logs=@(); activity=@(); alerts=@(); health=@() }

        $result = Build-ImpactCorrelation -ScenarioRun $run -Signals $signals -Buffer $script:Buffer -MetricDefaults $script:MetricDefaults
        $result[0].signals.chaosAttributed.Count | Should -Be 0
        $result[0].signals.unexplained.Count     | Should -BeGreaterThan 0
        $u = $result[0].signals.unexplained[0]
        $u.resourceId | Should -Be $script:NonTargetedVm
        $u.signalType | Should -Be 'metric'
    }
}

Describe 'Build-ImpactCorrelation — mixed scenario' {
    It 'routes signals from multiple actions into the right buckets' {
        $vmB = '/subscriptions/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/resourceGroups/rgA/providers/Microsoft.Compute/virtualMachines/vmB'

        $a1 = New-Action -Name 'cpuPressure' `
            -Started   '2026-05-29T10:10:00Z' `
            -Completed '2026-05-29T10:15:00Z' `
            -ResourceIds @($script:TargetedVm)
        $a2 = New-Action -Name 'stopVm' `
            -Started   '2026-05-29T10:20:00Z' `
            -Completed '2026-05-29T10:25:00Z' `
            -ResourceIds @($vmB)
        $run = New-Run -Started $script:RunStart -Completed $script:RunEnd -Actions @($a1, $a2)

        # Chaos hit on vmA inside a1's window.
        $m1 = New-MetricSignal -ResourceId $script:TargetedVm -MetricName 'Percentage CPU' -Points @(
            @{ t = '2026-05-29T10:01:00Z'; avg = 10.0 },
            @{ t = '2026-05-29T10:12:00Z'; avg = 85.0 }
        )
        # Chaos hit on vmB inside a2's window.
        $m2 = New-MetricSignal -ResourceId $vmB -MetricName 'Percentage CPU' -Points @(
            @{ t = '2026-05-29T10:11:00Z'; avg = 10.0 },
            @{ t = '2026-05-29T10:22:00Z'; avg = 90.0 }
        )
        # Unexplained on vmZ during the run.
        $m3 = New-MetricSignal -ResourceId $script:NonTargetedVm -MetricName 'Percentage CPU' -Points @(
            @{ t = '2026-05-29T10:13:00Z'; avg = 99.0 }
        )

        $defaults = @{
            'Microsoft.Compute/virtualMachines' = @{
                metrics    = @('Percentage CPU')
                thresholds = @{ 'Percentage CPU' = 20 }
            }
        }
        $signals = @{ metrics = @($m1, $m2, $m3); logs=@(); activity=@(); alerts=@(); health=@() }

        $result = Build-ImpactCorrelation -ScenarioRun $run -Signals $signals -Buffer $script:Buffer -MetricDefaults $defaults
        $result.Count | Should -Be 2

        $cpuRes = $result | Where-Object { $_.actionName -eq 'cpuPressure' }
        $stopRes = $result | Where-Object { $_.actionName -eq 'stopVm' }

        ($cpuRes.signals.chaosAttributed | Where-Object { $_.resourceId -eq $script:TargetedVm }).Count | Should -BeGreaterThan 0
        ($stopRes.signals.chaosAttributed | Where-Object { $_.resourceId -eq $vmB }).Count | Should -BeGreaterThan 0

        # vmZ unexplained should appear in cpuPressure's unexplained bucket (10:13 is in cpuPressure's expanded window).
        $unexCpu = $cpuRes.signals.unexplained | Where-Object { $_.resourceId -eq $script:NonTargetedVm }
        $unexCpu | Should -Not -BeNullOrEmpty
    }
}

Describe 'Build-ImpactCorrelation — per-action unexplained scoping (review fix)' {
    It "classifies a signal on action-A's target as unexplained from action-B's perspective" {
        # Resource X is targeted by Action A only. A signal on X during Action B's
        # window must show up as 'unexplained' for Action B (was incorrectly
        # suppressed by the previous global-suppression rule).
        $vmX = $script:TargetedVm
        $vmY = '/subscriptions/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/resourceGroups/rgA/providers/Microsoft.Compute/virtualMachines/vmY'

        $aA = New-Action -Name 'killX' `
            -Started   '2026-05-29T10:00:00Z' `
            -Completed '2026-05-29T10:05:00Z' `
            -ResourceIds @($vmX)
        $aB = New-Action -Name 'killY' `
            -Started   '2026-05-29T10:20:00Z' `
            -Completed '2026-05-29T10:25:00Z' `
            -ResourceIds @($vmY)
        $run = New-Run -Started $script:RunStart -Completed $script:RunEnd -Actions @($aA, $aB)

        # Big spike on vmX inside action-B's window (10:22). vmX is NOT in B's target set.
        # Pre-spike baseline at 10:15 well outside B's baseline window so delta is large.
        $m = New-MetricSignal -ResourceId $vmX -MetricName 'Percentage CPU' -Points @(
            @{ t = '2026-05-29T10:11:00Z'; avg = 5.0 },
            @{ t = '2026-05-29T10:22:00Z'; avg = 95.0 }
        )
        $signals = @{ metrics = @($m); logs=@(); activity=@(); alerts=@(); health=@() }

        $r = Build-ImpactCorrelation -ScenarioRun $run -Signals $signals -Buffer $script:Buffer -MetricDefaults $script:MetricDefaults
        $bRes = $r | Where-Object { $_.actionName -eq 'killY' }
        $unex = $bRes.signals.unexplained | Where-Object { $_.resourceId -eq $vmX -and $_.timestamp -eq '2026-05-29T10:22:00Z' }
        $unex | Should -Not -BeNullOrEmpty
    }
}

Describe 'Build-ImpactCorrelation — service health goes to platformEvent (review fix)' {
    It "routes Service Health events into 'platformEvent', not 'unexplained'" {
        $action = New-Action -Name 'cpuPressure' `
            -Started   '2026-05-29T10:10:00Z' `
            -Completed '2026-05-29T10:20:00Z' `
            -ResourceIds @($script:TargetedVm)
        $run = New-Run -Started $script:RunStart -Completed $script:RunEnd -Actions @($action)

        $health = [pscustomobject]@{
            title     = 'Cosmos DB regional incident'
            eventType = 'ServiceIssue'
            startTime = '2026-05-29T10:14:00Z'
        }
        $signals = @{ metrics=@(); logs=@(); activity=@(); alerts=@(); health=@($health) }

        $r = Build-ImpactCorrelation -ScenarioRun $run -Signals $signals -Buffer $script:Buffer -MetricDefaults $script:MetricDefaults
        $r[0].signals.platformEvent.Count   | Should -Be 1
        $r[0].signals.platformEvent[0].name | Should -Be 'Cosmos DB regional incident'
        $r[0].signals.unexplained.Count     | Should -Be 0
    }
}

Describe 'Build-ImpactCorrelation — per-action timing fallback' {
    It "tags windowSource='run' when action has no startedAt/completedAt" {
        # Note: omit -Started/-Completed → action has no timing.
        $action = New-Action -Name 'driftAction' -ResourceIds @($script:TargetedVm)
        $run = New-Run -Started $script:RunStart -Completed $script:RunEnd -Actions @($action)
        $signals = @{ metrics=@(); logs=@(); activity=@(); alerts=@(); health=@() }

        $result = Build-ImpactCorrelation -ScenarioRun $run -Signals $signals -Buffer $script:Buffer -MetricDefaults $script:MetricDefaults
        $result[0].windowSource | Should -Be 'run'
        $result[0].startedAt    | Should -Be $script:RunStart
        $result[0].completedAt  | Should -Be $script:RunEnd
    }
}

Describe 'Build-ImpactCorrelation — severity bucket boundaries' {
    BeforeEach {
        $script:action = New-Action -Name 'cpuPressure' `
            -Started   '2026-05-29T10:10:00Z' `
            -Completed '2026-05-29T10:20:00Z' `
            -ResourceIds @($script:TargetedVm)
        $script:run = New-Run -Started $script:RunStart -Completed $script:RunEnd -Actions @($script:action)
    }

    It '1.5× threshold → med' {
        # Baseline ≈ 0. Spike of 30 over threshold 20 → ratio 1.5 → med.
        $m = New-MetricSignal -ResourceId $script:TargetedVm -MetricName 'Percentage CPU' -Points @(
            @{ t = '2026-05-29T10:00:30Z'; avg = 0.0 },
            @{ t = '2026-05-29T10:04:00Z'; avg = 0.0 },
            @{ t = '2026-05-29T10:15:00Z'; avg = 30.0 }
        )
        $signals = @{ metrics = @($m); logs=@(); activity=@(); alerts=@(); health=@() }
        $r = Build-ImpactCorrelation -ScenarioRun $script:run -Signals $signals -Buffer $script:Buffer -MetricDefaults $script:MetricDefaults
        $hit = $r[0].signals.chaosAttributed | Where-Object { $_.timestamp -eq '2026-05-29T10:15:00Z' }
        $hit.severity | Should -Be 'med'
    }

    It '2.5× threshold → high' {
        $m = New-MetricSignal -ResourceId $script:TargetedVm -MetricName 'Percentage CPU' -Points @(
            @{ t = '2026-05-29T10:00:30Z'; avg = 0.0 },
            @{ t = '2026-05-29T10:04:00Z'; avg = 0.0 },
            @{ t = '2026-05-29T10:15:00Z'; avg = 50.0 }
        )
        $signals = @{ metrics = @($m); logs=@(); activity=@(); alerts=@(); health=@() }
        $r = Build-ImpactCorrelation -ScenarioRun $script:run -Signals $signals -Buffer $script:Buffer -MetricDefaults $script:MetricDefaults
        $hit = $r[0].signals.chaosAttributed | Where-Object { $_.timestamp -eq '2026-05-29T10:15:00Z' }
        $hit.severity | Should -Be 'high'
    }

    It '3.5× threshold → crit' {
        $m = New-MetricSignal -ResourceId $script:TargetedVm -MetricName 'Percentage CPU' -Points @(
            @{ t = '2026-05-29T10:00:30Z'; avg = 0.0 },
            @{ t = '2026-05-29T10:04:00Z'; avg = 0.0 },
            @{ t = '2026-05-29T10:15:00Z'; avg = 70.0 }
        )
        $signals = @{ metrics = @($m); logs=@(); activity=@(); alerts=@(); health=@() }
        $r = Build-ImpactCorrelation -ScenarioRun $script:run -Signals $signals -Buffer $script:Buffer -MetricDefaults $script:MetricDefaults
        $hit = $r[0].signals.chaosAttributed | Where-Object { $_.timestamp -eq '2026-05-29T10:15:00Z' }
        $hit.severity | Should -Be 'crit'
    }

    It 'exactly 2× threshold → med (boundary is exclusive: >2× = high, ==2× = med)' {
        # Baseline=0, spike=40, threshold=20 → delta/threshold == 2.0 exactly.
        $m = New-MetricSignal -ResourceId $script:TargetedVm -MetricName 'Percentage CPU' -Points @(
            @{ t = '2026-05-29T10:00:30Z'; avg = 0.0 },
            @{ t = '2026-05-29T10:04:00Z'; avg = 0.0 },
            @{ t = '2026-05-29T10:15:00Z'; avg = 40.0 }
        )
        $signals = @{ metrics = @($m); logs=@(); activity=@(); alerts=@(); health=@() }
        $r = Build-ImpactCorrelation -ScenarioRun $script:run -Signals $signals -Buffer $script:Buffer -MetricDefaults $script:MetricDefaults
        $hit = $r[0].signals.chaosAttributed | Where-Object { $_.timestamp -eq '2026-05-29T10:15:00Z' }
        $hit.severity | Should -Be 'med'
    }

    It 'exactly 3× threshold → high (boundary is exclusive: >3× = crit, ==3× = high)' {
        # Baseline=0, spike=60, threshold=20 → delta/threshold == 3.0 exactly.
        $m = New-MetricSignal -ResourceId $script:TargetedVm -MetricName 'Percentage CPU' -Points @(
            @{ t = '2026-05-29T10:00:30Z'; avg = 0.0 },
            @{ t = '2026-05-29T10:04:00Z'; avg = 0.0 },
            @{ t = '2026-05-29T10:15:00Z'; avg = 60.0 }
        )
        $signals = @{ metrics = @($m); logs=@(); activity=@(); alerts=@(); health=@() }
        $r = Build-ImpactCorrelation -ScenarioRun $script:run -Signals $signals -Buffer $script:Buffer -MetricDefaults $script:MetricDefaults
        $hit = $r[0].signals.chaosAttributed | Where-Object { $_.timestamp -eq '2026-05-29T10:15:00Z' }
        $hit.severity | Should -Be 'high'
    }

    It 'exactly 1× threshold → magnitude test fails (>threshold is exclusive); signal skipped' {
        # Baseline=0, spike=20, threshold=20 → |delta| > threshold is FALSE.
        # No magnitudeHit ⇒ signal is neither chaosAttributed nor baseline (not in baseline window).
        # Per spec: 'Otherwise: skip (below noise floor)'.
        $m = New-MetricSignal -ResourceId $script:TargetedVm -MetricName 'Percentage CPU' -Points @(
            @{ t = '2026-05-29T10:00:30Z'; avg = 0.0 },
            @{ t = '2026-05-29T10:04:00Z'; avg = 0.0 },
            @{ t = '2026-05-29T10:15:00Z'; avg = 20.0 }
        )
        $signals = @{ metrics = @($m); logs=@(); activity=@(); alerts=@(); health=@() }
        $r = Build-ImpactCorrelation -ScenarioRun $script:run -Signals $signals -Buffer $script:Buffer -MetricDefaults $script:MetricDefaults
        ($r[0].signals.chaosAttributed | Where-Object { $_.timestamp -eq '2026-05-29T10:15:00Z' }).Count | Should -Be 0
        ($r[0].signals.unexplained     | Where-Object { $_.timestamp -eq '2026-05-29T10:15:00Z' }).Count | Should -Be 0
    }
}

Describe 'Build-ImpactCorrelation — alert classification' {
    It 'classifies an in-window alert on a targeted resource with mapped severity' {
        $action = New-Action -Name 'cpuPressure' `
            -Started   '2026-05-29T10:10:00Z' `
            -Completed '2026-05-29T10:20:00Z' `
            -ResourceIds @($script:TargetedVm)
        $run = New-Run -Started $script:RunStart -Completed $script:RunEnd -Actions @($action)

        $alert = [pscustomobject]@{
            name = 'HighCpuAlert'
            severity = 'Sev1'
            firedTime = '2026-05-29T10:14:00Z'
            targetResourceId = $script:TargetedVm
        }
        $signals = @{ metrics=@(); logs=@(); activity=@(); alerts=@($alert); health=@() }

        $r = Build-ImpactCorrelation -ScenarioRun $run -Signals $signals -Buffer $script:Buffer -MetricDefaults $script:MetricDefaults
        $hit = $r[0].signals.chaosAttributed | Where-Object { $_.signalType -eq 'alert' }
        $hit | Should -Not -BeNullOrEmpty
        $hit.severity   | Should -Be 'high'
        $hit.actionName | Should -Be 'cpuPressure'
    }
}
