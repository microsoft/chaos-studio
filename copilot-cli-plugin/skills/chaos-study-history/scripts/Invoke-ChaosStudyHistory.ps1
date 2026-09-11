#Requires -Version 7.0
<#
.SYNOPSIS
    List, inspect, compare and rerun past studies.

.DESCRIPTION
    A single chaos study is an anecdote. The value comes from the series - the
    same question asked of the same workspace scope over time, so a change in
    the answer means something changed in the system.

    This skill never mutates a sealed study. `-Action rerun` prints the plan
    needed to repeat one; it does not inject anything itself, because rerunning
    is an execution decision and execution requires consent from the run skill.

.EXAMPLE
    ./Invoke-ChaosStudyHistory.ps1
    Lists every sealed study, newest first.

.EXAMPLE
    ./Invoke-ChaosStudyHistory.ps1 -Action compare -StudyId latest -Against previous
    Diffs the two most recent studies of the same scope.
#>

[CmdletBinding()]
param(
    [ValidateSet('list', 'show', 'compare', 'rerun')]
    [string]$Action = 'list',
    [string]$StudyId = 'latest',
    [string]$Against = 'previous',
    [string]$ScopeHash,
    [string]$StudyRoot,
    [switch]$Json
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$sharedLib = Join-Path $PSScriptRoot '..' '..' 'chaos-study' 'scripts' 'lib'
. (Join-Path $sharedLib 'Common.ps1')
. (Join-Path $sharedLib 'Study.ps1')
. (Join-Path $PSScriptRoot 'lib' 'Compare.ps1')

$indexArgs = @{}
if ($StudyRoot) { $indexArgs['StudyRoot'] = $StudyRoot }
$index = @(Get-ChaosStudyIndex @indexArgs -Rebuild)

if ($ScopeHash) { $index = @($index | Where-Object { $_.scopeHash -eq $ScopeHash }) }

function Get-StudyFindings {
    param([Parameter(Mandatory)][object]$Entry)
    $path = (Get-ChaosArtifactReader -StudyPath $Entry.path -Artifact 'findings').path
    $findings = Read-ChaosJsonFile -Path $path
    if (-not $findings) { return ,@() }
    # A study with no findings round-trips as $null through @(); filter it out so
    # callers always get a clean array rather than an array containing nothing.
    return ,@(@($findings.findings) | Where-Object { $null -ne $_ })
}

function Resolve-Entry {
    <#
    .SYNOPSIS
        Resolve 'latest', 'previous' or an explicit id against the index.
    #>
    param([Parameter(Mandatory)][string]$Reference, [Parameter(Mandatory)][AllowEmptyCollection()][object[]]$Pool)
    $ordered = @($Pool | Sort-Object -Property studyId -Descending)
    switch ($Reference) {
        'latest'   { return ($ordered | Select-Object -First 1) }
        'previous' { return ($ordered | Select-Object -Skip 1 -First 1) }
        default    { return ($ordered | Where-Object { $_.studyId -eq $Reference } | Select-Object -First 1) }
    }
}

function Format-RerunLiteral {
    <#
    .SYNOPSIS
        Render a stored plan value as PowerShell source the operator can run.

    .DESCRIPTION
        A rerun command is only useful if it can be pasted, so nested values -
        the mechanism probe, scenario parameters, tag exclusions - have to come
        back out as literals rather than as "System.Collections.Hashtable".
        Strings are single-quoted with embedded quotes doubled; anything the
        renderer does not recognise returns $null so the caller can report it as
        unreproducible rather than emit a command that lies.
    #>
    param([AllowNull()][object]$Value)

    if ($null -eq $Value) { return '$null' }
    if ($Value -is [bool]) { return $(if ($Value) { '$true' } else { '$false' }) }
    if ($Value -is [string]) { return ("'" + ($Value -replace "'", "''") + "'") }
    if ($Value -is [int] -or $Value -is [long] -or $Value -is [double] -or $Value -is [decimal]) { return [string]$Value }

    if ($Value -is [array] -or ($Value -is [System.Collections.IList] -and $Value -isnot [string])) {
        $items = @()
        foreach ($item in $Value) {
            $inner = Format-RerunLiteral -Value $item
            if ($null -eq $inner) { return $null }
            $items += $inner
        }
        return ('@(' + ($items -join ', ') + ')')
    }

    if ($Value -is [System.Collections.IDictionary] -or $Value -is [pscustomobject]) {
        $names = @(Get-ChaosMemberName -InputObject $Value)
        if ($names.Count -eq 0) { return '@{}' }
        $parts = @()
        foreach ($name in $names) {
            $inner = Format-RerunLiteral -Value (Get-ChaosMember -InputObject $Value -Name $name)
            if ($null -eq $inner) { return $null }
            $parts += "$name = $inner"
        }
        return ('@{ ' + ($parts -join '; ') + ' }')
    }

    return $null
}

function Get-ChaosMemberName {
    <#
    .SYNOPSIS
        Property or key names of a stored record, whichever shape it came back as.
    #>
    param([AllowNull()][object]$InputObject)
    if ($null -eq $InputObject) { return @() }
    if ($InputObject -is [System.Collections.IDictionary]) { return @($InputObject.Keys | ForEach-Object { [string]$_ }) }
    return @($InputObject.PSObject.Properties | ForEach-Object { $_.Name })
}

if ($index.Count -eq 0) {
    Write-ChaosStudyPanel -Title 'No studies yet' -Status 'info' -Body @"
No studies were found under the study root. History becomes useful after the
first sealed study - run the chaos-study skill to create one.
"@
    exit (Get-ChaosStudyExitCode -Name 'Success')
}

switch ($Action) {

    'list' {
        $rows = foreach ($entry in ($index | Sort-Object -Property studyId -Descending)) {
            $verdicts = if ($entry.summary) { Get-ChaosStudyVerdicts -Study $entry } else { $null }
            [pscustomobject]@{
                Study     = $entry.studyId
                State     = $entry.state
                Workspace = $(if ($entry.identity) { [string]$entry.identity.workspace } else { '-' })
                Action    = $(if ($entry.identity) { [string]$entry.identity.action } else { '-' })
                Predicate = $(if ($verdicts -and $verdicts.predicateVerdict) { $verdicts.predicateVerdict } else { '-' })
                Verdict   = $(if ($verdicts) { $verdicts.studyVerdict } else { '-' })
                Findings  = $(if ($entry.summary) { $entry.summary.findingCount } else { '-' })
                Scope     = $entry.scopeHash
            }
        }
        # -InputObject: a single prior study must still emit a JSON list, so a
        # caller parsing this contract never has to special-case one result.
        if ($Json) { ConvertTo-Json -InputObject @($rows) -Depth 6; exit (Get-ChaosStudyExitCode -Name 'Success') }
        Write-ChaosStudyTable -Title "Studies ($($index.Count))" -Data @($rows)
        $scopes = @($index | Group-Object scopeHash)
        Write-ChaosStudyNote -Message "$($scopes.Count) distinct scope(s). Compare within a scope: -Action compare -ScopeHash <hash>."
        exit (Get-ChaosStudyExitCode -Name 'Success')
    }

    'show' {
        $entry = Resolve-Entry -Reference $StudyId -Pool $index
        if (-not $entry) {
            Write-ChaosStudyFailure -Title 'Study not found' -Message "No study matched '$StudyId'." -Remediation 'Run this skill with -Action list to see available studies.'
            exit (Get-ChaosStudyExitCode -Name 'Error')
        }
        $findings = Get-StudyFindings -Entry $entry
        if ($Json) {
            ConvertTo-Json -InputObject ([ordered]@{ study = $entry; findings = @($findings) }) -Depth 8
            exit (Get-ChaosStudyExitCode -Name 'Success')
        }
        # The URN is the precise identity, but a discovery-skipped study never
        # learned one. Show the name rather than an empty row.
        $shownAction = '-'
        if ($entry.identity) {
            $shownAction = if ([string]::IsNullOrWhiteSpace($entry.identity.actionUrn)) { [string]$entry.identity.action } else { [string]$entry.identity.actionUrn }
            if ([string]::IsNullOrWhiteSpace($shownAction)) { $shownAction = '-' }
        }
        $shownVerdicts = if ($entry.summary) { Get-ChaosStudyVerdicts -Study $entry } else { $null }
        Write-ChaosStudyPanel -Title "Study $($entry.studyId)" -Status 'info' -Body @"
$(if ($shownVerdicts) { $shownVerdicts.studyVerdict } else { 'Not yet reported.' })
"@ -Properties ([ordered]@{
            'State'             = $entry.state
            'Sealed'            = $entry.sealedAt
            'Workspace'         = $(if ($entry.identity) { [string]$entry.identity.workspace } else { '-' })
            'Scenario'          = $(if ($entry.identity) { [string]$entry.identity.scenario } else { '-' })
            'Action'            = $shownAction
            'Predicate'         = $(if ($entry.identity) { [string]$entry.identity.predicate } else { '-' })
            'Predicate verdict' = $(if ($shownVerdicts -and $shownVerdicts.predicateVerdict) { $shownVerdicts.predicateVerdict } else { '-' })
            'Study verdict'     = $(if ($shownVerdicts) { $shownVerdicts.studyVerdict } else { '-' })
            'Report'            = (Join-Path $entry.path 'report.html')
        })
        if (@($findings).Count -gt 0) {
            Write-ChaosStudyTable -Title 'Findings' -Data @($findings | ForEach-Object {
                [pscustomobject]@{ Severity = $_.severity; Confidence = $_.confidence; Finding = $_.title }
            })
        }
        exit (Get-ChaosStudyExitCode -Name 'Success')
    }

    'compare' {
        $sealed = @($index | Where-Object { $_.state -eq 'SEALED' })
        $candidate = Resolve-Entry -Reference $StudyId -Pool $sealed
        if (-not $candidate) {
            Write-ChaosStudyFailure -Title 'Nothing to compare' -Message "No sealed study matched '$StudyId'." -Remediation 'Seal a study by running the chaos-study-report skill.'
            exit (Get-ChaosStudyExitCode -Name 'Error')
        }
        # Restrict the pool to the same scope before picking 'previous', otherwise
        # 'previous' would happily select an unrelated study.
        $pool = @($sealed | Where-Object { $_.scopeHash -eq $candidate.scopeHash -and $_.studyId -ne $candidate.studyId })
        $baseline = Resolve-Entry -Reference $(if ($Against -eq 'previous') { 'latest' } else { $Against }) -Pool $pool

        if (-not $baseline) {
            Write-ChaosStudyPanel -Title 'Only one study in this scope' -Status 'info' -Body @"
Study $($candidate.studyId) is the only sealed study for scope $($candidate.scopeHash).
A comparison needs two. Run the same study again later and compare then - that
series is where the value is.
"@
            exit (Get-ChaosStudyExitCode -Name 'Success')
        }

        $baseline | Add-Member -NotePropertyName findings -NotePropertyValue (Get-StudyFindings -Entry $baseline) -Force
        $candidate | Add-Member -NotePropertyName findings -NotePropertyValue (Get-StudyFindings -Entry $candidate) -Force

        $comparison = Compare-Study -Baseline $baseline -Candidate $candidate

        if ($Json) { $comparison | ConvertTo-Json -Depth 8; exit $(if ($comparison.comparable) { 0 } else { Get-ChaosStudyExitCode -Name 'StudyIncomparable' }) }

        if (-not $comparison.comparable) {
            Write-ChaosStudyFailure -Title 'These studies are not comparable' -Message @"
$($baseline.studyId) and $($candidate.studyId) did not ask the same question, so
any difference between them would be noise dressed as a signal.

$(@($comparison.reasons | ForEach-Object { "  - $_" }) -join "`n")
"@ -Remediation 'Compare studies that share a scope, a workspace, a scenario, an action, a steady-state objective and comparable window lengths.'
            exit (Get-ChaosStudyExitCode -Name 'StudyIncomparable')
        }

        $status = switch ($comparison.direction) {
            'improved'  { 'success' }
            'regressed' { 'error' }
            'stable'    { 'info' }
            default     { 'warning' }
        }
        Write-ChaosStudyPanel -Title "Comparison: $($comparison.direction)" -Status $status -Body @"
$($baseline.studyId): predicate $($comparison.baseline.predicateVerdict), study $($comparison.baseline.studyVerdict)
  -> $($candidate.studyId): predicate $($comparison.candidate.predicateVerdict), study $($comparison.candidate.studyVerdict)
"@ -Properties ([ordered]@{
            'Predicate verdict changed' = $comparison.predicateVerdictChanged
            'Study verdict changed'     = $comparison.verdictChanged
            'Introduced'                = @($comparison.introduced).Count
            'Resolved'                  = @($comparison.resolved).Count
            'Persisted'                 = @($comparison.persisted).Count
        })

        foreach ($group in @(
            @{ label = 'Introduced'; items = $comparison.introduced }
            @{ label = 'Resolved'; items = $comparison.resolved }
        )) {
            if (@($group.items).Count -gt 0) {
                Write-ChaosStudyTable -Title $group.label -Data @($group.items | ForEach-Object {
                    [pscustomobject]@{ Severity = $_.severity; Finding = $_.title }
                })
            }
        }
        if (@($comparison.persisted).Count -gt 0) {
            Write-ChaosStudyTable -Title 'Persisted' -Data @($comparison.persisted | ForEach-Object {
                [pscustomobject]@{ Movement = $_.movement; Was = $_.wasSeverity; Now = $_.nowSeverity; Finding = $_.title }
            })
        }
        exit (Get-ChaosStudyExitCode -Name 'Success')
    }

    'rerun' {
        $entry = Resolve-Entry -Reference $StudyId -Pool $index
        if (-not $entry) {
            Write-ChaosStudyFailure -Title 'Study not found' -Message "No study matched '$StudyId'." -Remediation 'Run this skill with -Action list to see available studies.'
            exit (Get-ChaosStudyExitCode -Name 'Error')
        }
        $planReader = Get-ChaosArtifactReader -StudyPath $entry.path -Artifact 'plan'
        $plan = Read-ChaosJsonFile -Path $planReader.path
        if (-not $plan) {
            Write-ChaosStudyFailure -Title 'Study has no plan' -Message "Study $($entry.studyId) has no plan artifact ($($planReader.fileName)) to repeat." -Remediation 'Plan a fresh study with the chaos-study-scope skill.'
            exit (Get-ChaosStudyExitCode -Name 'Error')
        }
        $scope = Join-Path $PSScriptRoot '..' '..' 'chaos-study-scope' 'scripts' 'Invoke-ChaosStudyScope.ps1'
        # The workspace already exists (this study ran against it), so the rerun
        # command deliberately omits -CreateWorkspace: reruns observe, they do not
        # provision. The scope is re-discovered live, so a resource that has since
        # left the workspace is not silently carried forward from the old plan.
        #
        # Everything the first study froze is reproduced here. Two kinds of
        # omission are dangerous rather than merely untidy: dropping the
        # mechanism or its probe emits a command that fails readiness (exit 10)
        # and looks like a platform fault, and dropping a blast-radius filter or
        # exclusion emits a command that runs WIDER than the study it claims to
        # repeat. Both are treated as unreproducible below rather than printed.
        $unreproducible = @()

        # -Action accepts a URN or a name. Prefer the URN because it is exact, but
        # a discovery-skipped plan never learned one, and emitting -Action '' would
        # hand the operator a command that cannot run.
        $actionRef = if ([string]::IsNullOrWhiteSpace($plan.action.canonicalId)) { [string]$plan.action.name } else { [string]$plan.action.canonicalId }
        if ([string]::IsNullOrWhiteSpace($actionRef)) { $unreproducible += 'the action - the plan records neither a canonical id nor a name' }

        $lines = @(
            "& '$scope' ``"
            "    -SubscriptionId '$($plan.workspace.subscriptionId)' ``"
            "    -ResourceGroup '$($plan.workspace.resourceGroup)' ``"
            "    -WorkspaceName '$($plan.workspace.name)' ``"
        )
        if ($plan.scope.region) { $lines += "    -Location '$($plan.scope.region)' ``" }
        $lines += @(
            "    -Scenario '$($plan.scenario.name)' ``"
            "    -Action '$actionRef' ``"
            "    -SteadyState '$($plan.question.steadyState.raw)' ``"
        )

        foreach ($source in @($plan.signals.configuredSources | Where-Object { $_ })) {
            $lines += "    -SignalSource '$($source -replace "'", "''")' ``"
        }

        # Falsifiability inputs. Required by readiness, so a rerun without them
        # is not a weaker rerun - it is a command that cannot run at all.
        $mechanism = $plan.mechanism
        $failureMechanism = [string](Get-ChaosMember -InputObject $mechanism -Name 'failureMechanism')
        $mechanismEvidence = [string](Get-ChaosMember -InputObject $mechanism -Name 'mechanismEvidence')
        $mechanismProbe = Get-ChaosMember -InputObject $mechanism -Name 'mechanismProbe'

        if ([string]::IsNullOrWhiteSpace($failureMechanism)) { $unreproducible += 'the failure mechanism - readiness requires it (exit 10)' }
        else { $lines += "    -FailureMechanism '$($failureMechanism -replace "'", "''")' ``" }

        if ([string]::IsNullOrWhiteSpace($mechanismEvidence)) { $unreproducible += 'the mechanism evidence - readiness requires it (exit 10)' }
        else { $lines += "    -MechanismEvidence '$($mechanismEvidence -replace "'", "''")' ``" }

        if ($null -eq $mechanismProbe) { $unreproducible += 'the mechanism probe - readiness requires it (exit 10)' }
        else {
            $probeLiteral = Format-RerunLiteral -Value $mechanismProbe
            if ($null -eq $probeLiteral) { $unreproducible += 'the mechanism probe - it contains a value that cannot be written back as a literal' }
            else { $lines += "    -MechanismProbe $probeLiteral ``" }
        }

        $hypothesis = [string](Get-ChaosMember -InputObject $plan.question -Name 'hypothesis')
        if (-not [string]::IsNullOrWhiteSpace($hypothesis)) { $lines += "    -Hypothesis '$($hypothesis -replace "'", "''")' ``" }

        # Scenario and action parameters are stored as the {key,value} pairs the
        # service takes; the scope skill takes a hashtable for each, so they are
        # folded back separately. They are validated against different schemas,
        # so collapsing them into one switch would reroute values on rerun.
        $parameterSets = @(
            @{ Container = $plan.scenario; Switch = 'Parameters'; Label = 'scenario' }
            @{ Container = $plan.action; Switch = 'ActionParameters'; Label = 'action' }
        )
        foreach ($set in $parameterSets) {
            $storedParameters = @(Get-ChaosItems -InputObject (Get-ChaosMember -InputObject $set.Container -Name 'parameters'))
            if ($storedParameters.Count -eq 0) { continue }
            $pairs = @()
            foreach ($parameter in $storedParameters) {
                $key = [string](Get-ChaosMember -InputObject $parameter -Name 'key')
                $literal = Format-RerunLiteral -Value (Get-ChaosMember -InputObject $parameter -Name 'value')
                if ([string]::IsNullOrWhiteSpace($key) -or $null -eq $literal) { $pairs = $null; break }
                $pairs += "$key = $literal"
            }
            if ($null -eq $pairs) { $unreproducible += "the $($set.Label) parameters - one of them cannot be written back as a literal" }
            else { $lines += "    -$($set.Switch) @{ $($pairs -join '; ') } ``" }
        }

        # Exposure arithmetic. Reproduced from the frozen inputs so the rerun
        # buys the same exposure and the two studies stay comparable.
        $exerciseInputs = Get-ChaosMember -InputObject (Get-ChaosMember -InputObject $plan.exercise -Name 'model') -Name 'inputs'
        foreach ($pair in @(
                @{ field = 'eventRatePerSecond'; parameter = 'EventRatePerSecond' }
                @{ field = 'vulnerableWindowSeconds'; parameter = 'VulnerableWindowSeconds' }
                @{ field = 'eligibleFraction'; parameter = 'EligibleFraction' })) {
            $value = Get-ChaosMember -InputObject $exerciseInputs -Name $pair.field
            if ($null -ne $value) { $lines += "    -$($pair.parameter) $value ``" }
        }
        foreach ($assumption in @(Get-ChaosItems -InputObject (Get-ChaosMember -InputObject (Get-ChaosMember -InputObject $plan.exercise -Name 'model') -Name 'assumptions'))) {
            if ($assumption) { $lines += "    -ExerciseAssumption '$([string]$assumption -replace "'", "''")' ``" }
        }
        if ([bool](Get-ChaosMember -InputObject $plan.exercise -Name 'weakAccepted')) { $lines += '    -AcceptWeakExercise `' }

        # Blast radius. Anything here that fails to reproduce widens the rerun,
        # so it is a hard failure rather than a dropped line.
        $blastRadius = Get-ChaosMember -InputObject $plan.scope -Name 'blastRadius'
        $filters = Get-ChaosMember -InputObject $blastRadius -Name 'filters'
        $exclusions = Get-ChaosMember -InputObject $blastRadius -Name 'exclusions'
        foreach ($map in @(
                @{ container = $filters; field = 'location'; parameter = 'FilterLocation'; list = $true }
                @{ container = $filters; field = 'zone'; parameter = 'FilterZone'; list = $true }
                @{ container = $filters; field = 'physicalZone'; parameter = 'FilterPhysicalZone'; list = $false }
                @{ container = $exclusions; field = 'resource'; parameter = 'ExcludeResource'; list = $true }
                @{ container = $exclusions; field = 'type'; parameter = 'ExcludeType'; list = $true })) {
            $value = Get-ChaosMember -InputObject $map.container -Name $map.field
            if ($null -eq $value) { continue }
            if ($map.list) {
                $items = @(Get-ChaosItems -InputObject $value | Where-Object { $_ })
                if ($items.Count -eq 0) { continue }
                $rendered = @($items | ForEach-Object { "'$([string]$_ -replace "'", "''")'" })
                $lines += "    -$($map.parameter) $($rendered -join ', ') ``"
            }
            elseif (-not [string]::IsNullOrWhiteSpace([string]$value)) {
                $lines += "    -$($map.parameter) '$([string]$value -replace "'", "''")' ``"
            }
        }
        $excludeTag = Get-ChaosMember -InputObject $exclusions -Name 'tag'
        if ($null -ne $excludeTag) {
            $tagLiteral = Format-RerunLiteral -Value $excludeTag
            if ($null -eq $tagLiteral) { $unreproducible += 'the tag exclusions - they cannot be written back as a literal, and omitting them would widen the blast radius' }
            elseif ($tagLiteral -ne '@{}') { $lines += "    -ExcludeTag $tagLiteral ``" }
        }

        # Any blast-radius key the plan carries that this builder does not know
        # how to emit would silently widen the rerun, so it fails instead.
        foreach ($pair in @(
                @{ container = $filters; known = @('location', 'zone', 'physicalZone'); label = 'filter' }
                @{ container = $exclusions; known = @('resource', 'type', 'tag'); label = 'exclusion' })) {
            foreach ($name in @(Get-ChaosMemberName -InputObject $pair.container)) {
                if ($pair.known -notcontains $name) {
                    $value = Get-ChaosMember -InputObject $pair.container -Name $name
                    if ($null -ne $value -and @(Get-ChaosItems -InputObject $value | Where-Object { $_ }).Count -gt 0) {
                        $unreproducible += "the '$name' blast-radius $($pair.label) - this skill cannot write it back, and omitting it would widen the rerun"
                    }
                }
            }
        }

        $adapter = [string](Get-ChaosMember -InputObject $plan -Name 'adapter')
        if (-not [string]::IsNullOrWhiteSpace($adapter)) { $lines += "    -Adapter '$adapter' ``" }

        $lines += @(
            "    -DurationMinutes $($plan.windows.injectMinutes) ``"
            "    -BaselineMinutes $($plan.windows.baselineMinutes) ``"
            "    -RecoveryMinutes $($plan.windows.recoveryMinutes)"
        )

        if ($unreproducible.Count -gt 0) {
            $detail = @($unreproducible | ForEach-Object { "  - $_" }) -join "`n"
            Write-ChaosStudyFailure -Title 'Rerun cannot be reproduced' -Message @"
Study $($entry.studyId) cannot be repeated exactly from its plan, so no command
was printed. A command that silently drops one of these would either fail
readiness or run against a wider blast radius than the study it claims to
repeat, and the two results would not be comparable.

Missing:
$detail
"@ -Remediation 'Plan a fresh study with the chaos-study-scope skill, supplying these inputs explicitly, and compare the two studies afterwards with -Action compare.'
            exit (Get-ChaosStudyExitCode -Name 'RerunNotReproducible')
        }

        $command = ($lines -join "`n")

        Write-ChaosStudyPanel -Title "Rerun study $($entry.studyId)" -Status 'info' -Body @"
Rerunning creates a new study rather than overwriting this one, so the pair can
be compared afterwards. The workspace scope and the action are both resolved
live again, so a rerun fails loudly if the platform no longer offers the action
or the workspace no longer covers the same resources. Nothing has been injected
- run the command below, then the chaos-study-run skill with explicit consent.
"@ -Properties ([ordered]@{
            'Workspace' = [string]$plan.workspace.name
            'Scenario'  = [string]$plan.scenario.name
            'Action'    = [string]$plan.action.displayName
            'Predicate' = [string]$plan.question.steadyState.raw
        })
        Write-ChaosStudyPanel -Title 'Command' -Status 'info' -Body $command
        exit (Get-ChaosStudyExitCode -Name 'Success')
    }
}
