import React, {useCallback, useEffect, useRef, useState} from 'react';
import {useHud, usePreferences, useTranslation} from '@/providers';
import {t as bareT} from '@/i18n';
import {IconPicker} from '@/components/IconPicker';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {cn} from '@/lib/utils';
import {IconButton} from '@/components/ui/icon-button';
import {Download, FileCode, FileText as FileTextIcon, FileType, MoreHorizontal, Trash2} from 'lucide-react';
import {buildDocumentModel} from '@/export/documentModel';
import {toMarkdown} from '@/export/toMarkdown';
import {toPdf} from '@/export/toPdf';
import {downloadBlob, downloadText, safeFilename} from '@/lib/download';
// Type-only imports: the EditorJS class is loaded dynamically (client-only)
// inside the effect below, so importing this module never pulls EditorJS's
// browser-dependent bundle during SSR (e.g. the Next.js web shell). The default
// import is kept type-only so `EditorJS` is usable as the instance type.
import type EditorJS from '@editorjs/editorjs';
import type {BlockToolData, OutputData} from '@editorjs/editorjs';
import {planBlockSync, isPersistWorthyChange} from './liveSync';
import {consumePendingRename, onRenamePageRequest} from '@/lib/pageActions';

/**
 * Apply a peer's snapshot to the live editor with minimal disruption.
 *
 * The naive approach — `editor.render(next)` — tears down and rebuilds every
 * block, which blows away the local user's focus and drops their caret to the
 * top of the document. That's the "cursor jumps when a peer edits" bug.
 *
 * Instead, when the editor is focused we diff block-by-block and patch only
 * what changed, and we *never* touch the block under the caret. A peer's edits
 * to other blocks still appear live; the block you're typing in is left exactly
 * as-is, so focus and cursor position survive. When the editor isn't focused
 * there's no caret to protect, so a full render is simplest and correct.
 */
async function applyIncomingBlocks(inst: EditorJS, next: OutputData, holder: HTMLElement | null): Promise<void> {
  const active = (typeof document !== 'undefined' ? document.activeElement : null) as HTMLElement | null;
  const editorFocused = !!(holder && active && holder.contains(active));
  const focusedBlockId = editorFocused
    ? active?.closest('.ce-block')?.getAttribute('data-id') ?? null
    : null;

  // Always diff — never `inst.render(next)`. A full render tears down and
  // rebuilds *every* block, which shifts the layout and re-mounts reactive /
  // subpage blocks, re-running their side effects (recompute, child creation) —
  // the source of the save loop on pages with complex blocks. {@link planBlockSync}
  // returns only the ops for blocks that actually changed (an identical snapshot
  // → empty plan → no churn). `focusedBlockId` is null when nothing here has the
  // caret; the planner never touches the focused block.
  const current = await inst.save();
  const plan = planBlockSync(current.blocks ?? [], next.blocks ?? [], focusedBlockId);

  for (const id of plan.deletes) {
    const idx = inst.blocks.getBlockIndex(id);
    if (idx >= 0) inst.blocks.delete(idx);
  }
  for (const u of plan.updates) {
    await inst.blocks.update(u.id, u.data as BlockToolData);
  }
  for (const ins of plan.inserts) {
    // Anchor after the predecessor so relative order survives multiple inserts;
    // fall back to the incoming index when the anchor isn't live.
    const prevIdx = ins.afterId ? inst.blocks.getBlockIndex(ins.afterId) : -1;
    const insertAt = prevIdx >= 0 ? prevIdx + 1 : ins.index;
    inst.blocks.insert(ins.type, ins.data as BlockToolData, {}, insertAt, false, false, ins.id);
  }
}
import {createPortal} from 'react-dom';
import {SliderBlock, ExprBlock, ChartBlock, SubpageBlock} from '@/reactive';
import {
  CalloutBlock,
  AccordionBlock,
  DividerBlock,
  ButtonBlock,
  TableOfContentsBlock,
  DatabaseBlock,
  type InlineDatabaseRegistry,
  type InlineDatabaseEntry,
} from '@/editor/blocks';
import {DatabaseView} from '@/components/database/DatabaseView';
import {InlineDatabaseChooser} from '@/components/database/DatabasePicker';
import {PageContextMenu} from '@/components/PageContextMenu';
import {PageProperties} from '@/components/PageProperties';
import {installEditorChrome} from '@/lib/editorChrome';
import {MentionController, PageLinkInlineTool} from '@/editor/pageMention';
import {MentionPopover} from '@/components/MentionPopover';
import {EmojiSuggestController} from '@/editor/emojiSuggest';
import {EmojiSuggestPopover} from '@/components/EmojiSuggestPopover';
import {pageLinks} from '@/lib/pageLinks';
import {store} from '@/reactive/ReactiveStore';
import {useData} from '@/data';
import type {PageSnapshot} from '@open-book/sdk';

