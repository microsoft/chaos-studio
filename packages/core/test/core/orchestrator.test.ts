import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { RunContext } from '../../src/contract.ts';
import { orchestrate, toNormalizedError } from '../../src/orchestrator.ts';
import { CoreError } from '../../src/ids.ts';
import {
  FakeClock,
  FakeCredential,
  FakeInputReader,
  FakeLogger,
  FakeOutputSetter,
  FakeTransport,
  FIXED_TOKEN,
  fixedRng,
  fixtureResponses,
  HANG,
  PendingCredential,
  response,
} from '../helpers/harness.ts';

const BASE_IDS = {
  'subscription-id': '11111111-1111-1111-1111-111111111111',
  'resource-group': 'rg-chaos',
  'workspace-name': 'ws-demo',
  'scenario-name': 'scn-demo',
  'scenario-configuration-name': 'cfg-demo',
};

function ctx(
  inputs: Record<string, string | undefined>,
  options: { clock?: FakeClock; signal?: AbortSignal; cred?: FakeCredential | PendingCredential } = {},
): { io: RunContext; out: FakeOutputSetter; log: FakeLogger; clock: FakeClock } {
  const clock = options.clock ?? new FakeClock();
  const out = new FakeOutputSetter();
  const log = new FakeLogger();
  const io: RunContext = {
    input: new FakeInputReader(inputs),
    output: out,
    log,
    cred: options.cred ?? new FakeCredential(),
    clock,
    signal: options.signal ?? new AbortController().signal,
  };
  return { io, out, log, clock };
}

const OPTS = { rng: fixedRng(0.5) };

// Route builders reused across scenarios.
const validateAccept = () => fixtureResponses('validate', 'accept-202.json');
const validationSucceeded = () => fixtureResponses('validate', 'validation-succeeded-200.json');
const validationRequiresAttention = () => fixtureResponses('validate', 'validation-requires-attention-200.json');
const executeAccept = () => fixtureResponses('execute', 'accept-202.json');
const runSucceeded = () => fixtureResponses('execute', 'run-transitions.json');
const runFailed = () => fixtureResponses('execute', 'run-failed-200.json');

// ---------------------------------------------------------------------------
// Output-by-mode / wait matrix (D11) and result mapping (D12).
// ---------------------------------------------------------------------------

test('validate-only success: only validation-state + correlation are set (D11, D12)', async () => {
  const t = new FakeTransport()
    .on('POST', '/validate', validateAccept())
    .on('GET', '/validations/latest', validationSucceeded());
  const { io, out } = ctx({ ...BASE_IDS, mode: 'validate-only' });
  const result = await orchestrate(io, t, OPTS);

  assert.equal(result.success, true);
  assert.equal(out.values['validation-state'], 'Succeeded');
  assert.ok(out.values['correlation-id'] && out.values['request-id']);
  assert.equal(out.values['run-id'], undefined, 'no run outputs in validate-only');
  assert.equal(out.values['run-state'], undefined);
  assert.equal(t.requestsFor('POST').filter((r) => r.url.includes('/execute')).length, 0, 'execute never attempted');
});

test('validate-only failure: RequiresAttention fails the step (D12)', async () => {
  const t = new FakeTransport()
    .on('POST', '/validate', validateAccept())
    .on('GET', '/validations/latest', validationRequiresAttention());
  const { io, out, log } = ctx({ ...BASE_IDS, mode: 'validate-only' });
  const result = await orchestrate(io, t, OPTS);

  assert.equal(result.success, false);
  assert.equal(out.values['validation-state'], 'RequiresAttention');
  assert.match(result.failureReason!, /validation-failed/);
});

test('validate-and-execute wait success: full scalar output set (D11)', async () => {
  const t = new FakeTransport()
    .on('POST', '/validate', validateAccept())
    .on('GET', '/validations/latest', validationSucceeded())
    .on('POST', '/execute', executeAccept())
    .on('GET', '/runs/', runSucceeded());
  const { io, out } = ctx({ ...BASE_IDS, mode: 'validate-and-execute' });
  const result = await orchestrate(io, t, OPTS);

  assert.equal(result.success, true);
  assert.equal(out.values['validation-state'], 'Succeeded');
  assert.equal(out.values['run-id'], '22222222-2222-2222-2222-222222222222');
  assert.ok(out.values['run-resource-id']!.endsWith('/runs/22222222-2222-2222-2222-222222222222'));
  assert.equal(out.values['run-state'], 'Succeeded');
  assert.equal(out.values['started-at'], '2026-05-01T12:01:00Z');
  assert.equal(out.values['completed-at'], '2026-05-01T12:11:00Z');
});

