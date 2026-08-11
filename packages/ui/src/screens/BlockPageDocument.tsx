import React, {useCallback, useEffect, useRef, useState} from 'react';
import * as Y from 'yjs';
import type {PageSnapshot} from '@book.dev/sdk';
import {ICON_PROPERTY_ID, gatherLedgerExportSection} from '@book.dev/sdk';
import {BlockEditor, type BlockEditorHandle, type LocalSelection} from '@/blockeditor/BlockEditor';
import {
  createSeededDoc,
  decodeSnapshot,
  encodeSnapshot,
  migrateLegacyBlocks,
  type BlockDocSnapshot,
} from '@/blockeditor/model';
import {projectSnapshotForExport} from '@/blockeditor/exportBlocks';
import {projectBlockPageSnapshot} from '@/blockeditor/saveProjection';
import {resolveDbChartSeries} from '@/blockeditor/kit/chartData';
import {computeExportCells} from '@/blockeditor/kit/scope';
import {buildDocumentModel} from '@/export/documentModel';
import {toMarkdown} from '@/export/toMarkdown';
import {resolveExportAssets} from '@/export/exportAssets';
import {downloadBlob} from '@/lib/download';
import {useData} from '@/data';
import {useCanWrite} from '@/lib/useCanWrite';
import {connectBroadcast} from '@/blockeditor/provider';
import {connectPageRelay} from '@/blockeditor/relay';
import {connectPageSaver} from '@/blockeditor/saver';
import {connectPageAwareness, blockSelection} from '@/blockeditor/awareness';
import {registerOpenAwareness, openAwareness, subscribeOpenAwareness} from '@/lib/openAwareness';
import {PresenceAvatars} from '@/components/presence/PresenceAvatars';
import {RemoteCursors} from '@/components/presence/RemoteCursors';
import {registerReactiveBlocks} from '@/blockeditor/reactiveBlocks';
import {registerArtifactKit} from '@/blockeditor/kit';
import {registerDatabaseBlock} from '@/components/database/InlineDatabaseBlock';
import {FormOriginContext, formOriginUrl, registerFormBlock} from '@/blockeditor/FormBlockView';
import {PageContextMenu} from '@/components/PageContextMenu';
import {ExportBooksDialog, type ExportBooksChoice} from '@/components/ExportBooksDialog';
import {PageProperties} from '@/components/PageProperties';
import {PageHeaderControls} from '@/components/PageHeaderControls';
import {PageCoverBanner} from '@/components/PageCover';
import {usePageThemeStyle, usePageHasBackground} from '@/components/appearance/PageCustomiseBody';
import {usePageFullWidth} from '@/lib/pageFullWidth';
import {pageFontStyle, usePageFonts} from '@/lib/pageFont';
import {setPageSaveStatus} from '@/lib/pageSaveStatus';
import {showToast} from '@/components/ui/toast';
import {pageHasPluginManifest} from '@/plugins';
import {registerPageDocActions, type ExportKind} from '@/lib/pageDocActions';
import {registerOpenDoc} from '@/lib/openDocs';
import {registerBlockEditorDoc} from '@/lib/aiBridge';
import {SuggestHost} from '@/components/review/SuggestHost';
import {BlockReviewMarkers} from '@/components/review/BlockReviewMarkers';
import {useConfirm, useNavigation, usePreferences, useTheme, useTranslation} from '@/providers';
import {downloadText, safeFilename} from '@/lib/download';
import {cn} from '@/lib/utils';
import {PageHeader, type PageDocumentProps, type PageTitleHandle} from './pageChrome';

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
registerFormBlock(); // provider-aware form shell (database summary + frozen preview)

/**
 * Honour a pending `blockAnchor` (a search pick, a copied block link, or
 * `?block=`): once this document is the primary page and its blocks have
 * rendered, scroll the target block into view and flash it, then consume the
 * anchor. Mirrors the DatabaseView row/group anchor (rAF-retry for async layout,
 * CSS.escape for the selector, single-fire), scoped to this editor's wrapper so
 * a split view resolves to the right copy.
 */
