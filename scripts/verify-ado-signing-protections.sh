#!/usr/bin/env bash
# verify-ado-signing-protections.sh — one-shot verifier for the EXTERNAL Azure DevOps
# controls that bind the OneBranch extension SIGNING and PUBLISH to the trusted branch.
# The `onebranch.pipeline.signing@1` task takes NO service connection, so ESRP signing is
# gated by the pipeline ENVIRONMENT the build_sign stage is associated with (default
# `ChaosStudio-ESRP-Signing-Prod`); Marketplace PUBLISH is gated by the `ADO-Plugin
# Publishing` service-connection ENDPOINT. Neither the in-YAML branch conditions nor
# PublishBranch are authoritative (a manual run loads the YAML from the SELECTED branch), so
# the ENFORCED gate must live on those concrete resources: (1) Approvals-and-checks ->
# Branch Control limited to the trusted branch (identified by the immutable task, not a
# display name), (2) Security -> Pipeline permissions restricted to EXACTLY the official
# pipeline, and (3) for publish, a required Approval. This script CONFIRMS them on each named
# resource — the live half that a worktree file cannot itself enforce.
#
# Requires: curl and jq. Authenticated via AZURE_DEVOPS_EXT_PAT (a PAT with
# Service Connections: Read + Environment: Read + Pipeline resources: Read + Build: Read — Build:
# Read is required to read the official build definition's repository identity / default branch /
# YAML path) sent as HTTP Basic auth (`Authorization: Basic base64(:PAT)`, i.e. empty username) to
# the Azure DevOps REST API on dev.azure.com. The PAT is the credential the API actually consumes —
# there is no Entra/`az login` fallback, so a missing or unscoped PAT fails the run rather than
# silently authenticating as some other identity. It makes only READ calls; it changes nothing.
#
# Usage:
#   scripts/verify-ado-signing-protections.sh ORG_URL PROJECT OFFICIAL_PIPELINE_ID \
#       [SIGNING_ENVIRONMENT] [PUBLISH_SC] [TRUSTED_BRANCH]
# e.g. scripts/verify-ado-signing-protections.sh https://dev.azure.com/msazure One 1234 \
#         ChaosStudio-ESRP-Signing-Prod "ADO-Plugin Publishing" refs/heads/main
#
# OFFICIAL_PIPELINE_ID (REQUIRED) is the numeric build-definition id of the sole official
# pipeline that may consume the signing + publish resources; the verifier fails unless each
# resource authorizes EXACTLY that pipeline and no other. BRANCH_CONTROL_TASK_ID (env,
# default is the well-known Branch Control task GUID) is the IMMUTABLE task id that
# implements the Branch Control check — the check is identified by that GUID (and must pin a
# task version), NOT by a user-settable display name or mutable task name, so a
# display-name-spoofed no-op check cannot pass. Override it only if your ADO instance
# registered the check under a different task id.
#
# REQUIRED environment for a faithful check:
#   BRANCH_CONTROL_TASK_VERSION   the pinned Branch Control task version (definitionRef.version)
#                                 the reviewed check records — the FULL version string ADO stores,
#                                 e.g. "0.0.1" (NOT a major-only "0"); an unpinned/version-drifted
#                                 check fails closed.
#   EXPECTED_REPOSITORY_ID        the IMMUTABLE repository id (.repository.id) the official build
#                                 definition must point at (a repo-swapped definition that keeps
#                                 the reviewed YAML path is otherwise undetected).
#   EXPECTED_REPOSITORY_TYPE      the repository type (.repository.type, e.g. "TfsGit") so a
#                                 same-id/name repository of a different provider is rejected.
# Optional: EXPECTED_REPOSITORY_NAME (extra mutable-name check), EXPECTED_YAML_PATH (default
# .pipelines/OneBranch.Official.yml).
#
# The Branch Control check is verified with the CORRECT ADO wire semantics: a Task Check's
# settings.inputs are STRINGS ("refs/heads/main"/"true"/"false"). The verifier requires
# allowedBranches == TRUSTED_BRANCH, ensureProtectionOfBranch == "true" (each allowed branch must
# itself carry a protection policy), and the SINGULAR allowUnknownStatusBranch absent or "false".
#
# `set -e` is intentionally NOT used so a single failed API/jq call cannot abort the run
# before the aggregate report. `fail` is an incrementing ERROR COUNT; the script exits
# nonzero only at the final aggregate.
set -uo pipefail

