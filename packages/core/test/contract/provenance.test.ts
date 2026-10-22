import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import {
  API_VERSION,
  STATUS_FIELD,
  START_TIME_FIELD,
  END_TIME_FIELD,
  VALIDATION_STATES,
  RUN_STATES,
  VALIDATION_TERMINAL_SUCCESS,
  VALIDATION_TERMINAL_FAILURE,
  RUN_TERMINAL_SUCCESS,
  RUN_TERMINAL_FAILURE,
  VALIDATION_ERROR_CHANNELS,
  RUN_ERROR_CHANNELS,
  DEFAULT_RETRY_AFTER_SECONDS,
  GUID_PATTERN,
  PROVIDER_OPERATIONS,
} from '../../src/contract.ts';
import {
  readExtract,
  extractSha256 as computeExtractSha256,
  enumWireValues,
  serializedWireNames,
  operationNames as extractOperationNames,
  csharpMethodNames,
  csharpDirectMethodBody,
  csharpExtensionMethodBodies,
  httpStatusCodes,
  csharpReferencesIdentifier,
  csharpConditionalRequestHeaderArg,
  csharpConditionalRequestHeaderLiteral,
  csharpComposedConditionalRequestHeader,
  csharpReferencesHttp412,
  serializedFieldsByClass,
  channelElementModels,
  diBindings,
  csharpInjectedFields,
  csharpInvocation,
  csharpEnclosedInLocalFunctionOrLambda,
  csharpRegionHasBypassingControl,
  csharpLocalWriteIndices,
  csharpGuardedEarlyReturns,
  csharpFirstUnconditionalReturnAtDepth0,
  splitTopLevelArgs,
  csharpIntConst,
  stripCSharpNoise,
  commentStrippedCSharp,
} from './source-extracts.ts';
import type { SerializedField, WirePrimitive } from './source-extracts.ts';

// This test is an INDEPENDENT verifier of the committed provenance manifest and,
// crucially, of the fixtures' AUTHENTICITY. It does three distinct things:
//
//   1. Manifest integrity + tamper-evidence (REPRODUCIBLE): it re-derives the
//      fixture list, canonical content hashes, and fixture→source bindings from
//      disk and asserts the committed manifest matches. A fixture cannot change
//      without a reviewable manifest hash change, and cannot cite a
//      non-authoritative source.
//
//   2. Reviewed-source-extract authentication (REPRODUCIBLE): every generated
//      source carries a committed reviewed representative extract under
//      `source-extracts/` (a representation of the upstream artifact, not a
//      byte-for-byte copy). This test recomputes each extract's recorded hash
//      (in-repo tamper-evidence), then PARSES the extract and asserts that BOTH
//      `contract.ts` AND the wire fixtures encode exactly what the extract contains —
//      the enum wire values (VALIDATION_STATES/RUN_STATES), the serialized wire field
//      names and error channels, and the exact provider operation set. This is the
//      reviewed authority that closes the earlier gap where a fixture and a contract
//      constant were only ever compared to each
//      other and could drift together. The extract itself is authenticated
//      out-of-band once by a reviewer who follows the commit-pinned permalink.
//
//   3. Contract cross-check of every fixture's wire facts (REPRODUCIBLE): API
//      version, resource states, error channels, Retry-After, run-ID GUID shape,
//      and operation strings, against the reviewed `contract.ts` encoding.
//
// It deliberately does not import the generator, so a generator bug cannot hide
// by being reused here.

const FIXTURES_DIR = join(import.meta.dirname, '..', '..', 'fixtures');
const MANIFEST_BASENAME = 'provenance.manifest.json';
const MANIFEST_PATH = join(FIXTURES_DIR, MANIFEST_BASENAME);

/**
 * Authenticates a terminal-gated GET's 200-vs-202 BRANCHES against source data flow — not
 * mere token presence, not "the factory name appears somewhere", and not an INVERTED or
 * UNRELATED guard. Given the name of the variable the method fetched from the backend
 * (`fetchedVar`), it:
 *   1. parses the single `if (<cond>) { <block> }` guard whose condition contains
 *      `IsTerminal()`, and requires that condition to be EXACTLY
 *      `<fetchedVar>(.member)*.IsTerminal()` — a POSITIVE (non-negated) predicate on the
 *      FETCHED resource, with no `!`, no `&&`/`||`, and no comparison. So an inverted
 *      `!x.IsTerminal()` or an unrelated `other.IsTerminal()` is rejected;
 *   2. binds each status factory to the branch's GUARANTEED (unconditional, top-level)
 *      return via {@link csharpFirstUnconditionalReturnAtDepth0} — the TERMINAL branch must
 *      guarantee `HttpResponseResult.Ok(<fetchedVar>...)` (200) and the NONTERMINAL
 *      fall-through must guarantee `HttpResponseResult.Accepted(<fetchedVar>...)` (202); and
 *   3. requires each factory's FIRST ARGUMENT to be exactly `fetchedVar` — so a branch that
 *      returns the correct status factory with the WRONG value (a decoy resource) is rejected.
 * Because the guaranteed return is the first unconditional depth-0 return, a dead/nested
 * return cannot spoof either branch.
 */
function assertTerminalGatedGet(
  strippedBody: string,
  label: string,
  fetchedVar: string,
  fetchBinding?: { receiver: string; method: string; argList: readonly string[] },
): void {
  // COMPLETE DATAFLOW BINDING (pass 43 finding #8): the guarded/returned resource must be the
  // fetched var, and the fetched var must be produced by an AWAITED call (the store GET) at the
  // method's straight-line depth 0 — so a guard/return over some OTHER (un-fetched) variable, or
  // a guard placed before the resource is actually read, cannot pass.
  const v = fetchedVar.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const fetchAssign = new RegExp(`(?:^|[;{}])\\s*(?:var\\s+|[A-Za-z_][\\w.<>,?\\[\\]]*\\s+)?${v}\\s*=\\s*await\\b`);
  const fetchMatch = fetchAssign.exec(strippedBody);
  assert.ok(fetchMatch, `${label}: the fetched resource '${fetchedVar}' is assigned from an AWAITED call (dataflow-bound GET)`);
  const fetchIndex = fetchMatch!.index;

  // EXACT FETCH BINDING (pass 44 finding #7): when a binding is supplied, the fetched var must be
  // assigned from the EXACT receiver-qualified method call with the EXACT argument list — so a
  // decoy fetch on the wrong receiver / wrong args / wrong resource cannot satisfy the check.
  if (fetchBinding) {
    const call = csharpInvocation(strippedBody, fetchBinding.method);
    assert.ok(call, `${label}: the fetch method ${fetchBinding.method}(...) is a parsed call`);
    assert.ok(call!.qualified && call!.receiver === fetchBinding.receiver, `${label}: the fetch is issued on this.${fetchBinding.receiver} (receiver-bound)`);
    assert.deepEqual([...call!.argList], [...fetchBinding.argList], `${label}: the fetch forwards EXACTLY (${fetchBinding.argList.join(', ')})`);
    assert.ok(call!.awaited, `${label}: the fetch is AWAITED`);
    const rcv = fetchBinding.receiver.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const mth = fetchBinding.method.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const assignBind = new RegExp(`(?:^|[;{}])\\s*(?:var\\s+|[A-Za-z_][\\w.<>,?\\[\\]]*\\s+)?${v}\\s*=\\s*await\\s+this\\s*\\.\\s*${rcv}\\s*\\.\\s*${mth}\\s*\\(`);
    assert.match(strippedBody, assignBind, `${label}: '${fetchedVar}' is assigned from await this.${fetchBinding.receiver}.${fetchBinding.method}(...) (assignment-bound)`);
  }

  // Brace depth at every index, so the terminal guard can be required to be a DIRECT child of the
  // method body (depth 0), never nested inside another block.
  const depthAt = new Array<number>(strippedBody.length + 1);
  {
    let d = 0;
    for (let i = 0; i < strippedBody.length; i++) {
      depthAt[i] = d;
      if (strippedBody[i] === '{') d++;
      else if (strippedBody[i] === '}') d--;
    }
    depthAt[strippedBody.length] = d;
  }
  // SINGLE REACHABLE PRODUCER at DEPTH 0 (pass 45 finding #4): there must be EXACTLY ONE awaited
  // assignment to the fetched var, and it must be a straight-line (depth-0) statement that
  // DOMINATES the guard — so an unrelated or DEAD second assignment cannot be combined with the
  // guard's consumption of the fetched var (one reachable producer→consumer chain, not two).
  const producerRe = new RegExp(`(?:^|[;{}])\\s*(?:var\\s+|[A-Za-z_][\\w.<>,?\\[\\]]*\\s+)?${v}\\s*=\\s*await\\b`, 'g');
  const producers = [...strippedBody.matchAll(producerRe)];
  assert.equal(producers.length, 1, `${label}: the fetched resource '${fetchedVar}' has EXACTLY ONE awaited producer (no combinable/dead second assignment)`);
  const awaitIdx = strippedBody.indexOf('await', fetchIndex);
  assert.ok(awaitIdx >= 0 && depthAt[awaitIdx] === 0, `${label}: the fetch of '${fetchedVar}' is a straight-line (depth-0) statement that dominates the guard`);
  // Reachability cutoff: the index of the first DEPTH-0 unconditional `return`/`throw` that
  // begins a statement — everything at/after it (except that statement itself) is dead. A guard
  // placed after it is unreachable and must be rejected.
  let deadFrom = strippedBody.length;
  {
    const termRe = /(?:^|[;{}])\s*(return|throw)\b/g;
    let tm: RegExpExecArray | null;
    while ((tm = termRe.exec(strippedBody)) !== null) {
      const kwIdx = tm.index + tm[0].length - tm[1]!.length;
      if (depthAt[kwIdx] === 0) { deadFrom = kwIdx; break; }
    }
  }

  // Find the terminal guard `if (...IsTerminal()...) {` that is at DEPTH 0 and REACHABLE (after
  // the fetch and before any dead code) — rejecting a decoy guard nested in a block or placed in
  // unreachable code after a return.
  const ifRe = /\bif\s*\(([^)]*IsTerminal\s*\(\s*\)[^)]*)\)\s*\{/g;
  let m: RegExpExecArray | null = null;
  let cand: RegExpExecArray | null;
  while ((cand = ifRe.exec(strippedBody)) !== null) {
    if (depthAt[cand.index] !== 0) continue; // nested inside another block => not a direct guard
    if (cand.index < fetchIndex) continue; // before the resource is fetched => wrong dataflow
    if (cand.index >= deadFrom) continue; // in unreachable code after a depth-0 return/throw
    m = cand;
    break;
  }
  assert.ok(m, `${label}: has a DIRECT (depth-0), reachable if(...IsTerminal()...) terminal guard after the fetch`);
  // (1) The guard condition must be EXACTLY a positive IsTerminal() predicate on the fetched
  // resource: `<fetchedVar>(.member)*.IsTerminal()`. Reject negation / compound / comparison.
  const cond = m![1]!.replace(/\s+/g, '');
  const positiveGuard = new RegExp(`^${v}(?:\\.[A-Za-z_]\\w*)*\\.IsTerminal\\(\\)$`);
  assert.match(
    cond,
    positiveGuard,
    `${label}: the terminal guard is EXACTLY a positive ${fetchedVar}.….IsTerminal() (not negated/compound/unrelated); got '${cond}'`,
  );

  const open = m!.index + m![0].length - 1; // index of the block's opening '{'
  let depth = 0;
  let close = -1;
  for (let j = open; j < strippedBody.length; j++) {
    if (strippedBody[j] === '{') depth++;
    else if (strippedBody[j] === '}') { depth--; if (depth === 0) { close = j; break; } }
  }
  assert.ok(close > open, `${label}: terminal guard block is brace-matched`);
  const terminalBranch = strippedBody.slice(open + 1, close);
  const fallThrough = strippedBody.slice(close + 1);

  const terminalReturn = csharpFirstUnconditionalReturnAtDepth0(terminalBranch);
  const fallReturn = csharpFirstUnconditionalReturnAtDepth0(fallThrough);
  assert.ok(terminalReturn !== null, `${label}: the TERMINAL branch has an unconditional return`);
  assert.ok(fallReturn !== null, `${label}: the NONTERMINAL fall-through has an unconditional return`);

  const OK = /^HttpResponseResult\s*\.\s*Ok\s*\(/;
  const ACCEPTED = /^HttpResponseResult\s*\.\s*Accepted\s*\(/;
  assert.match(terminalReturn!, OK, `${label}: the TERMINAL branch's guaranteed return is 200 Ok`);
  assert.ok(!ACCEPTED.test(terminalReturn!), `${label}: the terminal branch's guaranteed return is NOT 202 Accepted`);
  assert.match(fallReturn!, ACCEPTED, `${label}: the NONTERMINAL fall-through's guaranteed return is 202 Accepted`);
  assert.ok(!OK.test(fallReturn!), `${label}: the nonterminal fall-through's guaranteed return is NOT 200 Ok`);

  // (3) Each factory's FIRST argument must be exactly the fetched resource, so a correct
  // status with a WRONG returned value (a decoy resource) is rejected.
  assert.equal(firstCallArg(terminalReturn!), fetchedVar, `${label}: 200 Ok returns the fetched resource '${fetchedVar}'`);
  assert.equal(firstCallArg(fallReturn!), fetchedVar, `${label}: 202 Accepted returns the fetched resource '${fetchedVar}'`);
}

/** The first top-level argument of the leading `Factory(...)` call in an expression, or ''. */
function firstCallArg(expr: string): string {
  const open = expr.indexOf('(');
  if (open < 0) return '';
  let depth = 0;
  for (let j = open; j < expr.length; j++) {
    if (expr[j] === '(') depth++;
    else if (expr[j] === ')') { depth--; if (depth === 0) {
      const args = expr.slice(open + 1, j);
      if (args.trim().length === 0) return '';
      return splitTopLevelArgs(args)[0]!.trim();
    } }
  }
  return '';
}

interface ManifestSource {
  repo: string;
  path: string;
  symbol: string;
  kind: string;
  tier: number;
  pinnedApiVersion: string;
  commitId: string;
  url: string;
  extract?: string;
  extractSha256?: string;
}
interface ManifestSnapshot {
  repo: string;
  commitId: string;
  baseUrl: string;
  capturedAt: string;
}
interface ManifestFixture {
  file: string;
  source: string;
  citation: string;
  canonicalSha256: string;
}
interface Manifest {
  apiVersion: string;
  note: string;
  sourceSnapshot: ManifestSnapshot;
  sources: Record<string, ManifestSource>;
  fixtures: ManifestFixture[];
}
interface FixtureProvenance {
  provenance?: { source?: string; citation?: string };
}

interface HttpResponse {
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
}
interface HttpRequest {
  method?: string;
  url?: string;
  headers?: Record<string, string>;
}
interface WireFixtureRaw {
  provenance?: { source?: string; citation?: string };
  request?: HttpRequest;
  response?: HttpResponse;
  sequence?: Array<{ request?: HttpRequest; response: HttpResponse }>;
  value?: Array<{ name: string }>;
  expected?: { runId?: string; runResourceId?: string };
}

function loadManifest(): Manifest {
  const raw = readFileSync(join(FIXTURES_DIR, MANIFEST_BASENAME), 'utf8');
  return JSON.parse(raw) as Manifest;
}

/**
 * Canonical content hash: the JSON re-serialized from the parsed fixture, so
 * incidental whitespace or CRLF/LF differences never change the hash while any
 * semantic change does. Mirrors the generator's algorithm.
 */
function canonicalSha256(rawJson: string): string {
  const canonical = JSON.stringify(JSON.parse(rawJson));
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function listFixtureFiles(dir = FIXTURES_DIR): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...listFixtureFiles(full));
      continue;
    }
    // Case-insensitive extension; exclude ONLY the root manifest (by full path),
    // so a nested provenance.manifest.json is treated as a real fixture.
    if (!entry.toLowerCase().endsWith('.json')) continue;
    if (full === MANIFEST_PATH) continue;
    out.push(full);
  }
  return out;
}

function posixKey(fullPath: string): string {
  return relative(FIXTURES_DIR, fullPath).split('\\').join('/');
}

const COMMIT_SHA = /^[0-9a-f]{40}$/;
const CONTENT_SHA256 = /^[0-9a-f]{64}$/;

// TRUSTED permalink authority constants. The source snapshot's baseUrl (and every
// per-source permalink) must resolve to EXACTLY this host, repository path, and the
// default HTTPS port — never a value self-selected by the manifest. Binding to
// these constants prevents a tampered manifest from pointing provenance at an
// attacker-controlled host/repo while still "passing" a self-referential check.
const TRUSTED_PERMALINK_HOST = 'dev.azure.com';
const TRUSTED_PERMALINK_PORT = ''; // default 443; a non-empty port is rejected
const TRUSTED_PERMALINK_REPO_PATH = '/msazure/One/_git/Squall';
const TRUSTED_PERMALINK_ORIGIN = `https://${TRUSTED_PERMALINK_HOST}${TRUSTED_PERMALINK_REPO_PATH}`;
// Every source-of-truth artifact must live in the Squall monorepo; the snapshot
// repo is exactly this and each source repo is a path WITHIN it (`Squall/...`).
const TRUSTED_SOURCE_REPO = 'Squall';

/**
 * Asserts the RAW authority of an https URL (the substring between `https://` and
 * the first `/`, `?`, or `#`) equals `expectedHost` EXACTLY — BEFORE WHATWG URL
 * parsing can silently strip an explicit `:443`, fold userinfo, or lowercase/punycode
 * the host. This rejects `https://host:443/…` and `https://user@host/…` which a
 * normalized `URL.host`/`URL.port` check would accept.
 */
