import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  stripCSharpNoise,
  commentStrippedCSharp,
  assertLexableCSharp,
  csharpMethodNames,
  csharpMethodBody,
  csharpDirectMethodBody,
  csharpExtensionMethodBodies,
  csharpClassBodies,
  serializedFieldsByClass,
  serializedWireNames,
  enumWireValues,
  csharpPropertyTypes,
  csharpPropertyTypesByClass,
  channelElementModels,
  diBindings,
  csharpInjectedFields,
  csharpInvocation,
  csharpLocalWriteIndices,
  csharpEnclosedInLocalFunctionOrLambda,
  csharpRegionHasBypassingControl,
  csharpGuardedEarlyReturns,
  csharpFirstUnconditionalReturnAtDepth0,
  httpStatusCodes,
  csharpReferencesIdentifier,
  csharpStringLiterals,
  csharpReferencesHttp412,
  csharpAllStringValues,
  csharpConditionalRequestHeaderArg,
  csharpConditionalRequestHeaderLiteral,
  csharpComposedConditionalRequestHeader,
  splitTopLevelArgs,
  csharpIntConst,
} from './source-extracts.ts';

// Adversarial tests for the lexical C# parsers. Each case is crafted to fool a
// naive regex/brace matcher; the lexically-aware parsers must not be fooled.

test('stripCSharpNoise blanks line and block comment contents but keeps code', () => {
  const src = 'int a = 1; // HttpStatusCode.PreconditionFailed here\n/* If-Match */ int b = 2;';
  const stripped = stripCSharpNoise(src);
  assert.match(stripped, /int a = 1;/);
  assert.match(stripped, /int b = 2;/);
  assert.ok(!stripped.includes('PreconditionFailed'), 'comment content is blanked');
  assert.ok(!stripped.includes('If-Match'), 'block comment content is blanked');
});

test('httpStatusCodes ignores status names that appear only in comments or strings', () => {
  const src = `
    // returns HttpStatusCode.PreconditionFailed in a comment
    var s = "HttpStatusCode.Conflict in a string";
    return HttpStatusCode.Accepted;
  `;
  const codes = httpStatusCodes(src);
  assert.deepEqual(codes, ['Accepted'], 'only the real code reference is counted');
});

test('httpStatusCodes requires the exact System.Net.HttpStatusCode token (rejects impostors)', () => {
  const src = `
    // A DIFFERENT type that merely ENDS in HttpStatusCode must NOT be counted:
    var a = MyHttpStatusCode.OK;
    var b = Vendor.CustomHttpStatusCode.NotFound;
    // A same-named type under a FOREIGN qualifier must NOT be counted:
    var c = Other.HttpStatusCode.Forbidden;
    // These ARE the real enum — bare and fully-qualified:
    return x ? HttpStatusCode.Accepted : System.Net.HttpStatusCode.OK;
  `;
  const codes = httpStatusCodes(src).sort();
  assert.deepEqual(codes, ['Accepted', 'OK'], 'only the exact HttpStatusCode / System.Net.HttpStatusCode references are counted');
  assert.ok(!codes.includes('NotFound') && !codes.includes('Forbidden'), 'impostor identifiers are rejected');
});

test('httpStatusCodes rejects Unicode prefixes, alias qualification, and suffixed members (exact token boundaries)', () => {
  const src = `
    // UNICODE-PREFIXED impostor: a Unicode identifier-part char IMMEDIATELY before the
    // token must fail the boundary. An ASCII-only lookbehind ([A-Za-z0-9_.]) does NOT
    // contain 'e-acute', so it would let this identifier impersonate the enum:
    var u = \u00e9HttpStatusCode.OK;
    // A non-global ALIAS qualifier must be rejected (only global:: aliases the global
    // namespace; System.Net. is the accepted explicit qualifier). A bare global::HttpStatusCode
    // (no System.Net) names the ROOT-namespace type, NOT System.Net.HttpStatusCode — impostor:
    var g = global::HttpStatusCode.Conflict;
    var n = MyAlias::System.Net.HttpStatusCode.NotFound;
    // A global::System.Net.HttpStatusCode IS the real enum (global root + explicit namespace):
    var g2 = global::System.Net.HttpStatusCode.Gone;
    // SUFFIXED members must be read as their OWN distinct token, never truncated to a
    // real member name (Accepted_x is NOT Accepted; OK2 is NOT OK):
    var s1 = HttpStatusCode.Accepted_x;
    var s2 = HttpStatusCode.OK2;
    // A UNICODE-suffixed member is likewise its own token, not a truncated 'OK':
    var s3 = HttpStatusCode.OK\u00e9;
    // The one REAL, exactly-bounded reference:
    return HttpStatusCode.Accepted;
  `;
  const codes = httpStatusCodes(src);
  // The real, exactly-bounded reference is present.
  assert.ok(codes.includes('Accepted'), 'the exactly-bounded HttpStatusCode.Accepted is counted');
  // A Unicode-prefixed impostor and a suffixed member are not read as the real short name.
  assert.ok(!codes.includes('OK'), 'a Unicode-prefixed impostor (and a suffixed OK2) are not read as OK');
  // A bare global::HttpStatusCode (no System.Net) is the ROOT-namespace impostor — rejected;
  // only global::System.Net.HttpStatusCode is the real enum.
  assert.ok(!codes.includes('Conflict'), 'a bare global::HttpStatusCode (root namespace) is NOT System.Net.HttpStatusCode (finding #10)');
  assert.ok(codes.includes('Gone'), 'a global::System.Net.HttpStatusCode reference IS the real enum');
  assert.ok(!codes.includes('NotFound'), 'a NON-global alias (MyAlias::) qualified reference is rejected');
  // A suffixed member is reported as its OWN COMPLETE token, never truncated to a real
  // member name, so a downstream `.includes('Accepted')`/`.includes('OK')` cannot be spoofed.
  assert.ok(codes.includes('OK2'), 'a suffixed member is reported as its full token OK2, not OK');
  assert.ok(codes.includes('Accepted_x'), 'a suffixed member is reported as its full token Accepted_x, not Accepted');
});

test('httpStatusCodes decodes C# \\u/\\U identifier escapes so an escaped member cannot truncate to a real name', () => {
  // C# permits \uXXXX / \UXXXXXXXX escapes INSIDE identifiers. A matcher scanning the RAW
  // text would stop at the backslash and mis-read an escaped impostor as a real member.
  // The doubled backslashes below put LITERAL `\u`/`\U` escape sequences into the C#
  // source (not JS-interpreted characters).
  const src = `
    // IMPOSTOR: the real identifier is 'AcceptedX' (\\u0058 == 'X'); a raw-text matcher
    // stopping at the backslash would wrongly report the real member 'Accepted'.
    var a = HttpStatusCode.Accepted\\u0058;
    // IMPOSTOR via 8-hex \\U: 'OKN' (\\U0000004E == 'N'), must NOT be read as 'OK'.
    var b = HttpStatusCode.OK\\U0000004E;
    // GENUINE: 'Accept\\u0065d' decodes to the real member 'Accepted'.
    var c = HttpStatusCode.Accept\\u0065d;
    // A plain, exactly-bounded reference:
    return HttpStatusCode.Conflict;
  `;
  const codes = httpStatusCodes(src);
  assert.ok(codes.includes('Conflict'), 'the plain reference is counted');
  assert.ok(codes.includes('Accepted'), 'an escape that spells a real member (Accept\\u0065d) decodes to Accepted');
  assert.ok(!codes.includes('OK'), 'an escaped impostor OK\\U0000004E is not truncated to the real member OK');
  assert.ok(codes.includes('AcceptedX'), 'the escaped impostor is read as its full decoded token AcceptedX, not Accepted-by-truncation');
  assert.ok(codes.includes('OKN'), 'the 8-hex escaped impostor is read as its full decoded token OKN');
});

test('httpStatusCodes handles verbatim @ identifiers, global:: qualifier, and punctuation-manufacturing escapes; fails closed on malformed escapes (C# lexical rules)', () => {
  // Doubled backslashes below put LITERAL escape sequences into the C# source.
  const src = `
    // VERBATIM '@' prefix is NOT part of the name: @HttpStatusCode.@Accepted == Accepted.
    var a = @HttpStatusCode.@Accepted;
    // PUNCTUATION-MANUFACTURING escape: \\u002E is '.', which is NOT a valid identifier
    // char, so it can NOT manufacture a member access. 'HttpStatusCode\\u002EOK' is a
    // single (broken) identifier 'HttpStatusCode' followed by junk — NOT HttpStatusCode.OK.
    var b = HttpStatusCode\\u002EOK;
    // ESCAPED-PREFIX spoof: '\\u0041HttpStatusCode' decodes to 'AHttpStatusCode' (a
    // DIFFERENT type), so its '.OK' must NOT be counted as the real enum's OK.
    var d = \\u0041HttpStatusCode.OK;
    // global:: is the global-namespace alias and is DROPPED: this IS the real enum.
    var e = global::System.Net.HttpStatusCode.Conflict;
    // A plain reference remains counted:
    return HttpStatusCode.NotFound;
  `;
  const codes = httpStatusCodes(src);
  assert.ok(codes.includes('NotFound'), 'the plain reference is counted');
  assert.ok(codes.includes('Accepted'), 'a verbatim @HttpStatusCode.@Accepted counts as Accepted (@ is not part of the name)');
  assert.ok(codes.includes('Conflict'), 'a global::System.Net.HttpStatusCode.Conflict is counted (global alias dropped)');
  assert.ok(!codes.includes('OK'), 'a \\u002E punctuation escape does not manufacture HttpStatusCode.OK, and \\u0041HttpStatusCode.OK is a foreign type');
});

test('httpStatusCodes FAILS CLOSED on a malformed unicode escape in an identifier', () => {
  // A malformed \\u escape (too few hex digits) is invalid C#; the lexer must throw rather
  // than silently truncate 'Forbidden\\u12' to the real member 'Forbidden'.
  const src = 'return HttpStatusCode.Forbidden\\u12;';
  assert.throws(() => httpStatusCodes(src), /malformed unicode escape/, 'a malformed identifier escape fails closed');
});

test('httpStatusCodes: @global / escaped-global are NOT the global:: keyword; invalid escaped suffix fails closed (pass 39 finding #8)', () => {
  // @global::... names a USER-DEFINED extern alias literally named `global`, NOT the global
  // namespace, so its `HttpStatusCode.X` must NOT be counted as the real enum. Same for an
  // escaped spelling `gl\u006Fbal::...`.
  const aliased = `
    var a = @global::System.Net.HttpStatusCode.OK;
    var b = gl\\u006Fbal::System.Net.HttpStatusCode.Conflict;
    // The one real reference (bare global:: keyword) IS counted:
    return global::System.Net.HttpStatusCode.NotFound;
  `;
  const codes = httpStatusCodes(aliased);
  assert.ok(codes.includes('NotFound'), 'a bare global:: reference is counted');
  assert.ok(!codes.includes('OK'), '@global:: (verbatim alias) is not the global namespace');
  assert.ok(!codes.includes('Conflict'), 'escaped gl\\u006Fbal:: is not the global namespace keyword');

  // An INVALID escape suffix must FAIL CLOSED, not truncate 'Accepted\\q' to 'Accepted'.
  assert.throws(() => httpStatusCodes('return HttpStatusCode.Accepted\\q;'), /invalid escape in identifier/, 'an invalid \\q escape suffix fails closed');
});

test('httpStatusCodes: global:: roots to the GLOBAL namespace, so global::HttpStatusCode is NOT System.Net.HttpStatusCode (pass 40 finding #10)', () => {
  // `global::` roots the lookup at the ROOT namespace. `global::HttpStatusCode.X` names a
  // top-level `HttpStatusCode` type declared in NO namespace — a DIFFERENT type from
  // `System.Net.HttpStatusCode` (a `global::`-rooted bare name cannot resolve through a
  // `using System.Net;`). Only `global::System.Net.HttpStatusCode.X` is the real enum.
  const src = `
    var impostor = global::HttpStatusCode.OK;               // root-namespace type — NOT counted
    var real = global::System.Net.HttpStatusCode.Accepted;  // the real enum — counted
    var bare = HttpStatusCode.Conflict;                      // via 'using System.Net;' — counted
    return real;
  `;
  const codes = httpStatusCodes(src);
  assert.ok(!codes.includes('OK'), 'global::HttpStatusCode (root namespace) is an impostor type, not System.Net.HttpStatusCode');
  assert.ok(codes.includes('Accepted'), 'global::System.Net.HttpStatusCode IS the real enum');
  assert.ok(codes.includes('Conflict'), 'a bare (non-rooted) HttpStatusCode resolves via using System.Net');
});

test('csharpStringLiterals returns DECODED literals so an escaped header name is visible (pass 40 finding #9)', () => {
  // A conditional-request header name spelled with a unicode escape in a string literal must
  // still be recovered as its true value; a raw-substring scan would miss "If-\u004Datch".
  const src = 'var a = "If-\\u004Datch"; var b = "plain"; // "in-comment" is ignored';
  const lits = csharpStringLiterals(src);
  assert.ok(lits.includes('If-Match'), 'the escaped header name decodes to If-Match');
  assert.ok(lits.includes('plain'), 'a plain literal is returned verbatim');
  assert.ok(!lits.includes('in-comment'), 'a literal inside a comment is not returned');
});

test('csharpReferencesHttp412 detects symbolic AND computed 412 bound to STATUS CONTEXTS (pass 40 finding #9, pass 42 finding #7)', () => {
  assert.ok(csharpReferencesHttp412('return HttpStatusCode.PreconditionFailed;'), 'symbolic PreconditionFailed is 412');
  assert.ok(csharpReferencesHttp412('return (HttpStatusCode)412;'), 'a computed cast (HttpStatusCode)412 is 412');
  assert.ok(csharpReferencesHttp412('return StatusCode(412);'), 'a computed StatusCode(412) is 412');
  // A 412 NOT in a status context is NOT flagged (bound to status contexts, pass 42 finding #7).
  assert.ok(!csharpReferencesHttp412('int code = 412;'), 'a bare 412 not used as a status is not flagged');
  // Boundaries: 412 must be a standalone integer token in a status context.
  assert.ok(!csharpReferencesHttp412('return HttpStatusCode.OK;'), 'a non-412 status is not 412');
  assert.ok(!csharpReferencesHttp412('return (HttpStatusCode)4120;'), '4120 is not 412');
  assert.ok(!csharpReferencesHttp412('return (HttpStatusCode)1412;'), '1412 is not 412');
  assert.ok(!csharpReferencesHttp412('return (HttpStatusCode)member412;'), 'a member suffixed 412 is not 412');
  // A 412 inside a comment or string must NOT count (stripped before scanning).
  assert.ok(!csharpReferencesHttp412('return OK; // fallback was 412 historically'), 'a 412 in a comment is not code');
  assert.ok(!csharpReferencesHttp412('var msg = "code 412 unused";'), 'a 412 in a string literal is not a status');
});

test('csharpReferencesHttp412 detects HEX and ARITHMETIC 412 in status contexts, with named-const resolution, rejecting unrelated constants (pass 41 finding #5, pass 42 finding #7)', () => {
  // HEX: 0x19C == 412 in a status context.
  assert.ok(csharpReferencesHttp412('return (HttpStatusCode)0x19C;'), '0x19C hex is 412');
  assert.ok(csharpReferencesHttp412('return (HttpStatusCode)0x19c;'), '0x19c hex (lowercase) is 412');
  // ARITHMETIC that evaluates to 412 inside a status context.
  assert.ok(csharpReferencesHttp412('return StatusCode(400 + 12);'), '(400 + 12) evaluates to 412');
  assert.ok(csharpReferencesHttp412('return StatusCode((400 + 12));'), 'parenthesized (400 + 12) is 412');
  assert.ok(csharpReferencesHttp412('return (HttpStatusCode)(413 - 1);'), '413 - 1 evaluates to 412');
  assert.ok(csharpReferencesHttp412('return (HttpStatusCode)(4 * 103);'), '4 * 103 evaluates to 412');
  // NAMED CONSTANT resolution: a const int resolved inside a status context (previously missed).
  assert.ok(
    csharpReferencesHttp412('const int Precondition = 400 + 12; return (HttpStatusCode)Precondition;'),
    'a named const int resolving to 412 in a cast is detected',
  );
  assert.ok(
    csharpReferencesHttp412('const int Precondition = 0x19C; StatusCode = Precondition;'),
    'a named hex const 412 in a StatusCode assignment is detected',
  );
  // REJECTS unrelated constants and non-412 arithmetic (even in a status context).
  assert.ok(!csharpReferencesHttp412('return (HttpStatusCode)0x1234;'), '0x1234 (4660) is not 412');
  assert.ok(!csharpReferencesHttp412('return (HttpStatusCode)(400 + 13);'), '400 + 13 (413) is not 412');
  assert.ok(!csharpReferencesHttp412('return (HttpStatusCode)(400 - 12);'), '400 - 12 (388) is not 412');
  assert.ok(!csharpReferencesHttp412('return (HttpStatusCode)0x199;'), '0x199 (409) is not 412');
  // Unrelated (non-status) arithmetic that happens to equal 412 is NOT flagged.
  assert.ok(!csharpReferencesHttp412('var delayMs = 400 + 12;'), 'unrelated arithmetic equal to 412 is not a status');
});

test('csharpReferencesHttp412 detects StatusCodes.Status412PreconditionFailed and SHIFT expressions (pass 44 finding #8)', () => {
  // The canonical ASP.NET Core 412 constant is a status value by construction.
  assert.ok(csharpReferencesHttp412('return StatusCode(StatusCodes.Status412PreconditionFailed);'), 'StatusCodes.Status412PreconditionFailed is 412');
  assert.ok(csharpReferencesHttp412('return Results.StatusCode(StatusCodes.Status412PreconditionFailed);'), 'the canonical constant anywhere is 412');
  // A same-suffix impostor identifier is NOT the canonical constant.
  assert.ok(!csharpReferencesHttp412('var x = MyStatus412PreconditionFailedFlag;'), 'a suffixed impostor identifier is not the canonical 412 constant');
  // SHIFT expressions that evaluate to 412 inside a status context are detected.
  assert.ok(csharpReferencesHttp412('return (HttpStatusCode)(103 << 2);'), '103 << 2 == 412');
  assert.ok(csharpReferencesHttp412('return StatusCode(1648 >> 2);'), '1648 >> 2 == 412');
  // A shift that is NOT 412 is not flagged.
  assert.ok(!csharpReferencesHttp412('return (HttpStatusCode)(103 << 3);'), '103 << 3 (824) is not 412');
  // A shift outside a status context is not flagged.
  assert.ok(!csharpReferencesHttp412('var mask = 103 << 2;'), 'an unrelated shift equal to 412 is not a status');
});

test('csharpReferencesHttp412 evaluates BINARY literals and UNSIGNED shifts and resolutionSource constants (pass 47 finding #6)', () => {
  // BINARY literal 0b110011100 == 412.
  assert.ok(csharpReferencesHttp412('return (HttpStatusCode)0b110011100;'), 'a binary 412 literal is flagged');
  assert.ok(!csharpReferencesHttp412('return (HttpStatusCode)0b110011101;'), 'a binary non-412 literal is not flagged');
  // UNSIGNED right shift `>>>` (C# 11): 1648 >>> 2 == 412.
  assert.ok(csharpReferencesHttp412('return StatusCode(1648 >>> 2);'), 'an unsigned-shift 412 is flagged');
  assert.ok(!csharpReferencesHttp412('return StatusCode(1648 >>> 3);'), 'an unsigned-shift non-412 is not flagged');
  // A named 412 constant defined in the RESOLUTION SOURCE (full file) but used in a method-only
  // extract must resolve.
  const method = 'public IActionResult Fail() { return StatusCode(PreconditionFailedCode); }';
  const file = 'public class C { private const int PreconditionFailedCode = 412; public IActionResult Fail() { return StatusCode(PreconditionFailedCode); } }';
  assert.ok(csharpReferencesHttp412(method, file), 'a 412 constant from the resolution source resolves in a method-only extract');
  // The same method with a non-412 resolution-source constant is not flagged.
  const file200 = 'public class C { private const int PreconditionFailedCode = 200; }';
  assert.ok(!csharpReferencesHttp412(method, file200), 'a non-412 resolution-source constant is not flagged');
});

test('csharpComposedConditionalRequestHeader detects a header COMPOSED from a string-constant alias (pass 47 finding #6)', () => {
  // A header assembled from a const-string PREFIX + a literal, where no single literal equals the
  // header, is caught (the standalone-literal detector, joining only adjacent literals, misses it).
  const constPlusLiteral = 'const string Prefix = "If-"; var h = Prefix + "Match";';
  assert.equal(csharpComposedConditionalRequestHeader(constPlusLiteral), 'If-Match', 'a const-alias + literal composition is caught');
  // Inline (argument position) composition anywhere.
  const inline = 'const string Pfx = "If-"; headers.Add(Pfx + "None-Match", value);';
  assert.equal(csharpComposedConditionalRequestHeader(inline), 'If-None-Match', 'an inline const-alias + literal composition is caught');
  // A transitively-composed constant (Prefix built from two constants) resolves.
  const transitive = 'const string A = "If-"; const string B = A + "Unmodified-"; var h = B + "Since";';
  assert.equal(csharpComposedConditionalRequestHeader(transitive), 'If-Unmodified-Since', 'a transitively-composed header constant is caught');
  // A composition that does NOT form a conditional-request header is not flagged.
  assert.equal(csharpComposedConditionalRequestHeader('const string P = "Content-"; var h = P + "Type";'), null, 'a non-conditional composed header is not flagged');
  // A composition with an UNKNOWN operand (opaque variable) is not resolvable → not flagged.
  assert.equal(csharpComposedConditionalRequestHeader('var h = opaque + "Match";'), null, 'an unresolvable composition is not flagged');
});

test('csharpReferencesHttp412 resolves a static-readonly 412 assigned in a STATIC CONSTRUCTOR (pass 50 finding #5)', () => {
  // A `static readonly int Pf;` field with NO inline initializer, assigned 412 in a static ctor.
  const staticCtor = 'class C { static readonly int Pf; static C() { Pf = 412; } public int Fail() => StatusCode(Pf); }';
  assert.ok(csharpReferencesHttp412(staticCtor), 'a 412 assigned to a static-readonly field in a static ctor is resolved');
  // The qualified reference also resolves.
  const qualified = 'class C { static readonly int Pf; static C() { Pf = 412; } } return (HttpStatusCode)C.Pf;';
  assert.ok(csharpReferencesHttp412(qualified), 'a qualified static-ctor-assigned 412 is resolved');
  // A non-412 static-ctor assignment is not flagged.
  const notPf = 'class C { static readonly int Ok; static C() { Ok = 200; } public int Get() => StatusCode(Ok); }';
  assert.ok(!csharpReferencesHttp412(notPf), 'a non-412 static-ctor value is not flagged');
});

