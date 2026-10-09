#Requires -Version 7.0
<#
.SYNOPSIS
    Which revision of this suite is actually running.

.DESCRIPTION
    Two defects in this suite were reported, fixed, and then reported again.
    Each time the same question could not be answered: was the reporter running
    the fixed code, or a stale copy of a published package? Without an answer,
    the only options were to doubt the report or to doubt the fix, and both are
    guesses.

    This file removes the guess. It fingerprints the files that are on disk
    underneath the six skill directories - the ones that were actually loaded -
    and reduces them to a single content hash. Two installs agree if and only if
    their bytes agree. A bug report carrying that hash is a bug report against a
    known revision.

    The hash deliberately covers every file in each skill directory, not just
    the scripts. SKILL.md is the instruction surface that an agent obeys, and a
    stale SKILL.md drifts behaviour just as surely as stale code does.

    Nothing here calls Azure, and nothing here can fail a study: provenance that
    cannot be gathered is reported as unknown rather than thrown, because losing
    a report over a diagnostic would be absurd.
#>

Set-StrictMode -Version Latest

# Bumped only when the cross-skill contract changes - the shape callers bind to.
# It is NOT a build number. The content hash is what distinguishes two installs;
# this string only says which contract those bytes claim to implement.
$ChaosStudySuiteVersion = 'chaos-study-suite.v1'

function Get-ChaosSuiteVersion { return $ChaosStudySuiteVersion }

function Get-ChaosSuiteSkillDirectory {
    <#
    .SYNOPSIS
        The directory holding the suite's skill folders.

    .DESCRIPTION
        Resolved from this file rather than from the caller, so it is correct in
        the full plugin layout and in the published skills-only package alike.
    #>
    return [System.IO.Path]::GetFullPath((Join-Path (Get-ChaosStudySkillRoot) '..'))
}

