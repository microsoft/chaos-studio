#Requires -Version 7.0
<#
.SYNOPSIS
    Decide what is worth testing, before anything is scoped or injected.

.DESCRIPTION
    This is the phase most chaos work skips, and skipping it is why so many
    chaos results are unreadable. A run that was never aimed at a question
    cannot answer one: it produces a green tick, a screenshot, and no new
    information about the system.

    Design fixes that by forcing two things to happen in order.

      1. ANALYSIS FIRST. The system is read before anybody is asked anything -
         code, deployment, dependencies, retry and fallback behaviour,
         persistence, workload, telemetry, build identity. Every finding carries
         a citation; anything that could not be read is recorded as unavailable
         rather than assumed. This is enforced, not advised: the interview will
         not open until the analysis is complete.

      2. THEN THE INTERVIEW. One question at a time, each carrying the concrete
         finding that prompted it, and each refusing a vague answer. "Test
         resilience" is rejected with a worked example built from the
         customer's own code, because a goal that cannot come back false is not
         a study.

    Only after both does this skill recommend anything, and what it recommends
    is bounded by what Chaos Studio actually offers in that region today, read
    live from Microsoft.Chaos/locations/{region}/actions. There is no bundled
    catalogue of faults here and no fallback to one. If Azure cannot be reached,
    candidates are marked provisional and the brief carries a limitation - which
    is a different thing from "nothing is available", and the two are never
    collapsed.

    The output is a durable brief that chaos-study-scope consumes directly, so
    nothing established here has to be retyped - and nothing agreed here can be
    quietly changed later, because confirming the brief seals it.

    Nothing in this skill injects anything or mutates any Azure resource.

.EXAMPLE
    ./Invoke-ChaosStudyDesign.ps1 -Action start -System 'orders-api'

.EXAMPLE
    ./Invoke-ChaosStudyDesign.ps1 -Action analyze -BriefId <id> -ObservationFile analysis.json

.EXAMPLE
    ./Invoke-ChaosStudyDesign.ps1 -Action interview -BriefId <id>

