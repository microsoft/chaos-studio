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

/** Compose the real host/credential/signal and run the Action. */
export async function main(): Promise<void> {
  const { signal, dispose } = jobCancellationSignal();
  try {
    await runGithubAction({
      host: githubActionsHost(),
      cred: azureCliCredentialProvider(),
      signal,
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
    // Lazy import avoids loading @actions/core in the pure test paths.
    void import('@actions/core').then((core) => core.setFailed(message));
  });
}
