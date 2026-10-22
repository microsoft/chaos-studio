/**
 * Deterministic test harness for the E2 core (NFR2): a virtual clock, a
 * programmable in-memory transport, and fake adapter interfaces. No wall-clock
 * sleep, no real network, no `az`. Not a `*.test.ts` file, so the test runner
 * treats it as a helper module only.
 */
import type {
  IClock,
  ILogger,
  ICredentialProvider,
  IInputReader,
  IOutputSetter,
} from '../../src/contract.ts';
import type { HttpRequest, HttpResponse, IHttpTransport } from '../../src/http.ts';
import { loadFixture } from '../contract/fixtures.ts';

export const FIXED_TOKEN = 'fake-arm-access-token-value';

/** An AbortError shaped like the DOM one, for deterministic abort propagation. */
export function abortError(): Error {
  const e = new Error('The operation was aborted');
  e.name = 'AbortError';
  return e;
}

/** Virtual clock: `now()` advances only when `sleep()` is called. */
export class FakeClock implements IClock {
  private t: number;
  readonly sleeps: number[] = [];

  constructor(startMs = 1_700_000_000_000) {
    this.t = startMs;
  }

  now(): number {
    return this.t;
  }

  sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(abortError());
        return;
      }
      this.sleeps.push(ms);
      this.t += Math.max(0, ms);
      resolve();
    });
  }

  /** Total virtual time slept, in ms. */
  get totalSleptMs(): number {
    return this.sleeps.reduce((a, b) => a + b, 0);
  }

  /** Advance virtual time WITHOUT recording a sleep (e.g. to simulate request
   *  latency in a transport `onSend` hook). Does not affect `totalSleptMs`. */
  advance(ms: number): void {
    this.t += Math.max(0, ms);
  }
}

type Reply = HttpResponse | { error: unknown } | { hang: true };
type Matcher = string | RegExp | ((req: HttpRequest) => boolean);

interface Route {
  method: 'GET' | 'POST';
  matcher: Matcher;
  replies: Reply[];
}

/** A reply that never resolves until its request signal is aborted (a hung
 *  in-flight request, for deadline/pending-I/O tests). */
export const HANG: { hang: true } = { hang: true };

/** Programmable transport. Routes are matched in registration order; a route's
 *  last reply repeats once its scripted sequence is exhausted. An optional
 *  `onSend` hook runs at the start of every send (e.g. to advance the fake clock,
 *  simulating request latency that can cross a deadline). */
export class FakeTransport implements IHttpTransport {
  readonly requests: HttpRequest[] = [];
  private readonly routes: Route[] = [];
  private readonly onSend: ((req: HttpRequest) => void) | undefined;

  constructor(onSend?: (req: HttpRequest) => void) {
    this.onSend = onSend;
  }

  /** Register a scripted sequence (or single reply) for a method + URL matcher. */
  on(method: 'GET' | 'POST', matcher: Matcher, replies: Reply | Reply[]): this {
    this.routes.push({ method, matcher, replies: Array.isArray(replies) ? [...replies] : [replies] });
    return this;
  }

  send(req: HttpRequest, signal: AbortSignal): Promise<HttpResponse> {
    if (this.onSend) this.onSend(req);
    this.requests.push({ ...req, headers: { ...req.headers } });
    if (signal.aborted) return Promise.reject(abortError());
    const route = this.routes.find((r) => r.method === req.method && matches(r.matcher, req));
    if (!route) {
      return Promise.reject(new Error(`FakeTransport: no route for ${req.method} ${req.url}`));
    }
    const reply = route.replies.length > 1 ? route.replies.shift()! : route.replies[0]!;
    if (isError(reply)) return Promise.reject(reply.error);
    if (isHang(reply)) {
      // A pending request: resolves never; rejects only when its signal aborts
      // (e.g. by the client's deadline watcher).
      return new Promise<HttpResponse>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(abortError()), { once: true });
      });
    }
    return Promise.resolve(cloneResponse(reply));
  }

  /** Requests filtered by method (for assertions such as "exactly one POST"). */
  requestsFor(method: 'GET' | 'POST'): HttpRequest[] {
    return this.requests.filter((r) => r.method === method);
  }
}

function isHang(reply: Reply): reply is { hang: true } {
  return typeof reply === 'object' && reply !== null && 'hang' in reply;
}

function isError(reply: Reply): reply is { error: unknown } {
  return typeof reply === 'object' && reply !== null && 'error' in reply;
}

function matches(matcher: Matcher, req: HttpRequest): boolean {
  if (typeof matcher === 'string') return req.url.includes(matcher);
  if (matcher instanceof RegExp) return matcher.test(req.url);
  return matcher(req);
}

function cloneResponse(res: HttpResponse): HttpResponse {
  return { status: res.status, headers: { ...res.headers }, body: res.body };
}

