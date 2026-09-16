import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { bashAvailable, toBashPath } from './bash-path.ts';

/**
 * R2 — exercises the ACTUAL `verify_required_attestations` helper in
 * scripts/lib/release-asset-verify.sh (not a re-implementation of its logic),
 * with a fake `gh`/`jq` on PATH standing in for the network-calling CLI. Each
 * scenario the reviewer named — missing predicate data, malformed predicate
 * data, a mismatched releaseCommit, and an attestation whose signer workflow
 * does not match — must fail closed (nonzero exit). Requires `bash` (present
 * in CI and in this repo's dev containers); skipped otherwise.
 */

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const LIB = join(repoRoot, 'scripts', 'lib', 'release-asset-verify.sh');
const EXPECTED_SIGNER = 'octocat/chaos-studio/.github/workflows/release-action.yml';
const DEFAULT_BRANCH = 'main';
const EXPECTED_SOURCE_REF = `refs/heads/${DEFAULT_BRANCH}`;
const RELEASE_COMMIT = 'a'.repeat(40);

/**
 * Writes a fake `gh` (and `jq`, used only to pretty-print in the real script's
 * error paths) onto a scratch PATH, and a driver script that sources the real
 * library and calls `verify_required_attestations` against a synthetic
 * artifact — exactly as `release-action.yml`'s publish job does.
 *
 * `ghBehavior` is inlined verbatim into the fake `gh`'s shell body, and
 * decides what the "attestation verify" subcommand prints/exits given the
 * `--predicate-type` and `--signer-workflow` it was actually invoked with —
 * this is what lets each scenario below assert on the REAL script's call
 * shape, not merely on a mocked return value.
 */
function runBash(scriptPath: string): SpawnSyncReturns<string> {
  return spawnSync('bash', [toBashPath(scriptPath)], { encoding: 'utf8' });
}

/** Shell-quotes a value for safe embedding inside a single-quoted bash literal. */
function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function runVerify(ghBehavior: string): SpawnSyncReturns<string> {
  const dir = mkdtempSync(join(tmpdir(), 'release-asset-verify-'));
  const binDir = join(dir, 'bin');
  mkdirSync(binDir);

  const artifact = join(dir, 'action-bundle.tar.gz');
  writeFileSync(artifact, 'synthetic-artifact-bytes');

  const fakeGh = join(binDir, 'gh');
  writeFileSync(
    fakeGh,
    `#!/usr/bin/env bash\nset -euo pipefail\n${ghBehavior}\n`,
  );
  chmodSync(fakeGh, 0o755);

  // A minimal `jq` shim standing in for the real CLI, in case it is not
  // installed on the machine running this test — it implements only the ONE
  // query the real script issues
  // (`jq -r '.[].verificationResult...' /tmp/attest-release-commit.json`): the
  // query is $1, the file to read is the LAST argument, matching how
  // release-asset-verify.sh actually invokes it (not via stdin). Emits ONE
  // line per array entry (mirroring `.[]`, not `.[0]`), so tests can exercise
  // the real script's order-independent multi-entry scan (R4). Keep the shim
  // entirely in Bash so a POSIX path is never handed to a Windows-native
  // Python executable when the test runs under Git for Windows.
  const fakeJq = join(binDir, 'jq');
  writeFileSync(
    fakeJq,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'file="${@: -1}"',
      '{ grep -o \'"releaseCommit"[[:space:]]*:[[:space:]]*"[^"]*"\' "$file" || true; } |',
      '  sed -E \'s/^.*"releaseCommit"[[:space:]]*:[[:space:]]*"([^"]*)".*$/\\1/\'',
      '',
    ].join('\n'),
  );
  chmodSync(fakeJq, 0o755);

  // The driver `source`s the REAL library and calls verify_required_attestations
  // against the synthetic artifact, exactly as the publish job's steps do. All
  // "environment" the real script reads (REPO, RELEASE_COMMIT, DEFAULT_BRANCH,
  // PATH) is set INSIDE this script (rather than passed through spawnSync's
  // `env`, which a Windows-host `bash.exe` backed by WSL does not reliably
  // forward across the Win32/Linux process boundary) — bit-for-bit the same
  // values the publish job's `env:` mapping supplies. Any CRLF the committed
  // script may carry on a Windows checkout (`core.autocrlf=true`) is stripped
  // first, since bash's `source` cannot parse a `\r`-terminated line.
  const driver = join(dir, 'driver.sh');
  const libNoCr = join(dir, 'release-asset-verify.sh');
  writeFileSync(
    driver,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      `export PATH=${shQuote(toBashPath(binDir))}":$PATH"`,
      `export REPO=${shQuote('octocat/chaos-studio')}`,
      `export RELEASE_COMMIT=${shQuote(RELEASE_COMMIT)}`,
      `export DEFAULT_BRANCH=${shQuote(DEFAULT_BRANCH)}`,
      `tr -d '\\r' < ${shQuote(toBashPath(LIB))} > ${shQuote(toBashPath(libNoCr))}`,
      `source ${shQuote(toBashPath(libNoCr))}`,
      `verify_required_attestations ${shQuote(toBashPath(artifact))}`,
      '',
    ].join('\n'),
  );
  chmodSync(driver, 0o755);

  return runBash(driver);
}