test('csharpReferencesHttp412 scopes static-readonly resolution to the DECLARING type static ctor and binds qualified assignments (pass 51 finding #5)', () => {
  // QUALIFIED ASSIGNMENT inside the static ctor (`C.Pf = 412;`) is bound (false-negative fix).
  const qualAsgn = 'class C { static readonly int Pf; static C() { C.Pf = 412; } public int Fail() => StatusCode(Pf); }';
  assert.ok(csharpReferencesHttp412(qualAsgn), 'a declaring-type-qualified static-ctor assignment is resolved');
  // FALSE-POSITIVE guard: a same-named `Pf = 412` assignment OUTSIDE C's static ctor (here in
  // another type's method) must NOT resolve C.Pf, whose static ctor never assigns it.
  const otherTypeAssign = 'class C { static readonly int Pf; static C() { } } class D { int Pf; void M() { Pf = 412; } } return (HttpStatusCode)C.Pf;';
  assert.ok(!csharpReferencesHttp412(otherTypeAssign), 'a same-named assignment in another type does not resolve the static-readonly field');
  // FALSE-POSITIVE guard: an assignment in a NON-static (instance) constructor of the SAME type is
  // not the static-ctor initialization of a static-readonly field, so it is not bound.
  const instanceCtorAssign = 'class C { static readonly int Pf; public C() { Pf = 412; } public int Fail() => StatusCode(Pf); }';
  assert.ok(!csharpReferencesHttp412(instanceCtorAssign), 'an instance-ctor assignment is not the static-ctor value of a static-readonly field');
});

test('csharpReferencesHttp412 resolves a static-readonly 412 across PARTIAL declarations and honors last-write-wins (pass 52 finding #6)', () => {
  // PARTIAL type: the field is declared in one part and the static ctor lives in ANOTHER part.
  const partial = 'partial class C { static readonly int Pf; } partial class C { static C() { Pf = 412; } } return (HttpStatusCode)C.Pf;';
  assert.ok(csharpReferencesHttp412(partial), 'a static-ctor in a different partial part resolves the field');
  // LAST-WRITE-WINS: multiple assignments in the static ctor — the FINAL one is the value.
  const lastWins412 = 'class C { static readonly int Pf; static C() { Pf = 200; Pf = 412; } public int Fail() => StatusCode(Pf); }';
  assert.ok(csharpReferencesHttp412(lastWins412), 'the final static-ctor assignment (412) wins over an earlier one');
  const lastWins200 = 'class C { static readonly int Pf; static C() { Pf = 412; Pf = 200; } public int Fail() => StatusCode(Pf); }';
  assert.ok(!csharpReferencesHttp412(lastWins200), 'a final non-412 static-ctor assignment is not flagged even if an earlier value was 412');
});

test('csharpReferencesHttp412 flags a static-readonly 412 assigned on a REACHABLE static-ctor BRANCH (pass 53 finding #6)', () => {
  // A conditional branch assigns 412; the textually-LAST assignment (the else / a later line) is
  // non-412. A reachable branch that assigns 412 must be caught (fail closed), not masked.
  const ifElse = 'class C { static readonly int Pf; static C() { if (strict) { Pf = 412; } else { Pf = 428; } } public int Fail() => StatusCode(Pf); }';
  assert.ok(csharpReferencesHttp412(ifElse), 'a 412 assigned in a reachable if-branch is flagged even when the else assigns a non-412');
  // A 412 in a conditional branch AFTER an unconditional non-412 baseline is still reachable.
  const condAfterBaseline = 'class C { static readonly int Pf; static C() { Pf = 200; if (strict) { Pf = 412; } } public int Fail() => StatusCode(Pf); }';
  assert.ok(csharpReferencesHttp412(condAfterBaseline), 'a 412 in a branch after an unconditional baseline is flagged');
  // An UNCONDITIONAL non-412 assignment AFTER every conditional 412 overwrites them → not flagged.
  const uncondOverwrites = 'class C { static readonly int Pf; static C() { if (strict) { Pf = 412; } Pf = 200; } public int Fail() => StatusCode(Pf); }';
  assert.ok(!csharpReferencesHttp412(uncondOverwrites), 'an unconditional non-412 assignment after every branch overwrites them (not flagged)');
  // No branch assigns 412 → not flagged (no false positive).
  const noneIs412 = 'class C { static readonly int Pf; static C() { if (strict) { Pf = 409; } else { Pf = 428; } } public int Fail() => StatusCode(Pf); }';
  assert.ok(!csharpReferencesHttp412(noneIs412), 'a branched static ctor with no 412 branch is not flagged');
});

test('csharpReferencesHttp412 flags a 412 in a BRACELESS conditional static-ctor branch (pass 54 finding R1)', () => {
  // BRACELESS if/else: both assignments sit at brace-depth 0, but each is a CONDITIONAL body. The
  // final (else) assignment must NOT discard the reachable 412 candidate (brace depth != conditional
  // depth).
  const bracelessIfElse = 'class C { static readonly int Pf; static C() { if (strict) Pf = 412; else Pf = 428; } public int Fail() => StatusCode(Pf); }';
  assert.ok(csharpReferencesHttp412(bracelessIfElse), 'a 412 in a braceless if-branch is flagged even when the braceless else assigns a non-412');
  // A braceless if without else, 412 body.
  const bracelessIf = 'class C { static readonly int Pf; static C() { Pf = 200; if (strict) Pf = 412; } public int Fail() => StatusCode(Pf); }';
  assert.ok(csharpReferencesHttp412(bracelessIf), 'a 412 in a braceless if body after a baseline is flagged');
  // GENUINE UNCONDITIONAL OVERWRITE (retained negative): a braceless if assigns 412, then an
  // UNCONDITIONAL non-412 assignment overwrites it → not flagged.
  const genuineOverwrite = 'class C { static readonly int Pf; static C() { if (strict) Pf = 412; Pf = 200; } public int Fail() => StatusCode(Pf); }';
  assert.ok(!csharpReferencesHttp412(genuineOverwrite), 'an unconditional non-412 assignment after a braceless 412 branch overwrites it (not flagged)');
  // A braceless if/else with no 412 branch is not flagged (no false positive).
  const bracelessNone = 'class C { static readonly int Pf; static C() { if (strict) Pf = 409; else Pf = 428; } public int Fail() => StatusCode(Pf); }';
  assert.ok(!csharpReferencesHttp412(bracelessNone), 'braceless branches with no 412 are not flagged');
});

test('csharpComposedConditionalRequestHeader resolves aliases spelled with ESCAPED or VERBATIM identifiers (pass 50 finding #6)', () => {
  // A verbatim `@prefix` declaration used as `prefix` (normalized) composes the header.
  assert.equal(csharpComposedConditionalRequestHeader('var @prefix = "If-"; var h = prefix + "Match";'), 'If-Match', 'a verbatim @-declared alias is normalized');
  // A declaration spelled with a unicode escape used with the plain spelling.
  assert.equal(csharpComposedConditionalRequestHeader('var pre\\u0066ix = "If-"; var h = prefix + "None-Match";'), 'If-None-Match', 'an escaped-declared alias is normalized');
  // A plain declaration referenced via a verbatim `@prefix` use.
  assert.equal(csharpComposedConditionalRequestHeader('var prefix = "If-"; headers.Add(@prefix + "Unmodified-Since", v);'), 'If-Unmodified-Since', 'a verbatim use of a plain alias is normalized');
  // A non-conditional escaped alias is not flagged.
  assert.equal(csharpComposedConditionalRequestHeader('var @p = "Content-"; var h = p + "Type";'), null, 'a non-conditional escaped alias is not flagged');
});

test('csharpComposedConditionalRequestHeader honors SOURCE-ORDERED plain reassignment and shadowing (pass 51 finding #6)', () => {
  // A plain (non-declaration) REASSIGNMENT sequence that composes the header must be caught, even
  // though the initial declared value was unrelated.
  const reassigned = 'string s = "X-"; s = "If-"; s = s + "Match"; headers.Add(s, v);';
  assert.equal(csharpComposedConditionalRequestHeader(reassigned), 'If-Match', 'a source-ordered plain reassignment composing the header is caught');
  // SHADOWING: a later re-declaration of the same alias wins in source order.
  const shadow = 'var prefix = "X-"; var prefix = "If-"; var h = prefix + "Match";';
  assert.equal(csharpComposedConditionalRequestHeader(shadow), 'If-Match', 'a shadowing re-declaration (last wins) composes the header');
  // A reassignment to an UNRESOLVABLE (opaque) value invalidates the alias — no false positive.
  const invalidated = 'string s = "If-"; s = opaque; var h = s + "Match";';
  assert.equal(csharpComposedConditionalRequestHeader(invalidated), null, 'an opaque reassignment invalidates the alias (no false positive)');
  // A non-conditional reassignment composition is not flagged.
  const nonCond = 'string s = "X-"; s = "Content-"; var h = s + "Type";';
  assert.equal(csharpComposedConditionalRequestHeader(nonCond), null, 'a non-conditional reassignment composition is not flagged');
});

test('csharpComposedConditionalRequestHeader evaluates a composed header at its POINT OF USE, not the final alias value (pass 52 finding #7)', () => {
  // FALSE-NEGATIVE fix: the header is composed and USED before the alias is later reassigned. The
  // use must be evaluated with the alias value valid AT the use (If-), not the final value.
  const usedBeforeReassign = 'string s = "If-"; headers.Add(s + "Match", v); s = "Content-";';
  assert.equal(csharpComposedConditionalRequestHeader(usedBeforeReassign), 'If-Match', 'a header composed and used before a later reassignment is caught');
  // FALSE-POSITIVE fix: a NON-header composition at the use, with the alias reassigned to a
  // header-prefix-looking value AFTER the use, must NOT be flagged from that later value.
  const laterValueNotRetroactive = 'string s = "Content-"; headers.Add(s + "Match", v); s = "If-";';
  assert.equal(csharpComposedConditionalRequestHeader(laterValueNotRetroactive), null, 'a later reassignment value is not applied retroactively to an earlier non-header use');
  // A String.Concat use is likewise point-of-use.
  const concatBeforeReassign = 'string p = "If-"; var h = string.Concat(p, "None-Match"); p = "Content-";';
  assert.equal(csharpComposedConditionalRequestHeader(concatBeforeReassign), 'If-None-Match', 'a Concat header composed before a later reassignment is caught');
});

test('csharpComposedConditionalRequestHeader detects headers composed via string.Join / string.Format / StringBuilder (pass 53 finding #7)', () => {
  // string.Join with an explicit separator.
  assert.equal(csharpComposedConditionalRequestHeader('var h = string.Join("-", "If", "Match");'), 'If-Match', 'string.Join composes the header');
  assert.equal(csharpComposedConditionalRequestHeader('var h = string.Join("", "If-None-", "Match");'), 'If-None-Match', 'string.Join with an empty separator composes the header');
  // string.Join over an array initializer, mixing an alias.
  assert.equal(csharpComposedConditionalRequestHeader('const string P = "If"; var h = string.Join("-", new[] { P, "Unmodified-Since" });'), 'If-Unmodified-Since', 'string.Join over an array with an alias composes the header');
  // string.Format placeholder substitution.
  assert.equal(csharpComposedConditionalRequestHeader('var h = string.Format("{0}Match", "If-");'), 'If-Match', 'string.Format composes the header');
  assert.equal(csharpComposedConditionalRequestHeader('const string P = "If-"; var h = string.Format("{0}{1}", P, "None-Match");'), 'If-None-Match', 'string.Format with an alias composes the header');
  // StringBuilder — fluent form.
  assert.equal(csharpComposedConditionalRequestHeader('var h = new StringBuilder().Append("If-").Append("Match").ToString();'), 'If-Match', 'a fluent StringBuilder composes the header');
  // StringBuilder — variable form, appended across statements.
  const sbVar = 'var sb = new StringBuilder(); sb.Append("If-"); sb.Append("None-Match"); headers.Add(sb.ToString(), v);';
  assert.equal(csharpComposedConditionalRequestHeader(sbVar), 'If-None-Match', 'a variable StringBuilder composed across statements is caught');
  // StringBuilder seeded by its constructor initializer.
  assert.equal(csharpComposedConditionalRequestHeader('var sb = new StringBuilder("If-"); sb.Append("Unmodified-Since"); var h = sb.ToString();'), 'If-Unmodified-Since', 'a StringBuilder seeded by its initializer composes the header');
  // NEGATIVE: a non-conditional Join/Format/StringBuilder is not flagged.
  assert.equal(csharpComposedConditionalRequestHeader('var h = string.Join("-", "Content", "Type");'), null, 'a non-conditional string.Join is not flagged');
  assert.equal(csharpComposedConditionalRequestHeader('var sb = new StringBuilder(); sb.Append("Content-"); sb.Append("Type"); var h = sb.ToString();'), null, 'a non-conditional StringBuilder is not flagged');
});

test('csharpComposedConditionalRequestHeader tracks a VARIABLE StringBuilder fluent-continuation chain (pass 54 finding R2)', () => {
  // The tracked variable is appended via a FLUENT chain whose later links carry no `sb.` prefix:
  // `sb.Append("If-").Append("Match")`. The full chain must accumulate to `If-Match` for the later
  // `sb.ToString()` (point-of-use).
  const chained = 'var sb = new StringBuilder(); sb.Append("If-").Append("Match"); headers.Add(sb.ToString(), v);';
  assert.equal(csharpComposedConditionalRequestHeader(chained), 'If-Match', 'a variable StringBuilder fluent-continuation chain is accumulated');
  // A three-link fluent continuation with a trailing separate ToString.
  const threeLink = 'var sb = new StringBuilder(); sb.Append("If-").Append("None-").Append("Match"); var h = sb.ToString();';
  assert.equal(csharpComposedConditionalRequestHeader(threeLink), 'If-None-Match', 'a multi-link fluent continuation on a variable is accumulated');
  // POINT-OF-USE: the header is composed and used BEFORE a later reassigning append. The ToString at
  // the use resolves to If-Match; a later append does not retroactively change that use.
  const pointOfUse = 'var sb = new StringBuilder(); sb.Append("If-").Append("Match"); var h = sb.ToString(); sb.Append("-Extra");';
  assert.equal(csharpComposedConditionalRequestHeader(pointOfUse), 'If-Match', 'the ToString is evaluated at its point of use with the appends before it');
  // NEGATIVE: a non-conditional fluent continuation is not flagged.
  const nonCond = 'var sb = new StringBuilder(); sb.Append("Content-").Append("Type"); var h = sb.ToString();';
  assert.equal(csharpComposedConditionalRequestHeader(nonCond), null, 'a non-conditional variable fluent chain is not flagged');
});

test('csharpComposedConditionalRequestHeader resets StringBuilder tracking on variable REASSIGNMENT (pass 55)', () => {
  // The variable is REASSIGNED to a NEW StringBuilder between the two appends. The `ToString()`
  // reflects only the SECOND instance (`Match`), which is not a conditional-request header, so the
  // appends from different instances must NOT combine into `If-Match` (a false positive that could
  // wrongly reject a valid source-contract change).
  const reassigned = 'var sb = new StringBuilder(); sb.Append("If-"); sb = new StringBuilder(); sb.Append("Match"); return sb.ToString();';
  assert.equal(csharpComposedConditionalRequestHeader(reassigned), null, 'appends across a reassignment to a new instance do not combine (returns null)');
  // A reassignment whose SECOND instance genuinely composes a header is still caught (on that
  // instance alone) — the first instance's leftover buffer does not leak in.
  const secondComposes = 'var sb = new StringBuilder(); sb.Append("Content-"); sb = new StringBuilder(); sb.Append("If-").Append("Match"); return sb.ToString();';
  assert.equal(csharpComposedConditionalRequestHeader(secondComposes), 'If-Match', 'the reassigned instance composes its own header from its own appends');
  // Fluent-continuation detection is preserved when there is NO reassignment (regression guard).
  const noReassign = 'var sb = new StringBuilder(); sb.Append("If-").Append("Match"); return sb.ToString();';
  assert.equal(csharpComposedConditionalRequestHeader(noReassign), 'If-Match', 'a single-instance fluent continuation is still accumulated');
});

test('csharpComposedConditionalRequestHeader does not treat an object/with-initializer member assignment as a reassignment (pass 56)', () => {
  // An OBJECT-INITIALIZER member assignment `new Foo { sb = 1 }` does NOT rebind the local `sb`, so
  // the original builder still composes `If-Match` across it — it must not prematurely end tracking.
  const objInit = 'var sb = new StringBuilder(); sb.Append("If-"); var x = new Foo { sb = 1 }; sb.Append("Match"); return sb.ToString();';
  assert.equal(csharpComposedConditionalRequestHeader(objInit), 'If-Match', 'an object-initializer member assignment does not end the tracked instance');
  // A `with`-expression initializer member assignment does not rebind the local either.
  const withInit = 'var sb = new StringBuilder(); sb.Append("If-"); var y = rec with { sb = 2 }; sb.Append("Unmodified-Since"); return sb.ToString();';
  assert.equal(csharpComposedConditionalRequestHeader(withInit), 'If-Unmodified-Since', 'a with-initializer member assignment does not end the tracked instance');
  // A GENUINE reassignment inside a lambda/statement block (`=> { sb = new StringBuilder(); … }`)
  // still ends tracking — the object-initializer exclusion must not swallow a real reassignment.
  const realReassign = 'var sb = new StringBuilder(); sb.Append("If-"); Run(() => { sb = new StringBuilder(); sb.Append("Match"); }); return sb.ToString();';
  assert.equal(csharpComposedConditionalRequestHeader(realReassign), null, 'a genuine reassignment inside a statement/lambda block still ends the tracked instance');
});

test('csharpComposedConditionalRequestHeader requires ACTUAL initializer syntax — statement blocks end tracking (pass 57 finding #1)', () => {
  // A `do { sb = new StringBuilder(); } while(false);` statement block genuinely REASSIGNS the local
  // between the two appends — it must end tracking (the second instance composes only `Match`).
  const doWhile = 'var sb = new StringBuilder(); sb.Append("If-"); do { sb = new StringBuilder(); } while (false); sb.Append("Match"); return sb.ToString();';
  assert.equal(csharpComposedConditionalRequestHeader(doWhile), null, 'a do/while statement block reassignment ends tracking');
  // A `try { sb = new StringBuilder(); } finally { }` block likewise reassigns.
  const tryBlock = 'var sb = new StringBuilder(); sb.Append("If-"); try { sb = new StringBuilder(); } finally { } sb.Append("Match"); return sb.ToString();';
  assert.equal(csharpComposedConditionalRequestHeader(tryBlock), null, 'a try/finally block reassignment ends tracking');
  // A LOCAL FUNCTION body (`void Reset() { sb = new StringBuilder(); }`) that reassigns, then is
  // invoked — the non-`new` `)` before `{` must be a statement body, not an initializer.
  const localFn = 'var sb = new StringBuilder(); sb.Append("If-"); void Reset() { sb = new StringBuilder(); } Reset(); sb.Append("Match"); return sb.ToString();';
  assert.equal(csharpComposedConditionalRequestHeader(localFn), null, 'a local-function body reassignment ends tracking (non-new `)` is not an initializer)');
});

test('csharpComposedConditionalRequestHeader treats array/collection-initializer assignment expressions as reassignments (pass 57 finding #2)', () => {
  // An ARRAY initializer element `new[] { sb = new StringBuilder() }` is an ASSIGNMENT EXPRESSION
  // that genuinely reassigns the local — it must end tracking (result is only `Match`).
  const arr = 'var sb = new StringBuilder(); sb.Append("If-"); var a = new[] { sb = new StringBuilder() }; sb.Append("Match"); return sb.ToString();';
  assert.equal(csharpComposedConditionalRequestHeader(arr), null, 'an array-initializer assignment expression reassigns the local (ends tracking)');
  // A generic COLLECTION initializer element likewise reassigns via an assignment expression.
  const list = 'var sb = new StringBuilder(); sb.Append("If-"); var l = new List<StringBuilder> { sb = new StringBuilder() }; sb.Append("Match"); return sb.ToString();';
  assert.equal(csharpComposedConditionalRequestHeader(list), null, 'a List<> collection-initializer assignment expression reassigns the local (ends tracking)');
});

test('csharpComposedConditionalRequestHeader preserves detection across a NESTED member initializer (pass 57 finding #3)', () => {
  // A NESTED member initializer `new Foo { Child = { sb = 1 } }` sets `Child.sb`, NOT the tracked
  // local — the inner brace follows `=` but its enclosing brace is an OBJECT initializer, so it must
  // NOT end tracking; the original builder still composes `If-Match`.
  const nested = 'var sb = new StringBuilder(); sb.Append("If-"); var x = new Foo { Child = { sb = 1 } }; sb.Append("Match"); return sb.ToString();';
  assert.equal(csharpComposedConditionalRequestHeader(nested), 'If-Match', 'a nested member-initializer member assignment does not end the tracked instance');
});

test('csharpComposedConditionalRequestHeader preserves detection across anonymous / target-typed / alias-qualified object initializers (pass 58)', () => {
  // ANONYMOUS object creation `new { sb = 1 }` sets an anonymous-type member, NOT the local — it
  // must not end tracking, so the original builder still composes `If-Match`.
  const anon = 'var sb = new StringBuilder(); sb.Append("If-"); var x = new { sb = 1 }; sb.Append("Match"); return sb.ToString();';
  assert.equal(csharpComposedConditionalRequestHeader(anon), 'If-Match', 'an anonymous object initializer does not end the tracked instance');
  // TARGET-TYPED object creation `new() { sb = 1 }` likewise sets a member of the new object.
  const targetTyped = 'var sb = new StringBuilder(); sb.Append("If-"); Foo x = new() { sb = 1 }; sb.Append("Match"); return sb.ToString();';
  assert.equal(csharpComposedConditionalRequestHeader(targetTyped), 'If-Match', 'a target-typed object initializer does not end the tracked instance');
  // A TARGET-TYPED creation WITH constructor args (`new(1, 2) { sb = 1 }`) is also an object init.
  const targetTypedArgs = 'var sb = new StringBuilder(); sb.Append("If-"); Foo x = new(1, 2) { sb = 1 }; sb.Append("None-Match"); return sb.ToString();';
  assert.equal(csharpComposedConditionalRequestHeader(targetTypedArgs), 'If-None-Match', 'a target-typed object initializer with ctor args does not end the tracked instance');
  // ALIAS-QUALIFIED object creation `new global::Ns.Foo { sb = 1 }` — the `::` alias qualifier must
  // be traversed so the `new` before the chain is found and it is classified as an object init.
  const aliasQualified = 'var sb = new StringBuilder(); sb.Append("If-"); var x = new global::Ns.Foo { sb = 1 }; sb.Append("Unmodified-Since"); return sb.ToString();';
  assert.equal(csharpComposedConditionalRequestHeader(aliasQualified), 'If-Unmodified-Since', 'an alias-qualified object initializer does not end the tracked instance');
  // NEGATIVE (statement-block detection preserved): a genuine reassignment in a do/while block still
  // ends tracking — the broadened object-initializer recognition must not swallow a real reassign.
  const stmtStillEnds = 'var sb = new StringBuilder(); sb.Append("If-"); do { sb = new StringBuilder(); } while (false); sb.Append("Match"); return sb.ToString();';
  assert.equal(csharpComposedConditionalRequestHeader(stmtStillEnds), null, 'a statement-block reassignment still ends tracking (statement detection not weakened)');
});

