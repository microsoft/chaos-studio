---
name: chaos-study-design
description: "Decide what a Chaos reliability study should actually test. Reads the system's code, deployment and telemetry first, then interviews the customer about what they want to learn, and only then recommends a ranked set of Chaos Studio V2 scenario candidates grounded in real dependency edges. Produces a durable study brief that feeds chaos-study-scope without retyping."
---

# chaos-study-design — what should we test, and why?

Most failed reliability studies fail before anything is injected. Someone picks a
fault because it is available, runs it, sees nothing, and concludes the system is
resilient. This skill exists to make that outcome impossible: it forces the
question *what would we learn?* to be answered — in the customer's own words and
against the customer's own code — before a scenario is ever chosen.

## Principles

**Read before you ask.** Analysis always precedes the interview. Asking a
customer "what are your dependencies?" when their repository is sitting right
there wastes their time and produces worse answers than reading it. Eight areas
are inspected: code, deployment, dependencies, resilience behaviour, persistence,
workload, telemetry, and identity.

**Unavailable is not unknown.** Each area is either *observed* with a citation —
a file, a symbol, a config key — or explicitly declared *unavailable* with a
reason. Silence is rejected: `analyze` exits `24` and names every area left
unaccounted for. A candidate hypothesis may never rest on evidence nobody read.

**Grill, don't survey.** "Test resilience" is not a goal. Nine questions are
asked one at a time, in dependency order, and vague answers are refused rather
than recorded. Four of them are *grounded*: the answer must engage with the
customer's own system vocabulary — the services, dependencies and signals
analysis actually found — not generic reliability language.

**Never ask what you already know.** A question that analysis already answered is
pre-filled and marked `establishedBy`. The customer is asked only for what only
they can supply: intent, business impact, risk appetite, abort criteria.

**Candidates are code-grounded or they are not candidates.** Every candidate
carries eight mandatory fields — dependency edge, failure mechanism, mechanism
evidence, mechanism probe, steady-state predicate, exposure inputs, collateral
risks, and abort criteria. A candidate missing any of them is rejected at
construction, not at review.

**The platform is asked, never assumed.** Candidates are intersected with live
regional action discovery, workspace-discovered resources, and
workspace-recommended scenarios. When Azure cannot be reached, candidates are
marked `provisional`, limitation `L15` is recorded, and the brief says plainly
that platform availability is unconfirmed. No bundled catalogue, ever.

**The customer chooses.** Two to four ranked candidates are presented with
rationale and tradeoffs. Nothing is recommended as final until the customer
returns an exact confirmation phrase bound to the brief hash. On confirmation the
brief seals: the phrase keeps referring to what they actually saw.

## Usage

Design is the first phase, and the front door drives it for you — that is the
recommended path, because it also enforces the ordering:

```powershell
../chaos-study/scripts/Invoke-ChaosStudy.ps1 -System "orders-api"
```

The actions below are the same machine, exposed for expert use. Whichever route
you take, exit `26` means **the study is waiting on a person**: one question is
open. Ask the customer that single question with the host's interactive
mechanism (`ask_user` where available), wait for their reply, pass it back with
`-Answer`, and repeat. Never batch the questions into one message, never answer
on the customer's behalf, and never treat `26` as a failure.

### 1. Start a brief

```powershell
./scripts/Invoke-ChaosStudyDesign.ps1 -Action start -System "orders-api"
```

Prints a `briefId`. Every later action takes `-BriefId`.

### 2. Record what you read

```powershell
./scripts/Invoke-ChaosStudyDesign.ps1 -Action analyze -BriefId <id> `
  -Observed 'code=src/Orders/PaymentGateway.cs:14 Charge() has no retry or timeout' `
  -Observed 'dependencies=orders-api -> payments-api (synchronous, in request path)' `
  -Observed 'telemetry=metrics:checkoutSuccessRate, metrics:paymentGatewayErrors' `
  -Unavailable 'identity=no access to the subscription from this session'
```

Repeat `-Observed`/`-Unavailable` per area. All eight must be accounted for.

### 3. Propose candidates

```powershell
./scripts/Invoke-ChaosStudyDesign.ps1 -Action candidates -BriefId <id> -CandidateFile ./candidates.json
```

Each candidate needs the eight required fields. Ranking is computed:
availability, then confidence, then evidence count, then whether exposure is
computable. Pass `-Region`/`-Workspace` to intersect with live discovery.

### 4. Interview

```powershell
./scripts/Invoke-ChaosStudyDesign.ps1 -Action interview -BriefId <id>
./scripts/Invoke-ChaosStudyDesign.ps1 -Action answer -BriefId <id> -QuestionId purpose -Answer "..."
```

`interview` prints the single next open question and exits `26`. The question is
also emitted between `CHAOS-QUESTION-BEGIN` / `CHAOS-QUESTION-END` as JSON —
`questionId`, `prompt`, `why`, `choices`, `grounded` — so an orchestrator can
ask exactly one question without parsing prose. When `choices` is present the
answer must be one of them verbatim. `answer` accepts or refuses; a refusal
leaves the question open and exits `24` — it is not an error, it is the skill
doing its job.

### 5. Recommend, then confirm

```powershell
./scripts/Invoke-ChaosStudyDesign.ps1 -Action recommend -BriefId <id>
./scripts/Invoke-ChaosStudyDesign.ps1 -Action confirm -BriefId <id> `
  -Select <candidateId> -ConfirmPhrase "study <candidateId> on <system> <hash8>"
```

`recommend` requires every question answered, and exits `26` because the choice
is the customer's to make. `confirm` requires the exact case-sensitive phrase
printed by `recommend`.

### 6. Hand off

```powershell
../chaos-study-scope/scripts/Invoke-ChaosStudyScope.ps1 -Brief <briefPath> -Workspace ... -ResourceGroup ...
```

Scope reads the confirmed brief for hypothesis, steady state, failure mechanism,
mechanism evidence, mechanism probe, exposure inputs, scenario parameters, blast
radius and windows. Anything passed explicitly on the command line wins, so the
brief is a starting point rather than a cage.

## Artifacts

Briefs live at `<studyRoot>/briefs/<briefId>/study-brief.v1.json`, alongside but
separate from studies — a brief exists before there is a workspace to hash. The
brief carries `briefVersion`, `state`, the analysis with citations, candidates,
the interview transcript including refusals, the recommendation, the customer
confirmation, and `briefHash`.

States advance monotonically:
`DRAFT → ANALYZED → CANDIDATES → INTERVIEWING → RECOMMENDED → CONFIRMED`.
A confirmed brief is immutable; further writes exit `13`.

## Exit codes

| Code | Meaning |
|------|---------|
| `0`  | Success |
| `1`  | Unexpected failure |
| `13` | Brief already confirmed — start a new one |
| `24` | Design incomplete — unaccounted area, vague answer, or missing field |
| `26` | Awaiting customer input — a question is on the table. Not a failure. Ask it, then resume. |

## What this skill does not do

It never contacts Azure to mutate anything, never creates a workspace, never
validates a configuration and never injects a fault. It reads, asks, ranks and
records. Everything with a blast radius belongs to `chaos-study-scope` and
`chaos-study-run`, behind their own consent gates.
