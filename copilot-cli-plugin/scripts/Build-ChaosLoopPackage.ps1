<#
.SYNOPSIS
    Build and validate the standalone Chaos Loop plugin archive.

.DESCRIPTION
    Assembles Chaos Loop assets from the native startchaos plugin layout,
    includes the existing chaos-mcp package, rejects development-only
    references and Python bytecode, and validates the staged plugin.
#>
[CmdletBinding()]
param(
    [string]$OutputDirectory = (Join-Path (Get-Location) "tmp" "chaos-loop-package"),
    [switch]$SkipCopilotValidation
)

$ErrorActionPreference = "Stop"
$pluginRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$packageManifestPath = Join-Path $pluginRoot "package" "chaos-loop" "plugin.json"
$packageManifest = [System.IO.File]::ReadAllText($packageManifestPath) | ConvertFrom-Json

if ($packageManifest.name -ne "chaos-loop" -or $packageManifest.skills -ne "skills/") {
    throw "The Chaos Loop package manifest is invalid."
}

$requiredSources = @(
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
    "skills/chaos-loop/SKILL.md",
    "skills/resilience-analysis/SKILL.md",
    "skills/chaos-execution/SKILL.md",
    "skills/diagnostic/SKILL.md",
    "skills/advisory/SKILL.md",
    "skills/coding/SKILL.md",
    "examples/chaos-loop/initial-state.json",
    "examples/chaos-loop/workspace-plan.json",
    "examples/chaos-loop/external-gate.json",
    "mcp/pyproject.toml",
    "mcp/chaos_mcp/server.py"
)

foreach ($relativePath in $requiredSources) {
    if (-not (Test-Path -LiteralPath (Join-Path $pluginRoot $relativePath))) {
        throw "Package dependency is missing: $relativePath"
    }
}

function Copy-PackageTree {
    param(
        [Parameter(Mandatory)]
        [string]$Source,
        [Parameter(Mandatory)]
        [string]$Destination
    )

    foreach ($sourceFile in Get-ChildItem -LiteralPath $Source -Recurse -File) {
        if (
            $sourceFile.Extension -eq ".pyc" -or
            $sourceFile.FullName -match "[\\/](?:__pycache__|\.pytest_cache|dist)[\\/]"
        ) {
            continue
        }
        $relative = [System.IO.Path]::GetRelativePath($Source, $sourceFile.FullName)
        $destinationFile = Join-Path $Destination $relative
        [System.IO.Directory]::CreateDirectory(
            [System.IO.Path]::GetDirectoryName($destinationFile)
        ) | Out-Null
        [System.IO.File]::Copy($sourceFile.FullName, $destinationFile, $true)
    }
}

$outputPath = [System.IO.Path]::GetFullPath($OutputDirectory)
[System.IO.Directory]::CreateDirectory($outputPath) | Out-Null
$stagingRoot = Join-Path $outputPath (".stage-" + [guid]::NewGuid().ToString("N"))
$stagedPlugin = Join-Path $stagingRoot "chaos-loop"
$archivePath = Join-Path $outputPath ("chaos-loop-" + $packageManifest.version + ".zip")
$reportPath = Join-Path $outputPath ("chaos-loop-" + $packageManifest.version + ".package.json")

