<#
.SYNOPSIS
    Regression tests for the run-phase defects found on PR #37 (86db693).

.DESCRIPTION
    B1   abort criterion unmeasurable: in-process [ordered] signal points ignored
    B2a  reused study-owned preflight configuration refused as non-exclusive
    B2b  empty run list ('[]') read as "enumeration unavailable"
    F2   empty {} cancel body crashed envelope normalisation under StrictMode
    F38  front door could not carry -AbortCriteria; remediation omitted `source`
    7h   run times shifted by the host UTC offset
    SCN  live run list names the configuration properties.scenarioConfigurationName,
         which was unread, so the started run resolved as ambiguous (live run 02e10afe)
    F4   unused study-owned preflight configuration leaked after a run

    No Azure calls: `az` is replaced by a global function for the adapter tests.
    CHAOS_SKILLS_ROOT points the tests at another skills tree (e.g. a pre-fix
    checkout) to show they fail without the fixes.

    Run: Invoke-Pester -Path ./chaos-study/tests/RunPhaseFixes.Tests.ps1
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
    . (Join-Path $script:SkillsRoot 'chaos-study-report' 'scripts' 'lib' 'Findings.ps1')
    . (Join-Path $script:SkillsRoot 'chaos-study-scope' 'scripts' 'lib' 'Readiness.ps1')

    # Skip the extension install/update probe.
    $script:ChaosStudyExtensionEnsured = $true

    function script:New-TestPlan {
        [pscustomobject]@{
            adapter             = 'local-az'
            workspace           = [pscustomobject]@{ subscriptionId = '00000000-0000-0000-0000-000000000000'; resourceGroup = 'rg'; name = 'ws' }
            scenario            = [pscustomobject]@{ name = 'scn' }
            declaredVsEffective = [pscustomobject]@{ preflight = [pscustomobject]@{ configurationName = 'preflight-study1' } }
        }
    }

    function script:New-TestStudyPath {
        $path = Join-Path $TestDrive ([guid]::NewGuid().ToString('n'))
        New-Item -ItemType Directory -Path $path -Force | Out-Null
        return $path
    }

    # Fake az: $global:FakeAzStdout / $global:FakeAzExit drive the `az chaos` answer.
    function global:az {
        if ($args.Count -gt 0 -and $args[0] -eq 'extension') { $global:LASTEXITCODE = 0; return 'chaos' }
        $global:FakeAzCalls += , @($args)
        $global:LASTEXITCODE = $global:FakeAzExit
        if ($global:FakeAzExit -ne 0) { return 'ERROR: (InternalServerError) boom' }
        return $global:FakeAzStdout
    }
}

AfterAll {
    Remove-Item -Path function:global:az -ErrorAction SilentlyContinue
}

Describe 'B1: in-process [ordered] signal points are measured' {
    It 'Get-ChaosSignalValueMap summarises IDictionary points' {
        $signal = [pscustomobject]@{ values = @(
                [ordered]@{ timestamp = '2026-09-15T17:00:00Z'; value = 0.5 },
                [ordered]@{ timestamp = '2026-09-15T17:01:00Z'; value = 1 }
            ) }
        $map = Get-ChaosSignalValueMap -Signal $signal
        $map['count'] | Should -Be 2
        $map['last'] | Should -Be 1
        $map['min'] | Should -Be 0.5
    }

    It 'still summarises PSCustomObject points read back from JSON' {
        $signal = [pscustomobject]@{ values = @('[{"timestamp":"2026-09-15T17:00:00Z","value":3}]' | ConvertFrom-Json) }
        (Get-ChaosSignalValueMap -Signal $signal)['last'] | Should -Be 3
    }

    It 'lets the abort criterion measure an in-process series' {
        $signal = [pscustomobject]@{ values = @([ordered]@{ timestamp = '2026-09-15T17:00:00Z'; value = 0.4 }) }
        $measurement = Select-ChaosAbortMeasurement -Signal $signal -SignalName 'VmAvailabilityMetric' -Aggregate 'last'
        $measurement.value | Should -Be 0.4
    }

    It 'Get-ChaosSignalWindowPoint reads timestamps from IDictionary points' {
        $signal = [pscustomobject]@{ values = @(
                [ordered]@{ timestamp = '2026-09-15T17:00:30Z'; value = 1 },
                [ordered]@{ timestamp = '2026-09-15T18:00:00Z'; value = 1 }
            ) }
        $window = [pscustomobject]@{ start = '2026-09-15T17:00:00Z'; end = '2026-09-15T17:05:00Z' }
        $result = Get-ChaosSignalWindowPoint -Signal $signal -ActionWindow $window
        $result.verifiable | Should -BeTrue
    }
}

