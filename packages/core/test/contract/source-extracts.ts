// Parsers for the committed reviewed source extracts under
// `packages/core/fixtures/source-extracts/`. These extracts are the single
// reviewed authority the contract constants and the wire fixtures are
// authenticated against (see fixtures/source-extracts/README.md). This module is
// a helper only (excluded by the *.test.ts glob); it does not import contract.ts
// so it cannot smuggle the very constants it is used to authenticate.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const FIXTURES_DIR = join(import.meta.dirname, '..', '..', 'fixtures');

/** Reads a committed source extract by its fixtures-relative path (from the manifest). */
export function readExtract(relPath: string): string {
  return readFileSync(join(FIXTURES_DIR, relPath), 'utf8');
}

/** Line-ending-normalized hash matching the generator's `extractSha256`. */
export function extractSha256(rawText: string): string {
  return createHash('sha256').update(rawText.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// C#/Unicode identifier-aware token boundaries. A C# identifier part is a Unicode
// letter (Lu/Ll/Lt/Lm/Lo) or letter-number (Nl), a connector punctuation (Pc, incl.
// `_`), a combining mark (Mn/Mc), a decimal digit (Nd), or a format char (Cf); a
// leading `@` marks a verbatim identifier. ASCII-only boundaries like
// `(?<![A-Za-z0-9_])` let a Unicode-containing identifier (e.g. `wríter`) sit flush
// against an expected token and impersonate it, because the Unicode char is not in the
// ASCII class. These class fragments (used with the required `u` flag) close that gap.
// ---------------------------------------------------------------------------
/** C# identifier-part characters, as a character-class body fragment (needs `u`).
 *  Includes format chars (Cf) — a C# identifier-part per the language spec — so a
 *  zero-width format char (e.g. U+200B/U+200D/U+00AD) adjacent to a token cannot spoof
 *  or truncate a reference past an ASCII-only boundary. */
const CS_ID_PART = '\\p{L}\\p{Nl}\\p{Mn}\\p{Mc}\\p{Nd}\\p{Pc}\\p{Cf}';
/** Negative lookbehind: the preceding char is NOT part of a C# identifier, a member-
 *  access `.`, or a verbatim `@` prefix. Every regex using it MUST set the `u` flag. */
const NB_BEFORE = `(?<![${CS_ID_PART}.@])`;
/** Negative lookahead: the following char is NOT part of a C# identifier. Needs `u`. */
const NB_AFTER = `(?![${CS_ID_PART}])`;
/** Negative lookahead: not a C# identifier char AND not a `(` (so a method call is not
 *  read as a bare receiver identifier). Needs `u`. */
const NB_AFTER_NOCALL = `(?![${CS_ID_PART}(])`;

// ---------------------------------------------------------------------------
// The COMPLETE C# line-terminator set (spec §Line terminators): CR (U+000D), LF
// (U+000A), NEL (U+0085), LS (U+2028), PS (U+2029). JavaScript's own `^`/`$` multiline
// anchors recognize only LF/CR/LS/PS — NOT NEL — so directive/line detection must use
// THIS set, or a `#if` immediately after a U+0085 newline would evade detection.
// ---------------------------------------------------------------------------
const CS_NEWLINES = '\\n\\r\\u0085\\u2028\\u2029';
/** True iff `ch` is any C# line terminator (complete newline model). */
function isCSharpNewline(ch: string | undefined): boolean {
  return ch === '\n' || ch === '\r' || ch === '\u0085' || ch === '\u2028' || ch === '\u2029';
}

/**
 * True iff `ch` is C# WHITESPACE (spec §Whitespace): horizontal tab (U+0009), vertical tab
 * (U+000B), form feed (U+000C), OR any character in Unicode class Zs (which includes the
 * ordinary space U+0020, plus NBSP U+00A0, the U+2000–U+200A spaces, U+202F, U+205F,
 * U+3000, …). An ASCII-only whitespace test (`ch === ' ' || ch === '\t'`) would let a
 * Zs char (e.g. U+00A0) sit before a `#if` at line start and make the line look like it
 * does NOT start with a directive — evading conditional-compilation detection. Line
 * terminators are NOT whitespace here (they are handled separately as newlines).
 */
function isCSharpWhitespace(ch: string | undefined): boolean {
  if (ch === undefined) return false;
  if (ch === '\t' || ch === '\u000b' || ch === '\f') return true;
  return /\p{Zs}/u.test(ch);
}

/**
 * Decodes the BODY of a C# REGULAR string literal (the text between the quotes, already
 * captured with escaped quotes/backslashes respected) into its actual character value,
 * honoring C# simple escapes (`\'`, `\"`, `\\`, `\0`, `\a`, `\b`, `\f`, `\n`, `\r`, `\t`,
 * `\v`), `\xH{1,4}` hex, and `\uXXXX`/`\UXXXXXXXX` unicode escapes. FAILS CLOSED on a
 * malformed/unknown escape (an invalid escape is not valid C# and must not be silently
 * accepted), so a wire-name/enum-value extractor reads the TRUE decoded value and a
 * concatenation/escape trick cannot smuggle a different byte sequence past it.
 */
function decodeCSharpRegularString(body: string): string {
  let out = '';
  let i = 0;
  while (i < body.length) {
    const c = body[i]!;
    if (c !== '\\') { out += c; i++; continue; }
    const e = body[i + 1];
    switch (e) {
      case "'": out += "'"; i += 2; break;
      case '"': out += '"'; i += 2; break;
      case '\\': out += '\\'; i += 2; break;
      case '0': out += '\0'; i += 2; break;
      case 'a': out += '\x07'; i += 2; break;
      case 'b': out += '\b'; i += 2; break;
      case 'f': out += '\f'; i += 2; break;
      case 'n': out += '\n'; i += 2; break;
      case 'r': out += '\r'; i += 2; break;
      case 't': out += '\t'; i += 2; break;
      case 'v': out += '\v'; i += 2; break;
      case 'x': {
        // 1..4 hex digits (variable length).
        let j = i + 2;
        let hex = '';
        while (j < body.length && hex.length < 4 && /[0-9A-Fa-f]/.test(body[j]!)) { hex += body[j]!; j++; }
        if (hex.length === 0) throw new Error('decodeCSharpRegularString: malformed \\x escape (no hex digits)');
        out += String.fromCodePoint(parseInt(hex, 16));
        i = j;
        break;
      }
      case 'u': {
        const hex = body.slice(i + 2, i + 6);
        if (hex.length !== 4 || !/^[0-9A-Fa-f]{4}$/.test(hex)) throw new Error('decodeCSharpRegularString: malformed \\u escape');
        out += String.fromCodePoint(parseInt(hex, 16));
        i += 6;
        break;
      }
      case 'U': {
        const hex = body.slice(i + 2, i + 10);
        if (hex.length !== 8 || !/^[0-9A-Fa-f]{8}$/.test(hex)) throw new Error('decodeCSharpRegularString: malformed \\U escape');
        const cp = parseInt(hex, 16);
        if (cp > 0x10ffff) throw new Error('decodeCSharpRegularString: \\U code point out of range');
        out += String.fromCodePoint(cp);
        i += 10;
        break;
      }
      default:
        throw new Error(`decodeCSharpRegularString: unknown escape \\${e ?? '<eof>'}`);
    }
  }
  return out;
}

/**
 * All C# regular-string-literal DECODED values in a (comment-stripped, string-content-
 * preserved) span that IMMEDIATELY follow `prefixRe` (a source-anchored construct), each
 * paired with its match. The literal body is captured with escaped quotes/backslashes
 * respected — `"a\"b"` is ONE literal `a"b`, never truncated at the escaped quote — and
 * decoded via {@link decodeCSharpRegularString}. `prefixRe` MUST be a global-flagged regex
 * ending exactly at the opening `"` of the literal (i.e. its last token is `"`)... instead
 * we anchor by matching the whole `prefix"body"` in one pattern; callers pass a pattern
 * with the body group as the LAST group. Returns the decoded body of that group.
 */
function decodedStringLiteralsFollowing(src: string, pattern: RegExp): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  pattern.lastIndex = 0;
  while ((m = pattern.exec(src)) !== null) {
    out.push(decodeCSharpRegularString(m[m.length - 1]!));
  }
  return out;
}

// A C# regular-string-literal body: any run of escaped chars (`\` + any) or non-quote,
// non-backslash chars, so an escaped quote does not terminate the literal.
const CS_STRING_BODY = '((?:\\\\.|[^"\\\\])*)';

/**
 * Wire values of a generated Azure enum, in declaration order. Parses the
 * `private const string XxxValue = "Yyy";` lines autorest emits, whose string
 * literals are the exact wire values ARM serializes. Scans the SINGLE fail-closed
 * parsed representation (comments/directives blanked, string content preserved) so
 * a decoy value inside a comment is never matched.
 */
export function enumWireValues(extractText: string): string[] {
  const src = commentStrippedCSharp(extractText);
  // The literal body is captured escaped-quote-safe and DECODED, so an escaped quote can
  // never truncate a wire value and a `\uXXXX`/`\xH`/`\"` escape resolves to its true char.
  return decodedStringLiteralsFollowing(
    src,
    new RegExp(`private\\s+const\\s+string\\s+\\w+Value\\s*=\\s*"${CS_STRING_BODY}"\\s*;`, 'g'),
  );
}

/**
 * Serialized wire property names of a generated model, in serialization order.
 * Parses the `writer.WritePropertyName("name"u8)` calls autorest emits in the
 * model's `IUtf8JsonSerializable.Write` method — the authoritative wire names.
 * Scans the SINGLE fail-closed parsed representation so a `WritePropertyName("x")`
 * inside a comment/string is never mistaken for a real serialized field.
 */
export function serializedWireNames(extractText: string): string[] {
  const src = commentStrippedCSharp(extractText);
  // Escaped-quote-safe literal body, DECODED so an escaped quote/`\u` cannot hide or
  // corrupt a serialized wire name.
  return decodedStringLiteralsFollowing(
    src,
    new RegExp(`WritePropertyName\\("${CS_STRING_BODY}"(?:u8)?\\)`, 'g'),
  );
}

/**
 * The `Microsoft.Chaos/...` operation `name` strings in the generated GetOperations
 * verified snapshot. The snapshot is a JSON document, so it is PARSED as JSON (a
 * single fail-closed representation) and each operation's `name` read from the
 * parsed object — never scanned as raw text where a name in a description could be
 * mistaken for an operation.
 */
export function operationNames(extractText: string): string[] {
  return operationObjects(extractText).map((op) => op.name);
}

/** A single generated provider-operation object from the verified snapshot. */
export interface OperationObject {
  name: string;
  isDataAction: boolean;
  display: { provider: string; resource: string; operation: string; description: string };
}

/**
 * The COMPLETE generated provider-operation objects from the verified snapshot,
 * parsed as JSON (the snapshot is an ARM `{ "value": [ ... ] }` document). Returns
 * every operation's full object — name, isDataAction, and display metadata — so a
 * caller can authenticate the fixture as complete OBJECTS, not merely names.
 */
export function operationObjects(extractText: string): OperationObject[] {
  const parsed = JSON.parse(extractText) as { value?: unknown };
  if (!parsed || !Array.isArray(parsed.value)) {
    throw new Error('operations snapshot extract is not an ARM { value: [...] } document');
  }
  return parsed.value as OperationObject[];
}

/**
 * Fails CLOSED on C# syntax the lightweight lexer cannot safely model, so an
 * extract that introduces such syntax loudly forces a parser upgrade rather than
 * being silently mis-authenticated. Currently: conditional-compilation directives
 * (`#if`/`#elif`/`#else`/`#endif`) gate which code is active, and this lexer treats
 * all text as active — so they are rejected. (Non-conditional directives such as
 * `#nullable`, `#region`, `#pragma`, `#define` are safe and are blanked instead.)
 */
export function assertLexableCSharp(src: string): void {
  // Delegate to the SINGLE stateful scanner: it recognizes a conditional-compilation
  // directive ONLY when the `#` is at a true line start OUTSIDE any comment/string
  // (tracked state), with COMPLETE C# whitespace (incl. Unicode Zs) as leading
  // whitespace and the COMPLETE newline model. This avoids (a) a Zs char bypassing
  // detection and (b) a raw-text false-failure on a `#if` that appears inside a
  // comment/string. `scanCSharp` throws on a conditional directive; run it and discard.
  scanCSharp(src, /* blankStrings */ true);
}

/**
 * Single fail-closed C# scanner shared by EVERY extractor. It scans the source
 * once, always blanking comment and preprocessor-directive CONTENT (length/newlines
 * preserved), and — depending on `blankStrings` — either blanks string/char literal
 * CONTENT too (for structural parsing that must not see tokens/braces inside
 * literals) or PRESERVES literal content verbatim (for name extractors that must
 * read the literal values). Either way it fails CLOSED identically: conditional
 * compilation (see {@link assertLexableCSharp}), any INTERPOLATED string
 * (`$"..."`, `$@"..."`, `@$"..."`, `$"""..."""`), and any UNTERMINATED comment or
 * literal all throw. This guarantees no extractor scans raw text or a
 * differently-parsed view.
 */
function scanCSharp(src: string, blankStrings: boolean): string {
  let out = '';
  let i = 0;
  const n = src.length;
  let lineStart = true; // only whitespace seen on the current line so far
  // C# line terminators (spec §Line terminators): CR, LF, NEL, LS, PS. A `//` comment,
  // a `#` directive, and a regular/char literal all END at ANY of these — so a CR-only
  // (classic-Mac) or NEL/LS/PS newline cannot let a comment swallow the code that
  // follows it (hiding real declarations) nor let a single-line literal run past a line
  // break undetected.
  const isNL = (ch: string | undefined): boolean =>
    ch === '\n' || ch === '\r' || ch === '\u0085' || ch === '\u2028' || ch === '\u2029';
  // Blank every non-newline char to a space (length preserved); ALL C# newline forms
  // are preserved so blanked spans keep their line structure and offsets stay aligned.
  const space = (s: string) => s.replace(/[^\n\r\u0085\u2028\u2029]/g, ' ');
  // Emit a literal spanning [i, end). When `forceBlank` is set (raw/verbatim
  // strings — the multi-line-capable literals that can hide decoy code), the body
  // is ALWAYS blanked even in name-extraction mode, so a `WritePropertyName("x")`
  // or `const string XValue = "y"` HIDDEN INSIDE a raw/verbatim string can never
  // spoof an extractor. Regular single-line strings honor `blankStrings` (their
  // content is preserved in extraction mode so real literal arguments are readable;
  // a single-line regular string cannot hold a multi-line decoy block).
  const emitLiteral = (end: number, openLen: number, closeLen: number, forceBlank = false): void => {
    if (!blankStrings && !forceBlank) { out += src.slice(i, end); return; }
    const openDelim = src.slice(i, i + openLen);
    const closeDelim = src.slice(end - closeLen, end);
    const middle = space(src.slice(i + openLen, end - closeLen));
    out += openDelim + middle + closeDelim;
  };
  while (i < n) {
    const c = src[i]!;
    const c2 = src[i + 1];
    // Preprocessor directive: at line start (only whitespace before it, OUTSIDE any
    // comment/string — guaranteed by reaching here with lineStart still true), blank the
    // rest of the line so its tokens are never parsed as code. FAIL CLOSED on a
    // CONDITIONAL directive (#if/#elif/#else/#endif) because this lexer treats all text as
    // active and cannot model which branch compiles. Detection is STATEFUL (only a real
    // line-start `#` outside comments/strings reaches here), so a `#if` inside a comment or
    // string never false-fails, and Unicode-Zs leading whitespace cannot bypass it.
    if (lineStart && c === '#') {
      let k = i + 1;
      while (k < n && isCSharpWhitespace(src[k])) k++; // spec allows whitespace after '#'
      let kw = '';
      while (k < n && /[A-Za-z]/.test(src[k]!)) { kw += src[k]!; k++; }
      if (kw === 'if' || kw === 'elif' || kw === 'else' || kw === 'endif') {
        throw new Error(
          'Unsupported C# syntax for structural authentication: conditional compilation (#if/#elif/#else/#endif). Use a real C# parser.',
        );
      }
      let j = i;
      while (j < n && !isNL(src[j])) j++;
      out += space(src.slice(i, j));
      i = j;
      continue;
    }
    // Line comment.
    if (c === '/' && c2 === '/') {
      let j = i + 2;
      while (j < n && !isNL(src[j])) j++;
      out += space(src.slice(i, j));
      i = j;
      lineStart = false;
      continue;
    }
    // Block comment.
    if (c === '/' && c2 === '*') {
      let j = i + 2;
      while (j < n && !(src[j] === '*' && src[j + 1] === '/')) j++;
      if (j >= n) throw new Error('Unterminated block comment in C# extract (unclosed /* ... */).');
      j = Math.min(n, j + 2);
      out += space(src.slice(i, j));
      i = j;
      lineStart = false;
      continue;
    }
    // Raw string literal: a run of >= 3 double-quotes opens it; the same-length
    // run closes it. A `$` prefix makes it an INTERPOLATED raw string — reject it.
    const rawStart = matchRawStringOpen(src, i);
    if (rawStart) {
      const { quoteRun, prefixLen } = rawStart;
      if (src.slice(i, i + prefixLen).includes('$')) {
        throw new Error(
          'Unsupported C# syntax for structural authentication: interpolated raw string ($"""..."""). Use a real C# parser or remove interpolation.',
        );
      }
      const open = i + prefixLen;
      let j = open + quoteRun;
      let closed = false;
      while (j < n) {
        if (src[j] === '"' && runLength(src, j, '"') >= quoteRun) { closed = true; break; }
        j++;
      }
      if (!closed) throw new Error('Unterminated raw string literal in C# extract.');
      const end = j + quoteRun;
      // Opening delimiter = prefix + quote run; closing delimiter = quote run.
      // forceBlank: a raw string can span lines and hold unescaped decoy code, so
      // its body is never exposed to extractors.
      emitLiteral(end, prefixLen + quoteRun, quoteRun, /* forceBlank */ true);
      i = end;
      lineStart = false;
      continue;
    }
    // Interpolated verbatim ($@"..." / @$"...") carries `{ ... }` holes — reject.
    const isInterpolatedVerbatim =
      (c === '$' && c2 === '@' && src[i + 2] === '"') ||
      (c === '@' && c2 === '$' && src[i + 2] === '"');
    if (isInterpolatedVerbatim) {
      throw new Error(
        'Unsupported C# syntax for structural authentication: interpolated verbatim string ($@"..."). Use a real C# parser or remove interpolation.',
      );
    }
    // Verbatim string: @"...". A doubled "" is an escaped quote (stays inside).
    if (c === '@' && c2 === '"') {
      let j = i + 2;
      let closed = false;
      while (j < n) {
        if (src[j] === '"' && src[j + 1] === '"') { j += 2; continue; }
        if (src[j] === '"') { closed = true; break; }
        j++;
      }
      if (!closed) throw new Error('Unterminated verbatim string literal in C# extract.');
      const end = j + 1;
      // forceBlank: a verbatim string can span lines and hold decoy code, so its
      // body is never exposed to extractors.
      emitLiteral(end, 2, 1, /* forceBlank */ true); // open '@"' (2), close '"' (1)
      i = end;
      lineStart = false;
      continue;
    }
    // Interpolated string ($"...") carries `{ ... }` holes — reject.
    if (c === '$' && c2 === '"') {
      throw new Error(
        'Unsupported C# syntax for structural authentication: interpolated string ($"..."). Use a real C# parser or remove interpolation.',
      );
    }
    // Regular string: "...".
    if (c === '"') {
      let j = i + 1;
      while (j < n) {
        if (src[j] === '\\') {
          // A backslash escapes the NEXT char, but C# does NOT permit a line
          // continuation in a regular string: a `\` immediately before a recognized
          // newline (or EOF) does NOT swallow that newline — the string was never
          // closed on its line. Break so the unterminated-string throw below fires
          // (a naive `j += 2` here would consume the newline and let the literal span
          // a line break, hiding code / masking an unterminated string).
          if (j + 1 >= n || isNL(src[j + 1]!)) break;
          j += 2;
          continue;
        }
        if (src[j] === '"' || isNL(src[j])) break;
        j++;
      }
      if (src[j] !== '"') throw new Error('Unterminated string literal in C# extract (unclosed " before newline/EOF).');
      const end = j + 1;
      emitLiteral(end, 1, 1);
      i = end;
      lineStart = false;
      continue;
    }
    // Char literal: '.' or '\n' etc.
    if (c === "'") {
      let j = i + 1;
      while (j < n && src[j] !== "'" && !isNL(src[j])) {
        if (src[j] === '\\') {
          // Same as strings: a `\` before a recognized newline (or EOF) does not
          // continue the char literal across the line — fail closed.
          if (j + 1 >= n || isNL(src[j + 1]!)) break;
          j += 2;
          continue;
        }
        j++;
      }
      if (src[j] !== "'") throw new Error('Unterminated character literal in C# extract.');
      const end = j + 1;
      emitLiteral(end, 1, 1);
      i = end;
      lineStart = false;
      continue;
    }
    out += c;
    if (isNL(c)) lineStart = true;
    else if (!isCSharpWhitespace(c)) lineStart = false;
    i++;
  }
  return out;
}

/**
 * Structural view: comments, directives, AND string/char literal CONTENT blanked.
 * Fails closed (see {@link scanCSharp}). Used when parsing code STRUCTURE so a
 * token or brace inside a comment or string cannot fool the parser.
 */
export function stripCSharpNoise(src: string): string {
  return scanCSharp(src, /* blankStrings */ true);
}

/**
 * Name-extraction view: comments and directives blanked, but string/char literal
 * CONTENT PRESERVED, so an extractor can read the literal wire values it needs.
 * Fails closed identically to {@link stripCSharpNoise} — the SINGLE parsed
 * representation every name extractor scans (never raw text).
 */
export function commentStrippedCSharp(src: string): string {
  return scanCSharp(src, /* blankStrings */ false);
}

/** Length of the run of `ch` starting at index i. */
function runLength(src: string, i: number, ch: string): number {
  let k = 0;
  while (src[i + k] === ch) k++;
  return k;
}

/** Detects a raw-string open at index i (optional `$`/`@` prefixes then >= 3 quotes). */
function matchRawStringOpen(src: string, i: number): { quoteRun: number; prefixLen: number } | null {
  let j = i;
  while (src[j] === '$' || src[j] === '@') j++;
  const prefixLen = j - i;
  const quoteRun = runLength(src, j, '"');
  if (quoteRun >= 3) return { quoteRun, prefixLen };
  return null;
}

/**
 * Names of the C# methods DECLARED in an extract, parsed from a
 * comment/literal-stripped view so a method name that appears only in a comment
 * or string is never counted. A declaration is an access-modified signature whose
 * parameter list is followed by a body `{` or an expression body `=>` (not a call
 * site, which is followed by `;`).
 */
export function csharpMethodNames(extractText: string): string[] {
  const src = stripCSharpNoise(extractText);
  const out: string[] = [];
  const re = /(?:public|private|protected|internal)\s+(?:static\s+|async\s+|sealed\s+|override\s+|virtual\s+)*[A-Za-z_][A-Za-z0-9_.<>,?\[\]\s]*?\s+([A-Za-z_]\w*)\s*\(([^)]*)\)\s*(\{|=>)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) out.push(m[1]!);
  return out;
}

/**
 * Brace-matched body of a named C# method. Fail-closed against call sites: the
 * name must be preceded by an ACCESS MODIFIER + return type on the same signature
 * (so `lock (Foo()) { }` / `using (Foo()) { }` / control-flow braces after a call
 * are never mistaken for a declaration). Parsed from a comment/literal-stripped
 * view so braces inside strings/comments cannot truncate the body. Returns the
 * ORIGINAL source slice for the matched body span, or '' when not declared as a
 * block-bodied method.
 */
export function csharpMethodBody(extractText: string, methodName: string): string {
  const src = stripCSharpNoise(extractText);
  const escaped = methodName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const decl = new RegExp(
    `(?:public|private|protected|internal)\\s+(?:static\\s+|async\\s+|sealed\\s+|override\\s+|virtual\\s+)*` +
      `[A-Za-z_][A-Za-z0-9_.<>,?\\[\\]\\s]*?\\s+${escaped}\\s*\\(`,
    'g',
  );
  let m: RegExpExecArray | null;
  while ((m = decl.exec(src)) !== null) {
    // The match ends at the opening '(' of the parameter list; balance parens.
    const paren = m.index + m[0].length - 1;
    let depth = 0;
    let close = -1;
    for (let j = paren; j < src.length; j++) {
      if (src[j] === '(') depth++;
      else if (src[j] === ')') {
        depth--;
        if (depth === 0) { close = j; break; }
      }
    }
    if (close < 0) continue;
    const open = src.indexOf('{', close);
    if (open < 0) continue;
    // Only whitespace/where-constraint tokens between ')' and '{'. A ';' or '='
    // means an abstract/expression member, not a block body.
    const between = src.slice(close + 1, open);
    if (/[;=]/.test(between)) continue;
    let bdepth = 0;
    for (let j = open; j < src.length; j++) {
      const ch = src[j];
      if (ch === '{') bdepth++;
      else if (ch === '}') {
        bdepth--;
        if (bdepth === 0) return extractText.slice(open + 1, j);
      }
    }
  }
  return '';
}

/**
 * Brace-matched body of the method `methodName` declared as a DIRECT member of the
 * top-level class `className`, requiring EXACTLY ONE such direct block-bodied member.
 * Scoped to the class body via {@link csharpClassBodies} (which fails closed on
 * nested/duplicate classes), and depth-filtered so only members at brace depth 0 of the
 * class body count — a same-named local function nested inside another method, or a
 * method of a different class in the same extract, is never selected. Unlike
 * {@link csharpMethodBody}, which returns the FIRST same-named declaration anywhere in
 * the text, this THROWS when the count is not exactly one, so an acceptance-critical
 * check cannot be satisfied by a decoy/overload/first-of-many declaration.
 */
export function csharpDirectMethodBody(
  extractText: string,
  className: string,
  methodName: string,
): string {
  const classes = csharpClassBodies(extractText);
  const classBody = classes[className];
  if (classBody === undefined) {
    throw new Error(`C# extract declares no class '${className}' (cannot scope '${methodName}').`);
  }
  const src = stripCSharpNoise(classBody);
  // Brace depth at each index of the class body, so only DIRECT members (depth 0) match:
  // a `}` lowers the depth AT its own index; a `{` raises it AFTER its index.
  const depthAt: number[] = new Array(src.length);
  let d = 0;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === '}') d--;
    depthAt[i] = d;
    if (ch === '{') d++;
  }
  const escaped = methodName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const decl = new RegExp(
    `(?:public|private|protected|internal)\\s+(?:static\\s+|async\\s+|sealed\\s+|override\\s+|virtual\\s+)*` +
      `[A-Za-z_][A-Za-z0-9_.<>,?\\[\\]\\s]*?\\s+${escaped}\\s*\\(`,
    'g',
  );
  const bodies: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = decl.exec(src)) !== null) {
    // The signature must begin at class-body depth 0 (a DIRECT member) — not inside
    // another method (a local function) or a nested scope.
    if (depthAt[m.index] !== 0) continue;
    const paren = m.index + m[0].length - 1;
    let pdepth = 0;
    let close = -1;
    for (let j = paren; j < src.length; j++) {
      if (src[j] === '(') pdepth++;
      else if (src[j] === ')') {
        pdepth--;
        if (pdepth === 0) { close = j; break; }
      }
    }
    if (close < 0) continue;
    const open = src.indexOf('{', close);
    if (open < 0) continue;
    // A ';' or '=' between ')' and '{' means an abstract/expression member, not a block.
    if (/[;=]/.test(src.slice(close + 1, open))) continue;
    let bdepth = 0;
    for (let j = open; j < src.length; j++) {
      const ch = src[j];
      if (ch === '{') bdepth++;
      else if (ch === '}') {
        bdepth--;
        if (bdepth === 0) { bodies.push(classBody.slice(open + 1, j)); break; }
      }
    }
  }
  if (bodies.length !== 1) {
    throw new Error(
      `Expected EXACTLY ONE direct '${methodName}' method in class '${className}', found ${bodies.length}.`,
    );
  }
  return bodies[0]!;
}

/** A block-bodied C# extension method matched by exact signature. */
export interface CSharpExtensionMethod {
  /** The ORIGINAL-source body slice (between the outermost method braces). */
  body: string;
  /** The receiver parameter identifier (the `this <Type> <name>` name), so a caller can
   *  bind the method's comparisons to the receiver rather than a hardcoded name. */
  receiverParam: string;
}

