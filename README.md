# Azure Chaos Studio Workspaces — samples and tooling

Azure Chaos Studio Workspaces samples and tooling for chaos engineering on Azure,
resilience testing with Scenarios, and AKS zone-down testing.

> This repository complements the managed service; it doesn't contain the service
> source. Microsoft Learn is the source of truth for supported service workflows.

## Start here

| Journey | Destination |
|---|---|
| Understand the model | [Chaos Studio Workspaces overview](https://learn.microsoft.com/azure/chaos-studio/chaos-studio-workspaces-overview) |
| Create and run your first Scenario | [Quickstart: Create a Workspace and run your first Scenario](https://learn.microsoft.com/azure/chaos-studio/quickstart-create-workspace) |
| Try the primary hands-on sample | [AKS zone-down demo and scripts](samples/aks-zone-down-demo/) · [Microsoft Learn sample application tutorial](https://learn.microsoft.com/azure/chaos-studio/chaos-studio-tutorial-sample-app) |
| Plan and interpret AKS resilience tests | [Test workload resiliency on AKS](https://learn.microsoft.com/azure/chaos-studio/chaos-studio-aks-guidance) |
| Explore supported outage patterns | [Scenarios in Azure Chaos Studio](https://learn.microsoft.com/azure/chaos-studio/chaos-studio-scenarios) |
| Choose between the current and legacy models | [Compare Workspaces and Experiments (classic)](https://learn.microsoft.com/azure/chaos-studio/chaos-studio-workspaces-vs-experiments) |

## What is Chaos Studio Workspaces?

Chaos Studio Workspaces is the current Azure Chaos Studio resource model for
resilience testing. A Workspace discovers resources within a scope and recommends
Scenarios that simulate outage patterns. A Scenario run executes the Scenario's
Actions; Scenario reports record what ran and its outcome. Pair reports with
application monitoring to assess resilience, not just whether the disruption ran.
See the [Workspaces overview](https://learn.microsoft.com/azure/chaos-studio/chaos-studio-workspaces-overview)
for the model and supported workflows.

## Samples and tooling

| Component | What it is |
|---|---|
| [AKS zone-down demo](samples/aks-zone-down-demo/) | Deploy a sample application, run a zone-down Scenario, improve the deployment, and compare Scenario runs alongside application health. |
| [Resilience testing samples](samples/) | Deployable applications and infrastructure, starting with the AKS demo. |
| [Copilot CLI plugin and MCP server](copilot-cli-plugin/) | Create Workspaces, configure Scenarios, start Scenario runs, and analyze impact from a conversation or an autonomous agent. |
| [Custom Scenario contribution scaffold](scenarios/) | Guidance for contributing Scenario definitions beyond the built-in templates; no custom definitions are included yet. |

## Feedback (public preview)

We want it. [Open an issue](https://github.com/microsoft/chaos-studio/issues/new/choose)
for bugs and feature requests, or start a [Discussion](https://github.com/microsoft/chaos-studio/discussions)
for questions and ideas.

## Contributing

See the [contribution guide](CONTRIBUTING.md). This project follows the
[Microsoft Open Source Code of Conduct](https://opensource.microsoft.com/codeofconduct/)
and the [Microsoft CLA](https://cla.opensource.microsoft.com).

## License

[MIT](LICENSE)
