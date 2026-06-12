import {transform} from 'sucrase';
import {unzipSync, strFromU8} from 'fflate';
import {validateManifest, type PluginManifest, type PluginPackage} from '@open-book/sdk';

/**
 * The plugin loader: turns a zip of TypeScript source into a running module.
 *
 * - {@link parsePluginZip} reads `openbook.json` + every source file out of
 *   the archive (and a `signature.json` when the registry shipped one).
 * - {@link executePlugin} strips types with sucrase (fast, no typechecker)
 *   and links the files with a tiny in-memory CommonJS resolver, so plugins
 *   can be ordinary multi-file TypeScript programs. `react` and
 *   `@open-book/plugin-sdk` resolve to host-provided modules; anything else
 *   must live inside the zip — plugins are self-contained by design.
 */

export function parsePluginZip(bytes: Uint8Array): PluginPackage {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes);
  } catch {
    throw new Error('not a readable zip file');
  }
  const files: Record<string, string> = {};
  let manifest: PluginManifest | null = null;
  let signature: PluginPackage['signature'];

  // Tolerate a single top-level folder (zips of a directory): strip the
  // common prefix so `my-plugin/openbook.json` reads as `openbook.json`.
  const names = Object.keys(entries).filter((n) => !n.endsWith('/') && !n.startsWith('__MACOSX'));
  const roots = new Set(names.map((n) => n.split('/')[0]));
  const prefix = roots.size === 1 && !names.includes('openbook.json') ? `${[...roots][0]}/` : '';

  for (const name of names) {
    const path = name.startsWith(prefix) ? name.slice(prefix.length) : name;
    if (!path || path.startsWith('.')) continue;
    const text = strFromU8(entries[name]);
    if (path === 'openbook.json') {
      try {
        manifest = JSON.parse(text) as PluginManifest;
      } catch {
        throw new Error('openbook.json is not valid JSON');
      }
    } else if (path === 'signature.json') {
      try {
        signature = JSON.parse(text) as PluginPackage['signature'];
      } catch {
        throw new Error('signature.json is not valid JSON');
      }
    } else if (/\.(ts|tsx|js|jsx|json)$/.test(path)) {
      files[path] = text;
    }
  }

  const problem = validateManifest(manifest);
  if (problem) throw new Error(problem);
  if (!(manifest!.main in files)) throw new Error(`entry file "${manifest!.main}" is not in the zip`);
  return {manifest: manifest!, files, signature};
}

/** Resolve a relative import against the importing file's directory. */
function resolvePath(from: string, request: string): string {
  const parts = from.split('/').slice(0, -1);
  for (const seg of request.split('/')) {
    if (seg === '.' || seg === '') continue;
    else if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}

const CANDIDATE_SUFFIXES = ['', '.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx', '.json'];

/**
 * Execute a plugin package and return its entry module's exports. Host
 * modules (`react`, `@open-book/plugin-sdk`) come from `hostModules`; every
 * other import resolves inside the package.
 */
export function executePlugin(pkg: PluginPackage, hostModules: Record<string, unknown>): Record<string, unknown> {
  const cache = new Map<string, Record<string, unknown>>();

  const load = (path: string): Record<string, unknown> => {
    const hit = cache.get(path);
    if (hit) return hit;
    const source = pkg.files[path];
    if (source === undefined) throw new Error(`module not found in plugin: ${path}`);

    const moduleExports: Record<string, unknown> = {};
    cache.set(path, moduleExports); // pre-set for require cycles

    if (path.endsWith('.json')) {
      const parsed = JSON.parse(source) as unknown;
      // __esModule so sucrase's import interop unwraps to the JSON value.
      Object.assign(moduleExports, {__esModule: true, default: parsed}, typeof parsed === 'object' && parsed !== null ? parsed : {});
      return moduleExports;
    }

    const js = transform(source, {
      transforms: path.endsWith('.tsx') || path.endsWith('.jsx') ? ['typescript', 'imports', 'jsx'] : ['typescript', 'imports'],
      production: true,
      filePath: path,
    }).code;

    const require = (request: string): unknown => {
      if (request in hostModules) return hostModules[request];
      if (!request.startsWith('.')) throw new Error(`"${request}" is not available to plugins — bundle it into the zip`);
      const base = resolvePath(path, request);
      for (const suffix of CANDIDATE_SUFFIXES) {
        if (base + suffix in pkg.files) return load(base + suffix);
      }
      throw new Error(`cannot resolve "${request}" from ${path}`);
    };

    const fn = new Function('exports', 'require', 'module', `"use strict";${js}`);
    fn(moduleExports, require, {exports: moduleExports});
    return moduleExports;
  };

  return load(pkg.manifest.main);
}
