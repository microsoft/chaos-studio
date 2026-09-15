/**
 * adapter.ts (E3-T1) — the PURE, platform-SDK-free core of the GitHub Action
 * adapter. It translates a minimal {@link ActionsHost} (the subset of
 * `@actions/core` the adapter uses) and an {@link ICredentialProvider} into the
 * shared core's {@link RunContext}, drives the orchestrator, and maps the
 * {@link OrchestrationResult} onto GitHub's step result (`setFailed`) and scalar
 * outputs. It imports ONLY the E2 core — no `@actions/core`, no `@azure/identity`
 * — so the adapter's behavior is unit-testable with fakes and no real
 * network/secret (NFR2/NFR3). The real host and credential are wired in
 * {@link file://./index.ts}.
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
import { run as coreRun } from '../../core/src/orchestrator.ts';
import { CoreError } from '../../core/src/ids.ts';

/**
 * The minimal GitHub-platform surface the adapter needs. A runtime-erased type
 * ({@link file://./host.ts} adapts `@actions/core` to it), so this module has no
 * dependency on `@actions/core` and tests can pass a fake.
 */
export interface ActionsHost {
  /** Raw input value; returns '' when the input is unset (matches `@actions/core`). */
  getInput(name: string): string;
  /** Emit a step output (`core.setOutput`). */
  setOutput(name: string, value: string): void;
  /** Fail the step with a message (`core.setFailed`; sets a nonzero exit). */
  setFailed(message: string): void;
  /** Informational log line (`core.info`). */
  info(message: string): void;
  /** Warning annotation (`core.warning`). */
  warning(message: string): void;
  /** Error annotation (`core.error`). */
  error(message: string): void;
  /** Register a secret for masking (`core.setSecret` → `::add-mask::`). */
  setSecret(secret: string): void;
}

/** {@link IInputReader} over an {@link ActionsHost}. An empty `@actions/core`
 *  input (unset) is treated as absent so the core applies its documented defaults. */
export class GithubInputReader implements IInputReader {
  private readonly host: ActionsHost;
  constructor(host: ActionsHost) {
    this.host = host;
  }
  get(name: string): string | undefined {
    const raw = this.host.getInput(name);
    return raw === '' ? undefined : raw;
  }
  getRequired(name: string): string {
    const v = this.get(name);
    if (v === undefined) throw new Error(`missing required input '${name}'`);
    return v;
  }
  getBool(name: string, dflt: boolean): boolean {
    const v = this.get(name);
    if (v === undefined) return dflt;
    const normalized = v.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
    // A malformed value (e.g. a 'tru' typo) must FAIL the configuration rather than
    // silently coerce to false — that would quietly disable waiting or cancellation.
    // The core reads booleans inside its pre-network input-validation guard, so an
    // `identifier`-category error surfaces as a fail-closed result before any ARM
    // call (FR14/FR16) and never triggers cleanup (no run exists).
    throw new CoreError('identifier', `invalid boolean for input '${name}': '${v}' (expected 'true' or 'false')`);
  }
  getInt(name: string, dflt: number): number {
    const v = this.get(name);
    if (v === undefined) return dflt;
    // Require an exact positive safe integer: no partial numeric strings (e.g.
    // '5x'), fractions, leading/trailing whitespace, negatives, zero, or
    // unsafe/overflowing magnitudes. `Number.parseInt` silently truncates
    // partial matches and accepts out-of-range values, which could otherwise
    // eliminate the completion deadline entirely (R3).
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

/** {@link IOutputSetter} over an {@link ActionsHost} (`core.setOutput`). */
export class GithubOutputSetter implements IOutputSetter {
  private readonly host: ActionsHost;
  constructor(host: ActionsHost) {
    this.host = host;
  }
  set(name: string, value: string): void {
    this.host.setOutput(name, value);
  }
}

/**
 * {@link ILogger} over an {@link ActionsHost}. `warning`/`error` become GitHub
 * annotations; `mask` registers a secret with `::add-mask::` (`core.setSecret`)
 * so a token the core hands us is scrubbed from all subsequent log output (FR12).
 */
export class GithubLogger implements ILogger {
  private readonly host: ActionsHost;
  constructor(host: ActionsHost) {
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
 * always clears its timer so a cancelled step does not leak a pending timeout.
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

export interface RunGithubActionDeps {
  host: ActionsHost;
  cred: ICredentialProvider;
  /** Cancellation signal (job-cancel → AbortSignal, wired in index.ts). */
  signal: AbortSignal;
  /** Injectable clock (defaults to {@link systemClock}); tests pass a fake. */
  clock?: IClock;
  /** Injectable orchestrator entry (defaults to the core `run`); tests pass a fake. */
  orchestrate?: RunFn;
}

/** Fallback failure message when the core reports failure without a reason. */
const DEFAULT_FAILURE_MESSAGE = 'Azure Chaos Studio step failed.';

/**
 * Assemble the {@link RunContext} from the GitHub host + credential + signal,
 * drive the orchestrator, and map its result onto GitHub's step outcome:
 *  - the core sets every canonical scalar output through {@link GithubOutputSetter}
 *    as it runs (so outputs are identical to the core's contract, NFR5);
 *  - on failure, `core.setFailed(failureReason)` fails the step (pass/fail parity
 *    with the core's {@link OrchestrationResult.success}, D12).
 *
 * The core `run` never throws (it normalizes every failure into a result), but a
 * defensive catch maps any unexpected throw to `setFailed` so the step still
 * fails deterministically rather than crashing the Action.
 */
export async function runGithubAction(deps: RunGithubActionDeps): Promise<OrchestrationResult> {
  const io: RunContext = {
    input: new GithubInputReader(deps.host),
    output: new GithubOutputSetter(deps.host),
    log: new GithubLogger(deps.host),
    cred: deps.cred,
    clock: deps.clock ?? systemClock,
    signal: deps.signal,
  };
  const orchestrate = deps.orchestrate ?? coreRun;
  let result: OrchestrationResult;
  try {
    result = await orchestrate(io);
  } catch (err) {
    // The core is total (returns a result for every failure); a throw here is
    // unexpected. Fail the step rather than let the Action crash.
    const message = err instanceof Error ? err.message : String(err);
    deps.host.setFailed(message || DEFAULT_FAILURE_MESSAGE);
    return { success: false, outputs: {}, failureReason: message || DEFAULT_FAILURE_MESSAGE };
  }
  if (!result.success) {
    deps.host.setFailed(result.failureReason ?? DEFAULT_FAILURE_MESSAGE);
  }
  return result;
}
