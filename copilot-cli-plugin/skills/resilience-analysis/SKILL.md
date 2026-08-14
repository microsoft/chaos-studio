---
name: resilience-analysis
description: Internal Chaos Loop phase that produces ranked falsifiable resilience hypotheses from code, IaC, and eligible Chaos Studio Scenarios. Use only when the chaos-loop controller invokes this phase.
---

# Resilience analysis phase

Read the complete run state, then read
`<plugin-root>/references/chaos-loop/shared-contract.md` and
`<plugin-root>/references/chaos-loop/scenario-catalog.md`. Validate:

- `state.phase == "resilience-analysis"`;
- the supplied expected revision equals `state.stateRevision`;
- state is active;
- `state.workspace.status == "ready"` and `state.workspace.selected` names the
  workspace ARM ID, name, subscription, resource group, region, identity,
  managed scopes, and `provisioningState == "Succeeded"`;
- every `analysis.scope.targetResources` entry is covered by
  `state.workspace.selected.managedScopes`;
- `analysis.scope` contains repository, commit, and target resources.

If the workspace is not ready, stop and return control to the controller. Never
list, create, choose, or ask about a workspace: preflight already selected one
and it is immutable for the run.

You are read-only. Do not inject a fault, query impact telemetry, diagnose,
advise, edit code/IaC, invoke an agent, invoke another phase, or mutate state.
Write only the phase-output JSON requested by the controller.

## Scenario grounding

Use the selected workspace's discovered recommendations. The workspace
coordinates come from `state.workspace.selected`; never rediscover them:

Call `chaos_list_recommended_scenarios` from the bundled `chaos-studio` MCP
server with `state.workspace.selected.subscriptionId`,
`state.workspace.selected.resourceGroup`, and `state.workspace.selected.name`.

Preserve the exact versioned Scenario name and an existing validated
configuration name. Otherwise use only a currently supported custom Scenario
whose Actions and eligibility are evidenced. If no eligible runnable fault
exists, return an opinionated `repair` handoff with exact corrections, or
`escalated` when it is unsafe/unrecoverable. Never pause for customer choice and
never invent a fault.

## Method

1. Map entry points, sync/async dependency paths, queue consumers, DLQs,
   deployment topology, replicas/zones, probes, autoscale, and recovery.
2. Cite concrete file/symbol or IaC-resource evidence for each resilience gap.
3. Rank by learning value: likelihood x blast radius x falsifiability, with
   safety and Scenario eligibility as gates.
4. Make each hypothesis falsifiable and give it exactly one `matchingFault`
   object.
5. Submit structured hypotheses to the deterministic evaluator. It filters
   eligibility against `references/chaos-loop/scenario-catalog.v1.json`, calculates
   `learningScore = likelihood * blastRadius * falsifiability`, sorts by score
   descending then hypothesis ID, selects the highest-ranked remaining item,
   and hands exactly one test design to Execution.

Every hypothesis requires:

- `hypothesisId`, unique numeric `rank`, and `statement`;
- non-empty `codeOrIaCEvidence`;
- `scenarioEligibility` proving discovery, validated configuration, and safety;
- integer 1-5 `rankingInputs` for likelihood, blast radius, and falsifiability;
- exactly one matching fault with the seven frozen identity fields;
- non-empty `steadyStatePredicates`;
- `workExpected.predicate` and executable `workExpected.query`;
- `provingFault.predicate`, `requiredEvidence`, and `queryOrSource`;
- `confirmPredicate.predicate`, `telemetryQuery`, metric, operator, numeric
  threshold, unit, and window;
- `executedCodePathPredicate.predicate` and query/trace.

## Modes

### initial

For a new or next-ranked hypothesis, return the complete ranked set and one
selection. For `routingIntent = repair-exercise`, preserve the selected
hypothesis and frozen fault; repair only work, steady-state, or path-observation
proof.

### reassess

This is allowed only after the accepted external gate or when repairing a
`NOT EXERCISED` verify run. The repaired run remains verify mode. Preserve the
original:

- selected hypothesis ID and statement;
- proving-fault and confirmation predicates;
- exact `frozenValidation` Scenario/configuration/fault/parameters/targets/
  blast-radius/duration;