// The document save format (`PageSnapshot`) is defined in `@open-book/sdk` so
// the server, persistence clients, and the editor share one source of truth.

export interface PageDocumentProps {
  onSave?: (snap: PageSnapshot) => void | Promise<void>;
  onLoad?: () => Promise<PageSnapshot | null>;
  /** Current page title (the page name). Controlled. */
  title?: string;
  /** Called when the title input changes. */
  onTitleChange?: (title: string) => void;
  /** Page icon (emoji). */
  icon?: string;
  /** Called when the icon changes. */
  onIconChange?: (emoji: string) => void;
  /** When provided, enables the delete action in the page menu. */
  onDelete?: () => void;
  /** A newer snapshot pushed from the server to apply live (collaboration). */
  incoming?: {data: PageSnapshot; version: number};
  /** Notifies when the title input gains/loses focus (to avoid clobbering it). */
  onTitleActiveChange?: (active: boolean) => void;
  /** Extra content rendered below the editor, in the same content column (e.g.
   *  the database view for a page that hosts a database). */
  footer?: React.ReactNode;
  /** The page being edited — passed to the subpage block so new children nest here. */
  pageId?: string;
  /** True when this page hosts a database (its view renders as the {@link footer}).
   *  The empty editor then drops its tall min-height so the database sits directly
   *  under the header instead of being pushed down by a big gap. */
  hasDatabase?: boolean;
}

const isSSR = () => typeof window === 'undefined';

const PageHeader: React.FC<{
  title: string;
  icon: string;
  pageId?: string;
  onTitleChange?: (title: string) => void;
  onIconChange?: (emoji: string) => void;
  onTitleActiveChange?: (active: boolean) => void;
}> = ({title, icon, pageId, onTitleChange, onIconChange, onTitleActiveChange}) => {
  const {t} = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);

  // "Rename" from a menu focuses + selects this title field. Handle both a
  // request fired while we're already mounted, and one queued just before a
  // page switch mounted this header (claimed via consumePendingRename).
  useEffect(() => {
    if (!pageId) return;
    const focusTitle = () => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      el.select();
    };
    if (consumePendingRename(pageId)) focusTitle();
    return onRenamePageRequest((id) => {
      if (id === pageId) focusTitle();
    });
  }, [pageId]);

  return (
    <div className="pt-2 pb-1">
      <IconPicker
        value={icon}
        onPick={(emoji) => onIconChange?.(emoji)}
        ariaLabel={t('page.changeIcon')}
        className="-ml-1 mb-1 inline-flex h-[68px] w-[68px] items-center justify-center rounded-lg text-[3.5rem] leading-none transition-colors hover:bg-accent"
      />
      <input
        ref={inputRef}
        className="w-full bg-transparent text-[2.5rem] font-bold leading-tight tracking-tight outline-hidden placeholder:text-muted-foreground/35"
        value={title}
        placeholder={t('common.untitled')}
        onChange={(e) => onTitleChange?.(e.target.value)}
        onFocus={() => onTitleActiveChange?.(true)}
        onBlur={() => onTitleActiveChange?.(false)}
        aria-label={t('page.titleLabel')}
      />
    </div>
  );
};

