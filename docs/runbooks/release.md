# Runbook — release both marketplaces from one commit

Applies to the private preview, the public preview, and GA. The GitHub Action
(`microsoft/chaos-studio@v1`) and the Azure Pipelines extension
(`AzureChaosStudio.ChaosStudioWorkspaces`) are two adapters over **one** shared
core, so they are released from **one commit** and carry the same behaviour.

**Prerequisites:** the external controls in [`README.md`](README.md) are provisioned,
`scripts/verify-release-protections.sh` and `scripts/verify-ado-signing-protections.sh`
both pass in the live tenants, and RV1–RV3 are green with a committed receipt
([`release-validation.md`](release-validation.md)).

---

## 0. Pick the two commits

Two distinct commits are involved, and confusing them blocks the release:

- the **validated core commit** — the commit RV1–RV3 were run against. Record its
  full 40-character SHA. It must appear in both:

  1. the `coreCommit` of the release-validation receipt, and
  2. the `coreCommit` of each artifact entry in that receipt.

- the **release commit** — the commit you actually release (the tag target / the
  OneBranch build commit). It is normally a **later** commit: at minimum the one that
  adds the receipt itself. Both release configs read the receipt **from their own
  checkout of the release commit**, so the release commit is the one that *contains*
  `test/release-validation/receipts/<tag>.json`. Releasing the validated core commit
  instead would check out history that has no receipt and the gate would reject it.

That the two differ is expected and allowed. What both release configs enforce is:

- the receipt's core commit is an **ancestor** of the release commit, and
- the **shipped trees are byte-identical** between them.

So changes to `docs/**` or to the receipt itself may land after the validated commit;
changes to `packages/**`, `action.yml`, `dist/**`, or `azure-pipelines-extension/**`
may not — they invalidate the RV evidence and require a re-run.

That comparison covers the **committed** shipping paths. The Azure Pipelines
extension additionally **rebuilds** `dist/` and packages the result, so a change to a
build *input* that lives outside those paths — `scripts/build.mjs`, the root
dependency metadata, a transitive bundler version — could otherwise alter the
packaged bytes while the comparison still passed. The OneBranch `build` stage
therefore also runs, after `npm run build` and **before** anything is staged,
packaged, signed or published:

```bash
node scripts/lib/verify-built-runtime.mjs <validated-commit>
```

which requires the rebuilt `dist/` to equal the `dist/` committed at the validated
commit exactly — the complete file set (added **and** removed), git-normalized modes,
and blob hashes. If a build input moved, this fails and the fix is to re-run RV1–RV3
against the commit being released, not to bypass the check. The same invariant is
enforced on the GitHub side by the `validate` job's clean-rebuild comparison.

## 1. Confirm the evidence is in place

Run this on a checkout of the **release commit** — the commit that carries the receipt:

```bash
git rev-parse HEAD                       # the release commit
node scripts/lib/rv-receipt.mjs verify test/release-validation/receipts/<tag>.json
```

The receipt lives at `test/release-validation/receipts/<tag>.json`, where `<tag>` is
the release tag (for example `v1.0.0`). `verify` prints
`receipt-core-commit=` and `receipt-digest=`; `receipt-core-commit` must equal the
**validated core commit** from step 0, and `git merge-base --is-ancestor
<receipt-core-commit> HEAD` must succeed.

## 2. Release the GitHub Action

The release workflow is **dispatch-only** — it creates the tag itself, so do not push
a release tag by hand.

1. Run `.github/workflows/release-action.yml` via **workflow dispatch from
   `main`** (the job refuses any other ref), with:

   - `tag` = the exact release version, e.g. `v1.0.0`
   - `commit` = the **release commit** from step 0 — the commit that contains
     `test/release-validation/receipts/<tag>.json`, **not** the validated core
     commit (the `validate` job checks that commit out before reading the receipt,
     so a commit without the receipt fails the gate). Only needed for a first
     publish of the tag; an existing tag pins its own release commit.

   > **The tag must be exact `vMAJOR.MINOR.PATCH` SemVer with no leading zeros.**
   > The workflow rejects prerelease suffixes, so `v1.0.0-preview.1` is **not** a
   > valid tag. "Preview" is conveyed by the Marketplace listing and release notes,
   > not by the version string. Name the receipt for that same exact tag
   > (`test/release-validation/receipts/v1.0.0.json`).

