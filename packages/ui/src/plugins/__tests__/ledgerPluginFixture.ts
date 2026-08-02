// The REAL first-party ledger plugin, byte-for-byte (vite `?raw`): every test
// that touches the plugin runs the SHIPPED sources through the real loader,
// never a copy.
import ledgerManifestJson from '../../../../../examples/plugins/ledger/openbook.json?raw';
import type {DataClient, PluginManifest, StoredPlugin} from '@book.dev/sdk';
import {executePlugin} from '../loader';
import {buildPluginApi, hostModulesFor, type PluginApi} from '../api';

/**
 * Every source module the ledger plugin is made of, DERIVED — never listed.
 *
 * `src/index.ts` imports every module, so a package that misses one fails to
 * ACTIVATE, and the failure surfaces as unrelated red tests wherever the plugin
 * happens to be loaded. A hand-maintained map made that a standing trap: adding
 * a module and forgetting the map is a silent desynchronisation. The glob is
 * resolved at build time by Vite, so this cannot drift from the package again —
 * exactly as the e2e side walks the directory from disk (`web/e2e/ledgerPlugin.ts`).
 */
const ledgerSources = import.meta.glob('../../../../../examples/plugins/ledger/src/**/*.{ts,tsx}', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

export const LEDGER_PLUGIN_FILES: Record<string, string> = Object.fromEntries(
  // Glob keys are relative to THIS file; the plugin wants them relative to its
  // own root, so keep everything from `src/` onwards.
  Object.entries(ledgerSources).map(([path, source]) => [`src/${path.split('/src/').pop() ?? ''}`, source]),
);

/**
 * The manifest's RAW text. Exported because it is stored as JSONB alongside the
 * sources and fails install identically on a stray control character — the glob
 * above only covers `src/**`, so the manifest needs naming to be checked at all.
 */
export const ledgerManifestSource = ledgerManifestJson;

export const ledgerManifest = JSON.parse(ledgerManifestJson) as PluginManifest;

export const storedLedgerPlugin = (): StoredPlugin => ({
  manifest: ledgerManifest,
  files: LEDGER_PLUGIN_FILES,
  enabled: true,
  installedAt: new Date(0).toISOString(),
});

/** The plugin's module exports, loaded through the REAL loader + host modules. */
export function loadLedgerPlugin(client: DataClient = {} as DataClient, track: (d: () => void) => void = () => {}): {
  exports: Record<string, unknown>;
  api: PluginApi;
} {
  const api = buildPluginApi({id: ledgerManifest.id, name: ledgerManifest.name, version: ledgerManifest.version}, client, track);
  const exports = executePlugin({manifest: ledgerManifest, files: LEDGER_PLUGIN_FILES}, hostModulesFor(api));
  return {exports, api};
}
