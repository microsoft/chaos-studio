import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Supply-chain guard for the per-mode GitHub Action examples (E3-T3). The plan's
 * hardening requirement is that EVERY `uses:` action in the examples — third-party
 * AND `microsoft/chaos-studio` itself — is pinned to a full 40-hex commit SHA, not
 * a mutable tag/branch (a moving `@v1`/`@main` reference is a supply-chain risk).
 * These tests are deterministic (read the committed YAML; no network/clock/`az`).
 */

const examplesDir = fileURLToPath(new URL('../../../examples/github/', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

/** Capture the action reference from a `uses:` step line. */
const USES_RE = /^\s*(?:-\s*)?uses:\s*(\S+)/;
/** A full git commit SHA (what a hardened `uses:` ref must pin to). */
const FULL_SHA = /^[0-9a-f]{40}$/;

function exampleFiles(): string[] {
  return readdirSync(examplesDir).filter((f) => f.endsWith('.yml'));
}

function usesRefs(yaml: string): string[] {
  return yaml
    .split(/\r?\n/)
    .map((line) => USES_RE.exec(line)?.[1])
    .filter((v): v is string => typeof v === 'string');
}

test('the per-mode example workflows are all present', () => {
  const files = exampleFiles();
  for (const expected of [
    'validate-and-execute.yml',
    'validate-only.yml',
    'execute-only.yml',
    'execute-only-no-wait.yml',
  ]) {
    assert.ok(files.includes(expected), `missing example ${expected}`);
  }
});

test('every `uses:` action in every example is pinned to a full commit SHA (no mutable tags)', () => {
  for (const file of exampleFiles()) {
    const refs = usesRefs(readFileSync(join(examplesDir, file), 'utf8'));
    assert.ok(refs.length > 0, `${file} declares at least one action`);
    for (const ref of refs) {
      // A local composite action (`./...`) needs no pin; everything else is owner/repo@<sha>.
      if (ref.startsWith('./')) continue;
      const at = ref.lastIndexOf('@');
      assert.ok(at > 0, `${file}: '${ref}' must be pinned with @<sha>`);
      assert.match(
        ref.slice(at + 1),
        FULL_SHA,
        `${file}: '${ref}' must pin to a full 40-hex commit SHA, not a mutable tag`,
      );
    }
  }
});

/**
 * Shell-injection guard (reviewer P2 finding): a step-output value derived from the
 * chaos-studio Action (e.g. `run-state`) can be an arbitrary, unknown service string in
 * no-wait mode, so interpolating `${{ steps.*.outputs.* }}` directly into a `run:` Bash
 * block is unsafe even inside double quotes. Every example must instead map such
 * outputs through `env:` and reference them as shell variables (`$NAME`/`${NAME}`).
 */
test('example `run:` steps reference chaos-studio step outputs only via env vars, never by direct interpolation', () => {
  const OUTPUT_INTERPOLATION_RE = /\$\{\{\s*steps\.[\w-]+\.outputs\.[\w-]+\s*\}\}/;
  for (const file of exampleFiles()) {
    const yaml = readFileSync(join(examplesDir, file), 'utf8');
    const lines = yaml.split(/\r?\n/);
    let inRun = false;
    for (const line of lines) {
      if (/^\s*run:\s*\|/.test(line) || /^\s*run:\s*>/.test(line)) {
        inRun = true;
        continue;
      }
      if (/^\s*run:\s*\S/.test(line)) {
        // Single-line `run:` — check just this line.
        assert.doesNotMatch(
          line,
          OUTPUT_INTERPOLATION_RE,
          `${file}: step output interpolated directly into 'run:' — map through env: instead`,
        );
        continue;
      }
      if (inRun) {
        if (/^\s*(name:|uses:|with:|env:|id:|if:)/.test(line) && !/^\s{4,}/.test(line)) {
          inRun = false;
          continue;
        }
        assert.doesNotMatch(
          line,
          OUTPUT_INTERPOLATION_RE,
          `${file}: step output interpolated directly into 'run:' block — map through env: instead`,
        );
      }
    }
  }
});

test('every example pins microsoft/chaos-studio itself to a full commit SHA', () => {
  for (const file of exampleFiles()) {
    const chaos = usesRefs(readFileSync(join(examplesDir, file), 'utf8')).filter((r) =>
      r.startsWith('microsoft/chaos-studio@'),
    );
    assert.equal(chaos.length, 1, `${file} uses the chaos-studio Action exactly once`);
    assert.match(
      chaos[0]!.slice('microsoft/chaos-studio@'.length),
      FULL_SHA,
      `${file}: the chaos-studio Action must be SHA-pinned, not a mutable @v* tag`,
    );
  }
});

test('pre-release examples use an unmistakable non-resolving sentinel and document publication as a prerequisite', () => {
  const sentinel = 'microsoft/chaos-studio@0000000000000000000000000000000000000000';
  for (const file of exampleFiles()) {
    const yaml = readFileSync(join(examplesDir, file), 'utf8');
    assert.ok(yaml.includes(sentinel), `${file} uses the non-resolving pre-release sentinel`);
  }

  const examplesReadme = readFileSync(join(examplesDir, 'README.md'), 'utf8');
  assert.match(examplesReadme, /no public `microsoft\/chaos-studio@v1`/i);
  assert.match(examplesReadme, /all-zero 40-character SHA/i);
  assert.doesNotMatch(examplesReadme, /entry point is still the.*placeholder bundle/i);

  const rootReadme = readFileSync(join(repoRoot, 'README.md'), 'utf8');
  assert.match(rootReadme, /`microsoft\/chaos-studio@v1` ref does \*\*not exist yet\*\*/i);
  assert.match(rootReadme, /planned quickstart after the first preview release/i);
});

test('the pull-request validation example excludes forks and requires an approval environment', () => {
  const yaml = readFileSync(join(examplesDir, 'validate-only.yml'), 'utf8');
  assert.match(yaml, /environment:\s*chaos-validation/);
  assert.match(
    yaml,
    /if:\s*github\.event\.pull_request\.head\.repo\.full_name == github\.repository/,
  );
  assert.match(yaml, /required reviewers/i);
});
