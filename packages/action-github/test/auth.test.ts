import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';

import type { AccessToken, GetTokenOptions, TokenCredential } from '@azure/identity';
import { ARM_SCOPE } from '../../core/src/http.ts';
import { AzureCliCredentialProvider, azureCliCredentialProvider } from '../src/auth.ts';

/** A fake TokenCredential capturing the scope + abort signal, with no `az`/network. */
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
 * A credential that models the locked `@azure/identity` 4.13.2 `AzureCliCredential`:
 * it IGNORES `GetTokenOptions.abortSignal` and never settles on its own — the test
 * drives its eventual (late) completion or rejection so we can prove the provider
 * rejects promptly on abort and safely swallows the ignored operation's late result.
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
  getToken(_scopes: string | string[], _options?: GetTokenOptions): Promise<AccessToken | null> {
    this.calls += 1;
    // Deliberately ignores _options.abortSignal (matching the locked SDK version).
    return this.deferred;
  }
  /** Test hook: resolve the still-pending acquisition LATE (after the provider aborted). */
  completeLate(token: AccessToken | null): void {
    this.resolveToken(token);
  }
  /** Test hook: reject the still-pending acquisition LATE (after the provider aborted). */
  failLate(err: unknown): void {
    this.rejectToken(err);
  }
}

/** Yield one macrotask so any pending 'unhandledRejection' would be delivered. */
function nextTick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

test('AzureCliCredentialProvider requests the ARM scope with the abort signal and returns the token string', async () => {
  const fake = new FakeTokenCredential();
  const provider = new AzureCliCredentialProvider(fake);
  const controller = new AbortController();

  const token = await provider.getArmToken(ARM_SCOPE, controller.signal);

  assert.equal(token, 'arm-token-123');
  assert.equal(fake.requests.length, 1);
  assert.equal(fake.requests[0]!.scopes, ARM_SCOPE, 'the ARM .default scope is passed through');
  assert.equal(fake.requests[0]!.signal, controller.signal, 'the cancellation signal is forwarded to the credential');
});

test('AzureCliCredentialProvider throws an actionable error when the credential returns no token (missing azure/login)', async () => {
  const provider = new AzureCliCredentialProvider(new FakeTokenCredential(null));
  await assert.rejects(
    () => provider.getArmToken(ARM_SCOPE, new AbortController().signal),
    /azure\/login.*id-token: write/s,
  );
});

test('AzureCliCredentialProvider throws when the credential yields an empty token string', async () => {
  const provider = new AzureCliCredentialProvider(
    new FakeTokenCredential({ token: '', expiresOnTimestamp: Date.now() }),
  );
  await assert.rejects(() => provider.getArmToken(ARM_SCOPE, new AbortController().signal), /no access token/);
});

test('azureCliCredentialProvider factory returns a provider bound to the injected credential', async () => {
  const fake = new FakeTokenCredential({ token: 'factory-token', expiresOnTimestamp: Date.now() + 1000 });
  const provider = azureCliCredentialProvider(fake);
  assert.equal(await provider.getArmToken(ARM_SCOPE, new AbortController().signal), 'factory-token');
});

test('getArmToken rejects promptly with AbortError when the signal aborts even though the credential ignores cancellation', async () => {
  const cred = new IgnoresAbortCredential();
  const provider = new AzureCliCredentialProvider(cred);
  const controller = new AbortController();

  const pending = provider.getArmToken(ARM_SCOPE, controller.signal);
  // The credential never settles on its own; only the abort can unblock getArmToken.
  controller.abort();

  await assert.rejects(pending, (e: Error) => e.name === 'AbortError');
  assert.equal(cred.calls, 1, 'the token acquisition was attempted before the abort');
  // Listener cleanup: no 'abort' listener remains on the signal after settlement.
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0, 'the abort listener was removed');
});

test('getArmToken rejects immediately for an already-aborted signal without starting an acquisition', async () => {
  const cred = new IgnoresAbortCredential();
  const provider = new AzureCliCredentialProvider(cred);
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    () => provider.getArmToken(ARM_SCOPE, controller.signal),
    (e: Error) => e.name === 'AbortError',
  );
  assert.equal(cred.calls, 0, 'no `az` acquisition is started for an already-aborted signal');
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0, 'no abort listener leaked');
});

test('a late settlement of the ignored credential (after abort) is swallowed, never an unhandled rejection', async () => {
  const cred = new IgnoresAbortCredential();
  const provider = new AzureCliCredentialProvider(cred);
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

    // The ignored acquisition finally rejects LATE (e.g. the `az` subprocess dies
    // after we abandoned it). It must be consumed by the still-attached handlers.
    cred.failLate(new Error('az account get-access-token failed after cancellation'));
    await nextTick();
    assert.deepEqual(unhandled, [], 'a late credential rejection is safely swallowed');

    // A late RESOLVE is likewise a guarded no-op (does not resolve the already
    // rejected getArmToken, does not throw).
    cred.completeLate({ token: 'too-late', expiresOnTimestamp: Date.now() });
    await nextTick();
    assert.deepEqual(unhandled, [], 'a late credential resolution is a harmless no-op');
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

/**
 * WIF integration test (NFR3: no long-lived secret). The adapter authenticates
 * ONLY through {@link AzureCliCredential}, which reads the Azure CLI session that
 * `azure/login` established via OIDC/workload-identity federation — there is no
 * client secret anywhere in the flow. This test proves the WIF path end-to-end
 * against a real ARM token endpoint and is therefore GATED on an opt-in env var
 * so the default (offline, secretless) unit run stays deterministic. When
 * `RUN_WIF_INTEGRATION` is set (in a WIF-authenticated job with
 * `permissions: id-token: write`), it acquires a real ARM token and asserts a
 * non-empty JWT was returned without any secret input.
 */
test('WIF integration: AzureCliCredential yields an ARM token from the azure/login session (no secret)', async (t) => {
  if (process.env['RUN_WIF_INTEGRATION'] !== '1') {
    t.skip('set RUN_WIF_INTEGRATION=1 in a WIF-authenticated job to run the live token exchange');
    return;
  }
  // Real credential (no injection) → reads the azure/login WIF CLI session.
  const provider = azureCliCredentialProvider();
  const token = await provider.getArmToken(ARM_SCOPE, new AbortController().signal);
  assert.ok(token.length > 0, 'a real ARM access token was acquired via workload identity');
  assert.equal(token.split('.').length, 3, 'the ARM token is a JWT');
});
