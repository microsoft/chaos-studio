# Runbook — rollback and deprecation

Use when a published release is bad, or when a version, task, or the integration
itself is being retired. The two marketplaces have **asymmetric** rollback
capabilities, so the procedures differ and the safe response differs with them.

**Severity first.** If the bad release can cause a customer-visible fault to run
unexpectedly, or can leak a token, treat it as a live incident: roll back the
GitHub Action immediately (step 1, it is fast), then start the Marketplace path in
parallel and notify `aces@microsoft.com`.

---

## 1. Roll back the GitHub Action

The Action is consumed as `microsoft/chaos-studio@v1`. Almost every consumer is on the
**floating major tag**, so repointing it is the single highest-leverage action and
takes effect on the consumer's next run with no action from them.

> **The tag ruleset blocks an ordinary force-push of `v1`.** Only the dedicated
> release identity (`secrets.ACTION_RELEASE_TOKEN`, the principal on the ruleset
> bypass list) may write that ref, and `release-action.yml` will **not** move `v1`
> backwards — its floating-major step stands down unless the tag being released is
> the highest exact version in the major line. Roll **forward** wherever the delay is
> tolerable; the manual repoint below is an incident-only path that requires the
> release identity's credential.

1. **Preferred — roll forward.** Cut a new patch version above the bad one from the
   known-good code and release it normally
   ([`release.md`](release.md)); the workflow advances `v1` to it because it is then
   the highest version. This keeps every control intact and leaves an audit trail.

   This requires a fresh receipt, because the shipped trees changed
   ([`release-validation.md`](release-validation.md)).

2. **Incident only — repoint `v1` directly.** Performed by the release identity,
   because no other principal can write the ref:

   ```bash
   # Authenticated as the release identity (on the tag-ruleset bypass list).
   git tag -f -a v1 -m 'Rollback: v1 -> <last-good-version>' <last-good-core-commit>
   git push --force origin v1
   ```

   Record who performed it and why; the next forward release will re-advance `v1`
   through the normal gated path.

3. Mark the bad GitHub release as a pre-release (or delete it) so it stops being
   "Latest". Keep the immutable version tag: consumers pinned to the exact SHA or
   version must still resolve, and deleting it breaks their pipelines rather than
   fixing them.
4. Add a prominent notice to the bad release's notes: what is wrong, which versions
   are affected, and what to move to.
5. If consumers may be pinned to the bad exact version, open a repository advisory
   naming the affected versions.

**Never** re-publish a different build under an already-published version number.
Cut a new patch version from a new core commit and move `v1` to it.

## 2. Roll back the Azure Pipelines extension

The extension is `AzureChaosStudio.ChaosStudioWorkspaces` on the Visual Studio
Marketplace. It has no "revert" operation, so rollback means **publishing forward**:

1. Fix the defect, or revert the offending change, on `main`.
2. Run RV1–RV3 against the fix and record a receipt
   ([`release-validation.md`](release-validation.md)).
3. Run the Official pipeline with `publishExtension = true` at the new **release
   commit** — the commit that carries the new receipt, which the pipeline reads from
   its own checkout (the validated core commit it records normally predates it).
   `PackageAzureDevOpsExtension` stamps a strictly increasing task version, so agents
   pick up the corrected task rather than a cached older one.
4. If the defect is severe and no fix is ready, **unpublish** the extension
   (Marketplace → Manage publishers → `AzureChaosStudio` → Unpublish). Unpublishing
   removes it from discovery and new installs; it does **not** uninstall it from
   organizations that already have it. Those organizations must be notified directly.

> **A published task version cannot be deleted.** Marketplace extension versions and
> the task versions inside them are immutable once published; installed organizations
> may continue to resolve them. Rolling forward with a higher version is the only
> reliable correction, which is exactly why the release-validation gate sits *before*
> signing and publishing.

## 3. Verify the rollback

- GitHub: `git ls-remote origin 'refs/tags/v1^{}'` resolves to the known-good **commit**
  (the `^{}` peels the annotated tag object — without it you get the tag object's SHA,
  not the commit), and a scratch workflow using `microsoft/chaos-studio@v1` runs the
  known-good version.
- Azure DevOps: a scratch pipeline using the task reports the corrected task version
  in its log header.
- Record the incident, the bad version, the corrective version, and the verification
  evidence in the release issue.

---

## Deprecation

### Deprecating an Action version

1. Announce in the repository README and the release notes at least one release
   ahead, with the replacement and a date.
2. Mark superseded GitHub releases as **deprecated** in their notes, naming the
   replacement.
3. Keep the immutable version tags in place; keep `v1` on the newest supported 1.x.
4. Only a *major* change moves consumers to a new floating tag (`v2`). `v1` keeps
   receiving security fixes for the announced support window.

### Deprecating an extension task

A task inside `ChaosStudioWorkspaces` is retired, never deleted:

1. Set `"deprecated": true` on the task in its `task.json` and publish. Azure DevOps
   then shows the task as deprecated in the designer and warns in logs, while existing
   pipelines keep working.
2. Point the task's `helpMarkDown` at the replacement.
3. Keep the permanent task `major` version and the task GUID stable — changing either
   breaks existing pipeline definitions.
4. Remove the task only after the announced support window, understanding that
   organizations that already installed a version containing it retain that version.

### Retiring the integration

Deprecate both platforms in the same release, keep them functional for the announced
window, publish a migration note in `docs/ci-cd-integrations.md`, and unpublish the
extension and archive the Action tags only at the end of the window.
