#!/usr/bin/env bash
# Deploys the AKS zone-down demo: a zone-redundant AKS cluster running the
# AKS store demo sample app. See README.md in this folder.
set -euo pipefail

RESOURCE_GROUP="${RESOURCE_GROUP:-chaos-demo-rg}"
LOCATION="${LOCATION:-eastus2}"
CLUSTER_NAME="${CLUSTER_NAME:-chaos-demo-aks}"
# Pinned to a release so the demo doesn't drift with upstream main; override if needed.
MANIFEST_URL="${MANIFEST_URL:-https://raw.githubusercontent.com/Azure-Samples/aks-store-demo/2.2.0/aks-store-quickstart.yaml}"
ZONE_LABEL="topology.kubernetes.io/zone"

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

echo "==> Deploying the AKS store demo app (default single-replica deployments)"
kubectl apply -f "$MANIFEST_URL"

echo "==> Waiting for the storefront rollout"
kubectl rollout status deployment/store-front --timeout=300s

echo "==> DEMO SETUP (deliberate anti-pattern): pinning the single store-front"
echo "    replica to one zone so Run 1 is deterministic. This is NOT a"
echo "    resilience recommendation -- it is staged breakage for teaching,"
echo "    and it's removed as part of the fix (README.md step 6)."
STORE_NODE="$(kubectl get pods -l app=store-front -o jsonpath='{.items[0].spec.nodeName}')"
PIN_ZONE="$(kubectl get node "$STORE_NODE" -o jsonpath="{.metadata.labels['${ZONE_LABEL//./\\.}']}")"
if [ -z "$PIN_ZONE" ]; then
  echo "Could not read the store-front node's zone label; aborting the pin." >&2
  exit 1
fi

kubectl patch deployment store-front --patch "$(cat <<EOF
{
  "metadata": {
    "annotations": {
      "chaos-demo.aks-zone-down-demo/deliberate-anti-pattern": "Pins the single front-end replica to zone ${PIN_ZONE} so Run 1 is deterministic. Remove this pin as part of the fix (README.md step 6) -- do not carry it into a real deployment."
    }
  },
  "spec": {
    "template": {
      "spec": {
        "affinity": {
          "nodeAffinity": {
            "requiredDuringSchedulingIgnoredDuringExecution": {
              "nodeSelectorTerms": [
                {
                  "matchExpressions": [
                    {"key": "${ZONE_LABEL}", "operator": "In", "values": ["${PIN_ZONE}"]}
                  ]
                }
              ]
            }
          }
        }
      }
    }
  }
}
EOF
)"

echo "==> Restarting the rollout so the pinned pod (re)schedules deterministically"
kubectl rollout restart deployment/store-front
kubectl rollout status deployment/store-front --timeout=300s

# Sanity-check the pin actually held -- if it didn't, Run 1 won't be
# deterministic and the demo shouldn't proceed silently.
STORE_NODE="$(kubectl get pods -l app=store-front -o jsonpath='{.items[0].spec.nodeName}')"
STORE_ZONE="$(kubectl get node "$STORE_NODE" -o jsonpath="{.metadata.labels['${ZONE_LABEL//./\\.}']}")"
if [ "$STORE_ZONE" != "$PIN_ZONE" ]; then
  echo "Expected the pinned pod in zone $PIN_ZONE but found it in '$STORE_ZONE'." >&2
  exit 1
fi

echo "==> Waiting for the storefront public IP (can take a couple of minutes)"
STORE_IP=""
for _ in $(seq 1 60); do
  STORE_IP="$(kubectl get service store-front -o jsonpath='{.status.loadBalancer.ingress[0].ip}' 2>/dev/null || true)"
  [ -n "$STORE_IP" ] && break
  sleep 10
done

NODE_RG="$(az aks show --resource-group "$RESOURCE_GROUP" --name "$CLUSTER_NAME" --query nodeResourceGroup -o tsv)"

echo
echo "Done."
echo
if [ -n "$STORE_IP" ]; then
  echo "  Storefront:                    http://$STORE_IP"
else
  echo "  Storefront IP still pending -- check with: kubectl get service store-front"
fi
echo "  Infrastructure resource group: $NODE_RG"
echo "  store-front PINNED zone:       $STORE_ZONE  <- target this zone (the number after the region) for Run 1"
echo "  (the pin is deliberate demo setup -- remove it when you apply the fix, README.md step 6)"
echo
echo "Next: create a Chaos Studio Workspace scoped to '$NODE_RG' and run the"
echo "Compute Zone Down scenario against the store-front zone:"
echo "https://learn.microsoft.com/azure/chaos-studio/chaos-studio-tutorial-sample-app#create-a-workspace-scoped-to-the-infrastructure-resource-group"
echo
if [ -n "$STORE_IP" ]; then
  echo "Start the live monitor before Run 1:"
  echo "  python3 monitor.py --storefront-url http://$STORE_IP --target-zone $STORE_ZONE"
fi
