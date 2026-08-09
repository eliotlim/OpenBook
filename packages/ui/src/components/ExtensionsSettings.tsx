import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {ArrowUpCircle, BadgeCheck, Ban, Building2, KeyRound, Puzzle, Search, ShieldAlert, ShieldCheck, Store, Trash2, TriangleAlert, Upload, X} from 'lucide-react';
import {
  OPENBOOK_REGISTRY_KEYS,
  compareSemver,
  fetchRegistryDocument,
  isSemver,
  registryKeyFingerprint,
  type RegistryDocument,
} from '@book.dev/sdk';
import {SettingsScreen, SettingsSection} from '@/components/settings/primitives';
import {Button} from '@/components/ui/button';
import {Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle} from '@/components/ui/dialog';
import {Input} from '@/components/ui/input';
import {Switch} from '@/components/ui/switch';
import {useData} from '@/data';
import {useTranslation} from '@/providers';
import {
  addPluginStore,
  addTrustedRegistry,
  browseStores,
  dismissBundledPlugin,
  installVerified,
  isBundledPlugin,
  listPluginStores,
  parsePluginZip,
  pluginStatuses,
  refreshRevocations,
  registryEntryPinnedKeys,
  removePluginStore,
  removeTrustedRegistry,
  revocationFeedStatus,
  reloadPlugin,
  subscribePlugins,
  syncPlugins,
  storeProvenanceChanged,
  trustedRegistryKeys,
  verifyFromStore,
  type PluginStatus,
  type StoreResolution,
  type VerifiedStoreDownload,
} from '@/plugins';
import {cn} from '@/lib/utils';

/**
 * Settings → Extensions: the library's installed plugins. Install from a
 * zip of TypeScript source; each card shows provenance (verified by a
 * trusted registry / unverified) and activation state, with enable and
 * remove always one click away — VS Code's extension list, OpenBook's skin.
 */
