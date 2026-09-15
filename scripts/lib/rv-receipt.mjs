#!/usr/bin/env node
// rv-receipt.mjs — the release-validation receipt CLI (E6-T1).
//
// RV1-RV3 are executed by an operator against a real target preview environment;
// this CLI owns the reproducible half: it stamps a canonical digest onto a
// receipt and re-evaluates every recorded observation against the source-proven
// contract constants. It is a thin wrapper around the SHARED evaluators in
// test/release-validation/receipt.ts, so the release workflows, the OneBranch
// extension pipeline, and a local operator all apply exactly the same rules.
//
// Usage:
//   node scripts/lib/rv-receipt.mjs stamp  <receipt.json>   # write the digest
//   node scripts/lib/rv-receipt.mjs verify <receipt.json>   # release gate
//
// Environment (verify):
//   EXPECTED_CORE_COMMIT  require the receipt to be bound to this commit SHA
//   MAX_AGE_DAYS          reject evidence older than this many days (default 30)
//
// Exit codes: 0 = gate passed, 1 = gate FAILED (evidence rejected), 2 = usage or
// I/O error. Failures print `::error::` lines so a GitHub Actions run annotates
// them; the Azure Pipelines caller surfaces the same text on stderr.
import { readFileSync, writeFileSync } from 'node:fs';

import { receiptDigest, validateReceipt } from '../../test/release-validation/receipt.ts';

const PROVIDER_OPERATIONS_FILE = new URL(
  '../../packages/core/fixtures/operations/provider-operations.json',
  import.meta.url,
);
const DEFAULT_MAX_AGE_DAYS = 30;

function usage(message) {
  console.error(`::error::rv-receipt: ${message}`);
  console.error('::error::rv-receipt: usage: rv-receipt.mjs <stamp|verify> <receipt.json>');
  process.exit(2);
}

function readJson(path, what) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    console.error(`::error::rv-receipt: could not read/parse ${what} '${path}' (${String(e && e.message)}).`);
    process.exit(2);
  }
}

/**
 * The generated provider-operation snapshot is the authority for which
 * Microsoft.Chaos operations EXIST; RV2's role check is evaluated against it.
 */
function providerOpNames() {
  const snapshot = readJson(PROVIDER_OPERATIONS_FILE, 'the provider-operation snapshot');
  if (!Array.isArray(snapshot?.value)) {
    console.error('::error::rv-receipt: the provider-operation snapshot has no `value` array.');
    process.exit(2);
  }
  return new Set(snapshot.value.map((op) => op?.name));
}

const [command, file] = process.argv.slice(2);
if (!command || !file) usage('a command and a receipt path are required.');
if (command !== 'stamp' && command !== 'verify') usage(`unknown command '${command}'.`);

const receipt = readJson(file, 'the receipt');

// A template is a form to fill in, never evidence. Refuse BOTH verbs so an
// operator cannot accidentally stamp the committed skeleton into something that
// looks signed.
if (receipt?.template !== false) {
  console.error(
    `::error::rv-receipt: '${file}' is a receipt template (template is not false). ` +
      'Run RV1-RV3 against the target preview environment and record what you observed ' +
      '(docs/runbooks/release-validation.md).',
  );
  process.exit(1);
}

if (command === 'stamp') {
  const { digest: _dropped, ...body } = receipt;
  const digest = receiptDigest(body);
  writeFileSync(file, `${JSON.stringify({ ...body, digest }, null, 2)}\n`, 'utf8');
  console.log(`receipt-digest=${digest}`);
  process.exit(0);
}

const maxAgeRaw = process.env.MAX_AGE_DAYS;
const maxAgeDays = maxAgeRaw === undefined || maxAgeRaw === '' ? DEFAULT_MAX_AGE_DAYS : Number(maxAgeRaw);
if (!Number.isFinite(maxAgeDays) || maxAgeDays <= 0) usage(`MAX_AGE_DAYS must be a positive number, got '${maxAgeRaw}'.`);

const { ok, failures } = validateReceipt(receipt, {
  providerOpNames: providerOpNames(),
  expectedCoreCommit: process.env.EXPECTED_CORE_COMMIT || undefined,
  maxAgeDays,
});

if (!ok) {
  for (const failure of failures) console.error(`::error::rv-receipt: ${failure}`);
  console.error(
    `::error::rv-receipt: '${file}' is NOT valid release-validation evidence; the release is blocked. ` +
      'A protocol mismatch opens a service defect (docs/runbooks/contract-drift.md) rather than a client change.',
  );
  process.exit(1);
}

console.log(`receipt-core-commit=${receipt.coreCommit}`);
console.log(`receipt-digest=${receiptDigest(receipt)}`);
console.log(`RV1-RV3 receipt accepted: ${file} (${receipt.environment.cloud}/${receipt.environment.region}).`);
