import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { INPUT_NAMES } from '../../src/contract.ts';

// Repo root relative to this file: packages/core/test/contract → four levels up.
const REPO_ROOT = join(import.meta.dirname, '..', '..', '..', '..');

interface TaskJson {
  id: string;
  name: string;
  minimumAgentVersion?: string;
  execution: Record<string, unknown>;
  inputs: Array<{ name: string; type: string }>;
}

function loadTaskJson(
  folder = 'AzureChaosStudioScenarioV1',
): TaskJson {
  const path = join(
    REPO_ROOT,
    'azure-pipelines-extension',
    'tasks',
    folder,
    'task.json',
  );
  return JSON.parse(readFileSync(path, 'utf8')) as TaskJson;
}

// Azure Pipelines task input identifiers must be alphanumeric/underscore and may
// not contain hyphens. The canonical wire names are kebab-case, so the task maps
// each canonical input to the camelCase key that produced it (keyof INPUT_NAMES).
const ADO_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

test('every Azure task input name is a schema-valid ADO identifier (no hyphens)', () => {
  const task = loadTaskJson();
  for (const input of task.inputs) {
    assert.ok(
      ADO_IDENTIFIER.test(input.name),
      `task input '${input.name}' is not a valid ADO identifier`,
    );
  }
});

test('Azure task inputs map 1:1 to the canonical contract inputs', () => {
  const task = loadTaskJson();
  const canonicalKeys = Object.keys(INPUT_NAMES);
  // Every canonical input (keyof INPUT_NAMES) has a matching camelCase task
  // input; the ARM service-connection input is the only extra, task-native one.
  const taskInputNames = new Set(task.inputs.map((i) => i.name));
  for (const key of canonicalKeys) {
    assert.ok(
      taskInputNames.has(key),
      `canonical input '${key}' (${INPUT_NAMES[key as keyof typeof INPUT_NAMES]}) has no task input`,
    );
  }
  const extra = [...taskInputNames].filter((n) => !canonicalKeys.includes(n));
  assert.deepEqual(extra, ['azureSubscription'], 'only the ARM connection is task-native');
});

test('Azure task prefers Node24 and retains the Node20_1 compatibility handler (VF15)', () => {
  const task = loadTaskJson();
  assert.ok('Node24' in task.execution, 'task must declare the Node24 handler');
  assert.ok('Node20_1' in task.execution, 'task must run on the Node20_1 handler');
});

test('both Azure tasks require the first agent version that carries the Node20 fallback (VF15)', () => {
  // Agent 2.214.1 introduced the Node20 handler. Newer agents can select Node24;
  // older compatible Server agents select Node20_1 from the same manifest.
  for (const folder of ['AzureChaosStudioScenarioV1', 'AzureChaosStudioScenarioV1Dev']) {
    const task = loadTaskJson(folder);
    assert.equal(task.minimumAgentVersion, '2.214.1', `${folder} must require the Node20 handler floor`);
  }
});

test('the permanent task GUID is stable (VF15 — cannot change after publication)', () => {
  const task = loadTaskJson();
  assert.equal(task.id, '83c40b4c-e5bb-4045-9cb2-ce389248b386');
});

test('the dev task carries a DISTINCT permanent GUID and name for side-by-side install', () => {
  const prod = loadTaskJson('AzureChaosStudioScenarioV1');
  const dev = loadTaskJson('AzureChaosStudioScenarioV1Dev');

  // Two Azure DevOps tasks that share a GUID cannot be installed in the same
  // organization; the dev and production extensions must therefore package
  // different task GUIDs (and distinct names to avoid YAML-reference ambiguity).
  assert.notEqual(dev.id, prod.id, 'dev task GUID must differ from production');
  assert.equal(dev.id, 'eb1d4fc5-61c2-4887-a9af-a649907eaf64');
  assert.notEqual(dev.name, prod.name, 'dev task name must differ from production');
  assert.ok('Node24' in dev.execution, 'dev task also prefers the Node24 handler (VF15)');
  assert.ok('Node20_1' in dev.execution, 'dev task also runs on the Node20_1 handler (VF15)');
});

test('each Azure extension manifest packages its own task folder plus the Marketplace assets', () => {
  const readManifest = (file: string) =>
    JSON.parse(
      readFileSync(join(REPO_ROOT, 'azure-pipelines-extension', file), 'utf8'),
    ) as {
      files: Array<{ path: string; addressable?: boolean }>;
      icons?: { default?: string };
      content?: { details?: { path?: string } };
    };

  const prod = readManifest('vss-extension.json');
  const dev = readManifest('vss-extension.dev.json');
  // Each manifest packages its own task folder AND the shared overview + icon so the
  // public Marketplace listing has the mandatory content.details + icons.default.
  assert.deepEqual(
    prod.files.map((f) => f.path).sort(),
    ['images/icon.png', 'overview.md', 'tasks/AzureChaosStudioScenarioV1'],
  );
  assert.deepEqual(
    dev.files.map((f) => f.path).sort(),
    ['images/icon.png', 'overview.md', 'tasks/AzureChaosStudioScenarioV1Dev'],
    'the dev extension must package the distinct-GUID dev task folder plus the assets',
  );

  for (const [label, m] of [['prod', prod], ['dev', dev]] as const) {
    // Mandatory Marketplace metadata: an overview (content.details) and an icon.
    assert.equal(m.content?.details?.path, 'overview.md', `${label} manifest declares content.details overview`);
    assert.equal(m.icons?.default, 'images/icon.png', `${label} manifest declares icons.default`);
    // Both referenced assets are actually packaged (and addressable).
    for (const asset of ['overview.md', 'images/icon.png']) {
      const entry = m.files.find((f) => f.path === asset);
      assert.ok(entry, `${label} manifest packages '${asset}'`);
      assert.equal(entry!.addressable, true, `${label} manifest marks '${asset}' addressable`);
      assert.ok(existsSync(join(REPO_ROOT, 'azure-pipelines-extension', asset)), `${label}: '${asset}' exists on disk`);
    }
  }

  // The icon is a real PNG of at least 128x128 (Marketplace minimum).
  const png = readFileSync(join(REPO_ROOT, 'azure-pipelines-extension', 'images', 'icon.png'));
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'icon is a PNG');
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  assert.ok(width >= 128 && height >= 128, `icon is at least 128x128 (got ${width}x${height})`);

  // The overview is non-trivial markdown.
  const overview = readFileSync(join(REPO_ROOT, 'azure-pipelines-extension', 'overview.md'), 'utf8');
  assert.ok(overview.trim().length > 100 && overview.includes('#'), 'overview.md is non-trivial markdown');
});

test('root action.yml uses the node24 runtime and the canonical kebab input names (VF17, NFR5)', () => {
  const actionYml = readFileSync(join(REPO_ROOT, 'action.yml'), 'utf8');
  assert.match(actionYml, /using:\s*'node24'/, 'Action must target the node24 runtime');
  for (const kebab of Object.values(INPUT_NAMES)) {
    assert.ok(
      actionYml.includes(`${kebab}:`),
      `action.yml is missing the canonical input '${kebab}'`,
    );
  }
});
