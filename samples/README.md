# Chaos Studio Workspaces resilience testing samples

Hands-on applications and infrastructure for practicing resilience testing with
Chaos Studio Workspaces.

## Primary hands-on path

| Sample | What it shows |
|---|---|
| [AKS zone-down demo](aks-zone-down-demo/) | Deploy a sample retail app to a zone-redundant AKS cluster, run a zone-down Scenario, fix the deployment, run the Scenario again, and compare Scenario reports alongside application health. |

The repository demo contains deployment and cleanup scripts. Follow the corresponding
[Microsoft Learn AKS zone-resilience tutorial](https://learn.microsoft.com/azure/chaos-studio/chaos-studio-tutorial-sample-app)
for the guided walkthrough.

## Product guidance

Before deploying a sample, review the
[Workspaces overview](https://learn.microsoft.com/azure/chaos-studio/chaos-studio-workspaces-overview),
[Workspace quickstart](https://learn.microsoft.com/azure/chaos-studio/quickstart-create-workspace),
and [Scenario catalog](https://learn.microsoft.com/azure/chaos-studio/chaos-studio-scenarios).
For AKS-specific scope, disruption, and interpretation guidance, see
[Test workload resiliency on AKS](https://learn.microsoft.com/azure/chaos-studio/chaos-studio-aks-guidance).

## Contribute a sample

Contributions are welcome: use one folder per sample and include a README that
explains what it demonstrates, its prerequisites, setup, and cleanup.
