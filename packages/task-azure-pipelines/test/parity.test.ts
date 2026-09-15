import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { RunContext } from '../../core/src/contract.ts';
import { orchestrate } from '../../core/src/orchestrator.ts';
import { runAzurePipelinesTask } from '../src/adapter.ts';
import { FakeTaskHost, FakeTokenCredentialProvider } from './fake-host.ts';
import { FakeClock, FakeTransport, fixedRng, fixtureResponses } from '../../core/test/helpers/harness.ts';

/**
 * Canonical inputs keyed by the task.json wire names (camelCase). These are the
 * Azure Pipelines equivalents of the GitHub adapter's kebab-case inputs; driving
 * the SAME real core over the SAME fake transport must yield IDENTICAL canonical
 * outputs and the SAME pass/fail decision as the GitHub adapter (G3 parity).
 */
const BASE_INPUTS = {
  subscriptionId: '11111111-1111-1111-1111-111111111111',
  resourceGroup: 'rg-chaos',
  workspaceName: 'ws-demo',
  scenarioName: 'scn-demo',
  scenarioConfigurationName: 'cfg-demo',
};

/** Drive the adapter with the REAL core over a fake transport + fake clock. */
function runWithCore(host: FakeTaskHost, transport: FakeTransport, clock: FakeClock) {
  return runAzurePipelinesTask({
    host,
    cred: new FakeTokenCredentialProvider(),
    signal: new AbortController().signal,
    clock,
    orchestrate: (io: RunContext) => orchestrate(io, transport, { rng: fixedRng(0.5) }),
  });
}

test('parity: validate-only success drives the real core and emits the canonical outputs on the task host, no failure', async () => {
  const clock = new FakeClock();
  const transport = new FakeTransport()
    .on('POST', '/validate', fixtureResponses('validate', 'accept-202.json'))
    .on('GET', '/validations/latest', fixtureResponses('validate', 'validation-succeeded-200.json'));
  const host = new FakeTaskHost({ ...BASE_INPUTS, mode: 'validate-only' });

  const result = await runWithCore(host, transport, clock);

  assert.equal(result.success, true, 'the core reports success');
  assert.equal(host.failed, false, 'a successful validation does not fail the task');
  // Canonical outputs emitted through the task output setter — identical names to
  // the GitHub adapter (NFR5/G3): validate-only sets validation-state + correlation.
  assert.equal(host.outputs['validation-state'], 'Succeeded');
  assert.ok(host.outputs['correlation-id'], 'correlation-id output is set');
  assert.ok(host.outputs['request-id'], 'request-id output is set');
  assert.equal(host.outputs['run-id'], undefined, 'no run outputs in validate-only');
});

test('parity: a terminal Failed run fails the task with the core failure reason and emits run outputs (fail parity, VF10)', async () => {
  const clock = new FakeClock();
  const transport = new FakeTransport()
    .on('POST', '/execute', fixtureResponses('execute', 'accept-202.json'))
    .on('GET', '/runs/', fixtureResponses('execute', 'run-failed-200.json'));
  const host = new FakeTaskHost({ ...BASE_INPUTS, mode: 'execute-only' });

  const result = await runWithCore(host, transport, clock);

  assert.equal(result.success, false);
  assert.equal(host.failed, true, 'a failed run fails the task');
  assert.equal(host.outputs['run-id'], '22222222-2222-2222-2222-222222222222');
  assert.equal(host.outputs['run-state'], 'Failed');
  assert.equal(host.outputs['completed-at'], '2026-05-01T12:04:30Z', 'completed-at is emitted for a normally observed Failed terminal run (R4)');
  assert.match(host.failureMessage!, /run-failed/, 'the task failure carries the core category');
  assert.match(host.failureMessage!, /InternalExecutionError/, 'the customer-actionable ARM error code is preserved');
});

test('parity: an invalid identifier fails the task with no ARM calls (FR14 fail-closed)', async () => {
  const clock = new FakeClock();
  const transport = new FakeTransport(); // no routes → any call would throw
  const host = new FakeTaskHost({ ...BASE_INPUTS, subscriptionId: 'not-a-guid', mode: 'validate-only' });

  const result = await runWithCore(host, transport, clock);

  assert.equal(result.success, false);
  assert.equal(host.failed, true);
  assert.match(host.failureMessage!, /identifier/);
  assert.equal(transport.requests.length, 0, 'no ARM request was issued for a malformed identifier');
});

test('parity: a malformed waitForCompletion value fails the task BEFORE execution with no ARM calls (no silent disable)', async () => {
  const clock = new FakeClock();
  const transport = new FakeTransport(); // no routes → any call would throw
  const host = new FakeTaskHost({ ...BASE_INPUTS, mode: 'execute-only', waitForCompletion: 'tru' });

  const result = await runWithCore(host, transport, clock);

  assert.equal(result.success, false, 'a typo must not silently disable waiting — it fails the run');
  assert.equal(host.failed, true);
  assert.match(host.failureMessage!, /identifier/, 'input parse errors are identifier failures (never trigger cleanup)');
  assert.match(host.failureMessage!, /wait-for-completion/, 'the offending canonical input is named');
  assert.equal(transport.requests.length, 0, 'no ARM request was issued — the run never started');
});

test('parity: a malformed cancelOnTimeoutOrCancellation value fails the task BEFORE execution with no ARM calls', async () => {
  const clock = new FakeClock();
  const transport = new FakeTransport(); // no routes → any call would throw
  const host = new FakeTaskHost({ ...BASE_INPUTS, mode: 'execute-only', cancelOnTimeoutOrCancellation: 'nope' });

  const result = await runWithCore(host, transport, clock);

  assert.equal(result.success, false);
  assert.equal(host.failed, true);
  assert.match(host.failureMessage!, /identifier/);
  assert.match(host.failureMessage!, /cancel-on-timeout-or-cancellation/, 'the offending canonical input is named');
  assert.equal(transport.requests.length, 0, 'no ARM request was issued — the run never started');
});

test('parity: the ARM bearer token the core hands the logger is masked via tl.setSecret, never emitted as an output', async () => {
  const clock = new FakeClock();
  const transport = new FakeTransport()
    .on('POST', '/validate', fixtureResponses('validate', 'accept-202.json'))
    .on('GET', '/validations/latest', fixtureResponses('validate', 'validation-succeeded-200.json'));
  const host = new FakeTaskHost({ ...BASE_INPUTS, mode: 'validate-only' });
  const cred = new FakeTokenCredentialProvider('a-real-looking-bearer-token');

  await runAzurePipelinesTask({
    host,
    cred,
    signal: new AbortController().signal,
    clock,
    orchestrate: (io: RunContext) => orchestrate(io, transport, { rng: fixedRng(0.5) }),
  });

  assert.ok(host.masked.includes('a-real-looking-bearer-token'), 'the core masked the token via setSecret');
  assert.ok(
    !Object.values(host.outputs).some((v) => v.includes('a-real-looking-bearer-token')),
    'the token never appears in any scalar output',
  );
});
