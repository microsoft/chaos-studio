import { test } from 'node:test';
import assert from 'node:assert/strict';

import { redact } from '../../src/redaction.ts';

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