test('csharpComposedConditionalRequestHeader distinguishes the `new` keyword from an escaped `@new` local function (pass 59)', () => {
  // A local function `void @new() { … }` named with the ESCAPED identifier `@new` is NOT `new`
  // object-creation — its body reassigns the tracked builder, so tracking must END (the string-
  // masked view normalizes `@new`→`new`, so the two are distinguished by context: `@new` is a
  // method name preceded by a RETURN TYPE `void`, not an expression).
  const escapedNewLocalFn = 'var sb = new StringBuilder(); sb.Append("If-"); void @new() { sb = new StringBuilder(); } @new(); sb.Append("Match"); return sb.ToString();';
  assert.equal(csharpComposedConditionalRequestHeader(escapedNewLocalFn), null, 'an invoked @new local function that reassigns the builder ends tracking (not an object initializer)');
  // A local function with a GENERIC return type (`Task<int> @new() { … }`) is likewise a method.
  const genericReturn = 'var sb = new StringBuilder(); sb.Append("If-"); Task<int> @new() { sb = new StringBuilder(); return null; } @new(); sb.Append("Match"); return sb.ToString();';
  assert.equal(csharpComposedConditionalRequestHeader(genericReturn), null, 'a @new local function with a generic return type ends tracking');
  // POSITIVE guard (the pass-58 anonymous/target-typed behavior is preserved): a genuine `new() {}`
  // preceded by an EXPRESSION keyword (`return new() { … }`) is still an object initializer.
  const returnNew = 'var sb = new StringBuilder(); sb.Append("If-"); Func<Foo> f = () => new() { sb = 1 }; sb.Append("Match"); return sb.ToString();';
  assert.equal(csharpComposedConditionalRequestHeader(returnNew), 'If-Match', 'a genuine target-typed new() object initializer still does not end tracking');
});

test('csharpComposedConditionalRequestHeader distinguishes `@new` local functions with nullable / tuple return types (pass 60)', () => {
  // A NULLABLE return type (`int? @new() { … }`) ends the return type in `?`; the pass-59 context
  // heuristic mis-read that `?` as an expression position and wrongly kept tracking. With `@new`
  // provenance preserved through normalization, `@new` is recognized as an escaped identifier for
  // EVERY return-type form, so the reassigning local function still ENDS tracking.
  const nullableReturn = 'var sb = new StringBuilder(); sb.Append("If-"); int? @new() { sb = new StringBuilder(); return null; } @new(); sb.Append("Match"); return sb.ToString();';
  assert.equal(csharpComposedConditionalRequestHeader(nullableReturn), null, 'a @new local function with a nullable return type ends tracking');
  // A TUPLE return type (`(int, int) @new() { … }`) ends the return type in `)`, which the pass-59
  // heuristic also mishandled; it too must be recognized as a local function.
  const tupleReturn = 'var sb = new StringBuilder(); sb.Append("If-"); (int, int) @new() { sb = new StringBuilder(); return (0, 0); } @new(); sb.Append("Match"); return sb.ToString();';
  assert.equal(csharpComposedConditionalRequestHeader(tupleReturn), null, 'a @new local function with a tuple return type ends tracking');
  // An ARRAY return type (`int[] @new() { … }`) is likewise a local function.
  const arrayReturn = 'var sb = new StringBuilder(); sb.Append("If-"); int[] @new() { sb = new StringBuilder(); return null; } @new(); sb.Append("Match"); return sb.ToString();';
  assert.equal(csharpComposedConditionalRequestHeader(arrayReturn), null, 'a @new local function with an array return type ends tracking');
  // POSITIVE guard retained: a genuine anonymous `new { sb = 1 }` object initializer sets a member,
  // so it must NOT end tracking (the provenance fix does not weaken object-initializer detection).
  const anonPositive = 'var sb = new StringBuilder(); sb.Append("If-"); var x = new { sb = 1 }; sb.Append("Match"); return sb.ToString();';
  assert.equal(csharpComposedConditionalRequestHeader(anonPositive), 'If-Match', 'a genuine anonymous object initializer still does not end tracking');
});

test('csharpComposedConditionalRequestHeader distinguishes non-`@` escaped `new` identifier spellings (pass 61)', () => {
  // C# permits an identifier named `new` WITHOUT a `@` prefix: a Unicode escape (`n\u0065w`) or a
  // removed Cf format char yields the identifier `new`, because a keyword can carry no escape. The
  // pass-60 provenance check keyed on a leading `@` missed these spellings, so a reassigning local
  // function `int? n\u0065w() { … }` was misread as an object initializer (kept tracking → If-Match).
  // Provenance is now keyed on the RAW slice differing from `new`, so every escaped spelling is
  // recognized as an identifier and the reassigning local function ENDS tracking (returns null).
  const unicodeNullable = 'var sb = new StringBuilder(); sb.Append("If-"); int? n\\u0065w() { sb = new StringBuilder(); return null; } n\\u0065w(); sb.Append("Match"); return sb.ToString();';
  assert.equal(csharpComposedConditionalRequestHeader(unicodeNullable), null, 'a Unicode-escaped `n\\u0065w` nullable-return local function ends tracking');
  // A VOID-return Unicode-escaped spelling likewise.
  const unicodeVoid = 'var sb = new StringBuilder(); sb.Append("If-"); void n\\u0065w() { sb = new StringBuilder(); } n\\u0065w(); sb.Append("Match"); return sb.ToString();';
  assert.equal(csharpComposedConditionalRequestHeader(unicodeVoid), null, 'a Unicode-escaped `n\\u0065w` void-return local function ends tracking');
  // A REMOVED Cf FORMAT CHAR (zero-width non-joiner `\u200C`) inside the name normalizes to `new`
  // too — it is an identifier, not the keyword.
  const cfFormat = 'var sb = new StringBuilder(); sb.Append("If-"); int? ne\\u200Cw() { sb = new StringBuilder(); return null; } ne\\u200Cw(); sb.Append("Match"); return sb.ToString();';
  assert.equal(csharpComposedConditionalRequestHeader(cfFormat), null, 'a Cf-format-char `new` spelling local function ends tracking');
  // POSITIVE guard retained: the LITERAL keyword `new` (spelled with exactly `new`) is still an
  // object-creation expression whose `sb = 1` member does NOT end tracking.
  const literalPositive = 'var sb = new StringBuilder(); sb.Append("If-"); Foo x = new() { sb = 1 }; sb.Append("Match"); return sb.ToString();';
  assert.equal(csharpComposedConditionalRequestHeader(literalPositive), 'If-Match', 'the literal `new` keyword object initializer still does not end tracking');
});

test('csharpReferencesHttp412 resolves static-readonly, enum-backed, and qualified 412; scope-correct member resolution (pass 49 finding #6)', () => {
  // STATIC READONLY integral 412 constant.
  assert.ok(csharpReferencesHttp412('static readonly int Pf = 412; return StatusCode(Pf);'), 'a static readonly 412 is resolved');
  assert.ok(csharpReferencesHttp412('private static readonly int Pf = 412; return (HttpStatusCode)Pf;'), 'a private static readonly 412 is resolved');
  // ENUM-backed 412 via a member reference.
  assert.ok(
    csharpReferencesHttp412('enum Codes { Ok = 200, Pf = 412 } return (HttpStatusCode)Codes.Pf;'),
    'an enum member equal to 412 is resolved',
  );
  assert.ok(!csharpReferencesHttp412('enum Codes { Ok = 200, Pf = 412 } return (HttpStatusCode)Codes.Ok;'), 'an enum member not 412 is not flagged');
  // GLOBAL-qualified status cast.
  assert.ok(csharpReferencesHttp412('return (global::System.Net.HttpStatusCode)412;'), 'a global::-qualified status cast is evaluated');
  // SCOPE-CORRECT member resolution: a qualified Constants.Pf must resolve to THAT type's Pf, not a
  // same-named Pf in another type.
  const src = 'return StatusCode(Right.Pf);';
  const file = 'class Wrong { public const int Pf = 200; } class Right { public const int Pf = 412; }';
  assert.ok(csharpReferencesHttp412(src, file), 'a qualified member resolves to the correct type');
  const fileFlip = 'class Right { public const int Pf = 200; } class Wrong { public const int Pf = 412; }';
  assert.ok(!csharpReferencesHttp412(src, fileFlip), 'a qualified member does NOT resolve to a same-named leaf in another type (scope-correct)');
});

test('csharpComposedConditionalRequestHeader resolves System.String aliases, string.Concat, and mutated aliases (pass 49 finding #6)', () => {
  // System.String / String declared alias.
  assert.equal(csharpComposedConditionalRequestHeader('System.String p = "If-"; var h = p + "Match";'), 'If-Match', 'a System.String alias is resolved');
  assert.equal(csharpComposedConditionalRequestHeader('String p = "If-"; var h = p + "None-Match";'), 'If-None-Match', 'a String alias is resolved');
  // string.Concat / String.Concat composition.
  assert.equal(csharpComposedConditionalRequestHeader('var h = string.Concat("If-", "Match");'), 'If-Match', 'a string.Concat composition is caught');
  assert.equal(csharpComposedConditionalRequestHeader('const string P = "If-"; headers.Add(String.Concat(P, "Unmodified-Since"), v);'), 'If-Unmodified-Since', 'an inline String.Concat with a const is caught');
  // MUTATED alias (`s += ...`).
  assert.equal(csharpComposedConditionalRequestHeader('var s = "If-"; s += "Match";'), 'If-Match', 'a mutated (+=) alias is folded');
  // A non-conditional concat is not flagged.
  assert.equal(csharpComposedConditionalRequestHeader('var h = string.Concat("Content-", "Type");'), null, 'a non-conditional Concat is not flagged');
});

test('csharpReferencesHttp412 resolves non-int integral, member, escaped, and cast 412 constants (pass 48 finding #6)', () => {
  // NON-INT integral constant (const long).
  assert.ok(csharpReferencesHttp412('const long Pf = 412; return StatusCode(Pf);'), 'a const long 412 is resolved');
  assert.ok(csharpReferencesHttp412('const byte Pf = 200; const short Q = 412; return (HttpStatusCode)Q;'), 'a const short 412 is resolved');
  // MEMBER-access constant (Constants.Pf), resolved by leaf name.
  assert.ok(
    csharpReferencesHttp412('const int Pf = 412; return StatusCode(Constants.Pf);', 'public static class Constants { public const int Pf = 412; }'),
    'a member-access constant resolves by leaf',
  );
  // A CAST inside the status operand: (HttpStatusCode)(int)412 and a nested integral cast.
  assert.ok(csharpReferencesHttp412('return (HttpStatusCode)(int)412;'), 'an (int) cast operand is evaluated');
  assert.ok(csharpReferencesHttp412('return StatusCode((long)412);'), 'a (long) cast operand is evaluated');
  assert.ok(!csharpReferencesHttp412('return (HttpStatusCode)(int)413;'), 'a non-412 cast operand is not flagged');
  // An ESCAPED constant name (\u0050f decodes to Pf) resolves consistently at decl + use.
  assert.ok(
    csharpReferencesHttp412('const int \\u0050f = 412; return StatusCode(\\u0050f);'),
    'an escaped constant name resolves at declaration and use',
  );
});

test('csharpComposedConditionalRequestHeader resolves a NON-const (var) string alias (pass 48 finding #6)', () => {
  // A var alias (not const string) composed into a header must be caught.
  const varAlias = 'var prefix = "If-"; headers.Add(prefix + "Match", value);';
  assert.equal(csharpComposedConditionalRequestHeader(varAlias), 'If-Match', 'a var-alias + literal composition is caught');
  // A transitively-composed var alias.
  const transitive = 'var a = "If-"; var b = a + "None-"; var h = b + "Match";';
  assert.equal(csharpComposedConditionalRequestHeader(transitive), 'If-None-Match', 'a transitively-composed var alias is caught');
});

test('csharpReferencesHttp412 EXACTLY evaluates bitwise/shift constant status operands (pass 46 finding #6)', () => {
  // "Additional constant operators": bitwise XOR/OR/AND/complement and shift are now EVALUATED
  // exactly (not merely conservatively flagged), so a genuine computed 412 is caught and a
  // non-412 bitwise value is correctly NOT flagged.
  assert.ok(csharpReferencesHttp412('return (HttpStatusCode)(0x180 ^ 0x1C);'), '0x180 ^ 0x1C == 412 is flagged');
  assert.ok(csharpReferencesHttp412('return (HttpStatusCode)(0x180 | 0x1C);'), '0x180 | 0x1C == 412 is flagged');
  assert.ok(csharpReferencesHttp412('return StatusCode(~-413);'), '~-413 == 412 is flagged');
  // Bitwise values that are NOT 412 are correctly not flagged (exact evaluation, not conservative).
  assert.ok(!csharpReferencesHttp412('return (HttpStatusCode)(0x1A0 ^ 0xC);'), '0x1A0 ^ 0xC == 428 (not 412) is not flagged');
  assert.ok(!csharpReferencesHttp412('return StatusCode(413 & 511);'), '413 & 511 == 413 (not 412) is not flagged');
  // A bitwise value equal to 412 OUTSIDE a status context is NOT flagged (status-bound only).
  assert.ok(!csharpReferencesHttp412('var mask = 0x180 ^ 0x1C;'), 'an unrelated bitwise expression equal to 412 is not a status');
  // A NON-constant status operand (an opaque variable) is NOT flagged (no computable value).
  assert.ok(!csharpReferencesHttp412('return (HttpStatusCode)someFlags;'), 'an opaque status variable is not flagged');
  // A member/call status operand with a bitwise op is not a pure constant expression → not flagged.
  assert.ok(!csharpReferencesHttp412('return (HttpStatusCode)(a.b ^ 3);'), 'a member-access bitwise operand is not a pure constant expression');
});

test('csharpReferencesHttp412 resolves a TRANSITIVE named 412 constant (pass 46 finding #6)', () => {
  // A status built from a constant that itself references ANOTHER constant (transitively equal to
  // 412), including via a bitwise/shift initializer, is resolved and flagged.
  assert.ok(
    csharpReferencesHttp412('const int Base = 0x180; const int Pf = Base | 0x1C; return StatusCode(Pf);'),
    'a transitively-defined 412 constant (Base | 0x1C) is resolved and flagged',
  );
  assert.ok(
    csharpReferencesHttp412('const int A = 412; const int B = A; return (HttpStatusCode)B;'),
    'a chained constant B = A = 412 is resolved (transitive)',
  );
  // A transitively-defined NON-412 constant is not flagged.
  assert.ok(
    !csharpReferencesHttp412('const int A = 200; const int B = A; return (HttpStatusCode)B;'),
    'a chained non-412 constant is not flagged',
  );
});

test('csharpConditionalRequestHeaderLiteral flags a standalone header STRING CONSTANT/alias in any position (pass 45 finding #8)', () => {
  // A conditional-request header bound to a string constant/variable (assignment position) — which
  // the argument-bound detector misses — is caught by the standalone-literal detector.
  assert.equal(csharpConditionalRequestHeaderLiteral('const string P = "If-Match";'), 'If-Match', 'a const string header is caught');
  assert.equal(csharpConditionalRequestHeaderLiteral('var h = "If-None-Match";'), 'If-None-Match', 'a variable-alias header is caught');
  assert.equal(csharpConditionalRequestHeaderLiteral('private static readonly string E = @"ETag";'), 'ETag', 'a verbatim const header is caught');
  assert.equal(csharpConditionalRequestHeaderLiteral('var h = "If-" + "Match";'), 'If-Match', 'a concatenated header constant is caught');
  // A header name EMBEDDED in a longer message is NOT flagged (full value must equal the header).
  assert.equal(csharpConditionalRequestHeaderLiteral('var msg = "If-Match is not supported";'), null, 'a header-ish message is not a header constant');
  // A non-conditional header string is not flagged.
  assert.equal(csharpConditionalRequestHeaderLiteral('const string C = "Content-Type";'), null, 'a non-conditional header is not flagged');
});

test('csharpReferencesHttp412 detects a NAMED-ARGUMENT status expression (pass 43 finding #9)', () => {
  // A status expressed as a named argument (`statusCode: 412`) in an argument slot is flagged.
  assert.ok(csharpReferencesHttp412('return StatusCode(statusCode: 412);'), 'a named-arg statusCode: 412 is 412');
  assert.ok(csharpReferencesHttp412('return Op(retryAfter: 5, status: (HttpStatusCode)412);'), 'a later named-arg cast to 412 is 412');
  assert.ok(csharpReferencesHttp412('return AcceptedAsyncOperation(statusCode: 400 + 12);'), 'a named-arg arithmetic 412 is 412');
  // A non-412 named status (the shape the reviewed extracts actually use) is NOT flagged.
  assert.ok(!csharpReferencesHttp412('return AcceptedAsyncOperation(statusCode: HttpStatusCode.Accepted);'), 'a named-arg non-412 status is not flagged');
  assert.ok(!csharpReferencesHttp412('return Op(statusCode: 200);'), 'a named-arg 200 is not 412');
  // A `statusCode:` NOT in an argument slot (a label/property) is not a status context.
  assert.ok(!csharpReferencesHttp412('int x; statusCode: x = 412;'), 'a label statusCode: is not a status argument');
});

test('httpStatusCodes proves bare-ref resolution against a RESOLUTION SOURCE (method-only extracts) (pass 43 finding #9)', () => {
  const methodBody = 'return HttpStatusCode.PreconditionFailed;';
  // With a resolution source that imports System.Net, the bare ref resolves and is extracted.
  const goodFile = 'using System.Net;\nclass C { void M() { ' + methodBody + ' } }';
  assert.ok(httpStatusCodes(methodBody, goodFile).includes('PreconditionFailed'), 'a bare ref resolves against a file that imports System.Net');
  // With a resolution source that imports OTHER namespaces but NOT System.Net, the bare ref
  // cannot be proven to resolve — fail closed (throws), even though the body is method-only.
  const badFile = 'using System.Threading;\nclass C { void M() { ' + methodBody + ' } }';
  assert.throws(() => httpStatusCodes(methodBody, badFile), /cannot be proven to resolve to System\.Net/);
  // A resolution source with a LOCAL HttpStatusCode impostor fails closed.
  const impostorFile = 'using System.Net;\nenum HttpStatusCode { PreconditionFailed }\nclass C { void M() { ' + methodBody + ' } }';
  assert.throws(() => httpStatusCodes(methodBody, impostorFile), /impostor|rebinds|fail closed/i);
});

test('csharpAllStringValues sees verbatim, raw, and concatenated string values (pass 41 finding #5)', () => {
  // Regular, verbatim @"...", and raw """...""" all yield their content; a `""` inside a
  // verbatim string is one escaped quote.
  const src = [
    'var a = "If-None-Match";',
    'var b = @"If-Match";',
    'var c = """ETag""";',
    'var d = "If-" + "Match";',
    'var e = @"a""b";',
  ].join('\n');
  const vals = csharpAllStringValues(src);
  assert.ok(vals.includes('If-None-Match'), 'regular literal value present');
  assert.ok(vals.includes('If-Match'), 'verbatim @"If-Match" value present');
  assert.ok(vals.includes('ETag'), 'raw """ETag""" value present');
  // Concatenation "If-" + "Match" contributes the JOINED value If-Match.
  assert.ok(vals.filter((v) => v === 'If-Match').length >= 1, 'concatenated "If-" + "Match" joins to If-Match');
  assert.ok(vals.includes('a"b'), 'verbatim doubled-quote decodes to a single quote');
});

test('csharpConditionalRequestHeaderArg binds a header name to an argument/indexer position (pass 42 finding #7)', () => {
  // A header name used as a CALL ARGUMENT (first or later) or INDEXER KEY is flagged.
  assert.equal(csharpConditionalRequestHeaderArg('headers.Add("If-Match", value);'), 'If-Match', 'first-arg header name is bound');
  assert.equal(csharpConditionalRequestHeaderArg('headers.TryGetValue(name, "If-None-Match");'), 'If-None-Match', 'later-arg header name is bound');
  assert.equal(csharpConditionalRequestHeaderArg('var v = headers["ETag"];'), 'ETag', 'indexer-key header name is bound');
  // VERBATIM, RAW, and CONCATENATED forms in argument position are all recognized.
  assert.equal(csharpConditionalRequestHeaderArg('headers.Add(@"If-Match", v);'), 'If-Match', 'verbatim header arg is bound');
  assert.equal(csharpConditionalRequestHeaderArg('headers.Add("""If-Unmodified-Since""", v);'), 'If-Unmodified-Since', 'raw header arg is bound');
  assert.equal(csharpConditionalRequestHeaderArg('headers.Add("If-" + "Match", v);'), 'If-Match', 'concatenated header arg is bound');
  // A header NAME NOT in an argument/indexer position (assignment, log message) is NOT flagged.
  assert.equal(csharpConditionalRequestHeaderArg('var msg = "If-Match is not supported";'), null, 'a non-header header-ish message is not a header-API use');
  assert.equal(csharpConditionalRequestHeaderArg('var name = "If-Match";'), null, 'a header name assigned to a variable is not bound to a header API');
  // A non-conditional header in argument position is not flagged.
  assert.equal(csharpConditionalRequestHeaderArg('headers.Add("Content-Type", v);'), null, 'a non-conditional header is not flagged');
});

test('csharpConditionalRequestHeaderArg binds a header name given as a NAMED argument (pass 43 finding #9)', () => {
  // A named-argument header (`name: "If-Match"`) whose slot begins with `(` or `,` is bound.
  assert.equal(csharpConditionalRequestHeaderArg('headers.Add(name: "If-Match", value: v);'), 'If-Match', 'a first named-arg header is bound');
  assert.equal(csharpConditionalRequestHeaderArg('client.Send(url, headerName: "If-None-Match");'), 'If-None-Match', 'a later named-arg header is bound');
  // A `::` namespace separator before the string is NOT a named argument.
  assert.equal(csharpConditionalRequestHeaderArg('var x = Ns::"If-Match";'), null, 'a :: separator is not a named argument');
  // A named arg NOT beginning an argument slot (e.g. an object-initializer `Prop: "..."`) is not
  // treated as a header-API argument (its slot is preceded by `{`, not `(`/`,`).
  assert.equal(csharpConditionalRequestHeaderArg('var o = new H { Header: "If-Match" };'), null, 'an object-initializer property colon is not a header-API argument');
});

test('csharpReferencesIdentifier catches a NAMED header constant leaf (HeaderNames.IfMatch etc.) (pass 44 finding #8)', () => {
  const ids = ['IfMatch', 'IfNoneMatch', 'IfUnmodifiedSince', 'IfModifiedSince', 'ETag'];
  // A named header constant reference (its leaf member) is caught, so a conditional-request
  // header supplied via a constant (not a string literal) is not missed.
  assert.ok(csharpReferencesIdentifier('var h = HeaderNames.IfMatch;', ids), 'HeaderNames.IfMatch is caught via its leaf');
  assert.ok(csharpReferencesIdentifier('req.Headers[HttpRequestHeader.IfNoneMatch];', ids), 'HttpRequestHeader.IfNoneMatch is caught');
  assert.ok(csharpReferencesIdentifier('return Response(HeaderNames.ETag);', ids), 'HeaderNames.ETag is caught');
  // An unrelated identifier is not a false positive.
  assert.ok(!csharpReferencesIdentifier('var x = HeaderNames.ContentType;', ids), 'a non-conditional header constant is not caught');
});