/**
 * Every block-bodied `public static bool <methodName>(this <receiverType> <param>)`
 * method declared as a DIRECT member of the top-level class `className`. The signature
 * is matched EXACTLY:
 *   - modifiers + return type are exactly `public static bool` (no other return type,
 *     e.g. `bool?`/`Task<bool>`, and no other/extra modifier set is accepted);
 *   - the parameter list is EXACTLY ONE parameter — the extension receiver
 *     `this <receiverType> <param>` — with NO additional parameters (a trailing comma /
 *     second parameter is rejected), and a WHOLE-TOKEN receiver type (so
 *     `ScenarioValidationStateFoo` does not match `ScenarioValidationState`).
 * Scoped to the class body via {@link csharpClassBodies} (which fails closed on
 * nested/duplicate classes), so a same-named method in ANOTHER class, a non-extension
 * overload, a different return type, extra parameters, or a different receiver type is
 * never matched. Returns one `{ body, receiverParam }` per match, so a caller can
 * require EXACTLY ONE method AND bind the predicate's comparisons to the receiver
 * identifier — unlike {@link csharpMethodBody}, which returns the first method of a
 * given NAME regardless of its containing class or signature.
 */
export function csharpExtensionMethodBodies(
  extractText: string,
  className: string,
  methodName: string,
  receiverType: string,
): CSharpExtensionMethod[] {
  const classes = csharpClassBodies(extractText);
  const classBody = classes[className];
  if (classBody === undefined) return [];
  const src = stripCSharpNoise(classBody);
  const escapedName = methodName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escapedType = receiverType.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // EXACT signature: `public static bool <name>(` — canonical modifier order and the
  // `bool` return type only (no `bool?`, `Task<bool>`, or a different modifier set).
  const decl = new RegExp(`\\bpublic\\s+static\\s+bool\\s+${escapedName}\\s*\\(`, 'g');
  // The parameter list must be EXACTLY one parameter: `this <receiverType> <ident>` with
  // NO trailing comma (a second parameter is rejected). `$` anchors the single-parameter
  // requirement; the captured group is the receiver identifier bound by the caller.
  const receiverRe = new RegExp(`^\\s*this\\s+${escapedType}\\s+([A-Za-z_]\\w*)\\s*$`);
  const out: CSharpExtensionMethod[] = [];
  let m: RegExpExecArray | null;
  while ((m = decl.exec(src)) !== null) {
    const paren = m.index + m[0].length - 1;
    let depth = 0;
    let close = -1;
    for (let j = paren; j < src.length; j++) {
      if (src[j] === '(') depth++;
      else if (src[j] === ')') {
        depth--;
        if (depth === 0) { close = j; break; }
      }
    }
    if (close < 0) continue;
    const params = receiverRe.exec(src.slice(paren + 1, close));
    if (!params) continue;
    const open = src.indexOf('{', close);
    if (open < 0) continue;
    // A ';' or '=' between ')' and '{' means an abstract/expression member, not a block.
    if (/[;=]/.test(src.slice(close + 1, open))) continue;
    let bdepth = 0;
    for (let j = open; j < src.length; j++) {
      const ch = src[j];
      if (ch === '{') bdepth++;
      else if (ch === '}') {
        bdepth--;
        if (bdepth === 0) {
          out.push({ body: classBody.slice(open + 1, j), receiverParam: params[1]! });
          break;
        }
      }
    }
  }
  return out;
}

/**
 * Brace-matched body of each TOP-LEVEL `class NAME` (original source slice), keyed
 * by class name. Fails CLOSED on a NESTED class (a class whose body opens inside
 * another class's body): nesting would let a structural field/type derivation
 * double-count or mis-attribute members, so it forces a parser upgrade rather than
 * being silently mis-modeled. Duplicate top-level class names are also rejected.
 */
export function csharpClassBodies(extractText: string): Record<string, string> {
  const src = stripCSharpNoise(extractText);
  // 1) Locate every class declaration and brace-match its body range.
  const ranges: Array<{ name: string; open: number; close: number }> = [];
  const re = /\bclass\s+([A-Za-z_]\w*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const name = m[1]!;
    const open = src.indexOf('{', m.index + m[0].length);
    if (open < 0) continue;
    // Nothing but whitespace / base-list / generic-constraint tokens may sit between
    // the class header and its body brace; a ';' would be a forward declaration.
    if (src.slice(m.index + m[0].length, open).includes(';')) continue;
    let depth = 0;
    let close = -1;
    for (let j = open; j < src.length; j++) {
      const ch = src[j];
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) { close = j; break; }
      }
    }
    if (close < 0) throw new Error(`Unterminated class body for '${name}' in C# extract.`);
    ranges.push({ name, open, close });
  }
  // 2) Reject any class whose body opens INSIDE another class's body (nested class).
  for (const a of ranges) {
    for (const b of ranges) {
      if (a === b) continue;
      if (a.open > b.open && a.open < b.close) {
        throw new Error(
          `Unsupported C# syntax for structural authentication: nested class '${a.name}' inside '${b.name}'. Use a real C# parser.`,
        );
      }
    }
  }
  // 3) All remaining classes are top-level; capture their ORIGINAL-source bodies.
  const out: Record<string, string> = {};
  for (const r of ranges) {
    if (r.name in out) throw new Error(`Duplicate top-level class '${r.name}' in C# extract.`);
    out[r.name] = extractText.slice(r.open + 1, r.close);
  }
  return out;
}

/** A JSON primitive wire type derived from the `Write*Value` call. */
export type WirePrimitive = 'string' | 'number' | 'boolean';
/** An array's element wire type: a primitive, or `object` for `WriteObjectValue`. */
export type WireElement = WirePrimitive | 'object';

/**
 * A single serialized wire field derived from a model's `IUtf8JsonSerializable.Write`
 * body: its wire `name`, the wire `kind` (from the `Write*` call), whether it is
 * `required` (written WITHOUT an `Optional.Is[Collection]Defined` guard), the CLR
 * `property` it serializes, and the EXACT wire types — `primitive` for a scalar
 * (`WriteStringValue`→string, `WriteNumberValue`→number, `WriteBooleanValue`→
 * boolean) and `element` for an array (the type each item is written with).
 */
export interface SerializedField {
  name: string;
  kind: 'array' | 'object' | 'scalar';
  required: boolean;
  property: string | null;
  primitive?: WirePrimitive;
  element?: WireElement;
}

function writeCallToPrimitive(call: string): WirePrimitive | undefined {
  if (call === 'StringValue') return 'string';
  if (call === 'NumberValue') return 'number';
  if (call === 'BooleanValue') return 'boolean';
  return undefined;
}

/**
 * Per-class serialized wire fields, derived STRUCTURALLY from each model's
 * `IUtf8JsonSerializable.Write` body. For every `WritePropertyName("name")`:
 *  - `kind` is `array` for a following `WriteStartArray`, `object` for
 *    `WriteStartObject`, else `scalar`;
 *  - `required` is true iff the write is NOT wrapped in an
 *    `Optional.IsDefined(...)` / `Optional.IsCollectionDefined(...)` guard;
 *  - `property` is the CLR property name, taken from the guard argument, else from
 *    the value write (`Write*Value(Prop)` / `foreach (var item in Prop)`);
 *  - `primitive` is the scalar's exact wire type; `element` is an array item's
 *    exact wire type (a primitive or `object`), each derived from the `Write*Value`.
 * Parses the raw (comment-blanked) class body so the string LITERAL carrying each
 * wire name is preserved. Used to authenticate the fixtures' nested error shapes
 * against the exact generated serialization (fields, kinds, requiredness, and
 * primitive/element types) rather than a hardcode.
 */
