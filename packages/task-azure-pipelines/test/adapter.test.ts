import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { OrchestrationResult, RunContext } from '../../core/src/contract.ts';
import {
  TaskInputReader,
  TaskLogger,
  TaskOutputSetter,
  runAzurePipelinesTask,
  systemClock,
} from '../src/adapter.ts';
import { FakeTaskHost, FakeTokenCredentialProvider } from './fake-host.ts';

test('TaskInputReader maps canonical wire names to Azure Pipelines task inputs: unset→undefined/default, bool, int', () => {
  const host = new FakeTaskHost({
    subscriptionId: '11111111-1111-1111-1111-111111111111',
    waitForCompletion: 'FALSE',
    completionTimeoutSeconds: '900',
    mode: '',
  });
  const r = new TaskInputReader(host);

  // The core asks for the canonical wire name; the reader translates to the ADO
  // camelCase input name (subscription-id → subscriptionId).
  assert.equal(r.get('subscription-id'), '11111111-1111-1111-1111-111111111111');
  assert.equal(r.get('mode'), undefined, 'an empty Azure Pipelines input is treated as absent');
  assert.equal(r.get('scenario-name'), undefined, 'an unset input is absent');
  assert.equal(r.getRequired('subscription-id'), '11111111-1111-1111-1111-111111111111');
  assert.throws(() => r.getRequired('scenario-name'), /missing required input 'scenario-name'/);
  // Bool: case-insensitive true/false; unset → default.
  assert.equal(r.getBool('wait-for-completion', true), false);
  assert.equal(r.getBool('cancel-on-timeout-or-cancellation', true), true);
  // Int: parsed; unset/NaN → default.
  assert.equal(r.getInt('completion-timeout-seconds', 2700), 900);
  assert.equal(r.getInt('completion-timeout-seconds-missing', 2700), 2700);
});

test('TaskInputReader.getBool accepts case/space variants of true/false and REJECTS malformed values (fail-closed, no silent false)', () => {
  const host = new FakeTaskHost({
    t1: 'true',
    t2: 'TRUE',
    t3: '  True ',
    f1: 'false',
    f2: 'FALSE',
    typo: 'tru',
    yes: 'yes',
    one: '1',
  });
  const r = new TaskInputReader(host);

  assert.equal(r.getBool('t1', false), true);
  assert.equal(r.getBool('t2', false), true);
  assert.equal(r.getBool('t3', false), true);
  assert.equal(r.getBool('f1', true), false);
  assert.equal(r.getBool('f2', true), false);
  assert.equal(r.getBool('missing', true), true);
  assert.equal(r.getBool('missing', false), false);
  // Malformed values must THROW (naming the input + value), not silently be false.
  assert.throws(() => r.getBool('typo', true), /invalid boolean.*'typo'.*'tru'/s);
  assert.throws(() => r.getBool('yes', false), /invalid boolean.*'yes'/s);
  assert.throws(() => r.getBool('one', false), /invalid boolean.*'one'/s);
});

test('TaskOutputSetter forwards to tl.setVariable as an OUTPUT variable (isOutput=true)', () => {
  const host = new FakeTaskHost();
  const out = new TaskOutputSetter(host);
  out.set('run-id', '22222222-2222-2222-2222-222222222222');
  out.set('run-state', 'Succeeded');
  assert.deepEqual(host.outputs, {
    'run-id': '22222222-2222-2222-2222-222222222222',
    'run-state': 'Succeeded',
  });
  assert.ok(host.variables.every((v) => v.isOutput === true), 'every canonical output is an isOutput variable');
});

test('TaskLogger maps info/warning/error and masks secrets via tl.setSecret', () => {
  const host = new FakeTaskHost();
  const log = new TaskLogger(host);
  log.info('hello');
  log.warning('careful');
  log.error('boom');
  log.mask('super-secret-token');
  assert.deepEqual(host.infos, ['hello']);
  assert.deepEqual(host.warnings, ['careful']);
  assert.deepEqual(host.errors, ['boom']);
  assert.deepEqual(host.masked, ['super-secret-token'], 'a masked secret is registered with tl.setSecret');
});

