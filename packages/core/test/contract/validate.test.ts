import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  API_VERSION,
  DEFAULT_RETRY_AFTER_SECONDS,
  VALIDATION_STATES,
  VALIDATION_TERMINAL_SUCCESS,
  VALIDATION_TERMINAL_FAILURE,
} from '../../src/contract.ts';
import { loadFixture, statusOf } from './fixtures.ts';
import { readExtract, serializedWireNames } from './source-extracts.ts';

const VALIDATE_FIXTURE_DIR = join(import.meta.dirname, '..', '..', 'fixtures', 'validate');

/** The ValidationProperties extract path the provenance manifest binds. */
function validationPropsExtractPath(): string {
  const manifestPath = join(import.meta.dirname, '..', '..', 'fixtures', 'provenance.manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    sources: Record<string, { extract?: string }>;
  };
  const extract = manifest.sources['gw.validation.properties']?.extract;
  assert.ok(extract, 'provenance manifest binds a ValidationProperties extract');
  return extract!;
}

/** The ConfigurationDomainLogicV1 (validate controller) extract path the manifest binds. */
function validateControllerExtractPath(): string {
  const manifestPath = join(import.meta.dirname, '..', '..', 'fixtures', 'provenance.manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    sources: Record<string, { extract?: string }>;
  };
  const extract = manifest.sources['gw.configuration.domainLogic']?.extract;
  assert.ok(extract, 'provenance manifest binds a ConfigurationDomainLogicV1 extract');
  return extract!;
}

/** Every response object across a validation fixture (single response or a sequence). */
function validationResponses(raw: string): Array<{ status?: number; headers?: Record<string, string>; body?: unknown }> {
  const fx = JSON.parse(raw) as {
    response?: { status?: number; headers?: Record<string, string>; body?: unknown };
    sequence?: Array<{ response: { status?: number; headers?: Record<string, string>; body?: unknown } }>;
  };
  const out: Array<{ status?: number; headers?: Record<string, string>; body?: unknown }> = [];
  if (fx.response) out.push(fx.response);
  for (const step of fx.sequence ?? []) out.push(step.response);
  return out;
}

/** Recursively collects every object property key found in a JSON value. */
function collectKeys(value: unknown, acc: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, acc);
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      acc.add(k);
      collectKeys(v, acc);
    }
  }
  return acc;
}

test('validate acceptance is 202 with a direct validations/latest Location and Retry-After 10 (VF1)', () => {
  const fx = loadFixture('validate', 'accept-202.json');
  const res = fx.response!;
  assert.equal(res.status, 202);
  assert.equal(res.body ?? null, null, 'validate acceptance has no body');

  const location = res.headers?.['Location'];
  assert.ok(location, 'Location header is present');
  // Location points directly at validations/latest — no separate op-status resource first.
  assert.ok(location.includes('/configurations/cfg-demo/validations/latest'));
  assert.ok(location.endsWith(`?api-version=${API_VERSION}`));
  assert.equal(res.headers?.['Retry-After'], String(DEFAULT_RETRY_AFTER_SECONDS));
});

test('GET validations/latest is 202 while nonterminal and uses properties.status (VF2, DX2)', () => {
  const fx = loadFixture('validate', 'validation-nonterminal-202.json');
  const res = fx.response!;
  assert.equal(res.status, 202);

  const props = (res.body as { properties: Record<string, unknown> }).properties;
  assert.equal(props['state'], undefined, 'DX2: no stale `state` field');
  assert.ok('status' in props, 'DX2: uses `status`');
  assert.ok('startTime' in props);
  assert.ok('errors' in props && 'validationErrors' in props, 'dual validation error channels present');

  const status = statusOf(res.body);
  assert.ok(status && (VALIDATION_STATES as readonly string[]).includes(status));
  assert.ok(!(VALIDATION_TERMINAL_SUCCESS as readonly string[]).includes(status!));
  assert.ok(!(VALIDATION_TERMINAL_FAILURE as readonly string[]).includes(status!));
});

test('GET validations/latest is 200 with Succeeded when terminal-success (VF2, VF3)', () => {
  const fx = loadFixture('validate', 'validation-succeeded-200.json');
  const res = fx.response!;
  assert.equal(res.status, 200);

  const props = (res.body as { properties: Record<string, unknown> }).properties;
  assert.ok('startTime' in props && 'endTime' in props);
  assert.deepEqual(props['errors'], []);
  assert.deepEqual(props['validationErrors'], []);

  const status = statusOf(res.body);
  assert.equal(status, 'Succeeded');
  assert.ok((VALIDATION_TERMINAL_SUCCESS as readonly string[]).includes(status!));
});

