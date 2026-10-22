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

A **confirmed** protocol mismatch — one triage attributes to the service, not to this
repository — is a **service defect**, not a client bug. When the contract and the
service disagree, the response is to escalate to the Chaos Studio service team —
never to quietly change the client to match. Concretely, the following are prohibited
as a response to a red drift run, whichever cause triage lands on:

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
| A contract check reported `contract=mismatch` — provenance re-derivation, the **source-protocol** suite, or the pinned `api-version` assertion | `contract-drift` | A **confirmed mismatch between this repository's committed artifacts**: the fixtures, extracts, recorded hashes and pinned constants no longer agree. That is real and blocks releases, but it does **not** by itself say whether the repository or the service moved — these checks cannot see the service. Triage it with step 3 below before classifying it as a service defect. |
| The job failed without any contract check reporting a mismatch — `npm ci`, the runner, a timeout, the repository-policy assertions, the repository-side release-validation suite, or a contract check that **could not be evaluated** | `contract-drift-workflow-failure` | **Not** evidence of drift. Fix the workflow; do not file a service defect on the strength of it. Drift detection is not running until it is green. |

The three contract checks are evaluated by `scripts/lib/contract-drift.mjs`, which
reports a three-way verdict — a shell wrapper cannot, because `git diff --exit-code`
exits `1` for "there are differences" and `128` for "git could not run", and
`node --test` exits nonzero for a failed assertion, a syntax error, an unresolvable
import and an empty glob alike:

| Exit | Verdict | Effect |
|---|---|---|
| `0` | Checked; the contract matches. | Nothing recorded. |
| `1` | Checked; an **identified** disagreement (a `git diff` that reported differences, a failing **source-protocol** assertion, an exported `API_VERSION` that disagrees with the pin). | Records `contract=mismatch`; only this can become a service defect, and only after triage attributes it to the service. |
| `2` | The check **could not be evaluated** (a failed `git`, an unreadable file, a test file that will not parse or import, an empty test discovery, a test that died before any contract assertion ran, an unclassified contract test). | Records nothing; reported as a drift-check failure. |

### Issues left over from an earlier generation of the workflow

An earlier generation of this workflow declared every contract mismatch a **service
defect** outright. That classification was withdrawn — the checks observe only this
repository — so an issue opened under it carries a verdict this repository no longer
stands behind. Every body the workflow composes now ends with a classification marker;
an open `contract-drift` issue is recognized as stale only when **this workflow wrote
it** (the issue is bot-authored), it **lacks the marker**, and the **whole structure of
the old report** is present — its opening finding, its generated run link, the withdrawn
verdict and its runbook pointer. All three are required, because containing the old
wording is not by itself evidence that the workflow produced it. A stale issue is then
handled by whether a human has since touched it:

| The stale issue | What the next scheduled run does |
|---|---|
| Still exactly as the workflow wrote it (title and body unedited) | Its title and body are **migrated** to the current triage-required classification. No human triage exists to lose. |
| Edited or retitled by a person | Title and body are **left as filed** — recorded triage is authoritative. A one-time corrective comment states that the automated service-defect classification was withdrawn and that the mismatch must be triaged against the authoritative source or a live RV1 observation. |

The corrective comment carries its own marker and is posted once per issue, not on
every run. A current-generation issue, a `contract-drift-workflow-failure` issue (whose
wording never changed), and any human-filed issue are all left alone — including one
that quotes the old report in full, since the corrective notice asserts the issue was
filed by an earlier generation of the workflow and that would be untrue of it. The
behaviour is covered in `test/release-validation/drift-report-issue.test.ts`, which
evaluates the workflow's own inline reporting script and replays the previous generation
from `test/release-validation/fixtures/contract-drift.legacy-generation.yml` — a
byte-identical copy of that workflow revision, preserved as a fixture so the guard holds
in the shallow checkouts CI uses and cannot degrade into comparing the current wording
with itself.

### Only source-protocol assertions can produce a mismatch

`packages/core/test/contract/` holds two different kinds of assertion, and only one of
them is evidence about the **service**:

| Bucket | Files | Check | Can produce a mismatch? |
|---|---|---|---|
| **Source-protocol** — the shipped fixtures and constants versus the reviewed GW/BE source extracts | `contract`, `validate`, `run`, `cancel`, `operations`, `provenance` | `contract-suite` | Yes |
| **Repository-policy** — the packaged task manifest (e.g. `minimumAgentVersion`), the signing pipeline, the release tag rulesets, workflow permissions, the C# extraction machinery | `manifest`, `ado-pipeline`, `release-fnmatch`, `tagRulesetEval`, `workflowPermsAudit`, `source-extracts` | `repository-suite` | **No** — reported as a repository regression |