test('httpStatusCodes FAILS CLOSED on a using-alias / using-static / declared System that rebinds the type (pass 41 finding #8)', () => {
  // A using-alias rebinding HttpStatusCode makes a bare HttpStatusCode.X a FOREIGN type.
  assert.throws(
    () => httpStatusCodes('using HttpStatusCode = Foo.Bar; return HttpStatusCode.OK;'),
    /rebinds 'HttpStatusCode'/,
    'a using-alias of HttpStatusCode fails closed',
  );
  // Aliasing System or Net changes what System.Net.HttpStatusCode resolves to.
  assert.throws(
    () => httpStatusCodes('using System = Foo; return System.Net.HttpStatusCode.OK;'),
    /rebinds 'System'/,
    'a using-alias of System fails closed',
  );
  assert.throws(
    () => httpStatusCodes('using Net = Foo.Bar; return System.Net.HttpStatusCode.OK;'),
    /rebinds 'Net'/,
    'a using-alias of Net fails closed',
  );
  // using static of the enum brings foreign members into bare scope.
  assert.throws(
    () => httpStatusCodes('using static Foo.HttpStatusCode; return OK;'),
    /using static/,
    'a using static … HttpStatusCode fails closed',
  );
  // A declared System namespace/type shadows the global System.
  assert.throws(
    () => httpStatusCodes('namespace My.System { } return System.Net.HttpStatusCode.OK;'),
    /shadow global System/,
    'a declared System namespace fails closed',
  );
  assert.throws(
    () => httpStatusCodes('class System { } return System.Net.HttpStatusCode.OK;'),
    /shadow global System/,
    'a declared System class fails closed',
  );
  // The normal case (plain using System.Net;) is unaffected.
  assert.deepEqual(
    httpStatusCodes('using System.Net; return HttpStatusCode.Accepted;').sort(),
    ['Accepted'],
    'a plain using System.Net; is not an alias and is accepted',
  );
});

test('httpStatusCodes FAILS CLOSED on a local impostor type and an unproven bare reference (pass 42 finding #8)', () => {
  // A LOCALLY DECLARED HttpStatusCode enum/type is an impostor a bare reference would bind to.
  assert.throws(
    () => httpStatusCodes('enum HttpStatusCode { OK = 200 } return HttpStatusCode.OK;'),
    /local `HttpStatusCode` type\/enum/,
    'a locally-declared HttpStatusCode enum fails closed',
  );
  assert.throws(
    () => httpStatusCodes('class HttpStatusCode { } return HttpStatusCode.OK;'),
    /local `HttpStatusCode` type\/enum/,
    'a locally-declared HttpStatusCode class fails closed',
  );
  // A bare reference in an extract that imports namespaces but NOT System.Net cannot be proven
  // to resolve to System.Net.HttpStatusCode — fail closed.
  assert.throws(
    () => httpStatusCodes('using System.Text; return HttpStatusCode.OK;'),
    /cannot be proven to resolve to System.Net/,
    'a bare reference without using System.Net (but with other imports) fails closed',
  );
  // A method-body-only snippet (NO using directives) still allows a bare reference (the ambient
  // file provides the using) — this preserves existing method-body extraction behavior.
  assert.deepEqual(
    httpStatusCodes('return HttpStatusCode.Accepted;').sort(),
    ['Accepted'],
    'a bare reference in a using-free body snippet is still accepted (ambient System.Net)',
  );
  // A FULLY-QUALIFIED reference does not need using System.Net; even alongside other imports.
  assert.deepEqual(
    httpStatusCodes('using System.Text; return System.Net.HttpStatusCode.Accepted;').sort(),
    ['Accepted'],
    'a fully-qualified reference does not require using System.Net;',
  );
});

test('httpStatusCodes rejects Unicode format (Cf) characters that would spoof or truncate a reference', () => {
  // A Unicode FORMAT char (category Cf — here U+200B ZERO WIDTH SPACE and U+00AD SOFT
  // HYPHEN) is a valid C# identifier-PART. If the token boundary omitted \p{Cf}, a
  // zero-width Cf char adjacent to `HttpStatusCode` would slip past an ASCII/partial
  // boundary and either SPOOF (a leading Cf making a larger identifier look like the
  // enum) or TRUNCATE (a trailing Cf hiding a longer member behind a real name).
  const src = `
    // SPOOF: a leading ZERO WIDTH SPACE makes this part of a DIFFERENT identifier
    // (\u200bHttpStatusCode) that must NOT be read as the enum:
    var a = \u200bHttpStatusCode.OK;
    // TRUNCATE: a member with an embedded ZERO WIDTH SPACE is its OWN distinct token;
    // it must NOT be truncated to the real member 'Accepted':
    var b = HttpStatusCode.Accepted\u200bEvil;
    // TRUNCATE via SOFT HYPHEN (U+00AD, also Cf) — likewise not truncated to 'OK':
    var c = HttpStatusCode.OK\u00adNope;
    // The one REAL, exactly-bounded reference:
    return HttpStatusCode.NotFound;
  `;
  const codes = httpStatusCodes(src);
  assert.ok(codes.includes('NotFound'), 'the exactly-bounded reference is counted');
  assert.ok(!codes.includes('OK'), 'a leading Cf spoof and a soft-hyphen-truncated member are not read as OK');
  assert.ok(!codes.includes('Accepted'), 'a zero-width-truncated member is not read as the real member Accepted');
});

test('csharpDirectMethodBody requires exactly one direct class member (rejects decoys, overloads, local functions)', () => {
  const src = `
    namespace N {
      public class Other {
        // A same-named method in a DIFFERENT class must NOT be selected.
        public Task DoWork() { return Task.CompletedTask; }
      }
      public class Target {
        public async Task DoWork() {
          // A same-named LOCAL FUNCTION nested in the body must NOT count as a member.
          async Task DoWork() { await Task.Yield(); }
          await Inner();
        }
        private void Helper() { }
      }
    }`;
  const body = csharpDirectMethodBody(src, 'Target', 'DoWork');
  assert.match(body, /await Inner\(\)/, 'the direct member body is returned');
  assert.ok(!/Task\.CompletedTask/.test(body), "the other class's DoWork is not returned");
  // Two direct overloads of the same name must FAIL (not silently pick the first).
  const overloaded = `
    public class C {
      public void M() { }
      public void M(int x) { }
    }`;
  assert.throws(
    () => csharpDirectMethodBody(overloaded, 'C', 'M'),
    /Expected EXACTLY ONE direct 'M'/,
    'two same-named direct members fail closed',
  );
  // An absent class throws.
  assert.throws(
    () => csharpDirectMethodBody(overloaded, 'Nope', 'M'),
    /declares no class 'Nope'/,
    'an absent class fails closed',
  );
  // A method that does not exist as a direct member throws (found 0).
  assert.throws(
    () => csharpDirectMethodBody(src, 'Target', 'Missing'),
    /found 0/,
    'a missing method fails closed',
  );
});

test('csharpExtensionMethodBodies scopes to class + extension receiver, requiring exactly one method', () => {
  const src = `
    namespace N {
      // A DECOY IsTerminal in a DIFFERENT class must NOT be matched.
      public static class OtherExtensions {
        public static bool IsTerminal(this ScenarioRunState state) {
          return state == ScenarioRunState.Succeeded;
        }
      }
      public static class ScenarioValidationStateExtensions {
        // A same-named OVERLOAD with a DIFFERENT receiver type must NOT be matched.
        public static bool IsTerminal(this ScenarioRunState state) {
          return true;
        }
        // The one real target: correct class + correct extension receiver.
        public static bool IsTerminal(this ScenarioValidationState state) {
          return state == ScenarioValidationState.Succeeded
              || state == ScenarioValidationState.RequiresAttention;
        }
      }
    }`;
  const bodies = csharpExtensionMethodBodies(src, 'ScenarioValidationStateExtensions', 'IsTerminal', 'ScenarioValidationState');
  assert.equal(bodies.length, 1, 'exactly one class+receiver-matching method is returned');
  assert.match(bodies[0]!.body, /ScenarioValidationState\.Succeeded/, 'the returned body is the correct-receiver overload');
  assert.ok(!/return true;/.test(bodies[0]!.body), 'the wrong-receiver overload body is not returned');
  assert.equal(bodies[0]!.receiverParam, 'state', 'the receiver parameter identifier is captured');
  // A receiver type that is a PREFIX of the declared one must not match (whole-token).
  assert.equal(
    csharpExtensionMethodBodies(src, 'ScenarioValidationStateExtensions', 'IsTerminal', 'ScenarioValidation').length,
    0,
    'a prefix of the receiver type does not match (whole-token receiver)',
  );
  // An unknown class yields no matches (no cross-class borrowing).
  assert.equal(
    csharpExtensionMethodBodies(src, 'NoSuchClass', 'IsTerminal', 'ScenarioValidationState').length,
    0,
    'an absent class yields no methods',
  );
});

test('csharpExtensionMethodBodies enforces the EXACT public static bool signature and single receiver parameter', () => {
  const src = `
    public static class ScenarioValidationStateExtensions {
      // EXTRA PARAMETER after the receiver — must be rejected (not exactly one param).
      public static bool IsTerminal(this ScenarioValidationState state, bool strict) {
        return strict && state == ScenarioValidationState.Succeeded;
      }
      // WRONG RETURN TYPE (bool? not bool) — must be rejected.
      public static bool? IsTerminal(this ScenarioValidationState state, int _n) {
        return state == ScenarioValidationState.Succeeded;
      }
      // NON-EXTENSION overload (no 'this') — must be rejected.
      public static bool IsTerminal(ScenarioValidationState state) {
        return state == ScenarioValidationState.Succeeded;
      }
      // The one VALID signature: public static bool, exactly one receiver parameter.
      public static bool IsTerminal(this ScenarioValidationState s) {
        return s == ScenarioValidationState.NoResolvedResources;
      }
    }`;
  const bodies = csharpExtensionMethodBodies(src, 'ScenarioValidationStateExtensions', 'IsTerminal', 'ScenarioValidationState');
  assert.equal(bodies.length, 1, 'only the exact single-receiver public static bool signature matches');
  assert.equal(bodies[0]!.receiverParam, 's', 'the receiver identifier of the valid overload is captured (here `s`)');
  assert.match(bodies[0]!.body, /NoResolvedResources/, 'the returned body is the valid single-parameter overload');
  assert.ok(!/strict/.test(bodies[0]!.body), 'the extra-parameter overload is not returned');
});

test('csharpMethodNames ignores a method-like token inside a comment or string', () => {
  const src = `
    public class C {
      // public Task<int> GhostAsync() { }  <-- only a comment
      var note = "public Task<int> AlsoGhostAsync() {";
      public async Task<int> RealAsync() { return 0; }
    }`;
  const names = csharpMethodNames(src);
  assert.ok(names.includes('RealAsync'), 'the real declaration is found');
  assert.ok(!names.includes('GhostAsync'), 'a comment declaration is not counted');
  assert.ok(!names.includes('AlsoGhostAsync'), 'a string declaration is not counted');
});

test('csharpMethodNames does not treat a call site as a declaration', () => {
  const src = `public void Caller() { Other.DoWork(); Helper(); }`;
  const names = csharpMethodNames(src);
  assert.ok(names.includes('Caller'), 'the declaration is found');
  assert.ok(!names.includes('DoWork'), 'a call site is not a declaration');
  assert.ok(!names.includes('Helper'), 'a bare call is not a declaration');
});

test('csharpMethodBody is not truncated by a brace inside a string literal', () => {
  const src = `
    public string M() {
      var s = "a } that would fool a naive matcher";
      return s + "end";
    }
    public string After() { return "after"; }`;
  const body = csharpMethodBody(src, 'M');
  assert.match(body, /return s \+ /, 'the full body is captured past the string brace');
  // The returned body is the ORIGINAL slice, so the literal text is intact.
  assert.match(body, /a \} that would fool/);
  assert.ok(!body.includes('After'), 'the next method is not included');
});

test('csharpMethodBody is not truncated by a brace inside a verbatim string', () => {
  const src = String.raw`
    public string V() {
      var s = @"verbatim } with ""doubled"" quotes";
      return s;
    }`;
  const body = csharpMethodBody(src, 'V');
  assert.match(body, /return s;/, 'the body continues past the verbatim string brace');
});

test('csharpMethodBody returns empty for a call site (not a declaration)', () => {
  const src = `public void Caller() { Validate(route); }`;
  assert.equal(csharpMethodBody(src, 'Validate'), '', 'a call site has no extractable body');
});

test('csharpReferencesIdentifier ignores identifiers that appear only in comments/strings', () => {
  const src = `
    // IfMatch handling would go here
    var doc = "IfMatch";
    return Store.UpsertAsync(document);`;
  assert.ok(!csharpReferencesIdentifier(src, ['IfMatch']), 'comment/string mention is not a code reference');
  assert.ok(csharpReferencesIdentifier(src, ['UpsertAsync']), 'a real code reference is detected');
});

test('csharpReferencesIdentifier uses the shared spec-correct tokenizer: Cf identity, verbatim @, escapes, global:: (pass 38 finding #2)', () => {
  // A Cf format char (U+200B) inside an identifier is REMOVED from its identity, so
  // `Up\u200BsertAsync` IS the identifier `UpsertAsync`; a verbatim `@` prefix is dropped.
  const src = `
    var r = Store.Up\u200BsertAsync(document);
    return @IfMatch.Check();`;
  assert.ok(csharpReferencesIdentifier(src, ['UpsertAsync']), 'a Cf-format-char-split identifier is normalized and matched');
  assert.ok(csharpReferencesIdentifier(src, ['IfMatch']), 'a verbatim @IfMatch is matched as IfMatch (@ dropped)');
  // A dotted target must match consecutive dotted tokens (a member chain), not two
  // unrelated mentions.
  assert.ok(csharpReferencesIdentifier(src, ['Store.UpsertAsync']), 'a dotted target matches the real member chain');
  assert.ok(!csharpReferencesIdentifier(src, ['UpsertAsync.Store']), 'a dotted target in the wrong order does not match');
  // global:: is dropped, so a global-qualified reference matches the bare target.
  assert.ok(
    csharpReferencesIdentifier('return global::System.Threading.CancellationToken.None;', ['CancellationToken']),
    'a global:: qualified reference matches the bare identifier (global alias dropped)',
  );
});

test('csharpReferencesIdentifier fails closed on a malformed unicode escape in code', () => {
  assert.throws(() => csharpReferencesIdentifier('return Fo\\u12o();', ['Foo']), /malformed unicode escape/, 'a malformed escape fails closed');
});

test('enumWireValues / serializedWireNames decode string escapes and are not truncated by an escaped quote (pass 38 finding #3)', () => {
  // An escaped quote inside the literal must NOT truncate it; escapes decode to real chars.
  const enumSrc = `
    private const string QuoteValue = "a\\"b";
    private const string EscValue = "N\\u006Fp";`;
  assert.deepEqual(enumWireValues(enumSrc), ['a"b', 'Nop'], 'escaped quote kept; \\u006F decoded to o');
  const serSrc = `writer.WritePropertyName("wei\\u0072d"u8);`;
  assert.deepEqual(serializedWireNames(serSrc), ['weird'], '\\u0072 decodes to r in a serialized wire name');
});

test('assertLexableCSharp fails closed on a #if directive after ANY C# newline including U+0085 (pass 38 finding #3)', () => {
  // A JS /m regex recognizes LF/CR/LS/PS but NOT NEL (U+0085); the complete newline model
  // must still detect a conditional directive on a NEL-started line.
  assert.throws(() => assertLexableCSharp('int x = 1;\u0085#if DEBUG'), /conditional compilation/, 'NEL-started #if is detected');
  assert.throws(() => assertLexableCSharp('int x = 1;\u2028  #endif'), /conditional compilation/, 'LS-started #endif is detected');
  // A non-conditional directive is still allowed.
  assert.doesNotThrow(() => assertLexableCSharp('int x = 1;\u0085#region R'), 'a #region after NEL is allowed');
});

test('assertLexableCSharp: Zs leading whitespace cannot bypass, and directives in comments/strings do not false-fail (pass 39 finding #7)', () => {
  // A Unicode Zs char (U+00A0 NBSP) before the `#` at line start must NOT hide the
  // directive — an ASCII-only whitespace test would let it through.
  assert.throws(() => assertLexableCSharp('int x = 1;\n\u00a0#if DEBUG'), /conditional compilation/, 'NBSP-indented #if is detected');
  assert.throws(() => assertLexableCSharp('int x = 1;\n\u2003#elif Y'), /conditional compilation/, 'EM-SPACE-indented #elif is detected');
  // A `#if` that appears only INSIDE a line comment, block comment, or string must NOT
  // false-fail (it is not an active directive).
  assert.doesNotThrow(() => assertLexableCSharp('var a = 1; // #if DEBUG not a directive'), 'a #if in a line comment is not a directive');
  assert.doesNotThrow(() => assertLexableCSharp('var a = 1; /*\n#if DEBUG\n*/ var b = 2;'), 'a #if in a block comment is not a directive');
  assert.doesNotThrow(() => assertLexableCSharp('var s = "\\n#if DEBUG";'), 'a #if in a string is not a directive');
  assert.doesNotThrow(() => assertLexableCSharp('var s = @"\n#if DEBUG\n";'), 'a #if in a verbatim string is not a directive');
});

test('csharpGuardedEarlyReturns extracts top-level guards in order with early-return flags (finding #8)', () => {
  const body = `
    var run = Store.GetAsync(id);
    if (run.Status.IsTerminal())
    {
      return Unit.Value;
    }
    if (run.Status == State.Canceling)
    {
      Log("noop");
      return Unit.Value;
    }
    run.TransitionTo(State.Canceling);
    return Unit.Value;`;
  const guards = csharpGuardedEarlyReturns(body);
  assert.equal(guards.length, 2, 'exactly the two top-level guards are found');
  assert.match(guards[0]!.condition, /IsTerminal\(\)/, 'first guard is the terminal check');
  assert.equal(guards[0]!.returns, true, 'the terminal guard returns early');
  assert.match(guards[1]!.condition, /== State\.Canceling/, 'second guard is the already-canceling check');
  assert.equal(guards[1]!.returns, true, 'the canceling guard returns early');
  assert.ok(guards[0]!.index < guards[1]!.index, 'guards are reported in source order');
});

test('csharpGuardedEarlyReturns captures the leading ! of an INVERTED guard condition (pass 42 finding #6)', () => {
  // An inverted terminal guard `if (!run.Status.IsTerminal()) return;` would no-op the
  // CANCELABLE runs and transition the terminal ones. The parser must preserve the `!` in
  // the condition so an EXACT positive-predicate comparison (used by the cancel provenance
  // test) rejects it.
  const body = `
    if (!run.Status.IsTerminal()) { return Unit.Value; }
    if (run.Status == ScenarioRunState.Canceling) { return Unit.Value; }`;
  const guards = csharpGuardedEarlyReturns(body);
  assert.equal(guards.length, 2, 'two top-level guards');
  assert.equal(guards[0]!.condition.replace(/\s+/g, ''), '!run.Status.IsTerminal()', 'the inverted terminal condition keeps its !');
  assert.notEqual(guards[0]!.condition.replace(/\s+/g, ''), 'run.Status.IsTerminal()', 'an exact positive comparison rejects the inverted guard');
  assert.equal(guards[1]!.condition.replace(/\s+/g, ''), 'run.Status==ScenarioRunState.Canceling', 'the positive canceling condition matches exactly');
});

test('csharpGuardedEarlyReturns does not report a NESTED if as a sibling guard (finding #8)', () => {
  const body = `
    if (outer)
    {
      if (inner) { DoThing(); }
    }
    if (after) { return X; }`;
  const guards = csharpGuardedEarlyReturns(body);
  // The nested `if (inner)` is skipped; only the two top-level guards are reported.
  assert.equal(guards.length, 2, 'nested if is not a sibling');
  assert.match(guards[0]!.condition, /outer/);
  assert.equal(guards[0]!.returns, false, 'the outer guard has no return');
  assert.match(guards[1]!.condition, /after/);
  assert.equal(guards[1]!.returns, true, 'the after guard returns');
});

test('csharpMethodBody does NOT treat a call followed by control-flow braces as a declaration', () => {
  // `lock (Foo()) { ... }` and `using (Bar()) { ... }` contain `Name(...) {` but
  // are NOT declarations (no access modifier + return type). The fail-closed
  // signature requirement rejects them.
  const src = `
    public void Caller() {
      lock (Foo()) { DoWork(); }
      using (Bar()) { More(); }
      foreach (var x in Baz()) { Loop(); }
    }`;
  for (const name of ['Foo', 'Bar', 'Baz']) {
    assert.equal(csharpMethodBody(src, name), '', `${name}() control-flow brace is not a method body`);
  }
  assert.match(csharpMethodBody(src, 'Caller'), /lock \(Foo\(\)\)/, 'the real declaration body is captured');
});

test('assertLexableCSharp fails closed on conditional compilation directives', () => {
  assert.throws(() => stripCSharpNoise('#if DEBUG\npublic void A(){}\n#endif'), /conditional compilation/);
  assert.throws(() => assertLexableCSharp('  #elif X'), /conditional compilation/);
  // Non-conditional directives are fine and blanked.
  assert.doesNotThrow(() => stripCSharpNoise('#nullable disable\n#region R\npublic void A(){}\n#endregion'));
});

test('stripCSharpNoise blanks preprocessor-directive line contents', () => {
  const stripped = stripCSharpNoise('#pragma warning disable CS1591\nint a = 1;');
  assert.ok(!stripped.includes('CS1591'), 'directive tokens are blanked');
  assert.match(stripped, /int a = 1;/);
});

test('stripCSharpNoise is not fooled by a brace inside a raw string literal', () => {
  const src = [
    'public string R() {',
    '  var s = """',
    '  a } that must not close the body',
    '  """;',
    '  return s;',
    '}',
  ].join('\n');
  const body = csharpMethodBody(src, 'R');
  assert.match(body, /return s;/, 'the raw-string brace does not truncate the body');
});

test('stripCSharpNoise fails closed on interpolated strings (hidden executable holes)', () => {
  assert.throws(() => stripCSharpNoise('var s = $"x {Foo()} y";'), /interpolated string/);
  assert.throws(() => stripCSharpNoise('var s = $@"x {Foo()} y";'), /interpolated verbatim/);
  assert.throws(() => stripCSharpNoise('var s = @$"x {Foo()} y";'), /interpolated verbatim/);
  assert.throws(() => stripCSharpNoise('var s = $"""x {Foo()} y""";'), /interpolated raw string/);
  // A plain (non-interpolated) verbatim/raw string is still fine.
  assert.doesNotThrow(() => stripCSharpNoise('var s = @"C:\\\\path";'));
  assert.doesNotThrow(() => stripCSharpNoise('var s = """plain""";'));
});

test('stripCSharpNoise fails closed on unterminated comments and literals', () => {
  assert.throws(() => stripCSharpNoise('int a = 1; /* unclosed'), /Unterminated block comment/);
  assert.throws(() => stripCSharpNoise('var s = "unclosed\nint a = 1;'), /Unterminated string/);
  assert.throws(() => stripCSharpNoise('var s = @"unclosed verbatim'), /Unterminated verbatim/);
  assert.throws(() => stripCSharpNoise('var s = """unclosed raw'), /Unterminated raw string/);
  assert.throws(() => stripCSharpNoise("var c = 'x"), /Unterminated character/);
});

