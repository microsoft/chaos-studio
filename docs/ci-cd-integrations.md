# Azure Chaos Studio CI/CD integrations

Validate and run an Azure Chaos Studio **v2 scenario configuration** from CI/CD —
one step on either platform, with workload identity (no long-lived secret) — using
a shared TypeScript core so both platforms behave identically (same inputs, same
canonical outputs, same pass/fail rule).

- **GitHub Action:** root [`action.yml`](../action.yml) (`microsoft/chaos-studio`),
  `node24` runtime.
- **Azure Pipelines task:** `AzureChaosStudioScenario@1`, shipped by the
  **Azure Chaos Studio Workspaces** extension, `Node20_1` runtime.

> **Maintainers:** release, release-validation, rollback/deprecation, and
> contract-drift procedures live in [`docs/runbooks/`](runbooks/README.md).

## Modes

Both platforms share one `mode` input:

| Mode | What it does | Waits? |
|---|---|---|
| `validate-and-execute` (default) | Validate the configuration, then run it only if validation succeeds. | yes (unless `wait-for-completion:false`) |
| `validate-only` | Pre-flight / PR gate. Passes iff validation reaches `Succeeded`; never starts a run. | — |
| `execute-only` | Run a configuration a prior stage already validated. | yes (unless no-wait) |

## Examples

Minimal, per-mode examples live next to this doc:

- **GitHub Action:** [`examples/github/`](../examples/github/) — one workflow per
  mode, plus a no-wait example. SHA-pinned `azure/login`.
- **Azure Pipelines:** [`examples/azure-pipelines/`](../examples/azure-pipelines/)
  — one pipeline per mode, plus a **deployment-gate** example that runs the
  scenario inside a `deployment` job bound to an environment (environment
  approvals gate the run; a failed run blocks promotion).

## ⚠️ No-wait warning

With `wait-for-completion: false` (`waitForCompletion: false` on Azure Pipelines)
the step/task **succeeds as soon as the run is started** — it does not judge the
run outcome and emits only the run identity plus the last-observed state. After the
step exits, the integration **cannot cancel the run**
(`cancel-on-timeout-or-cancellation` applies only while waiting), so a cancelled
job leaves the chaos run going. Cancel it manually by run id:

```bash
az rest --method post \
  --url "https://management.azure.com<run-resource-id>/cancel?api-version=2026-05-01-preview"
```

Prefer waiting unless you deliberately want fire-and-forget.

## Job timeout budget: reserve time for cleanup beyond `completion-timeout-seconds`

`completion-timeout-seconds` (default `2700`) bounds only how long the
integration **waits for the run to complete**. On a completion timeout, or when
the pipeline job itself is cancelled, best-effort cleanup runs `cancel` and polls
for the run to reach `Canceled` — and that cleanup has its **own fixed budget of
300 seconds**, separate from and **in addition to** `completion-timeout-seconds`.
The job/step timeout you configure on the platform must therefore be at least
`completion-timeout-seconds + 300` seconds (plus normal job overhead: checkout,
setup, etc.) — otherwise the platform kills the job mid-cleanup, before the run
is actually cancelled, and the chaos run is left going exactly as in the no-wait
case above.

Platforms can only cancel a running job/step, not extend its own timeout, so
this reservation must be set explicitly:

- **GitHub Actions:** set the JOB's `timeout-minutes` to comfortably exceed
  `completion-timeout-seconds + 300` (converted to minutes), e.g. for the
  default 2700s completion timeout, a job timeout of at least 55 minutes:

  ```yaml
  jobs:
    run-scenario:
      timeout-minutes: 55 # completion-timeout-seconds (2700s=45m) + 300s cleanup + overhead
  ```

- **Azure Pipelines:** set the JOB's `timeoutInMinutes` the same way:

  ```yaml
  jobs:
    - job: RunScenario
      timeoutInMinutes: 55 # completionTimeoutSeconds (2700s=45m) + 300s cleanup + overhead
  ```

If you lower `completion-timeout-seconds`/`completionTimeoutSeconds`, lower the
job timeout proportionally but always keep the 300-second cleanup margin. A job
timeout set at or below `completion-timeout-seconds` will routinely kill the job
before cleanup can run.

## Least privilege — the runner role

The integration invokes exactly **five** `Microsoft.Chaos` control-plane
operations and nothing else:

| Operation | Used for |
|---|---|
| `.../scenarios/configurations/validate/action` | start validation |
| `.../scenarios/configurations/validations/read` | poll validation state |
| `.../scenarios/configurations/execute/action` | start a run |
| `.../scenarios/runs/read` | poll run state |
| `.../scenarios/runs/cancel/action` | cancel on timeout/cancellation |

A **least-privilege custom role template requiring customization** that grants precisely these
operations — no workspace/scenario/configuration write or delete, no data
actions — is committed at
[`security/chaos-studio-runner.role-template.json`](../security/chaos-studio-runner.role-template.json).
Its `actions` are drawn only from the generated provider-operation snapshot; the
release-validation suite (`test/release-validation/`) fails closed if the role ever
grants an operation outside that set or omits a required one.

Before creating the role, customize a local copy. The committed template's
`AssignableScopes` contains the all-zero subscription placeholder
`00000000-0000-0000-0000-000000000000`; Azure cannot use it for your subscription.

1. Copy the linked template to a local file named `chaos-studio-runner.role.json`
   in your current directory, leaving the committed template unchanged.
2. Replace its `AssignableScopes` array with your actual subscription scope
   (`/subscriptions/<sub>`) or, preferably, the workspace's resource-group scope
   shown below. Replace `<sub>` with your subscription ID and `<rg>` with your
   resource-group name; keep the role's permission fields unchanged.

