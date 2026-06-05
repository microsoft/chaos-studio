# `/chaos-impact` — Walkthrough & Reference

> Customer-facing guide for the `chaos-impact` skill shipped in `startchaos@0.3.0`.
> For the design rationale and implementation plan see [`impact-synthesis-skill.plan.md`](impact-synthesis-skill.plan.md).

## Overview

`/chaos-impact` is a post-experiment analysis skill. Given a Chaos Studio v2
`scenarioRunId`, it queries Azure Monitor over the run window plus a configurable
buffer, correlates each observed signal to the action that may have caused it, and
emits a Markdown report card plus a schema-validated JSON sidecar suitable for
diffing across runs.

## Prerequisites

Same as the rest of the `startchaos` plugin:

| Requirement | Minimum Version | Notes |
|---|---|---|
| PowerShell (`pwsh`) | 7.4+ | Cross-platform |
| Azure CLI (`az`) | 2.61+ | Already signed in (`az login`) |
| GitHub Copilot CLI | latest | `startchaos@0.3.0` installed |

The caller's `az` identity must have **at least** `Reader` on each targeted resource
group plus `Monitoring Reader` on the subscription (or per-resource-group). Without
`Monitoring Reader` the skill exits with code **4**.

## Quick start (inside a `/start-chaos` session)

After Phase 3 of `/start-chaos` finishes, the run ID is already in the state file at
`${SESSION_DIR}/startchaos-state.json` (key `run.scenarioRunId`). You can invoke the
impact skill without re-supplying any context:

```text
> /chaos-impact
```

The skill reads the state file, picks up subscription / resource group / workspace
/ scenario / run ID, runs the full pipeline, and writes the report artifacts to the
session directory.

## Standalone invocation

When you don't have a state file (e.g. analyzing someone else's run), pass all five
context parameters explicitly:

```text
> /chaos-impact run-2026-05-01-001 \
    -SubscriptionId 00000000-0000-0000-0000-000000000001 \
    -ResourceGroup  chaos-rg \
    -WorkspaceName  chaos-ws \
    -ScenarioName   stop-vmss
```

## Parameters

| Parameter | Default | Description |
|---|---|---|
| `<ScenarioRunId>` *(positional)* | *(required)* | The chaos run to analyze |
| `-SubscriptionId` | from state file | Subscription containing the workspace |
| `-ResourceGroup` | from state file | Resource group containing the workspace |
| `-WorkspaceName` | from state file | Chaos Studio v2 workspace name |
| `-ScenarioName` | from state file | Scenario the run belongs to |
| `-Buffer` | `PT5M` | ISO-8601 duration expanding both ends of the window |
| `-MaxResources` | `50` | Per-run resource fan-out cap (cap prevents accidental N×Monitor calls) |
| `-LogAnalyticsWorkspaceId` | *(auto-discovered)* | Override when diag-settings discovery fails; pass `none` to skip the logs path entirely |
| `-OutputDir` | session dir | Where to write `impact-<runId>.md` / `.json` |
| `-Format` | `both` | `markdown`, `json`, or `both` |
| `-AllowPartial` | off | Continue and emit a partial report even if some resources hit errors |

## Understanding the output

Two files are written, both named after the run ID:

### `impact-<runId>.md` — Markdown report card

Sections in order:

1. **Header** — scenario name, run ID, time window, workspace, resources targeted.
2. **⚠️ Partial report banner** *(when the run is still in flight)* — flags that
   the data is incomplete.
3. **`## Summary`** — counts of actions, chaos-attributed signals (with unique
   resource count), baseline signals, unexplained signals, and platform events.
4. **`## Action N — <name> (<start> → <end>)`** — one section per action with:
   - The targeted resource list
   - **`### Chaos-attributed signals`** — table of signals classified as caused by this action
   - **`### Unexplained signals (this action's window)`** — non-target signals
     observed inside this action's expanded window
5. **`## Unexplained Signals`** — cross-action rollup.
6. **`## Platform Events`** *(when present)* — Azure Service Health events active
   during the run window; explicitly attributed to the platform, not chaos.
7. **`## Coverage / Caveats`** — sampling counts, resources with no diagnostic
   settings, MaxResources overflow.
8. **`## Errors`** *(when present)* — per-call failures captured during fan-out.

### `impact-<runId>.json` — JSON sidecar (schema v1)

Conforms to [`schema/impact-report.schema.json`](../skills/chaos-impact/schema/impact-report.schema.json).
Key top-level fields:

| Field | Meaning |
|---|---|
| `impactReportSchemaVersion` | Always `1` for `startchaos@0.3.x`. |
| `generatedAt` | UTC timestamp; excluded when diffing two reports. |
| `scenarioRunId`, `workspace`, `scenario` | Identity of the run analyzed. |
| `window.partial` | `true` when the run was in flight at generation time. |
| `actions[]` | Per-action classified signal buckets. |
| `coverage` | Sampling + diag-setting availability summary. |
| `queries` | Trail of KQL + metric queries actually issued. |
| `errors[]` | Per-call failures captured during fan-out. |

To diff two runs:

```pwsh
$a = Get-Content impact-run-A.json -Raw | ConvertFrom-Json | Select-Object -ExcludeProperty generatedAt
$b = Get-Content impact-run-B.json -Raw | ConvertFrom-Json | Select-Object -ExcludeProperty generatedAt
Compare-Object ($a | ConvertTo-Json -Depth 32) ($b | ConvertTo-Json -Depth 32)
```

## Classification heuristics

