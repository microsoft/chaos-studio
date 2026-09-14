import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const repoRoot = new URL('../../', import.meta.url);
const readText = (path: string): string => readFileSync(new URL(path, repoRoot), 'utf8');

test('every E5 suite and its supporting files trigger TypeScript tests and typechecking', () => {
  const workflow = readText('.github/workflows/test.yml');
  const filter = workflow.slice(workflow.indexOf('            typescript:'), workflow.indexOf('\n  typescript:'));
  for (const path of ['test/**', 'docs/**', 'security/**', '.github/workflows/supply-chain.yml']) {
    assert.ok(filter.includes(`- '${path}'`), `${path} triggers the TypeScript job`);
  }
  assert.match(workflow, /run: npm run typecheck/);
  assert.match(workflow, /run: npm test/);
});

test('secret scanning runs on fork PRs without a license or secrets and fails closed', () => {
  const workflow = readText('.github/workflows/supply-chain.yml');
  const scan = workflow.slice(workflow.indexOf('\n  secret-scan:'), workflow.indexOf('\n  audit-and-rbac:'));
  assert.match(workflow, /\n  pull_request:/);
  assert.doesNotMatch(workflow, /\n\s+paths(?:-ignore)?:/);
  assert.doesNotMatch(scan, /gitleaks\/gitleaks-action|secrets\.|GITLEAKS_LICENSE|\n\s+if:|continue-on-error|\|\| true/);
  assert.match(scan, /fetch-depth: 0/);
  assert.match(scan, /persist-credentials: false/);
  assert.match(scan, /set -euo pipefail/);
  assert.match(scan, /curl --fail --silent --show-error --location/);
  assert.match(scan, /https:\/\/github\.com\/gitleaks\/gitleaks\/releases\/download\/v8\.30\.0\/gitleaks_8\.30\.0_linux_x64\.tar\.gz/);
  assert.match(scan, /79a3ab579b53f71efd634f3aaf7e04a0fa0cf206b7ed434638d1547a2470a66e {2}gitleaks\.tar\.gz/);
  const verify = scan.indexOf('sha256sum --check --strict');
  const extract = scan.indexOf('tar -xzf');
  const execute = scan.indexOf('"$scanner_dir/gitleaks" git');
  assert.ok(verify >= 0 && extract > verify && execute > extract, 'verify the pinned archive before extraction/execution');
  assert.match(scan, /git "\$GITHUB_WORKSPACE" --redact --log-opts="--all"/);
  assert.match(scan, /--gitleaks-ignore-path "\$GITHUB_WORKSPACE\/security\/gitleaks-history.ignore"/);
});

test('secret scan exceptions identify only the three historical synthetic redaction fixtures', () => {
  const exceptions = readText('security/gitleaks-history.ignore')
    .split(/\r?\n/).filter((line) => line.length > 0 && !line.startsWith('#'));
  const prefix = '0a3b126f0b723ed540c3c506b77afa9796fea327:packages/core/test/core/redaction.test.ts:';
  assert.deepEqual(exceptions.sort(), [
    `${prefix}generic-api-key:26`,
    `${prefix}generic-api-key:39`,
    `${prefix}jwt:17`,
  ]);
});
