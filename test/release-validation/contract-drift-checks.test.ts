import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { API_VERSION } from '../../packages/core/src/contract.ts';

/**
 * E6-T3 — BEHAVIOURAL coverage for the source-contract drift checks.
 *
 * The scheduled workflow escalates a contract mismatch to the service team as a
 * SERVICE DEFECT. That claim is only honest if a mismatch can be told apart from
 * an execution error: a failed generator, a broken `git` invocation, a test file
 * that will not parse or import, a suite that discovers nothing, or a test that
 * dies before any contract assertion runs are all "the check could not be
 * evaluated" — NOT evidence that the service moved.
 *
 * So the checks live in `scripts/lib/contract-drift.mjs` with a three-way exit
 * contract, and this suite drives that CLI against purpose-built trees:
 *
 *   exit 0 — checked, contract matches. Nothing written to `GITHUB_OUTPUT`.
 *   exit 1 — CHECKED, contract MISMATCHES. `contract=mismatch` is recorded, and
 *            only then may the workflow file a service defect.
 *   exit 2 — the check could NOT be evaluated. Nothing is written, so the
 *            workflow reports a drift-check failure instead of a defect.
 *
 * These are executions, not string assertions about the source: each case makes
 * the failure actually happen and then asserts the verdict.
 */

const repoRootUrl = new URL('../../', import.meta.url);
const repoRoot = fileURLToPath(repoRootUrl);
const CLI = join(repoRoot, 'scripts', 'lib', 'contract-drift.mjs');

type CheckResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  /** Everything the check recorded on the step's `GITHUB_OUTPUT` channel. */
  githubOutput: string;
};

/** Run one drift check against `root`, capturing its `GITHUB_OUTPUT` writes. */
function runCheck(
  check: string,
  root?: string,
  extraEnv: Record<string, string> = {},
): CheckResult {
  const outputFile = join(mkdtempSync(join(tmpdir(), 'drift-out-')), 'github-output.txt');
  writeFileSync(outputFile, '');
  const env: Record<string, string | undefined> = {
    ...process.env,
    GITHUB_OUTPUT: outputFile,
    ...extraEnv,
  };
  if (root !== undefined) env['CONTRACT_DRIFT_ROOT'] = root;
  const result = spawnSync(process.execPath, [CLI, check], {
    cwd: repoRoot,
    encoding: 'utf8',
    env,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    githubOutput: readFileSync(outputFile, 'utf8'),
  };
}

function scratch(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `drift-${prefix}-`));
}

