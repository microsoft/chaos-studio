import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { PROVIDER_OPERATIONS } from '../../packages/core/src/contract.ts';
import {
  validateRunnerRole,
  grantedActions,
  type RoleDefinition,
} from './roleValidator.ts';

/**
 * RV2 (E5-T3) — the RBAC role template must cite ONLY source-proven operation
 * strings and must fail closed when a required permission is removed (or an
 * unexpected one is added). The positive case pins the committed template; the
 * negative cases prove the validator rejects a role that drops a required op,
 * invents an op, over-grants a real-but-unneeded op, or grants a data action.
 */

const repoRoot = new URL('../../', import.meta.url);
const readJson = (rel: string): unknown => JSON.parse(readFileSync(new URL(rel, repoRoot), 'utf8'));

/** The five operations the integration actually invokes (the required set). */
const REQUIRED_OPS = Object.values(PROVIDER_OPERATIONS);

/** The full generated provider-operation surface (source of truth for "exists"). */
function providerOpNames(): Set<string> {
  const snapshot = readJson('packages/core/fixtures/operations/provider-operations.json') as {
    value: Array<{ name: string }>;
  };
  return new Set(snapshot.value.map((o) => o.name));
}

/** Load a fresh, deep copy of the committed role template. */
function loadTemplate(): RoleDefinition {
  return readJson('security/chaos-studio-runner.role-template.json') as RoleDefinition;
}

test('RV2 positive: the committed role template grants exactly the required, source-proven operations', () => {
  const providerOps = providerOpNames();
  const result = validateRunnerRole(loadTemplate(), REQUIRED_OPS, providerOps);
  assert.deepEqual(result.missing, [], 'no required operation is missing');
  assert.deepEqual(result.extraneous, [], 'no operation beyond the required set (least privilege)');
  assert.deepEqual(result.unknown, [], 'every granted operation exists in the provider snapshot');
  assert.deepEqual(result.dataActions, [], 'no data actions are granted');
  assert.deepEqual(result.notActions, [], 'no NotActions subtractions');
  assert.equal(result.ok, true, 'the committed template is valid');
});

test('RV2: every operation the template cites appears verbatim in the generated provider snapshot', () => {
  const providerOps = providerOpNames();
  for (const op of grantedActions(loadTemplate())) {
    assert.ok(providerOps.has(op), `granted operation '${op}' exists in the provider-operation snapshot`);
  }
});

test('RV2: the template grants precisely the five PROVIDER_OPERATIONS (no more, no less)', () => {
  assert.deepEqual([...grantedActions(loadTemplate())].sort(), [...REQUIRED_OPS].sort());
});

test('runner role setup documents scope customization before creating the local role definition', () => {
  const doc = readFileSync(new URL('docs/ci-cd-integrations.md', repoRoot), 'utf8');
  const setup = doc.slice(doc.indexOf('## Least privilege'), doc.indexOf('## Two-identity'));
  assert.doesNotMatch(setup, /ready-to-assign/i);
  assert.match(setup, /template requiring customization/i);
  assert.match(setup, /00000000-0000-0000-0000-000000000000/);
  const copy = setup.indexOf('Copy');
  const customize = setup.indexOf('Replace its `AssignableScopes`');
  const create = setup.indexOf('az role definition create --role-definition chaos-studio-runner.role.json');
  assert.ok(copy >= 0 && customize > copy && create > customize,
    'copy the template and customize its scopes before creating the local role');
  assert.match(setup, /"AssignableScopes":\s*\[\s*"\/subscriptions\/<sub>\/resourceGroups\/<rg>"\s*\]/);
  assert.doesNotMatch(setup, /az role definition create[^\n]*role-template\.json/);
  assert.match(setup, /assignment scope does not override/i);
});

test('RV2 negative: removing a required operation makes validation FAIL CLOSED', () => {
  const providerOps = providerOpNames();
  const role = loadTemplate();
  // Drop the execute permission — a role that cannot execute must be rejected.
  role.Actions = role.Actions!.filter((a) => a !== PROVIDER_OPERATIONS.execute);

  const result = validateRunnerRole(role, REQUIRED_OPS, providerOps);
  assert.equal(result.ok, false, 'a role missing a required op is invalid');
  assert.deepEqual(result.missing, [PROVIDER_OPERATIONS.execute], 'the missing op is reported');
});

test('runner role assignment is scoped to the target workspace, not its resource group', () => {
  const doc = readFileSync(new URL('docs/ci-cd-integrations.md', repoRoot), 'utf8');
  const assignment = doc.slice(doc.indexOf('az role assignment create'), doc.indexOf('## Two-identity'));
  assert.match(assignment, /--scope "\/subscriptions\/<sub>\/resourceGroups\/<rg>\/providers\/Microsoft\.Chaos\/workspaces\/<workspace>"/);
  const identities = doc.slice(doc.indexOf('## Two-identity'), doc.indexOf('## Concurrency'));
  assert.match(identities, /only\*\* the target workspace resource/);
  assert.match(identities, /Workspace managed identity/);
  assert.match(identities, /target resources/);
  assert.doesNotMatch(identities, /on \*\*only\*\* the workspace's resource group/);
});

test('RV2 negative: an INVENTED operation string is rejected (not in the provider snapshot)', () => {
  const providerOps = providerOpNames();
  const role = loadTemplate();
  // The DX1 non-existent operation must never be granted.
  role.Actions!.push('Microsoft.Chaos/workspaces/scenarios/run/action');

  const result = validateRunnerRole(role, REQUIRED_OPS, providerOps);
  assert.equal(result.ok, false, 'an invented operation string is invalid');
  assert.ok(result.unknown.includes('Microsoft.Chaos/workspaces/scenarios/run/action'));
  assert.ok(result.extraneous.includes('Microsoft.Chaos/workspaces/scenarios/run/action'));
});

test('RV2 negative: over-granting a real-but-unneeded operation violates least privilege', () => {
  const providerOps = providerOpNames();
  const role = loadTemplate();
  // workspaces/write exists in the provider but the integration never needs it.
  role.Actions!.push('Microsoft.Chaos/workspaces/write');

  const result = validateRunnerRole(role, REQUIRED_OPS, providerOps);
  assert.equal(result.ok, false, 'over-granting is invalid');
  assert.deepEqual(result.extraneous, ['Microsoft.Chaos/workspaces/write']);
  assert.deepEqual(result.unknown, [], 'the op is real (so not "unknown") but still extraneous');
});

test('RV2 negative: granting any dataAction is rejected (control-plane role only)', () => {
  const providerOps = providerOpNames();
  const role = loadTemplate();
  role.DataActions = ['Microsoft.Chaos/someDataAction'];

  const result = validateRunnerRole(role, REQUIRED_OPS, providerOps);
  assert.equal(result.ok, false, 'a data action is invalid for this role');
  assert.deepEqual(result.dataActions, ['Microsoft.Chaos/someDataAction']);
});

test('RV2 negative: a NotActions that subtracts a required op is rejected (effective-permission fail-closed)', () => {
  const providerOps = providerOpNames();
  const role = loadTemplate();
  // All five Actions are present, but NotActions subtracts execute — Azure would
  // deny execute, so the role is effectively missing it and must be rejected.
  role.NotActions = [PROVIDER_OPERATIONS.execute];

  const result = validateRunnerRole(role, REQUIRED_OPS, providerOps);
  assert.equal(result.ok, false, 'a NotActions subtraction invalidates the role');
  assert.deepEqual(result.notActions, [PROVIDER_OPERATIONS.execute]);
});
