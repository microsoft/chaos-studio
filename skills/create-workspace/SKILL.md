---
name: create-workspace
description: "Provision a Microsoft.Chaos/workspaces resource (v2), bind a managed identity, set scopes, and grant Reader RBAC on the scope."
---

# CreateWorkspace — Chaos Studio Workspace Provisioning

> ⛔ **ABSOLUTE RULE**: Do NOT improvise, skip, or substitute any step. On ANY error, STOP and wait for the user.

## When to use this skill (vs. the MCP server)

This skill is the **human-interactive** path: it persists state to `startchaos-state.json`, renders cards, and produces the workspace + identity + Reader RBAC in one go. Use it when there is a user in the loop.

If you are an **autonomous agent** with no user to prompt, call `chaos_create_workspace` on the `chaos-studio` MCP server. Same provisioning + identity binding + Reader RBAC, returned as a single tool call. See `mcp/README.md`.

Both surfaces target `Microsoft.Chaos` `2026-05-01-preview` and use the local `az login` session for auth.

## How It Works

All provisioning logic lives in `scripts/Invoke-CreateWorkspace.ps1`. The script handles input validation, PUT body construction, LRO polling, identity resolution, RBAC test/grant, and state persistence.

The AI orchestrator's **only** job is:

1. Set `$env:STARTCHAOS_STATE_PATH` to `${SESSION_DIR}/startchaos-state.json`.
2. Run the script with the required parameters.
3. Handle exit codes that require user input (see below).
4. Re-run with the user's answers as parameters.

## Prerequisites

- `state.auth.status == "done"` (run auth pre-flight first; the script refuses to start otherwise)
- `state.context.subscriptionId` populated

## Running the Script

```powershell
$env:STARTCHAOS_STATE_PATH = "<session-dir>/startchaos-state.json"
& "<skill-dir>/scripts/Invoke-CreateWorkspace.ps1" `
    -ResourceGroup <rg> `
    -WorkspaceName <name> `
    -Scopes @('<arm-id>', ...) `
    [-Location <region>] `
    [-IdentityType SystemAssigned|UserAssigned] `
    [-UserAssignedIdentityResourceId <uami-arm-id>]
```

Idempotent: re-runs short-circuit when `state.workspace.status == "done"`.

## Exit Codes → AI Actions

| Exit | Meaning | AI Action |
|------|---------|-----------|
| **0** | Workspace ready | Done — summary already rendered by script. |
| **1** | Hard error | STOP. Render the error from script output. Wait for user. State has `workspace.lastError`. |

If a required parameter is missing, PowerShell's parameter binder fails before the script body runs — gather the missing input via `ask_user` and retry.

## Script Parameters

| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| `-ResourceGroup` | yes | — | Azure resource group name |
| `-WorkspaceName` | yes | — | Name for the workspace resource |
| `-Scopes` | yes | — | ARM IDs the workspace is allowed to target (subscription / RG / service group) |
| `-Location` | no | `westus2` | Azure region |
| `-IdentityType` | no | `SystemAssigned` | `SystemAssigned` or `UserAssigned` |
| `-UserAssignedIdentityResourceId` | conditional | — | Required when `-IdentityType UserAssigned` |

## What the Script Handles (no AI logic needed)

- Input validation and ARM-ID well-formedness checks
- PUT workspace body construction per the v2 spec
- Azure-AsyncOperation LRO polling with terminal-state surfacing
- Identity resolution (SystemAssigned principalId from response; UserAssigned via UAMI GET)
- Per-scope `Test-CallerCanAssignRoles` + Reader role assignment with remediation card on denial
- Atomic state writes with error envelopes
- Idempotent re-runs

## Related Skills

- `start-chaos` — orchestrator that invokes this skill
- `setup-scenario` — next phase after workspace creation
