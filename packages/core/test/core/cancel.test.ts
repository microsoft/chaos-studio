import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ArmHttpClient, Deadline } from '../../src/http.ts';
import { bestEffortCancel } from '../../src/cancel.ts';
import {
  FakeClock,
  FakeCredential,
  FakeLogger,
  FakeTransport,
  FIXED_TOKEN,
  fixedRng,
  fixtureResponses,
  response,
} from '../helpers/harness.ts';

const RUN_RESOURCE_ID =
  '/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/rg-chaos/providers/Microsoft.Chaos/workspaces/ws-demo/scenarios/scn-demo/runs/22222222-2222-2222-2222-222222222222';

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

test('bestEffortCancel POSTs cancel then polls the run to terminal Canceled (FR11, VF8)', async () => {
  const t = new FakeTransport()
    .on('POST', '/cancel', fixtureResponses('cancel', 'accept-202.json'))
    .on('GET', '/runs/', fixtureResponses('cancel', 'run-transitions.json'));
  const { c, log, clock } = client(t);
  const outcome = await bestEffortCancel(c, RUN_RESOURCE_ID, Deadline.fromNow(clock, 300), log);
  assert.ok(outcome);
  assert.equal(outcome.status, 'Canceled');
  assert.equal(outcome.disposition, 'failure');
  assert.equal(t.requestsFor('POST').length, 1, 'cancel is POSTed once');
  assert.ok(log.infos.some((m) => m.includes('cleanup: run reached terminal Canceled')));
});

test('bestEffortCancel swallows a cleanup timeout and never throws (FR11)', async () => {
  const t = new FakeTransport()
    .on('POST', '/cancel', fixtureResponses('cancel', 'accept-202.json'))
    .on('GET', '/runs/', response(202, { 'Retry-After': '10' }, { properties: { status: 'Canceling' } }));
  const { c, log, clock } = client(t);
  const outcome = await bestEffortCancel(c, RUN_RESOURCE_ID, Deadline.fromNow(clock, 25), log);
  assert.equal(outcome, undefined);
  assert.ok(log.warnings.some((m) => m.includes('cleanup did not complete')));
});

test('bestEffortCancel swallows a failed cancel POST and never throws (FR11)', async () => {
  const t = new FakeTransport().on('POST', '/cancel', response(500, {}, { error: { code: 'ServerError' } }));
  const { c, log, clock } = client(t);
  const outcome = await bestEffortCancel(c, RUN_RESOURCE_ID, Deadline.fromNow(clock, 300), log);
  assert.equal(outcome, undefined);
  assert.ok(log.warnings.some((m) => m.includes('cleanup did not complete')));
});

test('bestEffortCancel refuses a cancel Location pointing at a DIFFERENT run and reports no terminal (D14, finding #2)', async () => {
  // A cancel 202 whose Location names another run must not be followed — cleanup
  // must never poll or report a foreign run's state.
  const foreign = response(202, {
    Location:
      'https://management.azure.com/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/rg-chaos/providers/Microsoft.Chaos/workspaces/ws-demo/scenarios/scn-demo/runs/33333333-3333-3333-3333-333333333333?api-version=2026-05-01-preview',
  });
  const t = new FakeTransport()
    .on('POST', '/cancel', foreign)
    // If the foreign Location were (wrongly) followed, this route would answer it.
    .on('GET', '/runs/33333333-3333-3333-3333-333333333333', response(200, {}, { properties: { status: 'Canceled' } }));
  const { c, log, clock } = client(t);
  const outcome = await bestEffortCancel(c, RUN_RESOURCE_ID, Deadline.fromNow(clock, 300), log);
  assert.equal(outcome, undefined, 'a foreign-run cancel Location yields no terminal outcome');
  assert.equal(t.requestsFor('GET').length, 0, 'the foreign run resource is never polled');
  assert.ok(log.warnings.some((m) => m.includes('cleanup did not complete')));
});

