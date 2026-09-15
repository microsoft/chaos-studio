#!/usr/bin/env node
// contract-drift.mjs — the source-contract drift checks (E6-T3).
//
// The scheduled `contract-drift` workflow escalates a protocol mismatch to the
// Chaos Studio service team as a SERVICE DEFECT; it never silently accommodates
// a contract change in the client (docs/runbooks/contract-drift.md). That claim
// is only honest if a MISMATCH can be told apart from an EXECUTION ERROR.
//
// A shell wrapper cannot make that distinction: `git diff --exit-code` exits 1
// for "there are differences" and 128 for "git could not run"; `grep` exits 1
// for "no match" and 2 for "could not read the file"; and `node --test` exits
// nonzero for a failed assertion, a syntax error, an unresolvable import, a
// test that dies during setup, and a glob that matched nothing alike. Treating
// every nonzero status as drift would file a service defect on no evidence.
//
// So each check is evaluated here and reports ONE of three verdicts:
//
//   exit 0  MATCH — the check ran and the contract agrees. Nothing is recorded.
//   exit 1  MISMATCH — the check ran and IDENTIFIED a disagreement. `contract=mismatch`
//           is written to `GITHUB_OUTPUT`; only this may become a service defect.
//   exit 2  ERROR — the check could not be evaluated. NOTHING is written, so the
//           workflow reports a drift-check failure instead of a service defect.
//
// Usage:
//   node scripts/lib/contract-drift.mjs provenance      # re-derive the manifest, diff it
//   node scripts/lib/contract-drift.mjs contract-suite  # re-run the source-contract suite
//   node scripts/lib/contract-drift.mjs api-version     # assert the pinned api-version
//
// Environment (test seams; the workflow sets none of them):
//   CONTRACT_DRIFT_ROOT        operate on this tree instead of the repository root
//   CONTRACT_DRIFT_SUITE_GLOB  the contract-suite glob, relative to that root
import { spawnSync } from 'node:child_process';
import { appendFileSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const ROOT = resolve(process.env.CONTRACT_DRIFT_ROOT || REPO_ROOT);

// D5/FR15: the `api-version` is a PINNED CONSTANT, never a customer input. It is
// restated here deliberately — the check is worthless if it reads its expectation
// from the same file it is auditing — and it moves only by a reviewed code change
// plus a fresh RV1-RV3 pass.
const PINNED_API_VERSION = '2026-05-01-preview';

const PROVENANCE_GENERATOR = 'packages/core/fixtures/scripts/generate-provenance.mjs';
const FIXTURES_DIR = 'packages/core/fixtures';
const CONTRACT_SUITE_GLOB =
  process.env.CONTRACT_DRIFT_SUITE_GLOB || 'packages/core/test/contract/**/*.test.ts';
const CONTRACT_CONSTANTS_FILE = 'packages/core/src/contract.ts';
// The shipped surface that may legitimately contain an `api-version` literal.
const API_VERSION_SCAN_ROOTS = [
  'packages/core/src',
  'packages/core/fixtures',
  'action.yml',
  'azure-pipelines-extension',
];
const API_VERSION_LITERAL = /api-version=(\d{4}-\d{2}-\d{2}(?:-preview)?)/g;

/** The three verdicts. `details` are printed verbatim beneath the summary. */
const match = (summary) => ({ verdict: 'match', summary, details: [] });
const mismatch = (summary, details = []) => ({ verdict: 'mismatch', summary, details });
const error = (summary, details = []) => ({ verdict: 'error', summary, details });

const describeExit = (result) => {
  if (result.error) return String(result.error.message);
  if (result.signal) return `killed by signal ${result.signal}`;
  return `exit status ${result.status}`;
};

// ---------------------------------------------------------------------------
// provenance — re-derive the manifest and diff it.
// ---------------------------------------------------------------------------

function checkProvenance() {
  // The generator is deterministic: a clean tree means nothing moved; a diff
  // means a fixture, a source extract, or a recorded hash no longer agrees with
  // the rest (including an edit that bypassed the generator).
  const generated = spawnSync(process.execPath, [PROVENANCE_GENERATOR], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  if (generated.error || generated.status !== 0) {
    return error(`the provenance generator could not be run (${describeExit(generated)}).`, [
      generated.stderr || generated.stdout || '',
    ]);
  }

  const diff = spawnSync('git', ['diff', '--exit-code', '--', FIXTURES_DIR], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  if (diff.error) return error(`\`git diff\` could not be run (${describeExit(diff)}).`);
  if (diff.signal !== null && diff.signal !== undefined) {
    return error(`\`git diff\` was killed by signal ${diff.signal}.`);
  }
  // `git diff --exit-code` uses exit 1 for "there are differences"; ANY other
  // nonzero status (128 for a broken repository, 129 for bad usage) is git
  // failing to answer the question, which is not evidence of drift.
  if (diff.status === 1) {
    return mismatch(
      'the source-contract provenance manifest is not reproducible from the committed fixtures/extracts.',
      [diff.stdout || ''],
    );
  }
  if (diff.status !== 0) {
    return error(`\`git diff\` failed (${describeExit(diff)}); the fixtures were not compared.`, [
      diff.stderr || '',
    ]);
  }
  return match('the provenance manifest re-derives byte-identically.');
}

// ---------------------------------------------------------------------------
// contract-suite — a mismatch verdict comes from an IDENTIFIED assertion.
// ---------------------------------------------------------------------------

/**
 * Pull the failing subtests out of a TAP report together with the parsed `code`
 * from their YAML diagnostic block, at any nesting depth.
 *
 * The `code` is read as a KEY of the diagnostic mapping (at the block's own key
 * indentation), never by searching the block text: an operational failure whose
 * message, stack frame, or nested value happens to contain the string
 * `ERR_ASSERTION` must not be mistaken for an assertion that ran.
 */
export function parseTapFailures(tap) {
  const lines = tap.split('\n');
  const failures = [];
  for (let i = 0; i < lines.length; i++) {
    const header = /^(\s*)not ok \d+ - (.*)$/.exec(lines[i]);
    if (!header) continue;
    const [, indent, name] = header;
    // Diagnostic keys sit two columns in from the `not ok` line.
    const keyIndent = `${indent}  `;
    let code = null;
    let j = i + 1;
    if (lines[j] !== undefined && lines[j].trimEnd() === `${keyIndent}---`) {
      for (j += 1; j < lines.length && lines[j].trimEnd() !== `${keyIndent}...`; j++) {
        const key = new RegExp(`^${keyIndent}code: '([^']*)'\\s*$`).exec(lines[j]);
        if (key && code === null) code = key[1];
      }
    }
    failures.push({ name: name.trim(), code });
  }
  return failures;
}

/** The TAP trailer counts, or `null` when the run never produced a summary. */
export function parseTapCounts(tap) {
  const read = (key) => {
    const found = new RegExp(`^# ${key} (\\d+)$`, 'm').exec(tap);
    return found ? Number(found[1]) : null;
  };
  const tests = read('tests');
  if (tests === null) return null;
  return { tests, pass: read('pass') ?? 0, fail: read('fail') ?? 0, cancelled: read('cancelled') ?? 0 };
}

/**
 * Classify a source-contract suite run.
 *
 * A failing `node:assert` assertion reports `code: 'ERR_ASSERTION'` in its own
 * TAP diagnostic: that is an assertion that RAN and observed the shipped
 * fixtures disagreeing with the reviewed source extracts, and it is the only
 * thing allowed to yield a mismatch. A syntax error, an unresolvable import, a
 * suite that discovers nothing, or a test that throws while setting up all fail
 * BEFORE any contract assertion is evaluated, so they are execution errors.
 */
export function classifyContractSuiteRun(result) {
  if (result.error) return error(`the contract suite could not be started (${describeExit(result)}).`);
  if (result.signal) return error(`the contract suite was killed by signal ${result.signal}.`);

  const tap = `${result.stdout ?? ''}`;
  const counts = parseTapCounts(tap);
  if (counts === null) {
    return error('the contract suite produced no TAP summary; it did not run to completion.', [
      result.stderr || tap,
    ]);
  }
  if (counts.tests === 0) {
    return error(
      `no contract tests were discovered by \`${CONTRACT_SUITE_GLOB}\`; the contract was not checked.`,
    );
  }

  const failures = parseTapFailures(tap);
  const assertionFailures = failures.filter((failure) => failure.code === 'ERR_ASSERTION');
  if (assertionFailures.length > 0) {
    return mismatch(
      'the source-contract suite reported failing contract assertions; the shipped fixtures no longer agree with the reviewed source extracts.',
      assertionFailures.map((failure) => `  - ${failure.name}`),
    );
  }
  if (result.status !== 0 || counts.fail > 0) {
    return error(
      `the contract suite failed (${describeExit(result)}) WITHOUT any contract assertion reporting a disagreement; it could not be evaluated.`,
      failures.map((failure) => `  - ${failure.name}`),
    );
  }
  return match(`the source-contract suite is green (${counts.pass} passing tests).`);
}

function checkContractSuite() {
  // The suite must run in a CLEAN test-runner context. `node:test` refuses to
  // run files when it detects it was launched from inside another test run
  // (`NODE_TEST_CONTEXT`), which would silently produce an empty report.
  const env = { ...process.env };
  delete env['NODE_TEST_CONTEXT'];
  const result = spawnSync(
    process.execPath,
    ['--test', '--test-reporter=tap', CONTRACT_SUITE_GLOB],
    { cwd: ROOT, encoding: 'utf8', env },
  );
  const verdict = classifyContractSuiteRun(result);
  // Keep the raw report in the log whatever the verdict: the triage runbook
  // needs it for both a confirmed mismatch and a broken runner.
  if (verdict.verdict !== 'match') process.stdout.write(result.stdout ?? '');
  return verdict;
}

// ---------------------------------------------------------------------------
// api-version — the pinned constant, and every literal that must agree with it.
// ---------------------------------------------------------------------------

/** Every readable text file under `relative`, which MUST exist. */
function collectTextFiles(relative, into) {
  const absolute = join(ROOT, relative);
  const stats = statSync(absolute);
  if (!stats.isDirectory()) {
    into.push({ relative, absolute });
    return;
  }
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    collectTextFiles(`${relative}/${entry.name}`, into);
  }
}

function checkApiVersion() {
  let constants;
  try {
    constants = readFileSync(join(ROOT, CONTRACT_CONSTANTS_FILE), 'utf8');
  } catch (e) {
    return error(`${CONTRACT_CONSTANTS_FILE} could not be read (${String(e && e.message)}).`);
  }
  if (!constants.includes(`export const API_VERSION = '${PINNED_API_VERSION}'`)) {
    return mismatch(
      `${CONTRACT_CONSTANTS_FILE} no longer pins API_VERSION='${PINNED_API_VERSION}'. An api-version bump requires a fresh RV1-RV3 pass.`,
    );
  }

  const files = [];
  for (const relative of API_VERSION_SCAN_ROOTS) {
    try {
      collectTextFiles(relative, files);
    } catch (e) {
      return error(
        `the shipped surface '${relative}' could not be scanned (${String(e && e.message)}); the api-version was not checked.`,
      );
    }
  }

  const disagreeing = [];
  for (const file of files) {
    let contents;
    try {
      contents = readFileSync(file.absolute, 'utf8');
    } catch (e) {
      return error(
        `'${file.relative}' could not be read (${String(e && e.message)}); the api-version was not checked.`,
      );
    }
    // Binary blobs carry no reviewable literal; `grep -I` skipped them too.
    if (contents.includes('\u0000')) continue;
    for (const found of contents.matchAll(API_VERSION_LITERAL)) {
      if (found[1] !== PINNED_API_VERSION) {
        disagreeing.push(`  - ${file.relative}: api-version=${found[1]}`);
      }
    }
  }
  if (disagreeing.length > 0) {
    return mismatch(
      `found api-version literals that disagree with the pinned ${PINNED_API_VERSION}:`,
      disagreeing,
    );
  }
  return match(`the pinned api-version ${PINNED_API_VERSION} is consistent across the shipped surface.`);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const CHECKS = {
  provenance: checkProvenance,
  'contract-suite': checkContractSuite,
  'api-version': checkApiVersion,
};

function report(check, result) {
  const runbook = 'docs/runbooks/contract-drift.md';
  if (result.verdict === 'match') {
    console.log(`contract-drift(${check}): ${result.summary}`);
    return 0;
  }
  const label = result.verdict === 'mismatch' ? 'CONTRACT MISMATCH' : 'CHECK FAILED';
  console.error(`::error::contract-drift(${check}) ${label}: ${result.summary} (${runbook})`);
  for (const detail of result.details) {
    if (detail) console.error(detail);
  }
  if (result.verdict === 'error') {
    console.error(
      `::error::contract-drift(${check}): this is a drift-check failure, NOT evidence of a source-contract mismatch; do not file a service defect on it.`,
    );
    return 2;
  }
  // The ONLY path that records contract evidence for the reporting job.
  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) appendFileSync(outputFile, 'contract=mismatch\n');
  return 1;
}

const check = process.argv[2];
if (!check || !Object.hasOwn(CHECKS, check)) {
  console.error(`::error::contract-drift: unknown check '${check ?? ''}'.`);
  console.error(
    `::error::contract-drift: usage: contract-drift.mjs <${Object.keys(CHECKS).join('|')}>`,
  );
  // A usage error is an execution error: it records no contract verdict.
  process.exit(2);
}

process.exit(report(check, CHECKS[check]()));
