/**
 * contract.ts — the canonical typed contract for the Azure Chaos Studio v2
 * CI/CD integrations. This is the only surface the platform adapters touch.
 *
 * Scope (E1): types + source-proven constants only. No orchestration logic,
 * no I/O, and no platform-SDK imports. The state machines, HTTP client, and
 * orchestrator that consume these types are implemented in later epics (E2+).
 *
 * Every value here is grounded in the current `Microsoft.Chaos`
 * `2026-05-01-preview` generated GW models, BE mappings, and the generated
 * provider-operation snapshot. The verified findings (VF#) and source-resolved
 * contract corrections (DX#) referenced below are defined in the plan.
 */

// ---------------------------------------------------------------------------
// API pin (D5, VF14)
// ---------------------------------------------------------------------------

/** The single API version this release pins. There is no `api-version` input. */
export const API_VERSION = '2026-05-01-preview';

// ---------------------------------------------------------------------------
// Mode (D1) — one closed enum; unknown/unset fails closed (FR16).
// ---------------------------------------------------------------------------

export const MODES = ['validate-and-execute', 'validate-only', 'execute-only'] as const;
export type Mode = (typeof MODES)[number];
export const DEFAULT_MODE: Mode = 'validate-and-execute';

// ---------------------------------------------------------------------------
// Canonical inputs. Names and semantics are identical across adapters (NFR5);
// only platform-native labels/metadata may differ.
// ---------------------------------------------------------------------------

export interface Inputs {
  subscriptionId: string;
  resourceGroup: string;
  workspaceName: string;
  scenarioName: string;
  scenarioConfigurationName: string;
  mode: Mode;
  waitForCompletion: boolean;
  completionTimeoutSeconds: number;
  cancelOnTimeoutOrCancellation: boolean;
}

/** Canonical wire names for each input, shared by both adapters (NFR5). */
export const INPUT_NAMES = {
  subscriptionId: 'subscription-id',
  resourceGroup: 'resource-group',
  workspaceName: 'workspace-name',
  scenarioName: 'scenario-name',
  scenarioConfigurationName: 'scenario-configuration-name',
  mode: 'mode',
  waitForCompletion: 'wait-for-completion',
  completionTimeoutSeconds: 'completion-timeout-seconds',
  cancelOnTimeoutOrCancellation: 'cancel-on-timeout-or-cancellation',
} as const satisfies Record<keyof Inputs, string>;

/** Defaults for the optional inputs (Inputs table, D8/D10). */
export const INPUT_DEFAULTS = {
  mode: DEFAULT_MODE,
  waitForCompletion: true,
  completionTimeoutSeconds: 2700,
  cancelOnTimeoutOrCancellation: true,
} as const;

/** Fixed cleanup budget; not a public input in v1 (D10). */
export const CLEANUP_TIMEOUT_SECONDS = 300;

// ---------------------------------------------------------------------------
// Canonical outputs (D11). Stable scalars only; structured error bodies stay
// in redacted logs, never in scalar outputs (FR13).
// ---------------------------------------------------------------------------

export const OUTPUT_NAMES = [
  'validation-state',
  'run-id',
  'run-resource-id',
  'run-state',
  'started-at',
  'completed-at',
  'correlation-id',
  'request-id',
] as const;
export type OutputName = (typeof OUTPUT_NAMES)[number];

// ---------------------------------------------------------------------------
// Validation state machine surface (VF2, VF3).
// ---------------------------------------------------------------------------

export const VALIDATION_STATES = [
  'Resolving',
  'Generating',
  'Validating',
  'Accepted',
  'NotStarted',
  'RequiresAttention',
  'NoResolvedResources',
  'Succeeded',
] as const;
export type ValidationState = (typeof VALIDATION_STATES)[number];

/** `Succeeded` is the only terminal success (VF3). */
export const VALIDATION_TERMINAL_SUCCESS = ['Succeeded'] as const satisfies readonly ValidationState[];
/** `RequiresAttention` and `NoResolvedResources` are terminal failures (VF3). */
export const VALIDATION_TERMINAL_FAILURE = [
  'RequiresAttention',
  'NoResolvedResources',
] as const satisfies readonly ValidationState[];

// ---------------------------------------------------------------------------
// Run state machine surface (VF6, VF7).
// ---------------------------------------------------------------------------

export const RUN_STATES = [
  'Queued',
  'Resolving',
  'Generating',
  'Validating',
  'ValidationSucceeded',
  'Starting',
  'Preparing',
  'Running',
  'CleaningUp',
  'Canceling',
  'Canceled',
  'Succeeded',
  'Failed',
] as const;
export type RunState = (typeof RUN_STATES)[number];

/** For execution-mode runs, `Succeeded` is terminal success (VF7). */
export const RUN_TERMINAL_SUCCESS = ['Succeeded'] as const satisfies readonly RunState[];
/** `Failed` and `Canceled` are terminal failures for execution-mode runs (VF7). */
export const RUN_TERMINAL_FAILURE = ['Failed', 'Canceled'] as const satisfies readonly RunState[];

