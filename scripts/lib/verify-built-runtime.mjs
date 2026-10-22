#!/usr/bin/env node
// verify-built-runtime.mjs — bind the REBUILT runtime to a validated commit (E6-T2).
//
// The release-validation receipt gate proves that the COMMITTED shipping paths
// (`packages`, `action.yml`, `dist`, `azure-pipelines-extension`) are unchanged
// between the commit RV1-RV3 validated and the commit being released. On the
// Azure Pipelines side that is NOT sufficient on its own: the OneBranch pipeline
// REBUILDS `dist/` and stages that generated runtime into the VSIX, so a change
// to a build INPUT that lives outside those paths — `scripts/build.mjs`, the
// root dependency metadata, a transitive bundler version — can produce different
// packaged bytes while every compared path is byte-identical.
//
// This CLI closes that gap: it compares the runtime in the WORKING TREE (what the
// rebuild just emitted) against the runtime COMMITTED at the baseline commit —
// the complete file set (added AND removed), git-normalized modes, and git blob
// hashes — so nothing is staged, packaged, signed, or published unless it is
// byte-identical to the runtime the receipt validated.
//
// Usage:
//   node scripts/lib/verify-built-runtime.mjs <baseline-commit> [runtime-dir]
//
// `runtime-dir` defaults to `dist`. Runs from the repository working tree.
//
// Exit codes: 0 = the rebuilt runtime equals the baseline, 1 = it does NOT (the
// release is blocked), 2 = usage or I/O error. Failures print `::error::` lines so
// a GitHub Actions run annotates them; the Azure Pipelines caller surfaces the
// same text on stderr.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, posix } from 'node:path';

// Both shipping adapters must be present on BOTH sides, so neither an empty
// rebuild nor an empty baseline can make the comparison trivially pass.
const REQUIRED_ENTRYPOINTS = ['dist/github-action/index.js', 'dist/azure-pipelines-task/index.js'];

function fail(message) {
  console.error(`::error::verify-built-runtime: ${message}`);
  process.exit(1);
}

function usage(message) {
  console.error(`::error::verify-built-runtime: ${message}`);
  console.error('::error::verify-built-runtime: usage: verify-built-runtime.mjs <baseline-commit> [runtime-dir]');
  process.exit(2);
}

function git(args) {
  return spawnSync('git', args, { encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 });
}

const [baselineArg, runtimeArg] = process.argv.slice(2);
if (!baselineArg) usage('a baseline commit is required.');
const runtimeDir = (runtimeArg ?? 'dist').replace(/\\/g, '/').replace(/\/+$/, '');
if (runtimeDir === '' || runtimeDir.startsWith('/') || runtimeDir.split('/').includes('..')) {
  usage(`invalid runtime directory '${runtimeArg}'.`);
}

const resolved = git(['rev-parse', '--verify', '--quiet', `${baselineArg}^{commit}`]);
const baseline = resolved.status === 0 ? resolved.stdout.toString('utf8').trim() : '';
if (!baseline) usage(`could not resolve baseline commit '${baselineArg}' in this repository.`);

/**
 * The runtime COMMITTED at the baseline, as `path -> {mode, oid}`. `git ls-tree
 * -r -z` yields `<mode> <type> <oid>\t<path>\0`. A symlink (120000) or a
 * submodule/gitlink (160000) is never publishable runtime, so it fails closed
 * rather than being compared as if it were a regular file.
 */
function committedRuntime() {
  const listed = git(['ls-tree', '-r', '-z', baseline, '--', runtimeDir]);
  if (listed.status !== 0) {
    console.error(`::error::verify-built-runtime: could not list '${runtimeDir}' at ${baseline}.`);
    process.exit(2);
  }
  const entries = new Map();
  for (const record of listed.stdout.toString('utf8').split('\0')) {
    if (record === '') continue;
    const [meta, path] = record.split('\t');
    const [mode, , oid] = meta.split(' ');
    if (mode === '120000' || mode === '160000') {
      fail(`committed runtime entry '${path}' is a symlink/submodule (mode ${mode}); not publishable.`);
    }
    entries.set(path, { mode, oid });
  }
  return entries;
}

