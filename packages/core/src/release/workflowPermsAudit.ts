// Static audit of GitHub Actions workflow files for EXPLICIT authority grants that the
// repository/organization DEFAULT-token audit cannot see. The default-token audit proves the
// GITHUB_TOKEN's DEFAULT permission is read-only, but a workflow (or a specific job) can
// re-grant write with its own `permissions:` block, and a REUSABLE workflow (`uses: …/*.yml`)
// runs with delegated authority whose effective permissions the default-token audit never
// inspects. Both are release-authority vectors, so this module flags:
//   - a BROAD `write-all` grant (or an UNRESOLVABLE alias value) at the workflow OR job level;
//   - a content-bearing `write` scope (`contents`/`packages`) at the workflow OR job level;
//   - any reusable-workflow invocation (`uses:` whose value names a `.yml`/`.yaml` file).
//
// The GitHub `permissions` grammar is a small, regular subset of YAML, parsed here with an
// indentation-aware scanner (no YAML dependency). To avoid the false-passes a naive scanner
// suffers, it additionally handles: QUOTED KEYS (`"permissions":`, `'contents':`, `"uses":`,
// including double-quoted ESCAPES like `"permissio\u006es"`), YAML ANCHORS
// (`permissions: &perm write-all`) and ALIASES (`permissions: *perm`, and `uses: *ref`, resolved
// POSITION-AWARE against anchor definitions — an alias binds to the nearest PRECEDING definition,
// so an anchor REDEFINITION cannot smuggle a later safer value; FOLDED/BLOCK-SCALAR,
// BLOCK-MAPPING, and ANCHORED FLOW-MAP anchor VALUES are all captured; an UNRESOLVABLE alias fails
// closed), QUOTED `uses:` values, BLOCK/FOLDED scalars (`permissions: >` / `uses: >`), MULTILINE
// FLOW mappings (`permissions: {` spanning lines), and FLOW-FORM grants — a `permissions:` OR a
// reusable-workflow `uses:` nested in a `{ … }` flow map (e.g. flow-form `jobs: { … }`), with the
// flow-context key double-quote-DECODED so an escaped `"permission\u0073"`/`"use\u0073"` key is
// not missed — the former treated as UNGATED (fail closed) since flow-form gating is not
// verifiable. It ALSO handles YAML NODE TAGS (`permissions: !!str write-all`), MERGE KEYS
// (`<<: *anchor` splicing an anchor's `permissions:`/`uses:` grant into a node — treated as an
// ungated grant, fail closed), and COMPLEX FLOW VALUES (a `{ … }` map split on top-level commas so
// a nested `[ … ]`/`{ … }` value is not mis-parsed). A narrow content-write is downgraded to a NOTE
// for an allowlisted workflow ONLY when its granting JOB is gated by a KNOWN-PROTECTED
// `environment:` (a name in the operator-verified protected set — an ARBITRARY environment name
// does NOT count); an UNGATED content-write (workflow-level, or a job with no/unknown environment)
// is a finding even when allowlisted. Comments (an unquoted `#` to end-of-line) are stripped
// first. This is a STATIC heuristic over reviewed, well-formed workflow files — not a general
// YAML parser.

export interface WorkflowInput {
  /** The workflow file name (for messages), e.g. `release.yml`. */
  readonly name: string;
  /** The workflow YAML text. */
  readonly content: string;
}

export interface AuditWorkflowPermissionsOptions {
  /**
   * Workflow file names whose NARROW content-scope write grants (`contents: write` /
   * `packages: write`) are independently gated (protected environments + release identity) and
   * audited elsewhere. A narrow content-write in one of these is REPORTED as a NOTE rather than
   * a finding ONLY when it is granted in a job gated by a KNOWN-PROTECTED `environment:` (see
   * {@link protectedEnvironments}); an UNGATED content-write (workflow-level, a job with no
   * `environment:`, or a job whose environment name is NOT in the protected set) is ALWAYS a
   * finding even for an allowlisted workflow — allowlisting cannot bless an un-gated write. A
   * BROAD `write-all` grant (or an unresolvable alias) is ALWAYS a finding even for an
   * allowlisted workflow. A reusable-workflow `uses:` is always a finding regardless of name.
   */
  readonly allowlistedWriteWorkflows?: readonly string[];
  /**
   * The environment NAMES the operator has independently provisioned as protected (required
   * reviewers + deployment-branch policy), verified elsewhere by the live release-protection
   * checks. ONLY a job whose `environment:` resolves to a name in THIS set counts as gated, so
   * an ARBITRARY `environment: anything` cannot launder an un-gated content-write into a NOTE.
   * When omitted/empty, NO environment name is treated as protected — every content-write is
   * un-gated (fail closed).
   */
  readonly protectedEnvironments?: readonly string[];
}

export interface AuditWorkflowPermissionsResult {
  /** Hard findings (each fails the audit). */
  readonly findings: readonly string[];
  /** Informational notes (allowlisted narrow content-write grants), for operator visibility. */
  readonly notes: readonly string[];
}

const CONTENT_WRITE_SCOPES = new Set(['contents', 'packages']);

/** Remove an unquoted `#`…EOL comment from a single line. */
function stripLineComment(line: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (c === '"' && !inSingle) inDouble = !inDouble;
    else if (c === '#' && !inSingle && !inDouble) {
      if (i === 0 || /\s/.test(line[i - 1]!)) return line.slice(0, i);
    }
  }
  return line;
}

/** The indentation (count of leading spaces) of a line. */
function indentOf(line: string): number {
  const m = /^( *)/.exec(line);
  return m ? m[1]!.length : 0;
}

function unquote(s: string): string {
  const t = s.trim();
  if (t.startsWith('"') && t.endsWith('"') && t.length >= 2) {
    // Decode the common escapes a double-quoted YAML key/scalar may carry, so an ESCAPED key
    // like `"permissio\u006es"` cannot hide a `permissions` grant from the audit.
    return decodeDoubleQuotedEscapes(t.slice(1, -1));
  }
  if (t.startsWith("'") && t.endsWith("'") && t.length >= 2) {
    // Single-quoted YAML: the only escape is a doubled `''` for a literal quote.
    return t.slice(1, -1).replace(/''/g, "'");
  }
  return t;
}

/** Decode the double-quoted YAML escapes that could obscure a key/scalar identity: `\uXXXX`,
 *  `\UXXXXXXXX` (8-hex, YAML's long-form unicode escape), `\xXX`, and the simple `\"`, `\\`, `\/`,
 *  `\t`, `\n`. Unknown escapes keep the following char. The 8-hex `\U` is decoded BEFORE the 4-hex
 *  `\u` so an escaped key like `"permission\U00000073"` is not missed (pass 47 finding #2). */
