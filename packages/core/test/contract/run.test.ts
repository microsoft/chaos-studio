import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  API_VERSION,
  DEFAULT_RETRY_AFTER_SECONDS,
  GUID_PATTERN,
  RUN_STATES,
  RUN_TERMINAL_SUCCESS,
  RUN_TERMINAL_FAILURE,
} from '../../src/contract.ts';
import { loadFixture, statusOf } from './fixtures.ts';

/**
 * Encodes the DX3 run-ID extraction contract that the core will implement in
 * E2: the execute 202 Location is the full run resource ID, and the run GUID
 * is the final `/runs/{runId}` path segment.
 */
function parseRunLocation(location: string): { runResourceId: string; runId: string } {
  const url = new URL(location);
  const runResourceId = url.pathname;
  const segments = runResourceId.split('/').filter(Boolean);
  const runsIndex = segments.lastIndexOf('runs');
  assert.ok(runsIndex >= 0 && runsIndex === segments.length - 2, 'terminal path is /runs/{runId}');
  const runId = segments[segments.length - 1]!;
  return { runResourceId, runId };
}

test('execute acceptance is 202 with a direct run-resource Location and Retry-After 10 (VF5)', () => {
  const fx = loadFixture('execute', 'accept-202.json');
  const res = fx.response!;
  assert.equal(res.status, 202);
  assert.equal(res.body ?? null, null, 'execute acceptance has no body');

  const location = res.headers?.['Location'];
  assert.ok(location, 'Location header is present');
  assert.ok(location.endsWith(`?api-version=${API_VERSION}`));
  assert.equal(res.headers?.['Retry-After'], String(DEFAULT_RETRY_AFTER_SECONDS));
});

test('DX3: run ID is parsed from the execute Location as a GUID', () => {
  const fx = loadFixture('execute', 'accept-202.json');
  const location = fx.response?.headers?.['Location']!;
  const { runResourceId, runId } = parseRunLocation(location);

  assert.ok(GUID_PATTERN.test(runId), 'run ID validates as a GUID');
  assert.equal(runId, fx.expected?.['runId']);
  assert.equal(runResourceId, fx.expected?.['runResourceId']);
  // resource-path identifiers match the request target.
  assert.ok(runResourceId.includes('/workspaces/ws-demo/'));
  assert.ok(runResourceId.includes('/scenarios/scn-demo/'));
});

test('GET run is 202 while nonterminal with dual error channels (VF6, DX2)', () => {
  const fx = loadFixture('execute', 'run-nonterminal-202.json');
  const res = fx.response!;
  assert.equal(res.status, 202);

  const props = (res.body as { properties: Record<string, unknown> }).properties;
  assert.equal(props['state'], undefined, 'DX2: no stale `state` field');
  assert.ok('status' in props && 'startTime' in props);
  assert.ok('errors' in props && 'executionErrors' in props, 'dual run error channels present');

  const status = statusOf(res.body);
  assert.ok(status && (RUN_STATES as readonly string[]).includes(status));
  assert.ok(!(RUN_TERMINAL_SUCCESS as readonly string[]).includes(status!));
  assert.ok(!(RUN_TERMINAL_FAILURE as readonly string[]).includes(status!));
});

test('GET run is 200 with Succeeded when terminal-success (VF6, VF7)', () => {
  const fx = loadFixture('execute', 'run-succeeded-200.json');
  const res = fx.response!;
  assert.equal(res.status, 200);
  const props = (res.body as { properties: Record<string, unknown> }).properties;
  assert.ok('startTime' in props && 'endTime' in props);

  const status = statusOf(res.body);
  assert.equal(status, 'Succeeded');
  assert.ok((RUN_TERMINAL_SUCCESS as readonly string[]).includes(status!));
});

test('GET run is 200 with Failed and both error channels populated (VF7, VF10)', () => {
  const fx = loadFixture('execute', 'run-failed-200.json');
  const res = fx.response!;
  assert.equal(res.status, 200);
  const props = (res.body as { properties: Record<string, unknown> }).properties;

  const status = statusOf(res.body);
  assert.equal(status, 'Failed');
  assert.ok((RUN_TERMINAL_FAILURE as readonly string[]).includes(status!));
  assert.equal((props['error'] as unknown) ?? undefined, undefined);
  assert.ok(Array.isArray(props['errors']) && (props['errors'] as unknown[]).length > 0);
  assert.ok(Array.isArray(props['executionErrors']) && (props['executionErrors'] as unknown[]).length > 0);
});

test('run polling transitions from 202 nonterminal to 200 terminal-success (VF6, VF7)', () => {
  const fx = loadFixture('execute', 'run-transitions.json');
  const seq = fx.sequence!;
  assert.ok(seq.length >= 2);

  seq.forEach((step, i) => {
    const status = statusOf(step.response.body);
    assert.ok(status && (RUN_STATES as readonly string[]).includes(status), `step ${i} is a known run state`);
    const isLast = i === seq.length - 1;
    if (isLast) {
      assert.equal(step.response.status, 200);
      assert.ok((RUN_TERMINAL_SUCCESS as readonly string[]).includes(status!));
    } else {
      assert.equal(step.response.status, 202);
      assert.ok(!(RUN_TERMINAL_SUCCESS as readonly string[]).includes(status!));
      assert.ok(!(RUN_TERMINAL_FAILURE as readonly string[]).includes(status!));
    }
  });
});

test('VF11: the representative unevaluated-workspace fixture encodes the expected execute 202 (removed 409 gate), not a runtime guarantee', () => {
  const fx = loadFixture('execute', 'accept-unevaluated-202.json');
  const res = fx.response!;
  // Asserts the EXPECTED contract shape encoded in the hand-authored fixture,
  // consistent with the reviewed BE extracts that STATICALLY show execute has no
  // evaluation prerequisite (StartScenarioExecutionCommand accepts a null
  // discovery/evaluation snapshot; no 409 evaluation-required error is mapped). It is
  // not a runtime-observed response; provenance.test.ts authenticates the static
  // absence of the gate against the source extracts.
  assert.notEqual(res.status, 409, 'the fixture encodes no 409 evaluation gate');
  assert.equal(res.status, 202);

  const { runId, runResourceId } = parseRunLocation(res.headers?.['Location']!);
  assert.ok(GUID_PATTERN.test(runId), 'run ID still parses as a GUID from Location');
  assert.equal(runId, fx.expected?.['runId']);
  assert.equal(runResourceId, fx.expected?.['runResourceId']);
});