function useBlockAnchor(
  pageId: string | undefined,
  containerRef: React.RefObject<HTMLElement | null>,
  notReady: boolean,
): void {
  const {blockAnchor, clearBlockAnchor, primaryPageId} = useNavigation();
  useEffect(() => {
    if (notReady || !blockAnchor || !pageId || pageId !== primaryPageId) return;
    const escaped =
      typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
        ? CSS.escape(blockAnchor)
        : blockAnchor.replace(/["\\]/g, '\\$&');
    const selector = `[data-block-row="${escaped}"]`;
    let tries = 0;
    let raf = 0;
    let timer = 0;
    const attempt = (): void => {
      const root: ParentNode = containerRef.current ?? document;
      let el: Element | null;
      try {
        el = root.querySelector(selector);
      } catch {
        clearBlockAnchor();
        return;
      }
      if (el) {
        const reduce =
          typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
        el.scrollIntoView({behavior: reduce ? 'auto' : 'smooth', block: 'center'});
        el.classList.add('ob-anchor-flash');
        timer = window.setTimeout(() => el!.classList.remove('ob-anchor-flash'), 1800);
        clearBlockAnchor();
        return;
      }
      // Give an async-loading document a few frames to render its blocks before
      // giving up; then clear so a missing target doesn't re-fire forever.
      if (++tries > 20) {
        clearBlockAnchor();
        return;
      }
      raf = requestAnimationFrame(attempt);
    };
    raf = requestAnimationFrame(attempt);
    return () => {
      cancelAnimationFrame(raf);
      if (timer) clearTimeout(timer);
    };
  }, [blockAnchor, clearBlockAnchor, primaryPageId, pageId, notReady, containerRef]);
}

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
  const {appearance} = useTheme();
  const client = useData();
  const confirm = useConfirm();
  // A viewer who can't write this instance reads the whole document locked: no
  // edit chrome, interactive widgets still live (OB-205). Coarse + server-enforced
  // — see useCanWrite. Defaults writable, so the owner case never flashes locked.
  const canWrite = useCanWrite();
  const [doc, setDoc] = useState<Y.Doc | null>(null);
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'save failed'>('idle');
  const lastSnapshot = useRef<PageSnapshot | null>(null);
  // The editor's positioned wrapper — inline review indicators portal into it.
  const editorWrapRef = useRef<HTMLDivElement | null>(null);
  // The title and the editor form one continuous caret surface: each holds an
  // imperative handle so Enter/↓ in the title jumps into the first block, and
  // ↑/Backspace at the editor's top jumps back to the end of the title.
  const titleRef = useRef<PageTitleHandle>(null);
  const editorRef = useRef<BlockEditorHandle>(null);
  // The live awareness connection (Collab T5), so the editor's local-caret
  // callback can publish this user's selection for peers to render.
  const awarenessRef = useRef<ReturnType<typeof connectPageAwareness> | null>(null);
  // Stable identities — both refs never change, but a fresh arrow each render
  // would. onLeaveToTitle is a dep of BlockEditor's `ui` useMemo, so an unstable
  // one rebuilds that surface on every render (e.g. each save-status tick).
  const leaveToTitle = useCallback(() => titleRef.current?.focusEnd(), []);
  const leaveToEditor = useCallback(() => editorRef.current?.focusStart(), []);

  // Scroll/flash a block when navigated here with a pending block anchor (a
  // search pick or a copied block link). Waits for the doc to decode + render.
  useBlockAnchor(pageId, editorWrapRef, !doc);

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
      setDoc(createSeededDoc(migrateLegacyBlocks(legacy, {values: snap?.values, names: snap?.names, pageLabels}), `mig-${pageId ?? 'page'}`));
    })();
    return () => {
      cancelled = true;
    };
  }, [pageId]);  

  // ── Save local edits ──────────────────────────────────────────────────────
  // Project the live doc into the durable snapshot and persist it (the single
  // checkpoint behind the live relay). Resolves on a save (or a no-op skip), REJECTS
  // on failure — the saver controller relies on that to keep this client "unconfirmed"
  // and retry. Called by {@link connectPageSaver}, never directly on every keystroke,
  // so the timing/election lives in one place.
  const performSave = useCallback(async (): Promise<void> => {
    if (!doc || !onSave) return;
    const prev = lastSnapshot.current;
    const base = prev ?? {editorjs: {blocks: []}, values: [], names: []};
    // Re-project the reactive context on every save: `values`/`names` are what the page
    // EXPORTS (a parent database's expr columns read them via projectExports), so they
    // must track the live document, and a named live-code output must publish its
    // computed value too — the projection only carries its runtime expression.
    const snapshot = await projectBlockPageSnapshot(doc, base);
    // Skip a no-op save: a Y.Doc change that nets to no difference in what the page
    // persists (an undo/redo round-trip, an edit to an unprojected prop, or a recompute
    // yielding identical values) shouldn't write — re-saving identical content only
    // churns a dead row version, and PGlite has no autovacuum to reclaim it (OB-164).
    // Same projection order each time, so a JSON compare is exact.
    if (prev && JSON.stringify(snapshot) === JSON.stringify(prev)) {
      setStatus('saved');
      return;
    }
    lastSnapshot.current = snapshot;
    setStatus('saving');
    try {
      await onSave(snapshot);
      setStatus('saved');
    } catch (e) {
      setStatus('save failed');
      throw e;
    }
  }, [doc, onSave]);
  // The controller calls the latest projection without re-subscribing every render.
  const performSaveRef = useRef(performSave);
  performSaveRef.current = performSave;

  // Track the live awareness INSTANCE for this page (registered by the awareness effect
  // below). Only re-renders when it (un)registers — not on every cursor move — so the
  // saver controller re-binds to the real presence once it's up, and runs solo before.
  const [awarenessInstance, setAwarenessInstance] = useState(() => openAwareness(pageId));
  useEffect(() => {
    const sync = (): void => setAwarenessInstance(openAwareness(pageId));
    sync();
    return subscribeOpenAwareness(sync);
  }, [pageId]);

  // ── Single-saver election (Collab T3) ──────────────────────────────────────
  // With N concurrent editors the relay converges every doc live, but each one still
  // debounce-saves the WHOLE snapshot on its own edits → N overlapping whole-snapshot
  // writes per burst (OB-164/OB-242 write-amp) where ONE save persists the same
  // converged doc for everyone. connectPageSaver elects a single saver per page (the
  // lowest-clientID present writer, surfaced through awareness): only it runs the
  // debounced save, persisting the converged doc whoever authored the change; the rest
  // skip it (their edits relay into the saver's doc + are persisted there). Handover on
  // saver-leave (next writer dirty-on-election saves), the last writer standing / an
  // offline client (no awareness) always saves, and a degraded-relay backstop keeps a
  // non-saver saving its own edits when the saver can't confirm them — never a lost
  // edit. See blockeditor/saver.ts.
  //
  // Runs UNCONDITIONALLY for a write-capable OR read-only client (no `!canWrite`
  // guard): the controller already no-ops a viewer (never elected, never saves), and
  // running it is what lets a viewer publish `canWrite:false` to peers. `useCanWrite`
  // defaults `true` while it loads, so without this a client that resolves to a viewer
  // would leak a stale `canWrite:true` into awareness (the true→false re-run would just
  // early-return and never republish), letting it win the election ~1/N, 403 every
  // save, and strand real writers on the backstop — defeating the write-amp win.
  useEffect(() => {
    if (!doc || !onSave) return;
    const conn = connectPageSaver(doc, awarenessInstance ?? null, {
      canWrite,
      save: () => performSaveRef.current(),
      onPending: () => setStatus('saving'),
      onPersisted: () => setStatus('saved'),
    });
    return () => conn.disconnect();
  }, [doc, onSave, canWrite, awarenessInstance]);

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

  // Cross-device live collaboration (Collab T2): incremental Yjs updates over the
  // existing SSE-down / POST-up transport — a late-joiner sync handshake on connect,
  // then live convergence between the 600ms snapshot saves (not on them). Augments
  // the same-browser BroadcastChannel above; the snapshot save stays the durable
  // checkpoint and the backstop when the transport degrades. See blockeditor/relay.ts.
  useEffect(() => {
    if (!doc || !pageId) return;
    const conn = connectPageRelay(doc, pageId, client);
    return () => conn.disconnect();
  }, [doc, pageId, client]);

  // Live presence/awareness (Collab T4): publish this user's identity + selection
  // and receive peers' over the read-gated awareness channel (so viewers appear
  // present too), then register the awareness instance so the remote-cursor layer
  // (Collab T5) can read peers + selections. Ephemeral — torn down (no ghost cursor)
  // on unmount.
  //
  // The colour/key SEED is the server-resolved principal SUBJECT (`instance.you`),
  // NOT the display name — so this client's own cursor + its same-browser tabs render
  // the EXACT colour/id the server stamps onto us for every network peer (the server
  // derives both from `principalId(principal)`). The display name stays the profile
  // label; the server re-stamps identity for everyone else, so it can't be spoofed.
  const presenceName = (preferences.profile.displayName || preferences.profile.name || 'You').trim() || 'You';
  useEffect(() => {
    if (!doc || !pageId) return;
    let conn: ReturnType<typeof connectPageAwareness> | null = null;
    let unregister: (() => void) | null = null;
    let cancelled = false;
    void (async () => {
      // Resolve who the server says we are (subject + name) so the self-seed matches
      // the server's awareness stamp exactly; fall back to the profile label offline.
      const you = await client.getInstanceInfo().then((i) => i.you).catch(() => null);
      if (cancelled || !doc || !pageId) return;
      const seed = you?.subject || presenceName;
      const name = (you?.name || presenceName).trim() || presenceName;
      conn = connectPageAwareness(doc, pageId, client, {name, id: seed});
      awarenessRef.current = conn;
      unregister = registerOpenAwareness(pageId, conn.awareness);
    })();
    return () => {
      cancelled = true;
      unregister?.();
      conn?.disconnect();
      if (awarenessRef.current === conn) awarenessRef.current = null;
    };
  }, [doc, pageId, client, presenceName]);

  // The editor's local caret → presence: publish this user's selection (built as
  // Y.RelativePositions so it survives concurrent edits) so peers render it as a
  // remote cursor; null clears it on blur. Throttling lives in the editor.
  const handleLocalSelection = useCallback(
    (sel: LocalSelection | null): void => {
      const conn = awarenessRef.current;
      if (!conn || !doc) return;
      conn.setSelection(sel ? blockSelection(doc, sel.blockId, sel.anchor, sel.head) : null);
    },
    [doc],
  );

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

  // LX-2: the "Include your books" step of an interactive-HTML export. Shown
  // only when the export set contains ledger blocks; resolves to the exporter's
  // choice (or null on cancel). Promise-based like ConfirmProvider so the
  // export flow simply awaits it.
  const [booksDialog, setBooksDialog] = useState<{canInclude: boolean; defaultOn: boolean} | null>(null);
  const booksResolverRef = useRef<((choice: ExportBooksChoice) => void) | null>(null);
  const askExportBooks = useCallback((canInclude: boolean, defaultOn: boolean): Promise<ExportBooksChoice> => {
    booksResolverRef.current?.(null); // a fresh request supersedes a stale one
    return new Promise<ExportBooksChoice>((resolve) => {
      booksResolverRef.current = resolve;
      setBooksDialog({canInclude, defaultOn});
    });
  }, []);
  const settleExportBooks = useCallback((choice: ExportBooksChoice) => {
    booksResolverRef.current?.(choice);
    booksResolverRef.current = null;
    setBooksDialog(null);
  }, []);

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
    // Resolve database-bound kit charts to their series live, via this in-app
    // client, and thread them through the projection. Nothing is written to the
    // doc — a DB chart persists no snapshot, so viewing/presenting is write-free.
    const encoded = encodeSnapshot(doc);
    const dbSeries = await resolveDbChartSeries(client, encoded.blocks ?? []);
    const computed = await computeExportCells(doc, dbSeries);
    const snapshot = projectSnapshotForExport({
      editorjs: {blocks: []},
      values: [],
      names: [],
      editor: 'blocks',
      blockdoc: encoded,
    }, dbSeries, computed);
    const base = safeFilename(title);
    // Identity stamped into a single-page/deck export's source island (so a saved
    // page re-imports onto its own id). Unsaved pages leave it blank — the island
    // still round-trips the content losslessly.
    const meta = {id: pageId};
    try {
      if (kind === 'md') {
        // Resolve image assets (assetId → data-URI) up front so every renderer
        // embeds the picture rather than a dangling reference. Markdown has no
        // sandboxed-iframe equivalent, so only the image map applies here.
        const assets = await resolveExportAssets(client, [snapshot]);
        downloadText(`${base}.md`, toMarkdown(buildDocumentModel({title, icon, snapshot, assets: assets.images, dbSeries})), 'text/markdown');
      } else if (kind === 'pdf-paged' || kind === 'pdf-continuous' || kind === 'pdf-slides') {
        // PDF mirrors the HTML export (vector, selectable) rather than a separate
        // hand-drawn renderer — so it looks like the window. See export/toPdf.ts.
        const [{toPdf, toPdfSlides}, {toHtml, toSlideDeck}, assets] = await Promise.all([
          import('@/export/toPdf'),
          import('@/export/toHtml'),
          resolveExportAssets(client, [snapshot]),
        ]);
        const blob =
          kind === 'pdf-slides'
            ? await toPdfSlides(toSlideDeck(snapshot, title, icon, assets, meta, appearance.dataColors, dbSeries))
            : await toPdf(toHtml(snapshot, title, icon, assets, meta, appearance.dataColors, dbSeries), kind === 'pdf-continuous' ? 'continuous' : 'paged');
        downloadBlob(`${base}${kind === 'pdf-slides' ? '-slides' : ''}.pdf`, blob);
      } else if (kind === 'html-slides') {
        const [{toSlideDeck}, assets] = await Promise.all([import('@/export/toHtml'), resolveExportAssets(client, [snapshot])]);
        downloadText(`${base}-slides.html`, toSlideDeck(snapshot, title, icon, assets, meta, appearance.dataColors, dbSeries), 'text/html');
      } else {
        const [{toHtmlSite}, {gatherSite, bundleHasLedgerBlocks}] = await Promise.all([import('@/export/toHtml'), import('@/export/exportSite')]);
        const bundle: import('@/export/exportSite').SiteBundle = pageId
          ? await gatherSite(client, pageId, {snapshot, title, icon})
          : {
            rootId: '',
            pages: [{id: '', title, icon, snapshot}],
            // Unsaved single page: the island still carries the lossless source.
            space: {
              pages: [
                {
                  id: '',
                  name: title,
                  data: snapshot,
                  hostedDatabaseId: null,
                  databaseId: null,
                  parentId: null,
                  properties: icon ? {[ICON_PROPERTY_ID]: icon} : {},
                  deletedAt: null,
                  createdAt: '',
                  updatedAt: '',
                },
              ],
              databases: [],
            },
          };
        // LX-2: the export set shows ledger blocks — OR the crawl reached
        // ledger content (a subpage/mention to a host page; always pruned from
        // the generic bundle, see gatherSite) → ask about embedding the
        // machine-readable records. Detection runs on the RAW snapshots in the
        // island bundle (the projection flattens plugin blocks to placeholders).
        // The probe AND the capture both go through this principal's own client,
        // so a guest/viewer can never receive records the API wouldn't serve
        // them — their dialog simply reports that the books are excluded.
        if (bundleHasLedgerBlocks(bundle.space) || bundle.ledgerReached) {
          // Default the toggle ON only for the owner/admin: `ledgerInfo.exists`
          // alone means "root host readable", which a granted reader also has —
          // their toggle starts OFF-but-available. The role is the server-
          // stamped effective role (InstanceInfo.youRole, the same signal
          // useCanWrite trusts); unknown/unreachable resolves to OFF.
          const [canInclude, isOwnerAdmin] = await Promise.all([
            client
              .ledgerInfo()
              .then((i) => i.exists)
              .catch(() => false),
            client
              .getInstanceInfo()
              .then((i) => i.youRole === 'owner' || i.youRole === 'admin')
              .catch(() => false),
          ]);
          const choice = await askExportBooks(canInclude, canInclude && isOwnerAdmin);
          if (!choice) return; // cancelled
          if (choice.includeBooks) {
            // Fail-closed capture: null (revoked mid-flight, transport error,
            // partial row grant tripping the completeness check) exports
            // without records — placeholders, never half a book. The exporter
            // OPTED IN, so tell them the file shipped without their books
            // rather than letting the warning imply the records are inside.
            bundle.ledger = (await gatherLedgerExportSection(client)) ?? undefined;
            if (!bundle.ledger) showToast({message: t('page.exportBooksCaptureFailed')});
          }
        }
        // A whole-site export can embed images from every reachable page.
        const assets = await resolveExportAssets(client, bundle.pages.map((p) => p.snapshot));
        downloadText(`${base}.html`, toHtmlSite(bundle, assets, appearance.dataColors), 'text/html');
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

  // Full width is a per-page choice (see lib/pageFullWidth); database-hosting
  // pages default to full-width when the user hasn't set an explicit override.
  const fullWidth = usePageFullWidth(pageId ?? '', hasDatabase);
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
            {/* The cover-area controls (hover-revealed) sit left; the live
                "who's here" presence stack stays right, always visible. The
                controls take the slack (flex-1 min-w-0) so their own internal
                right-alignment ("Add cover" ml-auto) still works. */}
            <div className="flex items-start gap-2">
              {pageId && (
                <div className="min-w-0 flex-1">
                  <PageHeaderControls pageId={pageId} />
                </div>
              )}
              {pageId && <PresenceAvatars pageId={pageId} />}
            </div>

            <PageHeader
              title={title}
              icon={icon}
              pageId={pageId}
              readOnly={!canWrite}
              onTitleChange={onTitleChange}
              onIconChange={onIconChange}
              onTitleActiveChange={onTitleActiveChange}
              focusRef={titleRef}
              onLeaveToEditor={leaveToEditor}
            />
            {pageId && <PageProperties pageId={pageId} />}
          </div>
        </div>
      </div>

      <div className="px-6 md:px-10">
        <div className={columnClass}>
          <div ref={editorWrapRef} className={cn(hasDatabase ? 'min-h-0' : 'min-h-[40vh]', 'relative pt-2')}>
            {doc && (
              <FormOriginContext.Provider value={formOriginUrl(pageId)}>
                <BlockEditor
                  doc={doc}
                  readOnly={!canWrite}
                  ariaLabel={title || 'Page content'}
                  fullWidth={fullWidth}
                  compact={hasDatabase}
                  spellcheck={preferences.general.spellcheck}
                  pageId={pageId}
                  focusRef={editorRef}
                  onLeaveToTitle={leaveToTitle}
                  onSelectionChange={handleLocalSelection}
                />
              </FormOriginContext.Provider>
            )}
            {/* Inline review affordances (provider-aware, portaled into the
                editor wrapper since the editor's own root is provider-less). */}
            {pageId && doc && <BlockReviewMarkers pageId={pageId} containerRef={editorWrapRef} />}
            {/* Remote carets + selections of live peers (Collab T5), same
                portal-into-the-editor-wrapper pattern. Decorative + inert. */}
            {pageId && doc && <RemoteCursors pageId={pageId} containerRef={editorWrapRef} />}
          </div>

          {/* Bridges the editor's inline "Suggest edit"/"Comment" menu items to
              the data client + Review pane. */}
          {pageId && doc && <SuggestHost />}

          {footer}
        </div>
      </div>
    </div>
  );

  return (
    <>
      {pageId ? <PageContextMenu pageId={pageId}>{body}</PageContextMenu> : body}
      {/* LX-2: the export-time "Include your books" toggle + warning. */}
      <ExportBooksDialog
        open={booksDialog !== null}
        canInclude={booksDialog?.canInclude ?? false}
        defaultOn={booksDialog?.defaultOn ?? false}
        onClose={settleExportBooks}
      />
    </>
  );
};

export default BlockPageDocument;
