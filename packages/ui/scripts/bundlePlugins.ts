/**
 * Reads the first-party plugin source trees (examples/plugins/*) and emits a
 * generated TypeScript module that embeds them as SIGNED PluginPackage
 * literals. The UI's syncPlugins auto-install path imports this module — no
 * network fetch, no zip — the plugin source ships inside the UI bundle.
 *
 * Signing (see bundleSigning.ts): with OPENBOOK_REGISTRY_PRIVATE_KEY set
 * (release CI), packages are signed by the production registry key so fresh
 * installs verify against the pinned OPENBOOK_REGISTRY public key; otherwise
 * the committed TEST-ONLY key signs them (trusted nowhere by default — e2e
 * trusts it explicitly). Ed25519 is deterministic, so the git-tracked output
 * is byte-stable across regenerations with the same key.
 *
 * ALSO mirrors the ledger plugin's PURE report-fold modules (`reports.ts`,
 * `statements.ts` — no React, no IO, no host calls) into
 * `src/export/ledgerFolds.gen/` as compilable TypeScript, with the loader-only
 * `@book.dev/plugin-sdk` import rewritten to `@book.dev/sdk` (the host module
 * those money functions come from anyway). The static HTML export (LX-3)
 * imports the folds from there to render ledger REPORT blocks as real tables —
 * the plugin source stays the single source of truth, and the export bundle
 * never gains the plugin runtime (the mirrored modules are pure functions).
 *
 * Run: `npx tsx scripts/bundlePlugins.ts`
 * Output: `src/plugins/bundled.gen.ts` + `src/export/ledgerFolds.gen/*.ts`
 * (git-tracked, regenerated on build)
 */

import {mkdirSync, readFileSync, readdirSync, writeFileSync, statSync} from 'fs';
import {join, relative, resolve} from 'path';
import ts from 'typescript';
import {OPENBOOK_REGISTRY_KEYS} from '@book.dev/sdk';
import {relativePluginPath} from './bundlePluginPaths';
import {resolveSigningKey, signBundledPackage} from './bundleSigning';

const ROOT = resolve(import.meta.dirname, '..', '..', '..');
const OUT = resolve(import.meta.dirname, '..', 'src', 'plugins', 'bundled.gen.ts');
// Machine-readable sidecar of the emitted signatures, so release CI can
// assert the built bundle is signed by a pinned key without parsing/executing
// bundled.gen.ts (scripts/check-bundled-signatures.mjs).
const SIG_OUT = resolve(import.meta.dirname, '..', 'src', 'plugins', 'bundled.signatures.json');
const FOLDS_OUT_DIR = resolve(import.meta.dirname, '..', 'src', 'export', 'ledgerFolds.gen');

/** The ledger plugin's pure fold modules the export renderer compiles in. */
const LEDGER_FOLD_MODULES = ['reports.ts', 'statements.ts'] as const;

/**
 * Every module specifier `source` can pull in at build or run time, found by
 * walking the real TypeScript AST — not a regex. Covers static imports
 * (default/named/namespace AND bare side-effect `import 'x'`, either quote
 * style), re-exports (`export ... from 'x'`), dynamic `import('x')`,
 * `import x = require('x')`, and CommonJS `require('x')` calls. A dynamic
 * import/require whose argument is not a string literal is unauditable, so it
 * is reported as a sentinel specifier the allowlist can never match — the
 * purity gate fails CLOSED on anything it cannot read.
 */
function moduleSpecifiers(fileName: string, source: string): string[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const specs: string[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier !== undefined) {
      specs.push(ts.isStringLiteralLike(node.moduleSpecifier) ? node.moduleSpecifier.text : '<non-literal specifier>');
    } else if (ts.isCallExpression(node)) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
      if (isDynamicImport || isRequire) {
        const arg = node.arguments[0];
        specs.push(arg !== undefined && ts.isStringLiteralLike(arg) ? arg.text : '<non-literal specifier>');
      }
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const expr = node.moduleReference.expression;
      specs.push(ts.isStringLiteralLike(expr) ? expr.text : '<non-literal specifier>');
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return specs;
}

