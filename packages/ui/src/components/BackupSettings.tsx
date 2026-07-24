import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  BACKUP_VERSION,
  getServerUrlOverride,
  parseBookFolder,
  libraryToBookFiles,
  type BackupCadence,
  type BackupConfig,
  type BackupStatus,
  type ServerInfo,
  type LibraryBackup,
} from '@book.dev/sdk';
import {CalendarClock, Database, Download, FileUp, FolderDown, FolderUp, Upload} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {useData} from '@/data';
import {useConfirm, useHud, useNavigation, usePlatformCapabilities, useTranslation} from '@/providers';
import {SettingsField, SettingsSection, SettingsToggle, SettingsAdvancedSection} from '@/components/settings/primitives';
import {writePageIcon, DEFAULT_PAGE_ICON} from '@/lib/pageIcon';
import {ICON_PROPERTY_ID} from '@book.dev/sdk';
import {downloadText} from '@/lib/download';
import {exportBookFolderInBrowser, importBookFolderInBrowser} from '@/lib/bookFolderTransfer';
import {bundleRoots, closure, overwriteCount, parseBackup} from '@/lib/backupBundle';
import {t as bareT} from '@/i18n';

const displayName = (name: string | null): string => (name && name.trim() ? name : bareT('common.untitled'));

/**
 * The viewer runtime bundle for the folder export's `_openbook/viewer.js` — ONE
 * copy per exported folder, referenced relatively from every `.book.html` so a
 * file opened straight from `file://` hydrates into the interactive locked
 * viewer (owner decision 2026-07-04: never vendored per-file).
 *
 * Loaded lazily at export time via a `?raw` dynamic import of the vite-built
 * vendor bundle (`build:viewer` runs before the lib build, so a packaged ui
 * always has it). When it can't be resolved (e.g. a dev/test context that never
 * built the viewer), the export gracefully degrades to the plain static files —
 * `libraryToBookFiles` emits no reference without a runtime.
 */
async function loadFolderRuntime(): Promise<string | undefined> {
  try {
    return (await import('@/export/vendor/openbook-viewer.js?raw')).default;
  } catch {
    return undefined;
  }
}