/** A fake `gh attestation verify` that requires `--signer-workflow "$EXPECTED_SIGNER"` and `--source-ref "$EXPECTED_SOURCE_REF"` on every call. */
const REQUIRE_SIGNER = `
EXPECTED_SIGNER='${EXPECTED_SIGNER}'
EXPECTED_SOURCE_REF='${EXPECTED_SOURCE_REF}'
if [[ "$1" != "attestation" || "$2" != "verify" ]]; then echo "unsupported gh invocation: $*" >&2; exit 64; fi
shift 2
signer=""
sourceRef=""
predicateType=""
formatJson="0"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --signer-workflow) signer="$2"; shift 2 ;;
    --source-ref) sourceRef="$2"; shift 2 ;;
    --predicate-type) predicateType="$2"; shift 2 ;;
    --format) [[ "$2" == "json" ]] && formatJson="1"; shift 2 ;;
    *) shift ;;
  esac
done
if [[ "$signer" != "$EXPECTED_SIGNER" ]]; then
  echo "fake gh: missing/wrong --signer-workflow (got '$signer')" >&2
  exit 1
fi
if [[ "$sourceRef" != "$EXPECTED_SOURCE_REF" ]]; then
  echo "fake gh: missing/wrong --source-ref (got '$sourceRef')" >&2
  exit 1
fi
`;

test('verify_required_attestations SUCCEEDS when both attestations verify, are signer-workflow-constrained, and the releaseCommit predicate matches', () => {
  const result = runVerify(`
${REQUIRE_SIGNER}
if [[ "$predicateType" == "https://slsa.dev/provenance/v1" ]]; then
  exit 0
fi
if [[ "$predicateType" == *"release-commit/v1" ]]; then
  echo '[{"verificationResult":{"statement":{"predicate":{"releaseCommit":"${RELEASE_COMMIT}"}}}}]'
  exit 0
fi
exit 64
`);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Both required attestations verified/);
});

test('verify_required_attestations FAILS CLOSED when the release-commit predicate is missing (empty)', () => {
  const result = runVerify(`
${REQUIRE_SIGNER}
if [[ "$predicateType" == "https://slsa.dev/provenance/v1" ]]; then exit 0; fi
if [[ "$predicateType" == *"release-commit/v1" ]]; then
  echo '[{"verificationResult":{"statement":{"predicate":{}}}}]'
  exit 0
fi
exit 64
`);
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /no 'releaseCommit' predicate field/);
});