// ---------------------------------------------------------------------------
// Wire-shape corrections (DX2). The current generated models use
// `properties.status`, `startTime`/`endTime`, and two error channels each:
// `errors` + `validationErrors` for validation; `errors` + `executionErrors`
// for runs. The older OpenAPI snapshot's `state`/single-channel shape is stale.
// ---------------------------------------------------------------------------

/** The status field lives at `properties.status` (DX2), not `properties.state`. */
export const STATUS_FIELD = 'status';
export const START_TIME_FIELD = 'startTime';
export const END_TIME_FIELD = 'endTime';

/** Validation exposes system (`errors`) and business (`validationErrors`) channels (VF2, VF10). */
export const VALIDATION_ERROR_CHANNELS = ['errors', 'validationErrors'] as const;
/** Runs expose system (`errors`) and business (`executionErrors`) channels (VF6, VF10). */
export const RUN_ERROR_CHANNELS = ['errors', 'executionErrors'] as const;

// ---------------------------------------------------------------------------
// Long-running-operation / acceptance contract (VF1, VF5, VF8).
// All three actions return an external 202 with a direct-resource `Location`
// and a default `Retry-After: 10`. There is no separate operation-status
// resource to discover first (DX3, VF12).
// ---------------------------------------------------------------------------

/** GW currently defaults `Retry-After` to 10 seconds for validate/execute/cancel (VF1, VF5, VF8). */
export const DEFAULT_RETRY_AFTER_SECONDS = 10;

/**
 * The execute 202 `Location` is the full run resource ID; the run GUID is the
 * final `/runs/{runId}` segment (DX3, VF5). This is the canonical GUID shape
 * the core validates before it trusts a run Location.
 */
export const GUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

// ---------------------------------------------------------------------------
// Generated provider operations (DX1, VF12). These are the exact five
// `Microsoft.Chaos` operations the adapters invoke. The generated snapshot
// proves the correct execute permission is `configurations/execute/action`;
// `Microsoft.Chaos/workspaces/scenarios/run/action` does not exist.
// ---------------------------------------------------------------------------

export const PROVIDER_OPERATIONS = {
  validate: 'Microsoft.Chaos/workspaces/scenarios/configurations/validate/action',
  validationRead: 'Microsoft.Chaos/workspaces/scenarios/configurations/validations/read',
  execute: 'Microsoft.Chaos/workspaces/scenarios/configurations/execute/action',
  runRead: 'Microsoft.Chaos/workspaces/scenarios/runs/read',
  runCancel: 'Microsoft.Chaos/workspaces/scenarios/runs/cancel/action',
} as const;
export type ProviderOperation = (typeof PROVIDER_OPERATIONS)[keyof typeof PROVIDER_OPERATIONS];

// ---------------------------------------------------------------------------
// Adapter boundary (the only surface the adapters implement). The core imports
// neither `@actions/core` nor `azure-pipelines-task-lib`; the adapters inject
// these interfaces. Modeled on the verified Azure Bicep Deploy boundary (D3).
// ---------------------------------------------------------------------------

export interface IInputReader {
  get(name: string): string | undefined;
  getRequired(name: string): string;
  getBool(name: string, dflt: boolean): boolean;
  getInt(name: string, dflt: number): number;
}

export interface IOutputSetter {
  set(name: string, value: string): void;
}

export interface ILogger {
  info(m: string): void;
  warning(m: string): void;
  error(m: string): void;
  mask(secret: string): void;
}

/** The portability seam (D7): the adapter supplies the ARM token source. */
export interface ICredentialProvider {
  getArmToken(scope: string, signal: AbortSignal): Promise<string>;
}

export interface IClock {
  now(): number;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
}

// ---------------------------------------------------------------------------
// Orchestration result + entry-point signature. The implementation of `run`
// lives in the orchestrator (E2); this contract exposes only its type.
// ---------------------------------------------------------------------------

export interface OrchestrationResult {
  success: boolean;
  outputs: Record<string, string>;
  failureReason?: string;
}

export interface RunContext {
  input: IInputReader;
  output: IOutputSetter;
  log: ILogger;
  cred: ICredentialProvider;
  clock: IClock;
  signal: AbortSignal;
}

export type RunFn = (io: RunContext) => Promise<OrchestrationResult>;

// ---------------------------------------------------------------------------
// Normalized error model. The core collapses every failure into this shape
// before an adapter maps it to a step result. Business-error detail from
// `validationErrors`/`executionErrors` is logged (redacted), not emitted as a
// scalar output (FR13). ARM `error.code` is preserved because it is
// customer-actionable (VF10).
// ---------------------------------------------------------------------------

export const ERROR_CATEGORIES = [
  'auth',
  'identifier',
  'transport',
  'validation-failed',
  'run-failed',
  'timeout',
  'ambiguous-acceptance',
] as const;
export type ErrorCategory = (typeof ERROR_CATEGORIES)[number];

export interface NormalizedError {
  category: ErrorCategory;
  armErrorCode?: string;
  message: string;
  correlationId?: string;
  requestId?: string;
}