/** Human-readable byte size (e.g. `1.5 GB`). */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** Backup & restore the whole library, from the Settings panel. */
export default function BackupSettings() {
  const client = useData();
  const platform = usePlatformCapabilities();
  const {reload} = useNavigation();
  const confirm = useConfirm();
  const {t} = useTranslation();
  const {setHud} = useHud();
  const fileInput = useRef<HTMLInputElement>(null);

  // Compaction (VACUUM FULL) only applies to the embedded local store; a remote
  // server answers 409. Gate up front on the connect override so the control
  // reads as disabled-with-reason instead of failing after a click.
  const remote = getServerUrlOverride();

  const [busy, setBusy] = useState<null | 'export' | 'import' | 'folder' | 'compact'>(null);
  // One status line for every data in/out action (export, restore, folder
  // export/import). The Backup and Folder sections sit adjacent, so a single
  // shared line reads cleanly and there's no second export action to feed.
  const [status, setStatus] = useState<string | null>(null);
  const [bundle, setBundle] = useState<LibraryBackup | null>(null);

  const doExport = useCallback(async () => {
    setBusy('export');
    setStatus(null);
    try {
      const {pages, databases} = await client.exportLibrary();
      // Icons travel in `page.properties` now, but keep the legacy `icons` map in
      // the bundle too so older importers still restore them.
      const icons: Record<string, string> = {};
      for (const p of pages) {
        const ic = p.properties?.[ICON_PROPERTY_ID];
        if (typeof ic === 'string' && ic) icons[p.id] = ic;
      }
      const backup: LibraryBackup = {version: BACKUP_VERSION, exportedAt: new Date().toISOString(), pages, databases, icons};
      downloadText(`openbook-backup-${new Date().toISOString().slice(0, 10)}.openbook.json`, JSON.stringify(backup), 'application/json');
      setStatus(t('backup.exported', {count: pages.length}));
    } catch (e) {
      setStatus(t('backup.exportFailed', {error: (e as Error).message}));
    } finally {
      setBusy(null);
    }
  }, [client, t]);

  const onFile = useCallback(async (file: File) => {
    setStatus(null);
    try {
      setBundle(parseBackup(await file.text()));
    } catch (e) {
      setStatus(t('backup.readFailed', {error: (e as Error).message}));
    }
  }, [t]);

  // Export the library as a folder of readable `.html` files (one per page,
  // OB-134 layout) plus a lossless bundle. The desktop supplies a native dialog;
  // the web falls back to the File System Access API or a zip download.
  const onExportFolder = useCallback(async () => {
    setBusy('folder');
    setStatus(null);
    try {
      const files = libraryToBookFiles(await client.exportLibrary(), {runtime: await loadFolderRuntime()});
      const name = `openbook-${new Date().toISOString().slice(0, 10)}`;
      const result = platform.bookFolder?.export
        ? await platform.bookFolder.export(files)
        : await exportBookFolderInBrowser(files, name);
      if (result) setStatus(t('backup.folderExported', {count: result.count, location: result.location}));
    } catch (e) {
      setStatus(t('backup.exportFailed', {error: (e as Error).message}));
    } finally {
      setBusy(null);
    }
  }, [client, platform, t]);

  // Load a book folder back; route it through the same Restore dialog so the
  // user picks which roots to bring in and copy-vs-overwrite.
  const onImportFolder = useCallback(async () => {
    setStatus(null);
    try {
      const files = platform.bookFolder?.import
        ? await platform.bookFolder.import()
        : await importBookFolderInBrowser();
      if (!files) return;
      const snapshot = parseBookFolder(files);
      if (!snapshot) {
        setStatus(t('backup.folderEmpty'));
        return;
      }
      const icons: Record<string, string> = {};
      for (const p of snapshot.pages) {
        const ic = p.properties?.[ICON_PROPERTY_ID];
        if (typeof ic === 'string' && ic) icons[p.id] = ic;
      }
      setBundle({version: BACKUP_VERSION, exportedAt: '', pages: snapshot.pages, databases: snapshot.databases, icons});
    } catch (e) {
      setStatus(t('backup.readFailed', {error: (e as Error).message}));
    }
  }, [platform, t]);

  // Compact the embedded database (VACUUM FULL) to physically reclaim the heap
  // bloat that edit churn leaves behind (OB-164). The store is exclusively locked
  // while it runs, so confirm first — and it only applies to the embedded PGlite
  // store; a remote server answers 409, surfaced as "unavailable".
  const onCompact = useCallback(async () => {
    if (!(await confirm({
      title: t('storage.confirmTitle'),
      description: t('storage.confirmBody'),
      confirmText: t('storage.confirmAction'),
    }))) return;
    setBusy('compact');
    setStatus(null);
    try {
      const {reclaimed, after} = await client.compact();
      setStatus(
        reclaimed > 0
          ? t('storage.reclaimed', {amount: formatBytes(reclaimed), size: formatBytes(after)})
          : t('storage.alreadyCompact', {size: formatBytes(after)}),
      );
    } catch (e) {
      const message = (e as Error).message;
      setStatus(message.includes('409') ? t('storage.unavailable') : t('storage.failed', {error: message}));
    } finally {
      setBusy(null);
    }
  }, [client, confirm, t]);

  return (
    <div className="flex flex-col gap-7">
      {/* Onboarding, not a backup: pull pages in from another tool. */}
      <SettingsSection title={t('backup.importHeading')} description={t('backup.importIntro')}>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            onClick={() => setHud((draft) => {
              draft.importer.open = true;
              return draft;
            })}
            disabled={busy !== null}
          >
            <FileUp className="h-4 w-4" />
            {t('backup.importContent')}
          </Button>
        </div>
      </SettingsSection>

      <SettingsSection title={t('backup.heading')} description={t('backup.intro')}>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => void doExport()} disabled={busy !== null}>
            <Download className="h-4 w-4" />
            {busy === 'export' ? t('backup.exporting') : t('backup.export')}
          </Button>
          <Button variant="secondary" onClick={() => fileInput.current?.click()} disabled={busy !== null}>
            <Upload className="h-4 w-4" />
            {t('backup.restore')}
          </Button>
          <input
            ref={fileInput}
            type="file"
            accept=".json,application/json"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (file) void onFile(file);
            }}
          />
        </div>
      </SettingsSection>

      <SettingsSection title={t('backup.folderHeading')} description={t('backup.folderIntro')}>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => void onExportFolder()} disabled={busy !== null}>
            <FolderDown className="h-4 w-4" />
            {busy === 'folder' ? t('backup.folderExporting') : t('backup.folderExport')}
          </Button>
          <Button variant="secondary" onClick={() => void onImportFolder()} disabled={busy !== null}>
            <FolderUp className="h-4 w-4" />
            {t('backup.folderImport')}
          </Button>
        </div>
        {/* One shared status line for every data in/out action above. */}
        {status && <p className="text-sm text-muted-foreground">{status}</p>}
      </SettingsSection>

      <ScheduledBackupsSection />

      <SettingsSection title={t('storage.heading')}>
        <BookFilesFields />
        {/* Rarely-touched maintenance — collapsed by default (SET2-8). */}
        <SettingsAdvancedSection title={t('storage.compactHeading')} description={t('storage.intro')}>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              onClick={() => void onCompact()}
              disabled={busy !== null || !!remote}
            >
              <Database className="h-4 w-4" />
              {busy === 'compact' ? t('storage.compacting') : t('storage.compact')}
            </Button>
          </div>
          {remote && <p className="text-xs text-muted-foreground">{t('storage.remoteUnavailable')}</p>}
        </SettingsAdvancedSection>
      </SettingsSection>

      {bundle && (
        <RestoreDialog
          bundle={bundle}
          onClose={() => setBundle(null)}
          onDone={(summary) => {
            setBundle(null);
            setStatus(summary);
            void reload();
          }}
          run={async (req) => {
            const result = await client.importLibrary(req);
            // Carry over page icons to the imported ids.
            for (const [oldId, newId] of Object.entries(result.idMap)) {
              const ic = bundle.icons?.[oldId];
              if (ic && ic !== DEFAULT_PAGE_ICON) writePageIcon(newId, ic);
            }
            return result;
          }}
          existingIds={async () => new Set((await client.exportLibrary()).pages.map((p) => p.id))}
          confirm={confirm}
          setBusy={setBusy}
        />
      )}
    </div>
  );
}