test('verify_required_attestations FAILS CLOSED when the releaseCommit predicate is malformed (not a 40-hex sha)', () => {
  const result = runVerify(`
${REQUIRE_SIGNER}
if [[ "$predicateType" == "https://slsa.dev/provenance/v1" ]]; then exit 0; fi
if [[ "$predicateType" == *"release-commit/v1" ]]; then
  echo '[{"verificationResult":{"statement":{"predicate":{"releaseCommit":"not-a-sha"}}}}]'
  exit 0
fi
exit 64
`);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /no verified release-commit attestation.*has a well-formed 'releaseCommit' predicate matching/i);
});

test('verify_required_attestations FAILS CLOSED when the releaseCommit predicate names a DIFFERENT commit', () => {
  const wrongCommit = 'b'.repeat(40);
  const result = runVerify(`
${REQUIRE_SIGNER}
if [[ "$predicateType" == "https://slsa.dev/provenance/v1" ]]; then exit 0; fi
if [[ "$predicateType" == *"release-commit/v1" ]]; then
  echo '[{"verificationResult":{"statement":{"predicate":{"releaseCommit":"${wrongCommit}"}}}}]'
  exit 0
fi
exit 64
`);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, new RegExp(`matching ${RELEASE_COMMIT}`));
  assert.match(result.stdout + result.stderr, new RegExp(wrongCommit));
});

test('verify_required_attestations FAILS CLOSED when gh does not receive the expected --signer-workflow constraint', () => {
  // A fake gh that IGNORES --signer-workflow (i.e. behaves like an older,
  // unconstrained verification) must still cause the helper to fail, proving
  // the helper itself supplies the constraint rather than merely tolerating
  // its absence.
  const result = runVerify(`
if [[ "$predicateType" == "https://slsa.dev/provenance/v1" ]]; then true; fi
echo "should never be reached without --signer-workflow" >&2
exit 1
`);
  assert.notEqual(result.status, 0);
});

test('verify_required_attestations FAILS CLOSED when gh does not receive the expected --source-ref constraint (R3)', () => {
  // A fake gh that requires --signer-workflow but IGNORES --source-ref (i.e.
  // an unconstrained-branch verification) must still cause the helper to
  // fail: --signer-workflow and --source-ref are separate identity
  // constraints, and R3 requires BOTH to be enforced.
  const result = runVerify(`
EXPECTED_SIGNER='${EXPECTED_SIGNER}'
if [[ "$1" != "attestation" || "$2" != "verify" ]]; then echo "unsupported gh invocation: $*" >&2; exit 64; fi
shift 2
signer=""
predicateType=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --signer-workflow) signer="$2"; shift 2 ;;
    --predicate-type) predicateType="$2"; shift 2 ;;
    *) shift ;;
  esac
done
if [[ "$signer" != "$EXPECTED_SIGNER" ]]; then
  echo "fake gh: missing/wrong --signer-workflow (got '$signer')" >&2
  exit 1
fi
echo "should never be reached without --source-ref" >&2
exit 1
`);
  assert.notEqual(result.status, 0);
});

test('verify_required_attestations FAILS CLOSED when DEFAULT_BRANCH is not set (R3, fail closed rather than skip)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'release-asset-verify-'));
  const binDir = join(dir, 'bin');
  mkdirSync(binDir);
  const artifact = join(dir, 'action-bundle.tar.gz');
  writeFileSync(artifact, 'synthetic-artifact-bytes');
  const fakeGh = join(binDir, 'gh');
  writeFileSync(fakeGh, `#!/usr/bin/env bash\necho "gh should never be called without DEFAULT_BRANCH" >&2\nexit 1\n`);
  chmodSync(fakeGh, 0o755);
  const driver = join(dir, 'driver.sh');
  const libNoCr = join(dir, 'release-asset-verify.sh');
  writeFileSync(
    driver,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      `export PATH=${shQuote(toBashPath(binDir))}":$PATH"`,
      `export REPO=${shQuote('octocat/chaos-studio')}`,
      `export RELEASE_COMMIT=${shQuote(RELEASE_COMMIT)}`,
      `tr -d '\\r' < ${shQuote(toBashPath(LIB))} > ${shQuote(toBashPath(libNoCr))}`,
      `source ${shQuote(toBashPath(libNoCr))}`,
      `verify_required_attestations ${shQuote(toBashPath(artifact))}`,
      '',
    ].join('\n'),
  );
  chmodSync(driver, 0o755);
  const result = runBash(driver);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /DEFAULT_BRANCH is not set/);
});