.EXAMPLE
    ./Invoke-ChaosStudyDesign.ps1 -Action answer -BriefId <id> -QuestionId purpose `
        -Answer 'whether orders still complete when the payment API is unreachable for 10 minutes'
#>

[CmdletBinding()]
param(
    # Which step of the design conversation to perform.
    [Parameter(Mandatory)]
    [ValidateSet('start', 'analyze', 'candidates', 'interview', 'answer', 'recommend', 'confirm', 'show', 'list')]
    [string]$Action,

    # A short name for the system under study. Required to start a brief.
    [string]$System,

    # The brief to continue. Defaults to the newest when omitted.
    [string]$BriefId,

    # JSON file holding the system analysis, produced by reading the code.
    [string]$ObservationFile,

    # JSON file holding the ranked candidate hypotheses.
    [string]$CandidateFile,

    # Which interview question is being answered.
    [string]$QuestionId,

    # The customer's answer, verbatim.
    [string]$Answer,

    # The candidate the customer selected, by id, rank or exact title.
    [string]$Select,

    # The exact confirmation phrase. Printed by -Action recommend.
    [string]$ConfirmPhrase,

    # Where briefs and studies live.
    [string]$StudyRoot,

    # Subscription used for live action discovery during -Action recommend.
    [string]$SubscriptionId,

    # Resource group holding the Chaos Studio workspace, for live discovery.
    [string]$ResourceGroup,

    # Workspace whose scopes and recommendations inform the shortlist.
    [string]$WorkspaceName,

    # Region to enumerate actions in. Resolved from the workspace when omitted.
    [string]$Location,

    # Execution adapter for any Azure read. Same contract as the other skills.
    [string]$Adapter,

    # Skip live discovery entirely and mark every candidate provisional.
    [switch]$NoDiscovery
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot '..' '..' 'chaos-study' 'scripts' 'lib' 'Common.ps1')
. (Join-Path $PSScriptRoot '..' '..' 'chaos-study' 'scripts' 'lib' 'Study.ps1')
. (Join-Path $PSScriptRoot '..' '..' 'chaos-study' 'scripts' 'lib' 'Operation.ps1')
. (Join-Path $PSScriptRoot 'lib' 'Brief.ps1')
. (Join-Path $PSScriptRoot 'lib' 'Inspect.ps1')
. (Join-Path $PSScriptRoot 'lib' 'Interview.ps1')
. (Join-Path $PSScriptRoot 'lib' 'Candidates.ps1')

$exitCode = 0

function Resolve-ChaosDesignRoot {
    if (-not [string]::IsNullOrWhiteSpace($StudyRoot)) { return $StudyRoot }
    return (Join-Path (Get-Location).Path '.chaos-studies')
}

function Resolve-ChaosDesignBrief {
    <#
    .SYNOPSIS
        Load the brief being worked on, defaulting to the newest.
    #>
    param([string]$Root)
    if (-not [string]::IsNullOrWhiteSpace($BriefId)) {
        $brief = Get-ChaosBrief -StudyRoot $Root -BriefId $BriefId
        if ($null -eq $brief) { throw "No brief '$BriefId' under $Root." }
        return $brief
    }
    $index = @(Get-ChaosBriefIndex -StudyRoot $Root)
    if ($index.Count -eq 0) {
        throw "No briefs exist yet under $Root. Start one with -Action start -System <name>."
    }
    $brief = Get-ChaosBrief -StudyRoot $Root -BriefId ([string]$index[0].briefId)
    Write-ChaosStudyNote -Message "Using the most recent brief $($index[0].briefId) ($($index[0].system))." -Level Info
    return $brief
}

function Read-ChaosDesignJson {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$What)
    if ([string]::IsNullOrWhiteSpace($Path)) { throw "This step needs $What." }
    if (-not (Test-Path -LiteralPath $Path)) { throw "$What file not found: $Path" }
    return Read-ChaosJsonFile -Path $Path
}

function Get-ChaosDesignConfirmPhrase {
    <#
    .SYNOPSIS
        The exact phrase that confirms a recommendation.

    .DESCRIPTION
        Names the chosen candidate and the system, and carries the brief hash so
        it cannot be typed before the shortlist was read, nor reused after the
        shortlist changed.
    #>
    param([Parameter(Mandatory)][object]$Brief, [Parameter(Mandatory)][object]$Candidate)
    $short = ([string]$Brief.briefHash).Substring(0, 8)
    return "study $($Candidate.id) on $($Brief.system) $short"
}

function Invoke-ChaosDesignDiscovery {
    <#
    .SYNOPSIS
        Read what the platform can actually do here, or say plainly that it was
        not read.

    .DESCRIPTION
        Returns { actions, scenarios, region, reason }. A failure returns nulls
        with the reason attached rather than an empty list, because an empty
        list means "the platform offers nothing" and that is a conclusion this
        function is not entitled to draw when the call never succeeded.
    #>
    param([Parameter(Mandatory)][string]$Root)

    if ($NoDiscovery) {
        return [pscustomobject]@{ actions = $null; scenarios = $null; region = $null; reason = 'Live discovery was skipped with -NoDiscovery, so platform availability is unverified.' }
    }
    if ([string]::IsNullOrWhiteSpace($SubscriptionId) -or [string]::IsNullOrWhiteSpace($ResourceGroup) -or [string]::IsNullOrWhiteSpace($WorkspaceName)) {
        return [pscustomobject]@{ actions = $null; scenarios = $null; region = $null; reason = 'No subscription, resource group and workspace were supplied, so live action discovery could not run.' }
    }

    try {
        . (Join-Path $PSScriptRoot '..' '..' 'chaos-study' 'scripts' 'lib' 'ApiVersions.ps1')
        . (Join-Path $PSScriptRoot '..' '..' 'chaos-study-scope' 'scripts' 'lib' 'Workspace.ps1')
        . (Join-Path $PSScriptRoot '..' '..' 'chaos-study-scope' 'scripts' 'lib' 'ActionDiscovery.ps1')

        $workspace = Get-ChaosStudyWorkspace -SubscriptionId $SubscriptionId -ResourceGroup $ResourceGroup -WorkspaceName $WorkspaceName -Adapter $Adapter -StudyPath $Root
        if ($null -eq $workspace) { throw "Workspace '$WorkspaceName' was not found in resource group '$ResourceGroup'." }

        $region = $Location
        if ([string]::IsNullOrWhiteSpace($region)) { $region = [string](Get-ChaosMember -InputObject $workspace -Name 'location') }
        if ([string]::IsNullOrWhiteSpace($region)) { throw 'The workspace did not report a location and none was supplied with -Location.' }

        # ConvertTo-ChaosList, never @(...): these producers return a
        # comma-wrapped array, and @() around one turns an EMPTY result into a
        # single phantom element - which would advertise an action and a
        # scenario that the service never returned.
        $actions = ConvertTo-ChaosList (Get-ChaosAvailableAction -SubscriptionId $SubscriptionId -Region $region -Adapter $Adapter -StudyPath $Root)
        $scenarios = $null
        try {
            $scenarios = ConvertTo-ChaosList (Get-ChaosStudyScenario -SubscriptionId $SubscriptionId -ResourceGroup $ResourceGroup -WorkspaceName $WorkspaceName -Adapter $Adapter -StudyPath $Root -RecommendedOnly)
        } catch {
            # Recommendations are advisory context. Losing them narrows what can
            # be shown; it does not invalidate the live action list, which is
            # the authoritative part.
            Write-ChaosStudyNote -Message "Workspace scenario recommendations were unavailable: $($_.Exception.Message)" -Level Warn
        }
        return [pscustomobject]@{ actions = $actions; scenarios = $scenarios; region = $region; reason = $null }
    } catch {
        return [pscustomobject]@{ actions = $null; scenarios = $null; region = $null; reason = "Live action discovery failed: $($_.Exception.Message)" }
    }
}

function Show-ChaosDesignQuestion {
    <#
    .SYNOPSIS
        Print the single next question, with the finding that prompted it.
    #>
    param([Parameter(Mandatory)][object]$Question, [Parameter(Mandatory)][object]$Brief)

    $lines = @("QUESTION  $($Question.id)", '', $Question.prompt, '', "Why this matters: $($Question.why)")
    $context = Get-ChaosMember -InputObject $Question -Name 'context'
    if ($null -ne $context) {
        $lines += @('', "From your system: $($context.statement)", "  (read from $($context.citation))")
    }
    $choices = @(Get-ChaosItems -InputObject $Question.choices | Where-Object { $_ })
    if ($choices.Count -gt 0) { $lines += @('', "Answer with one of: $($choices -join ', ')") }

    $rejections = @(Get-ChaosItems -InputObject (Get-ChaosMember -InputObject $Question -Name 'rejections'))
    if ($rejections.Count -gt 0) {
        $last = $rejections[-1]
        $lines += @('', "Previously answered '$($last.answer)', which was not specific enough: $($last.reason)")
    }
    $lines += @('', "Answer with:  -Action answer -BriefId $($Brief.briefId) -QuestionId $($Question.id) -Answer '<your answer>'")
    Write-ChaosStudyCard -Title 'Study design interview' -Body ($lines -join "`n")
    Write-ChaosDesignPrompt -Question $Question -Brief $Brief
}

