import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  evaluateTagRuleset,
  evaluateTagNamespace,
  patternCoversNamespace,
  patternOverlapsNamespace,
  DEFAULT_REQUIRED_OPS,
  type TagRuleset,
} from '../../src/release/tagRulesetEval.ts';

const RID = '424242';
const RELEASE_BYPASS = { actor_type: 'User', actor_id: 424242, bypass_mode: 'always' };

// A single, fully-locking ruleset for refs/tags/v* with the release identity as sole bypass.
function fullLock(overrides: Partial<TagRuleset> = {}): TagRuleset {
  return {
    id: 1,
    target: 'tag',
    enforcement: 'active',
    conditions: { ref_name: { include: ['refs/tags/v*'], exclude: [] } },
    rules: [{ type: 'creation' }, { type: 'update' }, { type: 'deletion' }, { type: 'non_fast_forward' }],
    bypass_actors: [RELEASE_BYPASS],
    ...overrides,
  };
}

test('evaluateTagRuleset accepts a single fully-locking ruleset (all ops + sole release bypass)', () => {
  const r = evaluateTagRuleset({ rulesets: [fullLock()], ref: 'refs/tags/v1.2.3', releaseActorId: RID });
  assert.deepEqual(r.errors, []);
  assert.equal(r.ok, true);
});

test('evaluateTagRuleset requires non_fast_forward for floating tags (VF: force-update of a moving tag)', () => {
  // A ruleset that restricts creation/update/deletion but NOT non_fast_forward leaves a
  // floating tag force-updatable by non-bypass actors.
  const noForce = fullLock({ rules: [{ type: 'creation' }, { type: 'update' }, { type: 'deletion' }] });
  const r = evaluateTagRuleset({ rulesets: [noForce], ref: 'refs/tags/v1', releaseActorId: RID });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('not restricted for non_fast_forward')), r.errors.join(' | '));
});

test('evaluateTagRuleset is LAYERED: a second applicable ruleset with a foreign bypass FAILS even if the first is perfect', () => {
  const perfect = fullLock({ id: 1 });
  // A second ruleset also covering v* that restricts deletion but bypasses a foreign Team —
  // GitHub ANDs layers, so deletion is now bypassable by that Team. Must fail.
  const foreign: TagRuleset = {
    id: 2,
    target: 'tag',
    enforcement: 'active',
    conditions: { ref_name: { include: ['refs/tags/v*'], exclude: [] } },
    rules: [{ type: 'deletion' }],
    bypass_actors: [{ actor_type: 'Team', actor_id: 99, bypass_mode: 'always' }],
  };
  const r = evaluateTagRuleset({ rulesets: [perfect, foreign], ref: 'refs/tags/v1.2.3', releaseActorId: RID });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('id=2') && e.includes('other than the User release identity')), r.errors.join(' | '));
});

test('evaluateTagRuleset is LAYERED: an applicable RESTRICTING ruleset that does NOT grant the identity a bypass FAILS', () => {
  const perfect = fullLock({ id: 1 });
  // A second ruleset covering v* restricts creation but grants NO bypass at all — the
  // release identity cannot create the tag through THIS layer (ANDed), so it must fail.
  const blocks: TagRuleset = {
    id: 3,
    target: 'tag',
    enforcement: 'active',
    conditions: { ref_name: { include: ['refs/tags/v*'], exclude: [] } },
    rules: [{ type: 'creation' }],
    bypass_actors: [],
  };
  const r = evaluateTagRuleset({ rulesets: [perfect, blocks], ref: 'refs/tags/v1.2.3', releaseActorId: RID });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('id=3') && e.includes('does not grant the User release identity')), r.errors.join(' | '));
});

test('evaluateTagRuleset spreads required operations ACROSS layers (each op restricted by SOME applicable ruleset)', () => {
  // No single ruleset restricts all ops, but together they cover creation+update+deletion+
  // non_fast_forward, and each grants the release identity the sole bypass.
  const a = fullLock({ id: 1, rules: [{ type: 'creation' }, { type: 'update' }] });
  const b = fullLock({ id: 2, rules: [{ type: 'deletion' }, { type: 'non_fast_forward' }] });
  const r = evaluateTagRuleset({ rulesets: [a, b], ref: 'refs/tags/v9.9.9', releaseActorId: RID });
  assert.deepEqual(r.errors, []);
  assert.equal(r.ok, true);
});

test('evaluateTagRuleset ignores INACTIVE and non-tag rulesets (they enforce nothing)', () => {
  const evaluate = fullLock({ id: 1, enforcement: 'evaluate' });
  const disabled = fullLock({ id: 2, enforcement: 'disabled' });
  const branch = fullLock({ id: 3, target: 'branch' });
  const r = evaluateTagRuleset({ rulesets: [evaluate, disabled, branch], ref: 'refs/tags/v1.0.0', releaseActorId: RID });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('no active tag ruleset applies')), r.errors.join(' | '));
});

