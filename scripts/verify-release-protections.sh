#!/usr/bin/env bash
# verify-release-protections.sh — one-shot verifier for the EXTERNAL release controls the
# CI/CD-integration release workflows depend on. These controls live in GitHub org/repo
# settings (Environments, repository variables, tag rulesets), NOT in this repository, so
# they must be provisioned once by an operator (see CONTRIBUTING.md, "required
# configuration" sections). This script CONFIRMS they are all present and hardened — it is
# the same fail-closed logic the `release-action.yml` / `release.yml` publish preflights
# enforce at release time, packaged so it can be run AHEAD of a release.
#
# Requires: gh (authenticated as, or with read access equivalent to, the release identity),
# jq, and node (for the shared tag-ruleset evaluator scripts/lib/eval-tag-ruleset.mjs and the
# shared workflow-permissions auditor scripts/lib/audit-workflow-perms.mjs). It makes only
# READ calls; it changes nothing.
#
# Usage:
#   scripts/verify-release-protections.sh OWNER/REPO DEFAULT_BRANCH EXPECTED_WRITERS
# DEFAULT_BRANCH is a REQUIRED POSITIONAL placeholder (arg 2) because EXPECTED_WRITERS is the
# required 3rd positional argument — it cannot be omitted, but pass an EMPTY STRING ("") to
# auto-detect the repo's default branch (a non-empty value overrides the auto-detection). Do NOT
# collapse the two arguments: `... OWNER/REPO EXPECTED_WRITERS` would bind EXPECTED_WRITERS to
# DEFAULT_BRANCH (arg 2) and leave arg 3 empty, which fails closed. EXPECTED_WRITERS is REQUIRED and
# must be a non-empty, TYPED CSV of the SANCTIONED release-writing principals — each entry
# `user:<login>`, `team:<slug>`, or `app:<slug>` (e.g.
# 'user:release-bot,team:release-admins,app:release-ci'). The release-authority audit FAILS
# unless EVERY write-capable principal (direct collaborators, teams, the org base
# permission, GitHub App installations, deploy keys, and the repo+org Actions default
# workflow token) is enumerable AND within that typed set — an empty expected set or any
# un-enumerable authority surface does NOT pass.
# Guard EVERY external operation (gh api, jq) and RECORD failures rather than aborting:
# `set -e` is intentionally NOT used so a single failed API/jq call cannot abort the run
# before the aggregate report. `fail` is an incrementing ERROR COUNT (not a 0/1 boolean),
# so a per-call snapshot can tell whether THIS check added any error even when a PRIOR
# check already failed. The script exits nonzero only at the final aggregate.
set -uo pipefail

# Directory of THIS script, so the shared tag-ruleset evaluator can be located regardless of
# the caller's working directory.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RULESET_EVAL="${SCRIPT_DIR}/lib/eval-tag-ruleset.mjs"

REPO="${1:-}"
if [[ -z "$REPO" ]]; then
  echo "usage: $0 OWNER/REPO DEFAULT_BRANCH EXPECTED_WRITERS  (DEFAULT_BRANCH: \"\" to auto-detect; EXPECTED_WRITERS: typed CSV user:/team:/app:)" >&2
  exit 2
fi

fail=0
err() { echo "::error::$*"; fail=$((fail + 1)); }
ok() { echo "OK: $*"; }

# Resolve the default branch (guarded): a failure here is recorded, not fatal, so the
# remaining controls still run (branch-name checks will then report their own mismatch).
if [[ -n "${2:-}" ]]; then
  DEFAULT_BRANCH="$2"
elif ! DEFAULT_BRANCH="$(gh api "repos/${REPO}" --jq '.default_branch' 2>/dev/null)" || [[ -z "$DEFAULT_BRANCH" ]]; then
  err "could not resolve the default branch for '${REPO}' (API error); pass it as the 2nd argument."
  DEFAULT_BRANCH=""
fi