function Write-ChaosDesignPrompt {
    <#
    .SYNOPSIS
        Emit the open question in a machine-readable form.

    .DESCRIPTION
        The card above is for a human reading a terminal. This block is for the
        agent driving the conversation: it names exactly one question, so there
        is nothing to batch and nothing to guess a default for. An agent should
        put `prompt` to the customer through its own interactive question
        mechanism - `ask_user` where the host provides one - wait for the reply,
        and send it back with `resume`.

        Printed on stdout between stable fences so it can be extracted without
        parsing the human card.
    #>
    param([Parameter(Mandatory)][object]$Question, [Parameter(Mandatory)][object]$Brief)

    $context = Get-ChaosMember -InputObject $Question -Name 'context'
    $payload = [ordered]@{
        awaiting   = 'customer-answer'
        briefId    = $Brief.briefId
        system     = $Brief.system
        questionId = $Question.id
        prompt     = $Question.prompt
        why        = $Question.why
        choices    = @(Get-ChaosItems -InputObject $Question.choices | Where-Object { $_ })
        grounded   = [bool]$Question.grounded
        context    = if ($null -ne $context) { "$($context.statement) (read from $($context.citation))" } else { $null }
        rejections = @(Get-ChaosItems -InputObject (Get-ChaosMember -InputObject $Question -Name 'rejections')).Count
        resume     = "-Action answer -BriefId $($Brief.briefId) -QuestionId $($Question.id) -Answer '<the customer's exact words>'"
    }
    Write-Output 'CHAOS-QUESTION-BEGIN'
    Write-Output (Protect-ChaosObject -InputObject ([pscustomobject]$payload) | ConvertTo-Json -Depth 6)
    Write-Output 'CHAOS-QUESTION-END'
}

