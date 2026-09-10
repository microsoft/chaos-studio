import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CoreError } from '../../src/ids.ts';
import {
  ArmHttpClient,
  Deadline,
  DEFAULT_BACKOFF,
  MAX_GET_ATTEMPTS,
  backoffDelayMs,
  headerValue,
  parseRetryAfter,
} from '../../src/http.ts';
import { FakeClock, FakeCredential, FakeLogger, FakeTransport, FIXED_TOKEN, fixedRng, HANG, response } from '../helpers/harness.ts';

function client(transport: FakeTransport, clock = new FakeClock(), rng = fixedRng(0.5)) {
  const log = new FakeLogger();
  const cred = new FakeCredential();
  const signal = new AbortController().signal;
  const c = new ArmHttpClient({ transport, clock, log, cred, signal, rng });
  return { c, log, cred, clock };
}

test('headerValue is case-insensitive', () => {
  const h = { 'Retry-After': '10', LOCATION: 'x', 'x-ms-request-id': 'r' };
  assert.equal(headerValue(h, 'retry-after'), '10');
  assert.equal(headerValue(h, 'Location'), 'x');
  assert.equal(headerValue(h, 'X-MS-Request-Id'), 'r');
  assert.equal(headerValue(h, 'missing'), undefined);
});

test('parseRetryAfter handles delta-seconds, HTTP-date, and absent', () => {
  assert.equal(parseRetryAfter('10', 0), 10);
  assert.equal(parseRetryAfter(undefined, 0), undefined);
  assert.equal(parseRetryAfter('not-a-number', 0), undefined);
  const now = Date.parse('2026-05-01T12:00:00Z');
  assert.equal(parseRetryAfter('Fri, 01 May 2026 12:00:30 GMT', now), 30);
});

test('parseRetryAfter rounds a positive fractional HTTP-date interval UP so a retry never fires early (FR8, finding #1)', () => {
  const httpDate = 'Fri, 01 May 2026 12:00:30 GMT';
  const target = Date.parse(httpDate);
  // 30.4s remaining: Math.round would yield 30 (early by 400ms); ceil yields 31.
  assert.equal(parseRetryAfter(httpDate, target - 30400), 31);
  // 29.6s remaining rounds up to 30 (would already round to 30, but confirms ceil).
  assert.equal(parseRetryAfter(httpDate, target - 29600), 30);
  // A tiny positive remainder (1ms) must still wait a full second, not 0.
  assert.equal(parseRetryAfter(httpDate, target - 1), 1);
  // Exactly on time is 0 (no wait), and a past date clamps to 0.
  assert.equal(parseRetryAfter(httpDate, target), 0);
  assert.equal(parseRetryAfter(httpDate, target + 5000), 0);
});

test('backoffDelayMs applies full jitter and caps at maxMs', () => {
  // rng=0 => zero; rng≈1 => the full capped interval.
  assert.equal(backoffDelayMs(1, DEFAULT_BACKOFF, () => 0), 0);
  assert.equal(backoffDelayMs(1, DEFAULT_BACKOFF, () => 0.999999), 4999);
  // attempt 4 uncapped = 5000*2^3 = 40000; attempt 5 = 80000 -> capped to 60000.
  assert.equal(backoffDelayMs(4, DEFAULT_BACKOFF, () => 1 - 1e-9), 39999);
  assert.equal(backoffDelayMs(5, DEFAULT_BACKOFF, () => 1 - 1e-9), 59999);
});

test('Deadline tracks remaining and expiry against the injected clock', () => {
  const clock = new FakeClock(1000);
  const d = Deadline.fromNow(clock, 30);
  assert.equal(d.remainingMs(), 30000);
  assert.equal(d.expired(), false);
  clock.sleep(29000, new AbortController().signal);
  assert.equal(d.remainingMs(), 1000);
  assert.equal(d.expired(), false);
  clock.sleep(1000, new AbortController().signal);
  assert.equal(d.remainingMs(), 0);
  assert.equal(d.expired(), true);
});

