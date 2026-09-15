/**
 * validation.ts (E2-T3) — the validation-resource state machine and its
 * Location poller (VF1–VF3, D9). `validate` returns a 202 whose `Location` is
 * the `validations/latest` singleton; the core polls that resource until its
 * `properties.status` reaches a terminal state. `Succeeded` is the only terminal
 * success; `RequiresAttention` and `NoResolvedResources` are terminal failures;
 * every other value (known nonterminal OR unknown) stays nonterminal until the
 * deadline (FR4).
 */

import { VALIDATION_TERMINAL_SUCCESS, VALIDATION_TERMINAL_FAILURE } from './contract.ts';
import type { ILogger } from './contract.ts';
import { CoreError, parseValidationLocation, type ScenarioCoordinates } from './ids.ts';
import {
  ArmHttpClient,
  Deadline,
  raiseForActionStatus,
  readResourceStatus,
  type ResourceStatus,
} from './http.ts';
import { redact } from './redaction.ts';

/** The business error channel for validation resources (DX2). */
const VALIDATION_BUSINESS_CHANNEL = 'validationErrors';

export type ValidationDisposition = 'success' | 'failure' | 'pending';

/** Classify a validation `properties.status` (VF3). Unknown ⇒ pending (FR4). */
export function classifyValidationStatus(status: string | undefined): ValidationDisposition {
  if (status !== undefined && (VALIDATION_TERMINAL_SUCCESS as readonly string[]).includes(status)) return 'success';
  if (status !== undefined && (VALIDATION_TERMINAL_FAILURE as readonly string[]).includes(status)) return 'failure';
  return 'pending';
}

export interface ValidationAcceptance {
  location: string;
  /** The acceptance 202's `Retry-After` (seconds), honored before the first poll (FR8). */
  retryAfterSeconds: number | undefined;
  correlationId: string | undefined;
  requestId: string | undefined;
}

/**
 * POST `validate` and return its `validations/latest` Location, bound to the
 * EXACT requested configuration (FR14, D14). A missing, foreign-coordinate,
 * wrong-shape, non-ARM, or unpinned-api-version Location fails closed as
 * `ambiguous-acceptance` without a re-POST. When a `deadline` is supplied it is
 * enforced before the POST (in-flight) and after the response (response-time
 * expiry) — a validate acceptance that crosses the budget times out (FR10).
 */
export async function acceptValidate(
  client: ArmHttpClient,
  url: string,
  coords: ScenarioCoordinates,
  deadline?: Deadline,
): Promise<ValidationAcceptance> {
  const res = await client.post(url, undefined, deadline);
  // Response-time expiry: a slow validate acceptance that crossed the budget is a
  // timeout regardless of its body (there is no run identity to preserve here).
  client.assertWithinDeadline(deadline);
  raiseForActionStatus(res, 'validate');
  let location: string;
  try {
    location = parseValidationLocation(res.location, coords);
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
  return { location, retryAfterSeconds: res.retryAfterSeconds, correlationId: res.correlationId, requestId: res.requestId };
}

export interface ValidationOutcome extends ResourceStatus {
  disposition: 'success' | 'failure';
  correlationId: string | undefined;
  requestId: string | undefined;
}

/**
 * Poll the `validations/latest` Location until terminal or the deadline elapses.
 * On a terminal failure the redacted business/system error detail is logged
 * (FR12) — it never becomes a scalar output (FR13). `initialRetryAfterSeconds`
 * (the acceptance 202's `Retry-After`) is honored before the first poll (FR8).
 */
export async function pollValidation(
  client: ArmHttpClient,
  location: string,
  deadline: Deadline,
  log: ILogger,
  initialRetryAfterSeconds?: number,
): Promise<ValidationOutcome> {
  const outcome = await client.poll<ValidationOutcome>(
    location,
    deadline,
    (res) => {
      const rs = readResourceStatus(res.json, VALIDATION_BUSINESS_CHANNEL);
      const disposition = classifyValidationStatus(rs.status);
      // A terminal disposition is accepted ONLY on HTTP 200 (FR1): the LRO contract
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
        `validation terminal ${outcome.status}; errors=${JSON.stringify(outcome.errors)} ` +
          `validationErrors=${JSON.stringify(outcome.businessErrors)}`,
      ),
    );
  }
  return outcome;
}
