/**
 * auth.ts (E4-T2) — the Azure Pipelines task's {@link ICredentialProvider},
 * backed by `@azure/identity`'s {@link ClientAssertionCredential}. It authenticates
 * to ARM through the pipeline's ARM SERVICE CONNECTION using workload identity
 * federation (WIF): the client assertion is a short-lived Azure DevOps OIDC token
 * (minted per job by {@link file://./host.ts}), exchanged with Entra ID for an ARM
 * access token — so there is NO long-lived client secret in the pipeline (NFR3).
 *
 * The underlying {@link TokenCredential} is injectable so the adapter's tests can
 * supply a fake and stay deterministic (no network, no service connection, no
 * secret). The real {@link ClientAssertionCredential} is constructed only when no
 * credential is injected. This mirrors the GitHub adapter's `AzureCliCredential`
 * provider one-for-one (same abort-honoring behavior), differing only in the
 * token source (ADO service-connection WIF vs the `azure/login` CLI session).
 */

import { ClientAssertionCredential, type AccessToken, type TokenCredential } from '@azure/identity';
import type { ICredentialProvider } from '../../core/src/contract.ts';

/**
 * The workload-identity-federation parameters read from the ARM service
 * connection ({@link file://./host.ts}). `getAssertion` mints the Azure DevOps
 * OIDC token used as the client assertion in the federated exchange.
 */
export interface ArmServiceConnection {
  tenantId: string;
  clientId: string;
  getAssertion: () => Promise<string>;
}

/** Create an AbortError shaped like the DOM one (name `AbortError`). */
function abortError(): Error {
  const e = new Error('The operation was aborted');
  e.name = 'AbortError';
  return e;
}

export class ServiceConnectionCredentialProvider implements ICredentialProvider {
  private readonly credential: TokenCredential;

  constructor(credential: TokenCredential) {
    this.credential = credential;
  }

  async getArmToken(scope: string, signal: AbortSignal): Promise<string> {
    const token = await this.acquireObservingAbort(scope, signal);
    if (!token || !token.token) {
      throw new Error(
        'the ARM service connection returned no access token. Ensure the task\u2019s `azureSubscription` input ' +
          'references a workload-identity-federation ARM service connection with access to the Chaos Studio workspace.',
      );
    }
    return token.token;
  }

  /**
   * Acquire a token but reject PROMPTLY the moment `signal` aborts, independently
   * of whether the underlying credential honors the abort. The core's HTTP client
   * aborts this signal when the completion deadline elapses (FR10); without this
   * race a credential that ignored the signal would keep the core blocked and it
   * could never reach best-effort experiment cancellation.
   *
   *  - an already-aborted signal rejects immediately, without starting an
   *    acquisition that we would only abandon;
   *  - the abort listener is removed on settlement (win or lose) so nothing leaks;
   *  - if the ignored underlying acquisition settles LATE (after we already
   *    rejected on abort), its result/rejection is swallowed via the `settled`
   *    guard on the handlers we keep attached, so it never becomes an unhandled
   *    rejection.
   */
  private acquireObservingAbort(scope: string, signal: AbortSignal): Promise<AccessToken | null> {
    if (signal.aborted) return Promise.reject(abortError());
    // Still forward the signal (defense in depth: a credential that honors it can
    // cancel its in-flight request early); the race below is what enforces it.
    const pending = this.credential.getToken(scope, { abortSignal: signal });
    return new Promise((resolve, reject) => {
      let settled = false;
      const onAbort = (): void => {
        settled = true;
        reject(abortError());
      };
      signal.addEventListener('abort', onAbort, { once: true });
      // These handlers remain attached even after an abort rejection, so a late
      // settlement of the ignored `pending` operation is always consumed here
      // (guarded no-op) rather than surfacing as an unhandled rejection.
      pending.then(
        (value) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener('abort', onAbort);
          resolve(value);
        },
        (err) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener('abort', onAbort);
          reject(err);
        },
      );
    });
  }
}

/**
 * Factory for the task's ARM credential. The real
 * {@link ClientAssertionCredential} is built from the service-connection WIF
 * parameters only when no credential is injected (tests inject a fake and never
 * touch `@azure/identity` or the network).
 */
export function armServiceConnectionCredentialProvider(
  connection: ArmServiceConnection,
  credential?: TokenCredential,
): ICredentialProvider {
  const cred =
    credential ??
    new ClientAssertionCredential(connection.tenantId, connection.clientId, connection.getAssertion);
  return new ServiceConnectionCredentialProvider(cred);
}
