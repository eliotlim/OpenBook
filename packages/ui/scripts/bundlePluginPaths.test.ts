import {posix, win32} from 'node:path';
import {describe, expect, it} from 'vitest';
import {relativePluginPath} from './bundlePluginPaths';

describe('relativePluginPath', () => {
  it.each([
    {
      host: 'POSIX',
      paths: posix,
      base: '/repo/examples/plugins/ledger',
      entry: '/repo/examples/plugins/ledger/src/index.ts',
    },
    {
      host: 'Windows',
      paths: win32,
      base: 'D:\\repo\\examples\\plugins\\ledger',
      entry: 'D:\\repo\\examples\\plugins\\ledger\\src\\index.ts',
    },
  ])('creates a portable manifest key from $host paths', ({paths, base, entry}) => {
    const files = {[relativePluginPath(base, entry, paths)]: 'plugin source'};

    expect(files).toHaveProperty('src/index.ts');
    expect('src/index.ts' in files).toBe(true);
  });
});