export function serializedFieldsByClass(extractText: string): Record<string, SerializedField[]> {
  const bodies = csharpClassBodies(extractText);
  const out: Record<string, SerializedField[]> = {};
  for (const [cls, body] of Object.entries(bodies)) {
    // Two length-aligned views of the SAME class body (blanking preserves offsets):
    //  - `struct`: string CONTENT blanked, used for BRACE + guard structure so a
    //    brace or `if` inside a string cannot perturb ancestry.
    //  - `names`: regular-string content preserved (raw/verbatim blanked), used to
    //    READ the WritePropertyName("name") argument and value-write property.
    const struct = stripCSharpNoise(body);
    const names = commentStrippedCSharp(body);

    // SCOPE to the SELECTED serializer method (`Write(Utf8JsonWriter <writer>)`, the
    // IUtf8JsonSerializable.Write body), NOT the whole class: a WritePropertyName in
    // some other method must never be read as a wire field. Bind the exact writer
    // variable so only calls ON THAT writer count, and track JSON container depth so
    // only TOP-LEVEL (root-object, depth 1) fields are extracted — a WritePropertyName
    // nested inside a sub-object (depth >= 2) is a nested field, not a top-level one.
    const serializer = findSerializerMethod(struct);
    if (serializer === null) { out[cls] = []; continue; }
    const { writer, start: mStart, end: mEnd } = serializer;
    const wq = writer.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    // Brace positions opened by an `if (Optional.Is[Collection]Defined(Prop)) {`
    // guard, mapped to the guarded property. Found on `struct` (within the method) so
    // string contents can't spoof a guard.
    const guardAt = new Map<number, string>();
    const guardRe = /\bif\s*\(\s*Optional\.Is(?:Collection)?Defined\(\s*([A-Za-z_]\w*)\s*\)\s*\)\s*\{/g;
    guardRe.lastIndex = mStart;
    let gm: RegExpExecArray | null;
    while ((gm = guardRe.exec(struct)) !== null) {
      if (gm.index >= mEnd) break;
      guardAt.set(gm.index + gm[0].length - 1, gm[1]!); // index of the opening '{'
    }

    // STRUCTURAL detection of `<writer>.WritePropertyName(...)` calls on the fully
    // string-blanked `struct` view WITHIN the serializer method, so no string/comment
    // CONTENT and no OTHER writer/method can be mistaken for a top-level wire field.
    const wpn: Array<{ index: number; name: string }> = [];
    const callRe = new RegExp(`${NB_BEFORE}${wq}\\s*\\.\\s*WritePropertyName\\s*\\(`, 'gu');
    callRe.lastIndex = mStart;
    let cm: RegExpExecArray | null;
    while ((cm = callRe.exec(struct)) !== null) {
      if (cm.index >= mEnd) break;
      // Require EXACTLY ONE literal string field-name argument (a single "..."
      // possibly with a u8 suffix), read from `names` at the same offset. The literal
      // body is captured escaped-quote-safe and DECODED, so an escaped quote cannot
      // truncate it and an escape resolves to its true char. A missing/empty/non-literal/
      // concatenated argument is ambiguous and FAILS CLOSED.
      const argWin = names.slice(cm.index, Math.min(mEnd, cm.index + 256));
      const nmeta = new RegExp(`^${wq}\\s*\\.\\s*WritePropertyName\\s*\\(\\s*"${CS_STRING_BODY}"(?:u8)?\\s*\\)`).exec(argWin);
      if (nmeta === null) {
        throw new Error(`serializedFieldsByClass: ${cls}.${writer}.WritePropertyName lacks exactly one non-empty string-literal field name (fail closed)`);
      }
      const decodedName = decodeCSharpRegularString(nmeta[1]!);
      if (decodedName.length === 0) {
        throw new Error(`serializedFieldsByClass: ${cls}.${writer}.WritePropertyName lacks exactly one non-empty string-literal field name (fail closed)`);
      }
      wpn.push({ index: cm.index, name: decodedName });
    }

    // JSON container boundaries on the SAME writer, each tagged with its container TYPE:
    // WriteStartObject/StartArray OPEN a typed container, WriteEndObject/EndArray CLOSE
    // one. The linear walk below drives a TYPED container stack from these so a close
    // must match its open type, an unmatched close (underflow) fails closed, and the
    // serializer must resolve to exactly one balanced ROOT OBJECT.
    const container = new Map<number, { op: 'open' | 'close'; type: 'object' | 'array' }>();
    const openRe = new RegExp(`${NB_BEFORE}${wq}\\s*\\.\\s*WriteStart(Object|Array)\\s*\\(`, 'gu');
    const closeRe = new RegExp(`${NB_BEFORE}${wq}\\s*\\.\\s*WriteEnd(Object|Array)\\s*\\(`, 'gu');
    for (const [re, op] of [[openRe, 'open'], [closeRe, 'close']] as const) {
      re.lastIndex = mStart;
      let m: RegExpExecArray | null;
      while ((m = re.exec(struct)) !== null) {
        if (m.index >= mEnd) break;
        container.set(m.index, { op, type: m[1] === 'Object' ? 'object' : 'array' });
      }
    }

    // Single linear walk over the METHOD region maintaining (a) the C# brace stack for
    // Optional-guard ancestry and (b) a TYPED JSON container stack. When the walk reaches
    // a top-level (root-object depth 1) WritePropertyName index, requiredness/attribution
    // come from the ENCLOSING guard braces.
    const stack: Array<string | null> = [];
    const jsonStack: Array<'object' | 'array'> = [];
    let rootObjects = 0;
    let wi = 0;
    const fields: SerializedField[] = [];
    for (let idx = mStart; idx < mEnd; idx++) {
      const cc = container.get(idx);
      if (cc !== undefined) {
        if (cc.op === 'open') {
          if (jsonStack.length === 0) {
            if (cc.type !== 'object') {
              throw new Error(`serializedFieldsByClass: ${cls} serializer root container is '${cc.type}', expected a single root object (fail closed)`);
            }
            rootObjects++;
            if (rootObjects > 1) {
              throw new Error(`serializedFieldsByClass: ${cls} serializer opens more than one root object (fail closed)`);
            }
          }
          jsonStack.push(cc.type);
        } else {
          const top = jsonStack.pop();
          if (top === undefined) {
            throw new Error(`serializedFieldsByClass: ${cls} serializer closes a JSON container that was never opened (underflow, fail closed)`);
          }
          if (top !== cc.type) {
            throw new Error(`serializedFieldsByClass: ${cls} serializer closes '${cc.type}' but the open container is '${top}' (mismatched, fail closed)`);
          }
        }
      }
      const ch = struct[idx];
      if (ch === '{') { stack.push(guardAt.get(idx) ?? null); continue; }
      if (ch === '}') { stack.pop(); continue; }
      if (wi < wpn.length && idx === wpn[wi]!.index) {
        const { name } = wpn[wi]!;
        wi++;
        // Only extract fields directly inside the ROOT object (a single open container,
        // which the checks above prove is the root object); deeper WritePropertyName
        // calls belong to a nested object and are not top-level wire fields.
        if (jsonStack.length !== 1) continue;
        // Innermost enclosing guard (search the stack top-down); required iff none.
        let enclosingGuard: string | null = null;
        for (let s = stack.length - 1; s >= 0; s--) {
          if (stack[s] !== null) { enclosingGuard = stack[s]!; break; }
        }
        const required = enclosingGuard === null;
        // kind + primitive/element + the value RECEIVER are read STRUCTURALLY from the
        // string-blanked `struct` window that FOLLOWS this call, BOUNDED to the current
        // property's write region (ends at the NEXT WritePropertyName), so a field can
        // never borrow a LATER field's writer info. Missing/ambiguous metadata FAILS
        // CLOSED (requires a value write, a receiver, and a type).
        const callMatch = new RegExp(`^${wq}\\s*\\.\\s*WritePropertyName\\s*\\([^)]*\\)`).exec(struct.slice(idx));
        const afterStart = idx + (callMatch ? callMatch[0].length : 0);
        const nextWpnIdx = wi < wpn.length ? wpn[wi]!.index : mEnd;
        const windowEnd = Math.min(afterStart + 400, nextWpnIdx, mEnd);
        const after = struct.slice(afterStart, Math.max(afterStart, windowEnd));
        // Derive the value write's KIND and (for a direct value write) its RECEIVER from
        // ONE invocation: the first `<writer>.Write<Kind>( <receiver>? …` in the window.
        // Reading both from the SAME matched call (rather than two independent scans)
        // means a field can never associate a receiver taken from a DIFFERENT (later)
        // call. Matched with an EXACT Unicode-aware receiver boundary so a different
        // writer whose name merely ends in this writer's name is not accepted.
        const next = new RegExp(
          `${NB_BEFORE}${wq}\\s*\\.\\s*Write(StartArray|StartObject|StringValue|NumberValue|BooleanValue|ObjectValue)\\s*\\(\\s*(?:([A-Za-z_]\\w*)${NB_AFTER_NOCALL})?`,
          'u',
        ).exec(after);
        if (!next) {
          throw new Error(`serializedFieldsByClass: no ${writer} value write found for property '${name}' in ${cls} (fail closed)`);
        }
        const receiverTok = next[2] ?? null; // the value write's receiver argument, if any
        let kind: 'array' | 'object' | 'scalar' = 'scalar';
        let primitive: WirePrimitive | undefined;
        let element: WireElement | undefined;
        let property: string | null = null;
        // Whether the value write is an INLINE object block (WriteStartObject); such a
        // field is assembled inline and legitimately has no single CLR receiver.
        let inlineObject = false;
        if (next[1] === 'StartArray') {
          kind = 'array';
          const el = new RegExp(`${NB_BEFORE}${wq}\\s*\\.\\s*Write(StringValue|NumberValue|BooleanValue|ObjectValue)\\s*\\(`, 'u').exec(after.slice(next.index));
          if (!el) {
            throw new Error(`serializedFieldsByClass: array field '${name}' in ${cls} has no element value write (fail closed)`);
          }
          element = el[1] === 'ObjectValue' ? 'object' : writeCallToPrimitive(el[1]!);
          // The `foreach (var x in Receiver)` source (anchored AFTER the WriteStartArray
          // so an earlier loop cannot be borrowed); the receiver token must be COMPLETE
          // (not followed by `(`), so a method call is not mistaken for a property.
          const fe = new RegExp(`foreach\\s*\\(\\s*var\\s+\\w+\\s+in\\s+([A-Za-z_]\\w*)${NB_AFTER_NOCALL}`, 'u').exec(after.slice(next.index));
          property = fe ? fe[1]! : null;
        } else if (next[1] === 'ObjectValue') {
          // A direct WriteObjectValue(Prop) nested object: the receiver (from the SAME
          // call) is required.
          kind = 'object';
          property = receiverTok;
        } else if (next[1] === 'StartObject') {
          // An INLINE nested object (WriteStartObject ... WriteEndObject) has no single
          // receiver — its members are written inline — so a null receiver is valid here.
          kind = 'object';
          inlineObject = true;
        } else {
          primitive = writeCallToPrimitive(next[1]!);
          // The scalar receiver is the argument of the SAME Write*Value call.
          property = receiverTok;
        }
        // Require a resolvable RECEIVER (the CLR property serialized) and TYPE metadata,
        // EXCEPT for an inline WriteStartObject object which is assembled inline.
        if (property === null && !inlineObject) {
          throw new Error(`serializedFieldsByClass: value write for '${name}' in ${cls} has no receiver (fail closed)`);
        }
        if (kind === 'scalar' && primitive === undefined) {
          throw new Error(`serializedFieldsByClass: scalar field '${name}' in ${cls} has no resolved primitive type (fail closed)`);
        }
        if (kind === 'array' && element === undefined) {
          throw new Error(`serializedFieldsByClass: array field '${name}' in ${cls} has no resolved element type (fail closed)`);
        }
        const field: SerializedField = { name, kind, required, property };
        if (primitive) field.primitive = primitive;
        if (element) field.element = element;
        fields.push(field);
      }
    }
    // FINAL BALANCE: every opened JSON container must have been closed (no dangling
    // open), and the serializer must have resolved to exactly one root object.
    if (jsonStack.length !== 0) {
      throw new Error(`serializedFieldsByClass: ${cls} serializer leaves ${jsonStack.length} JSON container(s) open (unbalanced, fail closed)`);
    }
    if (rootObjects !== 1) {
      throw new Error(`serializedFieldsByClass: ${cls} serializer resolves ${rootObjects} root objects, expected exactly one (fail closed)`);
    }
    out[cls] = fields;
  }
  return out;
}

/**
 * Locates the AUTHORITATIVE IUtf8JsonSerializable serializer method in a
 * (string-blanked) class body and returns its bound writer variable and the
 * `[start, end)` offsets of the method BODY. The authoritative serializer is the
 * explicit interface implementation `IUtf8JsonSerializable.Write(Utf8JsonWriter w)`
 * autorest emits. Selection is UNAMBIGUOUS:
 *  - if exactly one `Write(Utf8JsonWriter …)` method exists, use it;
 *  - if several exist, use the single explicit `IUtf8JsonSerializable.Write` one;
 *  - if several exist and none (or more than one) is the explicit interface impl, FAIL
 *    CLOSED (throw) rather than guess an overload.
 * Only DIRECT class members are considered: a signature must sit at brace depth 0 of the
 * class body, so a nested LOCAL FUNCTION `void Write(Utf8JsonWriter w){…}` declared
 * inside another method (depth >= 1) can never be selected as the serializer. Returns
 * null only when the class declares no direct serializer at all. Scoping extraction to
 * this method (and its writer) keeps a `WritePropertyName` in an unrelated method from
 * being read as a wire field.
 */
function findSerializerMethod(struct: string): { writer: string; start: number; end: number } | null {
  // Brace depth at every index of the class body, so a serializer signature can be
  // restricted to a DIRECT member (depth 0). A nested local function is at depth >= 1.
  const depthAt = new Array<number>(struct.length + 1);
  {
    let d = 0;
    for (let i = 0; i < struct.length; i++) {
      depthAt[i] = d;
      if (struct[i] === '{') d++;
      else if (struct[i] === '}') d--;
    }
    depthAt[struct.length] = d;
  }
  // All `Write(Utf8JsonWriter <w>)` signatures, each tagged with whether it is the
  // explicit `IUtf8JsonSerializable.Write` interface implementation. Only signatures at
  // brace depth 0 (direct class members) are eligible.
  const sigRe = /(IUtf8JsonSerializable\s*\.\s*)?\bWrite\s*\(\s*Utf8JsonWriter\s+([A-Za-z_]\w*)\s*\)/g;
  const sigs: Array<{ index: number; writer: string; explicit: boolean; sigEnd: number }> = [];
  let sm: RegExpExecArray | null;
  while ((sm = sigRe.exec(struct)) !== null) {
    if (depthAt[sm.index] !== 0) continue; // skip nested local functions
    sigs.push({ index: sm.index, writer: sm[2]!, explicit: sm[1] !== undefined, sigEnd: sm.index + sm[0].length });
  }
  if (sigs.length === 0) return null;
  let chosen: { index: number; writer: string; explicit: boolean; sigEnd: number };
  if (sigs.length === 1) {
    chosen = sigs[0]!;
  } else {
    const explicitSigs = sigs.filter((s) => s.explicit);
    if (explicitSigs.length !== 1) {
      throw new Error(
        `findSerializerMethod: ambiguous serializer — ${sigs.length} Write(Utf8JsonWriter …) methods and ${explicitSigs.length} explicit IUtf8JsonSerializable.Write impls (fail closed)`,
      );
    }
    chosen = explicitSigs[0]!;
  }
  const { writer, sigEnd } = chosen;
  // Find the method's opening brace after the signature, then brace-match its body.
  const open = struct.indexOf('{', sigEnd - 1);
  if (open < 0) return null;
  // Only whitespace between ')' and '{' (a where-constraint/expression body would not
  // be a serializer we can scope); tolerate whitespace only.
  const between = struct.slice(sigEnd, open);
  if (/[;=]/.test(between)) return null;
  let depth = 0;
  for (let j = open; j < struct.length; j++) {
    if (struct[j] === '{') depth++;
    else if (struct[j] === '}') {
      depth--;
      if (depth === 0) return { writer, start: open + 1, end: j };
    }
  }
  return null;
}

/**
 * CLR property declarations `public TYPE NAME { get; ... }` SCOPED TO THEIR
 * CONTAINING CLASS, mapped className -> { propName -> type }. Each class body is
 * parsed independently from the single fail-closed structural view, so a property
 * in one class can never be confused with a same-named property in another. Only
 * DIRECT class members are collected: a property declared inside a NESTED type
 * (nested class/struct/record/enum whose braces sit at depth >= 1 within the class
 * body) is IGNORED, so a nested type's property can never contaminate the containing
 * class's schema.
 */
export function csharpPropertyTypesByClass(extractText: string): Record<string, Record<string, string>> {
  const bodies = csharpClassBodies(extractText);
  const out: Record<string, Record<string, string>> = {};
  for (const [cls, body] of Object.entries(bodies)) {
    const src = stripCSharpNoise(body);
    // Brace depth at every index of the class body, so a property match can be
    // restricted to a DIRECT member (depth 0). A member of a nested type is at depth >= 1.
    const depthAt = new Array<number>(src.length + 1);
    {
      let d = 0;
      for (let i = 0; i < src.length; i++) {
        depthAt[i] = d;
        if (src[i] === '{') d++;
        else if (src[i] === '}') d--;
      }
      depthAt[src.length] = d;
    }
    const map: Record<string, string> = {};
    const re = /(?:public|internal|protected|private)\s+([A-Za-z_][\w.<>,?[\]]*)\s+([A-Za-z_]\w*)\s*\{\s*get\b/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      if (depthAt[m.index] !== 0) continue; // skip a property of a NESTED type
      map[m[2]!] = m[1]!;
    }
    out[cls] = map;
  }
  return out;
}

/**
 * CLR property declarations `public TYPE NAME { get; ... }` in an extract, mapped
 * NAME -> TYPE. This is the FLATTENED view of {@link csharpPropertyTypesByClass}
 * (later classes override earlier same-named properties); prefer the by-class map
 * when class scoping matters. Method declarations (with a `(` parameter list, not
 * `{ get`) are never matched.
 */
export function csharpPropertyTypes(extractText: string): Record<string, string> {
  const byClass = csharpPropertyTypesByClass(extractText);
  const out: Record<string, string> = {};
  for (const map of Object.values(byClass)) Object.assign(out, map);
  return out;
}

/**
 * Parses a C# integer constant declaration `... const int NAME = <digits>;` from the
 * structural view and returns its integer value, or `undefined` if not present. Reads
 * from the fail-closed structural representation (comments/strings blanked) so a decoy
 * `const int NAME = 999;` inside a comment or string cannot be picked up. Used to
 * authenticate a fixture/contract numeric constant (e.g. the default Retry-After
 * seconds) against the value the SOURCE actually declares.
 */
export function csharpIntConst(extractText: string, name: string): number | undefined {
  const src = stripCSharpNoise(extractText);
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?<![${CS_ID_PART}])const\\s+int\\s+${escaped}\\s*=\\s*(-?\\d+)\\s*;`, 'u');
  const m = re.exec(src);
  return m ? Number(m[1]) : undefined;
}

/**
 * Derives the wire error-CHANNEL -> element MODEL-class map from a generated
 * properties model, STRUCTURALLY (no hardcoded channel names). For every array
 * field whose CLR property is declared `IReadOnlyList<Element>`, maps the wire
 * channel name to `Element`. Property-type lookup is CLASS-SCOPED: each array
 * field's property is resolved against the SAME class that serialized it, so a
 * same-named property in another class cannot cross-contaminate. E.g.
 * ValidationProperties -> `{ errors: 'ScenarioError', validationErrors: 'ScenarioValidationError' }`.
 */
export function channelElementModels(propertiesExtractText: string): Record<string, string> {
  const fieldsByClass = serializedFieldsByClass(propertiesExtractText);
  const typesByClass = csharpPropertyTypesByClass(propertiesExtractText);
  const out: Record<string, string> = {};
  for (const [cls, fields] of Object.entries(fieldsByClass)) {
    const propTypes = typesByClass[cls] ?? {};
    for (const f of fields) {
      if (f.kind !== 'array' || !f.property) continue;
      const t = propTypes[f.property];
      if (!t) continue;
      const el = /^IReadOnlyList<([A-Za-z_]\w*)>$/.exec(t.replace(/\s+/g, ''));
      if (el) out[f.name] = el[1]!;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// A small, spec-faithful C# IDENTIFIER lexer. Regex-with-decode is not enough for
// C# identifiers because the language allows (a) a verbatim `@` prefix (`@class` is the
// identifier `class`; the `@` is NOT part of the name), and (b) `\uXXXX`/`\UXXXXXXXX`
// unicode escapes INSIDE identifiers — but ONLY when the escape resolves to a character
// that is itself a valid identifier char for that position. An escape that resolves to
// PUNCTUATION/whitespace (e.g. `\u002E` == '.') does NOT manufacture an operator; a
// MALFORMED or out-of-range escape is not an identifier char either. This lexer reads one
// identifier honoring those rules, so a matcher cannot be fooled into truncating a member
// to a real name, manufacturing a fake `.` member-access, or mishandling a verbatim `@`.
// ---------------------------------------------------------------------------

/** C# identifier-START code point: a letter (L*), letter-number (Nl), or `_` (U+005F). */
function isCSharpIdentStart(cp: number): boolean {
  if (cp === 0x5f) return true;
  return /[\p{L}\p{Nl}]/u.test(String.fromCodePoint(cp));
}
/** C# identifier-PART code point: L*, Nl, Nd, Pc, Mn, Mc, or Cf (format char). */
function isCSharpIdentPart(cp: number): boolean {
  return /[\p{L}\p{Nl}\p{Nd}\p{Pc}\p{Mn}\p{Mc}\p{Cf}]/u.test(String.fromCodePoint(cp));
}
/** C# FORMAT char (category Cf). Per the C# spec, Cf chars are identifier-PART but are
 *  REMOVED when forming an identifier's IDENTITY, so `foo\u200Bbar` IS the identifier
 *  `foobar`. The lexer consumes Cf chars but never appends them to the normalized name. */
function isCfFormat(cp: number): boolean {
  return /\p{Cf}/u.test(String.fromCodePoint(cp));
}

/**
 * Reads ONE identifier code point at index i — either a raw code point or a `\uXXXX`/
 * `\UXXXXXXXX` escape — requiring it to be a valid identifier START (isStart=true) or
 * PART (isStart=false) character. Returns the DECODED code point + end index, or null
 * when there is no such character (the identifier cleanly TERMINATES). FAILS CLOSED
 * (throws) on a MALFORMED unicode escape (`\u`/`\U` with too few / non-hex digits, or an
 * out-of-range `\U`): such an escape is invalid C# and must never be silently truncated
 * to a shorter real name. A `\` that does not begin a `\u`/`\U` escape is simply
 * not-an-identifier-char (clean terminate), as is any raw non-identifier char.
 */
function readCSharpIdentChar(src: string, i: number, isStart: boolean): { cp: number; end: number } | null {
  if (i >= src.length) return null;
  if (src[i] === '\\') {
    if (src[i + 1] === 'u' || src[i + 1] === 'U') {
      const hexLen = src[i + 1] === 'u' ? 4 : 8;
      const hex = src.slice(i + 2, i + 2 + hexLen);
      if (hex.length !== hexLen || !/^[0-9A-Fa-f]+$/.test(hex)) {
        throw new Error('readCSharpIdentChar: malformed unicode escape in identifier (fail closed)');
      }
      const cp = parseInt(hex, 16);
      if (cp > 0x10ffff) throw new Error('readCSharpIdentChar: unicode escape out of range (fail closed)');
      if (isStart ? !isCSharpIdentStart(cp) : !isCSharpIdentPart(cp)) return null; // decoded to a non-ident char => terminate
      return { cp, end: i + 2 + hexLen };
    }
    // A `\` that is NOT a `\u`/`\U` escape is not a valid identifier char. When we are
    // CONTINUING an identifier (isStart=false), an invalid escaped suffix must FAIL CLOSED
    // rather than silently TRUNCATE the identifier to a shorter real name (e.g.
    // `Accepted\q` must not be read as the real member `Accepted`). When we are LOOKING for
    // the start of an identifier, a stray `\` simply does not begin one (return null so the
    // tokenizer advances past it).
    if (!isStart) throw new Error('readCSharpIdentChar: invalid escape in identifier (fail closed)');
    return null;
  }
  const cp = src.codePointAt(i);
  if (cp === undefined) return null;
  const width = cp > 0xffff ? 2 : 1;
  if (isStart ? !isCSharpIdentStart(cp) : !isCSharpIdentPart(cp)) return null;
  return { cp, end: i + width };
}

/**
 * Reads a complete C# identifier at index i: an optional single verbatim `@` prefix, an
 * identifier-start char, then zero or more identifier-part chars (raw or escaped).
 * Returns the NORMALIZED name (the `@` prefix is dropped AND every Cf format char is
 * removed, per the C# identity rules), the end index, and LEXICAL METADATA — `verbatim`
 * (had an `@` prefix) and `escaped` (contained any `\u`/`\U` escape) — so a caller that
 * must recognize the CONTEXTUAL keyword `global` can require it to be the LITERAL bare
 * keyword (neither verbatim nor escaped). Returns null if no identifier begins at i.
 * Throws (fail closed) on a malformed OR invalid escape (via readCSharpIdentChar).
 */
function readCSharpIdentifier(src: string, i: number): { name: string; end: number; verbatim: boolean; escaped: boolean } | null {
  let j = i;
  const verbatim = src[j] === '@';
  if (verbatim) j++; // verbatim prefix: not part of the name, legal only before a start
  const startAt = j;
  const start = readCSharpIdentChar(src, j, true);
  if (!start) return null;
  let escaped = src[startAt] === '\\';
  let name = isCfFormat(start.cp) ? '' : String.fromCodePoint(start.cp);
  j = start.end;
  for (;;) {
    const partAt = j;
    const part = readCSharpIdentChar(src, j, false);
    if (!part) break;
    if (src[partAt] === '\\') escaped = true;
    if (!isCfFormat(part.cp)) name += String.fromCodePoint(part.cp); // Cf removed from identity
    j = part.end;
  }
  // A start that is itself Cf leaves an empty name; that cannot begin a real identifier.
  if (name.length === 0) return null;
  return { name, end: j, verbatim, escaped };
}

/**
 * Reads a dotted qualified name at index i — an optional `global::` global-namespace
 * qualifier, then `ident ( '.' ident )*`. Returns the list of NORMALIZED segment names,
 * the end index, and a `rooted` flag (true when the name was `global::`-qualified), or
 * null. The `global::` qualifier is DROPPED from the segment list but recorded via
 * `rooted`, because it changes the MEANING of the remaining name: `global::System.Net.X`
 * names the same member as `System.Net.X`, but `global::X` names the type `X` in the ROOT
 * namespace — NOT a `using`-imported `Namespace.X`. Callers that accept a bare (segment-0)
 * type via a `using` directive MUST therefore reject it when `rooted` is true (a
 * `global::`-rooted bare name cannot resolve through a `using`). A `.` not followed by an
 * identifier is NOT consumed (so `HttpStatusCode\u002EOK`, where `\u002E` decodes to '.',
 * is not an identifier char and yields a single segment `HttpStatusCode` — never a
 * manufactured `HttpStatusCode.OK`). A NON-`global` alias qualifier (`Alias::X`) is NOT
 * dropped/accepted here — the reader returns null. Only the LITERAL bare contextual keyword
 * `global` (NOT `@global`, NOT an escaped `gl\u006fbal`) is treated as the global namespace:
 * `@global::X` / escaped-global name a USER-DEFINED alias, not the global namespace, so they
 * are rejected here.
 */
function readCSharpQualifiedName(src: string, i: number): { segments: string[]; end: number; rooted: boolean } | null {
  let start = i;
  const first = readCSharpIdentifier(src, i);
  if (!first) return null;
  const isAliasQualifier = src[first.end] === ':' && src[first.end + 1] === ':';
  if (isAliasQualifier) {
    // Only the LITERAL bare `global` contextual keyword aliases the global namespace.
    // `@global` (verbatim) or an escaped spelling names a user alias — reject it.
    if (first.name === 'global' && !first.verbatim && !first.escaped) {
      const afterAlias = readCSharpIdentifier(src, first.end + 2);
      if (!afterAlias) return null;
      start = first.end + 2;
      return continueDotted(src, afterAlias, start, true);
    }
    // Any other `::` alias qualifier is not the global namespace — reject as a fresh ref.
    return null;
  }
  return continueDotted(src, first, start, false);
}

function continueDotted(src: string, first: { name: string; end: number }, _start: number, rooted: boolean): { segments: string[]; end: number; rooted: boolean } {
  const segments = [first.name];
  let j = first.end;
  for (;;) {
    if (src[j] !== '.') break;
    const next = readCSharpIdentifier(src, j + 1);
    if (!next) break; // a dangling '.' (or one before a non-identifier) ends the name
    segments.push(next.name);
    j = next.end;
  }
  return { segments, end: j, rooted };
}

/** The code point ENDING at index i (i.e. src[i-1]), accounting for a surrogate pair. */
function codePointEndingAt(src: string, i: number): number | undefined {
  if (i <= 0) return undefined;
  const lo = src.charCodeAt(i - 1);
  if (lo >= 0xdc00 && lo <= 0xdfff && i >= 2) {
    const hi = src.charCodeAt(i - 2);
    if (hi >= 0xd800 && hi <= 0xdbff) return src.codePointAt(i - 2);
  }
  return lo;
}

/**
 * True if a qualified name may START at index i — i.e. the preceding char is not part of
 * another identifier and is not a `.`/`@`/`\` (a member access, verbatim prefix, or an
 * escape-in-progress that would make this the CONTINUATION of a larger token). A preceding
 * `:` is allowed ONLY when it is the second colon of a `::` alias qualifier whose alias is
 * `global` (handled by {@link readCSharpQualifiedName}); a bare preceding `:` (e.g. a
 * ternary/label) is fine to start a fresh name after, so `:` is NOT blocked here — the
 * qualified-name reader itself rejects a non-global alias.
 */
function nameMayStartAt(src: string, i: number): boolean {
  if (i === 0) return true;
  const p = src[i - 1];
  if (p === '.' || p === '@' || p === '\\') return false;
  // Block the interior of a `::` so we do not start a fresh name at the alias tail; the
  // reader consumes `global::` as a whole from its start.
  if (p === ':') return false;
  const cp = codePointEndingAt(src, i);
  return cp === undefined || !isCSharpIdentPart(cp);
}

/**
 * Centralized identifier tokenizer: yields every maximal C# identifier in `src` with its
 * NORMALIZED name (verbatim `@` dropped, Cf removed, unicode escapes decoded) and its
 * [start,end) span, failing closed on any malformed unicode escape. Shared by the
 * identifier-reference checks so escape/Cf/verbatim handling is spec-correct and identical
 * everywhere (not a per-call ad-hoc regex). Skips over comment/string-blanked spans is the
 * caller's responsibility (pass a stripped view).
 */
export function csharpIdentifierTokens(src: string): Array<{ name: string; start: number; end: number }> {
  const out: Array<{ name: string; start: number; end: number }> = [];
  let i = 0;
  while (i < src.length) {
    // Attempt a MAXIMAL identifier read at every position. Because reads are maximal and we
    // jump to the end on success, we never start mid-identifier; a member segment after `.`
    // (e.g. `UpsertAsync` in `Store.UpsertAsync`) IS emitted as its own token, and dotted
    // adjacency is reconstructed by the caller via the inter-token gap. Fails closed (throws
    // out of readCSharpIdentifier) on a malformed unicode escape.
    const id = readCSharpIdentifier(src, i);
    if (id) {
      out.push({ name: id.name, start: i, end: id.end });
      i = Math.max(id.end, i + 1);
      continue;
    }
    i++;
  }
  return out;
}

/**
 * Distinct `HttpStatusCode.<Name>` enum members referenced in a span of C#, read with the
 * shared spec-faithful C# identifier lexer ({@link readCSharpQualifiedName}) over the
 * comment/literal-stripped view (so a name in a comment/string is never counted).
 * Requires the EXACT `System.Net.HttpStatusCode` enum token: a bare `HttpStatusCode.<Name>`
 * (via `using System.Net;`), the fully-qualified `System.Net.HttpStatusCode.<Name>`, or a
 * `global::System.Net.HttpStatusCode.<Name>`. The member reference is the segment
 * IMMEDIATELY after `HttpStatusCode`.
 *
 * Exactness (fail-closed against impostors), all handled by the lexer:
 *  - FOREIGN qualifier — `Other.HttpStatusCode.OK` / `MyHttpStatusCode.OK` — is a
 *    different dotted name (HttpStatusCode is not at segment 0, or the name isn't
 *    exactly `HttpStatusCode`), so it is rejected. A NON-`global` `Alias::…` is rejected.
 *  - GLOBAL-ROOTED impostor — `global::HttpStatusCode.OK` names the type `HttpStatusCode`
 *    in the ROOT namespace, which is NOT `System.Net.HttpStatusCode` (a `global::`-rooted
 *    bare name cannot resolve through a `using System.Net;`). So a bare (segment-0)
 *    `HttpStatusCode` is accepted ONLY when the name is NOT `global::`-rooted; when rooted,
 *    the full `System.Net.HttpStatusCode` path is required.
 *  - VERBATIM `@` and Cf format chars — `@HttpStatusCode`/`Http\u200BStatusCode` normalize
 *    to `HttpStatusCode`, so a verbatim/format-char spelling is neither missed nor foreign.
 *  - UNICODE ESCAPES — `Accept\u0065d` decodes to `Accepted`; `Accepted\u0058` decodes to
 *    `AcceptedX` (its own token, never truncated). A MALFORMED `\u12`/PUNCTUATION `\u002E`
 *    escape throws (fail closed) / terminates the identifier respectively.
 *  - ALIAS / SHADOW spoofs (fail closed via {@link assertNoHttpStatusCodeAliasing}) — a
 *    `using HttpStatusCode = <other>;` (or `using System = <other>;` / `using Net = …;`)
 *    alias, a `using static …HttpStatusCode;` import, or a `System` type/namespace DECLARED
 *    in the extract would silently rebind the bare/`System.Net.`-qualified reference to a
 *    DIFFERENT type. Any such construct throws, so `HttpStatusCode.<X>` cannot be spoofed
 *    into counting a foreign type's member.
 */
export function httpStatusCodes(csharp: string, resolutionSource?: string): string[] {
  const src = stripCSharpNoise(csharp);
  // Fail CLOSED if the extract rebinds `HttpStatusCode`/`System` (alias, using-static, a
  // declared `System` type/namespace, or a LOCALLY DECLARED `HttpStatusCode` impostor type),
  // because the reference below could then resolve to a DIFFERENT type than
  // System.Net.HttpStatusCode. When a RESOLUTION SOURCE (the full file the method body came
  // from) is supplied, its aliasing is checked too — a method body cannot see a file-level
  // impostor/alias, so binding to the full file closes that gap.
  assertNoHttpStatusCodeAliasing(src);
  const resSrc = resolutionSource === undefined ? undefined : stripCSharpNoise(resolutionSource);
  if (resSrc !== undefined) assertNoHttpStatusCodeAliasing(resSrc);
  // Positive System.Net resolution for BARE references: a bare `HttpStatusCode.<X>` binds to
  // `System.Net.HttpStatusCode` ONLY when `using System.Net;` is in scope. A method-body-only
  // extract carries NO `using` directives (the ambient file provides them). When a RESOLUTION
  // SOURCE is supplied, resolution is proven against IT (so a bare ref in a method body is only
  // trusted when the FILE imports System.Net) — an unauthenticated bare `HttpStatusCode` in a
  // method-only extract with no resolution source, but whose OWN text imports namespaces without
  // `using System.Net;`, still fails closed. Without a resolution source AND without any imports,
  // the body's bare ref is accepted (legacy behaviour) — pass a resolution source to authenticate.
  const proofSrc = resSrc ?? src;
  const hasUsingSystemNet = /(?<![A-Za-z0-9_])using\s+System\s*\.\s*Net\s*;/.test(proofSrc);
  const hasNamespaceImport = /(?<![A-Za-z0-9_])using\s+(?!static\b)(?:global\s*::\s*)?[A-Za-z_][\w]*(?:\s*\.\s*[A-Za-z_]\w*)*\s*;/.test(proofSrc);
  const requireResolution = resSrc !== undefined || hasNamespaceImport;
  const out = new Set<string>();
  let i = 0;
  while (i < src.length) {
    if (!nameMayStartAt(src, i)) { i++; continue; }
    const q = readCSharpQualifiedName(src, i);
    if (!q) { i++; continue; }
    // Locate `HttpStatusCode` and require it to be either a bare NON-rooted segment 0 (via
    // `using System.Net;`) or preceded by EXACTLY `System.Net` (segments 0,1). A
    // `global::`-rooted bare `HttpStatusCode` (k===0 && q.rooted) is the ROOT-namespace type,
    // NOT `System.Net.HttpStatusCode`, so it is rejected. The member is the next segment.
    const k = q.segments.indexOf('HttpStatusCode');
    const bareViaUsing = k === 0 && !q.rooted;
    const fullyQualified = k === 2 && q.segments[0] === 'System' && q.segments[1] === 'Net';
    if (bareViaUsing && requireResolution && !hasUsingSystemNet) {
      throw new Error(
        'httpStatusCodes: a bare HttpStatusCode reference cannot be proven to resolve to System.Net.HttpStatusCode — no `using System.Net;` in the resolution source (fail closed).',
      );
    }
    const qualified = bareViaUsing || fullyQualified;
    if (qualified && q.segments.length > k + 1) out.add(q.segments[k + 1]!);
    // Consume the whole dotted name so its sub-parts are never re-scanned as fresh starts.
    i = Math.max(q.end, i + 1);
  }
  return [...out];
}

/**
 * FAILS CLOSED when a (comment/string-stripped) extract contains a construct that could
 * rebind `HttpStatusCode` or `System` — so a bare `HttpStatusCode.<X>` or a
 * `System.Net.HttpStatusCode.<X>` cannot silently resolve to a foreign type:
 *   - a USING ALIAS `using [global::]<Alias> = …;` where `<Alias>` is `HttpStatusCode`,
 *     `System`, or `Net` (an alias rebinding the type name or a namespace segment);
 *   - a `using static …;` whose imported type is `HttpStatusCode` (which would bring foreign
 *     enum members into bare scope);
 *   - a `System` NAMESPACE or TYPE declared IN the extract (`namespace … System …`,
 *     `class/struct/record/interface/enum System`) that would shadow the global `System`;
 *   - a LOCALLY DECLARED `HttpStatusCode` type/enum (`class/struct/record/interface/enum
 *     HttpStatusCode`) — a bare `HttpStatusCode.<X>` would bind to that IMPOSTOR, not the
 *     real `System.Net.HttpStatusCode`.
 * The reviewed extracts use only a plain `using System.Net;`, so none of these fire; a decoy
 * that introduces one is rejected rather than mis-authenticated.
 */
export function assertNoHttpStatusCodeAliasing(strippedSrc: string): void {
  // `using [global::]Alias = ... ;` — an alias directive (has `=`), NOT a plain `using ns;`.
  const aliasRe = /(?<![A-Za-z0-9_])using\s+(?:global\s*::\s*)?([A-Za-z_]\w*)\s*=/g;
  let m: RegExpExecArray | null;
  while ((m = aliasRe.exec(strippedSrc)) !== null) {
    const alias = m[1]!;
    if (alias === 'HttpStatusCode' || alias === 'System' || alias === 'Net') {
      throw new Error(
        `httpStatusCodes: extract rebinds '${alias}' via a using-alias directive; a bare/qualified HttpStatusCode reference is ambiguous (fail closed).`,
      );
    }
  }
  // `using static <Qualified>.HttpStatusCode;` — imports the enum's members into bare scope.
  if (/(?<![A-Za-z0-9_])using\s+static\s+[A-Za-z_][\w.\s]*?\.\s*HttpStatusCode\s*;/.test(strippedSrc) ||
      /(?<![A-Za-z0-9_])using\s+static\s+HttpStatusCode\s*;/.test(strippedSrc)) {
    throw new Error('httpStatusCodes: extract uses `using static … HttpStatusCode;`; bare enum members are ambiguous (fail closed).');
  }
  // A DECLARED `System` namespace or type would shadow the global `System`.
  if (/(?<![A-Za-z0-9_])namespace\s+(?:[A-Za-z_][\w]*\s*\.\s*)*System(?![\w])/.test(strippedSrc) ||
      /(?<![A-Za-z0-9_])(?:class|struct|record|interface|enum)\s+System(?![\w])/.test(strippedSrc)) {
    throw new Error('httpStatusCodes: extract declares a `System` namespace/type that could shadow global System (fail closed).');
  }
  // A LOCALLY DECLARED `HttpStatusCode` type/enum is an IMPOSTOR a bare reference would bind to.
  if (/(?<![A-Za-z0-9_])(?:class|struct|record|interface|enum)\s+HttpStatusCode(?![\w])/.test(strippedSrc)) {
    throw new Error('httpStatusCodes: extract declares a local `HttpStatusCode` type/enum; a bare HttpStatusCode reference would bind to that impostor (fail closed).');
  }
}

/**
 * The DECODED value of every C# regular string literal in `csharp`, in source order.
 * Reads the comment-stripped/string-preserved view so a literal inside a comment is never
 * returned, captures each literal escaped-quote-safely (so `"a\"b"` is ONE literal), and
 * DECODES its escapes via {@link decodeCSharpRegularString} — so a header name spelled with
 * unicode escapes (e.g. `"If-\u004Datch"`) is returned as its true value (`If-Match`). Used
 * to authenticate the ABSENCE (or presence) of a HEADER NAME that appears as a STRING (an
 * identifier-only check like {@link csharpReferencesIdentifier} cannot see string content).
 * Verbatim (`@"..."`) and interpolated (`$"..."`) literals are out of scope of the reviewed
 * extracts; a `@`/`$` before the `"` is not consumed by the pattern, so those bodies are
 * read as regular literals — acceptable here because the header names of interest contain no
 * escape whose meaning differs between the two forms.
 */
export function csharpStringLiterals(csharp: string): string[] {
  const src = commentStrippedCSharp(csharp);
  return decodedStringLiteralsFollowing(src, new RegExp(`"${CS_STRING_BODY}"`, 'g'));
}

/**
 * True iff any CONSTANT integer expression in `text` evaluates to `target`, or contains a
 * sub-expression equal to `target`. A tiny recursive-descent evaluator parses `+ - * / %`,
 * parentheses, unary sign, integer literals ({@link readCSharpIntegerLiteral}), and — when a
 * `constants` map is supplied — NAMED integer constants (so `const int P = 412; … P …`
 * resolves). It records the value of EVERY sub-expression, so both `(400 + 12)` and a bare
 * `412` are caught. A run that references an UNKNOWN identifier (non-constant) fails to parse
 * there and is skipped — so a status expression built from an opaque variable is not spoofed.
 */
function constantIntegerExpressionEquals(text: string, target: number, constants?: ReadonlyMap<string, number>): boolean {
  const src = text;
  const n = src.length;
  const isIdent = (c: string | undefined): boolean => c !== undefined && /[A-Za-z0-9_]/.test(c);
  let pos = 0;
  const skipWs = (): void => { while (pos < n && /\s/.test(src[pos]!)) pos++; };
  const parsePrimary = (vals: number[]): number | null => {
    skipWs();
    const c = src[pos];
    if (c === '(') {
      pos++;
      const v = parseBitOr(vals);
      skipWs();
      if (src[pos] !== ')') return null;
      pos++;
      if (v !== null) vals.push(v);
      return v;
    }
    if (c === '+' || c === '-') {
      pos++;
      const v = parsePrimary(vals);
      if (v === null) return null;
      const r = c === '-' ? -v : v;
      vals.push(r);
      return r;
    }
    if (c === '~') {
      // Bitwise complement (C# `~`) — a unary constant operator (pass 46 finding #6).
      pos++;
      const v = parsePrimary(vals);
      if (v === null) return null;
      const r = ~v;
      vals.push(r);
      return r;
    }
    // A NAMED integer constant (resolved from `constants`), when the identifier is known.
    if (constants && c !== undefined && /[A-Za-z_]/.test(c)) {
      let k = pos;
      while (k < n && /[A-Za-z0-9_]/.test(src[k]!)) k++;
      const name = src.slice(pos, k);
      if (constants.has(name)) {
        pos = k;
        const v = constants.get(name)!;
        vals.push(v);
        return v;
      }
      return null; // an unknown identifier -> non-constant; caller skips this run
    }
    const lit = readCSharpIntegerLiteral(src, pos);
    if (lit === null) return null;
    pos = lit.end;
    vals.push(lit.value);
    return lit.value;
  };
  const parseMul = (vals: number[]): number | null => {
    let v = parsePrimary(vals);
    if (v === null) return null;
    for (;;) {
      skipWs();
      const op = src[pos];
      if (op === '*' || op === '/' || op === '%') {
        pos++;
        const rhs = parsePrimary(vals);
        if (rhs === null) return null;
        if (op === '*') v = v * rhs;
        else if (op === '/') v = rhs === 0 ? NaN : Math.trunc(v / rhs);
        else v = rhs === 0 ? NaN : v % rhs;
        vals.push(v);
      } else break;
    }
    return v;
  };
  function parseAdd(vals: number[]): number | null {
    let v = parseMul(vals);
    if (v === null) return null;
    for (;;) {
      skipWs();
      const op = src[pos];
      if (op === '+' || op === '-') {
        pos++;
        const rhs = parseMul(vals);
        if (rhs === null) return null;
        v = op === '+' ? v + rhs : v - rhs;
        vals.push(v);
      } else break;
    }
    return v;
  }
  // SHIFT has LOWER precedence than additive in C# (`<<`/`>>`/`>>>` bind looser than `+`/`-`), so a
  // status like `(HttpStatusCode)(103 << 2)` (== 412) is evaluated. The DOUBLE `<<`/`>>` and the
  // C# 11 UNSIGNED-right `>>>` operators are consumed; a single `<`/`>` (comparison/generic) stops
  // the parse (pass 47 finding #6 — unsigned shift).
  function parseShift(vals: number[]): number | null {
    let v = parseAdd(vals);
    if (v === null) return null;
    for (;;) {
      skipWs();
      const op = src[pos];
      const ushr = op === '>' && src[pos + 1] === '>' && src[pos + 2] === '>';
      if (ushr || (op === '<' && src[pos + 1] === '<') || (op === '>' && src[pos + 1] === '>')) {
        const shl = op === '<';
        pos += ushr ? 3 : 2;
        const rhs = parseAdd(vals);
        if (rhs === null) return null;
        // 32-bit shift semantics (C# int); the magnitudes here are tiny so this is exact.
        v = ushr ? (v >>> rhs) : shl ? (v << rhs) : (v >> rhs);
        vals.push(v);
      } else break;
    }
    return v;
  }
  // BITWISE levels, in C# precedence (loosest to tightest above shift): `&` binds tighter than
  // `^`, which binds tighter than `|` — all looser than shift. So a status like
  // `(HttpStatusCode)(0x1A0 ^ 0xC)` (== 412) or `(0x180 | 0x1C)` (== 412) is evaluated exactly
  // rather than left for the conservative fallback (pass 46 finding #6 — additional const ops).
  function parseBitAnd(vals: number[]): number | null {
    let v = parseShift(vals);
    if (v === null) return null;
    for (;;) {
      skipWs();
      // A SINGLE `&` (not the logical `&&`).
      if (src[pos] === '&' && src[pos + 1] !== '&') {
        pos++;
        const rhs = parseShift(vals);
        if (rhs === null) return null;
        v = v & rhs;
        vals.push(v);
      } else break;
    }
    return v;
  }
  function parseBitXor(vals: number[]): number | null {
    let v = parseBitAnd(vals);
    if (v === null) return null;
    for (;;) {
      skipWs();
      if (src[pos] === '^') {
        pos++;
        const rhs = parseBitAnd(vals);
        if (rhs === null) return null;
        v = v ^ rhs;
        vals.push(v);
      } else break;
    }
    return v;
  }
  function parseBitOr(vals: number[]): number | null {
    let v = parseBitXor(vals);
    if (v === null) return null;
    for (;;) {
      skipWs();
      // A SINGLE `|` (not the logical `||`).
      if (src[pos] === '|' && src[pos + 1] !== '|') {
        pos++;
        const rhs = parseBitXor(vals);
        if (rhs === null) return null;
        v = v | rhs;
        vals.push(v);
      } else break;
    }
    return v;
  }
  for (let i = 0; i < n; i++) {
    const c = src[i]!;
    if (!(c === '(' || c === '+' || c === '-' || c === '~' || /[0-9]/.test(c) || (constants && /[A-Za-z_]/.test(c)))) continue;
    const prev = i > 0 ? src[i - 1] : undefined;
    if (isIdent(prev) || prev === '.') continue; // part of a larger identifier / member / float
    pos = i;
    const vals: number[] = [];
    parseBitOr(vals);
    if (vals.some((x) => x === target)) return true;
    i = Math.max(i, pos - 1); // advance past the consumed region
  }
  return false;
}

/** The C# INTEGRAL type keywords a named integer constant may be declared with (a `const long`,
 *  `const byte`, `const uint`, … all hold an integral status value), so a 412 constant declared as
 *  a non-`int` integral type is still resolved (pass 48 finding #6). */
const INTEGRAL_TYPE_KEYWORDS = new Set([
  'int', 'long', 'short', 'byte', 'sbyte', 'uint', 'ulong', 'ushort', 'nint', 'nuint', 'char',
  'Int32', 'Int64', 'Int16', 'Byte', 'SByte', 'UInt32', 'UInt64', 'UInt16', 'IntPtr', 'UIntPtr',
]);

/** Read a dotted MEMBER-ACCESS chain (`A.B.Leaf`, whitespace-insensitive around the dots) starting
 *  at `i`, returning the LEAF segment name (spec-normalized via the identifier lexer, so an escaped
 *  spelling resolves) and the end index, or null. Used so a member constant reference
 *  (`Constants.PreconditionFailed`) resolves to its leaf name (pass 48 finding #6). */
function readMemberChainLeaf(src: string, i: number): { leaf: string; end: number } | null {
  const chain = readMemberChain(src, i);
  if (!chain) return null;
  return { leaf: chain.segments[chain.segments.length - 1]!, end: chain.end };
}

/** Read a dotted MEMBER-ACCESS chain and return ALL its normalized segments (so both the LEAF and
 *  a QUALIFIED `Container.Member` lookup are possible — closing the scope-incorrectness of a
 *  leaf-only resolution, pass 49 finding #6). A leading `global::` qualifier is dropped. */
function readMemberChain(src: string, i: number): { segments: string[]; end: number } | null {
  let j = i;
  // Drop a leading `global::`.
  const g = readCSharpIdentifier(src, j);
  if (g && g.name === 'global' && src[g.end] === ':' && src[g.end + 1] === ':') j = g.end + 2;
  const first = readCSharpIdentifier(src, j);
  if (!first) return null;
  const segments = [first.name];
  let end = first.end;
  for (;;) {
    let t = end;
    while (t < src.length && /\s/.test(src[t]!)) t++;
    if (src[t] !== '.') break;
    let u = t + 1;
    while (u < src.length && /\s/.test(src[u]!)) u++;
    const next = readCSharpIdentifier(src, u);
    if (!next) break;
    segments.push(next.name);
    end = next.end;
  }
  return { segments, end };
}

/** The nearest enclosing TYPE name (`class`/`struct`/`record`/`enum`/`interface <Name>`) whose body
 *  brace opens before `idx` and closes after it, or null. Used to build a QUALIFIED
 *  `Container.Member` key for a member constant so a same-named constant in ANOTHER type is not
 *  wrongly resolved (scope-aware, pass 49 finding #6). */
function nearestEnclosingTypeName(strippedSrc: string, idx: number): string | null {
  const re = /(?<![A-Za-z0-9_])(?:class|struct|record|enum|interface)\s+([A-Za-z_]\w*)/g;
  let m: RegExpExecArray | null;
  let best: string | null = null;
  while ((m = re.exec(strippedSrc)) !== null) {
    if (m.index >= idx) break;
    // The type's body `{` after the name; find its matching `}` and check idx is inside.
    const brace = strippedSrc.indexOf('{', m.index + m[0].length);
    if (brace < 0 || brace > idx) continue;
    let d = 0;
    let close = -1;
    for (let j = brace; j < strippedSrc.length; j++) {
      if (strippedSrc[j] === '{') d++;
      else if (strippedSrc[j] === '}') { d--; if (d === 0) { close = j; break; } }
    }
    if (close < 0 || close > idx) best = m[1]!; // idx is inside this type (or type unterminated)
  }
  return best;
}

/** The static-constructor body span `{start,end}` (brace-exclusive) for the type named `typeName`
 *  when `memberIdx` sits inside SOME declaration of that type, or null. A `static readonly` field
 *  with no inline initializer can ONLY be assigned in the type's static constructor, so its value
 *  MUST be resolved there. A PARTIAL type has SEVERAL declaration bodies and its single static
 *  constructor may live in a DIFFERENT partial part than the field, so ALL bodies named `typeName`
 *  are searched for the `static <typeName>()` ctor (pass 52 finding #6) — while `memberIdx` must
 *  still be inside one of those bodies (scope correctness: a same-named field/ctor in ANOTHER type
 *  is not used). Input MUST be comment/literal-stripped. */
function staticConstructorBody(strippedSrc: string, typeName: string, memberIdx: number): { start: number; end: number } | null {
  const escType = typeName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const typeRe = new RegExp(`(?<![A-Za-z0-9_])(?:class|struct|record)\\s+${escType}(?![A-Za-z0-9_])`, 'g');
  const bodies: Array<{ start: number; end: number }> = [];
  let tm: RegExpExecArray | null;
  while ((tm = typeRe.exec(strippedSrc)) !== null) {
    const brace = strippedSrc.indexOf('{', tm.index + tm[0].length);
    if (brace < 0) continue;
    let d = 0;
    let close = -1;
    for (let j = brace; j < strippedSrc.length; j++) {
      if (strippedSrc[j] === '{') d++;
      else if (strippedSrc[j] === '}') { d--; if (d === 0) { close = j; break; } }
    }
    if (close < 0) continue;
    bodies.push({ start: brace, end: close });
  }
  // Scope: `memberIdx` (the field) must be inside SOME body of this type.
  if (!bodies.some((b) => memberIdx > b.start && memberIdx < b.end)) return null;
  // Find the parameterless static constructor `static <typeName> ( ) {` in ANY body of this type.
  const ctorRe = new RegExp(`(?<![A-Za-z0-9_])static\\s+${escType}\\s*\\(\\s*\\)\\s*\\{`, 'g');
  for (const body of bodies) {
    ctorRe.lastIndex = body.start;
    const cm = ctorRe.exec(strippedSrc);
    if (!cm || cm.index >= body.end) continue;
    const ctorBrace = cm.index + cm[0].length - 1; // index of the ctor body `{`
    let cd = 0;
    let cclose = -1;
    for (let j = ctorBrace; j < strippedSrc.length; j++) {
      if (strippedSrc[j] === '{') cd++;
      else if (strippedSrc[j] === '}') { cd--; if (cd === 0) { cclose = j; break; } }
    }
    if (cclose < 0) continue;
    return { start: ctorBrace + 1, end: cclose };
  }
  return null;
}

/** True iff the statement CONTAINING the assignment at `index` (already known to be at brace-depth
 *  0) is the single-statement BODY of a BRACELESS conditional/loop header — `if (…)`, `else`,
 *  `else if (…)`, `while (…)`, `for (…)`, `foreach (…)`, `using (…)`, `lock (…)`, or `fixed (…)` —
 *  so it does NOT execute unconditionally. C# permits a braceless body, so `if (strict) Pf = 412;`
 *  places the assignment at brace-depth 0 yet only runs CONDITIONALLY; treating brace depth as
 *  conditional depth would mis-classify it as an unconditional overwrite (pass 54 finding R1). Scans
 *  back to the nearest depth-0 statement boundary (`;`/`{`/`}`, paren/bracket-aware) and inspects
 *  the statement PREFIX. Input MUST be comment/literal-stripped. */
function isBracelessConditionalBody(src: string, index: number): boolean {
  let depth = 0;
  let b = index - 1;
  for (; b >= 0; b--) {
    const c = src[b]!;
    if (c === ')' || c === ']') depth++;
    else if (c === '(' || c === '[') { if (depth > 0) depth--; }
    else if (depth === 0 && (c === ';' || c === '{' || c === '}')) break;
  }
  const prefix = src.slice(b + 1, index).trim();
  if (prefix.length === 0) return false;
  // The statement prefix is the braceless control HEADER: a `keyword (…)` ending the prefix, or a
  // bare `else`.
  if (/(?:^|[^A-Za-z0-9_])(?:if|while|for|foreach|using|lock|fixed)\s*\([\s\S]*\)$/.test(prefix)) return true;
  if (/(?:^|[^A-Za-z0-9_])else$/.test(prefix)) return true;
  return false;
}

/** Named integer constants — a compile-time `const <integral>`, a `static readonly <integral>`
 *  field (a runtime constant commonly used for status codes), OR an ENUM member — mapped by BOTH
 *  the LEAF name and a QUALIFIED `Container.Member` key (so `Constants.Pf`/`Codes.Pf` resolve
 *  precisely, not by any same-named leaf — scope-aware, pass 49 finding #6). Handles NON-`int`
 *  integral types and ESCAPED/verbatim names. Only resolvable constant initializers are recorded;
 *  resolution is TRANSITIVE (a fixpoint lets one reference another). Enum members support implicit
 *  auto-increment values. Parsed from the comment/literal-stripped view. */
function collectIntConstants(strippedSrc: string): Map<string, number> {
  const out = new Map<string, number>();
  const toks = csharpIdentifierTokens(strippedSrc);
  const decls: Array<{ name: string; qualified: string | null; expr: string; candidates?: string[] }> = [];
  // (1) const / static-readonly integral fields. A decl is `<modifiers…> <integral> NAME = <expr>;`
  // where the modifier run contains `const`, or BOTH `static` and `readonly`.
  const MOD = new Set(['public', 'private', 'protected', 'internal', 'static', 'readonly', 'const', 'volatile', 'new', 'sealed', 'extern', 'unsafe']);
  for (let i = 0; i < toks.length; i++) {
    if (!MOD.has(toks[i]!.name)) continue;
    // Only START at a modifier that BEGINS a modifier run (the previous significant char is a
    // statement boundary), so we do not re-scan the same decl from an interior modifier.
    let pb = toks[i]!.start - 1;
    while (pb >= 0 && /\s/.test(strippedSrc[pb]!)) pb--;
    if (!(pb < 0 || strippedSrc[pb] === ';' || strippedSrc[pb] === '{' || strippedSrc[pb] === '}')) continue;
    // Consume the modifier run.
    let k = i;
    const mods = new Set<string>();
    while (k < toks.length && MOD.has(toks[k]!.name)) { mods.add(toks[k]!.name); k++; }
    const isConstLike = mods.has('const') || (mods.has('static') && mods.has('readonly'));
    if (!isConstLike || k >= toks.length) continue;
    // The type (possibly qualified) then the NAME.
    const typeChain = readMemberChainLeaf(strippedSrc, toks[k]!.start);
    if (!typeChain || !INTEGRAL_TYPE_KEYWORDS.has(typeChain.leaf)) continue;
    let ni = k;
    while (ni < toks.length && toks[ni]!.start < typeChain.end) ni++;
    const nameTok = toks[ni];
    if (!nameTok) continue;
    let q = nameTok.end;
    while (q < strippedSrc.length && /\s/.test(strippedSrc[q]!)) q++;
    const container = nearestEnclosingTypeName(strippedSrc, nameTok.start);
    if (strippedSrc[q] === '=' && strippedSrc[q + 1] !== '=' && strippedSrc[q + 1] !== '>') {
      // Inline initializer `NAME = <expr>;`.
      const semi = strippedSrc.indexOf(';', q + 1);
      if (semi < 0) continue;
      decls.push({ name: nameTok.name, qualified: container ? `${container}.${nameTok.name}` : null, expr: strippedSrc.slice(q + 1, semi).trim() });
    } else if (strippedSrc[q] === ';' && mods.has('static') && mods.has('readonly')) {
      // A `static readonly <integral> NAME;` field with NO inline initializer — it can ONLY be
      // assigned in the DECLARING TYPE's STATIC CONSTRUCTOR (or left default). Scope the search to
      // that static-ctor body (pass 51 finding #5: not "anywhere in source", which both false-
      // positively matched same-named assignments elsewhere and false-negatively missed qualified
      // `<DeclaringType>.NAME = …` forms). Bind BARE and DECLARING-TYPE-QUALIFIED assignments.
      if (!container) continue; // no declaring type → cannot scope a static ctor
      const ctor = staticConstructorBody(strippedSrc, container, nameTok.start);
      if (!ctor) continue;
      const ctorText = strippedSrc.slice(ctor.start, ctor.end);
      const escName = nameTok.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const escType = container.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // A static ctor may assign the field on SEVERAL paths. Read every assignment with its
      // brace-depth RELATIVE to the ctor body, then decide fail-closed (this is an HTTP-412 status
      // detector): a DEPTH-0 (unconditional) assignment OVERWRITES all earlier ones (last-write-
      // wins, pass 52 finding #6), but any assignment REACHABLE AFTER the last unconditional one —
      // i.e. inside a later conditional BRANCH (depth > 0) — is a possible runtime value. So the
      // CANDIDATE set is the last unconditional assignment plus every assignment after it (and, if
      // there is NO unconditional assignment, every branch assignment). A reachable branch that
      // assigns 412 is therefore not masked by a textually-later non-412 assignment (pass 53
      // finding #6).
      const asgnRe = new RegExp(`(?<![A-Za-z0-9_.])(?:${escType}\\s*\\.\\s*)?${escName}\\s*=(?![=>])([^;]+);`, 'g');
      let am: RegExpExecArray | null;
      const hits: Array<{ index: number; unconditional: boolean; expr: string }> = [];
      let depth = 0;
      let scanFrom = 0;
      while ((am = asgnRe.exec(ctorText)) !== null) {
        for (let z = scanFrom; z < am.index; z++) { if (ctorText[z] === '{') depth++; else if (ctorText[z] === '}') depth--; }
        scanFrom = am.index;
        // An assignment executes UNCONDITIONALLY only when it is at brace-depth 0 AND is not the
        // single-statement BODY of a BRACELESS conditional/loop header (`if (…) Pf = 412;`). C#
        // allows a braceless body, so BRACE depth alone mis-classifies `if (strict) Pf = 412; else
        // Pf = 428;` (both at brace-depth 0) as unconditional and discards the reachable 412
        // candidate (pass 54 finding R1).
        const unconditional = depth === 0 && !isBracelessConditionalBody(ctorText, am.index);
        hits.push({ index: am.index, unconditional, expr: am[1]!.trim() });
      }
      if (hits.length === 0) continue;
      let lastUncond = -1;
      for (let z = 0; z < hits.length; z++) if (hits[z]!.unconditional) lastUncond = z;
      const candidates = lastUncond >= 0 ? hits.slice(lastUncond).map((h) => h.expr) : hits.map((h) => h.expr);
      const baseline = candidates[candidates.length - 1]!;
      decls.push({ name: nameTok.name, qualified: `${container}.${nameTok.name}`, expr: baseline, candidates });
    }
  }
  // (2) enum members: `enum <Name> { M0, M1 = <expr>, … }`. Values auto-increment from the last
  // explicit value (default start 0). Store both `M` and `Name.M`.
  const enumRe = /(?<![A-Za-z0-9_])enum\s+([A-Za-z_]\w*)(?:\s*:\s*[A-Za-z_][\w.]*)?\s*\{/g;
  let em: RegExpExecArray | null;
  while ((em = enumRe.exec(strippedSrc)) !== null) {
    const enumName = em[1]!;
    const brace = strippedSrc.indexOf('{', em.index);
    let d = 0;
    let close = -1;
    for (let j = brace; j < strippedSrc.length; j++) {
      if (strippedSrc[j] === '{') d++;
      else if (strippedSrc[j] === '}') { d--; if (d === 0) { close = j; break; } }
    }
    if (close < 0) continue;
    const body = strippedSrc.slice(brace + 1, close);
    let auto = 0;
    for (const member of splitTopLevelArgs(body)) {
      const mm = /^\s*([A-Za-z_]\w*)\s*(?:=\s*(.+))?$/.exec(member.trim());
      if (!mm) { continue; }
      let val: number | null;
      if (mm[2] !== undefined) val = evalSingleConstantInteger(mm[2]!.trim(), out);
      else val = auto;
      if (val !== null) {
        out.set(mm[1]!, val);
        out.set(`${enumName}.${mm[1]!}`, val);
        auto = val + 1;
      } else {
        auto = auto + 1; // unknown explicit value: keep incrementing conservatively
      }
    }
  }
  // FIXPOINT for the const/static-readonly declarations (transitive/forward references).
  let changed = true;
  while (changed) {
    changed = false;
    for (const { name, qualified, expr, candidates } of decls) {
      if (out.has(name) && (qualified === null || out.has(qualified))) continue;
      let v: number | null;
      if (candidates && candidates.length > 1) {
        // Branched static-ctor field: fail closed toward the sensitive HTTP-412 status. If ANY
        // reachable candidate resolves to 412, the field is 412; otherwise, once EVERY candidate is
        // resolvable, use the last-write baseline. If some candidate is not yet resolvable (forward
        // reference), defer to a later fixpoint iteration.
        const resolved = candidates.map((c) => evalSingleConstantInteger(c, out));
        if (resolved.some((x) => x === 412)) v = 412;
        else if (resolved.every((x) => x !== null)) v = evalSingleConstantInteger(expr, out);
        else v = null;
      } else {
        v = evalSingleConstantInteger(expr, out);
      }
      if (v !== null) {
        if (!out.has(name)) { out.set(name, v); changed = true; }
        if (qualified && !out.has(qualified)) { out.set(qualified, v); changed = true; }
      }
    }
  }
  return out;
}

/** Evaluate a WHOLE expression string as a single constant integer, or null if it is not a
 *  pure integer-constant expression. Supports decimal/hex literals, unary `+ - ~`, `* / %`,
 *  `+ -`, shift `<< >>`, and bitwise `& ^ |`, parens, and — when a `constants` map is supplied —
 *  NAMED integer constants (so a transitively-defined `const int` resolves). */
function evalSingleConstantInteger(expr: string, constants?: ReadonlyMap<string, number>): number | null {
  const src = expr.trim();
  const n = src.length;
  let pos = 0;
  const skipWs = (): void => { while (pos < n && /\s/.test(src[pos]!)) pos++; };
  const primary = (): number | null => {
    skipWs();
    const c = src[pos];
    if (c === '(') {
      // A CAST to an integral type — `(int)`, `(long)`, `(byte)`, `(System.Int32)`, … — is
      // skipped so `(HttpStatusCode)(int)412` / `(long)412` evaluates to its integral value
      // (pass 48 finding #6). Otherwise it is a parenthesized sub-expression.
      const save = pos;
      pos++;
      skipWs();
      const typeChain = readMemberChainLeaf(src, pos);
      if (typeChain && INTEGRAL_TYPE_KEYWORDS.has(typeChain.leaf)) {
        let t = typeChain.end;
        while (t < n && /\s/.test(src[t]!)) t++;
        if (src[t] === ')') { pos = t + 1; return primary(); } // consume the cast, parse the value
      }
      pos = save + 1;
      const v = bitOr(); skipWs(); if (src[pos] !== ')') return null; pos++; return v;
    }
    if (c === '+' || c === '-') { pos++; const v = primary(); return v === null ? null : (c === '-' ? -v : v); }
    if (c === '~') { pos++; const v = primary(); return v === null ? null : ~v; }
    // A NAMED integer constant (possibly a MEMBER-access `Container.NAME` or an ESCAPED spelling).
    // Resolve the QUALIFIED path first (`Container.NAME`, scope-correct) then fall back to the LEAF
    // (a bare reference) — closing the leaf-only scope hole (pass 48 finding #6, pass 49 finding #6).
    if (constants && c !== undefined && (/[A-Za-z_@\\]/.test(c))) {
      const chain = readMemberChain(src, pos);
      if (chain) {
        const full = chain.segments.join('.');
        const leaf = chain.segments[chain.segments.length - 1]!;
        if (chain.segments.length >= 2 && constants.has(full)) { pos = chain.end; return constants.get(full)!; }
        // A qualified member-access whose FULL key is unknown but whose Container.Member is tracked
        // for a DIFFERENT container must NOT resolve by leaf (scope-incorrect) — try the last two
        // segments as the qualified key, else fall back to leaf ONLY for a BARE (single-segment) ref.
        if (chain.segments.length >= 2) {
          const tail = chain.segments.slice(-2).join('.');
          if (constants.has(tail)) { pos = chain.end; return constants.get(tail)!; }
          pos = chain.end; return null; // qualified but unknown container.member -> not resolvable
        }
        if (constants.has(leaf)) { pos = chain.end; return constants.get(leaf)!; }
        pos = chain.end; return null; // an unknown identifier -> not a resolvable constant
      }
      return null;
    }
    const lit = readCSharpIntegerLiteral(src, pos);
    if (lit === null) return null;
    pos = lit.end;
    return lit.value;
  };
  const mul = (): number | null => {
    let v = primary(); if (v === null) return null;
    for (;;) { skipWs(); const op = src[pos];
      if (op === '*' || op === '/' || op === '%') { pos++; const r = primary(); if (r === null) return null;
        v = op === '*' ? v * r : op === '/' ? (r === 0 ? NaN : Math.trunc(v / r)) : (r === 0 ? NaN : v % r); }
      else break; }
    return v;
  };
  function add(): number | null {
    let v = mul(); if (v === null) return null;
    for (;;) { skipWs(); const op = src[pos];
      if (op === '+' || op === '-') { pos++; const r = mul(); if (r === null) return null; v = op === '+' ? v + r : v - r; }
      else break; }
    return v;
  }
  function shift(): number | null {
    let v = add(); if (v === null) return null;
    for (;;) { skipWs(); const op = src[pos];
      const ushr = op === '>' && src[pos + 1] === '>' && src[pos + 2] === '>';
      if (ushr || (op === '<' && src[pos + 1] === '<') || (op === '>' && src[pos + 1] === '>')) {
        const shl = op === '<'; pos += ushr ? 3 : 2; const r = add(); if (r === null) return null;
        v = ushr ? (v >>> r) : shl ? (v << r) : (v >> r); }
      else break; }
    return v;
  }
  function bitAnd(): number | null {
    let v = shift(); if (v === null) return null;
    for (;;) { skipWs(); if (src[pos] === '&' && src[pos + 1] !== '&') { pos++; const r = shift(); if (r === null) return null; v = v & r; } else break; }
    return v;
  }
  function bitXor(): number | null {
    let v = bitAnd(); if (v === null) return null;
    for (;;) { skipWs(); if (src[pos] === '^') { pos++; const r = bitAnd(); if (r === null) return null; v = v ^ r; } else break; }
    return v;
  }
  function bitOr(): number | null {
    let v = bitXor(); if (v === null) return null;
    for (;;) { skipWs(); if (src[pos] === '|' && src[pos + 1] !== '|') { pos++; const r = bitXor(); if (r === null) return null; v = v | r; } else break; }
    return v;
  }
  const val = bitOr();
  skipWs();
  return pos === n && val !== null && Number.isFinite(val) ? val : null;
}

/**
 * True iff the C# produces HTTP status 412 (Precondition Failed) in a STATUS CONTEXT — the
 * status a precondition-HONORING service returns. Detection is BOUND to status-producing
 * expressions (not any arithmetic anywhere), so an unrelated `412` constant elsewhere is not
 * flagged and a genuine computed 412 status is not missed:
 *   - SYMBOLIC `HttpStatusCode.PreconditionFailed` (via {@link httpStatusCodes}, so an
 *     escaped/verbatim spelling is normalized);
 *   - the CANONICAL ASP.NET Core constant `StatusCodes.Status412PreconditionFailed` (== 412);
 *   - a CAST to the status enum: `(HttpStatusCode)<expr>` / `(System.Net.HttpStatusCode)<expr>`;
 *   - a `StatusCode(<expr>)` / `.StatusCode(<expr>)` / `StatusCodeResult(<expr>)` call, or a
 *     `StatusCode = <expr>` assignment.
 * The `<expr>` operand is evaluated as a constant integer expression WITH named-`const int`
 * resolution ({@link collectIntConstants}), so decimal/hex/arithmetic/SHIFT AND a named 412
 * constant are caught, while `4120`/`0x1234`/`400 + 13` and any 412 outside a status context are
 * not.
 */
export function csharpReferencesHttp412(csharp: string, resolutionSource?: string): boolean {
  if (httpStatusCodes(csharp, resolutionSource).includes('PreconditionFailed')) return true;
  const src = stripCSharpNoise(csharp);
  // The canonical ASP.NET Core 412 constant (Microsoft.AspNetCore.Http.StatusCodes) is a named
  // status value equal to 412 — a status context by construction.
  if (/(?<![A-Za-z0-9_])Status412PreconditionFailed(?![A-Za-z0-9_])/.test(src)) return true;
  // Named integer constants are collected from the extract itself AND — when provided — the
  // RESOLUTION SOURCE (the full file a method-only extract came from), so a status built from a
  // constant DEFINED ELSEWHERE in the file (e.g. `const int Pf = 412;` at class scope, used as
  // `StatusCode(Pf)` in the method extract) is resolved. Local (extract) definitions overlay the
  // resolution-source ones so a same-named local shadows correctly (pass 47 finding #6).
  const constants = new Map<string, number>();
  if (resolutionSource !== undefined) {
    for (const [k, v] of collectIntConstants(stripCSharpNoise(resolutionSource))) constants.set(k, v);
  }
  for (const [k, v] of collectIntConstants(src)) constants.set(k, v);
  const operandIsHttp412 = (operand: string): boolean => {
    // Prefer an EXACT whole-operand evaluation (now supporting shift + bitwise + transitive
    // named constants), so a computed non-412 (e.g. `0x1 ^ 0x2`) is not over-flagged and a
    // computed 412 (e.g. `0x1A0 ^ 0xC`) is caught precisely (pass 46 finding #6).
    const exact = evalSingleConstantInteger(operand.trim(), constants);
    if (exact !== null) return exact === 412;
    // Otherwise fall back to the token-scanning equality (for a mixed cast/number operand) and,
    // last, the conservative unsupported-operator shape check (fail closed on an unprovable value).
    return constantIntegerExpressionEquals(operand, 412, constants) || operandHasUnsupportedConstOp(operand);
  };

  // (a) Cast to the status enum: `(HttpStatusCode)`, `(System.Net.HttpStatusCode)`, or a
  // `global::`-qualified spelling, then the operand up to the next top-level terminator.
  const castRe = /\(\s*(?:global\s*::\s*)?(?:System\s*\.\s*Net\s*\.\s*)?HttpStatusCode\s*\)/g;
  let cm: RegExpExecArray | null;
  while ((cm = castRe.exec(src)) !== null) {
    const operand = readOperandUntilTerminator(src, cm.index + cm[0].length);
    if (operandIsHttp412(operand)) return true;
  }
  // (b) StatusCode(...) / .StatusCode(...) / StatusCodeResult(...) call args.
  const callRe = /(?<![A-Za-z0-9_])(?:StatusCodeResult|StatusCode)\s*\(/g;
  let km: RegExpExecArray | null;
  while ((km = callRe.exec(src)) !== null) {
    const parenIdx = km.index + km[0].length - 1;
    const args = readBalancedParens(src, parenIdx);
    if (args !== null && operandIsHttp412(args)) return true;
  }
  // (c) StatusCode = <expr>; assignment (single `=`, not `==`).
  const assignRe = /(?<![A-Za-z0-9_])StatusCode\s*=\s*([^;=][^;]*);/g;
  let am: RegExpExecArray | null;
  while ((am = assignRe.exec(src)) !== null) {
    if (operandIsHttp412(am[1]!)) return true;
  }
  // (d) NAMED-ARGUMENT status forms: `statusCode: <operand>` / `status: <operand>` /
  // `httpStatusCode: <operand>` in an argument slot (preceded by `(` or `,`), reading the operand
  // to the next top-level terminator. This catches a status expressed as a named argument (e.g.
  // `StatusCode(statusCode: 412)` / `AcceptedAsyncOperation(statusCode: (HttpStatusCode)412)`)
  // that the positional cast/call rules alone could miss. A non-412 named status (e.g.
  // `statusCode: HttpStatusCode.Accepted`) evaluates to not-412 and is not flagged.
  const namedRe = /(?<![A-Za-z0-9_])(?:statusCode|status|httpStatusCode)\s*:/gi;
  let nm: RegExpExecArray | null;
  while ((nm = namedRe.exec(src)) !== null) {
    if (src[nm.index + nm[0].length] === ':') continue; // `::` namespace separator, not a named arg
    // Must be an argument slot: the char before the name is `(` or `,`.
    let p = nm.index - 1;
    while (p >= 0 && /\s/.test(src[p]!)) p--;
    if (p < 0 || (src[p] !== '(' && src[p] !== ',')) continue;
    const operand = readOperandUntilTerminator(src, nm.index + nm[0].length);
    if (operandIsHttp412(operand)) return true;
  }
  return false;
}

/**
 * True iff `operand` is a CONSTANT-INTEGER-SHAPED expression that contains a bitwise operator the
 * constant evaluator does NOT support (`^` XOR, or a lone `&`/`|`/`~` — not the logical `&&`/`||`),
 * so its value cannot be computed. Used CONSERVATIVELY inside a STATUS CONTEXT: because
 * {@link csharpReferencesHttp412} asserts the ABSENCE of 412, an operand we cannot prove is NOT 412
 * (e.g. `(HttpStatusCode)(0x1A0 ^ 0xC)` == 412, which the evaluator would misread) is treated as a
 * POSSIBLE 412 and flagged (fail closed). Only fires for a constant-expression SHAPE — digits, hex,
 * whitespace, and arithmetic/bitwise operators/parens, with no method call or member access — so a
 * legitimate non-constant `(HttpStatusCode)someFlags` (opaque variable) is NOT flagged here.
 */
function operandHasUnsupportedConstOp(operand: string): boolean {
  const t = operand.trim();
  if (t.length === 0) return false;
  // Must contain at least one digit (a constant expression) and an UNSUPPORTED bitwise operator:
  // `^` (XOR), or a SINGLE `&`/`|` (not `&&`/`||`), or `~` (bitwise complement).
  if (!/[0-9]/.test(t)) return false;
  const hasXor = /\^/.test(t);
  const hasSingleAnd = /(?<!&)&(?!&)/.test(t);
  const hasSingleOr = /(?<!\|)\|(?!\|)/.test(t);
  const hasComplement = /~/.test(t);
  if (!(hasXor || hasSingleAnd || hasSingleOr || hasComplement)) return false;
  // CONSTANT-EXPRESSION SHAPE ONLY: allow digits, hex (`0x…`), whitespace, and the arithmetic /
  // bitwise operator + paren charset. A method call, member access (`.`), or non-hex identifier
  // means it is NOT a pure constant expression, so we do NOT conservatively flag it.
  return /^[0-9a-fA-FxX_\s+\-*/%()<>^&|~]+$/.test(t);
}

/** The operand substring starting at `from`, up to (excluding) the next TOP-LEVEL terminator
 *  among `; , ) ] }` (respecting nested `() [] {}`). Used to bound a cast operand. */
function readOperandUntilTerminator(src: string, from: number): string {
  let depth = 0;
  for (let j = from; j < src.length; j++) {
    const ch = src[j]!;
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') { if (depth === 0) return src.slice(from, j); depth--; }
    else if ((ch === ';' || ch === ',') && depth === 0) return src.slice(from, j);
  }
  return src.slice(from);
}

/** The content between a `(` at `openIdx` and its matching `)`, or null if unbalanced. */
function readBalancedParens(src: string, openIdx: number): string | null {
  let depth = 0;
  for (let j = openIdx; j < src.length; j++) {
    if (src[j] === '(') depth++;
    else if (src[j] === ')') { depth--; if (depth === 0) return src.slice(openIdx + 1, j); }
  }
  return null;
}

/**
 * Reads a C# INTEGER literal (decimal or `0x` hex, honoring `_` digit separators and
 * `U`/`L` suffixes) at index i of `src`, or null when there is no integer literal there.
 * FLOATS are rejected: a `.` immediately after the digits or an `e`/`E` exponent means it is
 * a real literal, not an integer, so a fractional part like `1.412` never yields the integer
 * `412`. A trailing identifier char (e.g. `412abc`) also rejects. The caller guarantees the
 * left boundary (not preceded by an identifier char or `.`).
 */
function readCSharpIntegerLiteral(src: string, i: number): { value: number; end: number } | null {
  const n = src.length;
  let j = i;
  let value: number;
  if (src[i] === '0' && (src[i + 1] === 'x' || src[i + 1] === 'X')) {
    j = i + 2;
    let hex = '';
    while (j < n && /[0-9A-Fa-f_]/.test(src[j]!)) { if (src[j] !== '_') hex += src[j]; j++; }
    if (hex.length === 0) return null;
    value = parseInt(hex, 16);
  } else if (src[i] === '0' && (src[i + 1] === 'b' || src[i + 1] === 'B')) {
    // BINARY literal `0b1010` (honoring `_` separators) — a status like `(HttpStatusCode)0b110011100`
    // (== 412) must be evaluated, so a precondition path expressed in binary is not missed
    // (pass 47 finding #6).
    j = i + 2;
    let bin = '';
    while (j < n && /[01_]/.test(src[j]!)) { if (src[j] !== '_') bin += src[j]; j++; }
    if (bin.length === 0) return null;
    value = parseInt(bin, 2);
  } else if (/[0-9]/.test(src[i]!)) {
    let dec = '';
    while (j < n && /[0-9_]/.test(src[j]!)) { if (src[j] !== '_') dec += src[j]; j++; }
    if (src[j] === '.') return null; // a following '.' -> float or member access; not an int
    if (src[j] === 'e' || src[j] === 'E') return null; // exponent -> real literal
    value = parseInt(dec, 10);
  } else {
    return null;
  }
  while (j < n && /[uUlL]/.test(src[j]!)) j++; // integer suffix
  if (j < n && /[A-Za-z_.]/.test(src[j]!)) return null; // 412abc / 412. -> not a bare int
  if (!Number.isFinite(value)) return null;
  return { value, end: j };
}

/** A single C# string-literal token: its DECODED value and [start,end) span. */
export interface CSharpStringToken {
  readonly value: string;
  readonly start: number;
  readonly end: number;
}

/**
 * Every C# string-literal VALUE in `src` — REGULAR (`"..."`), VERBATIM (`@"..."`), and RAW
 * (`"""..."""`) — decoded to its actual text, with its [start,end) span, in source order.
 * Comments and char literals are skipped; an INTERPOLATED string (`$"..."`, `$@"..."`,
 * `@$"..."`, `$"""..."""`) THROWS, consistent with {@link scanCSharp}. Unlike
 * {@link commentStrippedCSharp} (which BLANKS verbatim/raw bodies so structural parsers can't
 * see decoy code), this READS every form's content — so an absence/presence check over string
 * values can see a name hidden in a verbatim or raw string.
 */
export function csharpStringLiteralTokens(src: string): CSharpStringToken[] {
  const out: CSharpStringToken[] = [];
  const n = src.length;
  let i = 0;
  while (i < n) {
    const c = src[i]!;
    const c2 = src[i + 1];
    if (c === '/' && c2 === '/') { let j = i + 2; while (j < n && !isCSharpNewline(src[j])) j++; i = j; continue; }
    if (c === '/' && c2 === '*') {
      let j = i + 2;
      while (j < n && !(src[j] === '*' && src[j + 1] === '/')) j++;
      if (j >= n) throw new Error('csharpStringLiteralTokens: unterminated block comment.');
      i = Math.min(n, j + 2);
      continue;
    }
    const rawStart = matchRawStringOpen(src, i);
    if (rawStart) {
      const { quoteRun, prefixLen } = rawStart;
      if (src.slice(i, i + prefixLen).includes('$')) throw new Error('csharpStringLiteralTokens: interpolated raw string.');
      const open = i + prefixLen;
      let j = open + quoteRun;
      let closed = false;
      while (j < n) { if (src[j] === '"' && runLength(src, j, '"') >= quoteRun) { closed = true; break; } j++; }
      if (!closed) throw new Error('csharpStringLiteralTokens: unterminated raw string.');
      const end = j + quoteRun;
      out.push({ value: decodeRawStringBody(src.slice(open + quoteRun, j)), start: i, end });
      i = end;
      continue;
    }
    if ((c === '$' && c2 === '@' && src[i + 2] === '"') || (c === '@' && c2 === '$' && src[i + 2] === '"')) {
      throw new Error('csharpStringLiteralTokens: interpolated verbatim string.');
    }
    if (c === '@' && c2 === '"') {
      let j = i + 2;
      let closed = false;
      let val = '';
      while (j < n) {
        if (src[j] === '"' && src[j + 1] === '"') { val += '"'; j += 2; continue; }
        if (src[j] === '"') { closed = true; break; }
        val += src[j];
        j++;
      }
      if (!closed) throw new Error('csharpStringLiteralTokens: unterminated verbatim string.');
      out.push({ value: val, start: i, end: j + 1 });
      i = j + 1;
      continue;
    }
    if (c === '$' && c2 === '"') throw new Error('csharpStringLiteralTokens: interpolated string.');
    if (c === '"') {
      let j = i + 1;
      while (j < n) {
        if (src[j] === '\\') { if (j + 1 >= n || isCSharpNewline(src[j + 1]!)) break; j += 2; continue; }
        if (src[j] === '"' || isCSharpNewline(src[j])) break;
        j++;
      }
      if (src[j] !== '"') throw new Error('csharpStringLiteralTokens: unterminated string.');
      out.push({ value: decodeCSharpRegularString(src.slice(i + 1, j)), start: i, end: j + 1 });
      i = j + 1;
      continue;
    }
    if (c === "'") {
      let j = i + 1;
      while (j < n && src[j] !== "'" && !isCSharpNewline(src[j])) {
        if (src[j] === '\\') { if (j + 1 >= n || isCSharpNewline(src[j + 1]!)) break; j += 2; continue; }
        j++;
      }
      if (src[j] !== "'") throw new Error('csharpStringLiteralTokens: unterminated char literal.');
      i = j + 1;
      continue;
    }
    i++;
  }
  return out;
}

/** Decodes a RAW string literal body. Raw strings do NOT process escapes, so the value is
 *  the content verbatim — sufficient for an equality/absence check that only needs to SEE the
 *  content, never blank it. */
function decodeRawStringBody(body: string): string {
  return body;
}

/**
 * Every string VALUE observable in `src`, INCLUDING top-level `+` CONCATENATIONS joined into
 * their combined value. Returns each individual decoded literal ({@link csharpStringLiteralTokens})
 * plus, for every maximal run of literals separated ONLY by whitespace and a single `+`, the
 * JOINED value. So `"If-" + "Match"` contributes `If-`, `Match`, AND `If-Match` — a split /
 * concatenated header name cannot hide from an absence check. Verbatim and raw forms are
 * included because the underlying token reader reads their content.
 */
export function csharpAllStringValues(src: string): string[] {
  const tokens = csharpStringLiteralTokens(src);
  const out: string[] = tokens.map((t) => t.value);
  let i = 0;
  while (i < tokens.length) {
    let j = i;
    let joined = tokens[i]!.value;
    while (j + 1 < tokens.length) {
      const gap = src.slice(tokens[j]!.end, tokens[j + 1]!.start);
      if (/^\s*\+\s*$/.test(gap)) {
        joined += tokens[j + 1]!.value;
        j++;
      } else break;
    }
    if (j > i) out.push(joined);
    i = j + 1;
  }
  return out;
}

/** The conditional-request header names a precondition-honoring path reads/writes. `if-range`
 *  is included so a `Range`-conditional read (which also keys off an ETag/last-modified validator)
 *  cannot smuggle in optimistic-concurrency behavior undetected (pass 46 finding #6). */
const CONDITIONAL_REQUEST_HEADERS = new Set([
  'if-match',
  'if-none-match',
  'if-unmodified-since',
  'if-modified-since',
  'if-range',
  'etag',
]);

/**
 * The first conditional-request HEADER NAME ({@link CONDITIONAL_REQUEST_HEADERS}) that is used
 * as a HEADER-API ARGUMENT or INDEXER KEY in `src`, or null. Unlike a blanket "the header name
 * appears as any string literal anywhere" scan (which false-positives on a log message or an
 * unrelated assignment), this BINDS the header name to a call-argument / indexer position: the
 * decoded string value (REGULAR, VERBATIM `@"..."`, RAW `"""..."""`, and top-level `+`
 * CONCATENATION runs are all read via {@link csharpStringLiteralTokens}) must be immediately
 * preceded — skipping whitespace — by `(` (a call's first argument), `,` (a later argument), `[`
 * (an indexer key), or a NAMED-argument colon `name:` whose argument slot begins with `(`/`,`
 * (e.g. `headers.Add(name: "If-Match")`). A header name assigned to a variable or embedded in a
 * message (preceded by `=`) is NOT flagged. Throws on an interpolated string (consistent with
 * {@link csharpStringLiteralTokens}).
 */
export function csharpConditionalRequestHeaderArg(src: string): string | null {
  const tokens = csharpStringLiteralTokens(src);
  let i = 0;
  while (i < tokens.length) {
    // Build a top-level `+` concatenation run, tracking the run's START position.
    let j = i;
    let joined = tokens[i]!.value;
    const runStart = tokens[i]!.start;
    while (j + 1 < tokens.length) {
      const gap = src.slice(tokens[j]!.end, tokens[j + 1]!.start);
      if (/^\s*\+\s*$/.test(gap)) { joined += tokens[j + 1]!.value; j++; } else break;
    }
    const name = joined.trim().toLowerCase();
    if (CONDITIONAL_REQUEST_HEADERS.has(name) && isHeaderArgPosition(src, runStart)) {
      return joined;
    }
    i = j + 1;
  }
  return null;
}

/**
 * The first conditional-request HEADER NAME ({@link CONDITIONAL_REQUEST_HEADERS}) that appears as a
 * STANDALONE decoded string literal (or a top-level `+` concatenation) whose FULL value equals a
 * conditional-request header, in ANY position — not only an argument/indexer slot. This catches a
 * header name bound to a STRING CONSTANT / VARIABLE ALIAS (e.g. `const string P = "If-Match";` or
 * `var h = "If-Match";`) that {@link csharpConditionalRequestHeaderArg} (argument-bound) misses,
 * because such a constant is declared precisely to be used as a conditional-request header key. A
 * header name EMBEDDED in a longer message (`"If-Match is not supported"`) is NOT flagged because
 * the FULL decoded value must equal the header exactly (pass 45 finding #8). Returns null when
 * absent. Throws on an interpolated string (consistent with {@link csharpStringLiteralTokens}).
 */
export function csharpConditionalRequestHeaderLiteral(src: string): string | null {
  const tokens = csharpStringLiteralTokens(src);
  let i = 0;
  while (i < tokens.length) {
    let j = i;
    let joined = tokens[i]!.value;
    while (j + 1 < tokens.length) {
      const gap = src.slice(tokens[j]!.end, tokens[j + 1]!.start);
      if (/^\s*\+\s*$/.test(gap)) { joined += tokens[j + 1]!.value; j++; } else break;
    }
    if (CONDITIONAL_REQUEST_HEADERS.has(joined.trim().toLowerCase())) return joined;
    i = j + 1;
  }
  return null;
}

/** Replace every C# string-literal token in a COMMENT-STRIPPED source with a sentinel
 *  `\uE000<index>\uE001`, returning the masked text and the ordered decoded values, AND normalizing
 *  every C# IDENTIFIER token to its spec-normalized name (decoding a verbatim `@name` prefix and
 *  `\uXXXX` escapes) so an ESCAPED/VERBATIM alias at a declaration matches its (possibly
 *  differently-escaped) use — closing the composed-header identifier-escape bypass (pass 50 finding
 *  #6). The string sentinels (U+E000/U+E001, non-identifier chars) survive normalization intact, so
 *  the `values` indices stay aligned. Lets a concatenation expression that MIXES string literals and
 *  identifiers be scanned structurally (a masked literal is a single opaque operand). */
function maskStringLiterals(commentStripped: string): { masked: string; values: string[] } {
  const toks = csharpStringLiteralTokens(commentStripped);
  let masked = '';
  let last = 0;
  const values: string[] = [];
  for (const t of toks) {
    masked += commentStripped.slice(last, t.start);
    masked += `\uE000${values.length}\uE001`;
    values.push(t.value);
    last = t.end;
  }
  masked += commentStripped.slice(last);
  return { masked: normalizeMaskedIdentifiers(masked), values };
}

/** Rebuild a string-masked C# text with every identifier token replaced by its spec-normalized
 *  name (`@prefix`→`prefix`, `pre\u0066ix`→`prefix`), so downstream regex operand/decl matching is
 *  escape/verbatim-insensitive. The string sentinels are non-identifier chars, so they pass
 *  through unchanged (pass 50 finding #6).
 *
 *  PROVENANCE EXCEPTION (pass 60/61): an identifier that normalizes to `new` KEEPS a synthetic
 *  leading `@`. The object-creation KEYWORD `new` is spelled with EXACTLY the three literal
 *  characters `new`; ANY other source spelling that normalizes to `new` is necessarily an
 *  IDENTIFIER (e.g. a local-function name), because a keyword can carry NO `@` verbatim prefix, NO
 *  Unicode escape (`n\u0065w`), and NO removed Cf format character — the `@` is therefore NOT the
 *  only identifier spelling, so provenance is keyed on the RAW source slice differing from `new`,
 *  not on a leading `@`. `new` is the only keyword {@link classifyNewTypeAt} special-cases, so
 *  marking every non-literal `new` spelling with a synthetic `@` lets that classifier tell an
 *  `@new()`/`n\u0065w()` local function from a `new()` object initializer for EVERY return-type
 *  form (void, generic, nullable `?`, tuple `)`) without inspecting the return type at all.
 *  Non-keyword verbatim/escaped identifiers (`@prefix`, `pre\u0066ix`) still normalize (their
 *  escape is cosmetic), so pass-50 alias matching is unaffected. */
function normalizeMaskedIdentifiers(masked: string): string {
  const toks = csharpIdentifierTokens(masked);
  let out = '';
  let last = 0;
  for (const t of toks) {
    out += masked.slice(last, t.start);
    // The keyword `new` is the literal spelling `new`; any token that normalizes to `new` from a
    // DIFFERENT raw slice (`@new`, `n\u0065w`, a Cf-format spelling) is an escaped identifier —
    // mark it with a synthetic `@` so classifyNewTypeAt does not read it as the keyword.
    out += t.name === 'new' && masked.slice(t.start, t.end) !== 'new' ? '@new' : t.name;
    last = t.end;
  }
  out += masked.slice(last);
  return out;
}

/** Split a (string-masked) expression on TOP-LEVEL `+`, respecting nested `()`/`[]`/`{}`. */
function splitTopLevelPlus(expr: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i]!;
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') { if (depth > 0) depth--; }
    else if (c === '+' && depth === 0) { out.push(expr.slice(start, i)); start = i + 1; }
  }
  out.push(expr.slice(start));
  return out;
}

/** Resolve a (string-masked) concatenation expression to its composed value, or null if any
 *  operand is neither a masked string literal, a KNOWN string constant, nor a resolvable
 *  `string.Concat(...)`/`String.Concat(...)` call. Supports `+`-concatenation AND
 *  `string.Concat(a, b, …)` (pass 49 finding #6). */
function resolveMaskedConcat(expr: string, values: readonly string[], constants: ReadonlyMap<string, string>): string | null {
  const t = expr.trim();
  // A whole-expression `string.Concat(...)` / `String.Concat(...)` (optionally `System.String.Concat`).
  const concatM = /^(?:System\s*\.\s*)?(?:string|String)\s*\.\s*Concat\s*\(([\s\S]*)\)$/.exec(t);
  if (concatM) {
    let out = '';
    for (const arg of splitTopLevelArgs(concatM[1]!)) {
      const v = resolveMaskedConcat(arg, values, constants);
      if (v === null) return null;
      out += v;
    }
    return out;
  }
  // A whole-expression `string.Join(separator, part0, part1, …)` — joins the parts with the
  // separator. Supports the params form and a single array-initializer arg (`new[]{…}` /
  // `new string[]{…}`) (pass 53 finding #7).
  const joinM = /^(?:System\s*\.\s*)?(?:string|String)\s*\.\s*Join\s*\(([\s\S]*)\)$/.exec(t);
  if (joinM) {
    const args = splitTopLevelArgs(joinM[1]!);
    if (args.length < 2) return null;
    const sep = resolveMaskedConcat(args[0]!, values, constants);
    if (sep === null) return null;
    let parts = args.slice(1);
    if (parts.length === 1) {
      const arr = /^new\b\s*(?:[A-Za-z_][\w.<>]*\s*)?\[\s*\]\s*\{([\s\S]*)\}$/.exec(parts[0]!.trim());
      if (arr) parts = splitTopLevelArgs(arr[1]!).filter((p) => p.trim().length > 0);
    }
    if (parts.length === 0) return null;
    const resolved: string[] = [];
    for (const pt of parts) {
      const v = resolveMaskedConcat(pt, values, constants);
      if (v === null) return null;
      resolved.push(v);
    }
    return resolved.join(sep);
  }
  // A whole-expression `string.Format(format, arg0, arg1, …)` — substitutes `{n}` placeholders.
  // Fails closed (null) on alignment/format components (`{0:X}`/`{0,5}`) or escaped braces
  // (`{{`/`}}`) rather than guessing (pass 53 finding #7).
  const formatM = /^(?:System\s*\.\s*)?(?:string|String)\s*\.\s*Format\s*\(([\s\S]*)\)$/.exec(t);
  if (formatM) {
    const args = splitTopLevelArgs(formatM[1]!);
    if (args.length < 1) return null;
    const fmt = resolveMaskedConcat(args[0]!, values, constants);
    if (fmt === null || /\{\{|\}\}/.test(fmt)) return null;
    const fmtArgs = args.slice(1).map((a) => resolveMaskedConcat(a, values, constants));
    if (fmtArgs.some((a) => a === null)) return null;
    let ok = true;
    const composed = fmt.replace(/\{([^}]*)\}/g, (_full, inner: string) => {
      const im = /^\s*(\d+)\s*$/.exec(inner);
      if (!im) { ok = false; return ''; }
      const idx = Number(im[1]);
      if (idx >= fmtArgs.length) { ok = false; return ''; }
      return fmtArgs[idx]!;
    });
    return ok ? composed : null;
  }
  const parts = splitTopLevelPlus(t);
  let out = '';
  for (const raw of parts) {
    const p = raw.trim();
    if (p.length === 0) return null;
    const mm = /^\uE000(\d+)\uE001$/.exec(p);
    if (mm) { out += values[Number(mm[1])]!; continue; }
    // A nested `string.Concat(...)`/`string.Join(...)`/`string.Format(...)` operand.
    const nested = /^(?:System\s*\.\s*)?(?:string|String)\s*\.\s*(?:Concat|Join|Format)\s*\(/.test(p);
    if (nested) { const v = resolveMaskedConcat(p, values, constants); if (v === null) return null; out += v; continue; }
    if (/^[A-Za-z_]\w*$/.test(p) && constants.has(p)) { out += constants.get(p)!; continue; }
    return null;
  }
  return out;
}

/** A source-ordered model of the string-alias environment for {@link
 *  csharpComposedConditionalRequestHeader}. Exposes the ordered mutation EVENTS (declarations,
 *  plain reassignments, `+=` appends) so a caller can compute the alias environment valid AT a given
 *  source position (point-of-use) rather than applying the FINAL value retroactively (pass 52
 *  finding #7). Also exposes `finalMap` (the end-of-scope values, for a bare-alias-equals-header
 *  check), the shared string-literal mask, the forward-reference declaration fixpoint, and the
 *  order-sensitive name set. */
interface StringAliasModel {
  readonly finalMap: Map<string, string>;
  readonly events: ReadonlyArray<{ pos: number; name: string; rhs: string; kind: 'set' | 'append' }>;
  readonly masked: string;
  readonly values: readonly string[];
  readonly declFixpoint: ReadonlyMap<string, string>;
  readonly orderSensitive: ReadonlySet<string>;
}

/** Build the {@link StringAliasModel} for a comment-stripped C# view. Declarations (`string NAME =
 *  <expr>;`, `var NAME = …`, `System.String`/`String NAME = …`), PLAIN reassignments (`NAME = …`),
 *  and `+=` appends are recorded as SOURCE-ORDERED events; a transitive fixpoint resolves pure-
 *  declaration forward references; the `finalMap` replays events in order (an unresolvable
 *  reassignment INVALIDATES the alias). Operates on a string-masked view so a commented-out/quoted
 *  declaration is never counted. */
function stringAliasModel(commentStripped: string): StringAliasModel {
  const { masked, values } = maskStringLiterals(commentStripped);
  // (1) DECLARATIONS `<type> NAME = <expr>;` — recorded for a transitive fixpoint (forward refs)
  // and as source-ordered `set` events. Shadowed names (>1 declaration) are treated as mutated.
  const decls: Array<{ name: string; rhs: string; pos: number }> = [];
  const declCount = new Map<string, number>();
  const re = /(?<![A-Za-z0-9_])(?:(?:System\s*\.\s*)?String|string|var)\s+([A-Za-z_]\w*)\s*=\s*([^;]+);/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked)) !== null) {
    decls.push({ name: m[1]!, rhs: m[2]!.trim(), pos: m.index });
    declCount.set(m[1]!, (declCount.get(m[1]!) ?? 0) + 1);
  }
  // Transitive fixpoint over DECLARATIONS ONLY (resolves forward/backward references between
  // pure-declaration constants, e.g. `const string B = A + "x"; const string A = "If-";`).
  const declFixpoint = new Map<string, string>();
  {
    let changed = true;
    while (changed) {
      changed = false;
      for (const { name, rhs } of decls) {
        if (declFixpoint.has(name)) continue;
        const v = resolveMaskedConcat(rhs, values, declFixpoint);
        if (v !== null) { declFixpoint.set(name, v); changed = true; }
      }
    }
  }
  // (2) SOURCE-ORDERED events: declarations (`set`), PLAIN reassignments (`set`, not `==`/`=>`/`+=`),
  // and compound `+=` appends. Plain reassignments/compounds and shadowed names are `mutated`.
  type Event = { pos: number; name: string; rhs: string; kind: 'set' | 'append' };
  const events: Event[] = decls.map((d) => ({ pos: d.pos, name: d.name, rhs: d.rhs, kind: 'set' as const }));
  const mutated = new Set<string>();
  for (const [name, count] of declCount) if (count > 1) mutated.add(name);
  // Plain reassignment `NAME = <expr>;`. The LHS identifier must sit at a STATEMENT BOUNDARY
  // (`^`, `;`, `{`, or `}`), which excludes declarations (whose NAME follows a type keyword). The
  // terminating `;` is matched via LOOKAHEAD so adjacent reassignments are not skipped.
  const reassignRe = /(?:^|[;{}])\s*([A-Za-z_]\w*)\s*=(?![=>])\s*([^;]+)(?=;)/g;
  let ra: RegExpExecArray | null;
  while ((ra = reassignRe.exec(masked)) !== null) {
    // ra.index points at the boundary char; the alias NAME starts after it, so record the NAME
    // position for point-of-use ordering.
    const namePos = masked.indexOf(ra[1]!, ra.index);
    events.push({ pos: namePos, name: ra[1]!, rhs: ra[2]!.trim(), kind: 'set' });
    mutated.add(ra[1]!);
  }
  const mutRe = /(?<![A-Za-z0-9_])([A-Za-z_]\w*)\s*\+=\s*([^;]+);/g;
  let mu: RegExpExecArray | null;
  while ((mu = mutRe.exec(masked)) !== null) {
    events.push({ pos: mu.index, name: mu[1]!, rhs: mu[2]!.trim(), kind: 'append' });
    mutated.add(mu[1]!);
  }
  events.sort((a, b) => a.pos - b.pos);
  const ordered = new Map<string, string>();
  for (const e of events) {
    if (e.kind === 'set') {
      const v = resolveMaskedConcat(e.rhs, values, ordered);
      if (v !== null) ordered.set(e.name, v);
      else ordered.delete(e.name); // an unresolvable reassignment invalidates the alias
    } else {
      if (!ordered.has(e.name)) continue; // cannot append to an unknown value
      const a = resolveMaskedConcat(e.rhs, values, ordered);
      if (a !== null) ordered.set(e.name, ordered.get(e.name)! + a);
      else ordered.delete(e.name);
    }
  }
  // ORDER-SENSITIVE names: mutated/shadowed, or (transitively) referencing a mutated name — their
  // value must NOT be back-filled from the STALE forward-reference fixpoint.
  const orderSensitive = new Set(mutated);
  let tchanged = true;
  while (tchanged) {
    tchanged = false;
    for (const { name, rhs } of decls) {
      if (orderSensitive.has(name)) continue;
      const ids = rhs.match(/[A-Za-z_]\w*/g) ?? [];
      if (ids.some((id) => orderSensitive.has(id))) { orderSensitive.add(name); tchanged = true; }
    }
  }
  const finalMap = new Map(ordered);
  for (const [name, v] of declFixpoint) {
    if (!orderSensitive.has(name) && !finalMap.has(name)) finalMap.set(name, v);
  }
  return { finalMap, events, masked, values, declFixpoint, orderSensitive };
}

