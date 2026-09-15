import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// R2: automated build-provenance attestation must be bound to the actual
// released artifact digest (not merely to the release-commit input), and the
// job granting id-token/attestations write must not be the workflow default.

const __dirname = dirname(fileURLToPath(import.meta.url));
const workflowPath = join(__dirname, '..', '..', '.github', 'workflows', 'release-action.yml');

function readWorkflow(): string {
  // Normalize line endings so line-anchored regexes work regardless of the
  // checked-out/committed EOL style (this file is LF/CRLF-agnostic content-wise).
  return readFileSync(workflowPath, 'utf8').replace(/\r\n/g, '\n');
}

function publishJobSlice(text: string): string {
  const start = text.search(/\n {2}publish:\n/);
  assert.ok(start >= 0, 'publish job not found in release-action.yml');
  // The publish job is the last top-level job in this workflow; slice to EOF.
  return text.slice(start);
}

test('release-action publish job declares attest-build-provenance bound to the packaged artifact', () => {
  const publish = publishJobSlice(readWorkflow());

  assert.match(
    publish,
    /uses:\s*actions\/attest-build-provenance@/,
    'expected an actions/attest-build-provenance step in the publish job'
  );
  assert.match(
    publish,
    /subject-path:\s*pkg\/action-bundle\.tar\.gz/,
    'attestation subject-path must reference the packaged release artifact (pkg/action-bundle.tar.gz), ' +
      'not an unrelated or unpinned path'
  );
});

test('release-action publish job grants least-privilege attestation permissions', () => {
  const publish = publishJobSlice(readWorkflow());
  const permsMatch = publish.match(/permissions:\n((?:\s{6}.+\n)+)/);
  assert.ok(permsMatch, 'expected a job-level `permissions:` block on publish');
  const perms = permsMatch![1]!;
  assert.match(perms, /id-token:\s*write/, 'attest-build-provenance requires OIDC (id-token: write)');
  assert.match(perms, /attestations:\s*write/, 'attest-build-provenance requires attestations: write');
  assert.match(perms, /contents:\s*read/, 'contents permission must stay read-only for the publish job');
});

test('workflow-level default permissions remain narrowly scoped (no blanket attestations/id-token write)', () => {
  const text = readWorkflow();
  const publishStart = text.search(/\n {2}publish:\n/);
  const topLevel = text.slice(0, publishStart);
  const permsMatch = topLevel.match(/\npermissions:\n((?:\s{2}.+\n)+)/);
  assert.ok(permsMatch, 'expected a workflow-level `permissions:` block');
  const perms = permsMatch![1]!;

  assert.doesNotMatch(
    perms,
    /id-token:\s*write/,
    'id-token: write must be scoped to the publish job only, not the whole workflow'
  );
  assert.doesNotMatch(
    perms,
    /attestations:\s*write/,
    'attestations: write must be scoped to the publish job only, not the whole workflow'
  );
});

test('attestation subject is the artifact downloaded+digest-verified in the same job, not the raw release-commit input', () => {
  const publish = publishJobSlice(readWorkflow());
  const attestMatch = publish.match(/uses:\s*actions\/attest-build-provenance@/);
  assert.ok(attestMatch, 'expected an attest-build-provenance step');
  const attestIndex = attestMatch!.index!;

  // The digest-verification step (sha256 check against pkg/action-bundle.tar.gz.sha256)
  // must appear before the attestation step, and the attestation must reference the
  // same artifact path.
  const digestCheckIndex = publish.search(/sha256sum\s+-c|action-bundle\.tar\.gz\.sha256/);
  assert.ok(digestCheckIndex >= 0, 'expected a sha256 digest verification step for the packaged artifact');
  assert.ok(
    digestCheckIndex < attestIndex,
    'artifact digest must be verified before generating the provenance attestation for it'
  );
});

// R2: the standard build-provenance statement records the DISPATCH RUN's own
// source SHA as its resolved Git material — correct for workflow identity, but
// when `main` has advanced past `$RELEASE_COMMIT` (an ancestor release, or a
// retry of an existing tag), that statement alone no longer identifies the
// commit that supplied the released bytes. A second, additional attestation on
// the SAME verified artifact digest must bind the verified RELEASE_COMMIT, so
// ancestor releases and retries are covered without changing the immutable tag
// target or fabricating the workflow's own provenance statement.
test('a second attestation binds the verified RELEASE_COMMIT to the same packaged artifact digest', () => {
  const publish = publishJobSlice(readWorkflow());

  assert.match(
    publish,
    /uses:\s*actions\/attest@/,
    'expected a second actions/attest step binding the release commit to the artifact'
  );

  const releaseCommitAttestMatch = publish.match(
    /uses:\s*actions\/attest@[^\n]*\n(?:.*\n)*?\s*predicate:\s*\|\n([\s\S]*?releaseCommit[\s\S]*?)(?:\n\n|\n\s*- name:)/
  );
  assert.ok(releaseCommitAttestMatch, 'expected the second attestation predicate to carry the releaseCommit');
  assert.match(
    releaseCommitAttestMatch![1]!,
    /RELEASE_COMMIT/,
    'the release-commit attestation predicate must reference the verified $RELEASE_COMMIT env, not an unverified input'
  );

  // Both attestations must target the exact same artifact path (same digest).
  const attestSteps = [...publish.matchAll(/uses:\s*actions\/attest(?:-build-provenance)?@[^\n]*\n((?:\s{8,}.+\n)+)/g)];
  assert.equal(attestSteps.length, 2, 'expected exactly two attestation steps in the publish job');
  for (const step of attestSteps) {
    assert.match(
      step[1]!,
      /subject-path:\s*pkg\/action-bundle\.tar\.gz/,
      'every attestation must bind to the same verified artifact digest (pkg/action-bundle.tar.gz)'
    );
  }
});

test('the release-commit attestation appears AFTER RELEASE_COMMIT was verified as reviewed default-branch history', () => {
  const text = readWorkflow();
  const enforceIndex = text.search(/Enforce the release commit is reviewed default-branch history/);
  assert.ok(enforceIndex >= 0, 'expected the release-commit ancestry enforcement step');
  const publish = publishJobSlice(text);
  const releaseCommitAttestIndex = publish.search(/Generate a second attestation binding the artifact digest to the verified release commit/);
  assert.ok(releaseCommitAttestIndex >= 0, 'expected the release-commit attestation step');
  // The enforcement step is in the validate job (earlier in the file); the attestation
  // step is in the publish job (a distinct, later slice) — both must exist and the
  // publish job's env must carry RELEASE_COMMIT from validate's verified output.
  assert.match(
    text,
    /RELEASE_COMMIT:\s*\$\{\{\s*needs\.validate\.outputs\.releaseCommit\s*\}\}/,
    'the publish job must source RELEASE_COMMIT from the validate job\'s verified output, not raw input'
  );
});
