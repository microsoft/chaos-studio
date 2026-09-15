import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { ICredentialProvider } from '../../src/contract.ts';
import { CoreError } from '../../src/ids.ts';
import {
  ArmHttpClient,
  Deadline,
  DEFAULT_BACKOFF,
  MAX_GET_ATTEMPTS,
  backoffDelayMs,
  bodyErrorMessage,
  formatProtocolObservation,
  headerValue,
  parseRetryAfter,
  raiseForAcceptance,
  raiseForActionStatus,
  type ParsedResponse,
  type ProtocolObservation,
} from '../../src/http.ts';
import { FakeClock, FakeCredential, FailingCredential, FakeLogger, FakeTransport, FIXED_TOKEN, fixedRng, HANG, response } from '../helpers/harness.ts';

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

// R4: a credential-provider failure (missing login, failed WIF token exchange,
// invalid/expired federated assertion) must normalize as an AUTH failure, never
// a raw exception that a caller's generic error mapping would default to
// `transport` — and the request must never reach the transport at all.
test('post: a failing credential provider raises an auth CoreError and never reaches the transport (R4)', async () => {
  const clock = new FakeClock();
  const t = new FakeTransport().on('POST', '/execute', response(202, { Location: 'x' }));
  const log = new FakeLogger();
  const cred = new FailingCredential(new Error('AADSTS700016: no matching federated credential'));
  const c = new ArmHttpClient({ transport: t, clock, log, cred, signal: new AbortController().signal, rng: fixedRng(0.5) });

  await assert.rejects(
    () => c.post('https://management.azure.com/x/execute', undefined, undefined),
    (e) => e instanceof CoreError && e.category === 'auth' && /AADSTS700016/.test(e.message),
  );
  assert.equal(cred.calls.length, 1, 'the credential acquisition was attempted');
  assert.equal(t.requestsFor('POST').length, 0, 'no request is sent when credential acquisition fails');
});

test('get: a failing credential provider raises an auth CoreError and never reaches the transport (R4)', async () => {
  const clock = new FakeClock();
  const t = new FakeTransport().on('GET', '/runs/', response(200, {}, { properties: { status: 'Succeeded' } }));
  const log = new FakeLogger();
  const cred = new FailingCredential(new Error('token exchange failed: invalid client assertion'));
  const c = new ArmHttpClient({ transport: t, clock, log, cred, signal: new AbortController().signal, rng: fixedRng(0.5) });

  await assert.rejects(
    () => c.get('https://management.azure.com/x/runs/y', undefined),
    (e) => e instanceof CoreError && e.category === 'auth',
  );
  assert.equal(t.requestsFor('GET').length, 0, 'no request is sent when credential acquisition fails');
});

test('a credential failure that races the deadline still surfaces `timeout`, not `auth` (deadline precedence preserved, R4)', async () => {
  // The credential rejects only once its signal aborts (deadline-triggered),
  // mirroring PendingCredential's abort-aware shape but rejecting with a
  // generic (non-Abort) error to prove the deadline race — not the raw
  // rejection shape — decides the category.
  const clock = new FakeClock();
  const deadline = Deadline.fromNow(clock, 10);
  const t = new FakeTransport().on('GET', '/runs/', response(200, {}, { properties: { status: 'Succeeded' } }));
  const log = new FakeLogger();
  const cred: ICredentialProvider = {
    getArmToken: (_scope, signal) =>
      new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('credential exchange aborted mid-flight')), { once: true });
      }),
  };
  const c = new ArmHttpClient({ transport: t, clock, log, cred, signal: new AbortController().signal, rng: fixedRng(0.5) });
  clock.advance(11000); // the credential promise settles once its signal is aborted by the deadline watcher

  await assert.rejects(
    () => c.get('https://management.azure.com/x/runs/y', deadline),
    (e) => e instanceof CoreError && e.category === 'timeout',
  );
  assert.equal(t.requestsFor('GET').length, 0);
});