```json
{
  "AssignableScopes": [
    "/subscriptions/<sub>/resourceGroups/<rg>"
  ]
}
```

The snippet shows only the field to replace, not the complete role definition.
The assignment scope must be within `AssignableScopes`; the assignment scope does not override
the role definition's `AssignableScopes`.

Create the role from the customized local file, then assign it at the **target
workspace resource scope**, not the subscription or resource group. Substitute
the runner identity's object ID, the same subscription/resource-group values, and
the target workspace name below. The parent `AssignableScopes` makes the role
available for assignment; it does not require granting access to other workspaces:

```bash
az role definition create --role-definition chaos-studio-runner.role.json
az role assignment create \
  --assignee-object-id "<runner-identity-object-id>" \
  --assignee-principal-type ServicePrincipal \
  --role "Chaos Studio Scenario Runner" \
  --scope "/subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.Chaos/workspaces/<workspace>"
```

## Two-identity guidance

Chaos Studio uses two distinct principals: the CI sign-in identity triggers runs
on the workspace; the workspace managed identity performs actions on target
resources. Keep both separate from the identity that **deploys** your application:

- **Sign-in identity (CI):** a workload-identity-federated app/managed identity —
  `azure/login` on GitHub, or an ARM service connection on Azure Pipelines. No
  client secret is stored on either platform (OIDC federation only).
- **Runner role:** grant that identity **only** the `Chaos Studio Scenario Runner`
  role above, on **only** the target workspace resource using the assignment scope
  shown above. The CI identity should not hold Contributor or your deployment
  identity's permissions.
- **Workspace managed identity:** grant only the action-specific permissions it
  needs on the **target resources**, based on validation's missing-permission
  diagnostics. These permissions are separate from the runner role; chaos actions
  deliberately affect those resources. Review and grant them outside CI/CD; the
  integration never auto-grants permissions.

The `subscription-id`, `resource-group`, `workspace-name`, `scenario-name`, and
`scenario-configuration-name` inputs are **identifiers, not secrets**.

## Trusted trigger requirements

Workload identity federation and least privilege (above) establish **what**
the CI sign-in identity can do once authorized; they say nothing about
**who** is allowed to trigger the pipeline/workflow that requests it. A
chaos-capable identity handed to an untrusted or unreviewed trigger is a
privilege-escalation path regardless of how narrowly its role is scoped.
Before wiring either platform's example into a real pipeline:

- Restrict the trigger to **trusted branches/environments** — e.g.
  `push`/`workflow_dispatch` on protected branches, or `trigger`/`pr` scoped to
  `main`/`release/*` on Azure Pipelines. Do not trigger a chaos-capable job from
  a fork pull request, and do not use `pull_request_target`/`workflow_run` (or
  an Azure Pipelines fork-secrets opt-in) to hand a fork's unreviewed code the
  federated credential exchange.
- Require **human approval** before the chaos-capable step runs when the
  trigger could carry unreviewed code — a GitHub `environment` with required
  reviewers, or an Azure Pipelines `environment`/check with approvals — so a
  person, not just a role assignment, gates execution.
- Never grant the chaos-capable identity (or the `id-token: write` permission /
  service-connection access that obtains it) to a job that also executes
  unreviewed, externally-contributed code paths — workflow files, composite
  actions, scripts, or templates from a fork or an unprotected shared source.
  Least privilege on the target workspace does not protect against unreviewed
  code running *as* the trusted identity in the first place.

See [`examples/github/README.md`](../examples/github/README.md#trusted-trigger-requirements)
and [`examples/azure-pipelines/README.md`](../examples/azure-pipelines/README.md#trusted-trigger-requirements)
for platform-specific mechanics.

## Concurrency guidance

A scenario configuration has one active run at a time, and it also has exactly
one `validations/latest` resource. ARM does not version or lock that resource:
each `validate` call **overwrites** `validations/latest`, including its
`executionPlanJson`, with no eTag/If-Match/idempotency key to detect the
overwrite. This is a hazard in **both** `execute-only` mode (running a plan a
prior stage validated) and `validate-and-execute` mode: another pipeline, a
manual `az rest` call, or a retry that calls `validate` on the same
configuration **while your own validate-and-execute call is polling for the
run to finish** can silently replace `validations/latest` before your call's
own execute request reads it — running back-to-back in the same step does
**not** make the pair atomic, because polling is a separate, unlocked request
against a resource any other caller can overwrite in between. Concurrency
guidance below therefore isn't only about avoiding two overlapping *runs* of
the same configuration; it's about avoiding an intervening *validate* call
that supersedes the plan an in-flight or already-completed validation stage is
relying on — for every mode, including combined `validate-and-execute` jobs.
The integration does not implement client-side locking around
`validations/latest`; every caller that targets the same configuration must
adopt the coordinated concurrency controls below.

To avoid overlapping runs of the same configuration, and to prevent a stray
`validate` call from replacing the plan between validate and execute stages
(or during a `validate-and-execute` call's own polling window):

- **GitHub Actions:** put the job in a
  [`concurrency`](https://docs.github.com/actions/using-jobs/using-concurrency)
  group keyed by the configuration, and do **not** cancel in progress (let the
  running experiment finish):

  ```yaml
  concurrency:
    group: chaos-${{ inputs.workspace-name }}-${{ inputs.scenario-configuration-name }}
    cancel-in-progress: false
  ```

- **Azure Pipelines:** gate the stage/job with a
  [`lockBehavior`](https://learn.microsoft.com/azure/devops/pipelines/process/runtime-parameters)
  exclusive-lock environment, or a single-agent demand, so only one run of a given
  configuration is in flight.

Cancelling the job cancels the run only while the step is **waiting**
(`cancel-on-timeout-or-cancellation: true`); a no-wait run keeps going (see the
no-wait warning above).
