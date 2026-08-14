# Changelog

All notable changes to **startchaos** are documented here.

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Chaos Loop workspace preflight.** A run now starts with a required,
  validated `workspaceRequest` (subscription, resource group, region, managed
  scopes, optional preferred name, optional managed identity) and a
  deterministic workspace preflight that runs before any phase:
  `chaos_list_workspaces` discovery → `workspace-plan` (reuse-or-create, no
  state mutation) → `chaos_get_workspace` readback or `chaos_create_workspace`
  → `workspace-finalize`. Reuse requires the requested region, the pinned
  identity when specified, `Succeeded` provisioning, and managed scopes that
  cover the requested scopes and every target resource; selection precedence is
  exact preferred name, exact managed-scope set, then stable case-insensitive
  ARM ID, with the remaining candidates recorded as alternatives and caveats.
  With no compatible candidate the create request uses the preferred name or a
  deterministic hash-derived name plus exactly the requested scopes, region, and
  identity. Any tool failure, failed RBAC grant, non-`Succeeded` provisioning,
  or readback mismatch persists a concrete `remediationBrief` and terminates the
  run `escalated` (`workspace-fail` records list/get/create permission and
  policy failures the same way). Only a ready workspace lets `evaluate`/`apply`
  proceed, and the selected workspace is immutable for the rest of the run — no
  later phase rediscovers it, and there is still no mid-loop workspace question.
  The two normal customer interaction stops are unchanged.
- `chaos_list_workspaces(subscription_id, resource_group=None)` MCP tool and the
  `azure.arm_list` paging helper: read-only enumeration of
  `Microsoft.Chaos/workspaces` at subscription or resource-group scope,
  following `nextLink`, on the same `2026-05-01-preview` API version.
  `chaos_create_workspace` remains the only write path. The `chaos-mcp`
  package version is now `0.4.0` for this public tool addition.
- `schemas/chaos-loop/workspace-plan.v1.schema.json` and
  `examples/chaos-loop/workspace-plan.json`.

### Changed

- Chaos Loop policy version is now `chaos-loop-policy/v2`; `run-state.v1`
  gains a required `workspace` object (status, normalized request, decision,
  selected workspace, alternatives, caveats, discovery/provisioning evidence,
  `observedAt`, remediation brief). `migrate` upgrades an earlier run and
  migrates it to a `pending` workspace so an in-flight run cannot bypass
  preflight; supply the missing request with `migrate --workspace-request`.
- The PowerShell skills (`create-workspace`, `setup-scenario`, `run-scenario`)
  now drive all Chaos Studio v2 control-plane operations through the first-party
  **`az chaos` CLI extension** instead of raw `az rest` calls, via a new shared
  `scripts/Invoke-AzChaos.ps1` wrapper. This keeps the plugin consistent with the
  supported CLI surface and gets LRO polling for free. Workspace creation now uses
  `az chaos workspace create`; discovery/evaluation uses
  `az chaos workspace refresh-recommendation`; scenario discovery/configuration/
  validation/permission-fix use the `az chaos scenario ...` command groups; and
  execution uses `az chaos scenario run start`. Non-Chaos ARM calls (managed-identity
  reads, role assignments) still use `az rest`. **Requires Azure CLI 2.75+**; the
  `chaos` extension is auto-installed on first use. The Python MCP server is
  unchanged (it retains direct ARM/httpx calls to preserve managed-identity auth).

### Fixed

- Restored the `chaos-mcp` server implementation (`chaos_mcp/server.py`,
  `chaos_mcp/monitor.py`): the 0.2.0/0.3.0 releases documented and tested the
  13 MCP tools, but the implementation modules were never committed to the
  repository. Reconstructed from the pytest specification, the README tool
  table, and the PowerShell skills' ARM call flows.
- `chaos-mcp` packaging metadata referenced `README.md`/`LICENSE` files that
  did not exist in the package directory, breaking `pip install`.

### Changed

- Repository renamed to `microsoft/chaos-studio` and restructured as a monorepo;
  the Copilot CLI plugin and MCP server now live under `copilot-cli-plugin/`.
- Repository extracted from `azure-rest-api-specs` to its own home. No
  user-visible behavior change.

## [0.3.0] — 2026-05-29

### Added

- `chaos-loop` controller and five bounded phase skills for an automatically
  advancing resilience-analysis, single-fault execution, diagnostic, advisory,
  coding, deployment-gate, and identical verification cycle. Deterministic
  Python policy owns durable state, validation, calculations, routing, verdict
  eligibility, advisory ledgers, and merge/build/artifact/deployment/live
  revision gate checks. The only normal customer pauses are advisory approval
  and PR delivery awaiting complete deployment evidence.
- Versioned Chaos Loop state and external-gate schemas, Scenario catalog,
  examples, package validation, and Azure SRE Agent setup guidance. The
  standalone archive reuses the repository's `chaos-studio` MCP server rather
  than shipping overlapping Azure wrappers.

- New `chaos-impact` skill: pulls a `ScenarioRun`, queries Azure Monitor
  (metrics, logs via KQL, Activity Log, alerts, Service Health) across the
  run window plus a configurable buffer, and emits a Markdown report card +
  JSON sidecar. Signals are classified as **chaos-attributed**, **baseline**,
  or **unexplained** with per-signal severity.
- Three new MCP tools so autonomous agents reach the same Azure Monitor
  capabilities programmatically:
  - `monitor_query_metrics`
  - `monitor_query_logs`
  - `monitor_search_activity_log`
- Hermetic E2E test harness (`skills/chaos-impact/tests/e2e/Run-Hermetic.ps1`)
  with recorded fixtures, exercised in CI without any Azure access.
- JSON schema for the impact report sidecar: `skills/chaos-impact/schema/impact-report.schema.json`.

### Tests

- 89 Pester tests (chaos-impact + shared helpers).
- 13 pytest tests (MCP Monitor tools, including 429 retry and 403 structured
  error envelope).

## [0.2.0] — 2026-05-12

### Added

- MCP server (`chaos-mcp`) exposing the workspace / scenario / run lifecycle
  as agent-callable tools, with LRO-aware blocking semantics.
- Bootstrap, polling, and RBAC helpers under `skills/_shared/`.

## [0.1.0] — 2026-04-30

### Added

- Initial release: `start-chaos`, `create-workspace`, `setup-scenario`,
  `run-scenario` skills targeting `Microsoft.Chaos` `2026-05-01-preview`.

[Unreleased]: https://github.com/microsoft/chaos-studio/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/microsoft/chaos-studio/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/microsoft/chaos-studio/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/microsoft/chaos-studio/releases/tag/v0.1.0