# --- Environments: release, mcp-release, pypi ---------------------------------------
# Each must have >=1 required reviewer, prevent_self_review=true, can_admins_bypass=false,
# and EXACTLY ONE deployment-branch policy of type 'branch' named the default branch.
# `release` and `mcp-release` must ALSO hold the ACTION_RELEASE_TOKEN environment secret
# (the tag-writing credential); `pypi` uses a trusted publisher and holds no token.
verify_env() {
  local envname="$1" needsToken="$2" envjson polJson reviewerRule total ptype pname
  # Snapshot the ERROR COUNT at entry. Because `fail` is an incrementing count (not a 0/1
  # boolean), comparing it to the snapshot at the end tells whether THIS environment added
  # ANY error — even when a PRIOR environment already failed (a boolean would wrongly report
  # this env as OK once any earlier env set fail=1). All error paths record via err().
  local before=$fail
  if ! envjson="$(gh api "repos/${REPO}/environments/${envname}" 2>/dev/null)"; then
    err "environment '${envname}' does not exist or is not readable."
    return 0
  fi
  reviewerRule="$(printf '%s' "$envjson" | jq -c '.protection_rules[]? | select(.type=="required_reviewers")')"
  [[ -n "$reviewerRule" ]] || err "environment '${envname}' has no required reviewers."
  [[ "$(printf '%s' "$reviewerRule" | jq -r '.prevent_self_review // false')" == "true" ]] \
    || err "environment '${envname}' must set prevent_self_review=true."
  # jq's // treats a literal false as absent, so test presence AND equality.
  [[ "$(printf '%s' "$envjson" | jq -r 'has("can_admins_bypass") and (.can_admins_bypass == false)')" == "true" ]] \
    || err "environment '${envname}' must set can_admins_bypass=false."
  [[ "$(printf '%s' "$envjson" | jq -r '.deployment_branch_policy.custom_branch_policies // false')" == "true" ]] \
    || err "environment '${envname}' must restrict deployments to selected branches/tags."
  # A branch-policy API failure must NOT abort the whole verifier under `set -e` (that
  # would skip every remaining control). RECORD the error and return so the other
  # environments and the tag rulesets are still checked.
  if ! polJson="$(gh api "repos/${REPO}/environments/${envname}/deployment-branch-policies" 2>/dev/null)"; then
    err "environment '${envname}' deployment-branch-policies are not readable (API error); cannot confirm the default-branch-only policy."
    return 0
  fi
  total="$(printf '%s' "$polJson" | jq -r '.total_count')"
  [[ "$total" == "1" ]] || err "environment '${envname}' must have EXACTLY one deployment policy, found ${total}."
  ptype="$(printf '%s' "$polJson" | jq -r '.branch_policies[0].type // "null"')"
  pname="$(printf '%s' "$polJson" | jq -r '.branch_policies[0].name // "null"')"
  { [[ "$ptype" == "branch" && "$pname" == "$DEFAULT_BRANCH" ]]; } \
    || err "environment '${envname}' policy must be a single BRANCH policy named '${DEFAULT_BRANCH}', got type='${ptype}' name='${pname}'."
  # ACTION_RELEASE_TOKEN must be an ENVIRONMENT-scoped secret where the tag write runs.
  # The secrets endpoint returns 200 (name + timestamps, never the value) if it exists,
  # 404 otherwise — so a present token is confirmed without ever reading its value.
  if [[ "$needsToken" == "yes" ]]; then
    if ! gh api "repos/${REPO}/environments/${envname}/secrets/ACTION_RELEASE_TOKEN" >/dev/null 2>&1; then
      err "environment '${envname}' is missing the ACTION_RELEASE_TOKEN environment secret (the tag-writing release identity token)."
    fi
  fi
  # Success message + return status derive from THIS call only (compare to the entry
  # snapshot), so the function returns 0 regardless of any earlier environment's failure.
  [[ $fail -eq $before ]] && ok "environment '${envname}' hardened (reviewers + prevent_self_review + can_admins_bypass=false + default-branch-only$([[ "$needsToken" == "yes" ]] && echo " + ACTION_RELEASE_TOKEN"))."
  return 0
}
verify_env release yes
verify_env mcp-release yes
verify_env pypi no

# --- RELEASE_IDENTITY_ACTOR_ID variable ---------------------------------------------
if ! RID="$(gh variable get RELEASE_IDENTITY_ACTOR_ID --repo "$REPO" 2>/dev/null)" || [[ -z "$RID" ]]; then
  err "repository variable RELEASE_IDENTITY_ACTOR_ID is not set (numeric actor id of the dedicated release User)."
  RID=""
else
  ok "RELEASE_IDENTITY_ACTOR_ID is set (${RID})."
fi

# --- Tag rulesets: v* and mcp-v* -----------------------------------------------------
# Evaluate the floating/immutable release tag refs with the SAME operation-aware, LAYERED
# evaluator the release workflows use (scripts/lib/eval-tag-ruleset.mjs). "Layered" because
# GitHub ANDs EVERY applicable active tag ruleset: each independently enforces its rules, so
# the release identity must bypass every applicable restricting layer and NO applicable layer
# may grant a foreign bypass. Every write AND force-update operation (creation, update,
# deletion, non_fast_forward) must be restricted so a floating tag (e.g. `v1`) cannot be
# force-moved by a non-bypass actor. A single named-ruleset jq check would miss additional
# layers and the non-fast-forward guard, so the whole active-tag-ruleset set is evaluated at
# once against each representative ref.
RULESETS_ARR=""
if ! command -v node >/dev/null 2>&1; then
  err "node is not installed; cannot run the shared tag-ruleset evaluator (${RULESET_EVAL})."
