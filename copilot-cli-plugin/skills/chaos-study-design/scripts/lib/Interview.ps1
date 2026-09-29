# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

<#
.SYNOPSIS
    The interview: one question at a time, and a refusal to accept a vague goal.

.DESCRIPTION
    The interview exists because the most common way a chaos study wastes a
    maintenance window is that nobody ever said what it was for. "Test
    resilience" survives a planning meeting because it sounds like an answer.
    It is not one: it names no dependency, predicts no failure, and cannot come
    back false, so whatever the run does afterwards will be reported as a
    success.

    So this file is deliberately hard to satisfy. It asks one question at a
    time, it tells the customer why it is asking, and when an answer is too
    vague to design against it says so and asks again - with an example built
    from that customer's own code rather than from a textbook.

    Two rules keep it from being an interrogation:

      * Anything the analysis already established is not asked. If the code
        showed the retry policy, the customer is told what was found, not quizzed
        on it.
      * Every question carries the concrete finding that prompted it, so the
        customer is answering about their system rather than about chaos
        engineering.

    Requires Common.ps1 and Inspect.ps1 to be dot-sourced first.
#>

Set-StrictMode -Version Latest

# Phrases that look like goals but cannot be designed against. Matched against
# the whole answer, so "test resilience of the payment retry path" passes and
# "test resilience" does not.
$ChaosVagueGoalPatterns = @(
    '^\s*(just\s+)?(to\s+)?(test|check|verify|validate|prove|see|try|do)?\s*(out\s+)?(the\s+|our\s+|its\s+|their\s+)?(chaos|resilience|resiliency|reliability|robustness|stability|availability|ha|high\s+availability|failover|fault\s+tolerance|dr|disaster\s+recovery)\s*(testing|test|stuff|things)?\s*[.!]?\s*$',
    '^\s*(make\s+sure|ensure|confirm)\s+(it|everything|the\s+system|the\s+service|things)\s+(works|is\s+fine|is\s+ok|is\s+okay|stays\s+up|doesn''?t\s+break)\s*[.!]?\s*$',
    '^\s*(we\s+)?(want|need)\s+(to\s+)?(be\s+)?(more\s+)?(resilient|reliable|robust)\s*[.!]?\s*$',
    '^\s*(general|generic|standard|routine|usual)\s+(chaos|resilience|reliability)?\s*(test|testing|study|exercise)?\s*[.!]?\s*$',
    '^\s*(idk|dunno|not\s+sure|no\s+idea|whatever|anything|everything|all\s+of\s+it)\s*[.!]?\s*$'
)

$ChaosMinimumAnswerLength = 25

