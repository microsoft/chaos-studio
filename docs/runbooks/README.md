# Operational runbooks — Chaos Studio CI/CD integrations

Operational handoff for the GitHub Action (`microsoft/chaos-studio@v1`) and the
Azure Pipelines extension (`AzureChaosStudio.ChaosStudioWorkspaces`). Both wrap the
same shared TypeScript core and are released from **one validated core commit**,
published from the single release commit that carries that commit's validation
receipt ([`release.md`](release.md)).

**Owning team:** Azure Chaos Engineering Services (ACES) — `aces@microsoft.com`.
File defects in this repository; page the on-call rotation only for a live customer
impact caused by a published integration.

| Runbook | Use it when |
|---|---|
| [`release.md`](release.md) | Cutting a preview or GA release of both marketplaces from one commit. |
| [`release-validation.md`](release-validation.md) | Running RV1–RV3 in the target environment and recording the receipt; responding to a failed RV. |
| [`rollback-and-deprecation.md`](rollback-and-deprecation.md) | A published release is bad, or a version/task is being retired. |
| [`contract-drift.md`](contract-drift.md) | The scheduled `contract-drift` workflow failed, or an `api-version` bump is proposed. |

## Standing operating principles

1. **One commit, two marketplaces.** Every release ships artifacts built from a
   single validated core commit; both release configs prove it before publishing,
   from one shared release commit.
2. **Evidence, not assertion.** RV1–RV3 results are recorded as a receipt whose
   observations are *re-evaluated* against the source-proven contract. A receipt
   that merely claims `passed` is rejected.
3. **A protocol mismatch is a service defect.** The client is never quietly changed
   to accommodate a wire change; the pinned `api-version` moves only by a reviewed
   code change plus a fresh RV pass.
4. **Secrets never meet repository code.** Publishing jobs consume prebuilt,
   verified artifacts and run no repository code; gates that execute repository code
   hold no credential.

## Standing external prerequisites

These controls live **outside** this repository and must be provisioned by a repo
admin and an ADO admin. They are verified, not created, by the tooling here:

- GitHub: tag ruleset + release environment protections
  (`scripts/verify-release-protections.sh`).
- Azure DevOps: the ESRP signing environment and the `ADO-Plugin Publishing`
  service-connection approvals (`scripts/verify-ado-signing-protections.sh`).
- A target preview environment (a Chaos Studio v2 stamp, a workspace, and federated
  CI identities) for RV1–RV3.

Until all three are provisioned and both verifier scripts pass in the live tenants,
the public preview is **blocked**. That is the expected state, not a defect.
