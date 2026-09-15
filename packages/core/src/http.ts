/**
 * http.ts (E2-T2) — the ARM HTTP client behind an injected transport (NFR2).
 * Owns the D13/FR8 retry-and-poll policy (honor `Retry-After`; else bounded
 * exponential backoff with full jitter; retry safe GETs on `429`/transient
 * `5xx` within a bounded budget), correlation capture (FR12), and the
 * completion/cleanup {@link Deadline}. The POST actions are single-attempt: the
 * client never re-POSTs `validate`/`execute`/`cancel` (D14).
 *
 * The transport is injected so unit tests use a fake; {@link fetchTransport} is
 * the default real transport the adapters use. Secret material is masked and any
 * logged text is redacted (FR12, VF16).
 */

import type { IClock, ILogger, ICredentialProvider } from './contract.ts';
import { assertArmUrl, CoreError } from './ids.ts';
import { redact } from './redaction.ts';

// ---------------------------------------------------------------------------
// Transport seam.
// ---------------------------------------------------------------------------

export interface HttpRequest {
  method: 'GET' | 'POST';
  url: string;
  headers: Record<string, string>;
  body?: string;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface IHttpTransport {
  send(req: HttpRequest, signal: AbortSignal): Promise<HttpResponse>;
}

// ---------------------------------------------------------------------------
// Retry / backoff policy (D13, FR8).
// ---------------------------------------------------------------------------

/** ARM token scope for public cloud. */
export const ARM_SCOPE = 'https://management.azure.com/.default';
/** Safe GETs retry on these statuses (D13). */
export const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([429, 500, 502, 503, 504]);
/** Bounded attempt budget per individual GET (D13). */
export const MAX_GET_ATTEMPTS = 8;

export interface BackoffOptions {
  initialMs: number;
  multiplier: number;
  maxMs: number;
}

/** initial 5s, multiplier 2, max 60s (D13). */
export const DEFAULT_BACKOFF: BackoffOptions = { initialMs: 5000, multiplier: 2, maxMs: 60000 };

/** Case-insensitive header lookup (HTTP header names are case-insensitive). */
export function headerValue(headers: Record<string, string>, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}

/**
 * Parse a `Retry-After` header (delta seconds or an HTTP-date) into seconds
 * relative to `nowMs`. Returns `undefined` when absent/unparseable so the caller
 * falls back to backoff. A fractional HTTP-date interval is rounded UP (a
 * positive sub-second remainder like 400ms yields 1s, never 0) so the retry
 * never fires before the server-directed time (FR8).
 */
export function parseRetryAfter(value: string | undefined, nowMs: number): number | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10);
  const when = Date.parse(trimmed);
  if (Number.isNaN(when)) return undefined;
  return Math.max(0, Math.ceil((when - nowMs) / 1000));
}

/**
 * Full-jitter backoff delay for a 1-based attempt: a uniform sample in
 * `[0, min(maxMs, initialMs * multiplier^(attempt-1))]`.
 */
export function backoffDelayMs(attempt: number, backoff: BackoffOptions, rng: () => number): number {
  const capped = Math.min(backoff.maxMs, backoff.initialMs * backoff.multiplier ** (attempt - 1));
  return Math.floor(rng() * capped);
}

// ---------------------------------------------------------------------------
// Deadlines (D10). A completion deadline covers the whole forward journey; a
// separate cleanup deadline bounds the cancel path.
// ---------------------------------------------------------------------------

export class Deadline {
  private readonly clock: IClock;
  private readonly endMs: number;

  constructor(clock: IClock, endMs: number) {
    this.clock = clock;
    this.endMs = endMs;
  }

  static fromNow(clock: IClock, seconds: number): Deadline {
    return new Deadline(clock, clock.now() + seconds * 1000);
  }

  remainingMs(): number {
    return Math.max(0, this.endMs - this.clock.now());
  }

  expired(): boolean {
    return this.clock.now() >= this.endMs;
  }
}

// ---------------------------------------------------------------------------
// Parsed ARM response.
// ---------------------------------------------------------------------------

export interface ParsedResponse {
  status: number;
  headers: Record<string, string>;
  json: unknown;
  location: string | undefined;
  retryAfterSeconds: number | undefined;
  correlationId: string | undefined;
  requestId: string | undefined;
  errorCode: string | undefined;
  errorMessage: string | undefined;
}

