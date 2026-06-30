import {useCallback, useEffect, useRef, useState} from 'react';
import {Check, FileText, Image, Loader2, TriangleAlert, Upload} from 'lucide-react';
import type {ImportedDoc} from '@book.dev/sdk';
import type {TKey} from '@/i18n';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {Button} from '@/components/ui/button';
import {useData} from '@/data';
import {useHud, useNavigation, useTranslation} from '@/providers';
import {
  detectImportFormat,
  parseImportSource,
  pickImportedJumpTarget,
  runImport,
  summarizeImportedDoc,
  type ImportSummary,
} from '@/lib/importContent';
import {isImportAbortError, parseImportInWorker, type ImportParseProgress} from '@/lib/importParse';

/** Extensions the file picker offers — Notion export zips and Markdown files. */
const ACCEPT = '.zip,.md,.markdown,.mdown,.mkd,.txt';

/**
 * The import flow, as a small state machine. `pick` offers the file picker (and
 * a paste-Markdown affordance); reading/parsing produces a `preview` of what
 * will land; the user confirms into `importing` (the progress phase); `done`
 * shows the result summary plus a jump to the first top-level imported page.
 * Any failure becomes a friendly `error` the user can retry from — never a
 * thrown crash.
 */
type Phase =
  | {step: 'pick'}
  | {step: 'reading'; progress?: ImportParseProgress}
  | {step: 'preview'; doc: ImportedDoc; summary: ImportSummary; sourceLabel: string}
  | {step: 'importing'; summary: ImportSummary}
  | {step: 'done'; summary: ImportSummary; jumpTarget: string | null}
  | {step: 'error'; message: string};

/**
 * "Bring your content" — import a Notion export (.zip) or a Markdown file into
 * the workspace (OB-301). Format is auto-detected from the file; the SDK
 * importers (`notionExportToImportedDoc` / `markdownToImportedDoc`) parse to the
 * format-agnostic IR, and `importDoc` lands it through the existing data paths,
 * picking the create-vs-bundle strategy itself. Opened from the HUD (Home quick
 * action, command palette, or Settings → Admin).
 *
 * We use a clean progress UI rather than reusing the backup Restore dialog: the
 * SDK's `importDoc` is the single landing entry point and chooses its own
 * strategy, so there are no per-root selections to surface — a preview → import
 * → result flow fits the seam better.
 */