elif [[ ! -f "$RULESET_EVAL" ]]; then
  err "shared tag-ruleset evaluator not found at '${RULESET_EVAL}'; run from a full checkout."
else
  # Fetch ALL active tag ruleset DETAILS once (bypass_actors are only present on the detail
  # object) into a JSON array file the evaluator consumes.
  ruleset_ids="$(gh api --paginate "repos/${REPO}/rulesets" --jq '.[] | select(.target=="tag" and .enforcement=="active") | .id' 2>/dev/null)"
  if [[ $? -ne 0 ]]; then
    err "tag ruleset list is not readable (API error); cannot verify the release tag locks."
  else
    ruleset_details="$(mktemp)"; : > "$ruleset_details"
    ruleset_read_ok=1
    while IFS= read -r rsid; do
      [[ -z "$rsid" ]] && continue
      if ! gh api "repos/${REPO}/rulesets/${rsid}" >> "$ruleset_details" 2>/dev/null; then
        ruleset_read_ok=0
        break
      fi
    done <<< "$ruleset_ids"
    if [[ "$ruleset_read_ok" != "1" ]]; then
      err "one or more tag ruleset detail reads failed (API error); cannot verify the release tag locks."
    else
      RULESETS_ARR="$(mktemp)"
      if ! jq -s '.' "$ruleset_details" > "$RULESETS_ARR" 2>/dev/null; then
        err "could not assemble the tag ruleset detail array (jq error); cannot verify the release tag locks."
        RULESETS_ARR=""
      fi
    fi
  fi
fi

# Evaluate a SET of representative concrete refs for a namespace against the full
# active-ruleset set. Multiple refs are required to catch (a) FLOATING-TAG gaps — the Action
# advances a floating major like `refs/tags/v1`, which a pattern that only matches exact
# `x.y.z` versions would leave unprotected — and (b) NAMESPACE gaps — a pattern that only
# matches one major/version (e.g. `refs/tags/v0.*`) would pass a single `v0.0.0` probe while
# leaving `v1`/`v2`/multi-digit versions unprotected. Each ref must be independently locked.
# $1=label  $2..=representative refs (each must be a ref the release actually writes/advances).
verify_ruleset() {
  local label="$1"; shift
  local ref out
  if [[ -z "$RULESETS_ARR" ]]; then
    err "tag ruleset '${label}' cannot be evaluated: the active tag rulesets were not readable."
    return 0
  fi
  for ref in "$@"; do
    if out="$(RULESETS_FILE="$RULESETS_ARR" TAG_REF="$ref" RID="${RID:-__unset__}" \
        REQUIRED_OPS="creation,update,deletion,non_fast_forward" node "$RULESET_EVAL" 2>&1)"; then
      ok "tag ruleset(s) lock '${label}' ${ref} to the single release identity (creation+update+deletion+non_fast_forward)."
    else
      printf '%s\n' "$out" >&2
      err "tag ruleset '${label}' (${ref}) is misconfigured (see the ::error:: messages above from the layered evaluator)."
    fi
  done
  return 0
}

# Verify NAMESPACE-WIDE coverage (not just finite probes): a ruleset whose include is a finite
# LIST of exact tags would pass every representative probe above while leaving FUTURE tags in
# the namespace unprotected. This requires an active tag ruleset whose include pattern COVERS
# the whole `refs/tags/<prefix>*` namespace (a wildcard, not an enumeration), with no excludes,
# restricting every write+force op and authorizing the release identity as the sole bypass.
# $1=label  $2=namespace tag-name prefix within refs/tags/ (e.g. v, mcp-v).
verify_ruleset_namespace() {
  local label="$1" prefix="$2" out
  if [[ -z "$RULESETS_ARR" ]]; then
    err "tag namespace '${label}' (refs/tags/${prefix}*) cannot be evaluated: the active tag rulesets were not readable."
    return 0
  fi
  if out="$(RULESETS_FILE="$RULESETS_ARR" NAMESPACE_PREFIX="$prefix" RID="${RID:-__unset__}" \
      REQUIRED_OPS="creation,update,deletion,non_fast_forward" node "$RULESET_EVAL" 2>&1)"; then
    ok "tag ruleset(s) cover the ENTIRE 'refs/tags/${prefix}*' namespace (not just probe refs) and lock it to the single release identity."
  else
    printf '%s\n' "$out" >&2
    err "tag namespace '${label}' (refs/tags/${prefix}*) is not fully covered/locked (see the ::error:: messages above from the layered evaluator)."
  fi
  return 0
}
# Representative refs per namespace. The Action publishes exact version tags (v1.2.3) AND
# advances a FLOATING major (v1); it must protect every major and multi-digit version, so
# probe a floating major, an exact version, a different major, and a multi-digit version.
verify_ruleset "release-tags-v" \
  "refs/tags/v1" "refs/tags/v1.2.3" "refs/tags/v2" "refs/tags/v10.20.30"
