/**
 * orchestrator.ts (E2-T4) — the mode dispatcher and result mapper (FR10–FR11,
 * D10–D12). It wires the identifier builder, ARM client, validation/run state
 * machines, and cancellation into the end-to-end flow behind the E1
 * {@link RunContext} boundary, and produces the canonical scalar outputs and a
 * deterministic pass/fail result.
 *
 * `run` is the public {@link RunFn} the adapters call (it uses the real
 * {@link fetchTransport}); {@link orchestrate} takes an injected transport so
 * unit tests drive the whole flow over a fake transport + fake clock (NFR2).
 */

import {
  CLEANUP_TIMEOUT_SECONDS,
  DEFAULT_MODE,
  INPUT_DEFAULTS,
  INPUT_NAMES,
  MODES,
  type Mode,
  type NormalizedError,
  type OrchestrationResult,
  type RunContext,
  type RunFn,
} from './contract.ts';
import {
  CoreError,
  executeActionUrl,
  runResourceUrl,
  validateActionUrl,
  validateScenarioCoordinates,
  type ScenarioCoordinates,
} from './ids.ts';
import { ArmHttpClient, Deadline, fetchTransport, type BackoffOptions, type IHttpTransport, type ResourceStatus } from './http.ts';
import { acceptValidate, pollValidation } from './validation.ts';
import { acceptExecute, pollRun, readRunOnce, type ExecuteAcceptance } from './run.ts';
import { bestEffortCancel } from './cancel.ts';
import { redact } from './redaction.ts';

/** Optional deterministic knobs for testing (RNG / backoff); adapters use defaults. */
export interface OrchestrateOptions {
  rng?: () => number;
  backoff?: BackoffOptions;
}

/** The public entry point the platform adapters call (E3/E4). */
export const run: RunFn = (io) => orchestrate(io, fetchTransport);

