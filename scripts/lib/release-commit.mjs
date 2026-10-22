#!/usr/bin/env node
// release-commit.mjs — bind a publication to the SHARED release commit (E6-T2).
//
// The Action and the extension are two adapters over ONE core, so they are
// released from ONE commit. Each release config independently proves that the
// commit it ships descends from the receipt's validated core commit and ships
// byte-identical trees — but that is satisfied by ANY receipt-bearing descendant.
// Two DIFFERENT descendants can therefore pass the two gates independently, and
// the marketplaces would ship different commits.
//
// The GitHub release makes its choice durable and immutable: publishing `v1.2.3`
// creates that exact tag at the released commit, under a ruleset that only the
// release identity can write. That tag IS the shared release record. This CLI
// resolves it and requires the caller's build commit to BE that commit — not an
// ancestor of it, not a descendant, not a branch that happens to share the name.
//
// Usage:
//   node scripts/lib/release-commit.mjs assert-tag-commit <vMAJOR.MINOR.PATCH> <build-commit>
//
// Runs from the repository working tree; the caller must have fetched tags first.
//
// Exit codes: 0 = the build commit IS the released commit (prints
// `release-commit=<sha>`), 1 = it is NOT, or the release record does not exist
// (publication is blocked), 2 = usage or I/O error.
import { spawnSync } from 'node:child_process';

// The same shape `.github/workflows/release-action.yml` enforces for a release
// tag: exact SemVer, no leading zeros, no prerelease suffix. Anchored, so a tag
// argument can never be a path, another ref, or a revision expression.
const EXACT_VERSION_TAG = /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

function fail(message) {
  console.error(`::error::release-commit: ${message}`);
  process.exit(1);
}

function usage(message) {
  console.error(`::error::release-commit: ${message}`);
  console.error(
    '::error::release-commit: usage: release-commit.mjs assert-tag-commit <vMAJOR.MINOR.PATCH> <build-commit>',
  );
  process.exit(2);
}

function git(args) {
  return spawnSync('git', args, { encoding: 'utf8' });
}

/** The commit a revision resolves to, or '' when it does not resolve. */
function resolveCommit(revision) {
  const result = git(['rev-parse', '--verify', '--quiet', `${revision}^{commit}`]);
  return result.status === 0 ? result.stdout.trim() : '';
}

const [command, tag, buildCommitArg] = process.argv.slice(2);
if (command !== 'assert-tag-commit') {
  usage(command ? `unknown command '${command}'.` : 'a command is required.');
}
if (!tag) usage('a release tag is required.');
if (!buildCommitArg) usage('a build commit is required.');
if (!EXACT_VERSION_TAG.test(tag)) {
  usage(
    `'${tag}' is not an exact release tag. Use vMAJOR.MINOR.PATCH with no leading zeros and no ` +
      'prerelease suffix (the GitHub release workflow refuses anything else).',
  );
}

// Fail closed OUTSIDE a repository rather than reporting a missing release record.
if (git(['rev-parse', '--git-dir']).status !== 0) {
  usage('not a git repository; the release commit cannot be resolved.');
}

const buildCommit = resolveCommit(buildCommitArg);
if (!buildCommit) usage(`could not resolve build commit '${buildCommitArg}' in this repository.`);

// `refs/tags/<tag>` explicitly — never the bare name, which git would also match
// against a branch of the same name (and which a revision expression could abuse).
const releaseCommit = resolveCommit(`refs/tags/${tag}`);
if (!releaseCommit) {
  fail(
    `no tag 'refs/tags/${tag}' in this repository, so there is no shared release record to publish ` +
      'against. Release the GitHub Action first (.github/workflows/release-action.yml creates the ' +
      'immutable tag at the release commit), then fetch tags and re-run this pipeline at that commit ' +
      '(docs/runbooks/release.md).',
  );
}

if (releaseCommit !== buildCommit) {
  fail(
    `this build is at ${buildCommit}, but the ${tag} release was published from ${releaseCommit}. ` +
      'Both marketplaces ship ONE commit: re-run this pipeline at the commit the release tag resolves ' +
      'to, or cut a new version for this commit. Do not publish a different build commit ' +
      '(docs/runbooks/release.md).',
  );
}

console.log(`release-commit=${releaseCommit}`);
console.log(`This build is the commit the ${tag} GitHub release was published from.`);