test('validate-and-execute: a failed validation does NOT attempt execute (D12, FR2)', async () => {
  const t = new FakeTransport()
    .on('POST', '/validate', validateAccept())
    .on('GET', '/validations/latest', validationRequiresAttention())
    .on('POST', '/execute', executeAccept());
  const { io, out } = ctx({ ...BASE_IDS, mode: 'validate-and-execute' });
  const result = await orchestrate(io, t, OPTS);

  assert.equal(result.success, false);
  assert.equal(out.values['run-id'], undefined);
  assert.equal(t.requestsFor('POST').filter((r) => r.url.includes('/execute')).length, 0);
});

test('execute-only wait success: no validation-state; run outputs set (D11)', async () => {
  const t = new FakeTransport()
    .on('POST', '/execute', executeAccept())
    .on('GET', '/runs/', runSucceeded());
  const { io, out } = ctx({ ...BASE_IDS, mode: 'execute-only' });
  const result = await orchestrate(io, t, OPTS);

  assert.equal(result.success, true);
  assert.equal(out.values['validation-state'], undefined, 'execute-only starts no validation');
  assert.equal(out.values['run-state'], 'Succeeded');
  assert.equal(t.requestsFor('POST').filter((r) => r.url.includes('/validate')).length, 0);
});

test('execute-only no-wait: last-observed run-state, no completed-at, warns about no cancel (D11, D8)', async () => {
  const t = new FakeTransport()
    .on('POST', '/execute', executeAccept())
    .on('GET', '/runs/', response(202, { 'Retry-After': '10' }, { properties: { status: 'Running', startTime: '2026-05-01T12:01:00Z' } }));
  const { io, out, log } = ctx({ ...BASE_IDS, mode: 'execute-only', 'wait-for-completion': 'false' });
  const result = await orchestrate(io, t, OPTS);

  assert.equal(result.success, true, 'no-wait succeeds at starting the run');
  assert.equal(out.values['run-id'], '22222222-2222-2222-2222-222222222222');
  assert.equal(out.values['run-state'], 'Running', 'last-observed state');
  assert.equal(out.values['completed-at'], undefined, 'completed-at not set in no-wait');
  assert.equal(t.requestsFor('GET').length, 1, 'exactly one best-effort GET');
  assert.ok(log.warnings.some((w) => w.includes('wait-for-completion is disabled')));
});

test('execute-only no-wait: a HUNG observation transport is aborted at the completion deadline and orchestration STILL returns success without cleanup (D11, FR10, finding #1)', async () => {
  const clock = new FakeClock();
  const t = new FakeTransport();
  t.on('POST', '/execute', executeAccept());
  t.on('GET', '/runs/', HANG); // the observation GET never resolves on its own
  t.on('POST', '/cancel', fixtureResponses('cancel', 'accept-202.json'));
  const { io, out, log } = ctx(
    { ...BASE_IDS, mode: 'execute-only', 'wait-for-completion': 'false', 'completion-timeout-seconds': '30' },
    { clock },
  );
  const result = await orchestrate(io, t, OPTS);

  // No-wait succeeds at STARTING the run; the hung observation is non-fatal and
  // does NOT flip the result, and no-wait never cleans up (D8).
  assert.equal(result.success, true, 'no-wait still returns success after the observation is aborted at the deadline');
  assert.equal(out.values['run-id'], '22222222-2222-2222-2222-222222222222', 'the started run id is reported');
  assert.equal(out.values['run-state'], undefined, 'no last-observed state — the GET was aborted');
  assert.equal(t.requestsFor('GET').length, 1, 'exactly one observation GET attempt');
  assert.equal(t.requestsFor('POST').filter((r) => r.url.includes('/cancel')).length, 0, 'no cleanup in no-wait mode (D8)');
  assert.ok(log.warnings.some((w) => w.includes('no-wait last-observed GET failed')), 'the hung observation was handled non-fatally');
});

