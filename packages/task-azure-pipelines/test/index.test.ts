import { test } from 'node:test';
import assert from 'node:assert/strict';

import { jobCancellationSignal, main, runSmokeSelfTest } from '../src/index.ts';

// NOTE: importing ../src/index.ts loads the real azure-pipelines-task-lib +
// @azure/identity (this is the composition-root entry test — an OFFLINE test with
// injected/guarded deps, unlike the SDK-free adapter/parity/oidc tests). It issues
// no real request. The mere fact this import completes — without hanging, exiting,
// or issuing a real request — is itself proof that the main-module guard did NOT
// auto-run main() on import (main() would read the service connection and attempt a
// real orchestration).

test('module import does not execute main (main-module guard): main is exported but not auto-run', () => {
  assert.equal(typeof main, 'function', 'main is exported for the entry to invoke');
  assert.equal(typeof jobCancellationSignal, 'function');
});

test('jobCancellationSignal aborts on SIGINT and cleans up its process listeners', () => {
  const beforeInt = process.listenerCount('SIGINT');
  const beforeTerm = process.listenerCount('SIGTERM');

  const { signal, dispose } = jobCancellationSignal();
  assert.equal(signal.aborted, false, 'not aborted until a signal arrives');
  assert.equal(process.listenerCount('SIGINT'), beforeInt + 1, 'a SIGINT listener is registered');
  assert.equal(process.listenerCount('SIGTERM'), beforeTerm + 1, 'a SIGTERM listener is registered');

  // process.emit invokes the registered listener WITHOUT triggering Node's default
  // signal termination (that only applies to real OS signals).
  process.emit('SIGINT');
  assert.equal(signal.aborted, true, 'SIGINT aborts the signal the core observes');

  dispose();
  assert.equal(process.listenerCount('SIGINT'), beforeInt, 'SIGINT listener removed');
  assert.equal(process.listenerCount('SIGTERM'), beforeTerm, 'SIGTERM listener removed');
});

test('jobCancellationSignal aborts on SIGTERM too', () => {
  const { signal, dispose } = jobCancellationSignal();
  assert.equal(signal.aborted, false);
  process.emit('SIGTERM');
  assert.equal(signal.aborted, true, 'SIGTERM aborts the signal');
  dispose();
});

test('jobCancellationSignal: a second signal is a no-op (idempotent abort) and dispose is safe to call repeatedly', () => {
  const beforeInt = process.listenerCount('SIGINT');
  const { signal, dispose } = jobCancellationSignal();
  process.emit('SIGINT');
  assert.equal(signal.aborted, true);
  assert.doesNotThrow(() => process.emit('SIGINT'));
  assert.doesNotThrow(() => dispose());
  assert.doesNotThrow(() => dispose());
  assert.equal(process.listenerCount('SIGINT'), beforeInt, 'no leaked SIGINT listener');
});

test('runSmokeSelfTest completes without reading a real ARM service connection or leaking listeners', async () => {
  const beforeInt = process.listenerCount('SIGINT');
  const beforeTerm = process.listenerCount('SIGTERM');
  await assert.doesNotReject(runSmokeSelfTest());
  assert.equal(process.listenerCount('SIGINT'), beforeInt, 'self-test disposes its cancellation bridge');
  assert.equal(process.listenerCount('SIGTERM'), beforeTerm, 'self-test disposes its cancellation bridge');
});

test('main() honors CHAOS_STUDIO_SMOKE_CHECK=1 and resolves without reading the service connection', async () => {
  const previous = process.env.CHAOS_STUDIO_SMOKE_CHECK;
  const previousTfBuild = process.env.TF_BUILD;
  process.env.CHAOS_STUDIO_SMOKE_CHECK = '1';
  delete process.env.TF_BUILD; // offline harness environment: never a real agent execution
  try {
    await assert.doesNotReject(main());
  } finally {
    if (previous === undefined) delete process.env.CHAOS_STUDIO_SMOKE_CHECK;
    else process.env.CHAOS_STUDIO_SMOKE_CHECK = previous;
    if (previousTfBuild === undefined) delete process.env.TF_BUILD;
    else process.env.TF_BUILD = previousTfBuild;
  }
});

test('main() REJECTS CHAOS_STUDIO_SMOKE_CHECK=1 inside a real Azure Pipelines execution context (TF_BUILD=True) instead of silently succeeding (R2)', async () => {
  const previous = process.env.CHAOS_STUDIO_SMOKE_CHECK;
  const previousTfBuild = process.env.TF_BUILD;
  process.env.CHAOS_STUDIO_SMOKE_CHECK = '1';
  process.env.TF_BUILD = 'True';
  try {
    await assert.rejects(main(), /not permitted inside a real Azure Pipelines execution context/);
  } finally {
    if (previous === undefined) delete process.env.CHAOS_STUDIO_SMOKE_CHECK;
    else process.env.CHAOS_STUDIO_SMOKE_CHECK = previous;
    if (previousTfBuild === undefined) delete process.env.TF_BUILD;
    else process.env.TF_BUILD = previousTfBuild;
  }
});
