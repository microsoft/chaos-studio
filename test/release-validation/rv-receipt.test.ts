import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  API_VERSION,
  CLEANUP_TIMEOUT_SECONDS,
  PROVIDER_OPERATIONS,
} from '../../packages/core/src/contract.ts';
import {
  RECEIPT_KIND,
  RECEIPT_SCHEMA_VERSION,
  canonicalize,
  evaluateRv1,
  evaluateRv2,
  evaluateRv3,
  receiptDigest,
  validateReceipt,
  type Receipt,
  type Rv1Observations,
  type Rv1Transcript,
  type Rv2Observations,
  type Rv3Observations,
} from './receipt.ts';

/**
 * E6-T1 — the release-validation receipt. RV1–RV3 are executed by a human
 * operator against a real target preview environment; this suite owns the
 * DETERMINISTIC half of that work: a receipt schema, pure pass/fail evaluators
 * grounded in the source-proven contract constants, and a canonical digest that
 * makes the receipt reproducible and tamper-evident.
 *
 * No receipt in this repository asserts a real environment result. The committed
 * `receipt.template.json` is a template (`template: true`, every check
 * `not-run`) and MUST fail validation — a release gate can never be satisfied by
 * a checked-in file.
 */

const repoRoot = new URL('../../', import.meta.url);
const readJson = (rel: string): unknown => JSON.parse(readFileSync(new URL(rel, repoRoot), 'utf8'));

function providerOpNames(): Set<string> {
  const snapshot = readJson('packages/core/fixtures/operations/provider-operations.json') as {
    value: Array<{ name: string }>;
  };
  return new Set(snapshot.value.map((o) => o.name));
}

const REQUIRED_OPS = Object.values(PROVIDER_OPERATIONS);
const COMMIT = 'a'.repeat(40);

/**
 * Stamp a receipt with its canonical digest. The digest is MANDATORY, so a
 * negative case that mutates a receipt must re-stamp it to keep the assertion
 * isolated to the property under test; the digest-tamper test deliberately does
 * NOT re-stamp.
 */
const stamp = (r: Receipt): Receipt => ({ ...r, digest: receiptDigest(r) });

/**
 * One adapter's synthetic transcript that matches the source-proven contract
 * exactly. `successRunId` and `cancelRunId` MUST be different runs: a
 * terminal-run cancellation is a no-op (RV3), so the same run cannot be
 * observed both Succeeded and, separately, Canceled.
 */
