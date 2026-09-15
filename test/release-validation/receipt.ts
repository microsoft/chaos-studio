/**
 * receipt.ts — the release-validation receipt (E6-T1).
 *
 * RV1–RV3 are executed by an operator against a real target preview environment
 * (a live Chaos Studio v2 stamp, a federated CI identity, and the private
 * Action/extension builds). Those runs are not reproducible from a worktree, so
 * this module owns the part that IS: a receipt schema, PURE evaluators that
 * decide pass/fail from recorded observations using only the source-proven
 * contract constants, and a canonical digest that makes a receipt reproducible
 * and tamper-evident.
 *
 * The split matters operationally: the operator records WHAT the environment
 * did; this code decides whether that satisfies the contract. A protocol
 * mismatch therefore always surfaces as a receipt failure (→ a service defect),
 * never as a silently accommodating client change.
 *
 * Not a `*.test.ts` file, so the runner treats it as a helper. It is also the
 * evaluator behind `scripts/lib/rv-receipt.mjs`, the release-gate CLI.
 */

import { createHash } from 'node:crypto';

import {
  API_VERSION,
  CLEANUP_TIMEOUT_SECONDS,
  DEFAULT_RETRY_AFTER_SECONDS,
  END_TIME_FIELD,
  GUID_PATTERN,
  PROVIDER_OPERATIONS,
  RUN_ERROR_CHANNELS,
  RUN_TERMINAL_SUCCESS,
  START_TIME_FIELD,
  STATUS_FIELD,
  VALIDATION_ERROR_CHANNELS,
  VALIDATION_TERMINAL_SUCCESS,
} from '../../packages/core/src/contract.ts';
import { validateRunnerRole, type RoleDefinition } from './roleValidator.ts';

export const RECEIPT_KIND = 'chaos-studio-release-validation-receipt';
export const RECEIPT_SCHEMA_VERSION = 1;

/** The three release-validation checks, in order. All must pass before release. */
export const RV_CHECK_IDS = ['RV1', 'RV2', 'RV3'] as const;
export type RvCheckId = (typeof RV_CHECK_IDS)[number];

/** Both marketplace artifacts must come from the SAME core commit (D16). */
export const RELEASE_PLATFORMS = ['github-action', 'azure-pipelines-task'] as const;
export type ReleasePlatform = (typeof RELEASE_PLATFORMS)[number];

/** v1 ships the public cloud only (NG4); a receipt from any other cloud proves nothing. */
export const SUPPORTED_CLOUD = 'AzureCloud';

/**
 * Operations the journey deliberately does NOT call. RV2 must prove the identity
 * succeeds without them, otherwise the shipped least-privilege role is wrong.
 */
export const OPERATIONS_PROVEN_NOT_REQUIRED = [
  'Microsoft.Chaos/workspaces/read',
  'Microsoft.Chaos/locations/workspaceOperationResults/read',
] as const;

const REQUIRED_OPERATIONS: readonly string[] = Object.values(PROVIDER_OPERATIONS);
const SHA256_HEX = /^[0-9a-f]{64}$/;
const COMMIT_SHA = /^[0-9a-f]{40}$/;

// ---------------------------------------------------------------------------
// Observation shapes — exactly what the operator records per check.
// ---------------------------------------------------------------------------

/** One accepted long-running action and the terminal resource it resolved to. */
export interface LroObservation {
  /** HTTP status of the initiating call (the contract's external acceptance). */
  acceptedStatus: number;
  /** Trailing path segments of the returned `Location` (no subscription/resource IDs). */
  locationSuffix: string;
  /** `Retry-After` seconds advertised on acceptance. */
  retryAfterSeconds: number;
  /** HTTP status of the terminal polled GET. */
  terminalStatus: number;
  /** Terminal `properties.status` value observed. */
  terminalState: string;
}

/** One accepted execute call and the run identity it produced. */
export type ExecuteObservation = LroObservation & { runId: string; runResourceIdSuffix: string };

/**
 * A cancellation requires its OWN run: terminal-run cancellation is a no-op
 * (RV3), so cancelling the same run already observed Succeeded in
 * `successRun` cannot happen for real. The operator instead executes a
 * SECOND run and cancels it while in flight.
 */