function decodeDoubleQuotedEscapes(s: string): string {
  return s
    .replace(/\\U([0-9A-Fa-f]{8})/g, (_m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/\\u([0-9A-Fa-f]{4})/g, (_m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/\\x([0-9A-Fa-f]{2})/g, (_m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/\\(["\\/tn])/g, (_m, c) => (c === 't' ? '\t' : c === 'n' ? '\n' : c));
}

/** Strip a leading YAML NODE TAG (`!!str`, `!!map`, `!Custom`, `!<tag:yaml.org,2002:str>`) from a
 *  value, so a TAGGED grant like `permissions: !!str write-all` or `uses: !!str ./x.yml` is
 *  classified by its underlying scalar rather than read as the literal `!!str write-all`
 *  (which would evade detection). Only a tag at the very START of the value (followed by
 *  whitespace) is removed (pass 46 finding #2). */
function stripYamlTag(s: string): string {
  return s.replace(/^\s*(?:!<[^>]*>|!\S+)\s+/, '');
}

/** Strip ALL leading YAML NODE PROPERTIES — a tag (`!!str`/`!Custom`/`!<…>`) and/or an anchor
 *  (`&name`) — in ANY ORDER and any number, so a value like `!!str &a write-all` or `&a !!str
 *  write-all` (a tag BEFORE an anchor, or vice-versa) resolves to its underlying scalar/map rather
 *  than being read as the literal property text (which would evade detection — pass 53 finding #2).
 *  A property must be followed by whitespace (a real node property), so a bare `&`/`!` inside a
 *  value is not mis-stripped. */
function stripNodeProperties(s: string): string {
  let t = s.trim();
  for (;;) {
    const stripped = stripYamlTag(t.replace(/^&[A-Za-z0-9_-]+\s+/, '')).trim();
    if (stripped === t) return t;
    t = stripped;
  }
}

/** Split a flow-map/flow-seq BODY on TOP-LEVEL commas, respecting nested `{}`/`[]`/`()` AND
 *  QUOTED STRINGS — so a COMPLEX flow value (`{ contents: write, x: [a, b] }`) is not mis-split
 *  inside its nested brackets (pass 46 finding #2) and a QUOTED value containing a comma
 *  (`{ name: "a,b", contents: write }`) is not split at the in-string comma (pass 47 finding #2).
 *  A double-quoted string honors `\`-escapes; a single-quoted string honors `''`. */
function splitTopLevelFlowEntries(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  let i = 0;
  while (i < body.length) {
    const c = body[i]!;
    if (c === '"') {
      // Skip a double-quoted string (honoring `\"` escapes).
      i++;
      while (i < body.length && body[i] !== '"') { if (body[i] === '\\') i++; i++; }
      i++;
      continue;
    }
    if (c === "'") {
      // Skip a single-quoted string (a doubled `''` is a literal quote, not a terminator).
      i++;
      while (i < body.length) { if (body[i] === "'") { if (body[i + 1] === "'") { i += 2; continue; } break; } i++; }
      i++;
      continue;
    }
    if (c === '{' || c === '[' || c === '(') depth++;
    else if (c === '}' || c === ']' || c === ')') { if (depth > 0) depth--; }
    else if (c === ',' && depth === 0) { out.push(body.slice(start, i)); start = i + 1; }
    i++;
  }
  out.push(body.slice(start));
  return out;
}

/** The index within `s` of the first TOP-LEVEL flow terminator among `,`/`}` (respecting nested
 *  `{}`/`[]`/`()` and QUOTED STRINGS), or -1 if none. Used to bound a flow SCALAR value so a
 *  quoted value containing a comma/brace (`uses: "a,b.yml"`) is not truncated at an in-string
 *  delimiter (pass 47 finding #2). */
function flowScalarTerminator(s: string): number {
  let depth = 0;
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (c === '"') { i++; while (i < s.length && s[i] !== '"') { if (s[i] === '\\') i++; i++; } i++; continue; }
    if (c === "'") { i++; while (i < s.length) { if (s[i] === "'") { if (s[i + 1] === "'") { i += 2; continue; } break; } i++; } i++; continue; }
    if (c === '{' || c === '[' || c === '(') depth++;
    else if (c === ']' || c === ')') { if (depth > 0) depth--; }
    else if (c === '}') { if (depth === 0) return i; depth--; }
    else if (c === ',' && depth === 0) return i;
    i++;
  }
  return -1;
}

/** Normalize YAML EXPLICIT-KEY blocks into the ordinary `key: value` block form. YAML allows a
 *  mapping entry to be written as `? <key>` (the key on the same line, or on FOLLOWING more-indented
 *  lines when the `?` stands alone) and `: <value>` at the SAME indentation as the `?`. A
 *  `permissions`/`uses`/scope grant written this way is invisible to the line-oriented `key:`
 *  scanners, so this pre-pass rewrites it into `<indent>key: value` and BLANKS the consumed lines
 *  (array length preserved so downstream indices are stable). A YAML NODE TAG on the key
 *  (`? !!str permissions`) is stripped, and a MULTILINE key (`?` alone, then the key on the next
 *  line) is gathered (pass 48 finding #2, extended pass 49 finding #2). */
function normalizeExplicitKeys(lines: readonly string[]): string[] {
  const out = lines.slice();
  for (let i = 0; i < out.length; i++) {
    const m = /^(\s*)\?(?:\s+(\S.*?))?\s*$/.exec(out[i]!);
    if (!m) continue;
    const indent = m[1]!;
    const consumed: number[] = [i];
    let keyText = (m[2] ?? '').trim();
    // A `?` that stands ALONE: gather the key from subsequent more-indented lines until the
    // matching `:` value line at the `?` indentation.
    if (keyText.length === 0) {
      let k = i + 1;
      while (k < out.length && out[k]!.trim().length === 0) k++;
      if (k < out.length && indentOf(out[k]!) > indent.length && !/^\s*:/.test(out[k]!)) {
        keyText = out[k]!.trim();
        consumed.push(k);
      }
    }
    if (keyText.length === 0) continue;
    // Strip a leading YAML ANCHOR (`&pk `) then a YAML node tag (`!!str permissions`) on the key
    // (pass 48/50 finding #2), so an anchored/tagged explicit key resolves to its bare name.
    keyText = stripYamlTag(keyText.replace(/^&[A-Za-z0-9_-]+\s+/, ''));
    // The `: value` line at the SAME indentation as the `?`.
    let j = consumed[consumed.length - 1]! + 1;
    while (j < out.length && out[j]!.trim().length === 0) j++;
    if (j >= out.length) continue;
    const vm = /^(\s*):\s?(.*)$/.exec(out[j]!);
    if (!vm || vm[1]!.length !== indent.length) continue;
    out[i] = `${indent}${keyText}: ${vm[2]!.trim()}`;
    for (const c of consumed) if (c !== i) out[c] = '';
    out[j] = '';
  }
  return out;
}

/** True iff `s` begins with a QUOTED scalar whose closing quote is NOT present on this line — a
 *  multiline double-/single-quoted scalar. Used to gather continuation lines so a value like
 *  `permissions: "write-\` … `  all"` (a double-quoted line continuation, folding to `write-all`)
 *  is not read as the unterminated first line only (pass 48 finding #2). */
function startsUnterminatedQuote(s: string): '"' | "'" | null {
  const t = s.replace(/^\s+/, '');
  const q = t[0];
  if (q !== '"' && q !== "'") return null;
  let i = 1;
  if (q === '"') {
    while (i < t.length) { if (t[i] === '\\') { i += 2; continue; } if (t[i] === '"') return null; i++; }
  } else {
    while (i < t.length) { if (t[i] === "'") { if (t[i + 1] === "'") { i += 2; continue; } return null; } i++; }
  }
  return q;
}

/** Gather a MULTILINE QUOTED scalar that begins at `keyLineIndex` with `firstValue` (a value whose
 *  opening quote is not closed on its line). Joins continuation lines — folding a double-quoted
 *  `\`-at-end-of-line line continuation (the break and following indentation are removed) and a
 *  plain line break to a single space — until the closing quote, returning the full quoted token
 *  (which {@link unquote} then decodes). If the quote never closes, returns the joined text
 *  (fail-closed: an unterminated grant is still scanned) (pass 48 finding #2). */
function readMultilineQuotedScalar(lines: readonly string[], keyLineIndex: number, firstValue: string): string {
  const q = startsUnterminatedQuote(firstValue);
  if (q === null) return firstValue;
  let acc = firstValue.replace(/^\s+/, '');
  const closed = (s: string): boolean => startsUnterminatedQuote(s) === null;
  // A trailing backslash on a double-quoted line escapes the newline (fold with no space); any
  // other continuation folds the break to a space.
  for (let j = keyLineIndex + 1; j < lines.length; j++) {
    if (q === '"' && /\\\s*$/.test(acc)) acc = acc.replace(/\\\s*$/, '') + lines[j]!.replace(/^\s+/, '');
    else acc = acc + ' ' + lines[j]!.replace(/^\s+/, '');
    if (closed(acc)) break;
  }
  return acc;
}

/** A KEY line `("<key>"|'<key>'|<key>) :` — matches optionally-quoted keys (a double-quoted key
 *  is escape-DECODED so `"permissio\u006es"` is read as `permissions`). Returns the lower-cased
 *  unquoted key name, its indentation, and the trailing text after the colon. */
function matchKeyLine(line: string): { indent: number; key: string; trailing: string } | null {
  const m = /^(\s*)(?:"((?:\\.|[^"\\])*)"|'((?:[^']|'')*)'|([A-Za-z0-9_.-]+))\s*:(.*)$/.exec(line);
  if (!m) return null;
  let key: string;
  if (m[2] !== undefined) key = decodeDoubleQuotedEscapes(m[2]);
  else if (m[3] !== undefined) key = m[3].replace(/''/g, "'");
  else key = m[4] ?? '';
  return { indent: m[1]!.length, key: key.toLowerCase(), trailing: m[5]!.trim() };
}

/** Parse an inline `{ scope: level, … }` permissions map into scope->level entries. Splits on
 *  TOP-LEVEL commas ({@link splitTopLevelFlowEntries}) so a complex nested flow value is not
 *  mis-split, and strips a YAML tag from each scope/level so a tagged level is still read. */
function parseInlinePermissions(inner: string): Array<{ scope: string; level: string }> {
  const out: Array<{ scope: string; level: string }> = [];
  const body = inner.trim().replace(/^\{/, '').replace(/\}$/, '');
  for (const part of splitTopLevelFlowEntries(body)) {
    const idx = part.indexOf(':');
    if (idx < 0) continue;
    // Strip a FLOW EXPLICIT-KEY marker `? ` before the scope (`{ ? contents : write }`) and any
    // leading anchor/tag, so an explicit-key scope resolves to its bare name (pass 50 finding #2).
    let scopeRaw = part.slice(0, idx).trim().replace(/^\?\s+/, '');
    const scope = unquote(stripNodeProperties(scopeRaw)).trim();
    const level = unquote(stripNodeProperties(part.slice(idx + 1))).trim();
    if (scope) out.push({ scope, level });
  }
  return out;
}

/** One YAML anchor DEFINITION: its name, effective value text, and the line it was defined on
 *  (for POSITION-AWARE resolution — a YAML alias resolves to the most recent PRIOR definition,
 *  so an anchor REDEFINITION cannot let an alias silently pick up a later, safer value). */
interface AnchorDef {
  readonly name: string;
  readonly value: string;
  readonly line: number;
}

/** The anchor table: the ordered list of definitions plus a position-aware resolver. */
interface AnchorTable {
  /** Resolve `name` to the value of its most recent definition BEFORE `atLine` (a YAML alias
   *  binds to the nearest preceding anchor). Returns undefined if none precedes it. */
  resolve(name: string, atLine: number): string | undefined;
}

/** Collect YAML anchor definitions across all (comment-stripped) lines, keeping EVERY definition
 *  (with its line) so an alias resolves to the nearest PRIOR one. Value forms captured so a
 *  folded/block/flow anchor cannot hide a grant behind an indicator:
 *   - INLINE `key: &name <value>` / `&name <value>` → the trailing scalar;
 *   - ANCHORED FLOW MAP `key: &name { … }` (single- OR multi-line) → the gathered `{ … }` text;
 *   - FOLDED/BLOCK-SCALAR `key: &name >` (or `|`) → the following indented block, space-folded;
 *   - BLOCK-MAPPING `key: &name` with nothing after → the following indented `k: v` lines,
 *     re-serialized as an inline `{k: v, …}` flow map so {@link classifyPermissionValue} reads it. */
function collectAnchors(lines: readonly string[]): AnchorTable {
  const defs: AnchorDef[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const m = /(?:^|:\s*)&([A-Za-z0-9_-]+)(?:\s+(.*\S))?\s*$/.exec(line);
    if (!m) continue;
    const name = m[1]!;
    const after = (m[2] ?? '').trim();
    if (after.startsWith('{')) {
      // ANCHORED FLOW MAP — gather across lines until the braces balance.
      defs.push({ name, value: readFlowMapping(lines, i, after), line: i });
      continue;
    }
    if (after.length > 0 && !isBlockScalarIndicator(after)) {
      defs.push({ name, value: after, line: i });
      continue;
    }
    // The anchor value is a BLOCK that follows on more-indented lines.
    const anchorIndent = indentOf(line);
    if (after.length > 0 && isBlockScalarIndicator(after)) {
      defs.push({ name, value: readBlockScalarValue(lines, i, anchorIndent), line: i });
      continue;
    }
    // Bare `&name` at end of line: read the following indented block. If it is a `k: v`
    // mapping, re-serialize to an inline flow map; otherwise fold as a scalar.
    const pairs: string[] = [];
    let scalarOnly = '';
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j]!.trim().length === 0) continue;
      if (indentOf(lines[j]!) <= anchorIndent) break;
      const skv = matchKeyLine(lines[j]!);
      if (skv && skv.trailing.length > 0) pairs.push(`${skv.key}: ${skv.trailing}`);
      else scalarOnly += (scalarOnly ? ' ' : '') + lines[j]!.trim();
    }
    if (pairs.length > 0) defs.push({ name, value: `{ ${pairs.join(', ')} }`, line: i });
    else if (scalarOnly.length > 0) defs.push({ name, value: scalarOnly, line: i });
  }
  return {
    resolve(name: string, atLine: number): string | undefined {
      let best: AnchorDef | undefined;
      for (const d of defs) {
        if (d.name !== name) continue;
        if (d.line > atLine) continue; // a definition AFTER the alias is not in scope
        if (best === undefined || d.line > best.line) best = d; // nearest preceding wins
      }
      return best?.value;
    },
  };
}

