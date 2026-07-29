# AKS zone-down demo

A ~30-minute end-to-end demo of Azure Chaos Studio Workspaces: deploy a sample
retail app to a zone-redundant AKS cluster, take down an availability zone, and
watch the app survive.

This is the fastest way to see Chaos Studio disrupt a live application — good as
a first hands-on experience, a customer demo, or a workshop exercise. It reuses
the [AKS store demo](https://github.com/Azure-Samples/aks-store-demo) sample
application (public container images, no registry or build steps).

The full written walkthrough lives on Microsoft Learn:
[Tutorial: Deploy a sample application and test its zone resilience with Chaos Studio](https://learn.microsoft.com/azure/chaos-studio/chaos-studio-tutorial-sample-app).
This folder adds scripts that automate the setup half, so a demo starts at the
interesting part.

## What the demo shows

1. A storefront app running across three availability zones on AKS.
2. A Chaos Studio **Workspace** that discovers the cluster's node
   infrastructure.
3. The **Compute Zone Down** scenario shutting down every node in one zone.
4. The app staying reachable while Kubernetes reschedules around the outage —
   and the single-replica queue briefly degrading, which is exactly the kind of
   finding chaos testing exists to surface.
5. A **Scenario report** documenting what ran, when, and against what.

## Prerequisites

- An Azure subscription with permission to create resource groups, AKS
  clusters, and Chaos Studio workspaces.
- Azure CLI and `kubectl` — [Azure Cloud Shell](https://learn.microsoft.com/azure/cloud-shell/overview)
  has both preinstalled.
- The `Microsoft.Chaos` resource provider
  [registered](https://learn.microsoft.com/azure/chaos-studio/chaos-studio-quickstart-azure-portal#register-the-chaos-studio-resource-provider)
  in the subscription.

## Set up (before the demo)

Cluster creation takes a few minutes, so run this ahead of time:

```bash
./deploy.sh
```

The script creates a resource group (`chaos-demo-rg` in `eastus2` by default —
override with the `RESOURCE_GROUP`, `LOCATION`, and `CLUSTER_NAME` environment
variables), creates a 3-node AKS cluster spread across zones 1–3, deploys the
store app, scales the front end to one replica per zone, and prints:

- the storefront URL — open it and confirm the store loads
- the cluster's **infrastructure resource group** (`MC_...`) — the workspace
  scope for the next step

## Run the demo

Follow the walkthrough from the
[workspace step onward](https://learn.microsoft.com/azure/chaos-studio/chaos-studio-tutorial-sample-app#create-a-workspace-scoped-to-the-infrastructure-resource-group).
In short:

1. In the portal, create a **Workspace** scoped to the infrastructure resource
   group printed by `deploy.sh` (system-assigned identity, automatic role
   assignment on). Discovery finds the node VM scale set.
2. Open the **Compute Zone Down** scenario, target zone `1`, save, and **Run**.
3. While it runs (5–10 minutes), split the screen: the storefront in a browser,
   and in a terminal:

   ```bash
   kubectl get nodes -w
   ```

   The zone's node goes `NotReady`, pods reschedule, and the storefront keeps
   serving. Refresh it liberally.
4. When the run completes, open **Run history** → the run → **Generate report**
   and walk through what executed.

> [!NOTE]
> Chaos Studio Workspaces are in public preview. Run this demo in a
> subscription and cluster set aside for testing, not production.

## Clean up

```bash
./cleanup.sh
```

Deletes the resource group, which removes the cluster, the app, the
infrastructure resource group, and the workspace.

## Going further

- [Workspaces overview](https://learn.microsoft.com/azure/chaos-studio/chaos-studio-workspaces-overview)
  and [Scenarios](https://learn.microsoft.com/azure/chaos-studio/chaos-studio-scenarios)
- [Test workload resiliency on AKS](https://learn.microsoft.com/azure/chaos-studio/chaos-studio-aks-guidance) —
  the caveats and interpretation guidance behind this demo
- [`copilot-cli-plugin/`](../../copilot-cli-plugin/) — drive the same setup
  conversationally from GitHub Copilot