/** A fake orchestrator that records the RunContext it received. */
function capturingOrchestrator(result: OrchestrationResult): {
  fn: (io: RunContext) => Promise<OrchestrationResult>;
  seen: { io?: RunContext };
} {
  const seen: { io?: RunContext } = {};
  return {
    seen,
    fn: (io: RunContext) => {
      seen.io = io;
      return Promise.resolve(result);
    },
  };
}

test('runAzurePipelinesTask: a SUCCESS result completes the task Succeeded and does NOT fail it (pass parity, D12)', async () => {
  const host = new FakeTaskHost();
  const orch = capturingOrchestrator({ success: true, outputs: { 'run-state': 'Succeeded' } });
  const result = await runAzurePipelinesTask({
    host,
    cred: new FakeTokenCredentialProvider(),
    signal: new AbortController().signal,
    orchestrate: orch.fn,
  });
  assert.equal(result.success, true);
  assert.equal(host.failed, false, 'a successful run does not fail the task');
  assert.deepEqual(host.results, [{ success: true, message: 'Azure Chaos Studio task succeeded.' }]);
});

test('runAzurePipelinesTask: a FAILURE result completes the task Failed with the core failure reason (fail parity, D12)', async () => {
  const host = new FakeTaskHost();
  const orch = capturingOrchestrator({ success: false, outputs: {}, failureReason: 'run-failed: InternalExecutionError' });
  await runAzurePipelinesTask({
    host,
    cred: new FakeTokenCredentialProvider(),
    signal: new AbortController().signal,
    orchestrate: orch.fn,
  });
  assert.equal(host.failed, true);
  assert.equal(host.failureMessage, 'run-failed: InternalExecutionError', 'the task carries the core failure reason');
});

test('runAzurePipelinesTask: a failure with no reason still fails the task with a default message', async () => {
  const host = new FakeTaskHost();
  const orch = capturingOrchestrator({ success: false, outputs: {} });
  await runAzurePipelinesTask({
    host,
    cred: new FakeTokenCredentialProvider(),
    signal: new AbortController().signal,
    orchestrate: orch.fn,
  });
  assert.equal(host.failed, true);
  assert.match(host.failureMessage!, /Azure Chaos Studio task failed/);
});

test('runAzurePipelinesTask: an UNEXPECTED throw from the orchestrator fails the task deterministically (defensive)', async () => {
  const host = new FakeTaskHost();
  const result = await runAzurePipelinesTask({
    host,
    cred: new FakeTokenCredentialProvider(),
    signal: new AbortController().signal,
    orchestrate: () => Promise.reject(new Error('kaboom')),
  });
  assert.equal(result.success, false);
  assert.equal(host.failed, true);
  assert.equal(host.failureMessage, 'kaboom');
});

test('runAzurePipelinesTask: the injected signal and default systemClock are wired into the RunContext', async () => {
  const host = new FakeTaskHost();
  const controller = new AbortController();
  const orch = capturingOrchestrator({ success: true, outputs: {} });
  await runAzurePipelinesTask({
    host,
    cred: new FakeTokenCredentialProvider(),
    signal: controller.signal,
    orchestrate: orch.fn,
  });
  assert.equal(orch.seen.io!.signal, controller.signal, 'the cancellation signal is threaded to the core');
  assert.equal(orch.seen.io!.clock, systemClock, 'the default wall-clock is supplied to the core');
});

test('systemClock.sleep resolves after the delay and rejects promptly on abort without leaking a timer', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });

  // Resolves once the virtual clock advances past the delay.
  const done = systemClock.sleep(10_000, new AbortController().signal);
  t.mock.timers.tick(10_000);
  await done;

  // Aborting mid-sleep rejects with an AbortError and clears the timer.
  const controller = new AbortController();
  const pending = systemClock.sleep(10_000, controller.signal);
  controller.abort();
  await assert.rejects(pending, (e: Error) => e.name === 'AbortError');

  // An already-aborted signal rejects immediately.
  await assert.rejects(
    () => systemClock.sleep(10_000, controller.signal),
    (e: Error) => e.name === 'AbortError',
  );
});
