import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { API_VERSION, PROVIDER_OPERATIONS } from '../../packages/core/src/contract.ts';
import {
  RECEIPT_KIND,
  RECEIPT_SCHEMA_VERSION,
  receiptDigest,
  type Receipt,
  type Rv1Transcript,
} from './receipt.ts';

/**
 * E6 — preview release & handoff. The parts of "run RV1–RV3, then publish both
 * marketplaces from one commit" that a repository CAN own deterministically:
 *
 *   * E6-T1: a receipt CLI (`scripts/lib/rv-receipt.mjs`) that stamps and
 *     verifies a release-validation receipt, so the RV evidence is reproducible
 *     rather than asserted.
 *   * E6-T2: both release configs GATE on that receipt and on ONE core commit,
 *     and the rollback/deprecation runbooks are published.
 *   * E6-T3: a SCHEDULED source-contract drift workflow that files a service
 *     defect instead of silently accommodating a protocol change, plus the
 *     operational runbooks (release-from-one-commit, failed-RV, API bump).
 *
 * LIVE RV1–RV3 execution and the marketplace publications themselves need a real
 * preview environment and repo/ADO admin rights; they are deliberately NOT
 * simulated here. What is tested is that nothing can be released without them.
 */

const repoRootUrl = new URL('../../', import.meta.url);
const repoRoot = fileURLToPath(repoRootUrl);
// Normalized to LF so the structural assertions below hold on a CRLF checkout
// (`core.autocrlf=true`) as well as on the LF CI runners.
const readText = (path: string): string =>
  readFileSync(new URL(path, repoRootUrl), 'utf8').replace(/\r\n/g, '\n');
const CLI = join(repoRoot, 'scripts', 'lib', 'rv-receipt.mjs');

function runCli(args: string[], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

const REQUIRED_OPS = Object.values(PROVIDER_OPERATIONS);
const COMMIT = 'a'.repeat(40);

/** One adapter's synthetic RV1 transcript, internally consistent with the contract. */
function rv1Transcript(
  platform: 'github-action' | 'azure-pipelines-task',
  runId: string,
): Rv1Transcript {
  return {
    platform,
    validate: {
      acceptedStatus: 202,
      locationSuffix: 'validations/latest',
      retryAfterSeconds: 10,
      terminalStatus: 200,
      terminalState: 'Succeeded',
    },
    execute: {
      acceptedStatus: 202,
      locationSuffix: `runs/${runId}`,
      runId,
      runResourceIdSuffix: `runs/${runId}`,
      retryAfterSeconds: 10,
      terminalStatus: 200,
      terminalState: 'Succeeded',
    },
    cancel: {
      acceptedStatus: 202,
      locationSuffix: `runs/${runId}`,
      retryAfterSeconds: 10,
      terminalStatus: 200,
      terminalState: 'Canceled',
    },
    wire: {
      statusField: 'status',
      startTimeField: 'startTime',
      endTimeField: 'endTime',
      validationErrorChannels: ['errors', 'validationErrors'],
      runErrorChannels: ['errors', 'executionErrors'],
    },
  };
}

/** A synthetic, internally consistent receipt — NOT a real environment result. */
function receipt(): Receipt {
  return {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    kind: RECEIPT_KIND,
    template: false,
    apiVersion: API_VERSION,
    coreCommit: COMMIT,
    generatedAt: new Date().toISOString(),
    environment: { cloud: 'AzureCloud', region: 'westus2', workspaceScopeHash: 'b'.repeat(64) },
    artifacts: [
      { platform: 'github-action', build: 'v1.0.0-preview.1', coreCommit: COMMIT },
      { platform: 'azure-pipelines-task', build: 'ChaosStudioWorkspacesDev 1.0.0', coreCommit: COMMIT },
    ],
    checks: [
      {
        id: 'RV1',
        status: 'passed',
        observedAt: new Date().toISOString(),
        observations: {
          region: 'westus2',
          apiVersion: API_VERSION,
          transcripts: [
            rv1Transcript('github-action', '3f2504e0-4f89-11d3-9a0c-0305e82c3301'),
            rv1Transcript('azure-pipelines-task', '3f2504e0-4f89-11d3-9a0c-0305e82c3302'),
          ],
        },
      },
      {
        id: 'RV2',
        status: 'passed',
        observedAt: new Date().toISOString(),
        observations: {
          assignmentScope: 'workspace',
          roleDefinition: JSON.parse(readText('security/chaos-studio-runner.role-template.json')),
          federatedIdentities: [
            { platform: 'github-action', tokenAcquired: true, secretless: true },
            { platform: 'azure-pipelines-task', tokenAcquired: true, secretless: true },
          ],
          negativeCases: REQUIRED_OPS.map((op) => ({
            removedOperation: op,
            failedOperations: [op],
            succeededOperations: REQUIRED_OPS.filter((other) => other !== op),
          })),
          operationsProvenNotRequired: [
            'Microsoft.Chaos/workspaces/read',
            'Microsoft.Chaos/locations/workspaceOperationResults/read',
          ],
        },
      },
      {
        id: 'RV3',
        status: 'passed',
        observedAt: new Date().toISOString(),
        observations: {
          cancelToCanceledSeconds: 74,
          duplicateCancelAccepted: true,
          duplicateCancelTerminalState: 'Canceled',
          cancelOnTerminalRunAccepted: true,
          cleanupFailurePreservesOriginalFailure: true,
        },
      },
    ],
  };
}

function writeReceipt(value: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'rv-receipt-'));
  const file = join(dir, 'receipt.json');
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return file;
}

