<#
.SYNOPSIS
    Pester 5 unit tests for New-ImpactReport.ps1 (Epic 4 renderer).

.DESCRIPTION
    Coverage:
      - Round-trip: build a minimal model → render JSON → assert it contains
        every required top-level field from impact-report.schema.json, with
        impactReportSchemaVersion == 1 and the documented enum / type
        constraints holding on a representative Signal.
      - Markdown rendering: section headers + action names appear; empty
        chaos-attributed bucket renders the explicit 'No ... detected'
        sentence rather than an empty table.
      - Atomic overwrite: running twice with the same -ScenarioRunId
        succeeds; no .tmp files remain in the output directory.
      - partial flag: status='Running' on the ScenarioRun → window.partial
        is $true in JSON and the Markdown carries the '⚠️ Partial report'
        banner.
      - Coverage caveats: logsUnavailableFor entries appear in the
        Coverage / Caveats Markdown section with their reasons.
      - platformEvent bucket: Service Health entries appear in the dedicated
        '## Platform Events' section, not under '## Unexplained Signals'.

    No external calls — the renderer is pure I/O over an in-memory model.

    Run: Invoke-Pester -Path ./tests/New-ImpactReport.Tests.ps1
#>

BeforeAll {
    $script:SkillRoot   = Split-Path $PSScriptRoot -Parent
    $script:ScriptsDir  = Join-Path $script:SkillRoot 'scripts'
    $script:SchemaPath  = Join-Path $script:SkillRoot 'schema/impact-report.schema.json'
    $script:RenderScript = Join-Path $script:ScriptsDir 'New-ImpactReport.ps1'

    . $script:RenderScript  # dot-source: helpers in scope; main body guarded

    $script:Schema = Get-Content $script:SchemaPath -Raw | ConvertFrom-Json

    # ── Fixture builders ─────────────────────────────────
    function New-FixtureRun {
        param(
            [Parameter()][string]$Status = 'Completed',
            [Parameter()][string]$Started   = '2026-05-29T10:00:00Z',
            [Parameter()][string]$Completed = '2026-05-29T10:30:00Z'
        )
        return [pscustomobject]@{
            id = '/subscriptions/aaaa-bbbb-cccc-dddd/resourceGroups/rgA/providers/Microsoft.Chaos/workspaces/wsA/scenarios/myScenario/runs/run-001'
            properties = [pscustomobject]@{
                status      = $Status
                startedAt   = $Started
                completedAt = $Completed
            }
        }
    }

    function New-FixtureCorrelation {
        param(
            [Parameter()][int]$ChaosCount = 1,
            [Parameter()][int]$UnexCount  = 0,
            [Parameter()][int]$PlatCount  = 0,
            [Parameter()][string]$ActionName = 'cpuPressure'
        )
        $vmA = '/subscriptions/aaaa-bbbb-cccc-dddd/resourceGroups/rgA/providers/Microsoft.Compute/virtualMachines/vmA'
        $chaos = @()
        for ($i = 0; $i -lt $ChaosCount; $i++) {
            $chaos += [ordered]@{
                resourceId = $vmA
                signalType = 'metric'
                name       = 'Percentage CPU'
                timestamp  = '2026-05-29T10:15:00Z'
                value      = 80.0
                severity   = 'crit'
                actionName = $ActionName
                rationale  = 'Metric delta exceeds threshold inside action window.'
            }
        }
        $unex = @()
        for ($i = 0; $i -lt $UnexCount; $i++) {
            $unex += [ordered]@{
                resourceId = '/subscriptions/aaaa-bbbb-cccc-dddd/resourceGroups/rgA/providers/Microsoft.Compute/virtualMachines/vmZ'
                signalType = 'metric'
                name       = 'Percentage CPU'
                timestamp  = '2026-05-29T10:18:00Z'
                value      = 90.0
                severity   = 'high'
                actionName = $null
                rationale  = "Signal on a resource not in this action's target set."
            }
        }
        $plat = @()
        for ($i = 0; $i -lt $PlatCount; $i++) {
            $plat += [ordered]@{
                resourceId = $null
                signalType = 'servicehealth'
                name       = 'Cosmos DB regional incident'
                timestamp  = '2026-05-29T10:14:00Z'
                value      = 'ServiceIssue'
                severity   = 'info'
                actionName = $null
                rationale  = 'Known Azure platform event.'
            }
        }
        return @(
            [ordered]@{
                actionName        = $ActionName
                startedAt         = '2026-05-29T10:10:00Z'
                completedAt       = '2026-05-29T10:20:00Z'
                windowSource      = 'action'
                targetedResources = @($vmA)
                signals = [ordered]@{
                    chaosAttributed = $chaos
                    baseline        = @()
                    unexplained     = $unex
                    platformEvent   = $plat
                }
            }
        )
    }

    function New-FixtureCoverage {
        param([Parameter()][string[]]$Unavailable = @())
        $reasons = @{}
        foreach ($u in $Unavailable) { $reasons[$u] = 'no_diagnostic_setting' }
        return @{
            resourcesTotal        = 2
            resourcesSampled      = 2
            skippedDueToCap       = @()
            maxResources          = 50
            logsAvailableFor      = @('/subscriptions/aaaa-bbbb-cccc-dddd/resourceGroups/rgA/providers/Microsoft.Compute/virtualMachines/vmA')
            logsUnavailableFor    = $Unavailable
            logsUnavailableReason = $reasons
        }
    }

    function Invoke-Render {
        param(
            [Parameter(Mandatory)][string]$OutDir,
            [Parameter()][string]$RunId = 'run-001',
            [Parameter()][string]$RunStatus = 'Completed',
            [Parameter()][int]$ChaosCount = 1,
            [Parameter()][int]$UnexCount  = 0,
            [Parameter()][int]$PlatCount  = 0,
            [Parameter()][string[]]$Unavailable = @(),
            [Parameter()][string]$Format = 'both'
        )
        $run = New-FixtureRun -Status $RunStatus
        $corr = New-FixtureCorrelation -ChaosCount $ChaosCount -UnexCount $UnexCount -PlatCount $PlatCount
        $cov = New-FixtureCoverage -Unavailable $Unavailable
        $queries = @{ kql = @(@{ workspaceId = 'ws1'; rows = @() }); metrics = @(@{ resourceId = 'vmA'; metricName = 'Percentage CPU' }) }

        return & $script:RenderScript `
            -CorrelationResult $corr `
            -ScenarioRunId     $RunId `
            -ScenarioRun       $run `
            -Coverage          $cov `
            -Queries           $queries `
            -Errors            @() `
            -OutputDir         $OutDir `
            -Format            $Format
    }

    # Minimal JSON-schema-like validator: enforces the required top-level
    # fields, the const on impactReportSchemaVersion, and the documented
    # enum constraints on Signal.signalType / Signal.severity. Avoids an
    # external dependency on NJsonSchema.
    function Test-AgainstImpactSchema {
        param([Parameter(Mandatory)]$Json, [Parameter(Mandatory)]$Schema)

        $errors = @()
        foreach ($req in $Schema.required) {
            if (-not $Json.PSObject.Properties[$req]) { $errors += "missing required field: $req" }
        }
        if ($Json.impactReportSchemaVersion -ne 1) { $errors += "impactReportSchemaVersion != 1" }

        $sigEnum  = $Schema.definitions.Signal.properties.signalType.enum
        $sevEnum  = $Schema.definitions.Signal.properties.severity.enum
        $wsEnum   = $Schema.properties.actions.items.properties.windowSource.enum

        foreach ($a in @($Json.actions)) {
            if (-not $a.name) { $errors += "action missing name" }
            if ($a.windowSource -and ($a.windowSource -notin $wsEnum)) { $errors += "windowSource '$($a.windowSource)' not in enum" }
            foreach ($bucket in @('chaosAttributed', 'baseline', 'unexplained')) {
                if (-not $a.signals.PSObject.Properties[$bucket]) { $errors += "action '$($a.name)' missing signals.$bucket" }
                foreach ($s in @($a.signals.$bucket)) {
                    if ($s.signalType -and ($s.signalType -notin $sigEnum)) { $errors += "signalType '$($s.signalType)' not in enum" }
                    if ($s.severity   -and ($s.severity   -notin $sevEnum)) { $errors += "severity '$($s.severity)' not in enum" }
                    foreach ($field in @('resourceId', 'signalType', 'name', 'timestamp', 'severity')) {
                        if (-not $s.PSObject.Properties[$field]) { $errors += "signal missing $field" }
                    }
                }
            }
        }
        foreach ($req in @('resourcesTotal', 'resourcesSampled', 'logsAvailableFor', 'logsUnavailableFor')) {
            if (-not $Json.coverage.PSObject.Properties[$req]) { $errors += "coverage missing $req" }
        }
        return $errors
    }
}

