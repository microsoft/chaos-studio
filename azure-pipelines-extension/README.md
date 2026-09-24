# `azure-pipelines-extension/` — Azure DevOps (Visual Studio Marketplace) extension

Manifests and task definition for the **Azure Chaos Studio Workspaces** Azure
Pipelines integration. These are consumed by the Squall OneBranch pipelines in
[`.pipelines/`](../.pipelines/) to build, sign, and publish the VSIX under the
existing `AzureChaosStudio` publisher.

| File | Purpose |
|---|---|
| `vss-extension.json` | Production manifest — `AzureChaosStudio.ChaosStudioWorkspaces` (public, Preview). |
| `vss-extension.dev.json` | Private development manifest — `AzureChaosStudio.ChaosStudioWorkspacesDev`, shared only with test organizations. Packages the distinct-GUID dev task folder. |
| `tasks/AzureChaosStudioScenarioV1/task.json` | The production `AzureChaosStudioScenario@1` task; preferred `Node24` execution handler with `Node20_1` fallback (VF15, D19). |
| `tasks/AzureChaosStudioScenarioV1Dev/task.json` | The private-preview `AzureChaosStudioScenarioDev@1` task; the same dual runtime handlers and a **distinct** permanent GUID so the dev extension installs side by side with production. |

Both task manifests require agent `2.214.1`, the first agent with the
`Node20_1` fallback handler. Agents that support the `Node24` handler prefer it;
older compatible Azure DevOps Server agents use `Node20_1`. Azure DevOps Server
2022.2's documented agent `3.238.0` therefore satisfies this task metadata,
while the task remains ready for current agents that carry Node24.

## Permanent task ID

The task `id` GUID in `task.json` is **permanent**: a published Azure DevOps task
cannot change its `id`, and a published task cannot be deleted — only deprecated
and version-bumped (VF15). Each was generated once and committed. The production
and development tasks carry **different** GUIDs so both extensions can be
installed in the same organization at once:

```
AzureChaosStudioScenario     id = 83c40b4c-e5bb-4045-9cb2-ce389248b386
AzureChaosStudioScenarioDev  id = eb1d4fc5-61c2-4887-a9af-a649907eaf64
```

The runtime `index.js` bundle is copied into the task folder from
[`dist/azure-pipelines-task/`](../dist/azure-pipelines-task/) at package time.