test('execute-only no-wait: a SLOW (settling) observation CREDENTIAL that consumes the budget times out at the deadline; orchestration returns success, no observation GET sent, no cleanup (D11, FR10, finding #1)', async () => {
  const clock = new FakeClock();
  // The OBSERVATION's credential exchange advances virtual time past the budget
  // then RESOLVES (post-acquisition check). Gate on call count so the earlier
  // EXECUTE-POST credential (call 0) is unaffected and the run actually starts.
  const cred: FakeCredential = new FakeCredential(FIXED_TOKEN, () => {
    if (cred.calls.length >= 1) clock.advance(31000);
  });
  const t = new FakeTransport();
  t.on('POST', '/execute', executeAccept());
  t.on('GET', '/runs/', response(200, {}, { properties: { status: 'Running' } }));
  t.on('POST', '/cancel', fixtureResponses('cancel', 'accept-202.json'));
  const { io, out, log } = ctx(
    { ...BASE_IDS, mode: 'execute-only', 'wait-for-completion': 'false', 'completion-timeout-seconds': '30' },
    { clock, cred },
  );
  const result = await orchestrate(io, t, OPTS);

  assert.equal(result.success, true);
  assert.equal(out.values['run-id'], '22222222-2222-2222-2222-222222222222');
  assert.equal(out.values['run-state'], undefined, 'no last-observed state — the credential exhausted the budget before the GET');
  assert.equal(t.requestsFor('GET').length, 0, 'the observation GET was never sent');
  assert.equal(t.requestsFor('POST').filter((r) => r.url.includes('/cancel')).length, 0, 'no cleanup in no-wait mode (D8)');
  assert.ok(log.warnings.some((w) => w.includes('no-wait last-observed GET failed')));
});

test('execute-only no-wait: a genuinely PENDING observation CREDENTIAL is aborted by the watcher at the deadline; the execute credential still succeeds, orchestration returns success non-fatally, no observation GET, no cleanup (D11, FR10, finding #1)', async () => {
  const clock = new FakeClock();
  // The EXECUTE-POST credential (call 0) resolves so the run actually starts; the
  // OBSERVATION credential (call 1) is genuinely PENDING and only the deadline
  // watcher (advancing virtual time to 30s and aborting) can end it.
  const cred = new PendingCredential(1);
  const t = new FakeTransport();
  t.on('POST', '/execute', executeAccept());
  t.on('GET', '/runs/', response(200, {}, { properties: { status: 'Running' } }));
  t.on('POST', '/cancel', fixtureResponses('cancel', 'accept-202.json'));
  const { io, out, log } = ctx(
    { ...BASE_IDS, mode: 'execute-only', 'wait-for-completion': 'false', 'completion-timeout-seconds': '30' },
    { clock, cred },
  );
  const startAt = clock.now();
  const result = await orchestrate(io, t, OPTS);

  assert.equal(result.success, true, 'the hung observation is non-fatal — the step still succeeds at starting the run');
  assert.equal(out.values['run-id'], '22222222-2222-2222-2222-222222222222', 'the started run id is reported');
  assert.equal(out.values['run-state'], undefined, 'no last-observed state — the observation credential never resolved');
  assert.equal(cred.calls.length, 2, 'the execute credential resolved and the observation credential was attempted');
  assert.equal(clock.now() - startAt, 30000, 'the watcher advanced virtual time to the deadline before aborting the pending credential');
  assert.equal(t.requestsFor('GET').length, 0, 'no observation GET was sent — the credential never resolved');
  assert.equal(t.requestsFor('POST').filter((r) => r.url.includes('/cancel')).length, 0, 'no cleanup in no-wait mode (D8)');
  assert.ok(log.warnings.some((w) => w.includes('no-wait last-observed GET failed')), 'the pending observation was handled non-fatally');
});

test('wait mode: a terminal Failed run fails the step, preserves the ARM error code, and DOES emit completed-at from the observed endTime (D11, D12, VF10, R4)', async () => {
  const t = new FakeTransport()
    .on('POST', '/execute', executeAccept())
    .on('GET', '/runs/', runFailed());
  const { io, out } = ctx({ ...BASE_IDS, mode: 'execute-only' });
  const result = await orchestrate(io, t, OPTS);

  assert.equal(result.success, false);
  assert.equal(out.values['run-state'], 'Failed');
  assert.equal(out.values['started-at'], '2026-05-01T12:01:00Z', 'started-at is still emitted');
  // A Failed run was normally observed to a terminal state with a real
  // service-provided endTime, so completed-at IS emitted (R4) — unlike the
  // timeout/cleanup cases below where no normal terminal observation occurred.
  assert.equal(out.values['completed-at'], '2026-05-01T12:04:30Z', 'completed-at is emitted for a normally observed Failed terminal run');
  assert.match(result.failureReason!, /run-failed/);
  assert.match(result.failureReason!, /InternalExecutionError/);
});

// ---------------------------------------------------------------------------
// Input validation / fail-closed (FR14, FR16).
// ---------------------------------------------------------------------------