Describe 'New-ImpactReport — round-trip (JSON validates against schema)' {
    BeforeEach {
        $script:OutDir = Join-Path $TestDrive ("rt-{0}" -f ([guid]::NewGuid()))
    }

    It 'emits a JSON sidecar that satisfies the v1 schema contract' {
        $res = Invoke-Render -OutDir $script:OutDir -RunId 'run-001' -ChaosCount 1
        Test-Path $res.jsonPath | Should -BeTrue
        $parsed = Get-Content $res.jsonPath -Raw | ConvertFrom-Json
        $errs = Test-AgainstImpactSchema -Json $parsed -Schema $script:Schema
        $errs | Should -BeNullOrEmpty
        $parsed.impactReportSchemaVersion | Should -Be 1
        $parsed.scenarioRunId             | Should -Be 'run-001'
        $parsed.workspace.subscriptionId  | Should -Be 'aaaa-bbbb-cccc-dddd'
        $parsed.workspace.resourceGroup   | Should -Be 'rgA'
        $parsed.workspace.name            | Should -Be 'wsA'
        $parsed.scenario.name             | Should -Be 'myScenario'
        $parsed.window.partial            | Should -BeFalse
        @($parsed.actions).Count          | Should -Be 1
        @($parsed.actions[0].signals.chaosAttributed).Count | Should -Be 1
        $parsed.actions[0].signals.chaosAttributed[0].severity | Should -Be 'crit'
    }
}