test('a credential failure while the caller signal is already aborted (cancellation) surfaces `transport`, preserving prior precedence, not `auth` (R4)', async () => {
  const clock = new FakeClock();
  const t = new FakeTransport().on('GET', '/runs/', response(200, {}, { properties: { status: 'Succeeded' } }));
  const log = new FakeLogger();
  const controller = new AbortController();
  controller.abort();
  const cred = new FailingCredential(new Error('should not matter — signal is already aborted'));
  const c = new ArmHttpClient({ transport: t, clock, log, cred, signal: controller.signal, rng: fixedRng(0.5) });

  await assert.rejects(
    () => c.get('https://management.azure.com/x/runs/y', undefined),
    (e) => e instanceof CoreError && e.category === 'transport',
  );
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
});

// ---------------------------------------------------------------------------
// R5: ARM error.message / nested error.details preservation alongside error.code.
// ---------------------------------------------------------------------------

test('bodyErrorMessage reads error.message and flattens nested error.details[].message, bounded and de-duplicated (R5, FR12)', () => {
  assert.equal(bodyErrorMessage(undefined), undefined);
  assert.equal(bodyErrorMessage({}), undefined);
  assert.equal(bodyErrorMessage({ error: {} }), undefined);
  assert.equal(bodyErrorMessage({ error: { message: 'top-level detail' } }), 'top-level detail');
  assert.equal(
    bodyErrorMessage({
      error: {
        message: 'outer failure',
        details: [{ message: 'inner cause A' }, { message: 'inner cause B', details: [{ message: 'deepest cause' }] }],
      },
    }),
    'outer failure | inner cause A | inner cause B | deepest cause',
  );
  // Duplicate messages across levels are not repeated.
  assert.equal(
    bodyErrorMessage({ error: { message: 'same', details: [{ message: 'same' }] } }),
    'same',
  );
  // Non-string / empty messages are ignored, not surfaced as '[object Object]' or ''.
  assert.equal(bodyErrorMessage({ error: { message: 123, details: [{ message: '' }, { message: null }] } }), undefined);
  // A pathological long/deep body is bounded, never crashes, and does not grow unbounded.
  const deep = { message: 'deep' } as { message: string; details?: unknown[] };
  let node: { message: string; details?: unknown[] } = deep;
  for (let i = 0; i < 20; i++) {
    const next = { message: `level-${i}` };
    node.details = [next];
    node = next;
  }
  const flattened = bodyErrorMessage({ error: deep });
  assert.ok(flattened !== undefined && flattened.length <= 2001, 'recursion depth is bounded');
  const long = { error: { message: 'x'.repeat(5000) } };
  const boundedMsg = bodyErrorMessage(long);
  assert.ok(boundedMsg !== undefined && boundedMsg.length <= 2001, 'overlong ARM messages are truncated, not dropped');
});

test('raiseForActionStatus preserves armErrorCode AND armErrorMessage (incl. nested details) on a non-2xx action response (R5, FR12)', () => {
  const res: ParsedResponse = {
    status: 401,
    headers: {},
    json: {
      error: {
        code: 'AuthenticationFailed',
        message: 'The access token has expired.',
        details: [{ code: 'TokenExpired', message: 'Token expired at 2026-05-01T00:00:00Z.' }],
      },
    },
    location: undefined,
    retryAfterSeconds: undefined,
    correlationId: 'corr-1',
    requestId: 'req-1',
    errorCode: 'AuthenticationFailed',
    errorMessage: 'The access token has expired. | Token expired at 2026-05-01T00:00:00Z.',
  };
  assert.throws(
    () => raiseForActionStatus(res, 'validate'),
    (e: unknown) =>
      e instanceof CoreError &&
      e.category === 'auth' &&
      e.armErrorCode === 'AuthenticationFailed' &&
      e.armErrorMessage === 'The access token has expired. | Token expired at 2026-05-01T00:00:00Z.' &&
      e.correlationId === 'corr-1' &&
      e.requestId === 'req-1',
  );
});