export interface Rv1CancellationRun {
  /** The execute call that started the run subsequently canceled. */
  execute: ExecuteObservation;
  cancel: LroObservation;
}

/** The protocol transcript one adapter produced against the live service. */
export interface Rv1Transcript {
  /** Which shipping adapter produced this transcript. */
  platform: ReleasePlatform;
  validate: LroObservation;
  /** A run driven to completion, observed Succeeded — proves the success path. */
  successRun: ExecuteObservation;
  /** A separate, independently identified run driven to Canceled — proves cancellation. */
  cancellationRun: Rv1CancellationRun;
  /** The deployed wire shape, as observed on the returned resources. */
  wire: {
    statusField: string;
    startTimeField: string;
    endTimeField: string;
    validationErrorChannels: string[];
    runErrorChannels: string[];
  };
}

export interface Rv1Observations {
  region: string;
  /** The `api-version` the requests actually carried. */
  apiVersion: string;
  /**
   * EXACTLY ONE transcript per shipping adapter. E6-T1 requires RV1 to be run from
   * the private Action build AND the private extension build, so a single transcript
   * is not acceptable evidence: each adapter must be shown to drive the protocol
   * itself, in its own run.
   */
  transcripts: Rv1Transcript[];
}

export interface Rv2Observations {
  /** Scope the role assignment under test was created at. */
  assignmentScope: string;
  /** The custom role definition the CI identity actually held. */
  roleDefinition: RoleDefinition;
  federatedIdentities: Array<{
    platform: ReleasePlatform;
    tokenAcquired: boolean;
    /** True when the ARM token came from workload identity federation, not a secret. */
    secretless: boolean;
  }>;
  /** One per required operation: remove it, then observe which calls fail. */
  negativeCases: Array<{
    removedOperation: string;
    failedOperations: string[];
    succeededOperations: string[];
  }>;
  operationsProvenNotRequired: string[];
}

export interface Rv3Observations {
  /** Wall-clock seconds from the cancel request to the observed `Canceled` state. */
  cancelToCanceledSeconds: number;
  duplicateCancelAccepted: boolean;
  /** State after two rapid cancels — still on the cancellation path. */
  duplicateCancelTerminalState: string;
  cancelOnTerminalRunAccepted: boolean;
  cleanupFailurePreservesOriginalFailure: boolean;
}

export type RvObservations = Rv1Observations | Rv2Observations | Rv3Observations;

export interface RvCheck {
  id: RvCheckId;
  status: 'passed' | 'failed' | 'not-run';
  observedAt: string;
  observations: RvObservations;
}

export interface Receipt {
  schemaVersion: number;
  kind: string;
  /** True for the committed skeleton; a template can never satisfy the gate. */
  template: boolean;
  apiVersion: string;
  coreCommit: string;
  generatedAt: string;
  environment: {
    cloud: string;
    region: string;
    /** sha256 of the workspace resource ID — proves one scope without publishing it. */
    workspaceScopeHash: string;
  };
  artifacts: Array<{ platform: ReleasePlatform; build: string; coreCommit: string }>;
  checks: RvCheck[];
  /** Canonical digest stamped by the receipt CLI; re-derived on validation. */
  digest?: string;
}

export interface CheckResult {
  id: RvCheckId;
  pass: boolean;
  failures: string[];
}

export interface ReceiptValidationOptions {
  /** Operation names from the generated provider snapshot (RV2 "exists" authority). */
  providerOpNames: ReadonlySet<string>;
  /** The commit being released; the receipt must be bound to it. */
  expectedCoreCommit?: string;
  /** Reject receipts older than this many days. */
  maxAgeDays?: number;
  /** Evaluation time in epoch ms (defaults to now); injected for determinism. */
  now?: number;
}

export interface ReceiptValidationResult {
  ok: boolean;
  failures: string[];
  checks: CheckResult[];
}

// ---------------------------------------------------------------------------
// Canonicalization + digest.
// ---------------------------------------------------------------------------

