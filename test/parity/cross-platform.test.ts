import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { RunContext } from '../../packages/core/src/contract.ts';
import { INPUT_NAMES } from '../../packages/core/src/contract.ts';
import { orchestrate } from '../../packages/core/src/orchestrator.ts';

import { runGithubAction } from '../../packages/action-github/src/adapter.ts';
import { FakeActionsHost } from '../../packages/action-github/test/fake-host.ts';
import { runAzurePipelinesTask } from '../../packages/task-azure-pipelines/src/adapter.ts';
import { FakeTaskHost } from '../../packages/task-azure-pipelines/test/fake-host.ts';

import {
  FakeClock,
  FakeCredential,
  FakeTransport,
  fixedRng,
  fixtureResponses,
} from '../../packages/core/test/helpers/harness.ts';

/**
 * E5-T1 — CROSS-PLATFORM parity suite. The GitHub Action adapter (E3) and the
 * Azure Pipelines task adapter (E4) are thin wrappers over the SAME E2 core, so
 * given IDENTICAL recorded ARM responses they must produce IDENTICAL observable
 * behavior (G3, NFR5): the same canonical scalar outputs, the same pass/fail
 * result, the same cancellation handling, and the same diagnostics
 * (correlation/request IDs + token masking).
 *
 * Scope: this is ADAPTER-BOUNDARY parity — it drives each adapter's pure
 * `run*` entry (readers/setters/logger/result-mapping) over the real core and a
 * shared fake transport, asserting the two agree with each other. It deliberately
 * does NOT exercise the platform SDK composition roots (host.ts/index.ts) or
 * live network; those are covered by each adapter's own tests. Deterministic:
 * fake transport + fake clock + fake credential, no network/SDK/wall-clock (NFR2).
 */

const FIXED_TOKEN = 'parity-arm-bearer-token';

/** Logical inputs, platform-agnostic. Each adapter receives its native key form. */
interface LogicalInputs {
  subscriptionId: string;
  resourceGroup: string;
  workspaceName: string;
  scenarioName: string;
  scenarioConfigurationName: string;
  mode?: string;
  waitForCompletion?: string;
  completionTimeoutSeconds?: string;
  cancelOnTimeoutOrCancellation?: string;
}

const BASE: LogicalInputs = {
  subscriptionId: '11111111-1111-1111-1111-111111111111',
  resourceGroup: 'rg-chaos',
  workspaceName: 'ws-demo',
  scenarioName: 'scn-demo',
  scenarioConfigurationName: 'cfg-demo',
};

/** GitHub inputs use the canonical kebab wire names (== INPUT_NAMES, action.yml). */
function githubInputs(v: LogicalInputs): Record<string, string> {
  const out: Record<string, string> = {
    [INPUT_NAMES.subscriptionId]: v.subscriptionId,
    [INPUT_NAMES.resourceGroup]: v.resourceGroup,
    [INPUT_NAMES.workspaceName]: v.workspaceName,
    [INPUT_NAMES.scenarioName]: v.scenarioName,
    [INPUT_NAMES.scenarioConfigurationName]: v.scenarioConfigurationName,
  };
  if (v.mode !== undefined) out[INPUT_NAMES.mode] = v.mode;
  if (v.waitForCompletion !== undefined) out[INPUT_NAMES.waitForCompletion] = v.waitForCompletion;
  if (v.completionTimeoutSeconds !== undefined) out[INPUT_NAMES.completionTimeoutSeconds] = v.completionTimeoutSeconds;
  if (v.cancelOnTimeoutOrCancellation !== undefined) {
    out[INPUT_NAMES.cancelOnTimeoutOrCancellation] = v.cancelOnTimeoutOrCancellation;
  }
  return out;
}

