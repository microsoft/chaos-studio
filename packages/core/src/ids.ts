/**
 * ids.ts (E2-T1) — resource-ID / request-URI builder for the pinned
 * `Microsoft.Chaos` `2026-05-01-preview` API, plus identifier validation
 * (FR14) and DX3 run-ID extraction from an execute `Location`.
 *
 * This is the foundational core module: it imports only the E1 contract
 * constants and defines {@link CoreError}, the single categorized error the
 * rest of the core throws and the orchestrator normalizes.
 */

import { API_VERSION, GUID_PATTERN } from './contract.ts';
import type { ErrorCategory } from './contract.ts';

/** ARM public-cloud root. Cloud selection is owned by the adapter's auth layer (D6). */
export const ARM_BASE_URL = 'https://management.azure.com';
/** The ARM host a credential-bearing request may target. */
const ARM_HOST = 'management.azure.com';

/** Optional context attached to a {@link CoreError}. */
export interface CoreErrorContext {
  armErrorCode?: string;
  correlationId?: string;
  requestId?: string;
  cause?: unknown;
}

/**
 * The single error type the core raises. Every failure carries a stable
 * {@link ErrorCategory} so the orchestrator can map it to a normalized result
 * without string-matching, and optional ARM correlation context (VF10, FR12).
 */
export class CoreError extends Error {
  readonly category: ErrorCategory;
  readonly armErrorCode: string | undefined;
  readonly correlationId: string | undefined;
  readonly requestId: string | undefined;

  constructor(category: ErrorCategory, message: string, context: CoreErrorContext = {}) {
    super(message, context.cause === undefined ? undefined : { cause: context.cause });
    this.name = 'CoreError';
    this.category = category;
    this.armErrorCode = context.armErrorCode;
    this.correlationId = context.correlationId;
    this.requestId = context.requestId;
  }
}

/** The five identifiers that address a scenario configuration (FR14, D5). */
export interface ScenarioCoordinates {
  subscriptionId: string;
  resourceGroup: string;
  workspaceName: string;
  scenarioName: string;
  scenarioConfigurationName: string;
}

// ---------------------------------------------------------------------------
// Identifier validation (FR14). Reject malformed identifiers BEFORE issuing any
// call — both to give an actionable error and to close path-injection (a value
// carrying `/`, whitespace, `?`, `#`, or `..` would corrupt the resource path).
// ---------------------------------------------------------------------------

/** ARM resource-group name: letters/digits/`-`/`_`/`.`/`(`/`)`, 1–90 chars, not ending in a period. */
const RESOURCE_GROUP_PATTERN = /^[A-Za-z0-9._\-()]{1,90}$/;
/**
 * Conservative Chaos child-resource name (workspace/scenario/configuration):
 * must start alphanumeric, then alphanumeric/`-`/`_`/`.`, 1–128 chars. This is a
 * strict subset of what ARM accepts — it deliberately rejects any character that
 * could alter the resource path (`/`, whitespace, `?`, `#`, `..`).
 */
const RESOURCE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function identifierError(field: string, value: string, requirement: string): CoreError {
  // The value itself is echoed truncated so the message is actionable without
  // leaking an unbounded, possibly secret-shaped input into logs.
  const shown = value.length > 64 ? `${value.slice(0, 64)}…` : value;
  return new CoreError('identifier', `invalid ${field} '${shown}': ${requirement}`);
}

/** Validates a subscription ID as a GUID (FR14). Returns the value on success. */
export function validateSubscriptionId(value: string): string {
  if (!GUID_PATTERN.test(value)) {
    throw identifierError('subscription-id', value, 'must be a GUID');
  }
  return value;
}

/** Validates an ARM resource-group name (FR14). Returns the value on success. */
export function validateResourceGroup(value: string): string {
  if (!RESOURCE_GROUP_PATTERN.test(value) || value.endsWith('.')) {
    throw identifierError(
      'resource-group',
      value,
      'must be 1–90 chars of letters, digits, or `-` `_` `.` `(` `)` and not end with a period',
    );
  }
  return value;
}