interface PermissionValue {
  broadWrite: boolean; // write-all
  contentWrites: string[]; // e.g. ['contents: write']
  unresolved: boolean; // an alias that could not be resolved (fail closed)
}

/** Classify a `permissions:` scalar/inline VALUE (after the colon), resolving a leading anchor
 *  and a `*alias` reference against `anchors` (POSITION-AWARE: the alias resolves to the nearest
 *  anchor defined before `atLine`). */
function classifyPermissionValue(trailingRaw: string, anchors: AnchorTable, atLine: number): PermissionValue {
  const res: PermissionValue = { broadWrite: false, contentWrites: [], unresolved: false };
  // Strip ALL leading YAML node properties (tag and/or anchor, in ANY ORDER) — so a TAGGED and/or
  // ANCHORED grant like `!!str &a write-all` or `&a !!str write-all` is classified by its
  // underlying scalar/map, not read as the literal property text (pass 53 finding #2).
  let trailing = stripNodeProperties(trailingRaw);
  // Resolve a `*alias` reference.
  const aliasMatch = /^\*([A-Za-z0-9_-]+)$/.exec(trailing);
  if (aliasMatch) {
    const resolved = anchors.resolve(aliasMatch[1]!, atLine);
    if (resolved === undefined) { res.unresolved = true; return res; }
    trailing = stripNodeProperties(resolved);
  }
  const token = unquote(trailing).toLowerCase();
  if (token === 'write-all') { res.broadWrite = true; return res; }
  if (token === 'read-all' || token === '{}' || token === '') return res;
  if (trailing.startsWith('{')) {
    for (const { scope, level } of parseInlinePermissions(trailing)) {
      if (level.toLowerCase() === 'write' && CONTENT_WRITE_SCOPES.has(scope.toLowerCase())) {
        res.contentWrites.push(`${scope}: write`);
      }
    }
  }
  return res;
}

