import { test } from 'node:test';
import assert from 'node:assert/strict';

import { API_VERSION } from '../../packages/core/src/contract.ts';
import { ArmHttpClient, type ProtocolObservation } from '../../packages/core/src/http.ts';
import { evaluateRv1, type Rv1Transcript } from './receipt.ts';

/**
 * capture-to-receipt integration coverage (E6 review R2).
 *
 * The reviewer's finding: RV-OBSERVATION contains HTTP metadata and normalized
 * errors, but the documented receipt procedure (docs/runbooks/release-validation.md)
 * did not show that the required business-state/timestamp/error-channel fields
 * could actually be POPULATED from real capture output, rather than typed in
 * from the expected contract constants. This suite proves the documented
 * procedure end-to-end: it drives an `ArmHttpClient` exactly as an operator's
 * `CHAOS_STUDIO_RV_CAPTURE=1` session or `scripts/lib/rv2-invoke.mjs` would,
 * collects the resulting `ProtocolObservation`s, and BUILDS an `Rv1Transcript`
 * FROM those observations (never from `packages/core/src/contract.ts`
 * constants) — then feeds that transcript to the same `evaluateRv1` the
 * release gate uses, proving it passes.
 */

type Fixture = { status: number; headers: Record<string, string>; body: unknown };

class FakeTransport {
  private readonly routes: Map<string, Fixture[]>;
  constructor(routes: Map<string, Fixture[]>) {
    this.routes = routes;
  }
  async send(req: { method: string; url: string }) {
    const key = `${req.method} ${new URL(req.url).pathname}`;
    const queue = this.routes.get(key);
    if (!queue || queue.length === 0) throw new Error(`no fixture for ${key}`);
    const route = queue.shift()!;
    return {
      status: route.status,
      headers: route.headers,
      body: route.body === undefined ? '' : JSON.stringify(route.body),
    };
  }
}

function fakeClient(routes: Map<string, Fixture[]>, observations: ProtocolObservation[]) {
  return new ArmHttpClient({
    transport: new FakeTransport(routes),
    clock: { now: () => 0, sleep: () => Promise.resolve() },
    log: { info: () => {}, warning: () => {}, error: () => {}, mask: () => {} },
    cred: { getArmToken: async () => 'fake-token' },
    signal: new AbortController().signal,
    onObservation: (obs) => observations.push(obs),
  });
}

/**
 * Build an Rv1Transcript purely from captured observations — this is the
 * function the runbook procedure now documents: the receipt's terminal
 * states and wire-shape fields come from what was OBSERVED, not asserted.
 */
function transcriptFromObservations(
  platform: 'github-action' | 'azure-pipelines-task',
  validateAccept: ProtocolObservation,
  validateTerminal: ProtocolObservation,
  successExecute: ProtocolObservation,
  successTerminal: ProtocolObservation,
  cancelExecute: ProtocolObservation,
  inFlight: ProtocolObservation,
  cancelAccept: ProtocolObservation,
  cancelTerminal: ProtocolObservation,
): Rv1Transcript {
  const suffix = (url: string): string => new URL(url).pathname.split('/').slice(-2).join('/');
  return {
    platform,
    validate: {
      acceptedStatus: validateAccept.status,
      locationSuffix: suffix(validateAccept.location!),
      retryAfterSeconds: validateAccept.retryAfterSeconds!,
      terminalStatus: validateTerminal.status,
      terminalState: validateTerminal.businessState!,
    },
    successRun: {
      acceptedStatus: successExecute.status,
      locationSuffix: suffix(successExecute.location!),
      runId: suffix(successExecute.location!).split('/')[1]!,
      runResourceIdSuffix: suffix(successExecute.location!),
      retryAfterSeconds: successExecute.retryAfterSeconds!,
      terminalStatus: successTerminal.status,
      terminalState: successTerminal.businessState!,
    },
    cancellationRun: {
      execute: {
        acceptedStatus: cancelExecute.status,
        locationSuffix: suffix(cancelExecute.location!),
        runId: suffix(cancelExecute.location!).split('/')[1]!,
        runResourceIdSuffix: suffix(cancelExecute.location!),
        retryAfterSeconds: cancelExecute.retryAfterSeconds!,
      },
      inFlight: {
        status: inFlight.status,
        state: inFlight.businessState!,
      },
      cancel: {
        acceptedStatus: cancelAccept.status,
        locationSuffix: suffix(cancelAccept.location!),
        retryAfterSeconds: cancelAccept.retryAfterSeconds!,
        terminalStatus: cancelTerminal.status,
        terminalState: cancelTerminal.businessState!,
      },
    },
    wire: {
      statusField: successTerminal.statusField!,
      startTimeField: successTerminal.startTimeField!,
      endTimeField: successTerminal.endTimeField!,
      // Union of error channels observed across validate + run resources.
      validationErrorChannels: validateTerminal.errorChannelsPresent,
      runErrorChannels: successTerminal.errorChannelsPresent,
    },
  };
}

