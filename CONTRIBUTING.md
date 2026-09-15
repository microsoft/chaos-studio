# Contributing to Azure Chaos Studio (open source)

Thanks for helping improve the open-source tooling for Azure Chaos Studio! This
repo is a monorepo — start with the component you're working on:

| Component | Where | Guide |
|---|---|---|
| GitHub Action + Azure Pipelines task | [`packages/`](packages/), [`action.yml`](action.yml), [`azure-pipelines-extension/`](azure-pipelines-extension/) | shared TypeScript core in [`packages/core`](packages/core/); see below |
| Copilot CLI plugin + MCP server | [`copilot-cli-plugin/`](copilot-cli-plugin/) | [copilot-cli-plugin/CONTRIBUTING.md](copilot-cli-plugin/CONTRIBUTING.md) |
| Scenarios | [`scenarios/`](scenarios/) | one folder per scenario; include a short README |
| Samples | [`samples/`](samples/) | self-contained, deployable, safe to break |

## CI/CD integrations (npm workspace)

The GitHub Action and Azure Pipelines task share one TypeScript core under
[`packages/`](packages/), managed as an npm workspace that coexists with the
Python and PowerShell tooling. It targets Node 24.

```bash
npm ci            # install workspace dependencies
npm run typecheck # tsc --noEmit across the workspace
npm test          # run the shared-core contract tests
npm run build     # regenerate the committed dist/ bundles (commit the result)
```

The committed `dist/` bundles must always equal a clean rebuild: PR CI and the
release `validate` job both rebuild into an empty directory and compare the
complete file set and every git blob hash, so run `npm run build` and commit the
output whenever the bundle sources change.

### Required external release controls (provision once, then verify)

The release workflows depend on GitHub org/repo controls that live in **settings, not
in this repository**, so a maintainer must provision them **once** before the first
release. The three "required configuration" sections below give the exact one-time `gh`
commands; the checklist is:

- [ ] `release` environment hardened — required reviewers, `prevent_self_review=true`,
  `can_admins_bypass=false`, single default-branch deployment policy, `ACTION_RELEASE_TOKEN`
  (`Contents: write` + `Actions: read` + `Administration: read`).
- [ ] `mcp-release` environment hardened — same protections; holds `ACTION_RELEASE_TOKEN`
  (`Contents: write` + `Actions: read` + `Administration: read`).
- [ ] `pypi` environment hardened — same protections (required reviewers +
  `prevent_self_review=true` + `can_admins_bypass=false` + default-branch-only).
- [ ] `RELEASE_IDENTITY_ACTOR_ID` repository variable = the dedicated release User's actor id.
- [ ] `release-tags-v` tag ruleset — active, `refs/tags/v*`,
  creation+update+deletion+non_fast_forward (block force pushes — the floating major tag
  `v1` must not be force-movable by anyone but the release identity),
  bypass = only that User (`always`).
- [ ] `release-tags-mcp-v` tag ruleset — active, `refs/tags/mcp-v*`, same restrictions/bypass.
- [ ] **Immutable releases enabled** (Settings → General → Releases → "Immutable releases",
  or `PUT /repos/OWNER/REPO/immutable-releases`) so a published release's
  assets **and** tag are frozen by GitHub. The publish steps require the published
  release to be immutable and fail closed otherwise.
