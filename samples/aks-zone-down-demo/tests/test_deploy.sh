#!/usr/bin/env bash
set -euo pipefail

SAMPLE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_DIR="$(mktemp -d)"
trap 'rm -rf "$TEST_DIR"' EXIT

mkdir -p "$TEST_DIR/bin"

cat >"$TEST_DIR/bin/az" <<'EOF'
#!/usr/bin/env bash
printf 'az' >>"$COMMAND_LOG"
printf ' <%s>' "$@" >>"$COMMAND_LOG"
printf '\n' >>"$COMMAND_LOG"

case "$1 $2" in
  "group create")
    ;;
  "aks create")
    exit "${AKS_CREATE_STATUS:-0}"
    ;;
  "aks get-credentials")
    ;;
  "aks show")
    printf 'MC_test-rg_test-aks_eastus2\n'
    ;;
  *)
    echo "Unexpected az command: $*" >&2
    exit 90
    ;;
esac
EOF

cat >"$TEST_DIR/bin/kubectl" <<'EOF'
#!/usr/bin/env bash
printf 'kubectl' >>"$COMMAND_LOG"
printf ' <%s>' "$@" >>"$COMMAND_LOG"
printf '\n' >>"$COMMAND_LOG"

case "$1" in
  apply|rollout)
    ;;
  get)
    case "$2" in
      service)
        printf '192.0.2.10'
        ;;
      pods)
        printf 'node-1'
        ;;
      node)
        printf 'eastus2-1'
        ;;
      *)
        echo "Unexpected kubectl get resource: $2" >&2
        exit 91
        ;;
    esac
    ;;
  *)
    echo "Unexpected kubectl command: $*" >&2
    exit 92
    ;;
esac
EOF

chmod +x "$TEST_DIR/bin/az" "$TEST_DIR/bin/kubectl"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

assert_log_contains() {
  grep -F -- "$1" "$COMMAND_LOG" >/dev/null || fail "missing command fragment: $1"
}

assert_log_excludes() {
  if grep -F -- "$1" "$COMMAND_LOG" >/dev/null; then
    fail "unexpected command fragment: $1"
  fi
}

run_deploy() {
  : >"$COMMAND_LOG"
  PATH="$TEST_DIR/bin:$PATH" \
    RESOURCE_GROUP=test-rg \
    LOCATION=eastus2 \
    CLUSTER_NAME=test-aks \
      NODE_VM_SIZE="${NODE_VM_SIZE:-}" \
      AKS_CREATE_STATUS="${AKS_CREATE_STATUS:-}" \
      MANIFEST_URL=https://example.test/manifest.yaml \
      "$SAMPLE_DIR/deploy.sh"
}

COMMAND_LOG="$TEST_DIR/commands.log"
export COMMAND_LOG

run_deploy >"$TEST_DIR/default.out" 2>"$TEST_DIR/default.err"
assert_log_contains "az <aks> <create> <--resource-group> <test-rg> <--name> <test-aks> <--node-count> <3> <--zones> <1> <2> <3>"
assert_log_excludes "<--node-vm-size>"
assert_log_excludes "<list-skus>"

NODE_VM_SIZE=Standard_D2s_v5 run_deploy >"$TEST_DIR/override.out" 2>"$TEST_DIR/override.err"
assert_log_contains "<--node-vm-size> <Standard_D2s_v5>"
assert_log_contains "<--zones> <1> <2> <3>"
assert_log_excludes "<list-skus>"

set +e
AKS_CREATE_STATUS=42 run_deploy >"$TEST_DIR/failure.out" 2>"$TEST_DIR/failure.err"
status=$?
set -e

[ "$status" -eq 42 ] || fail "expected az aks create status 42, got $status"
grep -F "use the Azure error above" "$TEST_DIR/failure.err" >/dev/null ||
  fail "failure guidance does not preserve the Azure error"
grep -F "SKU listings describe support and restrictions, not guaranteed deployment capacity." \
  "$TEST_DIR/failure.err" >/dev/null ||
  fail "failure guidance misrepresents SKU listings as live capacity"
assert_log_excludes "kubectl"

echo "deploy.sh tests passed"