/** Azure Pipelines inputs use the task.json camelCase names. */
function adoInputs(v: LogicalInputs): Record<string, string> {
  const out: Record<string, string> = {
    subscriptionId: v.subscriptionId,
    resourceGroup: v.resourceGroup,
    workspaceName: v.workspaceName,
    scenarioName: v.scenarioName,
    scenarioConfigurationName: v.scenarioConfigurationName,
  };
  if (v.mode !== undefined) out['mode'] = v.mode;
  if (v.waitForCompletion !== undefined) out['waitForCompletion'] = v.waitForCompletion;
  if (v.completionTimeoutSeconds !== undefined) out['completionTimeoutSeconds'] = v.completionTimeoutSeconds;
  if (v.cancelOnTimeoutOrCancellation !== undefined) out['cancelOnTimeoutOrCancellation'] = v.cancelOnTimeoutOrCancellation;
  return out;
}

/** The platform-agnostic observable outcome we compare across adapters. */
interface Observed {
  outputs: Record<string, string>;
  failed: boolean;
  failureReason: string | undefined;
  masked: string[];
}

/** A factory yields a FRESH scripted transport (replies are consumed per run). */
type TransportFactory = () => FakeTransport;

async function runGithub(inputs: LogicalInputs, makeTransport: TransportFactory, signal: AbortSignal): Promise<Observed> {
  const host = new FakeActionsHost(githubInputs(inputs));
  const transport = makeTransport();
  await runGithubAction({
    host,
    cred: new FakeCredential(FIXED_TOKEN),
    signal,
    clock: new FakeClock(),
    orchestrate: (io: RunContext) => orchestrate(io, transport, { rng: fixedRng(0.5) }),
  });
  return { outputs: host.outputs, failed: host.failed, failureReason: host.failures[0], masked: host.masked };
}

async function runAdo(inputs: LogicalInputs, makeTransport: TransportFactory, signal: AbortSignal): Promise<Observed> {
  const host = new FakeTaskHost(adoInputs(inputs));
  const transport = makeTransport();
  await runAzurePipelinesTask({
    host,
    cred: new FakeCredential(FIXED_TOKEN),
    signal,
    clock: new FakeClock(),
    orchestrate: (io: RunContext) => orchestrate(io, transport, { rng: fixedRng(0.5) }),
  });
  return { outputs: host.outputs, failed: host.failed, failureReason: host.failureMessage, masked: host.masked };
}

/**
 * Assert the two adapters produced equivalent observable behavior: identical
 * canonical outputs, identical pass/fail, identical failure reason, and both
 * masked the ARM token (diagnostics parity).
 */
function assertParity(gh: Observed, ado: Observed): void {
  assert.deepEqual(ado.outputs, gh.outputs, 'canonical scalar outputs are identical across platforms');
  assert.equal(ado.failed, gh.failed, 'pass/fail result is identical across platforms');
  assert.equal(ado.failureReason, gh.failureReason, 'the failure reason is identical across platforms');
  assert.ok(gh.masked.includes(FIXED_TOKEN), 'GitHub masked the ARM token');
  assert.ok(ado.masked.includes(FIXED_TOKEN), 'Azure Pipelines masked the ARM token');
}

const validateOnlyTransport: TransportFactory = () =>
  new FakeTransport()
    .on('POST', '/validate', fixtureResponses('validate', 'accept-202.json'))
    .on('GET', '/validations/latest', fixtureResponses('validate', 'validation-succeeded-200.json'));

const validateAndExecuteTransport: TransportFactory = () =>
  new FakeTransport()
    .on('POST', '/validate', fixtureResponses('validate', 'accept-202.json'))
    .on('GET', '/validations/latest', fixtureResponses('validate', 'validation-succeeded-200.json'))
    .on('POST', '/execute', fixtureResponses('execute', 'accept-202.json'))
    .on('GET', '/runs/', fixtureResponses('execute', 'run-succeeded-200.json'));

const executeFailedTransport: TransportFactory = () =>
  new FakeTransport()
    .on('POST', '/execute', fixtureResponses('execute', 'accept-202.json'))
    .on('GET', '/runs/', fixtureResponses('execute', 'run-failed-200.json'));

const executeNoWaitTransport: TransportFactory = () =>
  new FakeTransport().on('POST', '/execute', fixtureResponses('execute', 'accept-202.json'));