function transcript(
  platform: 'github-action' | 'azure-pipelines-task',
  successRunId: string,
  cancelRunId: string,
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
    successRun: {
      acceptedStatus: 202,
      locationSuffix: `runs/${successRunId}`,
      runId: successRunId,
      runResourceIdSuffix: `runs/${successRunId}`,
      retryAfterSeconds: 10,
      terminalStatus: 200,
      terminalState: 'Succeeded',
    },
    cancellationRun: {
      execute: {
        acceptedStatus: 202,
        locationSuffix: `runs/${cancelRunId}`,
        runId: cancelRunId,
        runResourceIdSuffix: `runs/${cancelRunId}`,
        retryAfterSeconds: 10,
      },
      inFlight: {
        status: 200,
        state: 'Running',
      },
      cancel: {
        acceptedStatus: 202,
        locationSuffix: `runs/${cancelRunId}`,
        retryAfterSeconds: 10,
        terminalStatus: 200,
        terminalState: 'Canceled',
      },
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

const ACTION_SUCCESS_RUN_ID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
const ACTION_CANCEL_RUN_ID = '3f2504e0-4f89-11d3-9a0c-0305e82c3311';
const TASK_SUCCESS_RUN_ID = '3f2504e0-4f89-11d3-9a0c-0305e82c3302';
const TASK_CANCEL_RUN_ID = '3f2504e0-4f89-11d3-9a0c-0305e82c3312';

/** A synthetic RV1 transcript set — one per adapter — matching the contract exactly. */
function rv1(): Rv1Observations {
  return {
    region: 'westus2',
    apiVersion: API_VERSION,
    transcripts: [
      transcript('github-action', ACTION_SUCCESS_RUN_ID, ACTION_CANCEL_RUN_ID),
      transcript('azure-pipelines-task', TASK_SUCCESS_RUN_ID, TASK_CANCEL_RUN_ID),
    ],
  };
}

function rv2(): Rv2Observations {
  return {
    assignmentScope: 'workspace',
    roleDefinition: readJson('security/chaos-studio-runner.role-template.json') as Rv2Observations['roleDefinition'],
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
  };
}

function rv3(): Rv3Observations {
  return {
    cancelToCanceledSeconds: 74,
    duplicateCancelAccepted: true,
    duplicateCancelTerminalState: 'Canceled',
    cancelOnTerminalRunAccepted: true,
    cleanupFailurePreservesOriginalFailure: true,
  };
}

/** A complete, internally consistent synthetic receipt (NOT a real environment result). */
function receipt(): Receipt {
  return stamp({
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    kind: RECEIPT_KIND,
    template: false,
    apiVersion: API_VERSION,
    coreCommit: COMMIT,
    generatedAt: '2026-01-15T12:00:00.000Z',
    environment: {
      cloud: 'AzureCloud',
      region: 'westus2',
      workspaceScopeHash: 'b'.repeat(64),
    },
    artifacts: [
      { platform: 'github-action', build: 'v1.0.0-preview.1', coreCommit: COMMIT },
      { platform: 'azure-pipelines-task', build: 'ChaosStudioWorkspacesDev 1.0.0', coreCommit: COMMIT },
    ],
    checks: [
      { id: 'RV1', status: 'passed', observedAt: '2026-01-15T11:30:00.000Z', observations: rv1() },
      { id: 'RV2', status: 'passed', observedAt: '2026-01-15T11:40:00.000Z', observations: rv2() },
      { id: 'RV3', status: 'passed', observedAt: '2026-01-15T11:50:00.000Z', observations: rv3() },
    ],
  });
}

const validate = (r: Receipt) => validateReceipt(r, { providerOpNames: providerOpNames() });

// ---------------------------------------------------------------------------
// RV1 — pinned-version protocol smoke in the release target region.
// ---------------------------------------------------------------------------

test('RV1 passes only when the observed protocol matches the source-derived contract', () => {
  const result = evaluateRv1(rv1());
  assert.deepEqual(result.failures, []);
  assert.equal(result.pass, true);
});

test('RV1 fails when the observed api-version is not the pinned one (no client accommodation)', () => {
  const obs = rv1();
  obs.apiVersion = '2026-02-01-preview';
  const result = evaluateRv1(obs);
  assert.equal(result.pass, false);
  assert.ok(result.failures.some((f) => f.includes('api-version')));
});

test('RV1 fails on a non-202 acceptance, a wrong validation Location, or a wrong Retry-After', () => {
  for (const mutate of [
    (t: Rv1Transcript) => { t.validate.acceptedStatus = 200; },
    (t: Rv1Transcript) => { t.validate.locationSuffix = 'validations/current'; },
    (t: Rv1Transcript) => { t.validate.retryAfterSeconds = 60; },
  ]) {
    const obs = rv1();
    mutate(obs.transcripts[0]!);
    assert.equal(evaluateRv1(obs).pass, false);
  }
});

test('RV1 requires exactly one transcript per shipping adapter, each from its own run', () => {
  // A single adapter's transcript is not evidence that BOTH private builds work.
  const actionOnly = rv1();
  actionOnly.transcripts = [actionOnly.transcripts[0]!];
  const missing = evaluateRv1(actionOnly);
  assert.equal(missing.pass, false);
  assert.ok(missing.failures.some((f) => f.includes('azure-pipelines-task')));

  // The same adapter twice is not two adapters.
  const duplicated = rv1();
  duplicated.transcripts[1]!.platform = 'github-action';
  assert.equal(evaluateRv1(duplicated).pass, false);

  // Re-recording ONE run under two platforms is not two runs.
  const sameRun = rv1();
  sameRun.transcripts[1] = { ...transcript('azure-pipelines-task', ACTION_SUCCESS_RUN_ID, ACTION_CANCEL_RUN_ID) };
  const reused = evaluateRv1(sameRun);
  assert.equal(reused.pass, false);
  assert.ok(reused.failures.some((f) => f.includes('distinct')));

  const unknownPlatform = rv1();
  (unknownPlatform.transcripts[1] as { platform: string }).platform = 'jenkins';
  assert.equal(evaluateRv1(unknownPlatform).pass, false);

  // GUIDs are case-insensitive: re-casing one copy is still the same single run.
  const reCased = rv1();
  reCased.transcripts[1] = transcript(
    'azure-pipelines-task',
    ACTION_SUCCESS_RUN_ID.toUpperCase(),
    TASK_CANCEL_RUN_ID,
  );
  const folded = evaluateRv1(reCased);
  assert.equal(folded.pass, false);
  assert.ok(folded.failures.some((f) => f.includes('distinct')));

  // The success run and cancellation run within ONE adapter's transcript must
  // also be different runs — a terminal-run cancel is a no-op (RV3), so the
  // same run cannot be both Succeeded and separately observed Canceled.
  const sameRunWithinAdapter = rv1();
  sameRunWithinAdapter.transcripts[0]!.cancellationRun.execute.runId = ACTION_SUCCESS_RUN_ID;
  sameRunWithinAdapter.transcripts[0]!.cancellationRun.execute.runResourceIdSuffix = `runs/${ACTION_SUCCESS_RUN_ID}`;
  sameRunWithinAdapter.transcripts[0]!.cancellationRun.execute.locationSuffix = `runs/${ACTION_SUCCESS_RUN_ID}`;
  sameRunWithinAdapter.transcripts[0]!.cancellationRun.cancel.locationSuffix = `runs/${ACTION_SUCCESS_RUN_ID}`;
  const sameJourney = evaluateRv1(sameRunWithinAdapter);
  assert.equal(sameJourney.pass, false);
  assert.ok(sameJourney.failures.some((f) => f.includes('must be different runs')));
});

test('RV1 evaluates EVERY adapter transcript, not just the first', () => {
  // A defect in the second adapter's transcript must still fail the check.
  const obs = rv1();
  obs.transcripts[1]!.validate.acceptedStatus = 200;
  const result = evaluateRv1(obs);
  assert.equal(result.pass, false);
  assert.ok(result.failures.some((f) => f.includes('azure-pipelines-task')));
});

test('RV1 fails when the execute Location run segment is not a GUID or disagrees with the run ID', () => {
  const notGuid = rv1();
  notGuid.transcripts[0]!.successRun.runId = 'latest';
  notGuid.transcripts[0]!.successRun.runResourceIdSuffix = 'runs/latest';
  assert.equal(evaluateRv1(notGuid).pass, false);

  const mismatch = rv1();
  mismatch.transcripts[0]!.successRun.runResourceIdSuffix = `runs/${TASK_SUCCESS_RUN_ID}`;
  assert.equal(evaluateRv1(mismatch).pass, false);

  // The execute acceptance Location must address the run it reported...
  const strayExecuteLocation = rv1();
  strayExecuteLocation.transcripts[0]!.successRun.locationSuffix = `runs/${TASK_SUCCESS_RUN_ID}`;
  assert.equal(evaluateRv1(strayExecuteLocation).pass, false);

  // ...and the cancel acceptance must address that SAME run, not another one.
  const strayCancelLocation = rv1();
  strayCancelLocation.transcripts[0]!.cancellationRun.cancel.locationSuffix = `runs/${TASK_SUCCESS_RUN_ID}`;
  assert.equal(evaluateRv1(strayCancelLocation).pass, false);
});

test('RV1 fails when a terminal state is outside the source-proven terminal sets', () => {
  const badValidation = rv1();
  badValidation.transcripts[0]!.validate.terminalState = 'RequiresAttention';
  assert.equal(evaluateRv1(badValidation).pass, false);

  const badRun = rv1();
  badRun.transcripts[0]!.successRun.terminalState = 'Failed';
  assert.equal(evaluateRv1(badRun).pass, false);

  const badCancel = rv1();
  badCancel.transcripts[0]!.cancellationRun.cancel.terminalState = 'Succeeded';
  assert.equal(evaluateRv1(badCancel).pass, false);
});

// R1: the cancellation run must be caught genuinely IN FLIGHT (a non-terminal
// GET) before it is canceled — never driven to a terminal state first, since
// a terminal-run cancellation is a no-op (RV3) and the same run can never be
// observed BOTH Succeeded and, separately, Canceled.
test('RV1 passes a realistic in-flight-to-Canceled cancellation transcript (202 accepted, Running observed, then Canceled)', () => {
  const obs = rv1();
  for (const t of obs.transcripts) {
    assert.equal(t.cancellationRun.inFlight.status, 200);
    assert.equal(t.cancellationRun.inFlight.state, 'Running');
  }
  assert.equal(evaluateRv1(obs).pass, true);
});

test('RV1 rejects a cancellation run whose in-flight observation reports a terminal state (impossible transcript)', () => {
  for (const terminalState of ['Succeeded', 'Failed', 'Canceled']) {
    const obs = rv1();
    obs.transcripts[0]!.cancellationRun.inFlight.state = terminalState;
    const result = evaluateRv1(obs);
    assert.equal(result.pass, false);
    assert.ok(result.failures.some((f) => f.includes('in-flight') && f.includes('non-terminal')));
  }
});

test('RV1 rejects a cancellation run whose in-flight observation was not a 200 GET', () => {
  const obs = rv1();
  obs.transcripts[0]!.cancellationRun.inFlight.status = 202;
  const result = evaluateRv1(obs);
  assert.equal(result.pass, false);
  assert.ok(result.failures.some((f) => f.includes('in-flight') && f.includes('200')));
});

test('RV1 rejects a cancellation execute acceptance that is not a bare 202/Location/Retry-After (no terminal fields to fabricate)', () => {
  const obs = rv1();
  obs.transcripts[0]!.cancellationRun.execute.acceptedStatus = 200;
  const result = evaluateRv1(obs);
  assert.equal(result.pass, false);
  assert.ok(result.failures.some((f) => f.includes('cancellation execute')));
});

test('RV1 fails when the deployed wire shape drifts from the generated models (status/time/error channels)', () => {
  for (const mutate of [
    (t: Rv1Transcript) => { t.wire.statusField = 'state'; },
    (t: Rv1Transcript) => { t.wire.startTimeField = 'startedAt'; },
    (t: Rv1Transcript) => { t.wire.validationErrorChannels = ['errors']; },
    (t: Rv1Transcript) => { t.wire.runErrorChannels = ['errors', 'validationErrors']; },
  ]) {
    const obs = rv1();
    mutate(obs.transcripts[0]!);
    assert.equal(evaluateRv1(obs).pass, false);
  }
});

// ---------------------------------------------------------------------------
// RV2 — workload identity + least-privilege authorization.
// ---------------------------------------------------------------------------

test('RV2 passes for secretless WIF on both platforms with the workspace-scoped five-operation role', () => {
  const result = evaluateRv2(rv2(), providerOpNames());
  assert.deepEqual(result.failures, []);
  assert.equal(result.pass, true);
});

test('RV2 fails when the proven assignment scope is broader than the workspace resource', () => {
  const obs = rv2();
  obs.assignmentScope = 'resource-group';
  assert.equal(evaluateRv2(obs, providerOpNames()).pass, false);
});

test('RV2 fails when either platform identity is missing or used a secret instead of WIF', () => {
  const missing = rv2();
  missing.federatedIdentities = missing.federatedIdentities.filter((i) => i.platform !== 'azure-pipelines-task');
  assert.equal(evaluateRv2(missing, providerOpNames()).pass, false);

  const secretful = rv2();
  secretful.federatedIdentities[0]!.secretless = false;
  assert.equal(evaluateRv2(secretful, providerOpNames()).pass, false);
});

test('RV2 evaluates EVERY identity entry, so a contradictory duplicate cannot hide', () => {
  // A failed/secret-backed retry appended after a passing entry for the same
  // platform must not be ignored.
  const contradictory = rv2();
  contradictory.federatedIdentities.push({
    platform: 'github-action',
    tokenAcquired: false,
    secretless: false,
  });
  const result = evaluateRv2(contradictory, providerOpNames());
  assert.equal(result.pass, false);
  assert.ok(result.failures.some((f) => f.includes('exactly one github-action')));

  const unknownPlatform = rv2();
  (unknownPlatform.federatedIdentities[0] as { platform: string }).platform = 'jenkins';
  assert.equal(evaluateRv2(unknownPlatform, providerOpNames()).pass, false);
});

test('RV2 fails when a negative case does not fail exactly its own operation', () => {
  const collateral = rv2();
  collateral.negativeCases[0]!.failedOperations = [
    collateral.negativeCases[0]!.removedOperation,
    PROVIDER_OPERATIONS.runRead,
  ];
  assert.equal(evaluateRv2(collateral, providerOpNames()).pass, false);

  const noEffect = rv2();
  noEffect.negativeCases[1]!.failedOperations = [];
  assert.equal(evaluateRv2(noEffect, providerOpNames()).pass, false);
});

test('RV2 fails when a required operation was never negatively tested', () => {
  const obs = rv2();
  obs.negativeCases = obs.negativeCases.slice(1);
  assert.equal(evaluateRv2(obs, providerOpNames()).pass, false);
});

test('RV2 fails when the role under test is not the least-privilege template', () => {
  const obs = rv2();
  obs.roleDefinition = { Actions: [...REQUIRED_OPS, 'Microsoft.Chaos/workspaces/write'] };
  const result = evaluateRv2(obs, providerOpNames());
  assert.equal(result.pass, false);
  assert.ok(result.failures.some((f) => f.includes('Microsoft.Chaos/workspaces/write')));
});

test('RV2 fails unless both unused operations are proven unnecessary', () => {
  const obs = rv2();
  obs.operationsProvenNotRequired = ['Microsoft.Chaos/workspaces/read'];
  assert.equal(evaluateRv2(obs, providerOpNames()).pass, false);
});

// ---------------------------------------------------------------------------
// RV3 — cancellation operational bounds and idempotency.
// ---------------------------------------------------------------------------

test('RV3 passes when cancellation lands inside the fixed cleanup budget and is idempotent', () => {
  const result = evaluateRv3(rv3());
  assert.deepEqual(result.failures, []);
  assert.equal(result.pass, true);
});

test('RV3 fails when cancellation exceeds the 300-second cleanup deadline (D10 reversal trigger)', () => {
  const obs = rv3();
  obs.cancelToCanceledSeconds = CLEANUP_TIMEOUT_SECONDS + 1;
  const result = evaluateRv3(obs);
  assert.equal(result.pass, false);
  assert.ok(result.failures.some((f) => f.includes(String(CLEANUP_TIMEOUT_SECONDS))));
});

test('RV3 fails on a non-positive or non-finite cancellation measurement', () => {
  for (const seconds of [0, -1, Number.NaN]) {
    const obs = rv3();
    obs.cancelToCanceledSeconds = seconds;
    assert.equal(evaluateRv3(obs).pass, false);
  }
});

test('RV3 fails when a rapid duplicate cancel, a terminal-run cancel, or cleanup masking regresses', () => {
  for (const mutate of [
    (o: Rv3Observations) => { o.duplicateCancelAccepted = false; },
    (o: Rv3Observations) => { o.duplicateCancelTerminalState = 'Failed'; },
    (o: Rv3Observations) => { o.cancelOnTerminalRunAccepted = false; },
    (o: Rv3Observations) => { o.cleanupFailurePreservesOriginalFailure = false; },
  ]) {
    const obs = rv3();
    mutate(obs);
    assert.equal(evaluateRv3(obs).pass, false);
  }
});

// ---------------------------------------------------------------------------
// Receipt: reproducibility + fail-closed release gate.
// ---------------------------------------------------------------------------

test('a complete receipt whose checks match the contract validates', () => {
  const result = validate(receipt());
  assert.deepEqual(result.failures, []);
  assert.equal(result.ok, true);
});

test('the canonical digest is stable across key order and changes with any content change', () => {
  const a = receipt();
  const b = receipt();
  // Reorder top-level keys: canonicalization must make the digest identical.
  const reordered = Object.fromEntries(Object.entries(b).reverse()) as unknown as Receipt;
  assert.equal(receiptDigest(reordered), receiptDigest(a));
  assert.match(receiptDigest(a), /^[0-9a-f]{64}$/);
  assert.equal(canonicalize({ b: 1, a: [2, { d: 3, c: 4 }] }), '{"a":[2,{"c":4,"d":3}],"b":1}');

  const tampered = receipt();
  tampered.checks[2]!.observations = { ...rv3(), cancelToCanceledSeconds: 73 };
  assert.notEqual(receiptDigest(tampered), receiptDigest(a));
});

test('a stamped digest that no longer matches the receipt body is rejected', () => {
  const stamped = receipt();
  assert.equal(validate(stamped).ok, true);

  // Deliberately NOT re-stamped: this is the post-stamp edit the digest exists to catch.
  stamped.environment.region = 'eastus2';
  const result = validate(stamped);
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((f) => f.includes('digest')));
});

test('an UNSTAMPED receipt is rejected outright', () => {
  const { digest: _dropped, ...unstamped } = receipt();
  const result = validate(unstamped as Receipt);
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((f) => f.includes('unstamped')));
});

