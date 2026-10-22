import { test } from 'node:test';
import assert from 'node:assert/strict';

import { GUID_PATTERN } from '../../src/contract.ts';
import { CoreError, type ScenarioCoordinates } from '../../src/ids.ts';
import { ArmHttpClient, Deadline } from '../../src/http.ts';
import { acceptExecute, classifyRunStatus, pollRun, readRunOnce } from '../../src/run.ts';
import {
  FakeClock,
  FakeCredential,
  FakeLogger,
  FakeTransport,
  FIXED_TOKEN,
  fixedRng,
  fixtureResponses,
  HANG,
  PendingCredential,
  response,
} from '../helpers/harness.ts';

const COORDS: ScenarioCoordinates = {
  subscriptionId: '11111111-1111-1111-1111-111111111111',
  resourceGroup: 'rg-chaos',
  workspaceName: 'ws-demo',
  scenarioName: 'scn-demo',
  scenarioConfigurationName: 'cfg-demo',
};

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

test('classifyRunStatus: terminal success/failure and pending-for-unknown (VF7, FR4)', () => {
  assert.equal(classifyRunStatus('Succeeded'), 'success');
  assert.equal(classifyRunStatus('Failed'), 'failure');
  assert.equal(classifyRunStatus('Canceled'), 'failure');
  for (const s of ['Queued', 'Resolving', 'Generating', 'Validating', 'ValidationSucceeded', 'Starting', 'Preparing', 'Running', 'CleaningUp', 'Canceling']) {
    assert.equal(classifyRunStatus(s), 'pending', `${s} is nonterminal`);
  }
  assert.equal(classifyRunStatus('Frobnicating'), 'pending', 'unknown stays pending');
  assert.equal(classifyRunStatus(undefined), 'pending');
});

test('acceptExecute parses the run GUID and resource ID from the execute Location (DX3, VF5)', async () => {
  const t = new FakeTransport().on('POST', '/execute', fixtureResponses('execute', 'accept-202.json'));
  const { c } = client(t);
  const acc = await acceptExecute(c, 'https://management.azure.com/x/execute', COORDS);
  assert.ok(GUID_PATTERN.test(acc.runId));
  assert.equal(acc.runId, '22222222-2222-2222-2222-222222222222');
  assert.ok(acc.runResourceId.endsWith('/scenarios/scn-demo/runs/22222222-2222-2222-2222-222222222222'));
  assert.equal(t.requestsFor('POST').length, 1);
});

test('acceptExecute fails closed on a foreign-scenario Location without re-POSTing (D14)', async () => {
  const bad = response(202, {
    Location:
      'https://management.azure.com/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/rg-chaos/providers/Microsoft.Chaos/workspaces/ws-demo/scenarios/OTHER/runs/22222222-2222-2222-2222-222222222222?api-version=2026-05-01-preview',
  });
  const t = new FakeTransport().on('POST', '/execute', bad);
  const { c } = client(t);
  await assert.rejects(
    () => acceptExecute(c, 'https://management.azure.com/x/execute', COORDS),
    (e) => e instanceof CoreError && e.category === 'ambiguous-acceptance',
  );
  assert.equal(t.requestsFor('POST').length, 1, 'no re-POST on ambiguous acceptance');
});

test('acceptExecute rejects an execute Location carrying a DUPLICATE api-version without re-POSTing (D5, D14, finding #2)', async () => {
  const base =
    'https://management.azure.com/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/rg-chaos/providers/Microsoft.Chaos/workspaces/ws-demo/scenarios/scn-demo/runs/22222222-2222-2222-2222-222222222222';
  for (const query of [
    '?api-version=2026-05-01-preview&api-version=2020-01-01',
    '?api-version=2026-05-01-preview&api-version=2026-05-01-preview',
  ]) {
    const t = new FakeTransport().on('POST', '/execute', response(202, { Location: base + query }, null));
    const { c } = client(t);
    await assert.rejects(
      () => acceptExecute(c, 'https://management.azure.com/x/execute', COORDS),
      (e) => e instanceof CoreError && e.category === 'ambiguous-acceptance',
      `expected duplicate api-version '${query}' to fail closed`,
    );
    assert.equal(t.requestsFor('POST').length, 1, 'no re-POST on ambiguous acceptance');
  }
});

test('pollRun transitions 202→200 to a terminal Succeeded run (VF6, VF7)', async () => {
  const t = new FakeTransport().on('GET', '/runs/', fixtureResponses('execute', 'run-transitions.json'));
  const { c, log, clock } = client(t);
  const outcome = await pollRun(c, 'https://management.azure.com/x/runs/y', Deadline.fromNow(clock, 2700), log);
  assert.equal(outcome.disposition, 'success');
  assert.equal(outcome.status, 'Succeeded');
  assert.ok(outcome.startTime && outcome.endTime);
  assert.equal(t.requestsFor('GET').length, 5);
  assert.equal(clock.totalSleptMs, 40000, 'four 10s Retry-After sleeps before the terminal poll');
});