test('csharpClassBodies + serializedFieldsByClass derive per-class serialized fields, kinds, and requiredness', () => {
  const src = `
    public class A {
      public string Code { get; }
      public IReadOnlyList<string> Roles { get; }
      void Write(Utf8JsonWriter writer) {
        writer.WriteStartObject();
        if (Optional.IsDefined(Code)) {
          writer.WritePropertyName("code"u8); writer.WriteStringValue(Code);
        }
        if (Optional.IsCollectionDefined(Roles)) {
          writer.WritePropertyName("roles"u8); writer.WriteStartArray();
          foreach (var item in Roles) { writer.WriteStringValue(item); }
          writer.WriteEndArray();
        }
        writer.WriteEndObject();
      }
    }
    public class B {
      void Write(Utf8JsonWriter writer) {
        writer.WriteStartObject();
        writer.WritePropertyName("id"u8); writer.WriteStringValue(Id);
        writer.WriteEndObject();
      }
    }`;
  const bodies = csharpClassBodies(src);
  assert.deepEqual(Object.keys(bodies).sort(), ['A', 'B']);
  const fields = serializedFieldsByClass(src);
  assert.deepEqual(fields['A'], [
    { name: 'code', kind: 'scalar', required: false, property: 'Code', primitive: 'string' },
    { name: 'roles', kind: 'array', required: false, property: 'Roles', element: 'string' },
  ]);
  // B writes `id` UNCONDITIONALLY (no Optional guard) -> required, property from the value write.
  assert.deepEqual(fields['B'], [{ name: 'id', kind: 'scalar', required: true, property: 'Id', primitive: 'string' }]);
});

test('serializedFieldsByClass derives exact scalar primitives and array element types', () => {
  const src = `
    public class M {
      void Write(Utf8JsonWriter writer) {
        writer.WriteStartObject();
        writer.WritePropertyName("count"u8); writer.WriteNumberValue(Count);
        writer.WritePropertyName("enabled"u8); writer.WriteBooleanValue(Enabled);
        writer.WritePropertyName("tags"u8); writer.WriteStartArray();
        foreach (var item in Tags) { writer.WriteStringValue(item); }
        writer.WriteEndArray();
        writer.WritePropertyName("items"u8); writer.WriteStartArray();
        foreach (var item in Items) { writer.WriteObjectValue(item); }
        writer.WriteEndArray();
        writer.WriteEndObject();
      }
    }`;
  const fields = serializedFieldsByClass(src)['M']!;
  const byName = new Map(fields.map((f) => [f.name, f] as const));
  assert.equal(byName.get('count')!.primitive, 'number');
  assert.equal(byName.get('enabled')!.primitive, 'boolean');
  assert.equal(byName.get('tags')!.kind, 'array');
  assert.equal(byName.get('tags')!.element, 'string');
  assert.equal(byName.get('items')!.kind, 'array');
  assert.equal(byName.get('items')!.element, 'object');
});

test('csharpClassBodies fails closed on a nested class (no silent mis-attribution)', () => {
  const src = `
    public class Outer {
      public class Inner {
        void Write(Utf8JsonWriter writer) { writer.WritePropertyName("x"u8); }
      }
      void Write(Utf8JsonWriter writer) { writer.WritePropertyName("y"u8); }
    }`;
  assert.throws(() => csharpClassBodies(src), /nested class/i);
});

test('csharpClassBodies fails closed on duplicate top-level class names', () => {
  const src = `
    public class Dup { void A() {} }
    public class Dup { void B() {} }`;
  assert.throws(() => csharpClassBodies(src), /[Dd]uplicate/);
});

test('csharpClassBodies fails closed on an unterminated class body', () => {
  const src = 'public class T { void A() { ';
  assert.throws(() => csharpClassBodies(src), /Unterminated class body/);
});

test('csharpClassBodies is not fooled by a generic constraint `where T : class`', () => {
  const src = `
    public class Real<T> where T : class {
      void Write(Utf8JsonWriter writer) { writer.WritePropertyName("z"u8); }
    }`;
  const bodies = csharpClassBodies(src);
  assert.deepEqual(Object.keys(bodies), ['Real'], 'only the real class is captured; the constraint is not a class');
});

test('csharpPropertyTypes + channelElementModels derive channel -> element model structurally', () => {
  const src = `
    public class P {
      public ScenarioState? Status { get; }
      public IReadOnlyList<SysError> Errors { get; }
      public IReadOnlyList<BizError> ValidationErrors { get; }
      void Write(Utf8JsonWriter writer) {
        writer.WriteStartObject();
        if (Optional.IsDefined(Status)) { writer.WritePropertyName("status"u8); writer.WriteStringValue(Status.Value.ToString()); }
        if (Optional.IsCollectionDefined(Errors)) { writer.WritePropertyName("errors"u8); writer.WriteStartArray(); foreach (var item in Errors) { writer.WriteObjectValue(item); } writer.WriteEndArray(); }
        if (Optional.IsCollectionDefined(ValidationErrors)) { writer.WritePropertyName("validationErrors"u8); writer.WriteStartArray(); foreach (var item in ValidationErrors) { writer.WriteObjectValue(item); } writer.WriteEndArray(); }
        writer.WriteEndObject();
      }
    }`;
  const types = csharpPropertyTypes(src);
  assert.equal(types['Status'], 'ScenarioState?');
  assert.equal(types['Errors'], 'IReadOnlyList<SysError>');
  const channels = channelElementModels(src);
  assert.deepEqual(channels, { errors: 'SysError', validationErrors: 'BizError' });
});

test('commentStrippedCSharp is the single fail-closed name-extraction view (comments blanked, strings preserved)', () => {
  const src = 'var s = "keepThis"; // dropThis\n/* alsoDrop */ var t = "andThis";';
  const view = commentStrippedCSharp(src);
  assert.ok(view.includes('keepThis') && view.includes('andThis'), 'string content preserved');
  assert.ok(!view.includes('dropThis') && !view.includes('alsoDrop'), 'comment content blanked');
  // Fails closed identically to stripCSharpNoise.
  assert.throws(() => commentStrippedCSharp('var s = $"{Foo()}";'), /interpolated string/);
  assert.throws(() => commentStrippedCSharp('var s = "unterminated'), /Unterminated string/);
  assert.throws(() => commentStrippedCSharp('#if DEBUG\n#endif'), /conditional compilation/);
});

test('serializedWireNames ignores a WritePropertyName decoy inside a comment (single parsed view)', () => {
  const src = [
    'void Write(Utf8JsonWriter w) {',
    '  // writer.WritePropertyName("decoyInComment"u8);',
    '  writer.WritePropertyName("realField"u8);',
    '}',
  ].join('\n');
  assert.deepEqual(serializedWireNames(src), ['realField']);
});

test('enumWireValues ignores a const-string decoy inside a comment', () => {
  const src = [
    '// private const string DecoyValue = "decoy";',
    'private const string RealValue = "Real";',
  ].join('\n');
  assert.deepEqual(enumWireValues(src), ['Real']);
});

test('serializedWireNames ignores a WritePropertyName decoy hidden in a raw string (spoof-proof)', () => {
  const src = [
    'public class M {',
    '  void Write(Utf8JsonWriter w) {',
    '    var doc = """',
    '      writer.WritePropertyName("spoofField"u8);',
    '      private const string SpoofValue = "spoof";',
    '      """;',
    '    writer.WritePropertyName("realField"u8);',
    '  }',
    '}',
  ].join('\n');
  assert.deepEqual(serializedWireNames(src), ['realField'], 'a raw-string body cannot spoof a serialized field');
});

test('enumWireValues ignores a const-string decoy hidden in a verbatim string', () => {
  const src = [
    'var doc = @"private const string SpoofValue = ""spoof"";";',
    'private const string RealValue = "Real";',
  ].join('\n');
  assert.deepEqual(enumWireValues(src), ['Real'], 'a verbatim-string body cannot spoof an enum value');
});

test('serializedFieldsByClass scopes requiredness to the DIRECT enclosing Optional guard (brace ancestry)', () => {
  // `id` is written UNCONDITIONALLY (required). An UNRELATED sibling guard block for
  // `Other` closes before `id`; a flat text-window matcher would wrongly attribute
  // that guard to `id`. Brace ancestry must keep `id` required with property Id.
  const src = `
    public class M {
      void Write(Utf8JsonWriter writer) {
        writer.WriteStartObject();
        if (Optional.IsDefined(Other)) {
          writer.WritePropertyName("other"u8); writer.WriteStringValue(Other);
        }
        writer.WritePropertyName("id"u8); writer.WriteStringValue(Id);
        if (Optional.IsDefined(Note)) {
          writer.WritePropertyName("note"u8); writer.WriteStringValue(Note);
        }
        writer.WriteEndObject();
      }
    }`;
  const fields = serializedFieldsByClass(src)['M']!;
  const byName = new Map(fields.map((f) => [f.name, f] as const));
  assert.equal(byName.get('other')!.required, false, 'other is guarded → optional');
  assert.equal(byName.get('other')!.property, 'Other');
  assert.equal(byName.get('id')!.required, true, 'id is unguarded → required (sibling guard not mis-attributed)');
  assert.equal(byName.get('id')!.property, 'Id');
  assert.equal(byName.get('note')!.required, false, 'note is guarded → optional');
  assert.equal(byName.get('note')!.property, 'Note');
});

test('serializedFieldsByClass ignores WritePropertyName/WriteStringValue tokens hidden in a string (structural detection, finding #5)', () => {
  // A regular string whose CONTENT spells a full writer call must NOT be mistaken for
  // one: the call is detected on the fully string-blanked structural view, so only the
  // real `real` field is extracted.
  const src = `
    public class M {
      void Write(Utf8JsonWriter writer) {
        writer.WriteStartObject();
        var doc = "writer.WritePropertyName(spoof); writer.WriteStringValue(SpoofProp);";
        writer.WritePropertyName("real"u8); writer.WriteStringValue(RealProp);
        writer.WriteEndObject();
      }
    }`;
  const fields = serializedFieldsByClass(src)['M']!;
  assert.deepEqual(fields.map((f) => f.name), ['real'], 'only the real serialized field is detected');
  assert.equal(fields[0]!.property, 'RealProp', 'the value receiver is the real CLR property');
});

test('serializedFieldsByClass derives the value receiver INDEPENDENTLY of the guard (no misattribution, finding #5)', () => {
  // The guard names Prop but the body writes a DIFFERENT property Actual. Requiredness
  // comes from the guard (present => optional); the serialized property must be the
  // value receiver Actual, not the guard's Prop.
  const src = `
    public class M {
      void Write(Utf8JsonWriter writer) {
        writer.WriteStartObject();
        if (Optional.IsDefined(Prop)) {
          writer.WritePropertyName("field"u8); writer.WriteStringValue(Actual);
        }
        writer.WriteEndObject();
      }
    }`;
  const f = serializedFieldsByClass(src)['M']![0]!;
  assert.equal(f.required, false, 'guarded => optional (requiredness from the guard)');
  assert.equal(f.property, 'Actual', 'property is the value receiver, NOT the guard argument Prop');
});

test('serializedFieldsByClass recognizes a direct WriteObjectValue as a scalar OBJECT field (finding #5)', () => {
  // A nested object written directly with WriteObjectValue(Prop) (no WriteStartObject)
  // must be classified kind=object, not scalar.
  const src = `
    public class M {
      void Write(Utf8JsonWriter writer) {
        writer.WriteStartObject();
        writer.WritePropertyName("detail"u8); writer.WriteObjectValue(Detail);
        writer.WriteEndObject();
      }
    }`;
  const f = serializedFieldsByClass(src)['M']![0]!;
  assert.equal(f.kind, 'object', 'a direct WriteObjectValue is an object field');
  assert.equal(f.property, 'Detail', 'the value receiver is the object property');
  assert.equal(f.primitive, undefined, 'an object field carries no scalar primitive');
});

test('serializedFieldsByClass extracts only TOP-LEVEL (depth-1) fields, not nested-object sub-fields (finding #5)', () => {
  // The `nested` field is an inline sub-object with its own WritePropertyName calls at
  // JSON depth 2. Only the depth-1 fields (`id`, `nested`) are top-level wire fields;
  // the sub-object's `inner`/`deep` must NOT be hoisted to the top level.
  const src = `
    public class M {
      void Write(Utf8JsonWriter writer) {
        writer.WriteStartObject();
        writer.WritePropertyName("id"u8); writer.WriteStringValue(Id);
        writer.WritePropertyName("nested"u8); writer.WriteStartObject();
        writer.WritePropertyName("inner"u8); writer.WriteStringValue(Inner);
        writer.WritePropertyName("deep"u8); writer.WriteStringValue(Deep);
        writer.WriteEndObject();
        writer.WriteEndObject();
      }
    }`;
  const fields = serializedFieldsByClass(src)['M']!;
  assert.deepEqual(fields.map((f) => f.name), ['id', 'nested'], 'only depth-1 fields are extracted; sub-object fields are excluded');
  assert.equal(fields.find((f) => f.name === 'nested')!.kind, 'object', 'the nested field is an object');
});

test('serializedFieldsByClass ignores WritePropertyName in OTHER methods and on OTHER writers (method/writer scoping, finding #5)', () => {
  // A helper method and a call on a DIFFERENT writer variable must not leak fields into
  // the selected IUtf8JsonSerializable serializer method\'s wire-field set.
  const src = `
    public class M {
      void Helper(Utf8JsonWriter other) {
        other.WriteStartObject();
        other.WritePropertyName("helperField"u8); other.WriteStringValue(Helper);
        other.WriteEndObject();
      }
      void Write(Utf8JsonWriter writer) {
        writer.WriteStartObject();
        var other = GetOther();
        other.WritePropertyName("otherWriterField"u8);
        writer.WritePropertyName("real"u8); writer.WriteStringValue(Real);
        writer.WriteEndObject();
      }
    }`;
  const fields = serializedFieldsByClass(src)['M']!;
  assert.deepEqual(fields.map((f) => f.name), ['real'], 'only the selected serializer + writer produces fields');
});

test('serializedFieldsByClass FAILS CLOSED on a non-literal / empty WritePropertyName argument (finding #6)', () => {
  // A field name computed from a variable (not a single string literal) is ambiguous.
  const src = `
    public class M {
      void Write(Utf8JsonWriter writer) {
        writer.WriteStartObject();
        writer.WritePropertyName(dynamicName); writer.WriteStringValue(Value);
        writer.WriteEndObject();
      }
    }`;
  assert.throws(() => serializedFieldsByClass(src), /exactly one non-empty string-literal field name/, 'a non-literal field name fails closed');
});

test('serializedFieldsByClass FAILS CLOSED when a scalar value write has no receiver (finding #6)', () => {
  // A scalar written from a non-identifier expression has no resolvable CLR receiver.
  const src = `
    public class M {
      void Write(Utf8JsonWriter writer) {
        writer.WriteStartObject();
        writer.WritePropertyName("x"u8); writer.WriteStringValue(Compute());
        writer.WriteEndObject();
      }
    }`;
  assert.throws(() => serializedFieldsByClass(src), /has no receiver/, 'a receiver-less value write fails closed');
});

test('serializedFieldsByClass selects the explicit IUtf8JsonSerializable.Write overload (finding #6)', () => {
  // Two Write(Utf8JsonWriter) overloads exist; the AUTHORITATIVE serializer is the
  // explicit interface impl (writer `w`), whose field is `real` — the other overload's
  // `decoy` must not be extracted.
  const src = `
    public class M {
      public void Write(Utf8JsonWriter other) {
        other.WriteStartObject();
        other.WritePropertyName("decoy"u8); other.WriteStringValue(Decoy);
        other.WriteEndObject();
      }
      void IUtf8JsonSerializable.Write(Utf8JsonWriter w) {
        w.WriteStartObject();
        w.WritePropertyName("real"u8); w.WriteStringValue(Real);
        w.WriteEndObject();
      }
    }`;
  const fields = serializedFieldsByClass(src)['M']!;
  assert.deepEqual(fields.map((f) => f.name), ['real'], 'the explicit interface serializer is authoritative');
});

test('serializedFieldsByClass FAILS CLOSED on ambiguous serializer overloads (finding #6)', () => {
  // Two non-explicit Write(Utf8JsonWriter) overloads and NO explicit interface impl:
  // the authoritative serializer is ambiguous, so extraction fails closed.
  const src = `
    public class M {
      public void Write(Utf8JsonWriter a) { a.WriteStartObject(); a.WritePropertyName("x"u8); a.WriteStringValue(X); a.WriteEndObject(); }
      public void Write(Utf8JsonWriter b) { b.WriteStartObject(); b.WritePropertyName("y"u8); b.WriteStringValue(Y); b.WriteEndObject(); }
    }`;
  assert.throws(() => serializedFieldsByClass(src), /ambiguous serializer/, 'ambiguous overloads fail closed');
});

test('serializedFieldsByClass enforces EXACT writer receiver boundaries (longer name not accepted, finding #6)', () => {
  // The serializer writer is `w`; a value write on a DIFFERENT writer `wrapper` whose
  // name merely starts with `w` must NOT be accepted as `w`'s value write — so the
  // field has no `w` value write and extraction fails closed.
  const src = `
    public class M {
      void IUtf8JsonSerializable.Write(Utf8JsonWriter w) {
        w.WriteStartObject();
        w.WritePropertyName("x"u8); wrapper.WriteStringValue(X);
        w.WriteEndObject();
      }
    }`;
  assert.throws(() => serializedFieldsByClass(src), /no w value write found/, 'a longer receiver name is not accepted as the writer');
});

test('serializedFieldsByClass FAILS CLOSED and does not borrow a later field\'s writer info (finding #5)', () => {
  // The first property has NO value write of its own; a naive fixed-window parse would
  // borrow the SECOND field\'s WriteStartArray. Bounding the window to the next
  // WritePropertyName makes the first field undeterminable => throw (fail closed).
  const src = `
    public class M {
      void Write(Utf8JsonWriter writer) {
        writer.WriteStartObject();
        writer.WritePropertyName("orphan"u8);
        writer.WritePropertyName("list"u8); writer.WriteStartArray(); foreach (var item in List) { writer.WriteStringValue(item); } writer.WriteEndArray();
        writer.WriteEndObject();
      }
    }`;
  assert.throws(() => serializedFieldsByClass(src), /no .* value write found for property 'orphan'/, 'an undeterminable field fails closed instead of borrowing');
});

test('csharpPropertyTypesByClass scopes property declarations to their containing class', () => {
  const src = `
    public class A {
      public IReadOnlyList<AError> Errors { get; }
      void Write(Utf8JsonWriter writer) { writer.WriteStartObject(); if (Optional.IsCollectionDefined(Errors)) { writer.WritePropertyName("errors"u8); writer.WriteStartArray(); foreach (var item in Errors) { writer.WriteObjectValue(item); } writer.WriteEndArray(); } writer.WriteEndObject(); }
    }
    public class B {
      public IReadOnlyList<BError> Errors { get; }
      void Write(Utf8JsonWriter writer) { writer.WriteStartObject(); if (Optional.IsCollectionDefined(Errors)) { writer.WritePropertyName("errors"u8); writer.WriteStartArray(); foreach (var item in Errors) { writer.WriteObjectValue(item); } writer.WriteEndArray(); } writer.WriteEndObject(); }
    }`;
  const byClass = csharpPropertyTypesByClass(src);
  // Same property NAME 'Errors' resolves to a DIFFERENT type per class.
  assert.equal(byClass['A']!['Errors'], 'IReadOnlyList<AError>');
  assert.equal(byClass['B']!['Errors'], 'IReadOnlyList<BError>');
});

test('diBindings maps each registered interface to its concrete implementation', () => {
  const src = `
    public static class Reg {
      public static IServiceCollection AddResolution(this IServiceCollection services) {
        // A binding mentioned only in a comment must be ignored: .AddScoped<IFake, Fake>()
        services.AddScoped<IResolver, Resolver>();
        services.AddSingleton<IEvaluator, Evaluator>();
        services.AddTransient<ITargetQuery, TargetQuery>();
        var s = "AddScoped<IString, StringImpl>()";
        return services;
      }
    }`;
  const bindings = diBindings(src);
  assert.equal(bindings['IResolver'], 'Resolver');
  assert.equal(bindings['IEvaluator'], 'Evaluator');
  assert.equal(bindings['ITargetQuery'], 'TargetQuery');
  assert.ok(!('IFake' in bindings), 'a binding named only in a comment is not counted');
  assert.ok(!('IString' in bindings), 'a binding named only in a string is not counted');
});

test('csharpInjectedFields binds each field to the type of the ctor parameter it is assigned from', () => {
  const src = `
    public sealed class Svc {
      private readonly IEvaluator evaluator;
      private readonly IReadOnlyList<IHook> hooks;
      private int local;
      public Svc(IEvaluator evaluator, IReadOnlyList<IHook> hooks) {
        this.evaluator = evaluator;
        this.hooks = hooks;
        this.local = 0; // not a parameter -> not an injected field
      }
    }`;
  const fields = csharpInjectedFields(src);
  assert.equal(fields['evaluator']!.type, 'IEvaluator');
  assert.equal(fields['evaluator']!.parameter, 'evaluator');
  assert.equal(fields['hooks']!.type, 'IReadOnlyList<IHook>', 'a generic parameter type with commas is kept whole');
  assert.ok(!('local' in fields), 'an assignment from a non-parameter is not an injected field');
});

test('csharpInjectedFields rejects a constructor-LOCAL assigned from a parameter (declared-field requirement, finding #6)', () => {
  // `cached` is a LOCAL (not a declared instance field) assigned from the parameter.
  // It must NOT be reported as an injected field; only the real field is.
  const src = `
    public sealed class Svc {
      private readonly IEvaluator evaluator;
      public Svc(IEvaluator evaluator) {
        var cached = evaluator;         // constructor-local, not a field
        IEvaluator alias = evaluator;   // typed local, not a field
        this.evaluator = evaluator;     // the real injected field
      }
    }`;
  const fields = csharpInjectedFields(src);
  assert.deepEqual(Object.keys(fields).sort(), ['evaluator'], 'only the declared instance field is reported');
  assert.ok(!('cached' in fields) && !('alias' in fields), 'constructor-locals are not injected fields');
});

test('csharpInjectedFields handles a local that SHADOWS a field name (finding #6)', () => {
  // `store` is BOTH a declared field and a constructor-local. A bare `store = param`
  // targets the LOCAL and must not count; the real field is bound via `this.`.
  const src = `
    public sealed class Svc {
      private readonly IStore store;
      private readonly IEvaluator evaluator;
      public Svc(IStore store, IEvaluator evaluator) {
        IStore store = Wrap(store);   // local shadows the field
        store = evaluator;            // bare assign targets the LOCAL, not the field
        this.evaluator = evaluator;   // real injected field, bound via this.
      }
    }`;
  const fields = csharpInjectedFields(src);
  assert.ok('evaluator' in fields, 'the this.-bound field is injected');
  assert.ok(!('store' in fields), 'a bare assignment to a shadowing local is not a field injection');
});

test('csharpInjectedFields does not borrow field declarations from ANOTHER class (per-class scoping, finding #4)', () => {
  // The FIRST class Svc has no field named `dep`; a SECOND class Other declares one.
  // Per-class scoping must not let Svc borrow Other's `dep` declaration.
  const src = `
    public sealed class Svc {
      public Svc(IEvaluator dep) {
        this.dep = dep;   // no such field in THIS class
      }
    }
    public sealed class Other {
      private readonly IEvaluator dep;
      public Other(IEvaluator dep) { this.dep = dep; }
    }`;
  const fields = csharpInjectedFields(src);
  assert.ok(!('dep' in fields), 'a field declared only in another class is not borrowed');
  assert.deepEqual(Object.keys(fields), [], 'the first class has no declared instance field to inject');
});