test('terminal-failure validation is 200 with both error channels populated (VF3, VF10)', () => {
  const fx = loadFixture('validate', 'validation-requires-attention-200.json');
  const res = fx.response!;
  assert.equal(res.status, 200);

  const props = (res.body as { properties: Record<string, unknown> }).properties;
  const status = statusOf(res.body);
  assert.equal(status, 'RequiresAttention');
  assert.ok((VALIDATION_TERMINAL_FAILURE as readonly string[]).includes(status!));

  // system channel + business channel both carry detail; no single `error` channel.
  assert.equal((props['error'] as unknown) ?? undefined, undefined);
  assert.ok(Array.isArray(props['errors']) && (props['errors'] as unknown[]).length > 0);
  const validationErrors = props['validationErrors'] as Array<Record<string, unknown>>;
  assert.ok(validationErrors.length > 0);
  assert.ok('recommendedRoles' in validationErrors[0]!, 'business error carries remediation data');
});

test('VF4: the validate controller returns 202 to validations/latest and enforces NO precondition (source-backed)', () => {
  // Bind the "If-Match ignored / 202 not 412 / plan replaced" claim to the GW
  // ConfigurationDomainLogicV1.ValidateAsync controller extract, which is what
  // actually decides the response — the ValidationProperties model alone cannot
  // prove request handling. The controller: (a) resolves validations/latest,
  // (b) dispatches the validation command unconditionally with no precondition
  // read, and (c) returns an Accepted (202) async operation to that resource.
  const src = readExtract(validateControllerExtractPath());

  assert.match(src, /ValidateAsync/, 'the extract is the ValidateAsync controller path');
  assert.match(src, /validations["/.]+latest|"validations",\s*"latest"/, 'validation targets the validations/latest singleton');
  assert.match(src, /HttpStatusCode\.Accepted|StatusCodes\.Status202Accepted|\b202\b/, 'the controller returns an external 202 (Accepted)');
  assert.match(src, /Retry-?After|retryAfter/i, 'the controller sets a Retry-After for polling');

  // The controller reads/enforces NO precondition — so a caller If-Match cannot
  // change the outcome and can never yield a 412.
  for (const token of ['If-Match', 'IfMatch', 'Precondition', 'PreconditionFailed', 'ETag', 'Etag', 'eTag', '412']) {
    assert.ok(!src.includes(token), `the validate controller must not reference '${token}' (no precondition handling)`);
  }
});

test('VF4: a later validation with a NONMATCHING If-Match is IGNORED (statically-inferred) and replaces the plan', () => {
  const fx = loadFixture('validate', 'plan-mutation-sequence.json');
  const seq = fx.sequence!;
  assert.ok(seq.length >= 4, 'the sequence records the full validate -> GET -> validate(If-Match) -> GET trace');

  // This trace is an ILLUSTRATION of the statically-inferred contract authenticated
  // above against the controller/store/mapper/model extracts — NOT a runtime capture.
  // The precondition is a CONCRETE NONMATCHING ETag (not a match-any `*`, which any
  // resource trivially satisfies): a precondition-HONORING service would reject it with
  // 412, so the inferred 202 here is what demonstrates the precondition is ignored.
  const conditional = seq.find(
    (s) => s.request?.method === 'POST' && s.request?.headers?.['If-Match'] !== undefined,
  );
  assert.ok(conditional, 'the second validation attempts an If-Match precondition');
  const ifMatch = conditional!.request!.headers!['If-Match']!;
  assert.notEqual(ifMatch, '*', 'the precondition is a CONCRETE nonmatching ETag, not a satisfiable match-any `*`');
  assert.match(ifMatch, /^"[^"]+"$/, 'the If-Match is a quoted opaque ETag value a honoring service would 412 on');
  assert.equal(conditional!.response.status, 202, 'the inferred contract ignores the nonmatching precondition: still a normal 202');
  assert.notEqual(conditional!.response.status, 412, 'no 412 precondition failure — the resource has no eTag to match and none is enforced');
  const respHeaderNames = Object.keys(conditional!.response.headers ?? {}).map((h) => h.toLowerCase());
  assert.ok(!respHeaderNames.includes('etag'), 'the response carries no ETag the client could have pinned');

  // Both GET validations/latest responses target the SAME singleton and show the
  // plan was replaced in place — nothing pins plan A once plan B is validated.
  const gets = seq
    .filter((s) => s.request?.method === 'GET')
    .map((s) => s.response.body as { id: string; properties: Record<string, unknown> });
  assert.equal(gets.length, 2, 'the sequence GETs validations/latest before and after the second validation');
  const ids = new Set(gets.map((g) => g.id));
  assert.equal(ids.size, 1, 'both GETs target the same validations/latest resource');
  assert.ok([...ids][0]!.endsWith('/configurations/cfg-demo/validations/latest'));

  const plans = gets.map((g) => g.properties['executionPlanJson'] as string);
  assert.notEqual(plans[0], plans[1], 'the later validation overwrote executionPlanJson (plan is mutable)');
  assert.match(plans[0]!, /plan-A/);
  assert.match(plans[1]!, /plan-B/);
});

test('VF4: the generated validation model exposes no concurrency/idempotency wire field (source-backed)', () => {
  // Authenticate the "no lock" claim against the reviewed ValidationProperties
  // source extract itself, not just authored fixtures: its generated serialization
  // exposes the mutable executionPlanJson but NO eTag/If-Match/version/idempotency
  // wire field, so a client genuinely cannot pin a plan.
  const names = serializedWireNames(readExtract(validationPropsExtractPath()));
  assert.ok(names.includes('executionPlanJson'), 'the source model exposes the mutable execution plan');
  const forbidden = [
    'etag',
    'eTag',
    'ifMatch',
    'ifNoneMatch',
    'idempotencyKey',
    'idempotencyToken',
    'concurrencyToken',
    'rowVersion',
    'resourceVersion',
    'sequenceNumber',
  ];
  for (const field of forbidden) {
    assert.ok(!names.includes(field), `the generated validation model has no '${field}' concurrency wire field`);
  }
});

test('VF4: no validation fixture surfaces a precondition token or 412 (defense in depth)', () => {
  // Body property keys that would indicate an optimistic-concurrency / idempotency
  // guard the client could pin a plan against.
  const FORBIDDEN_BODY_KEYS = [
    'etag',
    'eTag',
    'ifMatch',
    'ifNoneMatch',
    'idempotencyKey',
    'idempotencyToken',
    'concurrencyToken',
    'rowVersion',
    'resourceVersion',
    'sequenceNumber',
  ];
  // Response headers that would carry a precondition token.
  const FORBIDDEN_HEADERS = ['etag', 'if-match', 'if-none-match'];

  const files = readdirSync(VALIDATE_FIXTURE_DIR).filter((f) => f.endsWith('.json'));
  assert.ok(files.length >= 5, 'scans the full set of validation fixtures');

  let sawExecutionPlan = false;
  for (const file of files) {
    const raw = readFileSync(join(VALIDATE_FIXTURE_DIR, file), 'utf8');
    for (const res of validationResponses(raw)) {
      // No precondition-failure status: a resource guarded by concurrency control
      // would surface 412; the validation resource never does.
      assert.notEqual(res.status, 412, `${file}: validation must not return a 412 precondition failure`);

      const headerNames = Object.keys(res.headers ?? {}).map((h) => h.toLowerCase());
      for (const forbidden of FORBIDDEN_HEADERS) {
        assert.ok(!headerNames.includes(forbidden), `${file}: no '${forbidden}' concurrency header`);
      }

      const keys = collectKeys(res.body);
      const lowered = new Set([...keys].map((k) => k.toLowerCase()));
      for (const forbidden of FORBIDDEN_BODY_KEYS) {
        assert.ok(
          !lowered.has(forbidden.toLowerCase()),
          `${file}: validation body carries no '${forbidden}' concurrency/idempotency field`,
        );
      }
      if (keys.has('executionPlanJson')) sawExecutionPlan = true;
    }
  }

  // Sanity: at least one validation resource actually carries the mutable plan,
  // so the "no lock" assertion is about a resource that genuinely has one.
  assert.ok(sawExecutionPlan, 'the validation resource exposes the mutable executionPlanJson');
});

test('VF11: the representative unevaluated-workspace fixture encodes the expected 202 (removed 409 gate), not a runtime guarantee', () => {
  const fx = loadFixture('validate', 'accept-unevaluated-202.json');
  const res = fx.response!;
  // This asserts the EXPECTED contract shape encoded in the hand-authored fixture,
  // consistent with the reviewed BE extracts that STATICALLY removed the legacy
  // IsEvaluated 409 gate (no evaluation prerequisite in the inspected code, no 409
  // mapped). It is not a runtime-observed response; provenance.test.ts authenticates
  // the static removal of the gate against the source extracts.
  assert.notEqual(res.status, 409, 'the fixture encodes no 409 evaluation gate');
  assert.equal(res.status, 202);
  const location = res.headers?.['Location'];
  assert.ok(location && location.includes('/validations/latest'));
  assert.equal(res.headers?.['Retry-After'], String(DEFAULT_RETRY_AFTER_SECONDS));
});
