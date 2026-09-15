import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * E6-T2 — the POST-BUILD half of "both marketplaces ship the bytes RV1–RV3
 * validated".
 *
 * The receipt gate proves that the COMMITTED shipping paths (`packages`,
 * `action.yml`, `dist`, `azure-pipelines-extension`) are byte-identical between
 * the validated commit and the release commit. That is not sufficient on the
 * Azure Pipelines side, because the OneBranch pipeline REBUILDS `dist/` and
 * stages that generated runtime into the VSIX: a change to a build INPUT that
 * lives outside those four paths — `scripts/build.mjs`, the root dependency
 * metadata, a transitive bundler version — produces different packaged bytes
 * while every compared path is unchanged.
 *
 * `scripts/lib/verify-built-runtime.mjs` closes that gap by comparing the
 * REBUILT working-tree runtime against the runtime committed at the validated
 * commit — complete file set (added AND removed), git-normalized modes, and
 * blob hashes — before anything is staged, packaged, signed or published.
 */

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const CLI = join(repoRoot, 'scripts', 'lib', 'verify-built-runtime.mjs');

const ENTRYPOINTS = ['dist/github-action/index.js', 'dist/azure-pipelines-task/index.js'] as const;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function writeFile(root: string, rel: string, contents: string): void {
  const file = join(root, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, contents, 'utf8');
}

/**
 * A throwaway repository whose HEAD commit carries a `dist/` tree, plus the
 * build input that produced it. The working tree is what a rebuild would have
 * left behind, so a test mutates it to model a drifting build.
 */
function scaffold(dist: Record<string, string>): { root: string; commit: string } {
  const root = mkdtempSync(join(tmpdir(), 'built-runtime-'));
  git(root, 'init', '--quiet', '-b', 'main');
  git(root, 'config', 'user.email', 'rv@example.test');
  git(root, 'config', 'user.name', 'RV');
  // Keep the fixture's blob hashes independent of the harness platform's
  // autocrlf setting, exactly as the real gate requires.
  git(root, 'config', 'core.autocrlf', 'false');
  writeFile(root, 'scripts/build.mjs', '// bundler v1\n');
  for (const [rel, contents] of Object.entries(dist)) writeFile(root, rel, contents);
  git(root, 'add', '-A');
  git(root, 'commit', '--quiet', '-m', 'runtime');
  return { root, commit: git(root, 'rev-parse', 'HEAD').trim() };
}

function baselineDist(): Record<string, string> {
  return {
    'dist/github-action/index.js': 'console.log("action");\n',
    'dist/azure-pipelines-task/index.js': 'console.log("task");\n',
  };
}

function verify(root: string, commit: string): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [CLI, commit], { cwd: root, encoding: 'utf8' });
}

function cleanup(root: string): void {
  rmSync(root, { recursive: true, force: true });
}

test('the rebuilt runtime is accepted when it equals the validated commit exactly', () => {
  const { root, commit } = scaffold(baselineDist());
  try {
    const result = verify(root, commit);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /equals the runtime committed at/);
    assert.match(result.stdout, new RegExp(commit));
  } finally {
    cleanup(root);
  }
});

test('a changed BUILD INPUT that alters the rebuilt bytes is rejected even though every compared shipping path is unchanged', () => {
  const { root, commit } = scaffold(baselineDist());
  try {
    // The release-gate comparison (`git diff <validated> <build> -- packages
    // action.yml dist azure-pipelines-extension`) sees nothing: the committed
    // trees are identical. Only the build INPUT moved, and the rebuild emitted
    // different bytes into the working tree.
    writeFile(root, 'scripts/build.mjs', '// bundler v2\n');
    git(root, 'commit', '--quiet', '-am', 'bump the bundler');
    const buildCommit = git(root, 'rev-parse', 'HEAD').trim();
    assert.equal(
      spawnSync('git', ['diff', '--quiet', commit, buildCommit, '--', 'dist', 'packages', 'action.yml', 'azure-pipelines-extension'], { cwd: root }).status,
      0,
      'the four committed shipping paths are unchanged between the two commits',
    );

    writeFile(root, 'dist/github-action/index.js', 'console.log("action v2");\n');
    const result = verify(root, commit);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /dist\/github-action\/index\.js/);
    assert.match(result.stderr, /differs|changed/i);
  } finally {
    cleanup(root);
  }
});

test('a rebuilt runtime with an ADDED file is rejected', () => {
  const { root, commit } = scaffold(baselineDist());
  try {
    writeFile(root, 'dist/github-action/extra-chunk.js', 'module.exports = {};\n');
    const result = verify(root, commit);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /dist\/github-action\/extra-chunk\.js/);
    assert.match(result.stderr, /added|only in the rebuilt/i);
  } finally {
    cleanup(root);
  }
});

test('a rebuilt runtime with a REMOVED file is rejected', () => {
  const dist = { ...baselineDist(), 'dist/github-action/chunk.js': 'module.exports = 1;\n' };
  const { root, commit } = scaffold(dist);
  try {
    rmSync(join(root, 'dist', 'github-action', 'chunk.js'));
    const result = verify(root, commit);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /dist\/github-action\/chunk\.js/);
    assert.match(result.stderr, /missing|removed/i);
  } finally {
    cleanup(root);
  }
});

test('an empty rebuilt runtime cannot trivially pass', () => {
  const { root, commit } = scaffold(baselineDist());
  try {
    rmSync(join(root, 'dist'), { recursive: true, force: true });
    const result = verify(root, commit);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /no .*runtime files|produced no/i);
  } finally {
    cleanup(root);
  }
});

test('a validated commit that carries no runtime is rejected rather than treated as a match', () => {
  const { root, commit } = scaffold({});
  try {
    const result = verify(root, commit);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /committed/i);
  } finally {
    cleanup(root);
  }
});

test('a rebuilt runtime missing a shipping entrypoint is rejected', () => {
  const { root, commit } = scaffold(baselineDist());
  try {
    rmSync(join(root, 'dist', 'azure-pipelines-task'), { recursive: true, force: true });
    const result = verify(root, commit);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /dist\/azure-pipelines-task\/index\.js/);
  } finally {
    cleanup(root);
  }
});

test('an unresolvable or missing commit argument fails closed as a usage error', () => {
  const { root } = scaffold(baselineDist());
  try {
    assert.equal(spawnSync(process.execPath, [CLI], { cwd: root, encoding: 'utf8' }).status, 2);
    const unknown = verify(root, 'f'.repeat(40));
    assert.equal(unknown.status, 2);
    assert.match(unknown.stderr, /commit/i);
  } finally {
    cleanup(root);
  }
});

test('the shipping entrypoints the gate requires are the ones the runtime actually publishes', () => {
  for (const entrypoint of ENTRYPOINTS) {
    assert.ok(
      execFileSync('git', ['ls-tree', '-r', '--name-only', 'HEAD', '--', entrypoint], {
        cwd: repoRoot,
        encoding: 'utf8',
      }).trim().length > 0,
      `${entrypoint} is a committed shipping entrypoint`,
    );
  }
});
