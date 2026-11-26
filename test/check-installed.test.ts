import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error: a plain .mjs script without type declarations
import { staleInstalls } from '../scripts/check-installed.mjs';

let root: string;
afterEach(() => rmSync(root, { recursive: true, force: true }));

function install(name: string, version: string) {
  mkdirSync(join(root, 'node_modules', name), { recursive: true });
  writeFileSync(join(root, 'node_modules', name, 'package.json'), JSON.stringify({ name, version }));
}

describe('check:installed', () => {
  it('names packages whose installed version is not the locked one, and missing ones', () => {
    root = mkdtempSync(join(tmpdir(), 'ardent-studio-installed-'));
    writeFileSync(join(root, 'package-lock.json'), JSON.stringify({ packages: {
      '': { name: 'fixture' },
      'node_modules/@hivemagnus/hive-common': { version: '0.6.0' },
      'node_modules/zod': { version: '4.6.7', dev: true },
      'node_modules/missing': { version: '1.0.0' },
      'node_modules/platform-only': { version: '1.0.0', optional: true },
    } }));
    install('@hivemagnus/hive-common', '0.5.0');
    install('zod', '4.6.7');
    expect(staleInstalls(root)).toEqual(['@hivemagnus/hive-common: installed 0.5.0, lock 0.6.0', 'missing: missing (lock 1.0.0)']);
    install('@hivemagnus/hive-common', '0.6.0');
    install('missing', '1.0.0');
    expect(staleInstalls(root)).toEqual([]);
  });
});