export interface Correlation {
  correlationId?: string;
  requestId?: string;
}

/** One nonterminal-or-terminal decision from a poll classifier. */
export interface PollStep<T> {
  done: boolean;
  value?: T;
}

/**
 * Redacted protocol-metadata snapshot of one request/response pair (RV1). Never
 * carries a body, header value, or token — only the shape-proving fields the
 * client already parses for its own decisions ({@link ParsedResponse}), plus the
 * request method/URL/api-version so an operator's capture can attribute each
 * observation to the call that produced it.
 */
export interface ProtocolObservation {
  method: 'GET' | 'POST';
  url: string;
  status: number;
  location: string | undefined;
  retryAfterSeconds: number | undefined;
  correlationId: string | undefined;
  requestId: string | undefined;
  errorCode: string | undefined;
  /** ARM `error.message` (plus nested `details[].message`), already redacted (R2). */
  errorMessage: string | undefined;
}

export interface ArmClientOptions {
  transport: IHttpTransport;
  clock: IClock;
  log: ILogger;
  cred: ICredentialProvider;
  signal: AbortSignal;
  rng?: () => number;
  backoff?: BackoffOptions;
  scope?: string;
  /**
   * RV1 evidence-capture hook (E6/R1). When supplied, every parsed response is
   * reported here as a {@link ProtocolObservation} — never anything beyond
   * that shape. This is the ONLY sanctioned way to observe wire metadata
   * during a live RV session: it adds no public generic-ARM capability (the
   * hook is a plain callback on the same private client the adapters already
   * construct), and the reported fields are exactly the ones the client
   * itself already parses and relies on, so they cannot diverge from what
   * `raiseForAcceptance`/`raiseForActionStatus`/pollers actually observed.
   */
  onObservation?: (obs: ProtocolObservation) => void;
}

export class ArmHttpClient {
  readonly clock: IClock;
  readonly rng: () => number;
  readonly backoff: BackoffOptions;
  /** Correlation/request IDs of the most recent response carrying them (FR12). */
  lastCorrelation: Correlation = {};

  private readonly transport: IHttpTransport;
  private readonly log: ILogger;
  private readonly cred: ICredentialProvider;
  private readonly signal: AbortSignal;
  private readonly scope: string;
  private readonly onObservation: ((obs: ProtocolObservation) => void) | undefined;

  constructor(opts: ArmClientOptions) {
    this.transport = opts.transport;
    this.clock = opts.clock;
    this.log = opts.log;
    this.cred = opts.cred;
    this.signal = opts.signal;
    this.rng = opts.rng ?? Math.random;
    this.backoff = opts.backoff ?? DEFAULT_BACKOFF;
    this.scope = opts.scope ?? ARM_SCOPE;
    this.onObservation = opts.onObservation;
  }

  /**
   * GET a resource, retrying transient `429`/`5xx` within the attempt budget (D13).
   * When a `deadline` is supplied, every retry is bounded by the remaining budget:
   * expiry is enforced before each attempt AND before accepting a terminal
   * response, and a required retry delay that exceeds the remaining budget fails
   * with `timeout` rather than sleeping past the deadline (FR8/FR10).
   */
  async get(url: string, deadline?: Deadline): Promise<ParsedResponse> {
    let attempt = 0;
    for (;;) {
      // Enforce expiry BEFORE a further attempt.
      if (deadline?.expired()) throw this.timeoutError();
      attempt++;
      const parsed = await this.requestOnce('GET', url, undefined, deadline);
      // A response that arrives after the deadline is a TIMEOUT regardless of its
      // status or the attempt count — this precedence must hold over BOTH the
      // retry-limit and status branches so a final retryable response crossing the
      // deadline does not surface as `transport` and bypass timeout-triggered
      // cancellation in the orchestrator (FR10).
      if (deadline?.expired()) throw this.timeoutError();
      if (!RETRYABLE_STATUSES.has(parsed.status)) {
        return parsed;
      }
      if (attempt >= MAX_GET_ATTEMPTS) {
        throw new CoreError('transport', `GET failed after ${attempt} attempts (last status ${parsed.status})`, {
          armErrorCode: parsed.errorCode,
          armErrorMessage: parsed.errorMessage,
          correlationId: parsed.correlationId ?? this.lastCorrelation.correlationId,
          requestId: parsed.requestId ?? this.lastCorrelation.requestId,
        });
      }
      const delayMs =
        parsed.retryAfterSeconds !== undefined
          ? parsed.retryAfterSeconds * 1000
          : backoffDelayMs(attempt, this.backoff, this.rng);
      if (deadline !== undefined) {
        const remaining = deadline.remainingMs();
        // A retry we cannot afford within the remaining budget is a timeout — do
        // NOT sleep an unbounded Retry-After (e.g. 100s) under a 25s deadline.
        if (remaining <= 0 || delayMs > remaining) throw this.timeoutError();
      }
      this.log.warning(redact(`GET ${url} -> ${parsed.status}; retrying (attempt ${attempt}) after ${delayMs}ms`));
      await this.sleep(delayMs);
    }
  }