try {
    [System.IO.Directory]::CreateDirectory($stagedPlugin) | Out-Null

    [System.IO.File]::Copy($packageManifestPath, (Join-Path $stagedPlugin "plugin.json"))
    [System.IO.File]::Copy(
        (Join-Path $pluginRoot "docs" "chaos-loop.md"),
        (Join-Path $stagedPlugin "README.md")
    )
    [System.IO.File]::Copy(
        (Join-Path $pluginRoot "docs" "sre-agent-chaos-loop-import.md"),
        (Join-Path $stagedPlugin "SRE-AGENT-IMPORT.md")
    )

    foreach ($directory in @("references", "schemas", "examples")) {
        $source = Join-Path $pluginRoot $directory "chaos-loop"
        $destination = Join-Path $stagedPlugin $directory "chaos-loop"
        Copy-PackageTree -Source $source -Destination $destination
    }

    [System.IO.Directory]::CreateDirectory((Join-Path $stagedPlugin "scripts")) | Out-Null
    [System.IO.File]::Copy(
        (Join-Path $pluginRoot "scripts" "chaos_loop_state.py"),
        (Join-Path $stagedPlugin "scripts" "chaos_loop_state.py")
    )

    foreach ($skill in @(
        "chaos-loop",
        "resilience-analysis",
        "chaos-execution",
        "diagnostic",
        "advisory",
        "coding"
    )) {
        $destination = Join-Path $stagedPlugin "skills" $skill
        [System.IO.Directory]::CreateDirectory($destination) | Out-Null
        [System.IO.File]::Copy(
            (Join-Path $pluginRoot "skills" $skill "SKILL.md"),
            (Join-Path $destination "SKILL.md")
        )
    }
    Copy-PackageTree `
        -Source (Join-Path $pluginRoot "mcp") `
        -Destination (Join-Path $stagedPlugin "mcp")

    $textExtensions = @(".json", ".md", ".py", ".ps1", ".toml")
    $forbiddenPatterns = @(
        ("C:" + "\" + "Users" + "\"),
        ("Chaos-" + "AI-Plugins"),
        ("sre-agent-" + "chaos-skills"),
        "chaos_api.py"
    )
    foreach ($file in Get-ChildItem -LiteralPath $stagedPlugin -Recurse -File) {
        if ($textExtensions -notcontains $file.Extension) {
            continue
        }
        $content = [System.IO.File]::ReadAllText($file.FullName)
        foreach ($pattern in $forbiddenPatterns) {
            if ($content -match [regex]::Escape($pattern)) {
                throw "Development-only reference '$pattern' found in $($file.FullName)"
            }
        }
    }

    if (-not $SkipCopilotValidation) {
        $copilot = Get-Command copilot -ErrorAction SilentlyContinue
        if (-not $copilot) {
            throw "copilot was not found. Install it or use -SkipCopilotValidation."
        }
        $pluginList = @(& $copilot.Source --plugin-dir $stagedPlugin plugin list 2>&1)
        if ($LASTEXITCODE -ne 0 -or ($pluginList -join "`n") -notmatch "chaos-loop") {
            throw "Copilot CLI did not load the staged chaos-loop plugin."
        }
    }

    if (Test-Path -LiteralPath $archivePath) {
        Remove-Item -LiteralPath $archivePath -Force
    }
    Compress-Archive -LiteralPath $stagedPlugin -DestinationPath $archivePath

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [System.IO.Compression.ZipFile]::OpenRead($archivePath)
    try {
        $entries = @($archive.Entries | ForEach-Object { $_.FullName })
    } finally {
        $archive.Dispose()
    }

    $requiredEntries = @(
        "chaos-loop/plugin.json",
        "chaos-loop/README.md",
        "chaos-loop/SRE-AGENT-IMPORT.md",
        "chaos-loop/scripts/chaos_loop_state.py",
        "chaos-loop/references/chaos-loop/shared-contract.md",
        "chaos-loop/schemas/chaos-loop/run-state.v1.schema.json",
        "chaos-loop/schemas/chaos-loop/workspace-plan.v1.schema.json",
        "chaos-loop/examples/chaos-loop/workspace-plan.json",
        "chaos-loop/skills/chaos-loop/SKILL.md",
        "chaos-loop/mcp/pyproject.toml",
        "chaos-loop/mcp/chaos_mcp/server.py"
    )
    foreach ($entryName in $requiredEntries) {
        if ($entries -notcontains $entryName) {
            throw "Archive is missing required entry: $entryName"
        }
    }

    $report = [ordered]@{
        name = $packageManifest.name
        version = $packageManifest.version
        archive = $archivePath
        sha256 = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
        fileCount = $entries.Count
        copilotValidated = -not $SkipCopilotValidation
        builtAt = [DateTime]::UtcNow.ToString("o")
    }
    [System.IO.File]::WriteAllText(
        $reportPath,
        ($report | ConvertTo-Json -Depth 5) + [Environment]::NewLine
    )
    $report | ConvertTo-Json -Depth 5
} finally {
    if (Test-Path -LiteralPath $stagingRoot) {
        Remove-Item -LiteralPath $stagingRoot -Recurse -Force
    }
}
