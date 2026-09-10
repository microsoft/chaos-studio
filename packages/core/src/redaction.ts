/**
 * redaction.ts (E2-T2) — scrub tokens and secret-shaped values from any text
 * before it is logged (FR12, VF16). Per the repository's redaction guidance,
 * both `SharedAccessKey` and `SharedAccessSignature` shapes are scrubbed so a
 * SAS-based value cannot leak. This module has no dependencies and never throws.
 */

const REDACTED = '<redacted>';

/**
 * Ordered scrub rules. Each replaces only the secret material, preserving the
 * surrounding structure (header name, key name, other query parameters) so the
 * log stays useful for diagnostics. Secret-shaped `key=value` pairs are matched
 * with `=`, `:`, or a quoted-JSON (`"key":"value"`) delimiter so a value in a
 * stringified error body is scrubbed too.
 */
const RULES: Array<{ pattern: RegExp; replacement: string }> = [
  // `Bearer <token>` (Authorization header value or inline).
  { pattern: /(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, replacement: `$1${REDACTED}` },
  // Bare JWT-shaped token: three base64url segments separated by dots.
  { pattern: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, replacement: REDACTED },
  // Connection-string / SAS key-value shapes (`=`, `:`, or `":"`). The value runs
  // to the next delimiter (`;`, `&`, whitespace, quote) so only the secret is removed.
  { pattern: /(SharedAccessSignature["']?\s*[:=]\s*["']?)[^;&"'\s]+/gi, replacement: `$1${REDACTED}` },
  { pattern: /(SharedAccessKey["']?\s*[:=]\s*["']?)[^;&"'\s]+/gi, replacement: `$1${REDACTED}` },
  { pattern: /(AccountKey["']?\s*[:=]\s*["']?)[^;&"'\s]+/gi, replacement: `$1${REDACTED}` },
  // SAS signature parameter.
  { pattern: /(\bsig["']?\s*[:=]\s*["']?)[^;&"'\s]+/gi, replacement: `$1${REDACTED}` },
];

/** Returns `text` with tokens and secret-shaped values replaced by `<redacted>`. */
export function redact(text: string): string {
  let out = text;
  for (const { pattern, replacement } of RULES) {
    out = out.replace(pattern, replacement);
  }
  return out;
}