/**
 * The first conditional-request HEADER NAME ({@link CONDITIONAL_REQUEST_HEADERS}) COMPOSED from a
 * `+`-concatenation that MIXES string literals and string-CONSTANT ALIASES — either a `const string`
 * whose resolved value equals a header, or an INLINE concatenation anywhere (`headers.Add(Prefix +
 * "Match", …)`) that composes to a header — or null. This catches a header assembled from pieces
 * where NO single literal equals the header (so {@link csharpConditionalRequestHeaderLiteral}, which
 * only joins adjacent string LITERALS, misses it). Constants resolve transitively. Each INLINE
 * concatenation/`Concat` is evaluated with the alias environment valid AT its source position
 * (point-of-use), so a header composed BEFORE a later reassignment is caught and a non-header use is
 * not falsely flagged from a later value (pass 52 finding #7). Throws on an interpolated string
 * (consistent with {@link csharpStringLiteralTokens}) (pass 47 finding #6).
 */
export function csharpComposedConditionalRequestHeader(src: string): string | null {
  const cs = commentStrippedCSharp(src);
  const model = stringAliasModel(cs);
  const { finalMap, events, masked, values, declFixpoint, orderSensitive } = model;
  // The alias environment valid just BEFORE source position `pos`: seed the order-insensitive pure
  // constants (available everywhere, incl. forward references) then replay every ordered event whose
  // NAME position is strictly before `pos`.
  const envAt = (pos: number): Map<string, string> => {
    const env = new Map<string, string>();
    for (const [name, v] of declFixpoint) if (!orderSensitive.has(name)) env.set(name, v);
    for (const e of events) {
      if (e.pos >= pos) break;
      if (e.kind === 'set') {
        const v = resolveMaskedConcat(e.rhs, values, env);
        if (v !== null) env.set(e.name, v); else env.delete(e.name);
      } else {
        if (!env.has(e.name)) continue;
        const a = resolveMaskedConcat(e.rhs, values, env);
        if (a !== null) env.set(e.name, env.get(e.name)! + a); else env.delete(e.name);
      }
    }
    return env;
  };
  // (a) A string constant whose end-of-scope RESOLVED value equals a conditional-request header
  // (catches a bare `const string P = "If-Match"` or a `+=`-mutated alias with no separate use).
  for (const [, v] of finalMap) {
    if (CONDITIONAL_REQUEST_HEADERS.has(v.trim().toLowerCase())) return v;
  }
  // (b) An INLINE `+`-concatenation (any position) of literals + aliases KNOWN AT THAT POSITION that
  // composes to a header — e.g. `headers.Add(Prefix + "Match", …)`.
  const runRe = /(?:\uE000\d+\uE001|[A-Za-z_]\w*)(?:\s*\+\s*(?:\uE000\d+\uE001|[A-Za-z_]\w*))+/g;
  let m: RegExpExecArray | null;
  while ((m = runRe.exec(masked)) !== null) {
    const v = resolveMaskedConcat(m[0], values, envAt(m.index));
    if (v !== null && CONDITIONAL_REQUEST_HEADERS.has(v.trim().toLowerCase())) return v;
  }
  // (c) An INLINE `string.Concat(...)`/`Join(...)`/`Format(...)` call (any position) composing a
  // header, evaluated with the alias environment valid at the call position (pass 53 finding #7).
  const concatRe = /(?:System\s*\.\s*)?(?:string|String)\s*\.\s*(?:Concat|Join|Format)\s*\(/g;
  let cmt: RegExpExecArray | null;
  while ((cmt = concatRe.exec(masked)) !== null) {
    const openIdx = masked.indexOf('(', cmt.index + cmt[0].length - 1);
    let d = 0;
    let close = -1;
    for (let j = openIdx; j < masked.length; j++) { if (masked[j] === '(') d++; else if (masked[j] === ')') { d--; if (d === 0) { close = j; break; } } }
    if (close < 0) continue;
    const v = resolveMaskedConcat(masked.slice(cmt.index, close + 1), values, envAt(cmt.index));
    if (v !== null && CONDITIONAL_REQUEST_HEADERS.has(v.trim().toLowerCase())) return v;
  }
  // (d) A StringBuilder-composed header — fluent (`new StringBuilder().Append("If-").Append("Match")
  // .ToString()`) or VARIABLE (`var sb = new StringBuilder(); sb.Append("If-"); sb.Append("Match");
  // … sb.ToString()`). Each `.ToString()` is evaluated with the appends BEFORE it, using the alias
  // environment at that point (pass 53 finding #7).
  const sb = stringBuilderComposedHeader(masked, values, envAt);
  if (sb !== null) return sb;
  return null;
}

/** Collection/array type LEAF names whose initializer `{ … }` is a COLLECTION initializer — its
 *  entries are element EXPRESSIONS, so an `sb = x` element is an ASSIGNMENT EXPRESSION that DOES
 *  reassign the local (pass 57 finding #2), unlike an OBJECT initializer whose `Member = x` entries
 *  set members of the new object (not the local). */
const COLLECTION_TYPE_LEAVES = new Set<string>([
  'List', 'IList', 'ICollection', 'IEnumerable', 'Collection', 'ObservableCollection',
  'Dictionary', 'IDictionary', 'SortedDictionary', 'SortedList', 'ConcurrentDictionary',
  'HashSet', 'ISet', 'SortedSet', 'Queue', 'Stack', 'ConcurrentBag', 'ConcurrentQueue',
  'ConcurrentStack', 'LinkedList', 'Array',
]);

/** The index of the `{` that lexically ENCLOSES `idx` (brace-depth aware), or -1 if `idx` is not
 *  inside any brace. Input MUST be the string-masked view. */
function nearestEnclosingBrace(masked: string, idx: number): number {
  let depth = 0;
  for (let i = idx - 1; i >= 0; i--) {
    if (masked[i] === '}') depth++;
    else if (masked[i] === '{') { if (depth === 0) return i; depth--; }
  }
  return -1;
}

/** The index of the `<` matching the generic-close `>` at `gtIdx` (handles nested `List<List<T>>`),
 *  or -1 if it is not a balanced generic within the current statement. */
function matchGenericOpenBack(masked: string, gtIdx: number): number {
  let depth = 0;
  for (let i = gtIdx; i >= 0; i--) {
    const c = masked[i]!;
    if (c === '>') depth++;
    else if (c === '<') { depth--; if (depth === 0) return i; }
    else if (c === ';' || c === '{' || c === '}') return -1;
  }
  return -1;
}

/** Classify the TYPE whose name leaf ENDS at `leafEndIdx` (the char before an initializer `{`,
 *  `(`, or `<`): 'element' if it is a `new`-constructed ARRAY/COLLECTION type, 'member' if it is a
 *  `new`-constructed OBJECT type (including ANONYMOUS `new { … }` and TARGET-TYPED `new() { … }`,
 *  where the leaf itself is the `new` keyword — pass 58), or 'statement' if it is NOT preceded by
 *  `new` (so the `{` is a method / local-function body, not an object initializer — pass 57 finding
 *  #1). Walks back over a qualified `A.B.C` name AND an alias qualifier `global::Ns.Foo` (both `.`
 *  and `::` separators — pass 58) and requires the `new` keyword before the chain. */
function classifyNewTypeAt(masked: string, leafEndIdx: number): 'member' | 'element' | 'statement' {
  let q = leafEndIdx;
  while (q >= 0 && /[A-Za-z0-9_]/.test(masked[q]!)) q--;
  const leaf = masked.slice(q + 1, leafEndIdx + 1);
  if (leaf.length === 0) return 'statement';
  // ANONYMOUS (`new { … }`) or TARGET-TYPED (`new() { … }`) object creation: the leaf IS the `new`
  // keyword (no type name), so it is an OBJECT initializer whose `NAME = …` sets a member (pass 58).
  // An ESCAPED identifier spelled `@new`, `n\u0065w`, or with a Cf format char names a local function
  // (`int? @new() { … }`) and is NOT the keyword; normalizeMaskedIdentifiers marks EVERY such
  // non-literal `new` spelling with a synthetic `@` (pass 60/61), so `masked[q] === '@'` distinguishes
  // the identifier from a genuine object-creation `new` for EVERY return-type form — void, generic,
  // nullable `?`, tuple `)` — without classifying the return type (superseding the incomplete
  // pass-59 context heuristic).
  if (leaf === 'new') {
    return masked[q] === '@' ? 'statement' : 'member';
  }
  // Walk back over `.segment` and `::segment` qualifiers (a qualified `A.B.C` or alias-qualified
  // `global::Ns.Foo` type name — pass 58 recognizes the `::` alias separator too).
  let start = q + 1;
  let r = q;
  while (r >= 0 && /\s/.test(masked[r]!)) r--;
  for (;;) {
    if (r >= 1 && masked[r] === ':' && masked[r - 1] === ':') r -= 2; // `::` alias separator
    else if (r >= 0 && masked[r] === '.') r -= 1; // `.` member separator
    else break;
    while (r >= 0 && /\s/.test(masked[r]!)) r--;
    while (r >= 0 && /[A-Za-z0-9_]/.test(masked[r]!)) r--;
    start = r + 1;
    while (r >= 0 && /\s/.test(masked[r]!)) r--;
  }
  // Require the `new` keyword immediately before the type chain — WITHOUT it the `{` is a
  // method/local-function body (a return type + name), not an object initializer. An `@`-escaped
  // `@new` in this position (masked[n] === '@') is an identifier, not the keyword (pass 60).
  let n = start - 1;
  while (n >= 0 && /\s/.test(masked[n]!)) n--;
  const ne = n;
  while (n >= 0 && /[A-Za-z0-9_]/.test(masked[n]!)) n--;
  if (masked.slice(n + 1, ne + 1) !== 'new' || masked[n] === '@') return 'statement';
  return COLLECTION_TYPE_LEAVES.has(leaf) ? 'element' : 'member';
}

/** Classify the CONTEXT that a direct `NAME = …` entry of the brace at `bracePos` has:
 *   - 'member'    → an OBJECT initializer (`new Foo { NAME = … }`) or a NESTED member-initializer
 *                   (`Member = { NAME = … }`) — `NAME = …` sets a MEMBER, NOT the local, so it does
 *                   NOT end the tracked instance's lifetime.
 *   - 'element'   → an ARRAY/COLLECTION initializer (`new[] { NAME = … }`, `new List<…> { NAME = … }`,
 *                   a statement-level `= { NAME = … }` array literal) — `NAME = …` is an assignment
 *                   EXPRESSION element that DOES reassign the local (pass 57 finding #2).
 *   - 'statement' → a STATEMENT BLOCK (method / local-function / lambda / control / do-try-else /
 *                   bare block) — `NAME = …` is a real local reassignment (pass 57 finding #1).
 *  Requires ACTUAL initializer syntax (`new <Type>` / an array `[]` / a nested `Member = {`); an
 *  identifier or a non-control `)` alone does NOT introduce an initializer. Input MUST be masked. */
function braceContext(masked: string, bracePos: number): 'member' | 'element' | 'statement' {
  let p = bracePos - 1;
  while (p >= 0 && /\s/.test(masked[p]!)) p--;
  if (p < 0) return 'statement';
  const c = masked[p]!;
  // `=> {` lambda body.
  if (c === '>' && p >= 1 && masked[p - 1] === '=') return 'statement';
  // `Member = { … }` (a SINGLE `=`, not `==`/`=>`/`<=`/`>=`/`!=`/compound): a NESTED member-
  // initializer IFF its enclosing brace is an OBJECT initializer; otherwise a statement-level
  // `= { … }` ARRAY/collection literal whose `NAME = …` element reassigns the local (pass 57 #3).
  if (c === '=' && (p < 1 || '=<>!+-*/%&|^~'.indexOf(masked[p - 1]!) < 0)) {
    const enclosing = nearestEnclosingBrace(masked, bracePos);
    return enclosing >= 0 && braceContext(masked, enclosing) === 'member' ? 'member' : 'element';
  }
  // `new[] { … }` / `new T[…] { … }` array initializer → element context.
  if (c === ']') return 'element';
  // `new Type<…> { … }` — a generic type; classify by the type leaf (requires `new`).
  if (c === '>') {
    const lt = matchGenericOpenBack(masked, p);
    if (lt < 0) return 'statement';
    let q = lt - 1;
    while (q >= 0 && /\s/.test(masked[q]!)) q--;
    return classifyNewTypeAt(masked, q);
  }
  // `new Type(…) { … }` object/collection initializer, OR a method/local-function/control body.
  if (c === ')') {
    let pd = 0;
    let op = -1;
    for (let j = p; j >= 0; j--) { if (masked[j] === ')') pd++; else if (masked[j] === '(') { pd--; if (pd === 0) { op = j; break; } } }
    if (op < 0) return 'statement';
    let q = op - 1;
    while (q >= 0 && /\s/.test(masked[q]!)) q--;
    if (q >= 0 && masked[q] === '>') { const g = matchGenericOpenBack(masked, q); if (g < 0) return 'statement'; q = g - 1; while (q >= 0 && /\s/.test(masked[q]!)) q--; }
    return classifyNewTypeAt(masked, q); // 'statement' unless a `new <Type>(…)` precedes
  }
  // A bare identifier before `{`: `new Type { … }` (no ctor parens), a `with`-expression
  // (`expr with { Member = … }`), OR a statement keyword (`do`/`try`/`else`/… → no `new`, so
  // classifyNewTypeAt returns 'statement', pass 57 #1).
  if (/[A-Za-z0-9_]/.test(c)) {
    let q = p;
    while (q >= 0 && /[A-Za-z0-9_]/.test(masked[q]!)) q--;
    if (masked.slice(q + 1, p + 1) === 'with') return 'member'; // `expr with { Member = … }`
    return classifyNewTypeAt(masked, p);
  }
  return 'statement';
}

/** True iff the `NAME =` occurrence starting at `nameStart` is an OBJECT/nested-member-INITIALIZER
 *  MEMBER assignment (`new Foo { NAME = 1 }`, `new Foo { Child = { NAME = 1 } }`, `obj with { NAME =
 *  1 }`) — which sets a MEMBER, NOT the tracked local — rather than a genuine local reassignment (a
 *  statement-level `NAME = …`, a `NAME = …` assignment EXPRESSION inside an array/collection
 *  initializer, or a `NAME = …` in a statement block). Only a 'member'-context brace is a
 *  non-reassignment; the tracker must NOT end the tracked instance's lifetime on it. Input MUST be
 *  the string-masked view (pass 56; hardened pass 57). */
function isInitializerMemberAssignment(masked: string, nameStart: number): boolean {
  const brace = nearestEnclosingBrace(masked, nameStart);
  if (brace < 0) return false; // no enclosing brace → a statement-level local reassignment
  return braceContext(masked, brace) === 'member';
}

/** Resolve a `StringBuilder`-composed conditional-request header (fluent or variable form) from the
 *  string-masked view, or null. A fluent `new StringBuilder(<init>).Append(a).Append(b).ToString()`
 *  accumulates its initializer + appended args; a VARIABLE form tracks a `NAME = new
 *  StringBuilder(<init>)` and every subsequent `NAME.Append(<arg>)` in SOURCE ORDER, evaluating the
 *  value at each `NAME.ToString()` (point-of-use). `AppendLine`/`Append` args resolve through {@link
 *  resolveMaskedConcat} (so a literal, alias, `+`-concat, `Concat`/`Join`/`Format` composes). The
 *  `constAt(pos)` callback supplies the alias environment valid at a position (pass 53 finding #7). */
function stringBuilderComposedHeader(
  masked: string,
  values: readonly string[],
  constAt: (pos: number) => ReadonlyMap<string, string>,
): string | null {
  const NEW_SB = /new\s+(?:System\s*\.\s*Text\s*\.\s*)?StringBuilder\s*\(/g;
  // Walk a fluent `.Append(<arg>)`/`.AppendLine(<arg>)`/`.ToString()` CHAIN starting at index `from`
  // (a position expecting `.`), accumulating onto `acc`. Returns the composed `value`, the `header`
  // (non-null iff a `.ToString()` in the chain resolves to a conditional-request header), and `end`
  // (the index just past the consumed chain). Consuming the WHOLE chain — not one `.Append` — lets a
  // VARIABLE StringBuilder track fluent continuations like `sb.Append("If-").Append("Match")` whose
  // later links carry no `sb.` prefix (pass 54 finding R2). `constPos` selects the alias environment.
  const walkChain = (from: number, acc: string, constPos: number): { value: string; header: string | null; end: number } => {
    let i = from;
    let value = acc;
    for (;;) {
      while (i < masked.length && /\s/.test(masked[i]!)) i++;
      if (masked[i] !== '.') break;
      let j = i + 1;
      while (j < masked.length && /\s/.test(masked[j]!)) j++;
      const nameM = /^(Append|AppendLine|ToString)\s*\(/.exec(masked.slice(j));
      if (!nameM) break;
      const openIdx = masked.indexOf('(', j);
      let d = 0;
      let close = -1;
      for (let k = openIdx; k < masked.length; k++) { if (masked[k] === '(') d++; else if (masked[k] === ')') { d--; if (d === 0) { close = k; break; } } }
      if (close < 0) break;
      if (nameM[1] === 'ToString') {
        if (CONDITIONAL_REQUEST_HEADERS.has(value.trim().toLowerCase())) return { value, header: value, end: close + 1 };
        i = close + 1;
        continue;
      }
      const argText = masked.slice(openIdx + 1, close).trim();
      const v = argText.length === 0 ? '' : resolveMaskedConcat(argText, values, constAt(constPos));
      if (v === null) return { value, header: null, end: close + 1 }; // unresolvable arg: stop this chain
      value += v + (nameM[1] === 'AppendLine' ? '\n' : '');
      i = close + 1;
    }
    return { value, header: null, end: i };
  };
  let nm: RegExpExecArray | null;
  while ((nm = NEW_SB.exec(masked)) !== null) {
    const openIdx = masked.indexOf('(', nm.index);
    let d = 0;
    let close = -1;
    for (let k = openIdx; k < masked.length; k++) { if (masked[k] === '(') d++; else if (masked[k] === ')') { d--; if (d === 0) { close = k; break; } } }
    if (close < 0) continue;
    // Initializer: a string argument seeds the buffer; a numeric capacity / empty seeds "".
    const initText = masked.slice(openIdx + 1, close).trim();
    let init = '';
    if (initText.length > 0) {
      const iv = resolveMaskedConcat(initText, values, constAt(nm.index));
      if (iv !== null) init = iv;
    }
    // (d1) FLUENT: the `new StringBuilder(...)` is immediately followed by a `.Append…().ToString()`.
    const fluent = walkChain(close + 1, init, nm.index);
    if (fluent.header !== null) return fluent.header;
    // (d2) VARIABLE: `NAME = new StringBuilder(...)` — track subsequent `NAME.<chain>` in order.
    let p = nm.index - 1;
    while (p >= 0 && /\s/.test(masked[p]!)) p--;
    if (p < 0 || masked[p] !== '=') continue;
    let e = p - 1;
    while (e >= 0 && /\s/.test(masked[e]!)) e--;
    let s = e;
    while (s >= 0 && /[A-Za-z0-9_]/.test(masked[s]!)) s--;
    const name = masked.slice(s + 1, e + 1);
    if (!/^[A-Za-z_]\w*$/.test(name)) continue;
    // Replay `NAME.<append/toString chain>` events (any order-position) after the decl. Each event
    // consumes the ENTIRE fluent chain rooted at that `NAME` occurrence (via walkChain), so a
    // fluent continuation `NAME.Append(a).Append(b)` is fully accumulated (pass 54 finding R2).
    const escName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // The tracked instance's lexical lifetime ends at the NEXT genuine REASSIGNMENT of `NAME` — a
    // statement-level `NAME =` (single `=`, not `==`/`=>`, and not a `NAME.` member call) after this
    // `new StringBuilder(...)`. Past that point `NAME` refers to a DIFFERENT instance, so its
    // `Append`/`ToString` calls must NOT accumulate onto THIS instance's buffer (pass 55). A bare
    // `NAME =` also appears as an OBJECT/COLLECTION/`with`-INITIALIZER MEMBER assignment
    // (`new Foo { sb = 1 }`), which does NOT reassign the local — those are skipped so a genuinely
    // composed header is not lost (pass 56).
    const reassignRe = new RegExp(`(?<![A-Za-z0-9_.])${escName}\\s*=(?![=>])`, 'g');
    reassignRe.lastIndex = close + 1;
    let lifetimeEnd = masked.length;
    let ra: RegExpExecArray | null;
    while ((ra = reassignRe.exec(masked)) !== null) {
      if (!isInitializerMemberAssignment(masked, ra.index)) { lifetimeEnd = ra.index; break; }
    }
    const evRe = new RegExp(`(?<![A-Za-z0-9_])${escName}\\s*\\.\\s*(?:Append|AppendLine|ToString)\\s*\\(`, 'g');
    evRe.lastIndex = close + 1;
    let value = init;
    let ev: RegExpExecArray | null;
    while ((ev = evRe.exec(masked)) !== null) {
      if (ev.index >= lifetimeEnd) break; // `NAME` reassigned to a new instance — stop tracking this one
      const dotPos = masked.indexOf('.', ev.index); // the member-access dot after NAME
      const r = walkChain(dotPos, value, ev.index);
      if (r.header !== null) return r.header;
      value = r.value;
      evRe.lastIndex = r.end; // skip the consumed chain so its inner `.Append`s are not re-matched
    }
  }
  return null;
}

/** True iff the string run starting at `runStart` sits in a call ARGUMENT, INDEXER-KEY, or
 *  NAMED-ARGUMENT position. The previous significant char is `(`/`,`/`[`, OR it is a named
 *  argument `identifier:` whose slot begins with `(`/`,` (rejecting a `::` namespace separator
 *  and a ternary/label colon). Input MUST be comment-stripped (string bodies preserved). */
function isHeaderArgPosition(src: string, runStart: number): boolean {
  let k = runStart - 1;
  while (k >= 0 && /\s/.test(src[k]!)) k--;
  if (k < 0) return false;
  const prev = src[k]!;
  if (prev === '(' || prev === ',' || prev === '[') return true;
  if (prev === ':') {
    if (k >= 1 && src[k - 1] === ':') return false; // `::` namespace separator, not a named arg
    let p = k - 1;
    while (p >= 0 && /\s/.test(src[p]!)) p--;
    const idEnd = p;
    while (p >= 0 && /[A-Za-z0-9_]/.test(src[p]!)) p--;
    if (p === idEnd) return false; // no identifier before the colon
    while (p >= 0 && /\s/.test(src[p]!)) p--;
    const before = p >= 0 ? src[p]! : '';
    return before === '(' || before === ','; // the named argument begins an argument slot
  }
  return false;
}

/**
 * stripped view so a binding named only in a comment/string is never counted.
 * Used to prove the concrete callees the runtime actually resolves.
 */
export function diBindings(extractText: string): Record<string, string> {
  const src = stripCSharpNoise(extractText);
  const out: Record<string, string> = {};
  const re = /\.Add(?:Scoped|Singleton|Transient)<\s*([A-Za-z_]\w*)\s*,\s*([A-Za-z_]\w*)\s*>\s*\(\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) out[m[1]!] = m[2]!;
  return out;
}

/** True if the (comment/literal-stripped) C# references any of the given identifiers as
 *  CODE. Uses the SHARED spec-correct tokenizer ({@link csharpIdentifierTokens}) so a
 *  reference spelled with a verbatim `@`, Cf format chars, or `\u`/`\U` escapes is
 *  normalized and matched identically to every other identifier check (and a malformed
 *  escape fails closed). Multi-segment dotted names (e.g. `A.B`) are compared segment-wise:
 *  a target containing `.` matches a consecutive run of dotted identifier tokens. */
export function csharpReferencesIdentifier(csharp: string, identifiers: readonly string[]): boolean {
  const src = stripCSharpNoise(csharp);
  const tokens = csharpIdentifierTokens(src);
  const names = new Set(tokens.map((t) => t.name));
  return identifiers.some((id) => {
    if (!id.includes('.')) return names.has(id);
    // A dotted target: require its segments to appear as consecutive dotted tokens.
    const wanted = id.split('.');
    for (let a = 0; a + wanted.length <= tokens.length; a++) {
      let ok = true;
      for (let b = 0; b < wanted.length; b++) {
        if (tokens[a + b]!.name !== wanted[b]) { ok = false; break; }
        if (b > 0) {
          // Between token a+b-1 and a+b there must be only a single `.` separator.
          const gap = src.slice(tokens[a + b - 1]!.end, tokens[a + b]!.start).trim();
          if (gap !== '.') { ok = false; break; }
        }
      }
      if (ok) return true;
    }
    return false;
  });
}

/** A brace-delimited `if (<condition>) { <block> }` guard, structurally located. */
export interface CSharpGuard {
  /** The `if (...)` condition text (comment/literal-stripped, trimmed). */
  readonly condition: string;
  /** Offset of the `if` keyword within the stripped body (for ordering checks). */
  readonly index: number;
  /** True iff the guard's braced block contains an UNCONDITIONAL `return` at the block's
   *  DIRECT depth — a return that executes whenever the block is entered, not one buried
   *  inside a nested `{ ... }` block or governed by a braceless nested conditional. A
   *  caller authenticating an early-return no-op must require this, so a nested/
   *  conditional return cannot masquerade as the guard's early return. */
  readonly returns: boolean;
  /** Brace depth of the `if` within the body: 0 means a DIRECT child of the body (not
   *  wrapped in another block such as `try`/`using`/a bare block that could reorder or
   *  conditionalize the guard). Lets a caller authenticate direct guard depth. */
  readonly depth: number;
  /** True iff this `if` is actually an `else if` — i.e., the `if` keyword is immediately
   *  preceded (ignoring whitespace) by an `else` keyword. Such a guard is CONDITIONAL on a
   *  PRIOR branch NOT having been taken, so its `return` is NOT an unconditional early
   *  return. A caller authenticating an unconditional guard MUST require `elseIf === false`,
   *  so an `else if (...) { return; }` cannot masquerade as an unconditional cancellation
   *  guard. */
  readonly elseIf: boolean;
}

/**
 * Structurally extracts each `if (<cond>) { <block> }` guard in a (comment/literal-
 * stripped) C# body, in source order, reporting the condition text, the `if` offset,
 * whether the braced block contains a `return`, and the guard's BRACE DEPTH within the
 * body. Scanning skips PAST each guard's block so a NESTED `if` inside a guard is not
 * reported as a sibling. The reported `depth` (0 = a DIRECT child of the body) lets a
 * caller REQUIRE that the authenticated control-flow guards sit at the method top level
 * rather than being buried in a wrapping block. Only brace-delimited blocks are matched
 * (a braceless `if (c) return;` is intentionally not matched; the generated handlers
 * brace their blocks).
 */
export function csharpGuardedEarlyReturns(body: string): CSharpGuard[] {
  const src = stripCSharpNoise(body);
  // Brace depth at every index, so each guard's depth (0 = direct child of the body)
  // can be reported and required by callers authenticating direct guard depth.
  const depthAt = new Array<number>(src.length + 1);
  {
    let d = 0;
    for (let i = 0; i < src.length; i++) {
      depthAt[i] = d;
      if (src[i] === '{') d++;
      else if (src[i] === '}') d--;
    }
    depthAt[src.length] = d;
  }
  const out: CSharpGuard[] = [];
  const re = /\bif\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const guardDepth = depthAt[m.index]!;
    // Balance the condition parentheses.
    const condOpen = m.index + m[0].length - 1;
    let depth = 0;
    let condClose = -1;
    for (let j = condOpen; j < src.length; j++) {
      if (src[j] === '(') depth++;
      else if (src[j] === ')') { depth--; if (depth === 0) { condClose = j; break; } }
    }
    if (condClose < 0) continue;
    const condition = src.slice(condOpen + 1, condClose).trim();
    // A braced block must follow with only whitespace between `)` and `{`.
    const open = src.indexOf('{', condClose);
    if (open < 0) continue;
    if (/\S/.test(src.slice(condClose + 1, open))) continue;
    let bdepth = 0;
    let bclose = -1;
    for (let j = open; j < src.length; j++) {
      if (src[j] === '{') bdepth++;
      else if (src[j] === '}') { bdepth--; if (bdepth === 0) { bclose = j; break; } }
    }
    if (bclose < 0) continue;
    const block = src.slice(open + 1, bclose);
    const returns = hasUnconditionalReturnAtDepth0(block);
    // Detect an `else if`: the text immediately before the `if` keyword (skipping
    // whitespace) ends with the `else` keyword on an identifier boundary. Such a guard is
    // conditional on the prior branch, so its return is not unconditional.
    const before = src.slice(0, m.index).replace(/\s+$/, '');
    const elseIf = /(?<![A-Za-z0-9_])else$/u.test(before);
    out.push({ condition, index: m.index, returns, depth: guardDepth, elseIf });
    // Skip PAST this guard's block so a nested `if` is not reported as a sibling.
    re.lastIndex = bclose + 1;
  }
  return out;
}

/**
 * True iff a (comment/literal-stripped) block contains an UNCONDITIONAL `return` at the
 * block's DIRECT depth — i.e. a `return` that runs whenever the block is entered. A
 * return is REJECTED as conditional when it is (a) nested inside a further `{ ... }`
 * block (brace depth >= 1 within the block), or (b) governed by a BRACELESS nested
 * conditional — the `return` immediately follows a `)` that closes an
 * `if`/`while`/`for`/`foreach`/`switch` header, or follows an `else`/`do` keyword. Only
 * a `return` that begins a top-level statement (preceded by a statement boundary `;`,
 * `{`, `}`, or the block start) counts. This prevents a nested/conditional return from
 * masquerading as a guard's early return.
 */
function hasUnconditionalReturnAtDepth0(block: string): boolean {
  const depthAt = new Array<number>(block.length + 1);
  {
    let d = 0;
    for (let i = 0; i < block.length; i++) {
      depthAt[i] = d;
      if (block[i] === '{') d++;
      else if (block[i] === '}') d--;
    }
    depthAt[block.length] = d;
  }
  const re = new RegExp(`(?<![${CS_ID_PART}])return${NB_AFTER}`, 'gu');
  let m: RegExpExecArray | null;
  while ((m = re.exec(block)) !== null) {
    if (depthAt[m.index] !== 0) continue; // nested inside a { } block => conditional
    // Look back over whitespace to the previous significant char.
    let k = m.index - 1;
    while (k >= 0 && /\s/.test(block[k]!)) k--;
    if (k < 0) return true; // the return begins the block => unconditional
    const prev = block[k]!;
    // A statement boundary before the return => it is a new top-level statement. `}` can
    // close a nested block (`if(x){...} return;`) — unconditional — but a `} else return;`
    // would have `else` between `}` and `return`, so `prev` would be `e`, not `}`.
    if (prev === ';' || prev === '{' || prev === '}') return true;
    // Otherwise (a `)` closing a braceless if/while/for/foreach/switch header, or an
    // `else`/`do` keyword) the return is CONDITIONAL — keep scanning for another.
  }
  return false;
}

/**
 * The FIRST unconditional control-flow TERMINATOR (`return` or `throw`) at the block's
 * DIRECT depth (brace depth 0) that BEGINS a top-level statement, or null if none. This is
 * the reachability boundary: because a depth-0 `return`/`throw` exits the method/branch,
 * EVERYTHING textually after this statement is UNREACHABLE (dead code). Returns the
 * terminator KIND, the index of its expression start (just after the keyword), and the
 * index of its terminating top-level `;` (or block.length if the statement is unterminated).
 * A `return`/`throw` nested inside a `{ }` block (depth >= 1) or used as an EXPRESSION
 * (e.g. `x ?? throw e` — not preceded by a statement boundary) is NOT a top-level terminator
 * and is skipped, so only a statement that genuinely ends control flow is reported.
 */
function firstUnconditionalTerminatorAtDepth0(
  block: string,
): { kind: 'return' | 'throw'; exprStart: number; semi: number } | null {
  const depthAt = new Array<number>(block.length + 1);
  {
    let d = 0;
    for (let i = 0; i < block.length; i++) {
      depthAt[i] = d;
      if (block[i] === '{') d++;
      else if (block[i] === '}') d--;
    }
    depthAt[block.length] = d;
  }
  const re = new RegExp(`(?<![${CS_ID_PART}])(return|throw)${NB_AFTER}`, 'gu');
  let m: RegExpExecArray | null;
  while ((m = re.exec(block)) !== null) {
    if (depthAt[m.index] !== 0) continue; // nested inside a { } block => conditional
    // Must begin a top-level statement (a boundary `;`/`{`/`}` or the block start); a
    // `throw` used as an EXPRESSION (`x ?? throw e`) is preceded by an operator, not a
    // boundary, so it is not a control-flow terminator here.
    let k = m.index - 1;
    while (k >= 0 && /\s/.test(block[k]!)) k--;
    const prev = k < 0 ? null : block[k]!;
    if (!(prev === null || prev === ';' || prev === '{' || prev === '}')) continue;
    // Terminating `;` at the statement's own delimiter depth (so a `;` inside call args
    // does not end it early).
    let d = 0;
    let semi = block.length;
    for (let j = m.index + m![0].length; j < block.length; j++) {
      const ch = block[j]!;
      if (ch === '{' || ch === '(' || ch === '[') d++;
      else if (ch === '}' || ch === ')' || ch === ']') d--;
      else if (ch === ';' && d === 0) { semi = j; break; }
    }
    return { kind: m[1] as 'return' | 'throw', exprStart: m.index + m![0].length, semi };
  }
  return null;
}

/**
 * The EXPRESSION of the branch's GUARANTEED return — the value the branch actually produces
 * when entered — or null when the branch does not unconditionally return one. This is now
 * REACHABILITY-AWARE: the outcome is the FIRST unconditional depth-0 control-flow terminator
 * ({@link firstUnconditionalTerminatorAtDepth0}). If that terminator is a `return`, its
 * expression is the outcome; if it is a `throw`, the branch throws and returns NO value
 * (null). A return that is nested in a `{ }` block, governed by a braceless conditional, or
 * placed AFTER a `throw`/earlier terminator (dead code) is therefore never mistaken for the
 * outcome — closing the gap where a lexical "first unconditional return" accepted an
 * UNREACHABLE return or the WRONG returned value.
 */
export function csharpFirstUnconditionalReturnAtDepth0(block: string): string | null {
  const term = firstUnconditionalTerminatorAtDepth0(block);
  if (term === null || term.kind !== 'return') return null;
  return block.slice(term.exprStart, term.semi).trim();
}

/**
 * Index of the `>` that closes a well-formed GENERIC type-argument group opened by the
 * `<` at `open`, or -1 if the text at `open` is NOT a well-formed generic group. A
 * generic group balances nested `<>` and encloses ONLY type-argument-safe characters
 * (C# identifier chars, `,`, `.`, `?`, `[]`, whitespace, nested `<>`). Any other
 * character (an operator such as `+`, `=`, `&`, `|`, `(`, or a `,`/`>`-less run to EOF)
 * means it is not a clean generic — the caller decides how to treat the ambiguity.
 * Unicode-identifier aware so a Unicode type name cannot break the group.
 */
const GENERIC_INNER = new RegExp(`[${CS_ID_PART},.?[\\]\\s]`, 'u');
function matchGenericClose(text: string, open: number): number {
  let gdepth = 0;
  for (let j = open; j < text.length; j++) {
    const c = text[j]!;
    if (c === '<') gdepth++;
    else if (c === '>') { gdepth--; if (gdepth === 0) return j; }
    else if (!GENERIC_INNER.test(c)) return -1;
  }
  return -1;
}

/**
 * Token-aware split of a C# argument/parameter list on TOP-LEVEL commas. Uses a TYPED
 * delimiter stack for `()`, `[]`, and `{}`: each closer must match the most recent
 * opener, so a MISMATCHED pair (`([)]`) FAILS CLOSED rather than being accepted by a
 * naive single depth counter. Commas inside a nested group are protected. A `<`
 * immediately after a C# identifier char is treated as a generic type-argument group
 * ONLY when it forms a well-formed group (`Ident<...>`); a `<` that follows an
 * identifier but is NOT a clean generic is AMBIGUOUS (generic vs. comparison) and FAILS
 * CLOSED. Input MUST already be comment/string-stripped (via `stripCSharpNoise`) so
 * string contents cannot contain stray delimiters. Unicode-identifier aware.
 */
const IDENT_BEFORE_ANGLE = new RegExp(`[${CS_ID_PART}]`, 'u');
export function splitTopLevelArgs(text: string): string[] {
  const out: string[] = [];
  const MATCHING: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
  const stack: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '(' || ch === '[' || ch === '{') { stack.push(ch); continue; }
    if (ch === ')' || ch === ']' || ch === '}') {
      const top = stack.pop();
      if (top === undefined) {
        throw new Error(`splitTopLevelArgs: unbalanced closing '${ch}' (fail closed)`);
      }
      if (top !== MATCHING[ch]) {
        throw new Error(`splitTopLevelArgs: mismatched delimiters '${top}' … '${ch}' (fail closed)`);
      }
      continue;
    }
    if (ch === '<' && i > 0 && IDENT_BEFORE_ANGLE.test(text[i - 1]!)) {
      // A `<` after an identifier is either a generic type-argument group or an
      // ambiguous comparison. Only a WELL-FORMED generic protects its commas; anything
      // else is ambiguous and FAILS CLOSED (we must never silently misparse it).
      const close = matchGenericClose(text, i);
      if (close < 0) {
        throw new Error("splitTopLevelArgs: ambiguous '<' (generic vs. comparison) (fail closed)");
      }
      i = close;
      continue;
    }
    if (ch === ',' && stack.length === 0) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  if (stack.length !== 0) {
    throw new Error(`splitTopLevelArgs: unbalanced '${stack.join('')}' (fail closed)`);
  }
  out.push(text.slice(start));
  return out;
}

/** A constructor-injected field bound to the declared type of its source parameter. */
export interface InjectedField {
  /** The declared type of the constructor parameter assigned to this field. */
  readonly type: string;
  /** The constructor parameter name the field is assigned from. */
  readonly parameter: string;
}

/**
 * Constructor-injected fields of the FIRST class in an extract, mapped
 * FIELD -> { type, parameter }. Binds each `this.field = param;` assignment in EVERY
 * top-level constructor to the parameter's declared type, so a call's receiver can be
 * proven to be a specific DI-injected dependency (whose concrete impl the DI
 * registration pins) rather than an arbitrary local. Parsed from the comment/literal-
 * stripped view so a decoy assignment in a comment/string is never counted.
 *
 * Robustness rules:
 *  - only TOP-LEVEL (brace depth 0) instance fields are considered, so a field
 *    declared inside a nested `struct`/block is never mistaken for an injected field;
 *  - ALL constructors (every overload/declaration form) are parsed and unioned, not
 *    just the first;
 *  - the assignment target MUST be a declared instance field (a `var x = param;` local
 *    is rejected), and the field's declared type must EQUAL (whitespace-normalized)
 *    the parameter's declared type;
 *  - a bare `name = param` is REJECTED when `name` is also a PARAMETER or a local of
 *    that constructor (both SHADOW the field in ctor scope — a bare assignment would be
 *    a parameter/local self-assignment, not a field write); only `this.name = param`
 *    binds the field unambiguously;
 *  - all parsing is SCOPED to a single class body (via `csharpClassBodies`), so a
 *    field/ctor/local from ANOTHER class in the same extract is never borrowed.
 */
export function csharpInjectedFields(extractText: string, className?: string): Record<string, InjectedField> {
  const out: Record<string, InjectedField> = {};
  // SCOPE all parsing to a SINGLE class body so a field/ctor/local declared in
  // ANOTHER class in the same extract can never be borrowed. csharpClassBodies splits
  // the extract into per-class bodies (and fails closed on nested/duplicate classes).
  // When `className` is given, we bind to EXACTLY that class (fail closed if absent), so a
  // DECOY class prepended to the extract cannot supply the injected field; otherwise we
  // fall back to the FIRST class (legacy single-class extracts).
  const bodies = csharpClassBodies(extractText);
  const classNames = Object.keys(bodies);
  if (classNames.length === 0) return out;
  let targetClass: string;
  if (className !== undefined) {
    if (!(className in bodies)) {
      throw new Error(`csharpInjectedFields: extract declares no class '${className}' (cannot bind injected fields)`);
    }
    targetClass = className;
  } else {
    targetClass = classNames[0]!;
  }
  const src = stripCSharpNoise(bodies[targetClass]!);

  const normalizeType = (t: string): string => t.replace(/\s+/g, '');

  // Brace depth at every index of the class body, so field/constructor parsing can be
  // restricted to the TOP LEVEL (depth 0). A field declared inside a nested struct or
  // any nested block (depth >= 1) is NOT a top-level instance field and must be
  // ignored (a nested-struct field could otherwise be mistaken for an injected field).
  const depthAt = new Array<number>(src.length + 1);
  {
    let d = 0;
    for (let i = 0; i < src.length; i++) {
      depthAt[i] = d;
      if (src[i] === '{') d++;
      else if (src[i] === '}') d--;
    }
    depthAt[src.length] = d;
  }

  // TOP-LEVEL declared INSTANCE fields (name -> declared type), collected only where
  // the declaration begins at brace depth 0. A field decl ends in `;` (a property ends
  // in `{ get; }`, a method in `(`), so neither is matched; `static`/`const` are
  // excluded because an injected dependency is an instance field.
  const fieldDecls: Record<string, string> = {};
  const fieldRe = /(?:private|protected|internal|public)\s+(?!static\b|const\b)((?:readonly\s+|volatile\s+)*)([A-Za-z_][\w.<>,?[\]]*)\s+([A-Za-z_]\w*)\s*;/g;
  let fm: RegExpExecArray | null;
  while ((fm = fieldRe.exec(src)) !== null) {
    if (depthAt[fm.index] !== 0) continue; // skip nested-struct / nested-block fields
    // REQUIRE the field to be READONLY (pass 48 finding #7): a `readonly` field cannot be
    // reassigned outside a constructor and cannot be passed as `ref`/`out` — the C# compiler
    // guarantees the DI-injected value is immutable, so a mutable (non-readonly) field could be
    // overwritten by a same-named-parameter assignment or a ref/out mutation and is NOT trusted
    // DI provenance. (A declared-readonly-but-reassigned adversarial extract is still caught by the
    // scope-aware overwrite + ref/out analysis below, since this analyzer does not compile.)
    if (!/\breadonly\b/.test(fm[1]!)) continue;
    fieldDecls[fm[3]!] = fm[2]!;
  }

  // Parse EVERY top-level constructor (all overloads/declaration forms), not just the
  // first. For DI to be RELIABLE the field must be assigned the parameter in EVERY
  // constructor (an OVERLOAD that omits it leaves the field null on that path), and the
  // assignment must be REACHABLE (not after a depth-0 early `return`/`throw`). So we count
  // the constructors and, per field, the constructors that unconditionally+reachably assign
  // it; a field kept only when it is assigned in ALL constructors.
  const ctorRe = new RegExp(`(?<![${CS_ID_PART}.])${targetClass}\\s*\\(`, 'gu');
  let cm: RegExpExecArray | null;
  let ctorCount = 0;
  const fieldInfo: Record<string, InjectedField> = {};
  const fieldAssignedCtors: Record<string, number> = {};
  // Body spans of every constructor, so the overwrite scan can tell an in-constructor injecting
  // assignment apart from a reassignment in another method (scope-aware, pass 48 finding #7).
  const ctorSpans: Array<{ open: number; end: number }> = [];
  while ((cm = ctorRe.exec(src)) !== null) {
    const openParen = src.indexOf('(', cm.index);
    if (openParen < 0 || depthAt[openParen] !== 0) continue;
    // Balance the parameter parentheses.
    let pdepth = 0;
    let close = -1;
    for (let j = openParen; j < src.length; j++) {
      if (src[j] === '(') pdepth++;
      else if (src[j] === ')') { pdepth--; if (pdepth === 0) { close = j; break; } }
    }
    if (close < 0) continue;
    // The body brace must follow with only whitespace / `: base(...)` / `: this(...)`
    // in between; a `;` means an abstract/extern declaration with no body.
    const open = src.indexOf('{', close);
    if (open < 0) continue;
    const between = src.slice(close + 1, open);
    if (between.includes(';')) continue;
    // Only accept as a constructor if the body brace is at depth 0 too (guards against
    // a method-call `ClassName(...)` inside another member being read as a ctor).
    if (depthAt[open] !== 0) continue;

    const paramTypes: Record<string, string> = {};
    for (const raw of splitTopLevelArgs(src.slice(openParen + 1, close))) {
      const t = raw.trim();
      if (t.length === 0) continue;
      const nameMatch = /([A-Za-z_]\w*)\s*$/.exec(t);
      if (nameMatch === null) continue;
      const type = t.slice(0, nameMatch.index).trim().replace(/^(?:this|params|in|out|ref)\s+/, '');
      if (type.length > 0) paramTypes[nameMatch[1]!] = type;
    }

    let bdepth = 0;
    let bodyEnd = -1;
    for (let j = open; j < src.length; j++) {
      if (src[j] === '{') bdepth++;
      else if (src[j] === '}') { bdepth--; if (bdepth === 0) { bodyEnd = j; break; } }
    }
    if (bodyEnd < 0) continue;
    const body = src.slice(open + 1, bodyEnd);
    ctorCount++;
    ctorSpans.push({ open, end: bodyEnd });
    // An EARLY-RETURNING constructor: everything after the first depth-0 `return`/`throw` is
    // unreachable, so an assignment there does NOT reliably bind the field. Bound reachable
    // assignments to before that terminator's `;`.
    const ctorTerm = firstUnconditionalTerminatorAtDepth0(body);
    const ctorDeadFrom = ctorTerm === null ? body.length : ctorTerm.semi;
    const assignedThisCtor = new Set<string>();

    // Constructor-LOCAL variable names (a typed or `var` declaration at a statement
    // boundary). A local — like a PARAMETER — SHADOWS a field, so a bare `name = x`
    // targeting it is NOT a field assignment.
    const LOCAL_DECL_KEYWORDS = new Set(['return', 'throw', 'await', 'yield', 'else', 'new', 'in', 'is', 'as', 'out', 'ref']);
    const locals = new Set<string>();
    const localRe = /(?:^|[;{}])\s*(var|[A-Za-z_][\w.<>,?[\]]*)\s+([A-Za-z_]\w*)\s*(?:=[^=]|;)/g;
    let lm: RegExpExecArray | null;
    while ((lm = localRe.exec(body)) !== null) {
      if (!LOCAL_DECL_KEYWORDS.has(lm[1]!)) locals.add(lm[2]!);
    }

    // An injected-field assignment must (a) read a constructor PARAMETER of THIS ctor,
    // (b) target a TOP-LEVEL DECLARED INSTANCE FIELD, (c) the field's declared type must
    // EQUAL (normalized) the parameter's declared type, (d) bind the FIELD, not a
    // shadowing name, (e) be UNCONDITIONAL — a direct top-level statement of the ctor
    // body (body brace-depth 0, beginning a statement), never inside an `if`/loop block or
    // governed by a braceless conditional, AND (f) be REACHABLE (before any depth-0 early
    // return). A CONDITIONAL DI assignment (e.g. `if (x) this.store = a; else this.store = b;`)
    // does not reliably bind the field to one dependency, so it is rejected — the field must
    // be assigned the parameter on EVERY path of EVERY constructor. A bare `name = param` is
    // REJECTED when `name` is also a PARAMETER or a local (both shadow the field in ctor
    // scope). The leading `(?<![A-Za-z0-9_.@])` boundary rejects a member-chain / verbatim
    // impersonation — the LHS must be an EXACT tokenized `this.<field>` or bare `<field>`.
    const bodyDepthAt = new Array<number>(body.length + 1);
    {
      let bd = 0;
      for (let i = 0; i < body.length; i++) {
        bodyDepthAt[i] = bd;
        if (body[i] === '{') bd++;
        else if (body[i] === '}') bd--;
      }
      bodyDepthAt[body.length] = bd;
    }
    const assign = new RegExp(`${NB_BEFORE}(this\\s*\\.\\s*)?([A-Za-z_]\\w*)\\s*=\\s*([A-Za-z_]\\w*)\\s*;`, 'gu');
    let a: RegExpExecArray | null;
    while ((a = assign.exec(body)) !== null) {
      if (bodyDepthAt[a.index] !== 0) continue;
      if (a.index > ctorDeadFrom) continue; // unreachable after a depth-0 early return/throw
      let pk = a.index - 1;
      while (pk >= 0 && /\s/.test(body[pk]!)) pk--;
      const pprev = pk < 0 ? null : body[pk]!;
      if (!(pprev === null || pprev === ';' || pprev === '{' || pprev === '}')) continue;
      const hasThis = a[1] !== undefined;
      const lhs = a[2]!;
      const rhs = a[3]!;
      if (!Object.prototype.hasOwnProperty.call(paramTypes, rhs)) continue;
      if (!Object.prototype.hasOwnProperty.call(fieldDecls, lhs)) continue;
      if (!hasThis && (locals.has(lhs) || Object.prototype.hasOwnProperty.call(paramTypes, lhs))) continue;
      if (normalizeType(fieldDecls[lhs]!) !== normalizeType(paramTypes[rhs]!)) continue;
      fieldInfo[lhs] = { type: fieldDecls[lhs]!, parameter: rhs };
      assignedThisCtor.add(lhs);
    }
    for (const f of assignedThisCtor) fieldAssignedCtors[f] = (fieldAssignedCtors[f] ?? 0) + 1;
  }
  // Keep a field ONLY when it is assigned in EVERY constructor (so no overload leaves it
  // unbound). If there are no constructors, there are no injected fields.
  for (const field of Object.keys(fieldInfo)) {
    if (ctorCount > 0 && fieldAssignedCtors[field] === ctorCount) out[field] = fieldInfo[field]!;
  }
  // OVERWRITE detection (dataflow-aware, pass 41 finding #6, hardened pass 45 #6 / 46 #7 / 47 #5):
  // drop any field that is later REASSIGNED to a value OTHER than its injected parameter — anywhere
  // in the class. Uses the C# IDENTIFIER LEXER so an ESCAPED spelling of the field
  // (`@store`/`st\u006fre`) is normalized and cannot evade detection, and a NESTED tuple
  // deconstruction (`((this.store, a), b) = …`) is caught (pass 47 finding #5). If a field can be
  // overwritten it is not stably the DI-injected dependency, so a receiver bound to it is untrusted.
  const classSrc = stripCSharpNoise(bodies[targetClass]!);
  const idToks = csharpIdentifierTokens(classSrc);
  const isWs = (c: string | undefined): boolean => c !== undefined && /\s/.test(c);
  // `classSrc` is the same string content as `src` (both `stripCSharpNoise(bodies[targetClass])`),
  // so the ctor body spans computed over `src` index into `classSrc` too.
  const inConstructor = (idx: number): boolean => ctorSpans.some((s) => idx > s.open && idx < s.end);
  for (const field of Object.keys(out)) {
    const param = out[field]!.parameter;
    let overwritten = false;
    for (let ti = 0; ti < idToks.length && !overwritten; ti++) {
      const tok = idToks[ti]!;
      if (tok.name !== field) continue;
      // QUALIFICATION: the field reference must be bare `field` or `this.field` — a `foo.field`
      // (member of another object) is NOT our field. If the preceding significant char is `.`, the
      // receiver token (the previous identifier token) must be exactly `this`.
      let p = tok.start - 1;
      while (p >= 0 && isWs(classSrc[p])) p--;
      const qualifiedThis = p >= 0 && classSrc[p] === '.';
      if (qualifiedThis) {
        const prev = idToks[ti - 1];
        if (!prev || prev.name !== 'this') continue; // foo.field / a.b.field — not our field
      }
      // REF/OUT mutation: the field passed as `ref (this.)?field` / `out (this.)?field` — the callee
      // can reassign it, so the field is not stably the injected dependency (pass 48 finding #7).
      // The `ref`/`out` keyword precedes the reference start (the `this` token if qualified).
      const refStartTok = qualifiedThis ? idToks[ti - 1]! : tok;
      let rp = refStartTok.start - 1;
      while (rp >= 0 && isWs(classSrc[rp])) rp--;
      if (rp >= 0 && /[A-Za-z0-9_]/.test(classSrc[rp]!)) {
        let rs = rp;
        while (rs >= 0 && /[A-Za-z0-9_]/.test(classSrc[rs]!)) rs--;
        const kw = classSrc.slice(rs + 1, rp + 1);
        if (kw === 'ref' || kw === 'out') { overwritten = true; continue; }
      }
      // AFTER the token: an assignment/compound operator?
      let q = tok.end;
      while (q < classSrc.length && isWs(classSrc[q])) q++;
      const c = classSrc[q];
      // Direct `=` assignment (not `==`/`=>`).
      if (c === '=' && classSrc[q + 1] !== '=' && classSrc[q + 1] !== '>') {
        let depth = 0;
        let end = -1;
        for (let j = q + 1; j < classSrc.length; j++) {
          const ch = classSrc[j]!;
          if (ch === '(' || ch === '[' || ch === '{') depth++;
          else if (ch === ')' || ch === ']' || ch === '}') depth--;
          else if (ch === ';' && depth === 0) { end = j; break; }
        }
        if (end < 0) continue;
        const rhs = classSrc.slice(q + 1, end).trim();
        // SCOPE-AWARE (pass 48 finding #7): an assignment to the field is the LEGITIMATE injection
        // ONLY when it is INSIDE a constructor body AND the RHS is exactly the injected parameter.
        // A `this.store = store` in a NON-constructor method (whose `store` is a DIFFERENT,
        // same-named method parameter) reassigns the field to an arbitrary value and is an
        // overwrite — the previous name-only `rhs === param` check let it survive.
        const injecting = inConstructor(tok.start) && rhs === param;
        if (!injecting) { overwritten = true; }
        continue;
      }
      // COMPOUND assignment: `+= -= *= /= %= &= |= ^=`, `<<=`/`>>=`, `>>>=`, `??=` — mutates the
      // field to a value derived from more than the injected parameter (or conditionally
      // overwrites it), so the field is not a stable injection.
      if (c !== undefined && '+-*/%&|^'.includes(c) && classSrc[q + 1] === '=') { overwritten = true; continue; }
      if ((c === '<' || c === '>') && classSrc[q + 1] === c && classSrc[q + 2] === '=') { overwritten = true; continue; }
      if (c === '>' && classSrc[q + 1] === '>' && classSrc[q + 2] === '>' && classSrc[q + 3] === '=') { overwritten = true; continue; }
      if (c === '?' && classSrc[q + 1] === '?' && classSrc[q + 2] === '=') { overwritten = true; continue; }
      // TUPLE-DECONSTRUCTION target (possibly NESTED): the field is an element of a parenthesized
      // deconstruction whose outer `)=` is an assignment.
      if (isTupleDeconstructionTarget(classSrc, tok.start)) { overwritten = true; continue; }
      // REF-RETURN write (pass 49 finding #5): the field aliased-and-written through an unsafe
      // ref-return (`Unsafe.AsRef(in this.store) = evil`) defeats `readonly` — drop the field.
      if (isRefReturnWriteTarget(classSrc, tok.start)) { overwritten = true; continue; }
    }
    if (overwritten) delete out[field];
  }
  return out;
}

/** True iff the identifier at `tokenStart` is an element of a TUPLE-DECONSTRUCTION assignment
 *  target — a parenthesized tuple (possibly NESTED, e.g. `((this.store, a), b) = …`) whose
 *  outermost enclosing group's matching `)` is immediately followed by a single `=` (not
 *  `==`/`=>`). Rejects a CALL/INVOCATION paren (a `(` preceded by an identifier / `)` / `]`), so a
 *  field READ inside a method call (`Foo(this.store)`) or a right-hand-side tuple is not mistaken
 *  for a deconstruction target. Input MUST be comment/string-stripped (pass 47 finding #5). */
function isTupleDeconstructionTarget(src: string, tokenStart: number): boolean {
  // Collect every enclosing `(` (innermost → outermost), stopping at a statement boundary.
  const opens: number[] = [];
  let depth = 0;
  for (let i = tokenStart - 1; i >= 0; i--) {
    const c = src[i]!;
    if (c === ')') depth++;
    else if (c === '(') { if (depth === 0) opens.push(i); else depth--; }
    else if (c === ';' || c === '{' || c === '}') break; // statement boundary
  }
  for (const open of opens) {
    // The `(` must begin a TUPLE, not a call/indexer: its preceding significant char must not be an
    // identifier char, `)`, or `]` (which would make it an invocation/indexer), and not `var`
    // (a `var (a, b) = …` declaration deconstructs into NEW locals, not this field).
    let p = open - 1;
    while (p >= 0 && /\s/.test(src[p]!)) p--;
    if (p >= 0 && /[A-Za-z0-9_)\]]/.test(src[p]!)) continue;
    // Find the matching close.
    let d = 0;
    let close = -1;
    for (let j = open; j < src.length; j++) {
      if (src[j] === '(') d++;
      else if (src[j] === ')') { d--; if (d === 0) { close = j; break; } }
    }
    if (close < 0) continue;
    let qq = close + 1;
    while (qq < src.length && /\s/.test(src[qq]!)) qq++;
    if (src[qq] === '=' && src[qq + 1] !== '=' && src[qq + 1] !== '>') return true;
  }
  return false;
}

