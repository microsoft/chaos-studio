// Fixture loader shared by the contract tests. Not a test file itself
// (excluded by the *.test.ts glob), so it defines helpers only.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const FIXTURES_DIR = join(import.meta.dirname, '..', '..', 'fixtures');

export interface HttpResponseFixture {
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
}

export interface HttpRequestFixture {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
}

export interface WireFixture {
  description: string;
  provenance?: { source: string; citation: string };
  operationId?: string;
  request?: HttpRequestFixture;
  response?: HttpResponseFixture;
  sequence?: Array<{ note?: string; request?: HttpRequestFixture; response: HttpResponseFixture }>;
  expected?: Record<string, string>;
  value?: unknown[];
}

export function loadFixture(...segments: string[]): WireFixture {
  const raw = readFileSync(join(FIXTURES_DIR, ...segments), 'utf8');
  return JSON.parse(raw) as WireFixture;
}

/** Reads properties.status from a wire response body regardless of shape. */
export function statusOf(body: unknown): string | undefined {
  const props = (body as { properties?: { status?: unknown } } | null)?.properties;
  return typeof props?.status === 'string' ? props.status : undefined;
}
