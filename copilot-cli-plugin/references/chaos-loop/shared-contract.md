# Chaos Loop shared contract

This contract is authoritative for the controller and all five phase skills.
The phase-specific skill is authoritative when it imposes a stricter rule.

## Controller-owned state

The controller persists one UTF-8 JSON document per run at:

`tmp/chaos-loop/runs/<runId>/state.json`

Only `scripts/chaos_loop_state.py` may mutate this file. It uses an exclusive
lock, a same-directory temporary file, `fsync`, and atomic replacement. Every
mutation validates the expected phase and optimistic `stateRevision`, preserves
unowned fields, appends a UTC event, and increments the revision exactly once.

Never edit the state file manually. A phase reads the whole state and writes a structured proposal. The controller
first evaluates it deterministically, then applies only the evaluated output:

```powershell
python <plugin-root>\scripts\chaos_loop_state.py evaluate `
  --state <state.json> --expected-revision <revision> --phase <phase> `
  --input <phase-proposal.json> --output <phase-output.json>

python <plugin-root>\scripts\chaos_loop_state.py apply `
  --state <state.json> `
  --expected-revision <revision> `
  --phase <phase> `
  --output <phase-output.json>
```

The state schema is `schemas/chaos-loop/run-state.v1.schema.json`. The evaluated phase output envelope is:

```json
{
  "contractVersion": "chaos-loop-contract/v1",
  "runId": "<state.runId>",
  "expectedStateRevision": 0,
  "phase": "resilience-analysis",
  "evaluation": {
    "engine": "chaos_loop_state.py",
    "policyVersion": "chaos-loop-policy/v2"
  },
  "result": {},
  "handoff": {
    "<phase-owned decision>": {},
    "unresolvedCaveats": []
  },
  "transition": {
    "status": "ready",
    "from": "resilience-analysis",
    "to": "chaos-execution",
    "reason": "phase contract complete"
  }
}
```

Phase output `status` is exactly `ready` or `terminated`. Every phase emits one
opinionated route and a complete phase-owned `handoff`; it never presents route
options or asks the customer what should run next. The controller validates and
automatically executes every `ready` route.

Only controller-created state transitions may be `blocked`, and only at:

1. `advisory-approval`, where the customer selects proposed advisory IDs; and
2. `awaiting-external-gate`, the PR-delivery stop awaiting merge/build/artifact/
   deployment/live-revision evidence.

Terminal and escalated outcomes are decisions, not interaction gates.
`apply` rejects any output missing the evaluator stamp.

## Workspace preflight

Every run begins with one required, validated `workspaceRequest`
(`subscriptionId`, `resourceGroup`, `location`, non-empty `managedScopes`,
optional `preferredName`, optional `identity` defaulting to `SystemAssigned`).
The controller normalizes it at `start`; ambiguous or unsupported scopes,
foreign-subscription scopes, and targets outside the requested managed scopes
fail closed before any phase runs.

`start` persists `state.workspace` with `status = pending`. The controller then
runs, in order:

```powershell
python <plugin-root>\scripts\chaos_loop_state.py workspace-plan `
  --state <state.json> --expected-revision <revision> `
  --discovery <raw chaos_list_workspaces result> `
  --observed-at <UTC> --output <workspace-plan.json>

python <plugin-root>\scripts\chaos_loop_state.py workspace-finalize `
  --state <state.json> --expected-revision <revision> `
  --plan <workspace-plan.json> --result <raw get/create result>
