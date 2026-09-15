#!/usr/bin/env node
// rv2-invoke.mjs — the RV2 single-operation invocation CLI (E6 review R2).
//
// RV2 (packages/core/src/contract.ts PROVIDER_OPERATIONS) requires, for EACH of
// the 5 provider operations, an ISOLATED negative case: remove only that
// operation from the role, then invoke each of the 5 operations independently
// against pre-provisioned resources and confirm exactly the removed one fails.
// The core's own entry point (`run`) only ever drives the ORCHESTRATED
// `validate-and-execute`/`validate-only`/`execute-only` MODES, which
// short-circuit on the first failure and never reach `execute`/`runCancel` on
// their own — "re-run the journey" therefore cannot exercise the later
// operations once an earlier one is removed. This CLI is the executable
// operator procedure that closes that gap: it invokes exactly ONE named
// provider operation, once, using the SAME `ArmHttpClient` (and therefore the
// same `onObservation`/`RV-OBSERVATION` capture path, url builders, and
// acceptance/status classification) both adapters already use — it adds no
// new provider-operation coverage or public generic-ARM capability, only a
// single-call driver over the existing private core.
//
// Usage:
//   node scripts/lib/rv2-invoke.mjs <operation> --subscription-id <id> \
//     --resource-group <rg> --workspace-name <ws> --scenario-name <scn> \
//     --scenario-configuration-name <cfg> [--run-id <guid>]
//
// <operation> is one of: validate, validationRead, execute, runRead, runCancel
// (the keys of PROVIDER_OPERATIONS). `--run-id` is required for runRead/runCancel
// (the run must already exist — pre-provisioned by a prior independent `execute`
// invocation of this same CLI).
//
// Authentication is via AzureCliCredential (the same secretless mechanism the
// GitHub Action adapter uses) — run `az login` (or rely on the CI identity's
// federated session) before invoking this script.
//
// Output: one `RV-OBSERVATION {...}` line (packages/core/src/http.ts
// `formatProtocolObservation`) for the single call made, plus a final
// `RV2-INVOKE-RESULT {...}` summary line reporting the HTTP status and whether
// it was treated as a provider-authorization failure (403/AuthorizationFailed)
// or a success/acceptance. Exit code is always 0 (a 403 is an EXPECTED result
// for the negative case, not a script failure) unless the invocation itself
// could not be attempted (bad arguments, credential failure): those exit 2.
import { AzureCliCredential } from '@azure/identity';

import { ArmHttpClient, fetchTransport, formatProtocolObservation } from '../../packages/core/src/http.ts';
import {
  configurationResourceId,
  runResourceId,
  validateActionUrl,
  validationsLatestUrl,
  executeActionUrl,
  runResourceUrl,
  cancelActionUrl,
  validateScenarioCoordinates,
} from '../../packages/core/src/ids.ts';

const OPERATIONS = ['validate', 'validationRead', 'execute', 'runRead', 'runCancel'];

function usage(message) {
  if (message) console.error(`::error::rv2-invoke: ${message}`);
  console.error(
    '::error::rv2-invoke: usage: rv2-invoke.mjs <validate|validationRead|execute|runRead|runCancel> ' +
      '--subscription-id <id> --resource-group <rg> --workspace-name <ws> --scenario-name <scn> ' +
      '--scenario-configuration-name <cfg> [--run-id <guid>]',
  );
  process.exit(2);
}

function parseArgs(argv) {
  const [operation, ...rest] = argv;
  if (!operation || !OPERATIONS.includes(operation)) {
    usage(`operation must be one of ${OPERATIONS.join(', ')}, got '${operation ?? ''}'.`);
  }
  const out = { operation };
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i];
    const value = rest[i + 1];
    if (!key?.startsWith('--') || value === undefined) usage(`malformed argument '${key ?? ''}'.`);
    out[key.slice(2)] = value;
  }
  const required = ['subscription-id', 'resource-group', 'workspace-name', 'scenario-name', 'scenario-configuration-name'];
  for (const r of required) {
    if (!out[r]) usage(`--${r} is required.`);
  }
  if ((operation === 'runRead' || operation === 'runCancel') && !out['run-id']) {
    usage(`--run-id is required for '${operation}' (a run must already be pre-provisioned).`);
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const coords = validateScenarioCoordinates({
    subscriptionId: args['subscription-id'],
    resourceGroup: args['resource-group'],
    workspaceName: args['workspace-name'],
    scenarioName: args['scenario-name'],
    scenarioConfigurationName: args['scenario-configuration-name'],
  });

  let credential;
  try {
    credential = new AzureCliCredential();
    // Fail fast if no session is available, rather than surfacing an opaque
    // failure deep inside the client.
    await credential.getToken('https://management.azure.com/.default');
  } catch (err) {
    console.error(`::error::rv2-invoke: could not acquire an ARM token via AzureCliCredential (${String(err && err.message)}).`);
    process.exit(2);
  }

  const cred = {
    async getArmToken(scope, signal) {
      const token = await credential.getToken(scope, { abortSignal: signal });
      if (!token?.token) throw new Error('AzureCliCredential returned no access token.');
      return token.token;
    },
  };

  let observation;
  const client = new ArmHttpClient({
    transport: fetchTransport,
    clock: { now: () => Date.now(), sleep: (ms, signal) => new Promise((r, j) => {
      const t = setTimeout(r, ms);
      signal.addEventListener('abort', () => { clearTimeout(t); j(new Error('aborted')); }, { once: true });
    }) },
    log: { info: () => {}, warning: (m) => console.error(m), error: (m) => console.error(m), mask: () => {} },
    cred,
    signal: new AbortController().signal,
    onObservation: (obs) => {
      observation = obs;
      console.log(formatProtocolObservation(obs));
    },
  });

  let res;
  switch (args.operation) {
    case 'validate':
      res = await client.post(validateActionUrl(coords));
      break;
    case 'validationRead':
      res = await client.getOnce(validationsLatestUrl(coords));
      break;
    case 'execute':
      res = await client.post(executeActionUrl(coords));
      break;
    case 'runRead':
      res = await client.getOnce(runResourceUrl(runResourceId(coords, args['run-id'])));
      break;
    case 'runCancel':
      res = await client.post(cancelActionUrl(runResourceId(coords, args['run-id'])));
      break;
    default:
      usage(`unhandled operation '${args.operation}'.`);
  }

  const isAuthzFailure = res.status === 403 && observation?.errorCode === 'AuthorizationFailed';
  console.log(
    `RV2-INVOKE-RESULT ${JSON.stringify({
      operation: args.operation,
      status: res.status,
      errorCode: observation?.errorCode,
      authorizationFailure: isAuthzFailure,
    })}`,
  );
}

void main().catch((err) => {
  console.error(`::error::rv2-invoke: ${String(err && err.message)}`);
  process.exit(2);
});
