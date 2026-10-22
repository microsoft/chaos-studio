/**
 * adapter.ts (E4-T1) — the PURE, platform-SDK-free core of the Azure Pipelines
 * task adapter. It translates a minimal {@link TaskHost} (the subset of
 * `azure-pipelines-task-lib` the adapter uses) and an {@link ICredentialProvider}
 * into the shared core's {@link RunContext}, drives the orchestrator, and maps the
 * {@link OrchestrationResult} onto the Azure Pipelines task result
 * (`task.complete`) and output variables. It imports ONLY the E2 core — no
 * `azure-pipelines-task-lib`, no `@azure/identity` — so the adapter's behavior is
 * unit-testable with fakes and no real network/secret (NFR2/NFR3). The real host
 * and credential are wired in {@link file://./index.ts}.
 *
 * This mirrors the GitHub Action adapter (E3) one-for-one so the two platforms
 * share identical status/result/output behavior (G3, NFR5); only the platform
 * surface (`azure-pipelines-task-lib` vs `@actions/core`) and the credential
 * source (ARM service-connection WIF vs `AzureCliCredential`) differ.
 */

import type {
  IClock,
  IInputReader,
  ILogger,
  IOutputSetter,
  ICredentialProvider,
  OrchestrationResult,
  RunContext,
  RunFn,
} from '../../core/src/contract.ts';
import { INPUT_NAMES } from '../../core/src/contract.ts';
import { run as coreRun, createObservingRun } from '../../core/src/orchestrator.ts';
import { CoreError } from '../../core/src/ids.ts';
import { redact } from '../../core/src/redaction.ts';
import { formatProtocolObservation } from '../../core/src/http.ts';

/**
 * The minimal Azure Pipelines surface the adapter needs. A runtime-erased type
 * ({@link file://./host.ts} adapts `azure-pipelines-task-lib` to it), so this
 * module has no dependency on the task library and tests can pass a fake.
 */
export interface TaskHost {
  /** Raw input value; returns undefined when the input is unset (`tl.getInput`). */
  getInput(name: string): string | undefined;
  /** Set an output variable (`tl.setVariable(name, value, false, isOutput)`). */
  setVariable(name: string, value: string, isOutput: boolean): void;
  /**
   * Complete the task with a pass/fail result (`tl.setResult` →
   * `##vso[task.complete result=...]`). `success=false` fails the task.
   */
  setResult(success: boolean, message: string): void;
  /** Informational log line (normal task stdout). */
  info(message: string): void;
  /** Warning issue (`tl.warning` → `##vso[task.logissue type=warning]`). */
  warning(message: string): void;
  /** Error issue (`tl.error` → `##vso[task.logissue type=error]`). */
  error(message: string): void;
  /** Register a secret for masking (`tl.setSecret` → `##vso[task.setsecret]`). */
  setSecret(secret: string): void;
}

/**
 * Map each canonical core wire name (identical across adapters, NFR5) to the
 * Azure Pipelines task input name declared in `task.json`. The core always asks
 * for a wire name (e.g. `subscription-id`); Azure Pipelines inputs are camelCase
 * (`subscriptionId`), so the reader translates before touching the host. Names
 * not in the map pass through unchanged.
 */
export const WIRE_TO_TASK_INPUT: Record<string, string> = {
  [INPUT_NAMES.subscriptionId]: 'subscriptionId',
  [INPUT_NAMES.resourceGroup]: 'resourceGroup',
  [INPUT_NAMES.workspaceName]: 'workspaceName',
  [INPUT_NAMES.scenarioName]: 'scenarioName',
  [INPUT_NAMES.scenarioConfigurationName]: 'scenarioConfigurationName',
  [INPUT_NAMES.mode]: 'mode',
  [INPUT_NAMES.waitForCompletion]: 'waitForCompletion',
  [INPUT_NAMES.completionTimeoutSeconds]: 'completionTimeoutSeconds',
  [INPUT_NAMES.cancelOnTimeoutOrCancellation]: 'cancelOnTimeoutOrCancellation',
};

