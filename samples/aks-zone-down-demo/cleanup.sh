#!/usr/bin/env bash
# Removes everything the AKS zone-down demo created. Deleting the resource
# group also removes the cluster's MC_* infrastructure resource group and the
# workspace (if you created it in the same resource group, per the tutorial).
set -euo pipefail

RESOURCE_GROUP="${RESOURCE_GROUP:-chaos-demo-rg}"
CLUSTER_NAME="${CLUSTER_NAME:-chaos-demo-aks}"

# Only delete groups that deploy.sh created (identified by its tag), so a
# pre-existing group with the same name can't be wiped by accident.
TAG="$(az group show --name "$RESOURCE_GROUP" --query 'tags."chaos-demo"' -o tsv 2>/dev/null || true)"
if [ "$TAG" != "aks-zone-down-demo" ]; then
  echo "Refusing to delete '$RESOURCE_GROUP': it doesn't carry the chaos-demo=aks-zone-down-demo tag,"
  echo "so it wasn't created by deploy.sh. If you're sure, delete it yourself:"
  echo "  az group delete --name $RESOURCE_GROUP"
  exit 1
fi

if [ "${FORCE:-0}" != "1" ]; then
  read -r -p "Delete resource group '$RESOURCE_GROUP' and everything in it? Type the group name to confirm: " CONFIRM
  if [ "$CONFIRM" != "$RESOURCE_GROUP" ]; then
    echo "Aborted."
    exit 1
  fi
fi

echo "==> Deleting resource group '$RESOURCE_GROUP'"
az group delete --name "$RESOURCE_GROUP" --yes --no-wait

echo "==> Removing kubectl context"
kubectl config delete-context "$CLUSTER_NAME" 2>/dev/null || true
kubectl config delete-cluster "$CLUSTER_NAME" 2>/dev/null || true

echo "Deletion is running in the background (az group delete --no-wait)."