  /**
   * Single-attempt GET — no retry, no backoff sleep (the explicit best-effort
   * `ScenarioRuns_Get` observation for no-wait mode, D11). The caller decides how
   * to treat a non-2xx response; this never interprets an error body as state.
   * When a `deadline` is supplied it bounds credential acquisition AND the
   * in-flight request (a hung token exchange or transport is aborted at expiry),
   * so the single observation can never hang past the completion budget (FR10).
   */
  async getOnce(url: string, deadline?: Deadline): Promise<ParsedResponse> {
    return this.requestOnce('GET', url, undefined, deadline);
  }

  /**
   * POST an action exactly once (D14: never re-POST validate/execute/cancel).
   * When a `deadline` is supplied it is enforced BEFORE the request is sent
   * (in-flight interruption: an already-expired budget does not issue the POST).
   * Response-time expiry is enforced by the caller AFTER it has extracted any
   * accepted run identity needed for cleanup (FR10/D10).
   */
  async post(url: string, body?: unknown, deadline?: Deadline): Promise<ParsedResponse> {
    if (deadline?.expired()) throw this.timeoutError();
    return this.requestOnce('POST', url, body, deadline);
  }

  /** Throw a `timeout` CoreError if the supplied deadline has expired (FR10). */
  assertWithinDeadline(deadline?: Deadline): void {
    if (deadline?.expired()) throw this.timeoutError();
  }

  /**
   * Poll `url` (an LRO resource Location) until `classify` reports terminal or
   * the deadline elapses. Honors `Retry-After` on every poll; else backs off
   * with jitter (D13/FR8). A GET's own transient retries are handled by {@link get}.
   *
   * `initialDelayMs` (the ACCEPTANCE response's `Retry-After`, in ms) is honored
   * BEFORE the first GET, bounded by the deadline — the server-directed polling
   * guidance from the 202 must not be discarded (FR8).
   */
  async poll<T>(
    url: string,
    deadline: Deadline,
    classify: (res: ParsedResponse) => PollStep<T>,
    initialDelayMs = 0,
  ): Promise<T> {
    if (initialDelayMs > 0) {
      const remaining = deadline.remainingMs();
      if (remaining <= 0) throw this.timeoutError();
      // Honor the acceptance Retry-After before the first poll, capped by the
      // budget (if it exceeds the deadline the next-loop expiry check times out).
      await this.sleep(Math.min(initialDelayMs, remaining));
    }
    let backoffAttempt = 0;
    for (;;) {
      if (deadline.expired()) throw this.timeoutError();
      // The poll GET carries the deadline so its own transient retries cannot
      // sleep past the budget (FR8/FR10).
      const res = await this.get(url, deadline);
      // A non-2xx poll GET (e.g. 401/403/404) that survived transient retries is
      // a hard error, not a nonterminal state — fail fast rather than poll to the
      // deadline (401/403 ⇒ auth; other ⇒ transport), preserving ARM context.
      raiseForActionStatus(res, 'poll');
      const step = classify(res);
      if (step.done) return step.value as T;

      const delayMs =
        res.retryAfterSeconds !== undefined
          ? res.retryAfterSeconds * 1000
          : backoffDelayMs(++backoffAttempt, this.backoff, this.rng);
      const remaining = deadline.remainingMs();
      if (remaining <= 0) throw this.timeoutError();
      await this.sleep(Math.min(delayMs, remaining));
    }
  }

  /** A `timeout` CoreError carrying the last correlation/request IDs (FR10, FR12). */
  private timeoutError(): CoreError {
    return new CoreError('timeout', 'completion deadline elapsed while polling', {
      correlationId: this.lastCorrelation.correlationId,
      requestId: this.lastCorrelation.requestId,
    });
  }

