import React, {useCallback, useEffect, useState} from 'react';
import {BadgeCheck, Building2, Download, Puzzle, ShieldAlert, ShieldCheck} from 'lucide-react';
import type {VerifiedDownload} from '@book.dev/sdk';
import {useOptionalData} from '@/data';
import {
  getBundledPlugin,
  installVerified,
  listPluginStores,
  resolvePlugin,
  syncPlugins,
  verifyFromStore,
  type StoreResolution,
} from '@/plugins';
import {describeUnknownBlock} from './unknownBlock';

/**
 * Displayed when a block's type is `{pluginId}/{blockName}` but the plugin
 * isn't installed — instead of the bare "Unsupported block" text, the user
 * sees the plugin name and an Install button. Bundled first-party plugins
 * install in one click (they shipped with this build). Anything else is
 * resolved against the user's pinned stores (OB-641) and installs in two
 * explicit steps: verify (download + offline signature checks, outcome
 * DISPLAYED as a trust badge) → install (the user's consent). No plugin code
 * executes before both.
 *
 * Renders WITHOUT a {@link DataProvider} too (`useOptionalData`): the vendored
 * viewer that hydrates an exported page has no data client, and a throw here
 * would take down the whole viewer mount — the reader would silently lose every
 * live widget on the page, not just this block. Provider-less, the card is
 * informational: there is nothing to install into, so store resolution and
 * both install steps are gated on a live client.
 */
export const MissingPluginBlock: React.FC<{type: string}> = ({type}) => {
  const client = useOptionalData();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resolution, setResolution] = useState<StoreResolution | null>(null);
  const [resolving, setResolving] = useState(false);
  const [verified, setVerified] = useState<VerifiedDownload | null>(null);

  // Parse `pluginId/blockName` from the block type (shared with the exporters).
  const {pluginId, blockName, label} = describeUnknownBlock(type);

  const bundled = pluginId ? getBundledPlugin(pluginId) : undefined;

  // Not bundled → try the pinned stores (if any). Resolution is metadata-only:
  // nothing is downloaded, verified, or executed here. Provider-less (the
  // exported page's viewer) there is nowhere to install to, so don't resolve.
  useEffect(() => {
    if (!client || !pluginId || bundled || listPluginStores().length === 0) return;
    let stale = false;
    setResolving(true);
    resolvePlugin(pluginId)
      .then((res) => {
        if (!stale) setResolution(res);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!stale) setResolving(false);
      });
    return () => {
      stale = true;
    };
  }, [client, pluginId, bundled]);

  const displayName = bundled?.name ?? resolution?.entry.name ?? pluginId ?? type;

  const installBundled = useCallback(async () => {
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

  /** Step 1 — download + verify; the trust outcome renders before any consent. */
  const verify = useCallback(async () => {
    if (!resolution) return;
    setBusy(true);
    setError(null);
    try {
      setVerified(await verifyFromStore(resolution));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [resolution]);

  /** Step 2 — the user consented to the displayed outcome; install and load. */
  const install = useCallback(async () => {
    if (!verified || !client) return;
    setBusy(true);
    setError(null);
    try {
      await installVerified(client, verified);
      await syncPlugins(client);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [client, verified]);

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
        {bundled?.icon ?? resolution?.entry.icon ?? <Puzzle className="h-5 w-5" />}
      </span>
      <div className="obe-missing-plugin-body">
        {/* Lead with the block name, like the static HTML and Markdown exports
            do — then the plugin requirement, then the technical id. */}
        <p className="obe-missing-plugin-title">
          <strong>{label}</strong>
        </p>
        <p className="obe-missing-plugin-title">
          Requires the <strong>{displayName}</strong> plugin
        </p>
        <p className="obe-missing-plugin-meta">
          {pluginId}
          {blockName ? ` / ${blockName}` : ''}
          {resolution?.entry.publisher ? ` · by ${resolution.entry.publisher}` : ''}
          {resolution ? ` · v${resolution.entry.latestVersion} via ${resolution.store.name}` : ''}
        </p>
        {verified && (
          <p className="obe-missing-plugin-trust" data-missing-plugin-trust>
            <span className="obe-missing-plugin-badge" data-trust-signed>
              <BadgeCheck className="h-3 w-3" /> Publisher-signed
            </span>
            {verified.trust.firstParty && (
              <span className="obe-missing-plugin-badge" data-trust-first-party>
                <Building2 className="h-3 w-3" /> First-party
              </span>
            )}
            {verified.trust.notarised && (
              <span className="obe-missing-plugin-badge" data-trust-notarised>
                <ShieldCheck className="h-3 w-3" /> Notarised by {resolution?.store.name}
              </span>
            )}
            {!verified.trust.notarised && !verified.trust.firstParty && (
              <span className="obe-missing-plugin-badge obe-missing-plugin-badge-warn" data-trust-unreviewed>
                <ShieldAlert className="h-3 w-3" /> Not reviewed by the store — it runs with the same access as your own live code
              </span>
            )}
          </p>
        )}
        {error && <p className="obe-missing-plugin-error">{error}</p>}
      </div>
      {bundled && client ? (
        <button type="button" className="obe-missing-plugin-install" disabled={busy} onClick={() => void installBundled()}>
          <Download className="h-3.5 w-3.5" />
          {busy ? 'Installing…' : 'Install'}
        </button>
      ) : verified ? (
        <button type="button" className="obe-missing-plugin-install" disabled={busy} onClick={() => void install()} data-missing-plugin-install>
          <Download className="h-3.5 w-3.5" />
          {busy ? 'Installing…' : 'Install now'}
        </button>
      ) : resolution ? (
        <button type="button" className="obe-missing-plugin-install" disabled={busy} onClick={() => void verify()} data-missing-plugin-verify>
          <ShieldCheck className="h-3.5 w-3.5" />
          {busy ? 'Verifying…' : 'Verify & install'}
        </button>
      ) : (
        <span className="obe-missing-plugin-hint">
          {/* No client (the exported page's viewer) — there is nowhere to install to. */}
          {!client
            ? bundled
              ? 'Open in OpenBook to install'
              : 'Plugin not available'
            : resolving
              ? 'Checking your stores…'
              : 'Plugin not available'}
        </span>
      )}
    </div>
  );
};