test('an invalid subscription id fails closed with no network calls (FR14)', async () => {
  const t = new FakeTransport();
  const { io } = ctx({ ...BASE_IDS, 'subscription-id': 'not-a-guid', mode: 'validate-only' });
  const result = await orchestrate(io, t, OPTS);

  assert.equal(result.success, false);
  assert.match(result.failureReason!, /identifier/);
  assert.equal(t.requests.length, 0, 'no ARM call issued for a malformed identifier');
});

test('an unknown mode fails closed with no network calls (FR16)', async () => {
  const t = new FakeTransport();
  const { io } = ctx({ ...BASE_IDS, mode: 'destroy-everything' });
  const result = await orchestrate(io, t, OPTS);

  assert.equal(result.success, false);
  assert.match(result.failureReason!, /identifier/);
  assert.match(result.failureReason!, /unknown mode/);
  assert.equal(t.requests.length, 0);
});

test('an undefined (genuinely omitted) mode fails closed with no credential or network calls, rather than silently defaulting (FR16, R1)', async () => {
  const t = new FakeTransport();
  const cred = new FakeCredential();
  const { io } = ctx({ ...BASE_IDS }, { cred });
  const result = await orchestrate(io, t, OPTS);

  assert.equal(result.success, false);
  assert.match(result.failureReason!, /identifier/);
  assert.match(result.failureReason!, /missing required input/);
  assert.equal(t.requests.length, 0, 'no ARM call for an undefined mode');
  assert.equal(cred.calls.length, 0, 'no credential/auth call for an undefined mode');
});

test('an empty-string mode (e.g. a blank workflow expression) fails closed exactly like an undefined mode — it must NOT silently start a chaos run via the documented default (FR16, R1)', async () => {
  const t = new FakeTransport();
  const cred = new FakeCredential();
  const { io } = ctx({ ...BASE_IDS, mode: '' }, { cred });
  const result = await orchestrate(io, t, OPTS);

  assert.equal(result.success, false);
  assert.match(result.failureReason!, /identifier/);
  assert.match(result.failureReason!, /missing required input/);
  assert.equal(t.requests.length, 0, 'no ARM call for an empty mode');
  assert.equal(cred.calls.length, 0, 'no credential/auth call for an empty mode');
});

// ---------------------------------------------------------------------------
// Timeout + cancellation + cleanup (FR10, FR11, D9, D10).
// ---------------------------------------------------------------------------

test('completion timeout during run polling triggers cleanup that reaches Canceled, but the ORIGINAL timeout is reported (FR10, FR11)', async () => {
  const t = new FakeTransport();
  const cancelPosted = (): boolean => t.requests.some((r) => r.method === 'POST' && r.url.includes('/cancel'));
  t.on('POST', '/execute', executeAccept());
  // After a cancel has been POSTed, the run settles to Canceled; before, it runs forever.
  t.on('GET', (req) => req.url.includes('/runs/') && cancelPosted(), [
    response(202, { 'Retry-After': '10' }, { properties: { status: 'Canceling', startTime: '2026-05-01T12:01:00Z' } }),
    response(200, {}, { properties: { status: 'Canceled', startTime: '2026-05-01T12:01:00Z', endTime: '2026-05-01T12:02:00Z' } }),
  ]);
  t.on('GET', '/runs/', response(202, { 'Retry-After': '10' }, { properties: { status: 'Running', startTime: '2026-05-01T12:01:00Z' } }));
  t.on('POST', '/cancel', fixtureResponses('cancel', 'accept-202.json'));
  const { io, out } = ctx({ ...BASE_IDS, mode: 'execute-only', 'completion-timeout-seconds': '30' });
  const result = await orchestrate(io, t, OPTS);

  assert.equal(result.success, false);
  assert.match(result.failureReason!, /timeout/, 'the original reason (timeout) is reported, not the Canceled cleanup');
  assert.equal(t.requestsFor('POST').filter((r) => r.url.includes('/cancel')).length, 1, 'exactly one cancel POST');
  assert.equal(out.values['run-state'], 'Canceled', 'last-observed state from cleanup');
  assert.equal(out.values['completed-at'], undefined, 'completed-at not set on a timeout (D11)');
});

