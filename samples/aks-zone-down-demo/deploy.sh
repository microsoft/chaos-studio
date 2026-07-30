#!/usr/bin/env bash
# Deploys the AKS zone-down demo: a zone-redundant AKS cluster running the
# AKS store demo sample app. See README.md in this folder.
set -euo pipefail

RESOURCE_GROUP="${RESOURCE_GROUP:-chaos-demo-rg}"
LOCATION="${LOCATION:-eastus2}"
CLUSTER_NAME="${CLUSTER_NAME:-chaos-demo-aks}"
# Pinned to a release so the demo doesn't drift with upstream main; override if needed.
MANIFEST_URL="${MANIFEST_URL:-https://raw.githubusercontent.com/Azure-Samples/aks-store-demo/2.2.0/aks-store-quickstart.yaml}"

echo "==> Creating resource group '$RESOURCE_GROUP' in $LOCATION"
az group create --name "$RESOURCE_GROUP" --location "$LOCATION" \
  --tags chaos-demo=aks-zone-down-demo --output none

echo "==> Creating AKS cluster '$CLUSTER_NAME' (3 nodes across zones 1-3; takes a few minutes)"
az aks create \
  --resource-group "$RESOURCE_GROUP" \
  --name "$CLUSTER_NAME" \
  --node-count 3 \
  --zones 1 2 3 \
  --generate-ssh-keys \
  --output none

echo "==> Connecting kubectl"
az aks get-credentials --resource-group "$RESOURCE_GROUP" --name "$CLUSTER_NAME" --overwrite-existing

echo "==> Deploying the AKS store demo app (default single-replica deployments -- that's the point)"
kubectl apply -f "$MANIFEST_URL"

echo "==> Waiting for the storefront rollout"
kubectl rollout status deployment/store-front --timeout=300s

echo "==> Waiting for the storefront public IP (can take a couple of minutes)"
STORE_IP=""
for _ in $(seq 1 60); do
  STORE_IP="$(kubectl get service store-front -o jsonpath='{.status.loadBalancer.ingress[0].ip}' 2>/dev/null || true)"
  [ -n "$STORE_IP" ] && break
  sleep 10
done

NODE_RG="$(az aks show --resource-group "$RESOURCE_GROUP" --name "$CLUSTER_NAME" --query nodeResourceGroup -o tsv)"

STORE_NODE="$(kubectl get pods -l app=store-front -o jsonpath='{.items[0].spec.nodeName}' 2>/dev/null || true)"
STORE_ZONE=""
if [ -n "$STORE_NODE" ]; then
  STORE_ZONE="$(kubectl get node "$STORE_NODE" -o jsonpath='{.metadata.labels.topology\.kubernetes\.io/zone}' 2>/dev/null || true)"
fi

echo
echo "Done."
echo
if [ -n "$STORE_IP" ]; then
  echo "  Storefront:                    http://$STORE_IP"
else
  echo "  Storefront IP still pending -- check with: kubectl get service store-front"
fi
echo "  Infrastructure resource group: $NODE_RG"
if [ -n "$STORE_ZONE" ]; then
  echo "  store-front pod zone:          $STORE_ZONE  <- target this zone (the number after the region) to break the app"
else
  echo "  store-front pod zone:          check with: kubectl get pods -l app=store-front -o wide"
fi
echo
echo "Next: create a Chaos Studio Workspace scoped to '$NODE_RG' and run the"
echo "Compute Zone Down scenario against the store-front zone:"
echo "https://learn.microsoft.com/azure/chaos-studio/chaos-studio-tutorial-sample-app#create-a-workspace-scoped-to-the-infrastructure-resource-group"
