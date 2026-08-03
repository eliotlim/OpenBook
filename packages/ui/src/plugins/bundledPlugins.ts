import type {PluginPackage} from '@book.dev/sdk';

/**
 * Metadata about a first-party plugin that ships with the app. The bundled-
 * plugins infrastructure (a parallel task) will populate the full
 * {@link PluginPackage} for each entry; for now this carries just the display
 * info the install-prompt needs.
 */
export interface BundledPluginInfo {
  /** Plugin ID (reverse-DNS-ish), e.g. `openbook.ledger`. */
  id: string;
  /** Human-readable name shown in the install prompt. */
  name: string;
  /** Short description of what the plugin provides. */
  description: string;
  /** Emoji icon for the prompt card. */
  icon?: string;
  /**
   * The installable package. When the bundled-plugins task lands this will be
   * a real {@link PluginPackage}; until then it's undefined and the UI shows
   * an informational message instead of an Install button.
   */
  package?: PluginPackage;
}

/**
 * Registry of first-party plugins that ship with the app. Keyed by plugin ID.
 * The bundled-plugins task will populate `.package` for each entry so the
 * install-prompt can call `client.installPlugin(pkg)`.
 */
const bundledPlugins: Record<string, BundledPluginInfo> = {
  'openbook.ledger': {
    id: 'openbook.ledger',
    name: 'Ledger',
    description: 'Trustworthy double-entry books — journals, accounts, and financial reports.',
    icon: '📗',
  },
};

/** Look up a bundled (first-party) plugin by ID. */
export function getBundledPlugin(id: string): BundledPluginInfo | undefined {
  return bundledPlugins[id];
}
