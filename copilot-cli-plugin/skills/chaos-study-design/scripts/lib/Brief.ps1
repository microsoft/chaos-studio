# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

<#
.SYNOPSIS
    The durable design brief: its store, its state machine, and its gates.

.DESCRIPTION
    A brief is what exists before a study does. Scoping needs a workspace and a
    scope hash; design happens earlier than that, while the question is still
    being argued about, so briefs live in their own directory beside the study
    store rather than pretending to be studies.

    The brief is also where the ordering rule is enforced. The whole point of
    this phase is that the system is read BEFORE the customer is questioned, so
    that the questions are about their actual dependency edges rather than about
    chaos engineering in the abstract. That ordering is not advice here; it is a
    state machine, and skipping a state is a blocking failure.

        DRAFT -> ANALYZED -> CANDIDATES -> INTERVIEWING
              -> RECOMMENDED -> CONFIRMED

    Requires Common.ps1 and Study.ps1 to be dot-sourced first.
#>

Set-StrictMode -Version Latest

$ChaosBriefVersion = 'study-brief.v1'
$ChaosBriefFileName = 'study-brief.v1.json'

# Newest-first, like the study artifact table: an older brief must still open
# for reading even after this list grows.
$ChaosBriefLegacyFileNames = @()

$ChaosBriefStates = @('DRAFT', 'ANALYZED', 'CANDIDATES', 'INTERVIEWING', 'RECOMMENDED', 'CONFIRMED')

function Set-ChaosValue {
    <#
    .SYNOPSIS
        Write one field on a record, whichever shape it currently has.

    .DESCRIPTION
        A brief is an ordered dictionary while it is being built and a
        PSCustomObject once it has been through the JSON store, and the two
        shapes disagree about assignment: dot-assignment on a dictionary that
        has been through a pipeline cmdlet fails, and index-assignment on a
        PSCustomObject is not supported at all. Rather than let that difference
        decide whether a rank or a state is recorded, every write in the design
        skill goes through here.
    #>
    param(
        [Parameter(Mandatory)][object]$InputObject,
        [Parameter(Mandatory)][string]$Name,
        [AllowNull()][object]$Value
    )

    if ($InputObject -is [System.Collections.IDictionary]) { $InputObject[$Name] = $Value; return }

    $target = $InputObject
    if ($target -is [System.Management.Automation.PSObject]) { $target = $target.PSObject.BaseObject }
    if ($target -is [System.Collections.IDictionary]) { $target[$Name] = $Value; return }

    if ($null -ne $InputObject.PSObject.Properties[$Name]) { $InputObject.PSObject.Properties[$Name].Value = $Value }
    else { $InputObject | Add-Member -NotePropertyName $Name -NotePropertyValue $Value -Force }
}

function Get-ChaosBriefRoot {
    <#
    .SYNOPSIS
        Where briefs live: <studyRoot>/briefs. Sibling of the scope-hash
        directories, never inside one, because a brief predates the workspace
        that would give it a scope hash.
    #>
    param([string]$StudyRoot)
    if (-not $StudyRoot) { $StudyRoot = (Get-ChaosStudyRoot).path }
    return (Join-Path $StudyRoot 'briefs')
}

function New-ChaosBriefId {
    param([datetime]$Instant = [datetime]::UtcNow)
    $stamp = $Instant.ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
    return "$stamp-$([guid]::NewGuid().ToString('N').Substring(0, 8))"
}

function Get-ChaosBriefPath {
    param(
        [Parameter(Mandatory)][string]$BriefId,
        [string]$StudyRoot
    )
    return (Join-Path (Get-ChaosBriefRoot -StudyRoot $StudyRoot) $BriefId)
}

