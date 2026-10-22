// Single, operation-aware, LAYERED evaluator for GitHub tag rulesets. It answers one
// question faithfully: given the FULL set of a repository's active tag rulesets, is a
// concrete tag ref locked (for EVERY required operation) so that ONLY the one release
// identity can perform it? "Layered" because GitHub ANDs every applicable ruleset — each
// applicable ruleset independently enforces its own rules, so a bypass must be granted by
// EVERY applicable restricting layer, and NO applicable layer may grant a foreign bypass.
//
// The fnmatch implementation mirrors GitHub's ref-name matching (Ruby File.fnmatch with
// FNM_PATHNAME over `/`-separated segments and a RESTRICTED bracket-class subset: no
// backslash escaping, `[!...]` negation only). It is a straight port of the release
// workflows' inline evaluator so the standalone verifier and the release-time preflights
// agree bit-for-bit — one evaluator, no divergence. Pure and dependency-free so it can be
// unit-tested adversarially and reused from a thin CLI wrapper.

export interface RulesetBypassActor {
  readonly actor_type?: string;
  readonly actor_id?: number | string;
  readonly bypass_mode?: string;
}
export interface RulesetRule {
  readonly type?: string;
}
export interface RulesetRefName {
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
}
export interface RulesetConditions {
  readonly ref_name?: RulesetRefName;
}
export interface TagRuleset {
  readonly id?: number | string;
  readonly target?: string;
  readonly enforcement?: string;
  readonly conditions?: RulesetConditions;
  readonly rules?: readonly RulesetRule[];
  readonly bypass_actors?: readonly RulesetBypassActor[] | null;
}
export interface EvaluateTagRulesetInput {
  readonly rulesets: readonly TagRuleset[];
  readonly ref: string;
  readonly releaseActorId: string;
  /** Operations that MUST be restricted on the ref. Defaults to the full write+force set. */
  readonly requiredOps?: readonly string[];
}
export interface EvaluateTagRulesetResult {
  readonly ok: boolean;
  readonly errors: readonly string[];
}

/** All operations a floating/immutable release tag must be locked for. */
export const DEFAULT_REQUIRED_OPS: readonly string[] = [
  'creation',
  'update',
  'deletion',
  'non_fast_forward',
];

function reLit(ch: string): string {
  return ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
// Inside a regex character class only ] \ ^ - are significant. An escaped literal from the
// pattern must be emitted so it can NEVER form a JS range (`[a\-z]` = {a,-,z}, not a..z).
function classLit(ch: string): string {
  return ch.replace(/[\]\\^-]/g, '\\$&');
}

function segToRegex(seg: string): RegExp {
  let re = '^';
  for (let i = 0; i < seg.length; i++) {
    const c = seg.charAt(i);
    if (c === '*') {
      re += '[^/]*';
    } else if (c === '?') {
      re += '[^/]';
    } else if (c === '[') {
      let j = i + 1;
      let neg = false;
      if (seg.charAt(j) === '!') {
        neg = true;
        j++;
      }
      if (seg.charAt(j) === ']' && j < seg.length) {
        // `]` in first position closes an EMPTY set: positive matches nothing, negated
        // matches any single non-`/` char.
        re += neg ? '[^/]' : '[^\\s\\S]';
        i = j;
      } else {
        let out = '';
        let closed = false;
        let members = 0;
        while (j < seg.length) {
          if (seg.charAt(j) === ']') {
            closed = true;
            break;
          }
          const lo = seg.charAt(j);
          j += 1;
          if (seg.charAt(j) === '-' && j < seg.length && j + 1 < seg.length && seg.charAt(j + 1) !== ']') {
            j += 1;
            const hi = seg.charAt(j);
            j += 1;
            if (lo.charCodeAt(0) <= hi.charCodeAt(0)) {
              out += classLit(lo) + '-' + classLit(hi);
              members++;
            } else {
              // Reversed range matches EXACTLY its two endpoints (Ruby byte-compares bounds).
              out += classLit(lo) + classLit(hi);
              members += 2;
            }
          } else {
            out += classLit(lo);
            members++;
          }
        }
        if (!closed) {
          return /[^\s\S]/; // UNTERMINATED class -> NO MATCH (Ruby)
        }
        if (neg) re += members ? '[^' + out + ']' : '[^/]';
        else re += members ? '[' + out + ']' : '[^\\s\\S]';
        i = j;
      }
    } else {
      re += reLit(c);
    }
  }
  return new RegExp(re + '$');
}