// R4: initiating-action acceptance (validate/execute/cancel) must be EXACTLY
// 202 — an off-contract 200/201 (even one carrying an otherwise-valid
// Location) is not a legitimate acceptance under the pinned LRO protocol.
function acceptanceResponse(status: number): ParsedResponse {
  return {
    status,
    headers: {},
    json: undefined,
    location: '/subscriptions/s/resourceGroups/rg/providers/Microsoft.Chaos/.../runs/22222222-2222-2222-2222-222222222222',
    retryAfterSeconds: 10,
    correlationId: 'corr-2',
    requestId: 'req-2',
    errorCode: undefined,
    errorMessage: undefined,
  };
}

test('raiseForAcceptance accepts EXACTLY 202 and rejects every other status, including an off-contract 200/201 with a valid Location', () => {
  assert.doesNotThrow(() => raiseForAcceptance(acceptanceResponse(202), 'execute'));

  for (const status of [200, 201, 204]) {
    assert.throws(
      () => raiseForAcceptance(acceptanceResponse(status), 'execute'),
      (e: unknown) => e instanceof CoreError && e.category === 'transport' && e.message.includes('202'),
      `status ${status} with an otherwise-valid Location must still be rejected`,
    );
  }
});

test('raiseForAcceptance maps 401/403 to auth and everything else (including other 2xx) to transport, preserving ARM/correlation context', () => {
  const authRes: ParsedResponse = { ...acceptanceResponse(403), errorCode: 'Forbidden', errorMessage: 'not allowed' };
  assert.throws(
    () => raiseForAcceptance(authRes, 'cancel'),
    (e: unknown) =>
      e instanceof CoreError &&
      e.category === 'auth' &&
      e.armErrorCode === 'Forbidden' &&
      e.armErrorMessage === 'not allowed' &&
      e.correlationId === 'corr-2' &&
      e.requestId === 'req-2',
  );

  const transportRes = acceptanceResponse(200);
  assert.throws(
    () => raiseForAcceptance(transportRes, 'validate'),
    (e: unknown) => e instanceof CoreError && e.category === 'transport',
  );
});

