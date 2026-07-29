#!/usr/bin/env bash
# Removes everything the AKS zone-down demo created. Deleting the resource
# group also removes the cluster's MC_* infrastructure resource group and the
# workspace (if you created it in the same resource group, per the tutorial).
set -euo pipefail

RESOURCE_GROUP="${RESOURCE_GROUP:-chaos-demo-rg}"
CLUSTER_NAME="${CLUSTER_NAME:-chaos-demo-aks}"

echo "==> Deleting resource group '$RESOURCE_GROUP'"
az group delete --name "$RESOURCE_GROUP" --yes --no-wait

echo "==> Removing kubectl context"
kubectl config delete-context "$CLUSTER_NAME" 2>/dev/null || true
kubectl config delete-cluster "$CLUSTER_NAME" 2>/dev/null || true

echo "Deletion is running in the background (az group delete --no-wait)."
