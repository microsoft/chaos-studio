import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { RunContext } from '../../core/src/contract.ts';
import { orchestrate } from '../../core/src/orchestrator.ts';
import { runGithubAction } from '../src/adapter.ts';
import { FakeActionsHost, FakeTokenCredentialProvider } from './fake-host.ts';
import { FakeClock, FakeTransport, fixedRng, fixtureResponses } from '../../core/test/helpers/harness.ts';

/** Canonical inputs keyed by the action.yml wire names (== INPUT_NAMES). */
const BASE_INPUTS = {
  'subscription-id': '11111111-1111-1111-1111-111111111111',
  'resource-group': 'rg-chaos',
  'workspace-name': 'ws-demo',
  'scenario-name': 'scn-demo',
  'scenario-configuration-name': 'cfg-demo',
};

/** Drive the adapter with the REAL core over a fake transport + fake clock. */
function runWithCore(host: FakeActionsHost, transport: FakeTransport, clock: FakeClock) {
  return runGithubAction({
    host,
    cred: new FakeTokenCredentialProvider(),
    signal: new AbortController().signal,
    clock,
    orchestrate: (io: RunContext) => orchestrate(io, transport, { rng: fixedRng(0.5) }),
  });
}

test('parity: validate-only success drives the real core and emits the canonical outputs on the GitHub host, no setFailed', async () => {
  const clock = new FakeClock();
  const transport = new FakeTransport()
    .on('POST', '/validate', fixtureResponses('validate', 'accept-202.json'))
    .on('GET', '/validations/latest', fixtureResponses('validate', 'validation-succeeded-200.json'));
  const host = new FakeActionsHost({ ...BASE_INPUTS, mode: 'validate-only' });

  const result = await runWithCore(host, transport, clock);

  assert.equal(result.success, true, 'the core reports success');
  assert.equal(host.failed, false, 'a successful validation does not fail the GitHub step');
  // Canonical outputs are emitted through the GitHub output setter, identical to
  // the core contract (NFR5): validate-only sets validation-state + correlation.
  assert.equal(host.outputs['validation-state'], 'Succeeded');
  assert.ok(host.outputs['correlation-id'], 'correlation-id output is set');
  assert.ok(host.outputs['request-id'], 'request-id output is set');
  assert.equal(host.outputs['run-id'], undefined, 'no run outputs in validate-only');
});

test('parity: a terminal Failed run fails the GitHub step with the core failure reason and emits run outputs (fail parity, VF10)', async () => {
  const clock = new FakeClock();
  const transport = new FakeTransport()
    .on('POST', '/execute', fixtureResponses('execute', 'accept-202.json'))
    .on('GET', '/runs/', fixtureResponses('execute', 'run-failed-200.json'));
  const host = new FakeActionsHost({ ...BASE_INPUTS, mode: 'execute-only' });

  const result = await runWithCore(host, transport, clock);

  assert.equal(result.success, false);
  assert.equal(host.failed, true, 'a failed run fails the GitHub step');
  assert.equal(host.outputs['run-id'], '22222222-2222-2222-2222-222222222222');
  assert.equal(host.outputs['run-state'], 'Failed');
  assert.equal(host.outputs['completed-at'], undefined, 'completed-at is a success-only output (D11)');
  assert.equal(host.failures.length, 1);
  assert.match(host.failures[0]!, /run-failed/, 'the GitHub failure carries the core category');
  assert.match(host.failures[0]!, /InternalExecutionError/, 'the customer-actionable ARM error code is preserved');
});

test('parity: an invalid identifier fails the GitHub step with no ARM calls (FR14 fail-closed)', async () => {
  const clock = new FakeClock();
  const transport = new FakeTransport(); // no routes → any call would throw
  const host = new FakeActionsHost({ ...BASE_INPUTS, 'subscription-id': 'not-a-guid', mode: 'validate-only' });

  const result = await runWithCore(host, transport, clock);

  assert.equal(result.success, false);
  assert.equal(host.failed, true);
  assert.match(host.failures[0]!, /identifier/);
  assert.equal(transport.requests.length, 0, 'no ARM request was issued for a malformed identifier');
});

test('parity: a malformed wait-for-completion value fails the step BEFORE execution with no ARM calls (no silent disable)', async () => {
  const clock = new FakeClock();
  const transport = new FakeTransport(); // no routes → any call would throw
  const host = new FakeActionsHost({ ...BASE_INPUTS, mode: 'execute-only', 'wait-for-completion': 'tru' });

  const result = await runWithCore(host, transport, clock);

  assert.equal(result.success, false, 'a typo must not silently disable waiting — it fails the run');
  assert.equal(host.failed, true);
  assert.match(host.failures[0]!, /identifier/, 'input parse errors are identifier failures (never trigger cleanup)');
  assert.match(host.failures[0]!, /wait-for-completion/, 'the offending input is named');
  assert.equal(transport.requests.length, 0, 'no ARM request was issued — the run never started');
});

test('parity: a malformed cancel-on-timeout-or-cancellation value fails the step BEFORE execution with no ARM calls', async () => {
  const clock = new FakeClock();
  const transport = new FakeTransport(); // no routes → any call would throw
  const host = new FakeActionsHost({
    ...BASE_INPUTS,
    mode: 'execute-only',
    'cancel-on-timeout-or-cancellation': 'nope',
  });

  const result = await runWithCore(host, transport, clock);

  assert.equal(result.success, false, 'a typo must not silently disable cancellation — it fails the run');
  assert.equal(host.failed, true);
  assert.match(host.failures[0]!, /identifier/);
  assert.match(host.failures[0]!, /cancel-on-timeout-or-cancellation/, 'the offending input is named');
  assert.equal(transport.requests.length, 0, 'no ARM request was issued — the run never started');
});

test('parity: the ARM bearer token the core hands the logger is masked via ::add-mask::, never emitted as an output', async () => {
  const clock = new FakeClock();
  const transport = new FakeTransport()
    .on('POST', '/validate', fixtureResponses('validate', 'accept-202.json'))
    .on('GET', '/validations/latest', fixtureResponses('validate', 'validation-succeeded-200.json'));
  const host = new FakeActionsHost({ ...BASE_INPUTS, mode: 'validate-only' });
  const cred = new FakeTokenCredentialProvider('a-real-looking-bearer-token');

  await runGithubAction({
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
