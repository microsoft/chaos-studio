import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * E6-T2 — "both marketplaces are released from ONE commit" is only enforced if
 * each pipeline is bound to the SAME release commit, not merely to *a* commit
 * that carries *a* green receipt.
 *
 * The receipt gates prove, on each side independently, that the commit being
 * shipped descends from the receipt's validated core commit and ships identical
 * trees. Two DIFFERENT receipt-bearing descendants satisfy that independently:
 * the Action could be released from one and the VSIX from another, and both
 * gates would pass while the two marketplaces shipped different commits.
 *
 * The GitHub release makes its choice durable and immutable: the exact version
 * tag (`v1.2.3`) resolves to the released commit. `scripts/lib/release-commit.mjs`
 * makes that tag the SHARED RELEASE RECORD the OneBranch publication must agree
 * with — it resolves the tag and rejects a build commit that is anything other
 * than the commit the GitHub release actually shipped.
 */

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const CLI = join(repoRoot, 'scripts', 'lib', 'release-commit.mjs');

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function writeFile(root: string, rel: string, contents: string): void {
  const file = join(root, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, contents, 'utf8');
}

/** One commit on top of HEAD, returning its SHA. */
function commit(root: string, rel: string, contents: string): string {
  writeFile(root, rel, contents);
  git(root, 'add', '-A');
  git(root, 'commit', '--quiet', '-m', rel);
  return git(root, 'rev-parse', 'HEAD').trim();
}

/**
 * A throwaway repository modelling a release: a validated core commit, then TWO
 * receipt-bearing descendants of it. Both would satisfy the per-pipeline receipt
 * gates; only one is the commit the GitHub release tagged.
 */
function scaffold(): { root: string; core: string; released: string; other: string } {
  const root = mkdtempSync(join(tmpdir(), 'release-commit-'));
  git(root, 'init', '--quiet', '-b', 'main');
  git(root, 'config', 'user.email', 'rv@example.test');
  git(root, 'config', 'user.name', 'RV');
  const core = commit(root, 'packages/core/src/contract.ts', 'export const API_VERSION = "x";\n');
  const released = commit(root, 'test/release-validation/receipts/v1.0.0.json', '{"a":1}\n');
  // A SECOND receipt-bearing descendant: same shipped trees, different commit.
  const other = commit(root, 'docs/notes.md', 'later\n');
  return { root, core, released, other };
}

function assertTagCommit(root: string, tag: string, buildCommit: string): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [CLI, 'assert-tag-commit', tag, buildCommit], {
    cwd: root,
    encoding: 'utf8',
  });
}

function cleanup(root: string): void {
  rmSync(root, { recursive: true, force: true });
}

test('the build commit is accepted when it IS the commit the release tag resolves to', () => {
  const { root, released } = scaffold();
  try {
    git(root, 'tag', '-a', 'v1.0.0', '-m', 'release', released);
    const result = assertTagCommit(root, 'v1.0.0', released);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`^release-commit=${released}$`, 'm'));
  } finally {
    cleanup(root);
  }
});

test('a lightweight tag is resolved the same way', () => {
  const { root, released } = scaffold();
  try {
    git(root, 'tag', 'v1.0.0', released);
    assert.equal(assertTagCommit(root, 'v1.0.0', released).status, 0);
  } finally {
    cleanup(root);
  }
});

test('a DIFFERENT receipt-bearing descendant is rejected: it is not the released commit', () => {
  const { root, released, other } = scaffold();
  try {
    git(root, 'tag', '-a', 'v1.0.0', '-m', 'release', released);
    // `other` descends from the same validated core commit and carries the same
    // receipt, so every per-pipeline gate would pass on it — but the GitHub
    // release shipped `released`, so publishing the VSIX from it would break the
    // one-commit guarantee.
    const result = assertTagCommit(root, 'v1.0.0', other);
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, new RegExp(other));
    assert.match(result.stderr, new RegExp(released));
    assert.match(result.stderr, /v1\.0\.0/);
  } finally {
    cleanup(root);
  }
});

test('an ANCESTOR of the released commit is rejected too (the binding is equality, not ancestry)', () => {
  const { root, core, released } = scaffold();
  try {
    git(root, 'tag', '-a', 'v1.0.0', '-m', 'release', released);
    const result = assertTagCommit(root, 'v1.0.0', core);
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, new RegExp(core));
  } finally {
    cleanup(root);
  }
});

test('a missing release tag blocks publication rather than passing unbound', () => {
  const { root, released } = scaffold();
  try {
    const result = assertTagCommit(root, 'v1.0.0', released);
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, /v1\.0\.0/);
    // The operator needs to know the GitHub release comes first.
    assert.match(result.stderr, /release-action|GitHub release/i);
  } finally {
    cleanup(root);
  }
});

test('a BRANCH named like the tag can never satisfy the binding', () => {
  const { root, released } = scaffold();
  try {
    // Only `refs/tags/<tag>` is the shared release record. A branch (or any other
    // revision spelling) must not be accepted in its place.
    git(root, 'branch', 'v1.0.0', released);
    const result = assertTagCommit(root, 'v1.0.0', released);
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, /v1\.0\.0/);
  } finally {
    cleanup(root);
  }
});

test('a build commit that does not resolve in this repository fails closed', () => {
  const { root, released } = scaffold();
  try {
    git(root, 'tag', '-a', 'v1.0.0', '-m', 'release', released);
    const result = assertTagCommit(root, 'v1.0.0', 'f'.repeat(40));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /f{40}/);
  } finally {
    cleanup(root);
  }
});

test('the tag argument must be an exact SemVer version tag, and can never be a path or a revision', () => {
  const { root, released } = scaffold();
  try {
    git(root, 'tag', '-a', 'v1.0.0', '-m', 'release', released);
    for (const bad of [
      'v1.0.0-preview.1', // the release workflow refuses prerelease tags
      'v01.2.3', // leading zeros
      'v1.0', // not three parts
      '../../etc/passwd',
      'refs/tags/v1.0.0',
      'HEAD',
      'v1.0.0 ; rm -rf /',
      '',
    ]) {
      const result = assertTagCommit(root, bad, released);
      assert.equal(result.status, 2, `'${bad}' must be a usage error, got ${result.status}`);
    }
  } finally {
    cleanup(root);
  }
});

test('the CLI fails closed on a missing argument, an unknown command, or a non-repository', () => {
  const { root, released } = scaffold();
  try {
    assert.equal(
      spawnSync(process.execPath, [CLI, 'assert-tag-commit', 'v1.0.0'], { cwd: root, encoding: 'utf8' }).status,
      2,
    );
    assert.equal(
      spawnSync(process.execPath, [CLI, 'trust-me', 'v1.0.0', released], { cwd: root, encoding: 'utf8' }).status,
      2,
    );
    assert.equal(spawnSync(process.execPath, [CLI], { cwd: root, encoding: 'utf8' }).status, 2);

    const notARepo = mkdtempSync(join(tmpdir(), 'release-commit-bare-'));
    try {
      const result = spawnSync(process.execPath, [CLI, 'assert-tag-commit', 'v1.0.0', released], {
        cwd: notARepo,
        encoding: 'utf8',
      });
      assert.notEqual(result.status, 0);
    } finally {
      rmSync(notARepo, { recursive: true, force: true });
    }
  } finally {
    cleanup(root);
  }
});
