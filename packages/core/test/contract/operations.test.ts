import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { PROVIDER_OPERATIONS } from '../../src/contract.ts';
import { loadFixture } from './fixtures.ts';
import { readExtract, operationNames as extractOperationNames, operationObjects as extractOperationObjects } from './source-extracts.ts';

const INCORRECT_RUN_ACTION = 'Microsoft.Chaos/workspaces/scenarios/run/action';
const OPERATIONS_SOURCE_KEY = 'gw.operations.getOperationsSnapshot';

// Operations the scenario journey deliberately does NOT invoke, but which exist
// in the provider (VF12). They must be present in the full snapshot yet excluded
// from the client's PROVIDER_OPERATIONS.
const UNUSED_BUT_PRESENT = [
  'Microsoft.Chaos/workspaces/read',
  'Microsoft.Chaos/locations/workspaceOperationResults/read',
];

// The scenario-run journey namespace. Cancellation claims (VF9) are scoped here:
// the journey validates/executes a configuration and polls/cancels a run.
const SCENARIO_JOURNEY_PREFIX = 'Microsoft.Chaos/workspaces/scenarios/';

function operationNames(): string[] {
  const fx = loadFixture('operations', 'provider-operations.json');
  return (fx.value as Array<{ name: string }>).map((op) => op.name);
}

/** The COMPLETE operation objects the fixture carries. */
function operationObjects(): unknown[] {
  const fx = loadFixture('operations', 'provider-operations.json');
  return fx.value as unknown[];
}

const DISPLAY_KEYS = ['provider', 'resource', 'operation', 'description'] as const;
const OPERATION_KEYS = ['name', 'isDataAction', 'display'] as const;

/** Asserts a single operation is a COMPLETE, CLOSED object (no missing/extra keys). */
function assertClosedOperationObject(op: unknown, i: number): void {
  assert.ok(op && typeof op === 'object' && !Array.isArray(op), `operation[${i}] is an object`);
  const o = op as Record<string, unknown>;
  assert.deepEqual([...Object.keys(o)].sort(), [...OPERATION_KEYS].sort(), `operation[${i}] has exactly {name, isDataAction, display}`);
  assert.ok(typeof o['name'] === 'string' && (o['name'] as string).startsWith('Microsoft.Chaos/'), `operation[${i}] name is a Microsoft.Chaos op`);
  assert.equal(typeof o['isDataAction'], 'boolean', `operation[${i}] isDataAction is a boolean`);
  const d = o['display'];
  assert.ok(d && typeof d === 'object' && !Array.isArray(d), `operation[${i}] display is an object`);
  const dd = d as Record<string, unknown>;
  assert.deepEqual([...Object.keys(dd)].sort(), [...DISPLAY_KEYS].sort(), `operation[${i}] display has exactly {provider, resource, operation, description}`);
  for (const k of DISPLAY_KEYS) {
    assert.ok(typeof dd[k] === 'string' && (dd[k] as string).length > 0, `operation[${i}] display.${k} is a non-empty string`);
  }
}

/** The extract path the provenance manifest binds for the operations snapshot. */
function operationsExtractPath(): string {
  const manifestPath = join(import.meta.dirname, '..', '..', 'fixtures', 'provenance.manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    sources: Record<string, { extract?: string }>;
  };
  const extract = manifest.sources[OPERATIONS_SOURCE_KEY]?.extract;
  assert.ok(extract, `provenance manifest binds an extract for ${OPERATIONS_SOURCE_KEY}`);
  return extract!;
}

/** The authoritative generated operation names, parsed from the reviewed extract. */
function sourceOperationNames(): string[] {
  return extractOperationNames(readExtract(operationsExtractPath()));
}

test('the fixture snapshot is the EXACT generated provider operation set (authenticated, VF12)', () => {
  // Completeness is proven by EXACT-SET equality with the reviewed generated
  // snapshot extract (source-extracts/…GetOperations.verified.txt) — not by a
  // size threshold, which would let an omitted operation slip through. The
  // extract is authenticated out of band via its commit-pinned permalink and its
  // recorded hash (provenance.test.ts), so this equality binds the fixture to the
  // real generated operation surface.
  const fixture = operationNames().slice().sort();
  const source = sourceOperationNames().slice().sort();
  assert.deepEqual(fixture, source, 'the operations fixture must equal the reviewed generated snapshot exactly');
  assert.equal(new Set(fixture).size, fixture.length, 'operation names are unique');
  // Sanity: the authenticated set is genuinely the full surface (many more than
  // the five invoked ops), so the negative searches below are meaningful.
  assert.ok(
    source.length > Object.keys(PROVIDER_OPERATIONS).length + 5,
    'the generated surface is broader than the five invoked ops',
  );
});

