# startchaos — Chaos Studio v2 Workspace Plugin

A GitHub Copilot CLI plugin that guides Azure customers through the end-to-end
**Chaos Studio v2 Workspace** experience: provision a workspace, configure
scenarios, and execute chaos experiments — all from a single conversation.

## Prerequisites

| Requirement | Minimum Version | Notes |
|---|---|---|
| **PowerShell** (`pwsh`) | 7.4+ | Cross-platform; `winget install Microsoft.PowerShell` |
| **Azure CLI** (`az`) | 2.61+ | `winget install Microsoft.AzureCLI` |
| **GitHub Copilot CLI** | latest | Must support plugin marketplaces |
| `jq` *(optional)* | any | Fallback to `ConvertFrom-Json` if absent |

## Installation

1. Ensure your repo's `.copilot-plugins.yaml` includes:

   ```yaml
   marketplaces:
     - name: chaos-ai-plugins
       source: gim-home/Chaos-AI-Plugins

   plugins:
     - name: startchaos
       marketplace: chaos-ai-plugins
   ```

2. Run the bootstrap skill or:

   ```bash
   copilot plugin marketplace add gim-home/Chaos-AI-Plugins
   copilot plugin install startchaos@chaos-ai-plugins
   ```

## Two ways to use this plugin

| Surface | Folder | For |
|---|---|---|
| **Skill** (interactive) | `skills/start-chaos` | Humans driving Chaos Studio from a conversation |
| **MCP server** | `mcp/` | Autonomous agents that need typed Chaos Studio tools |

Both target `Microsoft.Chaos` `2026-05-01-preview` and use the local `az login`
session for auth.

## Skills

| Skill | Description |
|---|---|
| `start-chaos` | Orchestrator — auth → workspace → scenario → run |
| `create-workspace` | Provision workspace + identity + RBAC |
| `setup-scenario` | Discover, configure, validate scenarios |
| `run-scenario` | Execute and stream experiment results |
| `chaos-impact` | Analyze run impact — correlate Azure Monitor signals to targeted resources |

## MCP tools (for agents)

Install the MCP server. **Two install paths**:

**From PyPI (recommended once published):**
```bash
pip install chaos-mcp
```

**From source (for development):**
```bash
pip install -e ./mcp
```

Register it in your MCP client config (see `mcp/mcp-config.example.json`):

```json
{ "mcpServers": { "chaos-studio": { "command": "chaos-mcp" } } }
```

Per-client config snippets (Claude Desktop, Cursor, Codex CLI) are in
`mcp/README.md`. The Copilot CLI plugin wires this up automatically via
`plugin.json`.

| Tool | Purpose |
|---|---|
| `chaos_create_workspace` | Provision workspace + identity + Reader RBAC |
| `chaos_get_workspace` | Fetch workspace |
| `chaos_refresh_recommendations` | Trigger workspace evaluation |
| `chaos_list_recommended_scenarios` | List recommended scenarios |
| `chaos_create_scenario_configuration` | Create/update configuration (LRO-aware) |
| `chaos_validate_scenario_configuration` | Validate configuration |
| `chaos_fix_resource_permissions` | Auto-grant scenario target roles |
| `chaos_execute_scenario` | Kick off a run, return `scenarioRunId` |
| `chaos_get_scenario_run` | Single status snapshot |
| `chaos_cancel_scenario_run` | Best-effort cancel |
| `monitor_query_metrics` | Query Azure Monitor metrics for a resource over a time window |
| `monitor_query_logs` | Run a KQL query against a Log Analytics workspace |
| `monitor_search_activity_log` | Search the Azure Activity Log for resource events |

See `mcp/README.md` for the full agent integration guide and publishing
instructions (PyPI + Smithery).

## Usage

```text
> /start-chaos

# The orchestrator will guide you through:
#   Phase 0 — Azure CLI authentication
#   Phase 1 — Create a Chaos Studio workspace
#   Phase 2 — Set up a scenario configuration
#   Phase 3 — Run the chaos experiment
```

## Impact Report

After a chaos run completes, use `/chaos-impact` to automatically correlate Azure Monitor
signals (metrics, logs, activity log, alerts, service health) with the targeted resources
and classify them as **chaos-attributed**, **baseline**, or **unexplained**.

```text
> /chaos-impact <scenarioRunId>

# Produces:
#   impact-<runId>.md    — Markdown report card (per-action signal tables)
#   impact-<runId>.json  — JSON sidecar (schema v1, suitable for cross-run diffing)
```

### Parameters

| Parameter | Default | Description |
|---|---|---|
| `<scenarioRunId>` | *(required)* | The run to analyze |
| `-Buffer` | `PT5M` | Pre/post window buffer (ISO-8601 duration) |
| `-OutputDir` | session dir | Where to write artifacts |
| `-MaxResources` | `50` | Per-run resource fan-out cap |
| `-LogAnalyticsWorkspaceId` | *(auto-discovered)* | Override when discovery fails; pass `none` to skip logs entirely |
| `-Format` | `both` | `markdown`, `json`, or `both` |

### Exit codes

| Code | Meaning |
|---|---|
| 0 | Report emitted successfully |
| 1 | Hard error (details on stderr / in an error card) |
| 2 | Missing run context — re-invoke with the missing parameters |
| 3 | Log Analytics workspace not discoverable for ≥ 1 resource — supply `-LogAnalyticsWorkspaceId <id>` or `-LogAnalyticsWorkspaceId none` |
| 4 | Permission gap — ensure caller has `Monitoring Reader` on the targeted resource groups |

### How it works

1. Pulls the `ScenarioRun` resource from ARM.
2. Flattens `scenarioRunSummary[*].resources[*].id` → unique target set.
3. Discovers Log Analytics workspaces via diagnostic settings on each resource.
4. Queries metrics, resource logs (KQL), activity log, alerts, and service health
   over `[run.startedAt − buffer, run.completedAt + buffer]`.
5. Classifies each signal by time-overlap, target-overlap, and magnitude vs. baseline.
6. Renders a Markdown report card and a JSON sidecar.

See [`docs/impact-synthesis-skill.md`](docs/impact-synthesis-skill.md) for a full walkthrough.

## Configuration Overrides

Copy `.chaos-plugins.yaml.example` to your repo root as `.chaos-plugins.yaml`
and customize polling intervals, timeouts, and defaults.

## State File

The plugin persists progress to `$env:STARTCHAOS_STATE_PATH`
(default: `${SESSION_DIR}/startchaos-state.json`). Re-invoking the orchestrator
resumes from the first incomplete phase.

## Sample Transcript

See [`docs/impact-synthesis-skill.md`](docs/impact-synthesis-skill.md) for a full walkthrough including a sample impact report.

```text
[placeholder — a full happy-path transcript will be added here]
```

## API Version

All ARM calls target **`2026-05-01-preview`** (`Microsoft.Chaos` namespace).

## License

MIT