/** True iff `trailing` is a YAML BLOCK-SCALAR indicator (`|`/`>` with optional chomping/indent
 *  indicators, e.g. `>`, `|-`, `>2`, `|+`), signalling the value continues on indented lines. */
function isBlockScalarIndicator(trailing: string): boolean {
  return /^[|>][+\-0-9]*$/.test(trailing.trim());
}

/** Read a block/folded scalar value that begins after a `key:` line: gather every subsequent
 *  more-indented (than `keyIndent`) non-blank line and FOLD them into a single space-joined
 *  scalar. This lets `permissions: >` / `uses: >` continuation lines be classified rather than
 *  silently skipped (a fold that could hide a `write-all` or a reusable-workflow target). */
function readBlockScalarValue(lines: readonly string[], keyLineIndex: number, keyIndent: number): string {
  const parts: string[] = [];
  for (let j = keyLineIndex + 1; j < lines.length; j++) {
    if (lines[j]!.trim().length === 0) continue;
    if (indentOf(lines[j]!) <= keyIndent) break;
    parts.push(lines[j]!.trim());
  }
  return parts.join(' ');
}

/** Read a possibly MULTILINE inline flow mapping `{ … }` that begins at `keyLineIndex` with
 *  `firstTrailing` (the text after the key's colon, starting with `{`). Gathers continuation
 *  lines until the braces balance and returns EXACTLY the balanced `{ … }` substring (trailing
 *  text after the matching `}` — e.g. the outer flow-map's closers — is dropped), so a flow map
 *  split across lines (`permissions: {\n  contents: write\n}`) or nested inside an outer flow map
 *  is classified rather than read as an empty `{` or over-run into the outer braces. */
function readFlowMapping(lines: readonly string[], keyLineIndex: number, firstTrailing: string): string {
  // Extract the balanced `{ … }` substring from a text, or null if it does not yet balance.
  const balancedSlice = (s: string): string | null => {
    let d = 0;
    const start = s.indexOf('{');
    if (start < 0) return null;
    for (let i = start; i < s.length; i++) {
      if (s[i] === '{') d++;
      else if (s[i] === '}') { d--; if (d === 0) return s.slice(start, i + 1); }
    }
    return null;
  };
  const first = balancedSlice(firstTrailing);
  if (first !== null) return first;
  let joined = firstTrailing;
  for (let j = keyLineIndex + 1; j < lines.length; j++) {
    if (lines[j]!.trim().length === 0) continue;
    joined += ' ' + lines[j]!.trim();
    const done = balancedSlice(joined);
    if (done !== null) return done;
  }
  return joined;
}

/** Resolve the enclosing job's `environment:` NAME for a `permissions:` block at `permIndex`
 *  (indent `baseIndent`), or `null` when the grant is workflow-level (in no job) or the job
 *  declares no readable environment name. The name is read from the scalar form
 *  (`environment: release`) or a block `environment:`/`name:` sub-key. A WORKFLOW-LEVEL grant is
 *  never environment-gated. The caller decides whether the returned name is KNOWN-PROTECTED. */
function jobEnvironmentName(
  lines: readonly string[],
  jobs: readonly JobBlock[],
  permIndex: number,
  baseIndent: number,
): string | null {
  const job = jobs.find((j) => j.start < permIndex && permIndex < j.end);
  if (!job) return null; // workflow-level (or not inside a job) => ungated
  for (let i = job.start + 1; i < job.end; i++) {
    const kv = matchKeyLine(lines[i]!);
    if (!kv || kv.key !== 'environment' || kv.indent !== baseIndent) continue;
    if (kv.trailing.length > 0) return unquote(kv.trailing); // scalar form
    // Block form: find the `name:` sub-key (more indented than `environment:`).
    for (let j = i + 1; j < job.end; j++) {
      if (lines[j]!.trim().length === 0) continue;
      if (indentOf(lines[j]!) <= kv.indent) break;
      const nkv = matchKeyLine(lines[j]!);
      if (nkv && nkv.key === 'name' && nkv.trailing.length > 0) return unquote(nkv.trailing);
    }
    return null; // an environment block with no readable name is not provably protected
  }
  return null;
}

interface JobBlock {
  /** Line index of the job key (e.g. `  build:`). */
  readonly start: number;
  /** Exclusive line index where this job's block ends (a sibling job or a dedent). */
  readonly end: number;
  /** Indentation of the job KEY (its direct children are more-indented). */
  readonly keyIndent: number;
}

/** Compute the `jobs:` child blocks (each `<job>:` key and the line span it owns). Used to bind a
 *  `permissions:` grant to its enclosing job so environment-gating can be checked per job. */