export default function ImportDialog() {
  const {hud, setHud} = useHud();
  const {t} = useTranslation();
  const client = useData();
  const {reload, selectPage} = useNavigation();
  const fileInput = useRef<HTMLInputElement>(null);
  // Guards against a same-frame double-click on "Import" firing the write twice
  // (harmless under copy-mode dedup, but tidier blocked at the source).
  const importingRef = useRef(false);
  // Aborts (and terminates) an in-flight parse worker when the dialog closes or
  // unmounts mid-parse, so a big import left half-parsed doesn't keep a worker
  // churning in the background.
  const parseAbortRef = useRef<AbortController | null>(null);

  const open = hud.importer.open;
  const [phase, setPhase] = useState<Phase>({step: 'pick'});
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState('');

  // Reset to a clean picker each time the dialog opens, so a previous import's
  // result or error never greets the next one; abort any parse still running
  // when it closes.
  useEffect(() => {
    if (open) {
      setPhase({step: 'pick'});
      setPasteOpen(false);
      setPasteText('');
      importingRef.current = false;
    } else {
      parseAbortRef.current?.abort();
    }
  }, [open]);

  // Belt-and-braces: kill an in-flight parse worker if the whole dialog unmounts.
  useEffect(() => () => parseAbortRef.current?.abort(), []);

  const setOpen = useCallback(
    (next: boolean) =>
      setHud((draft) => {
        draft.importer.open = next;
        return draft;
      }),
    [setHud],
  );

  // Pick the singular or plural i18n string for a count (`t` has no plural
  // engine, so we choose the key) — "1 page", "3 pages".
  const plural = useCallback((n: number, one: TKey, many: TKey): string => t(n === 1 ? one : many, {count: n}), [t]);

  // Build a human "12 pages, 2 databases, 30 rows" phrase from a tally, omitting
  // the zeroes (mirrors the backup summary's part-joining).
  const summaryPhrase = useCallback(
    (s: ImportSummary): string =>
      [
        s.pages ? plural(s.pages, 'importer.summaryPageOne', 'importer.summaryPage') : '',
        s.databases ? plural(s.databases, 'importer.summaryDatabaseOne', 'importer.summaryDatabase') : '',
        s.rows ? plural(s.rows, 'importer.summaryRowOne', 'importer.summaryRow') : '',
      ]
        .filter(Boolean)
        .join(', '),
    [plural],
  );

  // Land a parsed IR on the preview (or surface "nothing to import"). The
  // summary is computed by the parser (in the worker, off the main thread) and
  // handed in, so the dialog never re-walks the tree on the main thread.
  const toPreview = useCallback(
    (doc: ImportedDoc, summary: ImportSummary, sourceLabel: string) => {
      if (summary.pages === 0) {
        setPhase({step: 'error', message: t('importer.empty')});
        return;
      }
      setPhase({step: 'preview', doc, summary, sourceLabel});
    },
    [t],
  );

  const onFile = useCallback(
    async (file: File) => {
      setPhase({step: 'reading'});
      // A fresh controller per parse; aborting it (on close/unmount) terminates
      // the worker. Cancel any prior parse first.
      parseAbortRef.current?.abort();
      const controller = new AbortController();
      parseAbortRef.current = controller;
      try {
        const format = detectImportFormat(file.name);
        if (!format) {
          setPhase({step: 'error', message: t('importer.unsupported')});
          return;
        }
        // Heavy work (unzip + parse + IR + summarize) runs in a Web Worker so a
        // big import doesn't freeze the UI; the spinner stays live and shows the
        // parse's progress. Falls back to a main-thread parse if a worker can't
        // be hosted (e.g. a webview that rejects the worker).
        const source =
          format === 'notion-zip'
            ? ({format, bytes: new Uint8Array(await file.arrayBuffer()), fileName: file.name} as const)
            : ({format, text: await file.text(), fileName: file.name} as const);
        const {doc, summary} = await parseImportInWorker(source, {
          signal: controller.signal,
          onProgress: (progress) => setPhase({step: 'reading', progress}),
        });
        toPreview(doc, summary, file.name);
      } catch (e) {
        // The dialog closed mid-parse — it's unmounting/reset, so show nothing.
        if (isImportAbortError(e)) return;
        setPhase({step: 'error', message: t('importer.parseFailed', {error: (e as Error).message})});
      }
    },
    [t, toPreview],
  );

  // Pasted Markdown is small by nature, so it parses inline (no worker spin-up):
  // the same pure parser the worker wraps, just on the main thread.
  const onPaste = useCallback(() => {
    if (!pasteText.trim()) {
      setPhase({step: 'error', message: t('importer.emptyPaste')});
      return;
    }
    try {
      const doc = parseImportSource({format: 'markdown', text: pasteText});
      toPreview(doc, summarizeImportedDoc(doc), t('importer.pastedLabel'));
    } catch (e) {
      setPhase({step: 'error', message: t('importer.parseFailed', {error: (e as Error).message})});
    }
  }, [pasteText, t, toPreview]);

  const doImport = useCallback(
    async (doc: ImportedDoc, summary: ImportSummary) => {
      if (importingRef.current) return;
      importingRef.current = true;
      setPhase({step: 'importing', summary});
      try {
        const result = await runImport(client, doc);
        // Reload first, then resolve the jump target against the fresh nav list
        // (rows excluded) so "view imported" can only ever land on a real page.
        const pages = await reload();
        setPhase({step: 'done', summary, jumpTarget: pickImportedJumpTarget(result, pages)});
      } catch (e) {
        setPhase({step: 'error', message: t('importer.importFailed', {error: (e as Error).message})});
      } finally {
        importingRef.current = false;
      }
    },
    [client, reload, t],
  );

  const viewImported = useCallback(
    (jumpTarget: string | null) => {
      setOpen(false);
      if (jumpTarget) selectPage(jumpTarget);
    },
    [selectPage, setOpen],
  );

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>{t('importer.title')}</DialogTitle>
          <DialogDescription>{t('importer.description')}</DialogDescription>
        </DialogHeader>

        {/* ── Pick: choose a file, or paste Markdown ─────────────────────── */}
        {phase.step === 'pick' && (
          <div className="flex flex-col gap-4">
            <button
              type="button"
              onClick={() => fileInput.current?.click()}
              className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border bg-sheet-1 px-4 py-8 text-center transition-[background-color,border-color,box-shadow] hover:border-foreground/20 hover:bg-hover focus-visible:outline-hidden focus-visible:shadow-[var(--ring-control)]"
            >
              <Upload className="h-6 w-6 text-muted-foreground" aria-hidden />
              <span className="text-sm font-medium">{t('importer.chooseFile')}</span>
              <span className="text-xs text-muted-foreground">{t('importer.formats')}</span>
            </button>
            <input
              ref={fileInput}
              type="file"
              accept={ACCEPT}
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (file) void onFile(file);
              }}
            />

            {pasteOpen ? (
              <div className="flex flex-col gap-2">
                <textarea
                  value={pasteText}
                  onChange={(e) => setPasteText(e.target.value)}
                  placeholder={t('importer.pastePlaceholder')}
                  rows={6}
                  aria-label={t('importer.pasteToggle')}
                  className="w-full resize-y rounded-md border border-border bg-background px-3 py-2 text-sm focus-visible:outline-hidden focus-visible:shadow-[var(--ring-control)]"
                />
                <div className="flex justify-end">
                  <Button size="sm" onClick={onPaste} disabled={!pasteText.trim()}>
                    {t('importer.pasteImport')}
                  </Button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setPasteOpen(true)}
                className="self-center text-xs text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline"
              >
                {t('importer.pasteToggle')}
              </button>
            )}
          </div>
        )}

        {/* ── Reading / parsing the file (off the main thread) ───────────── */}
        {phase.step === 'reading' && (
          <div role="status" className="flex flex-col items-center justify-center gap-1 py-10 text-sm text-muted-foreground">
            <span className="flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              {t('importer.reading')}
            </span>
            {phase.progress?.pages ? (
              <span className="text-xs">
                {plural(phase.progress.pages, 'importer.summaryPageOne', 'importer.summaryPage')}
              </span>
            ) : null}
          </div>
        )}

        {/* ── Preview: what will land, then confirm ──────────────────────── */}
        {phase.step === 'preview' && (
          <div className="flex flex-col gap-3">
            <div className="flex items-start gap-3 rounded-lg border border-border bg-card p-3">
              <FileText className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" aria-hidden />
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="truncate text-sm font-medium">{phase.sourceLabel}</span>
                <span className="text-xs text-muted-foreground">
                  {t('importer.preview', {summary: summaryPhrase(phase.summary)})}
                </span>
              </div>
            </div>
            {phase.summary.databases > 0 && (
              <p className="text-xs text-muted-foreground">{t('importer.databasesNote')}</p>
            )}
            {phase.summary.images > 0 && (
              <p className="flex items-start gap-2 text-xs text-muted-foreground">
                <Image className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                {plural(phase.summary.images, 'importer.imagesNoteOne', 'importer.imagesNote')}
              </p>
            )}
            <DialogFooter>
              <Button variant="ghost" onClick={() => setPhase({step: 'pick'})}>
                {t('importer.back')}
              </Button>
              <Button onClick={() => void doImport(phase.doc, phase.summary)}>{t('importer.import')}</Button>
            </DialogFooter>
          </div>
        )}

        {/* ── Importing: the progress phase ──────────────────────────────── */}
        {phase.step === 'importing' && (
          <div role="status" className="flex flex-col items-center gap-2 py-10 text-center">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" aria-hidden />
            <p className="text-sm font-medium">{t('importer.importing')}</p>
            <p className="text-xs text-muted-foreground">
              {t('importer.importingDetail', {summary: summaryPhrase(phase.summary)})}
            </p>
          </div>
        )}

        {/* ── Done: result summary ───────────────────────────────────────── */}
        {phase.step === 'done' && (
          <div className="flex flex-col gap-3">
            <div className="flex items-start gap-3 rounded-lg border border-border bg-card p-3">
              <Check className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden />
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="text-sm font-medium">{t('importer.done')}</span>
                <span className="text-xs text-muted-foreground">
                  {t('importer.result', {summary: summaryPhrase(phase.summary)})}
                </span>
                {phase.summary.databases > 0 && (
                  <span className="text-xs text-muted-foreground">{t('importer.databasesResult')}</span>
                )}
                {phase.summary.images > 0 && (
                  <span className="text-xs text-muted-foreground">
                    {plural(phase.summary.images, 'importer.imagesResultOne', 'importer.imagesResult')}
                  </span>
                )}
              </div>
            </div>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setOpen(false)}>
                {t('importer.finish')}
              </Button>
              {phase.jumpTarget && (
                <Button onClick={() => viewImported(phase.jumpTarget)}>{t('importer.view')}</Button>
              )}
            </DialogFooter>
          </div>
        )}

        {/* ── Error: a friendly message, retryable ───────────────────────── */}
        {phase.step === 'error' && (
          <div className="flex flex-col gap-3">
            <p
              role="alert"
              className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-foreground"
            >
              <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden />
              {phase.message}
            </p>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setOpen(false)}>
                {t('common.cancel')}
              </Button>
              <Button onClick={() => setPhase({step: 'pick'})}>{t('importer.tryAgain')}</Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
