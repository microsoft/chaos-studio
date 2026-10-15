<#
.SYNOPSIS
    Regression tests: a hung native call must not blind the stop rule.

.DESCRIPTION
    Live run 8414503f (on cabdbd1): one `az chaos scenario run show` blocked for
    301.7s, so the abort criterion went unevaluated for 323s instead of every
    ~20s. Every native read in the run-phase poll loop is now bounded by the
    loop's own poll cadence (-PollSeconds).

    The fake `az` here is a real executable (an sh wrapper on Linux/macOS, a
    .cmd shim on Windows) that starts a pwsh child, so it has the same
    two-level process tree as the real CLI and abandonment can be checked at
    the process level. Its run.show and metric queries can be made to hang.

    The OnPoll used here mirrors the run phase's: collect the abort signal,
    evaluate the criterion, count unmeasured polls against the same tolerance,
    and cancel through a latch.

    CHAOS_SKILLS_ROOT points the tests at another skills tree (e.g. a pre-fix
    checkout) to show they fail without the fix.

    Run: Invoke-Pester -Path ./chaos-study/tests/PollCadence.Tests.ps1
#>

BeforeAll {
    Set-StrictMode -Version Latest
    $script:SkillsRoot = if ($env:CHAOS_SKILLS_ROOT) { $env:CHAOS_SKILLS_ROOT } else { Split-Path (Split-Path $PSScriptRoot -Parent) -Parent }
    $shared = Join-Path $script:SkillsRoot 'chaos-study' 'scripts' 'lib'
    foreach ($file in 'Common.ps1', 'ApiVersions.ps1', 'Study.ps1', 'Operation.ps1', 'Residue.ps1', 'Exercise.ps1',
        'ConfigurationPayload.ps1', 'FaultDuration.ps1', 'AbortCriteria.ps1', 'SignalIdentity.ps1', 'ExecutionPlan.ps1') {
        . (Join-Path $shared $file)
    }
    . (Join-Path $script:SkillsRoot 'chaos-study-run' 'scripts' 'lib' 'Signals.ps1')
    . (Join-Path $script:SkillsRoot 'chaos-study-run' 'scripts' 'lib' 'Execute.ps1')

    $script:ChaosStudyExtensionEnsured = $true
    Remove-Item -Path function:global:az -ErrorAction SilentlyContinue

    # Kept above PollSeconds so an abandoned call is unmistakable, and well
    # below the injection window so a pre-fix tree still finishes.
    $script:PollSeconds = 3
    $script:HangSeconds = 40
    # Per-poll allowance for starting the fake's pwsh child on a CI runner.
    $script:StartupSlack = 2
    $script:SubscriptionId = '00000000-0000-0000-0000-000000000000'
    $script:Resource = "/subscriptions/$($script:SubscriptionId)/resourceGroups/rg/providers/Microsoft.Compute/virtualMachineScaleSets/vmss"

    $fakeDir = Join-Path $TestDrive 'fakeaz'
    New-Item -ItemType Directory -Path $fakeDir -Force | Out-Null
    $fakeScript = Join-Path $fakeDir 'fake-az.ps1'
    Set-Content -LiteralPath $fakeScript -Encoding utf8 -Value @'
$state = $env:FAKEAZ_STATE
$now = [datetime]::UtcNow.ToString('o')
Add-Content -LiteralPath (Join-Path $state 'calls.log') -Value "$now $($args -join ' ')"
function Hang([string]$Tag) {
    Set-Content -LiteralPath (Join-Path $state "$Tag.pid") -Value $PID
    Start-Sleep -Seconds ([int]$env:FAKEAZ_HANG_SECONDS)
    Set-Content -LiteralPath (Join-Path $state "$Tag.end") -Value 'completed'
}
if ($args[0] -eq 'extension') { 'chaos'; exit 0 }
if ($args[0] -eq 'chaos' -and $args[3] -eq 'show') {
    $counter = Join-Path $state 'shows'
    $n = 1 + [int](Get-Content -LiteralPath $counter -ErrorAction SilentlyContinue)
    Set-Content -LiteralPath $counter -Value $n
    $status = 'Running'
    if (Test-Path (Join-Path $state 'cancelled')) { $status = 'Cancelled' }
    elseif ($n -ge [int]$env:FAKEAZ_HANG_FROM_SHOW) { Hang "show-$n" }
    '{"name":"run1","properties":{"status":"' + $status + '"}}'
    exit 0
}
if ($args[0] -eq 'chaos' -and $args[3] -eq 'cancel') {
    Add-Content -LiteralPath (Join-Path $state 'cancels.log') -Value "$now $($args -join ' ')"
    Set-Content -LiteralPath (Join-Path $state 'cancelled') -Value $now
    '{}'
    exit 0
}
if ($args[0] -eq 'rest') {
    $counter = Join-Path $state 'metrics'
    $n = 1 + [int](Get-Content -LiteralPath $counter -ErrorAction SilentlyContinue)
    Set-Content -LiteralPath $counter -Value $n
    if ($env:FAKEAZ_HANG_METRICS -eq '1') { Hang "metric-$n" }
    $shows = [int](Get-Content -LiteralPath (Join-Path $state 'shows') -ErrorAction SilentlyContinue)
    $value = if ($shows -ge [int]$env:FAKEAZ_BREACH_FROM_SHOW) { 0.5 } else { 1 }
    $stamp = [datetime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:00Z')
    '{"value":[{"name":{"value":"VmAvailabilityMetric"},"timeseries":[{"data":[{"timeStamp":"' + $stamp + '","average":' + $value + '}]}]}]}'
    exit 0
}
'{}'
'@
    $pwshPath = [System.Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
    if ($IsWindows) {
        Set-Content -LiteralPath (Join-Path $fakeDir 'az.cmd') -Encoding ascii -Value "@`"$pwshPath`" -NoProfile -NonInteractive -File `"$fakeScript`" %*"
    } else {
        # Not `exec`: the shell stays as the parent, as the real az wrapper does,
        # so killing only the direct child would orphan the pwsh under it.
        $wrapper = Join-Path $fakeDir 'az'
        Set-Content -LiteralPath $wrapper -Encoding ascii -Value "#!/bin/sh`n`"$pwshPath`" -NoProfile -NonInteractive -File `"$fakeScript`" `"`$@`"`n"
        & chmod +x $wrapper
    }
    $script:OriginalPath = $env:PATH
    $env:PATH = $fakeDir + [System.IO.Path]::PathSeparator + $env:PATH
    (Get-Command az).CommandType | Should -Be 'Application'

    $script:Criterion = [pscustomobject]@{
        stated = $true; evaluable = $true; reason = $null; source = 'customer'
        signal = 'VmAvailabilityMetric'; aggregate = 'last'; conditionText = '< 0.66'; query = $null
        condition = [pscustomobject]@{ raw = '< 0.66'; operator = '<'; threshold = 0.66; unit = $null; parsed = $true; reason = $null }
    }

    function script:Invoke-CadenceScenario {
        param([int]$HangFromShow, [int]$BreachFromShow, [switch]$HangMetrics)

        $state = Join-Path $TestDrive ([guid]::NewGuid().ToString('n'))
        New-Item -ItemType Directory -Path $state -Force | Out-Null
        $env:FAKEAZ_STATE = $state
        $env:FAKEAZ_HANG_SECONDS = "$($script:HangSeconds)"
        $env:FAKEAZ_HANG_FROM_SHOW = "$HangFromShow"
        $env:FAKEAZ_BREACH_FROM_SHOW = "$BreachFromShow"
        $env:FAKEAZ_HANG_METRICS = if ($HangMetrics) { '1' } else { '0' }

        $plan = [pscustomobject]@{
            adapter   = 'local-az'
            workspace = [pscustomobject]@{ subscriptionId = $script:SubscriptionId; resourceGroup = 'rg'; name = 'ws' }
            scenario  = [pscustomobject]@{ name = 'scn' }
            scope     = [pscustomobject]@{ projectedResources = @($script:Resource) }
        }
        $sources = @("metrics:VmAvailabilityMetric@$($script:Resource)")

        $script:evaluations = [System.Collections.Generic.List[object]]::new()
        $script:cancelIssued = $false
        $script:unmeasuredStreak = 0
        $started = [datetime]::UtcNow

        Wait-ChaosScenarioRunWindow -Plan $plan -RunId 'run1' -Minutes 1 -PollSeconds $script:PollSeconds -StudyPath $state -OnPoll {
            param($status)
            $now = [datetime]::UtcNow
            $window = New-ChaosWindow -Name 'abort' -Start $now.AddMinutes(-5) -End $now
            $signals = Invoke-ChaosSignalCollection -Plan $plan -Window $window -Sources $sources -StudyPath $state
            $verdict = Test-ChaosAbortCriterion -Criterion $script:Criterion -Signals $signals -Sources $sources
            $script:evaluations.Add([pscustomobject]@{ at = $now; status = $status; breached = $verdict.breached })

            $cancel = $false
            if ($null -eq $verdict.breached) {
                $script:unmeasuredStreak++
                if ($script:unmeasuredStreak -ge 3) { $cancel = $true }
            } else {
                $script:unmeasuredStreak = 0
                if ($verdict.breached) { $cancel = $true }
            }
            if ($cancel -and -not $script:cancelIssued) {
                $script:cancelIssued = $true
                Stop-ChaosStudyScenarioRun -Plan $plan -RunId 'run1' -StudyPath $state | Out-Null
            }
        } | Out-Null

        return [pscustomobject]@{ state = $state; started = $started; finished = [datetime]::UtcNow }
    }

    function script:Get-EvaluationGaps {
        $at = @($script:evaluations | ForEach-Object { $_.at })
        return @(for ($i = 1; $i -lt $at.Count; $i++) { ($at[$i] - $at[$i - 1]).TotalSeconds })
    }

    function script:Get-Cancels([string]$State) {
        $log = Join-Path $State 'cancels.log'
        if (-not (Test-Path $log)) { return @() }
        return @(Get-Content -LiteralPath $log)
    }

    function script:Get-AbandonedCalls([string]$State) {
        return @(Get-ChildItem -LiteralPath $State -Filter '*.pid' | ForEach-Object {
                $tag = $_.BaseName
                [pscustomobject]@{
                    tag       = $tag
                    pid       = [int](Get-Content -LiteralPath $_.FullName)
                    completed = Test-Path (Join-Path $State "$tag.end")
                }
            })
    }

    function script:Test-ProcessAlive([int]$ProcessId) {
        # A killed child can take a moment to be reaped; allow one cadence.
        $deadline = [datetime]::UtcNow.AddSeconds($script:PollSeconds)
        do {
            $process = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
            if ($null -eq $process -or $process.HasExited) { return $false }
            Start-Sleep -Milliseconds 200
        } while ([datetime]::UtcNow -lt $deadline)
        return $true
    }

    # Each evaluation may wait one cadence of sleep, one bounded native call,
    # and one fast native call.
    $script:MaxGap = 2 * $script:PollSeconds + $script:StartupSlack + $script:PollSeconds
}

AfterAll {
    $env:PATH = $script:OriginalPath
    foreach ($name in 'FAKEAZ_STATE', 'FAKEAZ_HANG_SECONDS', 'FAKEAZ_HANG_FROM_SHOW', 'FAKEAZ_BREACH_FROM_SHOW', 'FAKEAZ_HANG_METRICS') {
        Remove-Item -Path "env:$name" -ErrorAction SilentlyContinue
    }
}

Describe 'CADENCE: a hung run.show does not blind the stop rule (live run 8414503f)' {
    BeforeAll {
        # Show 1 answers; every later show hangs until cancelled. The metric
        # breaches from the third show on, i.e. while shows are hanging.
        $script:hung = Invoke-CadenceScenario -HangFromShow 2 -BreachFromShow 3
        $script:hungEvaluations = @($script:evaluations)
        $script:hungGaps = Get-EvaluationGaps
    }

    It '(a) keeps evaluating the abort criterion at the poll cadence while run.show hangs' {
        $script:hungEvaluations.Count | Should -BeGreaterOrEqual 3
        Test-Path (Join-Path $script:hung.state 'show-2.pid') | Should -BeTrue -Because 'show 2 must have entered its hang'
        @($script:hungEvaluations | Where-Object { $null -eq $_.status }).Count | Should -BeGreaterOrEqual 1 -Because 'a status read abandoned at the cadence is status-unknown for that poll'
        foreach ($gap in $script:hungGaps) {
            $gap | Should -BeLessOrEqual $script:MaxGap -Because "a hung run.show ($($script:HangSeconds)s) must not hold the stop rule beyond the ${script:PollSeconds}s cadence"
        }
    }

    It '(b) issues exactly one cancel, with an explicit --subscription, on a breach during a hung run.show' {
        $cancels = @(Get-Cancels -State $script:hung.state)
        $cancels.Count | Should -Be 1
        $cancels[0] | Should -Match "--subscription $($script:SubscriptionId)"
        $breach = @($script:hungEvaluations | Where-Object { $_.breached -eq $true })[0]
        $breach.status | Should -BeNullOrEmpty -Because 'the breach was measured while run.show was hanging'
        $cancelAt = [datetime]::Parse($cancels[0].Split(' ')[0], $null, [System.Globalization.DateTimeStyles]::RoundtripKind)
        ($cancelAt - $script:hung.started).TotalSeconds | Should -BeLessThan $script:HangSeconds -Because 'cancel must not wait for the hung run.show to return'
        $script:hungEvaluations[-1].status | Should -Be 'Cancelled'
    }

    It '(c) leaves no abandoned az process running' {
        $abandoned = @(Get-AbandonedCalls -State $script:hung.state)
        $abandoned.Count | Should -BeGreaterOrEqual 1
        foreach ($call in $abandoned) {
            $call.completed | Should -BeFalse -Because "$($call.tag) was abandoned at the cadence, so it must have been terminated rather than left to run"
            Test-ProcessAlive -ProcessId $call.pid | Should -BeFalse -Because "$($call.tag) (pid $($call.pid)) is the pwsh grandchild of the az shim; it must not be orphaned"
        }
    }
}

Describe 'CADENCE: a hung metric query is an unmeasured poll under the existing tolerance' {
    BeforeAll {
        $script:metricHung = Invoke-CadenceScenario -HangFromShow 999 -BreachFromShow 999 -HangMetrics
        $script:metricEvaluations = @($script:evaluations)
        $script:metricGaps = Get-EvaluationGaps
    }

    It 'evaluates on cadence, counts each abandoned query as unmeasured, and cancels once at the tolerance' {
        $script:metricEvaluations.Count | Should -BeGreaterOrEqual 3
        @($script:metricEvaluations | Select-Object -First 3 | Where-Object { $null -ne $_.breached }).Count | Should -Be 0
        foreach ($gap in $script:metricGaps) { $gap | Should -BeLessOrEqual $script:MaxGap }
        @(Get-Cancels -State $script:metricHung.state).Count | Should -Be 1
    }

    It 'leaves no abandoned metric query running' {
        $abandoned = @(Get-AbandonedCalls -State $script:metricHung.state)
        $abandoned.Count | Should -BeGreaterOrEqual 1
        foreach ($call in $abandoned) {
            $call.completed | Should -BeFalse
            Test-ProcessAlive -ProcessId $call.pid | Should -BeFalse
        }
    }
}
