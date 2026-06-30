# Changelog

All notable changes to **startchaos** are documented here.

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