Describe 'B2b: an empty run list is an available, empty baseline' {
    BeforeEach { $global:FakeAzCalls = @(); $global:FakeAzExit = 0; $global:FakeAzStdout = '[]' }

    It 'reports available with no runs for []' {
        $inventory = Get-ChaosScenarioRunInventory -Plan (New-TestPlan) -StudyPath (New-TestStudyPath)
        $inventory.available | Should -BeTrue
        @($inventory.runs).Count | Should -Be 0
    }

    It 'still reports unavailable on a non-zero exit' {
        $global:FakeAzExit = 1
        $inventory = Get-ChaosScenarioRunInventory -Plan (New-TestPlan) -StudyPath (New-TestStudyPath)
        $inventory.available | Should -BeFalse
    }

    It 'still reports unavailable on unparseable output' {
        $global:FakeAzStdout = 'not json at all'
        $inventory = Get-ChaosScenarioRunInventory -Plan (New-TestPlan) -StudyPath (New-TestStudyPath)
        $inventory.available | Should -BeFalse
    }

    It 'lists runs from a non-empty answer' {
        $global:FakeAzStdout = '[{"name":"r1","id":"/x/runs/r1","properties":{"configurationName":"c1"}}]'
        $inventory = Get-ChaosScenarioRunInventory -Plan (New-TestPlan) -StudyPath (New-TestStudyPath)
        $inventory.available | Should -BeTrue
        @($inventory.runs).Count | Should -Be 1
    }
}