/** Recursively collect all files under `dir`, returning paths relative to `base`. */
function walk(dir: string, base: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      results.push(...walk(full, base));
    } else {
      results.push(relativePluginPath(base, full));
    }
  }
  return results;
}

interface BundledPlugin {
  dir: string;
}

/** First-party plugins to bundle. Add entries here to ship more plugins. */
const PLUGINS: BundledPlugin[] = [
  {dir: 'examples/plugins/ledger'},
];

// The signing key: the OPENBOOK_REGISTRY_PRIVATE_KEY env var (production/CI
// release) or the committed TEST-ONLY key. Loud about which, so build logs
// always show the provenance the bundle will carry.
const signingKey = resolveSigningKey();
if (signingKey.source === 'test') {
  console.warn(
    '[bundlePlugins] OPENBOOK_REGISTRY_PRIVATE_KEY is unset — signing with the committed TEST-ONLY key ' +
      '(scripts/test-registry-key.json). Fine for dev/test; production builds must set the secret (docs/plugin-signing.md).',
  );
} else if (!OPENBOOK_REGISTRY_KEYS.some((k) => k.publicKey === signingKey.publicKey)) {
  console.warn(
    `[bundlePlugins] signing with an env key whose public half (${signingKey.publicKey}) matches NO pinned ` +
      'OPENBOOK_REGISTRY_KEYS entry — installs will show Unverified unless clients trust it. Expected during rotation ' +
      'overlap or local throwaway-key testing; wrong for a production release.',
  );
}

const emittedSignatures: Array<{id: string; registry: string; publicKey: string}> = [];

let out = `/* eslint-disable */
/**
 * AUTO-GENERATED by scripts/bundlePlugins.ts — do not edit by hand.
 * Re-generate: \`pnpm run gen:bundled-plugins\`
 *
 * Signed by: ${signingKey.registry} (${signingKey.source === 'test' ? 'TEST-ONLY key — not trusted by default' : 'key from OPENBOOK_REGISTRY_PRIVATE_KEY'})
 */
import type {PluginPackage} from '@book.dev/sdk';

`;