/** The digest is mandatory, so anything the CLI must ACCEPT has to be stamped. */
const stamp = (r: Receipt): Receipt => ({ ...r, digest: receiptDigest(r) });

// ---------------------------------------------------------------------------
// E6-T1 — the receipt CLI is the reproducible half of RV1–RV3.
// ---------------------------------------------------------------------------

test('the receipt CLI verifies a complete receipt and reports its digest and core commit', () => {
  const file = writeReceipt(stamp(receipt()));
  const result = runCli(['verify', file]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`^receipt-core-commit=${COMMIT}$`, 'm'));
  assert.match(result.stdout, /^receipt-digest=[0-9a-f]{64}$/m);
});

test('the receipt CLI REFUSES an unstamped receipt', () => {
  const result = runCli(['verify', writeReceipt(receipt())]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unstamped/);
});

test('the receipt CLI stamps a digest that its own verify then re-derives', () => {
  const file = writeReceipt(receipt());
  assert.equal(runCli(['stamp', file]).status, 0);
  const stamped = JSON.parse(readFileSync(file, 'utf8')) as Receipt;
  assert.match(stamped.digest ?? '', /^[0-9a-f]{64}$/);
  assert.equal(stamped.digest, receiptDigest(stamped));
  assert.equal(runCli(['verify', file]).status, 0);

  // Any post-stamp edit invalidates the receipt.
  stamped.environment.region = 'eastus2';
  writeFileSync(file, JSON.stringify(stamped), 'utf8');
  const tampered = runCli(['verify', file]);
  assert.equal(tampered.status, 1);
  assert.match(tampered.stderr, /digest/);
});

test('the receipt CLI refuses to stamp or verify the committed template', () => {
  const template = join(repoRoot, 'test', 'release-validation', 'receipt.template.json');
  const stamp = runCli(['stamp', template]);
  assert.equal(stamp.status, 1);
  assert.match(stamp.stderr, /template/i);

  const verify = runCli(['verify', template]);
  assert.equal(verify.status, 1);
  assert.match(verify.stderr, /template/i);
});

test('the receipt CLI binds a receipt to an expected core commit and rejects stale evidence', () => {
  const file = writeReceipt(stamp(receipt()));
  const wrongCommit = runCli(['verify', file], { EXPECTED_CORE_COMMIT: 'd'.repeat(40) });
  assert.equal(wrongCommit.status, 1);
  assert.match(wrongCommit.stderr, /expected core commit/);

  // Age the whole receipt — envelope AND observations — so staleness is the only defect.
  const stale = receipt();
  const old = new Date(Date.now() - 90 * 86_400_000).toISOString();
  stale.generatedAt = old;
  stale.checks.forEach((c) => { c.observedAt = old; });
  const staleResult = runCli(['verify', writeReceipt(stamp(stale))], { MAX_AGE_DAYS: '30' });
  assert.equal(staleResult.status, 1);
  assert.match(staleResult.stderr, /older than/);
});

