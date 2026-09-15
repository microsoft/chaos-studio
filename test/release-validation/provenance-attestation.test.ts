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