for (const plugin of PLUGINS) {
  const pluginDir = resolve(ROOT, plugin.dir);
  const manifestPath = join(pluginDir, 'openbook.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  const id: string = manifest.id;

  // Collect source files (ts/tsx/js/jsx/json, excluding openbook.json itself)
  const allFiles = walk(pluginDir, pluginDir).filter(
    (f) => !f.startsWith('.') && !f.startsWith('__') && /\.(ts|tsx|js|jsx|json)$/.test(f),
  );

  const filesRecord: Record<string, string> = {};
  for (const f of allFiles.sort()) {
    if (f === 'openbook.json') continue; // manifest is separate
    filesRecord[f] = readFileSync(join(pluginDir, f), 'utf-8');
  }

  // Validate the entry file exists
  if (!(manifest.main in filesRecord)) {
    throw new Error(`entry file "${manifest.main}" not found in ${plugin.dir}`);
  }

  // Drift guard for the manifest's `blocks` declaration (PluginManifest.blocks
  // — what the server's/agent's `list_block_types` enumerates without running
  // plugin code): the declared types must EXACTLY match the `blocks.register`
  // calls in the plugin source. A bundled plugin whose manifest lies about its
  // blocks fails the build here instead of drifting silently.
  const registered = new Set<string>();
  for (const content of Object.values(filesRecord)) {
    for (const m of content.matchAll(/blocks\.register\(\{\s*type:\s*'([^']+)'/g)) registered.add(m[1]);
  }
  const declared = new Set<string>(((manifest.blocks ?? []) as Array<{type: string}>).map((b) => b.type));
  const missing = [...registered].filter((t) => !declared.has(t));
  const stale = [...declared].filter((t) => !registered.has(t));
  if (missing.length || stale.length) {
    throw new Error(
      `${plugin.dir}: openbook.json "blocks" drifted from the source's blocks.register calls` +
        `${missing.length ? ` — undeclared: ${missing.join(', ')}` : ''}` +
        `${stale.length ? ` — declared but never registered: ${stale.join(', ')}` : ''}`,
    );
  }

  // Sign the exact package literal being emitted — registry provenance for
  // the auto-installed first-party plugins (verified per sync in host.ts).
  const signature = await signBundledPackage({manifest, files: filesRecord}, signingKey);
  emittedSignatures.push({id, registry: signature.registry, publicKey: signature.publicKey});

  const varName = id.replace(/[^a-zA-Z0-9]/g, '_');
  out += `export const ${varName}: PluginPackage = {\n`;
  out += `  manifest: ${JSON.stringify(manifest, null, 2).replace(/\n/g, '\n  ')},\n`;
  out += '  files: {\n';
  for (const [path, content] of Object.entries(filesRecord)) {
    // Use JSON.stringify for safe escaping of the source text
    out += `    ${JSON.stringify(path)}: ${JSON.stringify(content)},\n`;
  }
  out += '  },\n';
  out += `  signature: ${JSON.stringify(signature, null, 2).replace(/\n/g, '\n  ')},\n`;
  out += '};\n\n';
}

out += '/** Every first-party plugin the app ships with. */\n';
out += 'export const BUNDLED_PLUGINS: PluginPackage[] = [\n';
for (const plugin of PLUGINS) {
  const pluginDir = resolve(ROOT, plugin.dir);
  const manifest = JSON.parse(readFileSync(join(pluginDir, 'openbook.json'), 'utf-8'));
  const varName = (manifest.id as string).replace(/[^a-zA-Z0-9]/g, '_');
  out += `  ${varName},\n`;
}
out += '];\n';

writeFileSync(OUT, out);
writeFileSync(SIG_OUT, `${JSON.stringify(emittedSignatures, null, 2)}\n`);
console.log(
  `wrote ${relative(process.cwd(), OUT)} (${PLUGINS.length} plugin(s), signed by ${signingKey.registry} [${signingKey.source}])`,
);

// ── Ledger fold mirror (LX-3) ────────────────────────────────────────────────
// Compilable copies of the PURE fold modules, so the export renderer can call
// the exact arithmetic the in-app report blocks use. Purity is enforced here:
// a mirrored module may import only `@book.dev/plugin-sdk` (rewritten to the
// host `@book.dev/sdk`) or a sibling fold module — anything else (React, the
// block components, host APIs) fails the build loudly rather than silently
// dragging the plugin runtime into the export bundle. The specifiers come
// from the TypeScript AST (moduleSpecifiers), so side-effect imports, dynamic
// import()/require() and both quote styles are all caught — "any
// non-sanctioned import fails the build" is airtight, not regex-deep.
mkdirSync(FOLDS_OUT_DIR, {recursive: true});
for (const file of LEDGER_FOLD_MODULES) {
  const srcPath = resolve(ROOT, 'examples/plugins/ledger/src', file);
  const source = readFileSync(srcPath, 'utf-8');
  const siblingNames = LEDGER_FOLD_MODULES.map((f) => f.replace(/\.ts$/, ''));
  for (const spec of moduleSpecifiers(file, source)) {
    const ok = spec === '@book.dev/plugin-sdk' || siblingNames.some((s) => spec === `./${s}`);
    if (!ok) throw new Error(`ledger fold mirror: ${file} imports ${spec} — not a pure fold module`);
  }
  const rewritten = source.replace(/from '@book\.dev\/plugin-sdk'/g, 'from \'@book.dev/sdk\'');
  const header =
    '/* eslint-disable */\n' +
    '/**\n' +
    ' * AUTO-GENERATED by scripts/bundlePlugins.ts — do not edit by hand.\n' +
    ` * Mirror of examples/plugins/ledger/src/${file} (the pure report folds),\n` +
    ' * with \'@book.dev/plugin-sdk\' rewritten to \'@book.dev/sdk\'.\n' +
    ' * Re-generate: `pnpm run gen:bundled-plugins`\n' +
    ' */\n';
  writeFileSync(join(FOLDS_OUT_DIR, file), header + rewritten);
}
console.log(`wrote ${relative(process.cwd(), FOLDS_OUT_DIR)} (${LEDGER_FOLD_MODULES.length} fold module(s))`);