2. The non-secret `validate` job re-verifies the receipt, proves the validated commit
   is an ancestor of the release commit, and proves the shipped trees are
   byte-identical to what RV1–RV3 exercised. The `package` job packages the committed
   `dist` **from git**, and only the isolated `publish` job holds a credential.
3. Approve the release environment when prompted.
4. The `publish` job creates the immutable tag at the release commit and, once the
   release is published, advances the floating major tag `v1` itself — **only** when
   this release is the highest version in the major line. There is no manual tag step.

**Provenance (GitHub side):** the release is bound to its evidence by the `validate`
job, whose log prints the validated core commit and the receipt digest. The workflow
creates the release with placeholder/auto-generated notes, so writing that provenance
**into** the notes is the operator step in section 4 below — do not skip it, or the
published notes will keep their staging text. Verify a published release by re-running
the same check locally:

```bash
git rev-parse <tag>^{commit}
node scripts/lib/rv-receipt.mjs verify test/release-validation/receipts/<tag>.json
```

The printed `receipt-core-commit` must be an ancestor of the tag's commit, and
`receipt-digest` must match what section 4 recorded.

**Cryptographic build provenance (GitHub-native attestation):** the `publish` job
generates a [SLSA build-provenance attestation](https://docs.github.com/en/actions/security-guides/using-artifact-attestations-to-establish-provenance-for-builds)
via `actions/attest-build-provenance`, using the job's own OIDC identity
(`id-token: write`) — no long-lived signing secret. The attestation subject is
the exact `action-bundle.tar.gz` bytes already verified against the release's
published sha256 digest in the same job, so it is bound to the published
artifact, not merely to the release commit. `attestations: write` is scoped to
only the `publish` job (least privilege).

Verify a published release's standard build-provenance attestation with the
GitHub CLI, constraining it to the intended signer workflow (`--repo` alone
only proves SOME workflow in the repository signed it; `--signer-workflow`
additionally proves it was THIS workflow):

```bash
gh attestation verify pkg/action-bundle.tar.gz --repo <owner>/<repo> \
  --signer-workflow <owner>/<repo>/.github/workflows/release-action.yml \
  --predicate-type https://slsa.dev/provenance/v1
```

This checks the Sigstore signature, confirms the artifact digest, and confirms
the attestation was produced by this repository's `release-action` workflow.

A **separate, second** attestation (predicate type
`https://chaos-studio.dev/attestations/release-commit/v1`) additionally binds
the same artifact digest to the exact release commit that produced it — the
standard build-provenance statement above only records the *dispatch run's*
own source SHA, which is not the same thing when `main` has advanced past an
ancestor release or a tag is retried. Verify that custom binding, and its
`releaseCommit` predicate field, separately:

```bash
gh attestation verify pkg/action-bundle.tar.gz --repo <owner>/<repo> \
  --signer-workflow <owner>/<repo>/.github/workflows/release-action.yml \
  --predicate-type https://chaos-studio.dev/attestations/release-commit/v1 \
  --format json | jq -r '.[0].verificationResult.statement.predicate.releaseCommit'
```

The printed `releaseCommit` must equal the exact commit the tag points at
(`git rev-parse <tag>^{commit}`). Both attestations must verify, and both must
be signed by this repository's `release-action` workflow, before the release's
provenance is considered established.

### 2a. GitHub Marketplace listing (manual operator/admin handoff)

**The `release-action.yml` workflow creates only the GitHub Release and its
tags — it does not publish or update a GitHub Marketplace listing.**
Publishing `microsoft/chaos-studio` as a Marketplace **Action** is a separate,
manual, repository-admin action that GitHub does not expose as an API a
workflow can call; it must be done by hand, once per major listing change,
through the repository's release UI:

1. A repository **owner/admin** must have accepted the
   [GitHub Marketplace Developer Agreement](https://docs.github.com/en/apps/github-marketplace/github-marketplace-overview/github-marketplace-developer-agreement)
   for the organization before any listing can go live. Confirm this is on
   file; it is a one-time, org-level acceptance, not part of this workflow.
2. After the GitHub Release from section 2 is published, an admin opens the
   release on github.com and checks **"Publish this Action to the GitHub
   Marketplace"** (or, for an existing listing, confirms the new release
   version is picked up) — this is a UI-only opt-in with no CLI/API
   equivalent; the automated release workflow cannot perform it.
3. Set/confirm the listing's **category** (and any primary/secondary category)
   appropriate to a chaos-engineering/testing action, and review the listing's
   name, icon (from `action.yml`'s `branding:`), and description for accuracy.
4. **Verify the listing**, not just the release: visit
   `https://github.com/marketplace/actions/<listing-slug>` and confirm the new
   version is listed before considering the release fully handed off.

This Marketplace enrollment/verification step is **distinct from and
additional to** the automated release created in section 2 — a green
`release-action.yml` run means the Release and its provenance are complete,
**not** that the Action is discoverable on the Marketplace. Do not skip it for
a release that is meant to be publicly discoverable. It has no bearing on the
protected `release` environment or the credential-holding `publish` job; it is
a separate, credential-free admin action taken after those complete.

## 3. Release the Azure Pipelines extension

**Run this after section 2.** The exact version tag the GitHub release creates is the
**shared release record**: the OneBranch build requires its own build commit to be the
commit that tag resolves to. A per-pipeline receipt gate cannot enforce that on its own
— any receipt-bearing descendant of the validated core commit would satisfy it, so the
two marketplaces could each pass their own gate on a *different* commit.

Run the `.pipelines/OneBranch.Official.yml` Official pipeline from `refs/heads/main`
at the **same release commit** used in section 2 — the receipt-bearing commit, since
this pipeline also reads the receipt from its own checkout. Both marketplaces are
therefore built from one commit, holding the one validated core commit recorded in
that receipt. Set:

- `publishExtension` = `true`
- `extensionManifest` = `vss-extension.json`
- `releaseTag` = the exact release tag from section 2 (for example `v1.0.0`). It
  selects **both** halves of the evidence — the receipt at
  `test/release-validation/receipts/<tag>.json` and the shared release commit — so the
  two can never disagree.

The unsigned `build` stage runs the same receipt gate before packaging, and
additionally runs:

```bash
node scripts/lib/release-commit.mjs assert-tag-commit <tag> <build-commit>
```

which resolves `refs/tags/<tag>` and **rejects any other build commit** (an ancestor,
a later receipt-bearing commit, or a branch that happens to share the tag's name). If
the tag does not exist yet, the build fails: release the Action first. The `sign`
stage is a deployment job bound to the ESRP signing environment, and the `publish`
stage is a `releaseJob` that re-verifies the signature of the artifact it received
before spending the Marketplace credential.

**Provenance (ADO side):** the published VSIX carries an ESRP `external_distribution`
signature, cryptographically validated by CodeSign Validation in both the sign and
publish stages. Record the pipeline run ID and build number in the release notes.

## 4. Record the release

In the GitHub release notes for the tag, record:

- the validated core commit SHA and the release commit SHA,
- the receipt path and its `receipt-digest`,
- the Action version and the extension version/task version, and
- the OneBranch run ID.

This is the audit trail that ties one commit to two marketplace artifacts.

## 5. If something goes wrong

- A gate rejects the receipt → [`release-validation.md`](release-validation.md).
- A published release is bad → [`rollback-and-deprecation.md`](rollback-and-deprecation.md).
- The contract itself moved → [`contract-drift.md`](contract-drift.md).

Never disable a gate to get a release out. Every gate here exists because the
failure it prevents is worse than a late release.