function Show-ChaosDesignShortlist {
    <#
    .SYNOPSIS
        Print the ranked shortlist the customer chooses from.
    #>
    param([Parameter(Mandatory)][object]$Brief)

    $candidates = @(Get-ChaosItems -InputObject $Brief.candidates)
    foreach ($candidate in $candidates) {
        $availability = Get-ChaosMember -InputObject $candidate -Name 'availability'
        $probe = Get-ChaosMember -InputObject $candidate -Name 'mechanismProbe'
        $body = @(
            "$($candidate.id)  [$([string]$availability.state)]  confidence: $($candidate.confidence)",
            '',
            $candidate.title,
            '',
            "Dependency edge   $($candidate.dependencyEdge)",
            "Code path         $($candidate.codePath)",
            "Mechanism         $($candidate.failureMechanism)",
            "  evidence        $($candidate.mechanismEvidence)",
            "Probe             $($probe.signal) should $($probe.direction)",
            "Hypothesis        $($candidate.hypothesis)",
            "Steady state      $($candidate.steadyStatePredicate)",
            "Platform          $([string]$availability.reason)"
        )
        $matched = @(Get-ChaosItems -InputObject $availability.matchedActions)
        if ($matched.Count -gt 0) {
            $body += "Live actions      $((@($matched | ForEach-Object { $_.name }) | Select-Object -First 5) -join ', ')"
        }
        $collateral = @(Get-ChaosItems -InputObject $candidate.collateralRisks | Where-Object { $_ })
        if ($collateral.Count -gt 0) { $body += "Collateral risk   $($collateral -join '; ')" }
        Write-ChaosStudyCard -Title "Candidate $($candidate.rank) of $($candidates.Count)" -Body ($body -join "`n")
    }

    $first = $candidates | Select-Object -First 1
    if ($null -ne $first) {
        Write-ChaosStudyCard -Title 'Choose one' -Body @"
Nothing is scoped or injected until you choose. Read the shortlist, then confirm
the one you want with the phrase for that candidate - for example:

  -Action confirm -BriefId $($Brief.briefId) -Select $($first.id) ``
      -ConfirmPhrase '$(Get-ChaosDesignConfirmPhrase -Brief $Brief -Candidate $first)'

Confirming seals the brief. If none of these is the study you want, answer the
interview again or supply new candidates - do not confirm one that is close.
"@
    }
}

