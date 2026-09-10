import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CoreError, type ScenarioCoordinates } from '../../src/ids.ts';
import { ArmHttpClient, Deadline } from '../../src/http.ts';
import { acceptValidate, classifyValidationStatus, pollValidation } from '../../src/validation.ts';
import {
  FakeClock,
  FakeCredential,
  FakeLogger,
  FakeTransport,
  fixedRng,
  fixtureResponses,
  response,
} from '../helpers/harness.ts';

/** Coordinates matching the validate fixtures' Location. */
const COORDS: ScenarioCoordinates = {
  subscriptionId: '11111111-1111-1111-1111-111111111111',
  resourceGroup: 'rg-chaos',
  workspaceName: 'ws-demo',
  scenarioName: 'scn-demo',
  scenarioConfigurationName: 'cfg-demo',
};
const VALIDATE_URL = 'https://management.azure.com/x/validate?api-version=2026-05-01-preview';

function client(transport: FakeTransport, clock = new FakeClock()) {
  const log = new FakeLogger();
  const c = new ArmHttpClient({
    transport,
    clock,
    log,
    cred: new FakeCredential(),
    signal: new AbortController().signal,
    rng: fixedRng(0.5),
  });
  return { c, log, clock };
}

test('classifyValidationStatus: terminal success/failure and pending-for-unknown (VF3, FR4)', () => {
  assert.equal(classifyValidationStatus('Succeeded'), 'success');
  assert.equal(classifyValidationStatus('RequiresAttention'), 'failure');
  assert.equal(classifyValidationStatus('NoResolvedResources'), 'failure');
  for (const s of ['Resolving', 'Generating', 'Validating', 'Accepted', 'NotStarted']) {
    assert.equal(classifyValidationStatus(s), 'pending', `${s} is nonterminal`);
  }
  assert.equal(classifyValidationStatus('Frobnicating'), 'pending', 'unknown stays pending');
  assert.equal(classifyValidationStatus(undefined), 'pending');
});

test('acceptValidate returns the validations/latest Location bound to the requested configuration (VF1)', async () => {
  const t = new FakeTransport().on('POST', '/validate', fixtureResponses('validate', 'accept-202.json'));
  const { c } = client(t);
  const acc = await acceptValidate(c, VALIDATE_URL, COORDS);
  assert.ok(acc.location.includes('/configurations/cfg-demo/validations/latest'));
  assert.equal(acc.correlationId, 'aaaaaaaa-0000-0000-0000-000000000001');
});

test('acceptValidate fails closed (ambiguous-acceptance) when a 202 carries no Location (D14)', async () => {
  const t = new FakeTransport().on('POST', '/validate', response(202, {}, null));
  const { c } = client(t);
  await assert.rejects(
    () => acceptValidate(c, VALIDATE_URL, COORDS),
    (e) => e instanceof CoreError && e.category === 'ambiguous-acceptance',
  );
});

test('acceptValidate binds the Location to the exact configuration and rejects foreign/wrong-shape/unpinned Locations (D14)', async () => {
  const base =
    'https://management.azure.com/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/rg-chaos/providers/Microsoft.Chaos/workspaces/ws-demo/scenarios/scn-demo/configurations/cfg-demo/validations/latest';
  const cases: Array<[string, string]> = [
    // Foreign configuration — must not permit execution off another config's validation.
    [base.replace('/configurations/cfg-demo/', '/configurations/OTHER-cfg/') + '?api-version=2026-05-01-preview', 'foreign configuration'],
    // Foreign subscription.
    [base.replace('11111111-1111-1111-1111-111111111111', '99999999-9999-9999-9999-999999999999') + '?api-version=2026-05-01-preview', 'foreign subscription'],
    // Wrong shape (a run resource, not validations/latest).
    ['https://management.azure.com/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/rg-chaos/providers/Microsoft.Chaos/workspaces/ws-demo/scenarios/scn-demo/runs/22222222-2222-2222-2222-222222222222?api-version=2026-05-01-preview', 'wrong shape'],
    // Unpinned api-version.
    [base + '?api-version=2020-01-01', 'unpinned api-version'],
    // Missing api-version entirely.
    [base, 'no api-version'],
    // Non-ARM origin.
    [base.replace('management.azure.com', 'evil.example.com') + '?api-version=2026-05-01-preview', 'foreign origin'],
  ];
  for (const [loc, label] of cases) {
    const t = new FakeTransport().on('POST', '/validate', response(202, { Location: loc }, null));
    const { c } = client(t);
    await assert.rejects(
      () => acceptValidate(c, VALIDATE_URL, COORDS),
      (e) => e instanceof CoreError && e.category === 'ambiguous-acceptance',
      `expected ${label} to fail closed`,
    );
  }
});