test('pollRun resolves a terminal Failed run and logs redacted dual-channel detail (VF7, VF10, FR12)', async () => {
  const t = new FakeTransport().on('GET', '/runs/', fixtureResponses('execute', 'run-failed-200.json'));
  const { c, log } = client(t);
  const outcome = await pollRun(c, 'https://management.azure.com/x/runs/y', Deadline.fromNow(c.clock, 2700), log);
  assert.equal(outcome.disposition, 'failure');
  assert.equal(outcome.status, 'Failed');
  assert.equal(outcome.armErrorCode, 'InternalExecutionError');
  assert.ok(outcome.errors.length > 0 && outcome.businessErrors.length > 0);
  assert.ok(log.warnings.some((w) => w.includes('run terminal Failed')));
});

test('pollRun does NOT accept a terminal disposition from a 202 body; only a 200 terminates (FR6, finding #2)', async () => {
  // A 202 carrying properties.status=Succeeded must NOT be reported as run success
  // — polling continues until an HTTP 200 arrives.
  const t = new FakeTransport().on('GET', '/runs/', [
    response(202, { 'Retry-After': '10' }, { properties: { status: 'Succeeded', startTime: 't0', endTime: 't1' } }),
    response(200, {}, { properties: { status: 'Succeeded', startTime: 't0', endTime: 't1' } }),
  ]);
  const { c, log, clock } = client(t);
  const outcome = await pollRun(c, 'https://management.azure.com/x/runs/y', Deadline.fromNow(clock, 2700), log);
  assert.equal(outcome.disposition, 'success');
  assert.equal(t.requestsFor('GET').length, 2, 'the 202 Succeeded body did not terminate polling');
});

test('pollRun times out if a terminal-looking status only ever appears on a 202 (FR6, finding #2)', async () => {
  const t = new FakeTransport().on('GET', '/runs/', response(202, { 'Retry-After': '10' }, { properties: { status: 'Failed' } }));
  const { c, log, clock } = client(t);
  await assert.rejects(
    () => pollRun(c, 'https://management.azure.com/x/runs/y', Deadline.fromNow(clock, 25), log),
    (e) => e instanceof CoreError && e.category === 'timeout',
  );
});

test('pollRun times out if the run never reaches terminal within the deadline (FR10)', async () => {
  const t = new FakeTransport().on('GET', '/runs/', response(202, { 'Retry-After': '10' }, { properties: { status: 'Running' } }));
  const { c, log, clock } = client(t);
  await assert.rejects(
    () => pollRun(c, 'https://management.azure.com/x/runs/y', Deadline.fromNow(clock, 25), log),
    (e) => e instanceof CoreError && e.category === 'timeout',
  );
});

test('EXECUTE acceptance-to-first-poll: the acceptance Retry-After is honored BEFORE the first run GET (FR8, finding #1)', async () => {
  const clock = new FakeClock();
  let firstGetAt = -1;
  const t = new FakeTransport((req) => {
    if (req.method === 'GET' && req.url.includes('/runs/') && firstGetAt < 0) firstGetAt = clock.now();
  });
  const runLoc =
    'https://management.azure.com/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/rg-chaos/providers/Microsoft.Chaos/workspaces/ws-demo/scenarios/scn-demo/runs/22222222-2222-2222-2222-222222222222?api-version=2026-05-01-preview';
  t.on('POST', '/execute', response(202, { Location: runLoc, 'Retry-After': '10' }, null));
  t.on('GET', '/runs/', response(200, {}, { properties: { status: 'Succeeded', startTime: 't0', endTime: 't1' } }));
  const { c, log } = client(t, clock);

  const acc = await acceptExecute(c, 'https://management.azure.com/x/execute', COORDS, Deadline.fromNow(clock, 2700));
  assert.equal(acc.retryAfterSeconds, 10, 'the acceptance Retry-After is captured');
  const startAt = clock.now();
  const outcome = await pollRun(
    c,
    `https://management.azure.com${acc.runResourceId}?api-version=2026-05-01-preview`,
    Deadline.fromNow(clock, 2700),
    log,
    undefined,
    acc.retryAfterSeconds,
  );
  assert.equal(outcome.disposition, 'success');
  assert.equal(firstGetAt - startAt, 10000, 'the first run GET waited the full acceptance Retry-After (10s), not 0ms');
});

test('readRunOnce returns the last-observed status for no-wait mode (D11)', async () => {
  const t = new FakeTransport().on('GET', '/runs/', response(202, { 'Retry-After': '10' }, { properties: { status: 'Running', startTime: 't0' } }));
  const { c } = client(t);
  const rs = await readRunOnce(c, 'https://management.azure.com/x/runs/y');
  assert.equal(rs.status, 'Running');
  assert.equal(rs.startTime, 't0');
  assert.equal(t.requestsFor('GET').length, 1);
});

