/**
 * index.ts (E3-T1/T2) — the GitHub Action entry point. It is the file the root
 * `action.yml` runs (via the committed `dist/github-action/` bundle). It performs
 * only composition: wire the real `@actions/core` host, the AzureCliCredential
 * token source, and a job-cancellation → `AbortSignal` bridge, then hand them to
 * the pure {@link runGithubAction} adapter. No service logic lives here.
 */

import { pathToFileURL } from 'node:url';

import { runGithubAction } from './adapter.ts';
import { githubActionsHost } from './host.ts';
import { azureCliCredentialProvider } from './auth.ts';
import { redact } from '../../core/src/redaction.ts';

/**
 * Bridge GitHub job cancellation to an {@link AbortSignal}. GitHub Actions
 * cancels a running step by sending `SIGINT` (then `SIGTERM`) to the Node
 * process; the core observes the returned signal to stop polling and, when
 * enabled, to run bounded cancel cleanup (FR11, D9). Returns the signal plus a
 * `dispose` that removes the process listeners.
 */
export function jobCancellationSignal(): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const onSignal = (): void => controller.abort();
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  const dispose = (): void => {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  };
  return { signal: controller.signal, dispose };
}

/**
 * Deterministic, no-side-effect self-test used by the release smoke harness
 * (`scripts/smoke-action-bundle.mjs`). It validates that the bundle's own
 * wiring — host construction, credential-provider construction, and the
 * cancellation bridge — can be exercised WITHOUT touching the network,
 * mutating anything, or reading real inputs. It must be a deliberate,
 * verifiable pass/fail: any thrown error or rejected promise here is a real
 * self-test failure, not merely "exit non-zero because inputs were missing".
 */
export async function runSmokeSelfTest(): Promise<void> {
  // Constructing the host is side-effect-free (no I/O until a method is called).
  githubActionsHost();
  // Constructing the credential provider must not touch the network/CLI; only
  // an actual getArmToken() call would shell out to `az`, which we never call.
  azureCliCredentialProvider();
  // Exercise the cancellation bridge end-to-end (attach + abort + dispose) to
  // prove it does not throw and cleans up its listeners.
  const { signal, dispose } = jobCancellationSignal();
  if (typeof signal.aborted !== 'boolean') {
    throw new Error('smoke self-test: cancellation bridge did not return a usable AbortSignal.');
  }
  dispose();
}

/** Compose the real host/credential/signal and run the Action. */
export async function main(): Promise<void> {
  // Deterministic offline self-test path (release smoke harness only). Must
  // complete and exit 0 ONLY on genuine success — any thrown error below
  // propagates to the catch handler, which fails the process instead of
  // silently exiting 0.
  if (process.env.CHAOS_STUDIO_SMOKE_CHECK === '1') {
    await runSmokeSelfTest();
    process.stdout.write('chaos-studio smoke self-test: OK\n');
    return;
  }
  const { signal, dispose } = jobCancellationSignal();
  try {
    await runGithubAction({
      host: githubActionsHost(),
      cred: azureCliCredentialProvider(),
      signal,
      rvCapture: process.env.CHAOS_STUDIO_RV_CAPTURE === '1',
    });
  } finally {
    dispose();
  }
}

// Run only when executed as the entry module (never on import from tests).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // runGithubAction maps failures to core.setFailed (nonzero exit); a rejection
  // here is an unexpected adapter fault — fail the step rather than crash silently.
  void main().catch((err: unknown) => {
    const message = redact(err instanceof Error ? err.message : String(err));
    if (process.env.CHAOS_STUDIO_SMOKE_CHECK === '1') {
      // The smoke harness requires a real nonzero exit on self-test failure,
      // not a masked core.setFailed (which does not affect process exit code
      // in all hosts). Fail the process directly and deterministically.
      process.stderr.write(`::error::chaos-studio smoke self-test failed: ${message}\n`);
      process.exitCode = 1;
      return;
    }
    // Lazy import avoids loading @actions/core in the pure test paths.
    void import('@actions/core').then((core) => core.setFailed(message));
  });
}