test('every fixture operation is a COMPLETE closed object (name + isDataAction + display metadata, VF12)', () => {
  const ops = operationObjects();
  assert.ok(ops.length > 0, 'the operations snapshot is non-empty');
  ops.forEach((op, i) => assertClosedOperationObject(op, i));
});

test('the fixture operation OBJECTS equal the reviewed generated snapshot exactly (not names only, VF12)', () => {
  // Bind the WHOLE objects — name, isDataAction, and every display field — to the
  // reviewed snapshot, in order, so a tampered display string or isDataAction flag
  // cannot pass a names-only check. The extract is authenticated out of band.
  const fixture = operationObjects();
  const source = extractOperationObjects(readExtract(operationsExtractPath()));
  assert.deepEqual(fixture, source, 'the operations fixture OBJECTS must equal the reviewed generated snapshot exactly');
});

test('every invoked operation (PROVIDER_OPERATIONS) is present in the full snapshot (VF12)', () => {
  const names = new Set(operationNames());
  for (const op of Object.values(PROVIDER_OPERATIONS)) {
    assert.ok(names.has(op), `invoked operation '${op}' must exist in the generated snapshot`);
  }
});

test('DX1: the full snapshot proves execute/action and refutes the nonexistent run/action', () => {
  const names = operationNames();
  assert.ok(names.includes('Microsoft.Chaos/workspaces/scenarios/configurations/execute/action'));
  // Searched across the ENTIRE provider surface, not a hand-picked subset.
  assert.ok(!names.includes(INCORRECT_RUN_ACTION), 'run/action does not exist anywhere in the provider');
  assert.ok(!Object.values(PROVIDER_OPERATIONS).includes(INCORRECT_RUN_ACTION as never));
});

test('the journey does not invoke provider ops that nonetheless exist (VF12)', () => {
  const names = operationNames();
  const invoked = new Set<string>(Object.values(PROVIDER_OPERATIONS));
  for (const op of UNUSED_BUT_PRESENT) {
    assert.ok(names.includes(op), `${op} exists in the provider snapshot`);
    assert.ok(!invoked.has(op), `${op} must not be one of the invoked PROVIDER_OPERATIONS`);
  }
});

test('VF9: run cancel is the ONLY cancel operation in the scenario journey — proven over the full snapshot', () => {
  const names = operationNames();

  // Search the ENTIRE provider surface for cancel actions, then restrict to the
  // scenario-run journey. Because the fixture is the full snapshot (not a curated
  // subset), finding exactly one cancel here is real evidence, not an artifact of
  // a hand-picked list.
  const journeyCancelOps = names
    .filter((n) => n.startsWith(SCENARIO_JOURNEY_PREFIX))
    .filter((n) => /\/cancel\/action$/.test(n));
  assert.deepEqual(
    journeyCancelOps,
    ['Microsoft.Chaos/workspaces/scenarios/runs/cancel/action'],
    'the only cancel operation in the scenario journey is run cancel',
  );
});

test('VF9: the provider exposes NO validation-cancel and NO execute-cancel operation (full-snapshot negative)', () => {
  const names = operationNames();
  // Cancellation is asymmetric: a run can be cancelled once its ID exists, but
  // the provider exposes no operation to cancel a validation, and none to cancel
  // an execute before a run ID exists. Assert these specific negatives across the
  // WHOLE snapshot so the claim cannot be an artifact of a curated subset.
  const forbiddenCancels = [
    /\/configurations\/validations(\/[^/]*)?\/cancel\/action$/,
    /\/configurations\/execute\/cancel\/action$/,
    /\/configurations\/validate\/cancel\/action$/,
  ];
  for (const name of names) {
    for (const forbidden of forbiddenCancels) {
      assert.ok(!forbidden.test(name), `unexpected cancel operation exists: ${name}`);
    }
  }
  assert.ok(!names.includes('Microsoft.Chaos/workspaces/scenarios/configurations/validations/cancel/action'));
  assert.ok(!names.includes('Microsoft.Chaos/workspaces/scenarios/configurations/execute/cancel/action'));
});

test('contract PROVIDER_OPERATIONS maps to the correct generated strings (DX1)', () => {
  assert.equal(
    PROVIDER_OPERATIONS.validate,
    'Microsoft.Chaos/workspaces/scenarios/configurations/validate/action',
  );
  assert.equal(
    PROVIDER_OPERATIONS.validationRead,
    'Microsoft.Chaos/workspaces/scenarios/configurations/validations/read',
  );
  assert.equal(
    PROVIDER_OPERATIONS.execute,
    'Microsoft.Chaos/workspaces/scenarios/configurations/execute/action',
  );
  assert.equal(PROVIDER_OPERATIONS.runRead, 'Microsoft.Chaos/workspaces/scenarios/runs/read');
  assert.equal(
    PROVIDER_OPERATIONS.runCancel,
    'Microsoft.Chaos/workspaces/scenarios/runs/cancel/action',
  );
});