function computeJobBlocks(lines: readonly string[]): JobBlock[] {
  const jobs: JobBlock[] = [];
  let jobsIndent = -1;
  let jobsLine = -1;
  for (let i = 0; i < lines.length; i++) {
    const kv = matchKeyLine(lines[i]!);
    if (kv && kv.key === 'jobs' && kv.trailing.length === 0) { jobsIndent = kv.indent; jobsLine = i; break; }
  }
  if (jobsLine < 0) return jobs;
  // The job-KEY indent is that of the first non-blank key line under `jobs:`.
  let jobKeyIndent = -1;
  for (let i = jobsLine + 1; i < lines.length; i++) {
    if (lines[i]!.trim().length === 0) continue;
    const ind = indentOf(lines[i]!);
    if (ind <= jobsIndent) break; // jobs section is empty
    if (matchKeyLine(lines[i]!)) { jobKeyIndent = ind; break; }
  }
  if (jobKeyIndent < 0) return jobs;
  const starts: number[] = [];
  for (let i = jobsLine + 1; i < lines.length; i++) {
    if (lines[i]!.trim().length === 0) continue;
    const ind = indentOf(lines[i]!);
    if (ind <= jobsIndent) break; // end of the jobs section
    if (ind === jobKeyIndent && matchKeyLine(lines[i]!)) starts.push(i);
  }
  for (const start of starts) {
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
      if (lines[i]!.trim().length === 0) continue;
      if (indentOf(lines[i]!) <= jobKeyIndent) { end = i; break; } // sibling job or dedent
    }
    jobs.push({ start, end, keyIndent: jobKeyIndent });
  }
  return jobs;
}

/** Find every FLOW-CONTEXT `key:` occurrence on a line — a mapping key that sits inside a `{ … }`
 *  flow mapping (its preceding significant char is `{` or `,`). The key may be BARE, single-, or
 *  double-quoted (double-quoted keys are escape-DECODED so `"permission\u0073"` reads as
 *  `permissions`). Returns each decoded lower-cased key with the index just past its colon, so a
 *  caller can classify the following flow value. This complements {@link matchKeyLine}, which only
 *  sees a key that is the line's LEADING token (block form). */
function flowContextKeys(line: string): Array<{ key: string; valueStart: number }> {
  const out: Array<{ key: string; valueStart: number }> = [];
  const re = /(?:"((?:\\.|[^"\\])*)"|'((?:[^']|'')*)'|([A-Za-z0-9_.-]+))\s*:/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    // FLOW CONTEXT only: the char before the key token (skipping whitespace AND any TAG/ANCHOR node
    // properties) is `{` or `,` (an ordinary flow key) or `?` (a FLOW EXPLICIT key
    // `{ ? permissions : write-all }`, pass 50 finding #2). A tagged/anchored flow key such as
    // `{ ? !!str permissions : write-all }` or `{ &pk permissions: write-all }` is recognized by
    // skipping the preceding `!…`/`&…` property tokens (pass 51 finding #2) rather than missing it.
    let k = m.index - 1;
    while (k >= 0 && /\s/.test(line[k]!)) k--;
    for (;;) {
      if (k < 0) break;
      const c = line[k]!;
      if (c === '{' || c === ',' || c === '?') break; // structural flow-key predecessor
      let ts = k;
      while (ts >= 0 && !/[\s{,?]/.test(line[ts]!)) ts--;
      const token = line.slice(ts + 1, k + 1);
      if (token.length > 0 && (token[0] === '!' || token[0] === '&')) {
        k = ts;
        while (k >= 0 && /\s/.test(line[k]!)) k--;
        continue; // consumed a node property; keep looking for the structural predecessor
      }
      break; // a non-property token precedes the key → not a flow key
    }
    if (k < 0 || (line[k] !== '{' && line[k] !== ',' && line[k] !== '?')) continue;
    let key: string;
    if (m[1] !== undefined) key = decodeDoubleQuotedEscapes(m[1]);
    else if (m[2] !== undefined) key = m[2].replace(/''/g, "'");
    else key = m[3] ?? '';
    out.push({ key: key.toLowerCase(), valueStart: m.index + m[0].length });
  }
  return out;
}

/** Detect a `permissions:` grant expressed in FLOW form (inside a `{ … }` flow mapping, e.g. a
 *  flow-form `jobs: { publish: { permissions: { contents: write } } }` or an inline
 *  `permissions: write-all` nested in a flow map). The line-oriented block scan cannot see these
 *  because `permissions:` is not the line's leading key. Because flow-form gating cannot be bound
 *  to a protected environment by the block scanner, ANY write found here is treated as UNGATED
 *  (fail closed). Returns the write-all flag, the un-gated content-writes, and an unresolved-alias
 *  flag. A double-quoted ESCAPED `permissions` key is decoded via {@link flowContextKeys}, so
 *  `{ "permission\u0073": write-all }` is not missed. */
/** Read a flow SCALAR value that begins at `firstRest` (the text after a flow-context `key:`),
 *  gathering CONTINUATION LINES until the top-level flow terminator (`,`/`}`), so a multiline flow
 *  permissions value (`{ permissions:\n  write-all }`) whose scalar sits on a later line is captured
 *  rather than read as empty (pass 53 finding #2). Quote/brace-aware via {@link flowScalarTerminator}. */
function readFlowScalarMultiline(lines: readonly string[], keyLineIndex: number, firstRest: string): string {
  let acc = firstRest;
  let term = flowScalarTerminator(acc);
  if (term >= 0) return acc.slice(0, term).trim();
  for (let j = keyLineIndex + 1; j < lines.length; j++) {
    if (lines[j]!.trim().length === 0) continue;
    acc += ' ' + lines[j]!.trim();
    term = flowScalarTerminator(acc);
    if (term >= 0) return acc.slice(0, term).trim();
  }
  return acc.trim();
}

function scanFlowFormPermissions(lines: readonly string[], anchors: AnchorTable): PermissionValue {
  const res: PermissionValue = { broadWrite: false, contentWrites: [], unresolved: false };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    for (const { key, valueStart } of flowContextKeys(line)) {
      if (key !== 'permissions') continue;
      // Gather the value: a flow map `{ … }` (possibly multi-line) or a scalar up to the next
      // top-level flow terminator (`,`/`}`) — gathering CONTINUATION lines so a multiline flow
      // scalar value is not read as empty (pass 53 finding #2).
      const rest = line.slice(valueStart).replace(/^\s+/, '');
      // A tag/anchor node property may precede the value inside the flow (`permissions: !!str
      // write-all`); classifyPermissionValue strips it. Decide the map-vs-scalar branch on the
      // value AFTER any node properties.
      const afterProps = stripNodeProperties(rest);
      let value: string;
      if (afterProps.startsWith('{')) {
        value = readFlowMapping(lines, i, afterProps);
      } else {
        value = readFlowScalarMultiline(lines, i, rest);
      }
      const v = classifyPermissionValue(value, anchors, i);
      res.broadWrite = res.broadWrite || v.broadWrite;
      res.unresolved = res.unresolved || v.unresolved;
      res.contentWrites.push(...v.contentWrites);
    }
  }
  return res;
}

/** Detect a reusable-workflow `uses:` expressed in FLOW form (inside a `{ … }` flow mapping, e.g.
 *  `jobs: { call: { uses: ./.github/workflows/x.yml } }`). The line-oriented `uses:` scan only
 *  sees a `uses` that is the line's LEADING token, so a flow-form reusable workflow would evade it.
 *  Returns each resolved reusable-workflow target string (a value naming a `.yml`/`.yaml` file) and
 *  each unresolvable-alias marker (`*name`) for fail-closed reporting. A double-quoted ESCAPED
 *  `uses` key is decoded via {@link flowContextKeys}. */
