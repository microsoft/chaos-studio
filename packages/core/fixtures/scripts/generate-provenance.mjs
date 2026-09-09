// generate-provenance.mjs — regenerates `packages/core/fixtures/provenance.manifest.json`.
//
// The source-contract fixtures encode the current Microsoft.Chaos
// `2026-05-01-preview` wire protocol. The manifest binds each fixture to an
// authoritative source and pins tamper-evidence. What it records is what a
// hermetic CI can verify plus what a human reviewer can authenticate once:
//
//   * Tamper-evidence (REPRODUCIBLE): each fixture's canonical content hash and
//     each committed source extract's line-ending-normalized hash. Any change to
//     a fixture or an extract changes its recorded hash, which
//     `provenance.test.ts` recomputes from disk.
//   * Reviewed source extract (IN-REPO AUTHORITY): the generated enums, property
//     models, and operation snapshot are captured as REVIEWED REPRESENTATIVE
//     extracts under `source-extracts/` (this public repo has no Squall source, so
//     these faithfully encode the relevant structure/behavior of the upstream
//     artifacts and carry brief commentary — they are NOT byte-for-byte copies).
//     They are the single reviewed authority that BOTH the contract constants AND
//     the wire fixtures are authenticated against in `provenance.test.ts` (parsed
//     enum values, serialized wire field names, and the exact operation set) — so a
//     fixture and a contract constant can no longer drift together undetected.
//   * Commit-pinned source reference (OUT-OF-BAND VERIFIABLE): every source is
//     bound to a named Tier 1/2 artifact and a commit-pinned permalink (`url`)
//     into the internal `Squall` monorepo at an immutable revision (`commitId`).
//     A reviewer with monorepo access follows the permalink and confirms the
//     committed extract FAITHFULLY REPRESENTS the real generated artifact at that
//     revision (its enum members, serialized fields/channels, and operation
//     strings — not a byte-for-byte diff, since the extract carries commentary).
//
// Run: `node packages/core/fixtures/scripts/generate-provenance.mjs`
// The committed manifest is verified independently by
// `packages/core/test/contract/provenance.test.ts`.

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST_PATH = join(FIXTURES_DIR, 'provenance.manifest.json');
const MANIFEST_BASENAME = 'provenance.manifest.json';
const API_VERSION = '2026-05-01-preview';

/**
 * Immutable source snapshot. The generated `2026-05-01-preview` GW/BE artifacts
 * the fixtures trace to were captured from a single revision of the internal
 * `Squall` Azure DevOps monorepo. `commitId` pins that immutable revision; every
 * source below inherits it and each `url` is a commit-pinned permalink. A
 * reviewer with monorepo access follows the permalink to authenticate the source
 * bytes; advance `commitId` (and therefore every permalink) when the snapshot
 * moves.
 */
export const SOURCE_SNAPSHOT = {
  repo: 'Squall',
  commitId: '94309b3d1a77d34bd20d0dd0fb1a7f930685050c',
  baseUrl: 'https://dev.azure.com/msazure/One/_git/Squall',
  capturedAt: '2026-05-01',
};

/** Commit-pinned permalink to a source artifact at the snapshot revision. */
export function sourceUrl(path) {
  return `${SOURCE_SNAPSHOT.baseUrl}?path=/${path}&version=GC${SOURCE_SNAPSHOT.commitId}`;
}

/**
 * Immutable source-of-truth registry. Each key is an authoritative generated
 * model/enum, generated operation snapshot, version-agnostic V1 domain-logic
 * file, or BE command handler in the GW/BE monorepo (Tier 1/2). These are the
 * references the fixtures are traced to; a fixture may only cite a key defined
 * here. The shared `commitId` and derived commit-pinned `url` are attached by
 * `buildManifest`.
 */