/** True iff the identifier at `tokenStart` is passed BY REFERENCE (`ref`/`in`/`out`) to a CALL that
 *  produces a WRITABLE REF aliasing the (readonly) field — a ref-return write vector — e.g.
 *  `Unsafe.AsRef(in this.store) = evil;`, `Unsafe.As<A,B>(ref this.store) = x;`, or a CUSTOM
 *  ref-returning helper `ref var r = ref MyAsRef(in this.store); r = evil;`. Detection is bound to
 *  the ACTUAL ref-producing DATA FLOW (pass 51 finding #6), NOT to any enclosing call:
 *   1. the field must carry a `ref`/`in`/`out` ARGUMENT MODIFIER immediately before its reference
 *      (skipping an optional `this.` qualifier) — a BY-VALUE argument cannot be aliased by the
 *      callee's ref-return, so `Outer(Compute(this.store)) = evil` (where `this.store` is a nested
 *      BY-VALUE arg) does NOT flag the field; AND
 *   2. the INNERMOST enclosing call (the one that DIRECTLY receives the ref argument) must be a
 *      real call (a member-access chain precedes its `(`) whose RESULT is either ASSIGNED with a
 *      single `=` (`Call(ref field) = value`) or REF-CAPTURED (`= ref Call(in field)` /
 *      `return ref Call(...)`), so the returned ref escapes as a writable alias of the field.
 *  Input MUST be comment/string-stripped. */
