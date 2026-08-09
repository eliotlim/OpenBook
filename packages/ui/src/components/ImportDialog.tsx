import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {AppWindow, Blocks, Check, FileText, Image, Loader2, TriangleAlert, Upload} from 'lucide-react';
import {notionAssetResolver, urlAssetResolver, type AssetBytes, type ImportedDoc} from '@book.dev/sdk';
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
import {Switch} from '@/components/ui/switch';
import {useData} from '@/data';
import {useHud, useNavigation, useTranslation} from '@/providers';
import {
  detectImportFormat,
  parseImportSource,
  pickImportedJumpTarget,
  runImport,
  summarizeImportedDoc,
  titleFromFileName,
  type ImportFormat,
  type ImportSummary,
  type RunImportAssetOptions,
} from '@/lib/importContent';
import {htmlToImportedDoc, parseHtmlImport} from '@/lib/htmlImport';
import {runIslandImport, summarizeIslandLedger, type HtmlIsland, type IslandLedgerOutcome} from '@/lib/islandImport';
import {useIsSettingsAdmin} from '@/components/settings/adminGate';
import {artifactChoiceFor, runArtifactImport, type ArtifactImportChoice} from '@/lib/artifactImport';
import {isImportAbortError, parseImportInWorker, type ImportParseProgress} from '@/lib/importParse';

/** Extensions the file picker offers — Notion export zips, Markdown, and HTML. */
const ACCEPT = '.zip,.md,.markdown,.mdown,.mkd,.txt,.html,.htm';

/** Which format the paste textarea is entering (Markdown or HTML). */
type PasteFormat = 'markdown' | 'html';

/**
 * The import flow, as a small state machine. `pick` offers the file picker (and
 * paste-Markdown / paste-HTML affordances); reading/parsing produces a `preview` of what
 * will land; the user confirms into `importing` (the progress phase); `done`
 * shows the result summary plus a jump to the first top-level imported page.
 * Any failure becomes a friendly `error` the user can retry from — never a
 * thrown crash.
 */
/** A detected OpenBook export island, staged for a lossless restore: the parsed
 *  island plus the asset bytes recovered from the file's own data-URIs. */
interface IslandPayload {
  found: HtmlIsland;
  assets: Map<string, AssetBytes>;
}

type Phase =
  | {step: 'pick'}
  | {step: 'reading'; progress?: ImportParseProgress}
  | {
      step: 'preview';
      doc: ImportedDoc | null;
      summary: ImportSummary;
      sourceLabel: string;
      format: ImportFormat;
      zipBytes?: Uint8Array;
      /** Present when the file carries an OpenBook source island — the import
       *  restores losslessly from it, skipping the HTML conversion entirely. */
      island?: IslandPayload;
      /** Present for a foreign (no-island) `.html` file: the run-as-artifact
       *  choice payload. The chooser is offered ONLY when this is set —
       *  island files never see it (see artifactChoiceFor, the one seam). */
      artifact?: ArtifactImportChoice;
    }
  | {step: 'importing'; summary: ImportSummary}
  | {step: 'done'; summary: ImportSummary; jumpTarget: string | null; ledger?: IslandLedgerOutcome}
  | {step: 'error'; message: string};

