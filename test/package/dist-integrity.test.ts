import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * E5-T2 — committed `dist/` integrity. The GitHub Marketplace and the Azure
 * Pipelines VSIX ship the committed runtime bundles directly, so `dist/` must be
 * exactly the set of files `scripts/build.mjs` declares (no stale or extra
 * files), and every committed bundle must be a regular, non-empty, syntactically
 * valid JavaScript file. Scope: this is a structural file-set + syntax check
 * (deterministic, non-mutating). The stronger byte-for-byte reproducibility gate
 * (clean rebuild + git blob-hash comparison) runs in CI (`.github/workflows/test.yml`)
 * and the Node 20 runtime-parity smoke runs in the OneBranch pipeline; this test
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
