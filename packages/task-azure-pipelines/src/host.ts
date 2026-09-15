/**
 * host.ts (E4-T1/T2) — the ONLY module that imports `azure-pipelines-task-lib`.
 * It adapts the real Azure Pipelines task library to the platform-free
 * {@link TaskHost} interface the rest of the adapter is written against, so the
 * deterministic adapter tests never load the task library. It also reads the ARM
 * service-connection (workload-identity federation) details and returns the
 * pieces {@link file://./auth.ts} needs to build a `ClientAssertionCredential`:
 * the tenant/client IDs and an assertion callback that mints the Azure DevOps
 * OIDC token for the federated exchange (WIF — no long-lived secret, NFR3).
 */

import * as tl from 'azure-pipelines-task-lib/task.js';
import type { TaskHost } from './adapter.ts';
import type { ArmServiceConnection } from './auth.ts';
import { fetchOidcToken } from './oidc.ts';

/** The real Azure Pipelines host backed by `azure-pipelines-task-lib`. */
export function azurePipelinesTaskHost(): TaskHost {
  return {
    getInput: (name) => tl.getInput(name),
    setVariable: (name, value, isOutput) => tl.setVariable(name, value, false, isOutput),
    setResult: (success, message) =>
      tl.setResult(success ? tl.TaskResult.Succeeded : tl.TaskResult.Failed, message, true),
    // task-lib has no dedicated info channel; a normal stdout line is the task's
    // informational log (debug is gated behind system.debug).
    info: (message) => console.log(message),
    warning: (message) => tl.warning(message),
    error: (message) => tl.error(message),
    setSecret: (secret) => tl.setSecret(secret),
  };
}

/** Missing-variable guard producing an actionable, secretless error. */
function requireVar(name: string): string {
  const v = tl.getVariable(name);
  if (v === undefined || v === '') {
    throw new Error(`required pipeline variable '${name}' is not available; run this task inside an Azure Pipelines job`);
  }
  return v;
}

/**
 * Read the ARM service-connection (`azureSubscription` input) and return the
 * workload-identity-federation parameters plus an assertion callback. The
 * callback mints a short-lived Azure DevOps OIDC token bound to this
 * job + service connection; `@azure/identity`'s `ClientAssertionCredential`
 * presents it to Entra ID to obtain an ARM access token. There is NO long-lived
 * client secret anywhere in the flow (NFR3).
 */
export function readArmServiceConnection(): ArmServiceConnection {
  const connectionId = tl.getInput('azureSubscription', true);
  if (connectionId === undefined || connectionId === '') {
    throw new Error("required input 'azureSubscription' (ARM service connection) is not set");
  }

  const scheme = tl.getEndpointAuthorizationScheme(connectionId, false);
  if (scheme !== 'WorkloadIdentityFederation') {
    throw new Error(
      `the '${connectionId}' service connection uses auth scheme '${String(scheme)}'; this task requires a ` +
        'workload-identity-federation (WIF) ARM service connection so there is no long-lived secret (NFR3)',
    );
  }

  const clientId = tl.getEndpointAuthorizationParameterRequired(connectionId, 'serviceprincipalid');
  // Tenant id is exposed as an authorization parameter on WIF connections.
  const tenantId = tl.getEndpointAuthorizationParameterRequired(connectionId, 'tenantid');

  return {
    tenantId,
    clientId,
    getAssertion: () => fetchAzureDevOpsOidcToken(connectionId),
  };
}