# MCP writes exact mcp-v<x.y.z> tags; protect the floating and multi-digit forms too.
verify_ruleset "release-tags-mcp-v" \
  "refs/tags/mcp-v1" "refs/tags/mcp-v1.2.3" "refs/tags/mcp-v10.20.30"
# NAMESPACE-WIDE coverage: a wildcard include must protect the WHOLE namespace, so an
# enumeration ruleset that only matches the probes above cannot pass.
verify_ruleset_namespace "release-tags-v" "v"
verify_ruleset_namespace "release-tags-mcp-v" "mcp-v"

# --- Immutable releases (repository setting) -----------------------------------------
# Published releases must be frozen by GitHub (assets + tag). GET the dedicated
# immutable-releases resource (requires admin READ / Administration: read) and require
# its .enabled field to be true; the API version is pinned for stability.
if [[ "$(gh api "repos/${REPO}/immutable-releases" -H "X-GitHub-Api-Version: 2022-11-28" --jq '.enabled == true' 2>/dev/null)" == "true" ]]; then
  ok "immutable releases enabled (published releases are frozen)."
else
  err "immutable releases are NOT enabled (enable with 'gh api --method PUT repos/${REPO}/immutable-releases -H \"X-GitHub-Api-Version: 2022-11-28\"'; requires admin / Administration: write)."
fi

# --- Exclusive release-writing authority (AUDITED — incomplete audit FAILS) ----------
# GitHub has NO per-release ACL: any principal with `contents: write` (push) can create,
# edit, publish, or delete a release/draft. The publish workflows DETECT tampering, but the
# only way to PREVENT it is to keep the set of write-capable principals minimal. This audit
# enumerates EVERY class of write-capable principal — direct collaborators, teams, the
# organization base permission, ORGANIZATION OWNERS (admins of all repos), GitHub App
# installations, deploy keys, and the effective Actions workflow authority — and FAILS
# acceptance on ANY principal outside the sanctioned set, ANY surface that cannot be fully
# enumerated, OR any sanctioned entry that is NOT actually a writer (EXACT set equality in
# BOTH directions). `EXPECTED_WRITERS` (arg 3) is REQUIRED and must be a non-empty, TYPED
# CSV — each entry `user:<login>`, `team:<slug>`, or `app:<slug>` — so a login can never be
# silently accepted as a team/app of the same name.
EXPECTED_WRITERS="${3:-}"
OWNER="${REPO%%/*}"
declare -A expected_user=() expected_team=() expected_app=()
# Which sanctioned entries were actually OBSERVED as writers, so a stale/typo'd expected
# entry (present in EXPECTED_WRITERS but not an actual writer) fails the reverse direction.
declare -A seen_user=() seen_team=() seen_app=()
if [[ -z "$EXPECTED_WRITERS" ]]; then
  err "release-authority: EXPECTED_WRITERS (arg 3) is REQUIRED — a non-empty TYPED CSV like 'user:release-bot,team:release-admins,app:release-ci'. An empty/absent expected set cannot assert exclusivity."
else
  IFS=',' read -ra _ew <<< "$EXPECTED_WRITERS"
  for w in "${_ew[@]}"; do
    w="$(printf '%s' "$w" | tr -d '[:space:]')"
    [[ -z "$w" ]] && continue
    case "$w" in
      user:*) expected_user["${w#user:}"]=1 ;;
      team:*) expected_team["${w#team:}"]=1 ;;
      app:*)  expected_app["${w#app:}"]=1 ;;
      *) err "release-authority: EXPECTED_WRITERS entry '${w}' is not TYPED (must be user:/team:/app:)." ;;
    esac
  done
fi

# Is the owner an ORGANIZATION? (org-only surfaces below fail closed for an org repo.)
IS_ORG=0
if gh api "orgs/${OWNER}" --jq '.login' >/dev/null 2>&1; then IS_ORG=1; fi

