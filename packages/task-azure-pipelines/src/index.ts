/**
 * index.ts (E4-T1/T2) — the Azure Pipelines task entry point. It is the file the
 * task's `Node20_1` execution handler runs (via the committed
 * `dist/azure-pipelines-task/` bundle staged into the task folder). It performs
 * only composition: wire the real `azure-pipelines-task-lib` host, the ARM
 * service-connection (WIF) credential, and a cancellation → `AbortSignal` bridge,
 * then hand them to the pure {@link runAzurePipelinesTask} adapter. No service
 * logic lives here.
 */

import { pathToFileURL } from 'node:url';

import { runAzurePipelinesTask } from './adapter.ts';
import { azurePipelinesTaskHost, readArmServiceConnection } from './host.ts';
import { armServiceConnectionCredentialProvider } from './auth.ts';
import { redact } from '../../core/src/redaction.ts';

/**
 * Bridge Azure Pipelines task cancellation to an {@link AbortSignal}. The agent
 * cancels a running task by sending `SIGINT` (then `SIGTERM`) to the Node
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

/** Compose the real host/credential/signal and run the task. */
export async function main(): Promise<void> {
  const host = azurePipelinesTaskHost();
  const { signal, dispose } = jobCancellationSignal();
  try {
    // Reading the ARM service connection is a configuration step; a misconfigured
    // (or non-WIF) connection must fail the task deterministically rather than
    // crash before the adapter runs.
    let cred;
    try {
      cred = armServiceConnectionCredentialProvider(readArmServiceConnection());
    } catch (err) {
      const message = redact(err instanceof Error ? err.message : String(err));
      host.setResult(false, message || 'Azure Chaos Studio task failed.');
      return;
    }
    await runAzurePipelinesTask({ host, cred, signal });
  } finally {
    dispose();
  }
}

// Run only when executed as the entry module (never on import from tests).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // runAzurePipelinesTask maps failures to tl.setResult(Failed); a rejection here
  // is an unexpected adapter fault — fail the task rather than crash silently.
  void main().catch((err: unknown) => {
    const message = redact(err instanceof Error ? err.message : String(err));
    // Lazy import avoids loading the task library in the pure test paths.
    void import('azure-pipelines-task-lib/task.js').then((tl) =>
      tl.setResult(tl.TaskResult.Failed, message, true),
    );
  });
}
