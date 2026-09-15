import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

// `readArmServiceConnection` loads the REAL `azure-pipelines-task-lib` — there is
// no fake host for it, it IS the module that adapts task-lib. Task-lib populates
// its internal vault from `process.env` exactly ONCE per process, on first
// import (`INPUT_*`, `ENDPOINT_AUTH_*` etc.), so each scenario below runs in its
// OWN child process (env vars set before the child starts) rather than
// re-importing the module in-process, where a cached vault from an earlier test
// would leak into later ones. Task-lib's vault also persists secrets to an
// on-disk `.taskkey` file keyed by `agent.TempDirectory`/cwd — each child gets
// its OWN scratch directory (via `agent.TempDirectory`) so concurrent test
// runs (`node --test` parallelizes files) never share/corrupt one `.taskkey`.

const HERE = dirname(fileURLToPath(import.meta.url));
const HOST_TS = pathToFileURL(join(HERE, '..', 'src', 'host.ts')).href;

/** Runs a small script (as `-e`) in a fresh child process with the given env,
 *  and returns the LAST non-empty stdout line — task-lib emits `##vso[...]`
 *  debug/logging lines to stdout too, so the driver script's own `OK:`/`ERR:`
 *  result line (always printed last) is the one that matters. */
function run(script: string, env: Record<string, string>): string {
  const scratch = mkdtempSync(join(tmpdir(), 'host-test-'));
  try {
    const res = spawnSync(process.execPath, ['-e', script], {
      env: { ...process.env, HOST_TS_PATH: HOST_TS, 'agent.TempDirectory': scratch, ...env },
      cwd: scratch,
      encoding: 'utf8',
    });
    assert.equal(res.error, undefined, `child process spawn failed: ${res.error}`);
    const lines = res.stdout.split(/\r?\n/).filter((l) => l.length > 0);
    return lines[lines.length - 1] ?? '';
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// Drives `readArmServiceConnection().getAssertion()` and prints either
// `OK:<assertion>` or `ERR:<message>` so the parent can assert without relying on
// child process exit codes (an unhandled rejection would otherwise just crash).
const DRIVE_ASSERTION_SCRIPT = `
import(process.env.HOST_TS_PATH).then(async ({ readArmServiceConnection }) => {
  try {
    const connection = readArmServiceConnection();
    const assertion = await connection.getAssertion();
    console.log('OK:' + assertion);
  } catch (e) {
    console.log('ERR:' + e.message);
  }
}).catch((e) => {
  console.log('ERR:' + e.message);
});
`;

// Drives just the synchronous `readArmServiceConnection()` composition (no
// network), for the non-WIF-scheme rejection which throws before any assertion
// callback is invoked.
const DRIVE_COMPOSE_SCRIPT = `
import(process.env.HOST_TS_PATH).then(({ readArmServiceConnection }) => {
  try {
    const connection = readArmServiceConnection();
    console.log('OK:' + connection.clientId);
  } catch (e) {
    console.log('ERR:' + e.message);
  }
}).catch((e) => {
  console.log('ERR:' + e.message);
});
`;

// Connection id deliberately has no hyphens: task-lib keys endpoint-auth env
// vars as \`ENDPOINT_AUTH_<SCHEME|PARAMETER>_<id>[...]\`, so the id must be a
// valid (hyphen-free) env-var name segment for these tests to name it directly.
const WIF_CONNECTION_ENV = {
  INPUT_AZURESUBSCRIPTION: 'theconnection',
  ENDPOINT_AUTH_SCHEME_theconnection: 'WorkloadIdentityFederation',
  ENDPOINT_AUTH_PARAMETER_theconnection_SERVICEPRINCIPALID: 'client-id-123',
  ENDPOINT_AUTH_PARAMETER_theconnection_TENANTID: 'tenant-id-456',
};

// R3: a normal custom-task job supplies the job's OAuth credential through the
// built-in `SYSTEMVSSCONNECTION` service endpoint — NOT through a
// `System.AccessToken` pipeline variable, which requires the pipeline author to
// explicitly map it via `env: { SYSTEM_ACCESSTOKEN: $(System.AccessToken) }`.
// This proves the host reads the OAuth token from `SYSTEMVSSCONNECTION`
// (task-lib's `getEndpointAuthorization`) and does NOT depend on
// `System.AccessToken` being present at all.
test('readArmServiceConnection composes a WIF connection and reads the job OAuth token from SYSTEMVSSCONNECTION, without a System.AccessToken variable', () => {
  const line = run(DRIVE_ASSERTION_SCRIPT, {
    ...WIF_CONNECTION_ENV,
    SYSTEM_OIDCREQUESTURI: 'https://vstoken.dev.azure.com/oidctoken',
    ENDPOINT_AUTH_SYSTEMVSSCONNECTION: JSON.stringify({
      scheme: 'OAuth',
      parameters: { AccessToken: 'job-oauth-token' },
    }),
    // Deliberately no SYSTEM_ACCESSTOKEN anywhere in the child's env.
  });
  assert.ok(line.startsWith('ERR:'), `expected the OIDC network call to fail (no live agent): ${line}`);
  // Reaching (and failing at) the network call — rather than failing on a
  // missing/invalid token — proves the token was read successfully from
  // SYSTEMVSSCONNECTION.
  assert.doesNotMatch(line, /AccessToken|SYSTEMVSSCONNECTION/);
});

test('readArmServiceConnection: a missing SYSTEMVSSCONNECTION endpoint fails the assertion with an actionable error', () => {
  const line = run(DRIVE_ASSERTION_SCRIPT, { ...WIF_CONNECTION_ENV });
  assert.match(line, /^ERR:.*SYSTEMVSSCONNECTION/);
});

test('readArmServiceConnection: a SYSTEMVSSCONNECTION with a non-OAuth scheme is rejected', () => {
  const line = run(DRIVE_ASSERTION_SCRIPT, {
    ...WIF_CONNECTION_ENV,
    ENDPOINT_AUTH_SYSTEMVSSCONNECTION: JSON.stringify({ scheme: 'UsernamePassword', parameters: {} }),
  });
  assert.match(line, /^ERR:.*OAuth/);
});

test('readArmServiceConnection: a SYSTEMVSSCONNECTION missing the AccessToken parameter is rejected', () => {
  const line = run(DRIVE_ASSERTION_SCRIPT, {
    ...WIF_CONNECTION_ENV,
    ENDPOINT_AUTH_SYSTEMVSSCONNECTION: JSON.stringify({ scheme: 'OAuth', parameters: {} }),
  });
  assert.match(line, /^ERR:.*AccessToken/);
});

test('readArmServiceConnection rejects a non-WIF service connection scheme', () => {
  const line = run(DRIVE_COMPOSE_SCRIPT, {
    INPUT_AZURESUBSCRIPTION: 'theconnection',
    ENDPOINT_AUTH_SCHEME_theconnection: 'ServicePrincipal',
  });
  assert.match(line, /^ERR:.*workload-identity-federation/);
});