test('acceptValidate accepts a case-normalized echo of the same configuration (ARM case-insensitivity)', async () => {
  const loc =
    'https://management.azure.com/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/RG-CHAOS/providers/Microsoft.Chaos/workspaces/WS-DEMO/scenarios/scn-demo/configurations/cfg-demo/validations/latest?api-version=2026-05-01-preview';
  const t = new FakeTransport().on('POST', '/validate', response(202, { Location: loc }, null));
  const { c } = client(t);
  const acc = await acceptValidate(c, VALIDATE_URL, COORDS);
  assert.equal(acc.location, loc);
});

test('acceptValidate rejects a validate Location carrying a DUPLICATE api-version (ambiguous effective version) (D5, D14, finding #2)', async () => {
  const base =
    'https://management.azure.com/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/rg-chaos/providers/Microsoft.Chaos/workspaces/ws-demo/scenarios/scn-demo/configurations/cfg-demo/validations/latest';
  for (const query of [
    '?api-version=2026-05-01-preview&api-version=2020-01-01', // pinned then conflicting
    '?api-version=2020-01-01&api-version=2026-05-01-preview', // conflicting then pinned
    '?api-version=2026-05-01-preview&api-version=2026-05-01-preview', // duplicated pinned
  ]) {
    const t = new FakeTransport().on('POST', '/validate', response(202, { Location: base + query }, null));
    const { c } = client(t);
    await assert.rejects(
      () => acceptValidate(c, VALIDATE_URL, COORDS),
      (e) => e instanceof CoreError && e.category === 'ambiguous-acceptance',
      `expected duplicate api-version '${query}' to fail closed`,
    );
  }
});

test('acceptValidate maps a 403 acceptance to an auth error', async () => {
  const t = new FakeTransport().on('POST', '/validate', response(403, { 'x-ms-error-code': 'AuthorizationFailed' }, { error: { code: 'AuthorizationFailed' } }));
  const { c } = client(t);
  await assert.rejects(
    () => acceptValidate(c, VALIDATE_URL, COORDS),
    (e) => e instanceof CoreError && e.category === 'auth' && e.armErrorCode === 'AuthorizationFailed',
  );
});

test('pollValidation resolves a terminal Succeeded validation (VF2, VF3)', async () => {
  const t = new FakeTransport().on('GET', '/validations/latest', fixtureResponses('validate', 'validation-succeeded-200.json'));
  const { c, log } = client(t);
  const outcome = await pollValidation(c, 'https://management.azure.com/x/validations/latest', Deadline.fromNow(c.clock, 2700), log);
  assert.equal(outcome.disposition, 'success');
  assert.equal(outcome.status, 'Succeeded');
  assert.ok(outcome.startTime && outcome.endTime);
});

test('pollValidation resolves a terminal RequiresAttention failure and logs redacted detail (VF3, VF10, FR12)', async () => {
  const t = new FakeTransport().on('GET', '/validations/latest', fixtureResponses('validate', 'validation-requires-attention-200.json'));
  const { c, log } = client(t);
  const outcome = await pollValidation(c, 'https://management.azure.com/x/validations/latest', Deadline.fromNow(c.clock, 2700), log);
  assert.equal(outcome.disposition, 'failure');
  assert.equal(outcome.status, 'RequiresAttention');
  assert.ok(outcome.businessErrors.length > 0, 'business errors captured for logging');
  assert.ok(log.warnings.some((w) => w.includes('validation terminal RequiresAttention')));
});