function isRefReturnWriteTarget(src: string, tokenStart: number): boolean {
  const isIdent = (ch: string | undefined): boolean => ch !== undefined && /[A-Za-z0-9_]/.test(ch);
  // Reference start: skip an optional `this.` qualifier before the field token.
  let refStart = tokenStart;
  {
    let p = tokenStart - 1;
    while (p >= 0 && /\s/.test(src[p]!)) p--;
    if (p >= 0 && src[p] === '.') {
      let e = p - 1;
      while (e >= 0 && /\s/.test(src[e]!)) e--;
      let s = e;
      while (s >= 0 && isIdent(src[s]!)) s--;
      if (src.slice(s + 1, e + 1) === 'this') refStart = s + 1;
    }
  }
  // (1) ARGUMENT MODIFIER `ref`/`in`/`out` immediately before the reference. A by-value argument is
  // never aliased by a ref-return, so it is not a write vector.
  let mp = refStart - 1;
  while (mp >= 0 && /\s/.test(src[mp]!)) mp--;
  if (mp < 0 || !isIdent(src[mp]!)) return false;
  let ms = mp;
  while (ms >= 0 && isIdent(src[ms]!)) ms--;
  const modifier = src.slice(ms + 1, mp + 1);
  if (modifier !== 'ref' && modifier !== 'in' && modifier !== 'out') return false;
  // (2) The INNERMOST enclosing call — the `(` that directly contains this ref argument.
  let open = -1;
  {
    let depth = 0;
    for (let i = refStart - 1; i >= 0; i--) {
      const c = src[i]!;
      if (c === ')') depth++;
      else if (c === '(') { if (depth === 0) { open = i; break; } depth--; }
      else if (c === ';' || c === '{' || c === '}') break; // statement boundary
    }
  }
  if (open < 0) return false;
  // The `(` must be a CALL, and it may be one link of a FLUENT/POSTFIX chain (`First().Second(in
  // field)`, `A.B<T>(in field).C()`). Walk back over the ENTIRE postfix chain — identifier
  // segments, generic `<...>` groups, `.` separators, and preceding balanced call `(...)`/indexer
  // `[...]` groups — to the EXPRESSION ROOT, so a `ref`-capture of the WHOLE chain is seen even when
  // the field's own call is NOT the first link of the chain (pass 52 finding #4).
  let p = open - 1;
  let exprStart = -1;
  let sawCallee = false; // consumed at least the field-call's own callee identifier
  for (;;) {
    while (p >= 0 && /\s/.test(src[p]!)) p--;
    if (p < 0) break;
    const c = src[p]!;
    if (c === '>') { // a generic argument list `<...>`
      let gd = 0;
      for (; p >= 0; p--) { if (src[p] === '>') gd++; else if (src[p] === '<') { gd--; if (gd === 0) { p--; break; } } }
      continue;
    }
    if (c === ')' || c === ']') { // a preceding call/indexer group earlier in the fluent chain
      const openCh = c === ')' ? '(' : '[';
      let gd = 0;
      for (; p >= 0; p--) { if (src[p] === c) gd++; else if (src[p] === openCh) { gd--; if (gd === 0) { p--; break; } } }
      continue;
    }
    if (isIdent(c)) {
      while (p >= 0 && isIdent(src[p]!)) p--;
      exprStart = p + 1;
      sawCallee = true;
      // A chain segment continues ONLY across a `.` member access; otherwise this identifier is the
      // expression ROOT (so a preceding `ref`/`return` keyword is NOT mis-consumed as a segment).
      let q = p;
      while (q >= 0 && /\s/.test(src[q]!)) q--;
      if (q >= 0 && src[q] === '.') { p = q - 1; continue; }
      break;
    }
    if (c === '.') { p--; continue; } // a `.` reached directly after a postfix group
    break;
  }
  if (!sawCallee || exprStart < 0) return false; // not a call chain (a tuple/paren group)
  // Find the matching close of this call group (needed for the grouping-paren expansion and the
  // (2a) assignment check).
  let d = 0;
  let close = -1;
  for (let j = open; j < src.length; j++) {
    if (src[j] === '(') d++;
    else if (src[j] === ')') { d--; if (d === 0) { close = j; break; } }
  }
  if (close < 0) return false;
  // GROUPING-PAREN EXPANSION (pass 53 finding #5): a ref-return may be wrapped in PURE GROUPING
  // parens, e.g. `ref var r = ref (Unsafe.AsRef(in this.store));` or `(Unsafe.AsRef(ref f)) = v;`.
  // Expand `exprStart`/`close` outward through each matching grouping pair `( … )` that wraps the
  // whole call expression, so the `ref`-capture keyword (2b) and the assignment `=` (2a) are seen
  // through the parens. A `(` PRECEDED by an identifier/generic-close/indexer/`)` is a CALL/indexer
  // paren (not grouping) and stops the expansion, so `Foo(M(in f)) = v` is NOT mistaken for a
  // grouped `M(in f)` (Foo's ref-return does not alias the by-value nested `f`).
  for (;;) {
    let a = exprStart - 1;
    while (a >= 0 && /\s/.test(src[a]!)) a--;
    if (a < 0 || src[a] !== '(') break;
    let b = a - 1;
    while (b >= 0 && /\s/.test(src[b]!)) b--;
    // A `(` PRECEDED by a generic-close/indexer/call-close, or by an identifier that is NOT the
    // `ref` capture keyword, is a CALL/indexer paren (not grouping) and stops the expansion.
    if (b >= 0 && /[>\])]/.test(src[b]!)) break;
    if (b >= 0 && isIdent(src[b]!)) {
      let bs = b;
      while (bs >= 0 && isIdent(src[bs]!)) bs--;
      if (src.slice(bs + 1, b + 1) !== 'ref') break; // a real callee name → a call paren
    }
    let z = close + 1;
    while (z < src.length && /\s/.test(src[z]!)) z++;
    if (src[z] !== ')') break;
    let bd = 0;
    let match = -1;
    for (let j = a; j < src.length; j++) { if (src[j] === '(') bd++; else if (src[j] === ')') { bd--; if (bd === 0) { match = j; break; } } }
    if (match !== z) break; // the `(` before does not pair with the `)` after — not a wrapping group
    exprStart = a;
    close = z;
  }
  // (2b) REF-CAPTURE of the whole (possibly grouped) postfix chain: the `ref` keyword immediately
  // precedes the EXPRESSION ROOT (`= ref <chain>` / `return ref <chain>`), so the returned ref
  // escapes as a writable alias of the field even when a fluent/generic link — not the root —
  // received it, or when the chain is wrapped in grouping parens.
  let rp = exprStart - 1;
  while (rp >= 0 && /\s/.test(src[rp]!)) rp--;
  if (rp >= 0 && isIdent(src[rp]!)) {
    let rs = rp;
    while (rs >= 0 && isIdent(src[rs]!)) rs--;
    if (src.slice(rs + 1, rp + 1) === 'ref') return true;
  }
  // (2a) The call result (optionally after a `.Member`/`<...>`/`[...]`/further `(...)` chain, and
  // through any wrapping grouping parens already unwrapped into `close`) is assigned with a single
  // `=` → a ref-return write.
  let qq = close + 1;
  for (;;) {
    while (qq < src.length && /\s/.test(src[qq]!)) qq++;
    const ch = src[qq];
    if (ch === '=' && src[qq + 1] !== '=' && src[qq + 1] !== '>') return true;
    // Consume a fluent continuation: `.`, a `<...>`/`[...]`/`(...)` group, or an identifier.
    if (ch === '.') { qq++; continue; }
    if (ch === '<' || ch === '[' || ch === '(') {
      const openCh = ch;
      const closeCh = ch === '<' ? '>' : ch === '[' ? ']' : ')';
      let gd = 0;
      let k = qq;
      for (; k < src.length; k++) { if (src[k] === openCh) gd++; else if (src[k] === closeCh) { gd--; if (gd === 0) break; } }
      if (k >= src.length) break;
      qq = k + 1;
      continue;
    }
    if (ch !== undefined && /[A-Za-z0-9_]/.test(ch)) { while (qq < src.length && /[A-Za-z0-9_]/.test(src[qq]!)) qq++; continue; }
    break;
  }
  return false;
}

