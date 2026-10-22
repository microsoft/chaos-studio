#!/usr/bin/env node
// Thin CLI wrapper around the SHARED, operation-aware, layered tag-ruleset evaluator
// (packages/core/src/release/tagRulesetEval.ts). Used by scripts/verify-release-protections.sh
// so the standalone preflight and the release-time workflow evaluators apply the SAME rules.
//
// Reads:
//   RULESETS_FILE      path to a JSON array of the repo's tag ruleset detail objects
//   RID                the numeric release-identity actor id (bypass actor)
//   REQUIRED_OPS       CSV of required operations (default: creation,update,deletion,non_fast_forward)
//   TAG_REF            (per-ref mode) the concrete ref to evaluate (e.g. refs/tags/v1.2.3)
//   NAMESPACE_PREFIX   (namespace mode) the tag-name prefix within refs/tags/ (e.g. v, mcp-v)
// Provide EITHER TAG_REF (per-ref layered evaluation) OR NAMESPACE_PREFIX (namespace-wide
// coverage: a finite list of exact tags does NOT protect the whole namespace). Prints
// ::error:: lines and exits 1 on any misconfiguration; exits 0 when locked.
import { readFileSync } from 'node:fs';
import { evaluateTagRuleset, evaluateTagNamespace, DEFAULT_REQUIRED_OPS } from '../../packages/core/src/release/tagRulesetEval.ts';

const rulesetsFile = process.env.RULESETS_FILE;
const ref = process.env.TAG_REF;
const namespacePrefix = process.env.NAMESPACE_PREFIX;
const rid = String(process.env.RID || '');
if (!rulesetsFile || (!ref && !namespacePrefix)) {
  console.error('::error::eval-tag-ruleset: RULESETS_FILE and one of TAG_REF / NAMESPACE_PREFIX are required.');
  process.exit(2);
}
const requiredOps = (process.env.REQUIRED_OPS || DEFAULT_REQUIRED_OPS.join(','))
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

let rulesets;
try {
  rulesets = JSON.parse(readFileSync(rulesetsFile, 'utf8'));
} catch (e) {
  console.error('::error::eval-tag-ruleset: could not read/parse RULESETS_FILE (' + String(e && e.message) + ').');
  process.exit(1);
}
if (!Array.isArray(rulesets)) {
  console.error('::error::eval-tag-ruleset: RULESETS_FILE must contain a JSON array of ruleset objects.');
  process.exit(1);
}

if (namespacePrefix) {
  const { ok, errors } = evaluateTagNamespace({ rulesets, namespacePrefix, releaseActorId: rid, requiredOps });
  if (!ok) {
    for (const e of errors) console.error('::error::tag namespace preflight: ' + e);
    process.exit(1);
  }
  console.log(
    'tag namespace preflight passed: refs/tags/' + namespacePrefix + '* is fully covered and restricted (' +
      requiredOps.join('+') + '), grants no foreign bypass, and authorizes the User release identity ' + rid + '.',
  );
} else {
  const { ok, errors } = evaluateTagRuleset({ rulesets, ref, releaseActorId: rid, requiredOps });
  if (!ok) {
    for (const e of errors) console.error('::error::tag ruleset preflight: ' + e);
    process.exit(1);
  }
  console.log(
    'tag ruleset preflight passed: ' + ref + ' is restricted (' + requiredOps.join('+') +
      '), grants no foreign bypass, and every applicable restricting ruleset authorizes the User release identity ' + rid + '.',
  );
}