function scanFlowFormUses(lines: readonly string[], anchors: AnchorTable): { targets: string[]; unresolvedAliases: string[] } {
  const targets: string[] = [];
  const unresolvedAliases: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    for (const { key, valueStart } of flowContextKeys(line)) {
      if (key !== 'uses') continue;
      const rest = line.slice(valueStart).replace(/^\s+/, '');
      // The flow value runs up to the next top-level `,` or `}` (a reusable-workflow value is a
      // scalar, never a nested map) — quote-aware so a `uses: "a,b.yml"` is not truncated at an
      // in-string comma (pass 47 finding #2).
      const term = flowScalarTerminator(rest);
      const raw = (term < 0 ? rest : rest.slice(0, term)).trim();
      if (raw.length === 0) continue;
      let target = unquote(stripNodeProperties(raw));
      const aliasMatch = /^\*([A-Za-z0-9_-]+)$/.exec(target);
      if (aliasMatch) {
        const resolved = anchors.resolve(aliasMatch[1]!, i);
        if (resolved === undefined) { unresolvedAliases.push(aliasMatch[1]!); continue; }
        target = unquote(stripNodeProperties(resolved));
      }
      if (/\.ya?ml(@\S+)?$/.test(target)) targets.push(target);
    }
  }
  return { targets, unresolvedAliases };
}

/** Scan the RESOLVED value of a merged anchor (a serialized `{ … }` flow mapping) for a
 *  `permissions` grant and a reusable-workflow `uses:` target, accumulating into `perm`/`targets`.
 *  Used by {@link scanMergeKeys} — a YAML merge key `<<: *anchor` splices the anchor's mapping into
 *  the current node, so a `permissions: write-all` (or a `uses:`) carried by the merged anchor is a
 *  real grant that the key-line scans (which never see the merged keys textually) would miss. */
function scanMergedMapping(
  value: string,
  anchors: AnchorTable,
  atLine: number,
  perm: PermissionValue,
  targets: string[],
): void {
  for (const { key, valueStart } of flowContextKeys(value)) {
    const rest = value.slice(valueStart).replace(/^\s+/, '');
    if (key === 'permissions') {
      let v: string;
      if (rest.startsWith('{')) v = readFlowMapping([value], 0, rest);
      else { const t = flowScalarTerminator(rest); v = (t < 0 ? rest : rest.slice(0, t)).trim(); }
      const pv = classifyPermissionValue(v, anchors, atLine);
      perm.broadWrite = perm.broadWrite || pv.broadWrite;
      perm.unresolved = perm.unresolved || pv.unresolved;
      perm.contentWrites.push(...pv.contentWrites);
    } else if (key === 'uses') {
      const t = flowScalarTerminator(rest);
      const raw = (t < 0 ? rest : rest.slice(0, t)).trim();
      let target = unquote(stripNodeProperties(raw));
      const am = /^\*([A-Za-z0-9_-]+)$/.exec(target);
      if (am) {
        const r = anchors.resolve(am[1]!, atLine);
        if (r === undefined) { perm.unresolved = true; continue; }
        target = unquote(stripNodeProperties(r));
      }
      if (/\.ya?ml(@\S+)?$/.test(target)) targets.push(target);
    }
  }
}

/** Detect YAML MERGE KEYS (`<<: *anchor` or `<<: [*a, *b]`) that splice an anchor's mapping into a
 *  node. If the merged anchor carries a `permissions:` grant or a reusable-workflow `uses:`, that
 *  authority is REAL but invisible to the key-line scans (the merged keys never appear textually at
 *  the node). Because merge-form gating cannot be bound to a protected environment by the block
 *  scanner, any write found here is treated as UNGATED (fail closed). An UNRESOLVABLE merge alias
 *  fails closed via `perm.unresolved` (pass 46 finding #2). */
function scanMergeKeys(lines: readonly string[], anchors: AnchorTable): { perm: PermissionValue; targets: string[] } {
  const perm: PermissionValue = { broadWrite: false, contentWrites: [], unresolved: false };
  const targets: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*(?:-\s*)?<<\s*:\s*(.*)$/.exec(lines[i]!);
    if (!m) continue;
    const rhs = m[1]!.trim();
    const aliasNames: string[] = [];
    const re = /\*([A-Za-z0-9_-]+)/g;
    let a: RegExpExecArray | null;
    while ((a = re.exec(rhs)) !== null) aliasNames.push(a[1]!);
    if (aliasNames.length === 0) continue;
    for (const name of aliasNames) {
      const resolved = anchors.resolve(name, i);
      if (resolved === undefined) { perm.unresolved = true; continue; }
      scanMergedMapping(resolved, anchors, i, perm, targets);
    }
  }
  return { perm, targets };
}

/**
 * Detect ADVANCED YAML node constructs in the permissions / reusable-`uses:` surface that the
 * indentation scanner does NOT fully model, so the audit FAILS CLOSED (emits a finding) instead of
 * silently PASSING a grant it cannot interpret (pass 52 finding #2). This module intentionally
 * carries no YAML-library dependency, so rather than resolve these exotic node forms it rejects
 * them. Covers the specific vectors an adversarial workflow could use to HIDE a `permissions`/`uses`
 * grant from the scanner:
 *   - an ALIAS used as a mapping KEY (`*a:` block form, or `? *a` explicit key) — the scanner keys
 *     on literal names, so an alias-derived `permissions`/`uses` key is invisible;
 *   - a MERGE key whose value is a SEQUENCE (`<<: [*a, *b]` flow, or a block sequence of aliases) —
 *     the single-alias merge resolver ({@link scanMergeKeys}) does not splice a SEQUENCE of maps;
 *   - a NODE TAG that introduces a NON-SCALAR/CUSTOM value for a `permissions`/`uses` key
 *     (`permissions: !!map …`, `uses: !inline …`) — {@link stripYamlTag} only unwraps a scalar
 *     tag, so a tagged nested collection would be misread; a plain scalar tag (`!!str`/…) is still
 *     handled and is NOT rejected here;
 *   - a FLOW SEQUENCE value for a `permissions`/`uses` key (`permissions: [ … ]`) — the flow reader
 *     ({@link readFlowMapping}) only models a `{ … }` map, so a `[ … ]` (possibly multi-line) value
 *     is not classifiable.
 * Operates on the SAME comment-stripped, explicit-key-NORMALIZED lines the scanner uses, so it sees
 * exactly what the scanner would (mis)read. Returns one human-readable reason per detected
 * construct.
 */
