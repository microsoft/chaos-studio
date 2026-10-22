import { test } from 'node:test';
import assert from 'node:assert/strict';

import { API_VERSION, GUID_PATTERN } from '../../src/contract.ts';
import {
  ARM_BASE_URL,
  CoreError,
  assertArmUrl,
  configurationResourceId,
  runResourceId,
  validateActionUrl,
  validationsLatestUrl,
  executeActionUrl,
  runResourceUrl,
  cancelActionUrl,
  validateScenarioCoordinates,
  validateSubscriptionId,
  validateResourceGroup,
  validateResourceName,
  parseRunLocation,
  type ScenarioCoordinates,
} from '../../src/ids.ts';

const COORDS: ScenarioCoordinates = {
  subscriptionId: '11111111-1111-1111-1111-111111111111',
  resourceGroup: 'rg-chaos',
  workspaceName: 'ws-demo',
  scenarioName: 'scn-demo',
  scenarioConfigurationName: 'cfg-demo',
};

const RUN_ID = '22222222-2222-2222-2222-222222222222';

test('configurationResourceId builds the pinned Microsoft.Chaos configuration path', () => {
  assert.equal(
    configurationResourceId(COORDS),
    '/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/rg-chaos/providers/Microsoft.Chaos/workspaces/ws-demo/scenarios/scn-demo/configurations/cfg-demo',
  );
});

test('runResourceId builds the run resource path from a run GUID', () => {
  assert.equal(
    runResourceId(COORDS, RUN_ID),
    '/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/rg-chaos/providers/Microsoft.Chaos/workspaces/ws-demo/scenarios/scn-demo/runs/22222222-2222-2222-2222-222222222222',
  );
});

test('action URLs are absolute, ARM-rooted, and carry the pinned api-version only', () => {
  const validate = validateActionUrl(COORDS);
  assert.ok(validate.startsWith(`${ARM_BASE_URL}/subscriptions/`));
  assert.ok(validate.endsWith(`/configurations/cfg-demo/validate?api-version=${API_VERSION}`));

  assert.ok(validationsLatestUrl(COORDS).endsWith(`/configurations/cfg-demo/validations/latest?api-version=${API_VERSION}`));
  assert.ok(executeActionUrl(COORDS).endsWith(`/configurations/cfg-demo/execute?api-version=${API_VERSION}`));

  const rid = runResourceId(COORDS, RUN_ID);
  assert.equal(runResourceUrl(rid), `${ARM_BASE_URL}${rid}?api-version=${API_VERSION}`);
  assert.equal(cancelActionUrl(rid), `${ARM_BASE_URL}${rid}/cancel?api-version=${API_VERSION}`);
});

test('validateSubscriptionId accepts a GUID and rejects a non-GUID (FR14)', () => {
  assert.equal(validateSubscriptionId(COORDS.subscriptionId), COORDS.subscriptionId);
  for (const bad of ['', 'not-a-guid', '11111111-1111-1111-1111', '11111111_1111_1111_1111_111111111111']) {
    assert.throws(() => validateSubscriptionId(bad), (e) => e instanceof CoreError && e.category === 'identifier');
  }
});

test('validateResourceGroup accepts ARM names and rejects malformed / injection-shaped values (FR14)', () => {
  for (const ok of ['rg-chaos', 'My_Resource.Group(1)', 'a']) {
    assert.equal(validateResourceGroup(ok), ok);
  }
  for (const bad of ['', 'ends-with-period.', 'has space', 'has/slash', 'a'.repeat(91)]) {
    assert.throws(() => validateResourceGroup(bad), (e) => e instanceof CoreError && e.category === 'identifier');
  }
});

test('validateResourceGroup accepts valid Unicode resource-group names allowed by ARM (R3)', () => {
  for (const ok of ['rg-café', 'rg-日本語', 'Ресурсы-1', 'rg-Müller_Ω']) {
    assert.equal(validateResourceGroup(ok), ok);
  }
  // Still rejects injection-shaped and structurally invalid values even with Unicode present.
  for (const bad of ['rg-café/evil', 'rg café', 'rg-café.', '日本語?']) {
    assert.throws(() => validateResourceGroup(bad), (e) => e instanceof CoreError && e.category === 'identifier');
  }
});

test('validateResourceName rejects path-injection and whitespace, accepts normal names (FR14)', () => {
  assert.equal(validateResourceName('workspace-name', 'ws-demo'), 'ws-demo');
  for (const bad of ['', 'a/b', 'a b', '../evil', 'has?query', 'trailing ', '#hash']) {
    assert.throws(
      () => validateResourceName('workspace-name', bad),
      (e) => e instanceof CoreError && e.category === 'identifier',
    );
  }
});

test('validateScenarioCoordinates validates every identifier and returns the coordinates', () => {
  assert.deepEqual(validateScenarioCoordinates(COORDS), COORDS);
  assert.throws(
    () => validateScenarioCoordinates({ ...COORDS, subscriptionId: 'bad' }),
    (e) => e instanceof CoreError && e.category === 'identifier',
  );
  assert.throws(
    () => validateScenarioCoordinates({ ...COORDS, scenarioName: 'a/b' }),
    (e) => e instanceof CoreError && e.category === 'identifier',
  );
});

test('parseRunLocation extracts the run GUID and resource ID from a valid execute Location (DX3)', () => {
  const location = `${ARM_BASE_URL}${runResourceId(COORDS, RUN_ID)}?api-version=${API_VERSION}`;
  const { runId, runResourceId: rid } = parseRunLocation(location);
  assert.ok(GUID_PATTERN.test(runId));
  assert.equal(runId, RUN_ID);
  assert.equal(rid, runResourceId(COORDS, RUN_ID));
});