/**
 * The START indices of every WRITE to the BARE LOCAL variable `name` in a (comment/literal-stripped)
 * C# body, across ALL write forms — so a check that a local is written exactly once cannot be evaded
 * by an alternate write syntax (pass 49 finding #4). A write is any of:
 *   - a PLAIN or COMPOUND assignment `name = …` / `name += …` / `name <<= …` / `name >>>= …`;
 *   - a NULL-COALESCING assignment `name ??= …`;
 *   - a TUPLE-DECONSTRUCTION target `(…, name, …) = …` (possibly nested);
 *   - a REF/OUT argument `ref name` / `out name` (the callee may reassign it);
 *   - a REF-RETURN write through the local (`Unsafe.AsRef(in name) = …`);
 *   - a PREFIX or POSTFIX increment/decrement `++name` / `--name` / `name++` / `name--` (which
 *     mutates the local, pass 50 finding #4).
 * A MEMBER access (`obj.name`, `name.Member`) is NOT a write of the local. Input MUST be
 * comment/string-stripped.
 */
export function csharpLocalWriteIndices(body: string, name: string): number[] {
  const src = stripCSharpNoise(body);
  const toks = csharpIdentifierTokens(src);
  const isWs = (c: string | undefined): boolean => c !== undefined && /\s/.test(c);
  const out: number[] = [];
  for (let ti = 0; ti < toks.length; ti++) {
    const tok = toks[ti]!;
    if (tok.name !== name) continue;
    // Skip a MEMBER access: `X.name` (preceded by `.`) or `name.Member` — a `.` on either side
    // means the token is a member, not the standalone local.
    let p = tok.start - 1;
    while (p >= 0 && isWs(src[p])) p--;
    if (p >= 0 && src[p] === '.') continue; // X.name
    let q0 = tok.end;
    while (q0 < src.length && isWs(src[q0])) q0++;
    if (src[q0] === '.') continue; // name.Member (a read of a member, not a write of the local)
    // PREFIX increment/decrement `++name` / `--name` (the `++`/`--` immediately precedes the token).
    if (p >= 1 && ((src[p] === '+' && src[p - 1] === '+') || (src[p] === '-' && src[p - 1] === '-'))) {
      out.push(tok.start); continue;
    }
    // POSTFIX increment/decrement `name++` / `name--` (a doubled `+`/`-` immediately follows).
    if ((src[q0] === '+' && src[q0 + 1] === '+') || (src[q0] === '-' && src[q0 + 1] === '-')) {
      out.push(tok.start); continue;
    }
    // REF/OUT argument.
    if (p >= 0 && /[A-Za-z0-9_]/.test(src[p]!)) {
      let rs = p;
      while (rs >= 0 && /[A-Za-z0-9_]/.test(src[rs]!)) rs--;
      const kw = src.slice(rs + 1, p + 1);
      if (kw === 'ref' || kw === 'out') { out.push(tok.start); continue; }
    }
    // Assignment / compound / coalescing following the token.
    const c = src[q0];
    if (c === '=' && src[q0 + 1] !== '=' && src[q0 + 1] !== '>') { out.push(tok.start); continue; }
    if (c !== undefined && '+-*/%&|^'.includes(c) && src[q0 + 1] === '=') { out.push(tok.start); continue; }
    if ((c === '<' || c === '>') && src[q0 + 1] === c && src[q0 + 2] === '=') { out.push(tok.start); continue; }
    if (c === '>' && src[q0 + 1] === '>' && src[q0 + 2] === '>' && src[q0 + 3] === '=') { out.push(tok.start); continue; }
    if (c === '?' && src[q0 + 1] === '?' && src[q0 + 2] === '=') { out.push(tok.start); continue; }
    // TUPLE-DECONSTRUCTION target / REF-RETURN write.
    if (isTupleDeconstructionTarget(src, tok.start)) { out.push(tok.start); continue; }
    if (isRefReturnWriteTarget(src, tok.start)) { out.push(tok.start); continue; }
  }
  return out;
}