The classification is explicit, and the `classify` check fails the job when a contract
test file is **unclassified** (newly added and nobody said what it observes) or
**stale** (classified but deleted). An unclassified file is never assumed to be
protocol evidence, and is never silently skipped either. When you add a contract test,
add it to `SOURCE_PROTOCOL_TESTS` or `REPOSITORY_POLICY_TESTS` in
`scripts/lib/contract-drift.mjs`. `classify` runs **independently** of the suites: a
newly added unclassified file fails the job, but it never suppresses the verdict the
already-classified source-protocol assertions would publish.

Two source-protocol files also carry a handful of assertions that observe **this
repository** rather than the service — the client's own naming/enum conventions in
`contract.test.ts` (D1/NFR5/D11 and the normalized error categories), and the fixture
validator's negative self-tests in `provenance.test.ts` (`negative: …`, which feed the
validator a deliberately broken input and assert it is rejected). Those are listed per
file in `REPOSITORY_ONLY_ASSERTIONS`: a failure confined to them is reported as a
repository regression with **no** contract evidence, while any other failing assertion
in the same file is still a mismatch. Because the runner reports failures by name
alone, the suite evaluates **each source-protocol file separately** and applies only
that file's rules, so an exemption can never suppress a genuine protocol failure that
happens to be named the same way in another file. `classify` additionally fails when a
listed rule matches no test in its own file (it has rotted) or also matches a test in
another protocol file (the rule is then ambiguous about what it exempts, and its twin
is left unclassified).

Start from that issue. All contract checks run **independently** of one another
(and ahead of the repository-side release-validation suite), so one failure never
suppresses another check's verdict.

1. **Read which step failed**, and whether it reported a mismatch (exit 1) or an
   unevaluable check (exit 2 — the log says so explicitly).

   | Failing step | Contract evidence? | Meaning |
   |---|---|---|
   | Install workspace dependencies | No | Setup failure; says nothing about the contract. |
   | Contract-test classification (`classify`) | No | A contract test is unclassified or stale; no contract verdict can be trusted until it is fixed. |
   | Provenance re-derivation | Only on exit 1 | A fixture, a source extract, or a recorded hash no longer agrees with the rest — usually an edit that bypassed the generator. |
   | Source-contract suite | Only on exit 1 | A **source-protocol** assertion about the wire shape broke. |
   | Repository-policy assertions | No | The packaged manifests, the signing pipeline, or the release rulesets regressed — a repository defect, not a protocol mismatch. |
   | Release-validation suite | No | This repository's release machinery regressed (receipt evaluators, RBAC template, release gates) — a repository defect, not a protocol mismatch. |
   | Pinned `api-version` assertion | Only on exit 1 | The **exported** constant moved, or a literal somewhere in the shipped surface disagrees with it. |

2. **Reproduce locally** at the same commit:

   ```bash
   npm ci
   node scripts/lib/contract-drift.mjs classify
   node scripts/lib/contract-drift.mjs provenance
   node scripts/lib/contract-drift.mjs contract-suite
   node scripts/lib/contract-drift.mjs repository-suite
   node scripts/lib/contract-drift.mjs api-version
   node --test "test/release-validation/**/*.test.ts"
   ```

3. **Classify the cause.** The drift checks cannot do this for you: they observe only
   this repository, so classification needs evidence from outside it — the
   authoritative service source for the pinned version, or a live-environment RV1
   observation ([`release-validation.md`](release-validation.md)). Until you have
   that evidence, the issue is an unclassified contract mismatch, not a service
   defect.

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
2. **Change the constant.** Update `API_VERSION` in `packages/core/src/contract.ts`,
   and the `PINNED_API_VERSION` the drift check audits it against in
   `scripts/lib/contract-drift.mjs` (deliberately restated there: a check that read its
   expectation from the file it audits would never fail). The check **loads the module
   and compares the exported value**, not the source text, so the declaration's quoting,
   type annotation, or re-export form is irrelevant — and an expected declaration left
   behind in a comment will not satisfy it. There is exactly one pinned
   value; no per-operation or per-adapter override, and no input that lets a caller
   select it.
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
`test/release-validation/release-handoff.test.ts`. The checks it runs live in
`scripts/lib/contract-drift.mjs`, whose mismatch-versus-execution-error behaviour is
covered by `test/release-validation/contract-drift-checks.test.ts` — including the
cases where the check fails *before* any contract assertion runs, and the cases that
distinguish a repository-policy assertion failure from a genuine protocol mismatch.
Weakening the
workflow (removing the schedule, suppressing a failure, dropping a suite) or blurring
that distinction fails those tests on the pull request, which is intentional: the drift
detector cannot be quietly disabled, and it cannot be made to claim evidence it does
not have.
