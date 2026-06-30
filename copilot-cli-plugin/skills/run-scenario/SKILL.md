---
name: run-scenario
description: "Execute a ScenarioConfiguration and stream ScenarioRun status with per-action breakdown until terminal state."
---

# RunScenario — Scenario Execution & Status Streaming

> ⛔ **ABSOLUTE RULE**: Do NOT improvise, skip, or substitute any step. On ANY error, STOP and wait for the user.

## When to use this skill (vs. the MCP server)

This skill is the **human-interactive** path: it reads run context from `startchaos-state.json`, renders status cards, and persists the run result. Use it when there is a user in the loop.

If you are an **autonomous agent** with no user to prompt, use `chaos_execute_scenario` + `chaos_get_scenario_run` (MCP) for a non-interactive run-and-poll flow. Cancellation: `chaos_cancel_scenario_run`. See `mcp/README.md`.

Both surfaces target `Microsoft.Chaos` `2026-05-01-preview` and use the local `az login` session for auth.

## How It Works

All execution and status-streaming logic lives in `scripts/Invoke-RunScenario.ps1`. The script handles confirmation gating, the execute POST, ScenarioRun ID resolution (Location LRO + ListAll fallback), per-poll status rendering, terminal-state detection, and the final summary.

The AI orchestrator's **only** job is:

1. Set `$env:STARTCHAOS_STATE_PATH` to `${SESSION_DIR}/startchaos-state.json`.
2. Run the script.
3. Handle exit codes (see below).

The script takes **no parameters**: configuration name, scenario, and workspace are all read from state.

## Prerequisites

- `state.setup.status == "done"` (configuration must exist and be validated)
- `state.setup.configuration.id` populated

## Running the Script

```powershell
$env:STARTCHAOS_STATE_PATH = "<session-dir>/startchaos-state.json"
& "<skill-dir>/scripts/Invoke-RunScenario.ps1"
```

For non-interactive sessions, set `$env:STARTCHAOS_NONINTERACTIVE=1` to skip the confirmation prompt.

## Exit Codes → AI Actions

| Exit | Meaning | AI Action |
|------|---------|-----------|
| **0** | Run reached a terminal state (Succeeded / Failed / Canceled) | Done — final card already rendered by script. Inspect `state.run.status` for terminal classification. |
| **1** | Hard error before/during execution | STOP. Render the error from script output. Wait for user. State has `run.lastError`. |

## Cancellation

On `Ctrl+C`, the script invokes `ScenarioRuns_Cancel` (POST `.../runs/{runId}/cancel`) best-effort and persists `state.run.lastError = "user-cancelled"`.

## What the Script Handles (no AI logic needed)

- Confirmation card with scenario, parameters, and scope summary (suppressed when `STARTCHAOS_NONINTERACTIVE=1`)
- POST `.../execute` with Location-style LRO polling
- ScenarioRun ID resolution from the LRO terminal body, with `ScenarioRuns_ListAll` fallback for older service builds
- Per-poll status card: top status, elapsed time, per-action `scenarioRunSummary[]` table, resource count, error counts
- Terminal-state detection (`Succeeded`, `Failed`, `Canceled`) and final summary card
- Atomic state writes with error envelopes
- Cancellation handling

## Related Skills

- `setup-scenario` — must complete before this skill
- `chaos-impact` — post-run Azure Monitor impact synthesis
- `start-chaos` — orchestrator that invokes this skill
