# Azure SRE Agent import

The standalone Chaos Loop archive contains the controller, five bounded phase
skills, deterministic state tool, schemas, references, examples, and this
repository's existing `chaos-mcp` package. Azure SRE Agent setup remains a
portal operation; do not claim the package was imported until the authenticated
identity and connector steps below are complete.

## Build and unpack

From the repository root:

```powershell
pwsh -NoProfile -File .\copilot-cli-plugin\scripts\Build-ChaosLoopPackage.ps1
```

Unpack `tmp/chaos-loop-package/chaos-loop-1.0.0.zip`. The archive root is
`chaos-loop/`; it has no dependency on this checkout or another plugin
repository.

## Required Agent environment

- A persistent repository workspace. State is written under
  `tmp/chaos-loop/runs/<runId>/state.json`; ephemeral tool storage is not
  sufficient.
- Repository read access for Analysis and read/write/branch/PR access for
  Coding.
- Read access to build, artifact, deployment, and live serving-revision
  metadata.
- Azure Advisor read access, or an equivalent read-only Well-Architected
  guidance connector, for Advisory.
- An attached managed identity for Chaos Studio and Azure Monitor.

Recommended Azure RBAC on the narrowest relevant scopes:

| Capability | Role |
|---|---|
| Workspace discovery (`chaos_list_workspaces`) and readback | Reader on the subscription or resource group |
| Workspace creation when preflight finds no compatible workspace | Contributor (or `Microsoft.Chaos/workspaces/write`) on the target resource group |
| Reader grants for the workspace identity on the requested managed scopes | User Access Administrator, or an equivalent role-assignment permission, on those scopes |
| Scenario/recommendation/run reads | Reader |
| Execute/cancel the configured Scenario | Contributor or equivalent Chaos Studio write permission |
| Metrics and Activity Log | Monitoring Reader |
| Log Analytics queries | Log Analytics Reader |

Grant only Reader when you intend the loop to reuse an existing workspace: a
missing create permission is recorded as a concrete remediation brief and the
run terminates `escalated` instead of proceeding without a workspace.

The workspace identity must separately hold the roles required by the selected
fault Actions.

## Configure tools and connectors

1. In Agent Builder/Agent Canvas, create a Python tool named
   `chaos_loop_state` from `scripts/chaos_loop_state.py`.
   - Parameters: `action` (string), `arguments` (object).
   - Supported actions: `start`, `status`, `migrate`, `workspace_plan`,
     `workspace_finalize`, `workspace_fail`, `evaluate`, `apply`, `approve`,
     `resume`, `terminate_analysis_only`.
   - Do not attach an Azure identity.
   - Set its working directory to the persistent repository root.
2. Add the `chaos-studio` MCP connector from the archive's `mcp/` package (or
   the published `chaos-mcp` package at the same version).
3. Attach the managed identity and smoke-test these read-only calls before
   enabling execution:
   - `chaos_get_auth_mode`
   - `chaos_list_workspaces`
   - `chaos_get_workspace`
   - `chaos_list_recommended_scenarios`
   - `monitor_query_metrics`
4. Keep tool approval enabled for `chaos_set_auth_mode` and every write
   operation, including `chaos_create_workspace`. Do not blanket-auto-approve
   identity changes, workspace creation, or Scenario execution.

The loop persists each returned `scenarioRunId` in repository state. On resume,
Execution calls `chaos_get_scenario_run` with that exact ID; continuity does not
depend on conversational memory or an optional run-list API.

## Configure the controller and five skills

The documented Agent limit is five active skills. Keep the controller outside
that limit:

1. Use `skills/chaos-loop/SKILL.md` as the primary Agent instructions and append
   `references/chaos-loop/shared-contract.md`.
2. Create exactly these five active skills:
   - `skills/resilience-analysis/SKILL.md`
   - `skills/chaos-execution/SKILL.md`
   - `skills/diagnostic/SKILL.md`
   - `skills/advisory/SKILL.md`
   - `skills/coding/SKILL.md`
3. Attach only the required tools/connectors:

| Skill | Attach |
|---|---|
| resilience-analysis | repository read, `chaos_list_recommended_scenarios`, persistent file read/write |
| chaos-execution | `chaos_execute_scenario`, `chaos_get_scenario_run`, `chaos_cancel_scenario_run`, deployment identity read, persistent file read/write |
| diagnostic | `monitor_query_logs`, `monitor_query_metrics`, `monitor_search_activity_log`, persistent file read/write |
| advisory | Azure Advisor/guidance read, persistent file read/write |
| coding | repository edit/branch/PR, allowed build command, persistent file read/write |

The controller alone uses `chaos_loop_state`, `chaos_list_workspaces`,
`chaos_get_workspace`, and `chaos_create_workspace`; workspace resolution is a
start-time controller responsibility, never a phase responsibility. Phase
skills write proposal JSON beside run state, never mutate state directly, and
never invoke one another.

## Invocation and customer gates

```text
chaos loop start repo=contoso/orders commit=<sha>
target_resources=["<ARM resource ID>"]
workspace_request={"subscriptionId":"<subscription UUID>","resourceGroup":"<rg>","location":"eastus","managedScopes":["/subscriptions/<subscription UUID>/resourceGroups/<rg>"]}
guardrails={"environmentScope":"staging","blastRadiusCap":"one replica","safetyHalts":["<halt>"]}
```

`workspace_request` is required. Before any phase runs, the controller lists
existing workspaces, plans reuse-or-create deterministically, reads back or
creates the workspace (creation requires tool approval), and finalizes the
proven workspace into run state. A permission, policy, provisioning, or
readback failure persists a remediation brief and terminates the run
`escalated`. Workspace resolution is not a customer interaction stop.

The controller auto-advances until one of two normal interaction stops:

1. `advisory-approval`: the customer selects IDs from the ranked advisory set.
   Coding starts automatically after explicit approval.
2. `awaiting-external-gate`: Coding has delivered PRs. Resume with a payload
   matching `schemas/chaos-loop/external-gate.v1.schema.json` that proves:

   `merge commit -> build -> artifact -> deployment -> live serving revision`.

After gate validation, the controller automatically runs reassessment, the
identical frozen fault, and verify Diagnostic.

## Manual portal work that remains

- Create the `chaos_loop_state` Python tool.
- Add and configure the `chaos-studio` MCP connector.
- Attach managed identity, RBAC, approval policy, and Advisor/repository/build
  connectors.
- Confirm the identity can list and read `Microsoft.Chaos/workspaces`, and can
  create one when workspace reuse is not intended.
- Paste/configure the controller instructions and five skills.
- Configure persistent repository storage.
- Smoke-test read-only discovery and state creation before enabling execution.
