# Runbook — source-contract drift and the `api-version` bump

The shared core models the Microsoft.Chaos wire protocol as **source-derived
fixtures** plus a provenance manifest that binds each fixture to a reviewed source
extract and pins its hash. The `.github/workflows/contract-drift.yml` workflow re-runs
that derivation weekly (and on demand) and fails closed when anything disagrees.

**The pinned protocol version is `2026-05-01-preview`.**

## What this workflow does and does not detect

It evaluates the **committed** fixtures, source extracts, and pinned constants, so it
detects:

- a fixture, source extract, or recorded hash that no longer agrees with the rest
  (including an edit that bypassed the generator),
- a broken wire-shape or RV-evaluator assertion, and
- an `api-version` literal anywhere in the shipped surface that disagrees with the
  pinned constant.

It does **not** read the upstream service source, which would require authenticated
access to the service repository. **An upstream contract change that nobody has
mirrored into this repository will not turn this workflow red.**

The partial compensating control is RV1, which runs against a live environment before
every release and re-checks the observed protocol against these same constants
([`release-validation.md`](release-validation.md)). Be precise about its reach: RV1
observes only the **success and cancellation paths** it exercises — acceptance
statuses, `Location` suffixes, `Retry-After`, terminal success/`Canceled` states,
run-ID shape, and the status/time/error-channel field names. Contract surface it does
**not** exercise — notably the terminal *failure* state values the client also relies
on — would go undetected by both mechanisms. Treat a service-side contract change as
something that must be mirrored here by a reviewed change; it is not something the
automation will reliably discover for you.

---

## The policy

A protocol mismatch is a **service defect**, not a client bug. When the contract and
the service disagree, the response is to escalate to the Chaos Studio service team —
never to quietly change the client to match. Concretely, the following are prohibited
as a response to a red drift run:

- regenerating fixtures and committing the result to make the diff go away,
- relaxing or deleting a contract assertion,
- bumping the pinned `api-version` to whatever the service is now serving.

The `api-version` is a pinned constant in `packages/core/src/contract.ts`. It is
**never a customer input**: there is no `api-version` input on the Action or on the
task, precisely so a customer cannot move the client onto an unvalidated protocol.
It changes only by the reviewed procedure below.

## When the drift workflow fails

The `drift` job runs repository code and holds no write permission; the `report` job
holds `issues: write`, runs no repository code, and files a single deduplicated issue.
**Which** issue it files depends on an explicit contract verdict, not on the mere fact
that the job failed:

| Verdict | Label | Meaning |
|---|---|---|
| A contract check reported `contract=mismatch` — provenance re-derivation, the source-contract suite, or the pinned `api-version` assertion | `contract-drift` | A **confirmed** source-contract mismatch. Treat it as a service defect and follow the steps below. |
| The job failed without any contract check reporting a mismatch — `npm ci`, the runner, a timeout, or the repository-side release-validation suite | `contract-drift-workflow-failure` | **Not** evidence of drift. Fix the workflow; do not file a service defect on the strength of it. Drift detection is not running until it is green. |

Start from that issue.

1. **Read which step failed.**

   | Failing step | Contract evidence? | Meaning |
   |---|---|---|
   | Install workspace dependencies | No | Setup failure; says nothing about the contract. |
   | Provenance re-derivation | Yes | A fixture, a source extract, or a recorded hash no longer agrees with the rest — usually an edit that bypassed the generator. |
   | Source-contract suite | Yes | An assertion about the wire shape broke. |
   | Release-validation suite | No | This repository's release machinery regressed (receipt evaluators, RBAC template, release gates) — a repository defect, not a protocol mismatch. |
   | Pinned `api-version` assertion | Yes | The constant moved, or a literal somewhere in the shipped surface disagrees with it. |

2. **Reproduce locally** at the same commit:

   ```bash
   npm ci
   node packages/core/fixtures/scripts/generate-provenance.mjs
   git diff -- packages/core/fixtures
   node --test "packages/core/test/contract/**/*.test.ts" "test/release-validation/**/*.test.ts"
   ```

3. **Classify the cause.**

   - *An in-repo edit that bypassed the generator* (a fixture hand-edited, an extract
     re-pasted): this is a repository defect. Restore the extract from the
     authoritative source, re-run the generator, review the diff line by line, and
     commit. Close the drift issue referencing the fix.
   - *The service's source contract genuinely moved*: this is a **service defect**.
     Do not change the client. File it with the service team from the drift issue,
     recording the old and new shapes, the affected fixtures, and the customer impact
     (which operations would misbehave). Keep releases blocked while it is open.

4. **Do not release** while a drift issue is open. Both release configs gate on an RV
   receipt whose observations are evaluated against these same constants, so a real
   drift will also fail RV1 ([`release-validation.md`](release-validation.md)).

## The `api-version` bump procedure

An **api-version bump** is a deliberate, reviewed change — the mechanism by which the
client adopts a new protocol after the service ships it. Per D5/FR15 it requires all
of the following, in order:

1. **Re-derive the contract from the new source.** Refresh the committed source
   extracts for the new version, update the fixtures through
   `packages/core/fixtures/scripts/generate-provenance.mjs`, and review every diff
   against the authoritative source.
2. **Change the constant.** Update `API_VERSION` in `packages/core/src/contract.ts`.
   There is exactly one pinned value; no per-operation or per-adapter override, and no
   input that lets a caller select it.
3. **Update every literal** in the shipped surface (`packages/core/src`,
   `packages/core/fixtures`, `action.yml`, `azure-pipelines-extension`, and the
   documentation) so the drift workflow's consistency assertion passes.
4. **Green the suites.** `npm run typecheck && npm test` must pass, including the
   contract and release-validation suites.
5. **Run a fresh RV1–RV3 pass** against a target environment serving the new version,
   and commit the resulting receipt. An old receipt is bound to the old shipped trees
   and will be rejected; this is the point of the bump procedure.
6. **Release from one commit** per [`release.md`](release.md), calling out the protocol
   change prominently in both sets of release notes.

A bump that skips step 5 is not a bump — it is shipping an unvalidated protocol.

## Changing the schedule or the checks

`.github/workflows/contract-drift.yml` is itself covered by the TypeScript path filter
in `.github/workflows/test.yml`, and its shape is pinned by
`test/release-validation/release-handoff.test.ts`. Weakening the workflow (removing the
schedule, suppressing a failure, dropping a suite) fails those tests on the pull
request, which is intentional: the drift detector cannot be quietly disabled.