test('the receipt CLI fails closed on a missing file, unreadable JSON, or an unknown command', () => {
  assert.equal(runCli(['verify', join(repoRoot, 'no-such-receipt.json')]).status, 2);
  assert.equal(runCli(['verify']).status, 2);
  assert.equal(runCli(['audit', join(repoRoot, 'package.json')]).status, 2);

  const dir = mkdtempSync(join(tmpdir(), 'rv-receipt-'));
  const broken = join(dir, 'receipt.json');
  writeFileSync(broken, '{ not json', 'utf8');
  assert.equal(runCli(['verify', broken]).status, 2);
});

test('a receipt whose observations contradict the contract fails the CLI gate', () => {
  const lying = receipt();
  // Declared passed, but the observed run never reached a terminal success.
  (lying.checks[0]!.observations as { transcripts: Array<{ execute: { terminalState: string } }> })
    .transcripts[0]!.execute.terminalState = 'Failed';
  const result = runCli(['verify', writeReceipt(stamp(lying))]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /RV1/);
});

// ---------------------------------------------------------------------------
// E6-T2 — both release configs gate on the receipt and on ONE core commit.
// ---------------------------------------------------------------------------

test('the Action release gates on an RV receipt inside the non-secret validate job', () => {
  const workflow = readText('.github/workflows/release-action.yml');
  const validate = workflow.slice(workflow.indexOf('\n  validate:'), workflow.indexOf('\n  package:'));
  assert.ok(validate.includes('node scripts/lib/rv-receipt.mjs verify'), 'the gate runs in validate');
  assert.ok(
    validate.includes('test/release-validation/receipts/'),
    'the receipt is looked up by release tag under the receipts directory',
  );
  // The released trees must be the ones RV1–RV3 actually exercised.
  assert.match(validate, /git merge-base --is-ancestor "\$VALIDATED_COMMIT" "\$RELEASE_COMMIT"/);
  assert.match(validate, /git diff --quiet "\$VALIDATED_COMMIT" "\$RELEASE_COMMIT" --/);
  for (const path of ['packages', 'action.yml', 'dist', 'azure-pipelines-extension']) {
    assert.ok(validate.includes(path), `${path} is covered by the release-equivalence check`);
  }
  // Shell-injection hygiene: the gate's SCRIPT reads only environment variables.
  // Workflow expressions belong in the `env:` mapping (the repo-wide pattern), so
  // scope this to the script body rather than the whole step.
  const gate = validate.slice(validate.indexOf('Release-validation receipt gate'));
  assert.doesNotMatch(gate.slice(gate.indexOf('run: |')), /\$\{\{/);
  assert.doesNotMatch(gate, /continue-on-error|\|\| true/);
  // No secret-bearing job may run the gate (it executes repository code).
  const publish = workflow.slice(workflow.indexOf('\n  publish:'));
  assert.doesNotMatch(publish, /rv-receipt\.mjs/);
});

test('the OneBranch extension pipeline gates the VSIX publish on the same receipt', () => {
  const pipeline = readText('.pipelines/OneBranch.Official.yml');
  assert.match(pipeline, /- name: releaseValidationReceipt/);
  const build = pipeline.slice(pipeline.indexOf('- stage: build'), pipeline.indexOf('- stage: sign'));
  assert.ok(build.includes('node scripts/lib/rv-receipt.mjs verify'), 'the gate runs in the unsigned build stage');
  assert.ok(build.includes('test/release-validation/receipts/'), 'receipts come from the tracked receipts directory');
  assert.match(build, /RECEIPT_NAME: \$\{\{ parameters\.releaseValidationReceipt \}\}/);
  // The gate must be inescapable on a publishing run.
  assert.match(build, /eq\('\$\{\{ parameters\.publishExtension \}\}', 'True'\)/);
  // The signing/publish stages hold the credentials and run no repository code.
  const publish = pipeline.slice(pipeline.indexOf('- stage: publish'));
  assert.doesNotMatch(publish, /rv-receipt\.mjs/);

  // The enforced invariant is that nothing is PUBLISHED without evidence: the publish
  // stage requires the same `publishExtension` predicate the gate keys on, and it
  // depends (through `sign`) on the gated `build` stage of its OWN run. If either link
  // breaks, a VSIX could reach the Marketplace without RV1-RV3.
  assert.match(publish, /eq\('\$\{\{ parameters\.publishExtension \}\}', true\)/);
  assert.match(pipeline, /- stage: sign\n {8}dependsOn: build\n/);
  assert.match(publish, /dependsOn: sign\n/);
});

test('the OneBranch pipeline binds the REBUILT runtime to the validated commit before it is staged or packaged', () => {
  const pipeline = readText('.pipelines/OneBranch.Official.yml');
  const build = pipeline.slice(pipeline.indexOf('- stage: build'), pipeline.indexOf('- stage: sign'));

  // The receipt gate proves the COMMITTED shipping paths are unchanged, but the
  // pipeline REBUILDS dist and stages that generated runtime into the VSIX, so a
  // changed build input outside those paths would otherwise ship unvalidated bytes.
  const equality = build.indexOf('node scripts/lib/verify-built-runtime.mjs');
  assert.ok(equality > 0, 'the rebuilt runtime is compared against the validated commit');

  const rebuild = build.indexOf('- script: npm run build');
  const stage = build.indexOf('Stage task runtime into every task folder');
  const packageVsix = build.indexOf('PackageAzureDevOpsExtension@4');
  assert.ok(rebuild > 0 && stage > 0 && packageVsix > 0, 'the build/stage/package steps exist');
  assert.ok(equality > rebuild, 'the equality check runs AFTER the rebuild');
  assert.ok(equality < stage, 'the equality check runs BEFORE the rebuilt runtime is staged');
  assert.ok(equality < packageVsix, 'the equality check runs BEFORE the VSIX is packaged');

  // The receipt gate publishes the validated commit for the equality check to consume.
  assert.match(build, /task\.setvariable variable=ReleaseValidatedCommit/);
  assert.match(build, /RUNTIME_BASELINE_COMMIT: \$\(ReleaseValidatedCommit\)/);
  // ...and a publishing run without that baseline FAILS rather than degrading to HEAD.
  const equalityStep = build.slice(build.lastIndexOf('- script: |', equality));
  assert.match(equalityStep, /publishExtension/, 'a publishing run requires the validated baseline');
  assert.doesNotMatch(equalityStep.slice(0, equalityStep.indexOf('displayName')), /\$\{\{ parameters/);
  assert.doesNotMatch(equalityStep.slice(0, equalityStep.indexOf('displayName')), /continue-on-error|\|\| true/);
});

test('both marketplaces are released from ONE core commit, provenance recorded on each side', () => {
  const runbook = readText('docs/runbooks/release.md');
  for (const marker of [
    'microsoft/chaos-studio@v1',
    'AzureChaosStudio.ChaosStudioWorkspaces',
    'test/release-validation/receipts/',
  ]) {
    assert.ok(runbook.includes(marker), `the release runbook names ${marker}`);
  }
  assert.match(runbook, /one commit/i);
});

/**
 * The body of one `## ` section of a runbook, heading included, up to the next
 * `## ` heading. Used to assert on the OPERATIONAL steps specifically, rather
 * than on explanatory prose elsewhere in the same document.
 */
function markdownSection(doc: string, heading: string): string {
  const start = doc.indexOf(heading);
  assert.notEqual(start, -1, `the runbook has a "${heading}" section`);
  const rest = doc.slice(start + heading.length);
  const end = rest.indexOf('\n## ');
  const body = heading + (end === -1 ? rest : rest.slice(0, end));
  // Collapsed to single spaces so a phrase that happens to be wrapped across a
  // line (or bolded around the wrap) still matches as one phrase.
  return body.replace(/\s+/g, ' ');
}

test('the publishing steps select the receipt-bearing release commit, not the validated core commit', () => {
  const runbook = readText('docs/runbooks/release.md');

  // Both release configs read the receipt from THEIR OWN checkout: the GitHub
  // `validate` job checks out the resolved release commit before reading
  // `test/release-validation/receipts/<tag>.json`, and the OneBranch `build`
  // stage reads it from the build's checkout. The receipt normally lands in a
  // LATER commit than the validated core commit (release.md section 0), so an
  // operational step that selects the validated core commit for either pipeline
  // selects a commit without the receipt and cannot publish.
  const github = markdownSection(runbook, '## 2. Release the GitHub Action');
  assert.match(
    github,
    /release commit/i,
    'the dispatch input is described as the release commit, not the validated core commit',
  );
  assert.match(github, /receipt/i, 'the dispatch step ties the release commit to the receipt');
  assert.doesNotMatch(
    github,
    /=\s*the (?:validated )?core commit/i,
    'the dispatch input must not be set to the validated core commit (it lacks the receipt)',
  );

  const ado = markdownSection(runbook, '## 3. Release the Azure Pipelines extension');
  assert.doesNotMatch(
    ado,
    /same core commit/i,
    'OneBranch must not be run at the validated core commit (its checkout lacks the receipt)',
  );
  assert.match(ado, /release commit/i, 'OneBranch is run at the same release commit as the Action');
  assert.match(ado, /receipt/i, 'the OneBranch step ties that commit to the receipt');

  // The gates the later commit is still held to must remain stated.
  assert.match(runbook, /ancestor/i, 'the ancestry gate is still documented');
  assert.match(runbook, /byte-identical/i, 'the shipping-equality gate is still documented');
  // ...and the receipt still carries the ORIGINAL validated commit.
  assert.match(
    markdownSection(runbook, '## 0. Pick the two commits'),
    /RV1–RV3 were run against/,
    'the receipt still records the commit RV1-RV3 actually ran against',
  );
});

test('the extension rollback publishes from the commit that carries the new receipt', () => {
  const runbook = readText('docs/runbooks/rollback-and-deprecation.md');
  const ado = markdownSection(runbook, '## 2. Roll back the Azure Pipelines extension');
  assert.doesNotMatch(
    ado,
    /at the new core commit/i,
    'rolling forward must not publish from the validated core commit (it lacks the receipt)',
  );
  assert.match(ado, /receipt/i, 'the roll-forward step names the receipt-bearing commit');
  assert.match(ado, /release commit/i);

  // The incident repoint moves the floating major tag onto a RELEASED commit —
  // the commit the last-good version tag resolves to — not onto the core commit
  // that release's receipt happens to record.
  const github = markdownSection(runbook, '## 1. Roll back the GitHub Action');
  assert.match(github, /git tag -f/, 'the incident repoint is still documented');
  assert.doesNotMatch(
    github,
    /<last-good-core-commit>/,
    'the floating tag must not be repointed at a validated core commit',
  );
  assert.match(
    github,
    /last-good-release-commit/,
    'the floating tag is repointed at the last-good release commit',
  );
});

test('rollback and deprecation runbooks cover both platforms, including the un-deletable task', () => {
  const runbook = readText('docs/runbooks/rollback-and-deprecation.md');
  for (const marker of [
    'floating major tag',
    'cannot be deleted',
    'deprecated',
    'ChaosStudioWorkspaces',
  ]) {
    assert.ok(runbook.includes(marker), `the rollback runbook covers "${marker}"`);
  }
});

// ---------------------------------------------------------------------------
// E6-T3 — scheduled drift detection + operational handoff.
// ---------------------------------------------------------------------------

test('the source-contract drift workflow runs on a schedule and fails closed', () => {
  const workflow = readText('.github/workflows/contract-drift.yml');
  assert.match(workflow, /^name: contract-drift$/m);
  // Scoped to the trigger block so an explanatory comment between `schedule:` and
  // its `cron:` does not defeat the assertion.
  const triggers = workflow.slice(workflow.indexOf('\non:'), workflow.indexOf('\npermissions:'));
  assert.match(triggers, /\n {2}schedule:\n/);
  assert.match(triggers, /\n {4}- cron: '[^']+'\n/);
  assert.match(triggers, /\n {2}workflow_dispatch:/);
  assert.match(workflow, /^permissions:\n {2}contents: read$/m);
  const drift = workflow.slice(workflow.indexOf('\n  drift:'), workflow.indexOf('\n  report:'));
  // The contract checks are EVALUATED by the drift CLI (behavioural coverage lives in
  // contract-drift-checks.test.ts); the workflow only wires them up.
  for (const check of ['classify', 'provenance', 'contract-suite', 'repository-suite', 'api-version']) {
    assert.ok(
      drift.includes(`node scripts/lib/contract-drift.mjs ${check}`),
      `the drift job runs the ${check} check`,
    );
  }
  const checks = readText('scripts/lib/contract-drift.mjs');
  assert.ok(checks.includes('packages/core/fixtures/scripts/generate-provenance.mjs'));
  assert.match(checks, /'diff', '--exit-code'/);
  assert.ok(checks.includes('packages/core/test/contract'));
  assert.ok(checks.includes(API_VERSION), 'the pinned api-version is asserted across the repo');
  assert.ok(drift.includes('test/release-validation/**/*.test.ts'));
  assert.doesNotMatch(drift, /continue-on-error|\|\| true/);
});

test('only explicitly classified SOURCE-PROTOCOL assertions can produce a contract mismatch', () => {
  // The contract test directory also holds repository-only assertions — the packaged
  // task manifest, the signing pipeline, the release rulesets. A failure there is a
  // repository regression, not evidence that the service protocol moved, so it must be
  // evaluated by a check that cannot publish contract evidence. (The BEHAVIOUR is
  // covered in contract-drift-checks.test.ts; this pins the shipped classification.)
  const checks = readText('scripts/lib/contract-drift.mjs');
  const protocol = checks.slice(
    checks.indexOf('const SOURCE_PROTOCOL_TESTS'),
    checks.indexOf('const REPOSITORY_POLICY_TESTS'),
  );
  const policy = checks.slice(
    checks.indexOf('const REPOSITORY_POLICY_TESTS'),
    checks.indexOf('const REPOSITORY_ONLY_ASSERTIONS'),
  );
  // The two files the review named explicitly: neither asserts the wire protocol.
  for (const repositoryOnly of ['manifest.test.ts', 'ado-pipeline.test.ts']) {
    assert.ok(policy.includes(repositoryOnly), `${repositoryOnly} is a repository-policy assertion`);
    assert.ok(
      !protocol.includes(repositoryOnly),
      `${repositoryOnly} must never produce a source-contract mismatch`,
    );
  }
  for (const protocolTest of ['validate.test.ts', 'run.test.ts', 'cancel.test.ts']) {
    assert.ok(protocol.includes(protocolTest), `${protocolTest} is a source-protocol assertion`);
  }

  const workflow = readText('.github/workflows/contract-drift.yml');
  const drift = workflow.slice(workflow.indexOf('\n  drift:'), workflow.indexOf('\n  report:'));
  // The repository-policy step is its own step, and the mismatch verdict does not
  // consult it: the CLI cannot emit one from it, and the workflow does not read one.
  assert.ok(drift.includes('id: repository_suite'), 'the repository-policy suite is its own step');
  const verdict = drift.slice(drift.indexOf('contractMismatch:'));
  assert.ok(
    !verdict.slice(0, verdict.indexOf('\n')).includes('repository_suite'),
    'the contract verdict never rests on a repository-policy failure',
  );
});

test('drift opens a service defect with least privilege and never changes client behavior', () => {
  const workflow = readText('.github/workflows/contract-drift.yml');
  const report = workflow.slice(workflow.indexOf('\n  report:'));
  assert.match(report, /needs: drift/);
  assert.match(report, /issues: write/);
  assert.ok(!report.includes('actions/checkout'), 'the reporting job runs no repository code');
  assert.match(report, /service defect/i);
  assert.match(report, /contract-drift/);
});

test('only a CONFIRMED contract mismatch is reported as a source-contract service defect', () => {
  const workflow = readText('.github/workflows/contract-drift.yml');
  const drift = workflow.slice(workflow.indexOf('\n  drift:'), workflow.indexOf('\n  report:'));
  const report = workflow.slice(workflow.indexOf('\n  report:'));

  // The drift job publishes an EXPLICIT contract-check verdict; a step that cannot
  // observe the contract (dependency install, the release-validation suite) never
  // sets it, so its failure cannot masquerade as drift.
  assert.match(drift, /\n {4}outputs:\n/);
  assert.match(drift, /contractMismatch: \$\{\{[^}]*steps\./);
  for (const id of ['provenance', 'contract_suite', 'api_version']) {
    assert.ok(drift.includes(`id: ${id}`), `the ${id} contract check is individually identified`);
  }
  // `contract=mismatch` is recorded ONLY by the drift CLI's checked-mismatch path —
  // never by a shell wrapper that cannot tell a mismatch from a command error.
  assert.doesNotMatch(drift, /GITHUB_OUTPUT/, 'no step writes a raw contract verdict of its own');
  const checks = readText('scripts/lib/contract-drift.mjs');
  assert.ok(checks.includes("appendFileSync(outputFile, 'contract=mismatch\\n')"));

  // The release-validation suite is a SEPARATE step from the contract suite so its
  // failure is reported for what it is.
  const contractSuite = drift.slice(drift.indexOf('id: contract_suite'));
  assert.ok(
    contractSuite
      .slice(0, contractSuite.indexOf('id: release_validation_suite'))
      .includes('node scripts/lib/contract-drift.mjs contract-suite'),
    'the contract suite step runs the contract check',
  );
  assert.ok(drift.includes('id: release_validation_suite'), 'the release-validation suite is its own step');
  const afterRvId = drift.slice(drift.indexOf('id: release_validation_suite'));
  const nextStep = afterRvId.indexOf('\n      - name:');
  const releaseValidation = nextStep === -1 ? afterRvId : afterRvId.slice(0, nextStep);
  assert.ok(releaseValidation.includes('test/release-validation/**/*.test.ts'), 'the release-validation step runs that suite');
  assert.ok(!releaseValidation.includes('contract-drift.mjs'), 'a release-validation failure does not claim contract drift');

  // Every contract check must PUBLISH its verdict even when a sibling step already
  // failed; otherwise a repository-side regression could skip the api-version check
  // and downgrade real drift to a mere workflow failure. The release-validation suite
  // runs last for the same reason.
  for (const id of ['provenance', 'contract_suite', 'api_version']) {
    const step = drift.slice(drift.indexOf(`id: ${id}`));
    assert.match(
      step.slice(0, step.indexOf('run:')),
      /if: \$\{\{ !cancelled\(\) && steps\.install\.outcome == 'success' \}\}/,
      `the ${id} check runs independently of the other checks' outcome`,
    );
  }
  assert.ok(
    drift.indexOf('id: api_version') < drift.indexOf('id: release_validation_suite'),
    'no repository-side suite runs ahead of a contract check',
  );

  // The reporting job branches on that verdict rather than on "the job failed".
  assert.match(report, /needs\.drift\.outputs\.contractMismatch/);
  // A non-contract failure is still reported, but never as a source-contract defect.
  assert.match(report, /did not (confirm|report) a (source-)?contract mismatch|not evidence of contract drift/i);
  assert.doesNotMatch(report, /continue-on-error/);
});

test('the drift workflow itself re-runs the TypeScript checks that guard it', () => {
  const test_yml = readText('.github/workflows/test.yml');
  const filter = test_yml.slice(test_yml.indexOf('            typescript:'), test_yml.indexOf('\n  typescript:'));
  assert.ok(filter.includes("- '.github/workflows/contract-drift.yml'"));
});

test('the operational runbooks cover failed release validation and an API-version bump', () => {
  const validation = readText('docs/runbooks/release-validation.md');
  for (const marker of ['RV1', 'RV2', 'RV3', 'rv-receipt.mjs', 'service defect']) {
    assert.ok(validation.includes(marker), `the release-validation runbook covers ${marker}`);
  }

  const drift = readText('docs/runbooks/contract-drift.md');
  assert.ok(drift.includes(API_VERSION), 'the drift runbook names the pinned api-version');
  assert.match(drift, /api-version bump/i);
  // D5/FR15: the pinned version changes by code + a fresh RV pass, never by input.
  assert.match(drift, /never a customer input|no `api-version` input/i);
});

test('the runbooks are discoverable from the integration docs and name the owning contact', () => {
  const docs = readText('docs/ci-cd-integrations.md');
  assert.ok(docs.includes('docs/runbooks/') || docs.includes('runbooks/'), 'the docs link the runbooks');

  const index = readText('docs/runbooks/README.md');
  for (const runbook of [
    'release.md',
    'release-validation.md',
    'rollback-and-deprecation.md',
    'contract-drift.md',
  ]) {
    assert.ok(index.includes(runbook), `the runbook index links ${runbook}`);
  }
  assert.ok(index.includes('aces@microsoft.com'), 'the handoff names the owning contact');
});
