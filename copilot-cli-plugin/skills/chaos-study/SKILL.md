---
name: chaos-study
description: "Run a complete Chaos reliability study against an Azure workspace scope: frame a falsifiable steady-state question, discover the actions Chaos Studio actually offers for that region live, freeze a plan, execute a validated scenario configuration with explicit consent, collect before/during/after evidence, and produce a self-contained HTML report. Start here for 'is my service actually resilient to X?' questions."
---

# chaos-study — reliability studies, end to end

Chaos engineering is an experiment in the scientific sense, not a stunt. This
skill runs it: it asks a question that can be proven **wrong**, executes a real
action against real resources, and reports what the evidence actually showed.

> Does **`<steady state>`** hold when I execute **`<action>`** across
> **`<workspace scope>`**?

You do not need that sentence to start — the front door builds it with you.
"Test resilience" is not a study: nothing could falsify it.

## Principles

**A study is a falsifiable claim.** Every study needs a steady-state predicate
measurable beforehand that could plausibly break during the run.

**What to test is decided before it is scoped, and never by this skill alone.**
Picking an action because it is available is how studies end up proving nothing.
The front door therefore *always* runs design first: it reads the system, then
stops and asks you, one question at a time, until the purpose and the risk you
will accept are stated in your own words and confirmed. There is no flag that
skips the interview.

**The platform decides what is possible, not this plugin.** The available
actions are read live from Chaos Studio for the workspace's region, every time.
This suite ships **no** action catalogue, and there is no offline fallback: if
the service cannot be asked, scoping stops with exit `16` rather than guessing.
Likewise the resources a run will touch come from the workspace's discovered
resources, not from an assertion in the plan.

**Evidence beats vibes.** A verdict is only as good as the signals behind it. If
a signal was not collected, the report says *not measured* — never `0`, never a
plausible-looking guess.

**Nothing runs without consent.** `-DryRun` defaults to `$true`. Arming a study
takes both `-DryRun:$false` and typing back the exact phrase the plan prints.
There is no flag that skips this.

**Blast radius is bounded before it is armed.** Workspace, scope, filters,
exclusions, action, parameters and duration are frozen into the plan and hashed.
If the plan changed after you approved it, the run refuses.

## The six skills

This is a suite, not a monolith. Use the front door — it is the only path that
enforces the design gate. Calling a phase skill directly is the expert escape
hatch and skips that enforcement deliberately.

| Skill | Owns |
| --- | --- |
| **chaos-study** | chains the phases below; the default entry point |
| **chaos-study-design** | reading the system, interviewing you, recommending what to test |
| **chaos-study-scope** | workspace, scope, live action discovery, freezing the plan |
| **chaos-study-run** | configuration, validation, consent, execution, evidence |
| **chaos-study-report** | interpretation, findings, the HTML report |
| **chaos-study-history** | list, compare, and re-run past studies |

Each phase persists its own output, so a chain that fails partway resumes there.

## Usage

**1. Name the system. That is all you start with.** The front door always opens
the design phase first: it reads the system, ranks candidate hypotheses against
real dependency edges, then holds the study at **exactly one question**:

```powershell
./scripts/Invoke-ChaosStudy.ps1 -System orders-api `
    -SubscriptionId $sub -ResourceGroup rg-prod -WorkspaceName ws-payments
```

Exit **26** means the study is open and waiting on a person — not that it
failed. One question is printed, and repeated in a `CHAOS-QUESTION` JSON block.
**Put that question to the customer with `ask_user`** (or your host's equivalent
interactive mechanism), wait for the reply, then resume the same brief:

```powershell
./scripts/Invoke-ChaosStudy.ps1 -System orders-api -BriefId <id> `
    -QuestionId <id from the block> -Answer '<what they actually said>'
```

One question per turn. Do not batch them, do not print a questionnaire, do not
answer on the customer's behalf, and do not fall through to scoping. Exit **24**
means the answer was too vague to test and the same question is still open.
Passing `-Scenario`/`-Action` up front does **not** bypass any of this: nothing
is scoped until the brief is `CONFIRMED` by the customer.

**2. Ask the platform what it can do here.** The answer depends on the region and
what is in scope, and changes as Chaos Studio ships new actions:

```powershell
./scripts/Invoke-ChaosStudy.ps1 -ListActions `
    -SubscriptionId $sub -ResourceGroup rg-prod -WorkspaceName ws-payments
