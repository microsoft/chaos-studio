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
  assert.ok(drift.includes('node packages/core/fixtures/scripts/generate-provenance.mjs'));
  assert.match(drift, /git diff --exit-code/);
  assert.ok(drift.includes('packages/core/test/contract/**/*.test.ts'));
  assert.ok(drift.includes('test/release-validation/**/*.test.ts'));
  assert.ok(drift.includes(API_VERSION), 'the pinned api-version is asserted across the repo');
  assert.doesNotMatch(drift, /continue-on-error|\|\| true/);
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
