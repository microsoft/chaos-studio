#!/usr/bin/env bash
# release-asset-verify.sh — shared release-gate helpers for release-action.yml.
#
# WHY THIS FILE EXISTS: bash functions and variables defined inside one GitHub
# Actions `run:` step's shell script do NOT persist to a later step — each
# `run:` block is a FRESH shell/process. The "Stage" step originally defined
# `require_immutable`/`verify_final_assets` (and the `want`/`assets` maps they
# close over) inline; the LATER "Publish" step called those same function
# names, which were undefined there, so publication would make the release
# public and then fail with "command not found" before the major tag could be
# advanced (the P1 issue this file fixes).
#
# This script is sourced (not executed) by BOTH the staging and publication
# steps, so both get an IDENTICAL definition of the two gate functions. The
# `want`/`wantNames` state `verify_final_assets` needs is NOT bash-exported
# across steps (associative arrays cannot cross a process boundary); instead
# the staging step persists it to a small on-disk manifest
# (`pkg/asset-digests.tsv`, name<TAB>sha256, part of the same verified working
# tree available to every step in this job) and `load_want_assets` rebuilds
# the in-memory map from that file in whichever step sources this library.
#
# Required environment when calling these functions: TAG, REPO (both already
# set as job-level env vars in release-action.yml).

# Build (and cache to disk) the intended asset name -> sha256 map from the
# release archive assets. Must be called once, in the step that first
# produces `pkg/action-bundle.tar.gz` et al. (the staging step).
compute_want_assets() {
  assets=( pkg/action-bundle.tar.gz pkg/action-bundle.tar.gz.sha256 pkg/dist-manifest.tsv )
  declare -gA want=()
  for a in "${assets[@]}"; do
    [[ -f "$a" ]] || { echo "::error::Expected asset '$a' is missing."; exit 1; }
    want["$(basename "$a")"]="$(sha256sum "$a" | awk '{print $1}')"
  done
  wantNames="$(printf '%s\n' "${!want[@]}" | LC_ALL=C sort)"
  # Persist so a LATER step (fresh shell) can rebuild the identical map without
  # re-hashing (and without trusting a second, possibly-tampered read of the
  # working tree at that later point in the job).
  : > pkg/asset-digests.tsv
  for name in "${!want[@]}"; do
    printf '%s\t%s\n' "$name" "${want[$name]}" >> pkg/asset-digests.tsv
  done
}

# Rebuild the intended asset name -> sha256 map from the on-disk manifest
# written by `compute_want_assets` in an earlier step. Must be called by any
# LATER step (fresh shell) before invoking `verify_final_assets`.
load_want_assets() {
  local manifest="pkg/asset-digests.tsv"
  [[ -f "$manifest" ]] || { echo "::error::Missing $manifest; compute_want_assets must run before load_want_assets."; exit 1; }
  declare -gA want=()
  local name sha
  while IFS=$'\t' read -r name sha; do
    [[ -z "$name" ]] && continue
    want["$name"]="$sha"
  done < "$manifest"
  wantNames="$(printf '%s\n' "${!want[@]}" | LC_ALL=C sort)"
}

verify_final_assets() {
  # The remote asset set must equal the intended set EXACTLY, and every
  # remote asset's DOWNLOADED bytes must hash to the intended digest.
  local finalNames verdir got name
  finalNames="$(gh release view "$TAG" --repo "$REPO" --json assets --jq '.assets[].name' | LC_ALL=C sort)"
  if [[ "$finalNames" != "$wantNames" ]]; then
    echo "::error::Remote asset set does not match the intended set."
    diff <(printf '%s\n' "$wantNames") <(printf '%s\n' "$finalNames") || true
    exit 1
  fi
  verdir="${RUNNER_TEMP}/asset-verify"; rm -rf "$verdir"; mkdir -p "$verdir"
  gh release download "$TAG" --repo "$REPO" --dir "$verdir" --clobber
  for name in "${!want[@]}"; do
    got="$(sha256sum "${verdir}/${name}" | awk '{print $1}')"
    if [[ "$got" != "${want[$name]}" ]]; then
      echo "::error::Remote asset '$name' digest ${got} != intended ${want[$name]}."
      exit 1
    fi
  done
}