/**
 * Mint the Azure DevOps federated OIDC token for `connectionId` from the running
 * job, using the job's OAuth token. This is the client assertion that
 * `ClientAssertionCredential` exchanges with Entra ID (WIF). It reads the pipeline
 * variables here (task-lib) and delegates the bounded HTTP exchange to
 * {@link fetchOidcToken} (task-lib-free, absolute-deadline). Runtime-only: it is
 * exercised by the guarded live WIF integration test, not the deterministic unit
 * tests (which inject a fake credential and never construct the real one).
 *
 * The job's OAuth credential is obtained from the built-in `SYSTEMVSSCONNECTION`
 * service endpoint (`scheme: OAuth`, `parameters.AccessToken`), the same
 * mechanism Microsoft's own built-in tasks use (e.g. `AzureRmWebAppDeployment`,
 * `Microsoft.TeamFoundation.DistributedTask.Tasks.*` OAuth token retrieval). A
 * normal custom-task job does NOT automatically map `System.AccessToken` as a
 * pipeline variable — that requires an explicit
 * `env: { SYSTEM_ACCESSTOKEN: $(System.AccessToken) }` the pipeline author would
 * have to opt into — so reading it via `System.AccessToken` directly would fail
 * on an unmodified pipeline. `SYSTEMVSSCONNECTION` is always present without any
 * such opt-in.
 */
async function fetchAzureDevOpsOidcToken(connectionId: string): Promise<string> {
  const accessToken = readSystemAccessToken();

  // Azure DevOps exposes the exact OIDC token endpoint for this job as
  // `System.OidcRequestUri`; prefer it over reconstructing the URL from the hub
  // name, because `System.HostType` values (release/deployment/gates) are NOT the
  // REST hub segment and the reconstruction would target the wrong endpoint.
  const oidcRequestUri = tl.getVariable('System.OidcRequestUri');
  const url =
    oidcRequestUri !== undefined && oidcRequestUri !== ''
      ? new URL(oidcRequestUri)
      : reconstructOidcUri();
  // Bind the request to this service connection and pin the API version.
  url.searchParams.set('serviceConnectionId', connectionId);
  url.searchParams.set('api-version', '7.1-preview.1');

  return fetchOidcToken(url, accessToken);
}

/**
 * Read the job's OAuth access token from the built-in `SYSTEMVSSCONNECTION`
 * service endpoint, mask it, and validate its authorization scheme is `OAuth`
 * before returning it — following the pattern Microsoft's built-in tasks use to
 * obtain the job token, rather than requiring the pipeline author to map
 * `System.AccessToken` explicitly.
 */
function readSystemAccessToken(): string {
  const auth = tl.getEndpointAuthorization('SYSTEMVSSCONNECTION', false);
  if (auth === undefined) {
    throw new Error(
      "the built-in 'SYSTEMVSSCONNECTION' service endpoint is not available; run this task inside an Azure Pipelines job",
    );
  }
  if (auth.scheme !== 'OAuth') {
    throw new Error(
      `the built-in 'SYSTEMVSSCONNECTION' service endpoint uses auth scheme '${auth.scheme}'; expected 'OAuth'`,
    );
  }
  const accessToken = auth.parameters['AccessToken'];
  if (accessToken === undefined || accessToken === '') {
    throw new Error(
      "the 'SYSTEMVSSCONNECTION' service endpoint has no 'AccessToken' parameter; enable OAuth token access for this pipeline job",
    );
  }
  tl.setSecret(accessToken);
  return accessToken;
}

/**
 * Fallback OIDC endpoint when `System.OidcRequestUri` is not present: build it
 * from the job's collection/plan/job coordinates. `System.HostType` is used only
 * as the REST hub segment here; when the newer `System.OidcRequestUri` variable is
 * available (current agents) it is preferred and this is not reached.
 */
function reconstructOidcUri(): URL {
  const collectionUri = requireVar('System.CollectionUri');
  const projectId = requireVar('System.TeamProjectId');
  const hub = requireVar('System.HostType');
  const planId = requireVar('System.PlanId');
  const jobId = requireVar('System.JobId');
  const base = collectionUri.endsWith('/') ? collectionUri : `${collectionUri}/`;
  return new URL(
    `${base}${projectId}/_apis/distributedtask/hubs/${hub}/plans/${planId}/jobs/${jobId}/oidctoken`,
  );
}
