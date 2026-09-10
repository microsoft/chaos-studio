# GitHub Action examples — Azure Chaos Studio

Minimal, per-mode workflow **templates** for the **Azure Chaos Studio** GitHub
Action (root [`action.yml`](../../action.yml)), one per mode.

> ⚠️ **These are templates, not yet copy-paste runnable.** Every action is pinned
> to a full commit SHA for supply-chain hygiene, but the `microsoft/chaos-studio`
> pin is a **pre-release placeholder**: that revision is not yet a published,
> GitHub-resolvable release, and the Action's committed entry point is still the
> pre-release placeholder bundle (the runnable bundle ships in E5/E6). Before
> running, **replace the `microsoft/chaos-studio@<sha>` pin** with the published
> preview release SHA — see [Supply-chain pinning](#supply-chain-pinning).

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

## Supply-chain pinning

**Every** action — third-party *and* `microsoft/chaos-studio` itself — is pinned to
a **full commit SHA**, with the human-readable release tag in a trailing comment,
e.g. `azure/login@7184910d9eb2b1c5e48f7073824a90609bb9b6d6 # v2`. No example uses a
mutable `@v*` tag or branch.

The `microsoft/chaos-studio` pin
(`@0a3b126f0b723ed540c3c506b77afa9796fea327`) is a **placeholder**, for two reasons:

1. it is not yet a **published, GitHub-resolvable release** — `microsoft/chaos-studio`
   has no `v*` release tag yet (the preview `v*` tag is cut in E6); and
2. the Action's committed entry point is still the **pre-release placeholder bundle**
   (the reproducible runnable bundle ships in E5/E6).

So these workflows are **non-runnable templates**: before running one, replace the
`microsoft/chaos-studio@<sha>` reference with the **published preview release SHA**
(keep a full SHA, not a mutable tag) once E5/E6 delivers it. The trailing `# v1`
comment records the intended release tag.

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
mode and wait setting; read them via `steps.<id>.outputs.<name>`.