test('a receipt is rejected when its checks are missing, duplicated, unknown, or not passed', () => {
  const missing = receipt();
  missing.checks = missing.checks.slice(0, 2);
  assert.equal(validate(stamp(missing)).ok, false);

  const duplicated = receipt();
  duplicated.checks = [duplicated.checks[0]!, duplicated.checks[0]!, duplicated.checks[1]!, duplicated.checks[2]!];
  assert.equal(validate(stamp(duplicated)).ok, false);

  const unknown = receipt();
  (unknown.checks[0] as { id: string }).id = 'RV4';
  assert.equal(validate(stamp(unknown)).ok, false);

  const notRun = receipt();
  notRun.checks[1]!.status = 'not-run';
  assert.equal(validate(stamp(notRun)).ok, false);
});

test('a receipt whose declared status contradicts the evaluated observations is rejected', () => {
  const lying = receipt();
  (lying.checks[0]!.observations as Rv1Observations).transcripts[0]!.validate.terminalState = 'RequiresAttention';
  const result = validate(stamp(lying));
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((f) => f.startsWith('RV1:')));
});

test('a receipt is rejected unless BOTH marketplace artifacts were built from the one core commit', () => {
  const split = receipt();
  split.artifacts[1]!.coreCommit = 'c'.repeat(40);
  const result = validate(stamp(split));
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((f) => f.includes('coreCommit')));

  const onePlatform = receipt();
  onePlatform.artifacts = onePlatform.artifacts.slice(0, 1);
  assert.equal(validate(stamp(onePlatform)).ok, false);
});