# (1) DIRECT collaborators with push/admin. A read failure FAILS acceptance. Any login not
# in the sanctioned user set is an error.
if collabs="$(gh api --paginate "repos/${REPO}/collaborators?affiliation=direct" \
    --jq '.[] | select(.permissions.push == true or .permissions.admin == true) | .login' 2>/dev/null)"; then
  echo "AUDIT: direct collaborators holding contents:write:"
  while IFS= read -r login; do
    [[ -z "$login" ]] && continue
    if [[ -z "${expected_user[$login]:-}" ]]; then
      err "release-authority: direct collaborator '${login}' holds contents:write but is not in EXPECTED_WRITERS (user:${login})."
    else
      seen_user["$login"]=1
      echo "  - user:${login} (sanctioned)"
    fi
  done <<< "$collabs"
else
  err "release-authority: could not enumerate direct collaborators for '${REPO}' (needs admin read). An un-auditable write surface fails the exclusivity audit."
fi

# (1b) ORGANIZATION OWNERS have admin over EVERY repo (an authority that cannot be removed
# per-repo), so they are release writers and MUST be sanctioned. A read failure fails closed.
if [[ "$IS_ORG" == "1" ]]; then
  if owners="$(gh api --paginate "orgs/${OWNER}/members?role=admin" --jq '.[].login' 2>/dev/null)"; then
    echo "AUDIT: organization owners (admin of every repo):"
    while IFS= read -r login; do
      [[ -z "$login" ]] && continue
      if [[ -z "${expected_user[$login]:-}" ]]; then
        err "release-authority: org owner '${login}' has admin over all repos (a release writer) but is not in EXPECTED_WRITERS (user:${login})."
      else
        seen_user["$login"]=1
        echo "  - user:${login} (org owner, sanctioned)"
      fi
    done <<< "$owners"
  else
    err "release-authority: could not enumerate org '${OWNER}' owners (needs org admin read). An un-auditable owner surface fails the audit."
  fi
fi

# (2) TEAMS with push/maintain/admin. A read failure FAILS acceptance; any write team not in
# the sanctioned team set is an error.
if teams="$(gh api --paginate "repos/${REPO}/teams" \
    --jq '.[] | select(.permission == "push" or .permission == "admin" or .permission == "maintain") | .slug' 2>/dev/null)"; then
  echo "AUDIT: teams granting contents:write (push/maintain/admin):"
  while IFS= read -r slug; do
    [[ -z "$slug" ]] && continue
    if [[ -z "${expected_team[$slug]:-}" ]]; then
      err "release-authority: team '${slug}' grants contents:write but is not in EXPECTED_WRITERS (team:${slug})."
    else
      seen_team["$slug"]=1
      echo "  - team:${slug} (sanctioned)"
    fi
  done <<< "$teams"
else
  err "release-authority: could not enumerate repository teams for '${REPO}' (needs admin read). An un-auditable write surface fails the exclusivity audit."
fi

# (3) ORGANIZATION base permission. If the org grants members a base repository permission of
# write/admin, EVERY org member has contents:write — a broad, non-exclusive surface. For an
# org repo this MUST be read/none, and MUST be enumerable.
if [[ "$IS_ORG" == "1" ]]; then
  if base="$(gh api "orgs/${OWNER}" --jq '.default_repository_permission // "unknown"' 2>/dev/null)"; then
    if [[ "$base" == "write" || "$base" == "admin" ]]; then
      err "release-authority: org '${OWNER}' base repository permission is '${base}' — every member has contents:write. Set it to 'read' or 'none' and grant release write explicitly."
    elif [[ "$base" == "unknown" || -z "$base" ]]; then
      err "release-authority: could not read org '${OWNER}' base repository permission (needs org admin read). An un-auditable org surface fails the audit."
    else
      ok "release-authority: org base repository permission is '${base}' (not broadly write)."
    fi
  else
    err "release-authority: could not read org '${OWNER}' settings (needs org admin read). An un-auditable org surface fails the audit."
  fi
fi

