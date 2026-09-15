/**
 * redaction.ts (E2-T2) — scrub tokens and secret-shaped values from any text
 * before it is logged (FR12, VF16). Per the repository's redaction guidance,
 * both `SharedAccessKey` and `SharedAccessSignature` shapes are scrubbed so a
 * SAS-based value cannot leak. This module has no dependencies and never throws.
 */

const REDACTED = '<redacted>';

/**
 * Object keys whose VALUE is always secret material, regardless of nesting
 * depth or the surrounding shape. Matched case-insensitively against exact
 * key names (not key substrings), so e.g. `resourceGroupName` is untouched.
 */
const SECRET_KEY_NAMES = new Set([
  'password',
  'clientsecret',
  'client_secret',
  'accesstoken',
  'access_token',
  'refreshtoken',
  'refresh_token',
  'secret',
  'apikey',
  'api_key',
  'sharedaccesskey',
  'sharedaccesssignature',
  'accountkey',
  'sig',
  'authorization',
  'bearertoken',
]);

/**
 * Recursively walk a parsed JSON-like value and replace every value whose key
 * is secret-shaped (see {@link SECRET_KEY_NAMES}) with `<redacted>`, regardless
 * of nesting depth. Arrays are walked element-wise; primitives pass through
 * unchanged. This runs BEFORE `JSON.stringify` so structured diagnostics (e.g.
 * ARM error detail bodies) never surface a raw `password`/`clientSecret`/
 * `accessToken` field even when it is buried inside nested `details` (FR12,
 * VF16). Never throws: unparseable/cyclic input is returned as-is via a
 * defensive try/catch at the call site, not here (this function assumes a
 * plain JSON-shaped value with no cycles, as parsed response bodies always are).
 */
export function redactSecretFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecretFields);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEY_NAMES.has(key.toLowerCase()) ? REDACTED : redactSecretFields(v);
    }
    return out;
  }
  return value;
}

/** `JSON.stringify` a value with every secret-shaped field pre-scrubbed (FR12, VF16). */
export function redactedJson(value: unknown): string {
  return JSON.stringify(redactSecretFields(value));
}

/**
 * Ordered scrub rules. Each replaces only the secret material, preserving the
 * surrounding structure (header name, key name, other query parameters) so the
 * log stays useful for diagnostics. Secret-shaped `key=value` pairs are matched
 * with `=`, `:`, or a quoted-JSON (`"key":"value"`) delimiter so a value in a
 * stringified error body — or in free-text ARM/exception diagnostics (R2) —
 * is scrubbed too.
 */

/** Escape a literal string for safe interpolation into a `RegExp` source. */
function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build a free-text `key <delimiter> value` scrub rule for a secret-shaped key
 * name (`=`, `:`, or a quoted-JSON `"key":"value"` delimiter). The value runs
 * to the next delimiter (`;`, `&`, `,`, whitespace, closing quote/brace) so
 * only the secret is removed and the surrounding structure (key name, other
 * fields) stays intact for diagnostics.
 */
function keyValueRule(key: string): { pattern: RegExp; replacement: string } {
  const escaped = escapeRegExp(key);
  return {
    pattern: new RegExp(`(${escaped}["']?\\s*[:=]\\s*["']?)[^;&,"'\\s}]+`, 'gi'),
    replacement: `$1${REDACTED}`,
  };
}

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
  // R2: one key-value scrub rule per secret-shaped key name (password,
  // clientSecret, accessToken, apiKey, etc.) so free-text ARM/exception
  // diagnostics get the same protection structured objects already get via
  // `redactSecretFields`. `authorization` and `bearerToken` are excluded here:
  // they name a HEADER, not a `key=value` pair, and the value is a
  // whitespace-containing `Bearer <token>` shape already fully scrubbed by the
  // dedicated Bearer-prefix rule above (a naive `[^;&,"'\s}]+` value-stop would
  // truncate at the first space and leave the token fragment exposed).
  ...[...SECRET_KEY_NAMES].filter((k) => k !== 'authorization' && k !== 'bearertoken').map(keyValueRule),
];

/** Returns `text` with tokens and secret-shaped values replaced by `<redacted>`. */
export function redact(text: string): string {
  let out = text;
  for (const { pattern, replacement } of RULES) {
    out = out.replace(pattern, replacement);
  }
  return out;
}
