import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  API_VERSION,
  DEFAULT_RETRY_AFTER_SECONDS,
  GUID_PATTERN,
  RUN_STATES,
  RUN_TERMINAL_FAILURE,
} from '../../src/contract.ts';
import { loadFixture, statusOf } from './fixtures.ts';

test('cancel acceptance is 202 with a Location back to the same run resource (VF8)', () => {
  const cancel = loadFixture('cancel', 'accept-202.json');
  const res = cancel.response!;
  assert.equal(res.status, 202);
  assert.equal(res.body ?? null, null, 'cancel acceptance has no body');

  const location = res.headers?.['Location'];
  assert.ok(location);
  assert.ok(location.endsWith(`?api-version=${API_VERSION}`));
  assert.equal(res.headers?.['Retry-After'], String(DEFAULT_RETRY_AFTER_SECONDS));

  // Location is the same run resource that execute returned (no new resource).
  const executeLocation = loadFixture('execute', 'accept-202.json').response?.headers?.['Location']!;
  assert.equal(location, executeLocation);
});

test('VF9: cancel is keyed by the run ID that execute exposed in its Location', () => {
  // The service can only cancel a run once its ID exists; that run ID comes from
  // the execute 202 Location, and the cancel request targets /runs/{runId}/cancel.
  const executeLocation = loadFixture('execute', 'accept-202.json').response?.headers?.['Location']!;
  const runId = new URL(executeLocation).pathname.split('/').filter(Boolean).pop()!;
  assert.ok(GUID_PATTERN.test(runId), 'the run ID is a GUID');

  const cancelUrl = new URL(loadFixture('cancel', 'accept-202.json').request!.url);
  const segs = cancelUrl.pathname.split('/').filter(Boolean);
  assert.equal(segs[segs.length - 1], 'cancel', 'cancel targets the /cancel action');
  assert.equal(segs[segs.length - 2], runId, 'cancel is scoped to the run ID from execute');
  assert.equal(segs[segs.length - 3], 'runs', 'cancel is a run-level operation');
});

test('cancel settles the run on the terminal Canceled state (VF7, VF8)', () => {
  const fx = loadFixture('cancel', 'run-canceled-200.json');
  const res = fx.response!;
  assert.equal(res.status, 200);
  const status = statusOf(res.body);
  assert.equal(status, 'Canceled');
  assert.ok((RUN_TERMINAL_FAILURE as readonly string[]).includes(status!));
});

test('cancel polling ends on terminal Canceled; every pre-final poll is 202 Canceling (VF7, VF8)', () => {
  const fx = loadFixture('cancel', 'run-transitions.json');
  const seq = fx.sequence!;
  assert.ok(seq.length >= 1);

  seq.forEach((step, i) => {
    const status = statusOf(step.response.body);
    assert.ok(status && (RUN_STATES as readonly string[]).includes(status));
    const isLast = i === seq.length - 1;
    if (isLast) {
      assert.equal(step.response.status, 200);
      assert.equal(status, 'Canceled');
    } else {
      // Once a cancel is accepted, the run is either still being canceled (Canceling) or
      // already settled (terminal Canceled). So EVERY pre-final poll MUST be an accepted
      // 202 reporting EXACTLY Canceling — it can never report an advancing/other run
      // state after the cancel. ZERO intermediate polls is still allowed: cancellation
      // may complete before the first poll, so the sequence may be just the terminal
      // Canceled (the `seq.length >= 1` above permits that). This is stricter than
      // "any non-terminal state" — a Running/Preparing pre-final poll is rejected.
      assert.equal(step.response.status, 202, 'a pre-final poll is an accepted 202 (cancel in progress)');
      assert.equal(status, 'Canceling', 'every pre-final poll reports exactly Canceling (never another state)');
    }
  });

  // Canceling only ever appears on a NON-final 202 poll (never as the terminal state and
  // never after Canceled). Its ABSENCE is also valid (zero intermediate polls allowed).
  seq.forEach((step, i) => {
    if (statusOf(step.response.body) === 'Canceling') {
      assert.notEqual(i, seq.length - 1, 'Canceling is never the terminal state');
      assert.equal(step.response.status, 202, 'a Canceling poll is a 202 (in-progress)');
    }
  });
});