# (4) GITHUB APP installations with contents:write. An installed app is a non-human principal
# that can create/alter releases — but ONLY while the installation is ACTIVE (not suspended)
# and actually TARGETS this repo (repository_selection == "all", or "selected" including this
# repo). Enumerate org installations and, for each ACTIVE contents:write/admin installation
# that can reach this repo, fail unless it is sanctioned. A SUSPENDED installation cannot act
# (its tokens are revoked) so it is reported but not counted. Because an org-admin token
# cannot cheaply enumerate a "selected" installation's repository list, a "selected"
# installation is treated as reaching this repo (FAIL CLOSED). A non-enumerable app surface
# FAILS.
if [[ "$IS_ORG" == "1" ]]; then
  if apps="$(gh api --paginate "orgs/${OWNER}/installations" \
      --jq '.installations[]? | select((.permissions.contents // "none") == "write" or (.permissions.contents // "none") == "admin") | [.app_slug, (.repository_selection // "unknown"), (if .suspended_at == null then "active" else "suspended" end)] | @tsv' 2>/dev/null)"; then
    echo "AUDIT: GitHub App installations holding contents:write:"
    while IFS=$'\t' read -r slug selection state; do
      [[ -z "$slug" ]] && continue
      if [[ "$state" == "suspended" ]]; then
        echo "  - app:${slug} (contents:write but SUSPENDED — inactive, cannot act)"
        continue
      fi
      # ACTIVE contents:write installation — determine whether it reaches THIS repo.
      case "$selection" in
        all) scope="all repositories" ;;
        selected) scope="selected repositories (assumed to include ${REPO} — fail closed)" ;;
        *) scope="unknown repository selection (fail closed)" ;;
      esac
      if [[ -z "${expected_app[$slug]:-}" ]]; then
        err "release-authority: active GitHub App '${slug}' holds contents:write on ${scope} but is not in EXPECTED_WRITERS (app:${slug})."
      else
        seen_app["$slug"]=1
        echo "  - app:${slug} (sanctioned; ${scope})"
      fi
    done <<< "$apps"
  else
    err "release-authority: could not enumerate GitHub App installations for org '${OWNER}' (needs org admin read). An un-auditable app surface fails the audit."
  fi
else
  # A user-owned repo: the per-repo installation endpoint returns at most the caller-visible
  # app and cannot enumerate all app grants — fail closed rather than certify blindly.
  err "release-authority: '${REPO}' is not an organization repo; GitHub App installation access cannot be fully enumerated via the repo API. Move release to an org (auditable installations) or attest app access out of band — the app surface is treated as unverified."
fi

# (5) DEPLOY KEYS with WRITE access are non-interactive push credentials. A read failure
# FAILS acceptance; ANY read-write deploy key is an error.
if keys="$(gh api --paginate "repos/${REPO}/keys" --jq '.[] | select(.read_only == false) | .title' 2>/dev/null)"; then
  if [[ -n "$keys" ]]; then
    while IFS= read -r title; do
      [[ -z "$title" ]] && continue
      err "release-authority: read-WRITE deploy key '${title}' can push/tamper; remove it (write deploy keys broaden release authority)."
    done <<< "$keys"
  else
    ok "release-authority: no read-write deploy keys."
  fi
else
  err "release-authority: could not enumerate deploy keys for '${REPO}' (needs admin read). An un-auditable write surface fails the exclusivity audit."
fi

# (6) EFFECTIVE Actions workflow authority must be READ-ONLY. A write-default GITHUB_TOKEN
# lets ANY workflow create/alter releases, and PR-review approval by the token is another
# authority vector. Read the FULL repo workflow-permissions object and require BOTH
# default_workflow_permissions == read AND can_approve_pull_request_reviews == false; for an
# org repo also require the org default is read-only (the effective value for unset repos).
# A non-enumerable value FAILS.
if wfjson="$(gh api "repos/${REPO}/actions/permissions/workflow" 2>/dev/null)" && printf '%s' "$wfjson" | jq -e '.default_workflow_permissions' >/dev/null 2>&1; then
  wfperm="$(printf '%s' "$wfjson" | jq -r '.default_workflow_permissions')"
  wfapprove="$(printf '%s' "$wfjson" | jq -r '.can_approve_pull_request_reviews // false')"
  if [[ "$wfperm" != "read" ]]; then
    err "release-authority: the repo Actions default workflow token is '${wfperm}', not 'read'. Set default workflow permissions to read-only."
  elif [[ "$wfapprove" == "true" ]]; then
    err "release-authority: the repo Actions workflow token can approve pull request reviews (can_approve_pull_request_reviews=true); disable it."
  else
    ok "release-authority: the repo effective Actions workflow authority is read-only and cannot approve PRs."
  fi
else
  err "release-authority: could not read the Actions workflow permissions for '${REPO}' (needs admin read). An un-auditable write surface fails the audit."