test('csharpInjectedFields rejects an assignment whose field type differs from the parameter type (finding #4)', () => {
  // `svc` is declared IStore but assigned from an IEvaluator parameter. The type
  // mismatch means it does NOT inject an IEvaluator; it must be rejected.
  const src = `
    public sealed class Svc {
      private readonly IStore svc;
      public Svc(IEvaluator svc) {
        this.svc = svc;   // field type IStore != parameter type IEvaluator
      }
    }`;
  const fields = csharpInjectedFields(src);
  assert.ok(!('svc' in fields), 'a field/parameter type mismatch is not an injection');
});

test('csharpInjectedFields records the field type when it equals the parameter type (finding #4)', () => {
  const src = `
    public sealed class Svc {
      private readonly IReadOnlyList<IHook> hooks;
      public Svc(IReadOnlyList<IHook> hooks) { this.hooks = hooks; }
    }`;
  const fields = csharpInjectedFields(src);
  assert.equal(fields['hooks']!.type, 'IReadOnlyList<IHook>', 'the equal field/param type is recorded');
  assert.equal(fields['hooks']!.parameter, 'hooks');
});

test('csharpInjectedFields ignores a field declared inside a NESTED struct (top-level only, finding #3)', () => {
  // `inner` is declared inside a nested struct at brace depth >= 1; it must NOT be
  // treated as a top-level injected field even though a ctor assigns a same-named param.
  const src = `
    public sealed class Svc {
      private readonly IEvaluator evaluator;
      public struct Nested { private readonly IEvaluator inner; }
      public Svc(IEvaluator evaluator, IEvaluator inner) {
        this.evaluator = evaluator;
        this.inner = inner;   // 'inner' is a nested-struct field, not a top-level field
      }
    }`;
  const fields = csharpInjectedFields(src);
  assert.ok('evaluator' in fields, 'the top-level field is injected');
  assert.ok(!('inner' in fields), 'a nested-struct field is not a top-level injected field');
});

test('csharpInjectedFields requires assignment in EVERY constructor; an overload-omitted field is dropped (pass 42 finding #6)', () => {
  // The FIRST ctor assigns only `a`; a SECOND overload assigns both `a` and `b`. `a` is
  // bound on EVERY construction path so it is a reliable injection; `b` is left NULL when
  // the one-arg ctor runs, so a receiver bound to `b` could NPE — it must be DROPPED.
  const src = `
    public sealed class Svc {
      private readonly IA a;
      private readonly IB b;
      public Svc(IA a) { this.a = a; }
      public Svc(IA a, IB b) { this.a = a; this.b = b; }
    }`;
  const fields = csharpInjectedFields(src);
  assert.equal(fields['a']!.type, 'IA', 'a field assigned in ALL constructors is injected');
  assert.ok(!('b' in fields), 'a field omitted by an overload constructor is NOT a reliable injection (dropped)');
});

test('csharpInjectedFields keeps a field assigned in ALL overloads (pass 42 finding #6)', () => {
  const src = `
    public sealed class Svc {
      private readonly IA a;
      public Svc(IA a) { this.a = a; }
      public Svc(IA a, int retries) { this.a = a; }
    }`;
  const fields = csharpInjectedFields(src);
  assert.equal(fields['a']!.type, 'IA', 'a field assigned in every constructor overload stays injected');
});

test('csharpInjectedFields rejects a field assigned only AFTER a depth-0 early return in the ctor (pass 42 finding #6)', () => {
  // The assignment is unreachable when the guard returns, so the field is not reliably bound.
  const src = `
    public sealed class Svc {
      private readonly IA a;
      public Svc(IA a) {
        if (a == null) return;
        return;
        this.a = a;
      }
    }`;
  const fields = csharpInjectedFields(src);
  assert.ok(!('a' in fields), 'an assignment after an unconditional early return does not inject the field');
});

test('csharpInjectedFields rejects a bare parameter self-assignment that shadows a field (finding #3)', () => {
  // `resolver` is BOTH a field and the parameter name; the parameter shadows the field
  // in ctor scope, so a bare `resolver = resolver;` is a parameter SELF-assignment, not
  // a field write. Only `this.resolver = resolver` would bind the field.
  const src = `
    public sealed class Svc {
      private readonly IResolver resolver;
      public Svc(IResolver resolver) {
        resolver = resolver;   // parameter self-assignment (shadows the field)
      }
    }`;
  const fields = csharpInjectedFields(src);
  assert.ok(!('resolver' in fields), 'a bare parameter self-assignment does not inject the field');
});

test('csharpInjectedFields rejects a member-chain assignment impersonation (finding #4)', () => {
  // `other.evaluator = evaluator;` assigns a member of ANOTHER object, not this class's
  // field; it must NOT be read as injecting the field `evaluator`.
  const src = `
    public sealed class Svc {
      private readonly IEvaluator evaluator;
      public Svc(IEvaluator evaluator, Other other) {
        other.evaluator = evaluator;   // member of another object, not this.evaluator
      }
    }`;
  const fields = csharpInjectedFields(src);
  assert.ok(!('evaluator' in fields), 'a member-chain assignment target is not this.<field>');
});

test('csharpInjectedFields rejects a @this verbatim-identifier assignment impersonation (finding #4)', () => {
  // `@this` is a local named "this", not the this-keyword; `@this.evaluator = evaluator`
  // assigns a member of that local, not the class field.
  const src = `
    public sealed class Svc {
      private readonly IEvaluator evaluator;
      public Svc(IEvaluator evaluator, Wrapper @this) {
        @this.evaluator = evaluator;   // member of the local named "this"
      }
    }`;
  const fields = csharpInjectedFields(src);
  assert.ok(!('evaluator' in fields), 'a @this verbatim identifier does not bind the class field');
});

test('csharpInjectedFields keeps a multi-type-arg generic parameter type intact (finding #5)', () => {
  // The token-aware param split must not break `IDictionary<K,V>` on its inner comma
  // (a broken splitter would split the parameter and lose the `map` field).
  const src = `
    public sealed class Svc {
      private readonly IDictionary<K,V> map;
      public Svc(IDictionary<K,V> map) { this.map = map; }
    }`;
  const fields = csharpInjectedFields(src);
  assert.equal(fields['map']!.type, 'IDictionary<K,V>', 'the generic parameter type is kept whole across its comma');
});

test('csharpInvocation binds a fluent call across newlines to its receiver field and arguments', () => {
  const body = `
    var targets = await this.targetQuery
      .QueryAsync(configuration, cancellationToken)
      .ConfigureAwait(false);`;
  const call = csharpInvocation(body, 'QueryAsync');
  assert.ok(call, 'the invocation is found across the newline before the dot');
  assert.equal(call!.receiver, 'targetQuery', 'the receiver is the DI field, with this. stripped');
  assert.equal(call!.qualified, true, 'the call is this.-qualified');
  assert.deepEqual(call!.argList, ['configuration', 'cancellationToken'], 'the complete argument list is parsed structurally');
});

test('csharpInvocation preserves this.-qualification so a shadowing local cannot impersonate the field (finding #4)', () => {
  // A bare `evaluator.Method(...)` (a shadowing local) is NOT this.-qualified; a
  // `this.evaluator.Method(...)` IS. The qualification flag distinguishes them.
  const bare = csharpInvocation('var x = evaluator.ResolveLiveAsync(configuration, cancellationToken);', 'ResolveLiveAsync');
  assert.ok(bare, 'the bare call is found');
  assert.equal(bare!.qualified, false, 'a bare local receiver is NOT this.-qualified');
  const qualified = csharpInvocation('var x = this.evaluator.ResolveLiveAsync(configuration, cancellationToken);', 'ResolveLiveAsync');
  assert.ok(qualified, 'the qualified call is found');
  assert.equal(qualified!.qualified, true, 'a this.field receiver IS this.-qualified');
  assert.equal(qualified!.receiver, 'evaluator');
});

test('csharpInvocation splits the COMPLETE argument list at top-level commas only (finding #4)', () => {
  // Nested generics/commas inside a call argument must NOT split the argument list.
  const call = csharpInvocation('this.svc.Do(a, Map<K, V>(b), c);', 'Do');
  assert.ok(call, 'the call is found');
  assert.deepEqual(call!.argList, ['a', 'Map<K, V>(b)', 'c'], 'top-level commas split; nested commas do not');
});

test('csharpInvocation splits args correctly across object initializers and comparisons (finding #5)', () => {
  // `{ A = 1, B = 2 }` is an object initializer (its commas are protected by `{}`),
  // and `x < y` is a COMPARISON (its `<`/`>` are operators, not brackets), so the
  // top-level commas split into exactly three arguments.
  const call = csharpInvocation('this.svc.Do(new Foo { A = 1, B = 2 }, x < y, z);', 'Do');
  assert.ok(call, 'the call is found');
  assert.deepEqual(call!.argList, ['new Foo { A = 1, B = 2 }', 'x < y', 'z'], 'initializers and comparisons split correctly');
});

test('csharpInvocation rejects a member-chain receiver impersonation (finding #4)', () => {
  // `wrapper.evaluator.Method(...)` must NOT be read as receiver `evaluator`: the
  // receiver must be an EXACT tokenized `this.<field>` or bare `<field>`, not the tail
  // of a member chain. There is no valid single-identifier receiver here, so no match.
  const call = csharpInvocation('var x = wrapper.evaluator.ResolveLiveAsync(configuration, cancellationToken);', 'ResolveLiveAsync');
  assert.equal(call, null, 'a member-chain tail is not accepted as the receiver');
});

test('csharpInvocation rejects a verbatim-identifier @this impersonation (finding #4)', () => {
  // `@this` is a LOCAL literally named "this" (a verbatim/escaped identifier), NOT the
  // this-keyword; `@this.field.Method(...)` must not be read as the this.-qualified field.
  const call = csharpInvocation('var x = @this.evaluator.ResolveLiveAsync(configuration, cancellationToken);', 'ResolveLiveAsync');
  assert.equal(call, null, 'a @this verbatim identifier does not impersonate the this-keyword');
});

test('csharpInvocation is not fooled by a decoy call hidden in a string or comment', () => {
  const body = `
    // this.decoy.QueryAsync(x, y);
    var s = "this.spoof.QueryAsync(a, b)";
    var r = await this.real.QueryAsync(configuration, cancellationToken);`;
  const call = csharpInvocation(body, 'QueryAsync');
  assert.ok(call, 'the real invocation is found');
  assert.equal(call!.receiver, 'real', 'the comment/string decoys are ignored; the receiver is the code call');
});

// ---------------------------------------------------------------------------
// Eighteenth-pass hardening (findings #8–#11): typed delimiter stack for argument
// parsing, direct-member serializer selection with one-invocation metadata, a typed
// JSON container stack, and Unicode/C#-identifier-aware token boundaries.
// ---------------------------------------------------------------------------

test('splitTopLevelArgs uses a TYPED delimiter stack: mismatched pairs fail closed (finding #8)', () => {
  // A naive single depth counter treats `([)]` as balanced; the typed stack rejects it.
  assert.throws(() => splitTopLevelArgs('([)]'), /mismatched delimiters/, 'a crossed ( [ ) ] fails closed');
  assert.throws(() => splitTopLevelArgs('[a)'), /mismatched delimiters/, 'a [ closed by ) fails closed');
  assert.throws(() => splitTopLevelArgs('a)'), /unbalanced closing/, 'a stray close fails closed');
  assert.throws(() => splitTopLevelArgs('(a'), /unbalanced/, 'a dangling open fails closed');
});

test('splitTopLevelArgs protects a well-formed generic and FAILS CLOSED on an ambiguous `<` (finding #8)', () => {
  // A well-formed generic type-argument group protects its commas.
  assert.deepEqual(splitTopLevelArgs('a, Map<K, V>(b), c'), ['a', ' Map<K, V>(b)', ' c']);
  assert.deepEqual(splitTopLevelArgs('List<Dictionary<string, int>> m'), ['List<Dictionary<string, int>> m']);
  // A `<` immediately after an identifier that is NOT a clean generic is ambiguous
  // (generic vs. comparison) and must fail closed rather than be silently misparsed.
  assert.throws(() => splitTopLevelArgs('a<b'), /ambiguous '<'/, 'an unterminated generic-looking `<` fails closed');
  assert.throws(() => splitTopLevelArgs('x<y && z'), /ambiguous '<'/, 'a `<` followed by an operator fails closed');
  // A spaced comparison (the `<` does not immediately follow an identifier) is fine.
  assert.deepEqual(splitTopLevelArgs('x < y, z'), ['x < y', ' z']);
});

test('findSerializerMethod ignores a NESTED local function Write and uses the DIRECT member (finding #9)', () => {
  // A local function `void Write(Utf8JsonWriter inner)` nested inside another method must
  // never be selected as the serializer; only the DIRECT explicit interface impl counts.
  const src = `
    public partial class M : IUtf8JsonSerializable {
      public string Code { get; }
      public void Helper() {
        void Write(Utf8JsonWriter inner) {
          inner.WriteStartObject();
          inner.WritePropertyName("decoy");
          inner.WriteStringValue(Code);
          inner.WriteEndObject();
        }
      }
      void IUtf8JsonSerializable.Write(Utf8JsonWriter writer) {
        writer.WriteStartObject();
        writer.WritePropertyName("code");
        writer.WriteStringValue(Code);
        writer.WriteEndObject();
      }
    }`;
  const fields = serializedFieldsByClass(src)['M']!;
  assert.deepEqual(fields.map((f) => f.name), ['code'], 'only the direct serializer’s field is read, not the nested decoy');
});

test('serializedFieldsByClass derives kind+receiver from ONE invocation, not a later call (finding #9)', () => {
  // The first value write for the property has NO receiver; a later write carries a
  // decoy receiver. Metadata must come from the SAME (first) call, so this fails closed
  // rather than borrowing `Wrong` from the later call.
  const src = `
    public partial class M : IUtf8JsonSerializable {
      void IUtf8JsonSerializable.Write(Utf8JsonWriter writer) {
        writer.WriteStartObject();
        writer.WritePropertyName("x");
        writer.WriteStringValue();
        writer.WriteStringValue(Wrong);
        writer.WriteEndObject();
      }
    }`;
  assert.throws(() => serializedFieldsByClass(src), /has no receiver/, 'the receiver is not borrowed from a later call');
});

test('serializedFieldsByClass typed JSON container stack rejects a mismatched close (finding #10)', () => {
  const src = `
    public partial class M : IUtf8JsonSerializable {
      void IUtf8JsonSerializable.Write(Utf8JsonWriter writer) {
        writer.WriteStartObject();
        writer.WritePropertyName("a");
        writer.WriteStringValue(A);
        writer.WriteEndArray();
      }
    }`;
  assert.throws(() => serializedFieldsByClass(src), /closes 'array' but the open container is 'object'/, 'an EndArray closing an object fails closed');
});

test('serializedFieldsByClass typed JSON container stack rejects underflow and dangling opens (finding #10)', () => {
  const underflow = `
    public partial class M : IUtf8JsonSerializable {
      void IUtf8JsonSerializable.Write(Utf8JsonWriter writer) {
        writer.WriteStartObject();
        writer.WritePropertyName("a");
        writer.WriteStringValue(A);
        writer.WriteEndObject();
        writer.WriteEndObject();
      }
    }`;
  assert.throws(() => serializedFieldsByClass(underflow), /underflow/, 'an extra close (underflow) fails closed');

  const dangling = `
    public partial class M : IUtf8JsonSerializable {
      void IUtf8JsonSerializable.Write(Utf8JsonWriter writer) {
        writer.WriteStartObject();
        writer.WritePropertyName("a");
        writer.WriteStringValue(A);
      }
    }`;
  assert.throws(() => serializedFieldsByClass(dangling), /leaves 1 JSON container/, 'a never-closed root fails closed');
});

test('serializedFieldsByClass requires EXACTLY ONE root object (finding #10)', () => {
  const twoRoots = `
    public partial class M : IUtf8JsonSerializable {
      void IUtf8JsonSerializable.Write(Utf8JsonWriter writer) {
        writer.WriteStartObject();
        writer.WritePropertyName("a");
        writer.WriteStringValue(A);
        writer.WriteEndObject();
        writer.WriteStartObject();
        writer.WritePropertyName("b");
        writer.WriteStringValue(B);
        writer.WriteEndObject();
      }
    }`;
  assert.throws(() => serializedFieldsByClass(twoRoots), /more than one root object/, 'two root objects fail closed');
});

test('serializedFieldsByClass Unicode boundary: a Unicode-prefixed writer cannot impersonate the writer (finding #11)', () => {
  // `éwriter` is a DIFFERENT writer whose ASCII tail is `writer`. An ASCII-only boundary
  // would accept its value write as the real `writer`'s; the Unicode-aware boundary must
  // reject it, so the property has no real `writer` value write and fails closed.
  const src = `
    public partial class M : IUtf8JsonSerializable {
      void IUtf8JsonSerializable.Write(Utf8JsonWriter writer) {
        writer.WriteStartObject();
        writer.WritePropertyName("x");
        \u00e9writer.WriteStringValue(Decoy);
        writer.WriteEndObject();
      }
    }`;
  assert.throws(() => serializedFieldsByClass(src), /no writer value write found/, 'a Unicode-prefixed writer does not impersonate the real writer');
});

test('csharpInvocation Unicode boundary: a Unicode-prefixed receiver cannot impersonate the field (finding #11)', () => {
  // `\u00e9evaluator` is a distinct identifier; an ASCII-only boundary would let its
  // ASCII tail `evaluator` match. The Unicode-aware boundary rejects the impersonation.
  const impersonation = csharpInvocation('var x = \u00e9evaluator.ResolveLiveAsync(a, b);', 'ResolveLiveAsync');
  assert.equal(impersonation, null, 'a Unicode-prefixed receiver is not matched as the bare field');
  const real = csharpInvocation('var x = evaluator.ResolveLiveAsync(a, b);', 'ResolveLiveAsync');
  assert.equal(real!.receiver, 'evaluator', 'the genuine receiver is still bound');
});

test('csharpGuardedEarlyReturns reports guard DEPTH so direct-child guards can be required (finding #6)', () => {
  const body = `
    if (a) { return; }
    try {
      if (b) { return; }
    } finally { }`;
  const guards = csharpGuardedEarlyReturns(body);
  const a = guards.find((g) => g.condition === 'a')!;
  const b = guards.find((g) => g.condition === 'b')!;
  assert.equal(a.depth, 0, 'a top-level guard is at depth 0 (direct child of the body)');
  assert.equal(b.depth, 1, 'a guard wrapped in a try-block is at depth 1 (not a direct child)');
});

// ---------------------------------------------------------------------------
// Twentieth-pass hardening (findings #9, #10, #11): unconditional early-return
// authentication, source int-const parsing, all C# newline forms, and direct-member
// property scoping.
// ---------------------------------------------------------------------------

test('csharpGuardedEarlyReturns requires an UNCONDITIONAL return at direct depth (finding #9)', () => {
  // A guard whose block returns unconditionally => returns:true.
  const unconditional = csharpGuardedEarlyReturns('if (t) { return; }');
  assert.equal(unconditional[0]!.returns, true, 'a direct unconditional return counts');

  // A return NESTED inside a further braced block is conditional => returns:false.
  const nestedBraced = csharpGuardedEarlyReturns('if (t) { if (x) { return; } }');
  assert.equal(nestedBraced[0]!.returns, false, 'a return nested in an inner { } block does NOT count');

  // A BRACELESS nested conditional return is conditional => returns:false.
  const braceless = csharpGuardedEarlyReturns('if (t) { if (x) return; }');
  assert.equal(braceless[0]!.returns, false, 'a braceless `if (x) return;` does NOT count as unconditional');

  // A return governed by a braceless loop header is also conditional => returns:false.
  const looped = csharpGuardedEarlyReturns('if (t) { for (;;) return; }');
  assert.equal(looped[0]!.returns, false, 'a braceless loop-governed return does NOT count');

  // A return AFTER a completed nested block is unconditional => returns:true.
  const afterNested = csharpGuardedEarlyReturns('if (t) { if (x) { Log(); } return; }');
  assert.equal(afterNested[0]!.returns, true, 'a return after a completed nested block is unconditional');

  // An `else`-governed return is conditional => returns:false.
  const elseReturn = csharpGuardedEarlyReturns('if (t) { if (x) { A(); } else return; }');
  assert.equal(elseReturn[0]!.returns, false, 'an `else`-governed return does NOT count');
});

test('csharpGuardedEarlyReturns flags an `else if` guard so a conditional branch is not an unconditional guard (finding: else-if)', () => {
  // An `else if (...) { return; }` only runs when the PRIOR branch was NOT taken, so its
  // return is CONDITIONAL — it must be flagged (elseIf:true) so an authenticating caller
  // that requires an unconditional guard rejects it. An adversarial cancel-like body puts
  // the terminal no-op in an `else if` after an unrelated first branch.
  const adversarial =
    'if (run.Status == ScenarioRunState.Queued) { Log(); } ' +
    'else if (run.Status.IsTerminal()) { return; }';
  const guards = csharpGuardedEarlyReturns(adversarial);
  const terminal = guards.find((g) => /IsTerminal\(\)/.test(g.condition));
  assert.ok(terminal, 'the terminal guard is located');
  assert.equal(terminal!.returns, true, 'its block does contain a direct return');
  assert.equal(terminal!.elseIf, true, 'but it is an ELSE-IF (conditional on the prior branch), so it is flagged');
  // The first `if` is not an else-if.
  const first = guards.find((g) => /Queued/.test(g.condition));
  assert.ok(first && first.elseIf === false, 'a leading plain `if` is not flagged as else-if');
  // A caller requiring an UNCONDITIONAL early-return guard (returns && !elseIf) finds none.
  const unconditionalReturns = guards.filter((g) => g.depth === 0 && g.returns && !g.elseIf);
  assert.equal(unconditionalReturns.length, 0, 'no unconditional early-return guard exists in the adversarial else-if body');
  // A plain (non-else) `if (...) { return; }` is NOT flagged.
  const plain = csharpGuardedEarlyReturns('if (run.Status.IsTerminal()) { return; }');
  assert.equal(plain[0]!.elseIf, false, 'a plain if-guard is not an else-if');
});