test('completion timeout with cancel disabled leaves the run running, does not POST cancel, and STILL emits last-observed run-state/started-at (D9, D11, finding #3)', async () => {
  const t = new FakeTransport()
    .on('POST', '/execute', executeAccept())
    .on('GET', '/runs/', response(202, { 'Retry-After': '10' }, { properties: { status: 'Running', startTime: '2026-05-01T12:01:00Z' } }))
    .on('POST', '/cancel', fixtureResponses('cancel', 'accept-202.json'));
  const { io, out, log } = ctx({
    ...BASE_IDS,
    mode: 'execute-only',
    'completion-timeout-seconds': '30',
    'cancel-on-timeout-or-cancellation': 'false',
  });
  const result = await orchestrate(io, t, OPTS);

  assert.equal(result.success, false);
  assert.match(result.failureReason!, /timeout/);
  assert.equal(t.requestsFor('POST').filter((r) => r.url.includes('/cancel')).length, 0, 'cancel disabled -> no cancel POST');
  assert.ok(log.warnings.some((w) => w.includes('is left running')));
  // D11: the previously observed Running/startTime survive even with cleanup off.
  assert.equal(out.values['run-state'], 'Running', 'last-observed run-state retained on timeout');
  assert.equal(out.values['started-at'], '2026-05-01T12:01:00Z', 'last-observed started-at retained on timeout');
  assert.equal(out.values['completed-at'], undefined, 'completed-at not set on a timeout (D11)');
});

test('cleanup failure after a timeout does NOT mask the original reason and RETAINS last-observed run outputs (FR11, R8, D11, finding #3)', async () => {
  const t = new FakeTransport()
    .on('POST', '/execute', executeAccept())
    .on('GET', '/runs/', response(202, { 'Retry-After': '10' }, { properties: { status: 'Running', startTime: '2026-05-01T12:01:00Z' } }))
    .on('POST', '/cancel', response(500, {}, { error: { code: 'ServerError' } }));
  const { io, out, log } = ctx({ ...BASE_IDS, mode: 'execute-only', 'completion-timeout-seconds': '30' });
  const result = await orchestrate(io, t, OPTS);

  assert.equal(result.success, false);
  assert.match(result.failureReason!, /timeout/, 'the timeout reason survives a failed cleanup');
  assert.ok(log.warnings.some((w) => w.includes('cleanup did not complete')));
  // A failed cleanup returns no terminal outcome, so the last-observed poll values remain.
  assert.equal(out.values['run-state'], 'Running', 'last-observed run-state retained when cleanup fails');
  assert.equal(out.values['started-at'], '2026-05-01T12:01:00Z');
  assert.equal(out.values['completed-at'], undefined);
});

test('cancellation before a run ID exists cannot cancel anything and fails the step (D9)', async () => {
  const controller = new AbortController();
  controller.abort(); // pipeline cancellation before the first call
  const t = new FakeTransport()
    .on('POST', '/validate', validateAccept())
    .on('GET', '/validations/latest', validationSucceeded());
  const { io } = ctx({ ...BASE_IDS, mode: 'validate-and-execute' }, { signal: controller.signal });
  const result = await orchestrate(io, t, OPTS);

  assert.equal(result.success, false);
  assert.equal(t.requestsFor('POST').filter((r) => r.url.includes('/cancel')).length, 0, 'nothing to cancel');
});

test('a slow EXECUTE acceptance that crosses the completion deadline times out, preserves the run identity, and cleans up in wait mode (FR10/FR11, finding #1)', async () => {
  const clock = new FakeClock();
  // The execute POST "takes" 40s of latency; under a 30s completion deadline the
  // acceptance crosses the budget. The run identity must still be emitted and the
  // run cleaned up (wait mode) rather than the step reporting success.
  const t = new FakeTransport((req) => {
    if (req.url.includes('/execute')) clock.advance(40000);
  });
  t.on('POST', '/execute', executeAccept());
  t.on('POST', '/cancel', fixtureResponses('cancel', 'accept-202.json'));
  t.on('GET', '/runs/', fixtureResponses('cancel', 'run-transitions.json'));
  const { io, out } = ctx({ ...BASE_IDS, mode: 'execute-only', 'completion-timeout-seconds': '30' }, { clock });
  const result = await orchestrate(io, t, OPTS);

  assert.equal(result.success, false);
  assert.match(result.failureReason!, /timeout/, 'a late execute acceptance is a timeout, not success');
  assert.equal(out.values['run-id'], '22222222-2222-2222-2222-222222222222', 'run identity preserved/emitted for cleanup');
  assert.ok(out.values['run-resource-id'], 'run-resource-id emitted');
  assert.equal(t.requestsFor('POST').filter((r) => r.url.includes('/cancel')).length, 1, 'cleanup cancel POST issued for the preserved run');
  assert.equal(out.values['run-state'], 'Canceled', 'cleanup observed the run terminal');
  assert.equal(out.values['completed-at'], undefined, 'completed-at not set on a timeout (D11)');
});