function Get-ChaosInterviewQuestions {
    <#
    .SYNOPSIS
        The question bank, in the order it is asked.

    .DESCRIPTION
        Order matters. Purpose comes first because every later question is a
        constraint on it: there is no useful answer to "what blast radius is
        acceptable" until it is known what the run is trying to learn.

        Fields:
          id            stable key, used by -Answer
          prompt        what is asked
          why           why this question exists, printed with it
          grounded      the answer must reference something concrete
          establishedBy analysis area that can answer this without asking
          choices       closed set, when the answer really is a small set
    #>
    return @(
        [ordered]@{
            id       = 'purpose'
            prompt   = 'What do you want to learn from this run that you do not already know?'
            why      = 'A study has to be able to come back false. If the answer is a goal rather than a question, there is no result that would surprise you, and the run cannot teach you anything.'
            grounded = $true
            establishedBy = $null
            choices  = @()
        },
        [ordered]@{
            id       = 'impact'
            prompt   = 'Which customer-visible or business impact are you worried about here?'
            why      = 'This becomes the steady-state predicate. "Checkout success rate" is measurable and can be breached; "the service is healthy" cannot.'
            grounded = $true
            establishedBy = $null
            choices  = @()
        },
        [ordered]@{
            id       = 'change'
            prompt   = 'Is there a specific change, fix or control you are trying to validate? If so, which one?'
            why      = 'Validating a specific control gives the run a sharp expected outcome. Answer "none" if this is exploratory - that is a legitimate answer, it just changes how the result is read.'
            grounded = $false
            establishedBy = $null
            choices  = @()
        },
        [ordered]@{
            id       = 'environment'
            prompt   = 'Is this production, pre-production, or a non-production environment?'
            why      = 'A non-production result carries a representativeness limitation into the report. Better to state it now than to discover it while reading the verdict.'
            grounded = $false
            establishedBy = 'deployment'
            choices  = @('production', 'pre-production', 'non-production')
        },
        [ordered]@{
            id       = 'blast'
            prompt   = 'What is the largest acceptable blast radius - which resources, how many, and is any data loss acceptable?'
            why      = 'This becomes the configuration filters and exclusions. Anything not excluded here is in scope for real.'
            grounded = $true
            establishedBy = $null
            choices  = @()
        },
        [ordered]@{
            id       = 'abort'
            prompt   = 'What would make you stop the run immediately? Give a threshold you could watch.'
            why      = 'An abort criterion nobody can measure is not one. Naming it now is what makes stopping a decision rather than a panic.'
            grounded = $true
            establishedBy = $null
            choices  = @()
        },
        [ordered]@{
            id       = 'window'
            prompt   = 'When can this run? Name the maintenance window or say "any time".'
            why      = 'Timing decides whether the run sees representative traffic, and whether the people who can respond are awake.'
            grounded = $false
            establishedBy = $null
            choices  = @()
        },
        [ordered]@{
            id       = 'traffic'
            prompt   = 'Will traffic during that window be representative of the load you care about?'
            why      = 'A fault injected into an idle system exercises nothing. If traffic will be light, the study needs to say so rather than reporting the silence as resilience.'
            grounded = $false
            establishedBy = $null
            choices  = @()
        },
        [ordered]@{
            id       = 'destructive'
            prompt   = 'Are destructive or one-shot actions acceptable - restarts, failovers, deletions - or must this be limited to reversible ones?'
            why      = 'Discrete actions cannot be cancelled once started, so this is a different risk decision from a continuous, cancellable one.'
            grounded = $false
            establishedBy = $null
            choices  = @('reversible-only', 'destructive-allowed')
        }
    )
}

function New-ChaosInterview {
    <#
    .SYNOPSIS
        Build the interview for one brief, pre-filling anything the analysis
        already established and attaching the finding behind each question.
    #>
    param([Parameter(Mandatory)][AllowNull()][object]$Analysis)

    $questions = [System.Collections.Generic.List[object]]::new()
    foreach ($template in (Get-ChaosInterviewQuestions)) {
        $established = $null
        $status = 'pending'
        $answer = $null
        if ($template.establishedBy) {
            $fact = Get-ChaosAnalysisFact -Analysis $Analysis -Area ([string]$template.establishedBy)
            if ($fact.established) {
                # Established by reading, not by asking. The customer still sees
                # it - as a statement to correct, not a question to answer.
                $established = [ordered]@{ statement = $fact.statement; citation = $fact.citation }
                $status = 'established'
                $answer = $fact.statement
            }
        }
        $questions.Add([ordered]@{
            id          = [string]$template.id
            prompt      = [string]$template.prompt
            why         = [string]$template.why
            grounded    = [bool]$template.grounded
            choices     = @($template.choices)
            context     = Get-ChaosQuestionContext -QuestionId ([string]$template.id) -Analysis $Analysis
            status      = $status
            answer      = $answer
            established = $established
            attempts    = 0
            rejections  = @()
            answeredAt  = $null
        }) | Out-Null
    }

    return [ordered]@{
        startedAt   = Get-ChaosUtcNow
        completedAt = $null
        questions   = @($questions)
    }
}

function Get-ChaosQuestionContext {
    <#
    .SYNOPSIS
        The concrete finding that makes this question worth asking of THIS
        customer.

    .DESCRIPTION
        A question with no context is a form. A question that says "your order
        service calls the payment API with a 3-retry policy and no circuit
        breaker - what do you want to learn?" is a conversation. Returns $null
        when the analysis established nothing relevant, and the question is then
        asked plainly rather than with a fabricated preamble.
    #>
    param(
        [Parameter(Mandatory)][string]$QuestionId,
        [Parameter(Mandatory)][AllowNull()][object]$Analysis
    )
    $area = switch ($QuestionId) {
        'purpose'     { 'dependencies' }
        'impact'      { 'telemetry' }
        'change'      { 'resilience' }
        'blast'       { 'persistence' }
        'abort'       { 'telemetry' }
        'traffic'     { 'workload' }
        'destructive' { 'persistence' }
        'environment' { 'deployment' }
        default       { $null }
    }
    if (-not $area) { return $null }
    $fact = Get-ChaosAnalysisFact -Analysis $Analysis -Area $area
    if (-not $fact.established) { return $null }
    return [ordered]@{ from = $area; statement = $fact.statement; citation = $fact.citation }
}

