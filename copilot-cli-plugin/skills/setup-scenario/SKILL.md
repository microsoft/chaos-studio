---
name: setup-scenario
description: "Discover recommended Scenarios in Chaos Studio Workspaces, build and validate a ScenarioConfiguration, and auto-fix resource permissions."
---

# SetupScenario — configure and validate Scenarios in Chaos Studio Workspaces

> ⛔ **ABSOLUTE RULE**: Do NOT improvise, skip, or substitute any step. On ANY error, STOP and wait for the user.

## When to use this skill (vs. the MCP server)

This skill is the **human-interactive** path: it shares state with the rest of the pipeline, prompts via exit codes, and renders cards. Use it when there is a user in the loop.

If you are an **autonomous agent** with no user to prompt, use the MCP tools directly: `chaos_refresh_recommendations`, `chaos_list_recommended_scenarios`, `chaos_create_scenario_configuration`, `chaos_validate_scenario_configuration`, `chaos_fix_resource_permissions`. See the [MCP server guide](../../mcp/README.md).

Both surfaces target `Microsoft.Chaos` `2026-05-01-preview` and use the local `az login` session for auth.
For supported outage patterns and Actions, see the [Scenario catalog](https://learn.microsoft.com/azure/chaos-studio/chaos-studio-scenarios).

## How It Works

All discovery, configuration, validation, and permission-fix logic lives in `scripts/Invoke-SetupScenario.ps1`. The script drives the Chaos Studio operations through the `az chaos` CLI extension — Workspace evaluation, recommendation listing, Scenario selection routing, parameter resolution, configuration creation, and the validate→fix→re-validate loop.

The AI orchestrator's **only** job is:

1. Set `$env:STARTCHAOS_STATE_PATH` to `${SESSION_DIR}/startchaos-state.json`.
2. Run the script (no parameters needed for the first call).
3. Handle exit codes that require user input (see below).
4. Re-run the script with the user's answers as parameters.

## Prerequisites

- `state.workspace.status == "done"` (Workspace must exist; the script refuses otherwise)
- `state.context.subscriptionId` populated

## Running the Script

```powershell
$env:STARTCHAOS_STATE_PATH = "<session-dir>/startchaos-state.json"
& "<skill-dir>/scripts/Invoke-SetupScenario.ps1" @args
```

On resume: re-runs short-circuit when `state.setup.status == "done"`.

## Exit Codes → AI Actions

| Exit | Meaning | AI Action |
|------|---------|-----------|
| **0** | Configuration created and validated | Done — summary already rendered by script. |
| **1** | Hard error | STOP. Render the error from script output. Wait for user. State has `setup.lastError`. |
| **2** | Scenario selection needed | Read `state.setup.recommendedScenarios` (or the script's rendered list). `ask_user` for one name. Re-run with `-ScenarioName <chosen>`. |
| **3** | Parameter mode needed | Show the parameter table from the script output. `ask_user` which parameters they want to override (or accept defaults). Re-run with `-ParameterMode autofill` and `-ParameterValues @{ key = 'value' }` for any overrides. |

### Important: Manual mode does NOT work

`-ParameterMode manual` uses `Read-Host` prompts that do not render in a non-interactive AI session. **Always use `-ParameterMode autofill`** combined with `-ParameterValues` for any overrides the user requests.

### Important: Exit 2 → 3 chaining

When exit 2 is followed by exit 3 on re-run, combine both answers in the next invocation:
```powershell
& Invoke-SetupScenario.ps1 -ScenarioName "ZoneDown-1.0" -ParameterMode "autofill" -ParameterValues @{ duration = 'PT5M' }
```

## Script Parameters

| Parameter | Description |
|-----------|-------------|
| `-ScenarioName` | Selected Scenario (e.g. `ZoneDown-1.0`). Bypasses the selection prompt. Equivalent to `$env:STARTCHAOS_SCENARIO`. |
| `-ParameterMode` | `autofill` (always use this — `manual` does not work in AI sessions). |
| `-ParameterValues` | Hashtable of parameter overrides applied on top of defaults, e.g. `@{ duration = 'PT5M' }`. |

## What the Script Handles (no AI logic needed)

- Workspace evaluation via `az chaos workspace refresh-recommendation` (CLI awaits the LRO) + `show-evaluation` summary
- Scenario list (`az chaos scenario list`) filtered to `recommendation.recommendationStatus == "Recommended"`
- Auto-select when exactly one Scenario is recommended; pause-and-emit-exit-2 otherwise
- ScenarioConfiguration create (`az chaos scenario config create`, `--scenario-id` auto-derived) with parameter merge (defaults + overrides)
- Validate (`az chaos scenario config validate`) → if not Succeeded → `az chaos scenario config fix-permissions` → re-validate
- RBAC propagation retry loop (up to 5 minutes, 20s interval) gated to permission-related errors only
- Atomic state writes with error envelopes
- Idempotent re-runs

## Related Skills

- `create-workspace` — must complete before this skill
- `run-scenario` — next phase after setup