test('a slow EXECUTE acceptance in NO-WAIT mode that crosses the deadline fails with timeout (not success) and does not cleanup (FR10, D8, finding #1)', async () => {
  const clock = new FakeClock();
  const t = new FakeTransport((req) => {
    if (req.url.includes('/execute')) clock.advance(40000);
  });
  t.on('POST', '/execute', executeAccept());
  t.on('POST', '/cancel', fixtureResponses('cancel', 'accept-202.json'));
  t.on('GET', '/runs/', response(200, {}, { properties: { status: 'Running' } }));
  const { io, out } = ctx(
    { ...BASE_IDS, mode: 'execute-only', 'wait-for-completion': 'false', 'completion-timeout-seconds': '30' },
    { clock },
  );
  const result = await orchestrate(io, t, OPTS);

  assert.equal(result.success, false, 'a no-wait execute crossing the deadline does not return success');
  assert.match(result.failureReason!, /timeout/);
  assert.equal(out.values['run-id'], '22222222-2222-2222-2222-222222222222', 'run-id emitted so an operator can cancel');
  assert.equal(t.requestsFor('POST').filter((r) => r.url.includes('/cancel')).length, 0, 'no cleanup in no-wait mode (D8)');
  assert.equal(t.requestsFor('GET').length, 0, 'the deadline is enforced before any observation GET');
});

test('a slow VALIDATE acceptance that crosses the completion deadline times out before polling (FR10, finding #1)', async () => {
  const clock = new FakeClock();
  const t = new FakeTransport((req) => {
    if (req.url.includes('/validate')) clock.advance(40000);
  });
  t.on('POST', '/validate', validateAccept());
  t.on('GET', '/validations/latest', validationSucceeded());
  const { io } = ctx({ ...BASE_IDS, mode: 'validate-only', 'completion-timeout-seconds': '30' }, { clock });
  const result = await orchestrate(io, t, OPTS);

  assert.equal(result.success, false);
  assert.match(result.failureReason!, /timeout/);
  assert.equal(t.requestsFor('GET').length, 0, 'no validations/latest poll after the acceptance already crossed the deadline');
});

test('an EXECUTE whose CREDENTIAL ACQUISITION crosses the completion deadline never submits the POST — zero execute sends, no chaos run started (FR10, finding #1)', async () => {
  // The budget is intact when the execute phase begins, but getArmToken() itself
  // advances the clock past the 30s deadline. The execute POST must NOT reach the
  // transport, so no run is started outside the completion budget, and the step
  // times out. (Distinct from response latency: here the request is never sent.)
  const clock = new FakeClock();
  const cred = new FakeCredential(FIXED_TOKEN, () => clock.advance(31000));
  const t = new FakeTransport();
  t.on('POST', '/execute', executeAccept());
  t.on('POST', '/cancel', fixtureResponses('cancel', 'accept-202.json'));
  t.on('GET', '/runs/', response(200, {}, { properties: { status: 'Running' } }));
  const { io, out } = ctx({ ...BASE_IDS, mode: 'execute-only', 'completion-timeout-seconds': '30' }, { clock, cred });
  const result = await orchestrate(io, t, OPTS);

  assert.equal(result.success, false);
  assert.match(result.failureReason!, /timeout/);
  assert.equal(t.requestsFor('POST').filter((r) => r.url.includes('/execute')).length, 0, 'the execute POST was never submitted');
  assert.equal(out.values['run-id'], undefined, 'no run identity — the run was never started');
  assert.equal(t.requestsFor('POST').filter((r) => r.url.includes('/cancel')).length, 0, 'nothing to cancel — no run exists');
});

test('end-to-end: a PENDING run poll GET that never resolves times out at the deadline and triggers cleanup of the started run (FR10/FR11, finding #2)', async () => {
  const clock = new FakeClock();
  const t = new FakeTransport();
  const cancelPosted = (): boolean => t.requests.some((r) => r.method === 'POST' && r.url.includes('/cancel'));
  t.on('POST', '/execute', executeAccept());
  // After cancel, the cleanup poll resolves to Canceled; the FORWARD run GET hangs
  // forever, so only the deadline watcher can end the wait.
  t.on('GET', (req) => req.url.includes('/runs/') && cancelPosted(),
    response(200, {}, { properties: { status: 'Canceled', startTime: '2026-05-01T12:01:00Z', endTime: '2026-05-01T12:02:00Z' } }));
  t.on('GET', '/runs/', HANG);
  t.on('POST', '/cancel', fixtureResponses('cancel', 'accept-202.json'));
  const { io, out } = ctx({ ...BASE_IDS, mode: 'execute-only', 'completion-timeout-seconds': '30' }, { clock });
  const result = await orchestrate(io, t, OPTS);

  assert.equal(result.success, false);
  assert.match(result.failureReason!, /timeout/, 'a hung forward poll times out (not left pending forever)');
  assert.equal(out.values['run-id'], '22222222-2222-2222-2222-222222222222', 'the started run identity is preserved for cleanup');
  assert.equal(t.requestsFor('POST').filter((r) => r.url.includes('/cancel')).length, 1, 'cleanup cancel was issued after the timeout');
  assert.equal(out.values['run-state'], 'Canceled', 'cleanup observed the run terminal');
  assert.equal(out.values['completed-at'], undefined, 'completed-at not set on a timeout (D11)');
});