test('evaluateTagRuleset honors an exclude carve-out: an applicable ruleset excluded from the ref does not count', () => {
  const carved = fullLock({ conditions: { ref_name: { include: ['refs/tags/v*'], exclude: ['refs/tags/v1*'] } } });
  const r = evaluateTagRuleset({ rulesets: [carved], ref: 'refs/tags/v1.2.3', releaseActorId: RID });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('no active tag ruleset applies')), r.errors.join(' | '));
  // A ref NOT carved out is still covered.
  const ok2 = evaluateTagRuleset({ rulesets: [carved], ref: 'refs/tags/v2.0.0', releaseActorId: RID });
  assert.deepEqual(ok2.errors, []);
});

test('evaluateTagRuleset fails closed when bypass_actors is missing (insufficient API visibility)', () => {
  const noBypass = fullLock();
  delete (noBypass as { bypass_actors?: unknown }).bypass_actors;
  const r = evaluateTagRuleset({ rulesets: [noBypass], ref: 'refs/tags/v1.0.0', releaseActorId: RID });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('did not return bypass_actors')), r.errors.join(' | '));
});

test('evaluateTagRuleset fails closed on unsupported fnmatch syntax (backslash / [^...] negation)', () => {
  const back = fullLock({ conditions: { ref_name: { include: ['refs/tags/v\\*'], exclude: [] } } });
  const r1 = evaluateTagRuleset({ rulesets: [back], ref: 'refs/tags/v1', releaseActorId: RID });
  assert.equal(r1.ok, false);
  assert.ok(r1.errors.some((e) => e.includes('unsupported fnmatch syntax')), r1.errors.join(' | '));

  const neg = fullLock({ conditions: { ref_name: { include: ['refs/tags/v[^x]'], exclude: [] } } });
  const r2 = evaluateTagRuleset({ rulesets: [neg], ref: 'refs/tags/va', releaseActorId: RID });
  assert.equal(r2.ok, false);
  assert.ok(r2.errors.some((e) => e.includes('unsupported fnmatch syntax')), r2.errors.join(' | '));
});

test('evaluateTagRuleset: the release bypass must be an ALWAYS User with the exact actor id (mode/type/id bound)', () => {
  const prOnly = fullLock({ bypass_actors: [{ actor_type: 'User', actor_id: 424242, bypass_mode: 'pull_request' }] });
  const r1 = evaluateTagRuleset({ rulesets: [prOnly], ref: 'refs/tags/v1.0.0', releaseActorId: RID });
  assert.equal(r1.ok, false, 'pull_request bypass mode is not "always"');

  const wrongId = fullLock({ bypass_actors: [{ actor_type: 'User', actor_id: 111, bypass_mode: 'always' }] });
  const r2 = evaluateTagRuleset({ rulesets: [wrongId], ref: 'refs/tags/v1.0.0', releaseActorId: RID });
  assert.equal(r2.ok, false, 'a different actor id is a foreign bypass');

  const wrongType = fullLock({ bypass_actors: [{ actor_type: 'Team', actor_id: 424242, bypass_mode: 'always' }] });
  const r3 = evaluateTagRuleset({ rulesets: [wrongType], ref: 'refs/tags/v1.0.0', releaseActorId: RID });
  assert.equal(r3.ok, false, 'a Team with the same numeric id is not the User release identity');
});

test('evaluateTagRuleset: ~ALL include covers a concrete tag ref (org-wide tag ruleset)', () => {
  const all = fullLock({ conditions: { ref_name: { include: ['~ALL'], exclude: [] } } });
  const r = evaluateTagRuleset({ rulesets: [all], ref: 'refs/tags/mcp-v1.2.3', releaseActorId: RID });
  assert.deepEqual(r.errors, []);
  assert.equal(r.ok, true);
});

test('DEFAULT_REQUIRED_OPS includes the floating-tag force-update guard', () => {
  assert.ok(DEFAULT_REQUIRED_OPS.includes('non_fast_forward'));
  assert.deepEqual([...DEFAULT_REQUIRED_OPS].sort(), ['creation', 'deletion', 'non_fast_forward', 'update']);
});