function Test-ChaosAnswerSubstance {
    <#
    .SYNOPSIS
        Decide whether an answer is specific enough to design a study against.

    .DESCRIPTION
        Returns { accepted, reason, suggestion }. Three tests, cheapest first:

          1. Length. A one-word answer to "what do you want to learn" is not an
             answer, whatever the word is.
          2. Known-vague phrasing. "Test resilience" and its relatives.
          3. Groundedness. For questions marked grounded, the answer has to
             touch something real: a name the analysis found, or a number.
             This is the test that catches fluent-but-empty answers, which are
             the ones that survive review.

        Truthfulness is not testable here and is not attempted. What is testable
        is whether the answer could be acted on, and that is what this returns.
    #>
    param(
        [Parameter(Mandatory)][object]$Question,
        [Parameter(Mandatory)][AllowEmptyString()][string]$Answer,
        [string[]]$Vocabulary = @()
    )

    $text = ([string]$Answer).Trim()
    $accept = { param($why) [pscustomobject]@{ accepted = $true; reason = $why; suggestion = $null } }
    $reject = { param($why, $how) [pscustomobject]@{ accepted = $false; reason = $why; suggestion = $how } }

    $choices = @(Get-ChaosItems -InputObject (Get-ChaosMember -InputObject $Question -Name 'choices') | Where-Object { $_ })
    if ($choices.Count -gt 0) {
        # A closed question is judged only against its choices; length and
        # groundedness are meaningless for "production".
        $match = $choices | Where-Object { $_ -eq $text } | Select-Object -First 1
        if ($match) { return & $accept 'matched one of the offered choices' }
        return & $reject "'$text' is not one of the offered answers." "Answer with exactly one of: $($choices -join ', ')."
    }

    if ([string]::IsNullOrWhiteSpace($text)) {
        return & $reject 'the answer is empty.' 'Say what you actually want, even roughly - it will be sharpened by the next questions.'
    }

    foreach ($pattern in $ChaosVagueGoalPatterns) {
        if ($text -match $pattern) {
            return & $reject "'$text' is a goal, not a question. There is no result that would count as failing it, so a run against it cannot teach you anything." (Get-ChaosAnswerExample -QuestionId ([string]$Question.id) -Vocabulary $Vocabulary)
        }
    }

    if (-not [bool](Get-ChaosMember -InputObject $Question -Name 'grounded')) {
        return & $accept 'the question does not require a grounded answer'
    }

    if ($text.Length -lt $ChaosMinimumAnswerLength) {
        return & $reject "the answer is $($text.Length) characters, which is too short to name what is being tested." (Get-ChaosAnswerExample -QuestionId ([string]$Question.id) -Vocabulary $Vocabulary)
    }

    $hasNumber = $text -match '\d'
    $hasName = $false
    foreach ($word in $Vocabulary) {
        if ([string]::IsNullOrWhiteSpace($word)) { continue }
        if ($text -match ('(?i)' + [regex]::Escape($word))) { $hasName = $true; break }
    }
    if (-not $hasNumber -and -not $hasName) {
        return & $reject 'the answer does not mention anything the analysis actually found - no component, dependency, signal or number from your system.' (Get-ChaosAnswerExample -QuestionId ([string]$Question.id) -Vocabulary $Vocabulary)
    }

    return & $accept 'the answer names something concrete'
}