/** {@link IInputReader} over a {@link TaskHost}. An empty/unset Azure Pipelines
 *  input is treated as absent so the core applies its documented defaults. */
export class TaskInputReader implements IInputReader {
  private readonly host: TaskHost;
  constructor(host: TaskHost) {
    this.host = host;
  }
  private raw(name: string): string | undefined {
    const taskName = WIRE_TO_TASK_INPUT[name] ?? name;
    const v = this.host.getInput(taskName);
    return v === undefined || v === '' ? undefined : v;
  }
  get(name: string): string | undefined {
    return this.raw(name);
  }
  getRequired(name: string): string {
    const v = this.raw(name);
    if (v === undefined) throw new Error(`missing required input '${name}'`);
    return v;
  }
  getBool(name: string, dflt: boolean): boolean {
    const v = this.raw(name);
    if (v === undefined) return dflt;
    const normalized = v.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
    // A malformed value (e.g. a 'tru' typo) must FAIL the configuration rather than
    // silently coerce to false — that would quietly disable waiting or cancellation.
    // The core reads booleans inside its pre-network input-validation guard, so an
    // `identifier`-category error surfaces as a fail-closed result before any ARM
    // call (FR14/FR16) and never triggers cleanup (no run exists). Identical to the
    // GitHub adapter so both platforms reject the same malformed inputs (G3).
    throw new CoreError('identifier', `invalid boolean for input '${name}': '${v}' (expected 'true' or 'false')`);
  }
  getInt(name: string, dflt: number): number {
    const v = this.raw(name);
    if (v === undefined) return dflt;
    // Require an exact positive safe integer: no partial numeric strings (e.g.
    // '5x'), fractions, leading/trailing whitespace, negatives, zero, or
    // unsafe/overflowing magnitudes. `Number.parseInt` silently truncates
    // partial matches and accepts out-of-range values, which could otherwise
    // eliminate the completion deadline entirely (R3). Identical to the
    // GitHub adapter so both platforms reject the same malformed inputs (G3).
    if (!/^[0-9]+$/.test(v.trim())) {
      throw new CoreError('identifier', `invalid integer for input '${name}': '${v}' (expected a positive whole number)`);
    }
    const n = Number(v.trim());
    if (!Number.isSafeInteger(n) || n <= 0) {
      throw new CoreError('identifier', `invalid integer for input '${name}': '${v}' (expected a positive whole number)`);
    }
    return n;
  }
}

/**
 * {@link IOutputSetter} over a {@link TaskHost}. Each canonical scalar output is
 * emitted as an Azure Pipelines OUTPUT variable (`isOutput=true`), using the same
 * canonical names as the GitHub adapter so downstream steps read identical values
 * across platforms (G3, NFR5).
 */
export class TaskOutputSetter implements IOutputSetter {
  private readonly host: TaskHost;
  constructor(host: TaskHost) {
    this.host = host;
  }
  set(name: string, value: string): void {
    this.host.setVariable(name, value, true);
  }
}

/**
 * {@link ILogger} over a {@link TaskHost}. `warning`/`error` become Azure Pipelines
 * log issues; `mask` registers a secret with `tl.setSecret` so a token the core
 * hands us is scrubbed from all subsequent log output (FR12).
 */
export class TaskLogger implements ILogger {
  private readonly host: TaskHost;
  constructor(host: TaskHost) {
    this.host = host;
  }
  info(m: string): void {
    this.host.info(m);
  }
  warning(m: string): void {
    this.host.warning(m);
  }
  error(m: string): void {
    this.host.error(m);
  }
  mask(secret: string): void {
    this.host.setSecret(secret);
  }
}

/** Create an AbortError shaped like the DOM one (name `AbortError`). */
function abortError(): Error {
  const e = new Error('The operation was aborted');
  e.name = 'AbortError';
  return e;
}