```

`workspace-plan` never mutates state. It filters candidates on subscription,
`Succeeded` provisioning, requested region, pinned identity, and managed-scope
coverage of the requested scopes and target resources, then selects by exact
preferred name, exact managed-scope set, and stable case-insensitive ARM ID.
With no compatible candidate it emits a create request that uses
`preferredName` or a deterministic hash-derived valid name and exactly the
requested scopes, location, and identity. A plan is refused once the workspace
is ready, so no later phase can rediscover.

`workspace-finalize` re-binds the plan to the run, revision, and request hash,
then proves the raw MCP result: no failed role assignment,
`provisioningState = Succeeded`, and matching ID/name/region/identity/scopes.
Success persists `status = ready` with `decision` `reused` or `created`, the
selected workspace, discovery and provisioning evidence, and `observedAt`. Any
tool, provisioning, or readback mismatch persists `status = failed` with a
concrete `remediationBrief` and terminates the run `escalated`.
`workspace-fail --stage list|get|create` records permission/policy failures the
same way.

Only `status = ready` allows `evaluate` and `apply`. The selected workspace is
then immutable: `apply` rejects any output that changes it, and every phase
reuses `state.workspace.selected` instead of rediscovering. Preflight is not a
customer interaction stop — the two normal blocked phases remain
`advisory-approval` and `awaiting-external-gate`.

## Ownership

| Phase | State/result ownership |
|---|---|
| controller preflight | `workspace`; validated request, reuse/create decision, selected workspace, alternatives, caveats, discovery/provisioning evidence, remediation brief |
| resilience-analysis | `analysis`; `analysisDecision`; one selected executable test design or repair/escalation brief |
| chaos-execution | `executionDecision`; test/build identity, steady-state evidence, exact fault window, proving-fault evidence, recovery |
| diagnostic | `diagnosticDecision`; numeric baselines, observed SLIs/deltas, queries, starvation, verdicts, targeted/changed path, DLQ |
| advisory | advisory set, default recommended IDs, evidence grounding, four-way change ledger |
| coding | implemented and not-implemented changes, PR delivery decision, allowed verification records |
| controller | run/fault IDs, phase, revision, iteration, cap, approvals, frozen validation, routing, terminal verdict |
| external gate | merge/build/artifact/deployment/serving-revision evidence only |

## Universal evidence invariants

1. Absence of failure is not evidence that the exercise occurred.
2. A fix is unproven until the changed path executes during the identical,
   proven validation fault.
3. Check eligible-work starvation before interpreting low counts.
4. Preserve numeric value, unit, window, query, and source across iterations.
5. Unknown numeric values are `null` plus a caveat. Zero is valid only when a
   cited query measured zero.
6. Preserve DLQ baseline, current count, delta, oldest age, and query.
7. Every timestamp is ISO-8601 UTC ending in `Z`.
8. Every factual claim traces to a named code location, tool result, query,
   metric, deployment record, or prior handoff.
9. Phase skills never invoke agents, other phase skills, or the controller. They
   decisively name the next phase; the controller invokes it.
10. Build/test success is not resilience proof.
11. The workspace selected by preflight is immutable. Phases read
    `state.workspace.selected` and never list, create, or switch workspaces.

## Accumulating handoff

The handoff retains, without summarizing away:

- test, build, artifact, deployment, environment, and serving revision IDs;
- live-build proof and named UTC evidence;
- steady-state predicate observations;
- exact fault window and proving-fault evidence;
- numeric baselines and observed SLI values/deltas with units/windows/queries;
- telemetry queries and work-starvation evidence;
- exact per-hypothesis verdicts;
- targeted-path and changed-path evidence;
- DLQ baseline/current/delta/oldest-age/query;
- advisory sets and added/changed/unchanged/removed ledger;
- implemented and not-implemented changes;
- unresolved caveats.

## Frozen validation

`frozenValidation` contains exactly:

`scenarioName`, `configurationName`, `faultType`, `parameters`,
`targetResources`, `blastRadius`, and `duration`.

Post-gate reassessment and verify execution must match it byte-for-byte after
canonical JSON ordering. Any drift blocks the run. No altered retry is allowed.

## Phase transition rules

| Condition | Controller transition |
|---|---|
| Initial fixable `CONFIRMED` | advisory |
| Initial `REFUTED`, backlog remains | resilience-analysis, next ranked |
| Initial `REFUTED`, no backlog | terminated: `no-impact` |
| Any `NOT EXERCISED` | resilience-analysis, repair same exercise |
| Advisory has no safe plan | terminated: `no-remediation` |
| Coding has implemented PRs | `awaiting-external-gate`, stop |
| Verify `REFUTED`, SLO holds, changed path observed, backlog remains | resilience-analysis, next ranked |
| Verify `REFUTED`, SLO holds, changed path observed, no backlog | terminated: `resolved` |
| Verify `CONFIRMED`, under cap | advisory |
| Verify `CONFIRMED`, cap reached | terminated: `escalated` |

Allowed terminal reasons are exactly `analysis-only`, `no-impact`,
`no-remediation`, `resolved`, and `escalated`.

## Auto-advance invariant

Analysis selects the highest-ranked eligible hypothesis and hands exactly one
test design to Execution. Execution decides Diagnostic eligibility or returns a
concrete Analysis repair brief. Diagnostic decides its route from the exact
verdict. Advisory recommends and ranks a set, marks default IDs, then the
controller creates the `advisory-approval` stop. Approved IDs immediately route
to Coding. Coding delivers PRs and the controller creates the
`awaiting-external-gate` stop. A valid external gate immediately runs reassess,
identical verify execution, and verify Diagnostic without confirmation.

## Tool paths

Resolve `<plugin-root>` from the active skill's base directory. Do not point to
the source checkout or another user's home directory. The installed plugin
contains:

- `scripts/chaos_loop_state.py` for state and transition enforcement;
- the bundled `chaos-studio` MCP server for workspace discovery
  (`chaos_list_workspaces`), workspace readback/creation
  (`chaos_get_workspace`, `chaos_create_workspace`), recommended Scenario
  discovery, one Scenario run, cancellation/status, and read-only Azure Monitor
  queries;
- `schemas/chaos-loop/run-state.v1.schema.json`;
- `schemas/chaos-loop/workspace-plan.v1.schema.json`;
- `schemas/chaos-loop/external-gate.v1.schema.json`.

The MCP server authenticates through managed identity or the signed-in Azure
CLI. It never stores tokens.

In Azure SRE Agent, import `chaos_loop_state(action, arguments)` as the
controller's Python tool and connect the bundled `chaos-studio` MCP server for
Azure operations. Configure per-skill tool allowlists as documented in
`docs/sre-agent-chaos-loop-import.md`; they do not change phase ownership or
routing.
