---
name: chaos-loop
description: Run or resume the production evidence-gated Azure Chaos Studio resilience loop. Use for "start chaos loop", "chaos loop status", "resume chaos loop", or post-deployment validation.
---

# Chaos Loop controller

You are the sole controller. You sequence phase skills and deterministic state
commands; you never perform a phase's analysis or action yourself. Do not invoke
agents. Do not allow a phase skill to invoke another phase. Every phase returns
one decisive handoff; automatically invoke its executable next phase without
routine confirmation.

Read `<plugin-root>/references/chaos-loop/shared-contract.md` before any action. Resolve
`<plugin-root>` from this active skill's installed base directory.

## Commands

Interpret the public command as one of:

- `start`: collect the workspace request, complete workspace preflight, then
  initialize and auto-run until one of two interaction stops or a terminal
  decision.
- `status`: validate and report one existing run without mutation.
- `resume`: approve advisories or submit the external gate, then continue.

State lives at `tmp/chaos-loop/runs/<runId>/state.json` in the consuming
repository. Never place run data in the installed plugin.

For an existing run, invoke `chaos_loop_state.py migrate --state <state.json>
--expected-revision <revision>` before status/resume. Migration is atomic,
revisioned, evented, and idempotent. A run migrated from an earlier policy
version has no proven workspace: it is migrated to `workspace.status = pending`
and cannot run a phase until preflight completes. Supply the missing request
with `migrate --workspace-request '<JSON object>'`, or start a new run.

### Start

Require repository, commit, non-empty target resource IDs, guardrails with
`environmentScope`, `blastRadiusCap`, and at least one `safetyHalt`, and a
`workspaceRequest`. Default `maxIterations` to 3.

`workspaceRequest` is mandatory and is collected once, at start, before any
phase runs:

```json
{
  "subscriptionId": "<subscription UUID>",
  "resourceGroup": "<resource group for the workspace>",
  "location": "<Azure region, e.g. eastus>",
  "managedScopes": ["<subscription, resource-group, or resource ARM ID>"],
  "preferredName": "<optional existing/desired workspace name>",
  "identity": { "type": "SystemAssigned" }
}
```

`identity` is optional and defaults to `SystemAssigned`. `UserAssigned`
requires the exact `userAssignedIdentityResourceId`. Every managed scope and
every target resource must be in `subscriptionId`, and every target must be
covered by a requested managed scope. The state tool normalizes and validates
this; an ambiguous or unsupported scope fails closed at start.

```powershell
python <plugin-root>\scripts\chaos_loop_state.py start `
  --repo <repo> --commit <commit> `
  --target-resources '<JSON array>' `
  --guardrails '<JSON object>' `
  --workspace-request '<JSON object>' `
  --max-iterations 3
```

The run starts with `workspace.status = pending`. `evaluate` and `apply` refuse
to run any phase until preflight succeeds.

### Workspace preflight

Run this immediately after `start`, before `resilience-analysis`. Never ask a
workspace question in the middle of the loop; everything needed was collected
at start.

1. **List.** Call `chaos_list_workspaces` on the bundled `chaos-studio` MCP
   server with both `subscription_id` and the required `resource_group`.
   Resource-group-scoped discovery is mandatory so the same request always
   yields the same reuse/create decision. Save the raw tool result JSON beside
   state.
   If the call fails (permission, policy), record it and stop:

   ```powershell
   python <plugin-root>\scripts\chaos_loop_state.py workspace-fail `
     --state <state.json> --expected-revision <revision> `
     --stage list --result <raw-tool-result.json>
   ```

2. **Plan.** The plan is deterministic and does not mutate state:

   ```powershell
   python <plugin-root>\scripts\chaos_loop_state.py workspace-plan `
     --state <state.json> --expected-revision <revision> `
     --discovery <raw-list-result.json> `
     --observed-at <UTC timestamp> `
     --output <workspace-plan.json>
   ```

   The tool filters candidates on subscription, `Succeeded` provisioning,
   requested region, requested identity when one was pinned, and managed-scope
   coverage of both the requested scopes and the target resources. It selects by
   exact preferred name, then exact managed-scope set, then stable
   case-insensitive ARM ID, and records the rest as alternatives with caveats.

3. **Read back or create.**
   - `decision = reuse`: call `chaos_get_workspace` for `plan.selected`.
   - `decision = create`: call `chaos_create_workspace` with exactly
     `plan.createRequest` (subscription, resource group, workspace name,
     location, scopes, identity). This is a write: keep tool approval enabled
     and present the exact request before calling it.
   - Record either failure with `workspace-fail --stage get|create`.

4. **Finalize.**

   ```powershell
   python <plugin-root>\scripts\chaos_loop_state.py workspace-finalize `
     --state <state.json> --expected-revision <revision> `
     --plan <workspace-plan.json> --result <raw-tool-result.json>
   ```

   Finalize re-validates the plan against the run, revision, and request hash,
   then verifies the raw tool result: no failed role assignment,
   `provisioningState = Succeeded`, and matching ID/name/region/identity/scopes
   and target coverage. On success it persists `workspace.status = ready` with
   the decision (`reused` or `created`), the selected workspace, discovery and
   provisioning evidence, and the observation timestamp. On any mismatch it
   persists `workspace.status = failed` with a concrete `remediationBrief` and
   terminates the run `escalated`; report that brief and stop.

Only a ready workspace lets `resilience-analysis` start. The selected workspace
is then immutable: later phases reuse `workspace.selected` and never rediscover
or re-plan.

Use the returned state path. When preflight is ready, invoke
`resilience-analysis`.

### Status

```powershell
python <plugin-root>\scripts\chaos_loop_state.py status --state <state.json>
```

Report phase, revision, iteration/cap, verdict, termination reason, transition,
workspace status/decision/selected workspace, selected hypothesis/fault, and
unresolved caveats. Do not advance.

### Resume advisory approval

Only when phase is `advisory-approval`. Present the ranked advisories and
`defaultRecommendedAdvisoryIds`, then accept the customer's selected IDs:

```powershell
python <plugin-root>\scripts\chaos_loop_state.py approve `
  --state <state.json> --expected-revision <revision> `
  --advisory-ids 'A1,A2'
