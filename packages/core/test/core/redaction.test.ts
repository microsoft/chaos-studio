import { test } from 'node:test';
import assert from 'node:assert/strict';

import { redact, redactSecretFields, redactedJson } from '../../src/redaction.ts';

test('redact scrubs a Bearer token but keeps surrounding text', () => {
  const out = redact('Authorization: Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.payloadpart.signaturepart done');
  assert.ok(!out.includes('payloadpart'));
  assert.ok(!out.includes('signaturepart'));
  assert.ok(out.startsWith('Authorization: '));
  assert.ok(out.includes('Bearer '));
  assert.ok(out.includes('<redacted>'));
  assert.ok(out.trim().endsWith('done'));
});

test('redact scrubs a bare JWT-shaped token anywhere in the text', () => {
  const jwt = 'eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w';
  const out = redact(`token=${jwt};rest`);
  assert.ok(!out.includes(jwt));
  assert.ok(out.includes('<redacted>'));
  assert.ok(out.endsWith(';rest'));
});

test('redact scrubs SharedAccessKey and SharedAccessSignature connection-string shapes', () => {
  const conn =
    'Endpoint=sb://x.servicebus.windows.net/;SharedAccessKeyName=root;SharedAccessKey=abc123SECRETkey==;EntityPath=q';
  const out = redact(conn);
  assert.ok(!out.includes('abc123SECRETkey=='));
  assert.ok(out.includes('SharedAccessKey=<redacted>'));
  assert.ok(out.includes('Endpoint=sb://x.servicebus.windows.net/'));

  const sas = 'https://x.blob.core.windows.net/c/b?sv=2021-08-06&sig=Ab%2Bcd3fGh4iJkLmNoP%3D&se=2026';
  const outSas = redact(sas);
  assert.ok(!outSas.includes('Ab%2Bcd3fGh4iJkLmNoP%3D'));
  assert.ok(outSas.includes('sig=<redacted>'));
});

test('redact scrubs an AccountKey and a SharedAccessSignature token', () => {
  const out = redact('AccountKey=Zm9vYmFyYmF6cXV4Cg==;SharedAccessSignature=sr%3Dhttps%253A%252F%252Fx');
  assert.ok(!out.includes('Zm9vYmFyYmF6cXV4Cg=='));
  assert.ok(out.includes('AccountKey=<redacted>'));
  assert.ok(out.includes('SharedAccessSignature=<redacted>'));
});

test('redact scrubs JSON-quoted and colon-delimited secret shapes (business-error bodies)', () => {
  const json = '{"SharedAccessKey":"TOPSECRETjsonKEY==","note":"keep"}';
  const outJson = redact(json);
  assert.ok(!outJson.includes('TOPSECRETjsonKEY=='));
  assert.ok(outJson.includes('SharedAccessKey'));
  assert.ok(outJson.includes('"note":"keep"'));

  const colon = redact('SharedAccessSignature: TOPSECRETcolon');
  assert.ok(!colon.includes('TOPSECRETcolon'));
  assert.ok(colon.includes('SharedAccessSignature'));

  const sigJson = redact('{"sig":"TOPSECRETsig"}');
  assert.ok(!sigJson.includes('TOPSECRETsig'));
  assert.ok(sigJson.includes('sig'));
});

test('redact leaves non-secret text unchanged', () => {
  const plain = 'GET .../runs/22222222-2222-2222-2222-222222222222 -> 202 Retry-After: 10';
  assert.equal(redact(plain), plain);
});

// R3: recursive secret-key redaction covers ordinary password/clientSecret/
// accessToken fields at ANY nesting depth, not just bearer/JWT/connection-string
// text shapes.
test('redactSecretFields scrubs password/clientSecret/accessToken at any nesting depth', () => {
  const parsed = {
    properties: {
      status: 'Failed',
      errors: [
        {
          code: 'AuthenticationFailed',
          message: 'bad creds',
          details: {
            password: 'topsecretpw',
            nested: {
              clientSecret: 'topsecretcs',
              accessToken: 'topsecretat',
              refreshToken: 'topsecretrt',
              keepMe: 'plain value',
            },
          },
        },
      ],
    },
  };
  const redacted = redactSecretFields(parsed) as typeof parsed;
  const details = redacted.properties.errors[0]!.details as Record<string, unknown>;
  assert.equal(details.password, '<redacted>');
  const nested = details.nested as Record<string, unknown>;
  assert.equal(nested.clientSecret, '<redacted>');
  assert.equal(nested.accessToken, '<redacted>');
  assert.equal(nested.refreshToken, '<redacted>');
  assert.equal(nested.keepMe, 'plain value');
  assert.equal(redacted.properties.errors[0]!.code, 'AuthenticationFailed');
});

test('redactSecretFields walks arrays of objects and leaves primitives untouched', () => {
  const parsed = [
    { accessToken: 'a-secret', ok: 1 },
    { nested: [{ password: 'b-secret' }, 'plain-string', 42] },
  ];
  const redacted = redactSecretFields(parsed) as typeof parsed;
  assert.equal((redacted[0] as Record<string, unknown>).accessToken, '<redacted>');
  assert.equal((redacted[0] as Record<string, unknown>).ok, 1);
  const nestedArr = (redacted[1] as Record<string, unknown>).nested as unknown[];
  assert.equal((nestedArr[0] as Record<string, unknown>).password, '<redacted>');
  assert.equal(nestedArr[1], 'plain-string');
  assert.equal(nestedArr[2], 42);
});

test('redactedJson stringifies with secret fields pre-scrubbed', () => {
  const out = redactedJson({ password: 'x', ok: 'y' });
  assert.ok(!out.includes('"x"'));
  assert.ok(out.includes('"password":"<redacted>"'));
  assert.ok(out.includes('"ok":"y"'));
});