/**
 * Real wall-clock {@link IClock} the adapter injects into the core (the core
 * ships only the {@link IClock} interface; the composition root supplies the
 * implementation). `sleep` is timer-based and rejects promptly on abort, and
 * always clears its timer so a cancelled task does not leak a pending timeout.
 * Identical to the GitHub adapter's clock (each adapter is its own composition
 * root, so the tiny implementation is intentionally duplicated, not shared).
 */
export const systemClock: IClock = {
  now(): number {
    return Date.now();
  },
  sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        reject(abortError());
        return;
      }
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = (): void => {
        clearTimeout(timer);
        reject(abortError());
      };
      signal.addEventListener('abort', onAbort, { once: true });
    });
  },
};

export interface RunTaskDeps {
  host: TaskHost;
  cred: ICredentialProvider;
  /** Cancellation signal (SIGINT/SIGTERM → AbortSignal, wired in index.ts). */
  signal: AbortSignal;
  /** Injectable clock (defaults to {@link systemClock}); tests pass a fake. */
  clock?: IClock;
  /** Injectable orchestrator entry (defaults to the core `run`); tests pass a fake. */
  orchestrate?: RunFn;
  /**
   * RV1 evidence-capture opt-in (E6/R1). When true and `orchestrate` is not
   * overridden, every ARM protocol observation is printed via `host.info` as a
   * single redacted `RV-OBSERVATION {...}` JSON line ({@link formatProtocolObservation}).
   * Never enabled by default; `index.ts` wires it only from
   * `CHAOS_STUDIO_RV_CAPTURE=1`, an operator-set env var used exclusively
   * during a live RV1 session — mirrors the GitHub adapter exactly (G3).
   */
  rvCapture?: boolean;
}

/** Fallback failure message when the core reports failure without a reason. */
const DEFAULT_FAILURE_MESSAGE = 'Azure Chaos Studio task failed.';
/** Result message for a passing task. */
const SUCCESS_MESSAGE = 'Azure Chaos Studio task succeeded.';

/**
 * Assemble the {@link RunContext} from the Azure Pipelines host + credential +
 * signal, drive the orchestrator, and map its result onto the task outcome:
 *  - the core sets every canonical scalar output through {@link TaskOutputSetter}
 *    as it runs (so outputs are identical to the GitHub adapter's, G3/NFR5);
 *  - the result is mapped to `task.complete` via {@link TaskHost.setResult}
 *    (success → Succeeded, failure → Failed with the core's `failureReason`),
 *    giving pass/fail parity with the core's {@link OrchestrationResult.success}
 *    (D12) and with the GitHub adapter.
 *
 * The core `run` never throws (it normalizes every failure into a result), but a
 * defensive catch maps any unexpected throw to a failed task so the task still
 * fails deterministically rather than crashing.
 */
export async function runAzurePipelinesTask(deps: RunTaskDeps): Promise<OrchestrationResult> {
  const io: RunContext = {
    input: new TaskInputReader(deps.host),
    output: new TaskOutputSetter(deps.host),
    log: new TaskLogger(deps.host),
    cred: deps.cred,
    clock: deps.clock ?? systemClock,
    signal: deps.signal,
  };
  const orchestrate =
    deps.orchestrate ?? (deps.rvCapture ? createObservingRun((obs) => deps.host.info(formatProtocolObservation(obs))) : coreRun);
  let result: OrchestrationResult;
  try {
    result = await orchestrate(io);
  } catch (err) {
    // The core is total (returns a result for every failure); a throw here is
    // unexpected. Fail the task rather than let it crash. The message is
    // redacted before it becomes a scalar task result/log (FR12, VF16): an
    // unexpected adapter fault could carry a raw credential/config value.
    const message = redact(err instanceof Error ? err.message : String(err));
    deps.host.setResult(false, message || DEFAULT_FAILURE_MESSAGE);
    return { success: false, outputs: {}, failureReason: message || DEFAULT_FAILURE_MESSAGE };
  }
  if (result.success) {
    deps.host.setResult(true, SUCCESS_MESSAGE);
  } else {
    deps.host.setResult(false, redact(result.failureReason ?? DEFAULT_FAILURE_MESSAGE));
  }
  return result;
}
