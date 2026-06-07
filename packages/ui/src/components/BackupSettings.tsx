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
import {useConfirm, useNavigation} from '@/providers';
import {readStoredPageIcon, writePageIcon, DEFAULT_PAGE_ICON} from '@/lib/pageIcon';
import {downloadText} from '@/lib/download';
import {bundleRoots, closure, overwriteCount, parseBackup} from '@/lib/backupBundle';

const displayName = (name: string | null): string => (name && name.trim() ? name : 'Untitled');

/** Backup & restore the whole workspace, from the Settings panel. */
export default function BackupSettings() {
  const client = useData();
  const {reload} = useNavigation();
  const confirm = useConfirm();
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
      setStatus(`Exported ${pages.length} page${pages.length === 1 ? '' : 's'}.`);
    } catch (e) {
      setStatus(`Export failed: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  }, [client]);

  const onFile = useCallback(async (file: File) => {
    setStatus(null);
    try {
      setBundle(parseBackup(await file.text()));
    } catch (e) {
      setStatus(`Couldn’t read backup: ${(e as Error).message}`);
    }
  }, []);

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-2">
        <h3 className="text-lg font-semibold">Backup &amp; restore</h3>
        <p className="text-sm text-muted-foreground">
          Export your whole workspace to a single file, or restore one — choosing which pages to bring back.
        </p>
        <div className="mt-1 flex flex-wrap gap-2">
          <Button onClick={() => void onExport()} disabled={busy !== null} className="gap-2">
            <Download className="h-4 w-4" />
            {busy === 'export' ? 'Exporting…' : 'Export backup'}
          </Button>
          <Button variant="secondary" onClick={() => fileInput.current?.click()} disabled={busy !== null} className="gap-2">
            <Upload className="h-4 w-4" />
            Restore backup…
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
        title: `Overwrite ${n} existing page${n === 1 ? '' : 's'}?`,
        description:
          n > 0
            ? `Restoring in place will replace the current content of ${n} page${n === 1 ? '' : 's'}. This can’t be undone.`
            : 'No existing pages match — these will be added as new pages.',
        confirmText: 'Overwrite',
        destructive: true,
      });
      if (!ok) return;
    }
    setBusy('import');
    try {
      const result = await run({pages: sel.pages, databases: sel.databases, mode});
      const bits = [
        result.created ? `${result.created} added` : '',
        result.overwritten ? `${result.overwritten} overwritten` : '',
        result.renamed ? `${result.renamed} renamed` : '',
      ].filter(Boolean);
      onDone(`Restored ${sel.pages.length} page${sel.pages.length === 1 ? '' : 's'}${bits.length ? ` (${bits.join(', ')})` : ''}.`);
    } catch (e) {
      onDone(`Restore failed: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  }, [bundle, checked, mode, confirm, existingIds, run, onDone, setBusy]);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Restore backup</DialogTitle>
          <DialogDescription>
            {roots.length} page{roots.length === 1 ? '' : 's'}
            {bundle.exportedAt ? ` · exported ${new Date(bundle.exportedAt).toLocaleDateString()}` : ''}. Pick what to restore.
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>{checked.size} selected</span>
          <div className="flex gap-2">
            <button type="button" className="cursor-pointer hover:text-foreground" onClick={() => setChecked(new Set(roots.map((r) => r.id)))}>
              All
            </button>
            <button type="button" className="cursor-pointer hover:text-foreground" onClick={() => setChecked(new Set())}>
              None
            </button>
          </div>
        </div>

        <ul className="max-h-64 overflow-y-auto rounded-md border border-border">
          {roots.map((p) => (
            <li key={p.id}>
              <label className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm hover:bg-accent">
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
            <span className="font-medium">Overwrite existing pages</span>
            <span className="block text-xs text-muted-foreground">
              Restore in place by id. Off (default) imports as copies, suffixing names that clash.
            </span>
          </span>
        </label>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void onRestore()} disabled={checked.size === 0}>
            Restore {checked.size > 0 ? checked.size : ''}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