/** Validates a Chaos child-resource name (FR14). Returns the value on success. */
export function validateResourceName(field: string, value: string): string {
  if (!RESOURCE_NAME_PATTERN.test(value)) {
    throw identifierError(
      field,
      value,
      'must start with a letter or digit and contain only letters, digits, `-`, `_`, or `.` (max 128)',
    );
  }
  return value;
}

/** Validates every identifier in the coordinates (FR14). Returns them on success. */
export function validateScenarioCoordinates(c: ScenarioCoordinates): ScenarioCoordinates {
  validateSubscriptionId(c.subscriptionId);
  validateResourceGroup(c.resourceGroup);
  validateResourceName('workspace-name', c.workspaceName);
  validateResourceName('scenario-name', c.scenarioName);
  validateResourceName('scenario-configuration-name', c.scenarioConfigurationName);
  return c;
}

// ---------------------------------------------------------------------------
// Resource-ID and request-URI builders. Identifiers are validated first so a
// built path can never carry an unvalidated segment.
// ---------------------------------------------------------------------------

/** `/subscriptions/{sub}/…/scenarios/{scn}/configurations/{cfg}` (validated). */
export function configurationResourceId(c: ScenarioCoordinates): string {
  validateScenarioCoordinates(c);
  return (
    `/subscriptions/${c.subscriptionId}` +
    `/resourceGroups/${c.resourceGroup}` +
    `/providers/Microsoft.Chaos/workspaces/${c.workspaceName}` +
    `/scenarios/${c.scenarioName}` +
    `/configurations/${c.scenarioConfigurationName}`
  );
}

/** `/subscriptions/{sub}/…/scenarios/{scn}/runs/{runId}` (validated; runId must be a GUID). */
export function runResourceId(c: ScenarioCoordinates, runId: string): string {
  validateSubscriptionId(c.subscriptionId);
  validateResourceGroup(c.resourceGroup);
  validateResourceName('workspace-name', c.workspaceName);
  validateResourceName('scenario-name', c.scenarioName);
  if (!GUID_PATTERN.test(runId)) {
    throw new CoreError('identifier', `invalid run id '${runId}': must be a GUID`);
  }
  return (
    `/subscriptions/${c.subscriptionId}` +
    `/resourceGroups/${c.resourceGroup}` +
    `/providers/Microsoft.Chaos/workspaces/${c.workspaceName}` +
    `/scenarios/${c.scenarioName}` +
    `/runs/${runId}`
  );
}

function withApiVersion(path: string, suffix = ''): string {
  return `${ARM_BASE_URL}${path}${suffix}?api-version=${API_VERSION}`;
}

/** POST `…/configurations/{cfg}/validate` (VF1). */
export function validateActionUrl(c: ScenarioCoordinates): string {
  return withApiVersion(configurationResourceId(c), '/validate');
}

/** GET `…/configurations/{cfg}/validations/latest` — the validate LRO Location target (VF1, VF2). */
export function validationsLatestUrl(c: ScenarioCoordinates): string {
  return withApiVersion(configurationResourceId(c), '/validations/latest');
}

/** POST `…/configurations/{cfg}/execute` (VF5). */
export function executeActionUrl(c: ScenarioCoordinates): string {
  return withApiVersion(configurationResourceId(c), '/execute');
}

/** GET a run resource by its resource ID — the execute/cancel LRO Location target (VF6, VF8). */
export function runResourceUrl(resourceId: string): string {
  return withApiVersion(resourceId);
}

/** POST `…/runs/{runId}/cancel` (VF8). */
export function cancelActionUrl(resourceId: string): string {
  return withApiVersion(resourceId, '/cancel');
}

// ---------------------------------------------------------------------------
// DX3 — the execute 202 `Location` IS the full run resource ID; the run GUID is
// the final `/runs/{runId}` segment. A missing/malformed Location, a non-GUID
// run segment, or (when expected coordinates are supplied) a Location pointing
// at a DIFFERENT workspace/scenario fails closed as `ambiguous-acceptance`
// (D14): the core never fabricates a run URL and never re-POSTs.
// ---------------------------------------------------------------------------