```

Never infer approval. After this succeeds, invoke `coding` automatically.

### Resume external gate

Only when phase is `awaiting-external-gate`. Validate the payload against
`schemas/chaos-loop/external-gate.v1.schema.json`, then run:

```powershell
python <plugin-root>\scripts\chaos_loop_state.py resume `
  --state <state.json> --expected-revision <revision> `
  --gate <gate-payload.json>
```

The tool rejects any missing coherent change, mismatch, non-live revision,
missing evidence stage, stale revision, or phase mismatch. There is no bypass.
On success it increments `iteration` immediately before the validation cycle,
sets analysis to `reassess`, preserves the original hypothesis and frozen
fault, and auto-runs reassessment, identical verify execution, and verify
Diagnostic.

## Sequencing loop

1. Read state and record `stateRevision`.
2. Confirm `workspace.status == "ready"`. If it is `pending`, run workspace
   preflight first; if it is `failed`, the run is already terminated
   `escalated` — report `workspace.remediationBrief` and stop.
3. Invoke exactly the skill named by `phase`:
   `resilience-analysis`, `chaos-execution`, `diagnostic`, `advisory`, or
   `coding`.
4. Give it the full state, state path, expected revision, plugin root, and the
   persisted `workspace.selected` coordinates.
5. Require one structured phase proposal JSON file adjacent to state. Phase
   skills do not calculate policy decisions or mutate state.
6. Run the deterministic evaluator:

   ```powershell
   python <plugin-root>\scripts\chaos_loop_state.py evaluate `
     --state <state.json> --expected-revision <revision> `
     --phase <phase> --input <phase-proposal.json> `
     --output <phase-output.json>
   ```

   Only this evaluated output may contain the final complete phase-owned
   `handoff` and `ready`/`terminated` decision.
7. Apply it:

   ```powershell
   python <plugin-root>\scripts\chaos_loop_state.py apply `
     --state <state.json> --expected-revision <revision> `
     --phase <phase> --output <phase-output.json>
   ```

7. Read the tool result, not the phase's prose, to determine the next action.
8. When transition is `ready`, immediately invoke the named phase. Do not ask.
9. Stop normally only at `advisory-approval`,
   `awaiting-external-gate`, or `terminated`. A contract error is not a customer
   decision gate: report it as an implementation/runtime failure.

The prescribed remediation cycle is:

`workspace preflight -> resilience-analysis -> chaos-execution -> diagnostic ->
advisory -> advisory-approval -> coding -> awaiting-external-gate ->
resilience-analysis(reassess) ->
chaos-execution(verify) -> diagnostic(verify)`.

`REFUTED`, `NOT EXERCISED`, mechanical repair, terminal decisions, backlog
selection, and iteration limits are routed by the state tool. The customer
chooses only advisory IDs and later supplies PR merge/deployment proof.

## Hard external gate

After Coding creates and presents PRs, report `awaiting-external-gate` and stop.
This is the PR-delivery stop. Never merge, deploy, poll a schedule, auto-resume,
or accept "PR merged" as deployment proof.
Resume requires, per implemented coherent change:

- `changeId`, `prUrl`, and `mergeCommit`;
- `targetEnv`;
- matching expected/observed build IDs;
- matching expected/observed artifact identity;
- matching expected/observed deployment IDs;
- matching expected/observed serving revision;
- `live: true`;
- exactly the named, UTC-timestamped evidence chain:
  merge, build, artifact, deployment, serving revision.

Merge is not deployment. Deployment is not changed-path execution. The latter
is proven only by Diagnostic during the identical verify run.

## Safety and termination

- The controller never executes a worker role.
- Do not alter `frozenValidation`.
- Do not alter `workspace` after preflight; the selected workspace is immutable
  for the life of the run and no phase may rediscover or replace it.
- Never ask a workspace question after preflight. The workspace request is
  collected once, at start.
- Do not advance stale revisions.
- Do not resume a terminated run.
- Only `advisory-approval` and `awaiting-external-gate` may have
  `transition.status = blocked`.
- `analysis-only` is an explicit controller termination from analysis:

  ```powershell
  python <plugin-root>\scripts\chaos_loop_state.py terminate-analysis-only `
    --state <state.json> --expected-revision <revision>
  ```

- Terminal reasons are exactly `analysis-only`, `no-impact`,
  `no-remediation`, `resolved`, and `escalated`.

After each phase, tell the user the persisted phase/revision and exactly what
comes next. Do not claim success unless the state tool terminated as `resolved`.
