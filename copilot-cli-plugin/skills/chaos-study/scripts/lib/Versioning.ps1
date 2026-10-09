# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

<#
.SYNOPSIS
    Artifact version constants and back-compatible reading for the study store.

.DESCRIPTION
    The contract revision grows the plan, run-record, findings and manifest
    schemas. Growing a schema in place would silently reinterpret every study
    written under the old shape, so each artifact is versioned by filename
    (study-plan.v3.json, run-record.v3.json, findings.v2.json) and, for the
    manifest, by an in-content manifestVersion field.

    This file owns two things and nothing else:

      1. The single table of current-vs-legacy artifact filenames.
      2. Read-only back-compatibility: an older study opens for reading no
         matter which generation wrote it, but an attempt to WRITE a
         new-generation artifact into a study that was frozen at an older
         generation fails loudly with StudyIncompatibleVersion rather than
         silently reinterpreting it.

    Requires Common.ps1 to be dot-sourced first (for the exit-code contract).
#>

Set-StrictMode -Version Latest

if (-not (Get-Command Get-ChaosStudyExitCode -ErrorAction SilentlyContinue)) {
    . (Join-Path $PSScriptRoot 'Common.ps1')
}

# -- Artifact filename table ------------------------------
# For each logical artifact the CURRENT generation writes exactly one
# filename; the LEGACY list is every older filename that must still open for
# reading. Order in the legacy list is newest-first so the reader prefers the
# newest shape actually present on disk.
$ChaosArtifactVersions = [ordered]@{
    plan      = [ordered]@{ current = 'study-plan.v3.json'; legacy = @('study-plan.v2.json', 'study-plan.v1.json') }
    runRecord = [ordered]@{ current = 'run-record.v3.json'; legacy = @('run-record.v2.json', 'run-record.v1.json') }
    findings  = [ordered]@{ current = 'findings.v2.json'; legacy = @('findings.v1.json') }
}

# The manifest keeps a stable filename and versions itself in-content so the
# crash-safe seal ordering (hash all files except manifest.json and SEALED)
# and the hash-exclusion rule stay intact across generations.
$ChaosManifestFileName = 'manifest.json'
$ChaosCurrentManifestVersion = 2

function Get-ChaosArtifactFileName {
    <#
    .SYNOPSIS
        The current-generation filename for a logical artifact.
    #>
    param([Parameter(Mandatory)][ValidateSet('plan', 'runRecord', 'findings')][string]$Artifact)
    return $ChaosArtifactVersions[$Artifact].current
}

function Get-ChaosArtifactReader {
    <#
    .SYNOPSIS
        Resolve the newest existing version of an artifact in a study, for
        reading. Always opens whatever is present, regardless of generation.

    .DESCRIPTION
        Returns a descriptor { artifact, path, fileName, version, found }.
        When no version of the artifact exists on disk, the descriptor points
        at the current-generation path with found = $false, so a caller can
        report "not written yet" without guessing the filename.
    #>
    param(
        [Parameter(Mandatory)][string]$StudyPath,
        [Parameter(Mandatory)][ValidateSet('plan', 'runRecord', 'findings')][string]$Artifact
    )
    $entry = $ChaosArtifactVersions[$Artifact]
    $ordered = @($entry.current) + @($entry.legacy)
    foreach ($name in $ordered) {
        $candidate = Join-Path $StudyPath $name
        if (Test-Path -LiteralPath $candidate) {
            return [pscustomobject]@{
                artifact = $Artifact
                path     = $candidate
                fileName = $name
                version  = Get-ChaosArtifactVersionNumber -FileName $name
                found    = $true
            }
        }
    }
    return [pscustomobject]@{
        artifact = $Artifact
        path     = Join-Path $StudyPath $entry.current
        fileName = $entry.current
        version  = Get-ChaosArtifactVersionNumber -FileName $entry.current
        found    = $false
    }
}

function Get-ChaosArtifactVersionNumber {
    <#
    .SYNOPSIS
        Extract the integer version from a versioned artifact filename.
        study-plan.v3.json -> 3. Unversioned names return $null.
    #>
    param([Parameter(Mandatory)][string]$FileName)
    if ($FileName -match '\.v(\d+)\.json$') { return [int]$Matches[1] }
    return $null
}

function Test-ChaosStudyGeneration {
    <#
    .SYNOPSIS
        Classify a study by the generation of artifacts it holds.

    .DESCRIPTION
        Returns one of:
          empty    - no plan/run/findings artifacts yet (writable at current gen)
          current  - the newest artifact present is the current generation
          legacy   - the newest artifact present predates the current generation
        A study opened for reading never cares which of these it is; a study
        opened for WRITING a current-generation artifact must be 'current' or
        'empty', or the write would reinterpret an older study.
    #>
    param([Parameter(Mandatory)][string]$StudyPath)

    $sawAny = $false
    $sawLegacy = $false
    foreach ($artifact in @('plan', 'runRecord', 'findings')) {
        $entry = $ChaosArtifactVersions[$artifact]
        if (Test-Path -LiteralPath (Join-Path $StudyPath $entry.current)) {
            $sawAny = $true
            continue
        }
        foreach ($name in $entry.legacy) {
            if (Test-Path -LiteralPath (Join-Path $StudyPath $name)) {
                $sawAny = $true
                $sawLegacy = $true
                break
            }
        }
    }

    if (-not $sawAny) { return 'empty' }
    if ($sawLegacy) { return 'legacy' }
    return 'current'
}

function Assert-ChaosStudyWriteCompatible {
    <#
    .SYNOPSIS
        Guard a current-generation write. Throws StudyIncompatibleVersion when
        the target study was frozen at an older artifact generation.

    .DESCRIPTION
        Reading is always allowed; only writing a new-generation artifact into
        an old-generation study is refused, because doing so would blend two
        incompatible shapes in one directory. The error is tagged so a caller
        can map it to exit code 23 (StudyIncompatibleVersion). It never
        silently reinterprets.
    #>
    param([Parameter(Mandatory)][string]$StudyPath)
    $generation = Test-ChaosStudyGeneration -StudyPath $StudyPath
    if ($generation -eq 'legacy') {
        throw "StudyIncompatibleVersion: study at '$StudyPath' was written with an older artifact generation and is read-only. Start a new study rather than mixing artifact versions."
    }
    return $true
}
