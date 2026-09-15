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
// A mismatch is a claim about the SERVICE, so mismatch-producing evaluation is
// restricted to EXPLICITLY CLASSIFIED source-protocol assertions. The contract
// test directory also holds repository-only assertions — the packaged task
// manifest, the signing pipeline, the release rulesets, the C# extraction
// machinery — whose failure is a repository regression and no evidence at all
// that the protocol moved. Those run under `repository-suite`, which can never
// publish contract evidence, and an unclassified test file fails `classify`
// rather than being assumed to be one or quietly dropped from both.
//
// Usage:
//   node scripts/lib/contract-drift.mjs classify          # the test classification is complete
//   node scripts/lib/contract-drift.mjs provenance        # re-derive the manifest, diff it
//   node scripts/lib/contract-drift.mjs contract-suite    # re-run the SOURCE-PROTOCOL assertions
//   node scripts/lib/contract-drift.mjs repository-suite  # re-run the repository-policy assertions
//   node scripts/lib/contract-drift.mjs api-version       # assert the pinned api-version
//
// Environment (test seams; the workflow sets none of them):
//   CONTRACT_DRIFT_ROOT            operate on this tree instead of the repository root
//   CONTRACT_DRIFT_CONTRACT_DIR    the contract test directory, relative to that root
//   CONTRACT_DRIFT_PROTOCOL_TESTS  comma-separated source-protocol test files
//   CONTRACT_DRIFT_POLICY_TESTS    comma-separated repository-policy test files
import { spawnSync } from 'node:child_process';
import { appendFileSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const ROOT = resolve(process.env.CONTRACT_DRIFT_ROOT || REPO_ROOT);

// D5/FR15: the `api-version` is a PINNED CONSTANT, never a customer input. It is
// restated here deliberately — the check is worthless if it reads its expectation
// from the same file it is auditing — and it moves only by a reviewed code change
// plus a fresh RV1-RV3 pass.
const PINNED_API_VERSION = '2026-05-01-preview';

const PROVENANCE_GENERATOR = 'packages/core/fixtures/scripts/generate-provenance.mjs';
const FIXTURES_DIR = 'packages/core/fixtures';
const CONTRACT_DIR = process.env.CONTRACT_DRIFT_CONTRACT_DIR || 'packages/core/test/contract';

/** `a.test.ts, b.test.ts` → `['a.test.ts','b.test.ts']`; `''` → `[]`. */
const splitList = (value) =>
  value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');

// A CONTRACT MISMATCH is a claim about the SERVICE, so only assertions that can
// actually observe the service protocol may produce one. These files compare the
// shipped fixtures and constants against the reviewed GW/BE source extracts.
const SOURCE_PROTOCOL_TESTS =
  process.env.CONTRACT_DRIFT_PROTOCOL_TESTS === undefined
    ? [
        'contract.test.ts',
        'validate.test.ts',
        'run.test.ts',
        'cancel.test.ts',
        'operations.test.ts',
        'provenance.test.ts',
      ]
    : splitList(process.env.CONTRACT_DRIFT_PROTOCOL_TESTS);

// These live in the same directory but assert THIS REPOSITORY: the packaged task
// manifest (e.g. `minimumAgentVersion`), the signing pipeline, the release tag
// rulesets and workflow permissions, and the C# extraction machinery. A failure
// here is a repository regression — real, and still reported — but it is no
// evidence whatsoever that the service protocol moved, so it is evaluated
// separately and can never publish contract evidence.
const REPOSITORY_POLICY_TESTS =
  process.env.CONTRACT_DRIFT_POLICY_TESTS === undefined
    ? [
        'manifest.test.ts',
        'ado-pipeline.test.ts',
        'release-fnmatch.test.ts',
        'tagRulesetEval.test.ts',
        'workflowPermsAudit.test.ts',
        'source-extracts.test.ts',
      ]
    : splitList(process.env.CONTRACT_DRIFT_POLICY_TESTS);

// Classification is per FILE, but two source-protocol files also carry assertions
// that observe THIS REPOSITORY rather than the service: client-side naming and
// enum conventions, and the fixture-validator's own negative self-tests. A
// failure in one of those is a repository regression, so an ERR_ASSERTION whose
// test name is listed here does NOT on its own produce a mismatch. Entries are
// exact test names, or a `prefix:` rule; `classify` fails when an entry matches
// nothing in the file, so the list cannot rot into a silent blanket exemption.
const REPOSITORY_ONLY_ASSERTIONS =
  process.env.CONTRACT_DRIFT_REPO_ONLY_ASSERTIONS === undefined
    ? {
        'contract.test.ts': [
          // Client-side conventions (D1/NFR5/D11) and the client's normalized
          // error taxonomy: none of them is a statement about the wire protocol.
          'mode enum is closed with the documented default (D1)',
          'canonical input names are kebab-case and cover every Inputs field (NFR5)',
          'canonical outputs are exactly the eight scalars (D11)',
          'error categories are the normalized set',
        ],
        'provenance.test.ts': [
          // The fixture/extract VALIDATOR's own self-tests: each feeds the
          // validator a deliberately broken input and asserts it is rejected.
          // They exercise repository machinery, not the service contract.
          'prefix:negative: ',
          'the commit-permalink check rejects tampered URLs (host, port, path, commit, userinfo, fragment, extra query)',
          'assertTerminalGatedGet rejects an inverted/unrelated guard and a wrong returned value (pass 41 finding #7)',
          'assertTerminalGatedGet rejects a guard nested/unreachable and an unbound fetch (pass 43 finding #8)',
          'assertTerminalGatedGet rejects TWO producers and a nested/dead producer (pass 45 finding #4)',
        ],
      }
    : JSON.parse(process.env.CONTRACT_DRIFT_REPO_ONLY_ASSERTIONS);

/** Does `name` match one of a file's repository-only assertion rules? */
export function isRepositoryOnlyAssertion(rules, name) {
  return (rules ?? []).some((rule) =>
    rule.startsWith('prefix:') ? name.startsWith(rule.slice('prefix:'.length)) : rule === name,
  );
}

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
// classify — every contract test is explicitly protocol OR repository.
// ---------------------------------------------------------------------------

/** Every `*.test.ts` under `CONTRACT_DIR`, relative to it, sorted. */
export function discoverContractTests(dir) {
  const found = [];
  const walk = (relative) => {
    const absolute = relative === '' ? dir : join(dir, relative);
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      const child = relative === '' ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) walk(child);
      else if (entry.name.endsWith('.test.ts')) found.push(child);
    }
  };
  walk('');
  return found.sort();
}

