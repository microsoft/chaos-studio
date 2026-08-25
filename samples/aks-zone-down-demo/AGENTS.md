# Agent guide: AKS zone-down demo

Context and ground rules for AI agents (GitHub Copilot, Claude, or similar)
running this demo on a user's behalf.

## What this demo is

A break-fix-prove resilience demo for Azure Chaos Studio Workspaces (public
preview). The arc matters:

1. Deploy the AKS store demo app to a zone-redundant AKS cluster.
   `deploy.sh` then **deliberately pins** the single `store-front` replica to
   the zone it landed in (a labeled, called-out anti-pattern — not a
   recommendation). This is what makes run 1 deterministic instead of
   depending on which zone the scheduler happened to pick.
2. Run the **Compute Zone Down** scenario against the pinned zone. **The
   storefront going down is the expected, desired outcome of run 1** — it
   demonstrates the resilience gap. Do not treat the outage as an error to
   fix mid-run, and do not remove the pin or scale the deployment before
   run 1; that destroys the lesson.
3. Apply the fix (README.md step 6): remove the deliberate pin, scale to
   three replicas, and add a **hard** topology spread constraint
   (`whenUnsatisfiable: DoNotSchedule`) — not `ScheduleAnyway`, which is a
   soft preference and does not guarantee one replica per zone. Run
   `./verify-fix.sh` and require it to pass before rerunning; it blocks until
   every zone actually has a Ready `store-front` replica, accounting for
   rolling-update stragglers from the old single-replica revision.
4. Rerun the same scenario against the same zone and show the storefront
   surviving.

## Signal ordering — read this before narrating a run

The storefront's HTTP health can fail **before** the node's Kubernetes status
shows `NotReady` (a live run observed roughly a 42-second gap). The node
transition is a platform signal explaining *why*; it is not the customer
signal. Treat `monitor.py`'s dashboard — specifically its HTTP
reachable/unreachable card and its transition timeline — as the primary
signal, not the terminal's `kubectl get pods -w` output or the node status
alone. Because the pod can reschedule and the storefront can look healthy
again quickly, a glance at the browser without the monitor's durable timeline
can miss that the customer was ever affected. Don't declare "it's fine" from
the browser looking healthy at a single moment; check the timeline.

A Scenario report showing `Succeeded` means the shutdown action was
*delivered* to the target zone — it says nothing about whether the
application stayed up. Never describe a `Succeeded` report as "the app
survived"; that's the monitor's job to show.

## Ground rules

- Run only in a subscription and resource group set aside for demos. Never
  target production resources.
- `deploy.sh` tags its resource group `chaos-demo=aks-zone-down-demo`, and
  `cleanup.sh` refuses to delete a group without that tag. Don't bypass the
  guard.
- Confirm with the user before starting a scenario run and before any
  deletion.
- Recommend a 5-minute scenario duration for *this* demo's live window
  (long enough to see failure and recovery, short enough to avoid dead air).
  Don't generalize that duration to other scenario types with different
  propagation or caching behavior.
- A fresh terminal/Cloud Shell session (a new tab, a reconnect, a second
  presenter) has not necessarily run `az aks get-credentials` yet. Before
  running `kubectl` in a session that didn't run `deploy.sh` itself, bootstrap
  it: `az account set --subscription <id>`, then
  `az aks get-credentials --resource-group <rg> --name <cluster>`, then
  `kubelogin convert-kubeconfig -l azurecli`. Don't assume `kubectl` just
  works because the shell opened.
- Chaos Studio Workspaces are in public preview; regions and behavior can
  change. If something doesn't match these instructions, prefer the live
  docs (links at the end) over improvising.

## Steps

1. `./deploy.sh` — env overrides: `RESOURCE_GROUP`, `LOCATION`,
   `CLUSTER_NAME`, `MANIFEST_URL`. It prints the storefront URL, the
   cluster's infrastructure resource group (`MC_*`), the zone the
   `store-front` pod was **pinned** to, and the exact `python3 monitor.py`
   command to start the live dashboard. Verify the storefront loads before
   proceeding.
2. Start `monitor.py` (locally, or via Cloud Shell Web Preview on port 8787 —
   see README.md) before injecting anything. It's the primary presentation
   surface; `kubectl get pods -o wide -w` and the Metrics blade are
   supporting evidence, not the main signal.
3. Create the workspace and run the scenario per README.md ("Run the demo").
   You can do this in the Azure portal with the user, or with the `az chaos`
   CLI extension and this repo's Copilot CLI plugin. Permissions: the Reader
   banner on the workspace, and the **Fix Permissions** action on the
   scenario configuration page when validation reports missing RBAC.
4. Between runs, apply the fix exactly as written in README.md step 6, then
   run `./verify-fix.sh` and do not proceed to run 2 until it exits 0.
5. `./cleanup.sh` when finished (`FORCE=1` skips the confirmation prompt).
   Stop `monitor.py` with Ctrl+C first if it's still running.

## References

- Full walkthrough: <https://learn.microsoft.com/azure/chaos-studio/chaos-studio-tutorial-sample-app>
- Manage workspaces and scenarios with the CLI: <https://learn.microsoft.com/azure/chaos-studio/chaos-studio-manage-cli>
- Least-privilege roles: <https://learn.microsoft.com/azure/chaos-studio/chaos-studio-workspaces-least-privilege-roles>
- Copilot CLI plugin: [`../../copilot-cli-plugin/`](../../copilot-cli-plugin/)
