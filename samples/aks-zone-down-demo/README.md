# AKS zone-down demo

This folder is the executable companion for the [Microsoft Learn tutorial: Deploy a sample app and test zone resilience on AKS](https://learn.microsoft.com/azure/chaos-studio/chaos-studio-tutorial-sample-app). The tutorial owns the break-fix-prove procedure and product guidance; these assets provide deterministic setup, live evidence, verification, and guarded cleanup.

| Asset | Purpose |
| --- | --- |
| `deploy.sh` | Deploy the sample and deliberately pin `store-front` for deterministic Run 1. |
| `monitor.py` | Serve the stdlib-only live HTTP and Kubernetes dashboard. |
| `verify-fix.sh` | Block Run 2 until the rollout has Ready coverage in every cluster zone. |
| `cleanup.sh` | Delete only the tagged demo resource group, with confirmation by default. |
| `aks-zone-down-demo.yml` | Optionally invoke deploy or cleanup through GitHub Actions and Azure OIDC. |

## Run locally

```bash
cd samples/aks-zone-down-demo
./deploy.sh
python3 monitor.py --storefront-url http://<STOREFRONT_IP> --target-zone <ZONE>
./cleanup.sh
```

Follow the Learn tutorial after deployment, including its [hard-spread fix and required verification](https://learn.microsoft.com/azure/chaos-studio/chaos-studio-tutorial-sample-app#fix-the-deployment-and-verify-it).

## Optional GitHub Actions deployment

In your fork, [configure Azure login with OpenID Connect](https://learn.microsoft.com/azure/developer/github/connect-from-azure-openid-connect), create the `aks-zone-down-demo` GitHub environment, and provide its `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, and `AZURE_SUBSCRIPTION_ID` secrets. Fork owners must configure any desired environment protection rules themselves; naming the environment does not enforce reviewers.

Grant the GitHub deployment identity the Azure permissions required to deploy and clean up these resources. That identity is separate from the Chaos Studio workspace managed identity and its scenario permissions, which are configured in the Learn tutorial. Then run the **AKS zone-down demo** workflow with the `deploy` or `cleanup` operation.