/** Extracts `{ runResourceId, runId }` from an execute/cancel `Location`. */
export function parseRunLocation(
  location: string | undefined,
  expected?: ScenarioCoordinates,
): { runResourceId: string; runId: string } {
  if (!location) {
    throw new CoreError('ambiguous-acceptance', 'acceptance response carried no Location header');
  }
  let url: URL;
  try {
    url = new URL(location);
  } catch {
    throw new CoreError('ambiguous-acceptance', `acceptance Location is not an absolute URL: '${location}'`);
  }
  // The Location must be an ARM HTTPS resource — never a foreign/HTTP origin the
  // client would then send a credential to.
  if (url.protocol !== 'https:' || url.host !== ARM_HOST) {
    throw new CoreError('ambiguous-acceptance', `acceptance Location is not an ARM URL (${url.protocol}//${url.host})`);
  }
  // The Location MUST carry the single pinned api-version (D5, D14) — an unpinned
  // or foreign version is not a resource this release trusts.
  assertPinnedApiVersion(url, 'acceptance Location');
  const segments = url.pathname.split('/').filter(Boolean);
  const runsIndex = segments.lastIndexOf('runs');
  if (runsIndex < 0 || runsIndex !== segments.length - 2) {
    throw new CoreError('ambiguous-acceptance', 'acceptance Location is not a .../runs/{runId} resource path');
  }
  const runId = segments[segments.length - 1]!;
  if (!GUID_PATTERN.test(runId)) {
    throw new CoreError('ambiguous-acceptance', 'acceptance Location run-id segment is not a GUID');
  }
  // Structural check: the path must be the canonical Microsoft.Chaos run resource
  // shape (`/subscriptions/{s}/resourceGroups/{rg}/providers/Microsoft.Chaos/
  // workspaces/{ws}/scenarios/{scn}/runs/{runId}`), with the run directly under
  // the scenario — no extra intervening segments.
  const shapeOk =
    segments.length === 12 &&
    segments[0] === 'subscriptions' &&
    segments[2] === 'resourceGroups' &&
    segments[4] === 'providers' &&
    segments[5] === 'Microsoft.Chaos' &&
    segments[6] === 'workspaces' &&
    segments[8] === 'scenarios' &&
    segments[10] === 'runs';
  if (!shapeOk) {
    throw new CoreError('ambiguous-acceptance', 'acceptance Location is not a canonical Microsoft.Chaos run resource');
  }
  if (expected) {
    // ARM treats these identifiers case-insensitively for routing; compare so a
    // Location pointing at a DIFFERENT resource than requested fails closed (D14),
    // without falsely rejecting a case-normalized echo of the same resource.
    const eq = (a: string | undefined, b: string): boolean => (a ?? '').toLowerCase() === b.toLowerCase();
    if (
      !eq(segments[1], expected.subscriptionId) ||
      !eq(segments[3], expected.resourceGroup) ||
      !eq(segments[7], expected.workspaceName) ||
      !eq(segments[9], expected.scenarioName)
    ) {
      throw new CoreError(
        'ambiguous-acceptance',
        'acceptance Location points at a different resource than requested',
      );
    }
  }
  return { runResourceId: url.pathname, runId };
}

/**
 * Guard: refuse to send an ARM credential to any URL that is not an
 * `https://management.azure.com` origin (defense in depth for every
 * Location-derived request — a foreign Location must never receive the token).
 */
export function assertArmUrl(url: string): void {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new CoreError('transport', 'refusing to issue a request to a malformed URL');
  }
  if (u.protocol !== 'https:' || u.host !== ARM_HOST) {
    throw new CoreError('transport', `refusing to send an ARM credential to a non-ARM URL (${u.protocol}//${u.host})`);
  }
}

/** Case-insensitive equality for ARM path identifiers (ARM routes case-insensitively). */
function eqCi(a: string | undefined, b: string): boolean {
  return (a ?? '').toLowerCase() === b.toLowerCase();
}