function Get-ChaosAnswerExample {
    <#
    .SYNOPSIS
        A worked example of a good answer, built from this customer's own
        analysis where possible.

    .DESCRIPTION
        Rejecting an answer without showing what a better one looks like just
        produces a longer version of the same answer. When the analysis found
        real names, they are used; when it did not, the example says <dependency>
        rather than inventing a plausible-sounding service name.
    #>
    param(
        [Parameter(Mandatory)][string]$QuestionId,
        [string[]]$Vocabulary = @()
    )
    $name = @($Vocabulary | Where-Object { $_ -and $_.Length -gt 4 } | Select-Object -First 1)
    $thing = if ($name.Count -gt 0) { $name[0] } else { '<dependency>' }
    switch ($QuestionId) {
        'purpose' { return "Try something like: 'whether orders still complete when $thing is unreachable for 10 minutes, or whether the retry budget exhausts and requests start failing'." }
        'impact'  { return "Try something like: 'checkout success rate stays above 99.5% - below that customers see errors'." }
        'blast'   { return "Try something like: 'one replica in westus2 only, no writes to $thing, no data loss acceptable'." }
        'abort'   { return "Try something like: 'stop if error rate exceeds 5% for two consecutive minutes'." }
        default   { return "Name a component, a signal or a number so the answer can be designed against - for example $thing." }
    }
}

function Set-ChaosInterviewAnswer {
    <#
    .SYNOPSIS
        Record an answer, or reject it and keep the question open.

    .DESCRIPTION
        Rejections are recorded on the question rather than discarded, which is
        what makes the interview persistent instead of merely repetitive: the
        brief carries the fact that a vague answer was given and refused, and
        the next prompt can escalate rather than restart.

        Returns { question, verdict }.
    #>
    param(
        [Parameter(Mandatory)][object]$Interview,
        [Parameter(Mandatory)][string]$QuestionId,
        [Parameter(Mandatory)][AllowEmptyString()][string]$Answer,
        [string[]]$Vocabulary = @()
    )
    $question = @(Get-ChaosItems -InputObject $Interview.questions) | Where-Object { $_ -and [string](Get-ChaosMember -InputObject $_ -Name 'id') -eq $QuestionId } | Select-Object -First 1
    if ($null -eq $question) {
        throw "Unknown interview question '$QuestionId'. Known: $((@(Get-ChaosItems -InputObject $Interview.questions) | ForEach-Object { $_.id }) -join ', ')."
    }

    $verdict = Test-ChaosAnswerSubstance -Question $question -Answer $Answer -Vocabulary $Vocabulary
    $question.attempts = [int](Get-ChaosMember -InputObject $question -Name 'attempts') + 1
    if ($verdict.accepted) {
        $question.answer = ([string]$Answer).Trim()
        $question.status = 'answered'
        $question.answeredAt = Get-ChaosUtcNow
    } else {
        $question.status = 'rejected'
        $rejections = @(Get-ChaosItems -InputObject (Get-ChaosMember -InputObject $question -Name 'rejections'))
        $rejections += [ordered]@{ at = Get-ChaosUtcNow; answer = ([string]$Answer).Trim(); reason = [string]$verdict.reason }
        $question.rejections = @($rejections)
    }
    return [pscustomobject]@{ question = $question; verdict = $verdict }
}

function Get-ChaosNextQuestion {
    <#
    .SYNOPSIS
        The single next question to ask, or $null when the interview is done.

    .DESCRIPTION
        One at a time is the point. Printing all nine at once produces nine
        one-word answers; printing one produces a conversation.
    #>
    param([Parameter(Mandatory)][object]$Interview)
    foreach ($question in @(Get-ChaosItems -InputObject $Interview.questions)) {
        if ($null -eq $question) { continue }
        $status = [string](Get-ChaosMember -InputObject $question -Name 'status')
        if ($status -eq 'pending' -or $status -eq 'rejected') { return $question }
    }
    return $null
}

function Test-ChaosInterviewComplete {
    <#
    .SYNOPSIS
        True when every question is answered or was established by analysis.
    #>
    param([Parameter(Mandatory)][object]$Interview)
    return ($null -eq (Get-ChaosNextQuestion -Interview $Interview))
}

function Get-ChaosInterviewSummary {
    <#
    .SYNOPSIS
        The answered interview as { questionId = answer }, for the brief and the
        handoff.
    #>
    param([Parameter(Mandatory)][object]$Interview)
    $summary = [ordered]@{}
    foreach ($question in @(Get-ChaosItems -InputObject $Interview.questions)) {
        if ($null -eq $question) { continue }
        $summary[[string](Get-ChaosMember -InputObject $question -Name 'id')] = [string](Get-ChaosMember -InputObject $question -Name 'answer')
    }
    return $summary
}
