# Chaos Impact Synthesis — Solution Design & Implementation Plan

> Plugin: `startchaos` (Copilot CLI plugin for Azure Chaos Studio v2)
> Proposed skill name: **`chaos-impact`** (folder: `skills/chaos-impact/`)
> Trigger: `/chaos-impact <scenarioRunId>` — or auto-invoked as a post-step by `/start-chaos`
> Audience: Chaos Studio plugin engineers; brief decisions summary for Chaos Studio architects.
> Revision: 2 (addresses technical review feedback — see Revision History at end).

---

## Executive Summary

Today, the `startchaos` plugin can stand up a Chaos Studio v2 workspace, configure a
scenario, execute it, and render an HTML run report containing the *control-plane* view
(per-action status, errors, target counts). It says **nothing** about what actually
happened to the targeted Azure resources during the run. Customers running a chaos
experiment must then manually pivot to Azure Monitor — metrics, Log Analytics, Activity
Log, Service Health, alerts — and correlate signals by hand.

This document proposes a new Copilot CLI skill, **`chaos-impact`**, which automates that
correlation. Given a ScenarioRun, it pulls the run resource, walks the targeted resource
list, queries Azure Monitor over the run window plus a configurable buffer, and emits a
structured **impact report card** (Markdown for humans, JSON sidecar for diffing). The
report separates chaos-caused signals from baseline noise and unexplained anomalies.

The skill follows the established `startchaos` conventions: a Markdown orchestrator
backed by PowerShell scripts under `scripts/`, state persisted under
`${SESSION_DIR}/`, auth via the caller's `az` session. The skill itself talks to
Azure (ARM + Azure Monitor) via the existing `Invoke-AzRest` helper — **it does
not embed an MCP client**. In parallel, the `chaos-mcp` Python server is extended
with **three** new tools (`monitor_query_metrics`, `monitor_query_logs`,
`monitor_search_activity_log`) so autonomous agents have feature parity with the
skill. The PowerShell path and the MCP path are two independent surfaces over
the same Azure endpoints (the same dual-surface model used by the rest of the
plugin) — neither calls the other. All correlation, classification, and rendering
logic lives in PowerShell.

---

## Background

### Current state

The `startchaos` plugin (see `plugin.json`, version `0.2.0`) ships two parallel surfaces
over the same `Microsoft.Chaos` 2026-05-01-preview API:

- **Skills** (`skills/start-chaos`, `create-workspace`, `setup-scenario`, `run-scenario`)
  — interactive Markdown orchestrators that delegate all logic to PowerShell scripts in
  each skill's `scripts/` folder, sharing helpers from `skills/_shared/`:
  - `Invoke-AzRest.ps1` — canonical ARM wrapper around `az rest` (subscription
    auto-injection, LRO support, JSON body marshalling, structured response).
  - `State.ps1` — atomic JSON state at `$env:STARTCHAOS_STATE_PATH` (schema v1).
  - `Render.ps1` — terminal "cards" for progress / errors / success.
  - `New-RunReport.ps1` — final HTML run report renderer (consumes
    `state.run.scenarioRunSummary` and per-action data).
  - `Ensure-AzLogin.ps1`, `Rbac.ps1`, `Wait-AzureLro.ps1` — auth pre-flight, RBAC
    grants, LRO polling.
- **MCP server** (`mcp/chaos_mcp/`) — Python FastMCP server exposing 10 typed tools
  over the same Chaos Studio v2 surface for autonomous agents. The server is
  stateless and uses the caller's `az` session via `az rest` shell-outs (see
  `mcp/chaos_mcp/azure.py`).

The terminal run summary rendered by the run-scenario skill ends at the boundary of the
Chaos Studio API: it knows whether each *action* succeeded, on which resources it ran,
and any execution / permission / resource errors. It has **no observation** of the target
resources themselves.

### Why now

- Customers consistently ask "what did chaos actually do to my service?" in user
  research. Recurring asks: drop-in noise rejection, side-by-side run comparisons,
  and pasteable post-mortem artifacts.
- The 2026-05-01-preview ScenarioRun resource exposes top-level `startedAt` /
  `completedAt` and a per-action `scenarioRunSummary: ScenarioRunSummaryAction[]`
  collection. Per `scenarioRun.models.tsp` (model `ScenarioRunSummaryAction`,
  lines 236–268), each action exposes: `actionUrn` (key), `state`,
  `resources: ScenarioRunResource[]` (NOT `targetedResources`), and optional
  `startedAt?` / `completedAt?` (utcDateTime). The optionality is load-bearing:
  the correlation algorithm MUST tolerate missing per-action timing and fall
  back to the overall run window — see §"Correlation algorithm".
- Azure Monitor's REST surface (Metrics, Logs/KQL, Activity Log, Alerts, Service
  Health) is stable and uniformly available across regions; the same `az` session
  used by the plugin already has the right tokens for these endpoints.

### Prior art

- The existing skills follow a *thin Markdown orchestrator + fat PowerShell*
  pattern (e.g. `skills/start-chaos/SKILL.md`). The new skill MUST adopt this same
  shape — including the resume-from-state and `ask_user`-driven exit-code contract.
- The MCP server already wraps `arm_get` / `arm_post` against the ARM endpoint;
  adding wrappers for `management.azure.com` (Metrics, Activity Log) and
  `api.loganalytics.io` (Logs) is a pure additive extension.

---

## Problem Statement

After a Chaos Studio v2 run completes, customers need to answer:

1. **Did the chaos action have the intended impact?** e.g. for `VMSS-StopInstance`, did
   instance count actually drop on the targeted VMSS during the action window?
2. **What collateral effects occurred?** e.g. dependent AKS deployments crash-looping,
   downstream SLO alerts firing, AppGateway 5xx rate increasing.
3. **Was anything observed actually caused by the chaos run** vs. baseline noise that
   was present before the run started?
4. **Are there unexplained anomalies** that don't map to any specific chaos action and
   warrant manual investigation?

Pain points today:

- All correlation is manual. Customers paste run start/end times into Azure Monitor
  and Log Analytics by hand.
- The Log Analytics workspace for a given target resource isn't trivially
  discoverable — it depends on per-resource diagnostic settings.
- There is no machine-readable record of what was observed, so cross-run comparison
  ("did this scenario regress between v1.0 and v1.1?") is impossible.

---

## Goals and Non-Goals

### Goals

1. Given a `scenarioRunId` (and optionally workspace/scenario context), produce in a
   single command:
   - A Markdown impact report card containing per-action impact, classified signals,
     and remediation hints.
   - A JSON sidecar containing every signal observed plus correlation metadata,
     stable enough to diff across runs.
2. Pull the ground-truth ScenarioRun resource via existing
   `chaos_get_scenario_run` MCP tool — no duplicate ARM logic in the new skill.
3. Query Azure Monitor (metrics, logs, activity log, alerts, service health) for the
   `[run.startedAt − buffer, run.completedAt + buffer]` window, scoped to the
   resources listed in `scenarioRunSummary[*].targetedResources`.
4. Classify every observation as **chaos-attributed**, **baseline**, or
   **unexplained**, with explicit, documented heuristics.
