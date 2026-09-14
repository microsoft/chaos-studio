import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { INPUT_NAMES, OUTPUT_NAMES } from '../../packages/core/src/contract.ts';

/**
 * E5-T2 — manifest/package tests. These assert the shipped package metadata is
 * internally consistent and matches the shared contract, and that the permanent
 * task GUIDs never drift (VF15): the root GitHub `action.yml` (node24 runtime +
 * canonical inputs/outputs), the two Azure Pipelines `task.json` manifests
 * (Node20_1 runtime, stable GUIDs), and the two extension manifests (publisher +
 * clean-room task resolution). Deterministic: reads committed files only.
 */

const repoRoot = new URL('../../', import.meta.url);
const readText = (rel: string): string => readFileSync(new URL(rel, repoRoot), 'utf8');
const readJson = (rel: string): Record<string, unknown> => JSON.parse(readText(rel)) as Record<string, unknown>;

// ---------------------------------------------------------------------------
// Root GitHub Action metadata (action.yml). No YAML parser is available in this
// repo, so the raw text is asserted against the canonical contract names.
// ---------------------------------------------------------------------------

test('action.yml targets the node24 runtime and runs the committed GitHub Action bundle (VF16/VF17, D19)', () => {
  const yml = readText('action.yml');
  assert.match(yml, /using:\s*'node24'/, 'the Action uses the node24 runtime (node20 is deprecated, VF17)');
  assert.match(yml, /main:\s*'dist\/github-action\/index\.js'/, 'runs the committed adapter bundle');
});

test('action.yml declares exactly the canonical inputs and outputs (shared contract, NFR5)', () => {
  const yml = readText('action.yml');
  // Slice the inputs block (from `inputs:` to `outputs:`) and the outputs block
  // (from `outputs:` to `runs:`) so an input/output name is matched in its section.
  const inputsBlock = yml.slice(yml.indexOf('\ninputs:'), yml.indexOf('\noutputs:'));
  const outputsBlock = yml.slice(yml.indexOf('\noutputs:'), yml.indexOf('\nruns:'));

  for (const wire of Object.values(INPUT_NAMES)) {
    assert.match(inputsBlock, new RegExp(`\\n  ${wire}:`), `action.yml declares input '${wire}'`);
  }
  for (const out of OUTPUT_NAMES) {
    assert.match(outputsBlock, new RegExp(`\\n  ${out}:`), `action.yml declares output '${out}'`);
  }
  // No unexpected inputs: count the second-level keys in the inputs block.
  const declaredInputs = [...inputsBlock.matchAll(/\n {2}([a-z][a-z0-9-]*):/g)].map((m) => m[1]);
  assert.deepEqual(
    [...declaredInputs].sort(),
    [...Object.values(INPUT_NAMES)].sort(),
    'action.yml declares no inputs beyond the canonical contract',
  );
  // No unexpected outputs either: the declared output set equals OUTPUT_NAMES.
  const declaredOutputs = [...outputsBlock.matchAll(/\n {2}([a-z][a-z0-9-]*):/g)].map((m) => m[1]);
  assert.deepEqual(
    [...declaredOutputs].sort(),
    [...OUTPUT_NAMES].sort(),
    'action.yml declares no outputs beyond the canonical contract',
  );
});

// ---------------------------------------------------------------------------
// Azure Pipelines task manifests. GUID STABILITY: the permanent task GUIDs are
// pinned here — a published task GUID can never change (VF15), so this test is
// the tripwire that fails if either is edited.
// ---------------------------------------------------------------------------

const PROD_TASK = 'azure-pipelines-extension/tasks/AzureChaosStudioScenarioV1/task.json';
const DEV_TASK = 'azure-pipelines-extension/tasks/AzureChaosStudioScenarioV1Dev/task.json';

/** The permanent, published task GUIDs. NEVER change these (VF15). */
const STABLE_TASK_GUIDS = {
  production: '83c40b4c-e5bb-4045-9cb2-ce389248b386',
  dev: 'eb1d4fc5-61c2-4887-a9af-a649907eaf64',
} as const;