test('patternCoversNamespace accepts only namespace-covering wildcards (pass 41 finding #4)', () => {
  assert.ok(patternCoversNamespace('~ALL', 'v'), '~ALL covers everything');
  assert.ok(patternCoversNamespace('refs/tags/*', 'v'), 'refs/tags/* covers the v namespace');
  assert.ok(patternCoversNamespace('refs/tags/**', 'v'), 'refs/tags/** covers the v namespace');
  assert.ok(patternCoversNamespace('refs/tags/v*', 'v'), 'refs/tags/v* covers the v namespace');
  assert.ok(patternCoversNamespace('refs/tags/mcp-*', 'mcp-v'), 'refs/tags/mcp-* covers the mcp-v namespace');
  assert.ok(patternCoversNamespace('refs/tags/mcp-v*', 'mcp-v'), 'refs/tags/mcp-v* covers the mcp-v namespace');
  // Non-covering: an exact tag, a narrower prefix, or a foreign namespace prefix.
  assert.ok(!patternCoversNamespace('refs/tags/v1.2.3', 'v'), 'an exact tag does not cover the namespace');
  assert.ok(!patternCoversNamespace('refs/tags/ve*', 'v'), 'a narrower prefix does not cover the namespace');
  assert.ok(!patternCoversNamespace('refs/tags/v1*', 'v'), 'refs/tags/v1* does not cover v (misses v2)');
  assert.ok(!patternCoversNamespace('refs/tags/v*', 'mcp-v'), 'refs/tags/v* does not cover the mcp-v namespace');
  assert.ok(!patternCoversNamespace('refs/heads/v*', 'v'), 'a non-tag ref pattern does not cover a tag namespace');
});

// A namespace ruleset whose include is a WILDCARD covering the whole namespace.
function nsWildcard(overrides: Partial<TagRuleset> = {}): TagRuleset {
  return {
    id: 1,
    target: 'tag',
    enforcement: 'active',
    conditions: { ref_name: { include: ['refs/tags/v*'], exclude: [] } },
    rules: [{ type: 'creation' }, { type: 'update' }, { type: 'deletion' }, { type: 'non_fast_forward' }],
    bypass_actors: [RELEASE_BYPASS],
    ...overrides,
  };
}

test('evaluateTagNamespace accepts a namespace-covering wildcard ruleset', () => {
  const r = evaluateTagNamespace({ rulesets: [nsWildcard()], namespacePrefix: 'v', releaseActorId: RID });
  assert.deepEqual(r.errors, []);
  assert.equal(r.ok, true);
});

test('evaluateTagNamespace REJECTS a finite enumeration of exact tags (the finite-probe gap, pass 41 finding #4)', () => {
  // This ruleset restricts and locks EXACTLY the four probe refs — every finite probe would
  // pass — but its include is an enumeration, so a future tag (v3, v1.2.4, …) is unprotected.
  const enumerated = nsWildcard({
    conditions: {
      ref_name: {
        include: ['refs/tags/v1', 'refs/tags/v1.2.3', 'refs/tags/v2', 'refs/tags/v10.20.30'],
        exclude: [],
      },
    },
  });
  const r = evaluateTagNamespace({ rulesets: [enumerated], namespacePrefix: 'v', releaseActorId: RID });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('covers the entire')), r.errors.join(' | '));
});

test('evaluateTagNamespace REJECTS a covering ruleset that carries an exclude (a hole in the namespace)', () => {
  const carved = nsWildcard({ conditions: { ref_name: { include: ['refs/tags/v*'], exclude: ['refs/tags/v9'] } } });
  const r = evaluateTagNamespace({ rulesets: [carved], namespacePrefix: 'v', releaseActorId: RID });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('covers the entire')), r.errors.join(' | '));
});

test('evaluateTagNamespace applies the layered bypass checks to the covering ruleset', () => {
  // A namespace-covering ruleset that grants a FOREIGN bypass fails.
  const foreign = nsWildcard({ bypass_actors: [RELEASE_BYPASS, { actor_type: 'Team', actor_id: 99, bypass_mode: 'always' }] });
  const r1 = evaluateTagNamespace({ rulesets: [foreign], namespacePrefix: 'v', releaseActorId: RID });
  assert.equal(r1.ok, false);
  assert.ok(r1.errors.some((e) => e.includes('other than the User release identity')), r1.errors.join(' | '));
  // A namespace-covering ruleset that does NOT grant the identity a bypass fails.
  const noBypass = nsWildcard({ bypass_actors: [] });
  const r2 = evaluateTagNamespace({ rulesets: [noBypass], namespacePrefix: 'v', releaseActorId: RID });
  assert.equal(r2.ok, false);
  assert.ok(r2.errors.some((e) => e.includes('does not grant the User release identity')), r2.errors.join(' | '));
});

test('evaluateTagNamespace requires every op to be restricted by a namespace-covering ruleset', () => {
  const noForce = nsWildcard({ rules: [{ type: 'creation' }, { type: 'update' }, { type: 'deletion' }] });
  const r = evaluateTagNamespace({ rulesets: [noForce], namespacePrefix: 'v', releaseActorId: RID });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('not restricted for non_fast_forward')), r.errors.join(' | '));
});