/** Every top-level `test('name', ...)` name declared in a test file's source. */
export function testNamesIn(source) {
  const names = [];
  for (const found of source.matchAll(/(?:^|\n)\s*test\(\s*(['"])((?:\\.|(?!\1).)*)\1/g)) {
    names.push(found[2].replace(/\\(['"\\])/g, '$1'));
  }
  return names;
}

/**
 * Bind every discovered contract test to exactly one bucket.
 *
 * An UNCLASSIFIED file (someone added a test and did not say what it observes)
 * and a STALE entry (a classified file that no longer exists) both make the
 * classification untrustworthy. Neither may be resolved by guessing: an
 * unclassified file must not be assumed to be protocol evidence, and must not be
 * silently dropped from the checks either. Both are execution errors.
 */
export function classifyContractTests(discovered, protocol, policy) {
  const known = new Set(discovered);
  const classified = new Set([...protocol, ...policy]);
  const unclassified = discovered.filter((file) => !classified.has(file));
  const stale = [...classified].filter((file) => !known.has(file)).sort();
  const both = protocol.filter((file) => policy.includes(file));
  const problems = [];
  if (unclassified.length > 0) {
    problems.push(
      `unclassified source-contract test files (classify them in scripts/lib/contract-drift.mjs):`,
      ...unclassified.map((file) => `  - ${CONTRACT_DIR}/${file}`),
    );
  }
  if (stale.length > 0) {
    problems.push(
      'classified source-contract test files that no longer exist:',
      ...stale.map((file) => `  - ${CONTRACT_DIR}/${file}`),
    );
  }
  if (both.length > 0) {
    problems.push(
      'source-contract test files classified as BOTH protocol and repository:',
      ...both.map((file) => `  - ${CONTRACT_DIR}/${file}`),
    );
  }
  return { unclassified, stale, both, problems };
}

/**
 * Audit the per-assertion exemptions inside the source-protocol files.
 *
 * `namesByFile` maps each protocol file to the test names it declares. A rule
 * that matches NOTHING in its own file has rotted (the test was renamed or
 * removed) and would silently widen over time; a rule that ALSO matches a test
 * in a DIFFERENT protocol file is ambiguous, because the test runner reports
 * failures by name alone — it would exempt a genuine protocol assertion. Both
 * are execution errors.
 */
export function auditRepositoryOnlyAssertions(exemptions, namesByFile) {
  const problems = [];
  for (const [file, rules] of Object.entries(exemptions)) {
    const own = namesByFile[file];
    if (own === undefined) {
      problems.push(
        `  - ${CONTRACT_DIR}/${file}: has per-assertion exemptions but is not a source-protocol test file`,
      );
      continue;
    }
    for (const rule of rules) {
      if (!own.some((name) => isRepositoryOnlyAssertion([rule], name))) {
        problems.push(`  - ${CONTRACT_DIR}/${file}: exemption '${rule}' matches no test in that file`);
      }
      for (const [other, names] of Object.entries(namesByFile)) {
        if (other === file) continue;
        const collision = names.find((name) => isRepositoryOnlyAssertion([rule], name));
        if (collision !== undefined) {
          problems.push(
            `  - ${CONTRACT_DIR}/${file}: exemption '${rule}' also matches '${collision}' in ${other}`,
          );
        }
      }
    }
  }
  return problems;
}

/** The classification, or an `error` verdict when it cannot be trusted. */
function classification() {
  let discovered;
  try {
    discovered = discoverContractTests(join(ROOT, CONTRACT_DIR));
  } catch (e) {
    return {
      verdict: error(
        `the source-contract test directory '${CONTRACT_DIR}' could not be read (${String(e && e.message)}).`,
      ),
    };
  }
  const result = classifyContractTests(discovered, SOURCE_PROTOCOL_TESTS, REPOSITORY_POLICY_TESTS);
  const problems = [...result.problems];

  // The per-assertion exemptions are only auditable when their files exist.
  const namesByFile = {};
  for (const file of SOURCE_PROTOCOL_TESTS) {
    if (!discovered.includes(file)) continue;
    try {
      namesByFile[file] = testNamesIn(readFileSync(join(ROOT, CONTRACT_DIR, file), 'utf8'));
    } catch (e) {
      problems.push(`  - ${CONTRACT_DIR}/${file}: could not be read (${String(e && e.message)})`);
    }
  }
  const exemptionProblems = auditRepositoryOnlyAssertions(REPOSITORY_ONLY_ASSERTIONS, namesByFile);
  if (exemptionProblems.length > 0) {
    problems.push('repository-only assertion exemptions that cannot be trusted:', ...exemptionProblems);
  }

  if (problems.length > 0) {
    return {
      verdict: error(
        'the source-contract test classification is incomplete; no contract verdict can be trusted until it is fixed.',
        problems,
      ),
    };
  }
  return { discovered };
}

function checkClassify() {
  const classified = classification();
  if (classified.verdict) return classified.verdict;
  return match(
    `every source-contract test is classified (${SOURCE_PROTOCOL_TESTS.length} source-protocol, ${REPOSITORY_POLICY_TESTS.length} repository-policy).`,
  );
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
export function classifyContractSuiteRun(result, exemptions = REPOSITORY_ONLY_ASSERTIONS) {
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
      `no source-protocol contract tests ran in '${CONTRACT_DIR}'; the contract was not checked.`,
    );
  }

  const failures = parseTapFailures(tap);
  const assertionFailures = failures.filter((failure) => failure.code === 'ERR_ASSERTION');
  // Classification is per FILE, but a source-protocol file can still carry
  // assertions that observe THIS REPOSITORY (client naming/enum conventions, the
  // fixture validator's own negative self-tests). They are attributed by test
  // name and, on their own, are a repository regression rather than evidence
  // that the service moved. `classify` keeps the exemption list honest.
  const rules = Object.values(exemptions).flat();
  const exempt = (failure) => isRepositoryOnlyAssertion(rules, failure.name);
  const protocolFailures = assertionFailures.filter((failure) => !exempt(failure));
  const repositoryOnly = assertionFailures.filter(exempt);
  if (protocolFailures.length > 0) {
    return mismatch(
      'the source-contract suite reported failing SOURCE-PROTOCOL assertions; the shipped fixtures no longer agree with the reviewed source extracts.',
      protocolFailures.map((failure) => `  - ${failure.name}`),
    );
  }
  if (repositoryOnly.length > 0) {
    return error(
      'the source-contract suite failed ONLY on repository-only assertions (client conventions, or the fixture validator\'s own self-tests); that is a repository regression, not a source-contract mismatch.',
      repositoryOnly.map((failure) => `  - ${failure.name}`),
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

/**
 * Classify a REPOSITORY-POLICY suite run.
 *
 * This suite observes the packaged manifests, the signing pipeline, the release
 * rulesets and the extraction machinery. A failing assertion here is a genuine
 * repository regression and is reported as such — but it is NOT evidence that
 * the service protocol moved, so it can only ever yield `match` or `error`.
 */
export function classifyRepositorySuiteRun(result) {
  if (result.error) {
    return error(`the repository-policy suite could not be started (${describeExit(result)}).`);
  }
  if (result.signal) return error(`the repository-policy suite was killed by signal ${result.signal}.`);

  const tap = `${result.stdout ?? ''}`;
  const counts = parseTapCounts(tap);
  if (counts === null) {
    return error('the repository-policy suite produced no TAP summary; it did not run to completion.', [
      result.stderr || tap,
    ]);
  }
  if (result.status !== 0 || counts.fail > 0) {
    return error(
      `the repository-policy suite failed (${describeExit(result)}); this is a REPOSITORY regression, not a source-contract mismatch.`,
      parseTapFailures(tap).map((failure) => `  - ${failure.name}`),
    );
  }
  return match(`the repository-policy suite is green (${counts.pass} passing tests).`);
}

/** Run `node --test` over an explicit, classified file list. */
function runSuite(files) {
  // The suite must run in a CLEAN test-runner context. `node:test` refuses to
  // run files when it detects it was launched from inside another test run
  // (`NODE_TEST_CONTEXT`), which would silently produce an empty report.
  const env = { ...process.env };
  delete env['NODE_TEST_CONTEXT'];
  return spawnSync(
    process.execPath,
    ['--test', '--test-reporter=tap', ...files.map((file) => join(CONTRACT_DIR, file))],
    { cwd: ROOT, encoding: 'utf8', env },
  );
}

function checkContractSuite() {
  // Deliberately independent of `classify`: an unclassified NEW file must not
  // suppress the verdict the DECLARED source-protocol assertions would publish.
  // `classify` fails the job separately, so the gap is still reported.
  if (SOURCE_PROTOCOL_TESTS.length === 0) {
    return error(
      `no source-protocol contract tests are declared for '${CONTRACT_DIR}'; the contract was not checked.`,
    );
  }
  const result = runSuite(SOURCE_PROTOCOL_TESTS);
  const verdict = classifyContractSuiteRun(result);
  // Keep the raw report in the log whatever the verdict: the triage runbook
  // needs it for both a confirmed mismatch and a broken runner.
  if (verdict.verdict !== 'match') process.stdout.write(result.stdout ?? '');
  return verdict;
}

function checkRepositorySuite() {
  if (REPOSITORY_POLICY_TESTS.length === 0) {
    return match('no repository-policy assertions are declared.');
  }
  const result = runSuite(REPOSITORY_POLICY_TESTS);
  const verdict = classifyRepositorySuiteRun(result);
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

async function checkApiVersion() {
  // The pin is compared against the constant's ACTUAL EXPORTED VALUE. Matching a
  // slice of SOURCE TEXT would be wrong in both directions: an equivalent
  // declaration (double quotes, a type annotation, a re-export) would be called
  // drift, and the expected text sitting in a COMMENT would satisfy the check
  // while the real declaration had moved.
  const constantsPath = join(ROOT, CONTRACT_CONSTANTS_FILE);
  let constants;
  try {
    // Cache-busted so repeated in-process checks observe the file as it is now.
    constants = await import(`${pathToFileURL(constantsPath).href}?contract-drift=${Date.now()}`);
  } catch (e) {
    return error(
      `${CONTRACT_CONSTANTS_FILE} could not be loaded (${String(e && e.message)}); the api-version was not checked.`,
    );
  }
  const declared = constants.API_VERSION;
  if (typeof declared !== 'string' || declared === '') {
    // The client is broken, not the service: this is never a service defect.
    return error(
      `${CONTRACT_CONSTANTS_FILE} does not export a non-empty string API_VERSION (got ${typeof declared}); the api-version was not checked.`,
    );
  }
  if (declared !== PINNED_API_VERSION) {
    return mismatch(
      `${CONTRACT_CONSTANTS_FILE} exports API_VERSION='${declared}', not the pinned '${PINNED_API_VERSION}'. An api-version bump requires a fresh RV1-RV3 pass.`,
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
  classify: checkClassify,
  provenance: checkProvenance,
  'contract-suite': checkContractSuite,
  'repository-suite': checkRepositorySuite,
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

process.exit(report(check, await CHECKS[check]()));
