# Changelog

All notable changes to **startchaos** are documented here.

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `chaos_list_scenario_runs` MCP tool for rediscovering durable ScenarioRun
  records after the agent session that created them has ended. The tool follows
  every service-provided pagination link, returns runs newest-first, and can
  filter by configuration, status, or targeted resource ID.

### Changed

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
