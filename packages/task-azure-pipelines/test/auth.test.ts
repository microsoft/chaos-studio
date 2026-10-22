import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';

import type { AccessToken, GetTokenOptions, TokenCredential } from '@azure/identity';
import { ARM_SCOPE } from '../../core/src/http.ts';
import {
  ServiceConnectionCredentialProvider,
  armServiceConnectionCredentialProvider,
} from '../src/auth.ts';

// These are OFFLINE tests with injected dependencies — they load `@azure/identity`
// (via auth.ts, which imports its types + ClientAssertionCredential) but never
// construct the real credential or touch the network: every case injects a fake
// TokenCredential. Only the guarded live WIF test at the bottom uses the real path.

/** A fake TokenCredential capturing the scope + abort signal, no network. */
class FakeTokenCredential implements TokenCredential {
  readonly requests: Array<{ scopes: string | string[]; signal: AbortSignal | undefined }> = [];
  private readonly result: AccessToken | null;
  constructor(result: AccessToken | null = { token: 'arm-token-123', expiresOnTimestamp: Date.now() + 3_600_000 }) {
    this.result = result;
  }
  getToken(scopes: string | string[], options?: GetTokenOptions): Promise<AccessToken | null> {
    this.requests.push({ scopes, signal: options?.abortSignal as AbortSignal | undefined });
    return Promise.resolve(this.result);
  }
}

/**
 * A credential that IGNORES `GetTokenOptions.abortSignal` and never settles on its
 * own — the test drives its eventual (late) completion or rejection. Proves the
 * provider rejects promptly on abort and safely swallows the ignored operation's
 * late settlement (parity with the GitHub adapter's credential hardening).
 */
class IgnoresAbortCredential implements TokenCredential {
  calls = 0;
  private resolveToken!: (t: AccessToken | null) => void;
  private rejectToken!: (e: unknown) => void;
  private readonly deferred: Promise<AccessToken | null>;
  constructor() {
    this.deferred = new Promise<AccessToken | null>((res, rej) => {
      this.resolveToken = res;
      this.rejectToken = rej;
    });
  }
  getToken(): Promise<AccessToken | null> {
    this.calls += 1;
    return this.deferred;
  }
  completeLate(token: AccessToken | null): void {
    this.resolveToken(token);
  }
  failLate(err: unknown): void {
    this.rejectToken(err);
  }
}

/** Yield one macrotask so any pending 'unhandledRejection' would be delivered. */
function nextTick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

test('ServiceConnectionCredentialProvider requests the ARM scope with the abort signal and returns the token string', async () => {
  const fake = new FakeTokenCredential();
  const provider = new ServiceConnectionCredentialProvider(fake);
  const controller = new AbortController();

  const token = await provider.getArmToken(ARM_SCOPE, controller.signal);

  assert.equal(token, 'arm-token-123');
  assert.equal(fake.requests.length, 1);
  assert.equal(fake.requests[0]!.scopes, ARM_SCOPE, 'the ARM .default scope is passed through');
  assert.equal(fake.requests[0]!.signal, controller.signal, 'the cancellation signal is forwarded to the credential');
});

test('ServiceConnectionCredentialProvider throws an actionable error when the credential returns no token', async () => {
  const provider = new ServiceConnectionCredentialProvider(new FakeTokenCredential(null));
  await assert.rejects(
    () => provider.getArmToken(ARM_SCOPE, new AbortController().signal),
    /service connection.*workload-identity/s,
  );
});

test('ServiceConnectionCredentialProvider throws when the credential yields an empty token string', async () => {
  const provider = new ServiceConnectionCredentialProvider(
    new FakeTokenCredential({ token: '', expiresOnTimestamp: Date.now() }),
  );
  await assert.rejects(() => provider.getArmToken(ARM_SCOPE, new AbortController().signal), /no access token/);
});

test('armServiceConnectionCredentialProvider factory returns a provider bound to the injected credential', async () => {
  const fake = new FakeTokenCredential({ token: 'factory-token', expiresOnTimestamp: Date.now() + 1000 });
  const connection = { tenantId: 't', clientId: 'c', getAssertion: () => Promise.resolve('assertion') };
  const provider = armServiceConnectionCredentialProvider(connection, fake);
  assert.equal(await provider.getArmToken(ARM_SCOPE, new AbortController().signal), 'factory-token');
});

test('getArmToken rejects promptly with AbortError when the signal aborts even though the credential ignores cancellation', async () => {
  const cred = new IgnoresAbortCredential();
  const provider = new ServiceConnectionCredentialProvider(cred);
  const controller = new AbortController();

  const pending = provider.getArmToken(ARM_SCOPE, controller.signal);
  controller.abort();

  await assert.rejects(pending, (e: Error) => e.name === 'AbortError');
  assert.equal(cred.calls, 1, 'the token acquisition was attempted before the abort');
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0, 'the abort listener was removed');
});

test('getArmToken rejects immediately for an already-aborted signal without starting an acquisition', async () => {
  const cred = new IgnoresAbortCredential();
  const provider = new ServiceConnectionCredentialProvider(cred);
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    () => provider.getArmToken(ARM_SCOPE, controller.signal),
    (e: Error) => e.name === 'AbortError',
  );
  assert.equal(cred.calls, 0, 'no acquisition is started for an already-aborted signal');
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0, 'no abort listener leaked');
});

test('a late settlement of the ignored credential (after abort) is swallowed, never an unhandled rejection', async () => {
  const cred = new IgnoresAbortCredential();
  const provider = new ServiceConnectionCredentialProvider(cred);
  const controller = new AbortController();
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason);
  };
  process.on('unhandledRejection', onUnhandled);
  try {
    const pending = provider.getArmToken(ARM_SCOPE, controller.signal);
    controller.abort();
    await assert.rejects(pending, (e: Error) => e.name === 'AbortError');

    cred.failLate(new Error('token exchange failed after cancellation'));
    await nextTick();
    assert.deepEqual(unhandled, [], 'a late credential rejection is safely swallowed');

    cred.completeLate({ token: 'too-late', expiresOnTimestamp: Date.now() });
    await nextTick();
    assert.deepEqual(unhandled, [], 'a late credential resolution is a harmless no-op');
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

/**
 * WIF integration test (NFR3: no long-lived secret). The task authenticates ONLY
 * through the ARM service connection's workload-identity federation: an Azure
 * DevOps OIDC token (minted per job) is exchanged with Entra ID for an ARM token —
 * there is no client secret anywhere. This proves the WIF path end-to-end and is
 * GATED on an opt-in env var so the default (offline, secretless) unit run stays
 * deterministic. When `RUN_WIF_INTEGRATION` is set (inside an Azure Pipelines job
 * whose `azureSubscription` is a WIF ARM connection), it acquires a real ARM token
 * and asserts a non-empty JWT was returned without any secret input.
 */
test('WIF integration: the ARM service connection yields an ARM token via workload identity (no secret)', async (t) => {
  if (process.env['RUN_WIF_INTEGRATION'] !== '1') {
    t.skip('set RUN_WIF_INTEGRATION=1 in a WIF-authenticated Azure Pipelines job to run the live token exchange');
    return;
  }
  // Dynamic import so the pure unit run never loads azure-pipelines-task-lib.
  const { readArmServiceConnection } = await import('../src/host.ts');
  const provider = armServiceConnectionCredentialProvider(readArmServiceConnection());
  const token = await provider.getArmToken(ARM_SCOPE, new AbortController().signal);
  assert.ok(token.length > 0, 'a real ARM access token was acquired via workload identity');
  assert.equal(token.split('.').length, 3, 'the ARM token is a JWT');
});