test('get returns a 200 and captures correlation IDs', async () => {
  const t = new FakeTransport().on('GET', '/runs/', response(200, {
    'x-ms-correlation-request-id': 'corr-1',
    'x-ms-request-id': 'req-1',
  }, { properties: { status: 'Succeeded' } }));
  const { c } = client(t);
  const res = await c.get('https://management.azure.com/runs/x?api-version=2026-05-01-preview');
  assert.equal(res.status, 200);
  assert.equal(res.correlationId, 'corr-1');
  assert.equal(c.lastCorrelation.correlationId, 'corr-1');
  assert.deepEqual(res.json, { properties: { status: 'Succeeded' } });
});

test('get sends a Bearer token and registers it for masking', async () => {
  const t = new FakeTransport().on('GET', '/runs/', response(200, {}, { properties: { status: 'Succeeded' } }));
  const { c, log } = client(t);
  await c.get('https://management.azure.com/runs/x');
  assert.equal(t.requests[0]!.headers['Authorization'], `Bearer ${FIXED_TOKEN}`);
  assert.ok(log.masked.includes(FIXED_TOKEN));
});

test('get retries a transient 503 then succeeds, honoring Retry-After for the delay (D13)', async () => {
  const t = new FakeTransport().on('GET', '/runs/', [
    response(503, { 'Retry-After': '7' }, { error: { code: 'ServerBusy' } }),
    response(200, {}, { properties: { status: 'Succeeded' } }),
  ]);
  const { c, clock } = client(t);
  const res = await c.get('https://management.azure.com/runs/x');
  assert.equal(res.status, 200);
  assert.equal(t.requestsFor('GET').length, 2);
  assert.equal(clock.totalSleptMs, 7000, 'slept the server-directed 7s between attempts');
});

test('get retries a 429 within the budget and uses backoff when Retry-After is absent', async () => {
  const t = new FakeTransport().on('GET', '/runs/', [
    response(429, {}, {}),
    response(200, {}, { properties: { status: 'Succeeded' } }),
  ]);
  const { c, clock } = client(t, new FakeClock(), fixedRng(1 - 1e-9));
  const res = await c.get('https://management.azure.com/runs/x');
  assert.equal(res.status, 200);
  // attempt-1 backoff with full jitter ~ initialMs (5000).
  assert.equal(clock.totalSleptMs, 4999);
});

test('get throws transport CoreError after the bounded attempt budget on persistent 5xx (D13)', async () => {
  const t = new FakeTransport().on('GET', '/runs/', response(503, {}, { error: { code: 'ServerBusy' } }));
  const { c } = client(t);
  await assert.rejects(
    () => c.get('https://management.azure.com/runs/x'),
    (e) => e instanceof CoreError && e.category === 'transport' && e.armErrorCode === 'ServerBusy',
  );
  assert.equal(t.requestsFor('GET').length, MAX_GET_ATTEMPTS);
});

test('get: a FINAL retryable response that crosses the deadline throws timeout (not transport) so cancellation is not bypassed (FR10, finding #3)', async () => {
  // Each request "takes" 2s of virtual latency; with a 15s deadline the 8th
  // (last-budgeted) attempt's response arrives at t=16 (past the deadline) while
  // still 503. The post-response deadline check must take precedence over the
  // attempt-limit branch so this is a `timeout`, not a `transport` error.
  const clock = new FakeClock();
  const t = new FakeTransport(() => clock.advance(2000)).on(
    'GET',
    '/runs/',
    response(503, { 'Retry-After': '0' }, { error: { code: 'ServerBusy' } }),
  );
  const { c } = client(t, clock);
  await assert.rejects(
    () => c.get('https://management.azure.com/runs/x', Deadline.fromNow(clock, 15)),
    (e) => e instanceof CoreError && e.category === 'timeout',
  );
  assert.equal(t.requestsFor('GET').length, MAX_GET_ATTEMPTS, 'reached the final budgeted attempt');
});

test('post is single-attempt and never re-POSTs (D14)', async () => {
  const t = new FakeTransport().on('POST', '/execute', [
    response(202, { Location: 'https://management.azure.com/runs/22222222-2222-2222-2222-222222222222' }),
    response(202, { Location: 'https://management.azure.com/runs/other' }),
  ]);
  const { c } = client(t);
  const res = await c.post('https://management.azure.com/x/execute');
  assert.equal(res.status, 202);
  assert.equal(res.location, 'https://management.azure.com/runs/22222222-2222-2222-2222-222222222222');
  assert.equal(t.requestsFor('POST').length, 1, 'exactly one POST issued');
});

