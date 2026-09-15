/**
 * run.ts (E2-T3) — the run-resource state machine, its Location poller, and DX3
 * run-ID extraction (VF5–VF7, D9). `execute` returns a 202 whose `Location` is
 * the full run resource ID; the run GUID is parsed from it (never fabricated,
 * never re-POSTed on ambiguity — D14). For execution-mode runs `Succeeded` is
 * terminal success; `Failed` and `Canceled` are terminal failures; every other
 * value (known nonterminal OR unknown) stays nonterminal until the deadline (FR4).
 */

import { RUN_TERMINAL_SUCCESS, RUN_TERMINAL_FAILURE } from './contract.ts';
import type { ILogger } from './contract.ts';
import { CoreError, parseRunLocation, type ScenarioCoordinates } from './ids.ts';
import {
  ArmHttpClient,
  Deadline,
  raiseForActionStatus,
  readResourceStatus,
  type ResourceStatus,
} from './http.ts';
import { redact } from './redaction.ts';

/** The business error channel for run resources (DX2). */
const RUN_BUSINESS_CHANNEL = 'executionErrors';

export type RunDisposition = 'success' | 'failure' | 'pending';

/** Classify a run `properties.status` (VF7). Unknown ⇒ pending (FR4). */
export function classifyRunStatus(status: string | undefined): RunDisposition {
  if (status !== undefined && (RUN_TERMINAL_SUCCESS as readonly string[]).includes(status)) return 'success';
  if (status !== undefined && (RUN_TERMINAL_FAILURE as readonly string[]).includes(status)) return 'failure';
  return 'pending';
}

export interface ExecuteAcceptance {
  runId: string;
  runResourceId: string;
  /** The acceptance 202's `Retry-After` (seconds), honored before the first poll (FR8). */
  retryAfterSeconds: number | undefined;
  correlationId: string | undefined;
  requestId: string | undefined;
}

/**
 * POST `execute` and parse the run identity from its Location (DX3). The Location
 * must be a `Microsoft.Chaos` run resource for the requested workspace/scenario;
 * a missing/malformed/foreign Location fails closed as `ambiguous-acceptance`
 * without a re-POST (D14). When a `deadline` is supplied it is enforced BEFORE
 * the POST (in-flight interruption). Response-time expiry is deliberately NOT
 * enforced here: the caller emits the parsed run identity first (so a run started
 * just past the budget can still be cleaned up, FR10/FR11) and then enforces the
 * deadline.
 */
export async function acceptExecute(
  client: ArmHttpClient,
  url: string,
  coords: ScenarioCoordinates,
  deadline?: Deadline,
): Promise<ExecuteAcceptance> {
  const res = await client.post(url, undefined, deadline);
  raiseForActionStatus(res, 'execute');
  let parsed: { runResourceId: string; runId: string };
  try {
    parsed = parseRunLocation(res.location, coords);
  } catch (err) {
    // Preserve the acceptance response's correlation/request IDs on an
    // ambiguous-Location failure so the operator can trace the 202 (VF10, D14).
    if (err instanceof CoreError && err.correlationId === undefined && err.requestId === undefined) {
      throw new CoreError(err.category, err.message, {
        armErrorCode: err.armErrorCode,
        armErrorMessage: err.armErrorMessage,
        correlationId: res.correlationId,
        requestId: res.requestId,
        cause: err,
      });
    }
    throw err;
  }
  return {
    runId: parsed.runId,
    runResourceId: parsed.runResourceId,
    retryAfterSeconds: res.retryAfterSeconds,
    correlationId: res.correlationId,
    requestId: res.requestId,
  };
}

export interface RunOutcome extends ResourceStatus {
  disposition: 'success' | 'failure';
  correlationId: string | undefined;
  requestId: string | undefined;
}

/**
 * Poll a run resource Location until terminal or the deadline elapses. On a
 * terminal failure the redacted business/system error detail is logged (FR12).
 * `observe` (when supplied) is invoked with the parsed status of EVERY poll —
 * terminal or nonterminal — so the caller retains the latest last-observed
 * run-state/timestamps even when polling later throws a timeout (D11, FR10).
 * `initialRetryAfterSeconds` (the acceptance 202's `Retry-After`) is honored
 * before the first poll (FR8).
 */
export async function pollRun(
  client: ArmHttpClient,
  location: string,
  deadline: Deadline,
  log: ILogger,
  observe?: (rs: ResourceStatus) => void,
  initialRetryAfterSeconds?: number,
): Promise<RunOutcome> {
  const outcome = await client.poll<RunOutcome>(
    location,
    deadline,
    (res) => {
      const rs = readResourceStatus(res.json, RUN_BUSINESS_CHANNEL);
      if (observe) observe(rs);
      const disposition = classifyRunStatus(rs.status);
      // A terminal disposition is accepted ONLY on HTTP 200 (FR6): the LRO contract
      // is 202-while-nonterminal → 200-when-terminal, so a 202 carrying a
      // terminal-looking `properties.status` is NOT terminal — keep polling.
      if (disposition === 'pending' || res.status !== 200) return { done: false };
      return {
        done: true,
        value: {
          ...rs,
          disposition,
          correlationId: res.correlationId ?? client.lastCorrelation.correlationId,
          requestId: res.requestId ?? client.lastCorrelation.requestId,
        },
      };
    },
    (initialRetryAfterSeconds ?? 0) * 1000,
  );

  if (outcome.disposition === 'failure') {
    log.warning(
      redact(
        `run terminal ${outcome.status}; errors=${JSON.stringify(outcome.errors)} ` +
          `executionErrors=${JSON.stringify(outcome.businessErrors)}`,
      ),
    );
  }
  return outcome;
}

/**
 * Best-effort SINGLE `ScenarioRuns_Get` for no-wait mode's last-observed state
 * (D11). Exactly one GET, no retry/backoff sleep. A non-2xx response THROWS (so
 * the caller's nonfatal warning handler runs) rather than being read as run
 * state — an error body is never interpreted as a status. When a `deadline` is
 * supplied it bounds credential acquisition and the in-flight request, so a hung
 * token exchange or transport is aborted at expiry (the caller then handles the
 * timeout non-fatally) — the observation can never hang past the budget (FR10).
 */
export async function readRunOnce(
  client: ArmHttpClient,
  location: string,
  deadline?: Deadline,
): Promise<ResourceStatus> {
  const res = await client.getOnce(location, deadline);
  raiseForActionStatus(res, 'run observation');
  return readResourceStatus(res.json, RUN_BUSINESS_CHANNEL);
}