export async function orchestrate(
  io: RunContext,
  transport: IHttpTransport,
  opts: OrchestrateOptions = {},
): Promise<OrchestrationResult> {
  const outputs: Record<string, string> = {};
  const emit = (name: string, value: string | undefined): void => {
    if (value !== undefined && value !== '') {
      outputs[name] = value;
      io.output.set(name, value);
    }
  };

  // Parse + validate inputs BEFORE any network call (FR14, FR16). Failures here
  // are `identifier` errors and never trigger cleanup (no run exists).
  let mode: Mode;
  let coords: ScenarioCoordinates;
  let waitForCompletion: boolean;
  let completionTimeoutSeconds: number;
  let cancelOnTimeout: boolean;
  try {
    mode = readMode(io);
    waitForCompletion = io.input.getBool(INPUT_NAMES.waitForCompletion, INPUT_DEFAULTS.waitForCompletion);
    completionTimeoutSeconds = io.input.getInt(INPUT_NAMES.completionTimeoutSeconds, INPUT_DEFAULTS.completionTimeoutSeconds);
    cancelOnTimeout = io.input.getBool(INPUT_NAMES.cancelOnTimeoutOrCancellation, INPUT_DEFAULTS.cancelOnTimeoutOrCancellation);
    coords = readCoordinates(io);
  } catch (err) {
    return failure(io, outputs, toNormalizedError(err, false));
  }

  const client = new ArmHttpClient({
    transport,
    clock: io.clock,
    log: io.log,
    cred: io.cred,
    signal: io.signal,
    rng: opts.rng,
    backoff: opts.backoff,
  });
  const completion = Deadline.fromNow(io.clock, completionTimeoutSeconds);
  const emitCorrelation = (): void => {
    emit('correlation-id', client.lastCorrelation.correlationId);
    emit('request-id', client.lastCorrelation.requestId);
  };

  let acceptance: ExecuteAcceptance | undefined;
  // The latest run status observed during wait-mode polling — retained so a
  // completion timeout / cancellation can still emit best-effort last-observed
  // run-state/started-at even when cleanup is disabled, fails, or times out (D11).
  let lastObservedRun: ResourceStatus | undefined;

  try {
    // ----- Validate phase (skipped for execute-only) -----
    if (mode !== 'execute-only') {
      const acc = await acceptValidate(client, validateActionUrl(coords), coords, completion);
      const validation = await pollValidation(client, acc.location, completion, io.log, acc.retryAfterSeconds);
      emit('validation-state', validation.status);
      emitCorrelation();
      if (validation.disposition !== 'success') {
        return failure(io, outputs, {
          category: 'validation-failed',
          armErrorCode: validation.armErrorCode,
          armErrorMessage: validation.armErrorMessage,
          message: `validation did not succeed (terminal state ${validation.status})`,
          correlationId: validation.correlationId,
          requestId: validation.requestId,
        });
      }
    }

    // ----- Execute phase (skipped for validate-only) -----
    if (mode !== 'validate-only') {
      acceptance = await acceptExecute(client, executeActionUrl(coords), coords, completion);
      emit('run-id', acceptance.runId);
      emit('run-resource-id', acceptance.runResourceId);
      emitCorrelation();
      // Response-time expiry for execute acceptance (FR10): a run started just past
      // the completion budget times out — but only AFTER its identity is emitted
      // and `acceptance` is set, so cleanup (wait mode) can still cancel it (FR11).
      client.assertWithinDeadline(completion);
      const runUrl = runResourceUrl(acceptance.runResourceId);

      if (waitForCompletion) {
        const runOutcome = await pollRun(
          client,
          runUrl,
          completion,
          io.log,
          (rs) => {
            lastObservedRun = rs;
          },
          acceptance.retryAfterSeconds,
        );
        emit('run-state', runOutcome.status);
        emit('started-at', runOutcome.startTime);
        // completed-at is emitted for every NORMALLY OBSERVED terminal run —
        // success, Failed, or Canceled alike (D11/D12) — because the service
        // provided a real endTime for each of those terminal states. It is
        // emitted before mapping success/failure so a Failed or Canceled run's
        // completion timestamp is not lost. It stays omitted only when the
        // run was never normally observed to a terminal state at all (e.g.
        // this process's own timeout/cleanup cancellation, where no endTime
        // was observed here).
        emit('completed-at', runOutcome.endTime);
        emitCorrelation();
        if (runOutcome.disposition !== 'success') {
          return failure(io, outputs, {
            category: 'run-failed',
            armErrorCode: runOutcome.armErrorCode,
            armErrorMessage: runOutcome.armErrorMessage,
            message: `run did not succeed (terminal state ${runOutcome.status})`,
            correlationId: runOutcome.correlationId,
            requestId: runOutcome.requestId,
          });
        }
      } else {
        // No-wait: a single best-effort GET for last-observed state (D11). It
        // never fails the step — the step succeeds at STARTING the run. The
        // completion deadline bounds this observation so a hung credential or
        // transport aborts at expiry and orchestration still returns (FR10).
        try {
          const observed = await readRunOnce(client, runUrl, completion);
          emit('run-state', observed.status);
          emit('started-at', observed.startTime);
        } catch (err) {
          io.log.warning(redact(`no-wait last-observed GET failed (non-fatal): ${errText(err)}`));
        }
        emitCorrelation();
        io.log.warning(
          'wait-for-completion is disabled: this process cannot cancel the run after it exits; ' +
            'cancel the run by ID if needed',
        );
      }
    }

    return { success: true, outputs };
  } catch (err) {
    return handleForwardFailure(io, outputs, client, transport, opts, err, acceptance, lastObservedRun, waitForCompletion, cancelOnTimeout, emit);
  }
}

/**
 * Map a thrown forward-journey failure to a result, running best-effort cleanup
 * when a run exists and cancellation is enabled — WITHOUT masking the original
 * reason (FR11).
 */
async function handleForwardFailure(
  io: RunContext,
  outputs: Record<string, string>,
  client: ArmHttpClient,
  transport: IHttpTransport,
  opts: OrchestrateOptions,
  err: unknown,
  acceptance: ExecuteAcceptance | undefined,
  lastObservedRun: ResourceStatus | undefined,
  waitForCompletion: boolean,
  cancelOnTimeout: boolean,
  emit: (name: string, value: string | undefined) => void,
): Promise<OrchestrationResult> {
  const aborted = io.signal.aborted;
  const normalized = toNormalizedError(err, aborted);

  // Emit the last-observed run-state/started-at (best-effort) whenever a run
  // exists — this survives even when cleanup is disabled, fails, or times out
  // (D11). `completed-at` is NEVER set here: the run did not reach terminal
  // success. A newer cleanup observation (below) may override these.
  if (acceptance !== undefined && lastObservedRun !== undefined) {
    emit('run-state', lastObservedRun.status);
    emit('started-at', lastObservedRun.startTime);
  }

  // Cleanup applies only to a timeout/cancellation AFTER a run ID exists, when
  // enabled AND only while WAITING (D8/D9): cancel-on-timeout applies only in
  // wait mode. A validation-phase interruption has no run to cancel.
  const isInterruption = aborted || normalized.category === 'timeout';
  if (isInterruption && acceptance !== undefined && waitForCompletion && cancelOnTimeout) {
    io.log.warning(
      redact(`initiating best-effort cancel of run ${acceptance.runId}; original reason: ${normalized.message}`),
    );
    // A FRESH signal so cleanup runs even when the main signal is aborted (D9).
    const cleanupClient = new ArmHttpClient({
      transport,
      clock: io.clock,
      log: io.log,
      cred: io.cred,
      signal: new AbortController().signal,
      rng: opts.rng,
      backoff: opts.backoff,
    });
    const cleanupDeadline = Deadline.fromNow(io.clock, CLEANUP_TIMEOUT_SECONDS);
    const observed = await bestEffortCancel(cleanupClient, acceptance.runResourceId, cleanupDeadline, io.log);
    // Incorporate the NEWER cleanup observation when available (still no
    // completed-at — the forward run did not reach terminal success, D11).
    if (observed) {
      emit('run-state', observed.status);
      emit('started-at', observed.startTime);
    }
  } else if (acceptance !== undefined && !cancelOnTimeout) {
    io.log.warning(`cancel-on-timeout-or-cancellation is disabled: run ${acceptance.runId} is left running`);
  }

  return failure(io, outputs, normalized);
}

