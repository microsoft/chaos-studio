# Runbook — release validation (RV1–RV3) and the receipt

RV1–RV3 are the three checks that must be green **in the target preview environment**
before either marketplace publishes. They are executed by an operator against a live
Chaos Studio v2 stamp using the **private** Action and extension builds, and their
results are recorded as a *receipt* that both release configs re-verify.

The split is deliberate: the operator records **what the environment did**; the
repository decides **whether that satisfies the contract**. A receipt that merely
claims `passed` is rejected, and a protocol mismatch therefore always surfaces as a
receipt failure — never as a silently accommodating client change.

---

## Environment prerequisites

| Item | Requirement |
|---|---|
| Cloud | `AzureCloud` (v1 is public-cloud only) |
| Stamp | A Chaos Studio v2 deployment serving the pinned `api-version` |
| Workspace | One workspace used by **all three** checks |
| Scenario configuration | A short, safe, repeatable configuration (a no-op or low-blast-radius fault) |
| Identities | One federated (WIF/OIDC) CI identity per platform — GitHub Actions and Azure Pipelines — with **no** client secret |
| Role | The custom role from `security/chaos-studio-runner.role-template.json`, assigned at **workspace** scope |
| Builds | The private Action build ref and the `ChaosStudioWorkspacesDev` VSIX, both built from the release core commit |

Record the workspace resource ID's sha256 (never the raw ID):

```bash
printf '%s' "<workspace-resource-id>" | sha256sum
```

## RV1 — target-region protocol smoke

Run `validate`, then `execute`, then `cancel` against the workspace from **each**
private build, with request logging on. Record, for each long-running call: the
acceptance status, the trailing `Location` segments, the advertised `Retry-After`,
the terminal polled status, and the terminal `properties.status`. Also record the
wire shape actually observed (status/start/end field names and both error channels)
and the `api-version` the requests carried.

The receipt carries **one transcript per adapter** under `observations.transcripts`,
each tagged with its `platform` (`github-action`, `azure-pipelines-task`). Both are
required, and the two transcripts must report **different run IDs** — each private
build has to drive its own run. Re-recording a single run under two platform labels is
rejected.

Passes when *every* transcript's observed protocol equals the pinned contract: a `202`
acceptance with the expected `Location` suffix and `Retry-After`, a terminal `200`, a
terminal state in the contract's success set, a GUID run ID that the execute `Location`
and `runs/{runId}` suffix both address, a cancel `Location` addressing that same run,
and the exact field/error-channel names the fixtures encode.

## RV2 — workload identity and least privilege

1. Prove both federated identities acquire an ARM token **secretlessly**.
2. Record the role definition the identity actually held.
3. For **each** operation the journey invokes, run a negative case: remove that one
   operation from the role, re-run the journey, and record which calls failed and
   which still succeeded. Exactly that one call must fail.
4. Prove the operations the journey deliberately does not call
   (`Microsoft.Chaos/workspaces/read`,
   `Microsoft.Chaos/locations/workspaceOperationResults/read`) are genuinely
   unnecessary.

Passes when the role is exactly the required set — no missing, extraneous, unknown,
data-action, or `NotActions` entries — assigned at workspace scope, both identities
are secretless, and every negative case isolates a single operation.

## RV3 — cancellation operational bounds

Measure the wall-clock seconds from the cancel request to the observed `Canceled`
state; issue two rapid cancels and confirm both are accepted and the run stays on the
cancellation path; cancel an already-terminal run and confirm it is a safe accepted
no-op; and force a cleanup failure and confirm the **original** pipeline failure is
preserved.

Passes when cancellation completes within the cleanup deadline the client enforces
and every idempotency/precedence property above holds.

## Recording the receipt

```bash
mkdir -p test/release-validation/receipts
cp test/release-validation/receipt.template.json \
   test/release-validation/receipts/<tag>.json
```

Replace every placeholder with what you **observed** — not with what you expected —
set `"template": false`, set each check's `status` to `passed`, then:

```bash
node scripts/lib/rv-receipt.mjs stamp  test/release-validation/receipts/<tag>.json
node scripts/lib/rv-receipt.mjs verify test/release-validation/receipts/<tag>.json
```

`stamp` writes a canonical sha256 digest over the receipt body; `verify` re-derives it
and re-evaluates every observation against the source-proven contract constants. The
digest is **mandatory** — an unstamped receipt is rejected. Both verbs refuse the
committed template outright, so a checked-in skeleton can never satisfy a gate. Commit
the receipt and proceed to [`release.md`](release.md).