- [ ] **Exclusive release management** — minimize the set of principals with `contents:
  write` on the repository (that is the permission GitHub uses to create/edit/publish/
  delete releases and drafts). GitHub has **no per-release ACL**, so a reserved draft is
  **not** exclusively owned; the only way to *prevent* (not merely detect) draft tampering
  is to restrict `contents: write` to the dedicated release identity and the minimum
  required maintainers. Provision that restriction across **every** write surface — direct
  collaborators, teams, **organization owners** (admins of every repo), the **organization
  base repository permission** (must be `read`/`none`), installed **GitHub Apps** with
  `contents: write`, read-write deploy keys, and the **effective Actions workflow authority**
  (repo **and** org default workflow token set to **read-only**, and workflow PR-review
  approval disabled) — then run
  `scripts/verify-release-protections.sh OWNER/REPO DEFAULT_BRANCH "user:login,team:slug,app:slug,…"`
  passing the sanctioned writer set as a **required, TYPED** 3rd argument (each entry
  `user:`/`team:`/`app:`). The audit **fails acceptance** unless the sanctioned set EQUALS
  the actual writer set **exactly, in both directions** — it fails if the expected set is
  empty or untyped, if any write-capable principal (collaborator, org owner, team, app)
  falls outside it, if a sanctioned entry is **not** actually a writer, if a read-write
  deploy key exists, if the repo/org Actions token is write or can approve PRs, or if any of
  these surfaces (including GitHub App installations and org owners, which require an **org**
  repo to enumerate) cannot be fully enumerated. Rely on the tag rulesets + release
  environments as the enforced trust boundary and the publish-time immutability + digest
  verification as the authoritative
  last-line gate (see the threat-model notes under "Action release environment" and "MCP
  release").
- [ ] **ADO signing + publish resources branch-restricted** — on the signing pipeline
  ENVIRONMENT **`ChaosStudio-ESRP-Signing-Prod`** (the `onebranch.pipeline.signing@1` task
  takes no service connection; named in `OneBranch.Official.yml` as `SigningEnvironment`) AND
  the `ADO-Plugin Publishing` Marketplace service connection, set Approvals and checks →
  Branch Control = `refs/heads/main` and restrict Security → Pipeline permissions to EXACTLY
  the official pipeline; the publish connection additionally requires an Approval. These
  EXTERNAL controls (plus OneBranch platform governance of the `external_distribution`
  SignType) are the authoritative gate; the in-YAML branch conditions are defense in depth
  only (see "Azure Pipelines extension publish security"). Verify with
  `scripts/verify-ado-signing-protections.sh https://dev.azure.com/ORG PROJECT OFFICIAL_PIPELINE_ID`
  — the 1st argument is the full **ORG_URL** (`https://dev.azure.com/ORG`), not a bare org name.
  It requires `AZURE_DEVOPS_EXT_PAT` (a PAT scoped **Service Connections: Read + Environment: Read
  + Pipeline resources: Read + Build: Read** — Build: Read is needed to read the official build
  definition's repository identity / default branch / YAML path) and the REQUIRED env
  `BRANCH_CONTROL_TASK_VERSION`, `EXPECTED_REPOSITORY_ID`, and `EXPECTED_REPOSITORY_TYPE` (see
  "Azure Pipelines extension publish security" for the full invocation). It fails closed unless the
  signing environment + publish connection each carry a task-identified Branch Control limited to
  the trusted branch (`ensureProtectionOfBranch == "true"`, the singular `allowUnknownStatusBranch`
  absent or `"false"`) and sole official-pipeline permissions, and publish carries an approval.
  NOTE: `verify-release-protections.sh` verifies the GitHub controls; the ADO controls are verified
  by the ADO script.

After provisioning, **verify every control in one command** (the same fail-closed checks
the publish preflights run at release time, run ahead of time). `DEFAULT_BRANCH` (arg 2) is a
**required positional placeholder** — pass `""` to auto-detect the repo's default branch — and
`EXPECTED_WRITERS` (the 3rd argument) is **REQUIRED** — a non-empty, TYPED CSV
(`user:`/`team:`/`app:`); the verifier exits non-zero if it is omitted or empty:

```bash
# exits non-zero + lists anything missing; DEFAULT_BRANCH (arg 2) required ("" = auto-detect),
# EXPECTED_WRITERS (arg 3) REQUIRED
scripts/verify-release-protections.sh OWNER/REPO DEFAULT_BRANCH "user:login,team:slug,app:slug,…"
```

The committed release workflows also **fail closed** at release time if any of these is
absent or misconfigured (environment preflights, tag-ruleset preflights, the token
identity check, and the published-release immutability check), so a release can never
complete against unprovisioned protections.

### Immutable releases (required configuration)

Enable **immutable releases** for the repository so that once a release is published,
GitHub **freezes its assets and its tag** — they cannot be edited, replaced, or moved.
Both publish workflows (`release.yml` and `release-action.yml`) require GitHub to report
the release as immutable (`isImmutable=true`) after publishing and fail closed otherwise,
so this setting is mandatory, not advisory.

One-time provisioning (replace `OWNER/REPO`). Both calls target the dedicated
`/repos/{owner}/{repo}/immutable-releases` resource and require **admin access** to the
repository — a fine-grained token needs the **`Administration`** repository permission
(**write** to enable, **read** to check) — and pin the REST API version:

```bash
# Enable repository-level immutable releases (Settings → General → Releases →
# "Immutable releases"). PUT returns 204 No Content on success. After this, every
# newly published release is frozen by GitHub. Requires admin / Administration: write.
gh api --method PUT "repos/OWNER/REPO/immutable-releases" \
  -H "X-GitHub-Api-Version: 2022-11-28"

# Verify it is enabled. GET returns { "enabled": bool, "enforced_by_owner": bool }
# and requires admin READ access. Exits non-zero if not enabled.
gh api "repos/OWNER/REPO/immutable-releases" \
  -H "X-GitHub-Api-Version: 2022-11-28" --jq '.enabled' \
  | grep -qx true || { echo "immutable releases not enabled"; exit 1; }
```

### Action release environment (required configuration)

The [`release-action`](.github/workflows/release-action.yml) workflow publishes
the root Action's `v*` tags and GitHub Release. Its `publish` job runs in the
protected `release` GitHub Environment, which **must** be configured in repository
settings (Settings → Environments → `release`) with:

- **Required reviewers** — a human approval gate before any tag/Release write, with
  **self-review prevented** (`prevent_self_review=true`) so the actor who dispatches
  the release cannot approve their own deployment.
- **Administrator bypass disabled** (`can_admins_bypass=false`) so a repository admin
  cannot skip the required-reviewer gate — the approval is mandatory for everyone.
- **Deployment branches and tags = "Selected branches and tags"**, naming **only
  the exact default branch** (e.g. `main`). This is the authoritative control that
  a modified in-file guard cannot bypass; the workflow's `if:` gates
  (`github.ref_type == 'branch'` and the full `refs/heads/<default>` ref) are
  defense in depth.
- **`ACTION_RELEASE_TOKEN`** — an environment secret holding a **persistent
  fine-grained Personal Access Token owned by a dedicated release USER account** (not
  a human maintainer) with **`Contents: write`** (to push tags and create the Release),
  **`Actions: read`** (the fine-grained permission that governs the
  `GET .../environments` and `.../deployment-branch-policies` REST endpoints, so the
  publish preflight can verify these rules), and **`Administration: read`** (required by
  the repository-immutability precheck that `GET`s `.../immutable-releases` before any
  tag/Release write). A dedicated-user PAT is required because
  the `publish` job consumes `ACTION_RELEASE_TOKEN` as a **stored, long-lived secret**;
  a GitHub **App installation token cannot be used here** because it expires after
  ~1 hour and cannot be a stable secret. (If your org mandates a GitHub App identity
  instead, do **not** store its token: mint an installation token **at runtime** from
  the App id + private key — e.g. `actions/create-github-app-token` — and use the App's
  bot **actor id** as the tag-ruleset bypass actor; that variant is out of scope for
  the committed workflow, which expects the persistent dedicated-user PAT.) This
  release user is the **only** actor on the `v*` **tag ruleset** bypass list (see
  "Release tag protection" below), so it is the sole principal that can write a `v*`
  tag. The token is readable only from the `release` environment; the `validate` and
  `package` jobs never see it.

The `publish` job runs a **fail-closed preflight** that queries the environment via
the API and refuses to publish unless it exists with required reviewers,
`prevent_self_review=true`, `can_admins_bypass=false`, and a
default-branch-only deployment policy — a missing/misconfigured environment (or one
that admins can bypass, or that permits self-approval) cannot silently grant an
unprotected publish.

The GitHub Release is staged as a **draft** (not public): all assets are uploaded
to the draft, their exact set and sha256 digests are verified, and only then is the
release flipped to published atomically and the floating major tag advanced. A run
that fails before the flip leaves a repairable draft — never a partial public
release — and a rerun reconciles the draft's assets and publishes; an
already-published release is immutable and is verified, never mutated.

**Threat model — what the draft does and does not do.** Reserving the draft is a
best-effort **race-narrower**, not an exclusive-ownership guarantee: GitHub scopes
release management to the `contents` permission, so any repository writer (or a
compromised third-party action with `contents: write`) can in principle alter,
publish, or delete a draft before the publish job verifies it. The draft therefore
does **not** authenticate what ships. The real trust boundary is the combination of
the **`release` environment** (required reviewers, `prevent_self_review`,
`can_admins_bypass=false`, default-branch-only), the **`v*` tag ruleset** (only the
dedicated release identity may write `v*`), and the **dedicated release identity**
that holds `ACTION_RELEASE_TOKEN`. The actual gate on what reaches consumers is the **publish-time verification** in the `publish` job: it
downloads the release and fails closed unless the asset **set**, **count**, and
every **sha256 digest** equal the locally built artifacts, and unless GitHub reports
the release as **immutable** (frozen assets + tag). Any draft an outsider tampered
with therefore fails that verification and never publishes. To additionally *prevent*
(not just detect) draft tampering, restrict the `contents: write` role to the release
identity via org/repo role settings — an external control that cannot be enforced
from a workflow file.

One-time provisioning (replace `OWNER/REPO` and `main` as needed):

```bash
# Create/protect the environment with an approval gate and default-branch-only
# rule. JSON booleans must be TYPED (real JSON), not strings, so the API receives
# real booleans and typed ids. prevent_self_review=true stops the dispatcher from
# self-approving; can_admins_bypass=false makes the reviewer gate mandatory even for
# repository admins.
gh api -X PUT "repos/OWNER/REPO/environments/release" \
  --input - <<'JSON'
{
  "prevent_self_review": true,
  "can_admins_bypass": false,
  "deployment_branch_policy": {
    "protected_branches": false,
    "custom_branch_policies": true
  },
  "reviewers": [
    { "type": "User", "id": 0 }
  ]
}
JSON
# (Replace the reviewer id 0 with a real user/team id, or add more reviewers.)

# Restrict deployments to EXACTLY the default branch — a single BRANCH-type policy.
gh api -X POST "repos/OWNER/REPO/environments/release/deployment-branch-policies" \
  --input - <<'JSON'
{ "name": "main", "type": "branch" }
JSON

# Store the release identity's token as an environment-scoped secret.
gh secret set ACTION_RELEASE_TOKEN --env release --repo OWNER/REPO
```

### Release tag protection (required configuration)

The environment approval gate protects the *workflow*, but it does **not** by itself
stop someone with push access from creating or moving a `v*` tag **directly** (e.g.
`git push origin v1.2.3`, or force-moving the floating `v1`), which would forge a
release ref outside the reviewed pipeline. The authoritative control is a
**repository tag ruleset** that restricts `refs/tags/v*` **creation, update, deletion, and
force-update (`non_fast_forward`)** to **only the dedicated release identity**, with **no
broad administrator bypass**:

- **Target:** tag ruleset matching `v*` (fnmatch `v*`), **enforcement `active`**.
- **Rules:** enable **Restrict creations**, **Restrict updates**, **Restrict
  deletions**, and **Block force pushes** (`non_fast_forward`) so no ordinary actor can
  create, move, delete, or **force-update** a `v*` tag (all four are required — creation
  protection blocks a first-time `git push origin v1.2.3`, and `non_fast_forward` stops a
  non-bypass actor from force-moving the floating major tag `v1`); **Require signed tags**
  is optional but recommended.
- **Bypass list:** add **only** the dedicated release USER account (the same user that
  owns `ACTION_RELEASE_TOKEN`), as a **specific actor** (`actor_type: "User"`) — **not**
  the broad "Repository admin"/"Organization admin" **role** and **not** a Team, so an
  admin cannot hand-push a `v*` tag around the pipeline. The release user's
  fine-grained PAT is still on this ruleset's bypass list so the `publish` job can write
  the tag.
- **`vars.RELEASE_IDENTITY_ACTOR_ID`** — set this repository **variable** to the numeric
  actor id of that dedicated release user. The `publish` job's tag-ruleset preflight
  (below) verifies the live ruleset's single bypass actor id equals it.

One-time provisioning (replace `OWNER/REPO`; set `<release-user-actor-id>` to the
numeric id of the dedicated release USER account):

```bash
# Create a tag ruleset that locks refs/tags/v* to the release identity only. The
# bypass_actors list contains ONLY the release user (no admin role), so nobody
# else — administrators included — can create, move, or delete a v* tag by hand.
gh api -X POST "repos/OWNER/REPO/rulesets" \
  --input - <<'JSON'
{
  "name": "release-tags-v",
  "target": "tag",
  "enforcement": "active",
  "conditions": {
    "ref_name": { "include": ["refs/tags/v*"], "exclude": [] }
  },
  "rules": [
    { "type": "creation" },
    { "type": "update" },
    { "type": "deletion" },
    { "type": "non_fast_forward" }
  ],
  "bypass_actors": [
    { "actor_id": <release-user-actor-id>, "actor_type": "User", "bypass_mode": "always" }
  ]
}
JSON

# Record the dedicated release user's numeric actor id so the publish preflight can
# verify the ruleset's bypass actor matches it.
gh variable set RELEASE_IDENTITY_ACTOR_ID --repo OWNER/REPO --body "<release-user-actor-id>"

# Verify the COMPLETE ruleset configuration (not just that an id exists). Fetch the
# detailed ruleset and assert: target=tag, enforcement=active, conditions include
# refs/tags/v* with NO excludes that carve it back out, creation+update+deletion+
# non_fast_forward rules all present, and the bypass list is EXACTLY the release user
# (User/always) with no admin role, team, or extra actor. Exits non-zero if any check fails.
RID=$(gh api --paginate "repos/OWNER/REPO/rulesets" \
  --jq '.[] | select(.name=="release-tags-v") | .id')
gh api "repos/OWNER/REPO/rulesets/$RID" --jq '
  (.target=="tag") and (.enforcement=="active")
  and ((.conditions.ref_name.include // []) | any(. == "refs/tags/v*"))
  and ((.conditions.ref_name.exclude // []) | length == 0)
  and ([.rules[].type] | (index("creation") and index("update") and index("deletion") and index("non_fast_forward")))
  and ((.bypass_actors // []) | length == 1)
  and (.bypass_actors[0] | .actor_type=="User" and .bypass_mode=="always"
       and (.actor_id|tostring) == "'"$(gh variable get RELEASE_IDENTITY_ACTOR_ID --repo OWNER/REPO)"'")
' | grep -qx true || { echo "release-tags-v ruleset misconfigured"; exit 1; }
```

Before any tag/Release write, the `publish` job runs a **fail-closed tag-ruleset
preflight**. It first confirms the **release token's own identity** (`gh api user`)
equals `vars.RELEASE_IDENTITY_ACTOR_ID`, so the principal that writes the tag IS the
ruleset's bypass actor. It then fetches **all** live rulesets (paginated) and evaluates
the **two concrete refs this release writes** — the exact tag `refs/tags/vX.Y.Z` **and**
the floating major `refs/tags/vN` — **independently**, using a faithful GitHub
**fnmatch (FNM_PATHNAME)** matcher that matches **segment by segment**: `*`, `?`, and
`[...]` match WITHIN a path segment (never `/`). A `**` segment is recursive (matches
zero or more whole segments) **only when it is NON-terminal** — i.e. it came from a
`**/` prefix; a **TERMINAL `**`** (the last pattern segment) is NOT recursive and behaves
like `*` (one within-segment match), exactly as Ruby `File.fnmatch` FNM_PATHNAME. So
`refs/tags/v*` matches `refs/tags/v1.2.3`/`refs/tags/v1` but **not** `refs/tags/v1/2`,
`refs/tags/**` (terminal `**`) covers a single tag segment but **`refs/**` does NOT
protect a nested `refs/tags/v1.2.3`**, `refs/*` does **not** match `refs/tags/...`, and a
pattern like `refs/tags/v1.*` that misses the floating `refs/tags/v1` is not mistaken for
coverage. A **NON-terminal `**/`** IS recursive, so `refs/**/v1.2.3` matches
`refs/tags/v1.2.3` (the `**/` spans the `tags` segment) and also `refs/v1.2.3` (spanning
zero segments) and `refs/a/b/v1.2.3` (spanning multiple); **excludes** are honored the
same way. For **each** ref it refuses to publish
unless some applicable ruleset restricts **creation**, some restricts **update**, and
some restricts **deletion**. For the **bypass** list it separates two cases: a ruleset
whose detail **omits** `bypass_actors` (insufficient API visibility) **fails closed**
(re-run with a token that can read bypass actors), while an **explicit empty** bypass
list is a **valid** protective layer (it grants no one a bypass and is accepted). A
ruleset is rejected only if it grants a bypass to a **non-release** actor (any actor that
is not the `User` `vars.RELEASE_IDENTITY_ACTOR_ID` with `bypass_mode` `always`).
Finally, the release identity must be a bypass actor on **at least one** applicable
ruleset per ref, so the pipeline is the **sanctioned** writer (empty-bypass protective
layers may coexist but cannot by themselves authorize the write). A missing write
protection, a non-`User`/foreign/extra bypass actor, omitted bypass visibility, or an
exclusion that removes either ref from coverage each fails the preflight.

Because `refs/tags/v*` create/update/delete is restricted to the release identity, the
environment gate governs the workflow that identity runs in, and the publish preflight
validates the complete ruleset configuration before writing, a `v*` release ref can only
be produced through the reviewed `publish` job — not by a direct push and not by an
administrator bypassing the reviewer gate.

### MCP release (chaos-mcp) — dispatch-only + mcp-v* tag protection (required configuration)

The chaos-mcp Python package is released by [`release.yml`](.github/workflows/release.yml).
It is **`workflow_dispatch`-only**, never `push: tags`. A tag-triggered workflow would
load `release.yml` **from the tagged commit**, so anyone able to create an `mcp-v*` tag
could ship an arbitrary workflow that strips the guards and exfiltrates the PyPI
trusted-publisher identity or `GITHUB_TOKEN`. Dispatch always runs the workflow
**definition from the dispatched ref**, and every job is gated (`if:` + an in-shell
check) to run **only** on the default branch, so publication can only execute the
reviewed-and-merged workflow against reviewed-and-merged code. The `build` job also
verifies the dispatched `version` input equals the committed `pyproject.toml` version, so
a dispatch cannot ship an unreviewed version. PyPI uses a **trusted publisher** bound to
(this repo, workflow file `release.yml`, environment `pypi`) — no stored token.

Protect the `mcp-v*` tag namespace with a repository **tag ruleset** exactly like the
`v*` one above (target `mcp-v*`, enforcement `active`, restrict **creations, updates,
deletions, and force pushes** (`non_fast_forward`), bypass list = **only** the dedicated
release `User`). The `github-release` job writes the `mcp-v*` tag with
`ACTION_RELEASE_TOKEN` (the release identity), so that identity must be the ruleset's sole
bypass actor:

```bash
gh api -X POST "repos/OWNER/REPO/rulesets" \
  --input - <<'JSON'
{
  "name": "release-tags-mcp-v",
  "target": "tag",
  "enforcement": "active",
  "conditions": {
    "ref_name": { "include": ["refs/tags/mcp-v*"], "exclude": [] }
  },
  "rules": [
    { "type": "creation" },
    { "type": "update" },
    { "type": "deletion" },
    { "type": "non_fast_forward" }
  ],
  "bypass_actors": [
    { "actor_id": <release-user-actor-id>, "actor_type": "User", "bypass_mode": "always" }
  ]
}
JSON

# Verify the COMPLETE mcp-v* ruleset configuration (matching the v* verification above):
# target=tag, enforcement=active, includes refs/tags/mcp-v* with NO carve-out excludes,
# creation+update+deletion+non_fast_forward all present, and the bypass list is EXACTLY the
# release user (User/always) with no admin role, team, or extra actor. Exits non-zero if any check fails.
RID=$(gh api --paginate "repos/OWNER/REPO/rulesets" \
  --jq '.[] | select(.name=="release-tags-mcp-v") | .id')
gh api "repos/OWNER/REPO/rulesets/$RID" --jq '
  (.target=="tag") and (.enforcement=="active")
  and ((.conditions.ref_name.include // []) | any(. == "refs/tags/mcp-v*"))
  and ((.conditions.ref_name.exclude // []) | length == 0)
  and ([.rules[].type] | (index("creation") and index("update") and index("deletion") and index("non_fast_forward")))
  and ((.bypass_actors // []) | length == 1)
  and (.bypass_actors[0] | .actor_type=="User" and .bypass_mode=="always"
       and (.actor_id|tostring) == "'"$(gh variable get RELEASE_IDENTITY_ACTOR_ID --repo OWNER/REPO)"'")
' | grep -qx true || { echo "release-tags-mcp-v ruleset misconfigured"; exit 1; }
```

Because `release.yml` is dispatch-only from the default branch and `refs/tags/mcp-v*`
create/update/delete is restricted to the release identity, an out-of-band `mcp-v*` tag
neither triggers publication nor masquerades as an official release.

**Protected environments (required).** A `workflow_dispatch` run can be started from ANY
branch, and on a feature branch the in-file `if:` guards come from that branch — so they
are not authoritative on their own. Both privileged jobs therefore reference EXTERNALLY
configured GitHub Environments that GitHub enforces regardless of the workflow file, and
the `github-release` job runs a **fail-closed preflight** (which `publish-pypi` depends
on) that refuses to publish unless **both** environments have the full protection set:

- **`pypi`** (used by `publish-pypi`) — **required reviewers**, **`prevent_self_review=true`**,
  **`can_admins_bypass=false`**, and a deployment-branch policy of type "Selected
  branches and tags" naming **only** the default branch. The PyPI trusted publisher is
  bound to (this repo, `release.yml`, environment `pypi`). `publish-pypi` also runs its
  OWN preflight (defense against a failed-job-only retry that skips `github-release` and
  rides on a stale prior pass) that revalidates these same protections on every attempt.
  That preflight needs a **read-only** credential — it must NOT reuse `ACTION_RELEASE_TOKEN`,
  since that token lives on `release`/`mcp-release` only and environment secrets are never
  shared across environments. Provision a **`pypi`-scoped** fine-grained PAT named
  **`PYPI_VERIFY_TOKEN`** with **only `Administration: read`** (no write scope of any
  kind) as an **environment secret on `pypi`**.
- **`mcp-release`** (used by `github-release`) — the SAME protections (required reviewers +
  `prevent_self_review=true` + `can_admins_bypass=false` + default-branch-only), and it
  stores `ACTION_RELEASE_TOKEN` (the release identity's fine-grained token, `Contents: write`
  + `Actions: read` + `Administration: read`) as an **environment-scoped** secret. GitHub withholds the environment
  and its secret on any non-default ref, so a feature-branch dispatch that stripped the
  in-file guard still cannot reach the tag-writing credential.

Also set the **`RELEASE_IDENTITY_ACTOR_ID`** repository variable (the numeric actor id of
the dedicated release USER — the same one used by the `v*` flow above) so the mcp tag
preflight can verify the token identity and the ruleset bypass actor.

```bash
# Provision the pypi AND mcp-release environments with the SAME strong protections as the
# `release` environment: typed JSON booleans, a required reviewer, self-review prevented,
# admin bypass disabled, and a default-branch-only deployment policy. Repeat the two calls
# for each environment name.
for ENVNAME in pypi mcp-release; do
  gh api -X PUT "repos/OWNER/REPO/environments/${ENVNAME}" \
    --input - <<'JSON'
{
  "prevent_self_review": true,
  "can_admins_bypass": false,
  "deployment_branch_policy": {
    "protected_branches": false,
    "custom_branch_policies": true
  },
  "reviewers": [
    { "type": "User", "id": 0 }
  ]
}
JSON
  # (Replace the reviewer id 0 with a real user/team id, or add more reviewers.)
  gh api -X POST "repos/OWNER/REPO/environments/${ENVNAME}/deployment-branch-policies" \
    --input - <<'JSON'
{ "name": "main", "type": "branch" }
JSON
done

# The tag-writing token is an ENVIRONMENT secret on mcp-release (not a repo secret).
gh secret set ACTION_RELEASE_TOKEN --env mcp-release --repo OWNER/REPO

# The pypi preflight's READ-ONLY verification credential is a SEPARATE environment secret
# on `pypi` — a fine-grained PAT scoped to THIS repo with ONLY `Administration: read` (no
# write scope). It must NOT be ACTION_RELEASE_TOKEN (environment secrets are not shared).
gh secret set PYPI_VERIFY_TOKEN --env pypi --repo OWNER/REPO

# Record the dedicated release user's numeric actor id (shared with the v* flow) so the
# mcp tag preflight can verify the token identity and the ruleset bypass actor.
gh variable set RELEASE_IDENTITY_ACTOR_ID --repo OWNER/REPO --body "<release-user-actor-id>"
```

**Tag immutability + preflight.** Before writing anything, the `github-release` job (a)
requires a **canonical** `mcp-v<MAJOR.MINOR.PATCH>` version with no leading zeros, (b)
verifies the release **token's identity** equals `vars.RELEASE_IDENTITY_ACTOR_ID` and
that the `mcp-v*` tag ruleset protects the exact ref it writes (creation+update+deletion,
bypass = only that `User`; omitted bypass data fails closed, an explicit empty bypass is
an accepted protective layer, any foreign bypass fails), (c) creates the tag with **bare
Git** (no working tree, so no repository code runs in the secret-bearing step) and, if
the tag already exists, **verifies** it points at the release commit rather than moving
it, and (d) treats an already-**published** GitHub Release as **immutable** — it verifies
without overwriting assets, only repairing an incomplete draft or creating a first
release. So a re-dispatch cannot re-point a shipped tag or clobber published assets.

**Retry after the default branch advances.** The MCP release is `workflow_dispatch`-only,
so a retry runs with the *current* `github.sha`, which may differ from the commit an
earlier run already tagged. To make retries recoverable, the `build` job resolves any
existing `mcp-v*` tag, requires its commit to be an **ancestor of the default-branch tip**
(trusted, reviewed history — an off-branch tag is rejected), and **builds from that tagged
commit** so the artifacts always match the shipped tag. The `github-release` job re-resolves
the tag and requires it to equal the built `release_commit` (equality with the *new* tip is
**not** required), so a retry recovers the original release instead of failing.

**Threat model — the draft is not exclusive ownership.** As with the Action release, the
`github-release` job reserves a **draft** before the tag is public, but a draft is only a
race-**narrower**: any `contents: write` holder could still alter/publish/delete it. The
trust boundary is the **`mcp-release` + `pypi` environments**, the **`mcp-v*` tag ruleset**,
and the **dedicated release identity**; the actual gate on PyPI is the publish-time
verification — the `publish-pypi` job `needs:` `github-release`, which fails closed unless
the GitHub Release's asset **set + count + sha256 digests** equal the locally built dist
*and* GitHub reports the release **immutable**. A tampered draft therefore fails
verification and never reaches PyPI. Preventing (not just detecting) draft tampering
requires restricting the `contents: write` role to the release identity — an external
org/repo role control.

### Azure Pipelines extension publish security (required configuration)

The [`OneBranch.Official`](.pipelines/OneBranch.Official.yml) pipeline publishes the
signed VSIX to the Visual Studio Marketplace. Publication is split into **three** isolated
stages: `build` builds/packages an **unsigned** VSIX (holds **no** Marketplace credential
and does **no** signing); `sign` is a **deployment** job bound to the protected pipeline
environment `$(SigningEnvironment)` that signs + cryptographically validates the VSIX; and
a separate `publish` stage — a OneBranch v2 `releaseJob` that declares the signed VSIX as an
artifact input and disables repository checkout — publishes it, running **no repository
code**. In YAML the `publish` stage runs only when the run sets `publishExtension: true`
**and** the run is from the trusted default branch (`PublishBranch`, `refs/heads/main`).

**Signing's INDEPENDENT enforcement is OneBranch platform governance, not this YAML.** The
pipeline is manual-dispatch only (`trigger: none`), so a maintainer can queue it against any
branch, and a feature branch could edit or delete the `sign` stage's `environment:` binding.
That binding is therefore **defense in depth, not the authoritative control.** The
authoritative control is external to the file: a Real `external_distribution` SignType is
granted by ESRP/OneBranch onboarding **only to the onboarded Official pipeline** (by pipeline
id / service tree) running the Production/Official template from the trusted branch. A feature
branch that deletes the `environment:` binding and calls `onebranch.pipeline.signing@1`
directly cannot obtain a trusted signature — the broker issues at most a **Test** signature,
which fails the CodeSign Validation gates. Layered on top, the `sign` stage is a **deployment
job that TARGETS the `$(SigningEnvironment)` environment**, so Azure DevOps also evaluates that
environment's Approvals-and-checks **before the deployment (and therefore any signing step) can
run**. The `build` stage produces an unsigned VSIX (so a feature-branch run still validates via
build/test/Node-20); only the platform-governed, environment-gated `sign` stage grants the
`external_distribution` signature.

Because a manual run loads the pipeline YAML *from the selected branch*, no in-file
condition or variable (`PublishBranch`, the stage conditions) is authoritative on its own.
The `onebranch.pipeline.signing@1` task takes **no** pipeline service connection — ESRP
signing is brokered by the governed OneBranch signing environment — so the concrete,
ADO-gateable protected resource for signing is the pipeline **environment**,
**`ChaosStudio-ESRP-Signing-Prod`** (named in the pipeline's `SigningEnvironment` variable),
which the `sign` **deployment** job targets. Configure the following **once** in Azure
DevOps so `external_distribution` signing can only ever happen on the trusted branch:

- **Environment → `ChaosStudio-ESRP-Signing-Prod` → Approvals and checks → Branch
  Control** (the "Evaluate branch protection" task-based check) — allowed branches limited
  to exactly `refs/heads/main`, no unknown-status-branch allowance. Combined with OneBranch
  platform governance (the Production/Official template + repo onboarding gate a
  Real/`external_distribution` SignType to the official pipeline), this binds signing to the
  trusted branch regardless of what the running YAML says.
- **Environment → `ChaosStudio-ESRP-Signing-Prod` → Security → Pipeline permissions** —
  restrict the environment to this official pipeline only, so no ad-hoc pipeline can sign.

**Verify the signing + publish resources live** (the same fail-closed checks, run ahead of
a release) with:

```bash
export AZURE_DEVOPS_EXT_PAT=...  # PAT with Service Connections + Environment + Pipeline resources + Build: Read
# REQUIRED: the pinned Branch Control task version the reviewed check uses (the FULL
# definitionRef.version string, e.g. 0.0.1 — NOT a major-only 0), and the IMMUTABLE repository
# identity + type the official build definition must point at (a repo-swapped definition that
# keeps the reviewed YAML path is otherwise undetected).
export BRANCH_CONTROL_TASK_VERSION=0.0.1             # definitionRef.version of the check
export EXPECTED_REPOSITORY_ID=<guid>                 # immutable .repository.id (REQUIRED)
export EXPECTED_REPOSITORY_TYPE=TfsGit               # .repository.type, e.g. TfsGit (REQUIRED)
# Optional extra mutable-name check: export EXPECTED_REPOSITORY_NAME=<repo>
# The 3rd argument is the numeric id of the SOLE official pipeline allowed to consume the
# signing + publish resources.
scripts/verify-ado-signing-protections.sh https://dev.azure.com/ORG PROJECT OFFICIAL_PIPELINE_ID \
  ChaosStudio-ESRP-Signing-Prod "ADO-Plugin Publishing" refs/heads/main
```

It resolves each named protected resource — the signing **environment**
`ChaosStudio-ESRP-Signing-Prod` (via the distributed-task environments API) and the publish
**service connection** `ADO-Plugin Publishing` (via the service-endpoint API) — and fails
closed unless each carries a **Branch Control** check identified by its immutable task
(`definitionRef.id`), not a user-settable display name, that is ENABLED (`isDisabled` must be
the exact boolean `false`; a missing property, a null, or a string `"false"` fails closed),
pins the REQUIRED task **version** (`definitionRef.version` must equal
`BRANCH_CONTROL_TASK_VERSION`), and — using the CORRECT ADO wire semantics, where a Task Check's
`settings.inputs` are **strings** — limits `allowedBranches` to exactly `refs/heads/main`,
requires branch protection (`ensureProtectionOfBranch` must be the string `"true"`, so an allowed
branch with no protection policy is rejected), and permits no unknown-status-branch allowance
(the singular `allowUnknownStatusBranch` must be the string `"false"` or absent — a `"true"` or any
unrecognized value fails closed), **and** authorizes EXACTLY the one official pipeline (not all
pipelines, and no others). The **publish** connection ADDITIONALLY requires an ENABLED
**Approval** check (again `isDisabled == false`) with at least one approver and
`requesterCannotBeApprover` set to the exact boolean `true` (a string `"true"` fails closed). The
**signing** environment is gated by Branch Control + pipeline permissions and does NOT require a
separate Approval — the human gate lives on the publish step, and signing's authoritative control
is the OneBranch SignType entitlement (below) plus the CodeSign Validation
gates in both stages.

**Signing-pipeline identity check (a consistency check, NOT branch-run prevention).** Because a
manual run can queue the official pipeline against *any* branch — and a feature-branch YAML
could delete the `sign` deployment job's `environment:` binding and call the signing task from a
plain job — the in-YAML binding is NOT self-sufficient, and no ADO REST field proves "signing
can only ever run on `main`". The verifier therefore reads the official pipeline's **build
definition** — a server-side object a feature branch cannot edit — and fails closed unless its
**immutable repository identity** matches the pinned `EXPECTED_REPOSITORY_ID` (`.repository.id`)
**and** `EXPECTED_REPOSITORY_TYPE` (`.repository.type`, e.g. `TfsGit`) — so a definition swapped
to a different repo, or a same-id/name repo of a different provider, is rejected (an optional
`EXPECTED_REPOSITORY_NAME` adds a mutable-name check) — its **default branch is
`refs/heads/main`**, and its YAML path is the reviewed `.pipelines/OneBranch.Official.yml`
(override with `EXPECTED_YAML_PATH`). This catches a **swapped/retargeted definition**, but it
does NOT by itself prevent a feature-branch run. The **authoritative, non-removable** prevention
is external and cannot be asserted over the REST API: the OneBranch/ESRP **Real
`external_distribution` SignType entitlement**, granted by OneBranch onboarding to the onboarded
Official pipeline on the trusted branch only. **Evidence to record** (the entitlement is
portal-confirmed, not REST-queryable): capture the ESRP/OneBranch onboarding request id and the
approved SignType (`external_distribution`) from the OneBranch portal, and keep it with the
release runbook so the Real-signing authorization is auditable. The **machine-enforced backstop**
is the CodeSign Validation gate in BOTH the sign and publish stages — a bypassing run obtains at
most a **Test** signature whose certificate does not chain to the approved Microsoft production
signing root, which those gates reject, so it can never publish. The committed pipeline's
Real-SignType request (`signing_profile: external_distribution`) and both fail-closed gates are
additionally locked by `packages/core/test/contract/ado-pipeline.test.ts`. The signing
environment's Branch Control (verified above) additionally gates the deployment-job path.

YAML conditions alone are likewise not sufficient for the Marketplace credential,
because a feature branch could define its own pipeline that consumes the same service
connection and skips those conditions. The **authoritative** gate is therefore
configured on the credential itself. Configure the following **once** in Azure DevOps:

- **Service connection → `ADO-Plugin Publishing` → Approvals and checks → Branch
  control** — allowed branches limited to exactly `refs/heads/main`. This blocks
  **any** pipeline (regardless of its YAML or branch) from using the Marketplace
  credential off the trusted branch.
- **Service connection → `ADO-Plugin Publishing` → Approvals and checks →
  Approvals** — one or more required human approvers, so a publish cannot proceed
  unattended.
- **Service connection → `ADO-Plugin Publishing` → Security → Pipeline
  permissions** — restrict the connection to this pipeline only, so the credential
  is not reusable from ad-hoc pipelines.

Because the release stage uses the OneBranch `releaseJob` contract (declared
artifact input, checkout disabled), the publishing step has no repository code on
disk and can only act on the signed VSIX artifact produced by the `sign` stage.

**Signed-artifact handoff is re-verified independently at publish time.** The `publish` stage
does **not** trust that the `sign` stage ran: before spending the Marketplace credential it
runs CodeSign Validation (`CodeSignValidation@0` + `PostAnalysis@2`, `BreakOn: WarningAbove`,
`ToolLogsNotFoundAction: Error`) on the artifact it actually received and **fails closed**
unless that VSIX is validly signed. A run that skipped or faked signing therefore cannot
publish. **Confirm this handoff once in a live Official run:** queue the Official pipeline with
`publishExtension: true` from `refs/heads/main`, and verify in the run logs that (a) the `sign`
stage's CodeSign Validation passed on a Real `external_distribution` signature, (b) the
`publish` stage's independent CodeSign re-verification passed on the consumed artifact, and (c)
`PublishAzureDevOpsExtension` uploaded exactly that signed VSIX. Keep the run link with the
release record.

## Issues & feedback

- **Bugs / feature requests:** <https://github.com/microsoft/chaos-studio/issues/new/choose>
- **Questions / ideas:** <https://github.com/microsoft/chaos-studio/discussions>
- **Security:** do not open a public issue — see [SECURITY.md](SECURITY.md).

## Microsoft CLA

Most contributions require you to agree to a Contributor License Agreement (CLA)
declaring that you have the right to, and actually do, grant us the rights to use
your contribution. For details, visit <https://cla.opensource.microsoft.com>.

When you submit a pull request, a CLA bot will automatically determine whether you
need to provide a CLA and decorate the PR appropriately. You only need to do this
once across all repos using our CLA.

This project has adopted the [Microsoft Open Source Code of Conduct](https://opensource.microsoft.com/codeofconduct/).
For more information see the [Code of Conduct FAQ](https://opensource.microsoft.com/codeofconduct/faq/)
or contact [opencode@microsoft.com](mailto:opencode@microsoft.com) with questions.
