import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * R3 (E6 review): publish-pypi must not rely on the earlier github-release
 * job's environment-protection preflight to gate its OWN publication. A
 * failed-job-only retry (GitHub Actions "re-run failed jobs") skips any
 * already-succeeded job, including github-release, and re-runs ONLY
 * publish-pypi. If that job merely trusted the prior successful prerequisite,
 * a `pypi` environment whose protections were removed or weakened between
 * attempts would let OIDC publication proceed unguarded. This suite proves
 * publish-pypi carries its OWN preflight that re-verifies the `pypi`
 * environment's protections on every attempt, fails closed on missing
 * verification credentials, and runs BEFORE any publish/upload step.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const workflowPath = join(__dirname, '..', '..', '.github', 'workflows', 'release.yml');

function readWorkflow(): string {
  return readFileSync(workflowPath, 'utf8').replace(/\r\n/g, '\n');
}

function publishPypiJobSlice(text: string): string {
  const start = text.search(/\n {2}publish-pypi:\n/);
  assert.ok(start >= 0, 'publish-pypi job not found in release.yml');
  // publish-pypi is followed by no further top-level jobs in this workflow at
  // the time of writing, but slice defensively to the next top-level job (two
  // spaces of indentation followed by a bare `key:`) if one is ever added.
  const rest = text.slice(start + 1);
  const nextTopLevel = rest.slice(1).search(/\n {2}\S[^\n]*:\n/);
  return nextTopLevel === -1 ? text.slice(start) : text.slice(start, start + 1 + nextTopLevel + 1);
}

test('publish-pypi does not depend solely on github-release for its own environment-protection gating', () => {
  const job = publishPypiJobSlice(readWorkflow());
  assert.match(
    job,
    /Preflight — revalidate the pypi environment protections on THIS attempt/,
    'publish-pypi must carry its own preflight step that re-verifies pypi protections on every attempt'
  );
});

test('the pypi preflight step precedes every publish/upload step in the job (revalidation happens before publication)', () => {
  const job = publishPypiJobSlice(readWorkflow());
  const preflightIdx = job.indexOf('Preflight — revalidate the pypi environment protections');
  assert.ok(preflightIdx >= 0);
  const publishIdx = job.search(/name:\s*Publish to PyPI|pypa\/gh-action-pypi-publish/);
  assert.ok(publishIdx >= 0, 'expected a PyPI publish step in publish-pypi');
  assert.ok(preflightIdx < publishIdx, 'the preflight revalidation must run BEFORE the publish step, not after');
});

test('the preflight fails closed when the verification token is unavailable, rather than skipping the check', () => {
  const job = publishPypiJobSlice(readWorkflow());
  const preflightStart = job.indexOf('Preflight — revalidate the pypi environment protections');
  const preflight = job.slice(preflightStart, preflightStart + 4000);
  assert.match(preflight, /if \[\[ -z "\$\{GH_TOKEN:-\}" \]\]/, 'must explicitly check for a missing token');
  assert.match(preflight, /exit 1/, 'a missing token must fail the job, not merely warn');
});

test('the preflight independently re-checks required reviewers, prevent_self_review, can_admins_bypass, and the single default-branch deployment policy', () => {
  const job = publishPypiJobSlice(readWorkflow());
  const preflightStart = job.indexOf('Preflight — revalidate the pypi environment protections');
  const preflight = job.slice(preflightStart, preflightStart + 4000);
  assert.match(preflight, /required_reviewers/);
  assert.match(preflight, /prevent_self_review/);
  assert.match(preflight, /can_admins_bypass/);
  assert.match(preflight, /deployment_branch_policy/);
  assert.match(preflight, /deployment-branch-policies/);
  // Every branch of the check must fail closed (exit 1), not merely log.
  const exitCount = (preflight.match(/exit 1/g) ?? []).length;
  assert.ok(exitCount >= 5, `expected at least 5 fail-closed branches in the preflight, found ${exitCount}`);
});

test('publish-pypi still declares the native `environment: pypi` gate as defense in depth (not a replacement for the preflight)', () => {
  const job = publishPypiJobSlice(readWorkflow());
  assert.match(job, /environment:\s*\n\s*name:\s*pypi/, 'the environment: pypi gate must remain declared');
});

test('the preflight uses a pypi-scoped read-only verification credential, not the release-writing ACTION_RELEASE_TOKEN', () => {
  const job = publishPypiJobSlice(readWorkflow());
  assert.match(
    job,
    /GH_TOKEN:\s*\$\{\{\s*secrets\.PYPI_VERIFY_TOKEN\s*\}\}/,
    'publish-pypi must authenticate its preflight with a dedicated PYPI_VERIFY_TOKEN, not ACTION_RELEASE_TOKEN (environment secrets are not shared across environments)'
  );
  assert.doesNotMatch(
    job,
    /secrets\.ACTION_RELEASE_TOKEN/,
    'publish-pypi must not reference ACTION_RELEASE_TOKEN — that secret lives only on release/mcp-release environments and would always be empty here'
  );
});

test('the preflight requires DEFAULT_BRANCH and enforces exact policy-name equality, not just policy type', () => {
  const job = publishPypiJobSlice(readWorkflow());
  assert.match(
    job,
    /DEFAULT_BRANCH:\s*\$\{\{\s*github\.event\.repository\.default_branch\s*\}\}/,
    'publish-pypi must be given DEFAULT_BRANCH (it is not otherwise in scope for this job)'
  );
  const preflightStart = job.indexOf('Preflight — revalidate the pypi environment protections');
  const preflight = job.slice(preflightStart, preflightStart + 4000);
  assert.match(
    preflight,
    /if \[\[ -z "\$\{DEFAULT_BRANCH:-\}" \]\]/,
    'must fail closed under set -u if DEFAULT_BRANCH is somehow unavailable'
  );
  assert.match(
    preflight,
    /\$ptype"\s*!=\s*"branch"\s*\|\|\s*"\$pname"\s*!=\s*"\$DEFAULT_BRANCH"/,
    'must require BOTH policy type == branch AND policy name == exactly DEFAULT_BRANCH — a wildcard or non-default-named branch policy must be rejected'
  );
});

test('CONTRIBUTING.md documents PYPI_VERIFY_TOKEN provisioning on the pypi environment', () => {
  const contributingPath = join(__dirname, '..', '..', 'CONTRIBUTING.md');
  const contributing = readFileSync(contributingPath, 'utf8');
  assert.match(
    contributing,
    /PYPI_VERIFY_TOKEN/,
    'CONTRIBUTING.md must document the PYPI_VERIFY_TOKEN credential used by the pypi preflight'
  );
  assert.match(
    contributing,
    /gh secret set PYPI_VERIFY_TOKEN --env pypi/,
    'CONTRIBUTING.md must show provisioning PYPI_VERIFY_TOKEN as an environment secret on pypi'
  );
});

test('verify-release-protections.sh checks for the PYPI_VERIFY_TOKEN environment secret on pypi (aligned with the workflow credential)', () => {
  const verifierPath = join(__dirname, '..', '..', 'scripts', 'verify-release-protections.sh');
  const verifier = readFileSync(verifierPath, 'utf8');
  assert.match(
    verifier,
    /environments\/\$\{envname\}\/secrets\/PYPI_VERIFY_TOKEN/,
    'the standalone verifier must check for PYPI_VERIFY_TOKEN on the pypi environment, matching the workflow credential'
  );
  assert.doesNotMatch(
    verifier,
    /pypi.*uses a trusted publisher and holds no token/i,
    'the verifier must no longer claim pypi holds no token now that PYPI_VERIFY_TOKEN is required'
  );
});

