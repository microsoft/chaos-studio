/**
 * cancel.ts (E2-T4) — best-effort run cancellation with a bounded cleanup
 * deadline (FR11, D9, D10). On a completion timeout or pipeline cancellation,
 * when a run ID exists and cancellation is enabled, the core POSTs
 * `runs/{runId}/cancel` and polls the returned run Location until `Canceled` or
 * another terminal status within the SHORT cleanup deadline.
 *
 * Invariants:
 *  - This NEVER throws and NEVER masks the original failure/cancellation reason
 *    (FR11): every cancel/cleanup error is logged (redacted) and swallowed.
 *  - The client passed here MUST use a signal that is NOT the (possibly aborted)
 *    main signal, so cleanup can still run on pipeline cancellation (D9).
 */

import type { ILogger } from './contract.ts';
import { cancelActionUrl, resolveCancelPollUrl, CoreError } from './ids.ts';
import { ArmHttpClient, Deadline, raiseForAcceptance } from './http.ts';
import { pollRun, type RunOutcome } from './run.ts';
import { redact } from './redaction.ts';

/**
 * Cancel a run and poll it to terminal within `cleanupDeadline`. Returns the
 * terminal outcome if reached (for best-effort last-observed outputs), else
 * `undefined`. Always resolves — the caller's original reason is authoritative.
 */
export async function bestEffortCancel(
  cleanupClient: ArmHttpClient,
  runResourceId: string,
  cleanupDeadline: Deadline,
  log: ILogger,
): Promise<RunOutcome | undefined> {
  try {
    const accept = await cleanupClient.post(cancelActionUrl(runResourceId), undefined, cleanupDeadline);
    raiseForAcceptance(accept, 'cancel');
    // The cancel 202 Location MUST be the SAME run we cancelled — a foreign or
    // wrong-shaped/unpinned Location fails closed rather than reporting another
    // run's state (D14). Absent ⇒ the canonical known-run URL.
    const location = resolveCancelPollUrl(accept.location, runResourceId);
    // Honor the cancel acceptance's Retry-After before the first cleanup poll,
    // bounded by the cleanup deadline (FR8).
    const outcome = await pollRun(cleanupClient, location, cleanupDeadline, log, undefined, accept.retryAfterSeconds);
    log.info(redact(`cleanup: run reached terminal ${outcome.status} after cancel`));
    return outcome;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Preserve the ARM diagnostic context (code, actionable message,
    // request/correlation IDs) a CoreError already carries, redacted, so an
    // operator investigating a possibly-still-running scenario after a failed
    // cancel is not left with only a generic message (R2, FR12). The original
    // forward failure/cancellation reason is still what the caller returns —
    // this is logged, never thrown or substituted.
    const details: string[] = [];
    if (err instanceof CoreError) {
      if (err.armErrorCode !== undefined) details.push(`armErrorCode=${err.armErrorCode}`);
      if (err.armErrorMessage !== undefined) details.push(`armErrorMessage=${err.armErrorMessage}`);
      if (err.correlationId !== undefined) details.push(`correlationId=${err.correlationId}`);
      if (err.requestId !== undefined) details.push(`requestId=${err.requestId}`);
    }
    const suffix = details.length > 0 ? ` (${details.join(', ')})` : '';
    log.warning(
      redact(
        `cleanup did not complete; original failure/cancellation reason is preserved: ${message}${suffix}`,
      ),
    );
    return undefined;
  }
}
