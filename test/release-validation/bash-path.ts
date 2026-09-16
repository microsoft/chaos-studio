import { spawnSync } from 'node:child_process';

type WindowsBashPathConverter = 'cygpath' | 'wslpath' | 'slash';

let windowsConverter: WindowsBashPathConverter | undefined;

export function bashAvailable(): boolean {
  return spawnSync('bash', ['-c', 'true'], { encoding: 'utf8' }).status === 0;
}

function detectWindowsConverter(): WindowsBashPathConverter {
  if (windowsConverter) return windowsConverter;

  const result = spawnSync(
    'bash',
    [
      '-lc',
      'if command -v cygpath >/dev/null 2>&1; then printf cygpath; elif command -v wslpath >/dev/null 2>&1; then printf wslpath; else printf slash; fi',
    ],
    { encoding: 'utf8' },
  );
  windowsConverter =
    result.status === 0 && ['cygpath', 'wslpath', 'slash'].includes(result.stdout.trim())
      ? (result.stdout.trim() as WindowsBashPathConverter)
      : 'slash';
  return windowsConverter;
}

export function toBashPath(path: string): string {
  if (process.platform !== 'win32') return path;

  const converter = detectWindowsConverter();
  if (converter === 'slash') return path.replace(/\\/g, '/');

  const command =
    converter === 'cygpath'
      ? 'cygpath -u "$1"'
      : 'wslpath -a "$1"';
  const result = spawnSync('bash', ['-lc', command, 'bash', path], { encoding: 'utf8' });
  if (result.status !== 0 || !result.stdout.trim()) {
    throw new Error(
      `Unable to convert Windows path for ${converter}: ${result.stderr.trim() || path}`,
    );
  }
  return result.stdout.trim();
}
