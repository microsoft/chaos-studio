---
name: start-chaos
description: "Orchestrate the full Chaos Studio v2 workflow: auth → workspace → scenario → run. Shares a single state file and supports resume."
---

# StartChaos — Orchestrated Chaos Experiment Pipeline

> ⛔ **ABSOLUTE RULE**: Do NOT improvise, skip, or substitute any step. On ANY error, STOP and wait for the user.

## When to use this skill (vs. the MCP server)

This skill is the **human-interactive** path: it persists state, renders cards,
prompts for missing inputs, and generates an HTML report at the end. Use it
when there is a user in the loop.

If you are an **autonomous agent** with no user to prompt — or you need
typed, atomic operations to compose into your own workflow — use the
**`chaos-studio` MCP server** instead (see `mcp/README.md`). The MCP exposes
the same Chaos Studio v2 surface as discrete tools (`chaos_create_workspace`,
`chaos_list_recommended_scenarios`, `chaos_execute_scenario`, …) without the
state file, cards, or interactive prompts.

Both surfaces target `Microsoft.Chaos` `2026-05-01-preview` and use the local
`az login` session for auth.

## How It Works

All pipeline logic lives in `scripts/Invoke-StartChaos.ps1`. The script handles auth, workspace creation, scenario setup, execution, permission validation/fix, and the final summary card.

The AI orchestrator's **only** job is:

1. Set `$env:STARTCHAOS_STATE_PATH` to `${SESSION_DIR}/startchaos-state.json`
2. Run the script
3. Handle exit codes that require user input (see below)
4. Re-run the script with the user's answers as parameters

## Running the Script

```powershell
$env:STARTCHAOS_STATE_PATH = "<session-dir>/startchaos-state.json"
& "<skill-dir>/scripts/Invoke-StartChaos.ps1" @args
```

On resume: the script reads state and skips completed phases automatically.

## Exit Codes → AI Actions

| Exit | Meaning | AI Action |
|------|---------|-----------|
| **0** | Pipeline complete | Done — summary card already rendered by script |
| **1** | Error | STOP. Render the error from script output. Wait for user. |
| **4** | Workspace inputs needed | `ask_user` for: resource group, workspace name, location, identity type, scopes. Re-run with `-ResourceGroup`, `-WorkspaceName`, `-Location`, `-IdentityType`, `-Scopes`. |
| **2** | Scenario selection needed | Read `state.setup.recommendedScenarios` from state file. `ask_user` with scenario names+descriptions as choices. Re-run with `-ScenarioName <chosen>`. |
| **3** | Parameter mode needed | Show the parameter table from the script output. `ask_user` which parameters they want to customize (or accept all defaults). Re-run with `-ParameterMode autofill` and `-ParameterValues @{ key = 'value' }` for any overrides. |

### Important: Exit 2 → 3 chaining

When exit 2 is followed by exit 3 on re-run, combine both user answers in the next invocation:
```powershell
& Invoke-StartChaos.ps1 -ScenarioName "ZoneDown-1.0" -ParameterMode "autofill" -ParameterValues @{ duration = 'PT5M' }
```

### Important: Manual mode does NOT work

`-ParameterMode manual` uses `Read-Host` prompts that do not render in a non-interactive AI session.
**Always use `-ParameterMode autofill`** combined with `-ParameterValues` for any overrides the user requests.
When exit 3 fires, show the user the parameter table from the output, ask which values they want to change, then re-run with autofill + overrides.

## Script Parameters (passed through to sub-phases)

| Parameter | Phase | Description |
|-----------|-------|-------------|
| `-ResourceGroup` | 1 | Azure resource group |
| `-WorkspaceName` | 1 | Workspace name |
| `-Location` | 1 | Azure region (default: westus2) |
| `-IdentityType` | 1 | SystemAssigned or UserAssigned |
| `-UserAssignedIdentityResourceId` | 1 | Required when IdentityType=UserAssigned |
| `-Scopes` | 1 | ARM resource ID(s) for workspace scope |
| `-ScenarioName` | 2 | Selected scenario (e.g. `ZoneDown-1.0`) |
| `-ParameterMode` | 2 | `autofill` (always use this — `manual` does not work in AI sessions) |
| `-ParameterValues` | 2 | Hashtable of parameter overrides, e.g. `@{ duration = 'PT5M' }`. Applied on top of defaults during configuration creation. |
| `-ForceReauth` | 0 | Force re-authentication |

## What the Script Handles (no AI logic needed)

- Phase sequencing and state-based resume
- Auth pre-flight (existing session detection, device-code login)
- Workspace creation, identity binding, RBAC grants
- Scenario evaluation, recommendation discovery, configuration creation
- Pre-run validation and `fixResourcePermissions` auto-remediation
- Run execution, polling, action status tracking
- Final summary card and HTML report generation
- All error cards with remediation commands