test('end-to-end: the EXECUTE acceptance Retry-After is honored before the first run poll GET (FR8, finding #1)', async () => {
  const clock = new FakeClock();
  let firstRunGetAt = -1;
  const t = new FakeTransport((req) => {
    if (req.method === 'GET' && req.url.includes('/runs/') && firstRunGetAt < 0) firstRunGetAt = clock.now();
  });
  t.on('POST', '/execute', executeAccept()); // accept-202 fixture carries Retry-After 10
  t.on('GET', '/runs/', runSucceeded());
  const { io, out } = ctx({ ...BASE_IDS, mode: 'execute-only' }, { clock });
  const startAt = clock.now();
  const result = await orchestrate(io, t, OPTS);

  assert.equal(result.success, true);
  assert.equal(out.values['run-state'], 'Succeeded');
  assert.equal(firstRunGetAt - startAt, 10000, 'the first run GET waited the acceptance Retry-After (10s), not 0ms');
});

test('end-to-end: the VALIDATE acceptance Retry-After is honored before the first validations/latest GET (FR8, finding #1)', async () => {
  const clock = new FakeClock();
  let firstGetAt = -1;
  const t = new FakeTransport((req) => {
    if (req.method === 'GET' && req.url.includes('/validations/latest') && firstGetAt < 0) firstGetAt = clock.now();
  });
  t.on('POST', '/validate', validateAccept()); // Retry-After 10
  t.on('GET', '/validations/latest', validationSucceeded());
  const { io, out } = ctx({ ...BASE_IDS, mode: 'validate-only' }, { clock });
  const startAt = clock.now();
  const result = await orchestrate(io, t, OPTS);

  assert.equal(result.success, true);
  assert.equal(out.values['validation-state'], 'Succeeded');
  assert.equal(firstGetAt - startAt, 10000, 'the first validations/latest GET waited the acceptance Retry-After (10s), not 0ms');
});

test('a failing poll correlation/request IDs OVERWRITE the earlier acceptance IDs in the outputs (D11 last-relevant-response, finding #3)', async () => {
  // Execute acceptance emits correlation A; the run poll then fails (403) carrying
  // DIFFERENT IDs (B). The failure outputs must report B (the last relevant
  // response), not the stale acceptance A.
  const t = new FakeTransport()
    .on('POST', '/execute', executeAccept()) // correlation aaaaaaaa-...0005
    .on('GET', '/runs/', response(403, {
      'x-ms-correlation-request-id': 'corr-from-failing-poll',
      'x-ms-request-id': 'req-from-failing-poll',
      'x-ms-error-code': 'AuthorizationFailed',
    }, { error: { code: 'AuthorizationFailed' } }));
  const { io, out } = ctx({ ...BASE_IDS, mode: 'execute-only' });
  const result = await orchestrate(io, t, OPTS);

  assert.equal(result.success, false);
  assert.equal(out.values['run-id'], '22222222-2222-2222-2222-222222222222', 'acceptance still emitted the run id');
  assert.notEqual(out.values['correlation-id'], 'aaaaaaaa-0000-0000-0000-000000000005', 'the stale acceptance correlation was replaced');
  assert.equal(out.values['correlation-id'], 'corr-from-failing-poll', 'the failing poll correlation is reported');
  assert.equal(out.values['request-id'], 'req-from-failing-poll');
});