/**
 * Deterministic JSON: object keys sorted recursively, arrays order-preserving
 * (observation order is meaningful). Two receipts with the same content produce
 * the same string regardless of how they were assembled.
 */
export function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** sha256 over the canonical receipt body, excluding any stamped digest. */
export function receiptDigest(receipt: Receipt): string {
  const { digest: _ignored, ...body } = receipt;
  return createHash('sha256').update(canonicalize(body), 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// Check evaluators — pure, contract-grounded, fail-closed.
// ---------------------------------------------------------------------------

const isIsoInstant = (value: unknown): boolean =>
  typeof value === 'string' && value.length > 0 && Number.isFinite(Date.parse(value));

/**
 * Tolerance for benign clock differences between the operator workstation that
 * stamps a receipt and the runner that verifies it. Anything beyond this is
 * treated as a post-dated timestamp, not skew.
 */
const CLOCK_SKEW_MS = 5 * 60_000;

const sorted = (values: readonly string[]): string[] => [...values].sort();

function result(id: RvCheckId, failures: string[]): CheckResult {
  return { id, pass: failures.length === 0, failures };
}

function checkLro(
  failures: string[],
  label: string,
  lro: LroObservation,
  expectedLocationSuffix: string | undefined,
  terminalStates: readonly string[],
): void {
  if (lro.acceptedStatus !== 202) {
    failures.push(`${label}: expected a 202 acceptance, observed ${lro.acceptedStatus}`);
  }
  if (expectedLocationSuffix !== undefined && lro.locationSuffix !== expectedLocationSuffix) {
    failures.push(
      `${label}: expected Location suffix '${expectedLocationSuffix}', observed '${lro.locationSuffix}'`,
    );
  }
  if (lro.retryAfterSeconds !== DEFAULT_RETRY_AFTER_SECONDS) {
    failures.push(
      `${label}: expected Retry-After ${DEFAULT_RETRY_AFTER_SECONDS}, observed ${lro.retryAfterSeconds}`,
    );
  }
  if (lro.terminalStatus !== 200) {
    failures.push(`${label}: expected a terminal 200 GET, observed ${lro.terminalStatus}`);
  }
  if (!terminalStates.includes(lro.terminalState)) {
    failures.push(
      `${label}: terminal state '${lro.terminalState}' is not one of ${terminalStates.join(', ')}`,
    );
  }
}

/** RV1 — pinned-version protocol smoke in the release target region. */
export function evaluateRv1(o: Rv1Observations): CheckResult {
  const failures: string[] = [];

  if (o.apiVersion !== API_VERSION) {
    failures.push(`api-version: expected '${API_VERSION}', observed '${o.apiVersion}'`);
  }
  if (typeof o.region !== 'string' || o.region.trim() === '') {
    failures.push('region: the target region must be recorded');
  }

  const transcripts = o.transcripts ?? [];
  for (const platform of RELEASE_PLATFORMS) {
    const matching = transcripts.filter((t) => t.platform === platform);
    if (matching.length !== 1) {
      failures.push(`transcripts: expected exactly one '${platform}' transcript, found ${matching.length}`);
    }
  }
  for (const transcript of transcripts) {
    if (!(RELEASE_PLATFORMS as readonly string[]).includes(transcript.platform)) {
      failures.push(`transcripts: unknown platform '${transcript.platform}'`);
      continue;
    }
    checkTranscript(failures, transcript);
  }
  // Each adapter must have driven its OWN success run and its OWN cancellation
  // run — and those two runs must themselves be DIFFERENT runs, since a
  // terminal-run cancellation is a no-op (RV3) and cannot turn a Succeeded run
  // into a Canceled one. Identical run IDs across adapters would also mean one
  // run was recorded twice rather than each private build being exercised.
  // GUIDs are case-insensitive, so compare them case-folded — otherwise
  // re-casing one copy would defeat the check.
  const allRunIds = transcripts.flatMap((t) => [t.successRun?.runId, t.cancellationRun?.execute?.runId]);
  const runIds = allRunIds.filter((id): id is string => typeof id === 'string').map((id) => id.toLowerCase());
  if (new Set(runIds).size !== runIds.length) {
    failures.push(
      'transcripts: every success run and cancellation run must be distinct (duplicate run IDs found)',
    );
  }

  return result('RV1', failures);
}

/** Evaluate one adapter's protocol transcript against the source-proven contract. */
function checkTranscript(failures: string[], t: Rv1Transcript): void {
  const at = (message: string): string => `${t.platform}: ${message}`;

  checkLro(failures, `${t.platform} validate`, t.validate, 'validations/latest', VALIDATION_TERMINAL_SUCCESS);
  checkLro(failures, `${t.platform} success execute`, t.successRun, undefined, RUN_TERMINAL_SUCCESS);
  checkLro(failures, `${t.platform} cancellation execute`, t.cancellationRun.execute, undefined, RUN_TERMINAL_SUCCESS);
  checkLro(failures, `${t.platform} cancel`, t.cancellationRun.cancel, undefined, ['Canceled']);

  // The run ID is the final `/runs/{runId}` segment of the execute Location and
  // must parse as a GUID before the client trusts it (DX3, VF5).
  for (const [label, execute] of [
    ['success', t.successRun] as const,
    ['cancellation', t.cancellationRun.execute] as const,
  ]) {
    if (!GUID_PATTERN.test(execute.runId)) {
      failures.push(at(`${label} run ID '${execute.runId}' is not a GUID`));
    }
    if (execute.runResourceIdSuffix !== `runs/${execute.runId}`) {
      failures.push(
        at(`${label} resource ID '${execute.runResourceIdSuffix}' does not end with the observed run ID`),
      );
    }
    if (execute.locationSuffix !== `runs/${execute.runId}`) {
      failures.push(at(`${label} execute Location '${execute.locationSuffix}' does not address run '${execute.runId}'`));
    }
  }
  // The cancel acceptance must address the SAME run its own execute call
  // started, not the success run or an unrelated one.
  if (t.cancellationRun.cancel.locationSuffix !== `runs/${t.cancellationRun.execute.runId}`) {
    failures.push(
      at(
        `cancel Location '${t.cancellationRun.cancel.locationSuffix}' does not address run '${t.cancellationRun.execute.runId}'`,
      ),
    );
  }
  // The success run must NOT be the run that was canceled — proving these are
  // genuinely independent journeys, not one run relabeled twice.
  if (t.successRun.runId.toLowerCase() === t.cancellationRun.execute.runId.toLowerCase()) {
    failures.push(at('the success run and the cancellation run must be different runs'));
  }

  if (t.wire.statusField !== STATUS_FIELD) {
    failures.push(at(`wire status field '${t.wire.statusField}' != '${STATUS_FIELD}'`));
  }
  if (t.wire.startTimeField !== START_TIME_FIELD) {
    failures.push(at(`wire start-time field '${t.wire.startTimeField}' != '${START_TIME_FIELD}'`));
  }
  if (t.wire.endTimeField !== END_TIME_FIELD) {
    failures.push(at(`wire end-time field '${t.wire.endTimeField}' != '${END_TIME_FIELD}'`));
  }
  if (canonicalize(sorted(t.wire.validationErrorChannels)) !== canonicalize(sorted(VALIDATION_ERROR_CHANNELS))) {
    failures.push(
      at(`wire validation error channels ${t.wire.validationErrorChannels.join('/')} != ${VALIDATION_ERROR_CHANNELS.join('/')}`),
    );
  }
  if (canonicalize(sorted(t.wire.runErrorChannels)) !== canonicalize(sorted(RUN_ERROR_CHANNELS))) {
    failures.push(
      at(`wire run error channels ${t.wire.runErrorChannels.join('/')} != ${RUN_ERROR_CHANNELS.join('/')}`),
    );
  }
}

/** RV2 — workload identity and least-privilege authorization. */
export function evaluateRv2(o: Rv2Observations, providerOpNames: ReadonlySet<string>): CheckResult {
  const failures: string[] = [];

  if (o.assignmentScope !== 'workspace') {
    failures.push(
      `assignment scope: expected 'workspace', observed '${o.assignmentScope}' (a broader scope over-grants)`,
    );
  }

  const role = validateRunnerRole(o.roleDefinition, REQUIRED_OPERATIONS, providerOpNames);
  for (const [kind, ops] of [
    ['missing required operation', role.missing],
    ['extraneous operation', role.extraneous],
    ['operation absent from the provider snapshot', role.unknown],
    ['data action', role.dataActions],
    ['NotActions subtraction', role.notActions],
  ] as const) {
    for (const op of ops) failures.push(`role: ${kind} '${op}'`);
  }

  for (const platform of RELEASE_PLATFORMS) {
    // Exactly one result per platform, and EVERY entry is evaluated below: a
    // `.find()` would let a contradictory duplicate (a failed or secret-backed
    // retry) hide behind a passing first entry.
    const matching = o.federatedIdentities.filter((i) => i.platform === platform);
    if (matching.length !== 1) {
      failures.push(
        `identity: expected exactly one ${platform} workload-identity result, found ${matching.length}`,
      );
    }
  }
  for (const identity of o.federatedIdentities) {
    if (!(RELEASE_PLATFORMS as readonly string[]).includes(identity.platform)) {
      failures.push(`identity: unknown platform '${identity.platform}'`);
      continue;
    }
    if (!identity.tokenAcquired) failures.push(`identity: ${identity.platform} did not acquire an ARM token`);
    if (!identity.secretless) {
      failures.push(`identity: ${identity.platform} did not authenticate secretlessly (WIF)`);
    }
  }

  // Each required operation must be negatively tested exactly once, and removing
  // it must fail ONLY its own call — otherwise the role's blast radius is unknown.
  for (const op of REQUIRED_OPERATIONS) {
    const cases = o.negativeCases.filter((c) => c.removedOperation === op);
    if (cases.length !== 1) {
      failures.push(`negative case: expected exactly one removal test for '${op}', found ${cases.length}`);
      continue;
    }
    const [negative] = cases;
    if (canonicalize(sorted(negative!.failedOperations)) !== canonicalize([op])) {
      failures.push(
        `negative case '${op}': expected only that operation to fail, observed [${negative!.failedOperations.join(', ')}]`,
      );
    }
    const expectedSucceeded = sorted(REQUIRED_OPERATIONS.filter((other) => other !== op));
    if (canonicalize(sorted(negative!.succeededOperations)) !== canonicalize(expectedSucceeded)) {
      failures.push(
        `negative case '${op}': the other four operations must still succeed, observed [${negative!.succeededOperations.join(', ')}]`,
      );
    }
  }
  for (const negative of o.negativeCases) {
    if (!REQUIRED_OPERATIONS.includes(negative.removedOperation)) {
      failures.push(`negative case: '${negative.removedOperation}' is not one of the invoked operations`);
    }
  }

  for (const op of OPERATIONS_PROVEN_NOT_REQUIRED) {
    if (!o.operationsProvenNotRequired.includes(op)) {
      failures.push(`least privilege: '${op}' was not proven unnecessary`);
    }
  }

  return result('RV2', failures);
}

/** RV3 — cancellation operational bounds and idempotency. */
export function evaluateRv3(o: Rv3Observations): CheckResult {
  const failures: string[] = [];

  if (!Number.isFinite(o.cancelToCanceledSeconds) || o.cancelToCanceledSeconds <= 0) {
    failures.push('cancellation: a positive measured cancel-to-Canceled duration is required');
  } else if (o.cancelToCanceledSeconds > CLEANUP_TIMEOUT_SECONDS) {
    failures.push(
      `cancellation: ${o.cancelToCanceledSeconds}s exceeds the ${CLEANUP_TIMEOUT_SECONDS}s cleanup deadline`,
    );
  }
  if (!o.duplicateCancelAccepted) {
    failures.push('cancellation: two rapid cancel requests were not both accepted');
  }
  // A duplicate cancel must leave the run on the cancellation path, not flip it
  // to another terminal state.
  if (!['Canceling', 'Canceled'].includes(o.duplicateCancelTerminalState)) {
    failures.push(
      `cancellation: after a duplicate cancel the run was '${o.duplicateCancelTerminalState}', not Canceling/Canceled`,
    );
  }
  if (!o.cancelOnTerminalRunAccepted) {
    failures.push('cancellation: canceling an already terminal run was not a safe accepted no-op');
  }
  if (!o.cleanupFailurePreservesOriginalFailure) {
    failures.push('cancellation: a cleanup failure did not preserve the original pipeline failure');
  }

  return result('RV3', failures);
}

function evaluateCheck(check: RvCheck, providerOpNames: ReadonlySet<string>): CheckResult {
  switch (check.id) {
    case 'RV1':
      return evaluateRv1(check.observations as Rv1Observations);
    case 'RV2':
      return evaluateRv2(check.observations as Rv2Observations, providerOpNames);
    case 'RV3':
      return evaluateRv3(check.observations as Rv3Observations);
    default:
      return { id: check.id, pass: false, failures: [`unknown check id '${check.id}'`] };
  }
}

// ---------------------------------------------------------------------------
// Receipt validation — the release gate.
// ---------------------------------------------------------------------------

/**
 * Validate a receipt. FAILS CLOSED: anything unrecognized, unproven, stale,
 * internally inconsistent, or merely asserted (a declared `passed` whose
 * observations do not evaluate to a pass) makes `ok` false.
 */
export function validateReceipt(
  receipt: Receipt,
  options: ReceiptValidationOptions,
): ReceiptValidationResult {
  const failures: string[] = [];
  const checks: CheckResult[] = [];

  if (receipt.kind !== RECEIPT_KIND) {
    failures.push(`kind: expected '${RECEIPT_KIND}', found '${receipt.kind}'`);
  }
  if (receipt.schemaVersion !== RECEIPT_SCHEMA_VERSION) {
    failures.push(`schemaVersion: expected ${RECEIPT_SCHEMA_VERSION}, found ${receipt.schemaVersion}`);
  }
  if (receipt.template !== false) {
    failures.push('template: a receipt template is not evidence; run RV1–RV3 and emit a real receipt');
  }
  if (receipt.apiVersion !== API_VERSION) {
    failures.push(`apiVersion: expected the pinned '${API_VERSION}', found '${receipt.apiVersion}'`);
  }
  if (!COMMIT_SHA.test(receipt.coreCommit ?? '')) {
    failures.push('coreCommit: a full 40-character commit SHA is required');
  }
  if (options.expectedCoreCommit && receipt.coreCommit !== options.expectedCoreCommit) {
    failures.push(
      `coreCommit: receipt is bound to '${receipt.coreCommit}', expected core commit '${options.expectedCoreCommit}'`,
    );
  }

  if (receipt.environment?.cloud !== SUPPORTED_CLOUD) {
    failures.push(`environment: v1 validates '${SUPPORTED_CLOUD}' only, found '${receipt.environment?.cloud}'`);
  }
  if (typeof receipt.environment?.region !== 'string' || receipt.environment.region.trim() === '') {
    failures.push('environment: the target region must be recorded');
  }
  // A published receipt carries a hash of the workspace resource ID, never the
  // raw ID — it still proves every check ran against one workspace.
  if (!SHA256_HEX.test(receipt.environment?.workspaceScopeHash ?? '')) {
    failures.push('environment: workspaceScopeHash must be a sha256 hex digest of the workspace resource ID');
  }

  const now = options.now ?? Date.now();
  let generatedAtMs: number | undefined;
  if (!isIsoInstant(receipt.generatedAt)) {
    failures.push('generatedAt: an ISO-8601 instant is required');
  } else {
    generatedAtMs = Date.parse(receipt.generatedAt);
    // A post-dated receipt would otherwise defeat the staleness bound forever, so
    // a future stamp is a failure rather than a very "fresh" receipt.
    if (generatedAtMs > now + CLOCK_SKEW_MS) {
      failures.push(`generatedAt: '${receipt.generatedAt}' is in the future; a receipt cannot be post-dated`);
    }
    if (options.maxAgeDays !== undefined) {
      const ageDays = (now - generatedAtMs) / 86_400_000;
      if (ageDays > options.maxAgeDays) {
        failures.push(
          `generatedAt: receipt is older than ${options.maxAgeDays} days (${ageDays.toFixed(1)}d); re-run RV1–RV3`,
        );
      }
    }
  }

  // One core commit produces both marketplace artifacts (D16).
  const artifacts = receipt.artifacts ?? [];
  for (const platform of RELEASE_PLATFORMS) {
    const matching = artifacts.filter((a) => a.platform === platform);
    if (matching.length !== 1) {
      failures.push(`artifacts: expected exactly one '${platform}' build, found ${matching.length}`);
      continue;
    }
    const [artifact] = matching;
    if (typeof artifact!.build !== 'string' || artifact!.build.trim() === '') {
      failures.push(`artifacts: the '${platform}' build identifier is missing`);
    }
    if (artifact!.coreCommit !== receipt.coreCommit) {
      failures.push(
        `artifacts: '${platform}' was built from coreCommit '${artifact!.coreCommit}', not the receipt's '${receipt.coreCommit}'`,
      );
    }
  }

  const seen = new Set<string>();
  for (const check of receipt.checks ?? []) {
    if (!(RV_CHECK_IDS as readonly string[]).includes(check.id)) {
      failures.push(`checks: unknown check '${check.id}'`);
      continue;
    }
    if (seen.has(check.id)) {
      failures.push(`checks: duplicate entry for '${check.id}'`);
      continue;
    }
    seen.add(check.id);

    if (!isIsoInstant(check.observedAt)) {
      failures.push(`${check.id}: observedAt must be an ISO-8601 instant`);
    } else {
      // The OBSERVATIONS are the perishable evidence — bounding only `generatedAt`
      // would let a year-old transcript be repackaged as a fresh receipt.
      const observedMs = Date.parse(check.observedAt);
      if (observedMs > now + CLOCK_SKEW_MS) {
        failures.push(`${check.id}: observedAt '${check.observedAt}' is in the future`);
      }
      if (generatedAtMs !== undefined && observedMs > generatedAtMs + CLOCK_SKEW_MS) {
        failures.push(
          `${check.id}: observedAt '${check.observedAt}' is after the receipt's generatedAt '${receipt.generatedAt}'`,
        );
      }
      if (options.maxAgeDays !== undefined) {
        const ageDays = (now - observedMs) / 86_400_000;
        if (ageDays > options.maxAgeDays) {
          failures.push(
            `${check.id}: observed ${ageDays.toFixed(1)} days ago, older than the ${options.maxAgeDays}-day bound; re-run RV1–RV3`,
          );
        }
      }
    }
    if (check.status !== 'passed') {
      failures.push(`${check.id}: status is '${check.status}', not 'passed'`);
    }

    const evaluated = evaluateCheck(check, options.providerOpNames);
    checks.push(evaluated);
    for (const failure of evaluated.failures) failures.push(`${check.id}: ${failure}`);

    // The whole receipt describes ONE validation session in ONE environment, so
    // RV1's observed region must be the region the receipt declares. Checking each
    // only for non-emptiness would let a transcript from another region be pasted in.
    if (check.id === 'RV1') {
      const observedRegion = (check.observations as Rv1Observations).region;
      if (observedRegion !== receipt.environment?.region) {
        failures.push(
          `RV1: observed region '${observedRegion}' is not the receipt's environment region '${receipt.environment?.region}'`,
        );
      }
    }
  }
  for (const id of RV_CHECK_IDS) {
    if (!seen.has(id)) failures.push(`checks: '${id}' is missing — all three must pass before release`);
  }

  // The digest is MANDATORY. It does not make a receipt unforgeable (see the trust
  // boundary in docs/runbooks/release-validation.md — a receipt is operator-produced
  // evidence whose authority comes from committed, reviewed history), but it does
  // mean the committed bytes cannot be edited after stamping without detection, and
  // it gives the release notes a stable identifier for the exact evidence used.
  if (receipt.digest === undefined) {
    failures.push("digest: the receipt is unstamped; run `rv-receipt.mjs stamp` and commit the result");
  } else if (receipt.digest !== receiptDigest(receipt)) {
    failures.push('digest: the stamped digest does not match the receipt body (tampered or edited after signing)');
  }

  return { ok: failures.length === 0, failures, checks };
}