test('readRunOnce is a SINGLE attempt: a transient 503 throws without retry or sleep (D11, finding #4)', async () => {
  // A transient response must NOT trigger the retrying GET path (up to 8 attempts);
  // no-wait observation is exactly one best-effort GET.
  const t = new FakeTransport().on('GET', '/runs/', [
    response(503, { 'Retry-After': '10' }, { error: { code: 'ServerBusy' } }),
    response(200, {}, { properties: { status: 'Succeeded' } }),
  ]);
  const { c, clock } = client(t);
  await assert.rejects(
    () => readRunOnce(c, 'https://management.azure.com/x/runs/y'),
    (e) => e instanceof CoreError && e.category === 'transport',
  );
  assert.equal(t.requestsFor('GET').length, 1, 'exactly one GET, no retry');
  assert.equal(clock.totalSleptMs, 0, 'no retry sleep');
});

test('readRunOnce does not interpret an error body as run state (surfaces the failure) (finding #4)', async () => {
  // An error envelope that also carries a status-shaped field must not be read as a run status.
  const t = new FakeTransport().on('GET', '/runs/', response(500, {}, { error: { code: 'X' }, properties: { status: 'Succeeded' } }));
  const { c } = client(t);
  await assert.rejects(
    () => readRunOnce(c, 'https://management.azure.com/x/runs/y'),
    (e) => e instanceof CoreError && e.category === 'transport',
  );
});

test('readRunOnce is bounded by the deadline: a HUNG transport is aborted at expiry as a single-attempt timeout (D11, FR10, finding #1)', async () => {
  const clock = new FakeClock();
  const t = new FakeTransport().on('GET', '/runs/', HANG);
  const { c } = client(t, clock);
  const startAt = clock.now();
  await assert.rejects(
    () => readRunOnce(c, 'https://management.azure.com/x/runs/y', Deadline.fromNow(clock, 30)),
    (e) => e instanceof CoreError && e.category === 'timeout',
  );
  assert.equal(t.requestsFor('GET').length, 1, 'still exactly one GET attempt');
  assert.equal(clock.now() - startAt, 30000, 'the observation aborted at the deadline, not before or forever');
});

test('readRunOnce is bounded by the deadline: a SLOW (settling) credential that consumes the whole budget times out with zero sends (D11, FR10, finding #1)', async () => {
  const clock = new FakeClock();
  const t = new FakeTransport().on('GET', '/runs/', response(200, {}, { properties: { status: 'Running' } }));
  const log = new FakeLogger();
  // A credential exchange that advances virtual time past the budget then RESOLVES
  // — exercises the post-acquisition deadline recheck (send is refused).
  const cred = new FakeCredential(FIXED_TOKEN, () => clock.advance(31000));
  const c = new ArmHttpClient({ transport: t, clock, log, cred, signal: new AbortController().signal, rng: fixedRng(0.5) });
  await assert.rejects(
    () => readRunOnce(c, 'https://management.azure.com/x/runs/y', Deadline.fromNow(clock, 30)),
    (e) => e instanceof CoreError && e.category === 'timeout',
  );
  assert.equal(t.requestsFor('GET').length, 0, 'the observation GET was not sent after the credential exhausted the budget');
});

test('readRunOnce is bounded by the deadline: a genuinely PENDING credential is aborted by the watcher at the deadline (D11, FR10, finding #1)', async () => {
  const clock = new FakeClock();
  const t = new FakeTransport().on('GET', '/runs/', response(200, {}, { properties: { status: 'Running' } }));
  const log = new FakeLogger();
  // getArmToken returns a promise that NEVER settles on its own — it only rejects
  // when its signal aborts. Only the deadline watcher (advancing virtual time to
  // the 30s deadline and aborting) can end this — proving pending acquisition is
  // bounded, not just the post-acquisition check.
  const cred = new PendingCredential();
  const c = new ArmHttpClient({ transport: t, clock, log, cred, signal: new AbortController().signal, rng: fixedRng(0.5) });
  const startAt = clock.now();
  await assert.rejects(
    () => readRunOnce(c, 'https://management.azure.com/x/runs/y', Deadline.fromNow(clock, 30)),
    (e) => e instanceof CoreError && e.category === 'timeout',
  );
  assert.equal(cred.calls.length, 1, 'the observation acquired (attempted) the credential exactly once');
  assert.equal(clock.now() - startAt, 30000, 'the watcher advanced virtual time to the deadline before aborting');
  assert.equal(t.requestsFor('GET').length, 0, 'no observation GET was sent — the credential never resolved');
});