Describe 'New-ImpactReport — Markdown rendering' {
    BeforeEach {
        $script:OutDir = Join-Path $TestDrive ("md-{0}" -f ([guid]::NewGuid()))
    }

    It 'contains the expected section headers and the action name' {
        $res = Invoke-Render -OutDir $script:OutDir -RunId 'run-001' -ChaosCount 1
        $md = Get-Content $res.markdownPath -Raw
        $md | Should -Match '^# Chaos Impact Report'
        $md | Should -Match '(?m)^## Summary'
        $md | Should -Match '(?m)^## Action 1 — cpuPressure'
        $md | Should -Match '(?m)^### Chaos-attributed signals'
        $md | Should -Match '(?m)^## Unexplained Signals'
        $md | Should -Match '(?m)^## Coverage / Caveats'
        $md | Should -Match 'cpuPressure'
    }

    It "renders the explicit 'No chaos-attributed signals detected' sentence when bucket is empty" {
        $res = Invoke-Render -OutDir $script:OutDir -RunId 'run-empty' -ChaosCount 0
        $md = Get-Content $res.markdownPath -Raw
        $md | Should -Match 'No chaos-attributed signals detected'
        # And must NOT emit an empty table for that action.
        $md | Should -Not -Match '\|\s*Resource\s*\|\s*Signal\s*\|\s*Type\s*\|\s*Value\s*\|\s*Severity\s*\|\s*Rationale\s*\|[\r\n]+\|---'
    }
}

Describe 'New-ImpactReport — atomic overwrite' {
    BeforeEach {
        $script:OutDir = Join-Path $TestDrive ("ovr-{0}" -f ([guid]::NewGuid()))
    }

    It 'overwrites cleanly on a second invocation with the same RunId; leaves no .tmp files' {
        $r1 = Invoke-Render -OutDir $script:OutDir -RunId 'run-001' -ChaosCount 1
        $r2 = Invoke-Render -OutDir $script:OutDir -RunId 'run-001' -ChaosCount 2
        $r2.markdownPath | Should -Be $r1.markdownPath
        $r2.jsonPath     | Should -Be $r1.jsonPath

        $parsed = Get-Content $r2.jsonPath -Raw | ConvertFrom-Json
        @($parsed.actions[0].signals.chaosAttributed).Count | Should -Be 2

        $stray = Get-ChildItem $script:OutDir -Filter '*.tmp*' -ErrorAction SilentlyContinue
        $stray | Should -BeNullOrEmpty
    }
}

Describe 'New-ImpactReport — partial flag (Running run)' {
    BeforeEach {
        $script:OutDir = Join-Path $TestDrive ("par-{0}" -f ([guid]::NewGuid()))
    }

    It 'sets window.partial=true and renders the ⚠️ Partial banner when run status is Running' {
        $res = Invoke-Render -OutDir $script:OutDir -RunId 'run-part' -RunStatus 'Running'
        $parsed = Get-Content $res.jsonPath -Raw | ConvertFrom-Json
        $parsed.window.partial | Should -BeTrue

        $md = Get-Content $res.markdownPath -Raw
        $md | Should -Match '⚠️ Partial report'
    }
}