test('bestEffortCancel rejects a cancel Location with an unpinned api-version (D14, finding #2)', async () => {
  const unpinned = response(202, {
    Location:
      'https://management.azure.com/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/rg-chaos/providers/Microsoft.Chaos/workspaces/ws-demo/scenarios/scn-demo/runs/22222222-2222-2222-2222-222222222222?api-version=2020-01-01',
  });
  const t = new FakeTransport().on('POST', '/cancel', unpinned);
  const { c, log, clock } = client(t);
  const outcome = await bestEffortCancel(c, RUN_RESOURCE_ID, Deadline.fromNow(clock, 300), log);
  assert.equal(outcome, undefined);
  assert.ok(log.warnings.some((m) => m.includes('cleanup did not complete')));
});

test('bestEffortCancel rejects a cancel Location with a DUPLICATE api-version and never polls a foreign/ambiguous run (D14, finding #2)', async () => {
  const dup = response(202, {
    Location:
      'https://management.azure.com/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/rg-chaos/providers/Microsoft.Chaos/workspaces/ws-demo/scenarios/scn-demo/runs/22222222-2222-2222-2222-222222222222?api-version=2026-05-01-preview&api-version=2020-01-01',
  });
  const t = new FakeTransport()
    .on('POST', '/cancel', dup)
    // If the ambiguous Location were (wrongly) followed, this route would answer it.
    .on('GET', '/runs/', response(200, {}, { properties: { status: 'Canceled' } }));
  const { c, log, clock } = client(t);
  const outcome = await bestEffortCancel(c, RUN_RESOURCE_ID, Deadline.fromNow(clock, 300), log);
  assert.equal(outcome, undefined);
  assert.equal(t.requestsFor('GET').length, 0, 'an ambiguous-version cancel Location is never polled');
  assert.ok(log.warnings.some((m) => m.includes('cleanup did not complete')));
});

test('CANCEL acceptance-to-first-poll: the cancel acceptance Retry-After is honored BEFORE the first cleanup GET (FR8, finding #1)', async () => {
  const clock = new FakeClock();
  let firstGetAt = -1;
  const t = new FakeTransport((req) => {
    if (req.method === 'GET' && req.url.includes('/runs/') && firstGetAt < 0) firstGetAt = clock.now();
  });
  t.on('POST', '/cancel', fixtureResponses('cancel', 'accept-202.json')); // Retry-After 10
  t.on('GET', '/runs/', fixtureResponses('cancel', 'run-transitions.json'));
  const { c, log } = client(t, clock);

  const startAt = clock.now();
  const outcome = await bestEffortCancel(c, RUN_RESOURCE_ID, Deadline.fromNow(clock, 300), log);
  assert.ok(outcome);
  assert.equal(outcome.status, 'Canceled');
  assert.equal(firstGetAt - startAt, 10000, 'the first cleanup GET waited the full cancel acceptance Retry-After (10s), not 0ms');
});

test('bestEffortCancel bounds the cancel POST by the cleanup deadline — a slow credential is not submitted, and the original reason is preserved (FR10/FR11, finding #2)', async () => {
  const clock = new FakeClock();
  // The cleanup credential exchange itself crosses the 300s cleanup deadline: the
  // cancel POST must NOT be sent, and bestEffortCancel swallows the timeout
  // (returning undefined) so the caller's original reason is authoritative.
  const cred = new FakeCredential(FIXED_TOKEN, () => clock.advance(301000));
  const t = new FakeTransport().on('POST', '/cancel', fixtureResponses('cancel', 'accept-202.json'));
  const log = new FakeLogger();
  const cleanupClient = new ArmHttpClient({
    transport: t,
    clock,
    log,
    cred,
    signal: new AbortController().signal,
    rng: fixedRng(0.5),
  });
  const outcome = await bestEffortCancel(cleanupClient, RUN_RESOURCE_ID, Deadline.fromNow(clock, 300), log);
  assert.equal(outcome, undefined);
  assert.equal(t.requestsFor('POST').length, 0, 'the cancel POST was not submitted past the cleanup deadline');
  assert.ok(log.warnings.some((m) => m.includes('cleanup did not complete')));
});
