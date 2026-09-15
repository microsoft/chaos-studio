import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { OrchestrationResult, RunContext } from '../../core/src/contract.ts';
import {
  GithubInputReader,
  GithubLogger,
  GithubOutputSetter,
  runGithubAction,
  systemClock,
} from '../src/adapter.ts';
import { FakeActionsHost, FakeTokenCredentialProvider } from './fake-host.ts';

test('GithubInputReader maps @actions/core inputs: unset→undefined/default, bool, int (parity with the core reader)', () => {
  const host = new FakeActionsHost({
    'subscription-id': '11111111-1111-1111-1111-111111111111',
    'wait-for-completion': 'FALSE',
    'completion-timeout-seconds': '900',
    mode: '',
  });
  const r = new GithubInputReader(host);

  assert.equal(r.get('subscription-id'), '11111111-1111-1111-1111-111111111111');
  assert.equal(r.get('mode'), undefined, 'an empty @actions/core input is treated as absent');
  assert.equal(r.get('missing'), undefined);
  assert.equal(r.getRequired('subscription-id'), '11111111-1111-1111-1111-111111111111');
  assert.throws(() => r.getRequired('missing'), /missing required input 'missing'/);
  // Bool: case-insensitive 'true'; unset → default.
  assert.equal(r.getBool('wait-for-completion', true), false);
  assert.equal(r.getBool('missing', true), true);
  assert.equal(r.getBool('missing', false), false);
  // Int: parsed; unset/NaN → default.
  assert.equal(r.getInt('completion-timeout-seconds', 2700), 900);
  assert.equal(r.getInt('missing', 2700), 2700);
});

test('GithubInputReader.getInt REQUIRES an exact positive safe integer and REJECTS malformed/negative/zero/overflowing values (R3)', () => {
  const host = new FakeActionsHost({
    ok: '900',
    partial: '5x',
    fractional: '5.5',
    negative: '-5',
    zero: '0',
    unsafe: '9007199254740993', // > Number.MAX_SAFE_INTEGER
    padded: ' 42 ',
    empty: '',
  });
  const r = new GithubInputReader(host);

  assert.equal(r.getInt('ok', 2700), 900);
  assert.equal(r.getInt('missing', 2700), 2700, 'unset → default');
  assert.equal(r.getInt('padded', 2700), 42, 'surrounding whitespace is trimmed');
  for (const name of ['partial', 'fractional', 'negative', 'zero', 'unsafe']) {
    assert.throws(
      () => r.getInt(name, 2700),
      /invalid integer for input/,
      `'${name}' must be rejected, not silently defaulted or truncated`,
    );
  }
});

test('GithubInputReader.getBool accepts case/space variants of true/false and REJECTS malformed values (fail-closed, no silent false)', () => {
  const host = new FakeActionsHost({
    t1: 'true',
    t2: 'TRUE',
    t3: '  True ',
    f1: 'false',
    f2: 'FALSE',
    typo: 'tru',
    yes: 'yes',
    one: '1',
    zero: '0',
  });
  const r = new GithubInputReader(host);

  // Accepted true/false spellings (trim + case-insensitive).
  assert.equal(r.getBool('t1', false), true);
  assert.equal(r.getBool('t2', false), true);
  assert.equal(r.getBool('t3', false), true);
  assert.equal(r.getBool('f1', true), false);
  assert.equal(r.getBool('f2', true), false);
  // Unset → default (unchanged).
  assert.equal(r.getBool('missing', true), true);
  assert.equal(r.getBool('missing', false), false);
  // Malformed values must THROW (naming the input + value), not silently be false —
  // a typo like 'tru' in wait-for-completion must not quietly disable waiting.
  assert.throws(() => r.getBool('typo', true), /invalid boolean.*'typo'.*'tru'/s);
  assert.throws(() => r.getBool('yes', false), /invalid boolean.*'yes'/s);
  assert.throws(() => r.getBool('one', false), /invalid boolean.*'one'/s);
  assert.throws(() => r.getBool('zero', true), /invalid boolean.*'zero'/s);
});

test('GithubOutputSetter forwards to core.setOutput', () => {
  const host = new FakeActionsHost();
  const out = new GithubOutputSetter(host);
  out.set('run-id', '22222222-2222-2222-2222-222222222222');
  out.set('run-state', 'Succeeded');
  assert.deepEqual(host.outputs, {
    'run-id': '22222222-2222-2222-2222-222222222222',
    'run-state': 'Succeeded',
  });
});

test('GithubLogger maps info/warning/error and masks secrets via core.setSecret (::add-mask::)', () => {
  const host = new FakeActionsHost();
  const log = new GithubLogger(host);
  log.info('hello');
  log.warning('careful');
  log.error('boom');
  log.mask('super-secret-token');
  assert.deepEqual(host.infos, ['hello']);
  assert.deepEqual(host.warnings, ['careful']);
  assert.deepEqual(host.errors, ['boom']);
  assert.deepEqual(host.masked, ['super-secret-token'], 'a masked secret is registered with core.setSecret');
});