function Get-ChaosSuiteProvenance {
    <#
    .SYNOPSIS
        Fingerprint the installed suite.

    .PARAMETER IncludeFiles
        Also return the per-file hash map. Off by default because the summary is
        what belongs in a report; the file list is for someone diffing two
        installs to find which file actually differs.

    .OUTPUTS
        An object whose contentHash is null when the suite could not be read.
        Null means "not determined", never "unchanged" - a provenance record
        that invents a hash is worse than one that admits it has none.
    #>
    param([switch]$IncludeFiles)

    $observedAt = try { Get-ChaosUtcNow } catch { $null }
    $skillsDir = $null
    $skillRoot = $null
    try {
        $skillRoot = Get-ChaosStudySkillRoot
        $skillsDir = Get-ChaosSuiteSkillDirectory
    } catch {
        # Roots are set at load time; if they are missing something is very
        # wrong, but a diagnostic must still return a shape callers can read.
    }

    $unknown = [pscustomobject]@{
        suiteVersion   = $ChaosStudySuiteVersion
        contentHash    = $null
        fileCount      = 0
        skills         = @()
        skillRoot      = $skillRoot
        skillsDirectory = $skillsDir
        packaging      = 'unknown'
        siblingSkills  = $null
        sharedScripts  = $null
        rendererSource = $null
        psVersion      = $PSVersionTable.PSVersion.ToString()
        observedAt     = $observedAt
        reason         = 'suite directory could not be resolved'
        files          = $null
    }

    if (-not $skillsDir -or -not (Test-Path -LiteralPath $skillsDir)) { return $unknown }

    $allDirs = @(Get-ChildItem -LiteralPath $skillsDir -Directory -ErrorAction SilentlyContinue)
    # 'chaos-study*' matches exactly the six suite directories and nothing else
    # in the plugin - chaos-impact, run-scenario and friends are deliberately not
    # part of this suite and must not move its hash.
    $suiteDirs = @($allDirs | Where-Object { $_.Name -like 'chaos-study*' } | Sort-Object -Property Name)
    if ($suiteDirs.Count -eq 0) {
        $unknown.reason = "no chaos-study* directories under '$skillsDir'"
        return $unknown
    }

    $hashes = [ordered]@{}
    $perSkill = @()
    foreach ($dir in $suiteDirs) {
        $skillHashes = [ordered]@{}
        $files = @(Get-ChildItem -LiteralPath $dir.FullName -Recurse -File -ErrorAction SilentlyContinue |
            Sort-Object -Property FullName)
        foreach ($file in $files) {
            $relative = $file.FullName.Substring($dir.FullName.Length).TrimStart('\', '/').Replace('\', '/')
            $key = "$($dir.Name)/$relative"
            $hash = $null
            try { $hash = Get-ChaosSha256 -Path $file.FullName } catch { $hash = $null }
            $hashes[$key] = $hash
            $skillHashes[$relative] = $hash
        }
        $skillHash = $null
        if ($skillHashes.Count -gt 0) {
            try {
                $skillHash = Get-ChaosSha256 -Text (ConvertTo-ChaosCanonicalJson -InputObject $skillHashes)
            } catch { $skillHash = $null }
        }
        $perSkill += [pscustomobject]@{
            skill       = $dir.Name
            fileCount   = $files.Count
            contentHash = $skillHash
        }
    }

    # An unreadable file poisons the whole hash rather than being skipped. A
    # fingerprint that silently omits what it could not read would let two
    # different installs agree.
    $contentHash = $null
    if (@($hashes.Values | Where-Object { $null -eq $_ }).Count -eq 0) {
        try {
            $contentHash = Get-ChaosSha256 -Text (ConvertTo-ChaosCanonicalJson -InputObject $hashes)
        } catch { $contentHash = $null }
    }

    $siblings = @($allDirs | Where-Object { $_.Name -notlike 'chaos-study*' })
    # The published package ships the six alone; the full plugin ships them
    # beside its other skills. Worth knowing, because a defect that reproduces in
    # one layout and not the other is a packaging defect, not a code defect.
    $packaging = if ($siblings.Count -gt 0) { 'plugin' } else { 'skills-only' }

    $rendererSource = $null
    $writeCard = Get-Command -Name 'Write-Card' -ErrorAction SilentlyContinue
    if ($writeCard -and $writeCard.ScriptBlock -and $writeCard.ScriptBlock.File) {
        $rendererSource = $writeCard.ScriptBlock.File
    }

    $shared = $null
    try { $shared = Get-ChaosSharedScriptStatus } catch { $shared = $null }

    return [pscustomobject]@{
        suiteVersion    = $ChaosStudySuiteVersion
        contentHash     = $contentHash
        fileCount       = $hashes.Count
        skills          = $perSkill
        skillRoot       = $skillRoot
        skillsDirectory = $skillsDir
        packaging       = $packaging
        siblingSkills   = @($siblings | ForEach-Object { $_.Name } | Sort-Object)
        sharedScripts   = $shared
        rendererSource  = $rendererSource
        psVersion       = $PSVersionTable.PSVersion.ToString()
        observedAt      = $observedAt
        reason          = $(if ($contentHash) { $null } else { 'one or more suite files could not be hashed' })
        files           = $(if ($IncludeFiles) { $hashes } else { $null })
    }
}

function Get-ChaosSuiteRevisionLine {
    <#
    .SYNOPSIS
        One line identifying this install, for reports and bug reports.

    .DESCRIPTION
        Short-form hash because it is read by humans comparing two installs, and
        twelve hex characters already make an accidental collision fanciful. The
        full hash stays available on the provenance object.
    #>
    param([object]$Provenance)

    if (-not $Provenance) { $Provenance = Get-ChaosSuiteProvenance }
    $short = if ($Provenance.contentHash) {
        $Provenance.contentHash.Substring(0, [Math]::Min(12, $Provenance.contentHash.Length))
    } else {
        'unknown'
    }
    return "$($Provenance.suiteVersion) content=$short files=$($Provenance.fileCount) packaging=$($Provenance.packaging)"
}