require_immutable() {
  # GitHub release immutability (a repository setting) FREEZES a published
  # release's assets AND tag. Require GitHub to report the release as immutable so
  # "immutable" is ENFORCED by the platform, not merely asserted by this workflow.
  # (Provisioning: enable release immutability in repo settings — see CONTRIBUTING.md.)
  local imm
  imm="$(gh api "repos/${REPO}/releases/tags/${TAG}" --jq '(.immutable // .is_immutable) // false' 2>/dev/null || echo false)"
  if [[ "$imm" != "true" ]]; then
    echo "::error::Release $TAG is NOT immutable (isImmutable=${imm}). Enable repository release immutability so published releases (assets + tag) are frozen (see CONTRIBUTING.md)."
    exit 1
  fi
  echo "Release $TAG is immutable (isImmutable=true)."
}

require_repo_immutability_enabled() {
  # Repository-level immutable releases must be ENABLED *before* we make ANY release
  # write. Otherwise a publish/flip would create a MUTABLE public release and the
  # per-release require_immutable check would only fail AFTER the mutable release is
  # already public. GET the repo setting (returns { enabled, enforced_by_owner });
  # fail CLOSED unless enabled==true so no mutable public release is ever produced.
  local en
  en="$(gh api "repos/${REPO}/immutable-releases" -H "X-GitHub-Api-Version: 2022-11-28" --jq ".enabled == true" 2>/dev/null || echo false)"
  if [[ "$en" != "true" ]]; then
    echo "::error::Repository immutable releases are NOT enabled; refusing to write any release (a published release would be mutable). Enable it (see CONTRIBUTING.md) before releasing."
    exit 1
  fi
  echo "Repository immutable releases are enabled."
}

reconcile_draft_assets() {
  # Bring a (possibly partial) DRAFT's assets to EXACTLY the intended set:
  # delete any unintended asset, then (re)upload the intended ones. Safe
  # ONLY on a draft, which is not public.
  local existing name
  existing="$(gh release view "$TAG" --repo "$REPO" --json assets --jq '.assets[].name' || true)"
  while IFS= read -r name; do
    [[ -z "$name" ]] && continue
    if [[ -z "${want[$name]+x}" ]]; then
      gh release delete-asset "$TAG" "$name" --repo "$REPO" --yes
    fi
  done <<< "$existing"
  gh release upload "$TAG" "${assets[@]}" --repo "$REPO" --clobber
}

# Verify BOTH required provenance attestations exist for the given artifact
# digest and are bound to the current release commit, using GitHub's
# attestation verification (not merely "a release already exists"). Fails
# closed (nonzero exit) if either attestation is missing or does not verify.
#
# Required: TAG, REPO, RELEASE_COMMIT env vars; the artifact must already be
# downloaded/available at `artifactPath`.
verify_required_attestations() {
  local artifactPath="$1"
  [[ -f "$artifactPath" ]] || { echo "::error::verify_required_attestations: artifact '$artifactPath' not found."; exit 1; }

  echo "Verifying build-provenance attestation for ${artifactPath}..."
  if ! gh attestation verify "$artifactPath" --repo "$REPO" --predicate-type https://slsa.dev/provenance/v1 >/tmp/attest-provenance.log 2>&1; then
    echo "::error::Required build-provenance attestation is missing or failed verification for ${artifactPath}."
    cat /tmp/attest-provenance.log || true
    exit 1
  fi

  echo "Verifying release-commit attestation for ${artifactPath}..."
  if ! gh attestation verify "$artifactPath" --repo "$REPO" \
      --predicate-type https://chaos-studio.dev/attestations/release-commit/v1 \
      >/tmp/attest-release-commit.log 2>&1; then
    echo "::error::Required release-commit attestation is missing or failed verification for ${artifactPath}."
    cat /tmp/attest-release-commit.log || true
    exit 1
  fi

  # Confirm the release-commit attestation's predicate names THIS run's
  # verified release commit, not merely that the predicate type is present
  # (a stale attestation from a different commit must not be accepted).
  local boundCommit
  boundCommit="$(gh attestation verify "$artifactPath" --repo "$REPO" \
      --predicate-type https://chaos-studio.dev/attestations/release-commit/v1 \
      --format json 2>/dev/null \
      | jq -r '.[0].verificationResult.statement.predicate.releaseCommit // empty' 2>/dev/null || true)"
  if [[ -n "$boundCommit" && "$boundCommit" != "$RELEASE_COMMIT" ]]; then
    echo "::error::Release-commit attestation for ${artifactPath} is bound to ${boundCommit}, expected ${RELEASE_COMMIT}."
    exit 1
  fi

  echo "Both required attestations verified for ${artifactPath} (build-provenance + release-commit)."
}