function Get-ChaosBriefFile {
    <#
    .SYNOPSIS
        Resolve the newest existing brief file in a brief directory, for
        reading. Mirrors Get-ChaosArtifactReader so a brief written by an older
        generation still opens.
    #>
    param([Parameter(Mandatory)][string]$BriefPath)
    foreach ($name in (@($ChaosBriefFileName) + @($ChaosBriefLegacyFileNames))) {
        $candidate = Join-Path $BriefPath $name
        if (Test-Path -LiteralPath $candidate) {
            return [pscustomobject]@{ path = $candidate; fileName = $name; found = $true }
        }
    }
    return [pscustomobject]@{ path = (Join-Path $BriefPath $ChaosBriefFileName); fileName = $ChaosBriefFileName; found = $false }
}

function New-ChaosBrief {
    <#
    .SYNOPSIS
        Start a brief. Records only what the caller actually stated; every
        analytical section starts empty rather than optimistic.
    #>
    param(
        [Parameter(Mandatory)][string]$System,
        [string]$StudyRoot,
        [string]$BriefId
    )
    if (-not $BriefId) { $BriefId = New-ChaosBriefId }
    $dir = Get-ChaosBriefPath -BriefId $BriefId -StudyRoot $StudyRoot
    New-Item -ItemType Directory -Path $dir -Force | Out-Null

    $now = Get-ChaosUtcNow
    return [ordered]@{
        briefVersion   = $ChaosBriefVersion
        briefId        = $BriefId
        system         = $System
        state          = 'DRAFT'
        createdAt      = $now
        updatedAt      = $now
        analysis       = $null
        candidates     = @()
        interview      = $null
        recommendation = $null
        confirmation   = $null
        handoff        = $null
        limitations    = @()
        briefHash      = $null
    }
}

function Save-ChaosBrief {
    <#
    .SYNOPSIS
        Write a brief, refusing to modify one that is already CONFIRMED.

    .DESCRIPTION
        A confirmed brief is the record of what a human agreed to. Editing it
        after the fact would make the confirmation phrase refer to something the
        customer never saw, so this is the single write path and the immutability
        rule lives here rather than in each caller.
    #>
    param(
        [Parameter(Mandatory)][object]$Brief,
        [string]$StudyRoot,
        [switch]$AllowConfirmed
    )
    $dir = Get-ChaosBriefPath -BriefId ([string]$Brief.briefId) -StudyRoot $StudyRoot
    $existing = Get-ChaosBriefFile -BriefPath $dir
    if ($existing.found -and -not $AllowConfirmed) {
        $onDisk = Read-ChaosJsonFile -Path $existing.path
        if ($onDisk -and ([string](Get-ChaosMember -InputObject $onDisk -Name 'state')) -eq 'CONFIRMED') {
            throw "BriefAlreadyConfirmed: brief $($Brief.briefId) was confirmed and is immutable. Start a new brief rather than editing an agreed one."
        }
    }
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
    $Brief.updatedAt = Get-ChaosUtcNow
    # Hash everything except the hash field itself, so the value is stable and
    # the confirmation phrase can be bound to it.
    $Brief.briefHash = $null
    $Brief.briefHash = Get-ChaosDigest -InputObject $Brief
    Write-ChaosJsonFile -Path (Join-Path $dir $ChaosBriefFileName) -InputObject $Brief | Out-Null
    return $Brief
}

function Get-ChaosBriefFilePath {
    <#
    .SYNOPSIS
        The file a brief was written to.

    .DESCRIPTION
        Save-ChaosBrief returns the brief itself, so callers that want to tell the
        operator where it landed need this rather than the save result. Printing
        the object instead would put the whole brief - including its hash and
        every nested record - into an operator-facing card.
    #>
    param(
        [Parameter(Mandatory)][object]$Brief,
        [string]$StudyRoot
    )
    $dir = Get-ChaosBriefPath -BriefId ([string]$Brief.briefId) -StudyRoot $StudyRoot
    return (Join-Path $dir $ChaosBriefFileName)
}

function Get-ChaosBrief {
    <#
    .SYNOPSIS
        Read a brief by id. Returns $null when it does not exist; callers turn
        that into a specific failure rather than an empty object.
    #>
    param(
        [Parameter(Mandatory)][string]$BriefId,
        [string]$StudyRoot
    )
    $dir = Get-ChaosBriefPath -BriefId $BriefId -StudyRoot $StudyRoot
    $file = Get-ChaosBriefFile -BriefPath $dir
    if (-not $file.found) { return $null }
    return Read-ChaosJsonFile -Path $file.path
}