export const SOURCES = {
  'gw.operations.getOperationsSnapshot': {
    repo: 'Squall/services/GW',
    path: 'services/GW/src/ArmGatewayService/ArmGatewayService.Resources.Operation.Tests/Api/IntegrationTests/Snapshots/OperationIntegrationTestsV2026_05_01_preview.GetOperations.verified.txt',
    symbol: 'GetOperations verified snapshot',
    kind: 'generated-snapshot',
    tier: 1,
    pinnedApiVersion: API_VERSION,
    extract: 'source-extracts/OperationIntegrationTestsV2026_05_01_preview.GetOperations.verified.txt',
  },
  'gw.validation.properties': {
    repo: 'Squall/services/GW',
    path: 'services/GW/src/ArmGatewayService/ArmGatewayService.Resources/Models/Preview/V2026_05_01_preview/ValidationProperties.g.cs',
    symbol: 'ValidationProperties',
    kind: 'generated-model',
    tier: 1,
    pinnedApiVersion: API_VERSION,
    extract: 'source-extracts/ValidationProperties.g.cs',
  },
  'gw.validation.state': {
    repo: 'Squall/services/GW',
    path: 'services/GW/src/ArmGatewayService/ArmGatewayService.Resources/Models/Preview/V2026_05_01_preview/ScenarioValidationState.g.cs',
    symbol: 'ScenarioValidationState',
    kind: 'generated-enum',
    tier: 1,
    pinnedApiVersion: API_VERSION,
    extract: 'source-extracts/ScenarioValidationState.g.cs',
  },
  'gw.run.properties': {
    repo: 'Squall/services/GW',
    path: 'services/GW/src/ArmGatewayService/ArmGatewayService.Resources/Models/Preview/V2026_05_01_preview/ScenarioRunProperties.g.cs',
    symbol: 'ScenarioRunProperties',
    kind: 'generated-model',
    tier: 1,
    pinnedApiVersion: API_VERSION,
    extract: 'source-extracts/ScenarioRunProperties.g.cs',
  },
  'gw.run.state': {
    repo: 'Squall/services/GW',
    path: 'services/GW/src/ArmGatewayService/ArmGatewayService.Resources/Models/Preview/V2026_05_01_preview/ScenarioRunState.g.cs',
    symbol: 'ScenarioRunState',
    kind: 'generated-enum',
    tier: 1,
    pinnedApiVersion: API_VERSION,
    extract: 'source-extracts/ScenarioRunState.g.cs',
  },
  'gw.configuration.domainLogic': {
    repo: 'Squall/services/GW',
    path: 'services/GW/src/ArmGatewayService/ArmGatewayService.Resources.Workspace.Scenario.Configuration/Api/DomainLogic/ConfigurationDomainLogicV1.cs',
    symbol: 'ConfigurationDomainLogicV1.ValidateAsync / ExecuteAsync',
    kind: 'domain-logic',
    tier: 1,
    pinnedApiVersion: API_VERSION,
    extract: 'source-extracts/ConfigurationDomainLogicV1.cs',
  },
  'gw.run.domainLogic': {
    repo: 'Squall/services/GW',
    path: 'services/GW/src/ArmGatewayService/ArmGatewayService.Resources.Workspace.Scenario.Run/Api/DomainLogic/RunDomainLogicV1.cs',
    symbol: 'RunDomainLogicV1.CancelRunAsync / GetRunAsync',
    kind: 'domain-logic',
    tier: 1,
    pinnedApiVersion: API_VERSION,
    extract: 'source-extracts/RunDomainLogicV1.cs',
  },
  'be.validation.command': {
    repo: 'Squall/services/BE',
    path: 'services/BE/src/Chaos.Workspaces.Application/Commands/StartScenarioValidationCommand.cs',
    symbol: 'StartScenarioValidationCommand (lines 59-90)',
    kind: 'command-handler',
    tier: 1,
    pinnedApiVersion: API_VERSION,
    extract: 'source-extracts/StartScenarioValidationCommand.cs',
  },
  'be.execution.command': {
    repo: 'Squall/services/BE',
    path: 'services/BE/src/Chaos.Workspaces.Application/Commands/StartScenarioExecutionCommand.cs',
    symbol: 'StartScenarioExecutionCommand (lines 60-87)',
    kind: 'command-handler',
    tier: 1,
    pinnedApiVersion: API_VERSION,
    extract: 'source-extracts/StartScenarioExecutionCommand.cs',
  },
  'be.cancel.command': {
    repo: 'Squall/services/BE',
    path: 'services/BE/src/Chaos.Workspaces.Application/Commands/CancelScenarioRunCommand.cs',
    symbol: 'CancelScenarioRunCommandHandler.Handle',
    kind: 'command-handler',
    tier: 1,
    pinnedApiVersion: API_VERSION,
    extract: 'source-extracts/CancelScenarioRunCommand.cs',
  },
  'be.configuration.controller': {
    repo: 'Squall/services/BE',
    path: 'services/BE/src/Chaos.Workspaces.Api/Controllers/ScenarioConfigurationsController.cs',
    symbol: 'ScenarioConfigurationsController (Validate / GetLatestValidation / Execute)',
    kind: 'controller',
    tier: 2,
    pinnedApiVersion: API_VERSION,
    extract: 'source-extracts/ScenarioConfigurationsController.cs',
  },
  'be.validation.store': {
    repo: 'Squall/services/BE',
    path: 'services/BE/src/Chaos.Workspaces.Infrastructure/Stores/ScenarioValidationStore.cs',
    symbol: 'ScenarioValidationStore.UpsertLatestAsync / GetLatestAsync',
    kind: 'store',
    tier: 2,
    pinnedApiVersion: API_VERSION,
    extract: 'source-extracts/ScenarioValidationStore.cs',
  },
  'be.exception.mapper': {
    repo: 'Squall/services/BE',
    path: 'services/BE/src/Chaos.Workspaces.Api/ErrorHandling/WorkspacesExceptionMapper.cs',
    symbol: 'WorkspacesExceptionMapper.Map',
    kind: 'exception-mapper',
    tier: 2,
    pinnedApiVersion: API_VERSION,
    extract: 'source-extracts/WorkspacesExceptionMapper.cs',
  },
  'be.resource.resolver': {
    repo: 'Squall/services/BE',
    path: 'services/BE/src/Chaos.Workspaces.Application/Resolution/ResourceSelectorResolver.cs',
    symbol: 'ResourceSelectorResolver.ResolveAsync',
    kind: 'resolver',
    tier: 2,
    pinnedApiVersion: API_VERSION,
    extract: 'source-extracts/ResourceSelectorResolver.cs',
  },
  'be.resource.evaluator': {
    repo: 'Squall/services/BE',
    path: 'services/BE/src/Chaos.Workspaces.Application/Resolution/SelectorEvaluator.cs',
    symbol: 'SelectorEvaluator.ResolveLiveAsync',
    kind: 'resolver',
    tier: 2,
    pinnedApiVersion: API_VERSION,
    extract: 'source-extracts/SelectorEvaluator.cs',
  },
  'be.resource.targetQuery': {
    repo: 'Squall/services/BE',
    path: 'services/BE/src/Chaos.Workspaces.Application/Resolution/SelectorTargetQuery.cs',
    symbol: 'SelectorTargetQuery.QueryAsync',
    kind: 'resolver',
    tier: 2,
    pinnedApiVersion: API_VERSION,
    extract: 'source-extracts/SelectorTargetQuery.cs',
  },
  'be.resource.diRegistration': {
    repo: 'Squall/services/BE',
    path: 'services/BE/src/Chaos.Workspaces.Application/Resolution/ResolutionServiceRegistration.cs',
    symbol: 'ResolutionServiceRegistration.AddResolution',
    kind: 'di-registration',
    tier: 2,
    pinnedApiVersion: API_VERSION,
    extract: 'source-extracts/ResolutionServiceRegistration.cs',
  },
  'be.resource.targetStore': {
    repo: 'Squall/services/BE',
    path: 'services/BE/src/Chaos.Workspaces.Application/Resolution/SelectorTargetStore.cs',
    symbol: 'SelectorTargetStore.ListTargetsAsync',
    kind: 'store',
    tier: 2,
    pinnedApiVersion: API_VERSION,
    extract: 'source-extracts/SelectorTargetStore.cs',
  },
  'be.resource.mapFactories': {
    repo: 'Squall/services/BE',
    path: 'services/BE/src/Chaos.Workspaces.Application/Resolution/SelectorMaps.cs',
    symbol: 'ResolvedSelectorMap.From / SelectorMap.FromLiveTargets',
    kind: 'construction-helper',
    tier: 2,
    pinnedApiVersion: API_VERSION,
    extract: 'source-extracts/SelectorMaps.cs',
  },
  'gw.error.models': {
    repo: 'Squall/services/GW',
    path: 'services/GW/src/ArmGatewayService/ArmGatewayService.Resources/Models/Preview/V2026_05_01_preview/ScenarioErrors.g.cs',
    symbol: 'ScenarioError / ScenarioValidationError / ScenarioExecutionError',
    kind: 'generated-model',
    tier: 1,
    pinnedApiVersion: API_VERSION,
    extract: 'source-extracts/ScenarioErrors.g.cs',
  },
  'gw.run.resource': {
    repo: 'Squall/services/GW',
    path: 'services/GW/src/ArmGatewayService/ArmGatewayService.Resources/Models/Preview/V2026_05_01_preview/ScenarioRunResource.g.cs',
    symbol: 'ScenarioRunResource',
    kind: 'generated-model',
    tier: 1,
    pinnedApiVersion: API_VERSION,
    extract: 'source-extracts/ScenarioRunResource.g.cs',
  },
  'be.run.state.isTerminal': {
    repo: 'Squall/services/BE',
    path: 'services/BE/src/Chaos.Workspaces.Domain/ScenarioRunStateExtensions.cs',
    symbol: 'ScenarioRunStateExtensions.IsTerminal',
    kind: 'domain-logic',
    tier: 2,
    pinnedApiVersion: API_VERSION,
    extract: 'source-extracts/ScenarioRunStateExtensions.cs',
  },
  'be.validation.state.isTerminal': {
    repo: 'Squall/services/BE',
    path: 'services/BE/src/Chaos.Workspaces.Domain/ScenarioValidationStateExtensions.cs',
    symbol: 'ScenarioValidationStateExtensions.IsTerminal',
    kind: 'domain-logic',
    tier: 2,
    pinnedApiVersion: API_VERSION,
    extract: 'source-extracts/ScenarioValidationStateExtensions.cs',
  },
};

