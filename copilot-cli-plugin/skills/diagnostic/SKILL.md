---
name: diagnostic
description: Internal Chaos Loop phase that performs read-only telemetry analysis and emits exact CONFIRMED, REFUTED, or NOT EXERCISED evidence. Use only when the chaos-loop controller invokes this phase.
---

# Diagnostic phase

Read state and the shared contract. Validate phase/revision. Require
`state.workspace.status == "ready"` and treat `state.workspace.selected` as the
run's immutable workspace: reuse those coordinates and never discover, create,
or change a workspace. This phase is
read-only against source, infrastructure, and telemetry. Do not recommend or
implement changes, invoke agents, invoke another skill, or mutate state.

Use `monitor_query_logs`, `monitor_query_metrics`, and
`monitor_search_activity_log` from the bundled `chaos-studio` MCP server for
named read-only evidence. Analyze only the selected hypothesis; it is the one
in-scope hypothesis for this single-fault run.

## Verdicts

Emit exactly one:

- `CONFIRMED`: fault proven, eligible work observed, targeted path executed,
  and confirmation predicate measured true.
- `REFUTED`: fault proven, eligible work observed, targeted path executed, and
  confirmation predicate measured false.
- `NOT EXERCISED`: fault not proven, work absent/starved, telemetry unavailable,
  targeted path absent, or, in verify mode, changed path not observed.

Never use PASS, FAIL, UNKNOWN, INCONCLUSIVE, or prose substitutes. Absence of
errors is not evidence of exercise.

The deterministic evaluator computes the only eligible verdict and route:

- `CONFIRMED -> advisory` when fixable;
- `CONFIRMED -> no-remediation` when not fixable;
- `REFUTED -> next-ranked-hypothesis`, `no-impact`, or `resolved` according to
  mode, backlog, SLO, and changed-path proof;
- `NOT EXERCISED -> exercise-repair` with a concrete brief;
- verify `CONFIRMED` at the iteration cap -> `escalated`.

Do not manually calculate deltas, DLQ ages, verdicts, or routes. Do not ask the
customer which route to take.

## Method

1. Re-evaluate proving-fault evidence.
2. Check work starvation before interpreting low counts.
3. Initial mode: derive stable numeric pre-fault baselines.
4. Verify mode: preserve initial values/units/windows/queries/sources; add
   current values and deltas without overwriting them.
5. Evaluate the exact confirmation query over the exact fault window.
6. Record targeted-path evidence. In verify, separately prove changed-path
   execution; without it verdict is `NOT EXERCISED`.
7. Preserve DLQ baseline/current/delta/oldest age/query even when no write is
   observed.
8. Use `null` plus a caveat for unavailable numeric results. Zero requires its
   measured query.

## Exactly one bounded critique/rewrite

Before output, perform exactly one critique and one corrective rewrite. Check:

- schema and allowed verdict;
- hypothesis/query/value traceability;
- fault and eligible-work proof;
- starvation-first reasoning;
- baseline and DLQ continuity;
- changed-path proof in verify.

Do not run a second investigation, add evidence during critique, change the
fault, or recommend a fix.

## Script-first protocol

Write measured query values and explicit boolean evidence inputs to a proposal,
then call `chaos_loop_state.py evaluate --phase diagnostic`. The evaluator owns
null/zero rules, baseline and DLQ calculations, the verdict matrix, iteration
cap, and route. Interpret the resulting mechanism only after evaluation.

## Evaluated output

```json
{
  "contractVersion": "chaos-loop-contract/v1",
  "runId": "<state.runId>",
  "expectedStateRevision": 2,
  "phase": "diagnostic",
  "result": {
    "mode": "initial",
    "numericBaselines": [],
    "observedSLIs": [],
    "telemetryQueries": [],
    "starvationEvidence": {
      "eligibleWorkObserved": true,
      "eligibleCount": 1,
      "unit": "requests",
      "query": "",
      "evidence": ""
    },
    "dlqState": [],
    "hypothesisResults": [
      {
        "hypothesisId": "H1",
        "statement": "",
        "provingFault": {
          "predicate": "",
          "satisfied": true,
          "evidence": []
        },
        "confirmPredicate": {
          "predicate": "",
          "telemetryQuery": "",
          "observedValue": 1,
          "unit": "",
          "operator": ">",
          "threshold": 0,
          "evaluatedTrue": true
        },
        "workStarvationChecked": true,
        "eligibleWorkObserved": true,
        "executedCodePathEvidence": [],
        "changedCodePathObserved": null,
        "verdict": "CONFIRMED",
        "reason": "",
        "unresolvedCaveats": []
      }
    ],
    "fixableConfirmedHypothesisIds": ["H1"],
    "sloHolds": false,
    "diagnosticHandoff": {
      "hypothesisId": "H1",
      "verdict": "CONFIRMED",
      "route": "advisory",
      "nextPhase": "advisory",
      "exerciseRepairBrief": null,
      "reason": ""
    },
    "boundedCritique": {
      "critiqueCount": 1,
      "rewriteCount": 1,
      "checks": [
        "schema",
        "traceability",
        "fault-and-work-proof",
        "starvation",
        "baseline-dlq-continuity",
        "changed-path-proof"
      ],
      "corrections": []
    }
  },
  "handoff": {
    "diagnosticDecision": {
      "hypothesisId": "H1",
      "verdict": "CONFIRMED",
      "route": "advisory",
      "nextPhase": "advisory",
      "exerciseRepairBrief": null,
      "reason": ""
    },
    "numericBaselines": [],
    "observedSLIs": [],
    "telemetryQueries": [],
    "starvationEvidence": {},
    "hypothesisResults": [],
    "targetedPathEvidence": [],
    "changedPathEvidence": [],
    "dlqState": [],
    "unresolvedCaveats": []
  },
  "transition": {
    "status": "ready",
    "from": "diagnostic",
    "to": "advisory",
    "reason": "selected hypothesis verdict measured"
  }
}
```

This phase chooses Advisory, exercise repair, next hypothesis, or termination
from the contract. The controller validates and auto-runs the decision.
