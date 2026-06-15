import {useCallback, useMemo, useRef, useState} from 'react';
import {BACKUP_VERSION, type SpaceBackup} from '@open-book/sdk';
import {Download, Upload} from 'lucide-react';
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
import {useConfirm, useNavigation, useTranslation} from '@/providers';
import {readStoredPageIcon, writePageIcon, DEFAULT_PAGE_ICON} from '@/lib/pageIcon';
import {downloadText} from '@/lib/download';
import {bundleRoots, closure, overwriteCount, parseBackup} from '@/lib/backupBundle';
import {t as bareT} from '@/i18n';

const displayName = (name: string | null): string => (name && name.trim() ? name : bareT('common.untitled'));

/** Backup & restore the whole workspace, from the Settings panel. */
export default function BackupSettings() {
  const client = useData();
  const {reload} = useNavigation();
  const confirm = useConfirm();
  const {t} = useTranslation();
  const fileInput = useRef<HTMLInputElement>(null);

  const [busy, setBusy] = useState<null | 'export' | 'import'>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [bundle, setBundle] = useState<SpaceBackup | null>(null);

  const onExport = useCallback(async () => {
    setBusy('export');
    setStatus(null);
    try {
      const {pages, databases} = await client.exportSpace();
      const icons: Record<string, string> = {};
      for (const p of pages) {
        const ic = readStoredPageIcon(p.id);
        if (ic) icons[p.id] = ic;
      }
      const backup: SpaceBackup = {version: BACKUP_VERSION, exportedAt: new Date().toISOString(), pages, databases, icons};
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

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-2">
        <h3 className="text-lg font-semibold">{t('backup.heading')}</h3>
        <p className="text-sm text-muted-foreground">
          {t('backup.intro')}
        </p>
        <div className="mt-1 flex flex-wrap gap-2">
          <Button onClick={() => void onExport()} disabled={busy !== null} className="gap-2">
            <Download className="h-4 w-4" />
            {busy === 'export' ? t('backup.exporting') : t('backup.export')}
          </Button>
          <Button variant="secondary" onClick={() => fileInput.current?.click()} disabled={busy !== null} className="gap-2">
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
        {status && <p className="text-sm text-muted-foreground">{status}</p>}
      </section>

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
            const result = await client.importSpace(req);
            // Carry over page icons to the imported ids.
            for (const [oldId, newId] of Object.entries(result.idMap)) {
              const ic = bundle.icons?.[oldId];
              if (ic && ic !== DEFAULT_PAGE_ICON) writePageIcon(newId, ic);
            }
            return result;
          }}
          existingIds={async () => new Set((await client.exportSpace()).pages.map((p) => p.id))}
          confirm={confirm}
          setBusy={setBusy}
        />
      )}
    </div>
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
  bundle: SpaceBackup;
  onClose: () => void;
  onDone: (summary: string) => void;
  run: (req: Parameters<ReturnType<typeof useData>['importSpace']>[0]) => ReturnType<ReturnType<typeof useData>['importSpace']>;
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