test('post maps a transport failure to ambiguous-acceptance (might have reached ARM) (D14)', async () => {
  const t = new FakeTransport().on('POST', '/execute', { error: new Error('ECONNRESET') });
  const { c } = client(t);
  await assert.rejects(
    () => c.post('https://management.azure.com/x/execute'),
    (e) => e instanceof CoreError && e.category === 'ambiguous-acceptance',
  );
});

test('post does not issue the request when the deadline is already expired (in-flight interruption) (FR10, finding #1)', async () => {
  const clock = new FakeClock();
  const deadline = Deadline.fromNow(clock, 10);
  clock.sleep(11000, new AbortController().signal); // consume the whole budget
  const t = new FakeTransport().on('POST', '/execute', response(202, { Location: 'x' }));
  const { c } = client(t, clock);
  await assert.rejects(
    () => c.post('https://management.azure.com/x/execute', undefined, deadline),
    (e) => e instanceof CoreError && e.category === 'timeout',
  );
  assert.equal(t.requestsFor('POST').length, 0, 'no POST issued past an expired deadline');
});

test('assertWithinDeadline throws timeout once the deadline has expired, else is a no-op (FR10, finding #1)', async () => {
  const clock = new FakeClock();
  const deadline = Deadline.fromNow(clock, 10);
  const { c } = client(new FakeTransport(), clock);
  c.assertWithinDeadline(deadline); // not expired → no throw
  c.assertWithinDeadline(undefined); // no deadline → no throw
  clock.sleep(11000, new AbortController().signal);
  assert.throws(() => c.assertWithinDeadline(deadline), (e) => e instanceof CoreError && e.category === 'timeout');
});

test('post does not send when CREDENTIAL ACQUISITION consumes the budget — rechecked immediately before transport.send (FR10, finding #1)', async () => {
  // The deadline is still within budget when post() begins, but getArmToken()
  // itself advances the clock past the 10s deadline (a slow token exchange). The
  // POST must NOT be submitted — a chaos run must never start outside the budget.
  const clock = new FakeClock();
  const deadline = Deadline.fromNow(clock, 10);
  const t = new FakeTransport().on('POST', '/execute', response(202, { Location: 'x' }));
  const log = new FakeLogger();
  const cred = new FakeCredential(FIXED_TOKEN, () => clock.advance(11000)); // auth crosses the deadline
  const c = new ArmHttpClient({ transport: t, clock, log, cred, signal: new AbortController().signal, rng: fixedRng(0.5) });

  await assert.rejects(
    () => c.post('https://management.azure.com/x/execute', undefined, deadline),
    (e) => e instanceof CoreError && e.category === 'timeout',
  );
  assert.equal(cred.calls.length, 1, 'the credential was acquired');
  assert.equal(t.requestsFor('POST').length, 0, 'zero transport sends after authentication crossed the deadline');
});

test('post STILL sends a request submitted within budget whose credential acquisition stays inside the deadline (FR10, finding #1)', async () => {
  // A token exchange that consumes SOME budget but stays within it must not block
  // the send — preserve run-identity handling for in-budget requests.
  const clock = new FakeClock();
  const deadline = Deadline.fromNow(clock, 30);
  const t = new FakeTransport().on('POST', '/execute', response(202, { Location: 'https://management.azure.com/x/runs/y' }));
  const log = new FakeLogger();
  const cred = new FakeCredential(FIXED_TOKEN, () => clock.advance(5000)); // 5s < 30s budget
  const c = new ArmHttpClient({ transport: t, clock, log, cred, signal: new AbortController().signal, rng: fixedRng(0.5) });

  const res = await c.post('https://management.azure.com/x/execute', undefined, deadline);
  assert.equal(res.status, 202);
  assert.equal(t.requestsFor('POST').length, 1, 'the in-budget request is sent');
});

test('get propagates the deadline so a slow CREDENTIAL on a GET times out with zero sends (FR10, finding #2)', async () => {
  const clock = new FakeClock();
  const deadline = Deadline.fromNow(clock, 30);
  const t = new FakeTransport().on('GET', '/runs/', response(200, {}, { properties: { status: 'Succeeded' } }));
  const log = new FakeLogger();
  const cred = new FakeCredential(FIXED_TOKEN, () => clock.advance(31000)); // auth crosses the budget
  const c = new ArmHttpClient({ transport: t, clock, log, cred, signal: new AbortController().signal, rng: fixedRng(0.5) });

  await assert.rejects(
    () => c.get('https://management.azure.com/x/runs/y', deadline),
    (e) => e instanceof CoreError && e.category === 'timeout',
  );
  assert.equal(t.requestsFor('GET').length, 0, 'the GET was not sent after credential acquisition exhausted the budget');
});