test('runGithubAction: a SUCCESS result sets outputs and does NOT fail the step (pass parity, D12)', async () => {
  const host = new FakeActionsHost();
  // A fake orchestrator that emits canonical outputs through the injected setter,
  // exactly as the real core does, and returns success.
  const fakeOrchestrate = async (io: RunContext): Promise<OrchestrationResult> => {
    io.output.set('run-id', '22222222-2222-2222-2222-222222222222');
    io.output.set('run-state', 'Succeeded');
    return { success: true, outputs: { 'run-id': '22222222-2222-2222-2222-222222222222', 'run-state': 'Succeeded' } };
  };
  const result = await runGithubAction({
    host,
    cred: new FakeTokenCredentialProvider(),
    signal: new AbortController().signal,
    orchestrate: fakeOrchestrate,
  });

  assert.equal(result.success, true);
  assert.equal(host.failed, false, 'a successful run does not call setFailed');
  assert.equal(host.outputs['run-id'], '22222222-2222-2222-2222-222222222222');
  assert.equal(host.outputs['run-state'], 'Succeeded');
});

test('runGithubAction: a FAILURE result calls setFailed with the core failure reason (fail parity, D12)', async () => {
  const host = new FakeActionsHost();
  const fakeOrchestrate = async (): Promise<OrchestrationResult> => ({
    success: false,
    outputs: { 'validation-state': 'RequiresAttention' },
    failureReason: 'validation-failed: validation did not succeed (terminal state RequiresAttention)',
  });
  const result = await runGithubAction({
    host,
    cred: new FakeTokenCredentialProvider(),
    signal: new AbortController().signal,
    orchestrate: fakeOrchestrate,
  });

  assert.equal(result.success, false);
  assert.equal(host.failed, true);
  assert.deepEqual(host.failures, [
    'validation-failed: validation did not succeed (terminal state RequiresAttention)',
  ]);
});

test('runGithubAction: a failure with no reason still fails the step with a default message', async () => {
  const host = new FakeActionsHost();
  const result = await runGithubAction({
    host,
    cred: new FakeTokenCredentialProvider(),
    signal: new AbortController().signal,
    orchestrate: async () => ({ success: false, outputs: {} }),
  });
  assert.equal(result.success, false);
  assert.equal(host.failures.length, 1);
  assert.match(host.failures[0]!, /Azure Chaos Studio step failed/);
});

test('runGithubAction: an UNEXPECTED throw from the orchestrator fails the step deterministically (defensive)', async () => {
  const host = new FakeActionsHost();
  const result = await runGithubAction({
    host,
    cred: new FakeTokenCredentialProvider(),
    signal: new AbortController().signal,
    orchestrate: async () => {
      throw new Error('kaboom');
    },
  });
  assert.equal(result.success, false);
  assert.deepEqual(host.failures, ['kaboom']);
});

test('runGithubAction: the injected signal and default systemClock are wired into the RunContext', async () => {
  const host = new FakeActionsHost();
  const controller = new AbortController();
  let seen: RunContext | undefined;
  await runGithubAction({
    host,
    cred: new FakeTokenCredentialProvider(),
    signal: controller.signal,
    orchestrate: async (io) => {
      seen = io;
      return { success: true, outputs: {} };
    },
  });
  assert.ok(seen);
  assert.equal(seen!.signal, controller.signal, 'the job-cancel signal reaches the core');
  assert.equal(seen!.clock, systemClock, 'the default system clock is injected when none is supplied');
});

test('systemClock.sleep resolves after the delay and rejects promptly on abort without leaking a timer', async (t) => {
  // Deterministic virtual timers (NFR2) — no real wall-clock sleep.
  t.mock.timers.enable({ apis: ['setTimeout'] });

  // Resolves once the (virtual) delay elapses.
  const resolved = systemClock.sleep(10_000, new AbortController().signal);
  t.mock.timers.tick(10_000);
  await resolved;

  // Pre-aborted → rejects immediately, no timer scheduled.
  const pre = new AbortController();
  pre.abort();
  await assert.rejects(() => systemClock.sleep(10_000, pre.signal), (e) => (e as Error).name === 'AbortError');

  // Aborted mid-sleep → rejects promptly (clears the timer; does NOT wait the delay).
  const mid = new AbortController();
  const p = systemClock.sleep(10_000, mid.signal);
  mid.abort();
  await assert.rejects(() => p, (e) => (e as Error).name === 'AbortError');
  // After the abort cleared the timer, ticking past the delay must NOT resolve
  // anything (the promise already rejected) — proves the timer was cleared.
  t.mock.timers.tick(10_000);
});