/** A resolved method invocation: its receiver, qualification, and arguments. */
export interface CSharpInvocation {
  /** The receiver identifier with a leading `this.` stripped (e.g. `evaluator`). */
  readonly receiver: string;
  /** True iff the call was `this.`-qualified (`this.field.Method(...)`), so a bare
   *  shadowing local `field.Method(...)` can be distinguished from the real field. */
  readonly qualified: boolean;
  /** The raw argument text between the balanced call parentheses. */
  readonly args: string;
  /** The COMPLETE argument list, split at top-level commas (each trimmed), so a
   *  partial/extra/reordered argument list can be compared structurally. */
  readonly argList: readonly string[];
  /** True iff the invocation is directly `await`ed (`await this.field.Method(...)`), so a
   *  fire-and-forget (unawaited) persistence can be distinguished from an awaited one. The
   *  `await` keyword must immediately precede the receiver (only whitespace between). */
  readonly awaited: boolean;
  /** True iff the invocation is an UNCONDITIONAL straight-line statement of the method body —
   *  at brace depth 0 (not nested inside an `if`/loop/`try`/etc. block) AND not governed by a
   *  BRACELESS control header (`if (c) this.f();`). A CONDITIONAL or braceless-dead call is
   *  `false`, so a persistence that only runs on some path can be rejected. */
  readonly unconditional: boolean;
}

/**
 * True iff `index` lies inside a LOCAL FUNCTION, LAMBDA (brace- OR expression-bodied), or
 * ANONYMOUS DELEGATE body — a block/expression that does NOT run as part of the enclosing
 * method's straight-line flow unless the function / lambda / delegate is invoked. Walks the
 * enclosing `{ }` blocks that are still open at `index`; for each, inspects the token
 * immediately before its opening `{`:
 *   - `=>` marks a brace-bodied LAMBDA body;
 *   - `delegate` (or `delegate(params)`) marks an ANONYMOUS DELEGATE body;
 *   - `)` whose matching `(` is preceded by an IDENTIFIER name (not a control-flow keyword
 *     like `if`/`while`/`catch`, and not an object-creation `new Type(...)`) that ITSELF has a
 *     preceding return-type/modifier token marks a LOCAL FUNCTION declaration body.
 * It ALSO detects an EXPRESSION-BODIED lambda (`x => this.f()` with no braces) by scanning
 * back, within the current statement/expression, for a `=>` whose body is not brace-introduced.
 * A plain nested scope, a `try`/`if`/`for`/`catch` block, or an object/collection initializer
 * is NOT treated as deferred. Input MUST be comment/string-stripped so a `{`/`(` inside a
 * literal cannot skew the matching.
 */
export function csharpEnclosedInLocalFunctionOrLambda(src: string, index: number): boolean {
  const openStack: number[] = [];
  for (let i = 0; i < index; i++) {
    const c = src[i];
    if (c === '{') openStack.push(i);
    else if (c === '}') openStack.pop();
  }
  const CONTROL = new Set([
    'if', 'else', 'for', 'foreach', 'while', 'do', 'switch', 'using', 'lock', 'fixed',
    'catch', 'finally', 'try', 'unsafe', 'checked', 'unchecked',
  ]);
  const identEndingAt = (end: number): { name: string; start: number } => {
    let t = end;
    while (t >= 0 && /[A-Za-z0-9_]/.test(src[t]!)) t--;
    return { name: src.slice(t + 1, end + 1), start: t + 1 };
  };
  for (let s = openStack.length - 1; s >= 0; s--) {
    const bracePos = openStack[s]!;
    let k = bracePos - 1;
    while (k >= 0 && /\s/.test(src[k]!)) k--;
    if (k < 0) continue;
    // LAMBDA: `=> {`.
    if (src[k] === '>' && src[k - 1] === '=') return true;
    // ANONYMOUS DELEGATE (bare): `delegate {`.
    if (/[A-Za-z0-9_]/.test(src[k]!)) {
      const { name } = identEndingAt(k);
      if (name === 'delegate') return true;
    }
    // LOCAL FUNCTION / anonymous-delegate-with-params / control block / initializer: `) {`.
    if (src[k] === ')') {
      let depth = 0;
      let p = k;
      for (; p >= 0; p--) {
        if (src[p] === ')') depth++;
        else if (src[p] === '(') { depth--; if (depth === 0) break; }
      }
      if (p < 0) continue;
      let t = p - 1;
      while (t >= 0 && /\s/.test(src[t]!)) t--;
      const { name, start } = identEndingAt(t);
      if (name.length === 0) continue; // e.g. `)(` — not a named header
      if (name === 'delegate') return true; // delegate(params) { ... } anonymous delegate
      if (CONTROL.has(name)) continue; // if/while/for/catch/... => a control block
      // The token BEFORE the name: `new` => object creation (not a local fn); an
      // identifier / `>` / `]` => a return type/modifier => a local-function header.
      let b = start - 1;
      while (b >= 0 && /\s/.test(src[b]!)) b--;
      if (b < 0) continue;
      const prevIdent = identEndingAt(b);
      if (prevIdent.name === 'new') continue; // object/collection initializer
      const prevCh = src[b]!;
      if (/[A-Za-z0-9_>\]]/.test(prevCh)) return true; // has a return type -> local function
      continue;
    }
  }
  // EXPRESSION-BODIED lambda: scan back within the current statement/expression for a `=>`
  // whose body is NOT brace-introduced. A brace-bodied lambda is already caught by the block
  // walk above, so here we only fire for an expression body (`x => this.f()`).
  const blockStart = openStack.length ? openStack[openStack.length - 1]! : -1;
  let d = 0; // parenthesis/bracket depth, going BACKWARD (a closer raises it)
  for (let i = index - 1; i > blockStart; i--) {
    const c = src[i]!;
    if (c === ')' || c === ']') d++;
    else if (c === '(' || c === '[') { if (d === 0) break; d--; } // exited the enclosing group
    else if (c === ';' && d === 0) break; // statement boundary
    else if (c === '{' || c === '}') break; // block boundary
    else if (c === '>' && i > 0 && src[i - 1] === '=') {
      let a = i + 1;
      while (a < src.length && /\s/.test(src[a]!)) a++;
      if (src[a] !== '{') return true; // expression-bodied lambda/delegate body
      break;
    }
  }
  return false;
}

/**
 * True iff the region `[from, to)` of a comment/literal-stripped C# body contains a METHOD-LEVEL
 * early exit (`return`/`throw`/`yield`) or a BRANCH / EXCEPTION / SCOPE control construct
 * (`if`/`else`/`while`/`for`/`foreach`/`switch`/`case`/`try`/`catch`/`finally`/`using`/`lock`/
 * `fixed`/`do`/`goto`), OR a KNOWN-THROWING call (a guard/throw idiom such as
 * `ThrowIfCancellationRequested()`, `Throw…`/`ThrowIf…`, `Ensure…`, `Require…`, `Verify…`,
 * `Validate…`, or a `Guard.…` clause), that is NOT confined to a nested lambda / local-function /
 * delegate body. Any of these introduces a path (a nested `return`/`throw`, or an EXCEPTION thrown
 * by a guard call) that can BYPASS code placed after the region, so its ABSENCE proves that whatever
 * executes at/after `to` DOMINATES every method exit reachable from `from` — i.e. a straight-line,
 * single-exit region. Used to prove a mandatory state transition and its persistence cannot be
 * skipped by a nested return OR a throwing guard call on any path (pass 52 finding #5, hardened for
 * known-throwing calls in pass 53 finding #4). A control keyword / call inside a nested
 * lambda/local function is that callee's own flow, not the enclosing method's, so it is ignored via
 * {@link csharpEnclosedInLocalFunctionOrLambda}. Input MUST be comment/string-stripped.
 */
export function csharpRegionHasBypassingControl(src: string, from: number, to: number): boolean {
  const region = src.slice(from, to);
  const kws = /(?<![A-Za-z0-9_])(?:return|throw|yield|if|else|while|for|foreach|switch|case|try|catch|finally|using|lock|fixed|do|goto)(?![A-Za-z0-9_])/g;
  let m: RegExpExecArray | null;
  while ((m = kws.exec(region)) !== null) {
    const abs = from + m.index;
    if (csharpEnclosedInLocalFunctionOrLambda(src, abs)) continue; // a nested callee's own control
    return true;
  }
  // KNOWN-THROWING calls: a guard/throw idiom that can raise an exception, bypassing the code after
  // the region on the exception path. Matched on the CALL leaf name (after an optional receiver
  // chain), so `cancellationToken.ThrowIfCancellationRequested()`, `Guard.AgainstNull(...)`, a
  // MEMBER-CHAIN guard `Guard.Against.Null(...)` (any depth of members rooted at `Guard`, pass 54
  // finding R3), or an `EnsureNotTerminal(...)`/`ValidateState(...)`/`RequireOpen(...)` between the
  // transition and the persistence defeats dominance (pass 53 finding #4).
  const throwingCall = /(?<![A-Za-z0-9_])(?:Guard(?:\s*\.\s*[A-Za-z_]\w*)+|(?:Throw|ThrowIf|Ensure|Require|Verify|Validate)[A-Za-z0-9_]*)\s*\(/g;
  let tc: RegExpExecArray | null;
  while ((tc = throwingCall.exec(region)) !== null) {
    const abs = from + tc.index;
    if (csharpEnclosedInLocalFunctionOrLambda(src, abs)) continue;
    return true;
  }
  return false;
}

/**
 * The FIRST REACHABLE invocation of `method` in a (comment/literal-stripped) C# body, with
 * its receiver identifier, `this.` QUALIFICATION, and the STRUCTURALLY-parsed argument list.
 * Used to BIND a call to the specific DI-injected field it is issued on — a receiver-bound,
 * qualification-aware check, not a bare method-name match that any unrelated `Foo.method(`
 * could satisfy. Preserving qualification prevents a bare shadowing local from impersonating
 * `this.<field>`.
 *
 * REACHABILITY-AWARE: a match that occurs in DEAD CODE — after the body's first unconditional
 * depth-0 `return`/`throw` ({@link firstUnconditionalTerminatorAtDepth0}) — is IGNORED, so a
 * decoy call placed after an unconditional return/throw cannot satisfy the check while the
 * reachable path omits it. A call INSIDE the terminating statement's own expression (e.g.
 * `return this.store.SaveAsync(...)`) is reachable and still matched. A match nested inside a
 * LOCAL FUNCTION / LAMBDA / DELEGATE body ({@link csharpEnclosedInLocalFunctionOrLambda}) or a
 * constant-`false` dead block ({@link csharpEnclosedInConstantFalseBlock}) is SKIPPED — such a
 * call is not part of the method's straight-line flow, so an "uncalled local function",
 * "expression lambda", "anonymous delegate", or "if(false)" decoy cannot satisfy the check.
 */
export function csharpInvocation(body: string, method: string): CSharpInvocation | null {
  const src = stripCSharpNoise(body);
  // Reachability boundary: everything AFTER the first depth-0 return/throw statement's
  // terminating `;` is dead code. A call within the terminating statement's expression is
  // reachable (index <= semi), so the cutoff is the terminator's `;` index.
  const term = firstUnconditionalTerminatorAtDepth0(src);
  const deadFrom = term === null ? src.length : term.semi;
  const escaped = method.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Allow whitespace/newlines around the connecting dot for fluent-call style
  // (`this.field\n    .Method(...)`). The receiver captures an optional `this.` and is
  // a SINGLE identifier (not a member chain). The leading `(?<![A-Za-z0-9_.@])` boundary
  // rejects a member-chain (`a.b.Method`) or verbatim-identifier (`@this.field.Method`)
  // impersonation — the receiver must be an EXACT tokenized `this.<field>` or `<field>`.
  const re = new RegExp(`${NB_BEFORE}((?:this\\s*\\.\\s*)?[A-Za-z_]\\w*)\\s*\\.\\s*${escaped}\\s*\\(`, 'gu');
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    if (m.index > deadFrom) return null; // the call and everything after it is unreachable
    // Skip a call nested inside an uncalled local function / lambda / delegate body — it is not
    // part of the method's straight-line flow (dataflow-aware, pass 41/42 finding #6).
    if (csharpEnclosedInLocalFunctionOrLambda(src, m.index)) continue;
    // Skip a call inside a constant-`false` dead block (`if (false) { ... }`) — unreachable.
    if (csharpEnclosedInConstantFalseBlock(src, m.index)) continue;
    const qualified = /^this\s*\.\s*/.test(m[1]!);
    const receiver = m[1]!.replace(/^this\s*\.\s*/, '');
    // `await`-detection: skip whitespace backwards from the receiver start; the immediately
    // preceding token must be the `await` keyword on an identifier boundary.
    const before = src.slice(0, m.index).replace(/\s+$/, '');
    const awaited = /(?<![A-Za-z0-9_])await$/u.test(before);
    const unconditional = csharpUnconditionalStraightLine(src, m.index);
    const paren = m.index + m[0].length - 1;
    let depth = 0;
    for (let j = paren; j < src.length; j++) {
      if (src[j] === '(') depth++;
      else if (src[j] === ')') {
        depth--;
        if (depth === 0) {
          const args = src.slice(paren + 1, j);
          const argList = args.trim().length === 0 ? [] : splitTopLevelArgs(args).map((a) => a.trim());
          return { receiver, qualified, args, argList, awaited, unconditional };
        }
      }
    }
    return null;
  }
  return null;
}

/**
 * True iff the call at `index` is an UNCONDITIONAL straight-line statement that DOMINATES the
 * method exit:
 * (a) at brace depth 0 (not nested inside an `if`/loop/`try`/`using`/`lock`/etc. block), AND
 * (b) not governed by a BRACELESS control header on the same statement (`if (c) this.f();`,
 *     `else this.f();`, `while (c) this.f();`, …), AND
 * (c) NO CONDITIONAL EARLY EXIT precedes it — there is no reachable `return`/`throw` before the
 *     call (a nested-block `return`/`throw`, or a braceless-conditional `if (c) return;`), because
 *     such an early exit means the call is SKIPPED on that path (it does not dominate exit).
 * A `return`/`throw` enclosed in a LOCAL FUNCTION / LAMBDA body is not a method exit and is
 * ignored. Ordinary lead-ins (`var x = await`, an assignment) are unconditional. Input MUST be
 * comment/string-stripped.
 */
function csharpUnconditionalStraightLine(src: string, index: number): boolean {
  let depth = 0;
  for (let i = 0; i < index; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') depth--;
  }
  if (depth !== 0) return false; // inside a braced block (if/loop/try/using/lock/switch/…)
  // Nearest preceding statement boundary at bracket/paren depth 0.
  let d = 0;
  let start = 0;
  for (let i = index - 1; i >= 0; i--) {
    const c = src[i]!;
    if (c === ')' || c === ']') d++;
    else if (c === '(' || c === '[') { if (d > 0) d--; }
    else if (d === 0 && (c === ';' || c === '{' || c === '}')) { start = i + 1; break; }
  }
  const prefix = src.slice(start, index).trim();
  // A braceless control header before the call makes the call conditional.
  if (/^(?:else\s+)?if\b/.test(prefix)) return false;
  if (/^(?:while|for|foreach|switch|lock|using|fixed)\b/.test(prefix)) return false;
  if (/^(?:else|do)\b/.test(prefix)) return false;
  // GOTO breaks straight-line reasoning: a `goto`/label can skip the call (a forward jump over
  // it) or re-enter (a backward jump), so a call in a method that uses `goto` cannot be proven to
  // dominate the exit. Fail closed if any `goto` (or a label target `name:`) appears before the
  // call's own statement (pass 46 finding #7).
  const preRegion = src.slice(0, start);
  if (/(?<![A-Za-z0-9_])goto(?![A-Za-z0-9_])/.test(preRegion)) return false;
  // (c) DOMINANCE: reject the call if ANY reachable `return`/`throw` precedes it IN AN EARLIER
  // statement — a conditional early exit (nested in a block, or a braceless-conditional at depth
  // 0) means the call is skipped on that path, so it does not dominate the method exit. Only exits
  // BEFORE the call's own statement (`< start`) count, so a `return this.f(...)` whose returned
  // expression IS the call is not self-disqualified. A `return`/`throw` inside a local function /
  // lambda body is not a method exit and is ignored.
  const exitRe = /(?<![A-Za-z0-9_])(?:return|throw)(?![A-Za-z0-9_])/g;
  let e: RegExpExecArray | null;
  while ((e = exitRe.exec(src)) !== null) {
    if (e.index >= start) break; // only exits in an EARLIER statement matter
    if (csharpEnclosedInLocalFunctionOrLambda(src, e.index)) continue; // not a method exit
    // Any reachable method-level return/throw before the call means the call is not guaranteed to
    // run on every path (it is guarded / the call is dead) → it does not dominate.
    return false;
  }
  return true;
}

/**
 * True iff `index` lies inside a block whose governing guard is a CONSTANT-`false` condition —
 * `if (false) { … }` or `while (false) { … }` (whitespace-insensitive) — i.e. dead code that
 * never executes. Walks the enclosing `{ }` blocks open at `index`; a block counts when its
 * opening `{` is preceded by `)` whose matched `(…)` condition is EXACTLY the literal `false`
 * and the keyword before the `(` is `if`/`while`. Input MUST be comment/string-stripped.
 */
export function csharpEnclosedInConstantFalseBlock(src: string, index: number): boolean {
  const openStack: number[] = [];
  for (let i = 0; i < index; i++) {
    const c = src[i];
    if (c === '{') openStack.push(i);
    else if (c === '}') openStack.pop();
  }
  for (let s = openStack.length - 1; s >= 0; s--) {
    const bracePos = openStack[s]!;
    let k = bracePos - 1;
    while (k >= 0 && /\s/.test(src[k]!)) k--;
    if (src[k] !== ')') continue;
    // Match the condition parens.
    let depth = 0;
    let p = k;
    for (; p >= 0; p--) {
      if (src[p] === ')') depth++;
      else if (src[p] === '(') { depth--; if (depth === 0) break; }
    }
    if (p < 0) continue;
    const cond = src.slice(p + 1, k).replace(/\s+/g, '');
    if (cond !== 'false') continue;
    let t = p - 1;
    while (t >= 0 && /\s/.test(src[t]!)) t--;
    let kw = '';
    while (t >= 0 && /[A-Za-z]/.test(src[t]!)) { kw = src[t]! + kw; t--; }
    if (kw === 'if' || kw === 'while') return true;
  }
  return false;
}