/**
 * The book-files folder (desktop, local managed server only): show where the
 * durable on-disk book mirror lives and let the user relocate or reveal it.
 * Hidden on the web and when connected to a remote server — only the always-on
 * local managed server exposes `chooseBookDir`. Rendered inside the unified
 * Storage section, so it emits fields only (no section wrapper of its own).
 */
function BookFilesFields() {
  const {serverControls} = usePlatformCapabilities();
  const {t} = useTranslation();
  const [info, setInfo] = useState<ServerInfo | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    if (!serverControls) return;
    serverControls
      .info()
      .then(setInfo)
      .catch(() => {
        /* the folder row simply stays hidden if info is unavailable */
      });
  }, [serverControls]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const runControl = useCallback(async (fn: () => Promise<ServerInfo>) => {
    setBusy(true);
    try {
      setInfo(await fn());
    } catch {
      /* a cancelled folder picker (or a transient error) leaves the row as-is */
    } finally {
      setBusy(false);
    }
  }, []);

  if (!serverControls?.chooseBookDir || !info?.managed) return null;

  return (
    <>
      <p className="text-sm text-muted-foreground">{t('connection.bookFilesDescription')}</p>
      <SettingsField label={t('connection.bookFolder')} className="max-w-lg">
        <code className="block truncate rounded-md border border-border bg-muted/40 px-2 py-1.5 text-xs">
          {info?.bookDir ?? '—'}
        </code>
      </SettingsField>
      <div className="flex gap-2">
        <Button variant="outline" disabled={busy} onClick={() => void runControl(() => serverControls.chooseBookDir!())}>
          {t('connection.changeFolder')}
        </Button>
        {serverControls.revealBookDir && (
          <Button variant="ghost" disabled={busy} onClick={() => void serverControls.revealBookDir!()}>
            {t('connection.reveal')}
          </Button>
        )}
      </div>
    </>
  );
}