export default function ExtensionsSettings() {
  const client = useData();
  const {t} = useTranslation();
  const [statuses, setStatuses] = useState<PluginStatus[]>(pluginStatuses());
  const [installError, setInstallError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [catalogue, setCatalogue] = useState<StoreResolution[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);

  // id → the store row offering a strictly newer semver than what's installed.
  const updates = useMemo(() => {
    const map = new Map<string, StoreResolution>();
    for (const status of statuses) {
      const {id, version} = status.plugin.manifest;
      const offer = catalogue.find((r) => r.entry.id === id);
      if (offer && isSemver(offer.entry.latestVersion) && isSemver(version) && compareSemver(offer.entry.latestVersion, version) > 0) {
        map.set(id, offer);
      }
    }
    return map;
  }, [statuses, catalogue]);

  useEffect(() => {
    const unsub = subscribePlugins(() => setStatuses(pluginStatuses()));
    void syncPlugins(client).catch(() => undefined);
    return unsub;
  }, [client]);

  const install = useCallback(
    async (file: File) => {
      setInstallError(null);
      setBusy(true);
      try {
        const pkg = parsePluginZip(new Uint8Array(await file.arrayBuffer()));
        await client.installPlugin(pkg);
        await reloadPlugin(pkg.manifest.id, client);
      } catch (err) {
        setInstallError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [client],
  );

  const setEnabled = useCallback(
    async (id: string, enabled: boolean) => {
      await client.setPluginEnabled(id, enabled);
      await syncPlugins(client);
    },
    [client],
  );

  const remove = useCallback(
    async (id: string) => {
      if (isBundledPlugin(id)) dismissBundledPlugin(id);
      await client.removePlugin(id);
      await syncPlugins(client);
    },
    [client],
  );

  return (
    <SettingsScreen title={t('settings.tab.extensions')} description={t('extensions.description')} scope="library">
      <SettingsSection>
        <div className="flex items-center gap-3">
          <input
            ref={fileRef}
            type="file"
            accept=".zip"
            className="hidden"
            data-extension-file
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void install(file);
              e.target.value = '';
            }}
          />
          <Button size="sm" disabled={busy} onClick={() => fileRef.current?.click()}>
            <Upload className="h-3.5 w-3.5" />
            {busy ? t('extensions.installing') : t('extensions.install')}
          </Button>
          <span className="text-xs text-muted-foreground">{t('extensions.installHint')}</span>
        </div>
        {installError && (
          <p className="rounded-md border border-destructive/40 px-3 py-2 text-xs text-destructive" data-extension-error>
            {installError}
          </p>
        )}
      </SettingsSection>

      <SettingsSection>
        {statuses.length === 0 && (
          <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border py-10 text-center">
            <Puzzle className="h-6 w-6 text-muted-foreground/50" />
            <p className="text-sm text-muted-foreground">{t('extensions.empty')}</p>
            <p className="max-w-sm text-xs text-muted-foreground/70">{t('extensions.emptyHint')}</p>
          </div>
        )}
        <div className="flex flex-col gap-2">
          {statuses.map((status) => (
            <ExtensionCard
              key={status.plugin.manifest.id}
              status={status}
              updateTo={updates.get(status.plugin.manifest.id)?.entry.latestVersion}
              onEnabled={setEnabled}
              onRemove={remove}
            />
          ))}
        </div>
      </SettingsSection>

      <StoreSection statuses={statuses} updates={updates} onCatalogue={setCatalogue} />

      <TrustedRegistries />

      <p className="text-xs text-muted-foreground/70">{t('extensions.trustNote')}</p>
    </SettingsScreen>
  );
}

/**
 * The store browse/install surface (OB-641). A store is pinned by
 * `(baseUrl, keys)` after the user confirms its key fingerprints against a
 * source that is not this fetch (PROTOCOL.md §6.2). Every install goes
 * download → offline verification → a consent dialog that shows the
 * verification outcome — no plugin code executes before both have happened.
 */
const StoreSection: React.FC<{
  statuses: PluginStatus[];
  updates: Map<string, StoreResolution>;
  onCatalogue: (rows: StoreResolution[]) => void;
}> = ({statuses, updates, onCatalogue}) => {
  const client = useData();
  const {t} = useTranslation();
  const [stores, setStores] = useState(() => listPluginStores());
  const [url, setUrl] = useState('');
  const [connectError, setConnectError] = useState<string | null>(null);
  const [pending, setPending] = useState<{doc: RegistryDocument; baseUrl: string; notaryFp: string | null; registryFp: string | null} | null>(null);
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState<StoreResolution[]>([]);
  const [browsing, setBrowsing] = useState(false);
  const [rowError, setRowError] = useState<string | null>(null);
  const [, setRevocationRevision] = useState(0);
  // The verify→consent pipeline: `verifying` while the download is checked,
  // then the outcome (or failure) is DISPLAYED and installing waits for an
  // explicit click. Nothing is installed or executed before that.
  const [confirm, setConfirm] = useState<{resolution: StoreResolution; download: VerifiedStoreDownload | null; error: string | null; installing: boolean} | null>(null);

  const browse = useCallback(
    async (q: string) => {
      if (listPluginStores().length === 0) {
        setRows([]);
        onCatalogue([]);
        return;
      }
      setBrowsing(true);
      setRowError(null);
      try {
        const found = await browseStores(q.trim() || undefined);
        setRows(found);
        // The unfiltered walk doubles as the update-check catalogue.
        if (!q.trim()) onCatalogue(found);
      } catch (err) {
        setRowError(err instanceof Error ? err.message : String(err));
      } finally {
        setBrowsing(false);
      }
    },
    [onCatalogue],
  );

  useEffect(() => {
    void browse('');
  }, [browse, stores]);

  useEffect(() => {
    let active = true;
    const refresh = async (): Promise<void> => {
      await refreshRevocations();
      if (active) setRevocationRevision((revision) => revision + 1);
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 60_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [stores]);

  const connect = useCallback(async () => {
    const baseUrl = url.trim().replace(/\/$/, '');
    if (!baseUrl) return;
    setConnectError(null);
    try {
      const doc = await fetchRegistryDocument(baseUrl);
      setPending({
        doc,
        baseUrl,
        notaryFp: doc.notaryPublicKey ? await registryKeyFingerprint(doc.notaryPublicKey) : null,
        registryFp: doc.registryPublicKey ? await registryKeyFingerprint(doc.registryPublicKey) : null,
      });
    } catch (err) {
      setConnectError(err instanceof Error ? err.message : String(err));
    }
  }, [url]);

  const pin = useCallback(() => {
    if (!pending) return;
    addPluginStore({
      name: pending.doc.name,
      baseUrl: pending.baseUrl,
      notaryPublicKey: pending.doc.notaryPublicKey,
      registryPublicKey: pending.doc.registryPublicKey,
    });
    setPending(null);
    setUrl('');
    setStores(listPluginStores());
  }, [pending]);

  const removeStore = useCallback((baseUrl: string) => {
    removePluginStore(baseUrl);
    setStores(listPluginStores());
  }, []);

  /** Step 1: download + verify; the dialog then shows the outcome. */
  const beginInstall = useCallback((resolution: StoreResolution) => {
    setConfirm({resolution, download: null, error: null, installing: false});
    void (async () => {
      try {
        const download = await verifyFromStore(resolution);
        setConfirm((c) => (c && c.resolution === resolution ? {...c, download} : c));
      } catch (err) {
        setConfirm((c) => (c && c.resolution === resolution ? {...c, error: err instanceof Error ? err.message : String(err)} : c));
      }
    })();
  }, []);

  /** Step 2: the user consented to the displayed outcome — install now. */
  const confirmInstall = useCallback(async () => {
    if (!confirm?.download) return;
    setConfirm({...confirm, installing: true});
    try {
      await installVerified(client, confirm.download);
      await reloadPlugin(confirm.download.pkg.manifest.id, client);
      setConfirm(null);
    } catch (err) {
      setConfirm((c) => (c ? {...c, installing: false, error: err instanceof Error ? err.message : String(err)} : c));
    }
  }, [client, confirm]);

  const installedVersion = useCallback(
    (id: string): string | undefined => statuses.find((s) => s.plugin.manifest.id === id)?.plugin.manifest.version,
    [statuses],
  );

  return (
    <SettingsSection title={t('extensions.store')} description={t('extensions.storeHint')}>
      {stores.length > 0 && (
        <div className="flex flex-col gap-1.5">
          {stores.map((store) => (
            <div key={store.baseUrl} data-store={store.baseUrl} className="flex items-center gap-3 rounded-md border border-border px-3 py-2">
              <Store className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <span className="text-sm font-medium">{store.name}</span>
                <p className="truncate font-mono text-[11px] text-muted-foreground/70">{store.baseUrl}</p>
                {revocationFeedStatus(store.baseUrl).state !== 'fresh' && (
                  <p className="mt-0.5 flex items-center gap-1 text-[11px] text-amber-700 dark:text-amber-300" data-store-revocations-stale>
                    <TriangleAlert className="h-3 w-3" />
                    {t('extensions.storeRevocationsStale')}
                  </p>
                )}
              </div>
              <Button
                size="icon"
                variant="ghost"
                className="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive"
                aria-label={t('extensions.storeRemove', {name: store.name})}
                onClick={() => removeStore(store.baseUrl)}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          ))}
        </div>
      )}

      <form
        className="flex flex-wrap items-start gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void connect();
        }}
      >
        <Input
          value={url}
          onChange={(e) => {
            setUrl(e.target.value);
            setConnectError(null);
          }}
          placeholder={t('extensions.storeUrl')}
          aria-label={t('extensions.storeUrl')}
          data-store-url
          className="h-8 min-w-64 flex-1 font-mono text-xs"
        />
        <Button type="submit" size="sm" variant="outline" disabled={!url.trim()} data-store-connect>
          {t('extensions.storeConnect')}
        </Button>
      </form>
      {connectError && (
        <p className="rounded-md border border-destructive/40 px-3 py-2 text-xs text-destructive" data-store-connect-error>
          {t('extensions.storeConnectError', {error: connectError})}
        </p>
      )}

      {pending && (
        <div className="flex flex-col gap-2 rounded-md border border-border bg-accent/30 px-3 py-2.5" data-store-pin-prompt>
          <p className="text-sm font-medium">{t('extensions.storePinTitle')}</p>
          <p className="text-xs text-muted-foreground">
            {pending.doc.name} · <span className="font-mono">{pending.baseUrl}</span>
          </p>
          <div className="flex flex-col gap-0.5 font-mono text-[11px] text-muted-foreground/80">
            <span>
              {t('extensions.storeNotaryFp')}: {pending.notaryFp ?? t('extensions.storeNoKey')}
            </span>
            <span>
              {t('extensions.storeRegistryFp')}: {pending.registryFp ?? t('extensions.storeNoKey')}
            </span>
          </div>
          <p className="text-xs text-muted-foreground">{t('extensions.storePinHint')}</p>
          <div className="flex gap-2">
            <Button size="sm" onClick={pin} data-store-pin>
              {t('extensions.storePin')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setPending(null)}>
              {t('common.cancel')}
            </Button>
          </div>
        </div>
      )}

      {stores.length > 0 && (
        <>
          <form
            className="flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void browse(query);
            }}
          >
            <div className="relative min-w-0 flex-1">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/60" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t('extensions.storeSearch')}
                aria-label={t('extensions.storeSearch')}
                data-store-search
                className="h-8 pl-8 text-sm"
              />
            </div>
            <Button type="submit" size="sm" variant="outline" disabled={browsing} data-store-browse>
              {t('extensions.storeBrowse')}
            </Button>
          </form>
          {rowError && (
            <p className="rounded-md border border-destructive/40 px-3 py-2 text-xs text-destructive" data-store-error>
              {t('extensions.storeError', {error: rowError})}
            </p>
          )}
          {rows.length === 0 && !browsing && <p className="text-xs text-muted-foreground">{t('extensions.storeEmpty')}</p>}
          <div className="flex flex-col gap-1.5">
            {rows.map((row) => {
              const installed = installedVersion(row.entry.id);
              const update = updates.get(row.entry.id);
              const claimsFirstParty = !!row.store.registryPublicKey && registryEntryPinnedKeys(row.entry).includes(row.store.registryPublicKey);
              return (
                <div key={`${row.store.baseUrl}:${row.entry.id}`} data-store-result={row.entry.id} className="flex items-start gap-3 rounded-md border border-border px-3 py-2">
                  <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-accent/50 text-lg" aria-hidden>
                    {row.entry.icon || '🧩'}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                      <span className="text-sm font-semibold">{row.entry.name}</span>
                      <span className="text-xs text-muted-foreground">v{row.entry.latestVersion}</span>
                      {claimsFirstParty && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-blue-500/10 px-2 py-0.5 text-[11px] font-medium text-blue-700 dark:text-blue-300" data-store-badge-first-party>
                          <Building2 className="h-3 w-3" />
                          {t('extensions.storeClaimsFirstParty')}
                        </span>
                      )}
                    </div>
                    {row.entry.description && <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{row.entry.description}</p>}
                    <p className="mt-0.5 text-[11px] text-muted-foreground/70">
                      {row.entry.id}
                      {row.entry.publisher ? ` · ${t('extensions.storeBy', {publisher: row.entry.publisher})}` : ''} · {t('extensions.storeVia', {store: row.store.name})}
                    </p>
                  </div>
                  <div className="shrink-0">
                    {update ? (
                      <Button size="sm" variant="outline" onClick={() => beginInstall(update)} data-store-update>
                        <ArrowUpCircle className="h-3.5 w-3.5" />
                        {t('extensions.storeUpdate', {version: update.entry.latestVersion})}
                      </Button>
                    ) : installed ? (
                      <span className="text-xs text-muted-foreground" data-store-installed>
                        {t('extensions.storeInstalled')}
                      </span>
                    ) : (
                      <Button size="sm" onClick={() => beginInstall(row)} data-store-install>
                        {t('extensions.storeInstall')}
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

      <Dialog open={confirm !== null} onOpenChange={(open) => !open && !confirm?.installing && setConfirm(null)}>
        <DialogContent data-store-confirm>
          {confirm && (
            <>
              <DialogHeader>
                <DialogTitle>
                  {t('extensions.storeConfirmTitle', {name: confirm.resolution.entry.name, version: confirm.resolution.entry.latestVersion})}
                </DialogTitle>
                <DialogDescription>
                  {confirm.resolution.entry.id}
                  {confirm.resolution.entry.publisher ? ` · ${t('extensions.storeBy', {publisher: confirm.resolution.entry.publisher})}` : ''} ·{' '}
                  {t('extensions.storeVia', {store: confirm.resolution.store.name})}
                </DialogDescription>
              </DialogHeader>
              {confirm.error ? (
                <p className="rounded-md border border-destructive/40 px-3 py-2 text-xs text-destructive" data-store-confirm-error>
                  {t('extensions.storeError', {error: confirm.error})}
                </p>
              ) : !confirm.download ? (
                <p className="text-sm text-muted-foreground" data-store-verifying>
                  {t('extensions.storeVerifying')}
                </p>
              ) : (
                <div className="flex flex-col gap-2" data-store-trust>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="inline-flex items-center gap-1 rounded-full bg-green-500/10 px-2 py-0.5 text-[11px] font-medium text-green-700 dark:text-green-300" data-store-badge-signed>
                      <BadgeCheck className="h-3 w-3" />
                      {t('extensions.storePublisherSigned')}
                    </span>
                    {confirm.download.trust.firstParty && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-blue-500/10 px-2 py-0.5 text-[11px] font-medium text-blue-700 dark:text-blue-300" data-store-badge-first-party>
                        <Building2 className="h-3 w-3" />
                        {t('extensions.storeFirstParty')}
                      </span>
                    )}
                    {confirm.download.trust.notarised && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-green-500/10 px-2 py-0.5 text-[11px] font-medium text-green-700 dark:text-green-300" data-store-badge-notarised>
                        <ShieldCheck className="h-3 w-3" />
                        {t('extensions.storeNotarised')}
                      </span>
                    )}
                    {!confirm.download.trust.notarised && !confirm.download.trust.firstParty && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-300" data-store-badge-unreviewed>
                        <ShieldAlert className="h-3 w-3" />
                        {t('extensions.storeUnreviewed')}
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">{t('extensions.storeConfirmVerified')}</p>
                  {confirm.download.trust.notarised && (
                    <p className="text-xs text-muted-foreground">{t('extensions.storeConfirmNotarised', {store: confirm.resolution.store.name})}</p>
                  )}
                  {confirm.download.trust.firstParty && (
                    <p className="text-xs text-muted-foreground">{t('extensions.storeConfirmFirstParty', {store: confirm.resolution.store.name})}</p>
                  )}
                  {!confirm.download.trust.notarised && !confirm.download.trust.firstParty && (
                    <p className="text-xs text-amber-700 dark:text-amber-300" data-store-unreviewed-warning>
                      {t('extensions.storeConfirmUnreviewed', {store: confirm.resolution.store.name})}
                    </p>
                  )}
                  {storeProvenanceChanged(
                    confirm.download,
                    statuses.find((status) => status.plugin.manifest.id === confirm.download?.pkg.manifest.id)?.plugin,
                  ) && (
                    <p className="rounded-md border border-amber-500/40 px-3 py-2 text-xs text-amber-700 dark:text-amber-300" data-store-provenance-warning>
                      {t('extensions.storeProvenanceChanged')}
                    </p>
                  )}
                </div>
              )}
              <DialogFooter>
                <Button variant="ghost" size="sm" disabled={confirm.installing} onClick={() => setConfirm(null)}>
                  {t('common.cancel')}
                </Button>
                <Button size="sm" disabled={!confirm.download || confirm.installing || !!confirm.error} onClick={() => void confirmInstall()} data-store-confirm-install>
                  {confirm.installing ? t('extensions.storeInstalling') : t('extensions.storeConfirmInstall')}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </SettingsSection>
  );
};

/** Is this a plausible raw Ed25519 public key — 32 bytes of valid base64? */
function isEd25519PublicKey(base64: string): boolean {
  try {
    return atob(base64).length === 32;
  } catch {
    return false;
  }
}

/**
 * The registries whose signatures earn the Verified badge: the pinned
 * first-party key plus any the user pastes in. Removing one demotes its
 * plugins to Unverified on the next sync — trust stays the user's call.
 */
const TrustedRegistries: React.FC = () => {
  const client = useData();
  const {t} = useTranslation();
  const [registries, setRegistries] = useState(() => trustedRegistryKeys());
  const [name, setName] = useState('');
  const [publicKey, setPublicKey] = useState('');
  const [keyError, setKeyError] = useState(false);

  const add = useCallback(() => {
    const trimmedKey = publicKey.trim();
    if (!name.trim() || !trimmedKey) return;
    if (!isEd25519PublicKey(trimmedKey)) {
      setKeyError(true);
      return;
    }
    addTrustedRegistry(name, trimmedKey);
    setName('');
    setPublicKey('');
    setKeyError(false);
    setRegistries(trustedRegistryKeys());
    void syncPlugins(client).catch(() => undefined);
  }, [client, name, publicKey]);

  const remove = useCallback(
    (key: string) => {
      removeTrustedRegistry(key);
      setRegistries(trustedRegistryKeys());
      void syncPlugins(client).catch(() => undefined);
    },
    [client],
  );

  return (
    <SettingsSection title={t('extensions.registries')} description={t('extensions.registriesHint')}>
      <div className="flex flex-col gap-1.5">
        {registries.map((registry) => {
          const builtIn = OPENBOOK_REGISTRY_KEYS.some((k) => k.publicKey === registry.publicKey);
          return (
            <div
              key={registry.publicKey}
              data-registry={registry.name}
              className="flex items-center gap-3 rounded-md border border-border px-3 py-2"
            >
              <KeyRound className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{registry.name}</span>
                  {builtIn && (
                    <span className="rounded-full bg-accent px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                      {t('extensions.builtIn')}
                    </span>
                  )}
                </div>
                <p className="truncate font-mono text-[11px] text-muted-foreground/70">{registry.publicKey}</p>
              </div>
              {!builtIn && (
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive"
                  aria-label={t('extensions.removeRegistry', {name: registry.name})}
                  onClick={() => remove(registry.publicKey)}
                >
                  <X className="h-4 w-4" />
                </Button>
              )}
            </div>
          );
        })}
      </div>
      <form
        className="flex flex-wrap items-start gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('extensions.registryName')}
          aria-label={t('extensions.registryName')}
          data-registry-name
          className="h-8 w-44 text-sm"
        />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <Input
            value={publicKey}
            onChange={(e) => {
              setPublicKey(e.target.value);
              setKeyError(false);
            }}
            placeholder={t('extensions.registryKey')}
            aria-label={t('extensions.registryKey')}
            data-registry-key
            className={cn('h-8 min-w-44 font-mono text-xs', keyError && 'border-destructive')}
          />
          {keyError && (
            <p className="text-xs text-destructive" data-registry-key-error>
              {t('extensions.registryKeyInvalid')}
            </p>
          )}
        </div>
        <Button type="submit" size="sm" variant="outline" disabled={!name.trim() || !publicKey.trim()} data-registry-add>
          {t('extensions.addRegistry')}
        </Button>
      </form>
    </SettingsSection>
  );
};

const ExtensionCard: React.FC<{
  status: PluginStatus;
  /** A pinned store offers this strictly newer version (semver compare). */
  updateTo?: string;
  onEnabled: (id: string, enabled: boolean) => void;
  onRemove: (id: string) => void;
}> = ({status, updateTo, onEnabled, onRemove}) => {
  const {t} = useTranslation();
  const m = status.plugin.manifest;

  return (
    <div
      data-extension={m.id}
      data-extension-state={status.state}
      className={cn(
        'flex items-start gap-3 rounded-lg border border-border bg-card px-4 py-3 transition-colors',
        status.state === 'disabled' && 'opacity-60',
      )}
    >
      <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-accent/50 text-xl" aria-hidden>
        {m.icon || '🧩'}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="text-sm font-semibold">{m.name}</span>
          <span className="text-xs text-muted-foreground">v{m.version}</span>
          {status.state === 'revoked' && (
            <span
              className="inline-flex items-center gap-1 rounded-full bg-red-500/10 px-2 py-0.5 text-[11px] font-medium text-red-700 dark:text-red-300"
              title={t('extensions.revokedHint', {reason: status.error ?? ''})}
              data-extension-revoked
            >
              <Ban className="h-3 w-3" />
              {t('extensions.revoked')}
            </span>
          )}
          {updateTo && (
            <span
              className="inline-flex items-center gap-1 rounded-full bg-blue-500/10 px-2 py-0.5 text-[11px] font-medium text-blue-700 dark:text-blue-300"
              data-extension-update={updateTo}
            >
              <ArrowUpCircle className="h-3 w-3" />
              {t('extensions.storeUpdateAvailable', {version: updateTo})}
            </span>
          )}
          {status.verifiedBy ? (
            <span
              className="inline-flex items-center gap-1 rounded-full bg-green-500/10 px-2 py-0.5 text-[11px] font-medium text-green-700 dark:text-green-300"
              title={t('extensions.verifiedBy', {registry: status.verifiedBy})}
              data-extension-verified
            >
              <BadgeCheck className="h-3 w-3" />
              {t('extensions.verified')}
            </span>
          ) : (
            <span
              className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-300"
              title={t('extensions.unverifiedHint')}
              data-extension-unverified
            >
              <ShieldAlert className="h-3 w-3" />
              {t('extensions.unverified')}
            </span>
          )}
        </div>
        {m.description && <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{m.description}</p>}
        <p className="mt-0.5 text-[11px] text-muted-foreground/70">
          {m.id}
          {m.author ? ` · ${m.author}` : ''}
        </p>
        {status.state === 'error' && (
          <p className="mt-1 inline-flex items-center gap-1 text-xs text-destructive" data-extension-load-error>
            <TriangleAlert className="h-3.5 w-3.5" />
            {t('extensions.loadError', {error: status.error ?? ''})}
          </p>
        )}
        {status.state === 'revoked' && (
          <p className="mt-1 inline-flex items-center gap-1 text-xs text-destructive" data-extension-revoked-reason>
            <Ban className="h-3.5 w-3.5" />
            {t('extensions.revokedHint', {reason: status.error ?? ''})}
          </p>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Switch
          checked={status.plugin.enabled}
          aria-label={t('extensions.enable', {name: m.name})}
          onCheckedChange={(v) => onEnabled(m.id, v)}
        />
        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7 text-muted-foreground hover:text-destructive"
          aria-label={t('extensions.remove', {name: m.name})}
          onClick={() => onRemove(m.id)}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
};
