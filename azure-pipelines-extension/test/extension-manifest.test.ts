import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Clean-install / private-share guard for the Azure Pipelines extension (E4-T3).
 * It proves, from the committed manifests + task.json files, that:
 *  - the public `ChaosStudioWorkspaces` and private `ChaosStudioWorkspacesDev`
 *    extensions each expose EXACTLY ONE task contribution — the new V2 task — and
 *    nothing else (so a clean private install of the dev extension surfaces only
 *    the V2 task);
 *  - the production and dev tasks carry DISTINCT permanent GUIDs, so both
 *    extensions can be installed side by side in a test organization (VF15);
 *  - both tasks prefer `Node24` and retain the `Node20_1` fallback (VF15, D19);
 *  - neither manifest touches the pre-existing `AzureChaosStudio.ChaosStudioExtension`
 *    (its version + V1 task are a separate, published extension and stay unchanged).
 * Deterministic: reads the committed files only; no network/agent.
 */

const extRoot = fileURLToPath(new URL('../', import.meta.url));
const readJson = (rel: string): Record<string, unknown> =>
  JSON.parse(readFileSync(new URL(rel, new URL('../', import.meta.url)), 'utf8')) as Record<string, unknown>;

const GUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const TASK_CONTRIBUTION_TYPE = 'ms.vss-distributed-task.task';

interface Contribution {
  id: string;
  type: string;
  properties?: { name?: string };
}
interface Manifest {
  id: string;
  publisher: string;
  public: boolean;
  files?: Array<{ path: string }>;
  contributions?: Contribution[];
}

function taskContributions(m: Manifest): Contribution[] {
  return (m.contributions ?? []).filter((c) => c.type === TASK_CONTRIBUTION_TYPE);
}

test('the production Workspaces manifest exposes exactly one task — the V2 task — under publisher AzureChaosStudio', () => {
  const m = readJson('vss-extension.json') as unknown as Manifest;
  assert.equal(m.id, 'ChaosStudioWorkspaces');
  assert.equal(m.publisher, 'AzureChaosStudio');
  assert.equal(m.public, true, 'the production extension is public');
  assert.notEqual(m.id, 'ChaosStudioExtension', 'must NOT reuse the pre-existing extension id (V1 stays unchanged)');

  const tasks = taskContributions(m);
  assert.equal(tasks.length, 1, 'exactly one task contribution (only the V2 task)');
  assert.equal(tasks[0]!.properties?.name, 'tasks/AzureChaosStudioScenarioV1');

  const paths = (m.files ?? []).map((f) => f.path);
  assert.ok(paths.includes('tasks/AzureChaosStudioScenarioV1'), 'packages the V2 task folder');
  assert.ok(
    !paths.includes('tasks/AzureChaosStudioScenarioV1Dev'),
    'the production extension does NOT ship the dev task folder',
  );
});

test('the dev Workspaces manifest is private and exposes exactly one task — the dev V2 task', () => {
  const m = readJson('vss-extension.dev.json') as unknown as Manifest;
  assert.equal(m.id, 'ChaosStudioWorkspacesDev');
  assert.equal(m.publisher, 'AzureChaosStudio');
  assert.equal(m.public, false, 'the dev extension is private (shared only with test orgs)');

  const tasks = taskContributions(m);
  assert.equal(tasks.length, 1, 'exactly one task contribution (only the V2 dev task)');
  assert.equal(tasks[0]!.properties?.name, 'tasks/AzureChaosStudioScenarioV1Dev');

  const paths = (m.files ?? []).map((f) => f.path);
  assert.ok(paths.includes('tasks/AzureChaosStudioScenarioV1Dev'), 'packages the dev task folder');
  assert.ok(
    !paths.includes('tasks/AzureChaosStudioScenarioV1'),
    'the dev extension does NOT ship the production task folder',
  );
});

test('the production and dev tasks carry DISTINCT permanent GUIDs and dual Node handlers (side-by-side install, VF15)', () => {
  const prod = readJson('tasks/AzureChaosStudioScenarioV1/task.json') as unknown as {
    id: string;
    name: string;
    execution: Record<string, unknown>;
    version: { Major: number };
    minimumAgentVersion: string;
  };
  const dev = readJson('tasks/AzureChaosStudioScenarioV1Dev/task.json') as unknown as {
    id: string;
    name: string;
    execution: Record<string, unknown>;
    version: { Major: number };
    minimumAgentVersion: string;
  };

  assert.equal(prod.name, 'AzureChaosStudioScenario');
  assert.equal(dev.name, 'AzureChaosStudioScenarioDev');
  assert.match(prod.id, GUID, 'production task has a valid permanent GUID');
  assert.match(dev.id, GUID, 'dev task has a valid permanent GUID');
  assert.notEqual(prod.id, dev.id, 'the two tasks MUST have different GUIDs for side-by-side install');

  for (const t of [prod, dev]) {
    const handlers = Object.keys(t.execution);
    assert.deepEqual(handlers, ['Node20_1', 'Node24'], `expected Node20 fallback + Node24 primary (got ${handlers.join(', ')})`);
    assert.equal((t.execution['Node20_1'] as { target?: string }).target, 'index.js');
    assert.equal((t.execution['Node24'] as { target?: string }).target, 'index.js');
    assert.equal(t.minimumAgentVersion, '2.214.1');
    assert.equal(t.version.Major, 1, 'the task is major version 1 (AzureChaosStudioScenario@1)');
  }
});

test('the extension root packages both task folders and nothing that re-declares the existing V1 extension', () => {
  // Sanity: the extension root exists and the two task manifests are the only task
  // contributions across BOTH extensions (V2 prod + V2 dev), so no legacy/V1 task
  // is bundled by the new Workspaces extensions.
  const prod = readJson('vss-extension.json') as unknown as Manifest;
  const dev = readJson('vss-extension.dev.json') as unknown as Manifest;
  const allTaskFolders = [...taskContributions(prod), ...taskContributions(dev)].map((c) => c.properties?.name);
  assert.deepEqual(
    allTaskFolders.sort(),
    ['tasks/AzureChaosStudioScenarioV1', 'tasks/AzureChaosStudioScenarioV1Dev'],
    'exactly the two V2 task folders are contributed (no V1/legacy task)',
  );
  assert.ok(extRoot.length > 0);
});
