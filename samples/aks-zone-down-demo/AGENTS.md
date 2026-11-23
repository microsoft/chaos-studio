# Agent guardrails: AKS zone-down demo

- Use this demo only in non-production subscriptions and resource groups.
- Preserve the deliberate `store-front` zone pin and single replica before Run 1; removing the pin or scaling early destroys the deterministic lesson.
- Treat storefront HTTP in `monitor.py` as the customer signal. A Scenario status of `Succeeded` proves disruption delivery only, not application health.
- Follow the [canonical Learn tutorial](https://learn.microsoft.com/azure/chaos-studio/chaos-studio-tutorial-sample-app#fix-the-deployment-and-verify-it) for the hard-spread fix, and require `./verify-fix.sh` to pass before Run 2.
- Preserve `cleanup.sh` resource-group tag validation and confirmation behavior.
- Preserve `--zones 1 2 3` and the optional `NODE_VM_SIZE` override in `deploy.sh`. Do not add an `az vm list-skus` capacity gate: SKU listings do not guarantee live capacity, so Azure deployment output is authoritative.
- Do not invent product or API behavior beyond the live Learn guidance.