test('raiseForAcceptance never re-POSTs: it only classifies the single response already received', () => {
  // The function takes no transport/retry dependency at all — a call is a pure
  // classification of the given response (D14's no-POST-retry policy is upheld
  // structurally, not just by convention).
  let calls = 0;
  const classify = (): void => {
    calls++;
    raiseForAcceptance(acceptanceResponse(200), 'execute');
  };
  assert.throws(classify);
  assert.equal(calls, 1);
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

// ---------------------------------------------------------------------------
// RV1 evidence-capture hook (E6/R1): `onObservation` reports every parsed
// response as a redacted, shape-bound ProtocolObservation. These tests use
// injected responses to prove the capture path itself — independent of any
// live environment — addressing the reviewer's stated R1 test gap.
// ---------------------------------------------------------------------------

test('onObservation reports one ProtocolObservation per parsed response, matching what raiseForAcceptance/poll actually saw (R1)', async () => {
  const t = new FakeTransport()
    .on('POST', '/execute', response(202, { Location: 'https://management.azure.com/runs/poll', 'Retry-After': '5' }))
    .on('GET', '/runs/poll', response(200, { 'x-ms-correlation-request-id': 'corr-1', 'x-ms-request-id': 'req-1' }, { properties: { status: 'Succeeded' } }));
  const observations: ProtocolObservation[] = [];
  const log = new FakeLogger();
  const cred = new FakeCredential();
  const c = new ArmHttpClient({
    transport: t,
    clock: new FakeClock(),
    log,
    cred,
    signal: new AbortController().signal,
    rng: fixedRng(0.5),
    onObservation: (obs) => observations.push(obs),
  });
  const post = await c.post('https://management.azure.com/execute');
  raiseForAcceptance(post, 'execute');
  const get = await c.getOnce('https://management.azure.com/runs/poll');
  raiseForActionStatus(get, 'get');

  assert.equal(observations.length, 2, 'one observation per independently exercised operation');
  assert.equal(observations[0]!.method, 'POST');
  assert.equal(observations[0]!.status, 202);
  assert.equal(observations[0]!.location, 'https://management.azure.com/runs/poll');
  assert.equal(observations[0]!.retryAfterSeconds, 5);
  assert.equal(observations[1]!.method, 'GET');
  assert.equal(observations[1]!.status, 200);
  assert.equal(observations[1]!.correlationId, 'corr-1');
  assert.equal(observations[1]!.requestId, 'req-1');
});

test('onObservation is not required — omitting it changes nothing about the client behavior (opt-in only)', async () => {
  const t = new FakeTransport().on('GET', '/runs/', response(200, {}, { properties: { status: 'Succeeded' } }));
  const { c } = client(t);
  const res = await c.getOnce('https://management.azure.com/runs/x');
  assert.equal(res.status, 200);
});

test('onObservation.errorMessage is redacted even when the ARM error body carries secret-shaped text (R1 + R2)', async () => {
  const t = new FakeTransport().on(
    'GET',
    '/runs/',
    response(403, { 'x-ms-error-code': 'AuthorizationFailed' }, {
      error: { code: 'AuthorizationFailed', message: 'denied for password=hunter2 clientSecret=abcd' },
    }),
  );
  const observations: ProtocolObservation[] = [];
  const log = new FakeLogger();
  const cred = new FakeCredential();
  const c = new ArmHttpClient({
    transport: t,
    clock: new FakeClock(),
    log,
    cred,
    signal: new AbortController().signal,
    rng: fixedRng(0.5),
    onObservation: (obs) => observations.push(obs),
  });
  await c.getOnce('https://management.azure.com/runs/x');
  assert.equal(observations.length, 1);
  assert.ok(!observations[0]!.errorMessage!.includes('hunter2'));
  assert.ok(!observations[0]!.errorMessage!.includes('abcd'));
});

test('formatProtocolObservation emits a single greppable RV-OBSERVATION JSON line with redacted errorMessage', () => {
  const obs: ProtocolObservation = {
    method: 'POST',
    url: 'https://management.azure.com/execute',
    status: 202,
    location: 'https://management.azure.com/runs/x',
    retryAfterSeconds: 5,
    correlationId: 'corr-1',
    requestId: 'req-1',
    errorCode: undefined,
    errorMessage: 'password=hunter2',
    businessState: undefined,
    startTime: undefined,
    endTime: undefined,
    statusField: undefined,
    startTimeField: undefined,
    endTimeField: undefined,
    errorChannelsPresent: [],
  };
  const line = formatProtocolObservation(obs);
  assert.ok(line.startsWith('RV-OBSERVATION '));
  const parsed = JSON.parse(line.slice('RV-OBSERVATION '.length)) as ProtocolObservation;
  assert.equal(parsed.method, 'POST');
  assert.equal(parsed.status, 202);
  assert.ok(!line.includes('hunter2'));
});

test('across four independently-exercised operations, onObservation records all four — proving a per-operation matrix is observable (RV2 shape)', async () => {
  const t = new FakeTransport()
    .on('POST', '/validate', response(202, { Location: 'https://management.azure.com/validations/latest' }))
    .on('GET', '/validations/latest', response(200, {}, { properties: { status: 'Succeeded' } }))
    .on('POST', '/execute', response(202, { Location: 'https://management.azure.com/runs/x' }))
    .on('POST', '/runs/x/cancel', response(202, { Location: 'https://management.azure.com/runs/x' }));
  const observations: ProtocolObservation[] = [];
  const log = new FakeLogger();
  const cred = new FakeCredential();
  const c = new ArmHttpClient({
    transport: t,
    clock: new FakeClock(),
    log,
    cred,
    signal: new AbortController().signal,
    rng: fixedRng(0.5),
    onObservation: (obs) => observations.push(obs),
  });
  await c.post('https://management.azure.com/validate');
  await c.getOnce('https://management.azure.com/validations/latest');
  await c.post('https://management.azure.com/execute');
  await c.post('https://management.azure.com/runs/x/cancel');

  const urls = observations.map((o) => o.url);
  assert.deepEqual(urls, [
    'https://management.azure.com/validate',
    'https://management.azure.com/validations/latest',
    'https://management.azure.com/execute',
    'https://management.azure.com/runs/x/cancel',
  ]);
});

test('onObservation reports the observed properties.status/startTime/endTime business VALUES and field NAMES, not asserted contract constants (R2 review)', async () => {
  const t = new FakeTransport().on(
    'GET',
    '/runs/x',
    response(200, {}, {
      properties: {
        status: 'Succeeded',
        startTime: '2026-01-01T00:00:00Z',
        endTime: '2026-01-01T00:05:00Z',
        errors: [],
        executionErrors: [],
      },
    }),
  );
  const observations: ProtocolObservation[] = [];
  const observingClient = new ArmHttpClient({
    transport: t,
    clock: new FakeClock(),
    log: new FakeLogger(),
    cred: new FakeCredential(),
    signal: new AbortController().signal,
    rng: fixedRng(0.5),
    onObservation: (obs) => observations.push(obs),
  });
  await observingClient.getOnce('https://management.azure.com/runs/x');

  assert.equal(observations.length, 1);
  const obs = observations[0]!;
  assert.equal(obs.businessState, 'Succeeded');
  assert.equal(obs.startTime, '2026-01-01T00:00:00Z');
  assert.equal(obs.endTime, '2026-01-01T00:05:00Z');
  assert.equal(obs.statusField, 'status');
  assert.equal(obs.startTimeField, 'startTime');
  assert.equal(obs.endTimeField, 'endTime');
  assert.deepEqual([...obs.errorChannelsPresent].sort(), ['errors', 'executionErrors']);
});

test('onObservation reports absent wire-shape fields as undefined/empty when the deployed body uses a different shape (R2 review — a real drift is visible, not masked)', async () => {
  // Simulates a service that regressed to the stale `state` field instead of `status`.
  const t = new FakeTransport().on('GET', '/runs/x', response(200, {}, { properties: { state: 'Succeeded' } }));
  const observations: ProtocolObservation[] = [];
  const observingClient = new ArmHttpClient({
    transport: t,
    clock: new FakeClock(),
    log: new FakeLogger(),
    cred: new FakeCredential(),
    signal: new AbortController().signal,
    rng: fixedRng(0.5),
    onObservation: (obs) => observations.push(obs),
  });
  await observingClient.getOnce('https://management.azure.com/runs/x');

  const obs = observations[0]!;
  assert.equal(obs.businessState, undefined);
  assert.equal(obs.statusField, undefined);
  assert.equal(obs.startTimeField, undefined);
  assert.equal(obs.endTimeField, undefined);
  assert.deepEqual(obs.errorChannelsPresent, []);
});

test('onObservation reports an empty wire-shape snapshot for a response with no properties object (e.g. an acceptance 202 with no body)', async () => {
  const t = new FakeTransport().on('POST', '/execute', response(202, { Location: 'https://management.azure.com/runs/x' }));
  const observations: ProtocolObservation[] = [];
  const observingClient = new ArmHttpClient({
    transport: t,
    clock: new FakeClock(),
    log: new FakeLogger(),
    cred: new FakeCredential(),
    signal: new AbortController().signal,
    rng: fixedRng(0.5),
    onObservation: (obs) => observations.push(obs),
  });
  await observingClient.post('https://management.azure.com/execute');

  const obs = observations[0]!;
  assert.equal(obs.businessState, undefined);
  assert.equal(obs.startTime, undefined);
  assert.equal(obs.endTime, undefined);
  assert.deepEqual(obs.errorChannelsPresent, []);
});