function assertRawAuthority(rawUrl: string, expectedHost: string, key: string, what: string): void {
  const m = /^https:\/\/([^/?#]*)/.exec(rawUrl);
  assert.ok(m, `${key}: ${what} must be an absolute https URL`);
  assert.equal(m![1], expectedHost, `${key}: ${what} raw authority must be exactly '${expectedHost}' (no explicit port or userinfo)`);
}

/** The RAW query string of a URL (between the first `?` and any `#`), or '' if none. */
function rawQueryString(rawUrl: string): string {
  const q = rawUrl.indexOf('?');
  if (q < 0) return '';
  return rawUrl.slice(q + 1).split('#', 1)[0]!;
}

/**
 * Strictly validates a commit-pinned Azure DevOps permalink by PARSING the whole
 * URL and binding every component to TRUSTED CONSTANTS (not a manifest-supplied
 * base): HTTPS, the trusted RAW authority (exact host, no `:443`/userinfo), no
 * fragment, the trusted repository path, an EXACT canonical raw query
 * (`path=/<path>&version=GC<commit>` byte-for-byte — no reordering, extra/duplicate
 * params, or percent-encoded spellings), and the decoded `path`/`version` values.
 */
function assertCommitPermalink(url: string, commitId: string, path: string, key: string): void {
  // RAW checks first (pre-normalization): exact authority and exact canonical query.
  assertRawAuthority(url, TRUSTED_PERMALINK_HOST, key, 'permalink');
  assert.equal(
    rawQueryString(url),
    `path=/${path}&version=GC${commitId}`,
    `${key} permalink raw query must be the exact canonical spelling (no reordering/encoding/extra params)`,
  );
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    assert.fail(`${key} URL is not a valid absolute URL`);
  }
  assert.equal(u!.protocol, 'https:', `${key} permalink is HTTPS`);
  assert.equal(u!.hostname, TRUSTED_PERMALINK_HOST, `${key} permalink uses the trusted host`);
  assert.equal(u!.port, TRUSTED_PERMALINK_PORT, `${key} permalink uses the default HTTPS port`);
  assert.equal(u!.username, '', `${key} permalink carries no userinfo (username)`);
  assert.equal(u!.password, '', `${key} permalink carries no userinfo (password)`);
  assert.equal(u!.hash, '', `${key} permalink carries no fragment`);
  assert.equal(u!.pathname, TRUSTED_PERMALINK_REPO_PATH, `${key} permalink targets the trusted repository path`);
  assert.deepEqual(
    [...u!.searchParams.keys()].sort(),
    ['path', 'version'],
    `${key} permalink carries exactly path + version (no extra/duplicate query)`,
  );
  assert.equal(u!.searchParams.get('path'), `/${path}`, `${key} permalink path parameter equals the decoded artifact path`);
  assert.equal(u!.searchParams.get('version'), `GC${commitId}`, `${key} permalink version parameter pins the commit (GC<sha>)`);
}

test('the provenance manifest pins the same API version as the contract (D5, VF14)', () => {
  assert.equal(loadManifest().apiVersion, API_VERSION);
});

test('the manifest declares an immutable source snapshot (commit-pinned monorepo revision)', () => {
  const snap = loadManifest().sourceSnapshot;
  assert.ok(snap, 'manifest declares a sourceSnapshot');
  // The snapshot repo is bound to the trusted Squall monorepo (not a self-selected name).
  assert.equal(snap.repo, TRUSTED_SOURCE_REPO, 'snapshot repo is the trusted Squall monorepo');
  assert.match(snap.commitId, COMMIT_SHA, 'snapshot pins a full 40-hex commit SHA');
  // RAW authority check first: exact host, no explicit :443, no userinfo, no query.
  assertRawAuthority(snap.baseUrl, TRUSTED_PERMALINK_HOST, 'snapshot base URL', 'base URL');
  assert.equal(rawQueryString(snap.baseUrl), '', 'snapshot base URL carries no raw query');
  // The base URL must equal the TRUSTED authority EXACTLY (host + repo path +
  // default port), with no userinfo/fragment/query — not a self-selected value.
  const base = new URL(snap.baseUrl);
  assert.equal(base.protocol, 'https:', 'snapshot base URL is HTTPS');
  assert.equal(base.hostname, TRUSTED_PERMALINK_HOST, 'snapshot base URL uses the trusted host');
  assert.equal(base.port, TRUSTED_PERMALINK_PORT, 'snapshot base URL uses the default HTTPS port');
  assert.equal(base.username, '', 'snapshot base URL carries no userinfo');
  assert.equal(base.password, '', 'snapshot base URL carries no userinfo');
  assert.equal(base.hash, '', 'snapshot base URL carries no fragment');
  assert.equal(base.search, '', 'snapshot base URL carries no query');
  assert.equal(base.pathname, TRUSTED_PERMALINK_REPO_PATH, 'snapshot base URL targets the trusted repository path');
  // And the assembled origin string matches the trusted constant byte-for-byte.
  assert.equal(`${base.protocol}//${base.host}${base.pathname}`, TRUSTED_PERMALINK_ORIGIN, 'snapshot base URL equals the trusted origin');
});

test('every source-of-truth reference is an authoritative pinned Tier 1/2 artifact', () => {
  const manifest = loadManifest();
  const entries = Object.entries(manifest.sources);
  assert.ok(entries.length > 0, 'manifest declares at least one source');
  for (const [key, src] of entries) {
    assert.ok(typeof src.path === 'string' && src.path.length > 0, `${key} has a source path`);
    assert.ok(typeof src.symbol === 'string' && src.symbol.length > 0, `${key} names a symbol`);
    assert.ok(typeof src.kind === 'string' && src.kind.length > 0, `${key} declares a kind`);
    assert.ok(src.tier === 1 || src.tier === 2, `${key} is a Tier 1/2 source`);
    assert.equal(src.pinnedApiVersion, API_VERSION, `${key} is pinned to ${API_VERSION}`);
    // Repo metadata is bound to the trusted Squall monorepo: exactly `Squall` or a
    // path within it (`Squall/services/...`) — never a foreign or self-selected repo.
    assert.ok(
      src.repo === TRUSTED_SOURCE_REPO || src.repo.startsWith(`${TRUSTED_SOURCE_REPO}/`),
      `${key} repo '${src.repo}' is within the trusted ${TRUSTED_SOURCE_REPO} monorepo`,
    );
  }
});

test('every source is bound by a commit-pinned permalink, not an opaque hardcoded hash', () => {
  const manifest = loadManifest();
  const snapshotCommit = manifest.sourceSnapshot.commitId;
  for (const [key, src] of Object.entries(manifest.sources)) {
    // Authentication is the commit-pinned permalink an auditor can FOLLOW to the
    // exact source bytes. Parse the FULL URL and bind every component to the
    // TRUSTED authority constants — substring checks (or a manifest-selected base)
    // would accept a look-alike host, an injected path segment, a userinfo/
    // fragment, or extra query parameters.
    assert.match(src.commitId, COMMIT_SHA, `${key} pins a full commit SHA`);
    assert.equal(src.commitId, snapshotCommit, `${key} shares the snapshot commit`);
    assertCommitPermalink(src.url, src.commitId, src.path, key);
    // The removed field must stay removed: a per-source content hash of a file
    // this repo cannot read is unverifiable here and must not masquerade as
    // authentication.
    assert.equal(
      (src as unknown as Record<string, unknown>)['sourceSha256'],
      undefined,
      `${key} must not carry an unverifiable opaque source hash`,
    );
  }
});

test('the commit-permalink check rejects tampered URLs (host, port, path, commit, userinfo, fragment, extra query)', () => {
  const commit = 'a'.repeat(40);
  const path = 'services/GW/src/Foo.cs';
  const good = `https://dev.azure.com/msazure/One/_git/Squall?path=/${path}&version=GC${commit}`;
  // The canonical permalink passes.
  assert.doesNotThrow(() => assertCommitPermalink(good, commit, path, 'good'));
  const reject = (url: string, why: string) =>
    assert.throws(() => assertCommitPermalink(url, commit, path, why), `expected rejection: ${why}`);
  reject(`http://dev.azure.com/msazure/One/_git/Squall?path=/${path}&version=GC${commit}`, 'not https');
  reject(`https://evil.example.com/msazure/One/_git/Squall?path=/${path}&version=GC${commit}`, 'foreign host');
  reject(`https://dev.azure.com:8443/msazure/One/_git/Squall?path=/${path}&version=GC${commit}`, 'non-default port');
  reject(`https://user@dev.azure.com/msazure/One/_git/Squall?path=/${path}&version=GC${commit}`, 'userinfo');
  reject(`https://dev.azure.com/msazure/One/_git/Squall?path=/${path}&version=GC${commit}#frag`, 'fragment');
  reject(`https://dev.azure.com/msazure/One/_git/Other?path=/${path}&version=GC${commit}`, 'foreign repository path');
  reject(`https://dev.azure.com/msazure/One/_git/Squall?path=/other/File.cs&version=GC${commit}`, 'mismatched artifact path');
  reject(`https://dev.azure.com/msazure/One/_git/Squall?path=/${path}&version=GC${'b'.repeat(40)}`, 'mismatched commit');
  reject(`https://dev.azure.com/msazure/One/_git/Squall?path=/${path}&version=GC${commit}&extra=1`, 'extra query parameter');
  reject(`https://dev.azure.com/msazure/One/_git/Squall?path=/${path}&path=/x&version=GC${commit}`, 'duplicate path parameter');
  // RAW-authority/query defenses (pre-normalization):
  reject(`https://dev.azure.com:443/msazure/One/_git/Squall?path=/${path}&version=GC${commit}`, 'explicit :443 authority');
  reject(`https://dev.azure.com/msazure/One/_git/Squall?version=GC${commit}&path=/${path}`, 'reordered query params');
  reject(`https://dev.azure.com/msazure/One/_git/Squall?path=/${path}&version=GC${commit}&`, 'trailing ampersand in query');
});

test('every fixture on disk is recorded in the manifest (no undocumented fixtures)', () => {
  const manifest = loadManifest();
  const recorded = new Set(manifest.fixtures.map((f) => f.file));
  const onDisk = listFixtureFiles().map(posixKey);
  for (const key of onDisk) {
    assert.ok(recorded.has(key), `fixture '${key}' is missing a provenance manifest entry`);
  }
  assert.equal(recorded.size, onDisk.length, 'manifest records exactly the fixtures on disk');
});

test('each manifest fixture traces to a declared source and matches its embedded provenance', () => {
  const manifest = loadManifest();
  for (const entry of manifest.fixtures) {
    assert.ok(entry.source in manifest.sources, `${entry.file} cites a declared source`);

    const raw = readFileSync(join(FIXTURES_DIR, entry.file), 'utf8');
    const embedded = (JSON.parse(raw) as FixtureProvenance).provenance;
    assert.ok(embedded?.source, `${entry.file} carries an embedded provenance.source`);
    assert.equal(embedded.source, entry.source, `${entry.file} embedded source must match manifest`);
    assert.equal(embedded.citation, entry.citation, `${entry.file} citation must match manifest`);
  }
});

test('every recorded content hash matches the fixture on disk (tamper-evidence)', () => {
  const manifest = loadManifest();
  for (const entry of manifest.fixtures) {
    assert.match(entry.canonicalSha256, CONTENT_SHA256, `${entry.file} records a canonical content hash`);
    const raw = readFileSync(join(FIXTURES_DIR, entry.file), 'utf8');
    assert.equal(
      canonicalSha256(raw),
      entry.canonicalSha256,
      `${entry.file} content drifted from its recorded provenance hash — regenerate the manifest`,
    );
  }
});

test('the committed manifest fixtures equal an independent regeneration from disk', () => {
  const manifest = loadManifest();
  const expected: ManifestFixture[] = listFixtureFiles()
    .map((full) => {
      const raw = readFileSync(full, 'utf8');
      const embedded = (JSON.parse(raw) as FixtureProvenance).provenance!;
      return {
        file: posixKey(full),
        source: embedded.source!,
        citation: embedded.citation ?? '',
        canonicalSha256: canonicalSha256(raw),
      };
    })
    .sort((a, b) => a.file.localeCompare(b.file));
  assert.deepEqual(manifest.fixtures, expected);
});

test('the generated provider-operations snapshot is a Tier-1 generated artifact (DX1, VF12)', () => {
  const manifest = loadManifest();
  const ops = manifest.fixtures.find((f) => f.file === 'operations/provider-operations.json');
  assert.ok(ops, 'the provider-operations fixture is recorded');
  const src = manifest.sources[ops!.source];
  assert.ok(src, 'its source is declared');
  assert.equal(src!.kind, 'generated-snapshot');
  assert.equal(src!.tier, 1);
});

test('VF11 fixtures trace to the BE command handlers that removed the evaluation gate', () => {
  const manifest = loadManifest();
  const vf11 = manifest.fixtures.filter((f) => f.citation.split(/,\s*/).includes('VF11'));
  assert.ok(vf11.length >= 2, 'at least the validate + execute unevaluated fixtures cite VF11');
  for (const fx of vf11) {
    const src = manifest.sources[fx.source];
    assert.ok(src, `${fx.file} cites a declared source`);
    assert.equal(src!.kind, 'command-handler', `${fx.file} traces to a BE command handler`);
    assert.equal(src!.repo, 'Squall/services/BE');
  }
});

// ---------------------------------------------------------------------------
// Reviewed-source-extract authentication (REPRODUCIBLE): the committed extracts
// under source-extracts/ are the single reviewed authority. Recompute each
// recorded hash, then parse the extract and prove contract.ts encodes exactly
// what the SOURCE contains — not merely what a sibling fixture contains.
// ---------------------------------------------------------------------------

const SOURCE_KEYS = {
  validationState: 'gw.validation.state',
  runState: 'gw.run.state',
  validationProps: 'gw.validation.properties',
  runProps: 'gw.run.properties',
  operations: 'gw.operations.getOperationsSnapshot',
  configDomainLogic: 'gw.configuration.domainLogic',
  runDomainLogic: 'gw.run.domainLogic',
  validationCommand: 'be.validation.command',
  executionCommand: 'be.execution.command',
  cancelCommand: 'be.cancel.command',
  configController: 'be.configuration.controller',
  validationStore: 'be.validation.store',
  exceptionMapper: 'be.exception.mapper',
  resolver: 'be.resource.resolver',
  liveEvaluator: 'be.resource.evaluator',
  targetQuery: 'be.resource.targetQuery',
  diRegistration: 'be.resource.diRegistration',
  targetStore: 'be.resource.targetStore',
  mapFactories: 'be.resource.mapFactories',
  errorModels: 'gw.error.models',
  runResource: 'gw.run.resource',
  runIsTerminal: 'be.run.state.isTerminal',
  validationIsTerminal: 'be.validation.state.isTerminal',
} as const;

function sourceWithExtract(key: string): ManifestSource {
  const src = loadManifest().sources[key];
  assert.ok(src, `manifest declares source ${key}`);
  assert.ok(src!.extract, `${key} records a committed reviewed extract path`);
  return src!;
}

test('every generated source declares a committed reviewed extract with a recorded hash', () => {
  for (const key of Object.values(SOURCE_KEYS)) {
    const src = sourceWithExtract(key);
    assert.match(src.extractSha256 ?? '', CONTENT_SHA256, `${key} records an extract hash`);
  }
});

test('each committed source extract matches its recorded hash (tamper-evidence)', () => {
  for (const [key, src] of Object.entries(loadManifest().sources)) {
    if (!src.extract) continue;
    const raw = readExtract(src.extract);
    assert.equal(
      computeExtractSha256(raw),
      src.extractSha256,
      `${key}: extract drifted from its recorded hash — regenerate the manifest`,
    );
  }
});

test('VALIDATION_STATES equals the generated ScenarioValidationState enum extract (VF3)', () => {
  const values = enumWireValues(readExtract(sourceWithExtract(SOURCE_KEYS.validationState).extract!));
  assert.deepEqual(values, [...VALIDATION_STATES], 'contract validation states must equal the generated enum');
});

test('RUN_STATES equals the generated ScenarioRunState enum extract (VF7)', () => {
  const values = enumWireValues(readExtract(sourceWithExtract(SOURCE_KEYS.runState).extract!));
  assert.deepEqual(values, [...RUN_STATES], 'contract run states must equal the generated enum');
});

test('validation wire fields + dual error channels are the ValidationProperties extract serialization (DX2, VF10)', () => {
  const names = serializedWireNames(readExtract(sourceWithExtract(SOURCE_KEYS.validationProps).extract!));
  assert.ok(names.includes(STATUS_FIELD), 'status is a serialized wire field (DX2)');
  assert.ok(names.includes(START_TIME_FIELD) && names.includes(END_TIME_FIELD), 'startTime/endTime are wire fields (DX2)');
  for (const chan of VALIDATION_ERROR_CHANNELS) {
    assert.ok(names.includes(chan), `validation channel '${chan}' is a serialized wire field (VF10)`);
  }
  assert.ok(!names.includes('state'), 'DX2: the generated model does not serialize a stale `state` field');
  // VF4: the generated validation model exposes no concurrency/idempotency field.
  for (const forbidden of ['etag', 'eTag', 'ifMatch', 'resourceVersion', 'concurrencyToken']) {
    assert.ok(!names.includes(forbidden), `no concurrency wire field '${forbidden}' in the source (VF4)`);
  }
});

test('run wire fields + dual error channels are the ScenarioRunProperties extract serialization (DX2, VF10)', () => {
  const names = serializedWireNames(readExtract(sourceWithExtract(SOURCE_KEYS.runProps).extract!));
  assert.ok(names.includes(STATUS_FIELD), 'status is a serialized wire field (DX2)');
  assert.ok(names.includes(START_TIME_FIELD) && names.includes(END_TIME_FIELD), 'startTime/endTime are wire fields (DX2)');
  for (const chan of RUN_ERROR_CHANNELS) {
    assert.ok(names.includes(chan), `run channel '${chan}' is a serialized wire field (VF10)`);
  }
  assert.ok(!names.includes('state'), 'DX2: no stale `state` field');
});

test('the run `resources` object-array binds to the ScenarioRunResource element model, derived from source (finding #5)', () => {
  // The channel->element-model binding is DERIVED from the properties model (the
  // Resources property is IReadOnlyList<ScenarioRunResource>), not hardcoded.
  assert.equal(RUN_CHANNEL_MODELS['resources'], 'ScenarioRunResource', 'resources binds to the ScenarioRunResource element model');
  // The element model's closed field set + kinds are derived from ITS OWN generated
  // serializer extract, so the recursive validator authenticates array items.
  const el = ELEMENT_MODEL_FIELDS['ScenarioRunResource']!;
  assert.deepEqual([...el.keys()].sort(), ['resourceId', 'selectors', 'targetType'], 'ScenarioRunResource wire fields are derived from its serializer');
  assert.equal(el.get('resourceId')!.kind, 'scalar');
  assert.equal(el.get('resourceId')!.primitive, 'string');
  assert.equal(el.get('targetType')!.kind, 'scalar');
  assert.equal(el.get('selectors')!.kind, 'array');
  assert.equal(el.get('selectors')!.element, 'string', 'selectors is a string array');
});

test('the derived property schema equals the source model fields (no hardcoded key list) (finding #5)', () => {
  // required ∪ optional is DERIVED from the properties model's serialized fields, so
  // the closed allowed-key set cannot drift from the generated serialization.
  const validateModel = [...AREA_PROP_FIELDS['validate']!.keys()].sort();
  assert.deepEqual([...PROP_SCHEMA['validate']!.required, ...PROP_SCHEMA['validate']!.optional].sort(), validateModel, 'validate allowed keys equal the model fields');
  const runModel = [...AREA_PROP_FIELDS['execute']!.keys()].sort();
  assert.deepEqual([...PROP_SCHEMA['execute']!.required, ...PROP_SCHEMA['execute']!.optional].sort(), runModel, 'execute allowed keys equal the model fields');
  // The contract-required subset is validated to be a subset of the model fields.
  for (const area of ['validate', 'execute', 'cancel'] as const) {
    for (const r of PROP_SCHEMA[area]!.required) {
      assert.ok(AREA_PROP_FIELDS[area]!.has(r), `required '${r}' is a serialized field of the ${area} model`);
    }
  }
});

test('every invoked PROVIDER_OPERATION is a generated operation string, and DX1 run/action is absent from the source (DX1, VF12)', () => {
  const ops = new Set(extractOperationNames(readExtract(sourceWithExtract(SOURCE_KEYS.operations).extract!)));
  for (const op of Object.values(PROVIDER_OPERATIONS)) {
    assert.ok(ops.has(op), `invoked operation '${op}' must exist in the generated operation snapshot`);
  }
  assert.ok(
    !ops.has('Microsoft.Chaos/workspaces/scenarios/run/action'),
    'DX1: the nonexistent run/action must not appear anywhere in the generated source',
  );
});

test('the configuration domain logic extract authenticates validate + validation GET + execute acceptance (VF1, VF2, VF5, DX3)', () => {
  const src = readExtract(sourceWithExtract(SOURCE_KEYS.configDomainLogic).extract!);
  const methods = new Set(csharpMethodNames(src));
  assert.ok(methods.has('ValidateAsync'), 'declares ValidateAsync');
  assert.ok(methods.has('GetLatestValidationAsync'), 'declares the validation GET logic');
  assert.ok(methods.has('ExecuteAsync'), 'declares ExecuteAsync');

  // Structural: assert on each method's BODY (exactly scoped to its class + a single
  // direct member), matched against the comment/literal-stripped views so a decoy in a
  // comment or (for code tokens) a string cannot satisfy a raw-text assertion.
  const validate = csharpDirectMethodBody(src, 'ConfigurationDomainLogicV1', 'ValidateAsync');
  // The resource-path segments are STRING literals, so match the comment-stripped view
  // (strings preserved, comments blanked) — a decoy in a comment cannot satisfy it.
  assert.match(commentStrippedCSharp(validate), /"validations",\s*"latest"/, 'validate targets validations/latest');
  assert.ok(httpStatusCodes(validate, src).includes('Accepted'), 'validate returns 202 Accepted');
  assert.ok(!httpStatusCodes(validate, src).includes('PreconditionFailed'), 'validate never returns 412 (VF4) — bare HttpStatusCode resolved against the full file (pass 43 finding #9)');

  const getValidation = csharpDirectMethodBody(src, 'ConfigurationDomainLogicV1', 'GetLatestValidationAsync');
  assertTerminalGatedGet(stripCSharpNoise(getValidation), 'validation GET', 'validation', {
    receiver: 'backendClient',
    method: 'GetLatestScenarioValidationAsync',
    argList: ['reference', 'context', 'cancellationToken'],
  });

  const execute = csharpDirectMethodBody(src, 'ConfigurationDomainLogicV1', 'ExecuteAsync');
  const executeCode = stripCSharpNoise(execute);
  // Bind the BE execution dispatch to an EXECUTABLE call (not a bare token): it is invoked
  // on the this.-qualified backendClient forwarding EXACTLY (reference, context,
  // cancellationToken) — the call whose awaited result yields runId.
  const startExec = csharpInvocation(execute, 'StartScenarioExecutionAsync');
  assert.ok(startExec, 'execute dispatches the BE execution command via a parsed call');
  assert.ok(startExec!.qualified && startExec!.receiver === 'backendClient', 'the execution command is issued on this.backendClient (receiver-bound)');
  assert.deepEqual(startExec!.argList, ['reference', 'context', 'cancellationToken'], 'the execution dispatch forwards EXACTLY (reference, context, cancellationToken)');
  // ONE REACHABLE PRODUCER→CONSUMER CHAIN (pass 45 finding #4): `runId` is PRODUCED by exactly one
  // awaited `this.backendClient.StartScenarioExecutionAsync(...)` assignment (a straight-line
  // producer), and that SAME `runId` is CONSUMED by `reference.ScenarioRunResourceId(runId)` — so
  // an unrelated `runId` assignment cannot be combined with a decoy resource-id derivation.
  const runIdProducers = [...executeCode.matchAll(/(?:^|[;{}])\s*(?:var\s+|[A-Za-z_][\w.<>,?[\]]*\s+)?runId\s*=\s*await\s+this\s*\.\s*backendClient\s*\.\s*StartScenarioExecutionAsync\s*\(/g)];
  assert.equal(runIdProducers.length, 1, 'runId has EXACTLY ONE awaited producer bound to this.backendClient.StartScenarioExecutionAsync (no combinable/dead assignment, DX3)');
  // DX3: the run Location is derived from the run resource id, bound as a parsed
  // ScenarioRunResourceId(runId) call ON the request `reference`, and it occurs AFTER the
  // execution dispatch (runId must be produced first).
  const runResId = csharpInvocation(execute, 'ScenarioRunResourceId');
  assert.ok(runResId, 'execute builds the run resource id via a parsed call (DX3)');
  assert.equal(runResId!.receiver, 'reference', 'the run resource id is built off the request reference (DX3)');
  assert.deepEqual(runResId!.argList, ['runId'], 'the run resource id is built from the awaited runId (DX3)');
  assert.ok(
    executeCode.indexOf('StartScenarioExecutionAsync') < executeCode.indexOf('ScenarioRunResourceId'),
    'the execution dispatch precedes the run-resource-id derivation (runId is produced then used, DX3)',
  );
  assert.ok(httpStatusCodes(execute, src).includes('Accepted'), 'execute returns 202 Accepted');

  // Structurally authenticate the fixtures' canonical Retry-After against SOURCE: the GW
  // declares `const int DefaultRetryAfterSeconds = <N>;` and each async Accepted(...)
  // passes `retryAfterSeconds: DefaultRetryAfterSeconds`, so the contract constant the
  // fixtures pin is derived from the source value, not a coincidental hardcode.
  const retrySeconds = csharpIntConst(src, 'DefaultRetryAfterSeconds');
  assert.equal(retrySeconds, DEFAULT_RETRY_AFTER_SECONDS, 'the GW default Retry-After source constant equals DEFAULT_RETRY_AFTER_SECONDS');
  for (const [method, body] of [['ValidateAsync', validate], ['ExecuteAsync', execute]] as const) {
    assert.match(
      stripCSharpNoise(body),
      /retryAfterSeconds\s*:\s*DefaultRetryAfterSeconds/,
      `${method} sets Retry-After from the DefaultRetryAfterSeconds source constant`,
    );
  }
});

test('the run domain logic extract authenticates run GET 202/200 and same-resource cancel (VF6, VF8, VF9)', () => {
  const src = readExtract(sourceWithExtract(SOURCE_KEYS.runDomainLogic).extract!);
  const methods = new Set(csharpMethodNames(src));
  assert.ok(methods.has('GetRunAsync') && methods.has('CancelRunAsync'), 'declares GetRunAsync + CancelRunAsync');

  const getRun = csharpDirectMethodBody(src, 'RunDomainLogicV1', 'GetRunAsync');
  assertTerminalGatedGet(stripCSharpNoise(getRun), 'run GET', 'run', {
    receiver: 'backendClient',
    method: 'GetScenarioRunAsync',
    argList: ['reference', 'context', 'cancellationToken'],
  });

  const cancel = csharpDirectMethodBody(src, 'RunDomainLogicV1', 'CancelRunAsync');
  const cancelCode = stripCSharpNoise(cancel);
  // BIND the cancel dispatch to the EXACT receiver-qualified backend call with EXACT args, awaited
  // (not a bare token): this.backendClient.CancelScenarioRunAsync(reference, context,
  // cancellationToken) (pass 44 finding #7).
  const cancelCall = csharpInvocation(cancel, 'CancelScenarioRunAsync');
  assert.ok(cancelCall, 'cancel dispatches the backend cancel via a parsed call');
  assert.ok(cancelCall!.qualified && cancelCall!.receiver === 'backendClient', 'the cancel is issued on this.backendClient (receiver-bound)');
  assert.deepEqual(cancelCall!.argList, ['reference', 'context', 'cancellationToken'], 'the cancel forwards EXACTLY (reference, context, cancellationToken)');
  assert.ok(cancelCall!.awaited, 'the cancel dispatch is AWAITED');
  // BIND the Location to the SAME run resource: `runResourceId` is assigned from
  // `reference.RunResourceId` (the resource the client already polls — no new resource), and the
  // AcceptedAsyncOperation location is BUILT from that runResourceId (VF8/VF9, DX3 same-resource).
  assert.match(cancelCode, /(?:^|[;{}])\s*(?:var\s+)?runResourceId\s*=\s*reference\s*\.\s*RunResourceId\b/, 'the cancel Location id is the SAME run resource (reference.RunResourceId)');
  const buildLoc = csharpInvocation(cancel, 'BuildResourceLocation');
  assert.ok(buildLoc, 'the cancel builds the Location via a parsed BuildResourceLocation call');
  assert.equal(buildLoc!.argList[0], 'runResourceId', 'the Location is built from the SAME-run runResourceId (no new resource, VF8/VF9)');
  // ONE REACHABLE PRODUCER for runResourceId (pass 45 finding #4): exactly one assignment, so an
  // unrelated `runResourceId = <newResource>` cannot be combined with the SAME-run derivation.
  const runResProducers = [...cancelCode.matchAll(/(?:^|[;{}])\s*(?:var\s+)?runResourceId\s*=/g)];
  assert.equal(runResProducers.length, 1, 'runResourceId has EXACTLY ONE producer (no combinable/dead reassignment, VF8/VF9)');
  assert.ok(
    cancelCode.indexOf('reference.RunResourceId') < cancelCode.indexOf('BuildResourceLocation'),
    'the run resource id is derived before the Location is built from it',
  );
  assert.ok(httpStatusCodes(cancel, src).includes('Accepted'), 'cancel returns 202 Accepted');

  // Authenticate the run/cancel 202 Retry-After against SOURCE: the GW declares
  // `const int DefaultRetryAfterSeconds = <N>;` equal to DEFAULT_RETRY_AFTER_SECONDS and
  // the run-poll/cancel Accepted(...) uses it, so the fixtures' Retry-After is source-derived.
  const retrySeconds = csharpIntConst(src, 'DefaultRetryAfterSeconds');
  assert.equal(retrySeconds, DEFAULT_RETRY_AFTER_SECONDS, 'the run-logic default Retry-After source constant equals DEFAULT_RETRY_AFTER_SECONDS');
  assert.match(
    stripCSharpNoise(cancel),
    /retryAfterSeconds\s*:\s*DefaultRetryAfterSeconds/,
    'cancel sets Retry-After from the DefaultRetryAfterSeconds source constant',
  );
});

test('assertTerminalGatedGet rejects an inverted/unrelated guard and a wrong returned value (pass 41 finding #7)', () => {
  const fetch = 'var x = await this.store.GetAsync(id, ct); ';
  // Baseline: the correct shape passes.
  const good = fetch + 'if (x.Properties.Status.IsTerminal()) { return HttpResponseResult.Ok(x); } return HttpResponseResult.Accepted(x, retryAfterSeconds: 10);';
  assertTerminalGatedGet(stripCSharpNoise(good), 'good', 'x');

  // INVERTED guard: `!x...IsTerminal()` would put Ok on the NON-terminal path — must throw.
  const inverted = fetch + 'if (!x.Properties.Status.IsTerminal()) { return HttpResponseResult.Ok(x); } return HttpResponseResult.Accepted(x);';
  assert.throws(() => assertTerminalGatedGet(stripCSharpNoise(inverted), 'inverted', 'x'), /positive .*IsTerminal/);

  // COMPOUND guard: `x...IsTerminal() || other` is not a clean terminal predicate — must throw.
  const compound = fetch + 'if (x.Properties.Status.IsTerminal() || force) { return HttpResponseResult.Ok(x); } return HttpResponseResult.Accepted(x);';
  assert.throws(() => assertTerminalGatedGet(stripCSharpNoise(compound), 'compound', 'x'), /positive .*IsTerminal/);

  // UNRELATED receiver: IsTerminal on some OTHER object, not the fetched resource — must throw.
  const unrelated = fetch + 'if (other.IsTerminal()) { return HttpResponseResult.Ok(x); } return HttpResponseResult.Accepted(x);';
  assert.throws(() => assertTerminalGatedGet(stripCSharpNoise(unrelated), 'unrelated', 'x'), /positive .*IsTerminal/);

  // WRONG returned value: the terminal branch returns a DECOY resource, not the fetched one.
  const wrongVal = fetch + 'if (x.Properties.Status.IsTerminal()) { return HttpResponseResult.Ok(decoy); } return HttpResponseResult.Accepted(x);';
  assert.throws(() => assertTerminalGatedGet(stripCSharpNoise(wrongVal), 'wrongVal', 'x'), /returns the fetched resource/);
});

test('assertTerminalGatedGet rejects a guard nested/unreachable and an unbound fetch (pass 43 finding #8)', () => {
  const fetch = 'var x = await this.store.GetAsync(id, ct); ';
  // UNBOUND: the returned/guarded variable is never assigned from an awaited GET — the dataflow
  // is not bound to a fetch, so the check fails closed.
  const unbound = 'if (x.Properties.Status.IsTerminal()) { return HttpResponseResult.Ok(x); } return HttpResponseResult.Accepted(x);';
  assert.throws(() => assertTerminalGatedGet(stripCSharpNoise(unbound), 'unbound', 'x'), /assigned from an AWAITED call/);

  // NESTED guard: the only IsTerminal() guard is inside another block (depth >= 1) — not a
  // direct terminal gate on the straight-line path.
  const nested = fetch + 'if (flag) { if (x.Properties.Status.IsTerminal()) { return HttpResponseResult.Ok(x); } } return HttpResponseResult.Accepted(x);';
  assert.throws(() => assertTerminalGatedGet(stripCSharpNoise(nested), 'nested', 'x'), /DIRECT \(depth-0\), reachable/);

  // UNREACHABLE guard: an early return makes the guard dead code; it must not be accepted.
  const dead = fetch + 'return HttpResponseResult.Accepted(x); if (x.Properties.Status.IsTerminal()) { return HttpResponseResult.Ok(x); }';
  assert.throws(() => assertTerminalGatedGet(stripCSharpNoise(dead), 'dead', 'x'), /DIRECT \(depth-0\), reachable/);
});

test('assertTerminalGatedGet rejects TWO producers and a nested/dead producer (pass 45 finding #4)', () => {
  // TWO awaited producers for the fetched var — an unrelated/dead second assignment could be
  // combined with the guard's consumption; require EXACTLY ONE producer.
  const twoProducers = 'var x = await this.store.GetAsync(id, ct); x = await this.store.GetAsync(other, ct); if (x.Status.IsTerminal()) { return HttpResponseResult.Ok(x); } return HttpResponseResult.Accepted(x);';
  assert.throws(() => assertTerminalGatedGet(stripCSharpNoise(twoProducers), 'two', 'x'), /EXACTLY ONE awaited producer/);

  // A NESTED (conditional) producer does not dominate the guard — the depth-0 producer check fails.
  const nestedProducer = 'if (flag) { var x = await this.store.GetAsync(id, ct); } if (x.Status.IsTerminal()) { return HttpResponseResult.Ok(x); } return HttpResponseResult.Accepted(x);';
  assert.throws(() => assertTerminalGatedGet(stripCSharpNoise(nestedProducer), 'nestedProducer', 'x'), /straight-line \(depth-0\) statement that dominates the guard/);
});

test('the backend cancel command extract authenticates idempotency + terminal no-op (VF8, VF9)', () => {
  // The GW CancelRunAsync forwards to the backend cancel handler; the idempotency /
  // terminal-no-op behavior lives in that BACKEND handler, so it is authenticated
  // against the backend extract's CONTROL FLOW (not merely token presence): the
  // handler reads the run state, then two EARLY-RETURN guards (terminal, then
  // already-Canceling) precede the single state transition, and nothing throws. This
  // binds the cancel/accept-202 fixture's "repeated cancellation is safe and terminal
  // runs no-op" claim to the reviewed source, per static inspection of the extract.
  const src = readExtract(sourceWithExtract(SOURCE_KEYS.cancelCommand).extract!);
  const handle = csharpDirectMethodBody(src, 'CancelScenarioRunCommandHandler', 'Handle');
  assert.ok(handle.length > 0, 'the backend cancel handler declares Handle');
  const struct = stripCSharpNoise(handle);

  // (1) The handler READS the current run state (GetAsync) and binds it to `run`. Finding #4
  // (pass 46, tightened pass 47): prove `run` comes from the REQUIRED, REACHABLE, AWAITED store
  // read — EXACTLY ONE producer whose awaited expression is DIRECTLY `(this.)?<field>.GetAsync(`
  // (no arbitrary text between `await` and `GetAsync`, so `run` cannot bind to an UNRELATED awaited
  // call while a separate store `GetAsync` sits elsewhere), AWAITED, at Handle-body DEPTH 0 (so it
  // dominates the guards). The producer's receiver is later required to be the DI-injected store.
  const runProducerRe = /(?<![A-Za-z0-9_])(?:var\s+|[A-Za-z_][\w.<>,?[\]]*\s+)?run\s*=\s*await\s+(this\s*\.\s*)?([A-Za-z_]\w*)\s*\.\s*GetAsync\s*\(/g;
  const runProducers = [...struct.matchAll(runProducerRe)];
  assert.equal(runProducers.length, 1, 'EXACTLY ONE awaited producer binds `run` DIRECTLY to a (this.)<field>.GetAsync store read (VF8/VF9, pass 47 finding #4)');
  const runProducerQualified = runProducers[0]![1] !== undefined;
  const runProducerReceiver = runProducers[0]![2]!;
  const readIdx = runProducers[0]!.index!;
  assert.ok(readIdx >= 0, 'the handler reads the run state into `run` via an awaited GetAsync before acting');
  // (1a) ARGS BOUND TO THE ASSIGNMENT (pass 48 finding #4): read the producer's OWN GetAsync
  // argument list (balanced parens from the producer match), so the args are proven on the SAME
  // call that binds `run` — not on a separate `csharpInvocation(GetAsync)` that could resolve a
  // DIFFERENT GetAsync elsewhere.
  const producerParenIdx = readIdx + runProducers[0]![0].length - 1;
  let apd = 0;
  let argEnd = -1;
  for (let j = producerParenIdx; j < struct.length; j++) {
    if (struct[j] === '(') apd++;
    else if (struct[j] === ')') { apd--; if (apd === 0) { argEnd = j; break; } }
  }
  assert.ok(argEnd > producerParenIdx, 'the run-producer GetAsync call has a balanced argument list');
  const producerArgsRaw = struct.slice(producerParenIdx + 1, argEnd);
  const producerArgList = producerArgsRaw.trim().length === 0 ? [] : splitTopLevelArgs(producerArgsRaw).map((a) => a.trim());
  assert.deepEqual(
    producerArgList,
    ['command.RunId', 'cancellationToken'],
    'the `run = await store.GetAsync(...)` producer reads EXACTLY (command.RunId, cancellationToken) — args bound to the assignment (VF8/VF9, pass 48 finding #4)',
  );
  // (1b) NO LATER OVERWRITE OF `run` (pass 48 finding #4, hardened pass 49 finding #4): `run` is
  // WRITTEN EXACTLY ONCE across ALL write forms — a plain/compound/coalescing assignment, a TUPLE
  // deconstruction, a `ref`/`out` argument, or an unsafe REF-RETURN write. Counting only plain
  // `run = …` (the prior check) let a tuple/ref/out/alias/compound/coalescing write silently
  // REPLACE the authenticated `run`, cancelling the WRONG resource.
  const runWrites = csharpLocalWriteIndices(struct, 'run');
  assert.equal(
    runWrites.length,
    1,
    '`run` is written EXACTLY ONCE across all write forms (plain/compound/coalescing/tuple/ref-out/ref-return) — no later overwrite that would transition/cancel the wrong resource (VF8/VF9, pass 49 finding #4)',
  );
  assert.ok(
    runWrites[0]! >= readIdx && runWrites[0]! < producerParenIdx,
    'the single `run` write IS the awaited-store-read producer (VF8/VF9, pass 49 finding #4)',
  );
  // Compute Handle-body depth once (used by the producer-dominance + mandatory-transition checks).
  const cancelDepthAt = new Array<number>(struct.length + 1);
  {
    let d = 0;
    for (let ci = 0; ci < struct.length; ci++) {
      cancelDepthAt[ci] = d;
      if (struct[ci] === '{') d++;
      else if (struct[ci] === '}') d--;
    }
    cancelDepthAt[struct.length] = d;
  }
  assert.equal(cancelDepthAt[readIdx], 0, 'the awaited store read is a straight-line (depth-0) statement that dominates the guards (VF8/VF9, pass 46 finding #4)');
  // The read is NOT inside an uncalled local function / lambda (which would not run in flow).
  assert.ok(!csharpEnclosedInLocalFunctionOrLambda(struct, readIdx), 'the store read is in the method straight-line flow (not an uncalled local function/lambda) (pass 46 finding #4)');

  // (2) TOP-LEVEL guards, in source order, each an EARLY RETURN (no-op path) AND a
  // DIRECT child of the Handle body (depth 0) — not buried in a wrapping block that
  // could reorder or conditionalize the no-op.
  const guards = csharpGuardedEarlyReturns(handle);
  // The TERMINAL guard applies the terminal predicate to the READ run's status. Require the
  // guard condition to be EXACTLY the POSITIVE predicate `run.Status.IsTerminal()` — an
  // INVERTED guard `!run.Status.IsTerminal()` (which would no-op the CANCELABLE runs and
  // transition the terminal ones) is rejected because its normalized condition differs.
  const terminalGuard = guards.find((g) => g.condition.replace(/\s+/g, '') === 'run.Status.IsTerminal()');
  assert.ok(terminalGuard, 'a guard tests EXACTLY run.Status.IsTerminal() (positive terminal predicate — not inverted)');
  assert.ok(terminalGuard!.returns, 'the terminal-status guard RETURNS early (terminal runs no-op, no transition)');
  assert.equal(terminalGuard!.depth, 0, 'the terminal guard is a DIRECT child of Handle (depth 0), not nested in a block');
  assert.equal(terminalGuard!.elseIf, false, 'the terminal guard is an UNCONDITIONAL if (not an else-if branch)');
  // Also assert NO inverted terminal predicate anywhere in the guards (defense in depth).
  assert.ok(
    !guards.some((g) => /!\s*run\s*\.\s*Status\s*\.\s*IsTerminal/.test(g.condition)),
    'no guard uses an INVERTED !run.Status.IsTerminal() predicate (which would invert the no-op)',
  );
  // The IDEMPOTENCY guard tests the read run's status == Canceling (EXACTLY, not != or nested).
  const cancelingGuard = guards.find((g) => g.condition.replace(/\s+/g, '') === 'run.Status==ScenarioRunState.Canceling');
  assert.ok(cancelingGuard, 'a guard tests EXACTLY run.Status == ScenarioRunState.Canceling (already-canceling)');
  assert.ok(cancelingGuard!.returns, 'the already-Canceling guard RETURNS early (repeat cancel is idempotent no-op)');
  assert.equal(cancelingGuard!.depth, 0, 'the already-Canceling guard is a DIRECT child of Handle (depth 0)');
  assert.equal(cancelingGuard!.elseIf, false, 'the already-Canceling guard is an UNCONDITIONAL if (not an else-if branch)');
  // Exactly two direct UNCONDITIONAL early-return guards precede the transition — no extra
  // hidden branch, and neither is an else-if (which would run only on a prior branch).
  const directReturningGuards = guards.filter((g) => g.depth === 0 && g.returns && !g.elseIf);
  assert.equal(directReturningGuards.length, 2, 'exactly two direct UNCONDITIONAL early-return guards (terminal + already-Canceling)');

  // (3) EXACTLY ONE state transition and EXACTLY ONE persistence, both AFTER both guards
  // (branch ordering): a cancelable run transitions to Canceling once and is updated
  // once; terminal/already-canceling runs never reach either because their guards
  // returned first. Counting (not first-match) proves there is no second transition or
  // update on another path.
  const transitionRe = /(?<![A-Za-z0-9_])run\s*\.\s*TransitionTo\s*\(\s*ScenarioRunState\s*\.\s*Canceling\s*\)/g;
  const transitions = [...struct.matchAll(transitionRe)];
  assert.equal(transitions.length, 1, 'exactly one run.TransitionTo(Canceling) (the single cancel state change)');
  const transitionIdx = transitions[0]!.index!;
  const updateRe = /(?<![A-Za-z0-9_])UpdateAsync\s*\(/g;
  const updates = [...struct.matchAll(updateRe)];
  assert.equal(updates.length, 1, 'exactly one store UpdateAsync (the single persistence of the transition)');
  const updateIdx = updates[0]!.index!;
  assert.ok(readIdx < terminalGuard!.index && readIdx < cancelingGuard!.index, 'the state read precedes both guards');
  assert.ok(
    terminalGuard!.index < transitionIdx && cancelingGuard!.index < transitionIdx,
    'both early-return guards precede the transition (terminal/idempotent no-op takes effect before any state change)',
  );
  assert.ok(transitionIdx < updateIdx, 'the transition is persisted AFTER it is applied (TransitionTo precedes UpdateAsync)');

  // (3a) MANDATORY-AFTER-GUARDS (pass 45 finding #5): the transition AND the update must be
  // STRAIGHT-LINE at Handle-body DEPTH 0 and NOT governed by a braceless control header — so on
  // the fall-through path (both no-op guards returned) they EXECUTE UNCONDITIONALLY. A
  // transition/update nested in a FURTHER conditional (`if (cond) { run.TransitionTo(...); … }`)
  // would pass the ordering + count checks yet not be mandatory; the depth-0 + no-braceless-guard
  // check rejects it. (`cancelDepthAt` was computed above, at the run-read binding.)
  const mandatoryStraightLine = (idx: number, what: string): void => {
    assert.equal(cancelDepthAt[idx], 0, `the cancel ${what} is at Handle-body DEPTH 0 (not nested in a further conditional block) — mandatory after the no-op guards (VF8/VF9, pass 45 finding #5)`);
    // The statement must NOT sit inside an uncalled LOCAL FUNCTION / LAMBDA / DELEGATE body — an
    // expression-bodied local function `void DoCancel() => run.TransitionTo(Canceling);` is at
    // brace-depth 0 and has no braceless control prefix, yet never runs unless invoked, so it must
    // not satisfy the mandatory-transition check (pass 46 finding #5).
    assert.ok(
      !csharpEnclosedInLocalFunctionOrLambda(struct, idx),
      `the cancel ${what} is part of the method straight-line flow, not an uncalled local function/lambda (VF8/VF9, pass 46 finding #5)`,
    );
    // The statement prefix (from the nearest depth-0 boundary `;`/`{`/`}` to the statement) must
    // not begin with a control keyword (a braceless `if (c) run.TransitionTo(...)` is conditional).
    let bd = 0;
    let start = 0;
    for (let bi = idx - 1; bi >= 0; bi--) {
      const c = struct[bi]!;
      if (c === ')' || c === ']') bd++;
      else if (c === '(' || c === '[') { if (bd > 0) bd--; }
      else if (bd === 0 && (c === ';' || c === '{' || c === '}')) { start = bi + 1; break; }
    }
    const prefix = struct.slice(start, idx).trim();
    assert.ok(
      !/^(?:else\s+)?if\b/.test(prefix) && !/^(?:while|for|foreach|switch|lock|using|fixed|else|do)\b/.test(prefix),
      `the cancel ${what} is not governed by a braceless conditional header — it runs unconditionally on the fall-through (VF8/VF9, pass 45 finding #5)`,
    );
    // A `goto`/label between the last guard and this statement could skip or re-enter it, so a
    // `goto` anywhere in the Handle body defeats the mandatory-straight-line proof (pass 46 #5/#7).
    assert.ok(
      !/(?<![A-Za-z0-9_])goto(?![A-Za-z0-9_])/.test(struct),
      `the cancel handler uses no goto (which could bypass the ${what}) (VF8/VF9, pass 46 finding #5)`,
    );
  };
  mandatoryStraightLine(transitionIdx, 'transition (run.TransitionTo(Canceling))');
  mandatoryStraightLine(updateIdx, 'persistence (UpdateAsync)');
  // No THIRD control block may sit between the last no-op guard and the transition (which would
  // make the transition conditional on that block's path). The two guards are the only depth-0
  // early-return `if`s; any other depth-0 `if`/loop before the transition is rejected.
  const lastGuardIdx = Math.max(terminalGuard!.index, cancelingGuard!.index);
  const controlBetween = /(?<![A-Za-z0-9_])(?:if|while|for|foreach|switch)\s*\(/g;
  let cb: RegExpExecArray | null;
  while ((cb = controlBetween.exec(struct)) !== null) {
    if (cb.index <= lastGuardIdx || cb.index >= transitionIdx) continue;
    if (cancelDepthAt[cb.index] !== 0) continue; // nested control is inside a guard block already
    assert.fail(`an extra depth-0 control block sits between the no-op guards and the transition — the transition would be conditional (VF8/VF9, pass 45 finding #5); found '${struct.slice(cb.index, cb.index + 20)}'`);
  }

  // (3d) DOMINANCE over EVERY exit path (pass 52 finding #5): the prior checks proved the
  // transition and update are depth-0 and not under a braceless conditional, but a NESTED `return`/
  // `throw` — inside a `try`/`using`/`lock` block, or simply between the TRANSITION and the UPDATE
  // (which `controlBetween`, scanning only if/while/for/foreach/switch up to the transition, never
  // saw) — could still bypass the transition or the persistence on some path. Require the region
  // from the LAST no-op guard's early return through the persistence to be STRAIGHT-LINE (no
  // method-level return/throw/yield and no branch/exception/scope control construct), so BOTH the
  // transition and the update DOMINATE the method exit on the fall-through path.
  let guardReturnEnd = lastGuardIdx;
  {
    const retRe = /(?<![A-Za-z0-9_])return(?![A-Za-z0-9_])/g;
    retRe.lastIndex = lastGuardIdx;
    const rm = retRe.exec(struct);
    if (rm) {
      const semi = struct.indexOf(';', rm.index);
      guardReturnEnd = semi >= 0 ? semi + 1 : rm.index + 'return'.length;
    }
  }
  assert.ok(guardReturnEnd < transitionIdx, 'the last no-op guard returns before the transition');
  assert.ok(
    !csharpRegionHasBypassingControl(struct, guardReturnEnd, updateIdx),
    'no nested return/throw or branch/try/using/lock construct sits between the no-op guards and the persistence — the transition AND the update DOMINATE every method exit on the fall-through path (VF8/VF9, pass 52 finding #5)',
  );
  // (3b) The persistence is RECEIVER-BOUND to the DI-injected run store (not a bare
  // method-name match): the handler injects EXACTLY ONE IScenarioRunStore field, both the
  // state READ (GetAsync) and the WRITE (UpdateAsync) are invoked on that this.-qualified
  // field, and UpdateAsync forwards EXACTLY (run, cancellationToken) — persisting the
  // transitioned run. This binds the cancel persistence to the injected store, closing the
  // gap where any `X.UpdateAsync(` textual match would satisfy the check (VF8, VF9).
  const runStoreFields = Object.entries(csharpInjectedFields(src, 'CancelScenarioRunCommandHandler')).filter(
    ([, f]) => f.type === 'IScenarioRunStore',
  );
  assert.equal(runStoreFields.length, 1, 'the cancel handler injects exactly one IScenarioRunStore field (VF8, VF9)');
  const storeField = runStoreFields[0]![0];
  const getCall = csharpInvocation(handle, 'GetAsync');
  assert.ok(getCall && getCall.qualified && getCall.receiver === storeField, 'the state READ (GetAsync) is invoked on the DI-injected run store (receiver-bound)');
  assert.deepEqual(getCall!.argList, ['command.RunId', 'cancellationToken'], 'GetAsync reads EXACTLY (command.RunId, cancellationToken) — the run named by the command');
  // The `run` ASSIGNMENT itself must await THIS store read: its awaited-expression receiver is the
  // this.-qualified DI-injected store field (not an unrelated awaited call followed by a separate
  // injected-store GetAsync elsewhere) (pass 47 finding #4).
  assert.ok(runProducerQualified, 'the `run` assignment awaits a this.-qualified store read (VF8/VF9, pass 47 finding #4)');
  assert.equal(runProducerReceiver, storeField, 'the `run` assignment awaits the EXACT DI-injected store field.GetAsync (the read that produces `run` IS the injected-store read) (VF8/VF9, pass 47 finding #4)');
  const updateCall = csharpInvocation(handle, 'UpdateAsync');
  assert.ok(updateCall, 'the cancel handler persists via a parsed UpdateAsync call');
  assert.ok(updateCall!.qualified && updateCall!.receiver === storeField, 'UpdateAsync is invoked on the DI-injected run store field (receiver-bound, VF8/VF9)');
  assert.deepEqual(updateCall!.argList, ['run', 'cancellationToken'], 'UpdateAsync persists EXACTLY (run, cancellationToken) — the transitioned run');
  assert.ok(updateCall!.awaited, 'the persistence is AWAITED (await this.runStore.UpdateAsync(...)) — not fire-and-forget (VF8/VF9)');
  // The cancel persistence is intentionally GUARDED (it runs only after the terminal/already-
  // canceling early-return guards fall through), so it does NOT dominate the method exit — the
  // dominance-aware `unconditional` correctly reports false here. The guarded PROCEED path is
  // validated by the guard + single-transition + ordering checks above, not by dominance.
  assert.equal(updateCall!.unconditional, false, 'the cancel persistence is guarded by the early-return no-op guards (not exit-dominating) (pass 44 finding #6)');

  // (4) No throw on any inspected path — cancel is accepted regardless of state.
  assert.ok(
    !csharpReferencesIdentifier(handle, ['throw']),
    'the inspected cancel handler body names no throw (accepted regardless of state)',
  );
});

test('the IsTerminal predicate extract authenticates EXACTLY the terminal run states (VF7, VF8)', () => {
  // The cancel handler's terminal-no-op guard calls run.Status.IsTerminal(); this test
  // authenticates the PREDICATE ITSELF (not merely its call site) against the reviewed
  // ScenarioRunStateExtensions extract, so the set of states that no-op a cancel is
  // pinned to the source — it must be exactly Succeeded/Failed/Canceled (the terminal
  // run states), with Canceling and every advancing state NON-terminal.
  const src = readExtract(sourceWithExtract(SOURCE_KEYS.runIsTerminal).extract!);
  // Require EXACTLY ONE ScenarioRunStateExtensions.IsTerminal(this ScenarioRunState) method
  // — scoped to the class and the exact extension-receiver signature, so a same-named
  // method in another class or a different overload cannot be authenticated in its place.
  const bodies = csharpExtensionMethodBodies(src, 'ScenarioRunStateExtensions', 'IsTerminal', 'ScenarioRunState');
  assert.equal(
    bodies.length,
    1,
    'the extract declares EXACTLY ONE ScenarioRunStateExtensions.IsTerminal(this ScenarioRunState) method',
  );
  const body = bodies[0]!.body;
  const receiver = bodies[0]!.receiverParam;
  const receiverRe = receiver.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const struct = stripCSharpNoise(body);

  // The states the predicate compares `state` against, in the extracted body.
  const compared = new Set<string>();
  const cmpRe = /ScenarioRunState\s*\.\s*([A-Za-z_]\w*)/g;
  let cm: RegExpExecArray | null;
  while ((cm = cmpRe.exec(struct)) !== null) compared.add(cm[1]!);

  const expectedTerminal = new Set<string>([...RUN_TERMINAL_SUCCESS, ...RUN_TERMINAL_FAILURE]);
  assert.deepEqual(
    [...compared].sort(),
    [...expectedTerminal].sort(),
    'IsTerminal returns true for EXACTLY the terminal run states (Succeeded/Failed/Canceled)',
  );
  // Canceling (a cancel in progress) is explicitly NOT terminal, so a run being canceled
  // still polls 202 and a repeated cancel is the idempotency guard's job, not a no-op here.
  assert.ok(!compared.has('Canceling'), 'Canceling is NOT terminal (cancel still in progress)');
  // The predicate is a pure disjunction of equality checks (no throw / side effect).
  assert.ok(!csharpReferencesIdentifier(body, ['throw']), 'the IsTerminal predicate names no throw');

  // The COMPLETE body must be ONE UNCONDITIONAL return statement — not merely a first
  // return among others. A preceding guard or any second statement would introduce a
  // conditional path, so require the whole (comment-blanked) body to be a single
  // `return <expr>;` with EXACTLY ONE statement terminator and no control-flow keyword.
  const trimmedBody = struct.trim();
  const single = /^return\b([\s\S]*);$/.exec(trimmedBody);
  assert.ok(single, 'the complete body is a single return statement');
  assert.equal(
    (trimmedBody.match(/;/g) ?? []).length,
    1,
    'the body is a SINGLE statement (exactly one ; — the return terminator; no guard or second statement)',
  );
  assert.ok(
    !/(?<![A-Za-z0-9_])(?:if|else|switch|case|for|while|do|goto|try|catch|finally)(?![A-Za-z0-9_])/.test(trimmedBody),
    'the body contains no conditional/branch/loop statement (unconditional return only)',
  );

  // Authenticate the predicate's MEANING and OPERATORS, not just the compared states:
  // the return expr is a DISJUNCTION (`||`) of EQUALITY (`==`) comparisons
  // `<receiver> == ScenarioRunState.<Terminal>` — so IsTerminal is TRUE exactly for the
  // terminal set. A `!=`, `&&`, `!`, or ternary would invert/narrow the meaning.
  const expr = single![1]!.trim();
  const eqCount = (expr.match(/==/g) ?? []).length;
  const orCount = (expr.match(/\|\|/g) ?? []).length;
  assert.equal(eqCount, expectedTerminal.size, 'the predicate compares each terminal state with == (one per state)');
  assert.equal(orCount, expectedTerminal.size - 1, 'the terminal comparisons are OR-joined (a disjunction over the states)');
  assert.ok(!/(!=|&&)/.test(expr), 'the predicate uses no != or && (no inverted/conjunctive meaning)');
  assert.ok(!/(?<![=!<>])!(?!=)/.test(expr), 'the predicate applies no logical-NOT that would invert the result');
  assert.ok(!/[?]/.test(expr), 'the return expression is unconditional (no ternary)');
  // Bind EVERY comparison to the EXTENSION RECEIVER parameter (captured from the exact
  // signature), not merely a literal named `state`: the LHS of each `==` must be it.
  const cmpOperands = [...expr.matchAll(/([A-Za-z_]\w*)\s*==\s*ScenarioRunState\s*\.\s*[A-Za-z_]\w*/g)];
  assert.equal(cmpOperands.length, expectedTerminal.size, 'every == compares an operand to a ScenarioRunState member');
  for (const c of cmpOperands) {
    assert.equal(c[1], receiver, `each equality tests the extension receiver parameter '${receiver}' (not some other operand)`);
  }
  // STRUCTURAL full-expression enforcement: the ENTIRE return expression must be nothing
  // but an OR-chain of `<receiver> == ScenarioRunState.<Member>` terms (optionally
  // parenthesized) — no extra operands, function calls, or hidden operators between checks.
  const compact = expr.replace(/\s+/g, '');
  const termRe = '\\(*' + receiverRe + '==ScenarioRunState\\.[A-Za-z_]\\w*\\)*';
  const chainRe = new RegExp('^' + termRe + '(?:\\|\\|' + termRe + ')*$');
  assert.ok(
    chainRe.test(compact),
    `IsTerminal body must be EXACTLY an ||-chain of ${receiver}==ScenarioRunState.<X> terms; got: ${compact}`,
  );
});

test('the validation IsTerminal predicate extract authenticates EXACTLY the terminal validation states (VF3)', () => {
  // GetLatestValidationAsync branches on validation.Properties.Status.IsTerminal() to
  // return 200 (terminal) vs 202 (in progress). This authenticates the PREDICATE ITSELF
  // against the reviewed ScenarioValidationStateExtensions extract, pinning the contract's
  // VALIDATION_TERMINAL_SUCCESS + VALIDATION_TERMINAL_FAILURE sets to the source — it must
  // be exactly Succeeded (terminal success) + RequiresAttention + NoResolvedResources
  // (terminal failures), with every advancing state (Resolving/Generating/Validating/
  // Accepted/NotStarted) NON-terminal.
  const src = readExtract(sourceWithExtract(SOURCE_KEYS.validationIsTerminal).extract!);
  // Require EXACTLY ONE ScenarioValidationStateExtensions.IsTerminal(this ScenarioValidationState)
  // method — scoped to the class and the extension-receiver signature, so a same-named
  // method in another class or a different overload cannot be authenticated in its place.
  const bodies = csharpExtensionMethodBodies(
    src,
    'ScenarioValidationStateExtensions',
    'IsTerminal',
    'ScenarioValidationState',
  );
  assert.equal(
    bodies.length,
    1,
    'the extract declares EXACTLY ONE ScenarioValidationStateExtensions.IsTerminal(this ScenarioValidationState) method',
  );
  const body = bodies[0]!.body;
  const receiver = bodies[0]!.receiverParam;
  const receiverRe = receiver.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const struct = stripCSharpNoise(body);

  // The states the predicate compares `state` against, in the extracted body.
  const compared = new Set<string>();
  const cmpRe = /ScenarioValidationState\s*\.\s*([A-Za-z_]\w*)/g;
  let cm: RegExpExecArray | null;
  while ((cm = cmpRe.exec(struct)) !== null) compared.add(cm[1]!);

  const expectedTerminal = new Set<string>([...VALIDATION_TERMINAL_SUCCESS, ...VALIDATION_TERMINAL_FAILURE]);
  assert.deepEqual(
    [...compared].sort(),
    [...expectedTerminal].sort(),
    'validation IsTerminal returns true for EXACTLY the terminal validation states (Succeeded/RequiresAttention/NoResolvedResources)',
  );
  // Every advancing validation state is explicitly NOT terminal (still polls 202).
  for (const advancing of ['Resolving', 'Generating', 'Validating', 'Accepted', 'NotStarted']) {
    assert.ok(!compared.has(advancing), `${advancing} is NOT terminal (validation still in progress)`);
  }
  // The predicate is a pure disjunction of equality checks (no throw / side effect).
  assert.ok(!csharpReferencesIdentifier(body, ['throw']), 'the validation IsTerminal predicate names no throw');

  // The COMPLETE body must be ONE UNCONDITIONAL return statement — not merely a first
  // return among others. A preceding guard (`if (...) return ...;`) or any second
  // statement would introduce a conditional path, so require the whole (comment-blanked)
  // body to be a single `return <expr>;` with EXACTLY ONE statement terminator.
  const trimmedBody = struct.trim();
  const single = /^return\b([\s\S]*);$/.exec(trimmedBody);
  assert.ok(single, 'the complete body is a single return statement');
  assert.equal(
    (trimmedBody.match(/;/g) ?? []).length,
    1,
    'the body is a SINGLE statement (exactly one ; — the return terminator; no guard or second statement)',
  );
  // No control-flow keyword anywhere in the body (defense in depth beyond the ; count).
  assert.ok(
    !/(?<![A-Za-z0-9_])(?:if|else|switch|case|for|while|do|goto|try|catch|finally)(?![A-Za-z0-9_])/.test(trimmedBody),
    'the body contains no conditional/branch/loop statement (unconditional return only)',
  );

  // Authenticate the predicate's MEANING and OPERATORS: the single return expr must be a
  // DISJUNCTION (`||`) of EQUALITY (`==`) comparisons against ScenarioValidationState
  // members, with no inverting/narrowing operators.
  const expr = single![1]!.trim();
  const eqCount = (expr.match(/==/g) ?? []).length;
  const orCount = (expr.match(/\|\|/g) ?? []).length;
  assert.equal(eqCount, expectedTerminal.size, 'the predicate compares each terminal state with == (one per state)');
  assert.equal(orCount, expectedTerminal.size - 1, 'the terminal comparisons are OR-joined (a disjunction over the states)');
  assert.ok(!/(!=|&&)/.test(expr), 'the predicate uses no != or && (no inverted/conjunctive meaning)');
  assert.ok(!/(?<![=!<>])!(?!=)/.test(expr), 'the predicate applies no logical-NOT that would invert the result');
  assert.ok(!/[?]/.test(expr), 'the return expression is unconditional (no ternary)');
  // Bind EVERY comparison to the EXTENSION RECEIVER parameter (captured from the exact
  // signature), not merely a literal named `state`: the LHS of each `==` must be the
  // receiver identifier, so the predicate genuinely tests the input value.
  const cmpOperands = [...expr.matchAll(/([A-Za-z_]\w*)\s*==\s*ScenarioValidationState\s*\.\s*[A-Za-z_]\w*/g)];
  assert.equal(cmpOperands.length, expectedTerminal.size, 'every == compares an operand to a ScenarioValidationState member');
  for (const c of cmpOperands) {
    assert.equal(c[1], receiver, `each equality tests the extension receiver parameter '${receiver}' (not some other operand)`);
  }
  // STRUCTURAL full-expression enforcement: EXACTLY an ||-chain of
  // `<receiver> == ScenarioValidationState.<Member>` terms — nothing else.
  const compact = expr.replace(/\s+/g, '');
  const termRe = '\\(*' + receiverRe + '==ScenarioValidationState\\.[A-Za-z_]\\w*\\)*';
  const chainRe = new RegExp('^' + termRe + '(?:\\|\\|' + termRe + ')*$');
  assert.ok(
    chainRe.test(compact),
    `validation IsTerminal body must be EXACTLY an ||-chain of ${receiver}==ScenarioValidationState.<X> terms; got: ${compact}`,
  );
});

/**
 * Fails if the C# uses ANY conditional-request HEADER NAME as a HEADER-API ARGUMENT or INDEXER
 * KEY. Uses {@link csharpConditionalRequestHeaderArg}, which decodes REGULAR, VERBATIM
 * (`@"..."`), and RAW (`"""..."""`) literals and joins top-level `+` CONCATENATIONS (so an
 * escaped, verbatim, raw, or split spelling `"If-" + "Match"` cannot hide the header name) AND
 * binds it to an argument / indexer position (`headers.Add("If-Match", …)`,
 * `headers["If-Match"]`), so a header name in a log message or an unrelated assignment is not a
 * false positive. Header-name matching is case-insensitive. The property/identifier forms
 * (`IfMatch`/`ETag`/…) are covered separately by the caller's `csharpReferencesIdentifier` checks.
 */
function assertNoConditionalRequestHeaderString(csharp: string, label: string): void {
  const used = csharpConditionalRequestHeaderArg(csharp);
  assert.ok(
    used === null,
    `${label} uses conditional-request header "${used}" as a header-API argument/indexer key (VF4 — decoded/verbatim/raw/concatenated, header-API-bound check)`,
  );
}

/** The conditional-request CODE IDENTIFIERS (including canonical named header constants such as
 *  `HeaderNames.IfMatch` / `HttpRequestHeader.IfMatch` and their leaf member names, plus common
 *  ENUM-member spellings so an enum alias like `HttpRequestHeader.IfRange` is caught via its leaf)
 *  that must be absent from a precondition-free flow. */
const CONDITIONAL_REQUEST_IDENTIFIERS = ['IfMatch', 'IfNoneMatch', 'IfUnmodifiedSince', 'IfModifiedSince', 'IfRange', 'ETag', 'Etag', 'eTag', 'PreconditionFailed'];

/**
 * COMPREHENSIVE conditional-request absence check (pass 44 finding #8, extended pass 45 finding
 * #8). Asserts the extract has NO conditional-request handling via ANY channel, so no single
 * caller can omit a detector: (1) CODE IDENTIFIERS — the conditional-request member/leaf names
 * (which also catch a NAMED header constant like `HeaderNames.IfMatch` or an ENUM alias
 * `HttpRequestHeader.IfMatch` via its leaf) plus any caller-specific `extraIdentifiers`; (2) a
 * conditional-request HEADER NAME used as a header-API argument/indexer key (string form,
 * decoded/verbatim/raw/concatenated); (3) a conditional-request HEADER NAME bound to a STRING
 * CONSTANT / VARIABLE ALIAS — a standalone literal whose full value equals a header, in any
 * position; and (4) an HTTP 412 status — symbolic, the canonical
 * `StatusCodes.Status412PreconditionFailed`, a computed cast/call/shift 412, or a status operand
 * with an UNSUPPORTED constant operator (XOR `^`, treated conservatively as a possible 412). A
 * method-body extract passes its full file as `resolutionSource` so a bare `HttpStatusCode`
 * resolves.
 */
function assertNoConditionalRequest(
  csharp: string,
  label: string,
  opts: { extraIdentifiers?: readonly string[]; resolutionSource?: string } = {},
): void {
  assert.ok(
    !csharpReferencesIdentifier(csharp, [...CONDITIONAL_REQUEST_IDENTIFIERS, ...(opts.extraIdentifiers ?? [])]),
    `${label} references no conditional-request identifier in CODE (VF4 — includes named header constants + enum aliases)`,
  );
  assertNoConditionalRequestHeaderString(csharp, label);
  const constLit = csharpConditionalRequestHeaderLiteral(csharp);
  assert.ok(
    constLit === null,
    `${label} binds conditional-request header "${constLit}" to a string constant/variable alias (VF4 — standalone-literal check, pass 45 finding #8)`,
  );
  const composed = csharpComposedConditionalRequestHeader(csharp);
  assert.ok(
    composed === null,
    `${label} COMPOSES conditional-request header "${composed}" from a string-constant alias + literal concatenation (VF4 — composed-alias check, pass 47 finding #6)`,
  );
  assert.ok(
    !csharpReferencesHttp412(csharp, opts.resolutionSource),
    `${label} never returns/maps HTTP 412 — symbolic / StatusCodes.Status412PreconditionFailed / computed / XOR-conservative (VF4)`,
  );
}

test('VF4 end-to-end call chain: controller -> command -> store overwrite, no conditional-request path', () => {
  // Controller: the validate action returns 202 and dispatches the command; there
  // is no conditional-request handling and no evaluation short-circuit.
  const controller = readExtract(sourceWithExtract(SOURCE_KEYS.configController).extract!);
  const validate = csharpDirectMethodBody(controller, 'ScenarioConfigurationsController', 'Validate');
  assert.ok(validate.length > 0, 'the controller declares a Validate action');
  // Match against the comment/literal-stripped view so a decoy in a comment/string cannot
  // satisfy the command-dispatch assertion, and require it to be a parsed invocation: the
  // command is built via `StartScenarioValidationCommand.FromRoute(route)`, so assert a
  // parsed `FromRoute` call whose RECEIVER is exactly StartScenarioValidationCommand.
  assert.match(stripCSharpNoise(validate), /StartScenarioValidationCommand\s*\.\s*FromRoute\s*\(/, 'validate dispatches the validation command');
  const cmdCall = csharpInvocation(validate, 'FromRoute');
  assert.ok(cmdCall, 'validate builds the command via a parsed FromRoute call');
  assert.equal(cmdCall!.receiver, 'StartScenarioValidationCommand', 'the parsed command-build call receiver is exactly StartScenarioValidationCommand');
  assert.ok(httpStatusCodes(validate, controller).includes('Accepted'), 'the controller returns 202 Accepted');
  // No conditional-request handling via ANY channel (comprehensive detector).
  assertNoConditionalRequest(controller, 'the controller');

  // Command handler: resolves and UPSERTS validations/latest (overwrite in place). Bind the
  // upsert to the DI-injected store field (not a bare method-name match): the handler
  // injects exactly one IScenarioValidationStore field, UpsertLatestAsync is invoked ON that
  // this.-qualified field, and it forwards EXACTLY (command.Configuration, validation,
  // cancellationToken) — an executable, receiver-bound overwrite.
  const command = readExtract(sourceWithExtract(SOURCE_KEYS.validationCommand).extract!);
  const handle = csharpDirectMethodBody(command, 'StartScenarioValidationCommandHandler', 'Handle');
  const storeFields = Object.entries(csharpInjectedFields(command, 'StartScenarioValidationCommandHandler')).filter(
    ([, f]) => f.type === 'IScenarioValidationStore',
  );
  assert.equal(storeFields.length, 1, 'the handler injects exactly one IScenarioValidationStore field (VF4)');
  const upsertLatest = csharpInvocation(handle, 'UpsertLatestAsync');
  assert.ok(upsertLatest, 'the handler upserts validations/latest via a parsed UpsertLatestAsync call (overwrite)');
  assert.ok(upsertLatest!.qualified && upsertLatest!.receiver === storeFields[0]![0], 'UpsertLatestAsync is invoked on the DI-injected validation store field (receiver-bound, VF4)');
  assert.deepEqual(upsertLatest!.argList, ['command.Configuration', 'validation', 'cancellationToken'], 'UpsertLatestAsync forwards EXACTLY (command.Configuration, validation, cancellationToken) — unconditional overwrite (VF4)');
  assert.ok(upsertLatest!.awaited, 'UpsertLatestAsync is AWAITED (await this.validationStore.UpsertLatestAsync(...)) — not fire-and-forget (pass 43 finding #7)');
  assert.ok(upsertLatest!.unconditional, 'UpsertLatestAsync is an UNCONDITIONAL straight-line statement (not conditional/braceless-dead) (pass 43 finding #7)');

  // Store: the upsert takes no conditional-update / version parameter. Bind UpsertAsync to
  // the injected IDocumentContainer field, forwarding EXACTLY (document, cancellationToken).
  const store = readExtract(sourceWithExtract(SOURCE_KEYS.validationStore).extract!);
  const upsertBody = csharpDirectMethodBody(store, 'ScenarioValidationStore', 'UpsertLatestAsync');
  assert.ok(upsertBody.length > 0, 'the store declares UpsertLatestAsync');
  const containerFields = Object.entries(csharpInjectedFields(store, 'ScenarioValidationStore')).filter(
    ([, f]) => f.type === 'IDocumentContainer',
  );
  assert.equal(containerFields.length, 1, 'the store injects exactly one IDocumentContainer field (VF4)');
  const upsertAsync = csharpInvocation(upsertBody, 'UpsertAsync');
  assert.ok(upsertAsync, 'the store performs a parsed unconditional UpsertAsync call');
  assert.ok(upsertAsync!.qualified && upsertAsync!.receiver === containerFields[0]![0], 'UpsertAsync is invoked on the DI-injected document container (receiver-bound, VF4)');
  assert.deepEqual(upsertAsync!.argList, ['document', 'cancellationToken'], 'UpsertAsync forwards EXACTLY (document, cancellationToken) — no conditional-update/version arg (VF4)');
  assert.ok(upsertAsync!.awaited, 'UpsertAsync is AWAITED (await this.container.UpsertAsync(...)) — not fire-and-forget (pass 43 finding #7)');
  assert.ok(upsertAsync!.unconditional, 'UpsertAsync is an UNCONDITIONAL straight-line statement (not conditional/braceless-dead) (pass 43 finding #7)');
  assert.ok(
    !csharpReferencesIdentifier(store, ['RowVersion', 'AccessCondition']),
    'the validation store references no conditional-update concurrency identifier in CODE (VF4)',
  );
  // No conditional-request handling via ANY channel; the store's extra concurrency identifiers are
  // folded into the comprehensive detector.
  assertNoConditionalRequest(store, 'the validation store', { extraIdentifiers: ['RowVersion', 'AccessCondition'] });

  // Exception mapper: no PreconditionFailed / 412 is mapped anywhere in the flow — checked
  // both symbolically and as a COMPUTED numeric 412 (a `(HttpStatusCode)412`/`StatusCode(412)`
  // that a raw `.includes('PreconditionFailed')` would miss).
  const mapper = readExtract(sourceWithExtract(SOURCE_KEYS.exceptionMapper).extract!);
  const mapBody = csharpDirectMethodBody(mapper, 'WorkspacesExceptionMapper', 'Map');
  assert.ok(mapBody.length > 0, 'the exception mapper declares Map');
  // The exception mapper previously checked only 412; it now runs the COMPREHENSIVE detector so a
  // conditional-request identifier / named header constant / header-string that maps to a
  // precondition failure cannot slip past this caller (pass 44 finding #8).
  assertNoConditionalRequest(mapBody, 'the exception mapper', { resolutionSource: mapper });
});

test('VF11 end-to-end call chain: no evaluation prerequisite and no 409-evaluation path', () => {
  // Binds a delegated call to the DI-injected dependency it is issued on: proves the
  // caller injects exactly one field of `ifaceType`, that `method` is invoked ON that
  // field (receiver-bound), and that the call forwards the caller's configuration +
  // cancellation token. Returns the bound field name. This makes the chain
  // receiver-authenticated end to end, not a set of bare method-name matches.
  const assertReceiverBoundCall = (
    callerExtractText: string,
    callerClass: string,
    callerBody: string,
    method: string,
    ifaceType: string,
    expectedArgs: readonly string[],
  ): string => {
    // Scope injected-field discovery to EXACTLY the caller's class, so a decoy class in the
    // same extract cannot supply a same-typed field the real caller does not declare.
    const injected = Object.entries(csharpInjectedFields(callerExtractText, callerClass)).filter(
      ([, f]) => f.type === ifaceType,
    );
    assert.equal(injected.length, 1, `exactly one field is constructor-injected as ${ifaceType} in ${callerClass} (VF11)`);
    const [fieldName] = injected[0]!;
    const call = csharpInvocation(callerBody, method);
    assert.ok(call, `${method} is invoked in the caller body (VF11)`);
    // The call must be `this.`-QUALIFIED to the injected field, so a bare shadowing
    // local cannot impersonate it.
    assert.ok(call!.qualified, `${method} is invoked on a this.-qualified receiver (VF11)`);
    assert.equal(
      call!.receiver,
      fieldName,
      `${method} is invoked on the DI-injected ${ifaceType} field '${fieldName}' (receiver-bound, VF11)`,
    );
    // Exact argument forwarding: the COMPLETE argument list must be exactly
    // `expectedArgs` in order (whitespace-normalized), not merely "contains
    // configuration/cancellationToken" — a partial/extra/reordered call is rejected.
    assert.deepEqual(
      call!.argList.map((x) => x.replace(/\s+/g, '')),
      expectedArgs.map((x) => x.replace(/\s+/g, '')),
      `${method} forwards EXACTLY (${expectedArgs.join(', ')}) (VF11)`,
    );
    return fieldName;
  };

  // Both BE command handlers resolve with a null evaluation snapshot, proven by
  // the resolver's own signature (the parameter is nullable and accepts null).
  const resolver = readExtract(sourceWithExtract(SOURCE_KEYS.resolver).extract!);
  // Assert the signature against the comment/literal-stripped view so a decoy in a
  // comment cannot satisfy the nullable-snapshot claim.
  const resolverCode = stripCSharpNoise(resolver);
  assert.match(resolverCode, /ResolveAsync/, 'the resolver declares ResolveAsync');
  assert.match(
    resolverCode,
    /EvaluationSnapshot\?\s+evaluationSnapshot/,
    'the resolver accepts a NULLABLE evaluation snapshot (null is valid, VF11)',
  );
  const resolveBody = csharpDirectMethodBody(resolver, 'ResourceSelectorResolver', 'ResolveAsync');
  assert.ok(resolveBody.length > 0, 'the resolver declares a ResolveAsync body');
  assert.ok(
    !csharpReferencesIdentifier(resolveBody, ['IsEvaluated', 'EvaluationRequired', 'NotEvaluatedException']),
    'the resolver has no evaluation prerequisite in CODE (VF11)',
  );

  for (const [key, handlerClass] of [
    [SOURCE_KEYS.validationCommand, 'StartScenarioValidationCommandHandler'],
    [SOURCE_KEYS.executionCommand, 'StartScenarioExecutionCommandHandler'],
  ] as const) {
    const src = readExtract(sourceWithExtract(key).extract!);
    const handle = csharpDirectMethodBody(src, handlerClass, 'Handle');
    // BIND the null-snapshot call to the INJECTED resolver: the handler injects exactly
    // one IResourceSelectorResolver field, and ResolveAsync is invoked ON that field
    // (this.-qualified) forwarding EXACTLY (command.Configuration, evaluationSnapshot:
    // null, cancellationToken) — a bare `evaluationSnapshot: null` token anywhere is not
    // sufficient. The resolver receiver, method, qualification, and complete argument
    // list are all authenticated.
    assertReceiverBoundCall(
      src,
      handlerClass,
      handle,
      'ResolveAsync',
      'IResourceSelectorResolver',
      ['command.Configuration', 'evaluationSnapshot: null', 'cancellationToken'],
    );
    assert.ok(!csharpReferencesIdentifier(src, ['IsEvaluated']), `${key}: does not gate on IsEvaluated (VF11)`);
  }
  // Controller: the extracted body names no evaluation short-circuit and names an
  // Accepted (202) status for the actions (static-text inspection).
  const controller = readExtract(sourceWithExtract(SOURCE_KEYS.configController).extract!);
  assert.ok(
    !csharpReferencesIdentifier(controller, ['IsEvaluated', 'EvaluationRequired', 'NotEvaluated']),
    'controller has no evaluation gate in CODE (VF11)',
  );
  const execute = csharpDirectMethodBody(controller, 'ScenarioConfigurationsController', 'Execute');
  assert.ok(httpStatusCodes(execute, controller).includes('Accepted'), 'the extracted Execute body names an Accepted (202) status');
  // The exception mapper maps no evaluation-required exception (there is none).
  const mapper = readExtract(sourceWithExtract(SOURCE_KEYS.exceptionMapper).extract!);
  assert.ok(
    !csharpReferencesIdentifier(mapper, ['EvaluationRequiredException', 'NotEvaluatedException', 'IsEvaluated']),
    'no evaluation-required exception is mapped (VF11)',
  );

  // The null-snapshot path delegates to the LIVE evaluator. Authenticate the extract
  // the resolver actually calls: the extracted ResolveLiveAsync BODY names no
  // conflict/evaluation-required token, so on the INSPECTED path nothing turns an
  // unevaluated workspace into a 409 through this delegate (a static-text claim).
  const evaluatorSrc = readExtract(sourceWithExtract(SOURCE_KEYS.liveEvaluator).extract!);
  assert.match(stripCSharpNoise(evaluatorSrc), /ResolveLiveAsync/, 'the live evaluator declares ResolveLiveAsync (the null-snapshot delegate)');
  // Receiver-bound: the resolver's null-coalescing target is ResolveLiveAsync
  // invoked ON the constructor-injected ISelectorEvaluator field (not a bare
  // method-name match), and the DI registration pins that interface to the
  // authenticated concrete impl. Bind constructor param -> field -> receiver -> args.
  const resolverField = assertReceiverBoundCall(resolver, 'ResourceSelectorResolver', resolveBody, 'ResolveLiveAsync', 'ISelectorEvaluator', ['configuration', 'cancellationToken']);
  assert.ok(resolverField.length > 0, 'the resolver injects an ISelectorEvaluator field for the live delegate (VF11)');
  const liveBody = csharpDirectMethodBody(evaluatorSrc, 'SelectorEvaluator', 'ResolveLiveAsync');
  assert.ok(liveBody.length > 0, 'the live evaluator declares a ResolveLiveAsync body');
  assert.ok(
    !csharpReferencesIdentifier(liveBody, [
      'IsEvaluated',
      'EvaluationRequired',
      'EvaluationRequiredException',
      'NotEvaluatedException',
      'ResourceConflictException',
      'ConflictException',
      'throw',
    ]),
    'the extracted live-resolution body names no conflict/evaluation-required token (VF11, static)',
  );
  // Defense in depth: the extracted live-evaluator body names no HTTP 409 / Conflict.
  assert.ok(!httpStatusCodes(liveBody).includes('Conflict'), 'the extracted live-resolution body names no Conflict (409) status (VF11, static)');

  // Authenticate the CONCRETE CALLEES via the DI registration: the resolver's
  // ISelectorEvaluator is bound to SelectorEvaluator, whose ISelectorTargetQuery is
  // bound to the concrete SelectorTargetQuery. A green interface would be worthless
  // if the runtime bound it to a throwing implementation — so bind the whole chain.
  const di = diBindings(readExtract(sourceWithExtract(SOURCE_KEYS.diRegistration).extract!));
  assert.equal(di['IResourceSelectorResolver'], 'ResourceSelectorResolver', 'DI binds the resolver to its concrete impl (VF11)');
  assert.equal(di['ISelectorEvaluator'], 'SelectorEvaluator', 'DI binds the evaluator to the authenticated concrete impl (VF11)');
  assert.equal(di['ISelectorTargetQuery'], 'SelectorTargetQuery', 'DI binds the target query to the authenticated concrete impl (VF11)');

  // The evaluator delegates to ISelectorTargetQuery.QueryAsync — authenticate that
  // concrete terminal callee: its extracted body names no conflict/409 token.
  // Receiver-bound: QueryAsync is invoked on the evaluator's DI-injected
  // ISelectorTargetQuery field, and DI pins that interface below.
  assertReceiverBoundCall(evaluatorSrc, 'SelectorEvaluator', liveBody, 'QueryAsync', 'ISelectorTargetQuery', ['configuration', 'cancellationToken']);
  const targetQuerySrc = readExtract(sourceWithExtract(SOURCE_KEYS.targetQuery).extract!);
  const queryBody = csharpDirectMethodBody(targetQuerySrc, 'SelectorTargetQuery', 'QueryAsync');
  assert.ok(queryBody.length > 0, 'the concrete target query declares QueryAsync');
  const NO_CONFLICT_IDENTS = [
    'IsEvaluated',
    'EvaluationRequired',
    'EvaluationRequiredException',
    'NotEvaluatedException',
    'ResourceConflictException',
    'ConflictException',
    'throw',
  ];
  assert.ok(
    !csharpReferencesIdentifier(queryBody, NO_CONFLICT_IDENTS),
    'the extracted target-query body names no conflict/evaluation-required token (VF11, static)',
  );
  assert.ok(!httpStatusCodes(queryBody).includes('Conflict'), 'the extracted target-query body names no Conflict (409) status (VF11, static)');

  // Complete the chain to the DEEPEST state-touching callee: the concrete STORE the
  // target query reads from (ISelectorTargetStore.ListTargetsAsync). DI binds it to
  // the authenticated concrete store; its extracted body names only a read.
  // Receiver-bound: ListTargetsAsync is invoked on the target query's DI-injected
  // ISelectorTargetStore field.
  assertReceiverBoundCall(targetQuerySrc, 'SelectorTargetQuery', queryBody, 'ListTargetsAsync', 'ISelectorTargetStore', ['configuration', 'cancellationToken']);
  assert.equal(di['ISelectorTargetStore'], 'SelectorTargetStore', 'DI binds the target store to the authenticated concrete impl (VF11)');
  const storeSrc = readExtract(sourceWithExtract(SOURCE_KEYS.targetStore).extract!);
  const storeBody = csharpDirectMethodBody(storeSrc, 'SelectorTargetStore', 'ListTargetsAsync');
  assert.ok(storeBody.length > 0, 'the concrete store declares ListTargetsAsync');
  assert.ok(
    !csharpReferencesIdentifier(storeBody, NO_CONFLICT_IDENTS),
    'the extracted store body names no conflict/evaluation-required token (VF11, static)',
  );
  assert.ok(!httpStatusCodes(storeBody).includes('Conflict'), 'the extracted store body names no Conflict (409) status (VF11, static)');
  // PERSISTENCE authentication (STATIC): the extracted store body names a READ-ONLY
  // query (ToListAsync) and names NO write/optimistic-concurrency token — the tokens
  // (write/upsert/concurrency) that WOULD be a persistence-conflict source in the
  // inspected body are absent. This is a static-text claim about the extract, not a
  // runtime guarantee about the framework's persistence layer.
  const PERSISTENCE_WRITE_IDENTS = [
    'SaveChanges',
    'SaveChangesAsync',
    'Add',
    'AddAsync',
    'Update',
    'UpdateAsync',
    'Remove',
    'Upsert',
    'UpsertAsync',
    'ExecuteUpdate',
    'ExecuteDelete',
    'RowVersion',
    'ConcurrencyToken',
    'ConcurrencyStamp',
    'DbUpdateConcurrencyException',
    'OptimisticConcurrency',
    'IfMatch',
    'ETag',
  ];
  assert.ok(
    !csharpReferencesIdentifier(storeBody, PERSISTENCE_WRITE_IDENTS),
    'the extracted store body names no write / optimistic-concurrency operation (no conflict source, VF11, static)',
  );
  assert.ok(
    csharpReferencesIdentifier(storeBody, ['ToListAsync']),
    'the extracted store body names a read-only query (ToListAsync) (VF11, static)',
  );

  // Authenticate the CONSTRUCTION HELPERS the chain calls (ResolvedSelectorMap.From
  // and SelectorMap.FromLiveTargets): their extracted bodies name no conflict token,
  // no throw, and no persistence/concurrency operation (a static-text claim about the
  // inspected factory bodies, not a runtime guarantee about projection).
  const factoriesSrc = readExtract(sourceWithExtract(SOURCE_KEYS.mapFactories).extract!);
  for (const [factory, factoryClass] of [
    ['From', 'ResolvedSelectorMap'],
    ['FromLiveTargets', 'SelectorMap'],
  ] as const) {
    const body = csharpDirectMethodBody(factoriesSrc, factoryClass, factory);
    assert.ok(body.length > 0, `the construction helper ${factory} is declared`);
    assert.ok(
      !csharpReferencesIdentifier(body, NO_CONFLICT_IDENTS),
      `the extracted ${factory} body names no conflict/evaluation-required token (VF11, static)`,
    );
    assert.ok(
      !csharpReferencesIdentifier(body, PERSISTENCE_WRITE_IDENTS),
      `the extracted ${factory} body names no persistence/concurrency operation (VF11, static)`,
    );
    assert.ok(!httpStatusCodes(body).includes('Conflict'), `the extracted ${factory} body names no Conflict (409) status (VF11, static)`);
  }
  // The chain actually USES these factories — matched against the comment/literal-stripped
  // bodies and confirmed as parsed invocations, so a decoy in a comment/string cannot
  // satisfy the claim.
  assert.match(stripCSharpNoise(resolveBody), /ResolvedSelectorMap\s*\.\s*From\s*\(/, 'the resolver wraps via ResolvedSelectorMap.From (VF11)');
  assert.match(stripCSharpNoise(liveBody), /SelectorMap\s*\.\s*FromLiveTargets\s*\(/, 'the evaluator projects via SelectorMap.FromLiveTargets (VF11)');
  assert.ok(csharpInvocation(resolveBody, 'From'), 'ResolvedSelectorMap.From is a parsed invocation in the resolver body (VF11)');
  assert.ok(csharpInvocation(liveBody, 'FromLiveTargets'), 'SelectorMap.FromLiveTargets is a parsed invocation in the evaluator body (VF11)');
  // Claim scope (STATIC inspection of the committed extract BODIES, NOT a runtime
  // guarantee): every EXTRACTED method in the null-snapshot resolution chain
  // (resolver → live evaluator → target query → read-only store → pure map factories)
  // names no evaluation gate, no conflict throw, no 409, and no write/optimistic-
  // concurrency operation. This authenticates only the REVIEWED SOURCE TEXT on the
  // inspected path; it is deliberately NOT an assertion that validate/execute are
  // guaranteed to return 202 and never throw at runtime end to end. Code the extracts
  // do not include (framework internals, the call graph beyond these bodies) is out of
  // scope and unverified here.
});

test('nested error serialization is authenticated against the generated error models (VF10)', () => {
  // Derive, STRUCTURALLY, the channel -> element-model binding from the properties
  // models and each element model's exact fields/kinds/requiredness from the error
  // models — no hardcoded channel map, field list, or class name. Then require the
  // terminal-failure fixtures' nested errors to match the derived models exactly.
  const errorSrc = readExtract(sourceWithExtract(SOURCE_KEYS.errorModels).extract!);
  const byClass = serializedFieldsByClass(errorSrc);

  // The channel -> element-model class map is derived from the properties models.
  const sysClass = SYSTEM_MODEL_CLASS;
  const valClass = VALIDATION_BUSINESS_CLASS;
  const runClass = RUN_BUSINESS_CLASS;
  assert.ok(byClass[sysClass], `the error models declare the system class ${sysClass}`);
  assert.ok(byClass[valClass], `the error models declare the validation business class ${valClass}`);
  assert.ok(byClass[runClass], `the error models declare the run business class ${runClass}`);

  // Every serialized error-model field is OPTIONAL on the wire (Optional-guarded):
  // we parse requiredness structurally and assert the derived fact.
  for (const cls of [sysClass, valClass, runClass]) {
    for (const f of byClass[cls]!) {
      assert.equal(f.required, false, `${cls}.${f.name} is written under an Optional guard (optional on the wire)`);
    }
  }

  const fieldsOf = (cls: string) => new Map(byClass[cls]!.map((f) => [f.name, f] as const));
  const systemModel = fieldsOf(sysClass);
  const validationModel = fieldsOf(valClass);
  const runModel = fieldsOf(runClass);
  const kindGet = (m: Map<string, { kind: string }>, k: string) => m.get(k)?.kind;

  // The three models must be DISTINCT enough to prove per-class derivation: the
  // validation business model uniquely carries the array-valued remediation field
  // whose ELEMENT type is string (derived from the loop's WriteStringValue(item)).
  assert.equal(kindGet(validationModel, 'recommendedRoles'), 'array', `${valClass} serializes recommendedRoles as an array`);
  assert.equal(validationModel.get('recommendedRoles')!.element, 'string', `${valClass} recommendedRoles elements are strings`);
  assert.equal(validationModel.get('code')!.primitive, 'string', `${valClass} code is a string`);
  assert.equal(systemModel.get('code')!.primitive, 'string', `${sysClass} code is a string`);
  assert.equal(systemModel.get('message')!.primitive, 'string', `${sysClass} message is a string`);
  assert.ok(!systemModel.has('resourceId'), `the system error model ${sysClass} declares no resourceId`);
  assert.ok(!runModel.has('recommendedRoles'), `the run business error model ${runClass} declares no recommendedRoles`);
  assert.ok(systemModel.has('code') && systemModel.has('message'), `${sysClass} serializes code + message`);

  // Validate a fixture nested-error value against its DERIVED field type: a scalar
  // must have the model's exact primitive JS type; an array must be an array whose
  // items each have the model's exact element type.
  const primitiveJs = (p: WirePrimitive): string => (p === 'number' ? 'number' : p === 'boolean' ? 'boolean' : 'string');
  const assertFieldValue = (rel: string, chan: string, field: SerializedField, v: unknown) => {
    assert.equal(jsonValueKind(v), field.kind, `${rel}: ${chan} field '${field.name}' has the model-declared value kind`);
    if (field.kind === 'scalar') {
      assert.ok(field.primitive, `${rel}: ${chan} field '${field.name}' has a derived primitive type`);
      assert.equal(typeof v, primitiveJs(field.primitive!), `${rel}: ${chan} field '${field.name}' is a ${field.primitive}`);
    } else if (field.kind === 'array') {
      assert.ok(field.element, `${rel}: ${chan} field '${field.name}' has a derived element type`);
      assert.ok(Array.isArray(v), `${rel}: ${chan} field '${field.name}' is an array`);
      for (const item of v as unknown[]) {
        if (field.element === 'object') {
          assert.equal(jsonValueKind(item), 'object', `${rel}: ${chan} field '${field.name}' items are objects`);
        } else {
          assert.equal(typeof item, primitiveJs(field.element as WirePrimitive), `${rel}: ${chan} field '${field.name}' items are ${field.element}`);
        }
      }
    }
  };

  const check = (
    rel: string,
    businessChan: 'validationErrors' | 'executionErrors',
    businessModel: Map<string, SerializedField>,
  ) => {
    const fx = JSON.parse(readFileSync(join(FIXTURES_DIR, rel), 'utf8')) as {
      response: { body: { properties: Record<string, Array<Record<string, unknown>>> } };
    };
    const props = fx.response.body.properties;
    for (const sys of props['errors']!) {
      for (const [k, v] of Object.entries(sys)) {
        const field = systemModel.get(k);
        assert.ok(field, `${rel}: system error field '${k}' is declared by the model`);
        assertFieldValue(rel, 'system error', field!, v);
      }
      assert.ok('code' in sys && 'message' in sys, `${rel}: system error has code + message`);
    }
    for (const biz of props[businessChan]!) {
      for (const [k, v] of Object.entries(biz)) {
        const field = businessModel.get(k);
        assert.ok(field, `${rel}: business error field '${k}' is declared by the model`);
        assertFieldValue(rel, 'business error', field!, v);
      }
      assert.ok('code' in biz && 'message' in biz, `${rel}: business error has code + message`);
    }
  };

  check('validate/validation-requires-attention-200.json', 'validationErrors', validationModel);
  check('execute/run-failed-200.json', 'executionErrors', runModel);
  // Sanity: the validation terminal-failure fixture carries the remediation field
  // the model declares.
  const vfx = JSON.parse(
    readFileSync(join(FIXTURES_DIR, 'validate/validation-requires-attention-200.json'), 'utf8'),
  ) as { response: { body: { properties: Record<string, Array<Record<string, unknown>>> } } };
  assert.ok('recommendedRoles' in vfx.response.body.properties['validationErrors']![0]!, 'the validation failure carries recommendedRoles');
});

// ---------------------------------------------------------------------------
// Reproducible contract authentication via EXPLICIT per-fixture schemas. Every
// fixture on disk must have a schema entry, and each is validated against its
// operation-specific required shape. This is deliberately NOT present-only:
// missing a required request, Location, api-version, status, id, channel, or
// Retry-After is a FAILURE (omission cannot evade the check).
// ---------------------------------------------------------------------------

const AREA_STATES: Record<string, readonly string[]> = {
  validate: VALIDATION_STATES,
  execute: RUN_STATES,
  cancel: RUN_STATES,
};
const AREA_CHANNELS: Record<string, readonly string[]> = {
  validate: VALIDATION_ERROR_CHANNELS,
  execute: RUN_ERROR_CHANNELS,
  cancel: RUN_ERROR_CHANNELS,
};
const AREA_TERMINAL: Record<string, readonly string[]> = {
  validate: [...VALIDATION_TERMINAL_SUCCESS, ...VALIDATION_TERMINAL_FAILURE],
  execute: [...RUN_TERMINAL_SUCCESS, ...RUN_TERMINAL_FAILURE],
  cancel: [...RUN_TERMINAL_SUCCESS, ...RUN_TERMINAL_FAILURE],
};

type Area = 'validate' | 'execute' | 'cancel';
type Operation = 'operations' | 'validate' | 'validationGet' | 'execute' | 'runGet' | 'cancel' | 'trace';
type Shape = 'operations' | 'acceptance' | 'resource' | 'resourceSequence' | 'trace';
interface FixtureSchema {
  shape: Shape;
  operation: Operation;
  area?: Area;
  requiresExpectedRunId?: boolean;
  terminalFailure?: boolean;
}

// EXPLICIT, CLOSED registry: one entry per fixture on disk, each pinned to a
// single operation. Adding a fixture without a schema fails the completeness test
// below; each fixture is then validated against a closed operation-specific shape
// (exact key sets, required request/path/id/headers/nested-errors, no extras).
const FIXTURE_SCHEMAS: Record<string, FixtureSchema> = {
  'operations/provider-operations.json': { shape: 'operations', operation: 'operations' },

  'validate/accept-202.json': { shape: 'acceptance', operation: 'validate', area: 'validate' },
  'validate/accept-unevaluated-202.json': { shape: 'acceptance', operation: 'validate', area: 'validate' },
  'validate/validation-nonterminal-202.json': { shape: 'resource', operation: 'validationGet', area: 'validate' },
  'validate/validation-succeeded-200.json': { shape: 'resource', operation: 'validationGet', area: 'validate' },
  'validate/validation-requires-attention-200.json': { shape: 'resource', operation: 'validationGet', area: 'validate', terminalFailure: true },
  'validate/plan-mutation-sequence.json': { shape: 'trace', operation: 'trace', area: 'validate' },

  'execute/accept-202.json': { shape: 'acceptance', operation: 'execute', area: 'execute', requiresExpectedRunId: true },
  'execute/accept-unevaluated-202.json': { shape: 'acceptance', operation: 'execute', area: 'execute', requiresExpectedRunId: true },
  'execute/run-nonterminal-202.json': { shape: 'resource', operation: 'runGet', area: 'execute' },
  'execute/run-succeeded-200.json': { shape: 'resource', operation: 'runGet', area: 'execute' },
  'execute/run-failed-200.json': { shape: 'resource', operation: 'runGet', area: 'execute', terminalFailure: true },
  'execute/run-transitions.json': { shape: 'resourceSequence', operation: 'runGet', area: 'execute' },

  'cancel/accept-202.json': { shape: 'acceptance', operation: 'cancel', area: 'cancel' },
  'cancel/run-canceled-200.json': { shape: 'resource', operation: 'runGet', area: 'cancel' },
  'cancel/run-transitions.json': { shape: 'resourceSequence', operation: 'runGet', area: 'cancel' },
};

const API_VERSION_RE = /[?&]api-version=([^&]+)/;

// Closed key sets. The authoritative top-level check is the PER-SHAPE schema in
// TOPLEVEL_SHAPE_SCHEMA, which pins the EXACT required+optional top-level keys for
// each fixture shape so a key valid for one shape (e.g. `value`, `sequence`,
// `resourceId`) cannot appear on another shape. Request/response bodies are pinned
// per operation via assertObjectSchema in their validators.

// ARM management-plane host every request/Location URL must use.
const MGMT_HOST = 'management.azure.com';

// Wire timestamps are ISO-8601 in UTC (trailing 'Z'). A local offset, a missing
// zone, or a naive datetime is a contract violation.
const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

// The generated provider operationIds the fixtures may carry (closed set).
const KNOWN_OPERATION_IDS = new Set<string>([
  'Operations_List',
  'ScenarioConfigurations_Validate',
  'ScenarioConfigurationValidations_Get',
  'ScenarioConfigurations_Execute',
  'ScenarioRuns_Get',
  'ScenarioRuns_Cancel',
]);

// The EXACT generated operationId each fixture operation must carry. operationId is
// REQUIRED and must equal this — a missing or mismatched id is a failure.
const EXPECTED_OPERATION_ID: Record<Operation, string> = {
  operations: 'Operations_List',
  validate: 'ScenarioConfigurations_Validate',
  validationGet: 'ScenarioConfigurationValidations_Get',
  execute: 'ScenarioConfigurations_Execute',
  runGet: 'ScenarioRuns_Get',
  cancel: 'ScenarioRuns_Cancel',
  trace: 'ScenarioConfigurationValidations_Get',
};

// The only HTTP header names any fixture request/response may carry.
const KNOWN_HEADER_NAMES = new Set<string>([
  'Location', 'Retry-After', 'x-ms-correlation-request-id', 'x-ms-request-id', 'If-Match', 'ETag',
]);

// Provenance citations are comma-separated verification/decision tokens (VF#, DX#).
const CITATION_TOKEN_RE = /^(?:VF\d+|DX\d+)$/;

// The bound ARM resource identity extracted from a fully-parsed request/Location.
interface ArmIdentity {
  subscriptionId: string;
  resourceGroup: string;
  workspace: string;
  scenario: string;
  configuration?: string;
  runId?: string;
  resourcePath: string;
}

// Binds the fixed ARM path shape and its identifiers, failing on any missing or
// malformed segment. Callers additionally pin the action tail via assertRequestPath.
function bindArmIdentity(segs: string[], pathname: string, key: string, kind: string): ArmIdentity {
  const seg = (label: string, i: number): string => {
    assert.equal(segs[i], label, `${key}: ${kind} URL segment ${i} must be '${label}'`);
    const v = segs[i + 1];
    assert.ok(v !== undefined && v.length > 0, `${key}: ${kind} URL is missing the '${label}' value`);
    return v!;
  };
  const subscriptionId = seg('subscriptions', 0);
  assert.ok(GUID_PATTERN.test(subscriptionId), `${key}: ${kind} subscriptionId is a GUID`);
  const resourceGroup = seg('resourceGroups', 2);
  assert.equal(segs[4], 'providers', `${key}: ${kind} URL has a providers segment`);
  assert.equal(segs[5], 'Microsoft.Chaos', `${key}: ${kind} URL provider is Microsoft.Chaos`);
  const workspace = seg('workspaces', 6);
  const scenario = seg('scenarios', 8);
  const id: ArmIdentity = { subscriptionId, resourceGroup, workspace, scenario, resourcePath: pathname };
  if (segs[10] === 'configurations') {
    id.configuration = seg('configurations', 10);
  } else if (segs[10] === 'runs') {
    const runId = seg('runs', 10);
    assert.ok(GUID_PATTERN.test(runId), `${key}: ${kind} run id is a GUID`);
    id.runId = runId;
  } else {
    assert.fail(`${key}: ${kind} URL tail must address a configuration or a run`);
  }
  return id;
}

// Canonical-validates a bare absolute path string (no scheme/authority): rejects
// dot segments, empty segments, backslashes, and ANY percent-encoding. Shared by
// the URL path checker and the bare-path resourceId checker.
function assertCanonicalRawPath(rawPath: string, key: string, what: string): void {
  assert.ok(rawPath.startsWith('/'), `${key}: ${what} must be an absolute path`);
  assert.ok(!rawPath.includes('%'), `${key}: ${what} must not be percent-encoded (no encoded separators)`);
  assert.ok(!rawPath.includes('\\'), `${key}: ${what} must not contain backslashes`);
  assert.ok(!rawPath.includes('//'), `${key}: ${what} must not contain empty segments`);
  for (const seg of rawPath.split('/')) {
    assert.ok(seg !== '.' && seg !== '..', `${key}: ${what} must not contain '.'/'..' dot segments`);
  }
}

// Extracts and CANONICAL-validates the RAW path of an absolute URL BEFORE URL
// normalization can hide traversal or encoded separators. Rejects: dot segments
// (`.`/`..`), empty segments (`//`), backslashes, and ANY percent-encoding in the
// path (which could smuggle `%2F`/`%2E`). Returns the raw path, which the caller
// then requires to equal the normalized `URL.pathname` (proving it was already
// canonical). This defends against `.../rg/../rg2/...` and `.../runs%2F..%2Fx`.
function rawCanonicalArmPath(rawUrl: string, key: string, kind: string): string {
  const authority = /^https:\/\/[^/?#]+/.exec(rawUrl);
  assert.ok(authority, `${key}: ${kind} URL must be an absolute https URL`);
  const afterAuthority = rawUrl.slice(authority![0].length);
  // The raw path is everything up to the first '?' or '#'.
  const rawPath = afterAuthority.split(/[?#]/, 1)[0]!;
  assertCanonicalRawPath(rawPath, key, `${kind} URL path`);
  return rawPath;
}

// Fully parses and hygiene-checks an ARM URL: absolute https, fixed host, NO
// userinfo, NO fragment, EXACTLY one api-version pinned to the contract version,
// no stray query parameters, and a RAW-CANONICAL path (validated before URL
// normalization, then required to equal the normalized path). Returns the bound
// resource identity.
function parseArmUrl(rawUrl: string | undefined, key: string, kind: string): { url: URL; identity: ArmIdentity } {
  assert.ok(rawUrl, `${key}: ${kind} URL is required`);
  // RAW authority check first: exact management host, no explicit `:443`, no
  // userinfo — BEFORE WHATWG normalization can silently strip/fold them.
  assertRawAuthority(rawUrl!, MGMT_HOST, key, `${kind} URL`);
  // Canonicalize the RAW path so URL normalization can never mask traversal or
  // encoded separators.
  const rawPath = rawCanonicalArmPath(rawUrl!, key, kind);
  // RAW query must be the exact canonical single-parameter spelling — no reordering,
  // extra/duplicate params, or percent-encoded key/value spelling.
  assert.equal(
    rawQueryString(rawUrl!),
    `api-version=${API_VERSION}`,
    `${key}: ${kind} URL raw query must be exactly 'api-version=${API_VERSION}'`,
  );
  let u: URL;
  try {
    u = new URL(rawUrl!);
  } catch {
    assert.fail(`${key}: ${kind} URL is not a valid absolute URL`);
  }
  assert.equal(u!.protocol, 'https:', `${key}: ${kind} URL must be https`);
  assert.equal(u!.host, MGMT_HOST, `${key}: ${kind} URL must use the ${MGMT_HOST} host`);
  assert.equal(u!.username, '', `${key}: ${kind} URL must not carry userinfo (username)`);
  assert.equal(u!.password, '', `${key}: ${kind} URL must not carry userinfo (password)`);
  assert.equal(u!.hash, '', `${key}: ${kind} URL must not carry a fragment`);
  // The normalized path must be byte-identical to the raw path: proof it was
  // already canonical (no segment was collapsed/decoded by URL parsing).
  assert.equal(u!.pathname, rawPath, `${key}: ${kind} URL path must be canonical (raw == normalized)`);
  const apiVersions = u!.searchParams.getAll('api-version');
  assert.equal(apiVersions.length, 1, `${key}: ${kind} URL must carry exactly one api-version`);
  assert.equal(apiVersions[0], API_VERSION, `${key}: ${kind} URL must pin ${API_VERSION}`);
  assert.deepEqual([...u!.searchParams.keys()], ['api-version'], `${key}: ${kind} URL carries only api-version`);
  const segs = u!.pathname.split('/').filter(Boolean);
  return { url: u!, identity: bindArmIdentity(segs, u!.pathname, key, kind) };
}

// Asserts two identities agree on every identifier they BOTH carry (the common
// sub/rg/workspace/scenario prefix, plus configuration or run when both have it).
function assertIdentityBinding(a: ArmIdentity, b: ArmIdentity, key: string, what: string): void {
  assert.equal(a.subscriptionId, b.subscriptionId, `${key}: ${what} subscriptionId must match`);
  assert.equal(a.resourceGroup, b.resourceGroup, `${key}: ${what} resourceGroup must match`);
  assert.equal(a.workspace, b.workspace, `${key}: ${what} workspace must match`);
  assert.equal(a.scenario, b.scenario, `${key}: ${what} scenario must match`);
  if (a.configuration !== undefined && b.configuration !== undefined) {
    assert.equal(a.configuration, b.configuration, `${key}: ${what} configuration must match`);
  }
  if (a.runId !== undefined && b.runId !== undefined) {
    assert.equal(a.runId, b.runId, `${key}: ${what} run id must match`);
  }
}

// Closed header map: only known header names, all values strings.
function assertHeaderMap(headers: unknown, key: string, what: string): void {
  if (headers === undefined) return;
  assert.ok(headers && typeof headers === 'object' && !Array.isArray(headers), `${key}: ${what} headers must be an object`);
  for (const [name, val] of Object.entries(headers as Record<string, unknown>)) {
    assert.ok(KNOWN_HEADER_NAMES.has(name), `${key}: unexpected ${what} header '${name}'`);
    assert.equal(typeof val, 'string', `${key}: ${what} header '${name}' must be a string`);
  }
}

// Asserts a headers object carries EXACTLY the expected key set (no missing/extra).
function assertExactHeaderKeys(headers: unknown, expected: string[], key: string, what: string): void {
  assertHeaderMap(headers, key, what);
  const present = headers ? Object.keys(headers as Record<string, unknown>) : [];
  assert.deepEqual(
    [...present].sort(),
    [...expected].sort(),
    `${key}: ${what} headers must be exactly {${expected.join(', ')}}`,
  );
}

// Top-level envelope typing: closed provenance ({source,citation} both non-empty
// strings; source is a declared manifest source; citation is VF#/DX# tokens) and a
// REQUIRED operationId that must EQUAL the operation's generated id.
function assertEnvelope(parsed: WireFixtureRaw & { operationId?: unknown }, expectedOperationId: string, key: string): void {
  const prov = parsed.provenance;
  assert.ok(prov, `${key}: fixture records provenance`);
  assertObjectSchema(prov, ['source', 'citation'], [], key, 'provenance');
  const manifestSources = loadManifest().sources;
  assert.ok(typeof prov!.source === 'string' && prov!.source.length > 0, `${key}: provenance.source is a non-empty string`);
  assert.ok(manifestSources[prov!.source as string], `${key}: provenance.source '${prov!.source}' is a declared manifest source`);
  assert.ok(typeof prov!.citation === 'string' && prov!.citation.length > 0, `${key}: provenance.citation is a non-empty string`);
  for (const tok of (prov!.citation as string).split(/,\s*/)) {
    assert.match(tok, CITATION_TOKEN_RE, `${key}: provenance citation token '${tok}' is a VF#/DX# reference`);
  }
  assert.ok('operationId' in parsed && parsed.operationId !== undefined, `${key}: fixture records an operationId`);
  assert.ok(typeof parsed.operationId === 'string', `${key}: operationId is a string`);
  assert.ok(KNOWN_OPERATION_IDS.has(parsed.operationId as string), `${key}: operationId '${String(parsed.operationId)}' is a known generated operation`);
  assert.equal(parsed.operationId, expectedOperationId, `${key}: operationId must be '${expectedOperationId}' for this operation`);
}

// --- Structurally derived error-model contract (no hardcoded channel maps) ---
// The generated error models declare the EXACT nested wire fields per class, and
// the properties models bind each error CHANNEL to its element model class. Derive
// both from the reviewed extracts so the closed schema authenticates fixtures
// against the SOURCE, not a hardcoded key list.
const ERROR_MODELS = serializedFieldsByClass(readExtract(sourceWithExtract(SOURCE_KEYS.errorModels).extract!));
const VALIDATION_CHANNEL_MODELS = channelElementModels(readExtract(sourceWithExtract(SOURCE_KEYS.validationProps).extract!));
const RUN_CHANNEL_MODELS = channelElementModels(readExtract(sourceWithExtract(SOURCE_KEYS.runProps).extract!));

// Both properties models must agree on the shared system 'errors' element model.
if (VALIDATION_CHANNEL_MODELS['errors'] !== RUN_CHANNEL_MODELS['errors']) {
  throw new Error('validation and run properties disagree on the system errors element model');
}
const SYSTEM_MODEL_CLASS = VALIDATION_CHANNEL_MODELS['errors']!;
const VALIDATION_BUSINESS_CLASS = VALIDATION_CHANNEL_MODELS['validationErrors']!;
const RUN_BUSINESS_CLASS = RUN_CHANNEL_MODELS['executionErrors']!;

function modelFieldSet(cls: string): Set<string> {
  const fields = ERROR_MODELS[cls];
  if (!fields || fields.length === 0) throw new Error(`error model class '${cls}' not found in the reviewed extract`);
  return new Set(fields.map((f) => f.name));
}
function modelFieldKinds(cls: string): Map<string, 'array' | 'object' | 'scalar'> {
  const fields = ERROR_MODELS[cls];
  if (!fields || fields.length === 0) throw new Error(`error model class '${cls}' not found in the reviewed extract`);
  return new Map(fields.map((f) => [f.name, f.kind]));
}
function derivedSystemErrorKeys(): Set<string> {
  return modelFieldSet(SYSTEM_MODEL_CLASS);
}

// Per-area PROPERTY field map derived from the generated properties models
// (ValidationProperties / ScenarioRunProperties). Each field carries its exact
// wire kind + primitive/element type, so optional (and required non-channel)
// scalar/array properties can be TYPE-checked against the source when present —
// not merely present-checked. The single class in each extract is the model.
function singleClassFields(extractKey: string): Map<string, SerializedField> {
  const byClass = serializedFieldsByClass(readExtract(sourceWithExtract(extractKey).extract!));
  const classes = Object.values(byClass);
  if (classes.length !== 1) throw new Error(`expected exactly one properties class in ${extractKey}, found ${classes.length}`);
  return new Map(classes[0]!.map((f) => [f.name, f]));
}
const AREA_PROP_FIELDS: Record<Area, Map<string, SerializedField>> = {
  validate: singleClassFields(SOURCE_KEYS.validationProps),
  execute: singleClassFields(SOURCE_KEYS.runProps),
  cancel: singleClassFields(SOURCE_KEYS.runProps),
};
// Properties handled by dedicated checks (state enum, timestamps, error channels);
// every OTHER property is typed generically against the derived model field.
const SPECIAL_PROP_NAMES = new Set(['status', 'startTime', 'endTime', 'errors', 'validationErrors', 'executionErrors']);

// Closed element-model schemas for the object-ARRAY properties (e.g. the run
// `resources` array), derived STRUCTURALLY from the element model's own generated
// serializer — NOT hardcoded. `channelElementModels` binds each array wire field to
// its `IReadOnlyList<Element>` class from the properties model; the element class's
// fields/kinds/types are then derived from the element extract so each array item
// can be recursively validated against the closed source model rather than merely
// present-checked as an object.
const ELEMENT_MODEL_FIELDS: Record<string, Map<string, SerializedField>> = {};
// Per element model: its object-ARRAY wire field -> nested element-model CLASS
// (derived from the element extract's own `IReadOnlyList<Element>` declarations), so
// a nested object array can be resolved and recursively validated — or FAIL CLOSED
// when no such model is registered, never shallow-validated.
const ELEMENT_MODEL_NESTED: Record<string, Record<string, string>> = {};
function registerElementModel(extractKey: string, cls: string): void {
  const extract = readExtract(sourceWithExtract(extractKey).extract!);
  const byClass = serializedFieldsByClass(extract);
  const fields = byClass[cls];
  if (!fields || fields.length === 0) throw new Error(`element model class '${cls}' not found in ${extractKey}`);
  ELEMENT_MODEL_FIELDS[cls] = new Map(fields.map((f) => [f.name, f]));
  ELEMENT_MODEL_NESTED[cls] = channelElementModels(extract);
}
registerElementModel(SOURCE_KEYS.runResource, 'ScenarioRunResource');
// wire-field -> element-model class per area (derived from the properties model),
// used to select the closed element schema for an object-array property.
const AREA_ELEMENT_MODELS: Record<Area, Record<string, string>> = {
  validate: VALIDATION_CHANNEL_MODELS,
  execute: RUN_CHANNEL_MODELS,
  cancel: RUN_CHANNEL_MODELS,
};

// Closed property key sets per area. The CONTRACT-required subset (status +
// startTime + both error channels) is a contract decision — the generated
// properties model serializes EVERY field under an `Optional.Is*Defined` guard, so
// requiredness cannot be read off the serializer. It is therefore VALIDATED against
// the source (each required name MUST be a serialized field of the model), and the
// closed allowed-key set (required ∪ optional) is DERIVED from the model's
// serialized fields — never hardcoded — so it cannot drift from the generated
// serialization. additionalProperties stays effectively disabled: any key outside
// the derived set fails.
const CONTRACT_REQUIRED_PROPS: Record<Area, string[]> = {
  validate: ['status', 'startTime', 'errors', 'validationErrors'],
  execute: ['status', 'startTime', 'errors', 'executionErrors'],
  cancel: ['status', 'startTime', 'errors', 'executionErrors'],
};
function derivePropSchema(area: Area): { required: string[]; optional: string[] } {
  const modelFields = AREA_PROP_FIELDS[area]!;
  const required = CONTRACT_REQUIRED_PROPS[area]!;
  for (const r of required) {
    if (!modelFields.has(r)) {
      throw new Error(`contract-required property '${r}' is not a serialized field of the ${area} properties model`);
    }
  }
  const optional = [...modelFields.keys()].filter((k) => !required.includes(k));
  return { required, optional };
}
const PROP_SCHEMA: Record<Area, { required: string[]; optional: string[] }> = {
  validate: derivePropSchema('validate'),
  execute: derivePropSchema('execute'),
  cancel: derivePropSchema('cancel'),
};
const SYSTEM_ERROR_KEYS = derivedSystemErrorKeys();
const BUSINESS_ERROR_KEYS: Record<Area, Set<string>> = {
  validate: modelFieldSet(VALIDATION_BUSINESS_CLASS),
  execute: modelFieldSet(RUN_BUSINESS_CLASS),
  cancel: modelFieldSet(RUN_BUSINESS_CLASS),
};
// Per-field wire KINDS (array vs scalar) per channel, also derived, so the closed
// nested-error validator can check each fixture value's TYPE against the model.
const SYSTEM_ERROR_KINDS = modelFieldKinds(SYSTEM_MODEL_CLASS);
const BUSINESS_ERROR_KINDS: Record<Area, Map<string, 'array' | 'object' | 'scalar'>> = {
  validate: modelFieldKinds(VALIDATION_BUSINESS_CLASS),
  execute: modelFieldKinds(RUN_BUSINESS_CLASS),
  cancel: modelFieldKinds(RUN_BUSINESS_CLASS),
};
// A compact polling projection (sequence step) carries ONLY status/time fields.
const PROJECTION_PROP = { required: ['status'], optional: ['startTime', 'endTime'] };

// EXACT ARM resource type per area (a mere Microsoft.Chaos/ prefix is too weak).
const RESOURCE_TYPE: Record<Area, string> = {
  validate: 'Microsoft.Chaos/workspaces/scenarios/configurations/validations',
  execute: 'Microsoft.Chaos/workspaces/scenarios/runs',
  cancel: 'Microsoft.Chaos/workspaces/scenarios/runs',
};

// EXACT response header sets per operation/status. A "known" header valid for one
// status (e.g. Retry-After on a 202, Location on an acceptance) is INVALID on
// another — these closed sets reject such cross-status leakage.
const ACCEPTANCE_RESPONSE_HEADERS = ['Location', 'Retry-After', 'x-ms-correlation-request-id', 'x-ms-request-id'];
const RESOURCE_202_RESPONSE_HEADERS = ['Retry-After', 'x-ms-correlation-request-id', 'x-ms-request-id'];
const RESOURCE_200_RESPONSE_HEADERS = ['x-ms-correlation-request-id', 'x-ms-request-id'];

/** Closed object schema: every key must be in required∪optional, and every required key present. */
function assertObjectSchema(
  obj: unknown,
  required: readonly string[],
  optional: readonly string[],
  key: string,
  what: string,
): void {
  assert.ok(obj && typeof obj === 'object' && !Array.isArray(obj), `${key}: ${what} must be an object`);
  const present = new Set(Object.keys(obj as Record<string, unknown>));
  const allowed = new Set([...required, ...optional]);
  for (const k of present) assert.ok(allowed.has(k), `${key}: unexpected ${what} key '${k}' (additionalProperties disabled)`);
  for (const r of required) assert.ok(present.has(r), `${key}: ${what} missing required key '${r}'`);
}

function requireApiVersion(url: string | undefined, key: string, kind: string): void {
  // Full strict parse: absolute https, fixed host, no userinfo/fragment, exactly
  // one pinned api-version, no stray params, and a well-formed ARM resource path.
  parseArmUrl(url, key, kind);
}

function header(res: HttpResponse, name: string): string | undefined {
  const h = res.headers ?? {};
  return h[name] ?? h[name.toLowerCase()];
}

function requireRetryAfter(res: HttpResponse, key: string): void {
  const ra = header(res, 'Retry-After');
  assert.ok(ra !== undefined, `${key}: a 202 response must set Retry-After`);
  // Require the EXACT canonical decimal-seconds string, not merely a numeric value:
  // `Number('1e1'|'+10'|'10.0'|'10 ')` all equal 10 but are noncanonical Retry-After
  // representations a strict client/server must not emit or accept.
  assert.equal(ra, String(DEFAULT_RETRY_AFTER_SECONDS), `${key}: Retry-After must be the exact string '${DEFAULT_RETRY_AFTER_SECONDS}'`);
}

function requireCorrelationHeaders(res: HttpResponse, key: string): void {
  assert.ok(header(res, 'x-ms-correlation-request-id'), `${key}: response must carry x-ms-correlation-request-id`);
  assert.ok(header(res, 'x-ms-request-id'), `${key}: response must carry x-ms-request-id`);
}

function pathSegments(url: string): string[] {
  return new URL(url).pathname.split('/').filter(Boolean);
}

// The fixed ARM prefix length: subscriptions/{sub}/resourceGroups/{rg}/providers/
// Microsoft.Chaos/workspaces/{ws}/scenarios/{scn} (bound by bindArmIdentity).
const ARM_PREFIX_LEN = 10;

// EXACT operation-specific path tails appended after the ARM prefix. `{cfg}` is a
// non-empty configuration id; `{runId}` is a GUID; every other token is literal.
const OPERATION_PATH_TAIL: Partial<Record<Operation, string[]>> = {
  validate: ['configurations', '{cfg}', 'validate'],
  validationGet: ['configurations', '{cfg}', 'validations', 'latest'],
  execute: ['configurations', '{cfg}', 'execute'],
  runGet: ['runs', '{runId}'],
  cancel: ['runs', '{runId}', 'cancel'],
};

/**
 * Closed operation-specific request-path validator. Requires the EXACT total
 * segment count (ARM prefix + operation tail) so NO extra segment can be injected
 * anywhere, and binds every tail segment (literal, non-empty id, or GUID). Returns
 * the resource path (no query).
 */
function assertRequestPath(url: string, op: Operation, key: string): string {
  const segs = pathSegments(url);
  const tail = OPERATION_PATH_TAIL[op];
  if (!tail) return new URL(url).pathname; // operations/trace: no resource path here
  assert.equal(
    segs.length,
    ARM_PREFIX_LEN + tail.length,
    `${key}: ${op} path must have exactly ${ARM_PREFIX_LEN + tail.length} segments (no extra path segments)`,
  );
  tail.forEach((expected, i) => {
    const seg = segs[ARM_PREFIX_LEN + i]!;
    if (expected === '{cfg}') {
      assert.ok(seg.length > 0, `${key}: ${op} configuration id segment is non-empty`);
    } else if (expected === '{runId}') {
      assert.ok(GUID_PATTERN.test(seg), `${key}: ${op} run id segment is a GUID`);
    } else {
      assert.equal(seg, expected, `${key}: ${op} path segment ${ARM_PREFIX_LEN + i} must be '${expected}'`);
    }
  });
  return new URL(url).pathname;
}

/** JSON value kind, mirroring the model's array/object/scalar wire kinds. */
function jsonValueKind(v: unknown): 'array' | 'object' | 'scalar' {
  return Array.isArray(v) ? 'array' : v !== null && typeof v === 'object' ? 'object' : 'scalar';
}

// The RESOURCE (not action) path tails an acceptance Location / trace singleton
// must resolve to, EXACTLY (ARM prefix + this tail, nothing appended).
const LOCATION_RESOURCE_TAIL = {
  validation: ['configurations', '{cfg}', 'validations', 'latest'] as const,
  run: ['runs', '{runId}'] as const,
};

/**
 * Requires a segment array to be EXACTLY the ARM prefix + the given resource tail
 * (no missing/extra segments anywhere), binding each tail token (literal, non-empty
 * cfg, or GUID runId). Used for Location/singleton resources so an extra trailing
 * or interior segment cannot slip past a tail-only check.
 */
function assertExactResourceSegs(segs: string[], tail: readonly string[], key: string, what: string): void {
  assert.equal(
    segs.length,
    ARM_PREFIX_LEN + tail.length,
    `${key}: ${what} must have exactly ${ARM_PREFIX_LEN + tail.length} segments (no extra path segments)`,
  );
  tail.forEach((expected, i) => {
    const seg = segs[ARM_PREFIX_LEN + i]!;
    if (expected === '{cfg}') {
      assert.ok(seg.length > 0, `${key}: ${what} configuration id segment is non-empty`);
    } else if (expected === '{runId}') {
      assert.ok(GUID_PATTERN.test(seg), `${key}: ${what} run id segment is a GUID`);
    } else {
      assert.equal(seg, expected, `${key}: ${what} segment ${ARM_PREFIX_LEN + i} must be '${expected}'`);
    }
  });
}

/**
 * Recursively validates a nested error entry against the closed per-channel key
 * set AND the model-derived wire KIND of each field (array vs scalar). Both the
 * allowed keys and the kinds are derived structurally from the generated models.
 */
function assertNestedError(
  entry: unknown,
  allowedKeys: Set<string>,
  kinds: Map<string, 'array' | 'object' | 'scalar'>,
  area: Area,
  key: string,
  requireRoles: boolean,
): void {
  assert.ok(entry && typeof entry === 'object' && !Array.isArray(entry), `${key}: an error entry must be an object`);
  const e = entry as Record<string, unknown>;
  for (const [k, v] of Object.entries(e)) {
    assert.ok(allowedKeys.has(k), `${key}: unexpected error field '${k}' (additionalProperties disabled)`);
    assert.equal(jsonValueKind(v), kinds.get(k), `${key}: error field '${k}' value kind must match the model-declared kind`);
  }
  assert.ok(typeof e['code'] === 'string' && (e['code'] as string).length > 0, `${key}: error has a non-empty code`);
  assert.ok(typeof e['message'] === 'string' && (e['message'] as string).length > 0, `${key}: error has a non-empty message`);
  if ('resourceId' in e) assert.ok(typeof e['resourceId'] === 'string', `${key}: error resourceId is a string`);
  if ('recommendedRoles' in e) {
    assert.ok(Array.isArray(e['recommendedRoles']), `${key}: recommendedRoles is an array`);
    for (const r of e['recommendedRoles'] as unknown[]) assert.ok(typeof r === 'string', `${key}: recommendedRoles entries are strings`);
  }
  if (requireRoles) {
    assert.ok(Array.isArray(e['recommendedRoles']) && (e['recommendedRoles'] as unknown[]).length > 0, `${key}: remediation carries recommendedRoles`);
  }
}

// Closed, RECURSIVE validator for an object-array element (e.g. a `resources`
// item) against its derived element model. Every key must be a serialized field of
// the model (additionalProperties disabled); each value's wire kind must match the
// model-declared kind; scalars are primitive-typed; primitive arrays are element-
// typed; nested object / object-array fields recurse into their own registered
// element model — and FAIL CLOSED when no such model is registered (never a shallow
// "is an object" check). Derived requiredness is ENFORCED: any model field NOT
// wrapped in an Optional guard (required===true) MUST be present.
function assertModelObject(item: unknown, modelClass: string, key: string, path: string): void {
  const fields = ELEMENT_MODEL_FIELDS[modelClass];
  assert.ok(fields, `${key}: no derived element model for '${modelClass}' (fail closed)`);
  const nestedModels = ELEMENT_MODEL_NESTED[modelClass] ?? {};
  assert.ok(item && typeof item === 'object' && !Array.isArray(item), `${key}: ${path} must be an object`);
  const present = new Set(Object.keys(item as Record<string, unknown>));
  for (const [k, v] of Object.entries(item as Record<string, unknown>)) {
    const field = fields!.get(k);
    assert.ok(field, `${key}: unexpected ${path} field '${k}' (additionalProperties disabled)`);
    assert.equal(jsonValueKind(v), field!.kind, `${key}: ${path}.${k} value kind must match the model-declared kind`);
    if (field!.kind === 'scalar' && field!.primitive) {
      const want: string = field!.primitive === 'number' ? 'number' : field!.primitive === 'boolean' ? 'boolean' : 'string';
      assert.equal(typeof v, want, `${key}: ${path}.${k} is a ${field!.primitive}`);
    } else if (field!.kind === 'array') {
      assert.ok(Array.isArray(v), `${key}: ${path}.${k} is an array`);
      for (const el of v as unknown[]) {
        if (field!.element === 'object') {
          // Nested object array: resolve its element model or FAIL CLOSED.
          const nestedClass = nestedModels[k];
          assert.ok(nestedClass && ELEMENT_MODEL_FIELDS[nestedClass], `${key}: ${path}.${k}[] has no registered element model (fail closed)`);
          assertModelObject(el, nestedClass!, key, `${path}.${k}[]`);
        } else {
          // A primitive array MUST have a derived element type; otherwise fail closed.
          assert.ok(field!.element, `${key}: ${path}.${k}[] element type is underivable (fail closed)`);
          const wantEl: string = field!.element === 'number' ? 'number' : field!.element === 'boolean' ? 'boolean' : 'string';
          assert.equal(typeof el, wantEl, `${key}: ${path}.${k} items are ${field!.element}`);
        }
      }
    } else if (field!.kind === 'object') {
      // A nested object scalar requires its own registered model — fail closed.
      assert.fail(`${key}: ${path}.${k} is a nested object with no registered element model (fail closed)`);
    } else {
      // A scalar whose primitive type could not be derived is fail-closed.
      assert.fail(`${key}: ${path}.${k} has an underivable scalar type (fail closed)`);
    }
  }
  // ENFORCE derived requiredness: every unguarded (required) model field is present.
  for (const [fname, f] of fields!) {
    if (f.required) assert.ok(present.has(fname), `${key}: ${path} missing required field '${fname}' (derived requiredness)`);
  }
}

function validateAcceptance(parsed: WireFixtureRaw, schema: FixtureSchema, key: string): void {
  const res = parsed.response;
  assert.ok(res, `${key}: acceptance fixture requires a top-level response`);
  // Response is EXACTLY {status, headers, body}; body must be null (no acceptance body).
  assertObjectSchema(res, ['status', 'headers', 'body'], [], key, 'acceptance response');
  // EXACT acceptance header set (Location + Retry-After + both correlation ids).
  assertExactHeaderKeys(res!.headers, ACCEPTANCE_RESPONSE_HEADERS, key, 'acceptance response');
  assert.equal(res!.status, 202, `${key}: acceptance status must be 202`);
  assert.ok(res!.body === null, `${key}: acceptance body must be null`);

  assert.ok(parsed.request, `${key}: acceptance requires a request`);
  // Request is EXACTLY {method, url} — no request headers, no request body.
  assertObjectSchema(parsed.request, ['method', 'url'], [], key, 'acceptance request');
  assert.equal((parsed.request!.method ?? '').toUpperCase(), 'POST', `${key}: acceptance is a POST action`);
  const reqId = parseArmUrl(parsed.request!.url, key, 'request').identity;
  assertRequestPath(parsed.request!.url!, schema.operation, key);

  requireRetryAfter(res!, key);
  requireCorrelationHeaders(res!, key);
  const loc = header(res!, 'Location');
  const locId = parseArmUrl(loc, key, 'Location').identity;
  // The Location resolves the SAME resource identity as the request (bind every
  // shared identifier: subscription/rg/workspace/scenario, and configuration/run).
  assertIdentityBinding(reqId, locId, key, 'request/Location');
  const segs = pathSegments(loc!);

  if (schema.operation === 'validate') {
    assertExactResourceSegs(segs, LOCATION_RESOURCE_TAIL.validation, key, 'validate acceptance Location');
    assert.ok(locId.configuration !== undefined, `${key}: validate acceptance Location addresses a configuration`);
  } else {
    // execute / cancel acceptance -> a run resource Location, EXACTLY /runs/{runId}.
    assertExactResourceSegs(segs, LOCATION_RESOURCE_TAIL.run, key, 'acceptance run Location');
    const runId = locId.runId;
    assert.ok(runId !== undefined && GUID_PATTERN.test(runId), `${key}: acceptance run Location ends in a GUID`);
    if (schema.requiresExpectedRunId) {
      assert.ok(parsed.expected, `${key}: execute acceptance records expected run identifiers`);
      assertObjectSchema(parsed.expected, ['runId', 'runResourceId'], [], key, 'expected');
      assert.ok(typeof parsed.expected!.runId === 'string' && GUID_PATTERN.test(parsed.expected!.runId), `${key}: expected.runId is a GUID`);
      assert.equal(parsed.expected!.runId, runId, `${key}: expected.runId equals the Location run GUID`);
      assert.equal(parsed.expected!.runResourceId, locId.resourcePath, `${key}: expected.runResourceId equals the Location resource path`);
    } else {
      assert.equal(parsed.expected, undefined, `${key}: only execute acceptance carries expected run identifiers`);
    }
  }
}

function assertFullResourceBody(
  body: unknown,
  area: Area,
  key: string,
  opts: { requireTimes: boolean; requestPath?: string; terminalFailure?: boolean },
): void {
  // Body: closed to exactly {id, name, type, properties}, all required.
  assertObjectSchema(body, ['id', 'name', 'type', 'properties'], [], key, 'resource body');
  const b = body as { id: string; name: unknown; type: unknown; properties: Record<string, unknown> };
  assert.ok(typeof b.id === 'string' && b.id.length > 0, `${key}: resource body requires a non-empty id`);
  assert.ok(typeof b.name === 'string' && (b.name as string).length > 0, `${key}: resource body requires a name`);
  // EXACT resource type per area (a mere Microsoft.Chaos/ prefix is too weak).
  assert.equal(b.type, RESOURCE_TYPE[area], `${key}: resource body type must be '${RESOURCE_TYPE[area]}'`);
  // The name is the LAST id segment; a run resource additionally names a GUID and a
  // validation resource is the 'latest' singleton.
  const idSegs = (b.id as string).split('/').filter(Boolean);
  const lastSeg = idSegs[idSegs.length - 1]!;
  assert.equal(b.name, lastSeg, `${key}: resource body name equals the last id segment`);
  if (area === 'validate') {
    assert.equal(b.name, 'latest', `${key}: a validation resource is the 'latest' singleton`);
  } else {
    assert.ok(GUID_PATTERN.test(b.name as string), `${key}: a run resource name is a GUID`);
  }
  if (opts.requestPath) {
    assert.equal(b.id, opts.requestPath, `${key}: resource body id equals the request resource path`);
  }
  // Properties: closed to the area's required + optional set (additionalProperties
  // disabled). Terminal resources additionally require endTime.
  const propSchema = PROP_SCHEMA[area]!;
  const required = opts.requireTimes ? [...propSchema.required, END_TIME_FIELD] : propSchema.required;
  const optional = opts.requireTimes ? propSchema.optional.filter((k) => k !== END_TIME_FIELD) : propSchema.optional;
  assertObjectSchema(b.properties, required, optional, key, 'properties');
  const props = b.properties;
  const status = props[STATUS_FIELD];
  assert.ok(typeof status === 'string' && AREA_STATES[area]!.includes(status as string), `${key}: status '${String(status)}' is a known ${area} state`);
  // Timestamps, when present, are ISO-8601 UTC instants.
  assert.match(props[START_TIME_FIELD] as string, ISO_UTC_RE, `${key}: startTime is an ISO-8601 UTC instant`);
  if (END_TIME_FIELD in props) {
    assert.match(props[END_TIME_FIELD] as string, ISO_UTC_RE, `${key}: endTime is an ISO-8601 UTC instant`);
  }
  // Every OTHER property present (e.g. executionPlanJson, resources, scenarioRunJson,
  // summary) is recursively TYPE-checked against the derived properties model: its
  // wire kind (scalar/array/object) and, for scalars, its exact primitive type, and
  // for arrays, its element type — so an optional property is never merely
  // present-checked with an arbitrary value type.
  const propFields = AREA_PROP_FIELDS[area]!;
  for (const [pname, pval] of Object.entries(props)) {
    if (SPECIAL_PROP_NAMES.has(pname)) continue;
    const field = propFields.get(pname);
    assert.ok(field, `${key}: property '${pname}' is declared by the properties model`);
    assert.equal(jsonValueKind(pval), field!.kind, `${key}: property '${pname}' value kind must match the model-declared kind`);
    if (field!.kind === 'scalar' && field!.primitive) {
      const wantType: string = field!.primitive === 'number' ? 'number' : field!.primitive === 'boolean' ? 'boolean' : 'string';
      assert.equal(typeof pval, wantType, `${key}: property '${pname}' is a ${field!.primitive}`);
    } else if (field!.kind === 'array') {
      assert.ok(Array.isArray(pval), `${key}: property '${pname}' is an array`);
      const elementClass = AREA_ELEMENT_MODELS[area]![pname];
      for (const item of pval as unknown[]) {
        if (field!.element === 'object') {
          // An object-array property MUST resolve to a registered element model and be
          // recursively validated against it — FAIL CLOSED, never a shallow object check.
          assert.ok(elementClass && ELEMENT_MODEL_FIELDS[elementClass], `${key}: property '${pname}' is an object array with no registered element model (fail closed)`);
          assertModelObject(item, elementClass!, key, `${pname}[]`);
        } else {
          assert.ok(field!.element, `${key}: property '${pname}' array element type is underivable (fail closed)`);
          const wantItemType: string = field!.element === 'number' ? 'number' : field!.element === 'boolean' ? 'boolean' : 'string';
          assert.equal(typeof item, wantItemType, `${key}: property '${pname}' items are ${field!.element}`);
        }
      }
    }
  }
  // ENFORCE derived requiredness at the properties level too: any property the
  // serializer writes UNCONDITIONALLY (required===true, i.e. not Optional-guarded)
  // MUST be present. (The generated models guard every field, so this set is empty
  // today; the check fails closed if a future model marks a field required.)
  for (const [fname, f] of propFields) {
    if (f.required) assert.ok(fname in props, `${key}: properties missing model-required '${fname}' (derived requiredness)`);
  }
  // Both channels are present (required above) and are arrays of closed error entries.
  const businessChan = area === 'validate' ? 'validationErrors' : 'executionErrors';
  for (const chan of AREA_CHANNELS[area]!) {
    assert.ok(Array.isArray(props[chan]), `${key}: channel '${chan}' is an array`);
    const allowed = chan === 'errors' ? SYSTEM_ERROR_KEYS : BUSINESS_ERROR_KEYS[area]!;
    const kinds = chan === 'errors' ? SYSTEM_ERROR_KINDS : BUSINESS_ERROR_KINDS[area]!;
    for (const entry of props[chan] as unknown[]) assertNestedError(entry, allowed, kinds, area, key, /* requireRoles */ false);
  }
  if (opts.terminalFailure) {
    const sys = props['errors'] as unknown[];
    const biz = props[businessChan] as unknown[];
    assert.ok(sys.length > 0, `${key}: terminal failure populates the system 'errors' channel`);
    assert.ok(biz.length > 0, `${key}: terminal failure populates the business '${businessChan}' channel`);
    assertNestedError(biz[0], BUSINESS_ERROR_KEYS[area]!, BUSINESS_ERROR_KINDS[area]!, area, key, /* requireRoles */ area === 'validate');
  }
}

function validateResource(parsed: WireFixtureRaw, schema: FixtureSchema, key: string): void {
  const area = schema.area!;
  const res = parsed.response;
  assert.ok(res, `${key}: resource fixture requires a top-level response`);
  // Response is EXACTLY {status, headers, body}.
  assertObjectSchema(res, ['status', 'headers', 'body'], [], key, 'resource response');
  assert.ok(res!.status === 200 || res!.status === 202, `${key}: resource status is 200 or 202`);

  assert.ok(parsed.request, `${key}: resource fixture requires a request`);
  // Request is EXACTLY {method, url} — no request headers, no request body.
  assertObjectSchema(parsed.request, ['method', 'url'], [], key, 'resource request');
  // EXACT response header set per STATUS: a 202 poll carries Retry-After + both
  // correlation ids (no Location); a terminal 200 carries only the correlation ids
  // (no Retry-After) — a cross-status header is rejected.
  assertExactHeaderKeys(
    res!.headers,
    res!.status === 202 ? RESOURCE_202_RESPONSE_HEADERS : RESOURCE_200_RESPONSE_HEADERS,
    key,
    `resource ${res!.status} response`,
  );
  assert.equal((parsed.request!.method ?? '').toUpperCase(), 'GET', `${key}: resource read is a GET`);
  requireApiVersion(parsed.request!.url, key, 'request');
  const requestPath = assertRequestPath(parsed.request!.url!, schema.operation, key);

  if (res!.status === 202) requireRetryAfter(res!, key);
  requireCorrelationHeaders(res!, key);
  const isTerminal = res!.status === 200;
  assertFullResourceBody(res!.body, area, key, {
    requireTimes: isTerminal,
    requestPath,
    terminalFailure: schema.terminalFailure,
  });

  const status = (res!.body as { properties: Record<string, unknown> }).properties[STATUS_FIELD] as string;
  if (isTerminal) {
    assert.ok(AREA_TERMINAL[area]!.includes(status), `${key}: a 200 resource is in a terminal ${area} state`);
  } else {
    assert.ok(!AREA_TERMINAL[area]!.includes(status), `${key}: a 202 resource is nonterminal`);
  }
}

function validateResourceSequence(parsed: WireFixtureRaw, schema: FixtureSchema, key: string): void {
  const area = schema.area!;
  const seq = parsed.sequence;
  assert.ok(seq && seq.length >= 2, `${key}: a polling sequence needs >= 2 steps`);
  seq!.forEach((step, i) => {
    // Step is closed to {note?, response} (a projection sequence has no per-step
    // request); a 202 poll response is EXACTLY {status, headers, body} carrying the
    // canonical Retry-After; the terminal 200 response is EXACTLY {status, body}
    // (no Retry-After on a terminal read). body is a CLOSED compact projection.
    assertObjectSchema(step, ['response'], ['note'], `${key}[${i}]`, 'sequence step');
    const res = step.response;
    const isLast = i === seq!.length - 1;
    if (isLast) {
      assertObjectSchema(res, ['status', 'body'], [], `${key}[${i}]`, 'terminal projection response');
    } else {
      assertObjectSchema(res, ['status', 'headers', 'body'], [], `${key}[${i}]`, '202 projection response');
      // Every 202 poll MUST advertise the exact canonical Retry-After, and ONLY that
      // header (a compact projection carries no correlation ids). requireRetryAfter
      // enforces the exact canonical string (no Number-coerced equivalents).
      assertExactHeaderKeys(res.headers, ['Retry-After'], `${key}[${i}]`, '202 projection response');
      requireRetryAfter(res, `${key}[${i}]`);
    }
    assertObjectSchema(res.body, ['properties'], [], `${key}[${i}]`, 'projection body');
    const props = (res.body as { properties: Record<string, unknown> }).properties;
    // Complete-and-closed projection: only status/time fields, status required.
    assertObjectSchema(props, PROJECTION_PROP.required, PROJECTION_PROP.optional, `${key}[${i}]`, 'projection properties');
    const status = props[STATUS_FIELD];
    assert.ok(typeof status === 'string' && AREA_STATES[area]!.includes(status as string), `${key}[${i}]: known ${area} status`);
    // Projection timestamps, when present, are ISO-8601 UTC instants.
    if (START_TIME_FIELD in props) assert.match(props[START_TIME_FIELD] as string, ISO_UTC_RE, `${key}[${i}]: startTime is ISO-8601 UTC`);
    if (END_TIME_FIELD in props) assert.match(props[END_TIME_FIELD] as string, ISO_UTC_RE, `${key}[${i}]: endTime is ISO-8601 UTC`);
    if (isLast) {
      assert.equal(res.status, 200, `${key}: the final poll is 200`);
      assert.ok(AREA_TERMINAL[area]!.includes(status as string), `${key}: the final status is terminal`);
    } else {
      assert.equal(res.status, 202, `${key}[${i}]: nonterminal polls are 202`);
      assert.ok(!AREA_TERMINAL[area]!.includes(status as string), `${key}[${i}]: nonterminal status`);
    }
  });
}

// The exact response header key sets per VF4 tuple position (closed).
const TRACE_POST_RESPONSE_HEADERS = ['Location', 'Retry-After', 'x-ms-correlation-request-id', 'x-ms-request-id'];
const TRACE_GET_RESPONSE_HEADERS = ['x-ms-correlation-request-id', 'x-ms-request-id'];
// An HTTP entity-tag value for If-Match: `*`, a strong `"..."`, or a weak `W/"..."`.
const ETAG_VALUE_RE = /^(?:\*|W\/"[^"]*"|"[^"]*")$/;

function validateTrace(parsed: WireFixtureRaw & { resourceId?: unknown }, key: string): void {
  const seq = parsed.sequence;
  // EXACT four-step tuple, in order: POST validate, GET validations/latest,
  // POST validate WITH If-Match, GET validations/latest. No more, no fewer.
  assert.ok(seq && seq.length === 4, `${key}: the VF4 trace is exactly [POST, GET, POST(If-Match), GET]`);
  const EXPECT: Array<{ method: 'POST' | 'GET'; op: Operation; ifMatch: boolean }> = [
    { method: 'POST', op: 'validate', ifMatch: false },
    { method: 'GET', op: 'validationGet', ifMatch: false },
    { method: 'POST', op: 'validate', ifMatch: true },
    { method: 'GET', op: 'validationGet', ifMatch: false },
  ];

  // The trace declares the singleton resource it operates on; every URL/id binds to it.
  assert.ok(typeof parsed.resourceId === 'string' && (parsed.resourceId as string).length > 0, `${key}: the trace records the singleton resourceId`);
  const rawSingleton = parsed.resourceId as string;
  assertCanonicalRawPath(rawSingleton, key, 'trace singleton resourceId');
  const singletonSegs = rawSingleton.split('/').filter(Boolean);
  const singletonId = bindArmIdentity(singletonSegs, rawSingleton, key, 'resourceId');
  assertExactResourceSegs(singletonSegs, LOCATION_RESOURCE_TAIL.validation, key, 'trace singleton');
  assert.ok(singletonId.configuration !== undefined, `${key}: the singleton addresses a configuration`);

  const posts: HttpResponse[] = [];
  const getBodies: Array<{ id: string; properties: Record<string, unknown> }> = [];
  let ifMatchValue: string | undefined;

  seq!.forEach((step, i) => {
    const spec = EXPECT[i]!;
    const at = `${key}[${i}]`;
    // Closed step schema: exactly {request, response} plus an optional note.
    assertObjectSchema(step, ['request', 'response'], ['note'], at, 'sequence step');
    assert.ok(step.request, `${at}: records a request`);
    assert.equal((step.request!.method ?? '').toUpperCase(), spec.method, `${at}: step ${i} is a ${spec.method}`);

    // The request URL binds to the singleton (validate action or the GET itself).
    const reqId = parseArmUrl(step.request!.url, at, 'request').identity;
    assertRequestPath(step.request!.url!, spec.op, at);
    assertIdentityBinding(reqId, singletonId, at, 'request/singleton');

    if (spec.method === 'POST') {
      // POST request: closed to {method, url} or {method, url, headers}; NEVER a body
      // (validate is a bodyless action). Only step 2 carries an If-Match header, and
      // its value must be a well-formed entity-tag.
      const reqAllowed = spec.ifMatch ? ['method', 'url', 'headers'] : ['method', 'url'];
      assertObjectSchema(step.request, reqAllowed, [], at, 'POST request');
      if (spec.ifMatch) {
        assertExactHeaderKeys(step.request!.headers, ['If-Match'], at, 'POST request');
        ifMatchValue = step.request!.headers!['If-Match']!;
        assert.match(ifMatchValue, ETAG_VALUE_RE, `${at}: If-Match must be a well-formed entity-tag`);
      } else {
        assert.ok(step.request!.headers === undefined, `${at}: the first validate carries no request headers`);
      }
      // POST response: closed to {status, headers}, 202, EXACT header set, no body.
      assertObjectSchema(step.response, ['status', 'headers'], [], at, 'POST response');
      assert.equal(step.response.status, 202, `${at}: validate POST is accepted (202, not 412)`);
      assertExactHeaderKeys(step.response.headers, TRACE_POST_RESPONSE_HEADERS, at, 'POST response');
      requireRetryAfter(step.response, at);
      requireCorrelationHeaders(step.response, at);
      const locId = parseArmUrl(header(step.response, 'Location'), at, 'Location').identity;
      assertExactResourceSegs(locId.resourcePath.split('/').filter(Boolean), LOCATION_RESOURCE_TAIL.validation, at, 'POST Location');
      assert.equal(locId.resourcePath, singletonId.resourcePath, `${at}: POST Location resolves the singleton`);
      // The ignored precondition returns no validator (no ETag key in the closed set).
      posts.push(step.response);
    } else {
      // GET request: closed to exactly {method, url}; no headers, no body.
      assertObjectSchema(step.request, ['method', 'url'], [], at, 'GET request');
      // GET response: closed to {status, headers, body}, 200, EXACT header set.
      assertObjectSchema(step.response, ['status', 'headers', 'body'], [], at, 'GET response');
      assert.equal(step.response.status, 200, `${at}: each GET is a terminal 200`);
      assertExactHeaderKeys(step.response.headers, TRACE_GET_RESPONSE_HEADERS, at, 'GET response');
      requireCorrelationHeaders(step.response, at);
      assertFullResourceBody(step.response.body, 'validate', at, { requireTimes: true, requestPath: singletonId.resourcePath });
      const body = step.response.body as { id: string; properties: Record<string, unknown> };
      assert.equal(body.id, singletonId.resourcePath, `${at}: GET body id is the singleton`);
      getBodies.push(body);
    }
  });

  assert.equal(posts.length, 2, `${key}: exactly two validate POSTs`);
  assert.equal(getBodies.length, 2, `${key}: exactly two validations/latest GETs`);
  // Both GETs read the SAME singleton, yet the later plan REPLACED the earlier one
  // in place — proving no precondition/version guard prevented replacement (VF4).
  assert.equal(getBodies[0]!.id, getBodies[1]!.id, `${key}: both GETs target the same validations/latest resource`);
  // Require TWO explicit, nonempty, DISTINCT execution plans, each a typed string —
  // a missing or non-string plan would let the "plan was replaced" claim pass vacuously.
  const plans = getBodies.map((b) => b.properties['executionPlanJson']);
  plans.forEach((p, i) => assert.ok(typeof p === 'string' && (p as string).length > 0, `${key}: GET[${i}] carries a nonempty string executionPlanJson`));
  const [planA, planB] = plans as [string, string];
  assert.notEqual(planA, planB, `${key}: the later validation replaced executionPlanJson`);
  // STATIC-INFERENCE illustration (not an observed runtime capture): the second
  // validate carries a CONCRETE, well-formed, NONMATCHING If-Match entity-tag — a value
  // a precondition-HONORING service would reject with 412. A match-any `*` is
  // deliberately NOT accepted: `*` is satisfied by any existing resource, so it could
  // not distinguish a service that honors preconditions from one that ignores them. The
  // inferred contract (proven statically above against the extracts: no precondition
  // read, no 412 mapped, no eTag field) accepts it with 202 and replaces the plan, which
  // is what demonstrates the precondition is ignored. Since the service issues NO ETag,
  // any concrete quoted value is nonmatching by construction.
  assert.ok(ifMatchValue !== undefined, `${key}: the second validate carries an If-Match`);
  assert.notEqual(ifMatchValue, '*', `${key}: the If-Match must be a concrete nonmatching ETag, not a satisfiable match-any *`);
  assert.match(ifMatchValue!, /^(?:W\/"[^"]*"|"[^"]*")$/, `${key}: the If-Match is a quoted (strong/weak) nonmatching entity-tag`);
  // Sanity: both plans declare distinct ids, so "the plan was replaced" is not vacuous.
  const planAId = (JSON.parse(planA) as { planId?: unknown }).planId;
  assert.ok(typeof planAId === 'string' && (planAId as string).length > 0, `${key}: plan A declares a planId`);
  const planBId = (JSON.parse(planB) as { planId?: unknown }).planId;
  assert.ok(typeof planBId === 'string' && (planBId as string).length > 0, `${key}: plan B declares a planId`);
  assert.notEqual(planAId, planBId, `${key}: the replacement plan has a different planId`);
}

function validateOperations(parsed: WireFixtureRaw, key: string): void {
  const ops = (parsed.value ?? []) as unknown[];
  assert.ok(ops.length > 0, `${key}: the operations snapshot is non-empty`);
  // Each entry is a COMPLETE, CLOSED operation object: exactly {name, isDataAction,
  // display}, display closed to {provider, resource, operation, description}, with a
  // boolean isDataAction and non-empty string display fields — not a bare name.
  const names: string[] = [];
  ops.forEach((op, i) => {
    assert.ok(op && typeof op === 'object' && !Array.isArray(op), `${key}: operation[${i}] is an object`);
    const o = op as Record<string, unknown>;
    assert.deepEqual([...Object.keys(o)].sort(), ['display', 'isDataAction', 'name'], `${key}: operation[${i}] has exactly {name, isDataAction, display}`);
    assert.ok(typeof o['name'] === 'string' && (o['name'] as string).startsWith('Microsoft.Chaos/'), `${key}: operation[${i}] name is a Microsoft.Chaos op`);
    assert.equal(typeof o['isDataAction'], 'boolean', `${key}: operation[${i}] isDataAction is a boolean`);
    const d = o['display'];
    assert.ok(d && typeof d === 'object' && !Array.isArray(d), `${key}: operation[${i}] display is an object`);
    const dd = d as Record<string, unknown>;
    assert.deepEqual([...Object.keys(dd)].sort(), ['description', 'operation', 'provider', 'resource'], `${key}: operation[${i}] display has exactly {provider, resource, operation, description}`);
    for (const dk of ['provider', 'resource', 'operation', 'description']) {
      assert.ok(typeof dd[dk] === 'string' && (dd[dk] as string).length > 0, `${key}: operation[${i}] display.${dk} is a non-empty string`);
    }
    names.push(o['name'] as string);
  });
  for (const op of Object.values(PROVIDER_OPERATIONS)) {
    assert.ok(names.includes(op), `${key}: snapshot must contain invoked op ${op}`);
  }
  assert.ok(!names.includes('Microsoft.Chaos/workspaces/scenarios/run/action'), `${key}: DX1 run/action must be absent`);
}

// EXACT top-level key schema per fixture shape. Every fixture carries the common
// envelope (`description`, `provenance`, `operationId`); each shape then adds its
// own required/optional keys. additionalProperties is disabled: a key valid for
// another shape cannot appear here. `expected`/`context` are optional only on
// acceptance (their presence/absence is further pinned by the acceptance checks).
const TOPLEVEL_SHAPE_SCHEMA: Record<Shape, { required: string[]; optional: string[] }> = {
  operations: { required: ['description', 'provenance', 'operationId', 'value'], optional: [] },
  acceptance: { required: ['description', 'provenance', 'operationId', 'request', 'response'], optional: ['expected', 'context'] },
  resource: { required: ['description', 'provenance', 'operationId', 'request', 'response'], optional: [] },
  resourceSequence: { required: ['description', 'provenance', 'operationId', 'sequence'], optional: [] },
  trace: { required: ['description', 'provenance', 'operationId', 'resourceId', 'sequence'], optional: [] },
};

/**
 * Validates the EXACT top-level shape of a fixture: the closed required+optional
 * key set for its shape (no cross-shape keys, no extras, no omissions) plus the
 * primitive typing of the envelope's free-text fields (`description` and, when
 * present, `context` are non-empty strings).
 */
function assertTopLevelShape(parsed: WireFixtureRaw, schema: FixtureSchema, key: string): void {
  const shapeSchema = TOPLEVEL_SHAPE_SCHEMA[schema.shape];
  assertObjectSchema(parsed, shapeSchema.required, shapeSchema.optional, key, 'top-level');
  const p = parsed as Record<string, unknown>;
  assert.ok(typeof p['description'] === 'string' && (p['description'] as string).length > 0, `${key}: description is a non-empty string`);
  if ('context' in p) {
    assert.ok(typeof p['context'] === 'string' && (p['context'] as string).length > 0, `${key}: context is a non-empty string`);
  }
}

/** Closed dispatcher shared by the positive suite and the negative mutation tests. */
function validateFixture(parsed: WireFixtureRaw, schema: FixtureSchema, key: string): void {
  assertTopLevelShape(parsed, schema, key);
  assertEnvelope(parsed, EXPECTED_OPERATION_ID[schema.operation], key);
  switch (schema.shape) {
    case 'operations': validateOperations(parsed, key); break;
    case 'acceptance': validateAcceptance(parsed, schema, key); break;
    case 'resource': validateResource(parsed, schema, key); break;
    case 'resourceSequence': validateResourceSequence(parsed, schema, key); break;
    case 'trace': validateTrace(parsed, key); break;
  }
}

test('every fixture on disk has an explicit operation-specific schema (no undocumented fixtures)', () => {
  const onDisk = listFixtureFiles().map(posixKey).sort();
  const declared = Object.keys(FIXTURE_SCHEMAS).sort();
  assert.deepEqual(onDisk, declared, 'FIXTURE_SCHEMAS must map exactly the fixtures on disk');
});

test('every fixture conforms to its closed operation-specific schema (omission/extra is a failure)', () => {
  for (const full of listFixtureFiles()) {
    const key = posixKey(full);
    const schema = FIXTURE_SCHEMAS[key];
    assert.ok(schema, `${key}: has an explicit schema`);
    validateFixture(JSON.parse(readFileSync(full, 'utf8')) as WireFixtureRaw, schema!, key);
  }
});

// ---------------------------------------------------------------------------
// NEGATIVE tests: a valid fixture with a required field removed, a wrong request
// path, or an extra key MUST be rejected — proving the schema is not omission- or
// substitution-evasive.
// ---------------------------------------------------------------------------

function loadFixtureObject(rel: string): WireFixtureRaw {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, rel), 'utf8')) as WireFixtureRaw;
}

function expectReject(rel: string, mutate: (fx: any) => void, why: string): void {
  const schema = FIXTURE_SCHEMAS[rel]!;
  const fx = loadFixtureObject(rel) as any;
  mutate(fx);
  assert.throws(() => validateFixture(fx, schema, rel), `expected rejection: ${why}`);
}

function expectAccept(rel: string, mutate: (fx: any) => void, why: string): void {
  const schema = FIXTURE_SCHEMAS[rel]!;
  const fx = loadFixtureObject(rel) as any;
  mutate(fx);
  assert.doesNotThrow(() => validateFixture(fx, schema, rel), `expected acceptance: ${why}`);
}

// A well-formed run `resources` element matching the derived ScenarioRunResource
// model (a string scalar, another string scalar, and a string array).
function validRunResource(): Record<string, unknown> {
  return { resourceId: '/subscriptions/s/resourceGroups/rg/providers/Microsoft.Compute/virtualMachines/vm1', targetType: 'Microsoft-VirtualMachine', selectors: ['sel-a', 'sel-b'] };
}

test('positive: a run resource carrying a valid resources[] element is accepted (finding #5)', () => {
  expectAccept('execute/run-succeeded-200.json', (fx) => { fx.response.body.properties.resources = [validRunResource()]; }, 'valid resources element');
});

test('negative: a resources[] element with an unknown key is rejected (closed element schema, finding #5)', () => {
  expectReject('execute/run-succeeded-200.json', (fx) => {
    const r = validRunResource(); (r as any).injected = true; fx.response.body.properties.resources = [r];
  }, 'unknown resources element key');
});

test('negative: a resources[] element scalar of the wrong type is rejected (finding #5)', () => {
  expectReject('execute/run-succeeded-200.json', (fx) => {
    const r = validRunResource(); (r as any).resourceId = 42; fx.response.body.properties.resources = [r];
  }, 'resourceId not a string');
});

test('negative: a resources[] element array item of the wrong type is rejected (finding #5)', () => {
  expectReject('execute/run-succeeded-200.json', (fx) => {
    const r = validRunResource(); (r as any).selectors = ['ok', 7]; fx.response.body.properties.resources = [r];
  }, 'selectors item not a string');
});

test('negative: a non-object resources[] element is rejected (finding #5)', () => {
  expectReject('execute/run-succeeded-200.json', (fx) => { fx.response.body.properties.resources = ['not-an-object']; }, 'resources element not an object');
});

test('the committed execute/run-succeeded fixture carries a source-backed resources element that validates against the model (finding #4)', () => {
  const fx = loadFixtureObject('execute/run-succeeded-200.json') as unknown as { response: { body: { properties: { resources?: unknown[] } } } };
  const resources = fx.response.body.properties.resources;
  assert.ok(Array.isArray(resources) && resources.length > 0, 'the committed fixture carries a source-backed resources array');
  // It is validated recursively by the positive suite; assert it does not throw here.
  assert.doesNotThrow(() => validateFixture(fx as unknown as WireFixtureRaw, FIXTURE_SCHEMAS['execute/run-succeeded-200.json']!, 'execute/run-succeeded-200.json'));
});

test('negative: the COMMITTED resources element rejects an unknown key (fail-closed recursion, finding #4)', () => {
  expectReject('execute/run-succeeded-200.json', (fx) => { fx.response.body.properties.resources[0].bogus = 1; }, 'unknown committed resources key');
});

test('negative: the COMMITTED resources element rejects a wrong-typed selector item (finding #4)', () => {
  expectReject('execute/run-succeeded-200.json', (fx) => { fx.response.body.properties.resources[0].selectors = [5]; }, 'committed selector not a string');
});

test('negative: an acceptance fixture missing its request is rejected', () => {
  expectReject('execute/accept-202.json', (fx) => { delete fx.request; }, 'missing request');
});

test('negative: an acceptance fixture missing Retry-After is rejected', () => {
  expectReject('validate/accept-202.json', (fx) => { delete fx.response.headers['Retry-After']; }, 'missing Retry-After');
});

test('negative: an acceptance fixture with a wrong request path is rejected', () => {
  expectReject('validate/accept-202.json', (fx) => {
    fx.request.url = fx.request.url.replace('/validate?', '/execute?');
  }, 'wrong action path');
});

test('negative: a resource fixture missing properties.status is rejected', () => {
  expectReject('execute/run-succeeded-200.json', (fx) => { delete fx.response.body.properties.status; }, 'missing status');
});

test('negative: a resource fixture missing a body id is rejected', () => {
  expectReject('execute/run-succeeded-200.json', (fx) => { delete fx.response.body.id; }, 'missing id');
});

test('negative: a resource fixture whose body id disagrees with the request path is rejected', () => {
  expectReject('execute/run-succeeded-200.json', (fx) => {
    fx.response.body.id = `${fx.response.body.id}-tampered`;
  }, 'id != request path');
});

test('negative: a resource fixture missing correlation headers is rejected', () => {
  expectReject('validate/validation-succeeded-200.json', (fx) => { delete fx.response.headers['x-ms-request-id']; }, 'missing x-ms-request-id');
});

test('negative: a resource fixture dropping a required error channel is rejected', () => {
  expectReject('execute/run-nonterminal-202.json', (fx) => { delete fx.response.body.properties.executionErrors; }, 'missing executionErrors channel');
});

test('negative: a terminal-failure fixture with an empty business channel is rejected', () => {
  expectReject('validate/validation-requires-attention-200.json', (fx) => { fx.response.body.properties.validationErrors = []; }, 'empty business channel');
});

test('negative: an unexpected top-level key is rejected (closed schema)', () => {
  expectReject('cancel/accept-202.json', (fx) => { fx.unexpected = true; }, 'extra top-level key');
});

test('negative: an unexpected resource-body key is rejected (closed schema)', () => {
  expectReject('execute/run-succeeded-200.json', (fx) => { fx.response.body.extra = 1; }, 'extra body key');
});

test('negative: a wrong api-version on the request is rejected', () => {
  expectReject('cancel/run-canceled-200.json', (fx) => {
    fx.request.url = fx.request.url.replace('2026-05-01-preview', '2026-02-01-preview');
  }, 'wrong api-version');
});

test('negative: a foreign URL host is rejected', () => {
  expectReject('execute/run-succeeded-200.json', (fx) => {
    fx.request.url = fx.request.url.replace('management.azure.com', 'evil.example.com');
  }, 'foreign host');
});

test('negative: a resource missing name/type is rejected', () => {
  expectReject('execute/run-succeeded-200.json', (fx) => { delete fx.response.body.name; }, 'missing name');
  expectReject('validate/validation-succeeded-200.json', (fx) => { delete fx.response.body.type; }, 'missing type');
});

test('negative: an extra nested properties key is rejected (additionalProperties disabled)', () => {
  expectReject('execute/run-succeeded-200.json', (fx) => { fx.response.body.properties.sneaky = 1; }, 'extra properties key');
});

test('negative: a foreign error channel leaking into another area is rejected', () => {
  expectReject('execute/run-succeeded-200.json', (fx) => { fx.response.body.properties.validationErrors = []; }, 'validation channel in a run');
});

test('negative: an extra key inside a nested error entry is rejected', () => {
  expectReject('execute/run-failed-200.json', (fx) => { fx.response.body.properties.executionErrors[0].injected = true; }, 'extra nested error key');
});

test('negative: a nested error missing its code is rejected', () => {
  expectReject('validate/validation-requires-attention-200.json', (fx) => { delete fx.response.body.properties.validationErrors[0].code; }, 'nested error missing code');
});

test('negative: an incomplete polling projection (extra key) is rejected', () => {
  expectReject('execute/run-transitions.json', (fx) => { fx.sequence[0].response.body.properties.errors = []; }, 'projection with an extra key');
});

test('negative: a terminal resource missing endTime is rejected', () => {
  expectReject('execute/run-succeeded-200.json', (fx) => { delete fx.response.body.properties.endTime; }, 'terminal resource missing endTime');
});

test('negative: an execute acceptance whose expected.runId disagrees with the Location is rejected', () => {
  expectReject('execute/accept-202.json', (fx) => { fx.expected.runId = '00000000-0000-0000-0000-000000000000'; }, 'expected.runId mismatch');
});

// --- Finding #15: strict full-URL parsing + resource-identity binding ---

test('negative: a URL carrying userinfo (credentials) is rejected', () => {
  expectReject('cancel/run-canceled-200.json', (fx) => {
    fx.request.url = fx.request.url.replace('https://management.azure.com', 'https://user:pass@management.azure.com');
  }, 'userinfo in URL');
});

test('negative: a URL carrying a fragment is rejected', () => {
  expectReject('cancel/run-canceled-200.json', (fx) => {
    fx.request.url = fx.request.url.replace('?api-version=', '#frag?api-version=');
  }, 'fragment in URL');
});

test('negative: a URL with a duplicate api-version parameter is rejected', () => {
  expectReject('cancel/run-canceled-200.json', (fx) => {
    fx.request.url = `${fx.request.url}&api-version=${API_VERSION}`;
  }, 'duplicate api-version');
});

test('negative: a URL with a stray extra query parameter is rejected', () => {
  expectReject('cancel/run-canceled-200.json', (fx) => {
    fx.request.url = `${fx.request.url}&$expand=all`;
  }, 'stray query parameter');
});

test('negative: an acceptance whose Location resource identity disagrees with the request is rejected', () => {
  expectReject('execute/accept-202.json', (fx) => {
    // Repoint the Location to a DIFFERENT subscription than the execute request.
    fx.response.headers.Location = fx.response.headers.Location.replace(
      '/subscriptions/11111111-1111-1111-1111-111111111111/',
      '/subscriptions/99999999-9999-9999-9999-999999999999/',
    );
    fx.expected.runResourceId = fx.expected.runResourceId.replace(
      '/subscriptions/11111111-1111-1111-1111-111111111111/',
      '/subscriptions/99999999-9999-9999-9999-999999999999/',
    );
  }, 'request/Location subscription mismatch');
});

test('negative: a validate acceptance whose Location configuration disagrees with the request is rejected', () => {
  expectReject('validate/accept-202.json', (fx) => {
    fx.response.headers.Location = fx.response.headers.Location.replace('/configurations/cfg-demo/', '/configurations/cfg-other/');
  }, 'request/Location configuration mismatch');
});

// --- Finding #16: closed/typed envelope, headers, and timestamps ---

test('negative: a provenance missing its citation is rejected', () => {
  expectReject('validate/validation-succeeded-200.json', (fx) => { delete fx.provenance.citation; }, 'provenance missing citation');
});

test('negative: a provenance with an undeclared source is rejected', () => {
  expectReject('validate/validation-succeeded-200.json', (fx) => { fx.provenance.source = 'gw.not.a.real.source'; }, 'undeclared provenance source');
});

test('negative: a provenance with a malformed citation token is rejected', () => {
  expectReject('validate/validation-succeeded-200.json', (fx) => { fx.provenance.citation = 'VF2, NOTATOKEN'; }, 'malformed citation token');
});

test('negative: an extra provenance key is rejected (closed schema)', () => {
  expectReject('validate/validation-succeeded-200.json', (fx) => { fx.provenance.extra = true; }, 'extra provenance key');
});

test('negative: an unknown operationId is rejected', () => {
  expectReject('validate/validation-succeeded-200.json', (fx) => { fx.operationId = 'ScenarioConfigurations_NotAThing'; }, 'unknown operationId');
});

// --- Finding #6: exact operation-specific paths, ids, names, and resource types ---

test('negative: a missing operationId is rejected (operationId is required)', () => {
  expectReject('validate/validation-succeeded-200.json', (fx) => { delete fx.operationId; }, 'missing operationId');
});

test('negative: a mismatched (but known) operationId is rejected', () => {
  // A valid generated id for a DIFFERENT operation must not pass.
  expectReject('validate/validation-succeeded-200.json', (fx) => { fx.operationId = 'ScenarioRuns_Get'; }, 'mismatched operationId');
});

test('negative: an extra request path segment is rejected (exact segment count)', () => {
  expectReject('cancel/run-canceled-200.json', (fx) => {
    fx.request.url = fx.request.url.replace('?api-version=', '/extra?api-version=');
    fx.response.body.id = `${fx.response.body.id}/extra`;
  }, 'extra request path segment');
});

// --- Finding #6b: raw-canonical ARM paths (pre-normalization) + exact Location ---

test('negative: a request path with a "." dot segment is rejected (raw-canonical)', () => {
  expectReject('cancel/run-canceled-200.json', (fx) => {
    fx.request.url = fx.request.url.replace('/providers/', '/./providers/');
  }, 'dot segment in path');
});

test('negative: a request path with a ".." traversal segment is rejected (raw-canonical)', () => {
  expectReject('cancel/run-canceled-200.json', (fx) => {
    // A traversal that URL-normalization would collapse must be rejected on the RAW path.
    fx.request.url = fx.request.url.replace('/resourceGroups/rg-chaos/', '/resourceGroups/rg-chaos/../rg-chaos/');
  }, 'traversal segment in path');
});

test('negative: a percent-encoded separator in the path is rejected (raw-canonical)', () => {
  expectReject('cancel/run-canceled-200.json', (fx) => {
    fx.request.url = fx.request.url.replace('/runs/', '/runs%2F');
  }, 'encoded separator in path');
});

test('negative: an ARM request URL with an explicit :443 authority is rejected (raw authority)', () => {
  expectReject('cancel/run-canceled-200.json', (fx) => {
    fx.request.url = fx.request.url.replace('https://management.azure.com/', 'https://management.azure.com:443/');
  }, 'explicit :443 on ARM request');
});

test('negative: an ARM request URL with userinfo in the authority is rejected (raw authority)', () => {
  expectReject('cancel/run-canceled-200.json', (fx) => {
    fx.request.url = fx.request.url.replace('https://management.azure.com/', 'https://user@management.azure.com/');
  }, 'userinfo on ARM request');
});

test('negative: an ARM request URL with a noncanonical trailing-ampersand query is rejected (raw query)', () => {
  expectReject('cancel/run-canceled-200.json', (fx) => {
    fx.request.url = `${fx.request.url}&`;
  }, 'trailing ampersand on ARM query');
});

test('negative: an acceptance Location with an extra trailing segment is rejected (exact resource)', () => {
  expectReject('execute/accept-202.json', (fx) => {
    // Append a segment after /runs/{runId}; a tail-only check would miss this.
    fx.response.headers.Location = fx.response.headers.Location.replace('?api-version=', '/extra?api-version=');
    fx.expected.runResourceId = `${fx.expected.runResourceId}/extra`;
  }, 'extra Location segment');
});

test('negative: a validate acceptance Location with an extra trailing segment is rejected', () => {
  expectReject('validate/accept-202.json', (fx) => {
    fx.response.headers.Location = fx.response.headers.Location.replace('/validations/latest?', '/validations/latest/extra?');
  }, 'extra validate Location segment');
});

test('negative: a wrong resource type is rejected (exact type discriminator)', () => {
  expectReject('validate/validation-succeeded-200.json', (fx) => {
    fx.response.body.type = 'Microsoft.Chaos/workspaces/scenarios/runs';
  }, 'wrong resource type');
});

test('negative: a resource name that is not the last id segment is rejected', () => {
  expectReject('execute/run-succeeded-200.json', (fx) => { fx.response.body.name = 'not-the-guid'; }, 'name != last id segment');
});

test('negative: a validation resource whose name is not "latest" is rejected', () => {
  expectReject('validate/validation-succeeded-200.json', (fx) => {
    // Move the id off the singleton and rename to keep name==lastSegment, so ONLY
    // the "must be latest" discriminator fails.
    fx.request.url = fx.request.url.replace('/validations/latest?', '/validations/previous?');
    fx.response.body.id = fx.response.body.id.replace('/validations/latest', '/validations/previous');
    fx.response.body.name = 'previous';
  }, 'validation resource not the latest singleton');
});

test('negative: an unknown response header name is rejected', () => {
  expectReject('validate/validation-succeeded-200.json', (fx) => { fx.response.headers['X-Injected'] = 'nope'; }, 'unknown header name');
});

test('negative: a non-string header value is rejected', () => {
  expectReject('execute/accept-202.json', (fx) => { fx.response.headers['Retry-After'] = 10; }, 'non-string header value');
});

test('negative: a noncanonical Retry-After representation is rejected (exact "10" required)', () => {
  for (const bad of ['1e1', '+10', '10.0', ' 10', '10 ', '010']) {
    expectReject('execute/accept-202.json', (fx) => { fx.response.headers['Retry-After'] = bad; }, `noncanonical Retry-After '${bad}'`);
  }
});

// --- Finding #4: exact per-operation/status header sets + typed optional props ---

test('negative: a terminal 200 resource carrying a Retry-After header is rejected (cross-status header)', () => {
  expectReject('execute/run-succeeded-200.json', (fx) => { fx.response.headers['Retry-After'] = '10'; }, '200 with Retry-After');
});

test('negative: a terminal 200 resource carrying a Location header is rejected', () => {
  expectReject('validate/validation-succeeded-200.json', (fx) => { fx.response.headers['Location'] = 'https://management.azure.com/x?api-version=2026-05-01-preview'; }, '200 with Location');
});

test('negative: a 202 poll resource missing its Retry-After header is rejected', () => {
  expectReject('execute/run-nonterminal-202.json', (fx) => { delete fx.response.headers['Retry-After']; }, '202 without Retry-After');
});

test('negative: a 202 poll resource carrying a Location header is rejected', () => {
  expectReject('validate/validation-nonterminal-202.json', (fx) => { fx.response.headers['Location'] = 'https://management.azure.com/x?api-version=2026-05-01-preview'; }, '202 resource with Location');
});

test('negative: an acceptance missing its Location header is rejected (exact acceptance headers)', () => {
  expectReject('execute/accept-202.json', (fx) => { delete fx.response.headers['Location']; }, 'acceptance without Location');
});

test('negative: a non-string typed optional property (executionPlanJson) is rejected', () => {
  expectReject('validate/validation-succeeded-200.json', (fx) => { fx.response.body.properties.executionPlanJson = 42; }, 'numeric executionPlanJson');
});

test('negative: an optional property with the wrong wire kind (executionPlanJson as array) is rejected', () => {
  expectReject('validate/validation-succeeded-200.json', (fx) => { fx.response.body.properties.executionPlanJson = ['x']; }, 'array executionPlanJson');
});

test('negative: a non-ISO-UTC startTime is rejected', () => {
  expectReject('validate/validation-succeeded-200.json', (fx) => { fx.response.body.properties.startTime = '2026-05-01 12:00:00'; }, 'naive startTime');
});

test('negative: a local-offset endTime is rejected', () => {
  expectReject('execute/run-succeeded-200.json', (fx) => { fx.response.body.properties.endTime = '2026-05-01T12:00:40+02:00'; }, 'local-offset endTime');
});

// --- Finding #17: the VF4 trace must be an exact four-step tuple ---

test('negative: a VF4 trace with a fifth step is rejected', () => {
  expectReject('validate/plan-mutation-sequence.json', (fx) => { fx.sequence.push(fx.sequence[3]); }, 'extra trace step');
});

test('negative: a VF4 trace with reordered steps (GET before the first POST) is rejected', () => {
  expectReject('validate/plan-mutation-sequence.json', (fx) => {
    const s = fx.sequence; [s[0], s[1]] = [s[1], s[0]];
  }, 'reordered trace steps');
});

test('negative: a VF4 trace whose If-Match is on the FIRST validate is rejected', () => {
  expectReject('validate/plan-mutation-sequence.json', (fx) => {
    fx.sequence[0].request.headers = { 'If-Match': '"plan-A"' };
    delete fx.sequence[2].request.headers;
  }, 'If-Match on the wrong step');
});

test('negative: a VF4 trace where the later plan did NOT change is rejected', () => {
  expectReject('validate/plan-mutation-sequence.json', (fx) => {
    fx.sequence[3].response.body.properties.executionPlanJson = fx.sequence[1].response.body.properties.executionPlanJson;
  }, 'plan not replaced');
});

test('negative: a VF4 trace whose GET body id disagrees with the singleton resourceId is rejected', () => {
  expectReject('validate/plan-mutation-sequence.json', (fx) => {
    fx.sequence[3].response.body.id = `${fx.sequence[3].response.body.id}-tampered`;
  }, 'GET id != singleton');
});

// --- Finding #7: each VF4 tuple position is a CLOSED schema ---

test('negative: a VF4 POST response carrying an extra header is rejected (exact header set)', () => {
  expectReject('validate/plan-mutation-sequence.json', (fx) => {
    fx.sequence[0].response.headers.ETag = '"plan-A"';
  }, 'extra POST response header');
});

test('negative: a VF4 POST response missing a correlation header is rejected', () => {
  expectReject('validate/plan-mutation-sequence.json', (fx) => {
    delete fx.sequence[0].response.headers['x-ms-correlation-request-id'];
  }, 'POST response missing correlation header');
});

test('negative: a VF4 POST carrying a request body is rejected (validate is bodyless)', () => {
  expectReject('validate/plan-mutation-sequence.json', (fx) => {
    fx.sequence[0].request.body = { some: 'payload' };
  }, 'POST request body');
});

test('negative: a VF4 If-Match with a malformed entity-tag value is rejected', () => {
  expectReject('validate/plan-mutation-sequence.json', (fx) => {
    fx.sequence[2].request.headers['If-Match'] = 'not-a-quoted-etag';
  }, 'malformed If-Match value');
});

test('negative: a VF4 POST request carrying an unexpected header (besides If-Match) is rejected', () => {
  expectReject('validate/plan-mutation-sequence.json', (fx) => {
    fx.sequence[2].request.headers['x-ms-request-id'] = 'aaaaaaaa-0000-0000-0000-0000000000ff';
  }, 'extra POST request header');
});

test('negative: a VF4 GET carrying request headers is rejected (GET has none)', () => {
  expectReject('validate/plan-mutation-sequence.json', (fx) => {
    fx.sequence[1].request.headers = { 'If-Match': '"plan-A"' };
  }, 'GET request headers');
});

test('negative: a VF4 GET response with a Location header is rejected (exact header set)', () => {
  expectReject('validate/plan-mutation-sequence.json', (fx) => {
    fx.sequence[1].response.headers.Location = fx.sequence[0].response.headers.Location;
  }, 'GET response Location header');
});

// --- VF4: the If-Match is a concrete NONMATCHING entity-tag (not a satisfiable `*`) ---

test('negative: a VF4 If-Match that is the match-any `*` is rejected (must be a concrete nonmatching ETag)', () => {
  // A match-any `*` is satisfied by any existing resource, so it cannot demonstrate that
  // the service IGNORES the precondition. The illustration requires a concrete
  // nonmatching entity-tag (the case a precondition-honoring service would 412 on), so a
  // match-any `*` is rejected.
  expectReject('validate/plan-mutation-sequence.json', (fx) => {
    fx.sequence[2].request.headers['If-Match'] = '*';
  }, 'match-any * instead of a concrete nonmatching ETag');
});

test('negative: a VF4 GET whose executionPlanJson is missing is rejected', () => {
  expectReject('validate/plan-mutation-sequence.json', (fx) => {
    delete fx.sequence[1].response.body.properties.executionPlanJson;
  }, 'missing plan');
});

test('negative: a VF4 GET whose executionPlanJson is empty is rejected', () => {
  expectReject('validate/plan-mutation-sequence.json', (fx) => {
    fx.sequence[3].response.body.properties.executionPlanJson = '';
  }, 'empty plan');
});

// --- Finding #8: operation objects are complete closed objects ---

test('negative: an operation with an extra key is rejected (closed operation object)', () => {
  expectReject('operations/provider-operations.json', (fx) => { fx.value[0].injected = true; }, 'extra operation key');
});

test('negative: an operation missing isDataAction is rejected', () => {
  expectReject('operations/provider-operations.json', (fx) => { delete fx.value[0].isDataAction; }, 'missing isDataAction');
});

test('negative: a non-boolean isDataAction is rejected', () => {
  expectReject('operations/provider-operations.json', (fx) => { fx.value[0].isDataAction = 'false'; }, 'string isDataAction');
});

test('negative: an operation display missing a field is rejected', () => {
  expectReject('operations/provider-operations.json', (fx) => { delete fx.value[0].display.description; }, 'display missing description');
});

test('negative: an operation display with an extra field is rejected', () => {
  expectReject('operations/provider-operations.json', (fx) => { fx.value[0].display.origin = 'user'; }, 'display extra field');
});

test('negative: an empty display string is rejected', () => {
  expectReject('operations/provider-operations.json', (fx) => { fx.value[0].display.operation = ''; }, 'empty display field');
});

// --- Finding #5: exact per-shape top-level + nested request/response schemas ---

test('negative: an acceptance carrying a cross-shape `value` key is rejected (per-shape top-level)', () => {
  expectReject('validate/accept-202.json', (fx) => { fx.value = []; }, 'acceptance with a value key');
});

test('negative: an acceptance carrying a cross-shape `sequence` key is rejected', () => {
  expectReject('execute/accept-202.json', (fx) => { fx.sequence = []; }, 'acceptance with a sequence key');
});

test('negative: a resource carrying a cross-shape `resourceId` key is rejected', () => {
  expectReject('execute/run-succeeded-200.json', (fx) => { fx.resourceId = '/foo'; }, 'resource with a resourceId key');
});

test('negative: an operations fixture carrying a `request` key is rejected', () => {
  expectReject('operations/provider-operations.json', (fx) => { fx.request = { method: 'GET', url: 'x' }; }, 'operations with a request key');
});

test('negative: a fixture missing its description is rejected', () => {
  expectReject('validate/validation-succeeded-200.json', (fx) => { delete fx.description; }, 'missing description');
});

test('negative: a non-string description is rejected', () => {
  expectReject('validate/validation-succeeded-200.json', (fx) => { fx.description = 123; }, 'non-string description');
});

test('negative: an empty-string context is rejected', () => {
  expectReject('validate/accept-unevaluated-202.json', (fx) => { fx.context = ''; }, 'empty context');
});

test('negative: a trace missing its resourceId is rejected (per-shape required)', () => {
  expectReject('validate/plan-mutation-sequence.json', (fx) => { delete fx.resourceId; }, 'trace missing resourceId');
});

test('negative: an acceptance request carrying a stray header is rejected (exact request schema)', () => {
  expectReject('validate/accept-202.json', (fx) => { fx.request.headers = { 'If-Match': '"x"' }; }, 'acceptance request header');
});

test('negative: an acceptance request carrying a body is rejected', () => {
  expectReject('execute/accept-202.json', (fx) => { fx.request.body = { some: 'payload' }; }, 'acceptance request body');
});

test('negative: a resource request carrying a stray header is rejected', () => {
  expectReject('execute/run-succeeded-200.json', (fx) => { fx.request.headers = { 'If-Match': '"x"' }; }, 'resource request header');
});

test('negative: an acceptance response with a non-null body is rejected', () => {
  expectReject('validate/accept-202.json', (fx) => { fx.response.body = { id: 'x' }; }, 'acceptance non-null body');
});

test('negative: a 202 poll missing its Retry-After header is rejected (finding #7)', () => {
  expectReject('execute/run-transitions.json', (fx) => { delete fx.sequence[0].response.headers['Retry-After']; }, '202 poll without Retry-After');
});

test('negative: a 202 poll with an entirely missing headers object is rejected (finding #7)', () => {
  expectReject('execute/run-transitions.json', (fx) => { delete fx.sequence[0].response.headers; }, '202 poll without headers');
});

test('negative: a 202 poll carrying an extra header beyond Retry-After is rejected (finding #7)', () => {
  expectReject('execute/run-transitions.json', (fx) => { fx.sequence[0].response.headers['x-ms-request-id'] = 'abc'; }, '202 poll with an extra header');
});

test('negative: a 202 poll with a noncanonical Retry-After is rejected (finding #7)', () => {
  for (const bad of ['1e1', '+10', '10.0', ' 10', '10 ', '010']) {
    expectReject('execute/run-transitions.json', (fx) => { fx.sequence[0].response.headers['Retry-After'] = bad; }, `noncanonical Retry-After '${bad}'`);
  }
});

test('negative: a terminal 200 poll carrying a Retry-After header is rejected (finding #7)', () => {
  expectReject('cancel/run-transitions.json', (fx) => {
    const last = fx.sequence[fx.sequence.length - 1];
    last.response.headers = { 'Retry-After': '10' };
  }, 'terminal 200 poll with Retry-After');
});