test('a receipt is bound to the release commit under validation when one is supplied', () => {
  const opts = { providerOpNames: providerOpNames(), expectedCoreCommit: 'd'.repeat(40) };
  const result = validateReceipt(receipt(), opts);
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((f) => f.includes('expected core commit')));
});

test('a receipt is rejected for a non-public cloud, a raw workspace scope, or a bad commit shape', () => {
  const sovereign = receipt();
  sovereign.environment.cloud = 'AzureUSGovernment';
  assert.equal(validate(stamp(sovereign)).ok, false);

  const rawScope = receipt();
  rawScope.environment.workspaceScopeHash =
    '/subscriptions/3f2504e0-4f89-11d3-9a0c-0305e82c3301/resourceGroups/rg/providers/Microsoft.Chaos/workspaces/w';
  assert.equal(validate(stamp(rawScope)).ok, false);

  const shortCommit = receipt();
  shortCommit.coreCommit = 'abc1234';
  shortCommit.artifacts.forEach((a) => { a.coreCommit = 'abc1234'; });
  assert.equal(validate(stamp(shortCommit)).ok, false);
});

test('a receipt is rejected when it pins a different api-version than the release', () => {
  const stale = receipt();
  stale.apiVersion = '2026-02-01-preview';
  assert.equal(validate(stamp(stale)).ok, false);
});

