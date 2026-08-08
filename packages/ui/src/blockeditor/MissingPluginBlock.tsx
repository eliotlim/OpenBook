import React, {useCallback, useState} from 'react';
import {Download, Puzzle} from 'lucide-react';
import {useOptionalData} from '@/data';
import {getBundledPlugin, syncPlugins} from '@/plugins';
import {describeUnknownBlock} from './unknownBlock';

/**
 * Displayed when a block's type is `{pluginId}/{blockName}` but the plugin
 * isn't installed — instead of the bare "Unsupported block" text, the user
 * sees the plugin name and an Install button (for bundled/available plugins)
 * or an informational fallback.
 *
 * Renders WITHOUT a {@link DataProvider} too (`useOptionalData`): the vendored
 * viewer that hydrates an exported page has no data client, and a throw here
 * would take down the whole viewer mount — the reader would silently lose every
 * live widget on the page, not just this block. Provider-less, the card is
 * informational: there is nothing to install into.
 */
export const MissingPluginBlock: React.FC<{type: string}> = ({type}) => {
  const client = useOptionalData();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Parse `pluginId/blockName` from the block type (shared with the exporters).
  const {pluginId, blockName} = describeUnknownBlock(type);

  const bundled = pluginId ? getBundledPlugin(pluginId) : undefined;
  const displayName = bundled?.name ?? pluginId ?? type;

  const install = useCallback(async () => {
    if (!bundled || !client) return;
    setBusy(true);
    setError(null);
    try {
      await client.installPlugin(bundled.package);
      await syncPlugins(client);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [client, bundled]);

  // No `/` — not a plugin-contributed type; show a plain unknown-block fallback.
  if (!pluginId) {
    return (
      <div className="obe-unknown" contentEditable={false}>
        Unsupported block &ldquo;{type}&rdquo;
      </div>
    );
  }

  return (
    <div className="obe-missing-plugin" contentEditable={false} data-block-type={type}>
      <span className="obe-missing-plugin-icon" aria-hidden>
        {bundled?.icon ?? <Puzzle className="h-5 w-5" />}
      </span>
      <div className="obe-missing-plugin-body">
        <p className="obe-missing-plugin-title">
          This block requires the <strong>{displayName}</strong> plugin
        </p>
        <p className="obe-missing-plugin-meta">
          {pluginId}{blockName ? ` / ${blockName}` : ''}
        </p>
        {error && (
          <p className="obe-missing-plugin-error">{error}</p>
        )}
      </div>
      {bundled && client ? (
        <button
          type="button"
          className="obe-missing-plugin-install"
          disabled={busy}
          onClick={install}
        >
          <Download className="h-3.5 w-3.5" />
          {busy ? 'Installing…' : 'Install'}
        </button>
      ) : (
        <span className="obe-missing-plugin-hint">
          {/* No client (the exported page's viewer) — there is nowhere to install to. */}
          {bundled ? 'Open in OpenBook to install' : 'Plugin not available'}
        </span>
      )}
    </div>
  );
};
