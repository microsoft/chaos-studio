---
name: chaos-study-scope
description: "Frame a Chaos reliability study before anything runs: resolve or create a Chaos Studio V2 workspace, read the resources the service discovered inside its scopes, discover live which actions and scenarios are actually available for that region, express a falsifiable steady-state predicate, verify the action fits what is in scope, then freeze and hash an auditable study plan."
---

# chaos-study-scope — decide what the study can prove

Most failed chaos studies fail here, not during execution. They run an action
nothing was measuring, over a scope that could not receive it, to answer a
question that could not have come back false.

This skill's job is to catch that before production is touched.

## Principles

**The workspace is the lifecycle root.** Scopes, discovered resources,
scenarios, configurations and runs all hang off one workspace. Scoping resolves
it first, and everything the plan records is anchored to it.

**Ask the platform; never assume.** The list of available actions is fetched
from `Microsoft.Chaos/locations/{region}/actions` for the workspace's region, on
every scope. That response is authoritative: its `canonicalId`, `actionType`,
`appliesTo` and `parametersSchema` are what the plan records. Scenarios come
from the workspace's own recommendation list.

**No bundled catalogue, no fallback.** This skill ships no action definitions.
If the actions endpoint cannot be reached — not logged in, no permission, region
unresolved — scoping stops with exit `16` and says so. It does not degrade to a
stale local list, because a stale list is how you plan a study against an action
that does not exist.

**What is in scope is read, not asserted.** The resources a run will touch come
from the workspace's discovered resources, not from the operator's mental model.
The two diverge constantly — a scope grows a resource nobody remembered, or a
resource the plan names was never onboarded and would have been silently
skipped.

**A steady state must be falsifiable.** `successRate >= 99.5` can be violated.
"the service is healthy" cannot. Scoping rejects the second kind.

**Check the fit before promising the study.** An empty scope, or an action that
applies to no resource type present in the scope, means the study cannot prove
anything. Scoping says so up front (exit `10` / `14`) instead of failing halfway
through a run.

**Parameters are validated against the service's schema.** Not against a copy of
it. Required properties, enums and types come from the live `parametersSchema`,
so validation cannot drift from the platform. Scenario knobs and action knobs
are different documents: `-Parameters` is checked against the scenario's schema
and is what the configuration carries, `-ActionParameters` against the action's.
Neither is ever silently checked against the other.

**Freeze what was approved.** The plan is written once and hashed. The run skill
re-computes that hash; if it changed, the run refuses (exit `12`). What you
reviewed is what executes.

**Discovery is read-only.** Scoping issues only reads, unless you explicitly ask
for `-CreateWorkspace`. Nothing else here mutates anything.

## Usage

**List what the platform offers** — start here; the action constrains the
question, and only the service knows what exists in that region today:

```powershell
./scripts/Invoke-ChaosStudyScope.ps1 -ListActions `
    -SubscriptionId $sub -ResourceGroup rg-prod -WorkspaceName ws-payments

./scripts/Invoke-ChaosStudyScope.ps1 -ListScenarios `
    -SubscriptionId $sub -ResourceGroup rg-prod -WorkspaceName ws-payments
```

**Scope a study:**

```powershell
./scripts/Invoke-ChaosStudyScope.ps1 `
    -SubscriptionId $sub -ResourceGroup rg-prod -WorkspaceName ws-payments `
    -Scenario '<scenario from -ListScenarios>' `
    -Action '<action from -ListActions>' `
    -SteadyState 'successRate >= 99.5' `
    -SignalSource 'metrics:Availability' `
    -DurationMinutes 10 -BaselineMinutes 5 -RecoveryMinutes 10
```

`-Action` accepts the canonical URN, the action name or the display name; a
partial match is accepted only when it is unambiguous.

Useful switches:

- `-CreateWorkspace -Scope <armId...>` — create the workspace over those scopes
  when it does not exist. Without it, a missing workspace is an error rather
  than an implicit provisioning action.
- `-Location` — region for a workspace being created
- `-Parameters @{ ... }` — scenario knobs, validated against the live scenario
  schema; these are what the configuration carries