- prior numeric baselines, DLQ state, and caveats.

Inspect the deployed change and define what changed-path evidence the identical
run must observe. A merged/deployed change is not proof it executes. Do not say
the fix worked.

## Script-first protocol

1. Write only semantic hypothesis proposals and cited evidence to
   `<phase-proposal.json>`. Do not assign final ranks, select a hypothesis, or
   author a transition.
2. Call `chaos_loop_state.py evaluate --phase resilience-analysis`.
3. Return the evaluated `<phase-output.json>` unchanged. The evaluator owns
   eligibility filtering, scores, stable ordering, selection, test-design
   handoff, and route.

## Evaluated output

The evaluator writes:

```json
{
  "contractVersion": "chaos-loop-contract/v1",
  "runId": "<state.runId>",
  "expectedStateRevision": 0,
  "phase": "resilience-analysis",
  "result": {
    "mode": "initial",
    "analysisId": "<repo>@<commit>-<UTC>",
    "scope": {
      "repo": "",
      "commit": "",
      "targetResources": []
    },
    "hypotheses": [
      {
        "hypothesisId": "H1",
        "rank": 1,
        "statement": "",
        "codeOrIaCEvidence": [
          {
            "location": "<file:symbol or IaC resource>",
            "evidence": "",
            "resilienceMechanism": ""
          }
        ],
        "scenarioEligibility": {
          "discovered": true,
          "configurationValidated": true,
          "safetyEligible": true
        },
        "rankingInputs": {
          "likelihood": 3,
          "blastRadius": 3,
          "falsifiability": 3
        },
        "learningScore": 27,
        "matchingFault": {
          "scenarioName": "<exact versioned name>",
          "configurationName": "<validated existing configuration>",
          "faultType": "",
          "parameters": {},
          "targetResources": [],
          "blastRadius": { "scope": "", "targets": [] },
          "duration": ""
        },
        "steadyStatePredicates": [
          {
            "predicate": "",
            "queryOrSource": "",
            "threshold": ""
          }
        ],
        "workExpected": { "predicate": "", "query": "" },
        "provingFault": {
          "predicate": "",
          "requiredEvidence": [],
          "queryOrSource": ""
        },
        "confirmPredicate": {
          "predicate": "",
          "telemetryQuery": "",
          "metric": "",
          "operator": ">",
          "threshold": 1,
          "unit": "",
          "window": ""
        },
        "executedCodePathPredicate": {
          "predicate": "",
          "queryOrTrace": ""
        },
        "priority": "high",
        "rationale": "",
        "source": "chaos-studio-recommended"
      }
    ],
    "selectedHypothesisId": "H1",
    "originalHypothesisId": "H1",
    "analysisHandoff": {
      "disposition": "executable",
      "selectedHypothesisId": "H1",
      "selectedTestDesign": {
        "hypothesisId": "H1",
        "frozenValidation": {},
        "steadyStatePredicates": [],
        "workExpected": {},
        "provingFault": {},
        "confirmPredicate": {},
        "executedCodePathPredicate": {}
      },
      "backlogHypothesisIds": [],
      "repairBrief": null
    }
  },
  "handoff": {
    "analysisDecision": {
      "disposition": "executable",
      "selectedHypothesisId": "H1",
      "selectedTestDesign": {
        "hypothesisId": "H1",
        "frozenValidation": {},
        "steadyStatePredicates": [],
        "workExpected": {},
        "provingFault": {},
        "confirmPredicate": {},
        "executedCodePathPredicate": {}
      },
      "backlogHypothesisIds": [],
      "repairBrief": null
    },
    "unresolvedCaveats": []
  },
  "transition": {
    "status": "ready",
    "from": "resilience-analysis",
    "to": "chaos-execution",
    "reason": "ranked falsifiable hypothesis and matching fault ready"
  }
}
```

Replace examples with evidence. Tell the controller that it must apply this
output. Emit exactly one decision: `executable -> chaos-execution`,
`repair -> resilience-analysis`, or `escalated -> terminated`. The controller
auto-runs a ready route; do not ask the customer.