function Get-ChaosDesignHandoff {
    <#
    .SYNOPSIS
        The scope inputs implied by the confirmed brief.

    .DESCRIPTION
        This is the point of the whole skill: everything established by reading
        the code and everything agreed with the customer, in the shape
        chaos-study-scope takes, so none of it is retyped and none of it drifts
        between the conversation and the plan.

        Abort criteria are carried but not claimed to be enforced. There is no
        platform hook for them, so they are handed over as an operator gate and
        labelled as one, which is honest rather than reassuring.
    #>
    param([Parameter(Mandatory)][object]$Brief, [Parameter(Mandatory)][object]$Candidate)

    $answers = Get-ChaosInterviewSummary -Interview $Brief.interview
    $probe = Get-ChaosMember -InputObject $Candidate -Name 'mechanismProbe'
    $exposure = Get-ChaosMember -InputObject $Candidate -Name 'exposure'
    $blast = Get-ChaosMember -InputObject $Candidate -Name 'blastRadius'

    return [ordered]@{
        purpose              = [string]$answers['purpose']
        impact               = [string]$answers['impact']
        change               = [string]$answers['change']
        environment          = [string]$answers['environment']
        window               = [string]$answers['window']
        traffic              = [string]$answers['traffic']
        destructive          = [string]$answers['destructive']
        candidateId          = [string]$Candidate.id
        hypothesis           = [string]$Candidate.hypothesis
        failureMechanism     = [string]$Candidate.failureMechanism
        mechanismEvidence    = [string]$Candidate.mechanismEvidence
        mechanismProbe       = $probe
        steadyState          = [string]$Candidate.steadyStatePredicate
        signals              = @(Get-ChaosItems -InputObject $Candidate.signals | Where-Object { $_ })
        exposure             = $exposure
        actionRequirements   = Get-ChaosMember -InputObject $Candidate -Name 'actionRequirements'
        # Scenario and action parameters travel separately across the seam
        # because scope validates them against two different live schemas.
        # A candidate that names neither hands off neither - absent stays absent.
        parameters           = Get-ChaosMember -InputObject $Candidate -Name 'parameters'
        actionParameters     = Get-ChaosMember -InputObject $Candidate -Name 'actionParameters'
        discoveryConstraints = Get-ChaosMember -InputObject $Candidate -Name 'availability'
        blastRadius          = [ordered]@{
            filters       = @(Get-ChaosItems -InputObject $blast.filters | Where-Object { $_ })
            exclusions    = @(Get-ChaosItems -InputObject $blast.exclusions | Where-Object { $_ })
            customerLimit = [string]$answers['blast']
        }
        abortCriteria        = [ordered]@{
            statement   = if ([string]::IsNullOrWhiteSpace([string]$answers['abort'])) { [string]$Candidate.abortCriteria } else { [string]$answers['abort'] }
            enforcement = 'operator'
            note        = 'Chaos Studio has no abort hook. This is a manual gate the operator watches during the run.'
        }
        telemetryGaps        = @(Get-ChaosItems -InputObject $Candidate.telemetryGaps | Where-Object { $_ })
        collateralRisks      = @(Get-ChaosItems -InputObject $Candidate.collateralRisks | Where-Object { $_ })
        unresolvedQuestions  = @(Get-ChaosItems -InputObject $Brief.limitations | Where-Object { $_ })
    }
}

