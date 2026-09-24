import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

/**
 * E5-T2 — committed `dist/` integrity. The GitHub Marketplace and the Azure
 * Pipelines VSIX ship the committed runtime bundles directly, so `dist/` must be
 * exactly the set of files `scripts/build.mjs` declares (no stale or extra
 * files), and every committed bundle must be a regular, non-empty, syntactically
 * valid JavaScript file. Scope: this is a structural file-set + syntax check
 * (deterministic, non-mutating). The stronger byte-for-byte reproducibility gate
 * (clean rebuild + git blob-hash comparison) runs in CI (`.github/workflows/test.yml`)
 * and the Node 24 primary + Node 20 fallback smoke checks run in the OneBranch pipelines; this test
 * does not duplicate those (it must not mutate the working tree).
 */

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const distDir = join(repoRoot, 'dist');

/** Recursively list files under a directory, as repo-relative POSIX paths. */
function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full));
    else out.push(relative(repoRoot, full).split('\\').join('/'));
  }
  return out;
}

/** The dist paths `scripts/build.mjs` declares it produces (its single source of truth). */
function declaredDistFiles(): string[] {
  const build = readFileSync(join(repoRoot, 'scripts', 'build.mjs'), 'utf8');
  return [...build.matchAll(/path:\s*'(dist\/[^']+)'/g)].map((m) => m[1]!);
}

test('the committed dist tree is exactly the set scripts/build.mjs produces (no stale or missing files)', () => {
  const committed = listFiles(distDir).sort();
  const declared = [...new Set(declaredDistFiles())].sort();
  assert.deepEqual(committed, declared, 'committed dist file set matches the build manifest');
});

test('dist ships both platform entrypoints and their READMEs', () => {
  const committed = new Set(listFiles(distDir));
  for (const required of [
    'dist/github-action/index.js',
    'dist/github-action/README.md',
    'dist/azure-pipelines-task/index.js',
    'dist/azure-pipelines-task/README.md',
  ]) {
    assert.ok(committed.has(required), `dist contains ${required}`);
  }
});

test('every committed dist entrypoint is a regular, non-empty, syntactically valid JS file (node --check)', () => {
  for (const rel of ['dist/github-action/index.js', 'dist/azure-pipelines-task/index.js']) {
    const full = join(repoRoot, rel);
    assert.ok(statSync(full).isFile(), `${rel} is a regular file`);
    assert.ok(readFileSync(full, 'utf8').length > 0, `${rel} is non-empty`);
    // `node --check` parses the file under the current Node without executing it;
    // it throws on a syntax error, failing the test.
    assert.doesNotThrow(
      () => execFileSync(process.execPath, ['--check', full], { stdio: 'pipe' }),
      `${rel} parses under node --check`,
    );
  }
});

test('neither committed dist entrypoint carries the placeholder sentinel (R1: bundled adapters, not fail-fast stubs)', () => {
  const SENTINEL = ['__CHAOS_STUDIO', 'PLACEHOLDER', 'BUNDLE__'].join('_');
  for (const rel of ['dist/github-action/index.js', 'dist/azure-pipelines-task/index.js']) {
    const content = readFileSync(join(repoRoot, rel), 'utf8');
    assert.ok(!content.includes(SENTINEL), `${rel} must not contain the placeholder sentinel — release gates grep for it`);
    // A real bundle is substantially larger than a one-line fail-fast stub: the
    // adapter plus its runtime dependencies (@actions/core / @azure/identity /
    // azure-pipelines-task-lib) bundle to well over 100KB.
    assert.ok(content.length > 100_000, `${rel} looks like a bundled adapter, not a stub (${content.length} bytes)`);
  }
});

test('each committed dist entrypoint runs as an executable, self-contained Node process and fails closed with no inputs (R1 smoke path)', () => {
  // GitHub Actions signals failure via a nonzero process exit; Azure Pipelines
  // tasks signal failure via the `##vso[task.complete result=Failed;...]`
  // logging command (the agent parses stdout, not the process exit code), so
  // each platform is checked against its own actual failure signal.
  const expectations: Record<string, (result: ReturnType<typeof spawnSync>) => void> = {
    'dist/github-action/index.js': (result) => {
      assert.notEqual(result.status, 0, 'the GitHub Action bundle must exit nonzero when required inputs are missing');
    },
    'dist/azure-pipelines-task/index.js': (result) => {
      const output = `${result.stdout}${result.stderr}`;
      assert.match(
        output,
        /##vso\[task\.complete result=Failed/,
        'the Azure Pipelines task bundle must report a Failed task result when required inputs are missing',
      );
    },
  };
  for (const [rel, expect] of Object.entries(expectations)) {
    const full = join(repoRoot, rel);
    // Executed with NO platform-specific env/inputs set: each adapter's
    // fail-closed input validation (FR14) must reject before any network call,
    // proving the bundle is a real, runnable adapter rather than a stub that
    // merely parses. A clean environment (no ambient GITHUB_*/AZP_* vars) keeps
    // this deterministic across CI and local shells.
    const result = spawnSync(process.execPath, [full], {
      encoding: 'utf8',
      timeout: 15_000,
      env: { PATH: process.env['PATH'] ?? '' },
    });
    const output = `${result.stdout}${result.stderr}`;
    assert.ok(output.length > 0, `${rel} produced diagnostic output`);
    expect(result);
  }
});