test('a forward timeout correlation context survives cleanup — cleanup IDs do not replace it (D11, FR11, finding #3)', async () => {
  const clock = new FakeClock();
  const t = new FakeTransport();
  const cancelPosted = (): boolean => t.requests.some((r) => r.method === 'POST' && r.url.includes('/cancel'));
  t.on('POST', '/execute', executeAccept());
  // After cancel, the cleanup poll carries its OWN correlation IDs.
  t.on('GET', (req) => req.url.includes('/runs/') && cancelPosted(),
    response(200, { 'x-ms-correlation-request-id': 'corr-cleanup', 'x-ms-request-id': 'req-cleanup' },
      { properties: { status: 'Canceled', startTime: '2026-05-01T12:01:00Z', endTime: '2026-05-01T12:02:00Z' } }));
  // The forward run poll stays Running (correlation from the forward flow) until timeout.
  t.on('GET', '/runs/', response(202, { 'Retry-After': '10', 'x-ms-correlation-request-id': 'corr-forward', 'x-ms-request-id': 'req-forward' },
    { properties: { status: 'Running', startTime: '2026-05-01T12:01:00Z' } }));
  t.on('POST', '/cancel', fixtureResponses('cancel', 'accept-202.json'));
  const { io, out } = ctx({ ...BASE_IDS, mode: 'execute-only', 'completion-timeout-seconds': '30' }, { clock });
  const result = await orchestrate(io, t, OPTS);

  assert.equal(result.success, false);
  assert.match(result.failureReason!, /timeout/);
  assert.equal(out.values['correlation-id'], 'corr-forward', 'the forward timeout correlation is reported, not the cleanup correlation');
  assert.equal(out.values['request-id'], 'req-forward');
  assert.equal(out.values['run-state'], 'Canceled', 'cleanup observation still updates run-state');
});

// ---------------------------------------------------------------------------
// Retries, redaction, and error normalization (D13, FR12, VF16).
// ---------------------------------------------------------------------------

test('a transient 503 on a run poll is retried, then the run succeeds (D13, FR8)', async () => {
  const t = new FakeTransport()
    .on('POST', '/execute', executeAccept())
    .on('GET', '/runs/', [
      response(503, { 'Retry-After': '5' }, { error: { code: 'ServerBusy' } }),
      response(200, {}, { properties: { status: 'Succeeded', startTime: '2026-05-01T12:01:00Z', endTime: '2026-05-01T12:11:00Z' } }),
    ]);
  const { io, out, clock } = ctx({ ...BASE_IDS, mode: 'execute-only' });
  const result = await orchestrate(io, t, OPTS);

  assert.equal(result.success, true);
  assert.equal(out.values['run-state'], 'Succeeded');
  assert.equal(t.requestsFor('GET').length, 2, 'the 503 was retried');
});

test('the bearer token is masked and never appears in logs or the failure reason (FR12, VF16)', async () => {
  const t = new FakeTransport()
    .on('POST', '/validate', validateAccept())
    .on('GET', '/validations/latest', validationRequiresAttention());
  const { io, log } = ctx({ ...BASE_IDS, mode: 'validate-only' });
  const result = await orchestrate(io, t, OPTS);

  assert.equal(result.success, false);
  assert.ok(log.masked.includes(FIXED_TOKEN), 'the token was registered for masking');
  assert.ok(!log.all.includes(FIXED_TOKEN), 'the token never appears in a log line');
  assert.ok(!result.failureReason!.includes(FIXED_TOKEN));
});

test('a secret-shaped business error is redacted before it is logged (FR12)', async () => {
  const leaky = {
    properties: {
      status: 'RequiresAttention',
      errors: [{ code: 'PermissionDenied', message: 'token Bearer eyJabc.def.ghi was rejected' }],
      validationErrors: [{ code: 'NeedsRole', message: 'use SharedAccessKey=TOPSECRETKEY== to fix' }],
    },
  };
  const t = new FakeTransport()
    .on('POST', '/validate', validateAccept())
    .on('GET', '/validations/latest', response(200, {}, leaky));
  const { io, log } = ctx({ ...BASE_IDS, mode: 'validate-only' });
  await orchestrate(io, t, OPTS);

  assert.ok(!log.all.includes('TOPSECRETKEY=='), 'SharedAccessKey value redacted');
  assert.ok(!log.all.includes('eyJabc.def.ghi'), 'JWT-shaped token redacted');
  assert.ok(log.all.includes('<redacted>'));
});

test('toNormalizedError maps a CoreError and describes an abort as a cancellation', () => {
  const ce = new CoreError('transport', 'GET failed', { armErrorCode: 'X', correlationId: 'c', requestId: 'r' });
  const normal = toNormalizedError(ce, false);
  assert.equal(normal.category, 'transport');
  assert.equal(normal.armErrorCode, 'X');
  assert.equal(normal.correlationId, 'c');

  const aborted = toNormalizedError(ce, true);
  assert.equal(aborted.category, 'timeout', 'a cancellation is grouped under timeout for mapping');
  assert.match(aborted.message, /cancellation/);
});