function Get-ChaosBriefIndex {
    <#
    .SYNOPSIS
        Every brief under the root, newest first. Ids sort chronologically as
        text, so no date parsing is needed to order them.
    #>
    param([string]$StudyRoot)
    $root = Get-ChaosBriefRoot -StudyRoot $StudyRoot
    if (-not (Test-Path -LiteralPath $root)) { return @() }
    $entries = @()
    foreach ($dir in (Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue)) {
        $file = Get-ChaosBriefFile -BriefPath $dir.FullName
        if (-not $file.found) { continue }
        $brief = Read-ChaosJsonFile -Path $file.path
        if (-not $brief) { continue }
        $entries += [pscustomobject]@{
            briefId   = [string](Get-ChaosMember -InputObject $brief -Name 'briefId')
            system    = [string](Get-ChaosMember -InputObject $brief -Name 'system')
            state     = [string](Get-ChaosMember -InputObject $brief -Name 'state')
            updatedAt = [string](Get-ChaosMember -InputObject $brief -Name 'updatedAt')
            path      = $dir.FullName
        }
    }
    return @($entries | Sort-Object -Property briefId -Descending)
}

# -- The ordering gate -------------------------------------

function Get-ChaosBriefStateRank {
    param([Parameter(Mandatory)][AllowEmptyString()][string]$State)
    $rank = [array]::IndexOf($ChaosBriefStates, $State)
    if ($rank -lt 0) { return -1 }
    return $rank
}

function Assert-ChaosBriefState {
    <#
    .SYNOPSIS
        Refuse an action whose prerequisite state has not been reached.

    .DESCRIPTION
        This is the enforcement point for "analysis precedes interview". It
        throws a DesignIncomplete-tagged error naming the exact step that is
        missing, so the caller maps it to exit 24 and the operator is told which
        command to run rather than being told "no".
    #>
    param(
        [Parameter(Mandatory)][object]$Brief,
        [Parameter(Mandatory)][string]$Required,
        [Parameter(Mandatory)][string]$Action,
        [Parameter(Mandatory)][string]$Remediation
    )
    $current = [string](Get-ChaosMember -InputObject $Brief -Name 'state')
    if ((Get-ChaosBriefStateRank -State $current) -lt (Get-ChaosBriefStateRank -State $Required)) {
        throw "DesignIncomplete: cannot $Action while the brief is $current; it must be at least $Required first. $Remediation"
    }
    return $true
}

function Set-ChaosBriefState {
    <#
    .SYNOPSIS
        Advance the brief. Never moves backwards: a brief that has already been
        recommended does not become un-recommended because a later step re-ran.
    #>
    param(
        [Parameter(Mandatory)][object]$Brief,
        [Parameter(Mandatory)][string]$State
    )
    if ((Get-ChaosBriefStateRank -State $State) -lt 0) { throw "Unknown brief state '$State'." }
    $current = [string](Get-ChaosMember -InputObject $Brief -Name 'state')
    if ((Get-ChaosBriefStateRank -State $State) -gt (Get-ChaosBriefStateRank -State $current)) {
        $Brief.state = $State
    }
    return $Brief
}

function Add-ChaosBriefLimitation {
    <#
    .SYNOPSIS
        Record a limitation code once. Limitations accumulate; they are never
        cleared by a later step, because the condition they describe happened.
    #>
    param(
        [Parameter(Mandatory)][object]$Brief,
        [Parameter(Mandatory)][string]$Code
    )
    $existing = @(Get-ChaosItems -InputObject (Get-ChaosMember -InputObject $Brief -Name 'limitations'))
    if ($existing -notcontains $Code) { $existing += $Code }
    $Brief.limitations = @($existing | Sort-Object)
    return $Brief
}
