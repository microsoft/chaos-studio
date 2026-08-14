Describe "Chaos Loop native plugin integration" {
    BeforeAll {
        $script:pluginRoot = (Resolve-Path (Join-Path $PSScriptRoot ".." ".." "..")).Path
    }

    It "extends the repository plugin with the controller and five phase skills" {
        $manifest = Get-Content (Join-Path $script:pluginRoot "plugin.json") -Raw |
            ConvertFrom-Json
        $manifest.name | Should -Be "startchaos"
        $manifest.skills | Should -Be "skills/"
        $manifest.mcpServers."chaos-studio".install.path | Should -Be "mcp/"

        foreach ($skill in @(
            "chaos-loop",
            "resilience-analysis",
            "chaos-execution",
            "diagnostic",
            "advisory",
            "coding"
        )) {
            Join-Path $script:pluginRoot "skills" $skill "SKILL.md" | Should -Exist
        }
    }

    It "ships every controller, schema, MCP, reference, package, and example dependency" {
        $required = @(
            "package/chaos-loop/plugin.json",
            "docs/chaos-loop.md",
            "docs/sre-agent-chaos-loop-import.md",
            "references/chaos-loop/shared-contract.md",
            "references/chaos-loop/scenario-catalog.md",
            "references/chaos-loop/scenario-catalog.v1.json",
            "schemas/chaos-loop/run-state.v1.schema.json",
            "schemas/chaos-loop/workspace-plan.v1.schema.json",
            "schemas/chaos-loop/external-gate.v1.schema.json",
            "scripts/chaos_loop_state.py",
            "scripts/Build-ChaosLoopPackage.ps1",
            "examples/chaos-loop/initial-state.json",
            "examples/chaos-loop/workspace-plan.json",
            "examples/chaos-loop/external-gate.json",
            "mcp/chaos_mcp/server.py"
        )
        foreach ($relative in $required) {
            Join-Path $script:pluginRoot $relative | Should -Exist
        }
    }

    It "binds the controller workspace preflight to the read-only MCP discovery tool" {
        $controller = Get-Content (
            Join-Path $script:pluginRoot "skills" "chaos-loop" "SKILL.md"
        ) -Raw
        $server = Get-Content (
            Join-Path $script:pluginRoot "mcp" "chaos_mcp" "server.py"
        ) -Raw
        $state = Get-Content (
            Join-Path $script:pluginRoot "scripts" "chaos_loop_state.py"
        ) -Raw

        $server | Should -Match "def chaos_list_workspaces"
        $server | Should -Match "def chaos_get_workspace"
        $server | Should -Match "def chaos_create_workspace"
        $controller | Should -Match "chaos_list_workspaces"
        $controller | Should -Match "workspace-plan"
        $controller | Should -Match "workspace-finalize"
        $controller | Should -Match "workspace-fail"
        $state | Should -Match "def cmd_workspace_plan"
        $state | Should -Match "def cmd_workspace_finalize"
        $state | Should -Match "def cmd_workspace_fail"

        foreach ($skill in @("resilience-analysis", "chaos-execution", "diagnostic", "advisory", "coding")) {
            $content = Get-Content (Join-Path $script:pluginRoot "skills" $skill "SKILL.md") -Raw
            $content | Should -Match "workspace"
            $content | Should -Not -Match "chaos_list_workspaces"
            $content | Should -Not -Match "chaos_create_workspace"
        }
    }

    It "binds phase skills to the repository MCP tools without a private Azure wrapper" {
        $analysis = Get-Content (
            Join-Path $script:pluginRoot "skills" "resilience-analysis" "SKILL.md"
        ) -Raw
        $execution = Get-Content (
            Join-Path $script:pluginRoot "skills" "chaos-execution" "SKILL.md"
        ) -Raw
        $diagnostic = Get-Content (
            Join-Path $script:pluginRoot "skills" "diagnostic" "SKILL.md"
        ) -Raw
        $server = Get-Content (
            Join-Path $script:pluginRoot "mcp" "chaos_mcp" "server.py"
        ) -Raw

        $analysis | Should -Match "chaos_list_recommended_scenarios"
        $execution | Should -Match "chaos_execute_scenario"
        $execution | Should -Match "chaos_get_scenario_run"
        $diagnostic | Should -Match "monitor_query_logs"
        $server | Should -Match "def chaos_list_recommended_scenarios"
        $server | Should -Match "def chaos_execute_scenario"
        $server | Should -Match "def chaos_get_scenario_run"
        ($analysis + $execution + $diagnostic) | Should -Not -Match "chaos_api"
    }

    It "contains no source-machine dependency" {
        $paths = @(
            "package/chaos-loop",
            "docs/chaos-loop.md",
            "docs/sre-agent-chaos-loop-import.md",
            "references/chaos-loop",
            "schemas/chaos-loop",
            "scripts/chaos_loop_state.py",
            "skills/chaos-loop",
            "skills/resilience-analysis",
            "skills/chaos-execution",
            "skills/diagnostic",
            "skills/advisory",
            "skills/coding"
        )
        $content = foreach ($relative in $paths) {
            $path = Join-Path $script:pluginRoot $relative
            if (Test-Path $path -PathType Leaf) {
                [System.IO.File]::ReadAllText($path)
            } else {
                Get-ChildItem $path -Recurse -File | ForEach-Object {
                    [System.IO.File]::ReadAllText($_.FullName)
                }
            }
        }
        $forbiddenSource = "Chaos-" + "AI-Plugins"
        $forbiddenLegacy = "sre-agent-" + "chaos-skills"
        $forbiddenHome = "C:" + "\Users\"
        $pattern = @(
            [regex]::Escape($forbiddenSource),
            [regex]::Escape($forbiddenLegacy),
            [regex]::Escape($forbiddenHome)
        ) -join "|"
        ($content -join "`n") | Should -Not -Match $pattern
    }

    It "builds a complete package archive without bytecode" {
        $builder = Join-Path $script:pluginRoot "scripts" "Build-ChaosLoopPackage.ps1"
        $outputDirectory = Join-Path $TestDrive "package"
        $output = @(
            & pwsh -NoProfile -File $builder `
                -OutputDirectory $outputDirectory `
                -SkipCopilotValidation 2>&1
        )
        $LASTEXITCODE | Should -Be 0 -Because ($output -join "`n")

        $archivePath = Join-Path $outputDirectory "chaos-loop-1.0.0.zip"
        $reportPath = Join-Path $outputDirectory "chaos-loop-1.0.0.package.json"
        $archivePath | Should -Exist
        $reportPath | Should -Exist

        Add-Type -AssemblyName System.IO.Compression.FileSystem
        $archive = [System.IO.Compression.ZipFile]::OpenRead($archivePath)
        try {
            $entries = @($archive.Entries | ForEach-Object { $_.FullName })
        } finally {
            $archive.Dispose()
        }
        $entries | Should -Contain "chaos-loop/plugin.json"
        $entries | Should -Contain "chaos-loop/SRE-AGENT-IMPORT.md"
        $entries | Should -Contain "chaos-loop/mcp/chaos_mcp/server.py"
        ($entries -match "__pycache__|\.pyc$").Count | Should -Be 0
    }
}
