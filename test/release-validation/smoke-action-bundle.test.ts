import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Exercises the ACTUAL packaged release smoke harness
 * (`scripts/smoke-action-bundle.mjs`) end-to-end — a plain `node <script>
 * <bundle>` child process, exactly as the release workflow invokes it —
 * against both real committed bundles plus synthetic bundles engineered to
 * hit every failure mode the harness must reject. This closes the gap the
 * plan review identified: the ordinary unit suite exercised the harness's
 * internal helpers, but never the harness as a subprocess against a bundle
 * that (a) ignores `CHAOS_STUDIO_SMOKE_CHECK` and exits 0 anyway (the Azure
 * adapter's pre-fix bug) or (b) exits non-zero deliberately.
 */

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const HARNESS = join(repoRoot, 'scripts', 'smoke-action-bundle.mjs');
const REAL_BUNDLES = ['dist/github-action/index.js', 'dist/azure-pipelines-task/index.js'] as const;

function runHarness(bundlePath: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [HARNESS, bundlePath], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

for (const rel of REAL_BUNDLES) {
  test(`packaged smoke harness passes the real committed bundle: ${rel}`, () => {
    const bundlePath = join(repoRoot, rel);
    assert.ok(existsSync(bundlePath), `expected ${rel} to be built (run \`node scripts/build.mjs\` first)`);
    const { status, stdout, stderr } = runHarness(bundlePath);
    assert.equal(status, 0, `harness must exit 0 for a healthy bundle; stderr: ${stderr}`);
    assert.match(stdout, /passed the deterministic smoke self-test/);
  });
}

test('packaged smoke harness fails closed on a bundle that exits non-zero', () => {
  const dir = mkdtempSync(join(tmpdir(), 'smoke-fail-'));
  const bundle = join(dir, 'index.js');
  writeFileSync(bundle, "process.exit(1);\n", 'utf8');
  try {
    const { status, stderr } = runHarness(bundle);
    assert.equal(status, 1);
    assert.match(stderr, /expected 0/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('packaged smoke harness fails closed on a bundle that throws during self-test', () => {
  const dir = mkdtempSync(join(tmpdir(), 'smoke-throw-'));
  const bundle = join(dir, 'index.js');
  writeFileSync(bundle, "throw new Error('boom');\n", 'utf8');
  try {
    const { status } = runHarness(bundle);
    assert.equal(status, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('packaged smoke harness fails closed on the placeholder sentinel', () => {
  const dir = mkdtempSync(join(tmpdir(), 'smoke-placeholder-'));
  const bundle = join(dir, 'index.js');
  const sentinel = ['__CHAOS_STUDIO', 'PLACEHOLDER', 'BUNDLE__'].join('_');
  writeFileSync(bundle, `console.log(${JSON.stringify(sentinel)});\nprocess.exit(0);\n`, 'utf8');
  try {
    const { status, stderr } = runHarness(bundle);
    assert.equal(status, 1);
    assert.match(stderr, /placeholder sentinel/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('packaged smoke harness requires a bundle argument', () => {
  const result = spawnSync(process.execPath, [HARNESS], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.status, 1);
  assert.match(result.stderr ?? '', /requires a bundle path argument/);
});
