import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { bashAvailable, toBashPath } from './bash-path.ts';

test(
  'toBashPath returns a path the installed Bash can access',
  { skip: !bashAvailable() ? 'bash is not installed' : false },
  () => {
    const dir = mkdtempSync(join(tmpdir(), 'bash-path-'));
    const file = join(dir, 'reachable.txt');
    writeFileSync(file, 'reachable');

    const result = spawnSync('bash', ['-c', 'test -f "$1"', 'bash', toBashPath(file)], {
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, result.stderr);
  },
);