/**
 * Scheduled backups (OB-166): turn on tiered daily/weekly/monthly/yearly
 * snapshots, see when each last ran, and trigger one on demand. Backups are
 * written + pruned by the server, so this is hidden when the server doesn't
 * expose the endpoint (older build) and shown as desktop/server-only when the
 * data layer runs in the browser (no filesystem).
 */
function ScheduledBackupsSection() {
  const client = useData();
  const {t} = useTranslation();
  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const refresh = useCallback(() => {
    client
      .getBackupStatus()
      .then(setStatus)
      .catch(() => setUnavailable(true));
  }, [client]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const patch = useCallback(
    async (p: Partial<BackupConfig>) => {
      setBusy(true);
      setMsg(null);
      try {
        setStatus(await client.setBackupConfig(p));
      } catch (e) {
        setMsg((e as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [client],
  );

  const backupNow = useCallback(async () => {
    setBusy(true);
    setMsg(null);
    try {
      const {file} = await client.runBackup('daily');
      setMsg(t('backup.schedule.ranNow', {file}));
      refresh();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [client, refresh, t]);

  const cadenceLabel = useCallback(
    (c: BackupCadence): string =>
      c === 'daily'
        ? t('backup.schedule.cadenceDaily')
        : c === 'weekly'
          ? t('backup.schedule.cadenceWeekly')
          : c === 'monthly'
            ? t('backup.schedule.cadenceMonthly')
            : t('backup.schedule.cadenceYearly'),
    [t],
  );

  if (unavailable || !status) return null;
  const webOnly = status.resolvedDir === null;

  return (
    <SettingsSection title={t('backup.schedule.heading')} description={t('backup.schedule.intro')}>
      {webOnly ? (
        <p className="text-sm text-muted-foreground">{t('backup.schedule.webOnly')}</p>
      ) : (
        <>
          <SettingsToggle
            label={t('backup.schedule.enable')}
            hint={t('backup.schedule.enableHint')}
            checked={status.config.enabled}
            disabled={busy}
            onCheckedChange={(v) => void patch({enabled: v})}
          />

          {status.config.enabled && (
            <div className="flex flex-col gap-1.5">
              {status.cadences.map((c) => (
                <SettingsToggle
                  key={c.cadence}
                  label={cadenceLabel(c.cadence)}
                  hint={
                    c.lastRun
                      ? t('backup.schedule.keptLast', {when: new Date(c.lastRun).toLocaleString(), count: c.count})
                      : t('backup.schedule.never')
                  }
                  checked={c.enabled}
                  disabled={busy}
                  onCheckedChange={(v) => void patch({cadences: {...status.config.cadences, [c.cadence]: v}})}
                />
              ))}
            </div>
          )}

          <div className="mt-1 flex flex-wrap items-center gap-2">
            <Button variant="secondary" onClick={() => void backupNow()} disabled={busy}>
              <CalendarClock className="h-4 w-4" />
              {busy ? t('backup.schedule.backingUp') : t('backup.schedule.backupNow')}
            </Button>
            {status.resolvedDir && (
              <code className="min-w-0 flex-1 truncate rounded-md border border-border bg-muted/40 px-2 py-1.5 text-xs">
                {status.resolvedDir}
              </code>
            )}
          </div>
        </>
      )}
      {msg && <p className="text-sm text-muted-foreground">{msg}</p>}
    </SettingsSection>
  );
}

function RestoreDialog({
  bundle,
  onClose,
  onDone,
  run,
  existingIds,
  confirm,
  setBusy,
}: {
  bundle: LibraryBackup;
  onClose: () => void;
  onDone: (summary: string) => void;
  run: (req: Parameters<ReturnType<typeof useData>['importLibrary']>[0]) => ReturnType<ReturnType<typeof useData>['importLibrary']>;
  existingIds: () => Promise<Set<string>>;
  confirm: ReturnType<typeof useConfirm>;
  setBusy: (b: null | 'import') => void;
}) {
  const {t} = useTranslation();
  const roots = useMemo(() => bundleRoots(bundle), [bundle]);
  const [checked, setChecked] = useState<Set<string>>(() => new Set(roots.map((r) => r.id)));
  const [mode, setMode] = useState<'copy' | 'overwrite'>('copy');

  const toggle = (id: string) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const onRestore = useCallback(async () => {
    const sel = closure(bundle, checked);
    if (sel.pages.length === 0) return;
    if (mode === 'overwrite') {
      const n = overwriteCount(sel.pages, await existingIds());
      const ok = await confirm({
        title: t('backup.dialog.confirmTitle', {count: n}),
        description:
          n > 0
            ? t('backup.dialog.confirmBody', {count: n})
            : t('backup.dialog.confirmBodyNone'),
        confirmText: t('backup.dialog.confirmOverwrite'),
        destructive: true,
      });
      if (!ok) return;
    }
    setBusy('import');
    try {
      const result = await run({pages: sel.pages, databases: sel.databases, mode});
      const bits = [
        result.created ? t('backup.added', {count: result.created}) : '',
        result.overwritten ? t('backup.overwrittenCount', {count: result.overwritten}) : '',
        result.renamed ? t('backup.renamedCount', {count: result.renamed}) : '',
      ].filter(Boolean);
      const detail = bits.length ? ` (${bits.join(', ')})` : '';
      onDone(t('backup.restored', {count: sel.pages.length, detail}));
    } catch (e) {
      onDone(t('backup.restoreFailed', {error: (e as Error).message}));
    } finally {
      setBusy(null);
    }
  }, [bundle, checked, mode, confirm, existingIds, run, onDone, setBusy, t]);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('backup.dialog.title')}</DialogTitle>
          <DialogDescription>
            {bundle.exportedAt
              ? t('backup.dialog.summaryDated', {count: roots.length, date: new Date(bundle.exportedAt).toLocaleDateString()})
              : t('backup.dialog.summary', {count: roots.length})}
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>{t('backup.dialog.selected', {count: checked.size})}</span>
          <div className="flex gap-2">
            <button type="button" className="cursor-pointer hover:text-foreground" onClick={() => setChecked(new Set(roots.map((r) => r.id)))}>
              {t('backup.dialog.all')}
            </button>
            <button type="button" className="cursor-pointer hover:text-foreground" onClick={() => setChecked(new Set())}>
              {t('backup.dialog.none')}
            </button>
          </div>
        </div>

        <ul className="max-h-64 overflow-y-auto rounded-md border border-border">
          {roots.map((p) => (
            <li key={p.id}>
              <label className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm hover:bg-hover">
                <input type="checkbox" className="cursor-pointer" checked={checked.has(p.id)} onChange={() => toggle(p.id)} />
                <span className="text-base leading-none">{bundle.icons?.[p.id] ?? DEFAULT_PAGE_ICON}</span>
                <span className="truncate">{displayName(p.name)}</span>
              </label>
            </li>
          ))}
        </ul>

        <label className="flex cursor-pointer items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-0.5 cursor-pointer"
            checked={mode === 'overwrite'}
            onChange={(e) => setMode(e.target.checked ? 'overwrite' : 'copy')}
          />
          <span>
            <span className="font-medium">{t('backup.dialog.overwrite')}</span>
            <span className="block text-xs text-muted-foreground">
              {t('backup.dialog.overwriteHint')}
            </span>
          </span>
        </label>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button onClick={() => void onRestore()} disabled={checked.size === 0}>
            {t('backup.dialog.restoreN', {count: checked.size})}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