test('parity: validate-only success ⇒ identical canonical outputs, pass, masking on both platforms', async () => {
  const inputs = { ...BASE, mode: 'validate-only' };
  const sig = new AbortController().signal;
  const gh = await runGithub(inputs, validateOnlyTransport, sig);
  const ado = await runAdo(inputs, validateOnlyTransport, sig);

  assertParity(gh, ado);
  assert.equal(gh.failed, false);
  assert.equal(gh.outputs['validation-state'], 'Succeeded');
  assert.ok(gh.outputs['correlation-id'] && gh.outputs['request-id'], 'diagnostics IDs are emitted');
});

test('parity: validate-and-execute success ⇒ identical run outputs, pass, masking on both platforms', async () => {
  const inputs = { ...BASE, mode: 'validate-and-execute' };
  const sig = new AbortController().signal;
  const gh = await runGithub(inputs, validateAndExecuteTransport, sig);
  const ado = await runAdo(inputs, validateAndExecuteTransport, sig);

  assertParity(gh, ado);
  assert.equal(gh.failed, false);
  assert.equal(gh.outputs['run-state'], 'Succeeded');
  assert.ok(gh.outputs['run-id'], 'run-id output is set on success');
});

test('parity: a terminal Failed run ⇒ identical fail result + identical failure reason on both platforms', async () => {
  const inputs = { ...BASE, mode: 'execute-only' };
  const sig = new AbortController().signal;
  const gh = await runGithub(inputs, executeFailedTransport, sig);
  const ado = await runAdo(inputs, executeFailedTransport, sig);

  assertParity(gh, ado);
  assert.equal(gh.failed, true);
  assert.equal(gh.outputs['run-state'], 'Failed');
});

test('parity: execute-only no-wait ⇒ identical last-observed outputs and pass on both platforms', async () => {
  const inputs = { ...BASE, mode: 'execute-only', waitForCompletion: 'false' };
  const sig = new AbortController().signal;
  const gh = await runGithub(inputs, executeNoWaitTransport, sig);
  const ado = await runAdo(inputs, executeNoWaitTransport, sig);

  assertParity(gh, ado);
  assert.equal(gh.failed, false, 'no-wait passes as soon as the run is started');
  assert.equal(gh.outputs['completed-at'], undefined, 'no completed-at without waiting');
});

test('parity: an invalid identifier fails closed identically with zero ARM calls on both platforms', async () => {
  const inputs = { ...BASE, subscriptionId: 'not-a-guid', mode: 'validate-only' };
  const sig = new AbortController().signal;

  // Track ARM calls per platform via wrapping transport factories.
  let ghCalls = 0;
  let adoCalls = 0;
  const ghT: TransportFactory = () => new FakeTransport(() => { ghCalls += 1; });
  const adoT: TransportFactory = () => new FakeTransport(() => { adoCalls += 1; });

  const gh = await runGithub(inputs, ghT, sig);
  const ado = await runAdo(inputs, adoT, sig);

  assert.equal(gh.failed, true);
  assert.equal(ado.failed, true);
  assert.equal(gh.failureReason, ado.failureReason, 'identical identifier failure reason');
  assert.match(gh.failureReason!, /identifier/);
  assert.equal(ghCalls, 0, 'GitHub issued no ARM request');
  assert.equal(adoCalls, 0, 'Azure Pipelines issued no ARM request');
});

test('parity: an already-cancelled signal ⇒ identical cancellation handling on both platforms', async () => {
  const inputs = { ...BASE, mode: 'validate-and-execute' };
  const controller = new AbortController();
  controller.abort();

  const gh = await runGithub(inputs, validateAndExecuteTransport, controller.signal);
  const ado = await runAdo(inputs, validateAndExecuteTransport, controller.signal);

  assert.equal(gh.failed, ado.failed, 'both platforms agree on the cancellation outcome');
  assert.equal(gh.failed, true, 'a pre-cancelled signal fails the step/task');
  assert.deepEqual(ado.outputs, gh.outputs, 'identical outputs under cancellation');
  assert.equal(gh.failureReason, ado.failureReason, 'identical cancellation failure reason');
});
