---
name: coding
description: Internal Chaos Loop phase that implements only explicitly approved advisory IDs and opens one PR per coherent change without merging or deploying. Use only when the chaos-loop controller invokes this phase.
---

# Coding phase

Read state and the shared contract. Validate phase/revision. Require
`state.workspace.status == "ready"` and leave `state.workspace.selected`
untouched; it is the run's immutable workspace. Reject any advisory
not present in both the current set and `approvedAdvisoryIds`.

Implement only explicit approved IDs. Do not diagnose, broaden advice, perform
generic hardening, invoke agents/skills, merge, deploy, run chaos, or claim the
fix worked.

## Change and PR rules

1. Make the smallest change satisfying each approved advisory.
2. Group only inseparable edits. One coherent change equals one PR.
3. Use a separate branch/worktree when multiple independent PRs are required.
4. Link run/fault, advisory and hypothesis IDs, evidence, rollback, and
   changed-path acceptance predicate in every PR.
5. Include mandatory `implemented` and `notImplemented` arrays. Every approved
   advisory appears exactly once across them.
6. Decide `awaiting-external-gate` after creating/reporting PRs. This PR-delivery
   stop is the second and final normal customer interaction point.

## Verification

Hosted runners are disabled. `verificationStatus` is exactly `passed`,
`failed`, `not-run`, or `blocked`.

Use `passed` only when an allowed local, service-side, deployment, plan,
what-if, or other explicitly approved path actually ran and its evidence is
recorded. Build/test success is always marked `notProofOfResilience: true`.
Never call a PR green/verified from hosted checks.

Every implemented change needs a changed-path acceptance predicate and target
environment. Record the expected build/artifact/deployment/revision IDs when
known; the external gate will require non-empty expected and observed values
before resumption.

## Script-first protocol

Submit implemented/notImplemented records and verification evidence to
`chaos_loop_state.py evaluate --phase coding`. The evaluator owns approval
coverage, verification policy, PR delivery handoff, and the terminal versus
external-gate route. Return its output unchanged.

## Evaluated output

```json
{
  "contractVersion": "chaos-loop-contract/v1",
  "runId": "<state.runId>",
  "expectedStateRevision": 5,
  "phase": "coding",
  "result": {
    "approvedAdvisoryIds": ["A1"],
    "implemented": [
      {
        "changeId": "C1",
        "advisoryIds": ["A1"],
        "hypothesisIds": ["H1"],
        "class": "application code",
        "prUrl": "",
        "repo": "",
        "branch": "",
        "commit": "",
        "filesChanged": [],
        "coherenceReason": "",
        "targetEnv": "",
        "expectedBuildId": "",
        "expectedArtifact": "",
        "expectedDeploymentId": "",
        "expectedRevision": "",
        "acceptanceEvidence": {
          "changedCodePathPredicate": "",
          "validationHypothesisId": "H1",
          "requiredTelemetry": []
        },
        "verification": {
          "hostedRunnersEnabled": false,
          "verificationStatus": "not-run",
          "pathsRun": [],
          "notProofOfResilience": true
        },
        "reviewSummary": "",
        "sensitive": false
      }
    ],
    "notImplemented": [],
    "unresolvedCaveats": []
  },
  "handoff": {
    "codeChanges": {
      "implemented": [],
      "notImplemented": [],
      "deliveryDecision": {
        "route": "awaiting-external-gate",
        "prUrls": [],
        "requiredGateEvidence": [
          "merge",
          "build",
          "artifact",
          "deployment",
          "serving-revision"
        ]
      }
    },
    "unresolvedCaveats": []
  },
  "transition": {
    "status": "ready",
    "from": "coding",
    "to": "awaiting-external-gate",
    "reason": "approved coherent change PRs reported"
  }
}
```

Copy result arrays and every created PR URL into `handoff.codeChanges`. Tell the
controller to apply the output and stop at `awaiting-external-gate`. If nothing
was safely implemented, decide terminal `no-remediation` rather than asking the
customer. The external actor must merge and deploy; this phase never does.