function segMatch(pat: readonly string[], r: readonly string[], pi: number, ri: number): boolean {
  while (pi < pat.length) {
    const p = pat[pi] as string;
    // Terminal `**` is NOT recursive under FNM_PATHNAME (behaves like `*`); only a
    // NON-terminal `**` (from `**/`) matches zero or more whole segments.
    if (p === '**' && pi < pat.length - 1) {
      for (let k = ri; k <= r.length; k++) {
        if (segMatch(pat, r, pi + 1, k)) return true;
      }
      return false;
    }
    if (ri >= r.length) return false;
    if (!segToRegex(p).test(r[ri] as string)) return false;
    pi++;
    ri++;
  }
  return ri === r.length;
}

function classEnd(p: string, i: number): number {
  // Index just past a bracket class opened at i (`[`), or -1 if UNTERMINATED.
  let j = i + 1;
  if (p.charAt(j) === '!') j++;
  if (p.charAt(j) === ']' && j < p.length) return j + 1;
  while (j < p.length) {
    if (p.charAt(j) === ']') return j + 1;
    j++;
  }
  return -1;
}

function splitSegments(p: string): string[] {
  // Split a PATTERN into path segments on `/`, but NEVER on a `/` inside a TERMINATED
  // bracket class (class-aware). No backslash escaping in GitHub rulesets.
  const segs: string[] = [];
  let cur = '';
  for (let i = 0; i < p.length; i++) {
    const c = p.charAt(i);
    if (c === '/') {
      segs.push(cur);
      cur = '';
      continue;
    }
    if (c === '[') {
      const end = classEnd(p, i);
      if (end >= 0) {
        cur += p.slice(i, end);
        i = end - 1;
        continue;
      }
    }
    cur += c;
  }
  segs.push(cur);
  return segs;
}

function matchesPattern(p: string, ref: string): boolean {
  if (p === '~ALL') return true;
  if (p.charAt(0) === '~') return false;
  return segMatch(splitSegments(p), ref.split('/'), 0, 0);
}

function covers(rs: TagRuleset, ref: string): boolean {
  const cond = (rs.conditions && rs.conditions.ref_name) || {};
  const inc = cond.include || [];
  const exc = cond.exclude || [];
  return inc.some((p) => matchesPattern(p, ref)) && !exc.some((p) => matchesPattern(p, ref));
}

function restricts(rs: TagRuleset, t: string): boolean {
  return (rs.rules || []).some((x) => x.type === t);
}

function isReleaseActor(a: RulesetBypassActor, rid: string): boolean {
  return !!a && a.actor_type === 'User' && String(a.actor_id) === rid && a.bypass_mode === 'always';
}

/** Push any LAYERED-bypass errors for a single applicable ruleset `rs` into `errors`: it must
 *  return its bypass actors, grant NO foreign bypass, and — if it restricts any required op —
 *  grant the release identity an `always` User bypass (layered rulesets are ANDed). */
function checkLayerBypass(
  rs: TagRuleset,
  rid: string,
  requiredOps: readonly string[],
  label: string,
  errors: string[],
): void {
  if (!Object.prototype.hasOwnProperty.call(rs, 'bypass_actors') || rs.bypass_actors === null || rs.bypass_actors === undefined) {
    errors.push(label + ' ruleset id=' + String(rs.id) + ' did not return bypass_actors (insufficient API visibility)');
    return;
  }
  const foreign = rs.bypass_actors.filter((a) => !isReleaseActor(a, rid));
  if (foreign.length > 0) {
    errors.push(label + ' ruleset id=' + String(rs.id) + ' grants a bypass to ' + foreign.length + ' actor(s) other than the User release identity ' + rid);
  }
  const restrictsAny = requiredOps.some((t) => restricts(rs, t));
  const grantsIdentity = rs.bypass_actors.some((a) => isReleaseActor(a, rid));
  if (restrictsAny && !grantsIdentity) {
    errors.push(
      label + ' applicable RESTRICTING ruleset id=' + String(rs.id) +
        ' does not grant the User release identity ' + rid +
        ' a bypass (layered rulesets are ANDed — the identity must bypass EVERY restricting layer)',
    );
  }
}

/**
 * True iff `pattern` covers the ENTIRE `refs/tags/<namespacePrefix>*` namespace — i.e. it
 * matches every tag that begins with `<namespacePrefix>`. Accepted covers are `~ALL` and a
 * single-segment wildcard `refs/tags/<lit>*` / `refs/tags/<lit>**` whose literal prefix
 * `<lit>` is a PREFIX of `<namespacePrefix>` (so the trailing `*` absorbs the rest of the
 * namespace prefix and any suffix, within the one tag segment). A finite list of exact tags,
 * or a narrower prefix (`refs/tags/ve*` for the `v` namespace), does NOT cover it.
 */
export function patternCoversNamespace(pattern: string, namespacePrefix: string): boolean {
  if (pattern === '~ALL') return true;
  const m = /^refs\/tags\/([^*?[\]/]*)(\*\*?)$/.exec(pattern);
  if (!m) return false;
  return namespacePrefix.startsWith(m[1]!);
}