test('parseRunLocation decodes a percent-encoded Unicode resource-group segment and returns the raw (decoded) run resource ID, matching the requested coordinates (R3)', () => {
  const unicodeCoords: ScenarioCoordinates = { ...COORDS, resourceGroup: 'rg-café' };
  const path = runResourceId(unicodeCoords, RUN_ID);
  // Constructing a URL from the raw Unicode path auto-percent-encodes it,
  // exactly as a real ARM Location header would arrive.
  const location = new URL(`${ARM_BASE_URL}${path}?api-version=${API_VERSION}`).toString();
  assert.ok(location.includes('%C3%A9'), 'Location is percent-encoded');
  const { runId, runResourceId: rid } = parseRunLocation(location, unicodeCoords);
  assert.equal(runId, RUN_ID);
  // The returned resource ID is the raw (decoded) identifier, matching what a
  // caller would compare against/build with — not the percent-encoded form.
  assert.equal(rid, path);
});

test('parseRunLocation cross-checks workspace/scenario when expected coordinates are supplied', () => {
  const location = `${ARM_BASE_URL}${runResourceId(COORDS, RUN_ID)}?api-version=${API_VERSION}`;
  assert.deepEqual(parseRunLocation(location, COORDS).runId, RUN_ID);
  // A Location pointing at a DIFFERENT scenario must fail closed (not trusted).
  const foreign = location.replace('/scenarios/scn-demo/', '/scenarios/other-scn/');
  assert.throws(
    () => parseRunLocation(foreign, COORDS),
    (e) => e instanceof CoreError && e.category === 'ambiguous-acceptance',
  );
});

test('parseRunLocation fails closed (ambiguous-acceptance) on a missing/malformed Location (D14)', () => {
  for (const bad of [
    '',
    'not-a-url',
    `${ARM_BASE_URL}/subscriptions/x/resourceGroups/rg/providers/Microsoft.Chaos/workspaces/ws/scenarios/scn/runs/not-a-guid?api-version=${API_VERSION}`,
    `${ARM_BASE_URL}${configurationResourceId(COORDS)}/validations/latest?api-version=${API_VERSION}`,
  ]) {
    assert.throws(() => parseRunLocation(bad), (e) => e instanceof CoreError && e.category === 'ambiguous-acceptance');
  }
});

test('parseRunLocation refuses a non-ARM origin and a foreign subscription/resource-group (D14, security)', () => {
  const good = `${ARM_BASE_URL}${runResourceId(COORDS, RUN_ID)}?api-version=${API_VERSION}`;
  // Foreign / non-HTTPS origin — must never be trusted (would receive a token).
  for (const foreignOrigin of ['https://evil.example.com', 'http://management.azure.com']) {
    const url = good.replace(ARM_BASE_URL, foreignOrigin);
    assert.throws(() => parseRunLocation(url), (e) => e instanceof CoreError && e.category === 'ambiguous-acceptance');
  }
  // Right host, but a different subscription / resource group than requested.
  const otherSub = good.replace(COORDS.subscriptionId, '99999999-9999-9999-9999-999999999999');
  assert.throws(() => parseRunLocation(otherSub, COORDS), (e) => e instanceof CoreError && e.category === 'ambiguous-acceptance');
  const otherRg = good.replace('/resourceGroups/rg-chaos/', '/resourceGroups/rg-evil/');
  assert.throws(() => parseRunLocation(otherRg, COORDS), (e) => e instanceof CoreError && e.category === 'ambiguous-acceptance');
});

test('parseRunLocation accepts a case-normalized echo of the same resource (ARM case-insensitivity)', () => {
  const upperSub = `${ARM_BASE_URL}${runResourceId(COORDS, RUN_ID).replace('rg-chaos', 'RG-CHAOS')}?api-version=${API_VERSION}`;
  // Same resource, different casing on the resource group — must NOT be rejected.
  assert.equal(parseRunLocation(upperSub, COORDS).runId, RUN_ID);
});

test('parseRunLocation requires EXACTLY ONE pinned api-version (rejects duplicate/unpinned) (D5, D14, finding #2)', () => {
  const path = `${ARM_BASE_URL}${runResourceId(COORDS, RUN_ID)}`;
  // A single pinned version is accepted.
  assert.equal(parseRunLocation(`${path}?api-version=${API_VERSION}`).runId, RUN_ID);
  // A duplicate api-version (even if one copy is the pinned value) leaves the
  // effective version ambiguous → fail closed.
  for (const query of [
    `?api-version=${API_VERSION}&api-version=2020-01-01`,
    `?api-version=2020-01-01&api-version=${API_VERSION}`,
    `?api-version=${API_VERSION}&api-version=${API_VERSION}`,
  ]) {
    assert.throws(() => parseRunLocation(path + query), (e) => e instanceof CoreError && e.category === 'ambiguous-acceptance');
  }
});

test('assertArmUrl accepts an ARM URL and rejects a non-ARM one', () => {
  assertArmUrl(`${ARM_BASE_URL}/subscriptions/x?api-version=${API_VERSION}`);
  for (const bad of ['https://evil.example.com/x', 'http://management.azure.com/x', 'garbage']) {
    assert.throws(() => assertArmUrl(bad), (e) => e instanceof CoreError && e.category === 'transport');
  }
});

test('CoreError carries its category and optional correlation context', () => {
  const e = new CoreError('transport', 'boom', { armErrorCode: 'X', correlationId: 'c', requestId: 'r' });
  assert.equal(e.category, 'transport');
  assert.equal(e.armErrorCode, 'X');
  assert.equal(e.correlationId, 'c');
  assert.equal(e.requestId, 'r');
  assert.ok(e instanceof Error);
  assert.equal(e.name, 'CoreError');
});
