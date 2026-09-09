#!/usr/bin/env node
// Thin CLI wrapper around the SHARED workflow-permissions audit
// (packages/core/src/release/workflowPermsAudit.ts), invoked by
// scripts/verify-release-protections.sh. Reads a JSON array of `{ name, content }` workflow
// objects (WORKFLOWS_FILE) and an optional CSV allowlist of write-permitted workflow file
// names (ALLOWLIST). Prints ::error:: lines and exits 1 on any hard finding; prints notes and
// exits 0 when clean.
import { readFileSync } from 'node:fs';
import { auditWorkflowPermissions } from '../../packages/core/src/release/workflowPermsAudit.ts';

const workflowsFile = process.env.WORKFLOWS_FILE;
if (!workflowsFile) {
  console.error('::error::audit-workflow-perms: WORKFLOWS_FILE is required.');
  process.exit(2);
}
const allowlist = (process.env.ALLOWLIST || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
// The environment names the operator has independently provisioned + verified as protected
// (required reviewers + default-branch-only deployment policy). ONLY a content-write gated by
// one of these is downgraded to a NOTE; an arbitrary `environment:` name is NOT protected.
const protectedEnvironments = (process.env.PROTECTED_ENVIRONMENTS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

let workflows;
try {
  workflows = JSON.parse(readFileSync(workflowsFile, 'utf8'));
} catch (e) {
  console.error('::error::audit-workflow-perms: could not read/parse WORKFLOWS_FILE (' + String(e && e.message) + ').');
  process.exit(1);
}
if (!Array.isArray(workflows)) {
  console.error('::error::audit-workflow-perms: WORKFLOWS_FILE must contain a JSON array of { name, content } objects.');
  process.exit(1);
}

const { findings, notes } = auditWorkflowPermissions(workflows, {
  allowlistedWriteWorkflows: allowlist,
  protectedEnvironments,
});
for (const n of notes) console.log('NOTE: ' + n);
if (findings.length) {
  for (const f of findings) console.error('::error::workflow-permissions audit: ' + f);
  process.exit(1);
}
console.log('workflow-permissions audit passed: no un-gated write grant and no reusable-workflow call across ' + workflows.length + ' workflow file(s).');