/**
 * True iff `pattern` could match AT LEAST ONE tag in the `refs/tags/<namespacePrefix>*`
 * namespace — a SOUND over-approximation used to catch RESTRICTIVE LAYERS that cover only PART
 * of the namespace (which a whole-namespace-only check would ignore). `~ALL` overlaps; any other
 * `~`-token names a non-tag ref and does not. The pattern is split into path segments
 * CLASS-AWARELY ({@link splitSegments}), so a `/` INSIDE a `[…]` character class (which does not
 * match a `/` separator under FNM_PATHNAME) does not spuriously split the tag segment — otherwise
 * a `refs/tags/[a/b]v*` pattern would be misread as multi-segment and ESCAPE the overlap audit.
 * A single-tag-segment pattern (`refs`,`tags`,`<seg>`) overlaps iff its leading LITERAL (up to
 * the first wildcard/class) and the prefix are prefix-compatible; an EXACT tag overlaps iff its
 * name starts with the prefix. A recursive-`**` `refs/…` pattern is conservatively treated as
 * overlapping (fail closed); any other shape does not overlap.
 */
export function patternOverlapsNamespace(pattern: string, namespacePrefix: string): boolean {
  if (pattern === '~ALL') return true;
  if (pattern.charAt(0) === '~') return false;
  const segs = splitSegments(pattern);
  if (segs.length !== 3 || segs[0] !== 'refs' || segs[1] !== 'tags') {
    // Not a single-tag-segment pattern: a recursive `**/` (which spans segments) is conservatively
    // treated as overlapping; anything else (a non-tag ref, a deeper path) does not overlap.
    return /\*\*/.test(pattern) && pattern.startsWith('refs/');
  }
  const seg = segs[2]!;
  const w = seg.search(/[*?[]/);
  if (w < 0) return seg.startsWith(namespacePrefix); // exact tag: in-namespace iff name starts with prefix
  const lit = seg.slice(0, w);
  return lit.startsWith(namespacePrefix) || namespacePrefix.startsWith(lit);
}

export interface EvaluateTagNamespaceInput {
  readonly rulesets: readonly TagRuleset[];
  /** The literal tag-name prefix of the namespace within `refs/tags/` — e.g. `v` or `mcp-v`. */
  readonly namespacePrefix: string;
  readonly releaseActorId: string;
  readonly requiredOps?: readonly string[];
}

/**
 * Evaluate whether the ENTIRE `refs/tags/<namespacePrefix>*` namespace is protected — not just
 * a finite set of representative probe refs. Because a ruleset whose include is a finite LIST
 * of exact tags would pass every finite probe while leaving future tags unprotected, this
 * requires, for EACH required operation, at least one ACTIVE tag ruleset that (a) has an
 * include pattern COVERING the whole namespace ({@link patternCoversNamespace}), (b) carries
 * NO excludes (any exclude could carve a hole in the namespace), (c) restricts that operation,
 * and (d) — with every other namespace-covering layer — grants the release identity the sole
 * `always` User bypass. This is the namespace-wide complement to the per-ref layered evaluation.
 *
 * It ADDITIONALLY audits every RESTRICTIVE LAYER that OVERLAPS the namespace — even one covering
 * only PART of it ({@link patternOverlapsNamespace}) — because GitHub ANDs layers: a partial
 * restricting layer that grants a FOREIGN bypass would open a hole over its sub-range, and one
 * that omits the release identity would block the identity there. A whole-namespace-only check
 * would ignore such partial layers, so the layered bypass check runs over ALL overlapping active
 * tag rulesets (a superset of the whole-namespace-covering ones).
 */
export function evaluateTagNamespace(input: EvaluateTagNamespaceInput): EvaluateTagRulesetResult {
  const rid = String(input.releaseActorId || '');
  const prefix = input.namespacePrefix;
  const requiredOps = input.requiredOps && input.requiredOps.length ? input.requiredOps : DEFAULT_REQUIRED_OPS;
  const errors: string[] = [];
  const ns = 'refs/tags/' + prefix + '*';

  const active = input.rulesets.filter((rs) => rs.target === 'tag' && rs.enforcement === 'active');
  try {
    for (const rs of active) {
      const cond = (rs.conditions && rs.conditions.ref_name) || {};
      const pats = (cond.include || []).concat(cond.exclude || []);
      for (const p of pats) assertSupported(p);
    }
  } catch (e) {
    errors.push((e as Error).message + '; cannot faithfully evaluate namespace coverage. Fix the ruleset to use supported syntax.');
    return { ok: false, errors };
  }

  // A ruleset "namespace-covers" iff it has a covering include AND no excludes (an exclude
  // could carve a hole, so a ruleset with any exclude cannot be relied on for full coverage).
  const covering = active.filter((rs) => {
    const cond = (rs.conditions && rs.conditions.ref_name) || {};
    const inc = cond.include || [];
    const exc = cond.exclude || [];
    if (exc.length > 0) return false;
    return inc.some((p) => patternCoversNamespace(p, prefix));
  });

  // A ruleset OVERLAPS the namespace iff some include could match a tag in it AND no exclude
  // fully covers the namespace (an exclude spanning the whole namespace removes the overlap).
  const overlapping = active.filter((rs) => {
    const cond = (rs.conditions && rs.conditions.ref_name) || {};
    const inc = cond.include || [];
    const exc = cond.exclude || [];
    if (!inc.some((p) => patternOverlapsNamespace(p, prefix))) return false;
    if (exc.some((p) => patternCoversNamespace(p, prefix))) return false;
    return true;
  });

  if (covering.length === 0) {
    errors.push('no active tag ruleset include pattern covers the entire ' + ns + ' namespace (a finite list of exact tags does not protect future tags)');
  }
  for (const t of requiredOps) {
    if (!covering.some((rs) => restricts(rs, t))) {
      errors.push('the ' + ns + ' namespace is not restricted for ' + t + ' by a namespace-covering ruleset');
    }
  }
  // Layered bypass audit over EVERY overlapping layer (partial or whole), so a restrictive layer
  // covering only part of the namespace is not ignored.
  for (const rs of overlapping) checkLayerBypass(rs, rid, requiredOps, ns, errors);
  return { ok: errors.length === 0, errors };
}

// GitHub rulesets use a RESTRICTED fnmatch: NO backslash escaping and NO `[^...]` class
// negation (only `[!...]`). Evaluating unsupported syntax OUR way could diverge from GitHub
// and falsely approve/deny a ruleset, so FAIL CLOSED.
function assertSupported(pattern: string): void {
  if (pattern.indexOf('\\') !== -1) {
    throw new Error(
      'unsupported fnmatch syntax (backslash escapes are not supported by GitHub rulesets) in pattern ' +
        JSON.stringify(pattern),
    );
  }
  for (let i = 0; i < pattern.length; i++) {
    if (pattern.charAt(i) === '[' && pattern.charAt(i + 1) === '^') {
      throw new Error(
        'unsupported fnmatch syntax ([^...] class negation is not supported by GitHub rulesets; use [!...]) in pattern ' +
          JSON.stringify(pattern),
      );
    }
  }
}

/**
 * Evaluate whether `ref` is locked to `releaseActorId` for every required operation across
 * ALL applicable active tag rulesets. Returns `{ ok, errors }` — `ok` is true only when the
 * ref is covered by at least one applicable ruleset, every required operation is restricted
 * by some applicable ruleset, no applicable ruleset grants a foreign bypass, and every
 * applicable RESTRICTING ruleset grants the release identity an `always` User bypass.
 */
export function evaluateTagRuleset(input: EvaluateTagRulesetInput): EvaluateTagRulesetResult {
  const rid = String(input.releaseActorId || '');
  const ref = input.ref;
  const requiredOps = input.requiredOps && input.requiredOps.length ? input.requiredOps : DEFAULT_REQUIRED_OPS;
  const errors: string[] = [];

  // Only ACTIVE tag rulesets can enforce anything.
  const active = input.rulesets.filter((rs) => rs.target === 'tag' && rs.enforcement === 'active');

  // Validate EVERY pattern for unsupported syntax FIRST, before any `~`-token handling, so a
  // pattern that merely BEGINS with `~` cannot smuggle unsupported syntax past the check.
  try {
    for (const rs of active) {
      const cond = (rs.conditions && rs.conditions.ref_name) || {};
      const pats = (cond.include || []).concat(cond.exclude || []);
      for (const p of pats) assertSupported(p);
    }
  } catch (e) {
    errors.push((e as Error).message + '; cannot faithfully evaluate coverage. Fix the ruleset to use supported syntax.');
    return { ok: false, errors };
  }

  const app = active.filter((rs) => covers(rs, ref));
  if (app.length === 0) errors.push('no active tag ruleset applies to ' + ref);
  for (const t of requiredOps) {
    if (!app.some((rs) => restricts(rs, t))) errors.push(ref + ' is not restricted for ' + t);
  }
  // LAYERED (ANDed): every applicable ruleset independently enforces its rules, so the
  // release identity must bypass EVERY applicable RESTRICTING layer, and NO applicable layer
  // may grant a foreign bypass.
  for (const rs of app) checkLayerBypass(rs, rid, requiredOps, ref, errors);
  return { ok: errors.length === 0, errors };
}