/** Require EXACTLY ONE pinned api-version on a Location URL (D5, D14). */
function assertPinnedApiVersion(url: URL, what: string): void {
  // `getAll` (not `get`) so a Location carrying the pinned version PLUS a
  // conflicting/duplicate `api-version` — which would leave the effective version
  // ambiguous — fails closed rather than being accepted on the first match.
  const versions = url.searchParams.getAll('api-version');
  if (versions.length !== 1 || versions[0] !== API_VERSION) {
    throw new CoreError(
      'ambiguous-acceptance',
      `${what} must carry exactly one pinned api-version ${API_VERSION}`,
    );
  }
}

/**
 * Bind a validate 202 `Location` to the EXACT requested configuration (FR14,
 * D14): it must be the canonical
 * `…/Microsoft.Chaos/workspaces/{ws}/scenarios/{scn}/configurations/{cfg}/validations/latest`
 * resource for these coordinates (compared case-insensitively) on the ARM host
 * with the pinned api-version. A foreign subscription/resource-group/workspace/
 * scenario/configuration, a wrong shape, a non-ARM origin, or an unpinned version
 * fails closed as `ambiguous-acceptance` (no re-POST). Returns the validated
 * Location for polling.
 */
export function parseValidationLocation(location: string | undefined, expected: ScenarioCoordinates): string {
  if (!location) {
    throw new CoreError('ambiguous-acceptance', 'validate acceptance carried no Location header');
  }
  let url: URL;
  try {
    url = new URL(location);
  } catch {
    throw new CoreError('ambiguous-acceptance', `validate acceptance Location is not an absolute URL: '${location}'`);
  }
  if (url.protocol !== 'https:' || url.host !== ARM_HOST) {
    throw new CoreError('ambiguous-acceptance', `validate acceptance Location is not an ARM URL (${url.protocol}//${url.host})`);
  }
  assertPinnedApiVersion(url, 'validate acceptance Location');
  const s = url.pathname.split('/').filter(Boolean);
  // Expected 14-segment shape: subscriptions/{s}/resourceGroups/{rg}/providers/
  // Microsoft.Chaos/workspaces/{ws}/scenarios/{scn}/configurations/{cfg}/validations/latest
  const shapeOk =
    s.length === 14 &&
    s[0] === 'subscriptions' &&
    s[2] === 'resourceGroups' &&
    s[4] === 'providers' &&
    s[5] === 'Microsoft.Chaos' &&
    s[6] === 'workspaces' &&
    s[8] === 'scenarios' &&
    s[10] === 'configurations' &&
    s[12] === 'validations' &&
    s[13] === 'latest';
  if (!shapeOk) {
    throw new CoreError('ambiguous-acceptance', 'validate acceptance Location is not a canonical validations/latest resource');
  }
  if (
    !eqCi(s[1], expected.subscriptionId) ||
    !eqCi(s[3], expected.resourceGroup) ||
    !eqCi(s[7], expected.workspaceName) ||
    !eqCi(s[9], expected.scenarioName) ||
    !eqCi(s[11], expected.scenarioConfigurationName)
  ) {
    throw new CoreError('ambiguous-acceptance', 'validate acceptance Location points at a different configuration than requested');
  }
  return location;
}

/**
 * Bind a cancel 202 `Location` to the KNOWN run resource we cancelled (FR11,
 * D14). When present it must resolve (via {@link parseRunLocation}) to the exact
 * same run resource path (case-insensitive) on the ARM host with the pinned
 * api-version; a foreign run, wrong shape, or unpinned version fails closed. When
 * absent, the canonical run URL for the known resource is used (the cancel
 * Location is documented to be the same run resource). Returns the poll URL.
 */
export function resolveCancelPollUrl(location: string | undefined, knownRunResourceId: string): string {
  if (!location) return runResourceUrl(knownRunResourceId);
  const { runResourceId } = parseRunLocation(location);
  if (!eqCi(runResourceId, knownRunResourceId)) {
    throw new CoreError('ambiguous-acceptance', 'cancel Location points at a different run than requested');
  }
  return location;
}
