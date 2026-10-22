import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import esbuild from 'esbuild';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRYPOINTS = [
  'packages/action-github/src/index.ts',
  'packages/task-azure-pipelines/src/index.ts',
];
const BLOCKING = new Set(['high', 'critical']);

function packageName(input) {
  const normalized = input.replaceAll('\\', '/');
  const marker = 'node_modules/';
  const at = normalized.lastIndexOf(marker);
  if (at < 0) return undefined;
  const parts = normalized.slice(at + marker.length).split('/');
  return parts[0]?.startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0];
}

async function bundledPackages() {
  const result = await esbuild.build({
    absWorkingDir: ROOT,
    entryPoints: ENTRYPOINTS,
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    outdir: 'audit-bundles',
    write: false,
    metafile: true,
    logLevel: 'silent',
    define: { 'import.meta.url': 'importMetaUrl' },
    banner: { js: 'const importMetaUrl = require("url").pathToFileURL(__filename).href;' },
  });
  return new Set(
    Object.keys(result.metafile.inputs)
      .map(packageName)
      .filter((name) => name !== undefined),
  );
}

const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('npm_execpath is not set; run this audit through npm run audit:bundles');
const audit = spawnSync(process.execPath, [npmCli, 'audit', '--omit=dev', '--json'], {
  cwd: ROOT,
  encoding: 'utf8',
});
if (audit.error) throw audit.error;

let report;
try {
  report = JSON.parse(audit.stdout);
} catch {
  console.error(audit.stdout);
  console.error(audit.stderr);
  throw new Error('npm audit did not return valid JSON');
}

const shipped = await bundledPackages();
const blocking = [];
const excluded = [];

for (const vulnerability of Object.values(report.vulnerabilities ?? {})) {
  for (const advisory of vulnerability.via ?? []) {
    if (typeof advisory !== 'object' || advisory === null) continue;
    if (!BLOCKING.has(advisory.severity)) continue;
    const finding = {
      package: advisory.name,
      severity: advisory.severity,
      title: advisory.title,
      url: advisory.url,
    };
    (shipped.has(advisory.name) ? blocking : excluded).push(finding);
  }
}

for (const finding of excluded) {
  console.log(
    `Install-only advisory excluded from shipped bundles: ${finding.package} ` +
      `(${finding.severity}) ${finding.url}`,
  );
}
if (blocking.length > 0) {
  for (const finding of blocking) {
    console.error(
      `::error::Bundled production advisory: ${finding.package} ` +
        `(${finding.severity}) ${finding.title} ${finding.url}`,
    );
  }
  process.exit(1);
}

console.log(
  `Bundled production audit passed (${shipped.size} bundled packages; ` +
    `${excluded.length} high/critical install-only advisories excluded).`,
);