test('csharpFirstUnconditionalReturnAtDepth0 binds a branch outcome to its GUARANTEED return, rejecting dead and nested returns (pass 39 finding #3)', () => {
  // The guaranteed (first unconditional, top-level) return is what the branch actually
  // produces. A trailing DEAD return of a different factory must NOT change the outcome.
  assert.equal(
    csharpFirstUnconditionalReturnAtDepth0(' return HttpResponseResult.Ok(run); return HttpResponseResult.Accepted(run); '),
    'HttpResponseResult.Ok(run)',
    'the FIRST unconditional return wins; the trailing return is dead code',
  );
  // A NESTED return (inside a further { } block) is conditional and must be ignored; the
  // top-level unconditional return is the outcome.
  assert.equal(
    csharpFirstUnconditionalReturnAtDepth0(' if (x) { return HttpResponseResult.Ok(run); } return HttpResponseResult.Accepted(run); '),
    'HttpResponseResult.Accepted(run)',
    'a nested Ok return does not spoof the guaranteed Accepted return',
  );
  // A BRACELESS conditional return is likewise ignored.
  assert.equal(
    csharpFirstUnconditionalReturnAtDepth0(' if (x) return HttpResponseResult.Ok(run); return HttpResponseResult.Accepted(run); '),
    'HttpResponseResult.Accepted(run)',
    'a braceless conditional Ok return does not spoof the guaranteed Accepted return',
  );
  // A branch whose ONLY returns are conditional/nested has NO guaranteed return.
  assert.equal(
    csharpFirstUnconditionalReturnAtDepth0(' if (x) { return HttpResponseResult.Ok(run); } '),
    null,
    'a branch with only a nested return has no guaranteed return',
  );
  // The expression is captured up to its top-level `;`, so a nested `;` inside call args
  // does not truncate it.
  assert.equal(
    csharpFirstUnconditionalReturnAtDepth0(' return HttpResponseResult.Ok(Build(a, b)); '),
    'HttpResponseResult.Ok(Build(a, b))',
    'the return expression is captured to its top-level terminator',
  );
});

test('csharpFirstUnconditionalReturnAtDepth0 is REACHABILITY-aware: a throw precedes/kills a later return; the outcome is the FIRST terminator (pass 40 finding #7)', () => {
  // A `return` AFTER an unconditional depth-0 `throw` is DEAD CODE — the branch throws and
  // returns NO value. A lexical "first unconditional return" would wrongly report Ok.
  assert.equal(
    csharpFirstUnconditionalReturnAtDepth0(' throw new NotSupportedException(); return HttpResponseResult.Ok(run); '),
    null,
    'a return after an unconditional throw is unreachable — the branch throws, no returned value',
  );
  // The FIRST terminator wins even when it is a return followed by a throw.
  assert.equal(
    csharpFirstUnconditionalReturnAtDepth0(' return HttpResponseResult.Ok(run); throw new Exception(); '),
    'HttpResponseResult.Ok(run)',
    'the first terminator (a return) is the outcome; the trailing throw is dead',
  );
  // A `throw` used as an EXPRESSION (`x ?? throw e`) is NOT a control-flow terminator, so a
  // following top-level return is still the outcome.
  assert.equal(
    csharpFirstUnconditionalReturnAtDepth0(' var y = x ?? throw new Exception(); return HttpResponseResult.Ok(run); '),
    'HttpResponseResult.Ok(run)',
    'an expression-position throw does not kill the later unconditional return',
  );
});

test('csharpInvocation is REACHABILITY-aware: a decoy call in dead code after a return/throw is ignored (pass 40 finding #7)', () => {
  // A decoy call placed AFTER an unconditional depth-0 return must not satisfy the check
  // while the reachable path omits it.
  assert.equal(
    csharpInvocation('return Unit.Value; this.store.UpdateAsync(run, ct);', 'UpdateAsync'),
    null,
    'a call after an unconditional return is dead code and is not matched',
  );
  assert.equal(
    csharpInvocation('throw new Exception(); this.store.UpdateAsync(run, ct);', 'UpdateAsync'),
    null,
    'a call after an unconditional throw is dead code and is not matched',
  );
  // A REACHABLE call before the return is still matched.
  const live = csharpInvocation('this.store.UpdateAsync(run, ct); return Unit.Value;', 'UpdateAsync');
  assert.ok(live && live.receiver === 'store', 'a reachable call before the return is matched');
  // A call INSIDE the terminating return expression is reachable and matched.
  const inReturn = csharpInvocation('return this.store.SaveAsync(run, ct);', 'SaveAsync');
  assert.ok(inReturn && inReturn.receiver === 'store', 'a call within the terminating return expression is reachable');
  // A call inside an EARLY conditional block (before the depth-0 terminator) is reachable.
  const conditional = csharpInvocation('if (x) { this.store.UpdateAsync(run, ct); } return Unit.Value;', 'UpdateAsync');
  assert.ok(conditional && conditional.receiver === 'store', 'a conditionally-reachable call before the depth-0 terminator is matched');
});

test('csharpInvocation reports whether a call is AWAITED (pass 41 finding #7)', () => {
  const awaited = csharpInvocation('await this.store.UpdateAsync(run, ct);', 'UpdateAsync');
  assert.ok(awaited && awaited.awaited === true, 'an `await this.store.UpdateAsync(...)` is reported as awaited');
  const fireForget = csharpInvocation('this.store.UpdateAsync(run, ct);', 'UpdateAsync');
  assert.ok(fireForget && fireForget.awaited === false, 'a fire-and-forget UpdateAsync is reported as NOT awaited');
  // `await` must be a separate token, not a prefix of an identifier.
  const notReally = csharpInvocation('awaiter.store.UpdateAsync(run, ct);', 'UpdateAsync');
  // (receiver here is `store` on a member chain `awaiter.store` — a member-chain receiver is
  // rejected by csharpInvocation, so this returns null; the point is `awaiter` is not `await`.)
  assert.equal(notReally, null, 'an identifier beginning with `await` is not the await keyword');
});

test('csharpInjectedFields rejects a CONDITIONAL DI assignment (must bind on every path) (pass 40 finding #7)', () => {
  // A field assigned inside an `if`/`else` is not unconditionally bound to one dependency.
  const conditional = `
    public sealed class H {
      private readonly IStore store;
      public H(IStore a, IStore b) {
        if (a != null) { this.store = a; } else { this.store = b; }
      }
    }`;
  assert.deepEqual(csharpInjectedFields(conditional), {}, 'a field assigned only inside if/else is not an unconditional injection');
  // A braceless conditional assignment is likewise rejected.
  const braceless = `
    public sealed class H {
      private readonly IStore store;
      public H(IStore a) {
        if (a != null) this.store = a;
      }
    }`;
  assert.deepEqual(csharpInjectedFields(braceless), {}, 'a braceless conditional field assignment is rejected');
  // The normal UNCONDITIONAL assignment is still accepted.
  const normal = `
    public sealed class H {
      private readonly IStore store;
      public H(IStore store) {
        this.store = store;
      }
    }`;
  assert.deepEqual(csharpInjectedFields(normal), { store: { type: 'IStore', parameter: 'store' } }, 'an unconditional this.field = param is accepted');
});

test('csharpInjectedFields drops an OVERWRITTEN field; csharpInvocation skips a call in an uncalled local function (pass 41 finding #6)', () => {
  // OVERWRITTEN field: the ctor assigns the injected param, then a method reassigns the field
  // to a DIFFERENT value — so the field is not stably the injected dependency and is dropped.
  const overwritten = `
    public sealed class H {
      private readonly IStore store;
      public H(IStore store) {
        this.store = store;
      }
      public void Swap(IStore other) {
        this.store = other;
      }
    }`;
  assert.deepEqual(csharpInjectedFields(overwritten), {}, 'a field later reassigned to a different value is not a stable injection');

  // SCOPE-AWARE (pass 48 finding #7): a `this.store = store` in a NON-constructor method — whose
  // `store` is a DIFFERENT, same-named method parameter — reassigns the field to an arbitrary
  // caller-supplied value and IS an overwrite (the previous name-only check let it survive). With
  // the field now `readonly`, this is also a compile error in real C#; the analyzer catches it.
  const reassignSameNamedParam = `
    public sealed class H {
      private readonly IStore store;
      public H(IStore store) {
        this.store = store;
      }
      public void Reset(IStore store) {
        this.store = store;
      }
    }`;
  assert.deepEqual(
    csharpInjectedFields(reassignSameNamedParam),
    {},
    'a this.store = store in a non-constructor method (a same-named parameter) is an overwrite (pass 48 finding #7)',
  );

  // A constructor that assigns the field from its injected parameter (even a second time in the
  // ctor from the same param) keeps the field — the injection is legitimate.
  const ctorOnly = `
    public sealed class H {
      private readonly IStore store;
      public H(IStore store) {
        this.store = store;
      }
    }`;
  assert.deepEqual(
    csharpInjectedFields(ctorOnly),
    { store: { type: 'IStore', parameter: 'store' } },
    'a constructor-only injection is kept',
  );

  // NON-IDENTIFIER overwrite (pass 45 finding #6): a reassignment to a CALL / `new` / member-chain
  // expression — not a bare identifier — must ALSO drop the field. The prior bare-identifier-only
  // match let `this.store = EvilFactory()` survive, leaving DI receiver provenance spoofable.
  for (const evil of ['this.store = EvilFactory();', 'this.store = new StoreImpl();', 'this.store = factory.Create();', 'this.store = a.b.c;']) {
    const src = `
      public sealed class H {
        private readonly IStore store;
        public H(IStore store) { this.store = store; }
        public void Swap() { ${evil} }
      }`;
    assert.deepEqual(csharpInjectedFields(src), {}, `a field overwritten by '${evil}' is not a stable injection`);
  }
  // A `==` comparison against the field is NOT an assignment and must not drop it.
  const compare = `
    public sealed class H {
      private readonly IStore store;
      public H(IStore store) { this.store = store; }
      public bool Same(IStore other) { return this.store == other; }
    }`;
  assert.deepEqual(
    csharpInjectedFields(compare),
    { store: { type: 'IStore', parameter: 'store' } },
    'a == comparison is not an overwrite',
  );

  // UNCALLED LOCAL FUNCTION: a call to this.store.UpdateAsync exists only inside a local
  // function body that is never invoked — it is not part of straight-line flow, so it must
  // NOT satisfy a receiver-bound invocation check.
  const localFn = 'void Local() { this.store.UpdateAsync(run, ct); } return;';
  assert.equal(csharpInvocation(localFn, 'UpdateAsync'), null, 'a call inside an uncalled local function is skipped');

  // A brace-bodied LAMBDA body is likewise not straight-line flow.
  const lambda = 'Action a = () => { this.store.UpdateAsync(run, ct); }; return;';
  assert.equal(csharpInvocation(lambda, 'UpdateAsync'), null, 'a call inside a brace-bodied lambda is skipped');

  // A call in a real control block (if/try) IS straight-line-reachable and still matched.
  const inIf = 'if (x) { this.store.UpdateAsync(run, ct); }';
  const call = csharpInvocation(inIf, 'UpdateAsync');
  assert.ok(call && call.receiver === 'store', 'a call inside an if-block is still matched (control flow, not a local function)');
});

test('csharpInjectedFields drops a field overwritten via ??=, compound assignment, or tuple deconstruction (pass 46 finding #7)', () => {
  // ??= NULL-COALESCING overwrite: conditionally reassigns the field, so it is not stably injected.
  const nullCoalesce = `
    public sealed class H {
      private readonly IStore store;
      public H(IStore store) { this.store = store; }
      public void Ensure(IStore fallback) { this.store ??= fallback; }
    }`;
  assert.deepEqual(csharpInjectedFields(nullCoalesce), {}, 'a field reassigned via ??= is not a stable injection');

  // COMPOUND assignment overwrite (e.g. `+=`): mutates the field beyond the injected value.
  for (const op of ['+=', '-=', '|=', '&=', '^=', '<<=', '>>=']) {
    const src = `
      public sealed class H {
        private readonly IStore store;
        public H(IStore store) { this.store = store; }
        public void Mutate(IStore x) { this.store ${op} x; }
      }`;
    assert.deepEqual(csharpInjectedFields(src), {}, `a field mutated via ${op} is not a stable injection`);
  }

  // TUPLE-DECONSTRUCTION overwrite: the field is a target of a parenthesized deconstruction, whose
  // value comes from a tuple/Deconstruct — the single-target `=` scan misses this.
  const tupleFirst = `
    public sealed class H {
      private readonly IStore store;
      private readonly int n;
      public H(IStore store) { this.store = store; }
      public void Reset() { (this.store, this.n) = Factory.Make(); }
    }`;
  assert.deepEqual(csharpInjectedFields(tupleFirst), {}, 'a field overwritten as the FIRST tuple target is dropped');
  const tupleLast = `
    public sealed class H {
      private readonly IStore store;
      public H(IStore store) { this.store = store; }
      public void Reset(int a) { (a, this.store) = (1, Build()); }
    }`;
  assert.deepEqual(csharpInjectedFields(tupleLast), {}, 'a field overwritten as a LATER tuple target is dropped');

  // A tuple that does NOT include the field, and an unrelated `==` tuple comparison, do not drop it.
  const tupleOther = `
    public sealed class H {
      private readonly IStore store;
      private readonly int a; private readonly int b;
      public H(IStore store) { this.store = store; }
      public void Reset() { (this.a, this.b) = (1, 2); }
    }`;
  assert.deepEqual(
    csharpInjectedFields(tupleOther),
    { store: { type: 'IStore', parameter: 'store' } },
    'a tuple deconstruction not targeting the field leaves it intact',
  );
});

test('csharpInjectedFields drops a field overwritten via an ESCAPED identifier or a NESTED tuple (pass 47 finding #5)', () => {
  // ESCAPED-IDENTIFIER overwrite: the field is reassigned via a verbatim `@store` or a
  // unicode-escaped `st\u006fre` spelling, which a raw-name regex misses but the identifier lexer
  // normalizes to `store`.
  const verbatim = `
    public sealed class H {
      private readonly IStore store;
      public H(IStore store) { this.store = store; }
      public void Swap(IStore other) { this.@store = other; }
    }`;
  assert.deepEqual(csharpInjectedFields(verbatim), {}, 'a field overwritten via a verbatim @store spelling is dropped');
  const unicodeEsc = `
    public sealed class H {
      private readonly IStore store;
      public H(IStore store) { this.store = store; }
      public void Swap(IStore other) { this.st\\u006fre = other; }
    }`;
  assert.deepEqual(csharpInjectedFields(unicodeEsc), {}, 'a field overwritten via a unicode-escaped spelling is dropped');
  // A bare escaped compound assignment is likewise caught.
  const escCompound = `
    public sealed class H {
      private readonly IStore store;
      public H(IStore store) { this.store = store; }
      public void M(IStore x) { @store ??= x; }
    }`;
  assert.deepEqual(csharpInjectedFields(escCompound), {}, 'a field mutated via an escaped ??= is dropped');

  // NESTED tuple deconstruction: the field is buried inside an inner tuple whose outer group is the
  // assignment target — the previous flat `[^()]*` tuple matcher could not cross the nested parens.
  const nested = `
    public sealed class H {
      private readonly IStore store;
      private readonly int a; private readonly int b;
      public H(IStore store) { this.store = store; }
      public void Reset() { ((this.store, this.a), this.b) = ((Build(), 1), 2); }
    }`;
  assert.deepEqual(csharpInjectedFields(nested), {}, 'a field overwritten inside a NESTED tuple deconstruction is dropped');

  // A field READ inside a method-call argument (not a deconstruction target) is NOT an overwrite.
  const readArg = `
    public sealed class H {
      private readonly IStore store;
      public H(IStore store) { this.store = store; }
      public void Use() { Log(this.store); }
    }`;
  assert.deepEqual(
    csharpInjectedFields(readArg),
    { store: { type: 'IStore', parameter: 'store' } },
    'a field read inside a call argument is not an overwrite',
  );
  // A field appearing in a right-hand-side tuple (read, not deconstruction target) is NOT dropped.
  const rhsTuple = `
    public sealed class H {
      private readonly IStore store;
      private readonly int a; private readonly int b;
      public H(IStore store) { this.store = store; }
      public void Snap() { (this.a, this.b) = Split((this.store, 1)); }
    }`;
  assert.deepEqual(
    csharpInjectedFields(rhsTuple),
    { store: { type: 'IStore', parameter: 'store' }, },
    'a field read in an RHS tuple is not an overwrite',
  );
});

test('csharpInjectedFields requires a readonly field and drops ref/out mutations (pass 48 finding #7)', () => {
  // A NON-readonly field is not trusted DI provenance (it can be reassigned outside the ctor or
  // passed ref/out), so it is not returned at all.
  const mutableField = `
    public sealed class H {
      private IStore store;
      public H(IStore store) { this.store = store; }
    }`;
  assert.deepEqual(csharpInjectedFields(mutableField), {}, 'a non-readonly field is not trusted DI provenance');
  // A readonly field with a plain ctor injection is kept.
  const readonlyField = `
    public sealed class H {
      private readonly IStore store;
      public H(IStore store) { this.store = store; }
    }`;
  assert.deepEqual(
    csharpInjectedFields(readonlyField),
    { store: { type: 'IStore', parameter: 'store' } },
    'a readonly ctor-injected field is trusted',
  );
  // The field passed by REF/OUT (the callee may reassign it) drops the field.
  for (const kw of ['ref', 'out']) {
    const byRef = `
      public sealed class H {
        private readonly IStore store;
        public H(IStore store) { this.store = store; }
        public void Rebind() { Factory.Init(${kw} this.store); }
      }`;
    assert.deepEqual(csharpInjectedFields(byRef), {}, `a field passed ${kw} is not a stable injection`);
    // Bare (unqualified) ref/out of the field is likewise caught.
    const bareRef = `
      public sealed class H {
        private readonly IStore store;
        public H(IStore store) { this.store = store; }
        public void Rebind() { Factory.Init(${kw} store); }
      }`;
    assert.deepEqual(csharpInjectedFields(bareRef), {}, `a bare field passed ${kw} is not a stable injection`);
  }
  // A field READ passed BY VALUE (not ref/out) is not an overwrite.
  const byValue = `
    public sealed class H {
      private readonly IStore store;
      public H(IStore store) { this.store = store; }
      public void Use() { Factory.Consume(this.store); }
    }`;
  assert.deepEqual(
    csharpInjectedFields(byValue),
    { store: { type: 'IStore', parameter: 'store' } },
    'a field passed by value is not an overwrite',
  );
});

test('csharpLocalWriteIndices counts ALL write forms of a bare local (pass 49 finding #4)', () => {
  // A single plain assignment.
  assert.equal(csharpLocalWriteIndices('var run = await store.GetAsync(id, ct);', 'run').length, 1, 'one plain write');
  // A read (member access, argument) is NOT a write.
  assert.equal(csharpLocalWriteIndices('var run = Get(); Use(run); return run.Status;', 'run').length, 1, 'reads are not writes');
  // Additional writes via each alternate form push the count above one.
  assert.equal(csharpLocalWriteIndices('var run = Get(); (run, x) = Swap();', 'run').length, 2, 'tuple deconstruction is a write');
  assert.equal(csharpLocalWriteIndices('var run = Get(); Reload(out run);', 'run').length, 2, 'out argument is a write');
  assert.equal(csharpLocalWriteIndices('var run = Get(); Reload(ref run);', 'run').length, 2, 'ref argument is a write');
  assert.equal(csharpLocalWriteIndices('var run = Get(); run ??= fallback;', 'run').length, 2, '??= is a write');
  assert.equal(csharpLocalWriteIndices('var run = Get(); run = other;', 'run').length, 2, 'a second plain assignment is a write');
  assert.equal(csharpLocalWriteIndices('var run = Get(); Unsafe.AsRef(in run) = evil;', 'run').length, 2, 'unsafe ref-return write is a write');
  // A `==` comparison and a `.Member` read are not writes.
  assert.equal(csharpLocalWriteIndices('var run = Get(); if (run == null) return; var s = run.Status;', 'run').length, 1, 'comparison + member read are not writes');
  // PREFIX / POSTFIX increment and decrement are writes (pass 50 finding #4).
  assert.equal(csharpLocalWriteIndices('var run = Get(); run++;', 'run').length, 2, 'postfix ++ is a write');
  assert.equal(csharpLocalWriteIndices('var run = Get(); run--;', 'run').length, 2, 'postfix -- is a write');
  assert.equal(csharpLocalWriteIndices('var run = Get(); ++run;', 'run').length, 2, 'prefix ++ is a write');
  assert.equal(csharpLocalWriteIndices('var run = Get(); --run;', 'run').length, 2, 'prefix -- is a write');
  // A `run += 1` (compound) is still a write and does not mis-read as a postfix `run+`.
  assert.equal(csharpLocalWriteIndices('var run = Get(); run += 1;', 'run').length, 2, 'compound += is a write');
});

test('csharpInjectedFields drops a readonly field mutated through a CUSTOM ref-return helper (ref dataflow, pass 50 finding #3)', () => {
  // A CUSTOM ref-returning helper (not in any hardcoded list) whose result is ref-captured and
  // written mutates the readonly field — detected by REF DATA FLOW, not a helper name list.
  const customDirect = `
    public sealed class H {
      private readonly IStore store;
      public H(IStore store) { this.store = store; }
      public void Hack(IStore evil) { MyRefHelper(ref this.store) = evil; }
    }`;
  assert.deepEqual(csharpInjectedFields(customDirect), {}, 'a custom ref-return helper whose result is assigned drops the field');
  // A custom helper captured into a ref local (`ref var r = ref Custom(in this.store);`) is a
  // ref-escape and drops the field even without a visible later write.
  const customCapture = `
    public sealed class H {
      private readonly IStore store;
      public H(IStore store) { this.store = store; }
      public void Hack() { ref var r = ref Custom.MakeRef(in this.store); }
    }`;
  assert.deepEqual(csharpInjectedFields(customCapture), {}, 'a custom ref-returning helper captured as a ref local drops the field');
  // A NORMAL (non-ref) call whose result is NOT ref-captured or assigned is not a mutation.
  const normal = `
    public sealed class H {
      private readonly IStore store;
      public H(IStore store) { this.store = store; }
      public bool Check() { return Validate(this.store); }
    }`;
  assert.deepEqual(
    csharpInjectedFields(normal),
    { store: { type: 'IStore', parameter: 'store' } },
    'an ordinary call taking the field is not a ref mutation',
  );
  // A `var x = Compute(this.store);` (by-value, result assigned to a NEW local, not `= ref`) is
  // not a ref-capture of the field.
  const byValueCapture = `
    public sealed class H {
      private readonly IStore store;
      public H(IStore store) { this.store = store; }
      public void Use() { var x = Compute(this.store); }
    }`;
  assert.deepEqual(
    csharpInjectedFields(byValueCapture),
    { store: { type: 'IStore', parameter: 'store' } },
    'a by-value result assigned to a new local is not a ref-capture',
  );
});

test('csharpInjectedFields drops a readonly field written through an unsafe ref-return (pass 49 finding #5)', () => {
  // `Unsafe.AsRef(in this.store) = evil` writes THROUGH the readonly field via an aliasing
  // ref-return — a compiler-legal escape from readonly immutability, so the field is not trusted.
  const asRefIn = `
    public sealed class H {
      private readonly IStore store;
      public H(IStore store) { this.store = store; }
      public void Hack(IStore evil) { Unsafe.AsRef(in this.store) = evil; }
    }`;
  assert.deepEqual(csharpInjectedFields(asRefIn), {}, 'a field written via Unsafe.AsRef(in this.store) = evil is dropped');
  // A generic Unsafe.As<...>(ref this.store) = x form.
  const asGeneric = `
    public sealed class H {
      private readonly IStore store;
      public H(IStore store) { this.store = store; }
      public void Hack(object evil) { Unsafe.As<IStore, object>(ref this.store) = evil; }
    }`;
  assert.deepEqual(csharpInjectedFields(asGeneric), {}, 'a field written via Unsafe.As<...>(ref this.store) = x is dropped');
  // MemoryMarshal.GetReference(ref ...) taking the field BY REF and ref-capturing the result is a
  // ref-return vector (pass 51 finding #6: the field must be passed BY REF to be aliased).
  const getRef = `
    public sealed class H {
      private readonly IStore store;
      public H(IStore store) { this.store = store; }
      public void Hack() { ref var r = ref MemoryMarshal.GetReference(ref this.store); }
    }`;
  assert.deepEqual(csharpInjectedFields(getRef), {}, 'a field passed BY REF to a ref producer and ref-captured is dropped');
  // A NORMAL read passed to an ordinary (non-ref-returning, not-assigned) call is NOT an overwrite.
  const normalCall = `
    public sealed class H {
      private readonly IStore store;
      public H(IStore store) { this.store = store; }
      public bool Check() { return Validate(this.store); }
    }`;
  assert.deepEqual(
    csharpInjectedFields(normalCall),
    { store: { type: 'IStore', parameter: 'store' } },
    'a field passed to an ordinary (non-assigned, non-unsafe) call is not an overwrite',
  );
});