test('RV1 evidence from a region other than the receipt environment is rejected', () => {
  const crossRegion = receipt();
  (crossRegion.checks[0]!.observations as Rv1Observations).region = 'eastus';
  const result = validate(stamp(crossRegion));
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((f) => f.includes('environment region')));
});

test('a receipt older than the allowed age is rejected (stale environment evidence)', () => {
  const opts = {
    providerOpNames: providerOpNames(),
    now: Date.parse('2026-03-15T12:00:00.000Z'),
    maxAgeDays: 14,
  };
  const result = validateReceipt(receipt(), opts);
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((f) => f.includes('older than')));

  const fresh = validateReceipt(receipt(), { ...opts, now: Date.parse('2026-01-20T12:00:00.000Z') });
  assert.equal(fresh.ok, true);
});

test('stale OBSERVATIONS cannot be repackaged under a fresh generatedAt', () => {
  const opts = {
    providerOpNames: providerOpNames(),
    now: Date.parse('2026-03-15T12:00:00.000Z'),
    maxAgeDays: 14,
  };
  // A current `generatedAt` wrapped around year-old RV transcripts: the receipt
  // would look fresh if only the envelope were bounded.
  const repackaged = receipt();
  repackaged.generatedAt = '2026-03-15T11:00:00.000Z';
  const result = validateReceipt(stamp(repackaged), opts);
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((f) => f.includes('RV1') && f.includes('older than')));
});