test('pollValidation advances through nonterminal and unknown states until terminal (FR4)', async () => {
  const t = new FakeTransport().on('GET', '/validations/latest', [
    response(202, { 'Retry-After': '10' }, { properties: { status: 'Validating' } }),
    response(202, { 'Retry-After': '10' }, { properties: { status: 'Frobnicating' } }), // unknown → still poll
    response(200, {}, { properties: { status: 'Succeeded', startTime: 't0', endTime: 't1' } }),
  ]);
  const { c, log, clock } = client(t);
  const outcome = await pollValidation(c, 'https://management.azure.com/x/validations/latest', Deadline.fromNow(clock, 2700), log);
  assert.equal(outcome.disposition, 'success');
  assert.equal(t.requestsFor('GET').length, 3);
  assert.equal(clock.totalSleptMs, 20000);
});

test('pollValidation does NOT accept a terminal disposition from a 202 body; only a 200 terminates (FR1, finding #2)', async () => {
  // A 202 carrying properties.status=Succeeded is a protocol inconsistency, NOT a
  // terminal validation — polling must continue until an HTTP 200 arrives, so an
  // in-flight validation can never authorize execution off a non-200 body.
  const t = new FakeTransport().on('GET', '/validations/latest', [
    response(202, { 'Retry-After': '10' }, { properties: { status: 'Succeeded', startTime: 't0', endTime: 't1' } }),
    response(200, {}, { properties: { status: 'Succeeded', startTime: 't0', endTime: 't1' } }),
  ]);
  const { c, log, clock } = client(t);
  const outcome = await pollValidation(c, 'https://management.azure.com/x/validations/latest', Deadline.fromNow(clock, 2700), log);
  assert.equal(outcome.disposition, 'success');
  assert.equal(t.requestsFor('GET').length, 2, 'the 202 Succeeded body did not terminate polling');
});

test('pollValidation times out if a terminal-looking status only ever appears on a 202 (FR1, finding #2)', async () => {
  const t = new FakeTransport().on('GET', '/validations/latest', response(202, { 'Retry-After': '10' }, { properties: { status: 'Succeeded' } }));
  const { c, log, clock } = client(t);
  await assert.rejects(
    () => pollValidation(c, 'https://management.azure.com/x/validations/latest', Deadline.fromNow(clock, 25), log),
    (e) => e instanceof CoreError && e.category === 'timeout',
  );
});

test('VALIDATE acceptance-to-first-poll: the acceptance Retry-After is honored BEFORE the first validations/latest GET (FR8, finding #1)', async () => {
  const clock = new FakeClock();
  let firstGetAt = -1;
  const t = new FakeTransport((req) => {
    if (req.method === 'GET' && req.url.includes('/validations/latest') && firstGetAt < 0) firstGetAt = clock.now();
  });
  const loc =
    'https://management.azure.com/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/rg-chaos/providers/Microsoft.Chaos/workspaces/ws-demo/scenarios/scn-demo/configurations/cfg-demo/validations/latest?api-version=2026-05-01-preview';
  t.on('POST', '/validate', response(202, { Location: loc, 'Retry-After': '10' }, null));
  t.on('GET', '/validations/latest', response(200, {}, { properties: { status: 'Succeeded', startTime: 't0', endTime: 't1' } }));
  const { c, log } = client(t, clock);

  const acc = await acceptValidate(c, VALIDATE_URL, COORDS, Deadline.fromNow(clock, 2700));
  assert.equal(acc.retryAfterSeconds, 10, 'the acceptance Retry-After is captured');
  const startAt = clock.now();
  const outcome = await pollValidation(c, acc.location, Deadline.fromNow(clock, 2700), log, acc.retryAfterSeconds);
  assert.equal(outcome.disposition, 'success');
  assert.equal(firstGetAt - startAt, 10000, 'the first validations/latest GET waited the full acceptance Retry-After (10s), not 0ms');
});