test('csharpInjectedFields binds ref-return mutation to the ACTUAL ref-producing dataflow, not any enclosing call (pass 51 finding #6)', () => {
  // FALSE-POSITIVE guard: the field is a BY-VALUE nested argument to `Compute`, whose result is
  // `in`-passed to a ref producer that IS assigned. The field itself is passed by VALUE, so it is
  // NOT aliased — it must NOT be dropped.
  const nestedByValue = `
    public sealed class H {
      private readonly IStore store;
      public H(IStore store) { this.store = store; }
      public void Use(object evil) { Unsafe.AsRef(in Compute(this.store)) = evil; }
    }`;
  assert.deepEqual(
    csharpInjectedFields(nestedByValue),
    { store: { type: 'IStore', parameter: 'store' } },
    'a by-value nested argument is not aliased by an outer ref-return (no false positive)',
  );
  // Another false-positive shape: the field is a plain by-value argument to a call whose result is
  // assigned (a ref-returning indexer/method), but the FIELD is by value.
  const byValueArgAssigned = `
    public sealed class H {
      private readonly IStore store;
      public H(IStore store) { this.store = store; }
      public void Use(object evil) { GetSlot(this.store) = evil; }
    }`;
  assert.deepEqual(
    csharpInjectedFields(byValueArgAssigned),
    { store: { type: 'IStore', parameter: 'store' } },
    'a by-value argument to an assigned call is not a ref mutation of the field',
  );
  // TRUE POSITIVE preserved: the field passed BY REF (`in`) to the DIRECTLY-enclosing ref producer
  // whose result is assigned is still dropped.
  const directRef = `
    public sealed class H {
      private readonly IStore store;
      public H(IStore store) { this.store = store; }
      public void Use(object evil) { Unsafe.AsRef(in this.store) = evil; }
    }`;
  assert.deepEqual(csharpInjectedFields(directRef), {}, 'a field passed in/ref to the directly-enclosing assigned ref producer is dropped');
});

test('csharpRegionHasBypassingControl proves single-exit dominance and rejects nested bypasses (pass 52 finding #5)', () => {
  // Straight-line region (transition then persistence) — no bypass, dominance holds.
  const straight = 'run.TransitionTo(Canceling); await store.UpdateAsync(run, ct); return Unit.Value;';
  const upd = straight.indexOf('UpdateAsync');
  assert.equal(csharpRegionHasBypassingControl(straight, 0, upd), false, 'a straight-line region has no bypassing control');
  // A nested `return` BETWEEN the transition and the persistence bypasses the update on one path.
  const midReturn = 'run.TransitionTo(Canceling); if (x) return Unit.Value; await store.UpdateAsync(run, ct);';
  assert.equal(csharpRegionHasBypassingControl(midReturn, 0, midReturn.indexOf('UpdateAsync')), true, 'a conditional return before the persistence is a bypass');
  // A `return` inside a try/using/lock block is still a method-level early exit.
  const tryReturn = 'run.TransitionTo(Canceling); try { return Unit.Value; } finally { } await store.UpdateAsync(run, ct);';
  assert.equal(csharpRegionHasBypassingControl(tryReturn, 0, tryReturn.indexOf('UpdateAsync')), true, 'a try-block return is a bypass');
  // A `throw` on some path likewise bypasses the persistence.
  const throwPath = 'run.TransitionTo(Canceling); if (bad) throw new Exception(); await store.UpdateAsync(run, ct);';
  assert.equal(csharpRegionHasBypassingControl(throwPath, 0, throwPath.indexOf('UpdateAsync')), true, 'a conditional throw before the persistence is a bypass');
  // A return CONFINED to a nested lambda/local function is that callee's own flow, not a bypass.
  const lambdaReturn = 'run.TransitionTo(Canceling); Action a = () => { return; }; await store.UpdateAsync(run, ct);';
  assert.equal(csharpRegionHasBypassingControl(lambdaReturn, 0, lambdaReturn.indexOf('UpdateAsync')), false, 'a return inside a nested lambda is not a method-level bypass');
});

test('csharpRegionHasBypassingControl treats KNOWN-THROWING guard calls as bypasses (pass 53 finding #4)', () => {
  // A `ThrowIfCancellationRequested()` between the transition and the persistence can throw and
  // bypass the update on the exception path — persistence no longer dominates every exit.
  const tific = 'run.TransitionTo(Canceling); ct.ThrowIfCancellationRequested(); await store.UpdateAsync(run, ct);';
  assert.equal(csharpRegionHasBypassingControl(tific, 0, tific.indexOf('UpdateAsync')), true, 'a ThrowIfCancellationRequested guard is a bypass');
  // Guard-clause idioms likewise throw.
  const ensure = 'run.TransitionTo(Canceling); EnsureNotTerminal(run); await store.UpdateAsync(run, ct);';
  assert.equal(csharpRegionHasBypassingControl(ensure, 0, ensure.indexOf('UpdateAsync')), true, 'an Ensure… guard call is a bypass');
  const guard = 'run.TransitionTo(Canceling); Guard.AgainstNull(run); await store.UpdateAsync(run, ct);';
  assert.equal(csharpRegionHasBypassingControl(guard, 0, guard.indexOf('UpdateAsync')), true, 'a Guard.… clause is a bypass');
  // A MEMBER-CHAIN guard rooted at Guard (`Guard.Against.Null(run)`) is likewise a bypass (pass 54
  // finding R3: more than one member before the invocation).
  const guardChain = 'run.TransitionTo(Canceling); Guard.Against.Null(run); await store.UpdateAsync(run, ct);';
  assert.equal(csharpRegionHasBypassingControl(guardChain, 0, guardChain.indexOf('UpdateAsync')), true, 'a Guard.Against.Null(...) member-chain guard is a bypass');
  const guardDeepChain = 'run.TransitionTo(Canceling); Guard.Against.Null.OrEmpty(run); await store.UpdateAsync(run, ct);';
  assert.equal(csharpRegionHasBypassingControl(guardDeepChain, 0, guardDeepChain.indexOf('UpdateAsync')), true, 'a deeper Guard member-chain guard is a bypass');
  const validate = 'run.TransitionTo(Canceling); ValidateState(run); await store.UpdateAsync(run, ct);';
  assert.equal(csharpRegionHasBypassingControl(validate, 0, validate.indexOf('UpdateAsync')), true, 'a Validate… guard call is a bypass');
  // NEGATIVE: the benign transition + await prefix (TransitionTo / ConfigureAwait) are NOT throwing
  // guard idioms, so a clean straight-line region is still dominance-proven.
  const benign = 'run.TransitionTo(Canceling); await store.UpdateAsync(run, ct).ConfigureAwait(false);';
  assert.equal(csharpRegionHasBypassingControl(benign, 0, benign.indexOf('UpdateAsync')), false, 'the benign transition + await prefix is not a throwing guard');
  // A throwing guard confined to a nested lambda is that callee's flow, not a method-level bypass.
  const lambdaGuard = 'run.TransitionTo(Canceling); Action a = () => EnsureX(); await store.UpdateAsync(run, ct);';
  assert.equal(csharpRegionHasBypassingControl(lambdaGuard, 0, lambdaGuard.indexOf('UpdateAsync')), false, 'a guard call inside a nested lambda is not a method-level bypass');
  // A Guard member-chain confined to a nested lambda is likewise not a method-level bypass (R3 keeps
  // the nested-lambda exclusion).
  const lambdaGuardChain = 'run.TransitionTo(Canceling); Action a = () => Guard.Against.Null(x); await store.UpdateAsync(run, ct);';
  assert.equal(csharpRegionHasBypassingControl(lambdaGuardChain, 0, lambdaGuardChain.indexOf('UpdateAsync')), false, 'a Guard member-chain inside a nested lambda is not a method-level bypass');
});

test('csharpInjectedFields drops a field captured through a CHAINED/FLUENT ref-return (pass 52 finding #4)', () => {
  // A fluent chain where the field's own call is NOT the first link: `First().Second(in this.store)`
  // whose WHOLE result is `ref`-captured aliases the field, so it is dropped.
  const fluentCapture = `
    public sealed class H {
      private readonly IStore store;
      public H(IStore store) { this.store = store; }
      public void Hack() { ref var r = ref First().Second(in this.store); r = null; }
    }`;
  assert.deepEqual(csharpInjectedFields(fluentCapture), {}, 'a fluent chain (First().Second(in field)) ref-captured drops the field');
  // A GENERIC fluent link receiving the field by `in`, whole chain ref-captured.
  const genericFluent = `
    public sealed class H {
      private readonly IStore store;
      public H(IStore store) { this.store = store; }
      public void Hack() { ref var r = ref Helpers.Wrap<IStore>(in this.store).AsRef(); r = null; }
    }`;
  assert.deepEqual(csharpInjectedFields(genericFluent), {}, 'a generic fluent ref producer ref-captured drops the field');
  // NEGATIVE: the same fluent shape WITHOUT a ref-capture and WITHOUT an assignment of the result is
  // an ordinary read — the field is NOT dropped.
  const fluentRead = `
    public sealed class H {
      private readonly IStore store;
      public H(IStore store) { this.store = store; }
      public bool Check() { return First().Second(in this.store).IsValid(); }
    }`;
  assert.deepEqual(
    csharpInjectedFields(fluentRead),
    { store: { type: 'IStore', parameter: 'store' } },
    'a fluent chain that is neither ref-captured nor assigned is not a mutation',
  );
});

test('csharpInjectedFields drops a field captured/assigned through PARENTHESIZED ref-returns (pass 53 finding #5)', () => {
  // A ref-return wrapped in GROUPING parens on the CAPTURE side: `ref var r = ref (AsRef(in field));`.
  const parenCapture = `
    public sealed class H {
      private readonly IStore store;
      public H(IStore store) { this.store = store; }
      public void Hack() { ref var r = ref (Unsafe.AsRef(in this.store)); r = null; }
    }`;
  assert.deepEqual(csharpInjectedFields(parenCapture), {}, 'a parenthesized ref-capture drops the field');
  // Grouping parens on the ASSIGNMENT side: `(AsRef(ref field)) = evil;`.
  const parenAssign = `
    public sealed class H {
      private readonly IStore store;
      public H(IStore store) { this.store = store; }
      public void Hack(object evil) { (Unsafe.AsRef(ref this.store)) = evil; }
    }`;
  assert.deepEqual(csharpInjectedFields(parenAssign), {}, 'a parenthesized ref-return assignment target drops the field');
  // DOUBLE grouping parens are also unwrapped.
  const doubleParen = `
    public sealed class H {
      private readonly IStore store;
      public H(IStore store) { this.store = store; }
      public void Hack(object evil) { ((Unsafe.AsRef(in this.store))) = evil; }
    }`;
  assert.deepEqual(csharpInjectedFields(doubleParen), {}, 'doubly-parenthesized ref-return assignment target drops the field');
  // NEGATIVE (no false positive): `Foo(M(in field)) = v` — the field is a BY-VALUE nested arg to M,
  // whose ref result is passed BY VALUE to Foo; Foo's ref-return does NOT alias the field, so the
  // enclosing call paren must NOT be mistaken for a wrapping group.
  const nestedCall = `
    public sealed class H {
      private readonly IStore store;
      public H(IStore store) { this.store = store; }
      public void Use(object evil) { Foo(Unsafe.AsRef(in this.store)) = evil; }
    }`;
  assert.deepEqual(
    csharpInjectedFields(nestedCall),
    { store: { type: 'IStore', parameter: 'store' } },
    'an enclosing call paren is not a grouping paren (no false positive)',
  );
});

test('csharpLocalWriteIndices counts a PARENTHESIZED ref-capture of a local as a write (pass 53 finding #5)', () => {
  // A local aliased through a parenthesized ref-capture is a WRITE vector (the alias can replace it).
  const body = 'var run = await store.GetAsync(id, ct); ref var r = ref (Unsafe.AsRef(in run)); r = other;';
  const writes = csharpLocalWriteIndices(body, 'run');
  assert.equal(writes.length, 2, 'the declaration and the parenthesized ref-capture are both counted as writes of run');
});

test('csharpInvocation.unconditional fails closed when goto precedes the call (pass 46 finding #7)', () => {
  // A `goto` before the call can skip it (forward jump) or re-enter (backward jump), so straight-
  // line dominance cannot be proven — the call is NOT unconditional.
  const gotoSkip = 'if (c) goto done; await this.store.UpdateAsync(run, ct); done: return;';
  const g = csharpInvocation(gotoSkip, 'UpdateAsync');
  assert.ok(g && g.receiver === 'store', 'the call is still matched');
  assert.equal(g!.unconditional, false, 'a call reachable only past a goto is not proven unconditional');
});

test('csharpEnclosedInLocalFunctionOrLambda flags an EXPRESSION-BODIED local function body (pass 46 finding #5)', () => {
  // The mandatory cancellation-transition check must reject a transition that lives only inside an
  // uncalled expression-bodied local function (`void DoCancel() => run.TransitionTo(Canceling);`),
  // which is at brace-depth 0 with no braceless control prefix yet never runs unless invoked.
  const exprLocalFn = 'void DoCancel() => run.TransitionTo(ScenarioRunState.Canceling); return;';
  const callIdx = exprLocalFn.indexOf('run.TransitionTo');
  assert.ok(
    csharpEnclosedInLocalFunctionOrLambda(exprLocalFn, callIdx),
    'a call inside an expression-bodied local function is flagged as not-straight-line',
  );
  // A brace-bodied local function is likewise flagged.
  const braceLocalFn = 'void DoCancel() { run.TransitionTo(ScenarioRunState.Canceling); } return;';
  const braceIdx = braceLocalFn.indexOf('run.TransitionTo');
  assert.ok(csharpEnclosedInLocalFunctionOrLambda(braceLocalFn, braceIdx), 'a brace-bodied local function is flagged');
  // A REAL straight-line transition (not in a local function) is NOT flagged.
  const straight = 'run.TransitionTo(ScenarioRunState.Canceling); await store.UpdateAsync(run, ct);';
  assert.ok(
    !csharpEnclosedInLocalFunctionOrLambda(straight, straight.indexOf('run.TransitionTo')),
    'a straight-line transition is not flagged',
  );
});

test('csharpInvocation.unconditional distinguishes straight-line from conditional/braceless calls (pass 43 finding #7)', () => {
  // A direct, awaited statement at method-body depth 0 is UNCONDITIONAL.
  const straight = 'var x = await this.store.UpsertAsync(document, ct).ConfigureAwait(false); return x;';
  const s = csharpInvocation(straight, 'UpsertAsync');
  assert.ok(s && s.unconditional, 'a direct await statement at depth 0 is unconditional');
  assert.ok(s!.awaited, 'and it is awaited');
  // A call nested inside an if-BLOCK is CONDITIONAL (brace depth >= 1).
  const braced = 'if (c) { await this.store.UpsertAsync(document, ct); } return;';
  const b = csharpInvocation(braced, 'UpsertAsync');
  assert.ok(b && b.receiver === 'store', 'the braced-if call is still matched');
  assert.equal(b!.unconditional, false, 'a call inside an if-block is conditional');
  // A BRACELESS conditional call is also CONDITIONAL (governed by a braceless if header).
  const bracelessIf = 'if (c) await this.store.UpsertAsync(document, ct); return;';
  const bi = csharpInvocation(bracelessIf, 'UpsertAsync');
  assert.ok(bi && bi.receiver === 'store', 'the braceless-if call is still matched');
  assert.equal(bi!.unconditional, false, 'a call governed by a braceless if is conditional');
  // A plain `return this.f(...)` expression call is unconditional.
  const ret = 'return this.store.UpsertAsync(document, ct);';
  const r = csharpInvocation(ret, 'UpsertAsync');
  assert.ok(r && r.unconditional, 'a return-expression call is unconditional');
});

test('csharpInvocation.unconditional requires DOMINANCE: a call after a conditional early exit is NOT unconditional (pass 44 finding #6)', () => {
  // A call after a BRACELESS conditional early return is skipped on the guard path → not dominating.
  const afterBracelessReturn = 'if (x) return; await this.store.UpsertAsync(document, ct);';
  const a = csharpInvocation(afterBracelessReturn, 'UpsertAsync');
  assert.ok(a && a.receiver === 'store', 'the call is still matched');
  assert.equal(a!.unconditional, false, 'a call after a braceless conditional return does not dominate');
  // A call after a nested-block conditional early return (guarded no-op) is likewise not dominating.
  const afterBlockReturn = 'if (run.Status.IsTerminal()) { return Ok(run); } await this.store.UpdateAsync(run, ct);';
  const b = csharpInvocation(afterBlockReturn, 'UpdateAsync');
  assert.ok(b && b.receiver === 'store', 'the guarded call is still matched');
  assert.equal(b!.unconditional, false, 'a call after a nested guard return does not dominate the exit');
  // A call after a conditional THROW is also not dominating.
  const afterThrow = 'if (x == null) throw new ArgumentNullException(); await this.store.UpsertAsync(document, ct);';
  const c = csharpInvocation(afterThrow, 'UpsertAsync');
  assert.equal(c!.unconditional, false, 'a call after a conditional throw does not dominate');
  // A return inside a LOCAL FUNCTION before the call is NOT a method exit → the call still dominates.
  const returnInLocalFn = 'int Local() { return 1; } await this.store.UpsertAsync(document, ct);';
  const d = csharpInvocation(returnInLocalFn, 'UpsertAsync');
  assert.ok(d && d.unconditional, 'a return inside an uncalled local function does not defeat dominance');
});

test('csharpIntConst parses a source int constant and ignores decoys (finding #10)', () => {
  assert.equal(csharpIntConst('private const int DefaultRetryAfterSeconds = 10;', 'DefaultRetryAfterSeconds'), 10);
  assert.equal(csharpIntConst('public const int Foo = -3 ;', 'Foo'), -3);
  // A decoy inside a comment or string must not be picked up (structural view).
  assert.equal(csharpIntConst('// const int Foo = 999;\nconst int Foo = 7;', 'Foo'), 7);
  assert.equal(csharpIntConst('var s = "const int Foo = 999;"; const int Foo = 8;', 'Foo'), 8);
  // A same-suffix name is not matched (token boundary).
  assert.equal(csharpIntConst('const int XFoo = 5;', 'Foo'), undefined);
  assert.equal(csharpIntConst('const long Foo = 5;', 'Foo'), undefined, 'only `int` consts are parsed');
});

test('stripCSharpNoise terminates a line comment at ALL C# newline forms (finding #11)', () => {
  // A CR-only (classic-Mac) newline must END the comment so the code after it is NOT
  // hidden. `code()` must survive as real code after each newline form.
  for (const nl of ['\r', '\u0085', '\u2028', '\u2029']) {
    const stripped = stripCSharpNoise(`// hidden${nl}code();`);
    assert.match(stripped, /code\(\)/, `code after a ${JSON.stringify(nl)} newline is not swallowed by the comment`);
    assert.doesNotMatch(stripped, /hidden/, 'the comment content is still blanked');
  }
  // A `#` directive likewise ends at a CR-only newline.
  const dir = stripCSharpNoise(`#pragma warning disable\rpublic void A(){}`);
  assert.match(dir, /public void A\(\)\{\}/, 'code after a CR-terminated directive survives');
});

test('stripCSharpNoise rejects a regular string spanning a CR-only newline (finding #11)', () => {
  // A single-line regular string cannot span any C# newline; a CR before the closing
  // quote is an unterminated string and must fail closed.
  assert.throws(() => stripCSharpNoise('var s = "unterminated\rint x = 1;'), /Unterminated string/);
});

test('csharpPropertyTypesByClass ignores properties of a NESTED type (finding #11)', () => {
  // The nested struct's `Contaminant` property must NOT appear in the outer class map.
  const src = `
    public class Outer {
      public string Real { get; }
      public struct Nested {
        public int Contaminant { get; }
      }
    }`;
  const byClass = csharpPropertyTypesByClass(src);
  assert.deepEqual(byClass['Outer'], { Real: 'string' }, 'only the outer class DIRECT member is collected');
  assert.ok(!('Contaminant' in (byClass['Outer'] ?? {})), 'the nested-type property does not contaminate the outer class');
});

// ---------------------------------------------------------------------------
// Twenty-first-pass hardening (finding #5): a backslash immediately before a
// recognized C# newline does NOT continue a regular string / char literal across the
// line (C# permits no line continuation there); such a sequence is an unterminated
// literal and must fail closed for EVERY newline form.
// ---------------------------------------------------------------------------

test('stripCSharpNoise rejects a backslash-newline line continuation in a regular string (finding #5)', () => {
  // A naive escape scanner (`\` => skip next char) would consume the newline and let
  // the string span the line break, hiding `code();` and masking the missing close
  // quote. Every recognized C# newline form after the escape must fail closed.
  for (const nl of ['\n', '\r', '\u0085', '\u2028', '\u2029']) {
    assert.throws(
      () => stripCSharpNoise(`var s = "open\\${nl}code();`),
      /Unterminated string/,
      `a backslash before ${JSON.stringify(nl)} does not continue the string`,
    );
  }
  // A backslash at EOF (no following char) is likewise an unterminated string.
  assert.throws(() => stripCSharpNoise('var s = "open\\'), /Unterminated string/, 'a trailing backslash at EOF fails closed');
});

test('stripCSharpNoise rejects a backslash-newline line continuation in a char literal (finding #5)', () => {
  for (const nl of ['\n', '\r', '\u0085', '\u2028', '\u2029']) {
    assert.throws(
      () => stripCSharpNoise(`var c = '\\${nl}';`),
      /Unterminated character/,
      `a backslash before ${JSON.stringify(nl)} does not continue the char literal`,
    );
  }
  assert.throws(() => stripCSharpNoise("var c = '\\"), /Unterminated character/, 'a trailing backslash at EOF fails closed');
});

test('stripCSharpNoise still accepts a normal escaped quote and escaped backslash (finding #5)', () => {
  // Regression guard: a legitimate `\"` and `\\` on one line still parse (the newline
  // rule only rejects a backslash IMMEDIATELY before a newline/EOF).
  const okQuote = stripCSharpNoise('var s = "a\\"b"; code();');
  assert.match(okQuote, /code\(\)/, 'an escaped quote does not prematurely end the string');
  const okBackslash = stripCSharpNoise('var s = "a\\\\"; code();');
  assert.match(okBackslash, /code\(\)/, 'an escaped backslash then a real close quote parses');
});
