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
