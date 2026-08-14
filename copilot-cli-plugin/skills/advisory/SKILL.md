---
name: advisory
description: Internal Chaos Loop phase that ranks evidence-supported remediation only for fixable CONFIRMED findings and maintains a complete advisory ledger. Use only when the chaos-loop controller invokes this phase.
---

# Advisory phase

Read state and the shared contract. Validate phase/revision. Require
`state.workspace.status == "ready"` and leave `state.workspace.selected`
untouched; it is the run's immutable workspace. Do not re-diagnose,
query impact telemetry, approve advice, edit code/IaC, apply resources, invoke
agents, invoke another phase, or mutate state.

Accept only fixable `CONFIRMED` findings. Every advisory must link:

- confirmed hypothesis ID;
- Diagnostic query and measured numbers;
- evidenced mechanism and code/resource location;
- directly matching Azure Advisor reliability recommendation, or one named
  Azure Well-Architected reliability guideline when Advisor has no coverage;
- minimal coherent change and how it acts on that mechanism;
- changed-path acceptance predicate for the identical validation fault.

No generic hardening. No advice for `REFUTED` or `NOT EXERCISED`.

Compare with `attemptedFixes` and the immediately prior advisory set. Do not
repeat a no-change or regressed fix without new evidence.

Every call requires a complete ledger:

- `added`;
- `changed`;
- `unchanged`;
- `removed`.

The first call uses `previousSetId: null`. Leave every item `proposed`.
Provide 1-5 `rankingInputs` for evidence strength, expected gain, and
implementation risk. The evaluator calculates stable scores, removes
unsupported attempted-fix duplicates, computes the ledger, and chooses the
top-ranked default ID. This is a recommendation, not approval. Advisory
selection is the first and only pre-PR customer interaction stop.

## Exactly one bounded critique/rewrite

Perform one critique and one corrective rewrite checking evidence linkage,
ranking, duplication/history, all four ledger categories, and Advisor/
Well-Architected grounding. Do not add unsupported advice.

## Script-first protocol

Draft evidence-grounded advisory proposals only, then call
`chaos_loop_state.py evaluate --phase advisory`. Return its rankings, ledger,
default selection, handoff, and transition unchanged.

## Evaluated output

```json
{
  "contractVersion": "chaos-loop-contract/v1",
  "runId": "<state.runId>",
  "expectedStateRevision": 3,
  "phase": "advisory",
  "result": {
    "basedOnHypothesisIds": ["H1"],
    "evidenceSummary": [],
    "advisorCoverage": {
      "retrievalTool": "az-cli",
      "queriedResourceIds": [],
      "categories": ["HighAvailability"],
      "recommendationsFound": 0,
      "recommendationsCorrelated": 0,
      "limitations": []
    },
    "advisories": [
      {
        "advisoryId": "A1",
        "rank": 1,
        "rankingInputs": {
          "evidenceStrength": 5,
          "expectedGain": 4,
          "implementationRisk": 2
        },
        "rankingScore": 10.0,
        "title": "",
        "class": "application code",
        "addressesHypothesisIds": ["H1"],
        "evidence": {
          "diagnosticQuery": "",
          "observedNumbers": [],
          "mechanism": "",
          "codeOrResourceEvidence": []
        },
        "grounding": {
          "source": "well-architected",
          "resourceId": null,
          "recommendationId": null,
          "recommendationText": null,
          "advisorRule": null,
          "category": null,
          "citation": ""
        },
        "expectedGain": { "rating": "high", "reason": "" },
        "risk": { "rating": "low", "reason": "" },
        "targetResourceOrRepo": "",
        "acceptanceEvidence": {
          "changedCodePathPredicate": "",
          "validationHypothesisId": "H1",
          "requiredTelemetry": []
        },
        "sensitive": false,
        "supersedesAttemptId": null,
        "approvalStatus": "proposed"
      }
    ],
    "changeLedger": {
      "previousSetId": null,
      "currentSetId": "",
      "added": [],
      "changed": [],
      "unchanged": [],
      "removed": []
    },
    "defaultRecommendedAdvisoryIds": ["A1"],
    "boundedCritique": {
      "critiqueCount": 1,
      "rewriteCount": 1,
      "checks": [
        "evidence-linkage",
        "ranking",
        "duplication",
        "ledger-completeness",
        "grounding"
      ],
      "corrections": []
    },
    "unresolvedCaveats": []
  },
  "handoff": {
    "advisoryState": {
      "previousSetId": null,
      "currentSetId": "",
      "defaultRecommendedAdvisoryIds": ["A1"],
      "advisories": [],
      "changeLedger": {
        "previousSetId": null,
        "currentSetId": "",
        "added": [],
        "changed": [],
        "unchanged": [],
        "removed": []
      }
    },
    "unresolvedCaveats": []
  },
  "transition": {
    "status": "ready",
    "from": "advisory",
    "to": "advisory-approval",
    "reason": "ranked advisory set and default recommendation ready for selection"
  }
}
```

The controller persists the proposal and creates the `advisory-approval`
interaction stop. Tell the customer the ranked set and default recommendation;
do not expose routing options. After IDs are selected, the controller
automatically invokes Coding. Do not invoke Coding yourself.
