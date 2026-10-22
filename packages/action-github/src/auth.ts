/**
 * auth.ts (E3-T2) — the GitHub adapter's {@link ICredentialProvider}, backed by
 * `@azure/identity`'s {@link AzureCliCredential}. It reuses the Azure CLI session
 * established by the `azure/login` step (workload identity federation, WIF) — so
 * there is NO long-lived secret in the workflow (NFR3); the OIDC token is
 * exchanged by `azure/login` and this credential simply reads the resulting CLI
 * session for an ARM access token.
 *
 * The underlying {@link TokenCredential} is injectable so the adapter's tests can
 * supply a fake and stay deterministic (no `az`, no network, no secret). The real
 * {@link AzureCliCredential} is constructed only when no credential is injected.
 *
 * Cancellation note: the locked `@azure/identity` 4.13.2 `AzureCliCredential`
 * does NOT honor `GetTokenOptions.abortSignal` — it shells out to `az account
 * get-access-token` and awaits the subprocess regardless of the signal. Two
 * measures make cancellation effective anyway so the core can reach best-effort
 * experiment cancellation before GitHub force-terminates the runner:
 *  1. a finite `processTimeoutInMs` bounds the `az` subprocess itself; and
 *  2. {@link AzureCliCredentialProvider.getArmToken} races the acquisition against
 *     its {@link AbortSignal} and rejects promptly on abort (including an
 *     already-aborted signal), cleaning up its listener and swallowing any late
 *     settlement of the ignored underlying operation.
 */

import { AzureCliCredential, type AccessToken, type TokenCredential } from '@azure/identity';
import type { ICredentialProvider } from '../../core/src/contract.ts';

/**
 * Finite ceiling for the `az account get-access-token` subprocess. Without it the
 * locked SDK leaves the CLI subprocess unbounded, so a hung `az` would keep the
 * credential pending even after this provider has abandoned it. Ten seconds is
 * comfortably longer than a healthy token read yet short enough to fail fast.
 */
const AZ_CLI_PROCESS_TIMEOUT_MS = 10_000;

/** Create an AbortError shaped like the DOM one (name `AbortError`). */
function abortError(): Error {
  const e = new Error('The operation was aborted');
  e.name = 'AbortError';
  return e;
}

export class AzureCliCredentialProvider implements ICredentialProvider {
  private readonly credential: TokenCredential;

  constructor(credential?: TokenCredential) {
    // The real AzureCliCredential (which shells out to `az`) is created ONLY when
    // no credential is injected — tests always inject a fake, so they never touch
    // the CLI or the network. A finite processTimeoutInMs bounds the `az`
    // subprocess so a hung CLI cannot keep the credential pending without limit.
    this.credential = credential ?? new AzureCliCredential({ processTimeoutInMs: AZ_CLI_PROCESS_TIMEOUT_MS });
  }

  async getArmToken(scope: string, signal: AbortSignal): Promise<string> {
    const token = await this.acquireObservingAbort(scope, signal);
    if (!token || !token.token) {
      throw new Error(
        'AzureCliCredential returned no access token. Ensure an `azure/login` step ' +
          'with workload identity (permissions: id-token: write) ran before this step.',
      );
    }
    return token.token;
  }

  /**
   * Acquire a token but reject PROMPTLY the moment `signal` aborts, independently
   * of whether the underlying credential honors the abort. The core's HTTP client
   * aborts this signal when the completion deadline elapses (FR10); the locked SDK
   * ignores it, so without this race the core would stay blocked on the credential
   * and could never reach best-effort experiment cancellation.
   *
   *  - an already-aborted signal rejects immediately, without starting an `az`
   *    acquisition that we would only abandon;
   *  - the abort listener is removed on settlement (win or lose) so nothing leaks;
   *  - if the ignored underlying acquisition settles LATE (after we already
   *    rejected on abort), its result/rejection is swallowed via the `settled`
   *    guard on the handlers we keep attached, so it never becomes an unhandled
   *    rejection.
   */
  private acquireObservingAbort(scope: string, signal: AbortSignal): Promise<AccessToken | null> {
    if (signal.aborted) return Promise.reject(abortError());
    // Still forward the signal (defense in depth: a future SDK that honors it will
    // cancel the `az` subprocess early); today the race below is what enforces it.
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

/** Factory for the GitHub adapter's ARM credential (injectable for tests). */
export function azureCliCredentialProvider(credential?: TokenCredential): ICredentialProvider {
  return new AzureCliCredentialProvider(credential);
}
