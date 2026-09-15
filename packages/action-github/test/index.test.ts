import { test } from 'node:test';
import assert from 'node:assert/strict';

import { jobCancellationSignal, main, runSmokeSelfTest } from '../src/index.ts';

// NOTE: importing ../src/index.ts loads the real @actions/core + @azure/identity
// (this is the composition-root test, unlike the pure adapter/parity tests). The
// mere fact this import completes — without hanging, exiting, or shelling out to
// `az` — is itself proof that the main-module guard did NOT auto-run main() on
// import (main() would attempt a real orchestration with the real credential).

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
  // A second SIGINT must not throw (AbortController.abort is idempotent; the once
  // listener has already been removed).
  assert.doesNotThrow(() => process.emit('SIGINT'));
  assert.doesNotThrow(() => dispose());
  assert.doesNotThrow(() => dispose());
  assert.equal(process.listenerCount('SIGINT'), beforeInt, 'no leaked SIGINT listener');
});

test('runSmokeSelfTest completes without touching the network or leaking process listeners', async () => {
  const beforeInt = process.listenerCount('SIGINT');
  const beforeTerm = process.listenerCount('SIGTERM');
  await assert.doesNotReject(runSmokeSelfTest());
  assert.equal(process.listenerCount('SIGINT'), beforeInt, 'self-test disposes its cancellation bridge');
  assert.equal(process.listenerCount('SIGTERM'), beforeTerm, 'self-test disposes its cancellation bridge');
});

test('main() honors CHAOS_STUDIO_SMOKE_CHECK=1 and resolves without running the real Action', async () => {
  const previous = process.env.CHAOS_STUDIO_SMOKE_CHECK;
  process.env.CHAOS_STUDIO_SMOKE_CHECK = '1';
  try {
    await assert.doesNotReject(main());
  } finally {
    if (previous === undefined) delete process.env.CHAOS_STUDIO_SMOKE_CHECK;
    else process.env.CHAOS_STUDIO_SMOKE_CHECK = previous;
  }
});