/** The git blob object-id of a file's bytes: sha1("blob <len>\0" + content). */
function blobId(bytes) {
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

// Git only tracks the POSIX executable bit where the filesystem carries it. On a
// platform without it the working-tree mode is not observable, so the mode
// comparison is skipped there (the file SET and every blob hash are still
// compared); the release pipelines run on Linux agents, where it is enforced.
const modesObservable = process.platform !== 'win32';

/** The runtime in the WORKING TREE, as `path -> {mode, oid}`. */
function rebuiltRuntime() {
  const entries = new Map();
  const walk = (relative) => {
    let listing;
    try {
      listing = readdirSync(relative, { withFileTypes: true });
    } catch (e) {
      if (e && e.code === 'ENOENT') return;
      console.error(`::error::verify-built-runtime: could not read '${relative}' (${String(e && e.message)}).`);
      process.exit(2);
    }
    for (const entry of listing) {
      const child = posix.join(relative, entry.name);
      if (entry.isDirectory()) {
        walk(child);
        continue;
      }
      // Explicitly REJECT every non-regular entry (symlink, fifo, socket,
      // device) rather than silently skipping it.
      if (!entry.isFile()) {
        fail(`rebuilt runtime entry '${child}' is not a regular file; not publishable.`);
      }
      const bytes = readFileSync(join(...child.split('/')));
      const executable = modesObservable && (statSync(join(...child.split('/'))).mode & 0o111) !== 0;
      entries.set(child, { mode: executable ? '100755' : '100644', oid: blobId(bytes) });
    }
  };
  walk(runtimeDir);
  return entries;
}

const committed = committedRuntime();
const rebuilt = rebuiltRuntime();

if (committed.size === 0) {
  fail(
    `the baseline commit ${baseline} has no committed files under '${runtimeDir}'; ` +
      'there is nothing to compare the rebuilt runtime against.',
  );
}
if (rebuilt.size === 0) {
  fail(`the rebuild produced no ${runtimeDir}/ runtime files; refusing to package an empty runtime.`);
}
for (const entrypoint of REQUIRED_ENTRYPOINTS) {
  if (!entrypoint.startsWith(`${runtimeDir}/`)) continue;
  if (!committed.has(entrypoint)) fail(`the baseline commit ${baseline} is missing the required entrypoint '${entrypoint}'.`);
  if (!rebuilt.has(entrypoint)) fail(`the rebuilt runtime is missing the required entrypoint '${entrypoint}'.`);
}

const added = [];
const removed = [];
const changed = [];
for (const [path, entry] of rebuilt) {
  const base = committed.get(path);
  if (!base) {
    added.push(path);
    continue;
  }
  if (base.oid !== entry.oid) {
    changed.push(`${path} (content differs: baseline ${base.oid}, rebuilt ${entry.oid})`);
  } else if (modesObservable && base.mode !== entry.mode) {
    changed.push(`${path} (mode differs: baseline ${base.mode}, rebuilt ${entry.mode})`);
  }
}
for (const path of committed.keys()) if (!rebuilt.has(path)) removed.push(path);

if (added.length > 0 || removed.length > 0 || changed.length > 0) {
  console.error(
    `::error::verify-built-runtime: the rebuilt ${runtimeDir}/ runtime does NOT equal the runtime committed at ${baseline}. ` +
      'A build INPUT changed without the validated runtime changing with it; re-run RV1-RV3 for the commit being released ' +
      '(docs/runbooks/release-validation.md).',
  );
  for (const path of added.sort()) console.error(`::error::verify-built-runtime:   added (only in the rebuilt runtime): ${path}`);
  for (const path of removed.sort()) console.error(`::error::verify-built-runtime:   missing (removed by the rebuild): ${path}`);
  for (const entry of changed.sort()) console.error(`::error::verify-built-runtime:   changed: ${entry}`);
  process.exit(1);
}

console.log(
  `The rebuilt ${runtimeDir}/ runtime equals the runtime committed at ${baseline} ` +
    `(${rebuilt.size} files, exact set${modesObservable ? ' + modes' : ''} + blob hashes).`,
);