function write(root: string, relative: string, contents: string): string {
  const path = join(root, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
  return path;
}

function git(root: string, args: string[]) {
  return spawnSync('git', args, { cwd: root, encoding: 'utf8' });
}

/** A minimal tracked fixture tree, so `git diff` has something to observe. */
function gitRootWithFixtures(prefix: string): string {
  const root = scratch(prefix);
  write(root, 'packages/core/fixtures/manifest.json', '{"stable":true}\n');
  assert.equal(git(root, ['init', '-q']).status, 0, 'the scratch git repository initializes');
  assert.equal(git(root, ['add', '-A']).status, 0, 'the scratch fixtures are tracked');
  return root;
}

/** Assert a verdict WITHOUT relying on a specific message. */
function assertMismatch(result: CheckResult) {
  assert.equal(result.status, 1, `expected a mismatch verdict; stderr: ${result.stderr}`);
  assert.match(result.githubOutput, /^contract=mismatch$/m);
}

function assertExecutionError(result: CheckResult) {
  assert.equal(result.status, 2, `expected an execution-error verdict; stderr: ${result.stderr}`);
  assert.doesNotMatch(
    result.githubOutput,
    /contract=mismatch/,
    'an execution error must NOT be recorded as contract evidence',
  );
}

function assertMatch(result: CheckResult) {
  assert.equal(result.status, 0, `expected a match verdict; stderr: ${result.stderr}`);
  assert.doesNotMatch(result.githubOutput, /contract=mismatch/);
}

// ---------------------------------------------------------------------------
// The contract suite: a mismatch verdict comes from an IDENTIFIED contract
// assertion, never from "the test process exited nonzero".
// ---------------------------------------------------------------------------

/** Lay down a scratch tree whose only contract test has the given body. */
function suiteRoot(prefix: string, body: string): string {
  const root = scratch(prefix);
  // Matches how the shipped packages are resolved: ESM, so type stripping loads
  // the `.ts` test the same way the real contract suite is loaded.
  write(root, 'package.json', '{"type":"module"}\n');
  write(root, 'contract/shape.test.ts', body);
  return root;
}

const SUITE_GLOB = { CONTRACT_DRIFT_SUITE_GLOB: 'contract/**/*.test.ts' };

test('contract-suite: a failing contract ASSERTION is a confirmed mismatch', () => {
  const root = suiteRoot(
    'assert',
    `import { test } from 'node:test';
     import assert from 'node:assert/strict';
     test('the validate envelope keeps its accepted status', () => {
       assert.equal(202, 200);
     });
    `,
  );
  const result = runCheck('contract-suite', root, SUITE_GLOB);
  assertMismatch(result);
  assert.match(
    result.stderr,
    /the validate envelope keeps its accepted status/,
    'the confirmed mismatch names the contract assertion that observed it',
  );
});

test('contract-suite: a syntax error before any assertion is NOT a mismatch', () => {
  const root = suiteRoot('syntax', 'this is not { valid TypeScript(((\n');
  const result = runCheck('contract-suite', root, SUITE_GLOB);
  assertExecutionError(result);
});

test('contract-suite: an unresolvable import is NOT a mismatch', () => {
  const root = suiteRoot(
    'import',
    `import { nothing } from './does-not-exist.ts';
     export { nothing };
    `,
  );
  const result = runCheck('contract-suite', root, SUITE_GLOB);
  assertExecutionError(result);
});

test('contract-suite: a test that dies before its assertion is NOT a mismatch', () => {
  const root = suiteRoot(
    'throw',
    `import { test } from 'node:test';
     test('loads the fixture', () => {
       // Fails while SETTING UP — no contract assertion is ever evaluated.
       throw new TypeError('fixture loader is broken');
     });
    `,
  );
  const result = runCheck('contract-suite', root, SUITE_GLOB);
  assertExecutionError(result);
});

test('contract-suite: an execution error that merely MENTIONS ERR_ASSERTION is NOT a mismatch', () => {
  // The diagnostic text of an operational failure can contain the string
  // `ERR_ASSERTION` — in the message, in a stack frame, even in the test name.
  // Only the diagnostic's own `code` key establishes that an assertion ran.
  const root = suiteRoot(
    'lookalike',
    `import { test } from 'node:test';
     test('ERR_ASSERTION lookalike', () => {
       throw new TypeError("could not load fixture: code: 'ERR_ASSERTION'");
     });
    `,
  );
  const result = runCheck('contract-suite', root, SUITE_GLOB);
  assertExecutionError(result);
});

test('contract-suite: discovering no contract tests is NOT a mismatch', () => {
  const root = scratch('empty');
  mkdirSync(join(root, 'contract'), { recursive: true });
  const result = runCheck('contract-suite', root, SUITE_GLOB);
  assertExecutionError(result);
  assert.match(result.stderr, /no contract tests/i, 'the empty suite is reported for what it is');
});

test('contract-suite: a green suite records no contract verdict at all', () => {
  const root = suiteRoot(
    'green',
    `import { test } from 'node:test';
     import assert from 'node:assert/strict';
     test('the validate envelope keeps its accepted status', () => {
       assert.equal(202, 202);
     });
    `,
  );
  assertMatch(runCheck('contract-suite', root, SUITE_GLOB));
});

// ---------------------------------------------------------------------------
// Provenance: a `git diff` that reports differences is drift; a `git` that
// cannot run at all is not.
// ---------------------------------------------------------------------------

const GENERATOR = 'packages/core/fixtures/scripts/generate-provenance.mjs';

test('provenance: a re-derived manifest that differs is a confirmed mismatch', () => {
  const root = gitRootWithFixtures('prov-diff');
  write(
    root,
    GENERATOR,
    `import { writeFileSync } from 'node:fs';
     writeFileSync(new URL('../manifest.json', import.meta.url), '{"stable":false}\\n');
    `,
  );
  assertMismatch(runCheck('provenance', root));
});

test('provenance: a byte-identical re-derivation is a match', () => {
  const root = gitRootWithFixtures('prov-clean');
  write(
    root,
    GENERATOR,
    `import { writeFileSync } from 'node:fs';
     writeFileSync(new URL('../manifest.json', import.meta.url), '{"stable":true}\\n');
    `,
  );
  assertMatch(runCheck('provenance', root));
});

test('provenance: a generator that crashes is NOT a mismatch', () => {
  const root = gitRootWithFixtures('prov-crash');
  write(root, GENERATOR, "throw new Error('the generator is broken');\n");
  assertExecutionError(runCheck('provenance', root));
});

test('provenance: a git invocation that ERRORS is NOT a mismatch', () => {
  // No `git init`: `git diff` exits 128 (a command error), which must never be
  // confused with exit 1 (differences found).
  const root = scratch('prov-nogit');
  write(root, 'packages/core/fixtures/manifest.json', '{"stable":true}\n');
  write(root, GENERATOR, 'export {};\n');
  const result = runCheck('provenance', root);
  assertExecutionError(result);
  assert.match(result.stderr, /git/i, 'the git failure is reported as the git failure it is');
});

test('provenance: a missing generator is NOT a mismatch', () => {
  assertExecutionError(runCheck('provenance', gitRootWithFixtures('prov-nogen')));
});

// ---------------------------------------------------------------------------
// The pinned api-version: a disagreeing literal is drift; an unreadable tree is
// not.
// ---------------------------------------------------------------------------

/** A scratch tree whose whole shipped surface agrees with the pinned version. */
function apiVersionRoot(prefix: string, pinned: string = API_VERSION): string {
  const root = scratch(prefix);
  write(root, 'packages/core/src/contract.ts', `export const API_VERSION = '${pinned}';\n`);
  write(root, 'packages/core/fixtures/call.json', `{"url":"?api-version=${API_VERSION}"}\n`);
  write(root, 'action.yml', `# api-version=${API_VERSION}\n`);
  write(root, 'azure-pipelines-extension/task.json', `{"note":"api-version=${API_VERSION}"}\n`);
  return root;
}

test('api-version: an unpinned constant is a confirmed mismatch', () => {
  assertMismatch(runCheck('api-version', apiVersionRoot('api-moved', '2099-01-01-preview')));
});

test('api-version: a literal that disagrees with the pin is a confirmed mismatch', () => {
  const root = apiVersionRoot('api-literal');
  write(root, 'packages/core/fixtures/call.json', '{"url":"?api-version=2099-01-01-preview"}\n');
  const result = runCheck('api-version', root);
  assertMismatch(result);
  assert.match(result.stderr, /2099-01-01-preview/, 'the disagreeing literal is named');
});

test('api-version: an unreadable shipped surface is NOT a mismatch', () => {
  const root = apiVersionRoot('api-unreadable');
  // The pinned constant itself cannot be read: no evidence either way.
  const missing = scratch('api-missing');
  write(missing, 'action.yml', '# empty\n');
  assertExecutionError(runCheck('api-version', missing));
  // ...and a consistent tree still matches, so the error case is not vacuous.
  assertMatch(runCheck('api-version', root));
});

// ---------------------------------------------------------------------------
// The real repository must be green under the same checks the schedule runs.
// ---------------------------------------------------------------------------

test('the shipped repository passes the pinned api-version check', () => {
  assertMatch(runCheck('api-version'));
});

test('the shipped repository re-derives its provenance manifest byte-identically', () => {
  assertMatch(runCheck('provenance'));
});

test('an unknown check is a usage error, never a contract verdict', () => {
  assertExecutionError(runCheck('not-a-check'));
});