/**
 * "Bring your content" — import a Notion export (.zip), a Markdown (.md), or an
 * HTML (.html) file into the library (OB-301/303). Format is auto-detected from
 * the file; the SDK importers (`notionExportToImportedDoc` / `markdownToImportedDoc`)
 * and the UI's `htmlToImportedDoc` parse to the format-agnostic IR, and `importDoc`
 * lands it through the existing data paths, picking the create-vs-bundle strategy
 * itself. Opened from the HUD (Home quick action, command palette, or Settings →
 * Admin).
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
  const [pasteFormat, setPasteFormat] = useState<PasteFormat>('markdown');
  // Opt-in: fetch each linked (http) image and store a copy in the library
  // (default off — a linked image is kept as a URL that loads from the web).
  const [downloadUrls, setDownloadUrls] = useState(false);
  // For a foreign `.html` file: land it as a sandboxed interactive artifact
  // (true) or convert it to editable blocks (false). Preselected by the
  // script/canvas heuristic when the preview opens; the user can flip it.
  const [runAsArtifact, setRunAsArtifact] = useState(false);
  // LX-4: also restore the export's embedded ledger records (offered only when
  // a space island carries a coherent section; default on — the user asked for
  // their content back, and a non-empty target refuses server-side anyway).
  const [restoreLedger, setRestoreLedger] = useState(true);
  // The restore route is instance-administration gated server-side; a CONFIRMED
  // non-admin gets a plain note instead of a toggle that could only ever fail.
  // `null` (probe in flight / inconclusive) keeps the toggle — the server gate
  // stays authoritative.
  const isAdmin = useIsSettingsAdmin();

  // Reset to a clean picker each time the dialog opens, so a previous import's
  // result or error never greets the next one; abort any parse still running
  // when it closes.
  useEffect(() => {
    if (open) {
      setPhase({step: 'pick'});
      setPasteOpen(false);
      setPasteText('');
      setPasteFormat('markdown');
      setDownloadUrls(false);
      setRunAsArtifact(false);
      setRestoreLedger(true);
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
    (
      doc: ImportedDoc | null,
      summary: ImportSummary,
      sourceLabel: string,
      format: ImportFormat,
      zipBytes?: Uint8Array,
      island?: IslandPayload,
      artifact?: ArtifactImportChoice,
    ) => {
      // Run-as-artifact needs no convertible content — an empty-body but
      // script-bearing file still lands verbatim; only a pure conversion with
      // nothing to convert is a dead end.
      if (summary.pages === 0 && !artifact) {
        setPhase({step: 'error', message: t('importer.empty')});
        return;
      }
      setDownloadUrls(false);
      setRunAsArtifact(artifact?.preferArtifact ?? false);
      setPhase({step: 'preview', doc, summary, sourceLabel, format, zipBytes, island, artifact});
    },
    [t],
  );

  const onFile = useCallback(
    async (file: File) => {
      const format = detectImportFormat(file.name);
      if (!format) {
        setPhase({step: 'error', message: t('importer.unsupported')});
        return;
      }
      setPhase({step: 'reading'});
      // HTML parses on the MAIN thread: an OpenBook export's source island is
      // detected FIRST (a pure string scan — a hit means a lossless restore
      // that skips the HTML conversion entirely); foreign HTML falls back to
      // the editor's DOM-based `htmlToBlocks`, which needs the live `document`
      // the import worker lacks. A single HTML document is light, so an inline
      // parse (like pasted Markdown) is fine; no worker, no abort controller.
      if (format === 'html') {
        try {
          const text = await file.text();
          const parsed = parseHtmlImport(text, {defaultTitle: titleFromFileName(file.name) || undefined});
          if (parsed.kind === 'island') {
            toPreview(null, parsed.summary, file.name, format, undefined, {found: parsed.island, assets: parsed.assets});
          } else {
            // Foreign HTML: offer the run-as-artifact vs convert choice
            // (island files never reach here — `artifactChoiceFor` is the seam).
            const artifact = artifactChoiceFor(parsed, text, file.name) ?? undefined;
            toPreview(parsed.doc, summarizeImportedDoc(parsed.doc), file.name, format, undefined, undefined, artifact);
          }
        } catch (e) {
          setPhase({step: 'error', message: t('importer.parseFailed', {error: (e as Error).message})});
        }
        return;
      }
      // Notion/Markdown: heavy work (unzip + parse + IR + summarize) runs in a Web
      // Worker so a big import doesn't freeze the UI; the spinner stays live and
      // shows the parse's progress. Falls back to a main-thread parse if a worker
      // can't be hosted (e.g. a webview that rejects the worker). A fresh
      // controller per parse; aborting it (on close/unmount) terminates the
      // worker. Cancel any prior parse first.
      parseAbortRef.current?.abort();
      const controller = new AbortController();
      parseAbortRef.current = controller;
      try {
        const source =
          format === 'notion-zip'
            ? ({format, bytes: new Uint8Array(await file.arrayBuffer()), fileName: file.name} as const)
            : ({format, text: await file.text(), fileName: file.name} as const);
        const {doc, summary} = await parseImportInWorker(source, {
          signal: controller.signal,
          onProgress: (progress) => setPhase({step: 'reading', progress}),
        });
        // Keep the zip bytes so a confirmed import can rehydrate its images from
        // the export (the bytes never crossed into the worker's discarded unzip).
        toPreview(doc, summary, file.name, format, format === 'notion-zip' ? source.bytes : undefined);
      } catch (e) {
        // The dialog closed mid-parse — it's unmounting/reset, so show nothing.
        if (isImportAbortError(e)) return;
        setPhase({step: 'error', message: t('importer.parseFailed', {error: (e as Error).message})});
      }
    },
    [t, toPreview],
  );

  // Pasted content is small by nature, so it parses inline (no worker spin-up):
  // Markdown via the pure parser the worker wraps, HTML via the DOM-based
  // `htmlToImportedDoc` — both on the main thread.
  const onPaste = useCallback(() => {
    if (!pasteText.trim()) {
      setPhase({step: 'error', message: t('importer.emptyPaste')});
      return;
    }
    try {
      const doc =
        pasteFormat === 'html'
          ? htmlToImportedDoc(pasteText)
          : parseImportSource({format: 'markdown', text: pasteText});
      const label = t(pasteFormat === 'html' ? 'importer.pastedHtmlLabel' : 'importer.pastedLabel');
      toPreview(doc, summarizeImportedDoc(doc), label, pasteFormat);
    } catch (e) {
      setPhase({step: 'error', message: t('importer.parseFailed', {error: (e as Error).message})});
    }
  }, [pasteText, pasteFormat, t, toPreview]);

  const doImport = useCallback(
    async (
      doc: ImportedDoc | null,
      summary: ImportSummary,
      format: ImportFormat,
      zipBytes?: Uint8Array,
      island?: IslandPayload,
      artifact?: ArtifactImportChoice,
    ) => {
      if (importingRef.current) return;
      importingRef.current = true;
      setPhase({step: 'importing', summary});
      try {
        let result: {pageIds: string[]};
        let ledger: IslandLedgerOutcome | undefined;
        if (artifact) {
          // Run as interactive artifact: the file lands VERBATIM — a new page
          // holding one sandboxed htmlArtifact block over the stored bytes.
          result = await runArtifactImport(client, artifact);
        } else if (island) {
          // An OpenBook export: restore losslessly from its source island (the
          // block-doc, structure, and databases land verbatim as a copy), then
          // re-store the asset bytes recovered from the file's own data-URIs
          // (content addressing restores the exact ids the blocks reference).
          // LX-4: embedded ledger records restore too when the user kept the
          // toggle on and the section previews as a coherent book — into an
          // EMPTY ledger only (a non-empty target refuses server-side and is
          // reported below; the page import always stands on its own).
          const ledgerOk = summarizeIslandLedger(island.found)?.ok === true;
          const landed = await runIslandImport(client, island.found, island.assets, {
            restoreLedger: restoreLedger && ledgerOk && isAdmin !== false,
          });
          ledger = landed.ledger;
          result = landed;
        } else if (doc) {
          // Wire the image-rehydration seam: a Notion export uploads its embedded
          // bytes; a Markdown/HTML import preserves linked images as URLs unless the
          // user opted to download a copy into the library.
          const assetOpts: RunImportAssetOptions =
            format === 'notion-zip' && zipBytes
              ? {resolveAssetBytes: notionAssetResolver(zipBytes)}
              : downloadUrls
                ? {resolveAssetBytes: urlAssetResolver(), downloadUrls: true}
                : {};
          result = await runImport(client, doc, assetOpts);
        } else {
          return; // unreachable: a preview always carries a doc or an island
        }
        // Reload first, then resolve the jump target against the fresh nav list
        // (rows excluded) so "view imported" can only ever land on a real page.
        const pages = await reload();
        setPhase({step: 'done', summary, jumpTarget: pickImportedJumpTarget(result, pages), ...(ledger ? {ledger} : {})});
      } catch (e) {
        setPhase({step: 'error', message: t('importer.importFailed', {error: (e as Error).message})});
      } finally {
        importingRef.current = false;
      }
    },
    [client, downloadUrls, isAdmin, reload, restoreLedger, t],
  );

  // LX-4: what the staged island says about embedded ledger records — `null`
  // when there are none, a tally when they preview as a coherent book, or the
  // refusal reason when they don't (the same validator the server runs).
  const ledgerPreview = useMemo(
    () => (phase.step === 'preview' && phase.island ? summarizeIslandLedger(phase.island.found) : null),
    [phase],
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
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>{t('importer.title')}</DialogTitle>
          <DialogDescription>{t('importer.description')}</DialogDescription>
        </DialogHeader>

        {/* ── Pick: choose a file, or paste Markdown / HTML ──────────────── */}
        {phase.step === 'pick' && (
          <div className="flex flex-col gap-4">
            <button
              type="button"
              onClick={() => fileInput.current?.click()}
              className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border bg-muted px-4 py-8 text-center transition-[background-color,border-color,box-shadow] hover:border-foreground/20 hover:bg-hover focus-visible:outline-hidden focus-visible:shadow-[var(--ring-control)]"
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
                  placeholder={t(pasteFormat === 'html' ? 'importer.pasteHtmlPlaceholder' : 'importer.pastePlaceholder')}
                  rows={6}
                  aria-label={t(pasteFormat === 'html' ? 'importer.pasteHtmlToggle' : 'importer.pasteToggle')}
                  className="w-full resize-y rounded-md border border-border bg-background px-3 py-2 text-sm focus-visible:outline-hidden focus-visible:shadow-[var(--ring-control)]"
                />
                <div className="flex justify-end">
                  <Button size="sm" onClick={onPaste} disabled={!pasteText.trim()}>
                    {t('importer.pasteImport')}
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
                <button
                  type="button"
                  onClick={() => {
                    setPasteFormat('markdown');
                    setPasteOpen(true);
                  }}
                  className="underline-offset-4 transition-colors hover:text-foreground hover:underline"
                >
                  {t('importer.pasteToggle')}
                </button>
                <span aria-hidden className="text-muted-foreground/50">
                  ·
                </span>
                <button
                  type="button"
                  onClick={() => {
                    setPasteFormat('html');
                    setPasteOpen(true);
                  }}
                  className="underline-offset-4 transition-colors hover:text-foreground hover:underline"
                >
                  {t('importer.pasteHtmlToggle')}
                </button>
              </div>
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
                  {/* Run-as-artifact lands exactly one page holding the file —
                      showing the CONVERSION tally there would contradict the
                      "nothing is converted" note below. */}
                  {t('importer.preview', {
                    summary: summaryPhrase(
                      runAsArtifact && phase.artifact ? {pages: 1, databases: 0, rows: 0, images: 0} : phase.summary,
                    ),
                  })}
                </span>
              </div>
            </div>
            {/* An OpenBook export restores exactly from its embedded source —
                the conversion notes below don't apply. */}
            {phase.island && <p className="text-xs text-muted-foreground">{t('importer.losslessNote')}</p>}
            {/* LX-4: the export carries ledger records. A CONFIRMED non-admin
                gets the plain fact (the restore route is admin-gated) instead
                of a toggle that could only land in `failed`. */}
            {ledgerPreview?.ok && isAdmin === false && (
              <p className="text-xs text-muted-foreground">{t('importer.ledgerAdminOnly')}</p>
            )}
            {/* Otherwise: offer the restore (empty-ledger only; the server
                refuses a non-empty target). */}
            {ledgerPreview?.ok && isAdmin !== false && (
              <label className="flex items-start justify-between gap-3 rounded-lg border border-border bg-muted p-3">
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-sm font-medium">{t('importer.ledgerToggle')}</span>
                  <span className="text-xs text-muted-foreground">
                    {t('importer.ledgerToggleHint', {
                      accounts: plural(ledgerPreview.accounts, 'importer.ledgerAccountsOne', 'importer.ledgerAccounts'),
                      entries: plural(ledgerPreview.entries, 'importer.ledgerEntriesOne', 'importer.ledgerEntries'),
                    })}
                  </span>
                  {ledgerPreview.evidenceDropped > 0 && (
                    <span className="text-xs text-muted-foreground">{t('importer.ledgerEvidenceNote')}</span>
                  )}
                </span>
                <Switch
                  checked={restoreLedger}
                  onCheckedChange={setRestoreLedger}
                  aria-label={t('importer.ledgerToggle')}
                  className="mt-0.5"
                />
              </label>
            )}
            {/* Records present but incoherent: said plainly, never half-landed. */}
            {ledgerPreview && !ledgerPreview.ok && (
              <p className="flex items-start gap-2 text-xs text-muted-foreground">
                <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                {t('importer.ledgerUnreadable', {reason: ledgerPreview.reason})}
              </p>
            )}
            {/* Foreign .html: run-as-artifact vs convert-to-blocks. Preselected
                by the script/canvas heuristic; island files never offer this.
                Native radios inside label cards (the AiSettings provider-picker
                pattern), so arrow-key navigation and the single tab stop come
                from the browser instead of a hand-rolled radio contract. */}
            {phase.artifact && (
              <div role="radiogroup" aria-label={t('importer.htmlModeLabel')} className="flex flex-col gap-2">
                {(
                  [
                    {artifact: true, icon: AppWindow, label: 'importer.artifactOption', hint: 'importer.artifactOptionHint'},
                    {artifact: false, icon: Blocks, label: 'importer.convertOption', hint: 'importer.convertOptionHint'},
                  ] as const
                ).map((opt) => {
                  const selected = runAsArtifact === opt.artifact;
                  const Icon = opt.icon;
                  return (
                    <label
                      key={opt.label}
                      className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-[background-color,border-color,box-shadow] ${
                        selected ? 'border-primary bg-primary/5' : 'border-border bg-muted hover:bg-hover'
                      }`}
                    >
                      <Icon
                        className={`mt-0.5 h-5 w-5 shrink-0 ${selected ? 'text-primary' : 'text-muted-foreground'}`}
                        aria-hidden
                      />
                      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span className="text-sm font-medium">{t(opt.label)}</span>
                        <span className="text-xs text-muted-foreground">{t(opt.hint)}</span>
                      </span>
                      <input
                        type="radio"
                        name="html-import-mode"
                        className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
                        checked={selected}
                        onChange={() => setRunAsArtifact(opt.artifact)}
                      />
                    </label>
                  );
                })}
              </div>
            )}
            {/* Tie the preselection to the file: scripts suggested the default. */}
            {phase.artifact?.preferArtifact && (
              <p className="text-xs text-muted-foreground">{t('importer.artifactHeuristicNote')}</p>
            )}
            {phase.artifact && runAsArtifact && (
              <p className="text-xs text-muted-foreground">{t('importer.artifactNote')}</p>
            )}
            {phase.summary.databases > 0 && !phase.island && !runAsArtifact && (
              <p className="text-xs text-muted-foreground">{t('importer.databasesNote')}</p>
            )}
            {phase.summary.images > 0 && !phase.island && !runAsArtifact && (
              <p className="flex items-start gap-2 text-xs text-muted-foreground">
                <Image className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                {plural(phase.summary.images, 'importer.imagesNoteOne', 'importer.imagesNote')}
              </p>
            )}
            {/* Opt-in: store a copy of linked (http) images — Notion images are
                always stored (and island imports recover their own bytes), so
                the toggle is only offered for converted Markdown/HTML. */}
            {phase.summary.images > 0 && phase.format !== 'notion-zip' && !phase.island && !runAsArtifact && (
              <label className="flex items-start justify-between gap-3 rounded-lg border border-border bg-muted p-3">
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-sm font-medium">{t('importer.downloadImages')}</span>
                  <span className="text-xs text-muted-foreground">{t('importer.downloadImagesHint')}</span>
                </span>
                <Switch
                  checked={downloadUrls}
                  onCheckedChange={setDownloadUrls}
                  aria-label={t('importer.downloadImages')}
                  className="mt-0.5"
                />
              </label>
            )}
            <DialogFooter>
              <Button variant="ghost" onClick={() => setPhase({step: 'pick'})}>
                {t('importer.back')}
              </Button>
              <Button
                onClick={() =>
                  void doImport(
                    phase.doc,
                    // Run-as-artifact lands exactly one page holding the file —
                    // the conversion tallies don't apply.
                    runAsArtifact && phase.artifact ? {pages: 1, databases: 0, rows: 0, images: 0} : phase.summary,
                    phase.format,
                    phase.zipBytes,
                    phase.island,
                    runAsArtifact ? phase.artifact : undefined,
                  )
                }
              >
                {t('importer.import')}
              </Button>
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
                {/* LX-4: how the ledger half ended, when it ran. */}
                {phase.ledger?.status === 'restored' && (
                  <span className="text-xs text-muted-foreground">
                    {t('importer.ledgerRestored', {
                      accounts: plural(phase.ledger.result.restored.accounts, 'importer.ledgerAccountsOne', 'importer.ledgerAccounts'),
                      entries: plural(phase.ledger.result.restored.transactions, 'importer.ledgerEntriesOne', 'importer.ledgerEntries'),
                    })}
                  </span>
                )}
                {phase.ledger?.status === 'restored' && phase.ledger.result.evidenceDropped > 0 && (
                  <span className="text-xs text-muted-foreground">
                    {plural(phase.ledger.result.evidenceDropped, 'importer.ledgerEvidenceDroppedOne', 'importer.ledgerEvidenceDropped')}
                  </span>
                )}
              </div>
            </div>
            {/* A refused / failed ledger restore never costs the page import —
                but it must be SAID, with the server's actionable reason. */}
            {(phase.ledger?.status === 'refused' || phase.ledger?.status === 'failed') && (
              <p
                role="alert"
                className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-xs text-foreground"
              >
                <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
                {t(phase.ledger.status === 'refused' ? 'importer.ledgerRefused' : 'importer.ledgerFailed', {
                  error: phase.ledger.message,
                })}
              </p>
            )}
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