ORG="${1:-}"
PROJECT="${2:-}"
OFFICIAL_PIPELINE_ID="${3:-}"
SIGNING_ENV="${4:-ChaosStudio-ESRP-Signing-Prod}"
PUBLISH_SC="${5:-ADO-Plugin Publishing}"
TRUSTED_BRANCH="${6:-refs/heads/main}"
# The expected YAML file path of the OFFICIAL pipeline definition, used to machine-verify that
# OFFICIAL_PIPELINE_ID actually maps to the reviewed OneBranch.Official pipeline (not a swapped
# definition). ADO stores the path with a leading slash; comparison is slash-insensitive.
EXPECTED_YAML_PATH="${EXPECTED_YAML_PATH:-.pipelines/OneBranch.Official.yml}"
# The IMMUTABLE task GUID implementing the Branch Control check (not a display/task name).
# Default is the well-known "Evaluate Branch Protection" (Branch control) task id.
BRANCH_CONTROL_TASK_ID="${BRANCH_CONTROL_TASK_ID:-86b05a0c-73e6-4f7d-b3cf-e38f3b39a75b}"
# MANDATORY pinned Branch Control task version (definitionRef.version). ADO records the check's
# FULL task version string (e.g. `0.0.1`), NOT a major-only `0` — set this to the exact version
# ADO reports for the reviewed check. The check's version MUST equal it exactly (an unpinned or
# version-drifted check is not the reviewed definition); an unset value fails at startup and an
# empty/differing version fails closed.
BRANCH_CONTROL_TASK_VERSION="${BRANCH_CONTROL_TASK_VERSION:-}"
# IMMUTABLE repository identity + TYPE of the OFFICIAL pipeline's build definition. A swapped
# definition that keeps the same YAML PATH but points at a DIFFERENT repository (an attacker fork,
# or a same-named repo in another provider) is caught only by pinning the IMMUTABLE repository id
# (`.repository.id`, MANDATORY) AND its type (`.repository.type`, e.g. `TfsGit` for Azure Repos,
# MANDATORY — the name is mutable so it is an optional extra check). Each set value must match the
# definition's repository EXACTLY.
EXPECTED_REPOSITORY_ID="${EXPECTED_REPOSITORY_ID:-}"
EXPECTED_REPOSITORY_TYPE="${EXPECTED_REPOSITORY_TYPE:-}"
EXPECTED_REPOSITORY_NAME="${EXPECTED_REPOSITORY_NAME:-}"
if [[ -z "$ORG" || -z "$PROJECT" || -z "$OFFICIAL_PIPELINE_ID" ]]; then
  echo "usage: $0 ORG_URL PROJECT OFFICIAL_PIPELINE_ID [SIGNING_ENVIRONMENT] [PUBLISH_SC] [TRUSTED_BRANCH]" >&2
  exit 2
fi
if [[ ! "$OFFICIAL_PIPELINE_ID" =~ ^[0-9]+$ ]]; then
  echo "OFFICIAL_PIPELINE_ID must be the numeric pipeline (build definition) id." >&2
  exit 2
fi
if [[ ! "$BRANCH_CONTROL_TASK_ID" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]]; then
  echo "BRANCH_CONTROL_TASK_ID must be a task GUID (immutable id), not a name." >&2
  exit 2
fi
# MANDATORY pinned Branch Control task version — an unpinned verifier cannot prove the check
# runs the reviewed, immutable task definition.
if [[ -z "$BRANCH_CONTROL_TASK_VERSION" ]]; then
  echo "BRANCH_CONTROL_TASK_VERSION is REQUIRED: set it to the pinned Branch Control task version (definitionRef.version, e.g. '0.0.1') ADO reports for the reviewed check." >&2
  exit 2
fi
# MANDATORY immutable repository identity + type so a repository-swapped definition with the same
# YAML path cannot pass the official-pipeline identity check.
if [[ -z "$EXPECTED_REPOSITORY_ID" ]]; then
  echo "EXPECTED_REPOSITORY_ID is REQUIRED: pin the IMMUTABLE repository id (.repository.id) the official pipeline must build." >&2
  exit 2