test('the production task manifest is AzureChaosStudioScenario@1 on Node20_1 with its stable GUID (VF15, D19)', () => {
  const t = readJson(PROD_TASK) as {
    id: string;
    name: string;
    version: { Major: number };
    execution: Record<string, { target?: string }>;
  };
  assert.equal(t.id, STABLE_TASK_GUIDS.production, 'the production task GUID is permanent and must not change');
  assert.equal(t.name, 'AzureChaosStudioScenario');
  assert.equal(t.version.Major, 1, 'AzureChaosStudioScenario@1');
  assert.deepEqual(Object.keys(t.execution), ['Node20_1'], 'only the Node20_1 handler (VF15)');
  assert.equal(t.execution['Node20_1']!.target, 'index.js');
});

test('the dev task manifest is AzureChaosStudioScenarioDev@1 on Node20_1 with its own stable GUID (VF15)', () => {
  const t = readJson(DEV_TASK) as {
    id: string;
    name: string;
    version: { Major: number };
    execution: Record<string, { target?: string }>;
  };
  assert.equal(t.id, STABLE_TASK_GUIDS.dev, 'the dev task GUID is permanent and must not change');
  assert.equal(t.name, 'AzureChaosStudioScenarioDev');
  assert.equal(t.version.Major, 1);
  assert.deepEqual(Object.keys(t.execution), ['Node20_1']);
  assert.equal(t.execution['Node20_1']!.target, 'index.js');
  assert.notEqual(STABLE_TASK_GUIDS.production, STABLE_TASK_GUIDS.dev, 'the two GUIDs differ (side-by-side install)');
});

test('both task manifests declare the canonical inputs (parity with action.yml, NFR5)', () => {
  // task.json input names are camelCase; map the canonical wire names to them.
  const expected = [
    'azureSubscription',
    'subscriptionId',
    'resourceGroup',
    'workspaceName',
    'scenarioName',
    'scenarioConfigurationName',
    'mode',
    'waitForCompletion',
    'completionTimeoutSeconds',
    'cancelOnTimeoutOrCancellation',
  ];
  for (const rel of [PROD_TASK, DEV_TASK]) {
    const t = readJson(rel) as { inputs: Array<{ name: string }> };
    const names = t.inputs.map((i) => i.name);
    for (const e of expected) {
      assert.ok(names.includes(e), `${rel} declares input '${e}'`);
    }
  }
});

// ---------------------------------------------------------------------------
// Extension manifests + clean-room task resolution: every task folder a manifest
// packages exists on disk and its contributed task name matches the folder, so a
// clean VSIX install resolves every declared task.
// ---------------------------------------------------------------------------

interface Manifest {
  id: string;
  publisher: string;
  public: boolean;
  files?: Array<{ path: string }>;
  contributions?: Array<{ type: string; properties?: { name?: string } }>;
}

for (const [label, rel, expectId, isPublic, expectFolder] of [
  ['production', 'azure-pipelines-extension/vss-extension.json', 'ChaosStudioWorkspaces', true, 'tasks/AzureChaosStudioScenarioV1'],
  ['dev', 'azure-pipelines-extension/vss-extension.dev.json', 'ChaosStudioWorkspacesDev', false, 'tasks/AzureChaosStudioScenarioV1Dev'],
] as const) {
  test(`the ${label} extension manifest (${expectId}) resolves every packaged task folder (clean-room install)`, () => {
    const m = readJson(rel) as unknown as Manifest;
    assert.equal(m.id, expectId);
    assert.equal(m.publisher, 'AzureChaosStudio');
    assert.equal(m.public, isPublic, `${label} extension public=${String(isPublic)}`);
    assert.notEqual(m.id, 'ChaosStudioExtension', 'must not reuse the pre-existing published extension id');

    const taskContribs = (m.contributions ?? []).filter((c) => c.type === 'ms.vss-distributed-task.task');
    assert.equal(taskContribs.length, 1, 'declares exactly one task contribution');
    // The single contributed folder is the expected V2 (prod|dev) task, not the other.
    assert.equal(taskContribs[0]!.properties?.name, expectFolder, `${label} contributes ${expectFolder}`);
    for (const c of taskContribs) {
      const folder = c.properties?.name;
      assert.ok(folder, 'the task contribution names a folder');
      // The packaged files must include the folder, and the folder must hold a task.json.
      assert.ok((m.files ?? []).some((f) => f.path === folder), `${folder} is packaged in files[]`);
      const taskJson = readJson(`azure-pipelines-extension/${folder}/task.json`) as { name: string };
      assert.ok(taskJson.name.length > 0, `${folder}/task.json is a valid task manifest`);
    }
  });
}