Each in-scope signal lands in exactly one bucket per action:

- **`chaosAttributed`** — inside the action's expanded window, on a targeted
  resource, and either (a) metric delta exceeds the per-type threshold from
  `templates/metrics/defaults.json`, (b) log error volume spikes above the baseline
  ratio, or (c) an alert fired. The action that owns the window claims the signal.
- **`baseline`** — observed inside the per-action baseline window
  `[A.start − 2×buffer, A.start − buffer]`; treated as pre-existing noise.
- **`unexplained`** — inside the action's expanded window but on a resource that is
  not in *this action's* target set. Scoping is per-action: a signal on resource X
  during action B's window will be `unexplained` for B even if X is targeted by
  action A.
- **`platformEvent`** *(separate bucket)* — Azure Service Health events; these are
  documented platform incidents and are intentionally distinguished from
  `unexplained`.

Severity buckets (`info` < `low` < `med` < `high` < `crit`):

| Signal type | Bucket boundaries |
|---|---|
| Alert | Direct Sev0→crit, Sev1→high, Sev2→med, Sev3→low, Sev4→info |
| Metric | `\|delta\|/threshold`: `>3×` crit, `>2×` high, `>1×` med, else low (strict greater-than) |
| Log | `count/baseline` ratio: `>5` crit, `>3` high, `>1.5` med, else low |
| Activity / ServiceHealth | `info` |

## Sample output

```markdown
# Chaos Impact Report — hermetic-scenario / run hermetic-run-001

**Run window**: 2026-05-01T10:00:00Z → 2026-05-01T10:20:00Z   (buffer ±PT5M)
**Workspace**: hermetic-rg/hermetic-ws    **Resources targeted**: 1

## Summary

- **1** action(s).
- **2** chaos-attributed signal(s) across **1** resource(s).
- **0** baseline signal(s) (suppressed from per-action sections).
- **0** unexplained signal(s) — review recommended.

## Action 1 — stopInstances (2026-05-01T10:01:00Z → 2026-05-01T10:10:00Z)

**Targeted resources** (1):
- `/subscriptions/.../virtualMachineScaleSets/hermetic-vmss`

### Chaos-attributed signals

| Resource | Signal | Type | Value | Severity | Rationale |
|---|---|---|---|---|---|
| `virtualMachineScaleSets/hermetic-vmss` | Percentage CPU | metric | 15.0 | **high** | Delta 48pp vs baseline 63pp avg exceeds threshold 20pp |
| `virtualMachineScaleSets/hermetic-vmss` | VMInstanceHealth/Warning | log | 3 | **med** | Error-level log spike ratio 3.0× baseline |

## Unexplained Signals

*None.*

## Coverage / Caveats

- Resources sampled: 1 / 1 (cap: 50).
- Log signals available for 1 / 1 sampled resources.
```

## Troubleshooting

### Exit 2 — Missing Run Context

The skill could not assemble all five required parameters (`subscriptionId`,
`resourceGroup`, `workspaceName`, `scenarioName`, `scenarioRunId`) from the state
file. Pass the missing ones explicitly:

```text
> /chaos-impact run-001 -SubscriptionId <id> -ResourceGroup <rg> \
    -WorkspaceName <ws> -ScenarioName <scen>
```

### Exit 3 — Log Analytics Workspace Not Discoverable

One or more targeted resources have no diagnostic setting that routes to a Log
Analytics workspace, so the logs query path can't run. Two remediations:

```text
# A) Supply a workspace explicitly (KQL will use it for every resource):
> /chaos-impact run-001 -LogAnalyticsWorkspaceId /subscriptions/.../workspaces/my-law

# B) Skip the logs path entirely (metrics + activity + alerts + health still run):
> /chaos-impact run-001 -LogAnalyticsWorkspaceId none
```

### Exit 4 — Permission Gap

The caller's identity is missing `Monitoring Reader` on at least one targeted
resource group. Grant via the portal or:

```bash
az role assignment create --assignee <upn> --role 'Monitoring Reader' \
    --scope /subscriptions/<sub>/resourceGroups/<rg>
```

### "No chaos-attributed signals detected" but I expected some

Three common causes:

1. **Buffer too tight** — the signal may sit just outside the action window. Try
   `-Buffer PT10M` to expand both ends.
2. **Threshold not met** — the per-type thresholds in
   [`templates/metrics/defaults.json`](../skills/chaos-impact/templates/metrics/defaults.json)
   may be too conservative for your workload. Override by editing the file (or fork
   the skill).
3. **Resource type not in defaults** — resources whose ARM type has no entry in
   `metrics/defaults.json` skip the metrics fan-out. The skill falls back to logs +
   activity + alerts for those types; add a defaults entry to enable metrics
   classification.

## Limitations

- **Resource fan-out cap**: `-MaxResources 50` by default. Larger runs sample the
  first 50 targets (alphabetical) and report the overflow in
  `coverage.skippedDueToCap`. Raise with `-MaxResources <n>` (max 500).
- **Single-tenant**: All targeted resources must live in the same subscription as
  the workspace.
- **Partial reports for in-flight runs**: If the `ScenarioRun` status is
  `Running` / `Pending`, the report is emitted with `window.partial = true` and
  the Markdown carries a ⚠️ banner. Re-run after the chaos run completes for a
  final view.
- **VMSS/AKS instance collapse**: Instance-level resource IDs
  (`.../virtualMachineScaleSets/vmss/virtualMachines/0`) collapse to the parent
  scale-set for target matching; per-instance metrics still surface but are
  attributed to the parent.
