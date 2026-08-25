# AKS zone-down demo

A ~45-minute end-to-end demo of Azure Chaos Studio Workspaces with a
break-fix-prove arc: deploy a sample retail app to a zone-redundant AKS
cluster, take down an availability zone and watch the storefront **actually go
down**, then fix the deployment, rerun the same scenario, and watch it survive.
A dependency-light live HTML monitor (Python standard library only) makes the
break and the fix visible on one screen instead of scattered across a
terminal, a metrics blade, and a browser tab.

A demo where something visibly breaks teaches more than one where nothing
happens. Rather than leave that to whichever zone the scheduler happens to
pick, `deploy.sh` deliberately pins the sample app's single front-end replica
to one zone — a labeled, called-out anti-pattern that exists only to make Run
1 deterministic. Good as a first hands-on experience, a customer demo, or a
workshop exercise. It reuses the
[AKS store demo](https://github.com/Azure-Samples/aks-store-demo) sample
application (public container images, no registry or build steps).

The full written walkthrough lives on Microsoft Learn:
[Tutorial: Deploy a sample application and test its zone resilience with Chaos Studio](https://learn.microsoft.com/azure/chaos-studio/chaos-studio-tutorial-sample-app).
This folder adds scripts that automate the setup half and a live monitor for
presenting it, so a demo starts at the interesting part.

## What the demo shows

1. A zone-redundant AKS cluster running a storefront app that *isn't* zone
   redundant: every component is a single replica.
2. **Deliberate demo setup:** `deploy.sh` pins the `store-front` replica to
   the zone it happened to land in, so Run 1 always breaks the same,
   predictable way. This pin is staged breakage for teaching, not a pattern
   to copy — it's labeled as such in the deployment annotation and in this
   README.
3. A Chaos Studio **Workspace** that discovers the cluster's node
   infrastructure.
4. **Run 1 — break it.** The **Compute Zone Down** scenario shuts down the
   node in the pinned zone. The storefront's HTTP health can fail *before*
   the node's Kubernetes status shows `NotReady` — the node transition is a
   platform signal, not the customer signal. Watch the monitor's timeline,
   not just its current state, or a quick recovery can make you miss that the
   customer was ever affected.
5. **The fix.** Remove the deliberate pin, scale to three front-end replicas,
   and add a *hard* topology spread constraint (`whenUnsatisfiable:
   DoNotSchedule`) that requires one replica per zone — not the soft
   `ScheduleAnyway` preference, which doesn't guarantee anything.
   `verify-fix.sh` blocks until that's actually true, waiting out any
   rolling-update stragglers from the old single-replica revision.
6. **Run 2 — prove it.** Same scenario, same zone. A node still dies, but the
   store keeps serving from the surviving zones.
7. Two **Scenario reports** that both say `Succeeded` — the teaching moment
   that a run succeeding measures the disruption delivered, not app health.
   The before/after difference lives in the monitor, not the report.

## Prerequisites

- An Azure subscription with permission to create resource groups, AKS
  clusters, and Chaos Studio workspaces.
- Azure CLI and `kubectl` — [Azure Cloud Shell](https://learn.microsoft.com/azure/cloud-shell/overview)
  has both preinstalled. `python3` (stdlib only, no `pip install`) is also
  preinstalled in Cloud Shell, for the live monitor.
- The `Microsoft.Chaos` resource provider
  [registered](https://learn.microsoft.com/azure/chaos-studio/chaos-studio-quickstart-azure-portal#register-the-chaos-studio-resource-provider)
  in the subscription.

> [!IMPORTANT]
> **A fresh Cloud Shell session does not have `kubectl` pointed at your
> cluster yet**, even though Cloud Shell itself opened fine. Opening a new
> tab, reconnecting after a timeout, or handing the demo to a second
> presenter all start a fresh session. Before running any `kubectl` command
> in a session that hasn't run `deploy.sh` itself, bootstrap it:
>
> ```bash
> az account set --subscription <SUBSCRIPTION_ID>
> az aks get-credentials --resource-group "$RESOURCE_GROUP" --name "$CLUSTER_NAME"
> kubelogin convert-kubeconfig -l azurecli
> ```
>
> `kubelogin convert-kubeconfig` is required whenever the cluster uses
> Azure AD/Entra ID authentication for `kubectl`; it's a no-op (harmless) on
> clusters that don't. Cloud Shell has `kubelogin` preinstalled. Skipping
> this step is the single most common "why doesn't `kubectl` work" moment in
> a live demo.

## Set up (before the demo)

Cluster creation takes a few minutes, so run this ahead of time:

```bash
./deploy.sh
```

The script creates a resource group (`chaos-demo-rg` in `eastus2` by default —
override with the `RESOURCE_GROUP`, `LOCATION`, and `CLUSTER_NAME` environment
variables), creates a 3-node AKS cluster spread across zones 1–3, deploys the
store app, deliberately pins the `store-front` replica to one zone (see
above), and prints:

- the storefront URL — open it and confirm the store loads
- the cluster's **infrastructure resource group** (`MC_...`) — the workspace
  scope for the next step
- the **pinned zone** — the zone to target, guaranteed stable across reruns
- the exact `python3 monitor.py ...` command to start the live monitor

## The live monitor

`monitor.py` is a single Python file, standard library only — no `pip
install`, so it runs unmodified on Cloud Shell or any machine with `python3`
and `kubectl`. It polls the storefront (with cache-busting query params and
`Cache-Control: no-cache` headers, so nothing between you and the app can mask
a real failure) and polls the target zone's node and the `store-front` pods
via `kubectl`, then serves a browser dashboard showing:

- storefront reachable/unreachable (the primary, customer-facing signal)
- the target zone's node Ready/NotReady state
- running front-end replicas and which zones they're in
- a durable timeline of every transition, not just the current state — so a
  quick recovery you didn't personally watch happen is still provable

**Run it locally:**

```bash
python3 monitor.py --storefront-url http://<STOREFRONT_IP> --target-zone <ZONE>
```

Then open `http://localhost:8787`. (`deploy.sh` prints this command
pre-filled with your storefront IP and pinned zone.)

**Run it in Azure Cloud Shell:** start it the same way, then use
[Cloud Shell's Web Preview](https://learn.microsoft.com/azure/cloud-shell/using-cloud-shell-editor#web-preview)
(the icon next to the Cloud Shell settings gear) and point it at port `8787`
to open the dashboard in a browser tab alongside your terminal — no separate
machine or port-forward needed.

**Polling cadence:** the default is 5 seconds
(`MONITOR_INTERVAL_SECONDS` env var or `--interval`), derived from a live run
where the storefront's HTTP failure preceded the Kubernetes node's `NotReady`
transition by about 42 seconds. 5s yields roughly 42 ÷ 5 ≈ 8 samples across
that gap — enough to render the two events as distinct points on the timeline
instead of one ambiguous jump, without polling `kubectl`/the API server
faster than a live demo needs. If your environment shows a different gap,
adjust accordingly.

## Run the demo

Follow the walkthrough from the
[workspace step onward](https://learn.microsoft.com/azure/chaos-studio/chaos-studio-tutorial-sample-app#create-a-workspace-scoped-to-the-infrastructure-resource-group)
for the portal mechanics. This section covers what's specific to this demo.

1. In the portal, create a **Workspace** scoped to the infrastructure resource
   group printed by `deploy.sh`, with a system-assigned identity. Discovery
   finds the node VM scale set. If the workspace shows a banner that the
   identity is missing read permissions on the scope, select **Assign the
   Reader role over the Workspace Scope**. (Creating role assignments needs
   Owner or User Access Administrator on that resource group.)
2. Open the **Compute Zone Down** scenario, target the pinned zone
   `deploy.sh` printed (the number after the region name), and save the
   configuration. If validation flags missing permissions, select
   **Fix Permissions** to grant the identity the recommended built-in roles.
   Strict least-privilege shop? Build a
   [custom role from the validation output](https://learn.microsoft.com/azure/chaos-studio/chaos-studio-workspaces-least-privilege-roles)
   instead.
3. Set the scenario **duration to 5 minutes** for this live demo. That's long
   enough to see the storefront fail, the node go `NotReady`, and (in Run 2)
   the recovery, without dead air waiting for a longer run to finish in front
   of an audience. This is guidance for *this* demo's failure/recovery
   window, not a general default — a DNS-caching test or a longer
   propagation delay elsewhere may need a different duration entirely.
4. Set up the view before injecting anything. Make the **monitor dashboard
   the primary surface** — it's the one place that shows customer-facing HTTP
   health next to Kubernetes state on a shared, durable timeline. Keep these
   as supporting evidence:
   - a terminal running `kubectl get pods -o wide -w`
   - the cluster's **Monitoring → Metrics** blade, charting CPU per node
5. **Run 1:** select **Run**. Expect, in order: the storefront's HTTP check
   can fail before the node shows `NotReady` — Kubernetes' node-monitor grace
   period means the platform signal lags the customer signal, sometimes by
   tens of seconds. Don't rely on the terminal's `NotReady` line as your cue
   that the app is down; it can arrive after the outage already started, and
   the storefront can look reachable again by the time you glance back if the
   pod already rescheduled. The monitor's timeline is the proof either way.
6. **The fix** — remove the deliberate zone pin, scale to three replicas, and
   require one per zone (not just prefer it):

   ```bash
   kubectl patch deployment store-front --type=merge --patch '{"spec":{"template":{"spec":{"affinity":null}}}}'
   kubectl patch deployment store-front --patch '{"spec":{"replicas":3,"template":{"spec":{"topologySpreadConstraints":[{"maxSkew":1,"topologyKey":"topology.kubernetes.io/zone","whenUnsatisfiable":"DoNotSchedule","labelSelector":{"matchLabels":{"app":"store-front"}}}]}}}}'
   ./verify-fix.sh
   ```

   `whenUnsatisfiable: DoNotSchedule` is what actually makes "one replica per
   zone" true; `ScheduleAnyway` is a soft preference the scheduler can
   ignore, and the sample app's earlier default configuration only *hoped*
   for that spread. `verify-fix.sh` waits for the rollout to finish (so
   stale pods from the old single-replica revision don't produce a false
   pass) and then blocks — refusing to let you proceed — until every zone
   actually has a Ready `store-front` replica. Trade-off: a hard constraint
   can leave a replica `Pending` if a zone lacks spare capacity; this
   3-node/3-zone cluster has room for exactly one each.
7. **Run 2:** rerun the same scenario against the same zone with the monitor
   still open. The storefront keeps serving while the node dies — the
   monitor's HTTP card stays green throughout, and its zone-coverage card
   drops to two zones and recovers to three as the node returns.
8. Open **Run history** → **Generate report** for both runs. Both say
   `Succeeded` — that status means the shutdown action was delivered to the
   target zone, not that the application stayed healthy. The app's fate
   lives in the monitor's timeline, not the report; pairing the two (report
   = disruption delivered, monitor = customer impact) is the product pitch.

## Testing the monitor's logic

`monitor.py`'s state parsing (pod/node readiness, zone mapping, transition
detection) is pure and covered by stdlib `unittest` fixtures — no cluster or
network needed:

```bash
python3 -m unittest discover -s tests -v
```

## Prefer to drive it with Copilot?

This repo ships a [Copilot CLI plugin and MCP server](../../copilot-cli-plugin/)
that can create workspaces, configure scenarios, run them, and analyze the
results conversationally. With the plugin set up, try a prompt like:

> Deploy the aks-zone-down-demo sample from the chaos-studio repo, then help
> me run the Compute Zone Down scenario against the zone the storefront is
> running in. When the run finishes, summarize the scenario report.

[`AGENTS.md`](AGENTS.md) in this folder gives coding agents the context and
ground rules they need to run the demo end to end.

> [!NOTE]
> Chaos Studio Workspaces are in public preview. Run this demo in a
> subscription and cluster set aside for testing, not production.

## Clean up

```bash
./cleanup.sh
```

Deletes the resource group, which removes the cluster, the app, the
infrastructure resource group, and the workspace. If the monitor is still
running, stop it with `Ctrl+C` first.

## Going further

- [Workspaces overview](https://learn.microsoft.com/azure/chaos-studio/chaos-studio-workspaces-overview)
  and [Scenarios](https://learn.microsoft.com/azure/chaos-studio/chaos-studio-scenarios)
- [Test workload resiliency on AKS](https://learn.microsoft.com/azure/chaos-studio/chaos-studio-aks-guidance) —
  the caveats and interpretation guidance behind this demo
- [`copilot-cli-plugin/`](../../copilot-cli-plugin/) — drive the same setup
  conversationally from GitHub Copilot