const PageDocument: React.FC<PageDocumentProps> = ({
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
  'use client';
  const {hud} = useHud();
  const {t} = useTranslation();
  const client = useData();
  const {preferences} = usePreferences();
  const spellcheck = preferences.general.spellcheck;

  const editorJsInstance = useRef<EditorJS | null>(null);
  // Per-instance holder element. EditorJS keys its DOM off this node, so each
  // PageDocument owns its own — required for the split pane, where two editors
  // are mounted at once and a shared element id would collide.
  const holderRef = useRef<HTMLDivElement | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Suppresses autosave while a server-pushed update is being applied, so we
  // don't echo it straight back to the server.
  const suppressSaveRef = useRef(false);
  // True once the *local user* has actually edited (typed/dragged/pasted) since
  // the last save. EditorJS fires onChange for programmatic DOM changes too —
  // applying a peer's snapshot, reactive blocks re-rendering — and saving those
  // back is what bounced edits between peers forever. The browser only fires
  // `input`/`beforeinput` for genuine user editing, never for programmatic DOM
  // mutation, so we gate autosave on this flag.
  const userEditedRef = useRef(false);
  // The `@`-mention controller for this editor (one per pane). Created lazily so
  // it's available when building the tools config (before the editor mounts).
  const mentionRef = useRef<MentionController | null>(null);
  if (!mentionRef.current) mentionRef.current = new MentionController();
  // The `:`-shortcode emoji controller for this editor (one per pane).
  const emojiRef = useRef<EmojiSuggestController | null>(null);
  if (!emojiRef.current) emojiRef.current = new EmojiSuggestController();
  // Inline database blocks hand their DOM nodes here; we portal a DatabaseView
  // into each from inside the provider tree (see InlineDatabaseRegistry). Updates
  // are deferred to a microtask so a block's render/destroy never sets state
  // synchronously during an EditorJS operation that runs amid a React commit.
  const [dbBlocks, setDbBlocks] = useState<Map<string, {el: HTMLElement} & InlineDatabaseEntry>>(new Map());
  const dbRegistry = useRef<InlineDatabaseRegistry>({
    register: (id, el, entry) =>
      queueMicrotask(() => setDbBlocks((prev) => new Map(prev).set(id, {el, ...entry}))),
    setPageId: (id, pageId) =>
      queueMicrotask(() =>
        setDbBlocks((prev) => {
          const entry = prev.get(id);
          if (!entry) return prev;
          const next = new Map(prev);
          next.set(id, {...entry, pageId});
          return next;
        }),
      ),
    unregister: (id) =>
      queueMicrotask(() =>
        setDbBlocks((prev) => {
          if (!prev.has(id)) return prev;
          const next = new Map(prev);
          next.delete(id);
          return next;
        }),
      ),
  });
  const [status, setStatus] = useState<string>('initializing');
  const statusRef = useRef(status);
  statusRef.current = status;

  // Reflect the spellcheck preference onto the editor holder. The contenteditable
  // blocks EditorJS injects don't set their own `spellcheck`, so they inherit it.
  useEffect(() => {
    if (holderRef.current) holderRef.current.spellcheck = spellcheck;
  }, [spellcheck]);

  useEffect(() => {
    let cancelled = false;
    let disposeChrome: (() => void) | null = null;
    const markUserEdited = () => {
      userEditedRef.current = true;
    };
    // Clicking an inline page-mention navigates (it's contenteditable=false, so
    // the click isn't placing a caret). Delegated on the holder.
    const onMentionClick = (e: MouseEvent) => {
      const link = (e.target as HTMLElement).closest('a.ob-mention');
      const id = link?.getAttribute('data-page-id');
      if (id) {
        e.preventDefault();
        pageLinks.openPage(id);
      }
    };

    const init = async () => {
      let initialData: OutputData | undefined;
      if (onLoad) {
        try {
          const snap = await onLoad();
          if (snap) {
            store.hydrate({values: snap.values, names: snap.names});
            initialData = snap.editorjs as OutputData;
          }
        } catch (e) {
          console.error('PageDocument: load failed:', e);
        }
      }
      if (cancelled) return;

      // Load the editor + block tools client-side only.
      const [
        {default: EditorJSCtor},
        {default: Header},
        {default: List},
        {default: Quote},
        {default: Delimiter},
        {default: CodeTool},
        {default: Marker},
        {default: InlineCode},
        {default: Table},
        {default: Checklist},
        {default: DragDrop},
      ] = await Promise.all([
        import('@editorjs/editorjs'),
        import('@editorjs/header'),
        import('@editorjs/list'),
        import('@editorjs/quote'),
        import('@editorjs/delimiter'),
        import('@editorjs/code'),
        import('@editorjs/marker'),
        import('@editorjs/inline-code'),
        import('@editorjs/table'),
        import('@editorjs/checklist'),
        // EditorJS dropped built-in block drag-and-drop in 2.20; this plugin
        // restores it (dragging a block by its settings handle reorders it).
        import('editorjs-drag-drop'),
      ]);
      if (cancelled || !holderRef.current) return;

      // Localize the third-party table/checklist toolbox titles (their other
      // strings are minimal) by subclassing to override the static toolbox.
      const LocalTable = class extends (Table as new (...a: never[]) => object) {
        static get toolbox() {
          return {...(Table as {toolbox: object}).toolbox, title: bareT('blocks.table')};
        }
      };
      const LocalChecklist = class extends (Checklist as new (...a: never[]) => object) {
        static get toolbox() {
          return {...(Checklist as {toolbox: object}).toolbox, title: bareT('blocks.todo')};
        }
      };
      // The List tool also offers its own "Checklist" toolbox entry, which would
      // sit beside the To-do tool as a confusing duplicate — drop it and localize
      // the two list flavors.
      const LocalList = class extends (List as new (...a: never[]) => object) {
        static get toolbox() {
          const entries = (List as {toolbox: Array<{title: string; data?: {style?: string}}>}).toolbox;
          return entries
            .filter((e) => e.data?.style !== 'checklist')
            .map((e) => ({
              ...e,
              title: e.data?.style === 'ordered' ? bareT('blocks.listOrdered') : bareT('blocks.listUnordered'),
            }));
        }
      };

      const editorJs = new EditorJSCtor({
        holder: holderRef.current,
        // Autofocus is applied manually in onReady: EditorJS's own autofocus
        // fires whenever init completes — on a slow load that's *after* the
        // user has reached other UI, and the focus steal closes any menu or
        // popover they just opened.
        autofocus: false,
        data: initialData,
        placeholder: bareT('page.editorPlaceholder'),
        tools: {
          header: {
            class: Header as unknown as never,
            inlineToolbar: true,
            shortcut: 'CMD+SHIFT+H',
            config: {placeholder: 'Heading', levels: [1, 2, 3], defaultLevel: 2},
          },
          list: {class: LocalList as unknown as never, inlineToolbar: true, config: {defaultStyle: 'unordered'}},
          quote: {class: Quote as unknown as never, inlineToolbar: true},
          code: CodeTool as unknown as never,
          delimiter: Delimiter as unknown as never,
          marker: {class: Marker as unknown as never, shortcut: 'CMD+SHIFT+M'},
          inlineCode: {class: InlineCode as unknown as never, shortcut: 'CMD+SHIFT+C'},
          table: {class: LocalTable as unknown as never, inlineToolbar: true},
          checklist: {class: LocalChecklist as unknown as never, inlineToolbar: true},
          callout: {class: CalloutBlock as unknown as never, inlineToolbar: true},
          accordion: {class: AccordionBlock as unknown as never, inlineToolbar: true},
          divider: DividerBlock as unknown as never,
          button: ButtonBlock as unknown as never,
          toc: TableOfContentsBlock as unknown as never,
          slider: SliderBlock as unknown as never,
          expr: ExprBlock as unknown as never,
          chart: ChartBlock as unknown as never,
          subpage: {class: SubpageBlock as unknown as never, config: {hostPageId: pageId}},
          // Inline database: the block hands its node to the registry and we
          // portal a live DatabaseView into it (below) from inside the providers.
          database: {class: DatabaseBlock as unknown as never, config: {hostPageId: pageId, registry: dbRegistry.current}},
          // Inline tool: preserves the `@`-mention anchor through save sanitization
          // and links a selection to a page. The `@` typing flow is driven by the
          // controller attached in onReady.
          pageLink: {class: PageLinkInlineTool as unknown as never, config: {controller: mentionRef.current}},
        },
        onReady: () => {
          editorJsInstance.current = editorJs;
          // Focus the editor only if the user hasn't focused anything yet.
          const active = document.activeElement;
          if (!active || active === document.body) editorJs.focus();
          // Enable block drag-and-drop (reorder blocks by dragging the settings
          // handle). Tauri's `dragDropEnabled: false` keeps the OS file-drop
          // handler from intercepting these drags in the desktop WKWebView.
          new DragDrop(editorJs);
          // Flag genuine user editing. `input`/`beforeinput` fire for typing,
          // deleting, pasting, and form-control (slider) interaction, but never
          // for programmatic DOM changes — so this distinguishes a real edit
          // from applying a peer's snapshot.
          const holder = holderRef.current;
          holder?.addEventListener('beforeinput', markUserEdited);
          holder?.addEventListener('input', markUserEdited);
          holder?.addEventListener('click', onMentionClick);
          // Preselect the first block/slash-menu item (Enter inserts it) and
          // turn off autocorrect on code textareas, as blocks/menus appear.
          if (holder) {
            disposeChrome = installEditorChrome(holder);
            mentionRef.current?.attach(holder);
            emojiRef.current?.attach(holder);
          }
          setStatus('ready');
        },
        onChange: (_api, event) => {
          if (suppressSaveRef.current) return;
          // Mark genuine structural edits (which fire no `input` event). Reactive
          // blocks fire `block-changed` on every recompute — {@link isPersistWorthyChange}
          // filters those out (only a subpage recording its new child id counts)
          // so they don't drive a save loop. Peer patches set `suppressSaveRef`
          // and are filtered above.
          if (isPersistWorthyChange(event)) userEditedRef.current = true;
          setStatus('unsaved');
          if (saveTimer.current) clearTimeout(saveTimer.current);
          saveTimer.current = setTimeout(() => {
            void doSave();
          }, 800);
        },
      });
    };

    const doSave = async () => {
      const inst = editorJsInstance.current;
      if (!inst || !onSave) return;
      // No genuine local edit since the last save — this onChange came from
      // applying a peer's snapshot (or reactive blocks re-rendering), not the
      // user. Don't echo it back: that's what bounced edits between peers.
      if (!userEditedRef.current) {
        setStatus('saved');
        return;
      }
      // Clear before awaiting so edits made *during* the save still count and
      // schedule a follow-up save.
      userEditedRef.current = false;
      try {
        const editorjs = await inst.save();
        const snap = store.snapshot();
        await onSave({editorjs, values: snap.values, names: snap.names});
        setStatus('saved');
      } catch (e) {
        console.error('PageDocument: save failed:', e);
        setStatus('save failed');
        // Saving failed — keep the document dirty so a later change retries.
        userEditedRef.current = true;
      }
    };

    void init();

    return () => {
      cancelled = true;
      if (saveTimer.current) clearTimeout(saveTimer.current);
      disposeChrome?.();
      mentionRef.current?.detach();
      emojiRef.current?.detach();
      const holder = holderRef.current;
      holder?.removeEventListener('beforeinput', markUserEdited);
      holder?.removeEventListener('input', markUserEdited);
      holder?.removeEventListener('click', onMentionClick);
      editorJsInstance.current?.destroy();
      editorJsInstance.current = null;
    };
  }, [onSave, onLoad]);

  // Apply a server-pushed snapshot live (collaboration). The block-level patch
  // in applyIncomingBlocks protects the caret, so we no longer skip updates
  // while the user is mid-edit — a peer's changes to other blocks merge in live
  // and the block under the caret is left untouched. Autosave is suppressed
  // during the patch so the merged content isn't immediately echoed back.
  useEffect(() => {
    if (!incoming) return;
    const inst = editorJsInstance.current;
    if (!inst || statusRef.current === 'initializing') return;
    let cancelled = false;
    void (async () => {
      suppressSaveRef.current = true;
      store.hydrate({values: incoming.data.values, names: incoming.data.names});
      try {
        await applyIncomingBlocks(inst, (incoming.data.editorjs ?? {blocks: []}) as OutputData, holderRef.current);
      } catch (e) {
        console.error('PageDocument: live update failed:', e);
      }
      if (!cancelled) setStatus('saved');
      setTimeout(() => {
        suppressSaveRef.current = false;
      }, 120);
    })();
    return () => {
      cancelled = true;
    };
  }, [incoming?.version]);

  const statusLabel =
    status === 'unsaved' ? t('page.saving') : status === 'saved' ? t('page.saved') : status === 'save failed' ? t('page.saveFailed') : '';

  // Export the page's *current* document (incl. unsaved edits) to a file.
  const handleExport = useCallback(
    async (kind: 'md' | 'pdf-paged' | 'pdf-continuous' | 'html') => {
      const inst = editorJsInstance.current;
      if (!inst) return;
      const editorjs = await inst.save();
      const snap = store.snapshot();
      const snapshot = {editorjs, values: snap.values, names: snap.names};
      const base = safeFilename(title);
      try {
        if (kind === 'md') {
          downloadText(`${base}.md`, toMarkdown(buildDocumentModel({title, icon, snapshot})), 'text/markdown');
        } else if (kind === 'pdf-paged') {
          downloadBlob(`${base}.pdf`, await toPdf(buildDocumentModel({title, icon, snapshot}), 'paged'));
        } else if (kind === 'pdf-continuous') {
          downloadBlob(`${base}.pdf`, await toPdf(buildDocumentModel({title, icon, snapshot}), 'continuous'));
        } else if (kind === 'html') {
          const [{toHtmlSite}, {gatherSite}] = await Promise.all([import('@/export/toHtml'), import('@/export/exportSite')]);
          // Crawl the page's reachable subtree (subpages, hosted databases and
          // their row pages) into one navigable, self-contained file.
          const bundle = pageId
            ? await gatherSite(client, pageId, {snapshot, title, icon})
            : {rootId: '', pages: [{id: '', title, icon, snapshot}]};
          downloadText(`${base}.html`, toHtmlSite(bundle), 'text/html');
        }
      } catch (e) {
        console.error('PageDocument: export failed:', e);
      }
    },
    [title, icon, pageId, client],
  );

  // The title lives in a centered column; the editor is full-width and centers
  // its own content to the same width (so the toolbar/+ stays in the left gutter
  // and EditorJS never enters its narrow, right-aligned layout).
  const columnClass = cn('mx-auto w-full', hud.viewMode.fullWidth ? 'max-w-none' : 'max-w-content');

  const body = (
    <div className="w-full px-6 pb-40 pt-6 md:px-10">
      <div className={columnClass}>
        {/* Page action bar: subtle save status + overflow menu. */}
        <div className="flex h-8 items-center justify-end gap-2 text-xs text-muted-foreground print:hidden">
          <span className={cn('transition-opacity', status === 'save failed' && 'text-destructive')}>
            {statusLabel}
          </span>
          {pageId && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <IconButton aria-label={t('page.actions')}>
                  <MoreHorizontal className="h-4 w-4" />
                </IconButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-44">
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>
                    <Download className="mr-2 h-4 w-4" />
                    {t('page.export')}
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent>
                    <DropdownMenuItem onClick={() => void handleExport('md')}>
                      <FileTextIcon className="mr-2 h-4 w-4" />
                      {t('page.exportMarkdown')}
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => void handleExport('html')}>
                      <FileCode className="mr-2 h-4 w-4" />
                      {t('page.exportHtml')}
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => void handleExport('pdf-paged')}>
                      <FileType className="mr-2 h-4 w-4" />
                      {t('page.exportPdfPaged')}
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => void handleExport('pdf-continuous')}>
                      <FileType className="mr-2 h-4 w-4" />
                      {t('page.exportPdfContinuous')}
                    </DropdownMenuItem>
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
                {onDelete && (
                  <DropdownMenuItem onClick={onDelete} className="text-destructive focus:text-destructive">
                    <Trash2 className="mr-2 h-4 w-4" />
                    {t('page.delete')}
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>

        <PageHeader
          title={title}
          icon={icon}
          pageId={pageId}
          onTitleChange={onTitleChange}
          onIconChange={onIconChange}
          onTitleActiveChange={onTitleActiveChange}
        />

        {/* Wiki-style page properties (owner, verification, backlinks). The same
            values double as database columns for a databased collection. */}
        {pageId && <PageProperties pageId={pageId} />}
      </div>

      {/* `ob-editor-full` lets the CSS widen the EditorJS content column to match
          the full-width title/database sections (the editor centers its blocks
          via a max-width in index.css, which this overrides). */}
      {!isSSR() && (
        <div
          ref={holderRef}
          className={cn(hasDatabase ? 'min-h-0 ob-editor-compact' : 'min-h-[40vh]', hud.viewMode.fullWidth && 'ob-editor-full')}
        />
      )}

      {/* Inline databases: a live DatabaseView portaled into each database
          block's DOM node, so the view runs inside the document's providers. */}
      {[...dbBlocks].map(([id, {el, pageId: dbPageId, onCreate, onPick}]) =>
        dbPageId
          ? createPortal(<DatabaseView pageId={dbPageId} inline />, el, id)
          : createPortal(<InlineDatabaseChooser onCreate={onCreate} onPick={onPick} />, el, id),
      )}

      {!isSSR() && mentionRef.current && <MentionPopover controller={mentionRef.current} />}
      {!isSSR() && emojiRef.current && <EmojiSuggestPopover controller={emojiRef.current} />}

      {footer && <div className={columnClass}>{footer}</div>}
    </div>
  );

  // Right-click anywhere on the page opens its action menu (desktop has no
  // native context menu); right-clicking a block adds block actions. Only when
  // we know which page this is.
  return pageId ? (
    <PageContextMenu pageId={pageId} editorRef={editorJsInstance}>
      {body}
    </PageContextMenu>
  ) : (
    body
  );
};

export default PageDocument;
