import React, {useCallback, useState} from 'react';
import {Download, Puzzle} from 'lucide-react';
import {useData} from '@/data';
import {getBundledPlugin, syncPlugins} from '@/plugins';

/**
 * Displayed when a block's type is `{pluginId}/{blockName}` but the plugin
 * isn't installed — instead of the bare "Unsupported block" text, the user
 * sees the plugin name and an Install button (for bundled/available plugins)
 * or an informational fallback.
 */
export const MissingPluginBlock: React.FC<{type: string}> = ({type}) => {
  const client = useData();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Parse `pluginId/blockName` from the block type.
  const slashIdx = type.indexOf('/');
  const pluginId = slashIdx > 0 ? type.slice(0, slashIdx) : null;
  const blockName = slashIdx > 0 ? type.slice(slashIdx + 1) : null;

  const bundled = pluginId ? getBundledPlugin(pluginId) : undefined;
  const displayName = bundled?.name ?? pluginId ?? type;

  const install = useCallback(async () => {
    if (!bundled?.package) return;
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
    <div className="obe-missing-plugin" contentEditable={false}>
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
      {bundled?.package ? (
        <button
          type="button"
          className="obe-missing-plugin-install"
          disabled={busy}
          onClick={install}
        >
          <Download className="h-3.5 w-3.5" />
          {busy ? 'Installing…' : 'Install'}
        </button>
      ) : bundled ? (
        <span className="obe-missing-plugin-hint">
          Available soon
        </span>
      ) : (
        <span className="obe-missing-plugin-hint">
          Plugin not available
        </span>
      )}
    </div>
  );
};
