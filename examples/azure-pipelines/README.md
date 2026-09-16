# Azure Pipelines examples — Azure Chaos Studio

Minimal, per-mode pipelines for the **Azure Chaos Studio Scenario** task
(`AzureChaosStudioScenario@1`), one per mode, plus a deployment-gate example.

| Example | Mode | Waits? | Purpose |
|---|---|:---:|---|
| [`validate-and-execute.yml`](./validate-and-execute.yml) | `validate-and-execute` | yes | Validate, then run only if validation succeeds (the default). |
| [`validate-only.yml`](./validate-only.yml) | `validate-only` | — | Pre-flight / PR gate; never starts a run. |
| [`execute-only.yml`](./execute-only.yml) | `execute-only` | yes | Run a configuration a prior stage already validated. |
| [`execute-only-no-wait.yml`](./execute-only-no-wait.yml) | `execute-only` | no | Fire-and-forget; see the no-wait warning below. |
| [`deployment-gate.yml`](./deployment-gate.yml) | `validate-and-execute` | yes | Run the scenario as a `deployment` gate bound to an environment. |

## Prerequisite — install the extension

These pipelines reference `AzureChaosStudioScenario@1`, contributed by the
**Azure Chaos Studio Workspaces** production marketplace extension. Install it
in your Azure DevOps organization first so the task resolves. This is a
separate extension from the existing `AzureChaosStudio.ChaosStudioExtension`;
installing it does not change that extension or its V1 task.

**Private preview / dev organizations:** the private `ChaosStudioWorkspacesDev`
build contributes a **different task name**, `AzureChaosStudioScenarioDev@1`
(same inputs/outputs, its own stable task GUID) — it does NOT make
`AzureChaosStudioScenario@1` available. In a dev-only organization, substitute
`AzureChaosStudioScenarioDev@1` for every `AzureChaosStudioScenario@1` step in
these examples; do not mix the two task names in one pipeline. See the
[release-validation runbook](../../docs/runbooks/release-validation.md) for how
the dev build is installed and validated before the production task ships.

## Authentication — workload identity, no secret

Every example authenticates with an **ARM service connection** configured for
**workload identity federation (WIF)**. Azure DevOps mints a short-lived OIDC token
per job that is exchanged with Entra ID for an ARM access token; the task reuses
that federated identity. There is **no long-lived client secret** anywhere in the
flow (NFR3). Reference the connection by name via the `azureSubscription` input.

`subscriptionId`, `resourceGroup`, `workspaceName`, `scenarioName`, and
`scenarioConfigurationName` are **identifiers, not secrets**.

## Trusted trigger requirements

Workload identity federation and least privilege establish *what* the service
connection can do; they say nothing about *who* is allowed to trigger the
pipeline that requests a chaos action. An ARM service connection with WIF
grants a real Azure token to **whatever pipeline run resolves it** — if that
run was triggered by an untrusted or unreviewed source, the chaos-capable
credential is exposed to that source, not just to your reviewed pipeline.

- Restrict pipeline triggers to trusted branches (`trigger:`/`pr:` scoped to
  protected branches such as `main`/`release/*`), and do not allow **fork
  pull requests** to trigger a pipeline that resolves a chaos-capable service
  connection. Azure DevOps disables secrets/service-connection access for
  fork PR builds by default — do not re-enable "Make secrets available to
  builds of forks" (or an equivalent setting) for a pipeline in this family.
- Gate any chaos-capable stage with an
  [environment](https://learn.microsoft.com/azure/devops/pipelines/process/environments)
  that requires **approvals/checks**, so a human reviews the run before the
  chaos-capable service connection is authorized, and restrict the service
  connection itself to specific pipelines
  ([Security → service connection → Pipeline permissions](https://learn.microsoft.com/azure/devops/pipelines/library/service-endpoints)).
- Do not grant a chaos-capable service connection to a pipeline that also
  executes unreviewed, externally-contributed code (e.g. a build that runs
  scripts from a fork or an unprotected shared template); doing so lets that
  unreviewed code run chaos actions under your least-privilege identity.

These requirements are in addition to, not a substitute for, the workload
identity and least-privilege guidance in
[the integration guide](../../docs/ci-cd-integrations.md#two-identity-guidance).

## ⚠️ No-wait warning

With `waitForCompletion: false` the task succeeds as soon as the run is **started** —
it does not judge the run outcome and returns only the run identity plus the
last-observed state. After the task exits, the integration **cannot cancel the run**
(`cancelOnTimeoutOrCancellation` applies only while waiting), so a cancelled job
leaves the chaos run going. Cancel it manually by run id:

```bash
az rest --method post \
  --url "https://management.azure.com<run-resource-id>/cancel?api-version=2026-05-01-preview"
```

Prefer `waitForCompletion: true` unless you deliberately want fire-and-forget.

## Outputs

The task exposes stable **output variables** (set with `isOutput=true`), identical
in name and value to the GitHub Action's outputs (cross-platform parity, G3):
`validation-state`, `run-id`, `run-resource-id`, `run-state`, `started-at`,
`completed-at`, `correlation-id`, `request-id`. Give the task a `name:` and read
them as `$(<name>.<output>)`, e.g. `$(chaos.run-id)`. Which ones are set depends on
the mode and wait setting. See the
[output presence matrix](../../docs/ci-cd-integrations.md#output-presence-matrix);
an absent output variable is not set by the task and normally expands as empty.