try {
    $root = Resolve-ChaosDesignRoot

    switch ($Action) {

        'start' {
            if ([string]::IsNullOrWhiteSpace($System)) { throw 'Starting a brief needs -System, a short name for the system under study.' }
            $brief = New-ChaosBrief -System $System -StudyRoot $root
            $brief = Save-ChaosBrief -Brief $brief -StudyRoot $root
            $path = Get-ChaosBriefFilePath -Brief $brief -StudyRoot $root
            Write-ChaosStudyCard -Title 'Study brief started' -Body @"
Brief    $($brief.briefId)
System   $($brief.system)
State    $($brief.state)
Stored   $path

Next: read the system before asking anyone anything. Inspect the application
code and request path, deployment and configuration, the dependency graph,
retry/fallback/circuit-breaker behaviour, persistence paths, workload and event
rate, existing telemetry and SLIs, and the build identity that is deployed.

Record what you found - with a citation for every claim, and an explicit
"unavailable" entry with a reason for anything you could not read. Then:

  -Action analyze -BriefId $($brief.briefId) -ObservationFile <analysis.json>

The interview stays closed until that is done. Questions asked before the code
is read are generic questions, and generic questions produce generic studies.
"@
        }

        'analyze' {
            $brief = Resolve-ChaosDesignBrief -Root $root
            $raw = Read-ChaosDesignJson -Path $ObservationFile -What 'the system analysis'
            $brief.analysis = ConvertTo-ChaosAnalysis -Raw $raw
            foreach ($gap in @(Get-ChaosItems -InputObject $brief.analysis.unavailable)) {
                Add-ChaosBriefLimitation -Brief $brief -Code "Analysis area '$($gap.area)' could not be read: $($gap.reason)" | Out-Null
            }
            Set-ChaosBriefState -Brief $brief -State 'ANALYZED' | Out-Null
            $brief = Save-ChaosBrief -Brief $brief -StudyRoot $root
            $path = Get-ChaosBriefFilePath -Brief $brief -StudyRoot $root

            $unavailable = @(Get-ChaosItems -InputObject $brief.analysis.unavailable)
            Write-ChaosStudyCard -Title 'System analysis recorded' -Body @"
Observations   $($brief.analysis.observedCount) across $((Get-ChaosAnalysisAreas).Count) areas
Unavailable    $($unavailable.Count) area(s), each with a stated reason
Stored         $path

Next: turn what you read into candidate hypotheses. Each one has to carry the
whole chain - dependency edge, code path, failure mechanism, the evidence it was
read from, the probe that proves it engaged, and a predicate that can be
breached:

  -Action candidates -BriefId $($brief.briefId) -CandidateFile <candidates.json>
"@
        }

        'candidates' {
            $brief = Resolve-ChaosDesignBrief -Root $root
            Assert-ChaosBriefState -Brief $brief -Required 'ANALYZED' -Action 'propose candidates' `
                -Remediation "Record the system analysis first: -Action analyze -BriefId $($brief.briefId) -ObservationFile <analysis.json>" | Out-Null
            $raw = Read-ChaosDesignJson -Path $CandidateFile -What 'the candidate hypotheses'
            $entries = @(Get-ChaosItems -InputObject $raw)
            if ($entries.Count -eq 0) { throw 'DesignIncomplete: the candidate file held no candidates.' }

            $candidates = [System.Collections.Generic.List[object]]::new()
            for ($i = 0; $i -lt $entries.Count; $i++) {
                $candidates.Add((ConvertTo-ChaosCandidate -Raw $entries[$i] -Index $i)) | Out-Null
            }
            $brief.candidates = @(Set-ChaosCandidateRank -Candidates @($candidates))
            Set-ChaosBriefState -Brief $brief -State 'CANDIDATES' | Out-Null
            $brief = Save-ChaosBrief -Brief $brief -StudyRoot $root
            $path = Get-ChaosBriefFilePath -Brief $brief -StudyRoot $root

            Write-ChaosStudyCard -Title 'Candidates recorded' -Body @"
Candidates  $(@($brief.candidates).Count), each with a citable mechanism and a falsifiable predicate
Stored      $path

These are not a recommendation yet. Nothing is shortlisted until the customer
has said what they want to learn and what risk they will accept:

  -Action interview -BriefId $($brief.briefId)
"@
        }

        'interview' {
            $brief = Resolve-ChaosDesignBrief -Root $root
            Assert-ChaosBriefState -Brief $brief -Required 'ANALYZED' -Action 'interview the customer' `
                -Remediation "Read the system first: -Action analyze -BriefId $($brief.briefId) -ObservationFile <analysis.json>. Questions asked before the code is read are generic questions." | Out-Null
            if ($null -eq $brief.interview -or @(Get-ChaosItems -InputObject (Get-ChaosMember -InputObject $brief.interview -Name 'questions')).Count -eq 0) {
                $brief.interview = New-ChaosInterview -Analysis $brief.analysis
                Set-ChaosBriefState -Brief $brief -State 'INTERVIEWING' | Out-Null
                Save-ChaosBrief -Brief $brief -StudyRoot $root | Out-Null
            }
            $question = Get-ChaosNextQuestion -Interview $brief.interview
            if ($null -eq $question) {
                Write-ChaosStudyCard -Title 'Interview complete' -Body @"
Every question is answered or was established by reading the system.

  -Action recommend -BriefId $($brief.briefId) [-SubscriptionId .. -ResourceGroup .. -WorkspaceName ..]
"@
            } else {
                Show-ChaosDesignQuestion -Question $question -Brief $brief
                # A surfaced question is a pause, not success. Exiting 0 here is
                # what let orchestrators walk straight past the interview.
                $exitCode = Get-ChaosStudyExitCode -Name 'AwaitingCustomerInput'
            }
        }

        'answer' {
            $brief = Resolve-ChaosDesignBrief -Root $root
            Assert-ChaosBriefState -Brief $brief -Required 'INTERVIEWING' -Action 'answer an interview question' `
                -Remediation "Open the interview first: -Action interview -BriefId $($brief.briefId)" | Out-Null
            if ([string]::IsNullOrWhiteSpace($QuestionId)) { throw 'Answering needs -QuestionId.' }

            $vocabulary = Get-ChaosAnalysisVocabulary -Analysis $brief.analysis
            $result = Set-ChaosInterviewAnswer -Interview $brief.interview -QuestionId $QuestionId -Answer $Answer -Vocabulary $vocabulary
            Save-ChaosBrief -Brief $brief -StudyRoot $root | Out-Null

            if (-not $result.verdict.accepted) {
                # Not an error - a refusal. The question stays open and is asked
                # again, which is the entire point of interviewing rather than
                # collecting.
                Write-ChaosStudyCard -Title "Answer not accepted ($QuestionId)" -Body @"
$($result.verdict.reason)

$($result.verdict.suggestion)

The question is still open. Answer it again:
  -Action answer -BriefId $($brief.briefId) -QuestionId $QuestionId -Answer '<your answer>'
"@
                $exitCode = Get-ChaosStudyExitCode -Name 'DesignIncomplete'
            } else {
                $next = Get-ChaosNextQuestion -Interview $brief.interview
                if ($null -eq $next) {
                    Write-ChaosStudyCard -Title 'Interview complete' -Body @"
Recorded: $QuestionId

Every question is answered. Next, intersect what you want with what the platform
can actually do here:

  -Action recommend -BriefId $($brief.briefId) [-SubscriptionId .. -ResourceGroup .. -WorkspaceName ..]
"@
                } else {
                    Write-ChaosStudyNote -Message "Recorded '$QuestionId'." -Level Info
                    Show-ChaosDesignQuestion -Question $next -Brief $brief
                    $exitCode = Get-ChaosStudyExitCode -Name 'AwaitingCustomerInput'
                }
            }
        }

        'recommend' {
            $brief = Resolve-ChaosDesignBrief -Root $root
            Assert-ChaosBriefState -Brief $brief -Required 'INTERVIEWING' -Action 'recommend a study' `
                -Remediation "Interview the customer first: -Action interview -BriefId $($brief.briefId)" | Out-Null
            if (-not (Test-ChaosInterviewComplete -Interview $brief.interview)) {
                $open = Get-ChaosNextQuestion -Interview $brief.interview
                throw "DesignIncomplete: the interview is not finished - '$($open.id)' is still open. A recommendation made before the customer has said what they want to learn is a guess wearing a shortlist."
            }
            if (@(Get-ChaosItems -InputObject $brief.candidates).Count -eq 0) {
                throw 'DesignIncomplete: there are no candidates to recommend. Supply them with -Action candidates first.'
            }

            $discovery = Invoke-ChaosDesignDiscovery -Root $root
            $brief.candidates = @(Resolve-ChaosCandidateAvailability -Candidates @(Get-ChaosItems -InputObject $brief.candidates) `
                    -Actions $discovery.actions -Scenarios $discovery.scenarios -UnavailableReason $discovery.reason)
            $brief.candidates = @(Set-ChaosCandidateRank -Candidates @($brief.candidates))

            if ($null -eq $discovery.actions) {
                Add-ChaosBriefLimitation -Brief $brief -Code "L15: candidates are provisional - $($discovery.reason)" | Out-Null
                Write-ChaosStudyNote -Message "Candidates are PROVISIONAL. $($discovery.reason)" -Level Warn
            } else {
                $brief.recommendation = [ordered]@{ region = $discovery.region; actionCount = @($discovery.actions).Count; discoveredAt = Get-ChaosUtcNow }
            }

            Set-ChaosBriefState -Brief $brief -State 'RECOMMENDED' | Out-Null
            Save-ChaosBrief -Brief $brief -StudyRoot $root | Out-Null
            Show-ChaosDesignShortlist -Brief $brief
            # Still a pause: a shortlist is not a decision. Nothing may be scoped
            # until the customer picks one and types the phrase back.
            $exitCode = Get-ChaosStudyExitCode -Name 'AwaitingCustomerInput'
        }

        'confirm' {
            $brief = Resolve-ChaosDesignBrief -Root $root
            Assert-ChaosBriefState -Brief $brief -Required 'RECOMMENDED' -Action 'confirm a study' `
                -Remediation "Produce the shortlist first: -Action recommend -BriefId $($brief.briefId)" | Out-Null
            if ([string]::IsNullOrWhiteSpace($Select)) { throw 'Confirming needs -Select naming the candidate you chose.' }

            $candidate = Get-ChaosCandidateById -Candidates @(Get-ChaosItems -InputObject $brief.candidates) -Reference $Select
            $expected = Get-ChaosDesignConfirmPhrase -Brief $brief -Candidate $candidate
            if ([string]$ConfirmPhrase -cne $expected) {
                Write-ChaosStudyFailure -Title 'Study not confirmed' `
                    -Message 'The confirmation phrase did not match this candidate exactly (comparison is case-sensitive).' `
                    -Remediation "To confirm candidate $($candidate.id), pass this phrase exactly:`n`n  -ConfirmPhrase '$expected'`n`nThe phrase carries the brief hash, so it cannot be typed before the shortlist was read."
                $exitCode = Get-ChaosStudyExitCode -Name 'ConsentDeclined'
                break
            }

            $brief.confirmation = [ordered]@{
                confirmedAt = Get-ChaosUtcNow
                candidateId = [string]$candidate.id
                phrase      = $expected
                briefHash   = [string]$brief.briefHash
            }
            $brief.handoff = Get-ChaosDesignHandoff -Brief $brief -Candidate $candidate
            Set-ChaosBriefState -Brief $brief -State 'CONFIRMED' | Out-Null
            $brief = Save-ChaosBrief -Brief $brief -StudyRoot $root -AllowConfirmed
            $path = Get-ChaosBriefFilePath -Brief $brief -StudyRoot $root

            $availability = Get-ChaosMember -InputObject $candidate -Name 'availability'
            $note = if ([string]$availability.state -eq 'provisional') {
                "`nThe chosen candidate is PROVISIONAL: $([string]$availability.reason)`nScope will run live discovery and will stop if the platform cannot do this."
            } else { '' }

            Write-ChaosStudyCard -Title 'Study confirmed' -Body @"
Candidate  $($candidate.id) - $($candidate.title)
Brief      $path (sealed)
$note
Hand this straight to scoping - nothing here needs retyping:

  ../../chaos-study-scope/scripts/Invoke-ChaosStudyScope.ps1 ``
      -SubscriptionId <sub> -ResourceGroup <rg> -WorkspaceName <ws> ``
      -Brief '$path'

Explicit arguments still win over the brief, so scope can be adjusted without
editing what the customer agreed to.

Abort criteria: $($brief.handoff.abortCriteria.statement)
  Enforcement is manual - Chaos Studio has no abort hook. Someone watches it.
"@
        }

        'show' {
            $brief = Resolve-ChaosDesignBrief -Root $root
            $file = Get-ChaosBriefFile -BriefPath (Get-ChaosBriefPath -BriefId ([string]$brief.briefId) -StudyRoot $root)
            Write-ChaosStudyCard -Title "Brief $($brief.briefId)" -Body @"
System       $($brief.system)
State        $($brief.state)
Created      $($brief.createdAt)
Updated      $($brief.updatedAt)
Candidates   $(@(Get-ChaosItems -InputObject $brief.candidates).Count)
Limitations  $(@(Get-ChaosItems -InputObject $brief.limitations).Count)
File         $($file.path)
"@
            if (@(Get-ChaosItems -InputObject $brief.candidates).Count -gt 0) { Show-ChaosDesignShortlist -Brief $brief }
        }

        'list' {
            $index = @(Get-ChaosBriefIndex -StudyRoot $root)
            if ($index.Count -eq 0) {
                Write-ChaosStudyNote -Message "No briefs under $root yet." -Level Info
            } else {
                $index | ForEach-Object { "{0}  {1,-24} {2,-14} {3}" -f $_.briefId, $_.system, $_.state, $_.updatedAt }
            }
        }
    }
} catch {
    $message = [string]$_.Exception.Message
    if ($message -like 'DesignIncomplete:*') {
        Write-ChaosStudyFailure -Title 'Design step incomplete' -Message ($message -replace '^DesignIncomplete:\s*', '') `
            -Remediation 'Design is deliberately ordered: read the system, then ask, then recommend. Complete the step above and run this command again.'
        $exitCode = Get-ChaosStudyExitCode -Name 'DesignIncomplete'
    } elseif ($message -like 'BriefAlreadyConfirmed:*') {
        Write-ChaosStudyFailure -Title 'Brief already confirmed' -Message ($message -replace '^BriefAlreadyConfirmed:\s*', '') `
            -Remediation 'A confirmed brief is sealed so the confirmation keeps referring to what the customer actually saw. Start a new brief for a different study.'
        $exitCode = Get-ChaosStudyExitCode -Name 'StudyAlreadySealed'
    } else {
        Write-ChaosStudyFailure -Title 'Study design failed' -Message $message -Remediation 'Nothing was scoped or injected. Fix the cause above and run this step again.'
        $exitCode = Get-ChaosStudyExitCode -Name 'Error'
    }
}

exit $exitCode