  /** Sleep on the injected clock, observing the abort signal (NFR2). */
  sleep(ms: number): Promise<void> {
    return this.clock.sleep(ms, this.signal);
  }

  private async requestOnce(method: 'GET' | 'POST', url: string, body?: unknown, deadline?: Deadline): Promise<ParsedResponse> {
    // Never send the ARM credential anywhere but ARM (defense in depth against a
    // foreign/HTTP Location echoed by the service).
    assertArmUrl(url);
    // A per-request AbortController linked to the main signal. The deadline
    // watcher aborts it so a hung credential exchange or in-flight request is
    // cancelled the moment the budget elapses (FR10) — not left pending with an
    // un-aborted transport signal.
    const ac = new AbortController();
    const onMainAbort = (): void => ac.abort();
    if (this.signal.aborted) ac.abort();
    else this.signal.addEventListener('abort', onMainAbort, { once: true });
    try {
      // Awaiting credentials is bounded by the deadline (a hung token exchange is
      // aborted); a token that consumed but resolved within budget is caught by
      // the recheck below.
      let token: string;
      try {
        token = await this.withDeadline(this.cred.getArmToken(this.scope, ac.signal), deadline, ac);
      } catch (err) {
        // A deadline-race timeout is authoritative — surface it as `timeout`.
        if (err instanceof CoreError && err.category === 'timeout') throw err;
        if (this.signal.aborted) {
          throw new CoreError('transport', `credential acquisition for ${method} ${url} aborted`, { cause: err });
        }
        // Any other credential-provider failure (missing login, failed WIF token
        // exchange, expired/invalid federated assertion, etc.) is an AUTH failure,
        // not a transport failure — normalize it here rather than letting it
        // escape as a raw exception that `toNormalizedError` would otherwise
        // default to `transport` (R4). No request has been sent yet.
        throw new CoreError('auth', redact(`credential acquisition failed: ${errText(err)}`), { cause: err });
      }
      this.log.mask(token);
      // Credential acquisition can consume the remaining budget (a slow token
      // exchange). Recheck AFTER acquiring the token and IMMEDIATELY before
      // transport.send, so an acceptance whose authentication crossed the deadline
      // is never submitted — a chaos run must not start outside the budget (FR10/D10).
      if (deadline?.expired()) throw this.timeoutError();
      const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      };
      let serialized: string | undefined;
      if (body !== undefined) {
        headers['Content-Type'] = 'application/json';
        serialized = JSON.stringify(body);
      }
      let res: HttpResponse;
      try {
        // In-flight expiry is bounded too: a pending send is aborted when the
        // deadline elapses (FR10).
        res = await this.withDeadline(
          this.transport.send({ method, url, headers, body: serialized }, ac.signal),
          deadline,
          ac,
        );
      } catch (err) {
        // A deadline-race timeout is authoritative — surface it as `timeout`.
        if (err instanceof CoreError && err.category === 'timeout') throw err;
        if (this.signal.aborted) {
          throw new CoreError('transport', `${method} ${url} aborted`, { cause: err });
        }
        // A POST network failure is AMBIGUOUS — the request might have reached ARM,
        // so the core must not re-POST; it fails with captured context (D14).
        const category = method === 'POST' ? 'ambiguous-acceptance' : 'transport';
        throw new CoreError(category, redact(`${method} ${url} transport error: ${errText(err)}`), {
          cause: err,
          correlationId: this.lastCorrelation.correlationId,
          requestId: this.lastCorrelation.requestId,
        });
      }
      const parsed = this.parse(res);
      if (this.onObservation !== undefined) {
        this.onObservation({
          method,
          url,
          status: parsed.status,
          location: parsed.location,
          retryAfterSeconds: parsed.retryAfterSeconds,
          correlationId: parsed.correlationId,
          requestId: parsed.requestId,
          errorCode: parsed.errorCode,
          errorMessage: parsed.errorMessage === undefined ? undefined : redact(parsed.errorMessage),
        });
      }
      return parsed;
    } finally {
      // Cancel any lingering deadline-watcher sleep and unlink the main signal.
      ac.abort();
      this.signal.removeEventListener('abort', onMainAbort);
    }
  }

  /**
   * Race a pending operation against the deadline using a DETERMINISTIC,
   * CANCELLABLE clock watcher. A promptly-settling op wins without ever starting
   * the clock (the watcher is armed one microtask later and short-circuits on the
   * already-settled op); only a genuinely PENDING op triggers the deadline sleep,
   * which then aborts the in-flight request (via `ac`) and rejects with `timeout`.
   */
  private withDeadline<T>(op: Promise<T>, deadline: Deadline | undefined, ac: AbortController): Promise<T> {
    if (deadline === undefined) return op;
    let settled = false;
    op.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    return new Promise<T>((resolve, reject) => {
      op.then(resolve, reject);
      queueMicrotask(() => {
        if (settled) return;
        this.clock.sleep(Math.max(0, deadline.remainingMs()), ac.signal).then(
          () => {
            if (settled) return;
            ac.abort();
            reject(this.timeoutError());
          },
          () => {
            // The watcher sleep was aborted because the op settled first — ignore.
          },
        );
      });
    });
  }

  private parse(res: HttpResponse): ParsedResponse {
    let json: unknown;
    if (res.body) {
      try {
        json = JSON.parse(res.body);
      } catch {
        json = undefined;
      }
    }
    const correlationId = headerValue(res.headers, 'x-ms-correlation-request-id');
    const requestId = headerValue(res.headers, 'x-ms-request-id');
    if (correlationId !== undefined) this.lastCorrelation.correlationId = correlationId;
    if (requestId !== undefined) this.lastCorrelation.requestId = requestId;
    return {
      status: res.status,
      headers: res.headers,
      json,
      location: headerValue(res.headers, 'location'),
      retryAfterSeconds: parseRetryAfter(headerValue(res.headers, 'retry-after'), this.clock.now()),
      correlationId,
      requestId,
      errorCode: headerValue(res.headers, 'x-ms-error-code') ?? bodyErrorCode(json),
      errorMessage: bodyErrorMessage(json),
    };
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Render a {@link ProtocolObservation} as a single redacted log line (RV1/R1).
 * This is the exact, shared format both private adapters print when an
 * operator opts a live RV session into evidence capture — a stable, greppable
 * `RV-OBSERVATION ` prefix followed by JSON so the operator's transcript can
 * mechanically extract one JSON object per line. `errorMessage` is passed
 * through {@link redact} a second time defensively (it is already redacted by
 * {@link ArmHttpClient}), and no header value or body is ever included.
 */
export function formatProtocolObservation(obs: ProtocolObservation): string {
  return `RV-OBSERVATION ${JSON.stringify({ ...obs, errorMessage: obs.errorMessage === undefined ? undefined : redact(obs.errorMessage) })}`;
}

/** Reads `error.code` from an ARM error envelope, if present (VF10). */
export function bodyErrorCode(json: unknown): string | undefined {
  const code = (json as { error?: { code?: unknown } } | null)?.error?.code;
  return typeof code === 'string' ? code : undefined;
}

/** Bound on how much ARM-provided message/detail text is retained per error (avoid unbounded log growth). */
const ARM_MESSAGE_MAX_CHARS = 2000;

interface ArmErrorDetail {
  code?: unknown;
  message?: unknown;
  details?: unknown;
}

/**
 * Reads `error.message` plus nested `error.details[].message` from an ARM error
 * envelope (FR12): authentication/request failures otherwise lose actionable
 * diagnostics beyond the bare `error.code`. Nested details are flattened,
 * de-duplicated by order of appearance, and the combined text is bounded so a
 * pathological body cannot bloat logs/outputs. Secret-shaped content is NOT
 * scrubbed here — the caller (via `redact`) scrubs the final combined text
 * before logging.
 */
export function bodyErrorMessage(json: unknown): string | undefined {
  const error = (json as { error?: ArmErrorDetail } | null)?.error;
  if (error === undefined || error === null) return undefined;
  const parts: string[] = [];
  const seen = new Set<string>();
  const addMessage = (m: unknown): void => {
    if (typeof m === 'string' && m.length > 0 && !seen.has(m)) {
      seen.add(m);
      parts.push(m);
    }
  };
  addMessage(error.message);
  const visitDetails = (details: unknown, depth: number): void => {
    if (!Array.isArray(details) || depth > 5) return;
    for (const detail of details) {
      const d = detail as ArmErrorDetail | undefined;
      if (d === undefined || d === null) continue;
      addMessage(d.message);
      visitDetails(d.details, depth + 1);
    }
  };
  visitDetails(error.details, 0);
  if (parts.length === 0) return undefined;
  const combined = parts.join(' | ');
  return combined.length > ARM_MESSAGE_MAX_CHARS ? `${combined.slice(0, ARM_MESSAGE_MAX_CHARS)}…` : combined;
}

// ---------------------------------------------------------------------------
// Wire-body helpers shared by the validation and run state machines (DX2).
// The generated models expose `properties.status`, `startTime`/`endTime`, and
// two error channels: `errors` (system) plus a business channel that differs by
// resource (`validationErrors` for validation, `executionErrors` for runs).
// ---------------------------------------------------------------------------

export interface ResourceStatus {
  status: string | undefined;
  startTime: string | undefined;
  endTime: string | undefined;
  errors: unknown[];
  businessErrors: unknown[];
  armErrorCode: string | undefined;
  armErrorMessage: string | undefined;
}

function firstCode(arr: unknown[]): string | undefined {
  const code = (arr[0] as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' ? code : undefined;
}

function firstMessage(arr: unknown[]): string | undefined {
  const message = (arr[0] as { message?: unknown } | undefined)?.message;
  return typeof message === 'string' && message.length > 0 ? message : undefined;
}

/** Reads the DX2 status shape from a resource body, given its business channel. */
export function readResourceStatus(json: unknown, businessChannel: string): ResourceStatus {
  const props = (json as { properties?: Record<string, unknown> } | null)?.properties ?? {};
  const asString = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
  const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
  const errors = asArray(props['errors']);
  const businessErrors = asArray(props[businessChannel]);
  return {
    status: asString(props['status']),
    startTime: asString(props['startTime']),
    endTime: asString(props['endTime']),
    errors,
    businessErrors,
    // ARM `error.code` is customer-actionable (VF10); prefer the system channel.
    armErrorCode: firstCode(errors) ?? firstCode(businessErrors),
    // Preserve the matching actionable message alongside the code (R5/FR12).
    armErrorMessage: firstMessage(errors) ?? firstMessage(businessErrors),
  };
}

/**
 * Fail a GET (poll / best-effort observation) whose response is not 2xx. `401`/
 * `403` map to `auth`; everything else to `transport`, preserving the ARM error
 * code and correlation context (FR12). GET handling stays separate from POST
 * acceptance ({@link raiseForAcceptance}): a GET's contract is "any 2xx is
 * readable, terminality is decided by `properties.status`", not "exactly 202".
 */
export function raiseForActionStatus(res: ParsedResponse, action: string): void {
  if (res.status >= 200 && res.status < 300) return;
  const category = res.status === 401 || res.status === 403 ? 'auth' : 'transport';
  throw new CoreError(category, `${action} failed with status ${res.status}`, {
    armErrorCode: res.errorCode,
    armErrorMessage: res.errorMessage,
    correlationId: res.correlationId,
    requestId: res.requestId,
  });
}

/**
 * Fail an initiating action POST (`validate`/`execute`/`cancel`) whose
 * acceptance is not EXACTLY 202 (R4). The pinned LRO protocol is
 * 202-accepted → poll to terminal; an off-contract `200`/`201` (even one
 * carrying an otherwise-valid `Location`) is not a legitimate acceptance and
 * must fail closed rather than proceed as if it were. `401`/`403` map to
 * `auth`; everything else (including a wrong-but-still-2xx status) to
 * `transport`, preserving the ARM error code and correlation context (FR12).
 * The no-POST-retry policy (D14) is preserved: this only classifies the
 * single response already received, it never re-POSTs.
 */
export function raiseForAcceptance(res: ParsedResponse, action: string): void {
  if (res.status === 202) return;
  const category = res.status === 401 || res.status === 403 ? 'auth' : 'transport';
  throw new CoreError(category, `${action} failed: expected a 202 acceptance, observed status ${res.status}`, {
    armErrorCode: res.errorCode,
    armErrorMessage: res.errorMessage,
    correlationId: res.correlationId,
    requestId: res.requestId,
  });
}

// ---------------------------------------------------------------------------
// Default real transport (used by the adapters; never exercised by unit tests).
// ---------------------------------------------------------------------------

export const fetchTransport: IHttpTransport = {
  async send(req, signal) {
    const res = await fetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body,
      signal,
    });
    const body = await res.text();
    const headers: Record<string, string> = {};
    res.headers.forEach((value, key) => {
      headers[key] = value;
    });
    return { status: res.status, headers, body };
  },
};