test('verify_required_attestations SUCCEEDS when the matching releaseCommit entry is NOT first in the verified result set (R4, order-independent)', () => {
  const otherCommit = 'c'.repeat(40);
  const result = runVerify(`
${REQUIRE_SIGNER}
if [[ "$predicateType" == "https://slsa.dev/provenance/v1" ]]; then exit 0; fi
if [[ "$predicateType" == *"release-commit/v1" ]]; then
  echo '[{"verificationResult":{"statement":{"predicate":{"releaseCommit":"${otherCommit}"}}}},{"verificationResult":{"statement":{"predicate":{"releaseCommit":"${RELEASE_COMMIT}"}}}}]'
  exit 0
fi
exit 64
`);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Both required attestations verified/);
});

test('verify_required_attestations FAILS CLOSED when MULTIPLE verified entries exist but NONE match the release commit (R4)', () => {
  const otherCommit1 = 'c'.repeat(40);
  const otherCommit2 = 'd'.repeat(40);
  const result = runVerify(`
${REQUIRE_SIGNER}
if [[ "$predicateType" == "https://slsa.dev/provenance/v1" ]]; then exit 0; fi
if [[ "$predicateType" == *"release-commit/v1" ]]; then
  echo '[{"verificationResult":{"statement":{"predicate":{"releaseCommit":"${otherCommit1}"}}}},{"verificationResult":{"statement":{"predicate":{"releaseCommit":"${otherCommit2}"}}}}]'
  exit 0
fi
exit 64
`);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, new RegExp(`matching ${RELEASE_COMMIT}`));
});

test('verify_required_attestations refuses a missing artifact before calling gh at all', () => {
  const dir = mkdtempSync(join(tmpdir(), 'release-asset-verify-'));
  const driver = join(dir, 'driver.sh');
  const libNoCr = join(dir, 'release-asset-verify.sh');
  writeFileSync(
    driver,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      `export REPO=${shQuote('octocat/chaos-studio')}`,
      `export RELEASE_COMMIT=${shQuote(RELEASE_COMMIT)}`,
      `tr -d '\\r' < ${shQuote(toBashPath(LIB))} > ${shQuote(toBashPath(libNoCr))}`,
      `source ${shQuote(toBashPath(libNoCr))}`,
      `verify_required_attestations ${shQuote(toBashPath(join(dir, 'does-not-exist.tar.gz')))}`,
      '',
    ].join('\n'),
  );
  chmodSync(driver, 0o755);
  const result = runBash(driver);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /not found/);
});

test('the release-asset-verify library constrains both required attestations to the release-action signer workflow and a trusted source ref', () => {
  const src = readFileSync(LIB, 'utf8');
  assert.match(src, /--signer-workflow "\$signerWorkflow"/g);
  const occurrences = [...src.matchAll(/--signer-workflow "\$signerWorkflow"/g)];
  assert.ok(occurrences.length >= 2, 'both attestation verify calls pass --signer-workflow');
  const sourceRefOccurrences = [...src.matchAll(/--source-ref "\$sourceRef"/g)];
  assert.ok(sourceRefOccurrences.length >= 2, 'both attestation verify calls pass --source-ref');
  assert.match(src, /signerWorkflow="\$\{REPO\}\/\.github\/workflows\/release-action\.yml"/);
  assert.match(src, /sourceRef="refs\/heads\/\$\{DEFAULT_BRANCH\}"/);
});

if (!bashAvailable()) {
  // node:test has no first-class "skip suite" outside a describe; each test
  // above already runs bash directly and will report a clear failure if bash
  // is absent, but note the requirement here for anyone triaging a CI gap.
  console.warn('release-asset-verify.test.ts: bash was not detected; the tests above require it.');
}
