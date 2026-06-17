import React, {useEffect, useRef, useState} from 'react';
import * as Y from 'yjs';
import type {PageSnapshot} from '@open-book/sdk';
import {BlockEditor} from '@/blockeditor/BlockEditor';
import {
  createSeededDoc,
  decodeSnapshot,
  encodeSnapshot,
  migrateEditorJs,
  type BlockDocSnapshot,
} from '@/blockeditor/model';
import {blockSnapshotToEditorJs} from '@/blockeditor/exportBlocks';
import {computeScope} from '@/blockeditor/kit/scope';
import {buildDocumentModel} from '@/export/documentModel';
import {toMarkdown} from '@/export/toMarkdown';
import {downloadBlob} from '@/lib/download';
import {useData} from '@/data';
import {connectBroadcast} from '@/blockeditor/provider';
import {registerReactiveBlocks} from '@/blockeditor/reactiveBlocks';
import {registerArtifactKit} from '@/blockeditor/kit';
import {registerDatabaseBlock} from '@/components/database/InlineDatabaseBlock';
import {PageContextMenu} from '@/components/PageContextMenu';
import {PageProperties} from '@/components/PageProperties';
import {PageHeaderControls} from '@/components/PageHeaderControls';
import {PageCoverBanner} from '@/components/PageCover';
import {usePageThemeStyle, usePageHasBackground} from '@/components/appearance/PageCustomiseBody';
import {usePageFullWidth} from '@/lib/pageFullWidth';
import {pageFontStyle, usePageFonts} from '@/lib/pageFont';
import {setPageSaveStatus} from '@/lib/pageSaveStatus';
import {pageHasPluginManifest} from '@/plugins';
import {registerPageDocActions, type ExportKind} from '@/lib/pageDocActions';
import {registerOpenDoc} from '@/lib/openDocs';
import {registerBlockEditorDoc} from '@/lib/aiBridge';
import {SuggestHost} from '@/components/review/SuggestHost';
import {BlockReviewMarkers} from '@/components/review/BlockReviewMarkers';
import {useConfirm, usePreferences, useTranslation} from '@/providers';
import {downloadText, safeFilename} from '@/lib/download';
import {cn} from '@/lib/utils';
import {PageHeader, type PageDocumentProps} from './pageChrome';

/**
 * The CRDT block editor mounted as a page document. Speaks the same contract
 * as the EditorJS-based {@link PageDocument} (onLoad/onSave/incoming/footer),
 * so {@link ConnectedPageDocument} can swap between them per page:
 *
 *  - load: `data.blockdoc` decodes into a Y.Doc; a legacy EditorJS document
 *    migrates deterministically (seed replica keyed off the page id, so two
 *    clients migrating concurrently converge instead of duplicating).
 *  - save: local edits debounce into a full snapshot — the CRDT update plus
 *    its JSON projection — stamped `editor: 'blocks'`.
 *  - collaboration: server pushes (`incoming`) merge via Y.applyUpdate, which
 *    is idempotent and order-tolerant; same-browser tabs additionally sync
 *    instantly over the BroadcastChannel provider.
 */
registerReactiveBlocks(); // built-in reactive plugins (slider + formula)
registerArtifactKit(); // interactive artifact blocks (inputs, charts, cards)
registerDatabaseBlock(); // inline database-view embeds ("Link to database")

