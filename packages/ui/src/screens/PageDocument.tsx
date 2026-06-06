import EmojiPicker, {Theme} from 'emoji-picker-react';
import React, {useEffect, useRef, useState} from 'react';
import {useHud, useTheme} from '@/providers';
import {Popover, PopoverContent, PopoverTrigger} from '@/components/ui/popover';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {cn} from '@/lib/utils';
import {MoreHorizontal, Trash2} from 'lucide-react';
// Type-only imports: the EditorJS class is loaded dynamically (client-only)
// inside the effect below, so importing this module never pulls EditorJS's
// browser-dependent bundle during SSR (e.g. the Next.js web shell). The default
// import is kept type-only so `EditorJS` is usable as the instance type.
import type EditorJS from '@editorjs/editorjs';
import type {OutputData} from '@editorjs/editorjs';

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
  // the source of the save loop on pages with complex blocks. We patch only the
  // blocks that actually changed. `focusedBlockId` is null when nothing here has
  // the caret, in which case every changed block is eligible for update.
  const current = await inst.save();
  const currentBlocks = current.blocks ?? [];
  const nextBlocks = next.blocks ?? [];
  const currentById = new Map(currentBlocks.map((b) => [b.id, b] as const));
  const nextById = new Map(nextBlocks.map((b) => [b.id, b] as const));
  const liveIds = new Set(currentBlocks.map((b) => b.id));

  // 1. Delete blocks the peer removed — but never the one under the caret.
  for (const b of currentBlocks) {
    if (b.id && b.id !== focusedBlockId && !nextById.has(b.id)) {
      const idx = inst.blocks.getBlockIndex(b.id);
      if (idx >= 0) {
        inst.blocks.delete(idx);
        liveIds.delete(b.id);
      }
    }
  }

  // 2. Update blocks whose data changed — but never the focused one (that would
  //    re-render it and yank the caret). The focused block reconciles on blur.
  for (const b of nextBlocks) {
    if (!b.id || b.id === focusedBlockId) continue;
    const cur = currentById.get(b.id);
    if (cur && JSON.stringify(cur.data) !== JSON.stringify(b.data)) {
      await inst.blocks.update(b.id, b.data);
    }
  }

  // 3. Insert blocks the peer added, each anchored after its predecessor so the
  //    relative order is preserved across multiple inserts.
  for (let i = 0; i < nextBlocks.length; i++) {
    const b = nextBlocks[i];
    if (!b.id || liveIds.has(b.id)) continue;
    const prevId = i > 0 ? nextBlocks[i - 1].id : undefined;
    const prevIdx = prevId ? inst.blocks.getBlockIndex(prevId) : -1;
    const insertAt = prevIdx >= 0 ? prevIdx + 1 : i;
    inst.blocks.insert(b.type, b.data, {}, insertAt, false, false, b.id);
    liveIds.add(b.id);
  }
}
import {SliderBlock, ExprBlock, ChartBlock, SubpageBlock} from '@/reactive';
import {PageContextMenu} from '@/components/PageContextMenu';
import {store} from '@/reactive/ReactiveStore';
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
}

const STATUS_LABEL: Record<string, string> = {
  unsaved: 'Saving…',
  saved: 'Saved',
  'save failed': 'Couldn’t save',
};

const isSSR = () => typeof window === 'undefined';