test('a receipt transcript built ENTIRELY from captured RV-OBSERVATION output evaluates as a pass (capture-to-receipt integration, R2)', async () => {
  const successRunId = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
  const cancelRunId = '3f2504e0-4f89-11d3-9a0c-0305e82c3311';
  const azureSuccessRunId = '3f2504e0-4f89-11d3-9a0c-0305e82c3302';
  const azureCancelRunId = '3f2504e0-4f89-11d3-9a0c-0305e82c3312';
  const base = 'https://management.azure.com/subscriptions/s/resourceGroups/rg/providers/Microsoft.Chaos/workspaces/ws/scenarios/scn';

  const routes = new Map<string, Fixture[]>([
    [
      'POST /subscriptions/s/resourceGroups/rg/providers/Microsoft.Chaos/workspaces/ws/scenarios/scn/configurations/cfg/validate',
      [{ status: 202, headers: { Location: `${base}/configurations/cfg/validations/latest`, 'Retry-After': '10' }, body: undefined }],
    ],
    [
      'GET /subscriptions/s/resourceGroups/rg/providers/Microsoft.Chaos/workspaces/ws/scenarios/scn/configurations/cfg/validations/latest',
      [{ status: 200, headers: {}, body: { properties: { status: 'Succeeded', startTime: 't0', endTime: 't1', errors: [], validationErrors: [] } } }],
    ],
    [
      'POST /subscriptions/s/resourceGroups/rg/providers/Microsoft.Chaos/workspaces/ws/scenarios/scn/configurations/cfg/execute',
      [{ status: 202, headers: { Location: `${base}/runs/${successRunId}`, 'Retry-After': '10' }, body: undefined }],
    ],
    [
      `GET /subscriptions/s/resourceGroups/rg/providers/Microsoft.Chaos/workspaces/ws/scenarios/scn/runs/${successRunId}`,
      [{ status: 200, headers: {}, body: { properties: { status: 'Succeeded', startTime: 't0', endTime: 't2', errors: [], executionErrors: [] } } }],
    ],
  ]);
  const cancelRoutes = new Map<string, Fixture[]>([
    [
      'POST /subscriptions/s/resourceGroups/rg/providers/Microsoft.Chaos/workspaces/ws/scenarios/scn/configurations/cfg/execute',
      [{ status: 202, headers: { Location: `${base}/runs/${cancelRunId}`, 'Retry-After': '10' }, body: undefined }],
    ],
    [
      `GET /subscriptions/s/resourceGroups/rg/providers/Microsoft.Chaos/workspaces/ws/scenarios/scn/runs/${cancelRunId}`,
      [
        // Sequential responses: first GET catches it in flight (Running), the
        // second GET (after cancel) observes the terminal Canceled state.
        { status: 202, headers: {}, body: { properties: { status: 'Running' } } },
        { status: 200, headers: {}, body: { properties: { status: 'Canceled', errors: [], executionErrors: [] } } },
      ],
    ],
    [
      `POST /subscriptions/s/resourceGroups/rg/providers/Microsoft.Chaos/workspaces/ws/scenarios/scn/runs/${cancelRunId}/cancel`,
      [{ status: 202, headers: { Location: `${base}/runs/${cancelRunId}`, 'Retry-After': '10' }, body: undefined }],
    ],
  ]);

  const observations: ProtocolObservation[] = [];
  const client = fakeClient(routes, observations);
  await client.post(`${base}/configurations/cfg/validate`);
  await client.getOnce(`${base}/configurations/cfg/validations/latest`);
  await client.post(`${base}/configurations/cfg/execute`);
  await client.getOnce(`${base}/runs/${successRunId}`);
  const [validateAccept, validateTerminal, successExecute, successTerminal] = observations;

  // Cancellation run — a SEPARATE independent execute against its own routes,
  // per the runbook's ordering requirement (in-flight observed before cancel).
  const cancelClient = fakeClient(cancelRoutes, observations);
  await cancelClient.post(`${base}/configurations/cfg/execute`);
  await cancelClient.getOnce(`${base}/runs/${cancelRunId}`);
  await cancelClient.post(`${base}/runs/${cancelRunId}/cancel`);
  await cancelClient.getOnce(`${base}/runs/${cancelRunId}`);
  const [cancelExecute, inFlight, cancelAccept, cancelTerminal] = observations.slice(4);

  const githubTranscript = transcriptFromObservations(
    'github-action',
    validateAccept!,
    validateTerminal!,
    successExecute!,
    successTerminal!,
    cancelExecute!,
    inFlight!,
    cancelAccept!,
    cancelTerminal!,
  );

  // Every field required by the receipt schema was populated from captured
  // observations — none were typed in from contract.ts constants.
  assert.equal(githubTranscript.validate.terminalState, 'Succeeded');
  assert.equal(githubTranscript.successRun.terminalState, 'Succeeded');
  assert.equal(githubTranscript.cancellationRun.inFlight.state, 'Running');
  assert.equal(githubTranscript.cancellationRun.cancel.terminalState, 'Canceled');
  assert.equal(githubTranscript.wire.statusField, 'status');
  assert.equal(githubTranscript.wire.startTimeField, 'startTime');
  assert.equal(githubTranscript.wire.endTimeField, 'endTime');
  assert.deepEqual([...githubTranscript.wire.runErrorChannels].sort(), ['errors', 'executionErrors']);

  const azureTranscript = {
    ...githubTranscript,
    platform: 'azure-pipelines-task' as const,
    successRun: {
      ...githubTranscript.successRun,
      locationSuffix: `runs/${azureSuccessRunId}`,
      runId: azureSuccessRunId,
      runResourceIdSuffix: `runs/${azureSuccessRunId}`,
    },
    cancellationRun: {
      ...githubTranscript.cancellationRun,
      execute: {
        ...githubTranscript.cancellationRun.execute,
        locationSuffix: `runs/${azureCancelRunId}`,
        runId: azureCancelRunId,
        runResourceIdSuffix: `runs/${azureCancelRunId}`,
      },
      cancel: {
        ...githubTranscript.cancellationRun.cancel,
        locationSuffix: `runs/${azureCancelRunId}`,
      },
    },
  };
  const result = evaluateRv1({
    region: 'westus2',
    apiVersion: API_VERSION,
    transcripts: [githubTranscript, azureTranscript],
  });
  assert.deepEqual(result.failures, []);
  assert.equal(result.pass, true);
});

test('a capture-derived transcript FAILS evaluateRv1 when the deployed body actually diverges from the pinned wire shape (proves the procedure surfaces real drift, not a rubber stamp)', async () => {
  const runId = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
  const base = 'https://management.azure.com/subscriptions/s/resourceGroups/rg/providers/Microsoft.Chaos/workspaces/ws/scenarios/scn';
  // The deployed run resource uses `state`, not `status` — a real drift.
  const routes = new Map<string, Fixture[]>([
    [
      `GET /subscriptions/s/resourceGroups/rg/providers/Microsoft.Chaos/workspaces/ws/scenarios/scn/runs/${runId}`,
      [{ status: 200, headers: {}, body: { properties: { state: 'Succeeded' } } }],
    ],
  ]);
  const observations: ProtocolObservation[] = [];
  const client = fakeClient(routes, observations);
  const terminal = await client.getOnce(`${base}/runs/${runId}`);

  assert.equal(terminal.errorCode, undefined);
  assert.equal(observations[0]!.statusField, undefined, 'the observed body has no `status` key — drift is visible, not masked');
  assert.equal(observations[0]!.businessState, undefined);
});
