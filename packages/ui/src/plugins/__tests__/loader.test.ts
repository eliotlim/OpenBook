import {describe, expect, it} from 'vitest';
import {zipSync, strToU8} from 'fflate';
import {executePlugin, parsePluginZip} from '../loader';
import type {PluginManifest} from '@book.dev/sdk';

const manifest: PluginManifest = {id: 'acme.demo', name: 'Demo', version: '1.0.0', main: 'src/index.ts'};

describe('parsePluginZip', () => {
  const zipOf = (entries: Record<string, string>): Uint8Array =>
    zipSync(Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, strToU8(v)])));

  it('reads manifest, sources, and signature from a zip', () => {
    const pkg = parsePluginZip(
      zipOf({
        'openbook.json': JSON.stringify(manifest),
        'src/index.ts': 'export default () => {};',
        'signature.json': JSON.stringify({registry: 'R', publicKey: 'pk', signature: 's', algorithm: 'ed25519'}),
        'README.md': 'ignored',
      }),
    );
    expect(pkg.manifest.id).toBe('acme.demo');
    expect(Object.keys(pkg.files)).toEqual(['src/index.ts']);
    expect(pkg.signature?.registry).toBe('R');
  });

  it('tolerates a single top-level folder (zipped directories)', () => {
    const pkg = parsePluginZip(
      zipOf({
        'my-plugin/openbook.json': JSON.stringify(manifest),
        'my-plugin/src/index.ts': 'export default () => {};',
      }),
    );
    expect(pkg.files['src/index.ts']).toBeDefined();
  });

  it('rejects garbage, bad manifests, and missing entries with readable errors', () => {
    expect(() => parsePluginZip(strToU8('not a zip'))).toThrow(/zip/);
    expect(() => parsePluginZip(zipOf({'src/index.ts': 'x'}))).toThrow(/openbook.json/);
    expect(() => parsePluginZip(zipOf({'openbook.json': JSON.stringify(manifest)}))).toThrow(/entry file/);
  });
});

describe('executePlugin', () => {
  it('links multi-file TypeScript with relative imports and JSON', () => {
    const mod = executePlugin(
      {
        manifest,
        files: {
          'src/index.ts': 'import {double} from \'./math\'; import config from \'../config.json\'; export default () => double(config.base);',
          'src/math.ts': 'export const double = (n: number): number => n * 2;',
          'config.json': '{"base": 21}',
        },
      },
      {},
    );
    expect((mod.default as () => number)()).toBe(42);
  });

  it('maps host modules and rejects unknown bare imports', () => {
    const mod = executePlugin(
      {manifest, files: {'src/index.ts': 'import {api} from \'@book.dev/plugin-sdk\'; export default () => api.manifest.id;'}},
      {'@book.dev/plugin-sdk': {api: {manifest: {id: 'host.id'}}}},
    );
    expect((mod.default as () => string)()).toBe('host.id');

    expect(() =>
      executePlugin({manifest, files: {'src/index.ts': 'import x from \'left-pad\'; export default x;'}}, {}),
    ).toThrow(/not available to plugins/);
  });

  it('renders JSX through the host React', () => {
    const mod = executePlugin(
      {
        manifest: {...manifest, main: 'src/view.tsx'},
        files: {'src/view.tsx': 'import React from \'react\'; export default () => <span>hi</span>;'},
      },
      // A fake React: createElement records the call.
      {react: {default: {createElement: (type: string, _p: unknown, child: string) => `${type}:${child}`}, createElement: (type: string, _p: unknown, child: string) => `${type}:${child}`}},
    );
    expect((mod.default as () => string)()).toBe('span:hi');
  });
});