test('get aborts a PENDING in-flight request when the deadline elapses, via a deterministic cancellable watcher (FR10, finding #2)', async () => {
  // The transport hangs (resolves never; rejects only on abort). With a 30s
  // deadline the client must fire its watcher, ABORT the transport signal, and
  // surface a timeout — not remain pending forever with an un-aborted signal.
  const clock = new FakeClock();
  const t = new FakeTransport().on('GET', '/runs/', HANG);
  const { c } = client(t, clock);
  const startAt = clock.now();
  await assert.rejects(
    () => c.get('https://management.azure.com/x/runs/y', Deadline.fromNow(clock, 30)),
    (e) => e instanceof CoreError && e.category === 'timeout',
  );
  assert.equal(t.requestsFor('GET').length, 1, 'the request was attempted');
  assert.equal(clock.now() - startAt, 30000, 'the watcher advanced virtual time to exactly the deadline before aborting');
});

test('a request WITHOUT a deadline is never subjected to the watcher (no clock advance, no abort)', async () => {
  const clock = new FakeClock();
  const t = new FakeTransport().on('GET', '/runs/', response(200, {}, { properties: { status: 'Succeeded' } }));
  const { c } = client(t, clock);
  const res = await c.getOnce('https://management.azure.com/x/runs/y');
  assert.equal(res.status, 200);
  assert.equal(clock.totalSleptMs, 0, 'no watcher sleep for a deadline-less request');
});

test('poll advances 202 -> 202 -> 200 and returns the terminal value, sleeping Retry-After each poll', async () => {
  const t = new FakeTransport().on('GET', '/runs/', [
    response(202, { 'Retry-After': '10' }, { properties: { status: 'Running' } }),
    response(202, { 'Retry-After': '10' }, { properties: { status: 'CleaningUp' } }),
    response(200, {}, { properties: { status: 'Succeeded' } }),
  ]);
  const { c, clock } = client(t);
  const deadline = Deadline.fromNow(clock, 2700);
  const status = await c.poll('https://management.azure.com/runs/x', deadline, (res) => {
    const s = (res.json as { properties?: { status?: string } }).properties?.status;
    const terminal = s === 'Succeeded';
    return { done: terminal, value: s };
  });
  assert.equal(status, 'Succeeded');
  assert.equal(t.requestsFor('GET').length, 3);
  assert.equal(clock.totalSleptMs, 20000, 'two 10s Retry-After sleeps before the terminal poll');
});

test('poll honoring an HTTP-date Retry-After with a sub-second offset does not retry before the specified date (FR8, finding #1)', async () => {
  // Clock starts 600ms past a second boundary; the Retry-After HTTP-date is 31s
  // after that boundary, so the true remaining interval is 30.4s. The poll must
  // wait a FULL 31s (ceil), landing at/after the HTTP date — never 30s (which
  // would retry 400ms early). HTTP-date has 1s resolution, so the header encodes
  // the whole-second boundary date.
  const boundaryMs = 1_700_000_000_000; // exact second boundary
  const startMs = boundaryMs + 600; // 600ms past the boundary
  const httpDate = new Date(boundaryMs + 31_000).toUTCString(); // 31s after the boundary
  const targetMs = Date.parse(httpDate);

  const clock = new FakeClock(startMs);
  const t = new FakeTransport().on('GET', '/runs/', [
    response(202, { 'Retry-After': httpDate }, { properties: { status: 'Running' } }),
    response(200, {}, { properties: { status: 'Succeeded' } }),
  ]);
  const { c } = client(t, clock);
  const status = await c.poll('https://management.azure.com/runs/x', Deadline.fromNow(clock, 2700), (res) => {
    const s = (res.json as { properties?: { status?: string } }).properties?.status;
    return { done: s === 'Succeeded', value: s };
  });
  assert.equal(status, 'Succeeded');
  assert.equal(clock.totalSleptMs, 31000, 'waited the ceil of the 30.4s HTTP-date interval, not 30s');
  assert.ok(clock.now() >= targetMs, 'the retry did not occur before the server-directed HTTP date');
});