fi
if [[ -z "$EXPECTED_REPOSITORY_TYPE" ]]; then
  echo "EXPECTED_REPOSITORY_TYPE is REQUIRED: pin the repository type (.repository.type, e.g. 'TfsGit') so a same-id/name repo of a different provider is rejected." >&2
  exit 2
fi

fail=0
err() { echo "::error::$*"; fail=$((fail + 1)); }
ok() { echo "OK: $*"; }

if ! command -v curl >/dev/null 2>&1; then
  err "curl is not installed; cannot call the Azure DevOps REST API to verify signing/publish protections."
  echo "::error::One or more required ADO signing/publish protections could not be verified." >&2
  exit 1
fi
if ! command -v jq >/dev/null 2>&1; then
  err "jq is not installed; cannot parse the Azure DevOps REST responses."
  echo "::error::One or more required ADO signing/publish protections could not be verified." >&2
  exit 1
fi
if [[ -z "${AZURE_DEVOPS_EXT_PAT:-}" ]]; then
  err "AZURE_DEVOPS_EXT_PAT is not set; the REST calls authenticate with a PAT (Basic auth) that has Service Connections: Read + Environment: Read + Pipeline resources: Read."
  echo "::error::One or more required ADO signing/publish protections could not be verified." >&2
  exit 1
fi

# Host for the Azure DevOps REST API. ORG is a full URL like https://dev.azure.com/<org>.
# The PAT is sent as HTTP Basic auth with an EMPTY username (`-u ":$PAT"`), which is the
# credential the dev.azure.com REST API consumes — no Entra token is ever used. `-f` makes a
# non-2xx response a nonzero exit (so a 401/403 from an unscoped PAT fails closed rather than
# being parsed as an empty-but-valid result).
api() { curl -fsS --max-time 60 -u ":${AZURE_DEVOPS_EXT_PAT}" -H 'Accept: application/json' "$1" 2>/dev/null; }

# Resolve a service connection (endpoint) id by exact name within the project.
endpoint_id() {
  local name="$1" json
  json="$(api "${ORG}/${PROJECT}/_apis/serviceendpoint/endpoints?endpointNames=$(jq -rn --arg n "$name" '$n|@uri')&api-version=7.1-preview.4")" || return 1
  # Require EXACTLY one endpoint of that exact name.
  local n
  n="$(printf '%s' "$json" | jq -r '[.value[]? | select(.name == $nm)] | length' --arg nm "$name" 2>/dev/null)"
  if [[ "$n" != "1" ]]; then
    return 2
  fi
  printf '%s' "$json" | jq -r '.value[] | select(.name == $nm) | .id' --arg nm "$name"
}

# Resolve a pipeline ENVIRONMENT id by exact name within the project. Environments live in
# the DISTRIBUTED TASK area (`_apis/distributedtask/environments`), NOT under
# `_apis/pipelines` — the wrong route returns 404/empty and would falsely fail (or, worse,
# be misread). Require EXACTLY one environment of that exact name.
environment_id() {
  local name="$1" json n
  json="$(api "${ORG}/${PROJECT}/_apis/distributedtask/environments?name=$(jq -rn --arg n "$name" '$n|@uri')&api-version=7.1-preview.1")" || return 1
  n="$(printf '%s' "$json" | jq -r '[.value[]? | select(.name == $nm)] | length' --arg nm "$name" 2>/dev/null)"
  if [[ "$n" != "1" ]]; then
    return 2
  fi
  printf '%s' "$json" | jq -r '.value[] | select(.name == $nm) | .id' --arg nm "$name"
}