/** Build an {@link HttpResponse} from a fixture-shaped `{ status, headers, body }`. */
export function response(
  status: number,
  headers: Record<string, string> = {},
  body: unknown = null,
): HttpResponse {
  return {
    status,
    headers,
    body: body === null || body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body),
  };
}

/** Fixed-token credential. An optional `onAcquire` hook runs at the start of each
 *  `getArmToken` (e.g. to advance the fake clock, simulating a slow token exchange). */
export class FakeCredential implements ICredentialProvider {
  readonly calls: string[] = [];
  private readonly token: string;
  private readonly onAcquire: (() => void) | undefined;
  constructor(token = FIXED_TOKEN, onAcquire?: () => void) {
    this.token = token;
    this.onAcquire = onAcquire;
  }
  getArmToken(scope: string): Promise<string> {
    if (this.onAcquire) this.onAcquire();
    this.calls.push(scope);
    return Promise.resolve(this.token);
  }
}

/**
 * Abort-aware credential whose `getArmToken` returns a GENUINELY PENDING promise:
 * it never resolves on its own and only REJECTS (with an AbortError) when its
 * `signal` aborts. This exercises the deadline watcher actually cancelling a
 * hung token exchange — as opposed to {@link FakeCredential}'s synchronous
 * resolve. An optional `settleAfter` count lets the FIRST N acquisitions resolve
 * normally (e.g. a successful execute-POST credential) while a LATER acquisition
 * (the observation) hangs.
 */
export class PendingCredential implements ICredentialProvider {
  readonly calls: string[] = [];
  private readonly token: string;
  private readonly settleAfter: number;
  constructor(settleAfter = 0, token = FIXED_TOKEN) {
    this.settleAfter = settleAfter;
    this.token = token;
  }
  getArmToken(scope: string, signal: AbortSignal): Promise<string> {
    const index = this.calls.length;
    this.calls.push(scope);
    if (index < this.settleAfter) return Promise.resolve(this.token);
    return new Promise<string>((_resolve, reject) => {
      if (signal.aborted) {
        reject(abortError());
        return;
      }
      signal.addEventListener('abort', () => reject(abortError()), { once: true });
    });
  }
}

/**
 * A credential whose `getArmToken` REJECTS with an arbitrary error — simulates a
 * missing login / failed WIF token exchange (R4). Never touches the transport.
 */
export class FailingCredential implements ICredentialProvider {
  readonly calls: string[] = [];
  private readonly err: unknown;
  constructor(err: unknown = new Error('AADSTS700016: no matching federated credential')) {
    this.err = err;
  }
  getArmToken(scope: string): Promise<string> {
    this.calls.push(scope);
    return Promise.reject(this.err);
  }
}

/** Collecting logger; also records masked secrets. */
export class FakeLogger implements ILogger {
  readonly infos: string[] = [];
  readonly warnings: string[] = [];
  readonly errors: string[] = [];
  readonly masked: string[] = [];
  info(m: string): void {
    this.infos.push(m);
  }
  warning(m: string): void {
    this.warnings.push(m);
  }
  error(m: string): void {
    this.errors.push(m);
  }
  mask(secret: string): void {
    this.masked.push(secret);
  }
  /** All log lines, for redaction assertions. */
  get all(): string {
    return [...this.infos, ...this.warnings, ...this.errors].join('\n');
  }
}

/** Input reader over a string map matching the adapter contract. */
export class FakeInputReader implements IInputReader {
  private readonly values: Record<string, string | undefined>;
  constructor(values: Record<string, string | undefined>) {
    this.values = values;
  }
  get(name: string): string | undefined {
    return this.values[name];
  }
  getRequired(name: string): string {
    const v = this.values[name];
    if (v === undefined || v === '') throw new Error(`missing required input '${name}'`);
    return v;
  }
  getBool(name: string, dflt: boolean): boolean {
    const v = this.values[name];
    if (v === undefined || v === '') return dflt;
    return v.trim().toLowerCase() === 'true';
  }
  getInt(name: string, dflt: number): number {
    const v = this.values[name];
    if (v === undefined || v === '') return dflt;
    const n = Number.parseInt(v, 10);
    return Number.isNaN(n) ? dflt : n;
  }
}

/** Output setter recording every set value. */
export class FakeOutputSetter implements IOutputSetter {
  readonly values: Record<string, string> = {};
  set(name: string, value: string): void {
    this.values[name] = value;
  }
}

/** Deterministic RNG returning a constant in [0,1); default mid-jitter. */
export function fixedRng(value = 0.5): () => number {
  return () => value;
}

/** Load a contract fixture and convert its response(s) into transport replies. */
export function fixtureResponses(...segments: string[]): HttpResponse[] {
  const fx = loadFixture(...segments);
  const steps = fx.sequence ? fx.sequence.map((s) => s.response) : fx.response ? [fx.response] : [];
  return steps.map((r) => response(r.status ?? 200, r.headers ?? {}, r.body ?? null));
}
