# `dist/azure-pipelines-task/` — committed Azure Pipelines task bundle

This directory holds the **reproducibly built** runtime bundle for the Azure
Pipelines task. The OneBranch official pipeline copies this bundle into the task
folder under [`azure-pipelines-extension/`](../../azure-pipelines-extension/)
and packages it into the signed VSIX.

- **Source:** `packages/task-azure-pipelines` (thin `azure-pipelines-task-lib`
  adapter over the shared core in `packages/core`).
- **Runtime:** the task prefers the `Node24` execution handler and retains
  `Node20_1` as a compatibility fallback for Azure DevOps Server agents.
- **Build:** produced by `npm run build` (`scripts/build.mjs`), which bundles
  `packages/task-azure-pipelines/src/index.ts` and its runtime dependencies
  (`@azure/identity`, `azure-pipelines-task-lib`) into this single
  self-contained CommonJS file via `esbuild`, so the `dist`-integrity gate
  reproduces the whole directory.