> **Trust boundary — read this before relying on a receipt.** The digest proves the
> committed bytes have not been edited *since stamping*; it is **not** a signature and
> it does **not** prove the observations came from a real environment. A receipt is
> operator-attested evidence, and its authority comes from the controls around it: it
> lands through a reviewed pull request, it is bound to one core commit and to shipped
> trees that must be byte-identical at release time, its observations are
> independently re-evaluated against the source-proven contract (so a fabricated
> receipt must reproduce the true contract exactly to pass), and it expires. Review a
> receipt PR as you would any other security-relevant change: confirm the run IDs,
> region, and workspace hash correspond to a real validation session. Replacing this
> with a CI-generated, workload-identity-signed attestation is the next hardening step
> and is tracked as follow-up work.

`verify` honours two environment variables:

- `EXPECTED_CORE_COMMIT` — require the receipt to be bound to this commit SHA. The
  release configs do **not** set this; they instead re-derive the commit from the
  receipt and then prove ancestry plus shipped-tree equality against the release
  commit. Use it manually when you want to assert a specific commit.
- `MAX_AGE_DAYS` — reject evidence older than this many days (default `30`). Both
  release configs set this to `30`.

Exit codes: `0` gate passed, `1` gate **failed** (evidence rejected), `2` usage or
I/O error.

Shipped-tree equality has a second half on the Azure Pipelines side, because the
OneBranch `build` stage **rebuilds** `dist/` and packages the rebuilt runtime rather
than the committed blobs. After `npm run build`, and before anything is staged,
packaged, signed or published, it runs:

```bash
node scripts/lib/verify-built-runtime.mjs <validated-commit>
```

which requires the rebuilt `dist/` to equal the `dist/` committed at the receipt's
validated commit exactly — the complete file set (added **and** removed),
git-normalized modes, and blob hashes. That closes the gap where a changed build
*input* outside the compared shipping paths (`scripts/build.mjs`, the root dependency
metadata, a transitive bundler version) would otherwise produce packaged bytes RV1–RV3
never exercised. On a publishing run a missing baseline **fails**; it is never
downgraded to `HEAD`. Its exit codes match the receipt CLI: `0` pass, `1` mismatch
(release blocked), `2` usage or I/O error.

---

## Responding to a failed RV

**Do not** edit the receipt, relax an evaluator, or set `MAX_AGE_DAYS` higher to get
past a red gate. Triage by what failed:

| Failure | Meaning | Action |
|---|---|---|
| `api-version`, `wire:`, `Location suffix`, `Retry-After`, or terminal-state failures in RV1 | The deployed service does not match the source-derived contract | **Open a service defect** with the Chaos Studio service team and stop the release. See [`contract-drift.md`](contract-drift.md). Do not change the client to match. |
| RV2 role `missing`/`extraneous`/`unknown` | The shipped least-privilege role template is wrong, or the provider operation set moved | Fix `security/chaos-studio-runner.role-template.json` (missing/extraneous) or open a **service defect** (unknown operation), then re-run RV2. |
| RV2 identity failures | Federation is misconfigured | Fix the federated credential subject/audience and re-run; this is an environment fix, not a code change. |
| RV3 duration over the cleanup deadline | The service's cancellation is slower than the client's bound | **Open a service defect**; a client timeout increase requires a reviewed change and a fresh RV pass. |
| RV3 idempotency/precedence failures | Cancellation semantics regressed | **Open a service defect**. |
| `digest:` mismatch | The receipt was edited after stamping | Re-run the affected checks and produce a fresh receipt. Never re-stamp an edited receipt. |
| `unstamped` | The receipt was never stamped | Run `rv-receipt.mjs stamp` and commit the result. |
| `in the future` / `after the receipt` | The timestamps are inconsistent or post-dated | Correct the recorded instants from the actual session; post-dating to defeat staleness is prohibited. |
| `expected exactly one '<platform>' transcript` / `its own run` | RV1 was not run from both private builds, or one run was recorded twice | Run RV1 from the missing adapter and record its own transcript. |
| `older than N days` | The evidence is stale | Re-run RV1–RV3. |
| `is not an ancestor` / `changes shipped code` | The release commit is not what was validated | Re-run RV1–RV3 against the actual release commit. |

Every service defect must name the observed value, the expected contract value, the
region, and the receipt path. Link the defect from the release issue and keep the
release blocked until it is resolved or the contract is re-derived and re-reviewed.
