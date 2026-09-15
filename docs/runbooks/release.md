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

## 0. Pick the release commit

Choose one commit on `main` that contains everything shipping. Record its full
40-character SHA — this is the **core commit**, the commit RV1–RV3 were run against.
It must appear in both:

1. the `coreCommit` of the release-validation receipt, and
2. the `coreCommit` of each artifact entry in that receipt.

The commit you actually release (the tag target / the OneBranch build commit) is
normally a **later** commit — at minimum the one that adds the receipt itself. That is
expected and allowed. What both release configs enforce is:

- the receipt's core commit is an **ancestor** of the release commit, and
- the **shipped trees are byte-identical** between them.

So changes to `docs/**` or to the receipt itself may land after the validated commit;
changes to `packages/**`, `action.yml`, `dist/**`, or `azure-pipelines-extension/**`
may not — they invalidate the RV evidence and require a re-run.

## 1. Confirm the evidence is in place

```bash
git rev-parse HEAD                       # the core commit
node scripts/lib/rv-receipt.mjs verify test/release-validation/receipts/<tag>.json
```

The receipt lives at `test/release-validation/receipts/<tag>.json`, where `<tag>` is
the release tag (for example `v1.0.0`). `verify` prints
`receipt-core-commit=` and `receipt-digest=`; the core commit must match step 0.

## 2. Release the GitHub Action

The release workflow is **dispatch-only** — it creates the tag itself, so do not push
a release tag by hand.

1. Run `.github/workflows/release-action.yml` via **workflow dispatch from
   `main`** (the job refuses any other ref), with:

   - `tag` = the exact release version, e.g. `v1.0.0`
   - `commit` = the core commit from step 0 (only needed for a first publish of the
     tag; an existing tag pins its own release commit)

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

> A cryptographic SLSA build-provenance attestation is **not** emitted today. Adding
> one requires `attestations: write` on the publish job and is tracked as follow-up
> work; until then the receipt, the committed `dist`, and the gate log are the audit
> trail.

## 3. Release the Azure Pipelines extension

Run the `.pipelines/OneBranch.Official.yml` Official pipeline from `refs/heads/main`
at the **same core commit**, with:

- `publishExtension` = `true`
- `extensionManifest` = `vss-extension.json`
- `releaseValidationReceipt` = the receipt basename from step 1 (for example
  `v1.0.0`) — the basename only, under
  `test/release-validation/receipts/`.

The unsigned `build` stage runs the same receipt gate before packaging, the `sign`
stage is a deployment job bound to the ESRP signing environment, and the `publish`
stage is a `releaseJob` that re-verifies the signature of the artifact it received
before spending the Marketplace credential.

**Provenance (ADO side):** the published VSIX carries an ESRP `external_distribution`
signature, cryptographically validated by CodeSign Validation in both the sign and
publish stages. Record the pipeline run ID and build number in the release notes.

## 4. Record the release

In the GitHub release notes for the tag, record:

- the core commit SHA,
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
