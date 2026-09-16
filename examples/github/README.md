# GitHub Action examples — Azure Chaos Studio

Minimal, per-mode workflow **templates** for the **Azure Chaos Studio** GitHub
Action (root [`action.yml`](../../action.yml)), one per mode.

> ⚠️ **These are templates, not yet copy-paste runnable.** The runnable bundles
> are committed, but no public `microsoft/chaos-studio@v1` or preview commit ref
> has been published. Each example therefore uses the all-zero 40-character SHA
> as an unmistakable, non-resolving sentinel. Replace it with the full commit SHA
> of an actual published preview release before running; do not guess a branch
> commit. See [Supply-chain pinning](#supply-chain-pinning).

| Example | Mode | Waits? | Purpose |
|---|---|:---:|---|
| [`validate-and-execute.yml`](./validate-and-execute.yml) | `validate-and-execute` | yes | Validate, then run only if validation succeeds (the default). |
| [`validate-only.yml`](./validate-only.yml) | `validate-only` | — | Pre-flight / PR gate; never starts a run. |
| [`execute-only.yml`](./execute-only.yml) | `execute-only` | yes | Run a configuration a prior stage already validated. |
| [`execute-only-no-wait.yml`](./execute-only-no-wait.yml) | `execute-only` | no | Fire-and-forget; see the no-wait warning below. |

## Authentication — workload identity, no secret

Every example signs in with [`azure/login`](https://github.com/Azure/login) using
**workload identity federation (WIF)**: GitHub mints a short-lived OIDC token that
`azure/login` exchanges for an Azure CLI session, which the Action reuses through
`AzureCliCredential`. There is **no long-lived client secret** anywhere in the
flow (NFR3). The workflow only needs:

```yaml
permissions:
  id-token: write   # mint the OIDC token
  contents: read
```

`client-id`, `tenant-id`, and `subscription-id` are **identifiers, not secrets** —
storing them as GitHub secrets (as shown) or as `vars` is equivalent; no client
secret or certificate is used. Configure a federated credential on the app
registration/managed identity for your repo/environment first
([docs](https://learn.microsoft.com/azure/developer/github/connect-from-azure)).

## Trusted trigger requirements

Workload identity federation and least privilege establish *what* the runner
identity can do; they say nothing about *who* is allowed to request that a
chaos action run. `azure/login` with WIF mints a real Azure session for
**whatever workflow run asks for it** — if that run was triggered by
untrusted, unreviewed code, the chaos-capable credential is exposed to that
code, not just to your reviewed pipeline.

- **Never** trigger these workflows with `pull_request_target`,
  `workflow_run`, or any other event that runs on a base-repo secret context
  while checking out a fork's unreviewed head, unless the job explicitly
  requires human approval before checkout/execution.
- Restrict `on:` triggers to trusted refs — e.g. `push`/`workflow_dispatch` on
  protected branches (`main`, `release/*`), not `pull_request` from forks.
- If a chaos run must be triggerable from a pull request, gate it with a
  GitHub [environment](https://docs.github.com/actions/deployment/targeting-different-environments/using-environments-for-deployment)
  that requires **required reviewers** approval before the job (and therefore
  the `id-token: write` permission and the federated credential exchange) runs.
  A `fork` PR's `GITHUB_TOKEN` and default permissions are read-only precisely
  because fork code is unreviewed; do not add `id-token: write` or any
  chaos-capable environment to a job that executes fork-supplied code paths
  (workflow files, composite actions, scripts) without that approval gate.
- The federated credential's subject claim should be scoped to the trusted
  branch/environment (e.g. `repo:ORG/REPO:ref:refs/heads/main` or
  `repo:ORG/REPO:environment:chaos`), not to `pull_request` subjects, so even a
  misconfigured trigger cannot mint a usable token outside that scope.

These requirements are in addition to, not a substitute for, the workload
identity and least-privilege guidance in
[the integration guide](../../docs/ci-cd-integrations.md#two-identity-guidance).

## Supply-chain pinning

**Every** action — third-party *and* `microsoft/chaos-studio` itself — is pinned to
a **full commit SHA**, with the human-readable release tag in a trailing comment,
e.g. `azure/login@7184910d9eb2b1c5e48f7073824a90609bb9b6d6 # v2`. No example uses a
mutable `@v*` tag or branch.

The `microsoft/chaos-studio` pin is the all-zero SHA sentinel. It is deliberately
not resolvable and cannot accidentally execute an unrelated historical revision.
These workflows become runnable only after a preview is published: resolve that
release tag to its full commit SHA and replace the sentinel (keep the immutable
SHA, not the mutable tag). The trailing `# v1` comment records the intended tag.

## ⚠️ No-wait warning

With `wait-for-completion: false` the step succeeds as soon as the run is
**started** — it does not judge the run outcome and returns only the run identity
plus the last-observed state. After the step exits, the integration **cannot
cancel the run** (`cancel-on-timeout-or-cancellation` applies only while waiting),
so a cancelled job leaves the chaos run going. Cancel it manually by run id:

```bash
az rest --method post \
  --url "https://management.azure.com<run-resource-id>/cancel?api-version=2026-05-01-preview"
```

Prefer `wait-for-completion: true` unless you deliberately want fire-and-forget.

## Outputs

The Action exposes stable scalar outputs (see [`action.yml`](../../action.yml)):
`validation-state`, `run-id`, `run-resource-id`, `run-state`, `started-at`,
`completed-at`, `correlation-id`, `request-id`. Which ones are set depends on the
mode and wait setting; read them via `steps.<id>.outputs.<name>`. See the
[output presence matrix](../../docs/ci-cd-integrations.md#output-presence-matrix);
an output marked absent is not emitted, and a GitHub expression reading it
normally evaluates to an empty string.
