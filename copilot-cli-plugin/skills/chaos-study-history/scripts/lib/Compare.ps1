#Requires -Version 7.0
<#
.SYNOPSIS
    Compare two sealed studies. Pure logic, no side effects.

.DESCRIPTION
    Comparison is only meaningful between studies that asked the same question of
    the same thing. Two runs that used different faults, different targets or a
    different steady-state definition produce numbers that look comparable and
    are not - which is worse than refusing to compare them.

    So comparability is checked first and explicitly. If the studies do not
    match on identity, this returns a refusal with the reasons, and the caller
    exits rather than printing a misleading delta.

    Findings are matched on findingKey, never on title. Titles are prose and
    change; the key is derived from fault, signal and predicate and does not.
#>

Set-StrictMode -Version Latest

function Get-ChaosWindowTolerance {
    <#
    .SYNOPSIS
        Two windows are the same length if they are within 20% of each other.
        Chaos runs never land on exact durations; demanding equality would make
        almost nothing comparable.
    #>
    param(
        [Parameter(Mandatory)][AllowNull()][object]$Left,
        [Parameter(Mandatory)][AllowNull()][object]$Right
    )
    if ($null -eq $Left -or $null -eq $Right) { return $false }
    $a = [double]$Left
    $b = [double]$Right
    if ($a -le 0 -or $b -le 0) { return $a -eq $b }
    $ratio = [Math]::Abs($a - $b) / [Math]::Max($a, $b)
    return $ratio -le 0.20
}

function ConvertTo-ChaosNormalisedPredicate {
    <#
    .SYNOPSIS
        Collapse whitespace and case so 'successRate>=99.5' and
        'successRate >= 99.5' are recognised as the same objective.
    #>
    param([AllowNull()][string]$Raw)
    if (-not $Raw) { return '' }
    return ([regex]::Replace($Raw, '\s+', '')).ToLowerInvariant()
}

function Get-ChaosStudyIdentityFacts {
    <#
    .SYNOPSIS
        The subset of a sealed manifest that decides comparability.
    #>
    param([Parameter(Mandatory)][object]$Study)

    $identity = $Study.identity
    return [pscustomobject]@{
        studyId     = [string]$Study.studyId
        scopeHash   = [string]$Study.scopeHash
        workspace   = [string]$identity.workspace
        workspaceId = [string]$identity.workspaceId
        scenario    = [string]$identity.scenario
        actionUrn   = [string]$identity.actionUrn
        scopeCount  = $identity.scopeCount
        predicate   = ConvertTo-ChaosNormalisedPredicate -Raw ([string]$identity.predicate)
        windows     = $identity.windows
        verdict     = [string]$Study.summary.verdict
    }
}


function Get-ChaosStudyVerdicts {
    <#
    .SYNOPSIS
        The predicate and study verdicts for one sealed study, tolerating v1.

    .DESCRIPTION
        A findings.v1 study recorded a single `verdict` that conflated "what
        happened to the predicate" with "how bad was this study". There is no
        honest way to split it after the fact, so the predicate verdict is
        reported as unknown rather than guessed. The contract version travels
        with the pair so a caller can refuse the comparison outright.
    #>
    param([Parameter(Mandatory)][object]$Study)

    $summary = $Study.summary
    $names = @($summary.PSObject.Properties | ForEach-Object { $_.Name })
    $version = if ($names -contains 'findingsVersion' -and $summary.findingsVersion) { [string]$summary.findingsVersion } else { 'findings.v1' }
    $study = if ($names -contains 'studyVerdict' -and $summary.studyVerdict) { [string]$summary.studyVerdict } else { [string]$summary.verdict }
    $predicate = if ($names -contains 'predicateVerdict' -and $summary.predicateVerdict) { [string]$summary.predicateVerdict } else { $null }

    return [pscustomobject]@{
        findingsVersion  = $version
        predicateVerdict = $predicate
        studyVerdict     = $study
    }
}

function Test-ChaosStudyComparability {
    <#
    .SYNOPSIS
        Can these two studies be compared at all?

    .OUTPUTS
        An object with `comparable` and the list of `reasons` it is not.
    #>
    param(
        [Parameter(Mandatory)][object]$Baseline,
        [Parameter(Mandatory)][object]$Candidate
    )

    $a = Get-ChaosStudyIdentityFacts -Study $Baseline
    $b = Get-ChaosStudyIdentityFacts -Study $Candidate
    $reasons = @()

    if ($a.scopeHash -ne $b.scopeHash) { $reasons += "Different scope: $($a.scopeHash) vs $($b.scopeHash)." }
    if ($a.workspaceId -ne $b.workspaceId) { $reasons += "Different workspace: $($a.workspace) vs $($b.workspace)." }
    if ($a.actionUrn -ne $b.actionUrn) { $reasons += "Different action: $($a.actionUrn) vs $($b.actionUrn)." }
    if ($a.scenario -ne $b.scenario) { $reasons += "Different scenario: $($a.scenario) vs $($b.scenario). The same action driven by a different scenario is a different study." }
    if ($a.scopeCount -ne $b.scopeCount) { $reasons += "Different number of scoped resources: $($a.scopeCount) vs $($b.scopeCount). A wider or narrower blast radius is a different study." }
    if ($a.predicate -ne $b.predicate) { $reasons += "Different steady-state objective: '$($Baseline.identity.predicate)' vs '$($Candidate.identity.predicate)'." }

    foreach ($window in @('baselineMinutes', 'injectMinutes', 'recoveryMinutes')) {
        $left = if ($a.windows -and $a.windows.PSObject.Properties.Name -contains $window) { $a.windows.$window } else { $null }
        $right = if ($b.windows -and $b.windows.PSObject.Properties.Name -contains $window) { $b.windows.$window } else { $null }
        if (-not (Get-ChaosWindowTolerance -Left $left -Right $right)) {
            $reasons += "Different $window window: $left vs $right (outside the 20% tolerance)."
        }
    }

    # Contract versions must match. A findings.v1 study has one conflated
    # verdict and no finding kinds; comparing it against a v2 study would put a
    # study verdict beside a predicate verdict and call the difference a
    # regression. Refusing is the only honest option.
    $va = Get-ChaosStudyVerdicts -Study $Baseline
    $vb = Get-ChaosStudyVerdicts -Study $Candidate
    if ($va.findingsVersion -ne $vb.findingsVersion) {
        $reasons += "Different findings contract version: $($va.findingsVersion) vs $($vb.findingsVersion). These studies record different things and cannot be diffed."
    }

    return [pscustomobject]@{
        comparable = ($reasons.Count -eq 0)
        reasons    = @($reasons)
    }
}