const PageHeader: React.FC<{
  title: string;
  icon: string;
  onTitleChange?: (title: string) => void;
  onIconChange?: (emoji: string) => void;
  onTitleActiveChange?: (active: boolean) => void;
}> = ({title, icon, onTitleChange, onIconChange, onTitleActiveChange}) => {
  const {colorScheme} = useTheme();
  return (
    <div className="pt-2 pb-1">
      <Popover>
        <PopoverTrigger asChild>
          <button
            className="-ml-1 mb-1 inline-flex h-[68px] w-[68px] items-center justify-center rounded-lg text-[3.5rem] leading-none transition-colors hover:bg-accent"
            aria-label="Change page icon"
          >
            <span>{icon || '📄'}</span>
          </button>
        </PopoverTrigger>
        <PopoverContent className="z-50 w-auto border-0 p-0 shadow-lg">
          <EmojiPicker
            onEmojiClick={(e) => onIconChange?.(e.emoji)}
            theme={colorScheme === 'light' ? Theme.LIGHT : Theme.DARK}
          />
        </PopoverContent>
      </Popover>
      <input
        className="w-full bg-transparent text-[2.5rem] font-bold leading-tight tracking-tight outline-hidden placeholder:text-muted-foreground/35"
        value={title}
        placeholder="Untitled"
        onChange={(e) => onTitleChange?.(e.target.value)}
        onFocus={() => onTitleActiveChange?.(true)}
        onBlur={() => onTitleActiveChange?.(false)}
        aria-label="Page title"
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
}) => {
  'use client';
  const {hud} = useHud();

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
  const [status, setStatus] = useState<string>('initializing');
  const statusRef = useRef(status);
  statusRef.current = status;

  useEffect(() => {
    let cancelled = false;
    const markUserEdited = () => {
      userEditedRef.current = true;
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
      ] = await Promise.all([
        import('@editorjs/editorjs'),
        import('@editorjs/header'),
        import('@editorjs/list'),
        import('@editorjs/quote'),
        import('@editorjs/delimiter'),
        import('@editorjs/code'),
        import('@editorjs/marker'),
        import('@editorjs/inline-code'),
      ]);
      if (cancelled || !holderRef.current) return;

      const editorJs = new EditorJSCtor({
        holder: holderRef.current,
        autofocus: true,
        data: initialData,
        placeholder: 'Write something, or press Tab for blocks…',
        tools: {
          header: {
            class: Header as unknown as never,
            inlineToolbar: true,
            shortcut: 'CMD+SHIFT+H',
            config: {placeholder: 'Heading', levels: [1, 2, 3], defaultLevel: 2},
          },
          list: {class: List as unknown as never, inlineToolbar: true, config: {defaultStyle: 'unordered'}},
          quote: {class: Quote as unknown as never, inlineToolbar: true},
          code: CodeTool as unknown as never,
          delimiter: Delimiter as unknown as never,
          marker: {class: Marker as unknown as never, shortcut: 'CMD+SHIFT+M'},
          inlineCode: {class: InlineCode as unknown as never, shortcut: 'CMD+SHIFT+C'},
          slider: SliderBlock as unknown as never,
          expr: ExprBlock as unknown as never,
          chart: ChartBlock as unknown as never,
          subpage: {class: SubpageBlock as unknown as never, config: {hostPageId: pageId}},
        },
        onReady: () => {
          editorJsInstance.current = editorJs;
          // Flag genuine user editing. `input`/`beforeinput` fire for typing,
          // deleting, pasting, and form-control (slider) interaction, but never
          // for programmatic DOM changes — so this distinguishes a real edit
          // from applying a peer's snapshot.
          const holder = holderRef.current;
          holder?.addEventListener('beforeinput', markUserEdited);
          holder?.addEventListener('input', markUserEdited);
          setStatus('ready');
        },
        onChange: (_api, event) => {
          if (suppressSaveRef.current) return;
          // Adding/removing/moving a block is a genuine edit that fires no
          // `input` event, so mark it here. `block-changed` is trickier: reactive
          // blocks (expr/chart/slider) fire it constantly as they recompute and
          // re-render their DOM — treating those as edits causes a save loop. So
          // only a subpage block recording the child page id it just created
          // (via dispatchChange) counts. Peer-applied patches set
          // `suppressSaveRef` and are filtered above.
          const events = Array.isArray(event) ? event : [event];
          const isEdit = events.some((e) => {
            const type = e?.type;
            if (type === 'block-added' || type === 'block-removed' || type === 'block-moved') return true;
            if (type === 'block-changed') {
              const target = (e as {detail?: {target?: {name?: string}}})?.detail?.target;
              return target?.name === 'subpage';
            }
            return false;
          });
          if (isEdit) userEditedRef.current = true;
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
      const holder = holderRef.current;
      holder?.removeEventListener('beforeinput', markUserEdited);
      holder?.removeEventListener('input', markUserEdited);
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

  const statusLabel = STATUS_LABEL[status] ?? '';

  // The title lives in a centered column; the editor is full-width and centers
  // its own content to the same width (so the toolbar/+ stays in the left gutter
  // and EditorJS never enters its narrow, right-aligned layout).
  const columnClass = cn('mx-auto w-full', hud.viewMode.fullWidth ? 'max-w-none' : 'max-w-content');

  const body = (
    <div className="w-full px-6 pb-40 pt-6 md:px-10">
      <div className={columnClass}>
        {/* Page action bar: subtle save status + overflow menu. */}
        <div className="flex h-8 items-center justify-end gap-2 text-xs text-muted-foreground">
          <span className={cn('transition-opacity', status === 'save failed' && 'text-destructive')}>
            {statusLabel}
          </span>
          {onDelete && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  aria-label="Page actions"
                >
                  <MoreHorizontal className="h-4 w-4" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-44">
                <DropdownMenuItem onClick={onDelete} className="text-destructive focus:text-destructive">
                  <Trash2 className="mr-2 h-4 w-4" />
                  Delete page
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>

        <PageHeader
          title={title}
          icon={icon}
          onTitleChange={onTitleChange}
          onIconChange={onIconChange}
          onTitleActiveChange={onTitleActiveChange}
        />
      </div>

      {/* `ob-editor-full` lets the CSS widen the EditorJS content column to match
          the full-width title/database sections (the editor centers its blocks
          via a max-width in index.css, which this overrides). */}
      {!isSSR() && (
        <div ref={holderRef} className={cn('min-h-[40vh]', hud.viewMode.fullWidth && 'ob-editor-full')} />
      )}

      {footer && <div className={columnClass}>{footer}</div>}
    </div>
  );

  // Right-click anywhere on the page opens its action menu (desktop has no
  // native context menu). Only when we know which page this is.
  return pageId ? <PageContextMenu pageId={pageId}>{body}</PageContextMenu> : body;
};

export default PageDocument;