function detectUnsupportedYamlNodes(lines: readonly string[]): string[] {
  const reasons: string[] = [];
  const SCALAR_TAG = /^!!(?:str|int|bool|float|null|timestamp|binary)$/;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const t = line.trim();
    if (t.length === 0) continue;
    // (1) ALIAS AS KEY: `*alias :` (block) or `? *alias` (explicit key) — an alias-derived key.
    if (/^\*[A-Za-z0-9_-]+\s*:/.test(t) || /^\?\s*\*[A-Za-z0-9_-]+/.test(t)) {
      reasons.push(`a YAML alias is used as a mapping key ('${t.slice(0, 30)}') — an alias-derived key cannot be resolved by the static scanner`);
      continue;
    }
    // (2) MERGE SEQUENCE: `<<:` whose value is a flow sequence `[ … ]` or a following block sequence.
    const mergeM = /^(?:"<<"|'<<'|<<)\s*:\s*(.*)$/.exec(t);
    if (mergeM) {
      const val = mergeM[1]!.trim();
      if (val.startsWith('[')) {
        reasons.push(`a YAML merge key '<<:' splices a SEQUENCE of aliases (${val.slice(0, 30)}) — a multi-mapping merge the scanner does not resolve`);
      } else if (val.length === 0) {
        const keyIndent = indentOf(line);
        for (let j = i + 1; j < lines.length; j++) {
          if (lines[j]!.trim().length === 0) continue;
          if (indentOf(lines[j]!) <= keyIndent) break;
          if (/^-\s/.test(lines[j]!.trim())) {
            reasons.push(`a YAML merge key '<<:' splices a block SEQUENCE of aliases — a multi-mapping merge the scanner does not resolve`);
          }
          break;
        }
      }
      continue;
    }
    // (3) A `permissions`/`uses` value carrying a NON-SCALAR/CUSTOM TAG, or a FLOW SEQUENCE value.
    const kv = matchKeyLine(line);
    if (kv && (kv.key === 'permissions' || kv.key === 'uses')) {
      const trailing = kv.trailing.trim();
      const tagM = /^(?:!<[^>]*>|!\S+)/.exec(trailing);
      if (tagM && !SCALAR_TAG.test(tagM[0]!)) {
        reasons.push(`the '${kv.key}' value carries a non-scalar/custom YAML tag ('${tagM[0]}') — its structured value cannot be classified by the scanner`);
      } else if (trailing.startsWith('[')) {
        reasons.push(`the '${kv.key}' value is a flow SEQUENCE ('${trailing.slice(0, 30)}') — a sequence value is not modeled by the scanner`);
      }
    }
  }
  return reasons;
}

/**
 * Audit a set of workflow files. Returns hard `findings` (each fails the audit) and
 * informational `notes` (allowlisted narrow content-write grants).
 */
