#!/usr/bin/env bash
# Blocks Run 2 until the fix (3 replicas, hard per-zone topology spread) has
# actually taken effect -- not merely applied. Follow the canonical Learn fix:
# https://learn.microsoft.com/azure/chaos-studio/chaos-studio-tutorial-sample-app#fix-the-deployment-and-verify-it
#
# Two checks, in order:
#   1. kubectl rollout status: waits out the rolling update so stale pods
#      from the old single-replica revision aren't counted.
#   2. monitor.py --mode verify: confirms every cluster zone has at least
#      one Ready store-front replica, using the same parsing logic the live
#      dashboard uses (and that tests/test_monitor.py exercises directly).
set -euo pipefail

DEPLOYMENT="${DEPLOYMENT:-store-front}"
NAMESPACE="${NAMESPACE:-default}"
LABEL_SELECTOR="${LABEL_SELECTOR:-app=store-front}"
TIMEOUT_SECONDS="${TIMEOUT_SECONDS:-300}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LEARN_FIX_URL="https://learn.microsoft.com/azure/chaos-studio/chaos-studio-tutorial-sample-app#fix-the-deployment-and-verify-it"

echo "==> Waiting for the store-front rollout to finish (clears stale pods from the old single-replica revision)"
kubectl rollout status "deployment/${DEPLOYMENT}" -n "$NAMESPACE" --timeout="${TIMEOUT_SECONDS}s"

echo "==> Verifying one Ready store-front replica lands in every zone (accounts for rolling-update stragglers)"
if ! python3 "$SCRIPT_DIR/monitor.py" --mode verify \
      --label-selector "$LABEL_SELECTOR" --namespace "$NAMESPACE" --timeout "$TIMEOUT_SECONDS"; then
  echo
  echo "Fix verification FAILED -- do not start Run 2 yet." >&2
  echo "Review the canonical fix procedure: $LEARN_FIX_URL" >&2
  exit 1
fi

echo
echo "Fix verified. Safe to start Run 2 against the same target zone."