test('patternOverlapsNamespace flags partial-cover patterns and rejects disjoint ones (pass 43 finding #4)', () => {
  assert.ok(patternOverlapsNamespace('~ALL', 'v'), '~ALL overlaps everything');
  assert.ok(patternOverlapsNamespace('refs/tags/v*', 'v'), 'a whole-namespace pattern overlaps');
  assert.ok(patternOverlapsNamespace('refs/tags/v1*', 'v'), 'a PARTIAL wildcard (v1*) overlaps the v namespace');
  assert.ok(patternOverlapsNamespace('refs/tags/*', 'v'), 'a broader wildcard overlaps');
  assert.ok(patternOverlapsNamespace('refs/tags/v1.2.3', 'v'), 'an exact tag inside the namespace overlaps');
  assert.ok(!patternOverlapsNamespace('refs/tags/mcp-v*', 'v'), 'a disjoint prefix (mcp-v*) does not overlap the v namespace');
  assert.ok(!patternOverlapsNamespace('refs/tags/w1.2.3', 'v'), 'an exact tag outside the namespace does not overlap');
  assert.ok(!patternOverlapsNamespace('~DEFAULT_BRANCH', 'v'), 'a non-~ALL ~-token names no tag in the namespace');
});

test('patternOverlapsNamespace is CLASS-AWARE: a / inside a [...] class does not split the tag segment (pass 44 finding #4)', () => {
  // `refs/tags/[a/b]v*` is a SINGLE tag-segment pattern (the `/` inside `[…]` is inert under
  // FNM_PATHNAME). A non-class-aware `[^/]*` split would misread it as multi-segment and, lacking
  // `**`, return false — letting a partial restrictive ruleset ESCAPE the overlap audit. It must
  // be treated as (conservatively) overlapping.
  assert.ok(patternOverlapsNamespace('refs/tags/[a/b]v*', 'v'), 'a tag pattern with a / inside a class still overlaps (fail closed)');
  assert.ok(patternOverlapsNamespace('refs/tags/v[0/1]*', 'v'), 'a v-prefixed class pattern overlaps the v namespace');
  // A genuinely deeper path (a real extra segment) is still not a single-tag pattern.
  assert.ok(!patternOverlapsNamespace('refs/tags/v/extra', 'v'), 'a real multi-segment tag path is not a single-tag overlap');
});

test('evaluateTagNamespace does NOT ignore a PARTIAL restrictive layer that grants a foreign bypass (pass 43 finding #4)', () => {
  // A whole-namespace covering ruleset locks everything correctly...
  const covering = nsWildcard();
  // ...but a SECOND active tag ruleset that covers only PART of the namespace (refs/tags/v1*)
  // grants a FOREIGN bypass. A whole-namespace-only check would ignore it; the overlap audit
  // must flag it, because it opens a hole over the v1* sub-range.
  const partialForeign = nsWildcard({
    id: 2,
    conditions: { ref_name: { include: ['refs/tags/v1*'], exclude: [] } },
    bypass_actors: [RELEASE_BYPASS, { actor_type: 'Team', actor_id: 99, bypass_mode: 'always' }],
  });
  const r = evaluateTagNamespace({ rulesets: [covering, partialForeign], namespacePrefix: 'v', releaseActorId: RID });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('other than the User release identity')), r.errors.join(' | '));
});

test('evaluateTagNamespace does NOT ignore a PARTIAL restrictive layer that omits the release identity (pass 43 finding #4)', () => {
  const covering = nsWildcard();
  // A partial restricting layer over v9* that does NOT grant the release identity a bypass would
  // block the identity on that sub-range; the overlap audit must flag it.
  const partialNoIdentity = nsWildcard({
    id: 3,
    conditions: { ref_name: { include: ['refs/tags/v9*'], exclude: [] } },
    bypass_actors: [],
  });
  const r = evaluateTagNamespace({ rulesets: [covering, partialNoIdentity], namespacePrefix: 'v', releaseActorId: RID });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('does not grant the User release identity')), r.errors.join(' | '));
});

test('evaluateTagNamespace ignores a DISJOINT partial layer (different namespace) (pass 43 finding #4)', () => {
  // A ruleset for a disjoint namespace (mcp-v*) with a foreign bypass must NOT affect the v
  // namespace evaluation (no false positive).
  const covering = nsWildcard();
  const disjoint = nsWildcard({
    id: 4,
    conditions: { ref_name: { include: ['refs/tags/mcp-v*'], exclude: [] } },
    bypass_actors: [RELEASE_BYPASS, { actor_type: 'Team', actor_id: 99, bypass_mode: 'always' }],
  });
  const r = evaluateTagNamespace({ rulesets: [covering, disjoint], namespacePrefix: 'v', releaseActorId: RID });
  assert.deepEqual(r.errors, []);
  assert.equal(r.ok, true);
});