fi
if [[ "$IS_ORG" == "1" ]]; then
  # Read the FULL org workflow-permissions object and require BOTH default_workflow_permissions
  # == read AND can_approve_pull_request_reviews == false — the org default is the EFFECTIVE
  # authority for repos that do not (or cannot) override it, and org-level token PR approval is
  # its own authority vector.
  if orgwfjson="$(gh api "orgs/${OWNER}/actions/permissions/workflow" 2>/dev/null)" && printf '%s' "$orgwfjson" | jq -e '.default_workflow_permissions' >/dev/null 2>&1; then
    orgwf="$(printf '%s' "$orgwfjson" | jq -r '.default_workflow_permissions')"
    orgwfapprove="$(printf '%s' "$orgwfjson" | jq -r '.can_approve_pull_request_reviews // false')"
    if [[ "$orgwf" != "read" ]]; then
      err "release-authority: the ORG Actions default workflow token is '${orgwf}', not 'read' (the effective default for new/unset repos). Set the org default to read-only."
    elif [[ "$orgwfapprove" == "true" ]]; then
      err "release-authority: the ORG Actions workflow token can approve pull request reviews (can_approve_pull_request_reviews=true); disable it."
    else
      ok "release-authority: the org effective Actions workflow authority is read-only and cannot approve PRs."
    fi
  else
    err "release-authority: could not read org '${OWNER}' Actions default workflow permissions (needs org admin read). An un-auditable surface fails the audit."
  fi
fi

# (6b) EXPLICIT workflow/job permissions + REUSABLE workflows. The default-token audit above
# proves the DEFAULT GITHUB_TOKEN is read-only, but that is not the EFFECTIVE authority: a
# workflow (or a specific job) can re-grant write with its own `permissions:` block, and a
# REUSABLE workflow (`uses: …/*.yml`) runs with delegated authority the default-token check
# never inspects. Both are release-authority write vectors. Enumerate every workflow file on the
# default branch and audit them statically with the shared auditor
# (scripts/lib/audit-workflow-perms.mjs). The known release workflows may hold GATED write
# (allowlisted — their authority is verified by the environment/identity/ruleset checks
# above) IF and only if the granting job is bound to one of the PROTECTED environments; ANY
# other content-write grant, a `write-all`, or ANY reusable-workflow call fails.
#
# ATOMICITY + COMPLETENESS (fail closed): the directory Contents API is CAPPED at 1,000 entries
# and each `?ref=<branch>` read is a separate mutable request (the branch can advance between
# reads), so the audited set could be incomplete or inconsistent. Instead we (1) resolve the
# default branch to a SINGLE immutable commit SHA once, (2) enumerate via the Git TREES API
# (recursive, not the Contents cap) and FAIL CLOSED if the tree is `truncated`, and (3) read
# every workflow blob PINNED to that one commit SHA, so the whole audit is a consistent snapshot.
WORKFLOW_AUDIT="${SCRIPT_DIR}/lib/audit-workflow-perms.mjs"
# The environment names independently provisioned + verified as protected above; only a
# content-write gated by one of these is allowed (as a NOTE) for an allowlisted workflow.
PROTECTED_ENVS_CSV="release,mcp-release,pypi"
if ! command -v node >/dev/null 2>&1; then
  err "release-authority: node is not installed; cannot audit explicit workflow permissions (${WORKFLOW_AUDIT})."
elif [[ ! -f "$WORKFLOW_AUDIT" ]]; then
  err "release-authority: workflow-permissions auditor not found at '${WORKFLOW_AUDIT}'; run from a full checkout."
elif [[ -z "$DEFAULT_BRANCH" ]]; then
  err "release-authority: default branch unknown; cannot fetch workflow files to audit explicit permissions."
elif ! wf_commit="$(gh api "repos/${REPO}/commits/${DEFAULT_BRANCH}" --jq '.sha' 2>/dev/null)" || [[ -z "$wf_commit" || "$wf_commit" == "null" ]]; then
  err "release-authority: could not resolve '${DEFAULT_BRANCH}' to a commit SHA for '${REPO}' (needs contents read). An un-auditable workflow surface fails the audit."