/**
 * Canonical content hash: hash of the JSON re-serialized from the parsed
 * fixture, so incidental whitespace or line-ending differences (CRLF vs LF
 * across platforms) never change the hash while any semantic change does.
 */
export function canonicalSha256(rawJson) {
  const canonical = JSON.stringify(JSON.parse(rawJson));
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/**
 * Line-ending-normalized hash for the committed source extracts (`.cs`/`.txt`),
 * which are not JSON. CRLF is normalized to LF so the recorded hash is stable
 * regardless of git autocrlf, while any semantic byte change is still caught.
 */
export function extractSha256(rawText) {
  return createHash('sha256').update(rawText.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
}

/** Recursively lists every fixture JSON, excluding ONLY the ROOT manifest. */
export function listFixtureFiles(dir = FIXTURES_DIR) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...listFixtureFiles(full));
      continue;
    }
    // Case-insensitive extension match; exclude only the root manifest by its
    // FULL path (a nested provenance.manifest.json is a real fixture, not the
    // manifest, and must not be silently skipped).
    if (!entry.toLowerCase().endsWith('.json')) continue;
    if (full === MANIFEST_PATH) continue;
    out.push(full);
  }
  return out;
}

/** Posix-style, fixtures-relative path used as the stable manifest key. */
function fixtureKey(fullPath) {
  return relative(FIXTURES_DIR, fullPath).split('\\').join('/');
}