# ...and -ListScenarios for the scenarios the workspace recommends
```

Each action is printed with its canonical id, type, what it applies to and its
parameter schema — all as the service reported them.

**3. Plan and preview.** Once the brief is confirmed the same command carries on
into scoping and stops there, executing nothing. Read the preview: what is in
scope after filters and exclusions, the windows, and the configuration that
would be created. Overrides such as `-SteadyState` apply on top of the brief.
**4. Arm it.** Only after the preview matches your intent:

```powershell
./scripts/Invoke-ChaosStudy.ps1 ... -DryRun:$false -Consent '<phrase from the preview>'
```

## Reading the verdict

| Verdict | Means |
| --- | --- |
| **Steady state held** | The action landed and the objective survived it |
| **Degraded but recovered** | Breached during the run, recovered afterwards |
| **Steady state breached** | Breached and still breached after recovery |
| **Not exercised** | The action never applied enough work to test anything |
| **Inconclusive** | The action could not be proven to have landed |

Severity follows recovery, not drama: a breach that never recovers is `critical`;
the same breach that self-heals is `medium`.

## Choosing signals

The suite collects only what you name, because what counts as evidence depends
on the system under study. Two forms:

- `metrics:<name>` — an Azure Monitor metric on the single scoped resource, or
  `@<resourceId>` to pin one, `|<aggregation>` to override the aggregation. A
  scope holding several resources has no implied metric target, so pin it.
- `logs:<workspaceId>#<kql>` — a Log Analytics query

Name at least one signal expected to *move* under the action. That is what
separates "resilient" from "the action never landed". Scoping checks readiness
first: a study whose objective cannot be measured, or whose parameters do not
satisfy the live schema, teaches nothing, so exit `10` is a real answer.

## Progressive discovery

Action identifiers, parameters and required permissions are **not** documented
here, because they are the service's to state and this plugin's to relay. Get
them from `-ListActions` — Kubernetes/AKS guidance is deliberately absent until
those actions appear there. What lives here is the method:

- **`references/design-method.md`** — how a study is chosen before it is scoped
- **`references/study-method.md`** — the six-phase method and why it is split
- **`references/report-contract.md`** — what the report may and may not claim

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Success |
| `1` | Error |
| `10` | Readiness gates failed |
| `11` | Consent declined or phrase mismatch |
| `12` | Plan changed after it was frozen |
| `13` | Study or brief already sealed |
| `14` | Scope unverified — nothing in scope, or the action does not fit it |
| `15` | Studies not comparable |
| `16` | Live action discovery unavailable — there is no fallback |
| `17` | Scenario configuration failed validation |
| `18` | Paused: an Azure operation must be executed by the host, then resumed |
| `19` | Paused: role assignments need their own, separate approval |
| `20` | Scenario would run fewer legs than it declares, and that was not accepted |
| `21` | The run would not exercise the failure often enough to mean anything |
| `22` | No adapter can reach Azure — say which one to use |
| `23` | Study was written by an older contract version |
| `24` | Design incomplete — an unread area, a vague answer, or a missing field |
| `25` | A past study cannot be re-run exactly, so no command was printed |
| `26` | **Paused: waiting on the customer.** One question is open — ask it |

`18`, `19` and `21` are **pauses, not failures**. Each names the one thing it
needs; supply it and re-run the same command. Do not fill in the missing part
yourself — a study that cannot show where its evidence came from cannot be sealed.

## Running where `az` is not usable

Every Azure call goes through one adapter seam, selected with `-Adapter`:
`local-az` runs `az` in-process; `external` cannot, so it writes each operation
into the study's `operations/` directory and exits `18`. Under `external` you are
the executor: read the pending request, run exactly that call with your own
authenticated tooling, write the response back as the matching result file, and
re-run the identical command. Results are bound to the request hash and folded
into the study's provenance; resuming is idempotent.

## Notes

- Chaos Studio **V2** only: workspaces are the lifecycle root and resource
  selection flows through workspace scopes. There is no V1 path or fallback.
- Core is `az` / Azure Resource Manager: no SRE Agent or MCP dependency.
- Sealed studies are immutable — re-testing scopes a **new** study.
- Parameterised scenarios (`-Parameters`) are planned via `chaos-study-scope` directly.
