import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const auditScript = join(repoRoot, 'scripts', 'audit-bundled-production.mjs');

function runAudit(name: string) {
  const root = mkdtempSync(join(tmpdir(), 'bundle-audit-'));
  const npmCli = join(root, 'npm-audit.mjs');
  const report = {
    vulnerabilities: {
      [name]: {
        name,
        via: [{ name, severity: 'high', title: 'synthetic advisory', url: 'https://example.test/advisory' }],
      },
    },
  };
  writeFileSync(npmCli, `process.stdout.write(${JSON.stringify(JSON.stringify(report))});\n`);
  const result = spawnSync(process.execPath, [auditScript], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, npm_execpath: npmCli },
  });
  rmSync(root, { recursive: true, force: true });
  return result;
}

test('bundle audit fails on a high advisory in a package that is actually bundled', () => {
  const result = runAudit('undici');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Bundled production advisory: undici/);
});

test('bundle audit reports but excludes a high advisory in install-only tooling', () => {
  const result = runAudit('shelljs');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Install-only advisory excluded from shipped bundles: shelljs/);
});