export function buildManifest() {
  const fixtures = listFixtureFiles()
    .map((full) => {
      const raw = readFileSync(full, 'utf8');
      const parsed = JSON.parse(raw);
      const provenance = parsed.provenance;
      const key = fixtureKey(full);
      if (!provenance || typeof provenance.source !== 'string') {
        throw new Error(`Fixture ${key} is missing a provenance.source block.`);
      }
      if (!(provenance.source in SOURCES)) {
        throw new Error(
          `Fixture ${key} cites unknown source '${provenance.source}'. Add it to SOURCES first.`,
        );
      }
      return {
        file: key,
        source: provenance.source,
        citation: provenance.citation ?? '',
        canonicalSha256: canonicalSha256(raw),
      };
    })
    .sort((a, b) => a.file.localeCompare(b.file));

  // Attach the shared immutable commit pin and a commit-pinned permalink to each
  // source. Sources with a committed reviewed extract also carry the extract's
  // relative path and its line-ending-normalized hash (tamper-evidence for the
  // in-repo authority the contract + fixtures are authenticated against).
  const sources = Object.fromEntries(
    Object.entries(SOURCES).map(([key, src]) => {
      const entry = { ...src, commitId: SOURCE_SNAPSHOT.commitId, url: sourceUrl(src.path) };
      if (src.extract) {
        const extractRaw = readFileSync(join(FIXTURES_DIR, src.extract), 'utf8');
        entry.extractSha256 = extractSha256(extractRaw);
      }
      return [key, entry];
    }),
  );

  return {
    apiVersion: API_VERSION,
    note:
      'Provenance manifest for the source-contract fixtures. Each fixture is bound to a named Tier 1/2 source-of-truth artifact (SOURCES) via a commit-pinned permalink (immutable sourceSnapshot.commitId + per-source url) and a canonical content hash for tamper-evidence. Generated sources also carry a committed reviewed extract under source-extracts/ (recorded path + extractSha256); provenance.test.ts parses those extracts and authenticates BOTH the contract.ts constants AND the fixtures against them (enum values, wire field names, exact operation set). Regenerate with `node packages/core/fixtures/scripts/generate-provenance.mjs`.',
    sourceSnapshot: SOURCE_SNAPSHOT,
    sources,
    fixtures,
  };
}

function main() {
  const manifest = buildManifest();
  writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(`Wrote ${MANIFEST_BASENAME} with ${manifest.fixtures.length} fixtures.`);
}

if (process.argv[1] && process.argv[1].endsWith('generate-provenance.mjs')) {
  main();
}