# Verify a concrete protected RESOURCE (a service-connection `endpoint` or a pipeline
# `environment`) carries the required, EXACTLY-configured protections:
#  (a) a Branch Control check identified by its immutable TASK (not a display name),
#      ENABLED, with allowedBranches limited to EXACTLY the trusted branch and no
#      permissive "allow unknown status branches";
#  (b) pipeline permissions authorizing EXACTLY the one official pipeline and no other
#      (and NOT open to all pipelines);
#  (c) for the publish resource, an Approval check with at least one approver.
# $1=label  $2=kind(endpoint|environment)  $3=name  $4=require_approval(yes/no)
verify_resource() {
  local label="$1" kind="$2" name="$3" require_approval="$4" before=$fail id checks
  if [[ "$kind" == "environment" ]]; then
    if ! id="$(environment_id "$name")" || [[ -z "$id" ]]; then
      err "${label}: could not resolve EXACTLY one pipeline environment named '${name}' in ${ORG}/${PROJECT} (needs Environment: Read)."
      return
    fi
  else
    if ! id="$(endpoint_id "$name")" || [[ -z "$id" ]]; then
      err "${label}: could not resolve EXACTLY one service connection named '${name}' in ${ORG}/${PROJECT} (needs Service Connections: Read)."
      return
    fi
  fi

  checks="$(api "${ORG}/${PROJECT}/_apis/pipelines/checks/configurations?resourceType=${kind}&resourceId=${id}&api-version=7.1-preview.1&\$expand=settings")"
  if [[ -z "$checks" ]] || ! printf '%s' "$checks" | jq -e '.value' >/dev/null 2>&1; then
    err "${label}: Approvals-and-checks for '${name}' are not readable (needs the checks read scope); protections cannot be confirmed."
    return
  fi

  # (a) BRANCH CONTROL — identified by the IMMUTABLE task GUID (definitionRef.id), NEVER by
  # a user-settable displayName OR the mutable task name. Require EXACTLY ONE such check
  # (so a permissive second branch-control check cannot widen access), a NON-EMPTY pinned
  # task VERSION (definitionRef.version), allowedBranches limited to EXACTLY the trusted
  # branch, ensureProtectionOfBranch enabled (the branch must itself be policy-protected), and
  # no permissive unknown-status allowance.
  #
  # WIRE SEMANTICS: a Task Check's `settings.inputs` values are STRINGS in Azure DevOps
  # (task inputs are string-typed), so allowedBranches/ensureProtectionOfBranch/
  # allowUnknownStatusBranch are the strings "refs/heads/main"/"true"/"false" — NOT JSON
  # booleans. They are normalized via `tostring | ascii_downcase` and compared as strings; an
  # unrecognized value fails closed. The unknown-status input is the SINGULAR
  # `allowUnknownStatusBranch` (the Branch Control task's actual input name).
  local bcCount bc allowed allowUnknown ensureProtection bcVersion bcEnabled
  bcCount="$(printf '%s' "$checks" | jq -r --arg id "$BRANCH_CONTROL_TASK_ID" \
    '[.value[]? | select(.type.name == "Task Check") | select((.settings.definitionRef.id // "") == $id)] | length' 2>/dev/null)"
  if [[ "$bcCount" != "1" ]]; then
    err "${label}: '${name}' must have EXACTLY ONE Branch Control check with the immutable task id '${BRANCH_CONTROL_TASK_ID}', found ${bcCount:-0} (a display-name/task-name-only 'Branch control' does not count)."
  else
    bc="$(printf '%s' "$checks" | jq -c --arg id "$BRANCH_CONTROL_TASK_ID" \
      '.value[] | select(.type.name == "Task Check") | select((.settings.definitionRef.id // "") == $id)' 2>/dev/null)"
    # ENABLED requires the EXACT boolean `isDisabled: false` — `has(...) and (.isDisabled == false)`
    # is true ONLY for a real boolean false, so a missing property, a null, a "false" STRING, or
    # a `0` all FAIL CLOSED (they cannot prove the check is enabled).
    bcEnabled="$(printf '%s' "$bc" | jq -r 'has("isDisabled") and (.isDisabled == false)' 2>/dev/null)"
    bcVersion="$(printf '%s' "$bc" | jq -r '(.settings.definitionRef.version // "") | tostring' 2>/dev/null)"
    allowed="$(printf '%s' "$bc" | jq -r '(.settings.inputs.allowedBranches // "") | tostring' 2>/dev/null)"
    # ensureProtectionOfBranch: the string "true" mandates that each allowed branch itself has a
    # protection policy (so a merely-named allowed branch with no policy is rejected). Anything
    # other than "true" (absent/"false"/other) FAILS — it is a required control, not optional.
    ensureProtection="$(printf '%s' "$bc" | jq -r '(.settings.inputs.ensureProtectionOfBranch // "") | tostring | ascii_downcase' 2>/dev/null)"
    # PERMISSIVE unknown-status allowance — the SINGULAR `allowUnknownStatusBranch` STRING input.
    # Absent (ADO default) or "false" is safe; "true" permits branches whose protection status is
    # unknown; any other value is untrusted and fails closed (its meaning cannot be proven).
    allowUnknown="$(printf '%s' "$bc" | jq -r \
      '(.settings.inputs.allowUnknownStatusBranch) as $v | if $v == null then "absent" else ($v | tostring | ascii_downcase) end' 2>/dev/null)"
    if [[ "$bcEnabled" != "true" ]]; then
      err "${label}: '${name}' Branch Control check (task ${BRANCH_CONTROL_TASK_ID}) is not verifiably ENABLED (isDisabled must be the exact boolean false); fail closed."
    elif [[ -z "$bcVersion" || "$bcVersion" == "null" ]]; then
      err "${label}: '${name}' Branch Control check does not pin a task version (definitionRef.version); an unpinned check is not the exact enabled definition."
    elif [[ "$bcVersion" != "$BRANCH_CONTROL_TASK_VERSION" ]]; then
      err "${label}: '${name}' Branch Control check pins task version '${bcVersion}', not the required '${BRANCH_CONTROL_TASK_VERSION}'."
    elif [[ "$allowed" != "$TRUSTED_BRANCH" ]]; then
      err "${label}: '${name}' Branch Control allowedBranches is '${allowed}', not exactly '${TRUSTED_BRANCH}'."
    elif [[ "$ensureProtection" != "true" ]]; then
      err "${label}: '${name}' Branch Control does not require branch protection (ensureProtectionOfBranch='${ensureProtection}', must be 'true'); an allowed branch with no protection policy would pass."
    elif [[ "$allowUnknown" == "true" ]]; then
      err "${label}: '${name}' Branch Control permits unknown-status branches (allowUnknownStatusBranch=true); it must not."
    elif [[ "$allowUnknown" != "absent" && "$allowUnknown" != "false" ]]; then
      err "${label}: '${name}' Branch Control allowUnknownStatusBranch is an unrecognized value ('${allowUnknown}'); its effective meaning cannot be proven — fail closed."
    else
      ok "${label}: '${name}' has an enabled Branch Control check (task ${BRANCH_CONTROL_TASK_ID} v${bcVersion}) limited to '${TRUSTED_BRANCH}' with branch protection required."
    fi
  fi

  # (c) PUBLISH APPROVAL — the publish resource must additionally carry EXACTLY ONE ENABLED
  # Approval check with at least one approver AND requesterCannotBeApprover=true (a real human
  # gate the requester cannot self-satisfy). "ENABLED" FAILS CLOSED on a missing isDisabled:
  # only an EXPLICIT `isDisabled: false` counts as enabled, so a DISABLED (or unverifiable)
  # approval is treated as ABSENT and cannot silently pass.
  if [[ "$require_approval" == "yes" ]]; then
    local apprCount approvers selfApprove enabledApproval
    enabledApproval='select(.type.name == "Approval") | select(has("isDisabled") and (.isDisabled == false))'
    apprCount="$(printf '%s' "$checks" | jq -r "[.value[]? | ${enabledApproval}] | length" 2>/dev/null)"
    if [[ "$apprCount" == "" || "$apprCount" == "0" ]]; then
      err "${label}: '${name}' has NO enabled Approval check; a required publish approval is missing, disabled, or does not report an isDisabled state (fail closed)."
    elif [[ "$apprCount" != "1" ]]; then
      err "${label}: '${name}' has ${apprCount} enabled Approval checks; require EXACTLY ONE well-defined approval."
    else
      approvers="$(printf '%s' "$checks" | jq -r "[.value[]? | ${enabledApproval} | (.settings.approvers // []) | (if type == \"array\" then length else 0 end)] | add // 0" 2>/dev/null)"
      # requesterCannotBeApprover must be the EXACT boolean true — a "true" STRING or a missing
      # field is NOT a proven self-approval bar, so `== true` fails closed on those.
      selfApprove="$(printf '%s' "$checks" | jq -r "[.value[]? | ${enabledApproval} | (.settings.requesterCannotBeApprover == true)] | all" 2>/dev/null)"
      if [[ "${approvers:-0}" -lt 1 ]]; then
        err "${label}: '${name}' Approval check lists no approvers; add at least one required approver."
      elif [[ "$selfApprove" != "true" ]]; then
        err "${label}: '${name}' Approval check allows the requester to self-approve (requesterCannotBeApprover must be true)."
      else
        ok "${label}: '${name}' has an Approval check with ${approvers} approver(s) and no self-approval."
      fi
    fi
  fi

  # (b) PIPELINE PERMISSIONS — must NOT be open to all pipelines AND must authorize EXACTLY
  # the one official pipeline (by id), no others.
  local ppperm allOpen authIds
  ppperm="$(api "${ORG}/${PROJECT}/_apis/pipelines/pipelinePermissions/${kind}/${id}?api-version=7.1-preview.1")"
  if [[ -z "$ppperm" ]] || ! printf '%s' "$ppperm" | jq -e '.' >/dev/null 2>&1; then
    err "${label}: pipeline permissions for '${name}' are not readable; cannot confirm sole official-pipeline authorization."
  else
    allOpen="$(printf '%s' "$ppperm" | jq -r '(.allPipelines.authorized) as $v | if $v == true then "open" elif ($v != null and ($v|type) != "boolean") then "nonbool" else "closed" end' 2>/dev/null)"
    # The SORTED list of authorized pipeline ids (only those actually authorized == true).
    authIds="$(printf '%s' "$ppperm" | jq -r '[.pipelines[]? | select(.authorized == true) | .id | tostring] | sort | join(",")' 2>/dev/null)"
    if [[ "$allOpen" == "open" ]]; then
      err "${label}: '${name}' is authorized for ALL pipelines; restrict Security -> Pipeline permissions to the official pipeline only."
    elif [[ "$allOpen" == "nonbool" ]]; then
      err "${label}: '${name}' allPipelines.authorized is a non-boolean value; its meaning cannot be proven — fail closed."
    elif [[ "$authIds" != "$OFFICIAL_PIPELINE_ID" ]]; then
      err "${label}: '${name}' authorizes pipelines '[${authIds}]', not EXACTLY the official pipeline '${OFFICIAL_PIPELINE_ID}'."
    else
      ok "${label}: '${name}' authorizes EXACTLY the official pipeline ${OFFICIAL_PIPELINE_ID}."
    fi
  fi

  [[ $fail -eq $before ]] && ok "${label}: '${name}' is fully protected (branch control + sole pipeline authorization$([[ "$require_approval" == "yes" ]] && echo " + approval"))."
}

# Machine-verify the OFFICIAL pipeline's SERVER-SIDE identity as a CONSISTENCY/tamper check —
# NOT as a proof that signing can only ever run on the trusted branch. A manual run can queue
# the official pipeline against ANY branch, and a feature-branch YAML could DELETE the `sign`
# deployment job's `environment:` binding and call `onebranch.pipeline.signing@1` from a plain
# job, bypassing the environment's Branch Control check. So this check does NOT by itself
# PREVENT feature-branch signing. It confirms the reviewed pipeline is intact: the official
# build DEFINITION (server-side, not editable from a feature-branch YAML) (a) defaults to the
# trusted branch and (b) runs the expected reviewed OneBranch.Official YAML — a swapped
# definition or retargeted YAML path is caught here. The AUTHORITATIVE prevention is external:
# (1) the ESRP Real `external_distribution` SignType ENTITLEMENT, granted by OneBranch/ESRP
# onboarding ONLY to the onboarded Official pipeline on the trusted branch (a portal-confirmed
# property, NOT exposed by the ADO REST API, so it cannot be asserted here); and (2) the
# CodeSign Validation gates in BOTH the sign and publish stages, which fail closed on the
# NON-Real (Test) signature a bypassing feature-branch run would obtain. The signing
# environment's Branch Control (verified separately) additionally gates the deployment-job path.
verify_official_pipeline_branch_lock() {
  local before=$fail defn defBranch yamlPath repoId repoType repoName
  defn="$(api "${ORG}/${PROJECT}/_apis/build/definitions/${OFFICIAL_PIPELINE_ID}?api-version=7.1")"
  if [[ -z "$defn" ]] || ! printf '%s' "$defn" | jq -e '.id' >/dev/null 2>&1; then
    err "official-pipeline: build definition ${OFFICIAL_PIPELINE_ID} is not readable (needs Build: Read); cannot machine-verify the official pipeline identity."
    return
  fi
  defBranch="$(printf '%s' "$defn" | jq -r '.repository.defaultBranch // ""' 2>/dev/null)"
  yamlPath="$(printf '%s' "$defn" | jq -r '.process.yamlFilename // ""' 2>/dev/null)"
  repoId="$(printf '%s' "$defn" | jq -r '(.repository.id // "") | tostring' 2>/dev/null)"
  repoType="$(printf '%s' "$defn" | jq -r '.repository.type // ""' 2>/dev/null)"
  repoName="$(printf '%s' "$defn" | jq -r '.repository.name // ""' 2>/dev/null)"
  # IMMUTABLE repository identity (MANDATORY): a swapped definition keeping the same YAML path
  # but pointing at a different repository is caught only by the immutable id AND the type.
  if [[ "$repoId" != "$EXPECTED_REPOSITORY_ID" ]]; then
    err "official-pipeline: definition ${OFFICIAL_PIPELINE_ID} repository id is '${repoId:-<none>}', not the expected '${EXPECTED_REPOSITORY_ID}'; the official pipeline must build the reviewed repository (a repo-swapped definition is rejected)."
  fi
  if [[ "$repoType" != "$EXPECTED_REPOSITORY_TYPE" ]]; then
    err "official-pipeline: definition ${OFFICIAL_PIPELINE_ID} repository type is '${repoType:-<none>}', not the expected '${EXPECTED_REPOSITORY_TYPE}'; a same-id/name repository of a different provider is rejected."
  fi
  if [[ -n "$EXPECTED_REPOSITORY_NAME" && "$repoName" != "$EXPECTED_REPOSITORY_NAME" ]]; then
    err "official-pipeline: definition ${OFFICIAL_PIPELINE_ID} repository name is '${repoName:-<none>}', not the expected '${EXPECTED_REPOSITORY_NAME}'; the official pipeline must build the reviewed repository."
  fi
  if [[ "$defBranch" != "$TRUSTED_BRANCH" ]]; then
    err "official-pipeline: definition ${OFFICIAL_PIPELINE_ID} default branch is '${defBranch:-<none>}', not exactly '${TRUSTED_BRANCH}'; the official signing pipeline must default to the trusted branch."
  fi
  # Slash-insensitive YAML path comparison (ADO stores '/.pipelines/...').
  if [[ "${yamlPath#/}" != "${EXPECTED_YAML_PATH#/}" ]]; then
    err "official-pipeline: definition ${OFFICIAL_PIPELINE_ID} runs YAML '${yamlPath:-<none>}', not the expected official pipeline '${EXPECTED_YAML_PATH}'; the official pipeline id must map to the reviewed OneBranch.Official YAML."
  fi
  [[ $fail -eq $before ]] && ok "official-pipeline: ${OFFICIAL_PIPELINE_ID} builds the pinned repository (id ${EXPECTED_REPOSITORY_ID}, type ${EXPECTED_REPOSITORY_TYPE}${EXPECTED_REPOSITORY_NAME:+, name ${EXPECTED_REPOSITORY_NAME}}), defaults to '${TRUSTED_BRANCH}', and runs '${yamlPath}' (server-side identity intact; ESRP Real-SignType entitlement is portal-confirmed, not REST-queryable)."
}

# Signing is gated by a pipeline ENVIRONMENT (the onebranch.pipeline.signing@1 task takes no
# service connection); publishing is gated by a real service-connection ENDPOINT.
verify_official_pipeline_branch_lock
verify_resource "signing" "environment" "$SIGNING_ENV" "no"
verify_resource "publish" "endpoint" "$PUBLISH_SC" "yes"

if [[ $fail -ne 0 ]]; then
  echo "::error::One or more required ADO signing/publish protections are missing/misconfigured. Provision them per CONTRIBUTING.md before publishing."
  exit 1
fi
echo "All required ADO signing/publish protections verified for ${ORG}/${PROJECT} (trusted branch '${TRUSTED_BRANCH}')."