test('a post-dated receipt or an observation after its own receipt is rejected', () => {
  const opts = {
    providerOpNames: providerOpNames(),
    now: Date.parse('2026-01-20T12:00:00.000Z'),
    maxAgeDays: 14,
  };

  // Post-dating would otherwise buy unlimited freshness.
  const postDated = receipt();
  postDated.generatedAt = '2026-06-01T00:00:00.000Z';
  postDated.checks.forEach((c) => { c.observedAt = '2026-06-01T00:00:00.000Z'; });
  const future = validateReceipt(stamp(postDated), opts);
  assert.equal(future.ok, false);
  assert.ok(future.failures.some((f) => f.includes('future')));

  // An observation cannot post-date the receipt that reports it.
  const outOfOrder = receipt();
  outOfOrder.checks[1]!.observedAt = '2026-01-16T12:00:00.000Z';
  const ordered = validateReceipt(stamp(outOfOrder), opts);
  assert.equal(ordered.ok, false);
  assert.ok(ordered.failures.some((f) => f.includes('after the receipt')));
});

test('the committed receipt TEMPLATE can never satisfy the release gate', () => {
  const template = readJson('test/release-validation/receipt.template.json') as Receipt;
  assert.equal(template.template, true);
  assert.equal(template.kind, RECEIPT_KIND);
  assert.equal(template.apiVersion, API_VERSION);
  assert.deepEqual(template.checks.map((c) => c.id), ['RV1', 'RV2', 'RV3']);
  for (const check of template.checks) {
    assert.equal(check.status, 'not-run', `${check.id} carries no fabricated result`);
  }

  const result = validate(template);
  assert.equal(result.ok, false, 'a template is never a passing receipt');
  assert.ok(result.failures.some((f) => f.includes('template')));
});
