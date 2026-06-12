import React, {useCallback, useEffect, useRef, useState} from 'react';
import {BadgeCheck, Puzzle, ShieldAlert, Trash2, TriangleAlert, Upload} from 'lucide-react';
import {SettingsScreen, SettingsSection} from '@/components/settings/primitives';
import {Button} from '@/components/ui/button';
import {Switch} from '@/components/ui/switch';
import {useData} from '@/data';
import {useTranslation} from '@/providers';
import {parsePluginZip, pluginStatuses, subscribePlugins, syncPlugins, reloadPlugin, type PluginStatus} from '@/plugins';
import {cn} from '@/lib/utils';

/**
 * Settings → Extensions: the workspace's installed plugins. Install from a
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
  const fileRef = useRef<HTMLInputElement>(null);

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
      await client.removePlugin(id);
      await syncPlugins(client);
    },
    [client],
  );

  return (
    <SettingsScreen title={t('settings.tab.extensions')} description={t('extensions.description')}>
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
            <Upload className="mr-1.5 h-3.5 w-3.5" />
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
            <ExtensionCard key={status.plugin.manifest.id} status={status} onEnabled={setEnabled} onRemove={remove} />
          ))}
        </div>
      </SettingsSection>

      <p className="text-xs text-muted-foreground/70">{t('extensions.trustNote')}</p>
    </SettingsScreen>
  );
}

const ExtensionCard: React.FC<{
  status: PluginStatus;
  onEnabled: (id: string, enabled: boolean) => void;
  onRemove: (id: string) => void;
}> = ({status, onEnabled, onRemove}) => {
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