const BlockPageDocument: React.FC<PageDocumentProps> = ({
  onSave,
  onLoad,
  title = '',
  onTitleChange,
  icon = '📄',
  onIconChange,
  onDelete,
  incoming,
  onTitleActiveChange,
  footer,
  pageId,
  hasDatabase = false,
}) => {
  const {t} = useTranslation();
  const {preferences} = usePreferences();
  const client = useData();
  const confirm = useConfirm();
  const [doc, setDoc] = useState<Y.Doc | null>(null);
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'save failed'>('idle');
  const lastSnapshot = useRef<PageSnapshot | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The editor's positioned wrapper — inline review indicators portal into it.
  const editorWrapRef = useRef<HTMLDivElement | null>(null);

  // ── Load (or migrate) ──────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const snap = await onLoad?.();
      if (cancelled) return;
      lastSnapshot.current = snap ?? null;
      if (snap?.blockdoc) {
        setDoc(decodeSnapshot(snap.blockdoc as BlockDocSnapshot));
        return;
      }
      const legacy = (snap?.editorjs as {blocks?: {type: string; data: Record<string, unknown>}[]} | undefined)?.blocks ?? [];
      // Resolve linked-page titles first so subpage/database blocks migrate
      // into mentions that carry their real names.
      const linkedIds = [...new Set(legacy.filter((b) => b.type === 'subpage' || b.type === 'database').map((b) => b.data?.pageId).filter((v): v is string => typeof v === 'string'))];
      const pageLabels = new Map<string, string>();
      await Promise.all(
        linkedIds.map(async (linkId) => {
          const linked = await client.getPage(linkId).catch(() => null);
          if (linked?.name) pageLabels.set(linkId, linked.name);
        }),
      );
      if (cancelled) return;
      // The reactive context (cell values + the name index) rides along so
      // sliders keep their live values and expr sources resolve to names.
      setDoc(createSeededDoc(migrateEditorJs(legacy, {values: snap?.values, names: snap?.names, pageLabels}), `mig-${pageId ?? 'page'}`));
    })();
    return () => {
      cancelled = true;
    };
  }, [pageId]);  

  // ── Save local edits ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!doc || !onSave) return;
    const handler = (_update: Uint8Array, origin: unknown): void => {
      // Only local edits save; merged remote state was saved by its author.
      if (origin === 'bc-remote' || origin === 'server') return;
      if (saveTimer.current) clearTimeout(saveTimer.current);
      setStatus('saving');
      saveTimer.current = setTimeout(() => {
        const base = lastSnapshot.current ?? {editorjs: {blocks: []}, values: [], names: []};
        // Re-project the reactive context on every save: `values`/`names` are
        // what the page EXPORTS (a parent database's expr columns read them
        // via projectExports), so they must track the live document, and a
        // named live-code output must publish its computed value too — the
        // projection only carries its runtime expression.
        const projected = blockSnapshotToEditorJs({
          ...base,
          editor: 'blocks',
          blockdoc: encodeSnapshot(doc),
        });
        const values = new Map(projected.values);
        const {results} = computeScope(doc);
        for (const [, cellId] of projected.names) {
          if (values.has(cellId)) continue;
          const result = results.get(cellId);
          if (result && !result.error) values.set(cellId, result.value);
        }
        const snapshot: PageSnapshot = {...projected, values: [...values]};
        lastSnapshot.current = snapshot;
        void Promise.resolve(onSave(snapshot))
          .then(() => setStatus('saved'))
          .catch(() => setStatus('save failed'));
      }, 600);
    };
    doc.on('update', handler);
    return () => {
      doc.off('update', handler);
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [doc, onSave]);

  // ── Live collaboration ────────────────────────────────────────────────────
  // Server-pushed snapshots merge into the live doc (CRDT union, no clobber).
  const incomingVersion = useRef(0);
  useEffect(() => {
    if (!doc || !incoming || incoming.version === incomingVersion.current) return;
    incomingVersion.current = incoming.version;
    const blockdoc = incoming.data.blockdoc as BlockDocSnapshot | undefined;
    if (!blockdoc?.update) return;
    try {
      const binary = atob(blockdoc.update);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      Y.applyUpdate(doc, bytes, 'server');
    } catch {
      // malformed remote update — ignore rather than corrupt local state
    }
  }, [doc, incoming]);

  // Same-browser tabs sync instantly (and presence rides along).
  useEffect(() => {
    if (!doc || !pageId) return;
    const conn = connectBroadcast(doc, `page:${pageId}`);
    return () => conn.disconnect();
  }, [doc, pageId]);

  // A page whose code blocks include one named openbook.json is an authorable
  // plugin — surface "Export as plugin" in the menu, live as the user types.
  const [isPlugin, setIsPlugin] = useState(false);
  useEffect(() => {
    if (!doc) return;
    const check = (): void => setIsPlugin(pageHasPluginManifest(doc));
    check();
    doc.on('update', check);
    return () => doc.off('update', check);
  }, [doc]);

  // ── Export ────────────────────────────────────────────────────────────────
  // The block document projects into the EditorJS shape, then rides the same
  // pipeline as classic pages — markdown, paged/continuous PDF, and the
  // interactive HTML site (live sliders/formulas, navigable subtree). A page
  // authored as a plugin additionally exports the install-ready zip itself.
  const handleExport = async (kind: ExportKind): Promise<void> => {
    if (!doc) return;
    if (kind === 'plugin') {
      try {
        const {pageToPluginZip} = await import('@/plugins');
        const {filename, bytes} = pageToPluginZip(doc);
        downloadBlob(filename, new Blob([bytes as BlobPart], {type: 'application/zip'}));
      } catch (e) {
        void confirm({
          title: t('page.exportPluginFailed'),
          description: e instanceof Error ? e.message : String(e),
          confirmText: t('page.exportPluginFailedOk'),
          hideCancel: true,
        });
      }
      return;
    }
    const snapshot = blockSnapshotToEditorJs({
      editorjs: {blocks: []},
      values: [],
      names: [],
      editor: 'blocks',
      blockdoc: encodeSnapshot(doc),
    });
    const base = safeFilename(title);
    try {
      if (kind === 'md') {
        downloadText(`${base}.md`, toMarkdown(buildDocumentModel({title, icon, snapshot})), 'text/markdown');
      } else if (kind === 'pdf-paged' || kind === 'pdf-continuous' || kind === 'pdf-slides') {
        // PDF mirrors the HTML export (vector, selectable) rather than a separate
        // hand-drawn renderer — so it looks like the window. See export/toPdf.ts.
        const [{toPdf, toPdfSlides}, {toHtml, toSlideDeck}] = await Promise.all([
          import('@/export/toPdf'),
          import('@/export/toHtml'),
        ]);
        const blob =
          kind === 'pdf-slides'
            ? await toPdfSlides(toSlideDeck(snapshot, title, icon))
            : await toPdf(toHtml(snapshot, title, icon), kind === 'pdf-continuous' ? 'continuous' : 'paged');
        downloadBlob(`${base}${kind === 'pdf-slides' ? '-slides' : ''}.pdf`, blob);
      } else if (kind === 'html-slides') {
        const {toSlideDeck} = await import('@/export/toHtml');
        downloadText(`${base}-slides.html`, toSlideDeck(snapshot, title, icon), 'text/html');
      } else {
        const [{toHtmlSite}, {gatherSite}] = await Promise.all([import('@/export/toHtml'), import('@/export/exportSite')]);
        const bundle = pageId
          ? await gatherSite(client, pageId, {snapshot, title, icon})
          : {rootId: '', pages: [{id: '', title, icon, snapshot}]};
        downloadText(`${base}.html`, toHtmlSite(bundle), 'text/html');
      }
    } catch (e) {
      console.error('BlockPageDocument: export failed:', e);
    }
  };

  // Expose the live doc to sibling surfaces (the dataflow split view).
  useEffect(() => {
    if (!pageId || !doc) return;
    return registerOpenDoc(pageId, doc);
  }, [pageId, doc]);

  // Expose the live doc to the AI write path so approved agent proposals apply
  // as one undoable CRDT transaction against this editor (rather than the
  // savePage fallback). Unregisters on unmount / page change.
  useEffect(() => {
    if (!pageId || !doc) return;
    return registerBlockEditorDoc(pageId, doc);
  }, [pageId, doc]);

  // Publish this document's capabilities to the shell page menu (NavContextMenu).
  // The handlers route through refs so the registration only churns when the
  // *shape* changes (page or plugin-ness), not on every keystroke.
  const exportRef = useRef(handleExport);
  exportRef.current = handleExport;
  const deleteRef = useRef(onDelete);
  deleteRef.current = onDelete;
  useEffect(() => {
    if (!pageId || !doc) return;
    const kinds: ExportKind[] = ['md', 'html', 'html-slides', 'pdf-paged', 'pdf-continuous', 'pdf-slides'];
    if (isPlugin) kinds.push('plugin');
    return registerPageDocActions(pageId, {
      exportKinds: kinds,
      runExport: (kind) => exportRef.current(kind),
      deletePage: onDelete ? () => deleteRef.current?.() : undefined,
    });
  }, [pageId, doc, isPlugin, !!onDelete]);

  // Publish the save status to the shell so the page-actions cluster can show it
  // (it tracks the right pane's page when the split view is open).
  useEffect(() => {
    setPageSaveStatus(pageId, status);
    return () => setPageSaveStatus(pageId, null);
  }, [pageId, status]);

  // Full width is a per-page choice (see lib/pageFullWidth).
  const fullWidth = usePageFullWidth(pageId ?? '');
  const columnClass = cn('mx-auto w-full', fullWidth ? 'max-w-none' : 'max-w-content');

  // Per-page overrides recolor (theme) and restyle (fonts) just this page.
  const pageThemeStyle = usePageThemeStyle(pageId ?? '');
  const fontStyle = pageFontStyle(usePageFonts(pageId ?? ''));
  const hasBackground = usePageHasBackground(pageId ?? '');

  // Right-clicking the page body opens the shared page actions (favorite,
  // open in split, rename, duplicate, trash, …) — same menu as classic pages.
  const body = (
    <div
      className={cn('w-full pb-40', fontStyle && 'ob-page-fonts', hasBackground && 'ob-page-bg')}
      style={{...pageThemeStyle, ...fontStyle}}
    >
      {/* The cover + title region. Hovering it reveals the header controls
          (customise / owner / verification / backlinks) — Notion-style — so they
          stay out of the way while reading the body below. */}
      <div className="group/pagehead">
        {pageId && <PageCoverBanner pageId={pageId} />}
        <div className="px-6 pt-6 md:px-10">
          <div className={columnClass}>
            {pageId && <PageHeaderControls pageId={pageId} />}

            <PageHeader
              title={title}
              icon={icon}
              pageId={pageId}
              onTitleChange={onTitleChange}
              onIconChange={onIconChange}
              onTitleActiveChange={onTitleActiveChange}
            />
            {pageId && <PageProperties pageId={pageId} />}
          </div>
        </div>
      </div>

      <div className="px-6 md:px-10">
        <div className={columnClass}>
          <div ref={editorWrapRef} className={cn(hasDatabase ? 'min-h-0' : 'min-h-[40vh]', 'relative pt-2')}>
            {doc && (
              <BlockEditor
                doc={doc}
                ariaLabel={title || 'Page content'}
                fullWidth={fullWidth}
                compact={hasDatabase}
                spellcheck={preferences.general.spellcheck}
                pageId={pageId}
              />
            )}
            {/* Inline review affordances (provider-aware, portaled into the
                editor wrapper since the editor's own root is provider-less). */}
            {pageId && doc && <BlockReviewMarkers pageId={pageId} containerRef={editorWrapRef} />}
          </div>

          {/* Bridges the editor's inline "Suggest edit"/"Comment" menu items to
              the data client + Review pane. */}
          {pageId && doc && <SuggestHost />}

          {footer}
        </div>
      </div>
    </div>
  );

  return pageId ? <PageContextMenu pageId={pageId}>{body}</PageContextMenu> : body;
};

export default BlockPageDocument;
