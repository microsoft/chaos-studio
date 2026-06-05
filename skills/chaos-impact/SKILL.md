---
name: chaos-impact
description: "Synthesize an Azure Monitor impact report for a Chaos Studio v2 ScenarioRun: pulls the run, walks targeted resources, queries metrics/logs/activity-log/alerts over the run window ± buffer, and renders a Markdown + JSON impact card."
---

# ChaosImpact — Post-Run Azure Monitor Synthesis

> ⛔ **ABSOLUTE RULE**: Do NOT improvise, skip, or substitute any step. On ANY error, STOP and wait for the user.

## When to use this skill (vs. the MCP server)

This skill is the **human-interactive** path: it resolves run context from the
shared `startchaos-state.json`, prompts for missing inputs via exit codes, and
renders a Markdown card plus a JSON sidecar. Use it when there is a user in the
loop — typically right after `/start-chaos` (or as a post-step of it).

If you are an **autonomous agent** with no user to prompt, call the three
Monitor tools on the `chaos-studio` MCP server directly (`monitor_query_metrics`,
`monitor_query_logs`, `monitor_search_activity_log`) and assemble your own
report. The PowerShell skill and the MCP tools are two independent surfaces
over the same Azure endpoints — neither calls the other.

Both surfaces target `Microsoft.Chaos` `2026-05-01-preview` plus the pinned
Azure Monitor API versions in `scripts/Constants.ps1`, and use the local
`az login` session for auth.

## How It Works

All synthesis logic lives in `scripts/Invoke-ChaosImpact.ps1`. The script
resolves the ScenarioRun, discovers Log Analytics workspaces via diagnostic
settings, runs the Monitor query fan-out, classifies signals, and writes both
artifacts.

The AI orchestrator's **only** job is:

1. Set `$env:STARTCHAOS_STATE_PATH` to `${SESSION_DIR}/startchaos-state.json`
   (the skill **reads** but does not **write** this file).
2. Run the script with `-ScenarioRunId <id>` (positional accepted).
3. Handle exit codes that require user input (see below).
4. Re-run the script with the user's answers as parameters.

## Running the Script

```powershell
$env:STARTCHAOS_STATE_PATH = "<session-dir>/startchaos-state.json"
& "<skill-dir>/scripts/Invoke-ChaosImpact.ps1" -ScenarioRunId <runId> @extraArgs
```

When invoked standalone (no prior `start-chaos` state file), the orchestrator
must supply `-SubscriptionId`, `-ResourceGroup`, `-WorkspaceName`, and
`-ScenarioName` — otherwise the script exits 2.

## Exit Codes → AI Actions

| Exit | Meaning | AI Action |
|------|---------|-----------|
| **0** | Report generated | Done — print the Markdown card from script output. |
| **1** | Hard error | STOP. Render the error from script output. Wait for user. |
| **2** | Missing run context | `ask_user` for any of: `-SubscriptionId`, `-ResourceGroup`, `-WorkspaceName`, `-ScenarioName`, `-ScenarioRunId`. Re-run with the supplied parameters. |
| **3** | Log Analytics workspace not discoverable for ≥ 1 resource, AND `-LogAnalyticsWorkspaceId` not supplied | `ask_user` whether to (a) supply a workspace ID (re-run with `-LogAnalyticsWorkspaceId <id>`) or (b) proceed without log signals (re-run with `-LogAnalyticsWorkspaceId none`). |
| **4** | Permission gap (caller lacks `Monitoring Reader` on one or more target resource groups) _(Epic 3 — not yet implemented)_ | `ask_user` to confirm best-effort partial report (re-run with `-AllowPartial`) or abort. |

## Script Parameters

| Parameter | Description |
|---|---|
| `-ScenarioRunId` | Required (positional). The ScenarioRun resource name. |
| `-SubscriptionId` / `-ResourceGroup` / `-WorkspaceName` / `-ScenarioName` | Run context. Read from `startchaos-state.json` when omitted; required otherwise. |
| `-Buffer` | ISO-8601 duration added before/after the run window. Default `PT5M`. |
| `-LogAnalyticsWorkspaceId` | Optional override when diag-settings discovery fails for some resources. Pass `none` to explicitly skip log signals. |
| `-MaxResources` | Per-run resource cap. Default `50`. Instance-level targets (VMSS / AKS) are collapsed to parent before counting. |
| `-OutputDir` | Where to drop artifacts. Default `$env:STARTCHAOS_SESSION_DIR` or current directory. |
| `-IncludeBaseline` | When set, also computes baseline samples (the `-Buffer × 2` window before run start). Default on. |
| `-Format` | `markdown`, `json`, or `both`. Default `both`. |
| `-AllowPartial` | Continue past permission gaps and emit a `partial` report. _(Epic 3 — not yet implemented; currently accepted but has no effect.)_ |

## What the Script Handles (no AI logic needed)

- Run resolution and targeted-resource flattening (collapses instance-level → parent)
- `MaxResources` cap with explicit coverage caveats
- Diagnostic-settings discovery + per-resource workspace caching
- Azure Monitor metrics / Log Analytics / Activity Log / Alerts / Service Health fan-out
- Baseline subtraction and signal classification
- Markdown report card + JSON sidecar artifact
- All error cards with remediation commands