test('poll throws a timeout CoreError when the deadline elapses before terminal (FR10)', async () => {
  const t = new FakeTransport().on('GET', '/runs/', response(202, { 'Retry-After': '10' }, { properties: { status: 'Running' } }));
  const { c, clock } = client(t);
  const deadline = Deadline.fromNow(clock, 25);
  await assert.rejects(
    () => c.poll('https://management.azure.com/runs/x', deadline, (res) => {
      const s = (res.json as { properties?: { status?: string } }).properties?.status;
      return { done: s === 'Succeeded', value: s };
    }),
    (e) => e instanceof CoreError && e.category === 'timeout',
  );
});

test('poll fails fast on a non-2xx GET (401) instead of polling to the deadline (D13)', async () => {
  const t = new FakeTransport().on('GET', '/runs/', response(401, { 'x-ms-error-code': 'ExpiredToken' }, { error: { code: 'ExpiredToken' } }));
  const { c, clock } = client(t);
  await assert.rejects(
    () => c.poll('https://management.azure.com/runs/x', Deadline.fromNow(clock, 2700), () => ({ done: false })),
    (e) => e instanceof CoreError && e.category === 'auth' && e.armErrorCode === 'ExpiredToken',
  );
  assert.equal(t.requestsFor('GET').length, 1, 'a 401 is not retried and does not poll-forever');
});

test('get bounds a transient-retry Retry-After by the remaining deadline instead of overrunning it (FR8/FR10)', async () => {
  // A 503 with Retry-After 100s under a 25s deadline must NOT sleep 100s then
  // return Succeeded — it must fail with a timeout without overrunning the budget.
  const t = new FakeTransport().on('GET', '/runs/', [
    response(503, { 'Retry-After': '100' }, { error: { code: 'ServerBusy' } }),
    response(200, {}, { properties: { status: 'Succeeded' } }),
  ]);
  const { c, clock } = client(t);
  await assert.rejects(
    () => c.get('https://management.azure.com/runs/x', Deadline.fromNow(clock, 25)),
    (e) => e instanceof CoreError && e.category === 'timeout',
  );
  assert.equal(clock.totalSleptMs, 0, 'did not sleep the unaffordable 100s Retry-After');
  assert.equal(t.requestsFor('GET').length, 1, 'no second attempt past the deadline');
});

test('poll propagates the deadline into GET retries so a transient overrun times out (completion + cleanup) (FR8/FR10)', async () => {
  const t = new FakeTransport().on('GET', '/runs/', [
    response(503, { 'Retry-After': '600' }, { error: { code: 'ServerBusy' } }),
    response(200, {}, { properties: { status: 'Succeeded' } }),
  ]);
  const { c, clock } = client(t);
  // A 300s cleanup deadline must not be defeated by a 600s Retry-After on a GET retry.
  await assert.rejects(
    () => c.poll('https://management.azure.com/runs/x', Deadline.fromNow(clock, 300), (res) => {
      const s = (res.json as { properties?: { status?: string } }).properties?.status;
      return { done: s === 'Succeeded', value: s };
    }),
    (e) => e instanceof CoreError && e.category === 'timeout',
  );
  assert.ok(clock.totalSleptMs <= 300000, 'never sleeps beyond the cleanup budget');
});

test('the client refuses to send a credential to a non-ARM URL (no token acquired, no request sent)', async () => {
  const t = new FakeTransport().on('GET', /.*/, response(200, {}, { properties: { status: 'Succeeded' } }));
  const log = new FakeLogger();
  const cred = new FakeCredential();
  const c = new ArmHttpClient({ transport: t, clock: new FakeClock(), log, cred, signal: new AbortController().signal, rng: fixedRng(0.5) });
  await assert.rejects(
    () => c.get('https://evil.example.com/subscriptions/x/runs/y'),
    (e) => e instanceof CoreError && e.category === 'transport',
  );
  assert.equal(t.requests.length, 0, 'no request was sent to the foreign origin');
  assert.equal(cred.calls.length, 0, 'no token was acquired for a foreign origin');
});