/** Read + validate the mode input; unknown/unset fails closed (FR16). */
function readMode(io: RunContext): Mode {
  const raw = io.input.get(INPUT_NAMES.mode);
  const value = raw && raw.length > 0 ? raw : DEFAULT_MODE;
  if (!(MODES as readonly string[]).includes(value)) {
    throw new CoreError('identifier', `unknown mode '${value}'; expected one of ${MODES.join(', ')}`);
  }
  return value as Mode;
}

/** Read + validate the five resource identifiers (FR14). */
function readCoordinates(io: RunContext): ScenarioCoordinates {
  const required = (name: string): string => {
    const v = io.input.get(name);
    if (v === undefined || v === '') {
      throw new CoreError('identifier', `missing required input '${name}'`);
    }
    return v;
  };
  const coords: ScenarioCoordinates = {
    subscriptionId: required(INPUT_NAMES.subscriptionId),
    resourceGroup: required(INPUT_NAMES.resourceGroup),
    workspaceName: required(INPUT_NAMES.workspaceName),
    scenarioName: required(INPUT_NAMES.scenarioName),
    scenarioConfigurationName: required(INPUT_NAMES.scenarioConfigurationName),
  };
  return validateScenarioCoordinates(coords);
}

/** Normalize any thrown value into the internal error shape (VF10, FR12). */
export function toNormalizedError(err: unknown, aborted: boolean): NormalizedError {
  if (err instanceof CoreError) {
    // Pipeline cancellation surfaces through the transport/timeout paths; group
    // it under `timeout` for internal mapping but describe it as a cancellation.
    const category = aborted && (err.category === 'transport' || err.category === 'timeout') ? 'timeout' : err.category;
    return {
      category,
      armErrorCode: err.armErrorCode,
      armErrorMessage: err.armErrorMessage === undefined ? undefined : redact(err.armErrorMessage),
      message: redact(aborted ? 'pipeline cancellation requested' : err.message),
      correlationId: err.correlationId,
      requestId: err.requestId,
    };
  }
  // A raw abort (e.g. from the clock during a sleep) under an aborted signal is a
  // cancellation, not a generic transport error.
  if (aborted) {
    return { category: 'timeout', message: redact('pipeline cancellation requested') };
  }
  return { category: 'transport', message: redact(errText(err)) };
}

/** Build a failure result, logging the redacted normalized error and its context. */
function failure(io: RunContext, outputs: Record<string, string>, normalized: NormalizedError): OrchestrationResult {
  // D11 (last-relevant-response): the correlation/request IDs of the FORWARD
  // failure are the most relevant, so they OVERWRITE any earlier acceptance
  // values still in the outputs. `normalized` is computed from the forward error
  // BEFORE any cleanup runs, so a cleanup response can never replace this context.
  if (normalized.correlationId) {
    outputs['correlation-id'] = normalized.correlationId;
    io.output.set('correlation-id', normalized.correlationId);
  }
  if (normalized.requestId) {
    outputs['request-id'] = normalized.requestId;
    io.output.set('request-id', normalized.requestId);
  }
  const parts: string[] = [normalized.category];
  if (normalized.armErrorCode) parts.push(`(${normalized.armErrorCode})`);
  let reason = `${parts.join(' ')}: ${normalized.message}`;
  if (normalized.armErrorMessage) reason += ` — ${normalized.armErrorMessage}`;
  const context: string[] = [];
  if (normalized.correlationId) context.push(`correlation-id=${normalized.correlationId}`);
  if (normalized.requestId) context.push(`request-id=${normalized.requestId}`);
  if (context.length > 0) reason += ` [${context.join(', ')}]`;
  const failureReason = redact(reason);
  io.log.error(failureReason);
  return { success: false, outputs, failureReason };
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
