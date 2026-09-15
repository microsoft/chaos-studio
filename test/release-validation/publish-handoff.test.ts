import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, chmodSync, mkdirSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * R1 — the isolated `publish` job's staging/publication steps `source
 * scripts/lib/release-asset-verify.sh`, but that job intentionally runs no
 * `actions/checkout` (no working tree from any commit is ever placed on disk
 * beside the publishing secret). Without a step that materializes that one
 * file, publication fails with a missing-file error before completing. These
 * tests pin BOTH halves of the fix: (1) the workflow text shows a dedicated
 * materialization step, ordered before every `source` of the helper, that
 * extracts the file BY CONTENT from a bare Git object (not a working-tree
 * checkout of arbitrary release code); and (2) a publication-handoff
 * simulation — a clean job filesystem populated only by the declared
 * `actions/download-artifact` output plus the same `git cat-file` extraction
 * the workflow performs — where the same commands the workflow's `run:`
 * blocks execute actually succeed at loading and using the helper.
 */

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const workflowPath = join(repoRoot, '.github', 'workflows', 'release-action.yml');
const readWorkflow = (): string => readFileSync(workflowPath, 'utf8').replace(/\r\n/g, '\n');

function publishJobSlice(text: string): string {
  const start = text.search(/\n {2}publish:\n/);
  assert.ok(start >= 0, 'publish job not found in release-action.yml');
  return text.slice(start);
}

function bashAvailable(): boolean {
  return spawnSync('bash', ['-c', 'true'], { encoding: 'utf8' }).status === 0;
}

function toBashPath(p: string): string {
  if (process.platform !== 'win32') return p;
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(p);
  if (!m) return p.replace(/\\/g, '/');
  return `/mnt/${m[1]!.toLowerCase()}/${m[2]!.replace(/\\/g, '/')}`;
}

function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

test('the publish job never checks out the repository (no actions/checkout beside the publishing secret)', () => {
  const publish = publishJobSlice(readWorkflow());
  assert.doesNotMatch(publish, /uses:\s*actions\/checkout@/, 'the publish job must not run actions/checkout');
});

test('a dedicated step materializes scripts/lib/release-asset-verify.sh BY CONTENT from a bare Git object, before it is sourced anywhere', () => {
  const publish = publishJobSlice(readWorkflow());

  const materializeIdx = publish.search(/Materialize the shared release-gate helper/);
  assert.ok(materializeIdx > 0, 'expected a step that materializes the shared release-gate helper');

  // Must extract the file BY CONTENT from a git object (git cat-file), not by
  // checking out a working tree of arbitrary release-commit code.
  const materializeStep = publish.slice(materializeIdx, publish.indexOf('\n      - name:', materializeIdx + 1));
  assert.match(
    materializeStep,
    /git -C "\$BARE" cat-file blob "\$\{DEFAULT_TIP\}:scripts\/lib\/release-asset-verify\.sh"/,
    'the helper must be extracted by content from a single trusted git blob, not from a working-tree checkout',
  );
  // Must be sourced from DEFAULT_TIP (the trusted, protected default-branch
  // commit this job's own `if:` guard already requires), not RELEASE_COMMIT
  // (which can be an older ancestor tag/retry and is not what defines this
  // workflow's own steps).
  assert.doesNotMatch(materializeStep, /\$\{RELEASE_COMMIT\}:scripts/, 'the helper must not be sourced from the release commit');
  assert.doesNotMatch(materializeStep, /uses:\s*actions\/checkout/, 'materializing the helper must not use actions/checkout');

  // Every `source scripts/lib/release-asset-verify.sh` in the publish job must
  // come AFTER the materialization step.
  const sourceCalls = [...publish.matchAll(/source scripts\/lib\/release-asset-verify\.sh/g)];
  assert.ok(sourceCalls.length >= 2, 'expected the staging AND publication steps to source the helper');
  for (const call of sourceCalls) {
    assert.ok(
      call.index! > materializeIdx,
      'every `source scripts/lib/release-asset-verify.sh` must occur after the materialization step',
    );
  }

  // The materialization step itself must run after the bare mirror (BARE env)
  // is prepared, since it reads from $BARE.
  const bareMirrorIdx = publish.search(/Prepare a bare Git mirror/);
  assert.ok(bareMirrorIdx > 0 && bareMirrorIdx < materializeIdx, 'the bare mirror must be prepared before the helper is materialized from it');
});

test(
  'publication handoff: sourcing the helper succeeds in a clean job filesystem populated only by the declared artifact + bare-git extraction (no repo checkout)',
  { skip: !bashAvailable() ? 'bash is required for this simulation' : false },
  () => {
    // Simulates the ACTUAL publish-job filesystem shape at the point the
    // staging step runs: a fresh directory containing ONLY (a) the downloaded
    // `pkg/` artifact (what actions/download-artifact would place) and (b)
    // whatever the materialization step itself writes — nothing else, and
    // critically NO working-tree checkout of the repository. If the
    // materialization step were missing (the R1 bug), `source
    // scripts/lib/release-asset-verify.sh` in this exact filesystem shape
    // fails with a missing-file error; this test proves it now succeeds.
    const jobDir = mkdtempSync(join(tmpdir(), 'publish-handoff-'));
    const pkgDir = join(jobDir, 'pkg');
    mkdirSync(pkgDir);
    writeFileSync(join(pkgDir, 'action-bundle.tar.gz'), 'synthetic');
    writeFileSync(join(pkgDir, 'action-bundle.tar.gz.sha256'), 'deadbeef  action-bundle.tar.gz\n');
    writeFileSync(join(pkgDir, 'dist-manifest.tsv'), '');

    // Build a minimal bare repo carrying exactly one committed file at
    // DEFAULT_TIP: scripts/lib/release-asset-verify.sh (the real committed
    // library), so `git cat-file blob $DEFAULT_TIP:...` resolves exactly as
    // it does against the real repository's default branch.
    const seedDir = mkdtempSync(join(tmpdir(), 'publish-handoff-seed-'));
    const libSrc = readFileSync(join(repoRoot, 'scripts', 'lib', 'release-asset-verify.sh'), 'utf8').replace(/\r\n/g, '\n');
    mkdirSync(join(seedDir, 'scripts', 'lib'), { recursive: true });
    writeFileSync(join(seedDir, 'scripts', 'lib', 'release-asset-verify.sh'), libSrc);

    const script = [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      `cd ${shQuote(toBashPath(seedDir))}`,
      'git init --quiet .',
      'git config user.email test@example.com',
      'git config user.name test',
      'git add scripts/lib/release-asset-verify.sh',
      'git commit --quiet -m seed',
      'defaultTip=$(git rev-parse HEAD)',
      `bare=${shQuote(toBashPath(join(jobDir, 'release-bare.git')))}`,
      'git init --bare --quiet "$bare"',
      `git -C ${shQuote(toBashPath(seedDir))} push --quiet "$bare" HEAD:refs/heads/main`,
      '',
      `cd ${shQuote(toBashPath(jobDir))}`,
      // The exact materialization command the workflow step runs, against
      // this simulated $BARE/$DEFAULT_TIP — proving the publication handoff
      // (download-artifact output + bare-git extraction, nothing else) works.
      'mkdir -p scripts/lib',
      'git -C "$bare" cat-file blob "${defaultTip}:scripts/lib/release-asset-verify.sh" > scripts/lib/release-asset-verify.sh',
      'chmod 0644 scripts/lib/release-asset-verify.sh',
      '',
      // The staging AND publication steps then `source` it, in a FRESH shell
      // each (as GitHub Actions runs each `run:` step) — proving both are
      // now able to load the shared functions from this exact filesystem.
      '( source scripts/lib/release-asset-verify.sh; type compute_want_assets require_immutable verify_final_assets verify_required_attestations >/dev/null )',
      '( source scripts/lib/release-asset-verify.sh; type compute_want_assets require_immutable verify_final_assets verify_required_attestations >/dev/null )',
      'echo HANDOFF_OK',
      '',
    ].join('\n');

    const driver = join(jobDir, 'handoff.sh');
    writeFileSync(driver, script);
    chmodSync(driver, 0o755);

    const result = spawnSync('bash', [toBashPath(driver)], { encoding: 'utf8' });
    assert.equal(result.status, 0, `publication handoff failed:\n${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /HANDOFF_OK/);

    // Sanity check: pkg/ still contains ONLY the declared artifacts (nothing
    // from a repository checkout leaked into the job filesystem).
    assert.deepEqual(
      readdirSync(pkgDir).sort(),
      ['action-bundle.tar.gz', 'action-bundle.tar.gz.sha256', 'dist-manifest.tsv'],
    );
  },
);
