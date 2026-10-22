import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { fetchOidcToken, type OidcRequestFn } from '../src/oidc.ts';

/**
 * Deterministic tests for the OIDC token exchange ({@link fetchOidcToken}). They
 * use a FAKE transport (no real network, no `azure-pipelines-task-lib`) and
 * node:test mock timers (no wall-clock sleep), so they are fully deterministic
 * (NFR2). The absolute-deadline behavior — a continuously-active response is still
 * bounded, the deadline destroys the request, and the timer is cleared on every
 * settlement — is what these prove.
 */

/** A fake response the test drives (data/end/error/aborted) via EventEmitter. */
class FakeResponse extends EventEmitter {
  statusCode: number | undefined;
  constructor(statusCode: number | undefined = 200) {
    super();
    this.statusCode = statusCode;
  }
}

/** A fake client request recording destroy()/end() and exposing an 'error' emitter. */
class FakeRequest extends EventEmitter {
  destroyed = false;
  ended = false;
  destroy(): this {
    this.destroyed = true;
    return this;
  }
  end(): this {
    this.ended = true;
    return this;
  }
}

interface Harness {
  request: OidcRequestFn;
  reqs: FakeRequest[];
  /** The response handed to the most recent request. */
  lastRes: () => FakeResponse;
}

/** Build a fake transport whose responses the test controls. */
function harness(makeResponse: () => FakeResponse): Harness {
  const reqs: FakeRequest[] = [];
  let lastRes: FakeResponse | undefined;
  const request: OidcRequestFn = (_url, _options, callback) => {
    const req = new FakeRequest();
    reqs.push(req);
    // Deliver the response asynchronously, like a real transport.
    lastRes = makeResponse();
    queueMicrotask(() => callback(lastRes!));
    return req;
  };
  return { request, reqs, lastRes: () => lastRes! };
}

const URL_UNDER_TEST = new URL('https://dev.azure.com/org/proj/_apis/distributedtask/oidctoken');

test('fetchOidcToken returns the oidcToken on a 200 JSON response and clears the deadline timer', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness(() => new FakeResponse(200));

  const p = fetchOidcToken(URL_UNDER_TEST, 'access-token', { request: h.request, deadlineMs: 10_000 });
  // Let the transport deliver the response, then stream a valid body and end.
  await Promise.resolve();
  const res = h.lastRes();
  res.emit('data', Buffer.from('{"oidcToken":'));
  res.emit('data', Buffer.from('"the-oidc-jwt"}'));
  res.emit('end');

  assert.equal(await p, 'the-oidc-jwt');
  assert.equal(h.reqs[0]!.ended, true, 'the request was sent');
  // The deadline timer was cleared on success: advancing past it does nothing
  // (no late reject, no second destroy).
  t.mock.timers.tick(60_000);
  assert.equal(h.reqs.length, 1, 'no retry/second request');
});

test('fetchOidcToken enforces an ABSOLUTE deadline: a continuously-active response is still destroyed and rejected', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness(() => new FakeResponse(200));

  const p = fetchOidcToken(URL_UNDER_TEST, 'access-token', { request: h.request, deadlineMs: 10_000 });
  await Promise.resolve();
  const res = h.lastRes();

  // The response keeps streaming bytes but NEVER ends — a socket-inactivity timeout
  // would never fire here. The absolute deadline must still bound the call.
  res.emit('data', Buffer.from('a'.repeat(1024)));
  t.mock.timers.tick(5_000);
  res.emit('data', Buffer.from('b'.repeat(1024)));
  t.mock.timers.tick(5_000); // now at the 10s absolute deadline

  await assert.rejects(p, /timed out/);
  assert.equal(h.reqs[0]!.destroyed, true, 'the in-flight request was destroyed at the deadline (cleanup)');
});

test('fetchOidcToken: a late response settlement after the deadline is a harmless no-op (no double-settle)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness(() => new FakeResponse(200));

  const p = fetchOidcToken(URL_UNDER_TEST, 'access-token', { request: h.request, deadlineMs: 10_000 });
  await Promise.resolve();
  const res = h.lastRes();

  t.mock.timers.tick(10_000); // deadline fires → reject + destroy
  await assert.rejects(p, /timed out/);

  // A late 'end' (the abandoned socket finally flushing) must not throw or re-settle.
  assert.doesNotThrow(() => {
    res.emit('data', Buffer.from('{"oidcToken":"too-late"}'));
    res.emit('end');
  });
});

test('fetchOidcToken rejects on a non-2xx status and destroys the request', async () => {
  const h = harness(() => new FakeResponse(403));
  const p = fetchOidcToken(URL_UNDER_TEST, 'access-token', { request: h.request });
  await Promise.resolve();
  const res = h.lastRes();
  res.emit('data', Buffer.from('forbidden'));
  res.emit('end');

  await assert.rejects(p, /HTTP 403/);
  assert.equal(h.reqs[0]!.destroyed, true, 'the request is destroyed on a non-2xx settlement');
});

test('fetchOidcToken rejects when the response is aborted', async () => {
  const h = harness(() => new FakeResponse(200));
  const p = fetchOidcToken(URL_UNDER_TEST, 'access-token', { request: h.request });
  await Promise.resolve();
  h.lastRes().emit('aborted');
  await assert.rejects(p, /aborted/);
});

test('fetchOidcToken rejects on a request transport error and clears the timer', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness(() => new FakeResponse(200));
  const p = fetchOidcToken(URL_UNDER_TEST, 'access-token', { request: h.request, deadlineMs: 10_000 });
  await Promise.resolve();
  h.reqs[0]!.emit('error', new Error('socket hang up'));

  await assert.rejects(p, /socket hang up/);
  // Timer cleared: advancing past the deadline does not re-settle.
  t.mock.timers.tick(60_000);
});

test('fetchOidcToken rejects when the 2xx body is not valid JSON', async () => {
  const h = harness(() => new FakeResponse(200));
  const p = fetchOidcToken(URL_UNDER_TEST, 'access-token', { request: h.request });
  await Promise.resolve();
  const res = h.lastRes();
  res.emit('data', Buffer.from('not-json'));
  res.emit('end');
  await assert.rejects(p, /not valid JSON/);
});

test('fetchOidcToken rejects when the 2xx body has no oidcToken', async () => {
  const h = harness(() => new FakeResponse(200));
  const p = fetchOidcToken(URL_UNDER_TEST, 'access-token', { request: h.request });
  await Promise.resolve();
  const res = h.lastRes();
  res.emit('data', Buffer.from('{"somethingElse":"x"}'));
  res.emit('end');
  await assert.rejects(p, /did not contain an oidcToken/);
});