export function auditWorkflowPermissions(
  workflows: readonly WorkflowInput[],
  options: AuditWorkflowPermissionsOptions = {},
): AuditWorkflowPermissionsResult {
  const allow = new Set(options.allowlistedWriteWorkflows ?? []);
  const protectedEnvs = new Set(options.protectedEnvironments ?? []);
  const findings: string[] = [];
  const notes: string[] = [];

  for (const wf of workflows) {
    // Normalize YAML EXPLICIT-KEY blocks (`? key` on one line, `: value` on the next) into the
    // ordinary `key: value` form BEFORE any scan, so an explicit-key `permissions`/`uses`/scope
    // grant is not hidden from the line-oriented scanners (pass 48 finding #2).
    const lines = normalizeExplicitKeys(wf.content.split(/\r?\n/).map(stripLineComment));
    const anchors = collectAnchors(lines);
    const jobs = computeJobBlocks(lines);
    // FAIL CLOSED on ADVANCED YAML node constructs the scanner cannot model (alias-derived keys,
    // merge SEQUENCES, non-scalar/custom tags or flow-sequence values on a permissions/uses key) —
    // rather than silently pass a grant it could hide (pass 52 finding #2).
    for (const reason of new Set(detectUnsupportedYamlNodes(lines))) {
      findings.push(`${wf.name}: ${reason} — fail closed. Rewrite it in the plain block \`key: value\` / \`{ scope: level }\` form the audit can verify.`);
    }
    // Each content-write records whether its granting job is gated by a KNOWN-PROTECTED
    // environment, so an allowlisted narrow write is only downgraded to a NOTE when it is
    // actually gated (an arbitrary/unknown environment name does NOT count as protected).
    const gatedWrites: string[] = [];
    const ungatedWrites: string[] = [];
    let broadWrite = false;
    let unresolvedAlias = false;

    for (let i = 0; i < lines.length; i++) {
      const kv = matchKeyLine(lines[i]!);
      if (!kv || kv.key !== 'permissions') continue;
      const baseIndent = kv.indent;
      const envName = jobEnvironmentName(lines, jobs, i, baseIndent);
      const gated = envName !== null && protectedEnvs.has(envName);
      const localWrites: string[] = [];

      if (kv.trailing.length > 0) {
        // Scalar/inline value — possibly a BLOCK/FOLDED scalar (`permissions: >` continuation)
        // or a MULTILINE flow mapping (`permissions: {` spanning lines) that would otherwise
        // hide the real grant. Fold/gather it before classifying.
        let value: string;
        if (isBlockScalarIndicator(kv.trailing)) value = readBlockScalarValue(lines, i, baseIndent);
        else if (kv.trailing.startsWith('{')) value = readFlowMapping(lines, i, kv.trailing);
        else if (startsUnterminatedQuote(kv.trailing)) value = readMultilineQuotedScalar(lines, i, kv.trailing);
        else value = kv.trailing;
        const v = classifyPermissionValue(value, anchors, i);
        broadWrite = broadWrite || v.broadWrite;
        unresolvedAlias = unresolvedAlias || v.unresolved;
        localWrites.push(...v.contentWrites);
      } else {
        // Block form. First, an INDENTED PLAIN SCALAR value — `permissions:` on its own line with
        // the value on the next MORE-indented line (`permissions:\n  write-all`) — is NOT a
        // `scope: level` mapping; classify it as the permissions scalar value (pass 50 finding #2).
        let firstChildIdx = -1;
        for (let j = i + 1; j < lines.length; j++) {
          if (lines[j]!.trim().length === 0) continue;
          if (indentOf(lines[j]!) <= baseIndent) break;
          firstChildIdx = j;
          break;
        }
        const firstChild = firstChildIdx >= 0 ? lines[firstChildIdx]! : '';
        const firstChildIsScalar = firstChildIdx >= 0 && matchKeyLine(firstChild) === null;
        if (firstChildIsScalar) {
          let value = firstChild.trim();
          if (startsUnterminatedQuote(value)) value = readMultilineQuotedScalar(lines, firstChildIdx, value);
          const v = classifyPermissionValue(value, anchors, firstChildIdx);
          broadWrite = broadWrite || v.broadWrite;
          unresolvedAlias = unresolvedAlias || v.unresolved;
          localWrites.push(...v.contentWrites);
        }
        // Block form: subsequent MORE-indented `scope: level` lines (keys may be quoted).
        for (let j = i + 1; j < lines.length; j++) {
          const bl = lines[j]!;
          if (bl.trim().length === 0) continue;
          if (indentOf(bl) <= baseIndent) break;
          const skv = matchKeyLine(bl);
          if (!skv) continue;
          // The scope's LEVEL value may be a block/folded scalar, a MULTILINE quoted scalar, a
          // YAML tag, an anchor/alias, or an INDENTED PLAIN SCALAR on the next line
          // (`contents:\n    write`, pass 50 finding #2).
          let level = skv.trailing;
          if (isBlockScalarIndicator(level)) level = readBlockScalarValue(lines, j, indentOf(bl));
          else if (startsUnterminatedQuote(level)) level = readMultilineQuotedScalar(lines, j, level);
          else if (level.length === 0) {
            // Indented plain scalar level: the next more-indented non-blank line, if it is not a
            // nested mapping key.
            for (let k = j + 1; k < lines.length; k++) {
              if (lines[k]!.trim().length === 0) continue;
              if (indentOf(lines[k]!) <= indentOf(bl)) break;
              if (matchKeyLine(lines[k]!) === null) level = lines[k]!.trim();
              break;
            }
          }
          level = stripNodeProperties(level);
          const alias = /^\*([A-Za-z0-9_-]+)$/.exec(level);
          if (alias) {
            const resolved = anchors.resolve(alias[1]!, j);
            if (resolved === undefined) { unresolvedAlias = true; continue; }
            level = stripNodeProperties(resolved);
          }
          if (unquote(level).toLowerCase() === 'write' && CONTENT_WRITE_SCOPES.has(skv.key)) {
            localWrites.push(`${skv.key}: write`);
          }
        }
      }
      for (const w of localWrites) (gated ? gatedWrites : ungatedWrites).push(w);
    }

    // FLOW-FORM grants (flow-form jobs / inline permissions maps) the line-oriented block scan
    // cannot see. These are treated as UNGATED (fail closed) — flow-form gating is not verifiable.
    const flow = scanFlowFormPermissions(lines, anchors);
    broadWrite = broadWrite || flow.broadWrite;
    unresolvedAlias = unresolvedAlias || flow.unresolved;
    ungatedWrites.push(...flow.contentWrites);
    // MERGE-KEY grants (`<<: *anchor`) that splice a `permissions:` grant or a reusable-workflow
    // `uses:` from an anchor into a node — invisible to the key-line scans (fail closed / ungated).
    const merged = scanMergeKeys(lines, anchors);
    broadWrite = broadWrite || merged.perm.broadWrite;
    unresolvedAlias = unresolvedAlias || merged.perm.unresolved;
    ungatedWrites.push(...merged.perm.contentWrites);
    // BROAD write-all (or an unresolvable alias) is ALWAYS a finding — allowlisting cannot
    // bless an unverified blanket write.
    if (broadWrite) {
      findings.push(`${wf.name}: grants write-all to the workflow token — a broad, un-gated release-authority write vector. Remove it (allowlisting does not cover write-all).`);
    }
    if (unresolvedAlias) {
      findings.push(`${wf.name}: a permissions value uses an UNRESOLVABLE YAML alias (*anchor) — its effective grant cannot be verified read-only (fail closed).`);
    }
    // UNGATED narrow content-writes (workflow-level, a job with no environment, or a job whose
    // environment name is NOT in the protected set) are ALWAYS a finding — even for an allowlisted
    // workflow. Allowlisting only covers a narrow write whose job is gated by a KNOWN-PROTECTED
    // environment (verified elsewhere).
    if (ungatedWrites.length > 0) {
      const uniq = [...new Set(ungatedWrites)].join(', ');
      findings.push(`${wf.name}: grants ${uniq} to the workflow token in a job with NO known-protected environment (or at the workflow level) — an un-gated release-authority write vector. Restrict it to read, or move it to a job gated by a protected environment.`);
    }
    // GATED narrow content-writes: a NOTE for allowlisted workflows, a finding otherwise.
    if (gatedWrites.length > 0) {
      const uniq = [...new Set(gatedWrites)].join(', ');
      if (allow.has(wf.name)) {
        notes.push(`${wf.name}: grants ${uniq} in an environment-gated job (allowlisted — its narrow content-write authority is gated by protected environments + the release identity and verified elsewhere).`);
      } else {
        findings.push(`${wf.name}: grants ${uniq} to the workflow token — an un-gated release-authority write vector. Restrict it to read, or gate + allowlist it.`);
      }
    }

    // Reusable-workflow invocations: a `uses:` (key may be quoted; value may be quoted, folded,
    // or an ALIAS resolved against anchors) whose value names a `.yml`/`.yaml` reusable workflow
    // (an action `uses:` references a repo/dir, never a `.yml` file). Such a call runs with
    // delegated authority the default-token audit cannot inspect, so it is ALWAYS a finding.
    for (let i = 0; i < lines.length; i++) {
      // Match a `uses:` key line — allowing an OPTIONAL leading list marker `- ` and a QUOTED or
      // ESCAPED key (`"use\u0073"`) by decoding via matchKeyLine on the marker-stripped line.
      const rawLine = lines[i]!;
      const markerM = /^(\s*)-\s+(\S.*)$/.exec(rawLine);
      const keyLineText = markerM ? markerM[1]! + markerM[2]! : rawLine;
      const kv = matchKeyLine(keyLineText);
      if (!kv || kv.key !== 'uses') continue;
      let value = kv.trailing;
      if (isBlockScalarIndicator(value)) value = readBlockScalarValue(lines, i, indentOf(lines[i]!));
      else if (startsUnterminatedQuote(value)) value = readMultilineQuotedScalar(lines, i, value);
      if (value.length === 0) continue;
      let target = unquote(stripNodeProperties(value));
      // Resolve a `*alias` reusable-workflow target against anchor definitions; an unresolvable
      // alias fails closed (a reusable target that cannot be verified is treated as a finding).
      const aliasMatch = /^\*([A-Za-z0-9_-]+)$/.exec(target);
      if (aliasMatch) {
        const resolved = anchors.resolve(aliasMatch[1]!, i);
        if (resolved === undefined) {
          findings.push(`${wf.name}: a uses: value references an UNRESOLVABLE YAML alias (*${aliasMatch[1]}) — its reusable-workflow target cannot be verified (fail closed).`);
          continue;
        }
        target = unquote(stripNodeProperties(resolved));
      }
      if (/\.ya?ml(@\S+)?$/.test(target)) {
        findings.push(`${wf.name}: calls reusable workflow '${target}' (uses:) — its delegated permissions are not covered by the default-token audit. Inline it or independently verify its authority.`);
      }
    }

    // FLOW-FORM reusable workflows (a `uses:` inside a `{ … }` flow mapping) the line-oriented
    // scan cannot see — e.g. `jobs: { call: { uses: ./.github/workflows/x.yml } }`.
    const flowUses = scanFlowFormUses(lines, anchors);
    for (const target of flowUses.targets) {
      findings.push(`${wf.name}: calls reusable workflow '${target}' (uses:) — its delegated permissions are not covered by the default-token audit. Inline it or independently verify its authority.`);
    }
    for (const alias of flowUses.unresolvedAliases) {
      findings.push(`${wf.name}: a uses: value references an UNRESOLVABLE YAML alias (*${alias}) — its reusable-workflow target cannot be verified (fail closed).`);
    }
    // MERGE-KEY reusable workflows (a `uses:` spliced in via `<<: *anchor`).
    for (const target of merged.targets) {
      findings.push(`${wf.name}: calls reusable workflow '${target}' (uses: via a YAML merge key) — its delegated permissions are not covered by the default-token audit. Inline it or independently verify its authority.`);
    }
  }

  return { findings, notes };
}