function Compare-Study {
    <#
    .SYNOPSIS
        Diff two sealed studies. Pure: same inputs, same output, always.

    .PARAMETER Baseline
        The earlier study index entry, with its findings attached as `findings`.

    .PARAMETER Candidate
        The later study index entry, with its findings attached as `findings`.
    #>
    param(
        [Parameter(Mandatory)][object]$Baseline,
        [Parameter(Mandatory)][object]$Candidate
    )

    $comparability = Test-ChaosStudyComparability -Baseline $Baseline -Candidate $Candidate

    $baseFindings = @($Baseline.findings)
    $candFindings = @($Candidate.findings)
    $baseKeys = @($baseFindings | ForEach-Object { [string]$_.findingKey })
    $candKeys = @($candFindings | ForEach-Object { [string]$_.findingKey })

    $resolved = @($baseFindings | Where-Object { $candKeys -notcontains [string]$_.findingKey })
    $introduced = @($candFindings | Where-Object { $baseKeys -notcontains [string]$_.findingKey })

    $persisted = @(
        foreach ($finding in $candFindings) {
            $match = $baseFindings | Where-Object { [string]$_.findingKey -eq [string]$finding.findingKey } | Select-Object -First 1
            if (-not $match) { continue }
            $order = @{ critical = 0; high = 1; medium = 2; low = 3 }
            $movement = if ($order[[string]$finding.severity] -lt $order[[string]$match.severity]) { 'worse' }
                        elseif ($order[[string]$finding.severity] -gt $order[[string]$match.severity]) { 'better' }
                        else { 'unchanged' }
            [ordered]@{
                findingKey   = [string]$finding.findingKey
                title        = [string]$finding.title
                wasSeverity  = [string]$match.severity
                nowSeverity  = [string]$finding.severity
                movement     = $movement
            }
        }
    )

    $baseVerdicts = Get-ChaosStudyVerdicts -Study $Baseline
    $candVerdicts = Get-ChaosStudyVerdicts -Study $Candidate
    $verdictChanged = ($baseVerdicts.studyVerdict -ne $candVerdicts.studyVerdict)
    $predicateVerdictChanged = ($baseVerdicts.predicateVerdict -ne $candVerdicts.predicateVerdict)
    $direction = if (-not $comparability.comparable) { 'unknown' }
                 elseif ($introduced.Count -gt 0) { 'regressed' }
                 elseif ($resolved.Count -gt 0 -and $introduced.Count -eq 0) { 'improved' }
                 elseif (@($persisted | Where-Object { $_.movement -eq 'worse' }).Count -gt 0) { 'regressed' }
                 elseif (@($persisted | Where-Object { $_.movement -eq 'better' }).Count -gt 0) { 'improved' }
                 else { 'stable' }

    return [ordered]@{
        comparisonVersion       = 'study-comparison.v2'
        comparable              = $comparability.comparable
        reasons                 = @($comparability.reasons)
        baseline                = [ordered]@{
            studyId          = [string]$Baseline.studyId
            sealedAt         = [string]$Baseline.sealedAt
            findingsVersion  = $baseVerdicts.findingsVersion
            predicateVerdict = $baseVerdicts.predicateVerdict
            studyVerdict     = $baseVerdicts.studyVerdict
            verdict          = $baseVerdicts.studyVerdict
        }
        candidate               = [ordered]@{
            studyId          = [string]$Candidate.studyId
            sealedAt         = [string]$Candidate.sealedAt
            findingsVersion  = $candVerdicts.findingsVersion
            predicateVerdict = $candVerdicts.predicateVerdict
            studyVerdict     = $candVerdicts.studyVerdict
            verdict          = $candVerdicts.studyVerdict
        }
        verdictChanged          = $verdictChanged
        predicateVerdictChanged = $predicateVerdictChanged
        direction               = $direction
        resolved                = @($resolved | ForEach-Object { [ordered]@{ findingKey = [string]$_.findingKey; title = [string]$_.title; severity = [string]$_.severity } })
        introduced              = @($introduced | ForEach-Object { [ordered]@{ findingKey = [string]$_.findingKey; title = [string]$_.title; severity = [string]$_.severity } })
        persisted               = @($persisted)
    }
}
