---
name: install-litmus-extension
description: "Install the LitmusChaos-based Chaos Studio extension on a customer's AKS cluster using delegated Azure CLI access. Check prerequisites and availability, require explicit approval for installation and bundled access changes, preserve existing installations, and verify provisioning and readiness without running faults."
---

# Install the Chaos Studio extension for AKS

Use this skill when asked to install the Litmus AKS extension or connect AKS to
an existing Chaos Studio Workspace. This installs the managed Chaos Studio
extension, not standalone LitmusChaos or Chaos Mesh.

**Default to read-only preflight.** An installation request, autonomous mode or
earlier approval does not approve the concrete plan. Use the host's user-input
tool for approval; without a customer to approve, return the plan and stop.
Check every native command's exit code immediately, before the next command.
On errors, stop and report the failed phase; never treat empty output as success.
Never print tokens, credentials or kubeconfig contents.

## Supported contract

Read the current public guidance before proceeding:

- [Installation, prerequisites and permissions](https://learn.microsoft.com/azure/chaos-studio/chaos-studio-aks-extension-install)
- [Overview and supported configurations](https://learn.microsoft.com/azure/chaos-studio/chaos-studio-aks-extension-overview)
- [Troubleshooting](https://learn.microsoft.com/azure/chaos-studio/chaos-studio-aks-extension-troubleshoot)
- [Extension availability discovery](https://learn.microsoft.com/cli/azure/k8s-extension/extension-types)

The published path uses `az k8s-extension create`, cluster type `managedClusters`,
name `chaos-studio`, type `Microsoft.ChaosStudio`, train `dev`, and the
`k8s-extension` CLI extension **1.9.5+**. The train name is not a claim of general
availability. Confirm live availability for the customer's cluster.
If guidance is unavailable or conflicts with the installed CLI, report the
unverified contract and stop. Never substitute `az aks extension`, guessed types,
preview flags, Helm, POC deployments, private endpoints or manual onboarding.

## 1. Gather and authenticate

Obtain explicit values; never choose the first subscription or cluster:

| Input | Requirement |
| --- | --- |
| Tenant and cloud | Customer tenant ID and intended Azure cloud |
| AKS | Subscription ID and full `Microsoft.ContainerService/managedClusters` resource ID |
| Workspace | Subscription ID and full `Microsoft.Chaos/workspaces` resource ID, not Log Analytics |
| Target namespaces | Exact, nonempty list of existing namespaces, excluding `chaos-infrastructure`; include `default` only if intended |
| Network faults needed | Determines whether an installation without the daemon meets the request |

Use the customer's delegated Azure CLI session. If missing or in the wrong
tenant, stop for customer sign-in with `az login --tenant <tenant-id>`.
Never request secrets, admin credentials or impersonation of the Workspace
identity. Do not silently switch clouds or identities.

Examples use PowerShell 7. Populate `$aksSubscriptionId`, `$aksResourceGroup`,
`$aksClusterName`, `$aksId`, `$workspaceSubscriptionId`, `$workspaceId` and the
array `$targetNamespaces` from validated inputs. Cross-check subscription,
resource group and name against each full ARM ID case-insensitively. Pass inputs
as arguments, never `Invoke-Expression`.

```powershell
az version --output json
az cloud show --output json
az account show --subscription $aksSubscriptionId --output json
az account show --subscription $workspaceSubscriptionId --output json
az extension show --name k8s-extension --output json
kubectl version --client --output json
kubelogin --version
```

Require enabled subscriptions in the intended tenant/cloud and CLI extension
version 1.9.5 or later. Before any `az k8s-extension` call, temporarily set
`AZURE_EXTENSION_USE_DYNAMIC_INSTALL=no`; restore its previous environment value
on exit. Missing or old tools block preflight, not permission to download them.
Offer `az extension add --name k8s-extension --upgrade` and
`az aks install-cli` only as separately approved local setup.

## 2. Read-only preflight

```powershell
az aks show --subscription $aksSubscriptionId `
    --resource-group $aksResourceGroup --name $aksClusterName --output json
az resource show --subscription $workspaceSubscriptionId `
    --ids $workspaceId --output json
az provider show --subscription $aksSubscriptionId `
    --namespace Microsoft.KubernetesConfiguration --output json
az provider show --subscription $workspaceSubscriptionId `
    --namespace Microsoft.Chaos --output json

$clusterArgs = @(
    '--subscription', $aksSubscriptionId,
    '--resource-group', $aksResourceGroup,
    '--cluster-name', $aksClusterName,
    '--cluster-type', 'managedClusters'
)
az k8s-extension extension-types list-by-cluster @clusterArgs `
    --release-train dev --output json
az k8s-extension extension-types list-versions-by-cluster @clusterArgs `
    --extension-type Microsoft.ChaosStudio --release-train dev --output json
az k8s-extension list @clusterArgs --output json
```

Require AKS provisioning `Succeeded`, Workload Identity enabled, OIDC enabled
with a nonempty issuer URL, Azure RBAC for Kubernetes enabled, registered
providers, and an advertised `Microsoft.ChaosStudio` type with an available `dev`
version. Empty catalogs, denied discovery and unavailable trains are blockers;
never attempt create as a probe. Do not register providers or enable features.

Require a Workspace with a system-assigned identity or exactly one user-assigned
identity, not both. Resolve its principal ID with a read-only identity lookup
when necessary. Verify the Workspace scope covers the cluster and the identity
has Reader on that scope, including inherited assignments. Unresolved scope
membership is a blocker, not proof of coverage.

Review the public installation permission table against the caller's effective
permissions at both scopes. Required permissions include cluster/Workspace
reads, Deployment Safeguards read, cluster-user credential access, Kubernetes
namespace read, extension write on the cluster, role-assignment write on the
cluster, and connection write on the Workspace. Contributor on the cluster
alone is insufficient. Use read-only permission and role inspection; successful
reads or visible role names alone do not prove write permissions. If permissions
cannot be established, stop for an administrator to confirm them. Never create
a resource to test access or grant permissions during preflight.

### Kubernetes checks

Explain and obtain approval for the local credential-file write before acquiring
credentials. Choose a new session-local `$kubeconfigPath`; never overwrite an
existing file or the default kubeconfig, and never use `--admin`.

```powershell
az aks get-credentials --subscription $aksSubscriptionId `
    --resource-group $aksResourceGroup --name $aksClusterName `
    --file $kubeconfigPath
```

Inspect the new kubeconfig locally without displaying credentials. Verify its
server matches the AKS read result before any Kubernetes reads. Then run:

```powershell
kubectl --kubeconfig $kubeconfigPath config current-context
kubectl --kubeconfig $kubeconfigPath get nodes --output json
kubectl --kubeconfig $kubeconfigPath get namespaces --output json
```

Use the explicit file for every kubectl call. Temporarily set `KUBECONFIG` to
that file and `AAD_LOGIN_METHOD=azurecli` for installation; restore both on exit.
Verify Linux amd64 capacity and that all requested namespaces exist. Arm64-only
clusters are unsupported; Windows pods are not supported fault targets.

Read Deployment Safeguards configuration using its current documented read-only
AKS interface. Enforcement without a `chaos-infrastructure` exclusion causes
installation to skip the network daemon. If network faults are required, stop
for an administrator; otherwise disclose reduced capability in the plan.
Never weaken policy. Report Pod Security Admission `restricted` labels, which
block pod delete faults; do not relabel namespaces.
Confirm documented outbound access to Chaos Studio, Microsoft Entra ID and
`mcr.microsoft.com`, and cluster API reachability from the agent. Do not change
network rules. Unverifiable required prerequisites remain blockers.

## 3. Preserve existing installations

Inspect the full extension list. Another type named `chaos-studio`, or the
requested type under another name, is a conflict: stop, do not add a second copy.
For a matching extension compare Workspace ID, train and namespace set.
An omitted namespace list means only `default`; unreadable settings are not a
match. Different settings block installation. Never delete, upgrade, adopt or
rebind an existing extension. Namespace changes require a separately approved
removal/reinstallation maintenance task under the public guide.

For matching settings, skip create and verify. Observe in-progress installations
without resubmitting. For failed or partial installations, diagnose first. The
public guide permits repeating the same create after correcting the cause:
disclose retained resources and obtain fresh approval before that retry.
After ambiguous write timeouts, inspect extension, role and connection state
before any further write. Never auto-retry or clean up.
An orphan Workspace connection is a support blocker, not permission to adopt
its identity or remove it.

## 4. Preview and obtain explicit approval

Prepare, but do not execute:

```powershell
$configuration = @("chaos-workspace-id=$workspaceId")
for ($i = 0; $i -lt $targetNamespaces.Count; $i++) {
    $configuration += "experiments.targetNamespaces[$i]=$($targetNamespaces[$i])"
}
$createArgs = @('k8s-extension', 'create') + $clusterArgs + @(
    '--name', 'chaos-studio',
    '--extension-type', 'Microsoft.ChaosStudio',
    '--release-train', 'dev',
    '--configuration-settings'
) + $configuration
```

Show exact tenant/cloud, subscriptions, AKS/Workspace IDs, namespaces, train,
discovered version availability, prerequisite results, capability limitations
and the complete argument list. Explain the bundled persistent changes:

- Extension and Kubernetes resources in `chaos-infrastructure`.
- Subscriber managed identity in the AKS node resource group and a federated
  identity credential; the subscriber receives no Azure role assignments.
- Built-in **Chaos Kubernetes Extension Operator** role assigned to the
  Workspace identity at cluster scope.
- A `Microsoft.Chaos/workspaces/connections` Workspace connection.

Require explicit approval of installation **and identity, role and connection
changes**. Ask the customer to type
`Install chaos-studio on <full-AKS-resource-ID> for <full-Workspace-resource-ID>`
with the actual IDs substituted. No flag, environment variable or autonomous
mode can supply consent. Missing or declined approval means no writes.
Re-read account, AKS, Workspace and extension state immediately before execution.
Any plan-affecting drift invalidates approval; show a fresh plan.

## 5. Install and verify

Only after approval:

```powershell
& az @createArgs
```

Do not use `--no-wait`. The CLI orchestrates extension installation, permissions
and connection creation; do not replace it with a bare ARM PUT or duplicate
onboarding manually. A zero exit code alone is not success.

```powershell
az k8s-extension show @clusterArgs --name chaos-studio --output json
kubectl --kubeconfig $kubeconfigPath get pods `
    --namespace chaos-infrastructure --output json
kubectl --kubeconfig $kubeconfigPath get deployments,daemonsets `
    --namespace chaos-infrastructure --output json
```

Observe every 15 seconds for at most 15 minutes. Require extension provisioning
`Succeeded`; stop on `Failed`, `Canceled` or deletion. At timeout report pending
or unknown and leave resources intact. Require a nonempty pod list including
running, container-ready `chaos-operator` and `chaos-subscriber`, with their
deployments fully available. When enabled, require the daemon's desired count
to be nonzero and equal its ready count, and a ready daemon pod on each eligible
Linux amd64 node. If `chaosDaemon.enabled` is false, report network faults as
unavailable; absent daemon pods are acceptable only if that limitation was
approved. Ambiguous daemon configuration requires investigation.

Read back Workspace ID and namespace settings. Verify the Workspace identity's
documented role at cluster scope and the corresponding Workspace connection
using the current public read/list interface. Do not invent a connection name,
API version or endpoint if that read surface is unavailable; report verification
as blocked. Missing roles or connection mean incomplete onboarding.

Report provisioning, Kubernetes readiness, identity/RBAC verification and
connection existence/status separately. Connection `Pending` is a documented
known issue; alone it proves neither failure nor end-to-end connectivity.
Never create a Scenario or run a fault as an installation check.

On failure, collect relevant read-only diagnostics (extension errors, pod and
rollout states, namespace events), retain resources, and report the failed phase
and residue with a link to public troubleshooting or Azure support. Do not
delete/reinstall, restart pods, change policies or grant roles as repair.
Always restore environment variables and remove only the session-local
credential file created by this skill.

## Completion

Return resource IDs, extension name/type/train and observed version, namespaces,
whether an existing installation was reused, each verification result, daemon
capability and remaining blockers. If any required check failed or was blocked,
label installation incomplete instead of claiming readiness.
State: **No fault was run; end-to-end execution is unverified.**
