/**
 * oidc.ts (E4-T2) — the PURE, task-lib-free HTTP exchange that mints the Azure
 * DevOps federated OIDC token used as the client assertion in the workload-identity
 * flow. {@link file://./host.ts} reads the job's pipeline variables (via task-lib)
 * and delegates the actual request here, so this logic is unit-testable with a fake
 * transport + fake timers and never loads `azure-pipelines-task-lib` (NFR2/NFR3).
 *
 * The request is bounded by an ABSOLUTE deadline (not a socket-inactivity timeout):
 * a continuously-active response that keeps streaming bytes but never ends is still
 * destroyed at the deadline, and the deadline timer is cleared on every settlement
 * path so nothing leaks.
 */

import { request as httpsRequest } from 'node:https';

/** The minimal client-request surface the exchange uses (real `https.ClientRequest` satisfies it). */
export interface OidcClientRequest {
  on(event: 'error', listener: (err: Error) => void): unknown;
  destroy(err?: Error): unknown;
  end(): unknown;
}

/** The minimal response surface the exchange uses (real `http.IncomingMessage` satisfies it). */
export interface OidcResponse {
  statusCode?: number | undefined;
  on(event: 'data', listener: (chunk: Buffer) => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
  on(event: 'aborted', listener: () => void): unknown;
  on(event: 'end', listener: () => void): unknown;
}

/** Injectable request function; the default is a thin wrapper over `node:https`. */
export type OidcRequestFn = (
  url: URL,
  options: { method: string; headers: Record<string, string> },
  callback: (res: OidcResponse) => void,
) => OidcClientRequest;

export interface FetchOidcTokenDeps {
  /** Injectable transport (tests pass a fake); defaults to `node:https`. */
  request?: OidcRequestFn;
  /** Absolute deadline in ms; defaults to 10s. */
  deadlineMs?: number;
}

/** Default transport: normalize `https.request(url, options, cb)` to {@link OidcRequestFn}. */
const defaultRequest: OidcRequestFn = (url, options, callback) =>
  httpsRequest(url, options, (res) => callback(res as unknown as OidcResponse));

/** Absolute request-lifetime ceiling for the OIDC token exchange. */
const DEFAULT_DEADLINE_MS = 10_000;

/**
 * POST the Azure DevOps OIDC token endpoint and return the `oidcToken` string.
 * Fails closed (rejects) on transport error, an aborted/truncated response, a
 * non-2xx status, invalid JSON, a missing token, OR the absolute deadline — and
 * always destroys the in-flight request and clears the deadline timer on every
 * settlement path so no request or timer outlives the call.
 */
export async function fetchOidcToken(
  url: URL,
  accessToken: string,
  deps: FetchOidcTokenDeps = {},
): Promise<string> {
  const doRequest = deps.request ?? defaultRequest;
  const deadlineMs = deps.deadlineMs ?? DEFAULT_DEADLINE_MS;

  const body = await new Promise<string>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let req: OidcClientRequest | undefined;

    // Every settlement path runs through here: it guards against double-settle,
    // clears the absolute-deadline timer, and destroys the in-flight request so a
    // still-open socket (e.g. a response that keeps streaming) cannot outlive us.
    const done = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      req?.destroy();
      fn();
    };

    req = doRequest(
      url,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/json',
          accept: 'application/json',
          'content-length': '0',
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('error', (err) => done(() => reject(err)));
        // A truncated/aborted response must settle the promise, not hang.
        res.on('aborted', () => done(() => reject(new Error('Azure DevOps OIDC token response was aborted'))));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          const status = res.statusCode ?? 0;
          if (status < 200 || status >= 300) {
            done(() => reject(new Error(`Azure DevOps OIDC token request failed (HTTP ${status})`)));
            return;
          }
          done(() => resolve(text));
        });
      },
    );
    req.on('error', (err) => done(() => reject(err)));

    // ABSOLUTE deadline (independent of socket activity): destroy the request and
    // reject once the wall budget elapses, even if the response is still streaming.
    // `done` clears this timer on any earlier settlement. The callback references
    // `req`, which is assigned synchronously above before this timer can fire.
    timer = setTimeout(() => {
      done(() => reject(new Error('Azure DevOps OIDC token request timed out')));
    }, deadlineMs);

    req.end();
  });

  let oidcToken: unknown;
  try {
    oidcToken = (JSON.parse(body) as { oidcToken?: unknown }).oidcToken;
  } catch {
    throw new Error('Azure DevOps OIDC token response was not valid JSON');
  }
  if (typeof oidcToken !== 'string' || oidcToken.length === 0) {
    throw new Error('Azure DevOps OIDC token response did not contain an oidcToken');
  }
  return oidcToken;
}
