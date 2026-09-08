#Requires -Version 7.0
<#
.SYNOPSIS
    Render a sealed study as one self-contained HTML file.

.DESCRIPTION
    The template owns presentation; this file owns content. Every value that
    originates from Azure or from the plan passes through HTML escaping on the
    way in, so a resource name containing a bracket cannot alter the document.

    Missing measurements render as "not measured" with their caveat. They are
    never rendered as zero and never quietly dropped - a reader must be able to
    tell the difference between "we measured nothing happened" and "we did not
    measure".

    Output is deterministic apart from the generated timestamp: fixed section
    order, sorted keys, no random ids.
#>

Set-StrictMode -Version Latest

function Get-ChaosReportTemplatePath {
    return (Join-Path $PSScriptRoot '..' '..' 'templates' 'study-report.html.tmpl')
}

function ConvertTo-ChaosReportValue {
    <#
    .SYNOPSIS
        Render one measurement, honestly.
    #>
    param([AllowNull()][object]$Value)
    if ($null -eq $Value) { return '<span class="notmeasured">not measured</span>' }
    if ($Value -is [bool]) { return $(if ($Value) { 'yes' } else { 'no' }) }
    if ($Value -is [double] -or $Value -is [single]) {
        return (ConvertTo-ChaosHtmlText -Text ([string][Math]::Round([double]$Value, 4)))
    }
    return (ConvertTo-ChaosHtmlText -Text ([string]$Value))
}

function New-ChaosReportRow {
    param([Parameter(Mandatory)][string]$Label, [AllowNull()][object]$Value)
    $rendered = if ($Value -is [string]) { ConvertTo-ChaosHtmlText -Text $Value } else { ConvertTo-ChaosReportValue -Value $Value }
    return "  <dt>$(ConvertTo-ChaosHtmlText -Text $Label)</dt><dd>$rendered</dd>"
}