- `-ActionParameters @{ ... }` — action knobs, validated against the action's own
  schema and recorded on the plan. The V2 configuration body takes scenario
  parameters only, so these are declared and frozen, never transmitted.
- `-FilterLocation` / `-FilterZone` / `-ExcludeResource` / `-ExcludeType` /
  `-ExcludeTag` — the blast radius, frozen onto the plan as the configuration's
  `filters` and `exclusions`. Discovery does not report a location or zone, so
  those two filters fail loudly rather than silently emptying the scope.
- `-SignalSource` — the evidence to collect (`metrics:` / `logs:`); no defaults
  are invented for you
- `-Hypothesis` — what you expect to happen, recorded for honesty at report time
- `-SkipDiscovery` — plan without contacting Azure. The plan then carries
  limitation `L10` and records the scenario and action as `unverified-offline`;
  no metadata is fabricated, and the run still validates before executing.

Output is a frozen `study-plan.v3.json` plus a study id. Nothing is executed.

## What the plan records

The plan is the contract the rest of the suite reads:

| Section | Why it matters |
| --- | --- |
| `workspace` | the lifecycle root — subscription, group, name, id, region, scopes |
| `scope` | what is actually in scope: discovered resources, types, blast radius, and how many survive it |
| `action` | live action metadata: canonical id, type, what it applies to, schema, roles |
| `scenario` | the scenario that will execute, its version and parameters |
| `discovery` | which endpoint answered, when, and how much it returned |
| `question` | the steady-state predicate, parsed and normalised |
| `windows` | baseline / inject / recovery minutes |
| `signals` | what evidence must be collected for the verdict to mean anything |
| `readiness` | gate results and any limitation codes they imply |
| `planHash` | integrity seal checked before execution |

## Choosing windows

Baseline exists to establish what "normal" looked like *today*, not last week.
Recovery exists to distinguish a transient dip from real damage — without it, a
system that never recovers looks identical to one that recovers instantly.

Injection windows of three minutes or less are recorded as limitation `L7`: too
short to distinguish resilience from luck.

## Progressive discovery

Action identifiers, parameter shapes and required permissions are **not**
documented here. They are the service's to state, and restating them locally is
exactly the drift this design removes. Use `-ListActions` and `-ListScenarios`.

What lives locally is the method:

- `../chaos-study/references/study-method.md` — the method behind the phases
- `../chaos-study/references/report-contract.md` — what a report may claim

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Plan frozen |
| `1` | Error |
| `10` | Readiness gates failed |
| `14` | Scope unverified — nothing in scope, or the action does not fit it |
| `16` | Live action discovery unavailable — there is no fallback |
| `18` | Paused: an Azure operation must be executed by the host, then resumed |
| `19` | Paused: role assignments need their own, separate approval |
| `20` | Scenario would run fewer legs than it declares, and that was not accepted |
| `21` | The run would not exercise the failure often enough to mean anything |
| `22` | No adapter can reach Azure — pass `-Adapter` explicitly |
| `23` | Study was written by an older contract version |

### The pauses

`18`, `19`, `20` and `21` are stops with a specific missing input, not errors.
Supply it and re-run the same command; scoping resumes rather than restarting.

- **`18`** — under `-Adapter external` this phase cannot call Azure itself. It
  wrote the exact request to the study's `operations/` directory. Execute it with
  your own authenticated tooling, write the response back as the matching result
  file, then re-run. Never answer the request from memory or inference: the
  result is hashed and bound to the request, and invented evidence cannot seal.
- **`19`** — preflight validation found the workspace identity is missing role
  assignments. Granting them is a *separate* decision from approving the fault,
  so it needs its own approval phrase. Approving the injection never implies it.
- **`20`** — the service's execution plan skips legs the scenario name implies.
  Fix the scope, or accept the reduced scenario explicitly.
- **`21`** — the exposure arithmetic says the fault would rarely meet the code
  path. Strengthen the exercise, or accept a weak one explicitly and let the
  study report "Not exercised" rather than false resilience.

## Next

Review the plan, then run it with explicit consent:

```powershell
chaos-study-run -StudyId <studyId> -DryRun:$false -Consent '<phrase from the plan>'
```
