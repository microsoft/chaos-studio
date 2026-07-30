# Agent guide: AKS zone-down demo

Context and ground rules for AI agents (GitHub Copilot, Claude, or similar)
running this demo on a user's behalf.

## What this demo is

A break-fix-prove resilience demo for Azure Chaos Studio Workspaces (public
preview). The arc matters:

1. Deploy the AKS store demo app with its **default single-replica**
   deployments to a zone-redundant AKS cluster.
2. Run the **Compute Zone Down** scenario against the zone the `store-front`
   pod runs in. **The storefront going down is the expected, desired outcome
   of run 1** — it demonstrates the resilience gap. Do not treat the outage
   as an error to fix mid-run, and do not scale the deployment before run 1;
   that destroys the lesson.
3. Apply the fix (replicas + zone topology spread constraint, in README.md
   step 5), rerun the same scenario, and show the storefront surviving.

## Ground rules

- Run only in a subscription and resource group set aside for demos. Never
  target production resources.
- `deploy.sh` tags its resource group `chaos-demo=aks-zone-down-demo`, and
  `cleanup.sh` refuses to delete a group without that tag. Don't bypass the
  guard.
- Confirm with the user before starting a scenario run and before any
  deletion.
- Chaos Studio Workspaces are in public preview; regions and behavior can
  change. If something doesn't match these instructions, prefer the live
  docs (links at the end) over improvising.

## Steps

1. `./deploy.sh` — env overrides: `RESOURCE_GROUP`, `LOCATION`,
   `CLUSTER_NAME`, `MANIFEST_URL`. It prints the storefront URL, the
   cluster's infrastructure resource group (`MC_*`), and the zone the
   `store-front` pod landed in. Verify the storefront loads before
   proceeding.
2. Create the workspace and run the scenario per README.md ("Run the demo").
   You can do this in the Azure portal with the user, or with the `az chaos`
   CLI extension and this repo's Copilot CLI plugin. Permissions: the Reader
   banner on the workspace, and the **Fix Permissions** action on the
   scenario configuration page when validation reports missing RBAC.
3. Between runs, apply the fix exactly as written in README.md step 5, and
   confirm the replicas spread across nodes before rerunning.
4. `./cleanup.sh` when finished (`FORCE=1` skips the confirmation prompt).

## References

- Full walkthrough: <https://learn.microsoft.com/azure/chaos-studio/chaos-studio-tutorial-sample-app>
- Manage workspaces and scenarios with the CLI: <https://learn.microsoft.com/azure/chaos-studio/chaos-studio-manage-cli>
- Least-privilege roles: <https://learn.microsoft.com/azure/chaos-studio/chaos-studio-workspaces-least-privilege-roles>
- Copilot CLI plugin: [`../../copilot-cli-plugin/`](../../copilot-cli-plugin/)
