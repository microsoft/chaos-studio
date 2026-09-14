/**
 * RV2 role-template validator (E5-T3). A PURE, deterministic validator that
 * checks an Azure custom-role definition against the source-proven Microsoft.Chaos
 * operation contract: the role must grant EXACTLY the operations the integration
 * invokes (least privilege), every granted operation must exist in the generated
 * provider-operation snapshot (no invented strings), and it must grant no data
 * actions. Not a `*.test.ts` file, so the runner treats it as a helper.
 *
 * It accepts BOTH role-definition shapes: the flat Azure CLI shape
 * (`{ Actions, DataActions, ... }` used by `az role definition create`) and the
 * ARM/REST shape (`{ properties: { permissions: [{ actions, dataActions }] } }`).
 */

export interface RoleDefinition {
  Actions?: string[];
  NotActions?: string[];
  DataActions?: string[];
  properties?: {
    permissions?: Array<{
      actions?: string[];
      notActions?: string[];
      dataActions?: string[];
      notDataActions?: string[];
    }>;
  };
}

export interface RoleValidationResult {
  ok: boolean;
  /** Required operations the role fails to grant. */
  missing: string[];
  /** Granted operations beyond the required set (least-privilege violations). */
  extraneous: string[];
  /** Granted operations that do not exist in the provider snapshot (invented). */
  unknown: string[];
  /** Data actions granted (must always be empty for this control-plane role). */
  dataActions: string[];
  /** NotActions granted (must be empty — a NotActions would subtract an Action Azure grants). */
  notActions: string[];
}

/** Flatten every granted action across both role-definition shapes. */
export function grantedActions(role: RoleDefinition): string[] {
  const flat = role.Actions ?? [];
  const arm = (role.properties?.permissions ?? []).flatMap((p) => p.actions ?? []);
  return [...flat, ...arm];
}

/** Flatten every granted data action across both role-definition shapes. */
export function grantedDataActions(role: RoleDefinition): string[] {
  const flat = role.DataActions ?? [];
  const arm = (role.properties?.permissions ?? []).flatMap((p) => p.dataActions ?? []);
  return [...flat, ...arm];
}

/** Flatten every NotActions entry across both role-definition shapes. */
export function grantedNotActions(role: RoleDefinition): string[] {
  const flat = role.NotActions ?? [];
  const arm = (role.properties?.permissions ?? []).flatMap((p) => p.notActions ?? []);
  return [...flat, ...arm];
}

/**
 * Validate a role definition. It FAILS CLOSED: any missing required operation,
 * any operation outside the required set, any operation absent from the provider
 * snapshot, any data action, or any NotActions subtraction makes `ok` false.
 *
 * @param role            the candidate role definition
 * @param requiredOps     the exact operations the integration invokes (PROVIDER_OPERATIONS)
 * @param providerOpNames the full set of operation names from the generated snapshot
 */
export function validateRunnerRole(
  role: RoleDefinition,
  requiredOps: readonly string[],
  providerOpNames: ReadonlySet<string>,
): RoleValidationResult {
  const granted = grantedActions(role);
  const grantedSet = new Set(granted);
  const requiredSet = new Set(requiredOps);

  const missing = [...requiredSet].filter((op) => !grantedSet.has(op)).sort();
  const extraneous = [...grantedSet].filter((op) => !requiredSet.has(op)).sort();
  const unknown = [...grantedSet].filter((op) => !providerOpNames.has(op)).sort();
  const dataActions = grantedDataActions(role).sort();
  // A NotActions entry SUBTRACTS a permission Azure would otherwise grant, so a
  // role that lists all five Actions but excludes one via NotActions is effectively
  // missing it. The least-privilege runner role must carry NO NotActions.
  const notActions = grantedNotActions(role).sort();

  return {
    ok:
      missing.length === 0 &&
      extraneous.length === 0 &&
      unknown.length === 0 &&
      dataActions.length === 0 &&
      notActions.length === 0,
    missing,
    extraneous,
    unknown,
    dataActions,
    notActions,
  };
}
