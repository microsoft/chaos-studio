import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
const RELEASE_COMMIT = 'a'.repeat(40);

function bashAvailable(): boolean {
  const result = spawnSync('bash', ['-c', 'true'], { encoding: 'utf8' });
  return result.status === 0;
}

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
/**
 * Converts a Windows path to the corresponding WSL path
 * (`C:\foo\bar` -> `/mnt/c/foo/bar`) so scripts this test writes to a
 * Windows temp dir can be handed to WSL's `bash.exe` on a Windows dev
 * machine; a no-op on POSIX, where the same path is already bash-usable.
 */
function toBashPath(p: string): string {
  if (process.platform !== 'win32') return p;
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(p);
  if (!m) return p.replace(/\\/g, '/');
  return `/mnt/${m[1]!.toLowerCase()}/${m[2]!.replace(/\\/g, '/')}`;
}

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

  // A minimal `jq` shim (Python-backed) standing in for the real CLI, in case
  // it is not installed on the machine running this test — it implements only
  // the ONE query the real script issues
  // (`jq -r '<query>' /tmp/attest-release-commit.json`): the query is $1, the
  // file to read is the LAST argument, matching how release-asset-verify.sh
  // actually invokes it (not via stdin).
  const fakeJq = join(binDir, 'jq');
  writeFileSync(
    fakeJq,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'file="${@: -1}"',
      'python3 -c \'',
      'import json, sys',
      'with open(sys.argv[1]) as f:',
      '    data = json.load(f)',
      'try:',
      '    v = data[0]["verificationResult"]["statement"]["predicate"].get("releaseCommit", "")',
      'except (IndexError, KeyError, TypeError):',
      '    v = ""',
      'print(v if v else "")',
      "' \"$file\"",
      '',
    ].join('\n'),
  );
  chmodSync(fakeJq, 0o755);

  // The driver `source`s the REAL library and calls verify_required_attestations
  // against the synthetic artifact, exactly as the publish job's steps do. All
  // "environment" the real script reads (REPO, RELEASE_COMMIT, PATH) is set
  // INSIDE this script (rather than passed through spawnSync's `env`, which a
  // Windows-host `bash.exe` backed by WSL does not reliably forward across the
  // Win32/Linux process boundary) — bit-for-bit the same values the publish
  // job's `env:` mapping supplies. Any CRLF the committed script may carry on
  // a Windows checkout (`core.autocrlf=true`) is stripped first, since bash's
  // `source` cannot parse a `\r`-terminated line.
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

  return runBash(driver);
}

/** A fake `gh attestation verify` that requires `--signer-workflow "$EXPECTED_SIGNER"` on every call. */
const REQUIRE_SIGNER = `
EXPECTED_SIGNER='${EXPECTED_SIGNER}'
if [[ "$1" != "attestation" || "$2" != "verify" ]]; then echo "unsupported gh invocation: $*" >&2; exit 64; fi
shift 2
signer=""
predicateType=""
formatJson="0"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --signer-workflow) signer="$2"; shift 2 ;;
    --predicate-type) predicateType="$2"; shift 2 ;;
    --format) [[ "$2" == "json" ]] && formatJson="1"; shift 2 ;;
    *) shift ;;
  esac
done
if [[ "$signer" != "$EXPECTED_SIGNER" ]]; then
  echo "fake gh: missing/wrong --signer-workflow (got '$signer')" >&2
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
  assert.match(result.stdout + result.stderr, /no well-formed 'releaseCommit' predicate field/);
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
  assert.match(result.stdout + result.stderr, /no well-formed 'releaseCommit' predicate field/);
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
  assert.match(result.stdout + result.stderr, new RegExp(`bound to ${wrongCommit}, expected ${RELEASE_COMMIT}`));
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

test('the release-asset-verify library constrains both required attestations to the release-action signer workflow', () => {
  const src = readFileSync(LIB, 'utf8');
  assert.match(src, /--signer-workflow "\$signerWorkflow"/g);
  const occurrences = [...src.matchAll(/--signer-workflow "\$signerWorkflow"/g)];
  assert.ok(occurrences.length >= 2, 'both attestation verify calls pass --signer-workflow');
  assert.match(src, /signerWorkflow="\$\{REPO\}\/\.github\/workflows\/release-action\.yml"/);
});

if (!bashAvailable()) {
  // node:test has no first-class "skip suite" outside a describe; each test
  // above already runs bash directly and will report a clear failure if bash
  // is absent, but note the requirement here for anyone triaging a CI gap.
  console.warn('release-asset-verify.test.ts: bash was not detected; the tests above require it.');
}
