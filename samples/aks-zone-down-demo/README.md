# AKS zone-down demo with Chaos Studio Workspaces

An end-to-end resilience testing demo of Azure Chaos Studio Workspaces with a
break-fix-prove arc: deploy a sample retail app to a zone-redundant AKS
cluster, take down an availability zone and watch the storefront **actually go
down**, then fix the deployment, rerun the same Scenario, and watch it survive.

A demo where something visibly breaks teaches more than one where nothing
happens — and the sample app's default single-replica deployment provides the
breakage for free. Good as a first hands-on experience, a customer demo, or a
workshop exercise. It reuses the
[AKS store demo](https://github.com/Azure-Samples/aks-store-demo) sample
application (public container images, no registry or build steps).

The full written walkthrough lives on Microsoft Learn:
[Tutorial: Deploy a sample application and test its zone resilience with Chaos Studio](https://learn.microsoft.com/azure/chaos-studio/chaos-studio-tutorial-sample-app).
This folder supplies deployment and cleanup scripts. Use the Learn tutorial for
the complete current walkthrough, including its monitoring and placement checks.

## What the demo shows

1. A zone-redundant AKS cluster running a storefront app that *isn't* zone
   redundant: every component is a single replica.
2. A Chaos Studio **Workspace** that discovers the cluster's node
   infrastructure.
3. **Run 1 — break it.** The **Compute Zone Down** Scenario shuts down the
   node in the storefront's zone. The store goes unreachable for several
   minutes (Kubernetes waits ~5 minutes by default before rescheduling pods
   off an unreachable node). That downtime is the finding.
4. **The fix.** Scale the front end and request zone spreading.
5. **Run 2 — prove it.** Same Scenario, same zone. A node still dies, but the
   store keeps serving from the surviving zones.
6. Two **Scenario reports** that both say `Succeeded` — the teaching moment
   that a Scenario run succeeding measures the disruption delivered, not app health.
   The before/after difference lives in your monitoring.

## Prerequisites

- An Azure subscription with permission to create resource groups, AKS
  clusters, and Chaos Studio Workspaces.
- Azure CLI and `kubectl` — [Azure Cloud Shell](https://learn.microsoft.com/azure/cloud-shell/overview)
  has both preinstalled.
- The `Microsoft.Chaos` resource provider registered in the subscription, as
  described in the [Workspace quickstart prerequisites](https://learn.microsoft.com/azure/chaos-studio/quickstart-create-workspace#prerequisites).

## Set up (before the demo)

Cluster creation takes a few minutes, so run this ahead of time:

```bash
./deploy.sh
```

The script creates a resource group (`chaos-demo-rg` in `eastus2` by default —
override with the `RESOURCE_GROUP`, `LOCATION`, and `CLUSTER_NAME` environment
variables), creates a 3-node AKS cluster spread across zones 1–3, deploys the
store app with its default single-replica deployments, and prints:

- the storefront URL — open it and confirm the store loads
- the cluster's **infrastructure resource group** (`MC_...`) — the Workspace
  scope for the next step
- the **zone the storefront pod is running in** — the zone to target

## Run the demo

Follow the walkthrough from the
[Workspace creation step onward](https://learn.microsoft.com/azure/chaos-studio/chaos-studio-tutorial-sample-app#create-a-workspace-scoped-to-the-infrastructure-resource-group).
In short:

1. In the portal, create a **Workspace** scoped to the infrastructure resource
   group printed by `deploy.sh`, with a system-assigned identity. Discovery
   finds the node VM scale set. If the Workspace shows a banner that the
   identity is missing read permissions on the scope, select **Assign the
   Reader role over the Workspace Scope**. (Creating role assignments needs
   Owner or User Access Administrator on that resource group.)
2. Open the **Compute Zone Down** Scenario, target the zone `deploy.sh`
   printed (the number after the region name), and save the configuration.
   If validation flags missing permissions, select **Fix Permissions** to
   grant the identity the recommended built-in roles. Strict least-privilege
   shop? Build a [custom role from the validation output](https://learn.microsoft.com/azure/chaos-studio/chaos-studio-workspaces-least-privilege-roles)
   instead.
3. Set up the view before injecting anything — split the screen: the
   storefront in a browser, the cluster's **Monitoring → Metrics** blade
   charting CPU per node, and a terminal running:

   ```bash
   kubectl get pods -o wide -w
   ```

4. **Run 1:** select **Run** (5–10 minutes). The node goes `NotReady`, its
   metrics flatline, and the storefront stops loading. Let the downtime sink
   in — note how long it lasts.
5. **The fix:** request three replicas and prefer spreading them across zones.
   `ScheduleAnyway` is a scheduling preference, not a guarantee of one replica
   per zone. Confirm placement before the second Scenario run:

   ```bash
   kubectl patch deployment store-front --patch '{"spec":{"replicas":3,"template":{"spec":{"topologySpreadConstraints":[{"maxSkew":1,"topologyKey":"topology.kubernetes.io/zone","whenUnsatisfiable":"ScheduleAnyway","labelSelector":{"matchLabels":{"app":"store-front"}}}]}}}}'
   kubectl get pods -l app=store-front -o wide   # confirm one per node
   ```

6. **Run 2:** rerun the same Scenario against the same zone. The storefront
   keeps serving while the node dies. Refresh it liberally.
7. Open **Run history** → **Generate report** for both runs. Both say
   `Succeeded`; the Scenario report records the disruption delivered, while the app's
   fate shows up in the metrics chart and the browser. That pairing is the
   product pitch.

## Run the AKS demo with GitHub Copilot

This repo ships a [Copilot CLI plugin and MCP server](../../copilot-cli-plugin/)
that can create Workspaces, configure Scenarios, start Scenario runs, and analyze the
results conversationally. With the plugin set up, try a prompt like:

> Deploy the aks-zone-down-demo sample from the chaos-studio repo, then help
> me run the Compute Zone Down Scenario against the zone the storefront is
> running in. When the Scenario run finishes, summarize the Scenario report.

The [agent guide](AGENTS.md) in this folder gives coding agents the context and
ground rules they need to run the demo end to end.

> [!NOTE]
> Chaos Studio Workspaces are in public preview. Run this demo in a
> subscription and cluster set aside for testing, not production.

## Clean up

```bash
./cleanup.sh
```

Deletes the resource group, which removes the cluster, the app, the
infrastructure resource group, and the Workspace.

## Going further

- [Workspaces overview](https://learn.microsoft.com/azure/chaos-studio/chaos-studio-workspaces-overview)
  and [Scenarios](https://learn.microsoft.com/azure/chaos-studio/chaos-studio-scenarios)
- [Test workload resiliency on AKS](https://learn.microsoft.com/azure/chaos-studio/chaos-studio-aks-guidance) —
  the caveats and interpretation guidance behind this demo
- [Copilot CLI plugin and MCP server](../../copilot-cli-plugin/) — drive the same setup
  conversationally from GitHub Copilot