else
  # Recursive Git TREES enumeration pinned to the resolved commit (uncapped, unlike the 1,000-
  # entry Contents listing). Capture the truncation flag and the workflow entries together.
  wf_tree="$(gh api "repos/${REPO}/git/trees/${wf_commit}?recursive=1" 2>/dev/null)"
  if [[ $? -ne 0 || -z "$wf_tree" ]]; then
    err "release-authority: could not read the git tree at ${wf_commit} for '${REPO}' (needs contents read). An un-auditable workflow surface fails the audit."
  elif [[ "$(printf '%s' "$wf_tree" | jq -r '.truncated // false' 2>/dev/null)" == "true" ]]; then
    err "release-authority: the git tree at ${wf_commit} is TRUNCATED; the workflow set cannot be fully enumerated (fail closed). Audit from a full checkout."
  else
    # Enumerate matching workflow blobs as COMPACT JSON objects — ONE per line. A newline INSIDE a
    # path is JSON-ESCAPED (`\n`) in `-c` output, so `read -r` can never split a single filename
    # across iterations (the previous `jq -r`+newline split let a newline-containing filename evade
    # the audit). Each object carries the blob SHA so content is fetched BY SHA below.
    wf_entries="$(printf '%s' "$wf_tree" | jq -c '.tree[]? | select(.type=="blob") | select(.path|test("^\\.github/workflows/[^/]+\\.ya?ml$")) | {path: .path, sha: .sha}' 2>/dev/null)"
    if [[ -z "$wf_entries" ]]; then
      ok "release-authority: no workflow files present to audit for explicit write permissions."
    else
      wf_json="$(mktemp)"; : > "$wf_json"
      wf_read_ok=1
      while IFS= read -r entry; do
        [[ -z "$entry" ]] && continue
        wsha="$(printf '%s' "$entry" | jq -r '.sha' 2>/dev/null)"
        wpath="$(printf '%s' "$entry" | jq -r '.path' 2>/dev/null)"
        wname="${wpath##*/}"
        if [[ -z "$wsha" || "$wsha" == "null" ]]; then wf_read_ok=0; break; fi
        # Fetch content BY BLOB SHA (immutable + path-INDEPENDENT). No path is interpolated into
        # the URL, so a filename containing ANY character — newline, `#`, `?`, `%`, space — cannot
        # alter the request or evade the audit. The git blobs endpoint supports the raw media type,
        # so no base64 decode is needed; --arg carries the content (with newlines) safely.
        if ! wcontent="$(gh api "repos/${REPO}/git/blobs/${wsha}" -H "Accept: application/vnd.github.raw" 2>/dev/null)"; then
          wf_read_ok=0; break
        fi
        if ! jq -n --arg name "$wname" --arg content "$wcontent" '{name:$name, content:$content}' >> "$wf_json" 2>/dev/null; then
          wf_read_ok=0; break
        fi
      done <<< "$wf_entries"
      if [[ "$wf_read_ok" != "1" ]]; then
        err "release-authority: could not read one or more workflow files for '${REPO}' at ${wf_commit}. An un-auditable workflow surface fails the audit."
      else
        wf_arr="$(mktemp)"
        if ! jq -s '.' "$wf_json" > "$wf_arr" 2>/dev/null; then
          err "release-authority: could not assemble the workflow file array (jq error); cannot audit explicit permissions."
        elif audit_out="$(WORKFLOWS_FILE="$wf_arr" ALLOWLIST="release.yml,release-action.yml" PROTECTED_ENVIRONMENTS="$PROTECTED_ENVS_CSV" node "$WORKFLOW_AUDIT" 2>&1)"; then
          ok "release-authority: explicit workflow/job permissions are least-privilege and no reusable workflows are called (audited at commit ${wf_commit})."
          printf '%s\n' "$audit_out" | grep '^NOTE:' || true
        else
          printf '%s\n' "$audit_out" >&2
          err "release-authority: explicit workflow permissions / reusable-workflow audit failed (see ::error:: messages above)."
        fi
      fi
    fi
  fi
fi

# (7) REVERSE DIRECTION (exact set equality): every SANCTIONED writer in EXPECTED_WRITERS
# must actually BE an observed writer. A sanctioned entry never seen as a real writer is a
# stale/typo'd expectation that would silently mask a future real writer of the same
# name — fail it so the expected set must equal the actual write surface EXACTLY.
for u in "${!expected_user[@]}"; do
  [[ -z "${seen_user[$u]:-}" ]] && err "release-authority: sanctioned writer 'user:${u}' is NOT an actual writer (direct collaborator or org owner); remove it or fix the login (EXPECTED_WRITERS must EQUAL the actual writer set)."
done
for t in "${!expected_team[@]}"; do
  [[ -z "${seen_team[$t]:-}" ]] && err "release-authority: sanctioned writer 'team:${t}' is NOT an actual write team; remove it or fix the slug (exact set equality)."
done
for a in "${!expected_app[@]}"; do
  [[ -z "${seen_app[$a]:-}" ]] && err "release-authority: sanctioned writer 'app:${a}' is NOT an actual contents:write app installation; remove it or fix the slug (exact set equality)."
done

if [[ $fail -ne 0 ]]; then
  echo "::error::One or more required release protections are missing/misconfigured. Provision them per CONTRIBUTING.md before releasing."
  exit 1
fi
echo "All required release protections verified for ${REPO} (default branch '${DEFAULT_BRANCH}')."