function New-ChaosReportList {
    param([AllowNull()][object[]]$Items, [string]$Empty = 'None recorded.')
    $all = @($Items | Where-Object { $_ })
    if ($all.Count -eq 0) { return "<p class=`"notmeasured`">$(ConvertTo-ChaosHtmlText -Text $Empty)</p>" }
    $lines = foreach ($item in $all) { "  <li>$(ConvertTo-ChaosHtmlText -Text ([string]$item))</li>" }
    return "<ul class=`"tight`">`n$($lines -join "`n")`n</ul>"
}

function Get-ChaosVerdictVisual {
    <#
    .SYNOPSIS
        Verdict styling and an inline SVG glyph. Inline so the report stays a
        single file with no external requests.
    #>
    param([Parameter(Mandatory)][string]$Verdict)

    $shapes = @{
        'Steady state held'     = @{ class = 'held'; color = '#1a7f37'; path = 'M5 10.5l3.2 3.2L15 7' }
        'Degraded but recovered' = @{ class = 'degraded'; color = '#9a6700'; path = 'M10 5v6M10 14h.01' }
        'Steady state breached' = @{ class = 'breached'; color = '#b3261e'; path = 'M6 6l8 8M14 6l-8 8' }
        'Not exercised'         = @{ class = 'inconclusive'; color = '#6639ba'; path = 'M5 10h10' }
        'Not evaluated'         = @{ class = 'inconclusive'; color = '#6639ba'; path = 'M5 10h10' }
        'Held'                  = @{ class = 'held'; color = '#1a7f37'; path = 'M5 10.5l3.2 3.2L15 7' }
        'Breached'              = @{ class = 'breached'; color = '#b3261e'; path = 'M6 6l8 8M14 6l-8 8' }
        'Inconclusive'          = @{ class = 'inconclusive'; color = '#6639ba'; path = 'M7.5 7.5a2.5 2.5 0 113.4 2.3c-.6.3-.9.8-.9 1.4M10 14h.01' }
    }
    # Critical collateral carries the breach styling because it is real damage,
    # while the wording itself keeps saying what happened to the predicate.
    $shape =
    if ($shapes.ContainsKey($Verdict)) { $shapes[$Verdict] }
    elseif ($Verdict -like 'Critical collateral damage*') { $shapes['Steady state breached'] }
    else { $shapes['Inconclusive'] }
    $svg = @"
<svg width="28" height="28" viewBox="0 0 20 20" role="img" aria-label="$(ConvertTo-ChaosHtmlText -Text $Verdict)" focusable="false"><circle cx="10" cy="10" r="9" fill="none" stroke="$($shape.color)" stroke-width="1.5"/><path d="$($shape.path)" fill="none" stroke="$($shape.color)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
"@
    return [pscustomobject]@{ class = $shape.class; svg = $svg.Trim() }
}

function New-ChaosSignalTable {
    <#
    .SYNOPSIS
        One row per signal per window, with the caveat visible next to the value.
    #>
    param([Parameter(Mandatory)][object]$Evidence)

    $rows = @()
    foreach ($window in @('pre', 'during', 'post')) {
        foreach ($signal in @($Evidence.$window | Where-Object { $null -ne $_ })) {
            $valueCell = if ($null -eq $signal.values) {
                '<span class="notmeasured">not measured</span>'
            } else {
                $map = Get-ChaosSignalValueMap -Signal $signal
                if ($map.Count -eq 0) {
                    '<span class="notmeasured">not measured</span>'
                } else {
                    $parts = foreach ($name in @($map.Keys)) {
                        "$(ConvertTo-ChaosHtmlText -Text $name) = $(ConvertTo-ChaosReportValue -Value $map[$name])"
                    }
                    ($parts -join '<br>')
                }
            }
            $caveat = if ($signal.caveat) { ConvertTo-ChaosHtmlText -Text ([string]$signal.caveat) } else { '&mdash;' }
            $rows += "  <tr><td class=`"mono`">$(ConvertTo-ChaosHtmlText -Text ([string]$signal.source))</td><td>$window</td><td class=`"num`">$valueCell</td><td>$caveat</td></tr>"
        }
    }
    if ($rows.Count -eq 0) { return '<p class="notmeasured">No signals were collected.</p>' }
    return @"
<table>
<thead><tr><th>Signal</th><th>Window</th><th>Value</th><th>Caveat</th></tr></thead>
<tbody>
$($rows -join "`n")
</tbody>
</table>
"@
}

function New-ChaosFindingsHtml {
    param([Parameter(Mandatory)][AllowEmptyCollection()][object[]]$Findings)

    if (@($Findings).Count -eq 0) {
        return '<p>No findings. Every signal that was measured stayed within its objective for the whole study.</p>'
    }

    $blocks = foreach ($finding in $Findings) {
        $evidence = foreach ($ref in @($finding.evidence | Where-Object { $null -ne $_ })) {
            "$(ConvertTo-ChaosHtmlText -Text ([string]$ref.signal)) during the <strong>$(ConvertTo-ChaosHtmlText -Text ([string]$ref.window))</strong> window"
        }
        $remediation = if (@($finding.remediation).Count -gt 0) {
            "<dt>Remediation</dt><dd>$(New-ChaosReportList -Items $finding.remediation)</dd>"
        } else { '' }
        # The kind says which question the finding answers. Without it a critical
        # collateral finding reads as a predicate failure, which is the exact
        # confusion this contract exists to remove.
        $kind = if ($finding.PSObject.Properties.Name -contains 'kind') { [string]$finding.kind } else { 'operational' }
        @"
<article class="finding">
  <h3><span class="pill $(ConvertTo-ChaosHtmlText -Text $finding.severity)">$(ConvertTo-ChaosHtmlText -Text $finding.severity)</span> $(ConvertTo-ChaosHtmlText -Text $finding.title) <span class="pill ghost">$(ConvertTo-ChaosHtmlText -Text $kind)</span> <span class="pill ghost">$(ConvertTo-ChaosHtmlText -Text $finding.confidence) confidence</span></h3>
  <dl>
    <dt>Observation</dt><dd>$(ConvertTo-ChaosHtmlText -Text $finding.observation)</dd>
    <dt>Interpretation</dt><dd>$(ConvertTo-ChaosHtmlText -Text $finding.interpretation)</dd>
    <dt>Evidence</dt><dd>$($evidence -join '; ')</dd>
    $remediation
  </dl>
</article>
"@
    }
    return ($blocks -join "`n")
}

function New-ChaosStudyReportHtml {
    <#
    .SYNOPSIS
        Build the whole report.
    #>
    param(
        [Parameter(Mandatory)][object]$Plan,
        [Parameter(Mandatory)][object]$RunRecord,
        [Parameter(Mandatory)][object]$Findings,
        [Parameter(Mandatory)][object]$Evidence,
        [object]$Manifest,
        [object[]]$CommandTrail = @(),
        [object[]]$Provenance = @()
    )

    $template = [System.IO.File]::ReadAllText((Get-ChaosReportTemplatePath))

    # The headline is the study verdict, because that is the one a reader acts
    # on. The predicate verdict is stated immediately beside it so the headline
    # can never be mistaken for a statement about the declared objective.
    $studyVerdict = if ($Findings.PSObject.Properties.Name -contains 'studyVerdict') { [string]$Findings.studyVerdict } else { [string]$Findings.verdict }
    $predicateVerdict = if ($Findings.PSObject.Properties.Name -contains 'predicateVerdict') { [string]$Findings.predicateVerdict } else { 'Not evaluated' }
    $verdictRationale = if ($Findings.PSObject.Properties.Name -contains 'verdictRationale') { [string]$Findings.verdictRationale } else { '' }
    $visual = Get-ChaosVerdictVisual -Verdict $studyVerdict
    $systemUnderStudy = [string]$Plan.workspace.name

    $verdictDetail = switch ($predicateVerdict) {
        'Held' { "$($Plan.question.steadyState.raw) held throughout the action window and recovery." }
        'Breached' { 'The service breached its objective and did not recover within the study window.' }
        'Not exercised' { 'The predicate did not move, but too little work reached the vulnerable path for that to count as resilience.' }
        default { 'The signal behind the predicate was not readable for the action window, so no predicate outcome can be stated.' }
    }

    # A discovery-skipped study has no verified count. Leaving it blank would put
    # an empty cell in the delivered report; say plainly that it is unknown.
    $scopedCountText = if ($null -eq $Plan.scope.projectedResourceCount) { 'not resolved (discovery skipped)' } else { [string]$Plan.scope.projectedResourceCount }

    # The configured window and the window in which the action was actually
    # live are different facts, and a reader who conflates them will credit the
    # system with surviving minutes of a fault that lasted an instant. Both are
    # stated, and an unknown action window says so.
    $observationWindowText = "$($Plan.windows.injectMinutes) minutes (configured)"
    $actionWindowText = 'unknown - the service reported no action times'
    $actionWindow = if ($Findings.PSObject.Properties.Name -contains 'actionWindow') { $Findings.actionWindow } else { $null }
    if ($null -ne $actionWindow -and $actionWindow.startUtc) {
        $actionWindowText = "$($actionWindow.startUtc) to $(if ($actionWindow.endUtc) { $actionWindow.endUtc } else { 'unknown' })"
        if ($actionWindow.timing -ne 'exact') { $actionWindowText += " ($($actionWindow.timing))" }
    }
    elseif ($null -ne $actionWindow -and $actionWindow.detail) {
        $actionWindowText = "unknown - $($actionWindow.detail)"
    }

    $headerFacts = @(
        New-ChaosReportRow -Label 'Workspace' -Value $systemUnderStudy
        New-ChaosReportRow -Label 'Scoped resources' -Value $scopedCountText
        New-ChaosReportRow -Label 'Action' -Value ([string]$Plan.action.displayName)
        New-ChaosReportRow -Label 'Steady state' -Value ([string]$Plan.question.steadyState.raw)
        New-ChaosReportRow -Label 'Predicate verdict' -Value $predicateVerdict
        New-ChaosReportRow -Label 'Study verdict' -Value $studyVerdict
        New-ChaosReportRow -Label 'Observation window' -Value $observationWindowText
        New-ChaosReportRow -Label 'Action window' -Value $actionWindowText
        New-ChaosReportRow -Label 'Run started' -Value ([string]$RunRecord.startedAt)
        New-ChaosReportRow -Label 'Sealed' -Value $(if ($Manifest) { [string]$Manifest.sealedAt } else { $null })
    ) -join "`n"

    $mechanismSentence = if ($Findings.mechanismProven) {
        'The action was proven to reach the system: measured signals moved during injection.'
    } else {
        'The action was not proven to reach the system, so a clean result cannot be read as resilience.'
    }

    $summary = @"
<p>$(ConvertTo-ChaosHtmlText -Text $Plan.question.hypothesis)</p>
<p><strong>$(ConvertTo-ChaosHtmlText -Text $studyVerdict).</strong> Predicate verdict: <strong>$(ConvertTo-ChaosHtmlText -Text $predicateVerdict)</strong>. $(ConvertTo-ChaosHtmlText -Text $verdictDetail)
$(ConvertTo-ChaosHtmlText -Text $mechanismSentence)</p>
$(if ($verdictRationale) { "<p>$(ConvertTo-ChaosHtmlText -Text $verdictRationale)</p>" })
<p>$(ConvertTo-ChaosHtmlText -Text "Evidence covers $($RunRecord.coverage.measured) of $($RunRecord.coverage.total) signal readings across the baseline, injection and recovery windows.") $(
    if (@($Findings.findings).Count -eq 0) { 'No findings were raised.' }
    else { ConvertTo-ChaosHtmlText -Text "$(@($Findings.findings).Count) finding(s) were raised; the most severe is $(@($Findings.findings)[0].severity)." }
)</p>
"@

    # V2 scenario parameters arrive as an array of {key, value} pairs, which is
    # the shape `az chaos scenario config create --parameters` accepts. Action
    # parameters use the same pair shape but a different schema, so they are
    # rendered as their own table - reading them as one list would misstate
    # which document each value was validated against.
    $renderParameterRows = {
        param([AllowNull()][object]$Pairs)
        $rows = @()
        foreach ($pair in @($Pairs)) {
            if ($null -eq $pair) { continue }
            $name = if ($pair.PSObject.Properties.Name -contains 'key') { [string]$pair.key } else { $null }
            if (-not $name) { continue }
            $value = if ($pair.PSObject.Properties.Name -contains 'value') { $pair.value } else { $null }
            $rendered = if ($value -is [string] -or $value -is [bool] -or $value -is [int] -or $value -is [long] -or $value -is [double]) {
                ConvertTo-ChaosReportValue -Value $value
            } else {
                "<code>$(ConvertTo-ChaosHtmlText -Text (ConvertTo-ChaosCanonicalJson -InputObject $value))</code>"
            }
            $rows += "  <tr><td class=`"mono`">$(ConvertTo-ChaosHtmlText -Text $name)</td><td>$rendered</td></tr>"
        }
        return , $rows
    }
    $parameterRows = ConvertTo-ChaosList (& $renderParameterRows $Plan.scenario.parameters)
    $actionParameterRows = ConvertTo-ChaosList (& $renderParameterRows (Get-ChaosMember -InputObject $Plan.action -Name 'parameters'))

    $scopedTypes = @($Plan.scope.resourceTypes) | Where-Object { $_ }
    $blastRows = @()
    foreach ($side in @('filters', 'exclusions')) {
        if ($Plan.scope.blastRadius.PSObject.Properties.Name -notcontains $side) { continue }
        $value = $Plan.scope.blastRadius.$side
        if ($null -eq $value) { continue }
        $blastRows += "  <tr><td class=`"mono`">$side</td><td><code>$(ConvertTo-ChaosHtmlText -Text (ConvertTo-ChaosCanonicalJson -InputObject $value))</code></td></tr>"
    }

    $tested = @"
<dl class="kv">
$(New-ChaosReportRow -Label 'Workspace' -Value ([string]$Plan.workspace.id))
$(New-ChaosReportRow -Label 'Region' -Value ([string]$Plan.scope.region))
$(New-ChaosReportRow -Label 'Workspace scopes' -Value (@($Plan.workspace.scopes) -join ', '))
$(New-ChaosReportRow -Label 'Resources in scope' -Value "$($Plan.scope.projectedResourceCount) of $($Plan.scope.discoveredResourceCount) discovered")
$(New-ChaosReportRow -Label 'Resource types' -Value $(if (@($scopedTypes).Count -gt 0) { @($scopedTypes) -join ', ' } else { $null }))
$(New-ChaosReportRow -Label 'Scenario' -Value ([string]$Plan.scenario.name))
$(New-ChaosReportRow -Label 'Action URN' -Value ([string]$Plan.action.canonicalId))
$(New-ChaosReportRow -Label 'Action type' -Value ([string]$Plan.action.actionType))
$(New-ChaosReportRow -Label 'Action metadata' -Value $(if ([string]$Plan.action.source -eq 'live-discovery') { 'discovered live from Microsoft.Chaos/locations/{region}/actions' } else { $null }))
$(New-ChaosReportRow -Label 'Configured windows' -Value "baseline $($Plan.windows.baselineMinutes) min, observation $($Plan.windows.injectMinutes) min, recovery $($Plan.windows.recoveryMinutes) min")
$(New-ChaosReportRow -Label 'Actual action window' -Value $actionWindowText)
$(New-ChaosReportRow -Label 'Action window derived from' -Value $(if ($null -ne $actionWindow) { "$(if ($actionWindow.source) { $actionWindow.source } else { 'nothing - unavailable' }); timing $($actionWindow.timing); $($actionWindow.legsTimed) of $($actionWindow.legsTotal) leg(s) timed" } else { $null }))
</dl>
<h3>Scenario parameters</h3>
<table><thead><tr><th>Parameter</th><th>Value</th></tr></thead><tbody>
$($parameterRows -join "`n")
</tbody></table>
$(if (@($actionParameterRows).Count -gt 0) { "<h3>Action parameters</h3>`n<p>Validated against the action's own schema, not the scenario's.</p>`n<table><thead><tr><th>Parameter</th><th>Value</th></tr></thead><tbody>`n$($actionParameterRows -join "`n")`n</tbody></table>" } else { '' })
$(if (@($blastRows).Count -gt 0) { "<h3>Blast radius</h3>`n<table><thead><tr><th>Constraint</th><th>Value</th></tr></thead><tbody>`n$($blastRows -join "`n")`n</tbody></table>" } else { '' })
<h3>Abort conditions</h3>
$(New-ChaosReportList -Items $Plan.safety.abortConditions)
"@

    $actionRows = foreach ($entry in @($RunRecord.scenarioRun.observation.actions)) {
        if ($null -eq $entry) { continue }
        $touched = if ($null -ne $entry.resources) { @($entry.resources).Count } else { 'not reported' }
        "  <tr><td class=`"mono`">$(ConvertTo-ChaosHtmlText -Text ([string]$entry.actionUrn))</td><td>$(ConvertTo-ChaosHtmlText -Text ([string]$entry.state))</td><td>$(ConvertTo-ChaosHtmlText -Text ([string]$touched))</td></tr>"
    }

    $errorRows = foreach ($entry in @($RunRecord.scenarioRun.observation.errors)) {
        if ($null -eq $entry) { continue }
        "  <tr><td class=`"mono`">$(ConvertTo-ChaosHtmlText -Text ([string]$entry.code))</td><td>$(ConvertTo-ChaosHtmlText -Text ([string]$entry.message))</td></tr>"
    }

    $happened = @"
<dl class="kv">
$(New-ChaosReportRow -Label 'Scenario run' -Value ([string]$RunRecord.scenarioRun.runId))
$(New-ChaosReportRow -Label 'Outcome' -Value ([string]$RunRecord.scenarioRun.outcome))
$(New-ChaosReportRow -Label 'Configuration' -Value ([string]$RunRecord.configuration.name))
$(New-ChaosReportRow -Label 'Validation' -Value ([string]$RunRecord.configuration.validationStatus))
$(New-ChaosReportRow -Label 'Resources touched' -Value $RunRecord.scenarioRun.observation.resourcesTouched)
$(New-ChaosReportRow -Label 'Mechanism proven' -Value $Findings.mechanismProven)
$(New-ChaosReportRow -Label 'Mechanism evidence' -Value ([string]$Findings.mechanismDetail))
$(New-ChaosReportRow -Label 'Predicate during' -Value $Findings.predicate.during)
$(New-ChaosReportRow -Label 'Predicate after' -Value $Findings.predicate.post)
</dl>
$(if (@($actionRows).Count -gt 0) { "<h3>Actions the service reported</h3>`n<table><thead><tr><th>Action URN</th><th>State</th><th>Resources</th></tr></thead><tbody>`n$($actionRows -join "`n")`n</tbody></table>" } else { '' })
$(if (@($errorRows).Count -gt 0) { "<h3>Execution errors</h3>`n<table><thead><tr><th>Kind</th><th>Detail</th></tr></thead><tbody>`n$($errorRows -join "`n")`n</tbody></table>" } else { '' })
<h3>Signals</h3>
$(New-ChaosSignalTable -Evidence $Evidence)
"@

    $limitationRows = foreach ($limitation in @($Findings.limitations | Where-Object { $null -ne $_ })) {
        "  <tr><td class=`"mono`">$(ConvertTo-ChaosHtmlText -Text ([string]$limitation.code))</td><td>$(ConvertTo-ChaosHtmlText -Text ([string]$limitation.text))</td></tr>"
    }
    $limitations = "<table><thead><tr><th>Code</th><th>Limitation</th></tr></thead><tbody>`n$($limitationRows -join "`n")`n</tbody></table>"

    $remediationItems = @($Findings.findings | ForEach-Object { $_.remediation } | Where-Object { $_ })
    $remediation = New-ChaosReportList -Items $remediationItems -Empty 'No remediation is indicated by this study.'

    $trailRows = foreach ($entry in @($CommandTrail)) {
        "  <tr><td class=`"mono`">$(ConvertTo-ChaosHtmlText -Text ([string]$entry.at))</td><td class=`"mono`">$(ConvertTo-ChaosHtmlText -Text ([string]$entry.command))</td><td>$(ConvertTo-ChaosHtmlText -Text ([string]$entry.note))</td></tr>"
    }
    $artifactRows = if ($Manifest -and $Manifest.PSObject.Properties.Name -contains 'artifacts') {
        foreach ($artifact in @($Manifest.artifacts)) {
            "  <tr><td class=`"mono`">$(ConvertTo-ChaosHtmlText -Text ([string]$artifact.path))</td><td class=`"mono`">$(ConvertTo-ChaosHtmlText -Text ([string]$artifact.sha256))</td></tr>"
        }
    } else { @() }

    # Residue: every resource and grant this study created, with the observed
    # outcome of its removal and the exact command that removes what is left.
    # A reader who has to clean up after a failed study should not have to
    # reconstruct these from resource ids.
    $residue = if ($Findings.PSObject.Properties.Name -contains 'residue') { $Findings.residue } else { $null }
    $residueRows = if ($null -ne $residue -and $residue.PSObject.Properties.Name -contains 'entries') {
        foreach ($entry in @($residue.entries)) {
            if ($null -eq $entry) { continue }
            $detail = if (-not [string]::IsNullOrWhiteSpace([string]$entry.error)) { [string]$entry.error }
            elseif (-not [string]::IsNullOrWhiteSpace([string]$entry.command)) { [string]$entry.command }
            else { 'no removal command recorded' }
            # 'verified-absent' is the only status that means gone; see
            # Test-ChaosResidueRemoved for why acceptance is not removal.
            $statusCell = if ([string]$entry.status -eq 'verified-absent') {
                ConvertTo-ChaosHtmlText -Text ([string]$entry.status)
            } else {
                "<strong>$(ConvertTo-ChaosHtmlText -Text ([string]$entry.status))</strong>"
            }
            "  <tr><td class=`"mono`">$(ConvertTo-ChaosHtmlText -Text ([string]$entry.kind))</td><td class=`"mono`">$(ConvertTo-ChaosHtmlText -Text ([string]$entry.id))</td><td>$statusCell</td><td class=`"mono`">$(ConvertTo-ChaosHtmlText -Text $detail)</td></tr>"
        }
    } else { @() }
    $residueSummaryText = if ($null -eq $residue) { 'not recorded' }
    elseif ([int]$residue.total -eq 0) { 'nothing was created' }
    elseif ([int]$residue.unresolved -eq 0) { "$($residue.resolved) of $($residue.total) verified absent" }
    else { "$($residue.unresolved) of $($residue.total) NOT verified absent - see the table below" }

    # Appendix data is read back from artifacts written by earlier phases, and an
    # older or partially-written artifact legitimately lacks fields a newer phase
    # adds. Reading those directly would fault the render under StrictMode and
    # lose a report that is otherwise complete, so absence reads as absence.
    function Get-ChaosReportField {
        param([object]$Object, [string]$Name)
        if ($null -eq $Object) { return $null }
        if ($Object.PSObject.Properties.Name -notcontains $Name) { return $null }
        return $Object.$Name
    }

    # Adapter provenance. Which seam actually carried each Azure call, and for
    # the external seam the request/result hashes a reviewer can re-derive. A
    # report with no provenance rows and an external adapter is a report whose
    # operations were never proven to have run.
    $adapterName = if (Get-ChaosReportField -Object $Plan -Name 'adapter') { [string]$Plan.adapter } else { 'not recorded' }
    $provenanceRows = foreach ($entry in @($Provenance)) {
        if ($null -eq $entry) { continue }
        "  <tr><td class=`"mono`">$(ConvertTo-ChaosHtmlText -Text ([string](Get-ChaosReportField -Object $entry -Name 'operationId')))</td><td class=`"mono`">$(ConvertTo-ChaosHtmlText -Text ([string](Get-ChaosReportField -Object $entry -Name 'adapter')))</td><td class=`"mono`">$(ConvertTo-ChaosHtmlText -Text ([string](Get-ChaosReportField -Object $entry -Name 'requestHash')))</td><td class=`"mono`">$(ConvertTo-ChaosHtmlText -Text ([string](Get-ChaosReportField -Object $entry -Name 'resultHash')))</td><td class=`"mono`">$(ConvertTo-ChaosHtmlText -Text ([string](Get-ChaosReportField -Object $entry -Name 'ingestedAt')))</td></tr>"
    }

    # Declared versus effective legs. The scenario name promises a set of
    # actions; the service execution plan decides which of them can run. Naming
    # only the scenario would let a report imply legs that never applied.
    $effective = Get-ChaosReportField -Object $Plan -Name 'declaredVsEffective'
    $legs = Get-ChaosReportField -Object $effective -Name 'legs'
    $legsText = 'not inspected'
    $legRows = @()
    if ($null -ne (Get-ChaosReportField -Object $legs -Name 'total')) {
        $legsText = "$($legs.executable) of $($legs.total) leg(s) executable"
        foreach ($skipped in @(Get-ChaosReportField -Object $legs -Name 'skipped')) {
            if ($null -eq $skipped) { continue }
            $legRows += "  <tr><td class=`"mono`">$(ConvertTo-ChaosHtmlText -Text ([string](Get-ChaosReportField -Object $skipped -Name 'leg')))</td><td class=`"mono`">$(ConvertTo-ChaosHtmlText -Text ([string](Get-ChaosReportField -Object $skipped -Name 'actionUrn')))</td><td class=`"mono`">$(ConvertTo-ChaosHtmlText -Text ([string](Get-ChaosReportField -Object $skipped -Name 'resource')))</td><td>$(ConvertTo-ChaosHtmlText -Text ([string](Get-ChaosReportField -Object $skipped -Name 'reason')))</td></tr>"
        }
    }

    # Permission grants. What the service said was missing, whether a human
    # approved it, and what changed - never inferred from the fault consent.
    $permissionFix = Get-ChaosReportField -Object (Get-ChaosReportField -Object $RunRecord -Name 'configuration') -Name 'permissionFix'
    $permissionRows = @()
    if ($null -ne $permissionFix) {
        $grantSet = @(Get-ChaosReportField -Object $permissionFix -Name 'grantSet')
        $before = Get-ChaosReportField -Object $permissionFix -Name 'validationBefore'
        $after = Get-ChaosReportField -Object $permissionFix -Name 'validationAfter'
        $permissionRows += New-ChaosReportRow -Label 'Repair attempted' -Value $(if (Get-ChaosReportField -Object $permissionFix -Name 'attempted') { 'yes' } else { 'no' })
        $permissionRows += New-ChaosReportRow -Label 'Grants approved' -Value $(if (Get-ChaosReportField -Object $permissionFix -Name 'approved') { 'yes - by explicit phrase' } else { 'no' })
        $permissionRows += New-ChaosReportRow -Label 'Grant set hash' -Value ([string](Get-ChaosReportField -Object $permissionFix -Name 'grantSetHash'))
        $permissionRows += New-ChaosReportRow -Label 'Grant set' -Value $(if ($grantSet.Count -gt 0) { $grantSet -join '; ' } else { $null })
        $permissionRows += New-ChaosReportRow -Label 'Observed grants' -Value ([string](Get-ChaosReportField -Object $permissionFix -Name 'grantsObserved'))
        $permissionRows += New-ChaosReportRow -Label 'Validation before then after' -Value "$(if ($before) { $before } else { 'unknown' }) then $(if ($after) { $after } else { 'unknown' })"
    }

    # The frozen exposure arithmetic, so a reader can disagree with the forecast
    # rather than having to trust the verdict that rests on it.
    $exercise = Get-ChaosReportField -Object $Plan -Name 'exercise'
    $exerciseModel = Get-ChaosReportField -Object $exercise -Name 'model'
    $exerciseKnown = [bool](Get-ChaosReportField -Object $exerciseModel -Name 'known')

    $appendix = @"
<dl class="kv">
$(New-ChaosReportRow -Label 'Study id' -Value ([string]$RunRecord.studyId))
$(New-ChaosReportRow -Label 'Scope hash' -Value ([string]$RunRecord.scopeHash))
$(New-ChaosReportRow -Label 'Frozen config hash' -Value ([string]$Plan.frozenConfigHash))
$(New-ChaosReportRow -Label 'Execution adapter' -Value $adapterName)
$(New-ChaosReportRow -Label 'Durable operations recorded' -Value ([string]@($Provenance).Count))
$(New-ChaosReportRow -Label 'Effective legs' -Value $legsText)
$(New-ChaosReportRow -Label 'Effective plan hash' -Value ([string](Get-ChaosReportField -Object $effective -Name 'effectivePlanHash')))
$(New-ChaosReportRow -Label 'Partial scenario accepted' -Value $(if (Get-ChaosReportField -Object $effective -Name 'accepted') { "yes - $(Get-ChaosReportField -Object $effective -Name 'decision')" } else { 'no' }))
$(New-ChaosReportRow -Label 'Expected vulnerable events' -Value $(if ($exerciseKnown) { [string]$exerciseModel.expectedEvents } else { $null }))
$(New-ChaosReportRow -Label 'Probability of at least one event' -Value $(if ($exerciseKnown) { [string]$exerciseModel.probAtLeastOne } else { $null }))
$(New-ChaosReportRow -Label 'Weak exercise accepted' -Value $(if (Get-ChaosReportField -Object $exercise -Name 'weakAccepted') { 'yes' } else { 'no' }))
$(New-ChaosReportRow -Label 'Manifest content hash' -Value $(if ($Manifest) { [string]$Manifest.contentHash } else { 'not sealed yet' }))
$(New-ChaosReportRow -Label 'Seal class' -Value $(if ($Manifest -and $Manifest.PSObject.Properties.Name -contains 'compliance') { [string]$Manifest.compliance.sealClass } else { 'not sealed yet' }))
$(New-ChaosReportRow -Label 'Chaos api-version' -Value (Get-ChaosApiVersion -Name 'chaosStudio'))
$(New-ChaosReportRow -Label 'Actions api-version' -Value (Get-ChaosApiVersion -Name 'chaosActions'))
$(New-ChaosReportRow -Label 'Metrics api-version' -Value (Get-ChaosApiVersion -Name 'metrics'))
$(New-ChaosReportRow -Label 'Residue' -Value $residueSummaryText)
</dl>
$(if (@($permissionRows).Count -gt 0) { "<h3>Permission approval</h3>`n<dl class=`"kv`">`n$($permissionRows -join "`n")`n</dl>" } else { '' })
$(if (@($legRows).Count -gt 0) { "<h3>Skipped legs</h3>`n<table><thead><tr><th>Leg</th><th>Action</th><th>Resource</th><th>Service reason</th></tr></thead><tbody>`n$($legRows -join "`n")`n</tbody></table>" } else { '' })
$(if (@($provenanceRows).Count -gt 0) { "<h3>Operation provenance</h3>`n<table><thead><tr><th>Operation</th><th>Adapter</th><th>Request hash</th><th>Result hash</th><th>Ingested</th></tr></thead><tbody>`n$($provenanceRows -join "`n")`n</tbody></table>" } else { '' })
$(if (@($residueRows).Count -gt 0) { "<h3>Residue ledger</h3>`n<table><thead><tr><th>Kind</th><th>Id</th><th>Cleanup</th><th>Error or removal command</th></tr></thead><tbody>`n$($residueRows -join "`n")`n</tbody></table>" } else { '' })
$(if (@($artifactRows).Count -gt 0) { "<h3>Artifact hashes</h3>`n<table><thead><tr><th>Artifact</th><th>SHA-256</th></tr></thead><tbody>`n$($artifactRows -join "`n")`n</tbody></table>" } else { '' })
$(if (@($trailRows).Count -gt 0) { "<h3>Command trail</h3>`n<table><thead><tr><th>At</th><th>Command</th><th>Note</th></tr></thead><tbody>`n$($trailRows -join "`n")`n</tbody></table>" } else { '<p class="notmeasured">No command trail was recorded.</p>' })
"@

    $tokens = [ordered]@{
        '{{TITLE}}'          = ConvertTo-ChaosHtmlText -Text "Chaos study: $($Plan.action.displayName) on $systemUnderStudy"
        '{{STUDY_ID}}'       = ConvertTo-ChaosHtmlText -Text ([string]$RunRecord.studyId)
        '{{VERDICT}}'        = ConvertTo-ChaosHtmlText -Text $studyVerdict
        '{{VERDICT_CLASS}}'  = $visual.class
        '{{VERDICT_ICON}}'   = $visual.svg
        '{{VERDICT_DETAIL}}' = ConvertTo-ChaosHtmlText -Text $verdictDetail
        '{{HEADER_FACTS}}'   = $headerFacts
        '{{SUMMARY}}'        = $summary
        '{{TESTED}}'         = $tested
        '{{HAPPENED}}'       = $happened
        '{{FINDINGS}}'       = New-ChaosFindingsHtml -Findings @($Findings.findings)
        '{{LIMITATIONS}}'    = $limitations
        '{{REMEDIATION}}'    = $remediation
        '{{APPENDIX}}'       = $appendix
        '{{GENERATED_AT}}'   = ConvertTo-ChaosHtmlText -Text (Get-ChaosUtcNow)
    }

    $html = $template
    foreach ($token in $tokens.Keys) { $html = $html.Replace($token, [string]$tokens[$token]) }

    if ($html -match '\{\{[A-Z_]+\}\}') {
        throw "Report template has unreplaced tokens: $($Matches[0]). The renderer and the template are out of sync."
    }
    if ($html -match '(?i)<script') {
        throw 'Report contains a script tag. Reports are evidence, not applications.'
    }
    return $html
}