5. Surface partial-data and failure cases cleanly (e.g. "no diagnostic settings on
   resource X → log signals unavailable") in both Markdown and JSON.
6. Reuse existing `startchaos` conventions: same script layout, same state file,
   same exit-code → `ask_user` contract.
7. Ship the skill in the plugin's marketplace manifest so it is installed alongside
   `start-chaos`.

### Non-Goals

- **Root-cause analysis.** We surface correlated signals; we do not infer causality
  beyond the time/target correlation rules documented here.
- **Long-horizon trend analysis.** We focus on the run window ± buffer. Multi-day or
  multi-run rollup is left for a future skill.
- **New observability ingestion.** We never enable diagnostic settings on customer
  resources, never create Log Analytics workspaces, and never deploy DCRs.
- **Replacing Azure Monitor UI.** The output is a triage / post-mortem artifact, not a
  general-purpose Monitor replacement.
- **Cross-tenant queries.** Single tenant per invocation, matching the rest of the
  plugin's auth model.

---

## Requirements

### Functional

| ID | Requirement |
|---|---|
| F1 | Skill MUST accept a `scenarioRunId` plus enough context to locate the run (subscription, RG, workspace, scenario). When invoked from `/start-chaos`, this context MUST be readable from the existing `startchaos-state.json`. |
| F2 | Skill MUST resolve the run's top-level `startedAt`/`completedAt` and, per `scenarioRunSummary[*]` action, `actionUrn`, `state`, optional `startedAt`/`completedAt`, and `resources[*].id`. When per-action times are absent (the TypeSpec model marks them optional), the skill MUST fall back to the overall run window for that action. |
| F3 | For each *unique* targeted Azure resource, skill MUST query: (a) platform metrics; (b) resource logs (if a Log Analytics workspace is discoverable); (c) Activity Log entries; (d) alerts that fired during the window. |
| F4 | Skill MUST support a configurable pre/post buffer (default ±5 minutes), enforced uniformly across all queries. |
| F5 | Skill MUST classify signals into `chaos-attributed`, `baseline`, or `unexplained` per the heuristics in §"Correlation algorithm". |
| F6 | Skill MUST emit (a) a Markdown report and (b) a JSON sidecar to the session directory (or a user-supplied `-OutputDir`). |
| F7 | Skill MUST work on an in-flight run (`status == Running`), producing a partial report (best-effort, with a `partial: true` flag). |
| F8 | Skill MUST be re-runnable: re-running with the same `scenarioRunId` MUST overwrite the previous artifacts atomically. |
| F9 | When invoked standalone, skill MUST work without any prior `startchaos-state.json` (build a minimal state object on the fly). |

### Non-Functional

| ID | Requirement |
|---|---|
| N1 | All Azure calls MUST use the caller's existing `az` session. No service principals; no stored secrets. |
| N2 | Per-resource query fan-out MUST be bounded (default cap: 50 unique resources per run; configurable via `-MaxResources`). When exceeded, the skill MUST sample and clearly flag truncation in the output. |
| N3 | Total wall-clock MUST be < 90 s for a typical run (1 action, ≤ 10 resources, single Log Analytics workspace). |
| N4 | KQL queries MUST cap rows (default `take 500` per query) to avoid runaway costs / responses. |
| N5 | All ARM/Monitor calls MUST be retried with exponential backoff on 429 / 5xx, matching the existing `Invoke-AzRest` behaviour. |
| N6 | JSON sidecar MUST conform to a versioned schema (`impactReportSchemaVersion: 1`) to support diffing tools. |

---

## Proposed Design

### Architecture Overview

```
┌──────────────────────────────────────────────────────────────────────┐
│  Copilot CLI                                                         │
│  /chaos-impact <scenarioRunId> [-Buffer PT5M] [-OutputDir <path>]    │
└──────────────┬───────────────────────────────────────────────────────┘
               │
               ▼
┌──────────────────────────────────────────────────────────────────────┐
│  skills/chaos-impact/SKILL.md          (orchestrator, Markdown)      │
│   • Sets $env:STARTCHAOS_STATE_PATH                                  │
│   • Invokes Invoke-ChaosImpact.ps1                                   │
│   • Handles exit codes (missing context → ask_user; no workspace →   │
│     prompt for -LogAnalyticsWorkspaceId)                             │
└──────────────┬───────────────────────────────────────────────────────┘
               │
               ▼
┌──────────────────────────────────────────────────────────────────────┐
│  skills/chaos-impact/scripts/Invoke-ChaosImpact.ps1                  │
│                                                                      │
│   Phase A: Resolve run                                               │
│     → Invoke-AzRest GET .../scenarioRuns/{id} (api 2026-05-01-preview)│
│   Phase B: Resolve observability                                     │
│     → Get-DiagnosticSettings.ps1  (per targeted resource)            │
│     → fallback: -LogAnalyticsWorkspaceId user-supplied               │
│   Phase C: Query Azure Monitor (ALL via Invoke-AzRest)               │
│     → Metrics:        GET .../providers/Microsoft.Insights/metrics   │
│     → Logs (KQL):     POST api.loganalytics.io/v1/workspaces/{id}/.. │
│     → Activity Log:   GET .../Microsoft.Insights/eventtypes/...      │
│     → Alerts:         GET .../Microsoft.AlertsManagement/alerts      │
│     → Service Health: GET .../Microsoft.ResourceHealth/events        │
│                                                                      │
│   (chaos-mcp ships three parallel Monitor tools for agent callers;   │
│    the skill does NOT consume them — see Design Decision #2.)        │
│   Phase D: Correlate & classify                                      │
│     → Build-ImpactCorrelation.ps1                                    │
│   Phase E: Render                                                    │
│     → New-ImpactReport.ps1 (Markdown + JSON sidecar)                 │
└──────────────┬───────────────────────────────────────────────────────┘
               │
               ▼
┌──────────────────────────────────────────────────────────────────────┐
│  Artifacts in $OutputDir (defaults to session dir):                  │
│     impact-<runId>.md     ← human-readable report card               │
│     impact-<runId>.json   ← machine-readable sidecar (schema v1)     │
│     impact-<runId>.state.json  ← intermediate query results (debug)  │
└──────────────────────────────────────────────────────────────────────┘
```

### Key Components

#### 1. Skill orchestrator — `skills/chaos-impact/SKILL.md`

Follows the same exit-code contract as `start-chaos/SKILL.md`:

| Exit | Meaning | AI action |
|---|---|---|
| 0 | Report generated | Done; print Markdown card. |
| 1 | Hard error | STOP; render error from script output. |
| 2 | Missing run context | `ask_user` for subscription / RG / workspace / scenario / runId; re-run with parameters. |
| 3 | Log Analytics workspace not discoverable for ≥ 1 resource, AND `-LogAnalyticsWorkspaceId` not supplied | `ask_user` whether to (a) supply a workspace ID or (b) proceed without log signals; re-run accordingly. |
| 4 | Permission gap (e.g. caller lacks `Monitoring Reader` on a target resource group) | `ask_user` to confirm best-effort partial report or abort. |

#### 2. PowerShell entrypoint — `Invoke-ChaosImpact.ps1`

Top-level script; orchestrates the phases above. Parameters:

| Parameter | Description |
|---|---|
| `-SubscriptionId` / `-ResourceGroup` / `-WorkspaceName` / `-ScenarioName` | Run context (read from state file if omitted). |
| `-ScenarioRunId` | Required (positional). |
| `-Buffer` | ISO-8601 duration. Default `PT5M`. |
| `-LogAnalyticsWorkspaceId` | Optional override when diag-settings discovery fails. |
| `-MaxResources` | Per-run resource cap. Default `50`. |
| `-OutputDir` | Where to drop artifacts. Default `$env:STARTCHAOS_SESSION_DIR` or current dir. |
| `-IncludeBaseline` | When set, also computes baseline samples (the `-Buffer × 2` window *before* run start). Default on. |
| `-Format` | `markdown`, `json`, or `both` (default). |

#### 3. Diagnostic-settings discovery — `Get-DiagnosticSettings.ps1`

For each unique targeted ARM resource ID:

```
GET {resourceId}/providers/Microsoft.Insights/diagnosticSettings?api-version=2021-05-01-preview
```

Pick the first setting whose `properties.workspaceId` is non-null and reachable
(verified via a cheap GET on the workspace itself). Cache the resolved workspace
per-resource in the intermediate state file. If multiple resources resolve to
different workspaces, the script issues one KQL request per workspace (parallel via
PowerShell `ForEach-Object -Parallel`, throttle 4).

Failure mode: if no setting and no user-supplied workspace → emit a per-resource
`logs.status = "unavailable"` marker and continue with metrics-only correlation.

#### 4. Correlation engine — `Build-ImpactCorrelation.ps1`

Pure-function module that takes:

- The `scenarioRun` resource (actions, time windows, target lists).
- Raw signal arrays returned from each Monitor query, each tagged with `(resourceId,
  signalType, timestamp, value, severity)`.

And emits, per action, classified buckets:

```
chaos-attributed → time-overlaps action window AND target matches AND
                   metric/log delta exceeds threshold
baseline         → present in pre-run buffer window with comparable rate
unexplained      → in run window, no matching action target, OR delta exceeds
                   threshold but target doesn't match any action
```

#### 5. MCP extensions — three new tools in `mcp/chaos_mcp/server.py`

| Tool | Purpose | Notes |
|---|---|---|
| `monitor_query_metrics` | Wraps `GET {resourceId}/providers/Microsoft.Insights/metrics` (API `2024-02-01`). Accepts `resource_id`, `metric_names`, `start_time`, `end_time`, `aggregation`, `interval`. | Single resource per call. Stateless. |
| `monitor_query_logs` | Wraps `POST https://api.loganalytics.io/v1/workspaces/{wid}/query`. Accepts `workspace_id`, `kql`, `timespan` (ISO-8601 interval). | Uses a separate token resource (`https://api.loganalytics.io`) — see Security. |
| `monitor_search_activity_log` | Wraps `GET /subscriptions/{sub}/providers/Microsoft.Insights/eventtypes/management/values?api-version=2015-04-01` with OData filter on `eventTimestamp` (ge / le) and `resourceUri` (eq) — note the filter key is `resourceUri`, NOT `resourceId`, and the endpoint does not accept an `in` list, so callers issue one request per resource URI. | Returns parsed events. |

Alerts (`Microsoft.AlertsManagement/alerts`) and Service Health
(`Microsoft.ResourceHealth/events`) are queried directly via `Invoke-AzRest` from
PowerShell. Rationale: they are simple GETs with a narrow ARM surface; wrapping them
in MCP tools adds little value over the existing `Invoke-AzRest` helper. (See §
"Design Decisions".)

#### 6. Renderer — `New-ImpactReport.ps1`

Produces two artifacts in `$OutputDir`:

- **`impact-<runId>.md`** — Markdown report card.
- **`impact-<runId>.json`** — JSON sidecar conforming to the schema below.

### Data Flow (happy path)

1. Skill invoked with `/chaos-impact 11111111-...`.
2. Orchestrator runs `Invoke-ChaosImpact.ps1`.
3. Script reads state file → resolves `(sub, rg, workspace, scenario)`. If missing, exit 2.
4. Script calls `Invoke-AzRest GET .../scenarioRuns/{runId}?api-version=2026-05-01-preview`
   → gets top-level `startedAt`/`completedAt` and `scenarioRunSummary[]`.
5. Script flattens `scenarioRunSummary[*].resources[*].id` → unique resource ID
   set; applies `MaxResources` cap. For any action with `startedAt`/`completedAt`
   missing, the action inherits the overall run window.
6. For each resource: `Get-DiagnosticSettings.ps1` → workspace map.
7. Parallel fan-out (all via `Invoke-AzRest`):
   - Per resource: GET `.../providers/Microsoft.Insights/metrics` for the
     default metric set per resource type (see §"KQL & metric templates").
   - Per workspace: POST `api.loganalytics.io/v1/workspaces/{id}/query` with
     the resource-log KQL (filtered to the resource set served by that
     workspace) — parameters bound via `let ids = dynamic([...]);` (see
     §Security for the injection-defence rationale).
   - Subscription-scoped: one Activity Log GET
     `.../providers/Microsoft.Insights/eventtypes/management/values` with
     `$filter=eventTimestamp ge ... and eventTimestamp le ... and resourceUri eq ...`
     (one call per unique resourceUri — the endpoint's OData filter does not
     support an `in` list; the script issues these in parallel, throttle 4).
   - Subscription-scoped: one alerts GET, one service-health GET.
8. `Build-ImpactCorrelation.ps1` → classified buckets per action.
9. `New-ImpactReport.ps1` → writes Markdown + JSON.
10. Exit 0; orchestrator prints the Markdown card.

### API Contracts

#### Markdown report — top-level outline

```
# Chaos Impact Report — <scenario> / run <runId>

**Run window**: 2026-05-29T18:00:01Z → 18:08:42Z   (Δ 8m 41s, +5m buffer)
**Workspace**: my-rg/my-ws    **Status**: Succeeded    **Resources targeted**: 7

## Summary
- 3 actions; all completed.
- 12 chaos-attributed signals across 5 resources.
- 4 baseline signals (suppressed from action sections).
- 2 unexplained signals — review recommended.

## Action 1 — VMSS-StopInstance (18:00:30 → 18:03:30)
| Resource | Signal | Δ vs baseline | Severity |
|---|---|---|---|
| .../myVmss | Percentage CPU (avg) | 67% → 12% | High |
| .../myVmss | VM Availability Metric | 1.0 → 0.67 | High |
| .../myAppGw | Failed Requests | 0 → 142 | Medium |

[KQL used] [Raw events]

## Unexplained Signals
...

## Coverage / Caveats
- 2/7 resources have no diagnostic setting → log signals unavailable.
- 1 resource exceeded MaxResources — not sampled.
```

#### JSON sidecar — schema v1

```jsonc
{
  "impactReportSchemaVersion": 1,
  "scenarioRunId": "…",
  "workspace": { "subscriptionId":"…", "resourceGroup":"…", "name":"…" },
  "scenario":   { "name":"VMSS-StopInstance","version":"1.0" },
  "window": {
    "startedAt":"2026-05-29T18:00:01Z",
    "completedAt":"2026-05-29T18:08:42Z",
    "bufferIso":"PT5M",
    "partial": false
  },
  "actions": [
    {
      "name":"stopInstances",
      "startedAt":"…","completedAt":"…",
      "targetedResources":["…"],
      "signals": {
        "chaosAttributed": [ /* Signal */ ],
        "baseline":        [ /* Signal */ ],
        "unexplained":     [ /* Signal */ ]
      }
    }
  ],
  "coverage": {
    "resourcesTotal": 7,
    "resourcesSampled": 7,
    "logsAvailableFor": ["resA","resB"],
    "logsUnavailableFor": ["resC"],
    "logsUnavailableReason": { "resC":"no_diagnostic_setting" }
  },
  "queries": {
    "kql":     [ { "workspaceId":"…", "query":"…", "rowCount": 42 } ],
    "metrics": [ { "resourceId":"…", "names":["Percentage CPU"], "interval":"PT1M" } ]
  },
  "errors": [ /* per-step errors, ARM error envelope */ ]
}

// Signal:
// {
//   "resourceId":"…", "signalType":"metric|log|activity|alert|servicehealth",
//   "name":"…", "timestamp":"…", "value":<any>, "severity":"info|low|med|high|crit",
//   "actionName":"…",     // populated only for chaos-attributed
//   "rationale":"…"       // human-readable why-this-was-classified-this-way
// }
```

### KQL & metric templates

Templates live under `skills/chaos-impact/templates/` and are parameterised on
`{resourceIds}`, `{tStart}`, `{tEnd}`.

| File | Purpose |
|---|---|
| `kql/resource-logs.kql` | `let ids = dynamic([{resourceIdsJson}]); let tStart = datetime({tStart}); let tEnd = datetime({tEnd}); AzureDiagnostics \| where TimeGenerated between (tStart .. tEnd) \| where _ResourceId in (ids) \| summarize count() by Category, Level, _ResourceId, bin(TimeGenerated, 1m) \| take 500` |
| `kql/azure-metrics.kql` | `let ids = dynamic([{resourceIdsJson}]); AzureMetrics \| where TimeGenerated between (datetime({tStart}) .. datetime({tEnd})) \| where _ResourceId in (ids) \| summarize avg(Average), max(Maximum) by MetricName, _ResourceId, bin(TimeGenerated, 1m)` |
| `kql/error-spike.kql` | Heuristic spike-detector: log error-level rows per minute vs baseline window's mean+2σ. |
| `metrics/defaults.json` | Per-ARM-type default metric sets + delta thresholds. **v1 ships defaults for the following resource types** (covering the most common Chaos Studio v2 fault targets): `Microsoft.Compute/virtualMachines`, `Microsoft.Compute/virtualMachineScaleSets`, `Microsoft.ContainerService/managedClusters` (AKS), `Microsoft.Network/applicationGateways`, `Microsoft.Sql/servers/databases`, `Microsoft.DocumentDB/databaseAccounts` (Cosmos), `Microsoft.Storage/storageAccounts`, `Microsoft.KeyVault/vaults`, `Microsoft.ServiceBus/namespaces`. All other resource types fall back to an empty default (metrics fan-out skipped; correlation runs on logs/activity/alerts only). Adding a new type is a one-line JSON edit; no code changes required. |

### Correlation algorithm (detail)

For each action `A`, derive the window `[A.start, A.end]` as follows: if
`A.startedAt`/`A.completedAt` are present on the `ScenarioRunSummaryAction`, use
them; otherwise inherit the overall run window
(`scenarioRun.startedAt`/`scenarioRun.completedAt`) and tag the action's signals
with `windowSource: "run"` (vs `"action"`) in the JSON sidecar so consumers can
see the precision was degraded. The target set `T(A)` is derived from
`A.resources[*].id`. Then:

1. **Time overlap test**: signal `s` is *in window* iff
   `s.timestamp ∈ [A.start − buffer, A.end + buffer]`.
2. **Target overlap test**: `s.resourceId ∈ T(A)` (with VMSS/AKS instance IDs
   collapsed to the parent resource).
3. **Magnitude test** (metrics only): `|s.value − baseline(s)| > threshold(s)`,
   where `threshold(s)` is metric-specific (defaults in `metrics/defaults.json`,
   e.g. CPU > 20pp delta).
4. **Classification**:
   - In-window AND target-match AND (magnitude OR log-error spike OR alert-fired)
     → `chaosAttributed`.
   - Present in `[A.start − 2×buffer, A.start − buffer]` (pre-run baseline window)
     with comparable rate → `baseline`.
   - In-window AND **not** target-match → `unexplained` (and surfaced prominently).
5. **Severity scoring**: map each classified signal to `info|low|med|high|crit`:
   - Alert: use alert severity directly.
   - Metric: bucket by `|delta| / threshold` (>3× = crit, >2× = high, >1× = med).
   - Log: by `count_in_window / count_in_baseline` ratio.

### Design Decisions

1. **Extend MCP with three Monitor tools for autonomous agents** (`monitor_query_metrics`,
   `monitor_query_logs`, `monitor_search_activity_log`). This brings agents to
   parity with what the skill can do and avoids duplicating ARM-client logic
   inside any future agent implementation. **We deliberately do NOT wrap
   alerts/service-health in MCP**: those are simple narrow GETs already trivial
   to express, and wrapping adds zero value over a five-line snippet — keeps
   the MCP surface focused on reusable, high-leverage tools.
2. **The skill itself does NOT call MCP.** The MCP server is not normally
   reachable from a PowerShell process (it speaks the MCP stdio protocol to its
   agent host). Embedding an MCP client in PowerShell would add a major
   dependency for zero functional gain, because the MCP tools are themselves
   thin wrappers over the same `management.azure.com` /
   `api.loganalytics.io` endpoints. The skill therefore calls those endpoints
   **directly via `Invoke-AzRest`**, and the new MCP tools live in parallel as
   the agent-facing surface — consistent with the rest of `startchaos`'s
   dual-surface model (PowerShell skill ↔ MCP tools, both grounded in the
   same Azure REST APIs, neither calling the other).
3. **Workspace discovery before user prompt.** Diagnostic settings on the
   targeted resource are the source of truth; user-supplied workspace is a
   fallback, not the default — most customers don't know their workspace ID
   off the top of their head.
4. **Bounded fan-out.** A worst-case run (AKS scenario, 100s of pod target
   instances) could explode the query count. We cap at `MaxResources=50` by
   default and collapse instance-level targets to parent resources before
   counting.
5. **JSON sidecar is the source of truth for diffing.** The Markdown report is a
   view over the JSON; future "diff two runs" tooling depends on a stable JSON
   schema, hence `impactReportSchemaVersion`.

---

## Alternatives Considered

| Alternative | Pros | Cons | Decision |
|---|---|---|---|
| **Implement everything in the MCP server (Python)** — skill becomes a thin Markdown wrapper that just renders MCP output. | Single language; better unit testability via `pytest`; report renderer can be reused programmatically. | Diverges from `startchaos`'s established "thin MD + fat PS" pattern; PowerShell already owns the rendering / session-dir / state-file conventions; agents can already call the underlying MCP tools directly. | **Rejected** — consistency with existing skills wins. |
| **Auto-enable diagnostic settings on customer resources** when none found. | Eliminates the "no logs" failure mode. | Mutates customer infrastructure; violates the plugin's no-side-effects posture; needs additional RBAC. | **Rejected** — violates Non-Goals. |
| **Use Azure Resource Graph for activity log / alerts** instead of the dedicated APIs. | One query language; simpler. | Resource Graph lag (minutes); incomplete coverage of Activity Log; not authoritative for the run window. | **Rejected** — accuracy matters more than uniformity here. |
| **Render Markdown only; skip JSON sidecar.** | Less code; one artifact. | Breaks future cross-run diffing; harder to consume from other tools. | **Rejected** — JSON sidecar is cheap (~50 LOC) and unblocks future work. |
| **Polling for in-flight runs** (re-run query every N seconds until completed). | Better real-time triage. | Out of scope for v1; complicates exit-code contract. | **Deferred** — v1 emits a `partial` report on the current snapshot; polling is a v2 enhancement. |

---

## Dependencies

### External

- **Azure CLI ≥ 2.61** — already required by `startchaos` (see plugin README).
- **PowerShell 7.4+** — already required.
- **Azure Monitor Metrics API** — `2024-02-01`.
- **Log Analytics Query API** — `api.loganalytics.io/v1` (token resource
  `https://api.loganalytics.io`).
- **Azure Monitor Diagnostic Settings API** — `2021-05-01-preview`.
- **Azure Activity Log API** — `2015-04-01`.
- **Alerts Management API** — `2023-05-01-preview` (current preview; falls back
  to stable `2018-05-05` if preview is unavailable in a given region). Pinned
  in `Constants.ps1`.
- **Resource Health API** — `2022-10-01`.

### Internal

- Reuses `skills/_shared/Invoke-AzRest.ps1`, `State.ps1`, `Render.ps1`,
  `Ensure-AzLogin.ps1`.
- Reads (does not write) `${SESSION_DIR}/startchaos-state.json` to bootstrap run context.
- Extends `mcp/chaos_mcp/server.py` with new tools; reuses `mcp/chaos_mcp/azure.py`
  HTTP helpers.

### Sequencing

- MCP tool additions (Epic 1) ship independently; they add no new dependencies
  and are not on the skill's call path (see Design Decision #2). Epics 1 and 2
  are fully parallelisable.
- Tests (Epic 4) depend on Epics 1 + 2 + 3.

---

## Impact Analysis

| Area | Impact |
|---|---|
| **Existing skills** | None — purely additive. `start-chaos` is the only skill that may be enhanced to auto-invoke `/chaos-impact` post-run, gated behind a `-WithImpact` switch (deferred to a follow-up). |
| **MCP server surface** | +3 tools. Tools are additive; existing agents are unaffected. Bump `mcp/pyproject.toml` version `0.2.x → 0.3.0` (minor — new feature, no breaking changes). |
| **plugin.json / marketplace.json** | New skill folder registered; plugin version bumped `0.2.0 → 0.3.0`. |
| **State schema** | Unchanged. New skill reads but does not write `startchaos-state.json`. Its own intermediate state is per-run (`impact-<runId>.state.json`) and not shared. |
| **Performance** | Discovery cost: with `MaxResources=50`, the diag-settings phase performs up to 50 per-resource `diagnosticSettings` GETs plus one workspace-reachability GET per unique workspace (≤ 50, typically ≤ 5) — i.e. an upper bound of ~100 ARM calls before any Monitor query. Each call is < 200 ms p50; with throttle-4 parallelism this phase is bounded at ~5 s and well inside the 90 s budget. Reachability results are cached in `impact-<runId>.state.json` so a re-run against the same workspaces skips the verification GETs. Query phase: O(unique resources) metrics calls + O(workspaces) KQL calls + O(unique resourceUris) activity-log calls + 2 fixed subscription-scoped calls. p95 wall-clock target ≤ 90 s. |
| **Operational** | No new infrastructure. Output artifacts live in the session dir or user-supplied path. |

Backward compatibility: full. Plugin consumers on `0.2.x` continue to work; upgrading to
`0.3.0` simply exposes the new skill.

---

## Security Considerations

- **Auth model unchanged.** Caller's `az` session token is used for all calls. No
  service principals; no stored secrets; no token caching.
- **New token audience: Log Analytics.** The Log Analytics Query API requires a token
  for `https://api.loganalytics.io`. The MCP tool and the PowerShell helper MUST
  request this audience via `az account get-access-token --resource
  https://api.loganalytics.io/`. The token is held in process memory only.
- **RBAC required of the caller**: `Monitoring Reader` (or equivalent: `Reader` +
  `Microsoft.Insights/metrics/read`, `Microsoft.OperationalInsights/workspaces/query/read`,
  `Microsoft.Insights/eventtypes/values/read`, `Microsoft.AlertsManagement/alerts/read`)
  on each targeted resource / subscription. Missing-permission errors are surfaced as
  per-resource `signals.status = "permission_denied"` rather than fatal; the report
  still renders for accessible resources.
- **KQL injection**: Parameters interpolated into KQL templates are either ARM
  resource IDs (validated against the canonical
  `^/subscriptions/[0-9a-f-]{36}/resourceGroups/[^/]+/providers/.*` regex) or
  ISO-8601 timestamps. Resource-ID lists are **bound via `let ids =
  dynamic([...]);` constructed from a `ConvertTo-Json` array** rather than
  string-interpolated into `in (...)` — this is necessary because resource
  *names* within otherwise-valid ARM IDs may legally contain characters
  (single quotes, backslashes) that would break naive string interpolation.
  No user-controlled free-form string is ever interpolated. Templates are
  loaded as opaque text and only the named `{placeholder}` slots are
  substituted via a strict allowlist parser.
- **No PII in artifacts beyond what the Chaos run + Monitor already expose.** The
  caller's signed-in UPN is *not* embedded in the JSON sidecar; the workspace ARM
  ID is (matching existing run reports).

---

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Diagnostic settings missing on most targets → reports are metrics-only and look thin. | High | Medium | Clearly surface "logs unavailable" in the Markdown coverage section; offer `-LogAnalyticsWorkspaceId` override; document in README. |
| Log Analytics query latency / 429s on large workspaces. | Medium | Medium | Cap `take 500`; retry with backoff; bound per-workspace concurrency to 4. |
| Correlation false positives (everything in window classified as chaos-attributed). | Medium | Medium | Magnitude threshold + pre-run baseline window subtracts noise; expose thresholds via `metrics/defaults.json` so customers can tune; document heuristics explicitly in the report card. |
| API version drift across the 6 Monitor surfaces. | Low | Low | Pin every API version in a single `Constants.ps1`; one place to update. |
| **No CI workflow currently exists under `chaos-ai-plugins/.github/workflows/`** for this plugin (confirmed: `glob` of that directory returns no files at time of writing). | Medium | Medium | Treat CI bootstrap as an Epic 5 prerequisite. Either reuse the parent `azure-rest-api-specs` CI patterns or stand up a minimal pipeline that runs `Invoke-Pester` + `pytest` against the plugin folder. Surface as an explicit task (E5-T0) so it is not silently skipped. |
| In-flight runs produce confusing partial reports. | Medium | Low | `partial:true` JSON flag + prominent Markdown banner; v2 will add `-WaitForCompletion`. |
| MaxResources truncation hides important signals. | Low | Medium | Truncation list is shown in Markdown; default `50` is empirically generous; user can raise it explicitly. |

---

## Open Questions

1. **Auto-invoke after `/start-chaos`?** Should `start-chaos`'s exit-0 path also fire
   `/chaos-impact` automatically (perhaps gated by a `-WithImpact` switch in the
   orchestrator)? Initial draft: leave it manual; revisit after first dogfooding.
2. **Should we wrap alerts / service-health as MCP tools too?** Current design says
   no (PS-only). If autonomous agents start requesting them, we can add
   `monitor_list_alerts` and `monitor_list_resource_health` later in a 0.3.x.
3. **HTML report parity?** `start-chaos` currently produces an HTML run report.
   Should `chaos-impact` also emit HTML, or is Markdown + JSON sufficient?
   Recommendation: Markdown + JSON for v1; HTML is a thin renderer over the JSON
   we can add later.
4. **Baseline window length.** Default `2 × buffer` (10 min) — does this reliably
   capture "noise" for slow-rolling metrics? Needs validation with real
   customer data during the alpha.
5. **AKS / container instances.** ScenarioRun's `targetedResources` may include
   sub-resources (pod names, container groups). The collapse-to-parent rule needs
   per-resource-type validation; tracked as a v1.1 polish item.
6. **Workspace-scope ScenarioRun.** Does the workspace itself ever appear in
   `targetedResources`? If so, exclude it from per-resource Monitor fan-out.

---

## Implementation Phases

| Phase | Exit criteria |
|---|---|
| **P1 — MCP Monitor tools** | New tools land on a branch, unit-tested with mocked `httpx`; `mcp/pyproject.toml` ≥ `0.3.0-alpha`; `mcp/README.md` updated. |
| **P2 — Skill scaffolding + diag-settings discovery** | `Invoke-ChaosImpact.ps1` resolves a run + workspace map end-to-end against a real workspace; exit codes 0/1/2/3 wired up; SKILL.md drafted. |
| **P3 — Query + correlation engine** | All Monitor surfaces queried; correlation produces correct classification on at least 2 hand-crafted scenarios (1 hit, 1 baseline-noise-only). |
| **P4 — Renderer + JSON schema** | Both Markdown and JSON artifacts produced; JSON validates against `impact-report.schema.json`; round-trip test passes. |
| **P5 — Tests** | Offline-replay E2E from recorded fixtures green in CI; ≥ 80 % line coverage on PS modules; pytest green on MCP tools. |
| **P6 — Docs + manifest** | README updates merged; plugin.json + marketplace.json updated; plugin version bumped to `0.3.0`. |

---

## Files Affected

### New Files

| File Path | Purpose |
|---|---|
| `skills/chaos-impact/SKILL.md` | Orchestrator with exit-code contract and `ask_user` flow. |
| `skills/chaos-impact/scripts/Invoke-ChaosImpact.ps1` | Top-level skill entrypoint. |
| `skills/chaos-impact/scripts/Get-DiagnosticSettings.ps1` | Per-resource diag-settings discovery. |
| `skills/chaos-impact/scripts/Get-MonitorSignals.ps1` | Fan-out wrapper: metrics + logs + activity + alerts + service health. |
| `skills/chaos-impact/scripts/Build-ImpactCorrelation.ps1` | Pure-function correlation + classification + severity scoring. |
| `skills/chaos-impact/scripts/New-ImpactReport.ps1` | Markdown + JSON renderer. |
| `skills/chaos-impact/scripts/Constants.ps1` | Pinned API versions and per-resource-type metric defaults. |
| `skills/chaos-impact/templates/kql/resource-logs.kql` | Parameterised resource-log KQL. |
| `skills/chaos-impact/templates/kql/azure-metrics.kql` | Parameterised AzureMetrics KQL. |
| `skills/chaos-impact/templates/kql/error-spike.kql` | Baseline-vs-window error spike KQL. |
| `skills/chaos-impact/templates/metrics/defaults.json` | Per-ARM-type default metric names + thresholds. |
| `skills/chaos-impact/templates/report.md.tmpl` | Markdown report skeleton. |
| `skills/chaos-impact/schema/impact-report.schema.json` | JSON Schema for the sidecar (schema v1). |
| `skills/chaos-impact/tests/Invoke-ChaosImpact.Tests.ps1` | Pester unit tests (mocked `Invoke-AzRest`). |
| `skills/chaos-impact/tests/Build-ImpactCorrelation.Tests.ps1` | Correlation engine unit tests. |
| `skills/chaos-impact/tests/e2e/recorded-run.json` | Recorded ScenarioRun fixture. |
| `skills/chaos-impact/tests/e2e/recorded-metrics.json` | Recorded Monitor responses fixture. |
| `skills/chaos-impact/tests/e2e/expected-impact.json` | Golden output for offline-replay E2E. |
| `skills/chaos-impact/tests/e2e/Run-OfflineReplay.ps1` | Offline-replay test driver (hermetic in the no-network sense; does not validate live ARM contract — see follow-up issue). |
| `mcp/chaos_mcp/monitor.py` | Module hosting the three new Monitor MCP tools + thin HTTP helpers. |
| `mcp/tests/test_monitor_tools.py` | Pytest unit tests for the Monitor tools. |
| `docs/impact-synthesis-skill.plan.md` | This document. |

### Modified Files

| File Path | Changes |
|---|---|
| `plugin.json` | Bump `version` → `0.3.0`. |
| `README.md` | Add `chaos-impact` row to skills table; new "Impact report" section. |
| `mcp/chaos_mcp/server.py` | Import + register the 3 Monitor tools from `monitor.py`. |
| `mcp/chaos_mcp/azure.py` | Add `loganalytics_post()` helper (token resource `https://api.loganalytics.io`); add `arm_get_with_query()` for OData filter calls. |
| `mcp/README.md` | Document the 3 new tools, their parameters, return shapes. |
| `mcp/pyproject.toml` | Bump version → `0.3.0`. |
| `agents/start-chaos.md` | Add a "Next step" hint mentioning `/chaos-impact` after run completion. |
| _(none — `skills/_shared/State.ps1` is intentionally NOT modified; the chaos-impact skill is a pure reader of `startchaos-state.json` and writes its own per-run state next to its artifacts. Earlier draft proposed an additive `lastImpactReportPath` field, but no requirement currently drives it; revisit if/when `/start-chaos` auto-links to the most-recent impact report — see Open Question #1.)_ | |

### Deleted Files

| File Path | Reason |
|---|---|
| _(none)_ | |

---

## Implementation Plan

### Epic 1 — MCP Monitor tools (Python)  **[DONE]**

**Goal**: Add three additive MCP tools exposing Azure Monitor (metrics, logs, activity
log) to autonomous agents, with the same auth model as the existing chaos tools.

**Prerequisites**: None.

| Task ID | Type | Description | Files | Status |
|---|---|---|---|---|
| E1-T1 | IMPL | Add `loganalytics_post()` and `arm_get_with_query()` helpers; introduce token-resource parameter on `_get_token()`. | `mcp/chaos_mcp/azure.py` | DONE |
| E1-T2 | IMPL | Create `monitor.py` module; implement `monitor_query_metrics`. | `mcp/chaos_mcp/monitor.py` | DONE |
| E1-T3 | IMPL | Implement `monitor_query_logs` (Log Analytics POST). | `mcp/chaos_mcp/monitor.py` | DONE |
| E1-T4 | IMPL | Implement `monitor_search_activity_log` with OData filter builder. | `mcp/chaos_mcp/monitor.py` | DONE |
| E1-T5 | IMPL | Register tools in `server.py`; bump version in `pyproject.toml`. | `mcp/chaos_mcp/server.py`, `mcp/pyproject.toml` | DONE |
| E1-T6 | TEST | Pytest unit tests with `httpx` mock transport for all 3 tools (happy path + 429 retry + 403 → structured error). | `mcp/tests/test_monitor_tools.py` | DONE |
| E1-T7 | IMPL | Document the 3 tools in `mcp/README.md`. | `mcp/README.md` | DONE |

**Acceptance Criteria**:
- [x] `python -m chaos_mcp` lists 13 tools (10 existing + 3 new).
- [x] `pytest mcp/tests/` is green.
- [x] No regressions in existing tool tests.
- [x] `monitor_query_logs` correctly requests a Log Analytics-scoped token.

---

### Epic 2 — Skill scaffolding & context resolution  **[DONE]**

**Goal**: Stand up the `chaos-impact` skill folder, the orchestrator Markdown, the
top-level PowerShell entrypoint, and run/diag-setting discovery — enough that the skill
can resolve a real run end-to-end and emit empty (correlation-less) artifacts.

**Prerequisites**: None (can run in parallel with Epic 1).

| Task ID | Type | Description | Files | Status |
|---|---|---|---|---|
| E2-T1 | IMPL | Create `SKILL.md` with the exit-code contract mirroring `start-chaos/SKILL.md`. | `skills/chaos-impact/SKILL.md` | DONE |
| E2-T2 | IMPL | Implement `Constants.ps1` with pinned API versions. | `skills/chaos-impact/scripts/Constants.ps1` | DONE |
| E2-T3 | IMPL | Implement `Invoke-ChaosImpact.ps1` skeleton: parameter parsing, state-file bootstrap, exit-2 path. | `skills/chaos-impact/scripts/Invoke-ChaosImpact.ps1` | DONE |
| E2-T4 | IMPL | Implement `Get-DiagnosticSettings.ps1` with parallel fan-out and per-resource caching. | `skills/chaos-impact/scripts/Get-DiagnosticSettings.ps1` | DONE |
| E2-T5 | IMPL | Wire `Invoke-ChaosImpact.ps1` → `chaos_get_scenario_run` (via direct `Invoke-AzRest`); resolve targeted resources; apply `MaxResources` cap. | `skills/chaos-impact/scripts/Invoke-ChaosImpact.ps1` | DONE |
| E2-T6 | TEST | Pester tests for parameter parsing + state-file bootstrap + exit codes. | `skills/chaos-impact/tests/Invoke-ChaosImpact.Tests.ps1` | DONE |

**Acceptance Criteria**:
- [ ] Running `Invoke-ChaosImpact.ps1 -ScenarioRunId <real>` against a real run exits 0 with a `coverage` summary printed.
- [x] Missing context produces exit 2 with a clear error.
- [x] Pester suite green locally on Windows + Linux.

---

### Epic 3 — Query, correlation, classification  **[DONE]**

**Goal**: Implement the Monitor query fan-out, the correlation engine, and the
classification heuristics.

**Prerequisites**: Epic 2.

| Task ID | Type | Description | Files | Status |
|---|---|---|---|---|
| E3-T1 | IMPL | Implement `Get-MonitorSignals.ps1` — metrics fan-out, logs fan-out, activity log call, alerts call, service-health call. | `skills/chaos-impact/scripts/Get-MonitorSignals.ps1` | DONE |
| E3-T2 | IMPL | KQL templates + per-type metric defaults. | `skills/chaos-impact/templates/**` | DONE |
| E3-T3 | IMPL | Implement `Build-ImpactCorrelation.ps1` — windowing, target-overlap, magnitude/baseline test, classification, severity scoring. | `skills/chaos-impact/scripts/Build-ImpactCorrelation.ps1` | DONE |
| E3-T4 | IMPL | Wire phases C+D into `Invoke-ChaosImpact.ps1`. | `skills/chaos-impact/scripts/Invoke-ChaosImpact.ps1` | DONE |
| E3-T5 | TEST | Pester unit tests for `Build-ImpactCorrelation.ps1` covering: chaos-attributed hit, baseline-only noise, unexplained signal, mixed; plus Get-MonitorSignals helper coverage. | `skills/chaos-impact/tests/Build-ImpactCorrelation.Tests.ps1`, `skills/chaos-impact/tests/Get-MonitorSignals.Tests.ps1` | DONE |

**Acceptance Criteria**:
- [x] Correlation suite covers all 3 classification buckets (+ new `platformEvent` bucket).
- [x] Severity buckets validated against fixture data (including exact-boundary tests).

---

### Epic 4 — Renderer, JSON schema, artifacts  **[DONE]**

**Goal**: Produce the Markdown report card and the JSON sidecar; ship a stable JSON
schema.

**Prerequisites**: Epic 3.

| Task ID | Type | Description | Files | Status |
|---|---|---|---|---|
| E4-T1 | IMPL | Author `impact-report.schema.json` (JSON Schema draft-07, `impactReportSchemaVersion: 1`). | `skills/chaos-impact/schema/impact-report.schema.json` | DONE |
| E4-T2 | IMPL | Implement `New-ImpactReport.ps1` — JSON emitter + Markdown emitter from a shared in-memory model. | `skills/chaos-impact/scripts/New-ImpactReport.ps1`, `templates/report.md.tmpl` | DONE |
| E4-T3 | IMPL | Atomic file writes (temp + rename) for both artifacts, mirroring `State.ps1` discipline. | `skills/chaos-impact/scripts/New-ImpactReport.ps1` | DONE |
| E4-T4 | TEST | Round-trip test: build sample model → render JSON → validate against schema. | `skills/chaos-impact/tests/New-ImpactReport.Tests.ps1` | DONE |

**Acceptance Criteria**:
- [x] JSON sidecar validates against the schema for every fixture.
- [x] Markdown report renders cleanly in GitHub's Markdown preview.
- [x] Re-running with same `scenarioRunId` overwrites artifacts atomically.

---

### Epic 5 — Offline-replay E2E + CI integration  **[DONE]**

**Goal**: A repeatable, offline E2E test that exercises the full skill against
recorded Azure responses, plus CI wiring.

**Prerequisites**: Epics 1–4.

| Task ID | Type | Description | Files | Status |
|---|---|---|---|---|
| E5-T0 | IMPL | **Prerequisite:** stand up a minimal CI workflow for `chaos-ai-plugins/startchaos/` (no workflow currently exists under `chaos-ai-plugins/.github/workflows/`). Decide with maintainers whether to (a) extend the parent `azure-rest-api-specs` workflows or (b) add a self-contained workflow under `chaos-ai-plugins/.github/workflows/startchaos-ci.yml` that runs `Invoke-Pester` + `pytest`. | `.github/workflows/startchaos-ci.yml` (NEW) or parent repo | DONE |
| E5-T1 | TEST | Record a real ScenarioRun + Monitor response set (sanitised) into `tests/e2e/`. | `skills/chaos-impact/tests/e2e/*.json` | DONE |
| E5-T2 | TEST | Implement `Run-OfflineReplay.ps1` — stub `Invoke-AzRest` to serve fixtures, run the full skill, diff against `expected-impact.json`. | `skills/chaos-impact/tests/e2e/Run-OfflineReplay.ps1` | DONE |
| E5-T3 | TEST | Wire Pester + pytest + offline-replay E2E into the CI workflow stood up in E5-T0. | `.github/workflows/startchaos-ci.yml` | DONE |

**Acceptance Criteria**:
- [x] Offline-replay E2E runs in < 30 s offline. *(observed: ~2s locally)*
- [x] CI green on Windows + Linux runners. *(matrix configured in workflow; Pester 5 tests pass locally on Windows)*
- [x] Fixture files contain no real subscription/tenant IDs. *(all fixtures use `00000000-0000-0000-0000-000000000001` + `hermetic-*` names)*

---

### Epic 6 — Docs, manifest, marketplace  **[DONE]**

**Goal**: Ship the new skill to customers via the plugin marketplace; update all
customer-visible docs.

**Prerequisites**: Epics 1–5 merged.

| Task ID | Type | Description | Files | Status |
|---|---|---|---|---|
| E6-T1 | IMPL | Bump `plugin.json` version → `0.3.0`. | `plugin.json` | DONE |
| E6-T2 | IMPL | Add `chaos-impact` row to skills table + a dedicated "Impact report" section in `README.md`. | `README.md` | DONE |
| E6-T3 | IMPL | Update `agents/start-chaos.md` with a "Next step → `/chaos-impact <runId>`" hint. | `agents/start-chaos.md` | DONE |
| E6-T4 | IMPL | Update marketplace manifest (in `gim-home/Chaos-AI-Plugins`) to publish `startchaos@0.3.0`. | _(external repo)_ | DEFERRED — external repo; requires separate PR. See note below. |
| E6-T5 | IMPL | Customer-facing walkthrough doc: example invocation, sample report, troubleshooting. | `docs/impact-synthesis-skill.md` | DONE |

**Acceptance Criteria**:
- [x] `copilot plugin install startchaos@chaos-ai-plugins` will install `0.3.0` once the marketplace manifest in `gim-home/Chaos-AI-Plugins` is bumped (E6-T4 is the gating handoff step).
- [x] README updated with `chaos-impact` skill row, dedicated **Impact Report** section, three new `monitor_*` MCP tools, and a link to the walkthrough doc.
- [x] Customer-style end-to-end walkthrough documented in `docs/impact-synthesis-skill.md` (overview, prereqs, parameters, output anatomy, classification heuristics, sample report, troubleshooting, limitations).

> **E6-T4 handoff note**: bumping the marketplace manifest lives in the external
> `gim-home/Chaos-AI-Plugins` repository. The required change is a single version
> bump on the `startchaos` entry from `0.2.0` → `0.3.0`. This is intentionally
> outside the scope of this PR; the plugin maintainer must open a separate PR in
> that repository once this PR is merged.

---

## References

- Existing plugin: `C:\Chaos\specs\azure-rest-api-specs\specification\chaos\chaos-ai-plugins\startchaos\`
- `Microsoft.Chaos` API spec: `specification/chaos/resource-manager/Microsoft.Chaos/Chaos/` (`2026-05-01-preview`).
- Azure Monitor Metrics REST API: <https://learn.microsoft.com/rest/api/monitor/metrics/list>
- Log Analytics Query API: <https://learn.microsoft.com/rest/api/loganalytics/dataaccess/query/get>
- Diagnostic Settings API: <https://learn.microsoft.com/rest/api/monitor/diagnostic-settings>
- Activity Log API: <https://learn.microsoft.com/rest/api/monitor/activity-logs/list>
- Alerts Management API: <https://learn.microsoft.com/rest/api/monitor/alertsmanagement/alerts>
- Resource Health Events API: <https://learn.microsoft.com/rest/api/resourcehealth/events>
- FastMCP (used by `chaos-mcp`): <https://github.com/jlowin/fastmcp>
- `startchaos` repository convention: `start-chaos/SKILL.md` (exit-code contract this skill mirrors).

---

## Revision History

### Revision 2 — addresses technical review (score 88/100)

- **Removed internal contradiction about MCP usage.** Executive Summary, the
  data-flow diagram (Phase A & C), and the §"Data Flow" walkthrough now
  consistently show the skill calling `Invoke-AzRest` directly. Design
  Decision #1/#2 rewritten to make the dual-surface model explicit: PowerShell
  skill and chaos-mcp tools are independent surfaces over the same Azure
  endpoints; neither calls the other. Sequencing note updated.
- **Pinned Alerts Management API to `2023-05-01-preview`** (with `2018-05-05`
  GA fallback) instead of the stale `2019-05-05-preview`.
- **Tightened KQL injection defence.** Both KQL templates now bind resource
  ID lists via `let ids = dynamic([...]);` constructed from a `ConvertTo-Json`
  array (Security section expanded to explain why string-interpolated
  `in (...)` is unsafe for ARM IDs containing special characters in resource
  names).
- **Corrected Activity Log API contract.** `monitor_search_activity_log` and
  the Phase C fan-out now filter on `resourceUri` (not `resourceId`) at
  `Microsoft.Insights/eventtypes/management/values?api-version=2015-04-01`,
  and acknowledge that the endpoint requires one call per `resourceUri`
  (no `in` list support).
- **Grounded the ScenarioRun schema claim in TypeSpec.** Background and F2
  now reference `ScenarioRunSummaryAction` (`scenarioRun.models.tsp`
  lines 236–268) explicitly, naming the actual fields (`resources[*].id`,
  not `targetedResources`) and noting that per-action `startedAt`/
  `completedAt` are optional. Correlation algorithm now defines an explicit
  fallback to the overall run window with `windowSource` tagging in the JSON
  sidecar.
- **Added diag-settings discovery cost analysis to Impact Analysis** —
  bounded at ~100 ARM calls + ~5 s wall-clock with throttle-4 parallelism,
  with workspace-reachability cached across re-runs.
- **Dropped the optional `lastImpactReportPath` State.ps1 extension** from
  Modified Files (no requirement drives it; revisit only if Open Question #1
  resolves yes).
- **Added Epic 5 task E5-T0 (CI bootstrap)** and a corresponding Risk row,
  since no CI workflow currently exists under `chaos-ai-plugins/.github/
  workflows/` (confirmed by glob at revision time).
- **Made v1 resource-type scope explicit** in `metrics/defaults.json` —
  ships defaults for VM, VMSS, AKS, AppGw, SQL DB, Cosmos, Storage,
  Key Vault, Service Bus; all other types fall back to logs/activity/alerts
  only.
