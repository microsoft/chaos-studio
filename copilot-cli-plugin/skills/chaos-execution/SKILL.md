---
name: chaos-execution
description: Internal Chaos Loop phase that executes exactly one frozen Azure Chaos Studio fault and records mechanical run evidence. Use only when the chaos-loop controller invokes this phase.
---

# Chaos execution phase

Read the complete state and shared contract. Validate the exact phase and
revision. Require `state.workspace.status == "ready"` and use only
`state.workspace.selected` for the subscription, resource group, and workspace
name in every Chaos Studio call. Never list, create, or switch workspaces. Do
not mutate state or invoke agents/skills.

Your sole job is mechanical and decisive:

1. prove the intended build/artifact/revision is serving in the target
   environment with named UTC evidence;
2. evaluate every predeclared steady-state predicate without inventing SLI
   math or thresholds;
3. execute exactly one Scenario configuration matching the selected hypothesis;
4. prove the intended Action became active on the intended target;
5. record the exact fault window and terminal run state;
6. prove recovery using the declared recovery source.

The deterministic evaluator chooses exactly one route from the mechanical
inputs:

- `diagnostic-eligible -> diagnostic` only when all mechanical proof passes;
- `repair-analysis -> resilience-analysis` for a correctable build identity,
  steady-state, fault-design, or fault-proof failure, with concrete evidence and
  required corrections;
- `unsafe -> terminated/escalated` for unsafe or unrecoverable conditions.

Do not manually aggregate predicate results or choose the route. Never ask the
customer to approve a mechanical route.

Call `chaos_execute_scenario` and persist its `scenarioRunId` in the proposal.
Poll only that ID with `chaos_get_scenario_run`. Use
`chaos_cancel_scenario_run` only when a declared safety halt trips. These tools
come from the bundled `chaos-studio` MCP server.

Poll an existing run; never start a second run to check status. A resumed
controller reads the durable run ID from repository state and calls
`chaos_get_scenario_run` directly, so it does not depend on conversational MCP
memory or an unmerged run-list API. `run completed` alone does not prove the
fault landed.

## Mode and drift gate

- `initial` when `analysis.mode == initial`.
- `verify` when `analysis.mode == reassess`.

In verify mode, compare Scenario, configuration, fault type, parameters,
targets, blast radius, and duration to `state.frozenValidation`. Any difference
is `unsafe -> terminated/escalated`; do not inject or alter/retry the fault.

## Forbidden work

Do not calculate availability, error rate, latency, error-budget burn, deltas,
or other SLIs. Do not diagnose, emit hypothesis verdicts, advise, code, merge,
deploy, or claim resilience success.

## Script-first protocol

Write raw build identity observations, individual steady-state predicate
results, fault evidence, run status, recovery, safety flags, and timestamps to a
proposal. Call `chaos_loop_state.py evaluate --phase chaos-execution`. It owns
identity equality, predicate aggregation, window ordering, fault eligibility,
safety/abort routing, and the final handoff.

## Evaluated output

`result.frozenValidation` must be an exact copy of state:

```json
{
  "contractVersion": "chaos-loop-contract/v1",
  "runId": "<state.runId>",
  "expectedStateRevision": 1,
  "phase": "chaos-execution",
  "result": {
    "mode": "initial",
    "selectedHypothesisId": "H1",
    "frozenValidation": {
      "scenarioName": "",
      "configurationName": "",
      "faultType": "",
      "parameters": {},
      "targetResources": [],
      "blastRadius": { "scope": "", "targets": [] },
      "duration": ""
    },
    "testIdentity": {
      "analysisId": "",
      "scenarioName": "",
      "configurationName": "",
      "scenarioRunId": "",
      "mode": "initial"
    },
    "buildIdentity": {
      "environment": "",
      "expectedCommit": "",
      "observedCommit": "",
      "expectedBuildId": "",
      "observedBuildId": "",
      "expectedArtifact": "",
      "observedArtifact": "",
      "expectedDeploymentId": "",
      "observedDeploymentId": "",
      "expectedRevision": "",
      "observedRevision": "",
      "live": true,
      "evidence": []
    },
    "steadyStateEvidence": {
      "passed": true,
      "window": { "startTime": "", "endTime": "" },
      "predicates": []
    },
    "faultEvidence": {
      "provingFaultPredicate": "",
      "faultLanded": true,
      "evidence": []
    },
    "faultWindow": { "startTime": "", "endTime": "" },
    "run": {
      "startTime": "",
      "endTime": "",
      "status": "completed",
      "abortReason": null,
      "recoveryEvidence": []
    },
    "executionHandoff": {
      "disposition": "diagnostic-eligible",
      "diagnosticEligible": true,
      "repairBrief": null,
      "evidence": []
    }
  },
  "handoff": {
    "executionDecision": {
      "disposition": "diagnostic-eligible",
      "diagnosticEligible": true,
      "repairBrief": null,
      "evidence": []
    },
    "testIdentity": {},
    "buildIdentity": {},
    "steadyStateEvidence": {},
    "faultWindow": {},
    "provingFaultEvidence": {},
    "unresolvedCaveats": []
  },
  "transition": {
    "status": "ready",
    "from": "chaos-execution",
    "to": "diagnostic",
    "reason": "single frozen fault completed with mechanical proof"
  }
}
```

Populate each handoff field with the corresponding result evidence. Use `null`
plus a caveat for an unavailable raw numeric observation, never an uncited zero.
Tell the controller next is `diagnostic` only after apply succeeds.
For a correctable failure, return the complete mechanical evidence plus a
`repairBrief` and transition directly to `resilience-analysis`; the controller
auto-runs it.