Describe 'B2a: the study-owned preflight configuration is exclusive' {
    It 'is owned when this study''s scope recorded it in the ledger' {
        $study = New-TestStudyPath
        Add-ChaosPreflightResidueEntry -StudyPath $study -ConfigurationName 'preflight-ledger' `
            -Workspace ([pscustomobject]@{ resourceGroup = 'rg'; name = 'ws'; scenario = 'scn' }) | Out-Null
        $plan = New-TestPlan
        $plan.declaredVsEffective = $null
        Test-ChaosStudyOwnsPreflightConfiguration -Plan $plan -StudyPath $study -ConfigurationName 'preflight-ledger' | Should -BeTrue
    }

    It 'is owned when the frozen plan names it as this study''s preflight' {
        Test-ChaosStudyOwnsPreflightConfiguration -Plan (New-TestPlan) -StudyPath (New-TestStudyPath) -ConfigurationName 'preflight-study1' | Should -BeTrue
    }

    It 'is not owned when neither the ledger nor the plan records it' {
        Test-ChaosStudyOwnsPreflightConfiguration -Plan (New-TestPlan) -StudyPath (New-TestStudyPath) -ConfigurationName 'someone-elses' | Should -BeFalse
    }

    It 'the run phase claims exclusivity for a reused owned preflight' {
        $runScript = Get-Content -Raw (Join-Path $script:SkillsRoot 'chaos-study-run' 'scripts' 'Invoke-ChaosStudyRun.ps1')
        $runScript | Should -Match 'Test-ChaosStudyOwnsPreflightConfiguration'
    }

    It 'binds a single new run on an exclusive config with an empty baseline' {
        $before = [pscustomobject]@{ available = $true; runs = @() }
        $after = [pscustomobject]@{ available = $true; runs = @([pscustomobject]@{ id = 'i1'; name = 'r1'; configurationName = 'preflight-study1' }) }
        $result = Resolve-ChaosStartedScenarioRun -Before $before -After $after -ConfigurationName 'preflight-study1' -ConfigurationExclusive $true
        $result.tracked | Should -BeTrue
    }

    It 'still refuses a config that already carried a run before the start' {
        $prior = [pscustomobject]@{ id = 'i0'; name = 'r0'; configurationName = 'preflight-study1' }
        $before = [pscustomobject]@{ available = $true; runs = @($prior) }
        $after = [pscustomobject]@{ available = $true; runs = @($prior, [pscustomobject]@{ id = 'i1'; name = 'r1'; configurationName = 'preflight-study1' }) }
        $result = Resolve-ChaosStartedScenarioRun -Before $before -After $after -ConfigurationName 'preflight-study1' -ConfigurationExclusive $true
        $result.tracked | Should -BeFalse
    }

    It 'still refuses two new runs on the config' {
        $before = [pscustomobject]@{ available = $true; runs = @() }
        $after = [pscustomobject]@{ available = $true; runs = @(
                [pscustomobject]@{ id = 'i1'; name = 'r1'; configurationName = 'preflight-study1' },
                [pscustomobject]@{ id = 'i2'; name = 'r2'; configurationName = 'preflight-study1' }) }
        $result = Resolve-ChaosStartedScenarioRun -Before $before -After $after -ConfigurationName 'preflight-study1' -ConfigurationExclusive $true
        $result.tracked | Should -BeFalse
    }
}

Describe 'SCN: the live run-list configuration field identifies the started run' {
    BeforeAll {
        $script:Live = Get-Content -Raw (Join-Path $PSScriptRoot 'fixtures' 'live-run-list-35f214c.json') | ConvertFrom-Json
    }

    It 'reads properties.scenarioConfigurationName from a captured live run' {
        $raw = @($script:Live.after | Where-Object { $_.name -eq $script:Live.startedRun })[0]
        (ConvertTo-ChaosScenarioRunSummary -Run $raw).configurationName | Should -Be $script:Live.configurationName
    }

    It 'reads a top-level scenarioConfigurationName' {
        $raw = [pscustomobject]@{ name = 'r1'; scenarioConfigurationName = 'c1' }
        (ConvertTo-ChaosScenarioRunSummary -Run $raw).configurationName | Should -Be 'c1'
    }

    It 'resolves the captured live start (02e10afe) as tracked' {
        $before = [pscustomobject]@{ available = $true; runs = @($script:Live.before | ForEach-Object { ConvertTo-ChaosScenarioRunSummary -Run $_ }) }
        $after = [pscustomobject]@{ available = $true; runs = @($script:Live.after | ForEach-Object { ConvertTo-ChaosScenarioRunSummary -Run $_ }) }
        $result = Resolve-ChaosStartedScenarioRun -Before $before -After $after -ConfigurationName $script:Live.configurationName -ConfigurationExclusive $true
        $result.tracked | Should -BeTrue
        $result.runId | Should -Be $script:Live.startedRun
    }

    It 'resolves the captured live start through the inventory reader' {
        $global:FakeAzCalls = @(); $global:FakeAzExit = 0
        $global:FakeAzStdout = $script:Live.before | ConvertTo-Json -Depth 20 -AsArray
        $before = Get-ChaosScenarioRunInventory -Plan (New-TestPlan) -StudyPath (New-TestStudyPath)
        $global:FakeAzStdout = $script:Live.after | ConvertTo-Json -Depth 20 -AsArray
        $after = Get-ChaosScenarioRunInventory -Plan (New-TestPlan) -StudyPath (New-TestStudyPath)
        $result = Resolve-ChaosStartedScenarioRun -Before $before -After $after -ConfigurationName $script:Live.configurationName -ConfigurationExclusive $true
        $result.tracked | Should -BeTrue
        $result.runId | Should -Be $script:Live.startedRun
    }
}

Describe 'F2: an empty or non-ARM cancel body is an accepted cancel' {
    It 'normalises an empty {} body without throwing under StrictMode' {
        $empty = '{}' | ConvertFrom-Json
        { ConvertTo-ChaosOperationEnvelope -Schema 'any.v1' -Result $empty } | Should -Not -Throw
        (Test-ChaosOperationResult -Schema 'any.v1' -Result $empty).ok | Should -BeTrue
    }

    It 'Stop-ChaosStudyScenarioRun accepts an empty {} cancel response' {
        $global:FakeAzCalls = @(); $global:FakeAzExit = 0; $global:FakeAzStdout = '{}'
        { Stop-ChaosStudyScenarioRun -Plan (New-TestPlan) -RunId 'r1' -StudyPath (New-TestStudyPath) } | Should -Not -Throw
        @($global:FakeAzCalls | Where-Object { ($_ -join ' ') -match 'run cancel' }).Count | Should -Be 1
    }

    It 'Stop-ChaosStudyScenarioRun accepts a non-ARM body' {
        $global:FakeAzCalls = @(); $global:FakeAzExit = 0; $global:FakeAzStdout = '{"status":"Cancelling"}'
        { Stop-ChaosStudyScenarioRun -Plan (New-TestPlan) -RunId 'r1' -StudyPath (New-TestStudyPath) } | Should -Not -Throw
    }
}

Describe 'F38: the front door carries -AbortCriteria to scope' {
    BeforeAll {
        $script:FrontDoor = Join-Path $script:SkillsRoot 'chaos-study' 'scripts' 'Invoke-ChaosStudy.ps1'
        $tokens = $null; $errors = $null
        $script:FrontDoorAst = [System.Management.Automation.Language.Parser]::ParseFile($script:FrontDoor, [ref]$tokens, [ref]$errors)
    }

    It 'declares -AbortCriteria in both the Study and Brief parameter sets' {
        $param = @($script:FrontDoorAst.ParamBlock.Parameters | Where-Object { $_.Name.VariablePath.UserPath -eq 'AbortCriteria' })
        $param.Count | Should -Be 1
        $sets = @($param[0].Attributes | Where-Object { $_.TypeName.Name -eq 'Parameter' } | ForEach-Object {
                $_.PositionalArguments + @($_.NamedArguments | ForEach-Object { $_.Argument }) | ForEach-Object { $_.Extent.Text.Trim("'") } })
        $sets | Should -Contain 'Study'
        $sets | Should -Contain 'Brief'
    }

    It 'forwards it into the scope arguments when bound' {
        (Get-Content -Raw $script:FrontDoor) | Should -Match "\`$scopeArgs\['AbortCriteria'\] = \`$AbortCriteria"
    }

    It 'crosses the phase boundary unchanged as a table' {
        $fn = $script:FrontDoorAst.Find({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Invoke-ChaosPhase' }, $true)
        . ([scriptblock]::Create($fn.Extent.Text))
        $out = Join-Path $TestDrive 'received.json'
        $child = Join-Path $TestDrive 'child.ps1'
        Set-Content -LiteralPath $child -Value "param([object]`$AbortCriteria) `$AbortCriteria | ConvertTo-Json -Depth 5 -Compress | Set-Content -LiteralPath '$out'; exit 0"
        $rule = @{ statement = 'stop below two thirds'; source = 'customer'; signal = 'VmAvailabilityMetric'; condition = '< 0.66'; resourceCorrelation = '/subscriptions/x/rg/vmss' }
        Invoke-ChaosPhase -Name 'child' -Script $child -Arguments @{ AbortCriteria = $rule } | Out-Null
        $received = Get-Content -Raw $out | ConvertFrom-Json -AsHashtable
        foreach ($key in $rule.Keys) { $received[$key] | Should -Be $rule[$key] }
    }

    It 'tells the operator that source = customer is required' {
        $gate = Test-ChaosAbortCriteriaArmable -AbortCriteria $null
        $gate.remediation | Should -Match "source = 'customer'"
    }
}

Describe '7h: run times keep their instant on a non-UTC host' {
    # Independent of the host zone, so it proves the fix on Windows too, which
    # ignores $env:TZ. Each instant reaches the converter with a non-zero
    # offset: as a DateTimeOffset at -07:00 (wall clock 10:00, instant 17:00Z),
    # as the local-kind [datetime] ConvertFrom-Json produces, and as raw JSON.
    # Stringifying any of them, then re-reading the text as UTC, either loses
    # the ISO form or moves the instant by the offset.
    It 'Get-ChaosScenarioRunObservation reports <Name> instants as the same UTC instant' -ForEach @(
        @{ Name = 'DateTimeOffset (-07:00)'; Make = { param([datetime]$utc) [datetimeoffset]::new($utc.AddHours(-7).Ticks, [timespan]::FromHours(-7)) } }
        @{ Name = 'local-kind [datetime]'; Make = { param([datetime]$utc) [datetimeoffset]::new($utc.AddHours(-7).Ticks, [timespan]::FromHours(-7)).LocalDateTime } }
        @{ Name = 'ConvertFrom-Json'; Make = $null }
    ) {
        $expected = [ordered]@{
            startTime = '2026-09-15T17:00:00Z'; endTime = '2026-09-15T17:10:00Z'
            legStart  = '2026-09-15T17:00:05Z'; legEnd = '2026-09-15T17:09:55Z'
        }
        if ($null -eq $Make) {
            $run = ('{"properties":{"startTime":"' + $expected.startTime + '","endTime":"' + $expected.endTime +
                '","scenarioRunSummary":[{"actionUrn":"a","state":"Completed","startedAt":"' + $expected.legStart +
                '","completedAt":"' + $expected.legEnd + '"}]}}') | ConvertFrom-Json
        } else {
            $v = @{}
            foreach ($key in $expected.Keys) { $v[$key] = & $Make (ConvertFrom-ChaosUtcIso -Text $expected[$key]) }
            if ($Name -like 'local-kind*') { $v.startTime.Kind | Should -Be ([System.DateTimeKind]::Local) }
            $run = [pscustomobject]@{ properties = [pscustomobject]@{
                    startTime = $v.startTime; endTime = $v.endTime
                    scenarioRunSummary = @([pscustomobject]@{ actionUrn = 'a'; state = 'Completed'; startedAt = $v.legStart; completedAt = $v.legEnd })
                } }
        }

        $o = Get-ChaosScenarioRunObservation -Run $run
        $leg = @($o.actions)[0]
        $actual = [ordered]@{ startTime = $o.startedAt; endTime = $o.completedAt; legStart = $leg.startedAt; legEnd = $leg.completedAt }
        foreach ($key in $expected.Keys) {
            [string]$actual[$key] | Should -Be $expected[$key]
            # The consumer re-reads these as UTC; the instant must survive that.
            (ConvertFrom-ChaosUtcIso -Text ([string]$actual[$key])) | Should -Be (ConvertFrom-ChaosUtcIso -Text $expected[$key])
        }
    }
}

Describe 'F4: an unused study-owned preflight configuration is removed after a run' {
    BeforeEach {
        $script:Study = New-TestStudyPath
        Add-ChaosPreflightResidueEntry -StudyPath $script:Study -ConfigurationName 'preflight-study1' `
            -Workspace ([pscustomobject]@{ resourceGroup = 'rg'; name = 'ws'; scenario = 'scn' }) | Out-Null
        Add-ChaosExecutionResidueEntry -StudyPath $script:Study -ConfigurationName 'study-1' `
            -Workspace ([pscustomobject]@{ resourceGroup = 'rg'; name = 'ws' }) -Adapter 'local-az' | Out-Null
        Set-ChaosResidueCleanup -StudyPath $script:Study -Kind 'executionConfiguration' -Id 'study-1' -Status 'verified-absent' | Out-Null
    }

    It 'deletes it with an absence probe and leaves no unresolved residue' {
        Mock Remove-ChaosStudyConfiguration { }
        Mock Test-ChaosStudyConfigurationAbsent { $true }
        Remove-ChaosUnusedPreflightConfiguration -Plan (New-TestPlan) -StudyPath $script:Study -ConfigurationName 'study-1' -Adapter 'local-az' -VerifyDelaySeconds 0 | Out-Null
        Should -Invoke Remove-ChaosStudyConfiguration -Times 1 -ParameterFilter { $ConfigurationName -eq 'preflight-study1' }
        @(Get-ChaosUnresolvedResidue -StudyPath $script:Study).Count | Should -Be 0
    }

    It 'keeps it unresolved when the read-back still sees it' {
        Mock Remove-ChaosStudyConfiguration { }
        Mock Test-ChaosStudyConfigurationAbsent { $false }
        Remove-ChaosUnusedPreflightConfiguration -Plan (New-TestPlan) -StudyPath $script:Study -ConfigurationName 'study-1' -VerifyAttempts 1 -VerifyDelaySeconds 0 -WarningAction SilentlyContinue | Out-Null
        @(Get-ChaosUnresolvedResidue -StudyPath $script:Study | ForEach-Object { $_.id }) | Should -Contain 'preflight-study1'
    }

    It 'never deletes the configuration that ran' {
        Mock Remove-ChaosStudyConfiguration { }
        Mock Test-ChaosStudyConfigurationAbsent { $true }
        Remove-ChaosUnusedPreflightConfiguration -Plan (New-TestPlan) -StudyPath $script:Study -ConfigurationName 'preflight-study1' -VerifyDelaySeconds 0 | Out-Null
        Should -Invoke Remove-ChaosStudyConfiguration -Times 0
    }

    It 'the run phase calls it on the fresh-configuration path' {
        (Get-Content -Raw (Join-Path $script:SkillsRoot 'chaos-study-run' 'scripts' 'Invoke-ChaosStudyRun.ps1')) |
            Should -Match 'Remove-ChaosUnusedPreflightConfiguration'
    }
}