Describe 'New-ImpactReport — Coverage / Caveats section' {
    BeforeEach {
        $script:OutDir = Join-Path $TestDrive ("cov-{0}" -f ([guid]::NewGuid()))
    }

    It 'lists unavailable resources and their reasons in the Markdown caveats' {
        $unavail = @(
            '/subscriptions/aaaa-bbbb-cccc-dddd/resourceGroups/rgA/providers/Microsoft.Compute/virtualMachines/vmB'
        )
        $res = Invoke-Render -OutDir $script:OutDir -RunId 'run-cov' -Unavailable $unavail
        $md = Get-Content $res.markdownPath -Raw
        $md | Should -Match '## Coverage / Caveats'
        $md | Should -Match 'without usable diagnostic settings'
        $md | Should -Match 'vmB'
        $md | Should -Match 'no_diagnostic_setting'

        $parsed = Get-Content $res.jsonPath -Raw | ConvertFrom-Json
        @($parsed.coverage.logsUnavailableFor).Count | Should -Be 1
    }
}

Describe 'New-ImpactReport — platformEvent bucket renders in its own section' {
    BeforeEach {
        $script:OutDir = Join-Path $TestDrive ("plt-{0}" -f ([guid]::NewGuid()))
    }

    It "renders Service Health events under '## Platform Events', not '## Unexplained Signals'" {
        $res = Invoke-Render -OutDir $script:OutDir -RunId 'run-plt' -PlatCount 1
        $md = Get-Content $res.markdownPath -Raw
        $md | Should -Match '(?m)^## Platform Events'
        $md | Should -Match 'Cosmos DB regional incident'
        # Cross-action Unexplained Signals section should NOT mention the Cosmos event.
        $unexSection = ($md -split '## Unexplained Signals')[1]
        if ($unexSection) {
            ($unexSection -split '##')[0] | Should -Not -Match 'Cosmos DB regional incident'
        }

        $parsed = Get-Content $res.jsonPath -Raw | ConvertFrom-Json
        @($parsed.actions[0].signals.platformEvent).Count | Should -Be 1
    }
}

Describe 'New-ImpactReport — pure helper coverage' {
    It 'Get-WorkspaceContextFromRun parses subscription/RG/workspace from the run id' {
        $r = [pscustomobject]@{ id = '/subscriptions/S/resourceGroups/R/providers/Microsoft.Chaos/workspaces/W/scenarios/X/runs/Y' }
        $ctx = Get-WorkspaceContextFromRun -ScenarioRun $r
        $ctx.subscriptionId | Should -Be 'S'
        $ctx.resourceGroup  | Should -Be 'R'
        $ctx.name           | Should -Be 'W'
    }
    It 'Get-ScenarioContextFromRun extracts scenario name' {
        $r = [pscustomobject]@{ id = '/subscriptions/S/resourceGroups/R/providers/Microsoft.Chaos/workspaces/W/scenarios/myScen/runs/Y' }
        (Get-ScenarioContextFromRun -ScenarioRun $r).name | Should -Be 'myScen'
    }
    It 'Test-RunIsPartial returns true for Running and false for Completed' {
        Test-RunIsPartial -ScenarioRun ([pscustomobject]@{ properties = [pscustomobject]@{ status = 'Running'   } }) | Should -BeTrue
        Test-RunIsPartial -ScenarioRun ([pscustomobject]@{ properties = [pscustomobject]@{ status = 'Completed' } }) | Should -BeFalse
        Test-RunIsPartial -ScenarioRun ([pscustomobject]@{ properties = [pscustomobject]@{ status = 'Pending'   } }) | Should -BeTrue
        Test-RunIsPartial -ScenarioRun $null | Should -BeFalse
    }
    It 'Get-ShortResourceId returns the trailing 2 segments' {
        Get-ShortResourceId -ResourceId '/subscriptions/S/resourceGroups/R/providers/Microsoft.Compute/virtualMachines/vmA' |
            Should -Be 'virtualMachines/vmA'
    }
    It 'Write-AtomicFile writes content and removes the temp file on success' {
        $p = Join-Path $TestDrive ('atomic-{0}.txt' -f ([guid]::NewGuid()))
        Write-AtomicFile -Path $p -Content 'hello'
        (Get-Content $p -Raw) | Should -Be 'hello'
        (Get-ChildItem (Split-Path $p) -Filter '*.tmp*' -ErrorAction SilentlyContinue) | Should -BeNullOrEmpty
    }
}
