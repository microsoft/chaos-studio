# Chaos Studio Workspaces — Open-source companion

Community tooling, Scenario contribution scaffolds, and hands-on samples for
**Chaos Studio Workspaces**, the current Azure Chaos Studio model for discovering
resources, running resilience tests, and reviewing ScenarioRun results.

> This repository complements the managed service; it doesn't contain the service
> source. See the [Azure Chaos Studio documentation](https://learn.microsoft.com/en-us/azure/chaos-studio/).

## Start with Workspaces

| Journey | Destination |
|---|---|
| Understand the model | [What are Workspaces in Azure Chaos Studio?](https://learn.microsoft.com/en-us/azure/chaos-studio/chaos-studio-workspaces-overview) |
| Create and run your first Scenario | [Quickstart: Create a Workspace and run your first Scenario](https://learn.microsoft.com/en-us/azure/chaos-studio/quickstart-create-workspace) |
| Choose between the current and legacy models | [Compare Workspaces and Experiments (classic)](https://learn.microsoft.com/en-us/azure/chaos-studio/chaos-studio-workspaces-vs-experiments) |
| Explore supported outage patterns | [Scenarios in Azure Chaos Studio](https://learn.microsoft.com/en-us/azure/chaos-studio/chaos-studio-scenarios) |
| Try the primary hands-on sample | [AKS zone-down demo](samples/aks-zone-down-demo/) |

## What's here

| Component | Path | What it is |
|---|---|---|
| **Copilot CLI plugin + MCP server** | [`copilot-cli-plugin/`](copilot-cli-plugin/) | Create Workspaces, configure Scenarios, start ScenarioRuns, and analyze impact from a conversation or an autonomous agent. |
| **Scenarios** | [`scenarios/`](scenarios/) | Contribution scaffold for shareable custom Scenario definitions beyond the built-in templates. |
| **Samples** | [`samples/`](samples/) | Deployable applications and infrastructure for practicing resilience testing. |

## Feedback (public preview)

We want it. [Open an issue](https://github.com/microsoft/chaos-studio/issues/new/choose)
for bugs and feature requests, or start a [Discussion](https://github.com/microsoft/chaos-studio/discussions)
for questions and ideas.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). This project follows the
[Microsoft Open Source Code of Conduct](https://opensource.microsoft.com/codeofconduct/)
and the [Microsoft CLA](https://cla.opensource.microsoft.com).

## License

[MIT](LICENSE)
