import React, {useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore} from 'react';
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Boxes,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Copy,
  ClipboardPaste,
  Eraser,
  EyeOff,
  GripHorizontal,
  GripVertical,
  Heading,
  Lock,
  LockOpen,
  Plus,
  RefreshCw,
  Scissors,
  TableCellsMerge,
  TableCellsSplit,
  Trash2,
} from 'lucide-react';
import type * as Y from 'yjs';
import {
  blockChildren,
  COLUMN_GRID_UNITS,
  columnBoundaryFromPointer,
  blockId,
  blockProp,
  blockText,
  blockType,
  dropBeside,
  findBlock,
  makeBlock,
  moveBlock,
  moveBlocks,
  normalizeColumnSpans,
  patchBlock,
  parentBlockOf,
  blockToJSON,
  cellInRect,
  cellPosition,
  clearCellRange,
  cloneBlock,
  normalizeCellRect,
  removeBlock,
  resizeColumnBoundary,
  rootBlocks,
  setBlockProp,
  tableCellColor,
  tableCellAt,
  tableCellOwnColor,
  tableColumnColor,
  tableColumns,
  tableRangeCells,
  tableRangeExport,
  tableRangeRuns,
  tableDeleteColumn,
  tableDeleteColumnRange,
  tableDeleteRow,
  tableDeleteRowRange,
  tableDuplicateRow,
  tableGrid,
  tableInsertColumn,
  tableInsertRow,
  tableMergeCells,
  tableMoveColumn,
  tableMoveRow,
  tablePasteGrid,
  tableRowColor,
  tableSnapRectToSpans,
  tableSpans,
  tableSplitCell,
  trailingColumnBoundaryFromPointer,
  setTableCellRangeColor,
  setTableColumnColor,
  setTableRowColor,
  walkBlocks,
  TEXT_BLOCKS,
  type BlockMap,
  type BlockType,
  type CellRect,
  type CellSelection,
} from './model';
import {rangeHasAttr, readSelection, readSelectionDirected, writeSelection} from './richtext';
import {marqueeRect, rowsInMarquee, shiftClickRange, type Rect} from './marquee';
import {blocksToHtml, blocksToMarkdown, cellRangeExportToHtml, cellRangeToTsv} from './exportBlocks';
import {getCustomBlock, getRegistrySnapshot, subscribeRegistry} from './registry';
import {MissingPluginBlock} from './MissingPluginBlock';
import {StaticKeepBlock, useStaticKeep} from './staticKeep';
import {CodeBlockView} from './CodeBlockView';
import {ImageBlockView} from './ImageBlockView';
import {imageBlockFromFile} from './imageBlock';
import {HtmlArtifactBlockView} from './HtmlArtifactBlockView';
import {editorFilesFromTransfer, htmlArtifactBlockFromFile, isHtmlFile} from './htmlArtifactBlock';
import {pageLinks} from '@/lib/pageLinks';
import {pageIconToText} from '@/lib/iconValue';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import {
  MENU_COMPONENTS,
  MENU_DESTRUCTIVE_CLASS,
  MENU_WIDTH_MD,
  MENU_WIDTH_SM,
  type MenuComponentSet,
} from '@/components/ui/menu-components';
import {formatShortcut, matchShortcut, SHORTCUTS} from '@/lib/shortcuts';
import {suppressContextMenu} from '@/lib/suppressContextMenu';
import {t, type TKey} from '../i18n';
import {TextBlockView} from './TextBlockView';
import {COLOR_TOKENS, isColorToken} from './colors';
import {SlashMenu, type SlashState} from './SlashMenu';
import {MentionMenu} from './MentionMenu';
import {WikilinkMenu} from './WikilinkMenu';
import {EmojiMenu} from './EmojiMenu';
import {LinkPicker} from './LinkPicker';
import {hasKitConfig, openKitConfig} from './kit/kitConfig';
import {KitLockContext, KitPageLockContext, useKitLock, useKitPageLock} from './kit/lock';
import {KitInlineText} from './kit/KitFrame';
import {groupInputs, inputValue, setInputValue} from './kit/scope';
import {sectionCompletion, type CompletionStat} from './kit/completion';
import {readGroupSync, subscribeGroupSync, valueEqual, writeGroupSync} from './kit/groupSync';
import type {PageLinkResult} from '@/lib/pageLinks';
import {InlineToolbar, type ToolbarState} from './InlineToolbar';
import {useBlockEditor, type BlockEditorController} from './useBlockEditor';
import type {InlineAttrs} from './model';
import {getPageIdForDoc} from '@/lib/aiBridge';
import {requestComment, requestSuggestEdit, suggestHostReady} from '@/lib/suggestBridge';
import {createSelectionReporter, LOCAL_SELECTION_THROTTLE_MS, type LocalSelection, type SelectionReporter} from './localSelection';
import {passEditableContextMenuToBrowser} from './nativeContextMenu';
import {parseClipboardGrid} from './tablePaste';

// Re-exported so the page host can type its onSelectionChange handler. Collab T5.
export {LOCAL_SELECTION_THROTTLE_MS, type LocalSelection};

/**
 * A rectangular multi-cell selection within ONE table (TBL-5). `anchor` is the
 * fixed corner; `focus` moves under drag / shift-click / shift-arrow. Both are
 * RENDER-order grid coordinates — LOCAL React state only, never CRDT or
 * awareness (per-user, ephemeral). The BlockEditor root owns it and threads it
 * to the table through {@link CellSelectionContext}.
 */
export type {CellSelection} from './model';

/** Both native copy/cut events and range-menu clipboard commands use this payload. */
export function tableRangeClipboardPayload(doc: Y.Doc, tableId: string, rect: CellRect): {text: string; html: string} {
  return {
    text: cellRangeToTsv(tableRangeRuns(doc, tableId, rect)),
    html: cellRangeExportToHtml(tableRangeExport(doc, tableId, rect)),
  };
}

interface CellSelectionCtx {
  sel: CellSelection | null;
  setSel: (s: CellSelection | null) => void;
}
const CellSelectionContext = React.createContext<CellSelectionCtx | null>(null);

/** A range-menu subject must span at least two grid slots (Q2). */
const isMultiCellRect = (rect: CellRect): boolean => rect.top !== rect.bottom || rect.left !== rect.right;

/**
 * The block editor root: renders the block tree, owns the transient UI
 * (slash menu, inline toolbar, drag state, block selection), and routes
 * structural keyboard commands. Pure UI — all document state lives in the
 * Y.Doc handed in by the caller.
 */

/** Shared UI surface text blocks call into (menus, formatting, drag). */
export interface EditorUI {
  slash: SlashState;
  mention: SlashState;
  wiki: SlashState;
  emoji: SlashState;
  spellcheck: boolean;
  openSlash(blockId: string, anchorOffset: number): void;
  updateSlash(caret: number): void;
  closeSlash(): void;
  slashKey(key: string): void;
  openMention(blockId: string, anchorOffset: number): void;
  updateMention(caret: number): void;
  closeMention(): void;
  mentionKey(key: string): void;
  /** "[[" wikilink menu — anchorOffset is the FIRST "[" of the pair. */
  openWiki(blockId: string, anchorOffset: number): void;
  updateWiki(caret: number): void;
  closeWiki(): void;
  wikiKey(key: string): void;
  openEmoji(blockId: string, anchorOffset: number): void;
  updateEmoji(caret: number): void;
  closeEmoji(): void;
  emojiKey(key: string): void;
  toggleFormat(key: keyof InlineAttrs, value?: string): void;
  scheduleToolbar(): void;
  /** Leave the editor for the page title above (↑/←/Backspace at the very top). */
  leaveToTitle?(): void;
}

/** Imperative handle the host uses to hand the caret into the editor. */
export interface BlockEditorHandle {
  /** Focus the first text block at its start, creating a paragraph if empty. */
  focusStart(): void;
}

export type DropRegion = 'above' | 'below' | 'left' | 'right';
interface DragState {
  /** The block whose handle is grabbed. */
  id: string;
  /** Present (length ≥ 2) for a multi-block drag: the whole selection in
   *  document order, `id` included. Absent for a single-block drag. */
  ids?: string[];
  over: {id: string; region: DropRegion} | null;
}

export const BlockEditor: React.FC<{
  doc: Y.Doc;
  readOnly?: boolean;
  ariaLabel?: string;
  /** Widen the content column to the container (page "full width" mode). */
  fullWidth?: boolean;
  /** Trim the tall click-to-append bottom padding (pages with content below
   *  the editor, e.g. a hosted database view). */
  compact?: boolean;
  /** Spellcheck text blocks while typing (user preference). */
  spellcheck?: boolean;
  /** The page hosting this editor — powers the "New page/database" commands. */
  pageId?: string;
  /** Imperative handle so the title can hand the caret to the first block. */
  focusRef?: React.Ref<BlockEditorHandle>;
  /** Leave the editor for the title above (caret at the top of the document). */
  onLeaveToTitle?: () => void;
  /** Report the local caret/selection so peers can render it as a remote cursor
   *  (Collab T5). Fired throttled (~10Hz) as the selection moves; null on blur. */
  onSelectionChange?: (selection: LocalSelection | null) => void;
}> = ({doc, readOnly = false, ariaLabel, fullWidth = false, compact = false, spellcheck = true, pageId, focusRef, onLeaveToTitle, onSelectionChange}) => {
  const editor = useBlockEditor(doc, readOnly);
  const rootRef = useRef<HTMLDivElement>(null);
  // React synthetic events from portaled descendants still traverse this
  // component tree. Every handler attached to the DOM root must reject those
  // events before treating them as editor-surface input.
  const insideRoot = useCallback(
    (e: React.SyntheticEvent): boolean => !!rootRef.current?.contains(e.target as Node),
    [],
  );
  // Whole-document read-only (viewer / present): a lock context wraps the tree so
  // `BlockBody` freezes text + structure while interactive widgets stay live —
  // the present-mode treatment, lifted to a normal page. Stable identity so the
  // root provider doesn't re-render every consumer on each doc version tick.
  const readOnlyLock = useMemo(() => ({locked: readOnly}), [readOnly]);

  // Give a writable, text-less document its typing row as soon as it loads.
  // Doing this before paint keeps the row out of the title → body focus path;
  // writing directly also avoids moving the caret before the user asks to.
  // Known benign races: concurrent first-visits may each seed (Yjs keeps both),
  // and a text-less snapshot may seed before a peer's live content merges. This
  // is accepted; the UndoManager is unaffected because it tracks 'local' only.
  useLayoutEffect(() => {
    if (readOnly) return;
    const hasTextBlock = [...walkBlocks(rootBlocks(doc))].some(
      ({block}) => TEXT_BLOCKS.has(blockType(block)) && !!blockText(block),
    );
    if (!hasTextBlock) rootBlocks(doc).push([makeBlock({type: 'paragraph'})]);
  }, [doc, readOnly]);

  // Title → editor: focus the first text block, caret at its start. Load-time
  // text-less docs are seeded above; the fallback covers docs emptied later.
  useImperativeHandle(focusRef, () => ({
    focusStart() {
      // A read-only page (viewer / present) has no caret surface to hand off to —
      // and must never enter an editing state. Guarding here covers every entry
      // point even if a caller invokes the hand-off imperatively.
      if (editor.readOnly) return;
      const first = editor.textBlockIds()[0];
      if (!first) {
        editor.insertAfter(null, {type: 'paragraph'});
        return;
      }
      editor.requestCaret({blockId: first, offset: 0});
    },
  }), [editor]);

  const [slash, setSlash] = useState<SlashState>({open: false, blockId: '', anchorOffset: 0, query: '', index: 0});
  const [mention, setMention] = useState<SlashState>({open: false, blockId: '', anchorOffset: 0, query: '', index: 0});
  const [wiki, setWiki] = useState<SlashState>({open: false, blockId: '', anchorOffset: 0, query: '', index: 0, trigger: '[['});
  const [emoji, setEmoji] = useState<SlashState>({open: false, blockId: '', anchorOffset: 0, query: '', index: 0});
  const [toolbar, setToolbar] = useState<ToolbarState | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [linkPicker, setLinkPicker] = useState<{kind: 'page' | 'database'; blockId: string; anchorOffset: number} | null>(null);
  const [live, setLive] = useState(''); // aria-live announcements
  const [fileDragOver, setFileDragOver] = useState(false); // external image drag hovering the editor
  // Marquee (rubber-band) rectangle, in obe-root-relative coords, while a
  // drag-select is live; null the rest of the time. Rendered as an overlay.
  const [marquee, setMarquee] = useState<{left: number; top: number; width: number; height: number} | null>(null);
  // A marquee drag just ended → swallow the trailing `click` so it doesn't
  // append a trailing paragraph (the click-below-last-block affordance).
  const suppressClickRef = useRef(false);
  // Teardown for an in-flight marquee drag (remove window listeners, cancel the
  // rAF loop, clear state). Stashed so we can tear down on unmount / read-only
  // flip mid-drag — otherwise the listeners + self-scheduling rAF leak.
  const marqueeTeardownRef = useRef<(() => void) | null>(null);
  // Teardown for an in-flight cell drag-select (remove window listeners, clear
  // transient drag state). Stashed so we can tear down on unmount / read-only
  // flip mid-drag — otherwise the listeners leak and the next move runs on a
  // detached doc / an unmounted tree.
  const cellDragTeardownRef = useRef<(() => void) | null>(null);
  // Cell-range selection (TBL-5): a rectangle of table cells. LOCAL, per-user,
  // ephemeral — never CRDT. A ref mirrors it so the document-level clipboard /
  // keyboard listeners read the live value without re-subscribing every change.
  const [cellSel, setCellSel] = useState<CellSelection | null>(null);
  const cellSelRef = useRef(cellSel);
  cellSelRef.current = cellSel;
  const cellSelCtx = useMemo<CellSelectionCtx>(() => ({sel: cellSel, setSel: setCellSel}), [cellSel]);

  // Insert an inline page-link mention (chosen in the LinkPicker) at the caret.
  const insertMention = useCallback(
    (blockId: string, at: number, r: PageLinkResult): void => {
      const found = findBlock(doc, blockId);
      const text = found && blockText(found.block);
      if (!text) return;
      const iconText = pageIconToText(r.icon);
      const label = iconText ? `${iconText} ${r.label}` : r.label;
      const start = Math.min(at, text.length);
      doc.transact(() => {
        text.insert(start, label, {m: r.id});
        text.insert(start + label.length, ' ', {m: null}); // plain space so the caret exits the chip
      }, 'local');
      editor.requestCaret({blockId, offset: start + label.length + 1});
    },
    [doc, editor],
  );

  // Insert plain text at an offset (mention menu's dates / person names).
  const insertTextAt = useCallback(
    (blockId: string, at: number, str: string): void => {
      const found = findBlock(doc, blockId);
      const text = found && blockText(found.block);
      if (!text) return;
      const start = Math.min(at, text.length);
      doc.transact(() => text.insert(start, str, {}), 'local');
      editor.requestCaret({blockId, offset: start + str.length});
    },
    [doc, editor],
  );

  // Auto-create a page for a "[[" wikilink whose name matches nothing: the new
  // page nests under the current page (parentId = pageId) and its typed name is
  // used as the chip label immediately (the reload behind createPage means
  // pageLinks.label would also resolve it, but the typed name avoids a flash).
  const createWikiPage = useCallback(
    async (name: string): Promise<PageLinkResult> => {
      const id = await pageLinks.createPage(name, pageId ?? null);
      return {id, label: name, icon: pageLinks.icon(id)};
    },
    [pageId],
  );

  // Embed a live database view as its own block (the "Link to database"
  // command), replacing the empty "/" line it was triggered from.
  const insertDbView = useCallback(
    (blockId: string, r: PageLinkResult): void => {
      const found = findBlock(doc, blockId);
      const empty = found && blockType(found.block) === 'paragraph' && (blockText(found.block)?.length ?? 0) === 0;
      editor.insertAfter(blockId, {type: 'dbview', props: {pageId: r.id, name: r.label}});
      if (empty && found) editor.doc.transact(() => found.parent.delete(found.index, 1), 'local');
    },
    [doc, editor],
  );

  const blockEl = useCallback((id: string): HTMLElement | null => {
    return rootRef.current?.querySelector(`[data-block-text="${id}"]`) ?? null;
  }, []);

  // ── Inline formatting ────────────────────────────────────────────────────
  const toggleFormat = useCallback(
    (key: keyof InlineAttrs, value?: string): void => {
      const id = editor.focusedId;
      if (!id) return;
      const found = findBlock(doc, id);
      const text = found && blockText(found.block);
      const el = blockEl(id);
      if (!found || !text || !el) return;
      const sel = readSelection(el);
      if (!sel || sel.end === sel.start) return;
      const on = rangeHasAttr(text, sel.start, sel.end, key);
      doc.transact(() => {
        text.format(sel.start, sel.end - sel.start, {[key]: on ? null : (value ?? true)});
      }, 'local');
      editor.requestCaret({blockId: id, offset: sel.start});
      // Restore the full range after the re-render so repeated toggles work —
      // but ONLY if the selection is still where the apply left it (the
      // collapsed caret at sel.start). If it moved meanwhile (a click, an
      // arrow key, a programmatic caret), restoring the stale range would
      // make the next keystroke REPLACE the whole formatted span — the
      // type-at-a-link's-edge corruption.
      requestAnimationFrame(() => {
        const node = blockEl(id);
        if (!node) return;
        const current = readSelection(node);
        if (current && current.start === sel.start && current.end === sel.start) {
          writeSelection(node, sel.start, sel.end);
        }
      });
    },
    [editor, doc, blockEl],
  );

  // Set (or clear, with null) a non-boolean inline attribute on the selection —
  // colours pick a value rather than toggling on/off like bold.
  const setFormat = useCallback(
    (key: keyof InlineAttrs, value: string | null): void => {
      const id = editor.focusedId;
      if (!id) return;
      const found = findBlock(doc, id);
      const text = found && blockText(found.block);
      const el = blockEl(id);
      if (!found || !text || !el) return;
      const sel = readSelection(el);
      if (!sel || sel.end === sel.start) return;
      doc.transact(() => {
        text.format(sel.start, sel.end - sel.start, {[key]: value ?? null});
      }, 'local');
      editor.requestCaret({blockId: id, offset: sel.start});
      requestAnimationFrame(() => {
        const node = blockEl(id);
        if (!node) return;
        const current = readSelection(node);
        if (current && current.start === sel.start && current.end === sel.start) writeSelection(node, sel.start, sel.end);
      });
    },
    [editor, doc, blockEl],
  );

  // ── Inline toolbar ───────────────────────────────────────────────────────
  const scheduleToolbar = useCallback((): void => {
    requestAnimationFrame(() => {
      const id = editor.focusedId;
      const el = id ? blockEl(id) : null;
      const domSel = document.getSelection();
      if (!id || !el || !domSel || domSel.rangeCount === 0 || domSel.isCollapsed) {
        setToolbar(null);
        return;
      }
      const sel = readSelection(el);
      if (!sel || sel.end === sel.start) {
        setToolbar(null);
        return;
      }
      const found = findBlock(doc, id);
      const text = found && blockText(found.block);
      setToolbar({
        anchorEl: el,
        active: text
          ? {
            b: rangeHasAttr(text, sel.start, sel.end, 'b'),
            i: rangeHasAttr(text, sel.start, sel.end, 'i'),
            u: rangeHasAttr(text, sel.start, sel.end, 'u'),
            s: rangeHasAttr(text, sel.start, sel.end, 's'),
            c: rangeHasAttr(text, sel.start, sel.end, 'c'),
            a: rangeHasAttr(text, sel.start, sel.end, 'a'),
          }
          : {},
      });
    });
  }, [editor, blockEl, doc]);

  // ── Slash menu ───────────────────────────────────────────────────────────
  const slashQuery = useCallback(
    (state: SlashState, caret: number): string => {
      const found = findBlock(doc, state.blockId);
      const text = found && blockText(found.block);
      if (!text) return '';
      const s = text.toString();
      // The query is what was typed after the '/', bounded by the CARET —
      // not by the next whitespace, so multi-word labels ("hello test") stay
      // matchable and the pick deletes the whole typed run. A '/' typed at
      // the start of a non-empty block would otherwise swallow the trailing
      // text into the query and close the menu on the first keystroke. The
      // caller passes the post-edit caret (the DOM selection is a render
      // behind here).
      // The query starts after the trigger — one char for "/"/"@"/":", two for
      // the "[[" wikilink (state.trigger records the literal so this is generic).
      const triggerLen = state.trigger?.length ?? 1;
      const after = s.slice(state.anchorOffset + triggerLen);
      return after.slice(0, Math.max(0, caret - state.anchorOffset - triggerLen));
    },
    [doc],
  );

  const ui = useMemo<EditorUI>(() => {
    const closeSlash = (): void => setSlash((s) => ({...s, open: false, query: '', index: 0}));
    const closeMention = (): void => setMention((s) => ({...s, open: false, query: '', index: 0}));
    const closeWiki = (): void => setWiki((s) => ({...s, open: false, query: '', index: 0}));
    const closeEmoji = (): void => setEmoji((s) => ({...s, open: false, query: '', index: 0}));
    // The query tracker is trigger-agnostic — it just slices text after the
    // anchor up to the caret, so the slash, mention, wikilink and emoji menus
    // share it. `trigger` is the literal sequence (one char for "/"/"@"/":",
    // two for the "[[" wikilink) — the menu closes if it's been edited away.
    const triggerOpen = (caret: number, s: SlashState, trigger: string): SlashState => {
      if (!s.open) return s;
      const found = findBlock(doc, s.blockId);
      const text = found && blockText(found.block);
      if (!text || text.toString().slice(s.anchorOffset, s.anchorOffset + trigger.length) !== trigger) {
        return {...s, open: false}; // trigger deleted
      }
      return {...s, query: slashQuery(s, caret), index: 0};
    };
    return {
      slash,
      mention,
      wiki,
      emoji,
      spellcheck,
      openSlash: (id, anchorOffset) => {
        // Only one trigger menu at a time — opening this closes its siblings so
        // typing e.g. "/ :" never stacks two popovers.
        setSlash({open: true, blockId: id, anchorOffset, query: '', index: 0});
        closeMention();
        closeWiki();
        closeEmoji();
      },
      updateSlash: (caret) => setSlash((s) => triggerOpen(caret, s, '/')),
      closeSlash,
      slashKey: (key) => {
        // handled inside SlashMenu via props — stored here so text blocks can forward keys
        setSlash((s) => ({...s, keyEvent: {key, n: (s.keyEvent?.n ?? 0) + 1}}));
      },
      openMention: (id, anchorOffset) => {
        setMention({open: true, blockId: id, anchorOffset, query: '', index: 0});
        closeSlash();
        closeWiki();
        closeEmoji();
      },
      updateMention: (caret) => setMention((s) => triggerOpen(caret, s, '@')),
      closeMention,
      mentionKey: (key) => setMention((s) => ({...s, keyEvent: {key, n: (s.keyEvent?.n ?? 0) + 1}})),
      openWiki: (id, anchorOffset) => {
        setWiki({open: true, blockId: id, anchorOffset, query: '', index: 0, trigger: '[['});
        closeSlash();
        closeMention();
        closeEmoji();
      },
      updateWiki: (caret) => setWiki((s) => triggerOpen(caret, s, s.trigger ?? '[[')),
      closeWiki,
      wikiKey: (key) => setWiki((s) => ({...s, keyEvent: {key, n: (s.keyEvent?.n ?? 0) + 1}})),
      openEmoji: (id, anchorOffset) => {
        setEmoji({open: true, blockId: id, anchorOffset, query: '', index: 0});
        closeSlash();
        closeMention();
        closeWiki();
      },
      updateEmoji: (caret) => setEmoji((s) => triggerOpen(caret, s, ':')),
      closeEmoji,
      emojiKey: (key) => setEmoji((s) => ({...s, keyEvent: {key, n: (s.keyEvent?.n ?? 0) + 1}})),
      toggleFormat,
      scheduleToolbar,
      leaveToTitle: onLeaveToTitle,
    };
  }, [slash, mention, wiki, emoji, doc, slashQuery, toggleFormat, scheduleToolbar, spellcheck, onLeaveToTitle]);

  // ── Drag and drop ────────────────────────────────────────────────────────
  const computeRegion = (e: React.DragEvent | React.PointerEvent, el: HTMLElement, allowSides: boolean): DropRegion => {
    const rect = el.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    if (allowSides && x < 0.18) return 'left';
    if (allowSides && x > 0.82) return 'right';
    const y = (e.clientY - rect.top) / rect.height;
    return y < 0.5 ? 'above' : 'below';
  };

  const performDrop = useCallback(
    (sourceId: string, targetId: string, region: DropRegion, ids?: string[]): void => {
      // Multi-block drag: move the whole (document-ordered) selection to the
      // drop point in one undo step. Side-drops are disabled while multi-
      // dragging (v1), so region is always above/below here.
      if (ids && ids.length > 1) {
        if (ids.includes(targetId)) return; // never drop the selection onto itself
        const target = findBlock(doc, targetId);
        if (!target) return;
        const parentBlock = parentBlockOf(doc, target.parent);
        const parentId = parentBlock ? blockId(parentBlock) : null;
        moveBlocks(doc, ids, parentId, region === 'above' ? target.index : target.index + 1);
        setLive(t('editor.drag.movedBlocks', {count: ids.length}));
        return;
      }
      if (sourceId === targetId) return;
      if (region === 'left' || region === 'right') {
        dropBeside(doc, sourceId, targetId, region);
        setLive('Moved into columns');
      } else {
        const target = findBlock(doc, targetId);
        if (!target) return;
        const parentBlock = parentBlockOf(doc, target.parent);
        const parentId = parentBlock ? blockId(parentBlock) : null;
        moveBlock(doc, sourceId, parentId, region === 'above' ? target.index : target.index + 1);
        setLive(region === 'above' ? 'Moved above' : 'Moved below');
      }
    },
    [doc],
  );

  // ── File ingest (paste / drop → image or HTML-artifact blocks) ─────────────
  // The third path — the "/Image" and "/HTML artifact" slash commands — inserts
  // an empty block whose placeholder opens the file picker (see SlashMenu +
  // ImageBlockView / HtmlArtifactBlockView), so it needs no handler here. Mixed
  // transfers route per file: images → `imageBlockFromFile`, HTML documents →
  // `htmlArtifactBlockFromFile`; blocks land in transfer order.
  const insertFilesAsBlocks = useCallback(
    (files: File[], afterId: string | null): void => {
      let after = afterId;
      void (async () => {
        for (const file of files) {
          // Thread the hosting page id (the BlockEditor `pageId` prop) so the
          // ingest can upload the bytes to the asset store and ref them to it
          // (Assets A2); without a pageId images fall back to an inline
          // data-URL and artifacts fail with a friendly message.
          const res = isHtmlFile(file)
            ? await htmlArtifactBlockFromFile(file, pageId)
            : await imageBlockFromFile(file, pageId);
          if ('error' in res) {
            setLive(res.error);
            continue;
          }
          after = editor.insertAfter(after, res.block);
        }
      })();
    },
    [editor, pageId],
  );

  const lastTopId = (): string | null => {
    const root = rootBlocks(doc);
    return root.length > 0 ? blockId(root.get(root.length - 1)) : null;
  };

  const pasteIntoTable = useCallback(
    (e: ClipboardEvent): boolean => {
      if (readOnly || e.defaultPrevented || !e.clipboardData) return false;
      const range = cellSelRef.current;
      const eventEl = e.target instanceof Element ? e.target : document.activeElement;
      const cellEl = eventEl?.closest?.('[data-block-text]') as HTMLElement | null;
      const cellId = cellEl?.dataset.blockText;
      const caret = cellId ? cellPosition(doc, cellId) : null;
      if (!range && (!cellEl || !rootRef.current?.contains(cellEl) || !caret)) return false;
      const tableId = range?.tableId ?? blockId(caret!.table);
      const anchor = range
        ? {row: Math.min(range.anchor.row, range.focus.row), col: Math.min(range.anchor.col, range.focus.col)}
        : {row: caret!.row, col: caret!.col};
      const table = findBlock(doc, tableId);
      if (!table) return false;
      const anchorCell = tableCellAt(tableGrid(table.block), anchor.row, anchor.col);
      const tableCellEl = range && anchorCell
        ? (rootRef.current?.querySelector(`[data-block-text="${blockId(anchorCell)}"]`) as HTMLElement | null)
        : cellEl;
      if (
        tableCellEl?.closest('.obe-group-locked,.obe-cnt-locked') ||
        tableCellEl?.getAttribute('contenteditable') === 'false'
      ) return false;
      const grid = parseClipboardGrid({
        html: e.clipboardData.getData('text/html'),
        text: e.clipboardData.getData('text/plain'),
      });
      if (!grid) return false;
      e.preventDefault();
      e.stopPropagation();
      const written = tablePasteGrid(doc, tableId, anchor, grid, {range: range ?? undefined});
      if (written) {
        setCellSel({
          tableId,
          anchor,
          focus: {row: anchor.row + written.rows - 1, col: anchor.col + written.cols - 1},
        });
      }
      setLive('Pasted cells');
      return true;
    },
    [doc, readOnly],
  );

  React.useEffect(() => {
    if (!cellSel) return;
    const onPaste = (e: ClipboardEvent): void => { pasteIntoTable(e); };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, [cellSel, pasteIntoTable]);

  const onRootPaste = (e: React.ClipboardEvent): void => {
    if (!insideRoot(e) || readOnly) return;
    if (pasteIntoTable(e.nativeEvent)) return;
    const files = editorFilesFromTransfer(e.clipboardData);
    if (files.length === 0) return; // let text paste fall through to the block
    e.preventDefault();
    e.stopPropagation();
    insertFilesAsBlocks(files, editor.focusedId ?? lastTopId());
  };

  // Is this drag carrying external files (vs an internal block move)?
  const isFileDrag = (e: React.DragEvent): boolean =>
    !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files');

  const onRootDragOver = (e: React.DragEvent): void => {
    // Internal block-move drags are handled per-row; only claim external files.
    if (!insideRoot(e) || readOnly || drag || !isFileDrag(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    if (!fileDragOver) setFileDragOver(true);
  };

  const onRootDragLeave = (e: React.DragEvent): void => {
    if (!insideRoot(e)) return;
    // Only clear when the pointer actually left the editor region (dragleave
    // also fires crossing child boundaries).
    if (fileDragOver && !e.currentTarget.contains(e.relatedTarget as Node | null)) setFileDragOver(false);
  };

  const onRootDrop = (e: React.DragEvent): void => {
    if (!insideRoot(e) || readOnly || drag) return; // a block move is finishing — not our drop
    // We claimed this drag in `onRootDragOver` (preventDefault → the browser
    // offered it here), so we MUST preventDefault the drop too — otherwise a
    // dropped non-ingestible file (a PDF, say) triggers the browser's default
    // file-open and navigates away from the editing session.
    if (!isFileDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    setFileDragOver(false);
    const files = editorFilesFromTransfer(e.dataTransfer);
    if (files.length === 0) {
      setLive('That file isn’t an image or an HTML file.');
      return;
    }
    // Drop onto a row → insert after it; otherwise after the caret / at the end.
    const rowEl = (e.target as HTMLElement)?.closest?.('[data-block-row]') as HTMLElement | null;
    const afterId = rowEl?.dataset.blockRow ?? editor.focusedId ?? lastTopId();
    insertFilesAsBlocks(files, afterId);
  };

  // ── Block-selection keyboard ─────────────────────────────────────────────
  // Bound at the document level while a selection exists: selecting a block
  // blurs the text caret, so key events land on <body>, never on this tree.
  const onRootKeyDown = (e: KeyboardEvent): void => {
    if (editor.selection.size === 0) return;
    // The keydown that *created* the selection (Escape in a text block —
    // already preventDefaulted) reaches this listener on the same dispatch,
    // because React flushes the attaching effect synchronously mid-bubble.
    if (e.defaultPrevented) return;
    const ids = topLevelIds(doc);
    const selectedTop = ids.filter((id) => editor.selection.has(id));
    if (e.key === 'Backspace' || e.key === 'Delete') {
      e.preventDefault();
      editor.removeSelected();
      setLive('Deleted');
      return;
    }
    if (e.key === 'Escape') {
      editor.clearSelection();
      return;
    }
    if (matchShortcut(e, SHORTCUTS.duplicateBlock)) {
      e.preventDefault();
      editor.duplicateSelected();
      setLive('Duplicated');
      return;
    }
    if (matchShortcut(e, SHORTCUTS.moveBlockUp)) {
      e.preventDefault();
      editor.moveSelected(-1);
      setLive('Moved up');
      return;
    }
    if (matchShortcut(e, SHORTCUTS.moveBlockDown)) {
      e.preventDefault();
      editor.moveSelected(1);
      setLive('Moved down');
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const dir = e.key === 'ArrowDown' ? 1 : -1;
      const edge = selectedTop.length > 0 ? (dir === 1 ? selectedTop[selectedTop.length - 1] : selectedTop[0]) : ids[0];
      const at = ids.indexOf(edge);
      const next = ids[at + dir];
      if (!next) return;
      if (e.shiftKey) editor.setSelection([...editor.selection, next]);
      else editor.setSelection([next]);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const id = selectedTop[0];
      if (id) {
        editor.clearSelection();
        editor.requestCaret({blockId: firstTextDescendant(doc, id) ?? id, offset: 'end'});
      }
    }
  };

  // Cross-block native selections convert to block selection: per-block
  // contenteditables can't host a real multi-block text range (typing into
  // one was a silent no-op), so spanning rows highlight as selected blocks
  // instead; mouseup collapses the native range and the block-selection
  // keyboard takes over.
  const uiRef = useRef(ui);
  uiRef.current = ui;
  React.useEffect(() => {
    if (readOnly) return;
    const spannedRows = (): string[] => {
      const sel = document.getSelection();
      const root = rootRef.current;
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed || !root) return [];
      const range = sel.getRangeAt(0);
      if (!root.contains(range.commonAncestorContainer)) return [];
      const ids: string[] = [];
      root.querySelectorAll(':scope > [data-block-row]').forEach((row) => {
        if (range.intersectsNode(row)) ids.push((row as HTMLElement).dataset.blockRow!);
      });
      return ids;
    };
    const onSelectionChange = (): void => {
      const ids = spannedRows();
      if (ids.length > 1) editor.setSelection(ids);
    };
    const onMouseUp = (): void => {
      const ids = spannedRows();
      if (ids.length > 1) {
        document.getSelection()?.removeAllRanges();
        (document.activeElement as HTMLElement | null)?.blur();
        editor.setSelection(ids);
      }
    };
    const onClipboard = (e: ClipboardEvent, cut: boolean): void => {
      if (editor.selection.size === 0 || !e.clipboardData) return;
      e.preventDefault();
      // Selected top-level blocks serialize three ways: markdown for text
      // consumers, HTML for rich editors, and the block JSON for a lossless
      // paste back into this (or any) OpenBook document.
      const blocks = rootBlocks(doc)
        .map((b) => b)
        .filter((b) => editor.selection.has(blockId(b)))
        .map((b) => blockToJSON(b));
      if (blocks.length === 0) return;
      e.clipboardData.setData('text/plain', blocksToMarkdown(blocks));
      e.clipboardData.setData('text/html', blocksToHtml(blocks));
      // Wrapped payload: paste always recreates BLOCKS (a copied paragraph
      // must not splice inline like external single-line HTML does).
      e.clipboardData.setData('application/x-obe-blocks', JSON.stringify({v: 1, blocks}));
      if (cut) editor.removeSelected();
      setLive(cut ? 'Cut' : 'Copied');
    };
    const onCopy = (e: ClipboardEvent): void => onClipboard(e, false);
    const onCut = (e: ClipboardEvent): void => onClipboard(e, true);
    const onScroll = (e: Event): void => {
      // Scrolling INSIDE the slash menu is the menu working as intended —
      // this listener captures, so its own overflow scroll lands here too.
      if (e.target instanceof Element && e.target.closest('.obe-slash')) return;
      // Fixed-position popups don't track the page — fold them on scroll.
      if (uiRef.current.slash.open) uiRef.current.closeSlash();
      setToolbar(null);
    };
    document.addEventListener('selectionchange', onSelectionChange);
    document.addEventListener('mouseup', onMouseUp);
    document.addEventListener('copy', onCopy);
    document.addEventListener('cut', onCut);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('selectionchange', onSelectionChange);
      document.removeEventListener('mouseup', onMouseUp);
      document.removeEventListener('copy', onCopy);
      document.removeEventListener('cut', onCut);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [editor, readOnly]);

  const onRootKeyDownRef = useRef(onRootKeyDown);
  onRootKeyDownRef.current = onRootKeyDown;
  const hasSelection = editor.selection.size > 0;
  React.useEffect(() => {
    if (!hasSelection) return;
    const listener = (e: KeyboardEvent): void => onRootKeyDownRef.current(e);
    document.addEventListener('keydown', listener);
    return () => document.removeEventListener('keydown', listener);
  }, [hasSelection]);

  // ── Cell-range selection (TBL-5) ────────────────────────────────────────────
  // A native selection spanning >1 cell of the SAME table becomes a cell-range
  // selection. It is NOT a block selection: a table is one top-level row, so the
  // block converter above never fires for a within-table span (its spannedRows
  // stays length 1); a span crossing the table boundary DOES hit ≥2 top-level
  // rows and falls through to that block converter (acceptance #5, unchanged).
  // Live during the drag via selectionchange; mouseup collapses the native range
  // so the highlight is clean and the document-level cell keyboard takes over.
  // Runs in BOTH modes — readOnly keeps SELECT + COPY (never clear/cut, #4).
  React.useEffect(() => {
    const cellIdOf = (node: Node | null): string | null => {
      const el = node instanceof Element ? node : (node?.parentElement ?? null);
      const cellEl = el?.closest?.('[data-block-text]') as HTMLElement | null;
      const id = cellEl?.dataset.blockText;
      if (!id) return null;
      const found = findBlock(doc, id);
      return found && blockType(found.block) === 'cell' ? id : null;
    };
    // The native selection reduced to a same-table cell span (anchor→focus),
    // or null when it is collapsed, single-cell (plain text edit), or crosses
    // out of the table.
    const spanFromNative = (): CellSelection | null => {
      const root = rootRef.current;
      const sel = document.getSelection();
      if (!root || !sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
      const range = sel.getRangeAt(0);
      if (!root.contains(range.commonAncestorContainer)) return null;
      const aId = cellIdOf(sel.anchorNode);
      const fId = cellIdOf(sel.focusNode);
      if (!aId || !fId || aId === fId) return null; // one cell → native text select
      const aPos = cellPosition(doc, aId);
      const fPos = cellPosition(doc, fId);
      if (!aPos || !fPos || aPos.table !== fPos.table) return null; // crosses tables
      return {
        tableId: blockId(aPos.table),
        anchor: {row: aPos.row, col: aPos.col},
        focus: {row: fPos.row, col: fPos.col},
      };
    };
    const onSelectionChange = (): void => {
      const span = spanFromNative();
      if (span) {
        editor.clearSelection();
        setCellSel(span); // live rectangle during the drag
      }
    };
    const onMouseUp = (): void => {
      const span = spanFromNative();
      if (!span) return;
      editor.clearSelection();
      setCellSel(span);
      // Collapse + blur so keydowns route to the document-level cell keyboard
      // and no native highlight lingers under the cell highlight.
      document.getSelection()?.removeAllRanges();
      (document.activeElement as HTMLElement | null)?.blur();
    };
    const onClipboard = (e: ClipboardEvent, cut: boolean): void => {
      const csel = cellSelRef.current;
      if (!csel || !e.clipboardData) return; // block copy handler owns the rest
      e.preventDefault();
      const rect = normalizeCellRect(csel.anchor, csel.focus);
      const payload = tableRangeClipboardPayload(doc, csel.tableId, rect);
      e.clipboardData.setData('text/plain', payload.text);
      e.clipboardData.setData('text/html', payload.html);
      // Cut = copy + clear; the clear half is disabled on a read-only surface,
      // so there Cut degrades to a plain Copy (never mutates — acceptance #4).
      if (cut && !readOnly) {
        clearCellRange(doc, csel.tableId, rect);
        setLive('Cut');
      } else {
        setLive('Copied');
      }
    };
    const onCopy = (e: ClipboardEvent): void => onClipboard(e, false);
    const onCut = (e: ClipboardEvent): void => onClipboard(e, true);
    document.addEventListener('selectionchange', onSelectionChange);
    document.addEventListener('mouseup', onMouseUp);
    document.addEventListener('copy', onCopy);
    document.addEventListener('cut', onCut);
    return () => {
      document.removeEventListener('selectionchange', onSelectionChange);
      document.removeEventListener('mouseup', onMouseUp);
      document.removeEventListener('copy', onCopy);
      document.removeEventListener('cut', onCut);
    };
  }, [doc, editor, readOnly]);

  // Cell-range keyboard: bound at the document level while a range exists (the
  // range blurs the caret, so keys land on <body>). Escape clears; Backspace/
  // Delete clears the cells in one undo step (disabled read-only); Shift+arrows
  // extend the focus corner; a plain arrow collapses to a single-cell caret.
  const hasCellSel = cellSel !== null;
  React.useEffect(() => {
    if (!hasCellSel) return;
    const dirs: Record<string, {dr: number; dc: number}> = {
      ArrowUp: {dr: -1, dc: 0},
      ArrowDown: {dr: 1, dc: 0},
      ArrowLeft: {dr: 0, dc: -1},
      ArrowRight: {dr: 0, dc: 1},
    };
    const onKey = (e: KeyboardEvent): void => {
      const sel = cellSelRef.current;
      if (!sel) return;
      // Undo/redo while the range is shown: a cleared range blurs the caret, so
      // TextBlockView's own Cmd+Z never sees the keys — route them here so the
      // clear is immediately reversible (one transact = one step).
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) editor.undo.redo();
        else editor.undo.undo();
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setCellSel(null);
        return;
      }
      if (e.key === 'Backspace' || e.key === 'Delete') {
        if (readOnly) return; // clear disabled on a read-only surface
        e.preventDefault();
        clearCellRange(doc, sel.tableId, normalizeCellRect(sel.anchor, sel.focus));
        setLive('Cleared cells');
        return;
      }
      const d = dirs[e.key];
      if (!d) return;
      e.preventDefault();
      const table = findBlock(doc, sel.tableId);
      if (!table) return;
      const grid = tableGrid(table.block);
      const maxRow = grid.rows.length - 1;
      const maxCol = grid.width - 1;
      const focus = {
        row: Math.max(0, Math.min(maxRow, sel.focus.row + d.dr)),
        col: Math.max(0, Math.min(maxCol, sel.focus.col + d.dc)),
      };
      if (e.shiftKey) {
        setCellSel({...sel, focus});
        return;
      }
      // Plain arrow collapses the range to a single-cell caret at the moved focus.
      setCellSel(null);
      const cell = tableCellAt(grid, focus.row, focus.col);
      if (cell) editor.requestCaret({blockId: blockId(cell), offset: 'end'});
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [hasCellSel, doc, editor, readOnly]);

  // ── Local caret → presence (Collab T5) ─────────────────────────────────────
  // Broadcast where this user's caret is so peers can render it as a remote
  // cursor (T4 deferred the editor-side caret tracking here). Throttled (~10Hz)
  // so a fast-moving selection doesn't flood the relay; cleared on blur / unmount
  // so we never leave a ghost cursor. A read-only surface has no editable caret.
  //
  // ONE reporter for the component's lifetime: both the selectionchange path and
  // the blur backstop go through its `clear`, which cancels any pending trailing
  // emit. Were they separate, a caret move <100ms before a blur would fire its
  // trailing emit AFTER the null and strand a stale peer caret.
  const focusedIdRef = useRef(editor.focusedId);
  focusedIdRef.current = editor.focusedId;
  const onSelectionChangeRef = useRef(onSelectionChange);
  onSelectionChangeRef.current = onSelectionChange;
  const reporterRef = useRef<SelectionReporter | null>(null);
  if (!reporterRef.current) {
    reporterRef.current = createSelectionReporter((sel) => onSelectionChangeRef.current?.(sel));
  }
  React.useEffect(() => {
    if (readOnly || !onSelectionChange) return;
    const reporter = reporterRef.current!;
    const handle = (): void => {
      const id = focusedIdRef.current;
      if (!id) {
        reporter.clear();
        return;
      }
      const el = blockEl(id);
      if (!el) {
        reporter.clear();
        return;
      }
      // The DOM selection can sit outside the focused block (e.g. it moved to the
      // title) — readSelectionDirected returns null then, so clear rather than
      // guess. Directional offsets keep the caret on the true head for an RTL drag.
      const sel = readSelectionDirected(el);
      if (!sel) {
        reporter.clear();
        return;
      }
      reporter.emit({blockId: id, anchor: sel.anchor, head: sel.head});
    };
    document.addEventListener('selectionchange', handle);
    return () => {
      document.removeEventListener('selectionchange', handle);
      reporter.clear(); // drop our caret when the editor unmounts / goes read-only
    };
  }, [readOnly, blockEl, onSelectionChange]);

  // Clear on blur even if the engine fires no selectionchange (some WKWebView blur
  // paths): the focused block going null is an explicit "the caret left the editor".
  // Routed through the SAME reporter so it cancels a pending trailing emit too.
  React.useEffect(() => {
    if (readOnly || !onSelectionChange) return;
    if (editor.focusedId === null) reporterRef.current?.clear();
  }, [editor.focusedId, readOnly, onSelectionChange]);

  // Cmd+A escalation: from full-block text selection to all blocks.
  const onRootKeyDownCapture = (e: React.KeyboardEvent): void => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a' && editor.focusedId) {
      const el = blockEl(editor.focusedId);
      const found = findBlock(doc, editor.focusedId);
      const text = found && blockText(found.block);
      if (el && text) {
        const sel = readSelection(el);
        const all = sel && sel.start === 0 && sel.end === text.length;
        if (all || text.length === 0) {
          e.preventDefault();
          (document.activeElement as HTMLElement | null)?.blur();
          editor.setSelection(topLevelIds(doc));
        }
      }
    }
  };

  // ── Marquee (rubber-band) rectangle select ───────────────────────────────
  // A drag beginning on empty editor chrome (not text / a control) draws a
  // rectangle that live-selects the top-level rows it intersects. It COEXISTS
  // with the plain-click clear: a click that never moves ≥5px does nothing here
  // and the existing handlers run. Read-only surfaces opt out — selection there
  // has no copy/keyboard path wired, and we must never expose a mutation route.
  const startMarquee = (e: React.MouseEvent): void => {
    if (readOnly || e.button !== 0 || e.shiftKey) return;
    const root = rootRef.current;
    if (!root) return;
    const target = e.target as HTMLElement;
    // Only empty chrome arms the marquee — never text, media, or a control.
    if (target.closest(MARQUEE_EXCLUDE)) return;

    const sx = e.clientX;
    const sy = e.clientY;
    const scroller = scrollParent(root);
    const readScroll = (): {top: number; left: number} =>
      scroller === window
        ? {top: window.scrollY, left: window.scrollX}
        : {top: (scroller as HTMLElement).scrollTop, left: (scroller as HTMLElement).scrollLeft};
    const startScroll = readScroll();

    let engaged = false;
    let raf: number | null = null;
    let px = sx;
    let py = sy;
    let lastKey = '';

    const selectIfChanged = (ids: string[]): void => {
      const key = ids.join('|');
      if (key === lastKey) return;
      lastKey = key;
      editor.setSelection(ids);
    };

    const recompute = (): void => {
      const now = readScroll();
      // Re-derive the anchor's CURRENT client position from the scroll delta so
      // the rectangle stays pinned to the document point it started on while the
      // page auto-scrolls under it.
      const ax = sx + (startScroll.left - now.left);
      const ay = sy + (startScroll.top - now.top);
      const rect = marqueeRect(ax, ay, px, py); // client coords
      const rows: {id: string; rect: Rect}[] = [];
      root.querySelectorAll(':scope > [data-block-row]').forEach((el) => {
        const r = (el as HTMLElement).getBoundingClientRect();
        rows.push({id: (el as HTMLElement).dataset.blockRow!, rect: {left: r.left, top: r.top, right: r.right, bottom: r.bottom}});
      });
      selectIfChanged(rowsInMarquee(rect, rows));
      const rr = root.getBoundingClientRect();
      setMarquee({left: rect.left - rr.left, top: rect.top - rr.top, width: rect.right - rect.left, height: rect.bottom - rect.top});
    };

    const autoScroll = (): void => {
      const margin = 48;
      const speed = 14;
      const bounds =
        scroller === window
          ? {top: 0, bottom: window.innerHeight}
          : (() => {
            const b = (scroller as HTMLElement).getBoundingClientRect();
            return {top: b.top, bottom: b.bottom};
          })();
      let dy = 0;
      if (py < bounds.top + margin) dy = -speed;
      else if (py > bounds.bottom - margin) dy = speed;
      if (dy === 0) return;
      if (scroller === window) window.scrollBy(0, dy);
      else (scroller as HTMLElement).scrollTop += dy;
    };

    // The rAF loop only drives AUTO-SCROLL: while the pointer sits in a hot zone
    // no `mousemove` fires, so we need a self-scheduling tick to keep scrolling
    // (and re-hit-testing) the document under a stationary pointer.
    const loop = (): void => {
      autoScroll();
      recompute();
      raf = engaged ? requestAnimationFrame(loop) : null;
    };

    const onMove = (ev: MouseEvent): void => {
      px = ev.clientX;
      py = ev.clientY;
      if (!engaged) {
        if (Math.abs(px - sx) < 5 && Math.abs(py - sy) < 5) return;
        engaged = true;
        // Block-selection takes over from the caret: drop focus + any native
        // range so the block-selection keyboard router (document-level) engages.
        (document.activeElement as HTMLElement | null)?.blur();
        document.getSelection()?.removeAllRanges();
        root.classList.add('obe-marqueeing'); // user-select:none while dragging
        if (raf == null) raf = requestAnimationFrame(loop);
      }
      // Update the rectangle synchronously on every move so the overlay never
      // waits on a frame (and never lags the pointer).
      recompute();
      ev.preventDefault();
    };

    // Single teardown for the whole gesture: detach the window listeners, kill
    // the rAF loop, drop the overlay + drag class. Invoked from onUp on a normal
    // release AND from the unmount / read-only-flip effects when a drag is cut
    // short — so nothing leaks past the editor's lifetime.
    const teardown = (): void => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      if (raf != null) cancelAnimationFrame(raf);
      raf = null;
      engaged = false;
      root.classList.remove('obe-marqueeing');
      setMarquee(null);
      marqueeTeardownRef.current = null;
    };

    const onUp = (): void => {
      const wasEngaged = engaged;
      if (wasEngaged) recompute(); // final frame — keep whatever the release rect selected
      teardown();
      if (wasEngaged) suppressClickRef.current = true; // eat the trailing click
      // A plain click (never engaged) falls through to the native handlers.
    };

    marqueeTeardownRef.current = teardown;
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  // ── Cell drag-select (TBL-5) ─────────────────────────────────────────────────
  // Each cell is its OWN contenteditable, and a browser will not extend a native
  // text selection across separate editables — so a cell drag is tracked by grid
  // COORDINATE (hit-testing the pointer against `[data-block-text]` cells),
  // independent of the native selection. A press that never leaves its start
  // cell stays a plain caret / intra-cell text drag; the moment the pointer
  // enters a DIFFERENT cell of the SAME table it engages, blurs the caret, and
  // lays down a live rectangle. Selection is allowed read-only (copy path).
  const startCellDrag = (e: React.MouseEvent): void => {
    if (e.button !== 0 || e.shiftKey) return;
    const startEl = (e.target as HTMLElement).closest?.('[data-block-text]') as HTMLElement | null;
    const startId = startEl?.dataset.blockText;
    if (!startId) return;
    const startPos = cellPosition(doc, startId);
    if (!startPos) return; // the press was not inside a table cell
    const tableId = blockId(startPos.table);
    const anchor = {row: startPos.row, col: startPos.col};
    let engaged = false;
    // The cell of THIS table under a client point, or null (outside / other table).
    const cellAt = (x: number, y: number): {row: number; col: number} | null => {
      for (const el of document.elementsFromPoint(x, y)) {
        const cEl = (el as HTMLElement).closest?.('[data-block-text]') as HTMLElement | null;
        const cid = cEl?.dataset.blockText;
        if (!cid) continue;
        const p = cellPosition(doc, cid);
        return p && blockId(p.table) === tableId ? {row: p.row, col: p.col} : null;
      }
      return null;
    };
    const onMove = (ev: MouseEvent): void => {
      const cur = cellAt(ev.clientX, ev.clientY);
      if (!cur) return;
      if (!engaged) {
        if (cur.row === anchor.row && cur.col === anchor.col) return; // still in start cell
        engaged = true;
        (document.activeElement as HTMLElement | null)?.blur();
        editor.clearSelection();
      }
      // Suppress the native selection + keep the rectangle live under the pointer.
      document.getSelection()?.removeAllRanges();
      setCellSel({tableId, anchor, focus: cur});
      ev.preventDefault();
    };
    // Single teardown for the whole gesture: detach the window listeners and
    // drop the transient drag state. Invoked from onUp on a normal release AND
    // from the unmount / read-only-flip effects when a drag is cut short — so
    // neither listener leaks past the editor's lifetime (the next move would
    // otherwise run cellPosition on a detached doc + setCellSel on a dead tree).
    const teardown = (): void => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      engaged = false;
      cellDragTeardownRef.current = null;
    };
    const onUp = (): void => {
      const wasEngaged = engaged;
      teardown();
      if (wasEngaged) {
        document.getSelection()?.removeAllRanges();
        (document.activeElement as HTMLElement | null)?.blur();
        suppressClickRef.current = true; // eat the trailing click (no caret jump)
      }
    };
    cellDragTeardownRef.current = teardown;
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  // Cut a live marquee short when the editor unmounts, so its window listeners
  // and self-scheduling rAF don't outlive the component.
  React.useEffect(() => () => marqueeTeardownRef.current?.(), []);

  // A read-only flip mid-drag has no selection/copy path — tear the marquee down
  // rather than leave it dangling on a now-frozen surface.
  React.useEffect(() => {
    if (readOnly) marqueeTeardownRef.current?.();
  }, [readOnly]);

  // Cut a live cell drag-select short when the editor unmounts, so its window
  // listeners don't outlive the component (the next move would run on a detached
  // doc + set state on an unmounted tree).
  React.useEffect(() => () => cellDragTeardownRef.current?.(), []);

  // A read-only flip mid-drag has no selection/copy path — tear the cell drag
  // down too (selection-only, so low stakes, but keep parity with the marquee).
  React.useEffect(() => {
    if (readOnly) cellDragTeardownRef.current?.();
  }, [readOnly]);

  return (
    <div
      ref={rootRef}
      className={['obe-root', fullWidth && 'obe-full', compact && 'obe-compact', readOnly && 'obe-readonly', fileDragOver && 'obe-file-dragover'].filter(Boolean).join(' ')}
      role="region"
      aria-label={ariaLabel ?? 'Page content'}
      onKeyDownCapture={onRootKeyDownCapture}
      onPaste={onRootPaste}
      onDragOver={onRootDragOver}
      onDragLeave={onRootDragLeave}
      onDrop={onRootDrop}
      onMouseDown={(e) => {
        // React events propagate along the COMPONENT tree, so a press inside a
        // portaled overlay (a Radix context/dropdown menu, whose content is a
        // child of a trigger nested in here) lands on this handler even though
        // its DOM node lives under <body>. Those presses are menu interaction,
        // not canvas interaction: they must not drop a cell range the menu is
        // about to act on (TBL-6), nor arm a marquee. Ignore anything whose
        // target is outside our own DOM subtree.
        if (!insideRoot(e)) return;
        // A real click's mousedown always precedes its click, so clear any stale
        // suppression here: if a marquee drag ended with the pointer OUTSIDE the
        // root (autoscroll drove it to the edge), no click reached onClick to
        // reset the flag and it would otherwise swallow this genuine next click.
        suppressClickRef.current = false;
        // Shift-click extension is owned by the row's / cell's capture handler
        // (which stops propagation) — a shift-mousedown reaching here is empty
        // space, and must NOT collapse a live cell range it is extending.
        if (e.shiftKey) return;
        // Any fresh non-shift press starts over: drop a cell range (a drag then
        // rebuilds one live; a plain click just places a caret).
        setCellSel(null);
        startCellDrag(e); // arms a coordinate-tracked cell drag when inside a cell
        startMarquee(e); // no-ops inside a contenteditable (MARQUEE_EXCLUDE)
        if (e.target === rootRef.current) editor.clearSelection();
      }}
      onClick={(e) => {
        if (suppressClickRef.current) {
          suppressClickRef.current = false;
          return; // a marquee drag just ended here — not a real click
        }
        // Mentions navigate; links open in a new tab. (Mentions are
        // contenteditable=false so a plain click is unambiguous; links keep
        // the caret behavior on plain click only when editing is impossible.)
        const anchor = (e.target as HTMLElement).closest?.('a.obe-mention, a.obe-link');
        if (anchor instanceof HTMLElement) {
          const pageRef = anchor.dataset.pageId;
          if (pageRef) {
            e.preventDefault();
            // Link navigation always drives the PRIMARY pane — including links
            // clicked in the side pane, which stays put as a reference and
            // changes only via an explicit "open in split".
            pageLinks.openPage(pageRef, 'primary');
            return;
          }
          if (anchor.classList.contains('obe-link') && (readOnly || e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            window.open((anchor as HTMLAnchorElement).href, '_blank', 'noreferrer');
            return;
          }
        }
        // Clicking the open space below the last block continues the page:
        // focus a trailing empty paragraph, creating one if needed.
        if (e.target !== rootRef.current || readOnly) return;
        const rows = rootRef.current.querySelectorAll(':scope > [data-block-row]');
        const lastRow = rows[rows.length - 1] as HTMLElement | undefined;
        if (lastRow && e.clientY <= lastRow.getBoundingClientRect().bottom) return;
        const root = rootBlocks(doc);
        const last = root.length > 0 ? root.get(root.length - 1) : null;
        if (last && blockType(last) === 'paragraph' && (blockText(last)?.length ?? 0) === 0) {
          editor.requestCaret({blockId: blockId(last), offset: 0});
        } else {
          editor.insertAfter(last ? blockId(last) : null, {type: 'paragraph'});
        }
      }}
    >
      <CellSelectionContext.Provider value={cellSelCtx}>
        <KitPageLockContext.Provider value={readOnly}>
          <KitLockContext.Provider value={readOnlyLock}>
            <BlockList list={rootBlocks(doc)} editor={editor} ui={ui} drag={drag} setDrag={setDrag} performDrop={performDrop} computeRegion={computeRegion} depth={0} container={null} />
          </KitLockContext.Provider>
        </KitPageLockContext.Provider>
      </CellSelectionContext.Provider>
      {slash.open && (
        <SlashMenu
          state={slash}
          editor={editor}
          anchorEl={blockEl(slash.blockId)}
          rootEl={rootRef.current}
          onClose={ui.closeSlash}
          pageId={pageId}
          onLink={(kind, blockId, anchorOffset) => setLinkPicker({kind, blockId, anchorOffset})}
        />
      )}
      {mention.open && (
        <MentionMenu
          state={mention}
          editor={editor}
          anchorEl={blockEl(mention.blockId)}
          onClose={ui.closeMention}
          onMentionPage={insertMention}
          onInsertText={insertTextAt}
        />
      )}
      {wiki.open && (
        <WikilinkMenu
          state={wiki}
          editor={editor}
          anchorEl={blockEl(wiki.blockId)}
          parentPageId={pageId}
          onClose={ui.closeWiki}
          onMentionPage={insertMention}
          onCreatePage={createWikiPage}
        />
      )}
      {emoji.open && (
        <EmojiMenu
          state={emoji}
          editor={editor}
          anchorEl={blockEl(emoji.blockId)}
          onClose={ui.closeEmoji}
          onInsertText={insertTextAt}
        />
      )}
      {linkPicker && !readOnly && (
        <LinkPicker
          kind={linkPicker.kind}
          anchorEl={blockEl(linkPicker.blockId)}
          onClose={() => setLinkPicker(null)}
          onPick={(r) => {
            if (linkPicker.kind === 'database') insertDbView(linkPicker.blockId, r);
            else insertMention(linkPicker.blockId, linkPicker.anchorOffset, r);
            setLinkPicker(null);
          }}
        />
      )}
      {toolbar && !readOnly && (
        <InlineToolbar state={toolbar} onToggle={toggleFormat} onColor={(key, token) => setFormat(key, token)} />
      )}
      {marquee && (
        <div
          className="obe-marquee"
          aria-hidden
          style={{left: marquee.left, top: marquee.top, width: marquee.width, height: marquee.height}}
        />
      )}
      <div aria-live="polite" className="obe-sr-only">
        {live}
      </div>
    </div>
  );
};

const topLevelIds = (doc: Y.Doc): string[] => rootBlocks(doc).map((b) => blockId(b));

// Multi-block drag ghost: a small pill showing how many blocks are moving.
// setDragImage needs the node in the document when it snapshots, so the pill is
// appended off-screen and removed on the next tick (after the snapshot).
function setGroupDragImage(e: React.DragEvent, count: number): void {
  const ghost = document.createElement('div');
  ghost.className = 'obe-drag-ghost';
  ghost.textContent = t('editor.drag.blockCount', {count});
  ghost.style.position = 'absolute';
  ghost.style.top = '-1000px';
  ghost.style.left = '-1000px';
  document.body.appendChild(ghost);
  e.dataTransfer.setDragImage(ghost, 12, 12);
  setTimeout(() => ghost.remove(), 0);
}

// A marquee only arms on empty editor chrome. Anything a pointer-down should
// "do something else" with — edit text, drag the handle, click a control,
// interact with media / a kit widget — is excluded so the drag keeps its native
// meaning (text selection, HTML5 block drag, button press).
const MARQUEE_EXCLUDE =
  '[contenteditable="true"], input, textarea, select, button, a, label, ' +
  '[role="button"], [role="menuitem"], [role="slider"], [role="checkbox"], [role="tab"], ' +
  'img, canvas, iframe, video, .obe-handle, .obe-gutter-btn';

/** Nearest scrollable ancestor (for marquee auto-scroll); falls back to the window. */
const scrollParent = (el: HTMLElement): HTMLElement | Window => {
  let node: HTMLElement | null = el.parentElement;
  while (node) {
    const style = getComputedStyle(node);
    if (/(auto|scroll|overlay)/.test(style.overflowY) && node.scrollHeight > node.clientHeight) return node;
    node = node.parentElement;
  }
  return window;
};

function firstTextDescendant(doc: Y.Doc, id: string): string | null {
  const found = findBlock(doc, id);
  if (!found) return null;
  if (TEXT_BLOCKS.has(blockType(found.block))) return id;
  const children = blockChildren(found.block);
  if (!children) return null;
  for (let i = 0; i < children.length; i += 1) {
    const hit = firstTextDescendant(doc, blockId(children.get(i)));
    if (hit) return hit;
  }
  return null;
}

// ── Block list + rows ─────────────────────────────────────────────────────────

export interface RowShared {
  editor: BlockEditorController;
  ui: EditorUI;
  drag: DragState | null;
  setDrag: React.Dispatch<React.SetStateAction<DragState | null>>;
  performDrop: (sourceId: string, targetId: string, region: DropRegion, ids?: string[]) => void;
  computeRegion: (e: React.DragEvent | React.PointerEvent, el: HTMLElement, allowSides: boolean) => DropRegion;
  depth: number;
  /** Type of the block whose children these rows are (null at the root) — a
   *  side-drop is offered at the root and inside columns (to create / grow a
   *  columns layout), but not inside groups or tables. */
  container: BlockType | null;
}

const BlockList: React.FC<RowShared & {list: Y.Array<BlockMap>}> = ({list, ...shared}) => (
  <>
    {list.map((block) => (
      <BlockRow key={blockId(block)} block={block} {...shared} />
    ))}
  </>
);

/** Suppress the native gutter menu, then open the owning row's block menu. */
function routeGutterContextMenu(e: React.MouseEvent<HTMLButtonElement>): void {
  suppressContextMenu(e);
  const row = e.currentTarget.closest<HTMLElement>('[data-block-row]');
  if (!row) return;
  row.dispatchEvent(
    new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: e.clientX,
      clientY: e.clientY,
    }),
  );
}

/** One block row: hover gutter (add + drag handle), drop targeting, dispatch. */
export const BlockRow: React.FC<RowShared & {block: BlockMap}> = ({block, ...shared}) => {
  const {editor, ui, drag, setDrag, performDrop, computeRegion, depth} = shared;
  const id = blockId(block);
  const type = blockType(block);
  const rowRef = useRef<HTMLDivElement>(null);
  // The handle is BOTH a drag grip and the actions-menu trigger. Radix opens
  // its (modal) menu on pointerdown, which kills HTML5 dragging — the overlay
  // swallows every dragover/drop. Control the menu and ignore Radix's
  // pointerdown open-request; a real click (which never follows a drag)
  // opens it from onClick instead.
  const [handleMenu, setHandleMenu] = useState(false);
  const selected = editor.selection.has(id);
  const over = drag?.over?.id === id ? drag.over.region : null;
  // Side-drop creates a columns layout (at the root) or grows one (inside a
  // column); never on the columns wrapper itself, nor inside groups/tables.
  const {container} = shared;
  // A multi-block drag only offers above/below (v1): side-drops build columns,
  // which one-at-a-time semantics don't extend cleanly to a whole selection.
  const multiDragging = (drag?.ids?.length ?? 0) > 1;
  const allowSides = type !== 'columns' && (container === null || container === 'column') && !multiDragging;
  // Per-block colours (palette tokens → theme-aware classes on the body).
  const bg = blockProp<string>(block, 'bg');
  const fg = blockProp<string>(block, 'fg');
  const bodyClass = ['obe-blockbody', isColorToken(bg) && `obe-bg-${bg}`, isColorToken(fg) && `obe-fg-${fg}`]
    .filter(Boolean)
    .join(' ');
  const indent = blockProp<number>(block, 'indent') ?? 0;

  const onDragOver = (e: React.DragEvent): void => {
    if (!drag || drag.id === id || editor.readOnly) return;
    if (drag.ids?.includes(id)) return; // no drop indicator on a block that's moving
    e.preventDefault();
    e.stopPropagation();
    const region = computeRegion(e, rowRef.current!, allowSides);
    setDrag((d) => (d && (d.over?.id !== id || d.over.region !== region) ? {...d, over: {id, region}} : d));
  };

  const onDrop = (e: React.DragEvent): void => {
    if (!drag || drag.ids?.includes(id)) return;
    e.preventDefault();
    e.stopPropagation();
    performDrop(drag.id, id, computeRegion(e, rowRef.current!, allowSides), drag.ids);
    setDrag(null);
  };

  const rowEl = (
    <div
      ref={rowRef}
      data-block-row={id}
      data-block-type={type}
      data-block-level={type === 'heading' ? blockProp<number>(block, 'level') ?? 2 : undefined}
      className={[
        'obe-row',
        selected ? 'obe-row-selected' : '',
        over ? `obe-drop-${over}` : '',
        indent ? `obe-indent-${indent}` : '',
      ]
        .filter(Boolean)
        .join(' ')}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragLeave={() => setDrag((d) => (d?.over?.id === id ? {...d, over: null} : d))}
      // Shift-click a block extends the block selection contiguously. Only the
      // top-level row owns this (capture beats the caret + stops the marquee /
      // root handlers); a shift-click inside a nested block still resolves to
      // its whole top-level container via this row's id.
      onMouseDownCapture={
        depth === 0 && !editor.readOnly
          ? (e) => {
            // A secondary press inside a multi-block selection is a bulk-menu
            // gesture: keep the selection intact through the mousedown that a
            // real browser dispatches before contextmenu. Outside starts over,
            // so the following contextmenu renders the ordinary block actions.
            if (e.button === 2 && editor.selection.size > 1) {
              if (selected) {
                // Stopping propagation alone is not enough in a real browser:
                // the secondary press still focuses the contenteditable under
                // the pointer, whose onFocus clears the block selection before
                // Radix handles contextmenu. Suppress that default focus too.
                e.preventDefault();
                e.stopPropagation();
              } else {
                editor.clearSelection();
              }
              return;
            }
            if (!e.shiftKey || e.button !== 0) return;
            // Don't hijack native intra-block text extension ("caret at word 3,
            // shift-click word 20" inside ONE block): when nothing is
            // block-selected AND the shift-click lands on the row already hosting
            // the caret, let the browser extend the text range. We only convert
            // to block selection once a block is selected, or the shift-click
            // jumps to a DIFFERENT top-level row.
            const hostsFocus =
              editor.focusedId != null &&
              rowRef.current?.querySelector(`[data-block-text="${editor.focusedId}"]`) != null;
            if (editor.selection.size === 0 && hostsFocus) return;
            e.preventDefault();
            e.stopPropagation();
            (document.activeElement as HTMLElement | null)?.blur();
            document.getSelection()?.removeAllRanges();
            const order = rootBlocks(editor.doc).map((b) => blockId(b));
            // Deliberate nearest-anchor (range-redefinition) semantics: the anchor
            // is the currently-selected block NEAREST the target, so each
            // shift-click REDEFINES the range from that anchor rather than only
            // ever growing an initial one. See shiftClickRange's contract.
            editor.setSelection(shiftClickRange(order, editor.selection, id, editor.focusedId));
          }
          : undefined
      }
    >
      {!editor.readOnly && (
        <div className={`obe-gutter${depth > 0 ? ' obe-gutter-nested' : ''}`} contentEditable={false}>
          {depth === 0 && (
            <button
              type="button"
              tabIndex={-1}
              aria-label="Add a block below"
              className="obe-gutter-btn"
              onContextMenu={routeGutterContextMenu}
              onClick={() => {
                const newId = editor.insertAfter(id, {type: 'paragraph'});
                if (newId) ui.openSlash(newId, 0);
              }}
            >
              <Plus className="obe-gutter-icon" />
            </button>
          )}
          <DropdownMenu open={handleMenu} onOpenChange={(open) => !open && setHandleMenu(false)}>
            {/* The menu anchors to this empty span, NOT the handle: a Radix
                trigger preventDefaults pointerdown (suppressing the mousedown
                that initiates HTML5 dragging), so the drag grip must stay a
                plain button. The span sits inside the gutter, so the menu
                still opens at the handle. */}
            <DropdownMenuTrigger asChild>
              <span className="obe-handle-anchor" aria-hidden />
            </DropdownMenuTrigger>
            <button
              type="button"
              aria-label="Drag to move, click for actions"
              aria-haspopup="menu"
              aria-expanded={handleMenu}
              className="obe-gutter-btn obe-handle"
              draggable
              onContextMenu={routeGutterContextMenu}
              onDragStart={(e) => {
                // A drag that starts on a SELECTED block (with others selected)
                // moves the whole group; the ids are captured in document order.
                const sel = editor.selection;
                const multi = sel.has(id) && sel.size > 1;
                const ids = multi ? rootBlocks(editor.doc).map(blockId).filter((b) => sel.has(b)) : undefined;
                // dataTransfer is null on synthetic events (tests) — optional.
                if (e.dataTransfer) {
                  e.dataTransfer.effectAllowed = 'move';
                  e.dataTransfer.setData('text/plain', id);
                  if (multi && ids) setGroupDragImage(e, ids.length);
                }
                // Grabbing a block outside the selection collapses it to just
                // that block (single-block move preserved).
                if (!sel.has(id)) editor.setSelection([]);
                setDrag({id, ids, over: null});
              }}
              onDragEnd={() => setDrag(null)}
              onClick={() => {
                editor.setSelection([id]);
                setHandleMenu(true);
              }}
              onPointerDown={(e) => {
                // Touch drag: HTML5 DnD doesn't exist on touch screens, so the
                // handle drives a pointer-based drag (move ≥6px to engage).
                if (e.pointerType !== 'touch' || editor.readOnly) return;
                e.preventDefault();
                const startY = e.clientY;
                let engaged = false;
                let lastOver: {id: string; region: DropRegion} | null = null;
                const move = (ev: PointerEvent): void => {
                  if (!engaged && Math.abs(ev.clientY - startY) < 6) return;
                  engaged = true;
                  ev.preventDefault();
                  const under = document
                    .elementsFromPoint(ev.clientX, ev.clientY)
                    .find((el) => el instanceof HTMLElement && el.dataset.blockRow && el.dataset.blockRow !== id) as
                  | HTMLElement
                  | undefined;
                  if (!under) return;
                  const region = computeRegion(
                  {clientX: ev.clientX, clientY: ev.clientY} as React.PointerEvent,
                  under,
                  under.parentElement?.closest('[data-block-row]') === null,
                  );
                  lastOver = {id: under.dataset.blockRow!, region};
                  setDrag({id, over: lastOver});
                };
                const up = (): void => {
                  window.removeEventListener('pointermove', move);
                  window.removeEventListener('pointerup', up);
                  if (engaged && lastOver) performDrop(id, lastOver.id, lastOver.region);
                  setDrag(null);
                };
                window.addEventListener('pointermove', move, {passive: false});
                window.addEventListener('pointerup', up);
              }}
            >
              <GripVertical className="obe-gutter-icon" />
            </button>
            <HandleMenu block={block} editor={editor} />
          </DropdownMenu>
        </div>
      )}
      <div className={bodyClass}>
        <BlockErrorBoundary key={blockId(block)}>
          <BlockBody block={block} {...shared} />
        </BlockErrorBoundary>
      </div>
    </div>
  );

  // Right-clicking a block opens its own actions (not the page menu). In
  // read-only mode there are no block actions, so fall through to the page menu.
  if (editor.readOnly) return rowEl;
  return (
    <ContextMenu>
      <ContextMenuTrigger
        asChild
        // CTX-4 seam: its collapsed anchor/link menu check belongs immediately
        // before this general editable-selection passthrough, so anchors can
        // claim their dedicated menu first when the branches are merged.
        onContextMenuCapture={passEditableContextMenuToBrowser}
      >
        {rowEl}
      </ContextMenuTrigger>
      <BlockRowMenu block={block} editor={editor} />
    </ContextMenu>
  );
};

/** The "Turn into" choices, shared by the handle menu and the right-click menu. */
const TURN_OPTIONS: Array<{label: string; type: BlockType; props?: Record<string, unknown>}> = [
  {label: 'Text', type: 'paragraph'},
  {label: 'Heading 1', type: 'heading', props: {level: 1}},
  {label: 'Heading 2', type: 'heading', props: {level: 2}},
  {label: 'Heading 3', type: 'heading', props: {level: 3}},
  {label: 'Bulleted list', type: 'list', props: {kind: 'bullet'}},
  {label: 'Numbered list', type: 'list', props: {kind: 'number'}},
  {label: 'To-do', type: 'todo'},
  {label: 'Quote', type: 'quote'},
  {label: 'Callout', type: 'callout', props: {variant: 'info'}},
  {label: 'Code', type: 'code'},
];

/** Block actions shared by the drag-handle menu and the right-click menu.
 *  Direct model ops (not the selection-based controller ops, which would read
 *  a stale closure if the selection were set in the same tick). */
function blockOps(editor: BlockEditorController, id: string) {
  return {
    turn: (type: BlockType, props?: Record<string, unknown>): void => editor.turnInto(id, type, props),
    duplicate: (): void => {
      const found = findBlock(editor.doc, id);
      if (!found) return;
      editor.doc.transact(() => found.parent.insert(found.index + 1, [cloneBlock(found.block, true)]), 'local');
    },
    move: (delta: -1 | 1): void => {
      const found = findBlock(editor.doc, id);
      if (!found) return;
      const parentBlock = parentBlockOf(editor.doc, found.parent);
      moveBlock(editor.doc, id, parentBlock ? blockId(parentBlock) : null, found.index + delta);
    },
    remove: (): void => {
      removeBlock(editor.doc, id);
      editor.clearSelection();
    },
    setColor: (which: 'fg' | 'bg', token: string | null): void => {
      const found = findBlock(editor.doc, id);
      if (!found) return;
      editor.doc.transact(() => setBlockProp(found.block, which, token ?? undefined), 'local');
    },
  };
}

/** Colour choices for the block menus (a leading "Default" clears the prop). */
const COLOR_MENU: Array<{id: string | null; label: TKey}> = [
  {id: null, label: 'menu.colour.default'},
  ...COLOR_TOKENS.map((c) => ({id: c.id, label: `menu.colour.${c.id}` as TKey})),
];

/**
 * The single source of truth for a block's actions, rendered from both entry
 * points — the drag-handle click menu ({@link HandleMenu}, `menu="dropdown"`)
 * and the right-click menu ({@link BlockRowMenu}, `menu="context"`). One list
 * renders through whichever Radix family the host provides; the kit-config and
 * review rows are added conditionally by block/host (not by surface), so both
 * entry points expose the same capabilities and can no longer drift.
 *
 * Rendered inside a `DropdownMenuContent`/`ContextMenuContent` by the caller.
 */
const BlockMenuItems: React.FC<{
  block: BlockMap;
  editor: BlockEditorController;
  menu: 'context' | 'dropdown';
}> = ({block, editor, menu}) => {
  const id = blockId(block);
  const isText = TEXT_BLOCKS.has(blockType(block));
  const ops = blockOps(editor, id);
  const C = MENU_COMPONENTS[menu];

  // Review affordances need the host (BlockPageDocument) mounted and the live
  // doc registered against a page id (so the composer knows its target page).
  const pageId = getPageIdForDoc(editor.doc);
  const reviewable = !editor.readOnly && suggestHostReady() && pageId !== null;
  const suggestEdit = (): void => {
    const text = blockText(block);
    if (pageId) requestSuggestEdit({pageId, blockId: id, before: text ? text.toString() : ''});
  };
  const comment = (): void => {
    if (pageId) requestComment({pageId, blockId: id});
  };

  return (
    <>
      {/* Interactive blocks expose their settings popover right from the menu. */}
      {hasKitConfig(id) && (
        <>
          <C.Item onSelect={() => openKitConfig(id)}>{t('pane.config')}…</C.Item>
          <C.Separator />
        </>
      )}

      {/* ── Review rows (Suggest edit / Comment) ────────────────────────────────
          i18n'd (VOCAB/IA-4); both labels live together in this one spot
          (single surface, single place). Keep new review items here, not scattered. */}
      {reviewable && (
        <>
          {isText && <C.Item onSelect={suggestEdit}>{t('menu.block.suggestEdit')}</C.Item>}
          <C.Item onSelect={comment}>{t('menu.block.comment')}</C.Item>
          <C.Separator />
        </>
      )}

      {isText && (
        <>
          <C.Sub>
            <C.SubTrigger>Turn into</C.SubTrigger>
            <C.SubContent className={MENU_WIDTH_SM}>
              {TURN_OPTIONS.map((o) => (
                <C.Item key={o.label} onSelect={() => ops.turn(o.type, o.props)}>
                  {o.label}
                </C.Item>
              ))}
            </C.SubContent>
          </C.Sub>
          <C.Separator />
        </>
      )}

      <C.Sub>
        <C.SubTrigger>Text colour</C.SubTrigger>
        <C.SubContent className={MENU_WIDTH_SM}>
          {COLOR_MENU.map((c) => (
            <C.Item key={c.id ?? 'default'} onSelect={() => ops.setColor('fg', c.id)}>
              <span className={`obe-mi-sw ${c.id ? `obe-fg-${c.id}` : 'obe-mi-sw-reset'}`} aria-hidden>A</span>
              {t(c.label)}
            </C.Item>
          ))}
        </C.SubContent>
      </C.Sub>
      <C.Sub>
        <C.SubTrigger>Background</C.SubTrigger>
        <C.SubContent className={MENU_WIDTH_SM}>
          {COLOR_MENU.map((c) => (
            <C.Item key={c.id ?? 'default'} onSelect={() => ops.setColor('bg', c.id)}>
              <span className={`obe-mi-sw obe-mi-sw-fill ${c.id ? `obe-hl-${c.id}` : 'obe-mi-sw-reset'}`} aria-hidden />
              {t(c.label)}
            </C.Item>
          ))}
        </C.SubContent>
      </C.Sub>

      <C.Separator />
      <C.Item onSelect={() => editor.setSelection([id])}>Select block</C.Item>
      <C.Item onSelect={ops.duplicate}>
        Duplicate
        <C.Shortcut>{formatShortcut(SHORTCUTS.duplicateBlock)}</C.Shortcut>
      </C.Item>
      <C.Item onSelect={() => ops.move(-1)}>
        Move up
        <C.Shortcut>{formatShortcut(SHORTCUTS.moveBlockUp)}</C.Shortcut>
      </C.Item>
      <C.Item onSelect={() => ops.move(1)}>
        Move down
        <C.Shortcut>{formatShortcut(SHORTCUTS.moveBlockDown)}</C.Shortcut>
      </C.Item>
      <C.Separator />
      <C.Item className={MENU_DESTRUCTIVE_CLASS} onSelect={ops.remove}>
        Delete
        <C.Shortcut>{formatShortcut(SHORTCUTS.deleteBlock)}</C.Shortcut>
      </C.Item>
    </>
  );
};

/** The drag handle's click menu: the block's actions in a dropdown, so a click
 *  on the gutter handle acts without leaving the mouse. Thin wrapper over the
 *  shared {@link BlockMenuItems}. */
const HandleMenu: React.FC<{block: BlockMap; editor: BlockEditorController}> = ({block, editor}) => (
  <DropdownMenuContent align="start" side="bottom" className={MENU_WIDTH_MD}>
    <BlockMenuItems block={block} editor={editor} menu="dropdown" />
  </DropdownMenuContent>
);

/** The block's right-click menu — the same block actions in place of the page
 *  menu, so right-clicking a block reads as "this block", not "this page". Thin
 *  wrapper over the shared {@link BlockMenuItems}. */
const BlockRowMenu: React.FC<{block: BlockMap; editor: BlockEditorController}> = ({block, editor}) => {
  let topLevelId = blockId(block);
  let current = findBlock(editor.doc, topLevelId);
  while (current && current.parent !== rootBlocks(editor.doc)) {
    const parent = parentBlockOf(editor.doc, current.parent);
    if (!parent) break;
    topLevelId = blockId(parent);
    current = findBlock(editor.doc, topLevelId);
  }
  const inBulkSelection = editor.selection.size > 1 && editor.selection.has(topLevelId);

  return (
    <ContextMenuContent className={MENU_WIDTH_MD}>
      {inBulkSelection ? (
        <BlockBulkMenu editor={editor} />
      ) : (
        <BlockMenuItems block={block} editor={editor} menu="context" />
      )}
    </ContextMenuContent>
  );
};

/** Whole-selection actions for a right-click inside a 2+ block selection. */
const BlockBulkMenu: React.FC<{editor: BlockEditorController}> = ({editor}) => {
  const C = MENU_COMPONENTS.context;
  const ids = [...editor.selection];
  const count = ids.length;
  const textIds = ids.filter((id) => {
    const found = findBlock(editor.doc, id);
    return found ? TEXT_BLOCKS.has(blockType(found.block)) : false;
  });

  // Delimit every menu command from nearby typing and from the next command.
  // The mutation itself remains one Yjs transaction, hence one undo item.
  const runAsUndoStep = (op: () => void): void => {
    editor.undo.stopCapturing();
    op();
    editor.undo.stopCapturing();
  };
  const turnAll = (type: BlockType, props?: Record<string, unknown>): void =>
    runAsUndoStep(() => {
      editor.doc.transact(() => {
        for (const id of textIds) {
          const found = findBlock(editor.doc, id);
          if (found) patchBlock(found.block, {type, props});
        }
      }, 'local');
    });
  const colorAll = (which: 'fg' | 'bg', token: string | null): void =>
    runAsUndoStep(() => {
      editor.doc.transact(() => {
        for (const id of ids) {
          const found = findBlock(editor.doc, id);
          if (found) setBlockProp(found.block, which, token ?? undefined);
        }
      }, 'local');
    });

  return (
    <>
      <ContextMenuLabel>{t('menu.block.bulkSelected', {count})}</ContextMenuLabel>
      <C.Item onSelect={() => runAsUndoStep(editor.duplicateSelected)}>
        {t('menu.block.bulkDuplicate', {count})}
      </C.Item>
      <C.Sub>
        <C.SubTrigger disabled={textIds.length === 0}>
          {textIds.length < count ? t('menu.block.bulkTurnInto', {count: textIds.length}) : 'Turn into'}
        </C.SubTrigger>
        <C.SubContent className={MENU_WIDTH_SM}>
          {TURN_OPTIONS.map((option) => (
            <C.Item key={option.label} onSelect={() => turnAll(option.type, option.props)}>
              {option.label}
            </C.Item>
          ))}
        </C.SubContent>
      </C.Sub>
      <C.Sub>
        <C.SubTrigger>Text colour</C.SubTrigger>
        <C.SubContent className={MENU_WIDTH_SM}>
          {COLOR_MENU.map((color) => (
            <C.Item key={color.id ?? 'default'} onSelect={() => colorAll('fg', color.id)}>
              <span className={`obe-mi-sw ${color.id ? `obe-fg-${color.id}` : 'obe-mi-sw-reset'}`} aria-hidden>A</span>
              {t(color.label)}
            </C.Item>
          ))}
        </C.SubContent>
      </C.Sub>
      <C.Sub>
        <C.SubTrigger>Background</C.SubTrigger>
        <C.SubContent className={MENU_WIDTH_SM}>
          {COLOR_MENU.map((color) => (
            <C.Item key={color.id ?? 'default'} onSelect={() => colorAll('bg', color.id)}>
              <span className={`obe-mi-sw obe-mi-sw-fill ${color.id ? `obe-hl-${color.id}` : 'obe-mi-sw-reset'}`} aria-hidden />
              {t(color.label)}
            </C.Item>
          ))}
        </C.SubContent>
      </C.Sub>
      <C.Separator />
      <C.Item className={MENU_DESTRUCTIVE_CLASS} onSelect={() => runAsUndoStep(editor.removeSelected)}>
        {t('menu.block.bulkDelete', {count})}
      </C.Item>
    </>
  );
};

// ── Group ────────────────────────────────────────────────────────────────────

/**
 * A named group: a titled, bordered container that (1) namespaces its inputs in
 * the reactive scope (`group.field.value`), (2) locks its contents read-only on
 * demand (interactive widgets excepted), and (3) optionally mirrors its inputs
 * across pages by a shared sync key.
 */
const GroupView: React.FC<RowShared & {block: BlockMap}> = ({block, ...shared}) => {
  const {editor} = shared;
  const doc = editor.doc;
  const name = blockProp<string>(block, 'name') ?? '';
  const ownLocked = Boolean(blockProp<boolean>(block, 'locked'));
  const parentLocked = useKitLock();
  const locked = ownLocked || parentLocked;
  const sync = (blockProp<string>(block, 'sync') ?? '').trim();
  const children = blockChildren(block);

  const set = (key: string, value: unknown): void =>
    doc.transact(() => setBlockProp(block, key, value), 'local');

  // A signature of the group's input values — recomputed each doc version (the
  // editor's identity changes per version), so it drives the publish effect.
  const sig = useMemo(() => {
    const out: Record<string, unknown> = {};
    for (const [field, blk] of groupInputs(block)) out[field] = inputValue(blk);
    return JSON.stringify(out);
  }, [block, editor]);

  // Adopt shared values FIRST (defined before publish so on mount the store
  // wins the race), then keep adopting whenever another page writes.
  useEffect(() => {
    if (!sync) return;
    const apply = (): void => {
      const incoming = readGroupSync(sync);
      doc.transact(() => {
        for (const [field, blk] of groupInputs(block)) {
          if (field in incoming && !valueEqual(inputValue(blk), incoming[field])) {
            setInputValue(blk, incoming[field]);
          }
        }
      }, 'local');
    };
    apply();
    return subscribeGroupSync(sync, apply);
  }, [sync, block, doc]);

  // Publish local values to the store. Reads LIVE values at effect-time (not the
  // render snapshot) so the post-adopt mount state is what gets published —
  // `writeGroupSync` no-ops when unchanged, so adopted values never echo back.
  useEffect(() => {
    if (!sync) return;
    const live: Record<string, unknown> = {};
    for (const [field, blk] of groupInputs(block)) live[field] = inputValue(blk);
    writeGroupSync(sync, live);
  }, [sync, sig, block]);

  return (
    <KitLockContext.Provider value={{locked}}>
      <section className={`obe-group${locked ? ' obe-group-locked' : ''}`} data-group-name={name || undefined}>
        <header className="obe-group-head" contentEditable={false}>
          <Boxes className="obe-group-icon" aria-hidden />
          <KitInlineText
            className="obe-group-name"
            value={name}
            placeholder="Section"
            readOnly={editor.readOnly}
            ariaLabel="Section name"
            onCommit={(v) => set('name', v)}
          />
          <span className="obe-group-spacer" />
          <button
            type="button"
            className={`obe-group-btn${sync ? ' obe-group-btn-on' : ''}`}
            aria-label={sync ? `Synced across pages as ${sync}` : 'Sync this section across pages'}
            aria-pressed={Boolean(sync)}
            title={sync ? `Synced across pages as “${sync}”` : 'Sync across pages'}
            disabled={editor.readOnly}
            onClick={() => set('sync', sync ? '' : name.trim() || 'group')}
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            className={`obe-group-btn${locked ? ' obe-group-btn-on' : ''}`}
            aria-label={locked ? 'Unlock section' : 'Lock section'}
            aria-pressed={locked}
            title={locked ? 'Unlock section' : 'Lock section'}
            disabled={editor.readOnly}
            onClick={() => set('locked', !ownLocked)}
          >
            {locked ? <Lock className="h-3.5 w-3.5" /> : <LockOpen className="h-3.5 w-3.5" />}
          </button>
        </header>
        <div className="obe-group-body">
          {children && <BlockList list={children} {...shared} depth={shared.depth + 1} container="group" />}
        </div>
      </section>
    </KitLockContext.Provider>
  );
};

// ── Tabs & Accordion (interactive-kit containers) ─────────────────────────────

/** A small completion chip a tab/section shows: ✓ when complete, else N/M.
 *  Nothing to complete renders nothing (a purely informational section). */
const CompletionBadge: React.FC<{stat: CompletionStat}> = ({stat}) => {
  if (stat.total === 0) return null;
  return stat.complete ? (
    <span className="obe-cnt-badge obe-cnt-done" aria-label="Complete">
      <Check className="h-3 w-3" />
    </span>
  ) : (
    <span className="obe-cnt-badge" aria-label={`${stat.done} of ${stat.total} complete`}>
      {stat.done}/{stat.total}
    </span>
  );
};

/**
 * Tabs — a container whose children are `tab` blocks, each holding arbitrary
 * blocks. Per-tab completion is auto-computed from the inputs/to-dos it
 * contains; optional gating locks later tabs until earlier ones complete
 * (wizard). Reuses the group container infra: BlockList for children, the
 * KitLockContext for the gate, and the standard row DnD inside each tab.
 *
 * Completion reads: an author binds `setup.complete` / `setup.ratio` in a
 * progress bar or formula via the tab/accordion's group-style name on the
 * input scope — see kit/completion.ts.
 */
const TabsView: React.FC<RowShared & {block: BlockMap}> = ({block, ...shared}) => {
  const {editor} = shared;
  const doc = editor.doc;
  const tabs = blockChildren(block)!;
  const gated = Boolean(blockProp<boolean>(block, 'gated'));
  const active = Math.max(0, Math.min(blockProp<number>(block, 'active') ?? 0, Math.max(0, tabs.length - 1)));
  const parentLocked = useKitLock();

  const set = (key: string, value: unknown): void => doc.transact(() => setBlockProp(block, key, value), 'local');
  const addTab = (): void => {
    doc.transact(() => {
      const child = makeChild('tab', {label: `Tab ${tabs.length + 1}`});
      tabs.insert(tabs.length, [child]);
      setBlockProp(block, 'active', tabs.length - 1);
    }, 'local');
  };

  // Per-tab completion (recomputed each version via the editor identity).
  const stats = useMemo(() => tabs.map((tab) => sectionCompletion(tab)), [block, editor]);
  // A gated tab is reachable once every PRIOR tab is complete.
  const reachable = (i: number): boolean => !gated || stats.slice(0, i).every((s) => s.complete);
  const activeTab = tabs.length > 0 ? tabs.get(active) : null;
  const activeLocked = parentLocked || (gated && !reachable(active));

  return (
    <section className="obe-cnt obe-tabs" data-kit-name={blockProp<string>(block, 'name') || undefined}>
      <header className="obe-cnt-head" contentEditable={false}>
        <div className="obe-tabs-strip" role="tablist" aria-label="Tabs">
          {tabs.map((tab, i) => {
            const locked = gated && !reachable(i);
            return (
              <button
                key={blockId(tab)}
                type="button"
                role="tab"
                aria-selected={i === active}
                className={`obe-tab${i === active ? ' obe-tab-on' : ''}${locked ? ' obe-tab-locked' : ''}`}
                disabled={locked}
                onClick={() => set('active', i)}
              >
                <KitInlineText
                  className="obe-tab-label"
                  value={blockProp<string>(tab, 'label') ?? ''}
                  placeholder={`Tab ${i + 1}`}
                  readOnly={editor.readOnly || i !== active}
                  ariaLabel="Tab label"
                  onCommit={(v) => doc.transact(() => setBlockProp(tab, 'label', v), 'local')}
                />
                <CompletionBadge stat={stats[i]} />
                {locked && <Lock className="h-3 w-3 opacity-60" aria-hidden />}
              </button>
            );
          })}
          {!editor.readOnly && (
            <button type="button" className="obe-cnt-add" aria-label="Add tab" title="Add tab" onClick={addTab}>
              <Plus className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        {!editor.readOnly && (
          <button
            type="button"
            className={`obe-group-btn${gated ? ' obe-group-btn-on' : ''}`}
            aria-label={gated ? 'Gating on — later tabs lock until earlier complete' : 'Gate tabs (wizard)'}
            aria-pressed={gated}
            title={gated ? 'Gating on (wizard)' : 'Gate: lock later tabs until earlier complete'}
            onClick={() => set('gated', !gated)}
          >
            <Lock className="h-3.5 w-3.5" />
          </button>
        )}
      </header>
      {activeTab && (
        <KitLockContext.Provider value={{locked: activeLocked}}>
          <div className={`obe-cnt-panel${activeLocked ? ' obe-cnt-locked' : ''}`} role="tabpanel">
            <BlockList list={blockChildren(activeTab)!} {...shared} depth={shared.depth + 1} container="group" />
          </div>
        </KitLockContext.Provider>
      )}
    </section>
  );
};

/**
 * Accordion — a container whose children are `accordionsection` blocks (each a
 * collapsible holder of arbitrary blocks). Completion is auto-computed per
 * section; an optional gating toggle locks later sections (and force-collapses
 * them) until prior ones complete. Reuses the group container infra.
 */
const AccordionView: React.FC<RowShared & {block: BlockMap}> = ({block, ...shared}) => {
  const {editor} = shared;
  const doc = editor.doc;
  const sections = blockChildren(block)!;
  const gated = Boolean(blockProp<boolean>(block, 'gated'));
  const parentLocked = useKitLock();
  const pageLocked = useKitPageLock();

  const set = (key: string, value: unknown): void => doc.transact(() => setBlockProp(block, key, value), 'local');
  const addSection = (): void => {
    doc.transact(() => {
      sections.insert(sections.length, [makeChild('accordionsection', {label: `Section ${sections.length + 1}`})]);
    }, 'local');
  };

  const stats = useMemo(() => sections.map((s) => sectionCompletion(s)), [block, editor]);
  const reachable = (i: number): boolean => !gated || stats.slice(0, i).every((s) => s.complete);

  return (
    <section className="obe-cnt obe-accordion" data-kit-name={blockProp<string>(block, 'name') || undefined}>
      {sections.map((section, i) => {
        const gateLocked = gated && !reachable(i);
        const locked = parentLocked || gateLocked;
        // Gating (and an author-locked group) force-collapses sections; a
        // whole-page reader lock (read-only viewer, the export viewer bundle)
        // keeps them navigable — expanding a section is reader navigation,
        // not an edit (its contents stay locked either way).
        const forceCollapsed = gateLocked || (parentLocked && !pageLocked);
        const collapsed = forceCollapsed || Boolean(blockProp<boolean>(section, 'collapsed'));
        return (
          <div key={blockId(section)} className={`obe-acc-section${locked ? ' obe-cnt-locked' : ''}`}>
            <header className="obe-acc-head" contentEditable={false}>
              <button
                type="button"
                className="obe-acc-toggle"
                aria-expanded={!collapsed}
                disabled={forceCollapsed}
                onClick={() => doc.transact(() => setBlockProp(section, 'collapsed', !collapsed), 'local')}
              >
                {collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
              </button>
              <KitInlineText
                className="obe-acc-label"
                value={blockProp<string>(section, 'label') ?? ''}
                placeholder={`Section ${i + 1}`}
                readOnly={editor.readOnly}
                ariaLabel="Section label"
                onCommit={(v) => doc.transact(() => setBlockProp(section, 'label', v), 'local')}
              />
              <span className="obe-cnt-spacer" />
              <CompletionBadge stat={stats[i]} />
              {forceCollapsed && <Lock className="h-3.5 w-3.5 opacity-60" aria-hidden />}
            </header>
            {!collapsed && (
              <KitLockContext.Provider value={{locked}}>
                <div className="obe-acc-body">
                  <BlockList list={blockChildren(section)!} {...shared} depth={shared.depth + 1} container="group" />
                </div>
              </KitLockContext.Provider>
            )}
          </div>
        );
      })}
      {!editor.readOnly && (
        <div className="obe-acc-foot" contentEditable={false}>
          <button type="button" className="obe-cnt-add" aria-label="Add section" onClick={addSection}>
            <Plus className="h-3.5 w-3.5" /> Section
          </button>
          <span className="obe-cnt-spacer" />
          <button
            type="button"
            className={`obe-group-btn${gated ? ' obe-group-btn-on' : ''}`}
            aria-label={gated ? 'Gating on — later sections lock until earlier complete' : 'Gate sections (wizard)'}
            aria-pressed={gated}
            title={gated ? 'Gating on (wizard)' : 'Gate: lock later sections until earlier complete'}
            onClick={() => set('gated', !gated)}
          >
            <Lock className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
    </section>
  );
};

/** Build a fresh tab/section child with one empty paragraph to type into. */
function makeChild(type: BlockType, props: Record<string, unknown>): BlockMap {
  return makeBlock({type, props, children: [{type: 'paragraph'}]});
}

/**
 * A last-resort net around a single block's render. The typed guards in
 * TableView / TextBlockView already keep the known poison shapes from throwing;
 * this catches anything unforeseen so one malformed block degrades to a quiet
 * placeholder instead of unmounting the whole editor (a persisted white screen).
 * Keyed by block id at the call site, so a replaced / fixed block remounts fresh.
 */
class BlockErrorBoundary extends React.Component<{children: React.ReactNode}, {failed: boolean}> {
  state = {failed: false};
  static getDerivedStateFromError(): {failed: boolean} {
    return {failed: true};
  }
  render(): React.ReactNode {
    if (this.state.failed) {
      return (
        <div className="obe-unknown" contentEditable={false}>
          This block couldn’t be displayed.
        </div>
      );
    }
    return this.props.children;
  }
}

/** Type dispatch for a block's content. */
const BlockBody: React.FC<RowShared & {block: BlockMap}> = ({block, ...shared}) => {
  const {editor, ui} = shared;
  const type = blockType(block);
  const id = blockId(block);

  // A locked group makes its descendants read-only: text and structure
  // entirely, but kit widgets stay operable for the reader by default — that's
  // the point of an interactive artifact. An author opts a widget *out* by
  // turning off "Stays interactive when locked" (stored `interactive: false`).
  // Containers keep the real editor and re-apply the lock at each leaf via the
  // context.
  const locked = useKitLock();
  const lockText = locked && !editor.readOnly;
  const interactive = blockProp<boolean>(block, 'interactive') ?? true;
  // Whole-document read-only (a viewer who can't write, or present mode): the
  // editor itself is read-only AND the page-level lock context is set. Text and
  // structure freeze (via `editor.readOnly`), but an interactive widget stays
  // LIVE for the reader — the same exemption a locked group grants, lifted to the
  // page. It just never persists (the host skips saving). An author opt-out
  // (`interactive: false`) freezes the widget too.
  const pageLocked = editor.readOnly && locked;
  const textEditor = useMemo(() => (lockText ? {...editor, readOnly: true} : editor), [editor, lockText]);
  const liveEditor = useMemo(() => ({...editor, readOnly: false}), [editor]);
  const kitEditor = useMemo(() => {
    if (pageLocked) return interactive ? liveEditor : editor; // viewer/present: live unless opted out
    return lockText && !interactive ? {...editor, readOnly: true} : editor; // group lock (unchanged)
  }, [editor, liveEditor, pageLocked, lockText, interactive]);

  // Re-render when the custom-block registry changes so that a block whose
  // plugin hasn't loaded yet updates automatically once registration happens.
  useSyncExternalStore(subscribeRegistry, getRegistrySnapshot);

  // A static render the host document already produced for this block (LX-5):
  // set only by the exported file's viewer, empty in the app.
  const keptStatic = useStaticKeep(id);

  switch (type) {
  case 'divider':
    return <hr className="obe-divider" aria-label="Divider" />;

  case 'columns':
    return <ColumnsView block={block} {...shared} />;

  case 'group':
    return <GroupView block={block} {...shared} />;

  case 'tabs':
    return <TabsView block={block} {...shared} />;

  case 'accordion':
    return <AccordionView block={block} {...shared} />;

  case 'table':
    return <TableView block={block} {...shared} />;

  case 'todo': {
    const checked = blockProp<boolean>(block, 'checked') ?? false;
    return (
      <div className={`obe-todo${checked ? ' obe-todo-done' : ''}`}>
        <input
          type="checkbox"
          className="obe-todo-box"
          checked={checked}
          disabled={textEditor.readOnly}
          aria-label={checked ? 'Mark as not done' : 'Mark as done'}
          onChange={() => editor.doc.transact(() => setBlockProp(block, 'checked', !checked), 'local')}
        />
        <TextBlockView block={block} editor={textEditor} ui={ui} />
      </div>
    );
  }

  case 'list': {
    const kind = blockProp<string>(block, 'kind') ?? 'bullet';
    const marker = kind === 'number' ? `${listNumber(editor.doc, block)}.` : '•';
    return (
      <div className="obe-list">
        <span className={`obe-list-marker obe-list-${kind}`} contentEditable={false} aria-hidden>
          {marker}
        </span>
        <TextBlockView block={block} editor={textEditor} ui={ui} />
      </div>
    );
  }

  case 'quote':
    return (
      <blockquote className="obe-quote">
        <TextBlockView block={block} editor={textEditor} ui={ui} />
      </blockquote>
    );

  case 'callout': {
    const variant = blockProp<string>(block, 'variant') ?? 'info';
    const icons: Record<string, string> = {info: '💡', warn: '⚠️', success: '✅', danger: '🚫'};
    return (
      <div className={`obe-callout obe-callout-${variant}`}>
        <button
          type="button"
          className="obe-callout-icon"
          contentEditable={false}
          disabled={textEditor.readOnly}
          aria-label="Change callout style"
          onClick={() => {
            const order = ['info', 'warn', 'success', 'danger'];
            const next = order[(order.indexOf(variant) + 1) % order.length];
            editor.doc.transact(() => setBlockProp(block, 'variant', next), 'local');
          }}
        >
          {icons[variant] ?? '💡'}
        </button>
        <TextBlockView block={block} editor={textEditor} ui={ui} />
      </div>
    );
  }

  case 'code':
    return <CodeBlockView block={block} editor={textEditor} ui={ui} />;

  case 'image':
    // A leaf media block — it freezes like text (no interactive-widget
    // exemption): `textEditor` is read-only in present / viewer / locked-group,
    // so ImageBlockView hides every edit affordance for a reader.
    return <ImageBlockView block={block} editor={textEditor} ui={ui} />;

  case 'htmlArtifact':
    // An interactive leaf: dispatched with the kit-widget semantics so the
    // sandboxed document stays LIVE for a reader in present / viewer /
    // locked-group contexts; the view separately freezes its authoring chrome
    // (title, replace, resize) via the kit-lock context + editor.readOnly.
    return <HtmlArtifactBlockView block={block} editor={kitEditor} ui={ui} />;

  case 'notes':
    // A speaker note: quietly marked on the page (and hidden from the audience
    // deck + every export); surfaced in the presenter view.
    return (
      <div className="obe-notes" data-block-kind="notes">
        <span className="obe-notes-tag" contentEditable={false}>
          <EyeOff className="h-3.5 w-3.5" /> Speaker note
        </span>
        <TextBlockView block={block} editor={textEditor} ui={ui} />
      </div>
    );

  case 'heading': {
    const level = blockProp<number>(block, 'level') ?? 2;
    return (
      <div className={`obe-heading obe-h${level}`} role="heading" aria-level={level}>
        <TextBlockView block={block} editor={textEditor} ui={ui} />
      </div>
    );
  }

  default: {
    const custom = getCustomBlock(type);
    if (custom) {
      const Custom = custom.render;
      return (
        <div className="obe-custom" data-custom-type={type}>
          {/* `kitEditor` may carry `readOnly: false` so an interactive widget
              stays live for a reader; `pageReadOnly` is the document's real
              lock, which that override must not hide from a block that offers
              to write somewhere else. See {@link CustomBlockProps.pageReadOnly}. */}
          <Custom block={block} editor={kitEditor} pageReadOnly={editor.readOnly} />
        </div>
      );
    }
    // No renderer here — but the HOST DOCUMENT may already have one: an
    // exported file renders its blocks statically before hydrating the viewer
    // over them, and for a ledger report that static render is a real table of
    // real numbers (LX-3). Keep it rather than replace it with an
    // install-plugin card that shows the reader nothing (LX-5). Ordered ahead
    // of the text fallback: the preserved render already contains any text the
    // block carried.
    if (keptStatic) return <StaticKeepBlock node={keptStatic} />;
    // A text-carrying unknown type still edits as text; anything else shows
    // a quiet placeholder instead of crashing (forward compatibility).
    if (blockText(block)) return <TextBlockView block={block} editor={textEditor} ui={ui} />;
    // Plugin-contributed types follow the `{pluginId}/{blockName}` pattern.
    // Show a helpful install prompt instead of the bare “Unsupported block”.
    return <MissingPluginBlock type={type} />;
  }
  }

  void id;
};

/** 1-based position of a numbered list item within its contiguous run. */
function listNumber(doc: Y.Doc, block: BlockMap): number {
  const found = findBlock(doc, blockId(block));
  if (!found) return 1;
  let n = 1;
  for (let i = found.index - 1; i >= 0; i -= 1) {
    const prev = found.parent.get(i);
    if (blockType(prev) === 'list' && blockProp<string>(prev, 'kind') === 'number') n += 1;
    else break;
  }
  return n;
}

// ── Columns ──────────────────────────────────────────────────────────────────

/** A columns layout on the 12-col grid, with cascading resize boundaries. */
const ColumnsView: React.FC<RowShared & {block: BlockMap}> = ({block, ...shared}) => {
  const {editor} = shared;
  const wrapRef = useRef<HTMLDivElement>(null);
  const cols = blockChildren(block)!;
  const spans = useMemo(
    () => normalizeColumnSpans(cols.map((col) => blockProp<number>(col, 'span'))),
    [cols, editor.version],
  );
  const boundaryAt = (boundaryIndex: number): number =>
    spans.slice(0, boundaryIndex + 1).reduce((sum, span) => sum + span, 0);

  const commitSpans = (next: readonly number[], previous: readonly number[] = spans): void => {
    const changed = next.flatMap((span, i) => (span === previous[i] ? [] : [[i, span] as const]));
    if (changed.length === 0) return;
    editor.doc.transact(() => {
      changed.forEach(([i, span]) => setBlockProp(cols.get(i), 'span', span));
    }, 'local');
  };

  /** Drag an internal boundary, or the last column's trailing edge. */
  const onDividerDown = (e: React.PointerEvent, boundaryIndex: number, trailing = false): void => {
    if (editor.readOnly) return;
    e.preventDefault();
    e.stopPropagation();
    const wrap = wrapRef.current;
    if (!wrap) return;
    const divider = e.currentTarget as HTMLElement;
    const rect = wrap.getBoundingClientRect();
    const computed = getComputedStyle(wrap);
    const gap = Number.parseFloat(computed.columnGap || computed.gap) || 0;
    const pitch = (rect.width + gap) / COLUMN_GRID_UNITS;
    if (pitch <= 0) return;
    const startSpans = spans;
    let committedSpans = startSpans;
    const startBoundary = boundaryAt(boundaryIndex);
    const startPointerX = e.clientX;
    const pointerId = e.pointerId;
    const frames = [...wrap.querySelectorAll<HTMLIFrameElement>('iframe')];
    const framePointerEvents = frames.map((frame) => frame.style.pointerEvents);
    const move = (ev: PointerEvent): void => {
      if (ev.pointerId !== pointerId) return;
      const target = trailing
        ? trailingColumnBoundaryFromPointer(ev.clientX, startPointerX, startBoundary, pitch)
        : columnBoundaryFromPointer(ev.clientX, rect.left, pitch, gap);
      const next = resizeColumnBoundary(startSpans, boundaryIndex, target);
      commitSpans(next, committedSpans);
      committedSpans = next;
    };
    let ended = false;
    const end = (ev: PointerEvent): void => {
      if (ev.pointerId !== pointerId) return;
      if (ended) return;
      ended = true;
      frames.forEach((frame, i) => {
        frame.style.pointerEvents = framePointerEvents[i];
      });
      divider.removeEventListener('pointermove', move);
      divider.removeEventListener('pointerup', end);
      divider.removeEventListener('pointercancel', end);
      divider.removeEventListener('lostpointercapture', end);
    };
    frames.forEach((frame) => {
      frame.style.pointerEvents = 'none';
    });
    try {
      divider.setPointerCapture(pointerId);
    } catch {
      // Synthetic events have no live pointer; element listeners still cover
      // their in-parent drag path.
    }
    divider.addEventListener('pointermove', move);
    divider.addEventListener('pointerup', end);
    divider.addEventListener('pointercancel', end);
    divider.addEventListener('lostpointercapture', end);
  };

  const onDividerKeyDown = (e: React.KeyboardEvent, boundaryIndex: number, trailing = false): void => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    e.stopPropagation();
    const step = e.key === 'ArrowRight' ? 1 : -1;
    const target = boundaryAt(boundaryIndex) + (trailing ? -step : step);
    commitSpans(resizeColumnBoundary(spans, boundaryIndex, target));
  };

  return (
    <div ref={wrapRef} className="obe-columns" data-cols={cols.length} role="group" aria-label={`${cols.length} columns`}>
      {cols.map((col, i) => (
        <React.Fragment key={blockId(col)}>
          <div className="obe-column" style={{gridColumn: `span ${spans[i]}`}} data-block-row={blockId(col)}>
            {i > 0 && !editor.readOnly && (
              <div
                className="obe-col-divider"
                role="separator"
                aria-orientation="vertical"
                aria-label={`Resize columns ${i} and ${i + 1}`}
                aria-valuemin={i}
                aria-valuemax={COLUMN_GRID_UNITS - (cols.length - i)}
                aria-valuenow={boundaryAt(i - 1)}
                tabIndex={0}
                contentEditable={false}
                onPointerDown={(e) => onDividerDown(e, i - 1)}
                onKeyDown={(e) => onDividerKeyDown(e, i - 1)}
              />
            )}
            <BlockList list={blockChildren(col)!} {...shared} depth={shared.depth + 1} container="column" />
            {i === cols.length - 1 && cols.length > 1 && !editor.readOnly && (
              <div
                className="obe-col-divider obe-col-divider-trailing"
                role="separator"
                aria-orientation="vertical"
                aria-label="Resize last column"
                aria-valuemin={1}
                aria-valuemax={COLUMN_GRID_UNITS - (cols.length - 1)}
                aria-valuenow={spans[i]}
                tabIndex={0}
                contentEditable={false}
                onPointerDown={(e) => onDividerDown(e, i - 1, true)}
                onKeyDown={(e) => onDividerKeyDown(e, i - 1, true)}
              />
            )}
          </div>
        </React.Fragment>
      ))}
    </div>
  );
};

// ── Table ─────────────────────────────────────────────────────────────────────

/**
 * The row/column actions for a single table cell, computed from that cell's
 * SORTED grid position via {@link cellPosition} — so every op targets the right
 * index even after the row/column has been reordered (the sorted-vs-array trap).
 * Positional ops only; TBL-2 adds Move items and TBL-4 adds colour submenus at
 * the anchors below. Rendered inside a {@link ContextMenuContent}; content is
 * mounted fresh on each open, so the position is always read live from the doc.
 */
/**
 * A "Row colour" / "Column colour" submenu for the table cell menu (TBL-4):
 * the 9 palette swatches + a leading "Default" that clears the tint, styled
 * like the block-menu Background submenu. `current` gets a trailing check.
 * Apply/Clear each run through one transacting op = one undo step.
 */
const TableColorSubmenu: React.FC<{
  label: string;
  current: string | null;
  onPick: (token: string | null) => void;
  menu?: MenuComponentSet;
}> = ({label, current, onPick, menu = MENU_COMPONENTS.context}) => {
  const {Item, Sub, SubContent, SubTrigger} = menu;
  return (
    <Sub>
      <SubTrigger>{label}</SubTrigger>
      <SubContent className={MENU_WIDTH_SM}>
        {COLOR_MENU.map((c) => (
          <Item key={c.id ?? 'default'} onSelect={() => onPick(c.id)}>
            <span
              className={`obe-mi-sw obe-mi-sw-fill ${c.id ? `obe-hl-${c.id}` : 'obe-mi-sw-reset'}`}
              aria-hidden
            />
            {t(c.label)}
            {(c.id ?? null) === current && <Check className="ml-auto h-3.5 w-3.5" />}
          </Item>
        ))}
      </SubContent>
    </Sub>
  );
};

interface TableAxisMenuItemsProps {
  tableId: string;
  editor: BlockEditorController;
  index: number;
  id: string;
  count: number;
  header: boolean;
  menu?: MenuComponentSet;
}

export const TableRowMenuItems: React.FC<TableAxisMenuItemsProps> = ({
  tableId, editor, index: row, id: rowId, count: rowCount, header, menu = MENU_COMPONENTS.context,
}) => {
  const {Item} = menu;
  const doc = editor.doc;
  const found = findBlock(doc, tableId);
  const rowBlock = found && blockType(found.block) === 'table' ? tableGrid(found.block).rows[row] : null;
  if (!rowBlock) return null;
  return (
    <>
      {!(header && row === 0) && (
        <Item onSelect={() => tableInsertRow(doc, tableId, row)}>
          <ArrowUp className="mr-2 h-3.5 w-3.5" /> {t('menu.table.insertRowAbove')}
        </Item>
      )}
      <Item onSelect={() => tableInsertRow(doc, tableId, row + 1)}>
        <ArrowDown className="mr-2 h-3.5 w-3.5" /> {t('menu.table.insertRowBelow')}
      </Item>
      <Item onSelect={() => tableDuplicateRow(doc, tableId, row)}>
        <Copy className="mr-2 h-3.5 w-3.5" /> {t('menu.table.duplicateRow')}
      </Item>
      <Item disabled={row === 0} onSelect={() => tableMoveRow(doc, tableId, rowId, row - 1)}>
        <ChevronUp className="mr-2 h-3.5 w-3.5" /> {t('menu.table.moveRowUp')}
      </Item>
      <Item disabled={row >= rowCount - 1} onSelect={() => tableMoveRow(doc, tableId, rowId, row + 1)}>
        <ChevronDown className="mr-2 h-3.5 w-3.5" /> {t('menu.table.moveRowDown')}
      </Item>
      <TableColorSubmenu menu={menu} label={t('menu.table.rowColour')} current={tableRowColor(rowBlock)} onPick={(token) => setTableRowColor(doc, tableId, rowId, token)} />
      <Item className={MENU_DESTRUCTIVE_CLASS} onSelect={() => tableDeleteRow(doc, tableId, row)}>
        <Trash2 className="mr-2 h-3.5 w-3.5" /> {t('menu.table.deleteRow')}
      </Item>
    </>
  );
};

export const TableColumnMenuItems: React.FC<Omit<TableAxisMenuItemsProps, 'id'> & {id?: string}> = ({
  tableId, editor, index: col, id: colId, count: colCount, menu = MENU_COMPONENTS.context,
}) => {
  const {Item} = menu;
  const doc = editor.doc;
  const found = findBlock(doc, tableId);
  if (!found || blockType(found.block) !== 'table') return null;
  const table = found.block;
  return (
    <>
      <Item onSelect={() => tableInsertColumn(doc, tableId, col)}><ArrowLeft className="mr-2 h-3.5 w-3.5" /> {t('menu.table.insertColumnLeft')}</Item>
      <Item onSelect={() => tableInsertColumn(doc, tableId, col + 1)}><ArrowRight className="mr-2 h-3.5 w-3.5" /> {t('menu.table.insertColumnRight')}</Item>
      {colId && <TableColorSubmenu menu={menu} label={t('menu.table.columnColour')} current={tableColumnColor(table, colId)} onPick={(token) => setTableColumnColor(doc, tableId, colId, token)} />}
      <Item disabled={col === 0 || !colId} onSelect={() => colId && tableMoveColumn(doc, tableId, colId, col - 1)}><ChevronLeft className="mr-2 h-3.5 w-3.5" /> {t('menu.table.moveColumnLeft')}</Item>
      <Item disabled={col >= colCount - 1 || !colId} onSelect={() => colId && tableMoveColumn(doc, tableId, colId, col + 1)}><ChevronRight className="mr-2 h-3.5 w-3.5" /> {t('menu.table.moveColumnRight')}</Item>
      <Item className={MENU_DESTRUCTIVE_CLASS} onSelect={() => tableDeleteColumn(doc, tableId, col)}><Trash2 className="mr-2 h-3.5 w-3.5" /> {t('menu.table.deleteColumn')}</Item>
    </>
  );
};

const TableHeaderMenuItem: React.FC<{
  menu: MenuComponentSet;
  tableId: string;
  editor: BlockEditorController;
  header: boolean;
}> = ({menu, tableId, editor, header}) => {
  const {Item} = menu;
  return (
    <Item onSelect={() => {
      const found = findBlock(editor.doc, tableId);
      if (found) editor.doc.transact(() => setBlockProp(found.block, 'header', !header), 'local');
    }}>
      <Heading className="mr-2 h-3.5 w-3.5" /> {t('menu.table.toggleHeader')}
    </Item>
  );
};

/**
 * The RANGE variant of the cell menu (TBL-6): shown when the right-clicked cell
 * falls inside the live {@link CellSelection} rectangle. Every item acts on the
 * whole rectangle (never just the clicked cell) in one transact = one undo step:
 *
 *   Clear contents     the same op the Backspace shortcut runs (clearCellRange)
 *   Cell colour        each cell's own `bg` prop, composited over row/column
 *   Delete N rows      exactly rect.top…rect.bottom
 *   Delete N columns   exactly rect.left…rect.right
 *
 * Merge and the two deletes drop the selection afterwards (`onClearRange`) —
 * its coordinates address slots that no longer exist. A clear/tint keeps it,
 * matching the keyboard clear (the highlight persists so the range stays actionable).
 * A range of one row / one column falls back to the singular labels, so we never
 * render "Delete 1 rows" and never need plural rules in the catalogues.
 */
const TableRangeMenuContent: React.FC<{
  rect: CellRect;
  tableId: string;
  editor: BlockEditorController;
  onClearRange?: () => void;
}> = ({rect, tableId, editor, onClearRange}) => {
  const doc = editor.doc;
  const found = findBlock(doc, tableId);
  if (!found || blockType(found.block) !== 'table') return null;
  const grid = tableGrid(found.block);
  // A live remote edit can shrink the grid while this local rectangle/menu is
  // still open. Labels describe the intersection that the range ops will
  // actually touch, never stale coordinates beyond the current table.
  const rowFrom = Math.max(0, Math.min(rect.top, rect.bottom));
  const rowTo = Math.min(grid.rows.length - 1, Math.max(rect.top, rect.bottom));
  const colFrom = Math.max(0, Math.min(rect.left, rect.right));
  const colTo = Math.min(grid.width - 1, Math.max(rect.left, rect.right));
  const rowCount = Math.max(0, rowTo - rowFrom + 1);
  const colCount = Math.max(0, colTo - colFrom + 1);
  const deletesAllRows = grid.rows.length > 0 && rowCount === grid.rows.length;
  const deletesAllColumns = grid.width > 0 && colCount === grid.width;
  // The swatch check is only meaningful when the WHOLE range shares one own-tint
  // (a mixed range shows no check, and "Default" still clears all of it).
  const cells = tableRangeCells(doc, tableId, rect).flat().filter((c): c is BlockMap => c !== null);
  const first = cells.length > 0 ? tableCellOwnColor(cells[0]) : null;
  const current = cells.length > 0 && cells.every((c) => tableCellOwnColor(c) === first) ? first : null;
  const clipboard: Partial<Clipboard> | undefined = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
  const canWriteClipboard = !!clipboard?.write && typeof ClipboardItem !== 'undefined';
  const canPasteClipboard = !!clipboard && (!!clipboard.read || !!clipboard.readText);
  const copyRange = async (cut: boolean): Promise<void> => {
    if (!canWriteClipboard) return;
    try {
      const payload = tableRangeClipboardPayload(doc, tableId, rect);
      await clipboard!.write!([new ClipboardItem({
        'text/plain': new Blob([payload.text], {type: 'text/plain'}),
        'text/html': new Blob([payload.html], {type: 'text/html'}),
      })]);
      if (cut) clearCellRange(doc, tableId, rect);
    } catch {
      // Clipboard permission can be denied between menu open and selection.
    }
  };
  const pasteRange = async (): Promise<void> => {
    if (!canPasteClipboard) return;
    try {
      let html = '';
      let text = '';
      if (clipboard!.read) {
        const items = await clipboard!.read();
        const item = items[0];
        if (item?.types.includes('text/html')) html = await (await item.getType('text/html')).text();
        if (item?.types.includes('text/plain')) text = await (await item.getType('text/plain')).text();
      } else if (clipboard!.readText) text = await clipboard!.readText();
      const source = parseClipboardGrid({html, text});
      if (source) tablePasteGrid(doc, tableId, {row: rowFrom, col: colFrom}, source, {
        range: {tableId, anchor: {row: rowFrom, col: colFrom}, focus: {row: rowTo, col: colTo}},
      });
    } catch {
      // Unsupported/denied clipboard reads leave the document untouched.
    }
  };
  const insertRows = (at: number): void => doc.transact(() => {
    for (let i = 0; i < rowCount; i += 1) tableInsertRow(doc, tableId, at);
  }, 'local');
  const insertColumns = (at: number): void => doc.transact(() => {
    for (let i = 0; i < colCount; i += 1) tableInsertColumn(doc, tableId, at);
  }, 'local');
  return (
    <ContextMenuContent className={MENU_WIDTH_MD}>
      <ContextMenuLabel>
        {t('menu.table.sectionSelection')} · {rowCount} × {colCount}
      </ContextMenuLabel>
      <ContextMenuItem disabled={!canWriteClipboard} onSelect={() => void copyRange(false)}>
        <Copy className="mr-2 h-3.5 w-3.5" /> {t('menu.clipboard.copy')}
      </ContextMenuItem>
      <ContextMenuItem disabled={!canWriteClipboard} onSelect={() => void copyRange(true)}>
        <Scissors className="mr-2 h-3.5 w-3.5" /> {t('menu.clipboard.cut')}
      </ContextMenuItem>
      <ContextMenuItem disabled={!canPasteClipboard} onSelect={() => void pasteRange()}>
        <ClipboardPaste className="mr-2 h-3.5 w-3.5" /> {t('menu.clipboard.paste')}
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onSelect={() => insertRows(rowFrom)}>
        <ArrowUp className="mr-2 h-3.5 w-3.5" /> {t('menu.table.insertRowsAboveN', {n: rowCount})}
      </ContextMenuItem>
      <ContextMenuItem onSelect={() => insertRows(rowTo + 1)}>
        <ArrowDown className="mr-2 h-3.5 w-3.5" /> {t('menu.table.insertRowsBelowN', {n: rowCount})}
      </ContextMenuItem>
      <ContextMenuItem onSelect={() => insertColumns(colFrom)}>
        <ArrowLeft className="mr-2 h-3.5 w-3.5" /> {t('menu.table.insertColumnsLeftN', {n: colCount})}
      </ContextMenuItem>
      <ContextMenuItem onSelect={() => insertColumns(colTo + 1)}>
        <ArrowRight className="mr-2 h-3.5 w-3.5" /> {t('menu.table.insertColumnsRightN', {n: colCount})}
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onSelect={() => clearCellRange(doc, tableId, rect)}>
        <Eraser className="mr-2 h-3.5 w-3.5" /> {t('menu.table.clearCells')}
      </ContextMenuItem>
      <ContextMenuItem
        onSelect={() => {
          tableMergeCells(doc, tableId, rect);
          onClearRange?.();
        }}
      >
        <TableCellsMerge className="mr-2 h-3.5 w-3.5" /> {t('menu.table.mergeCells')}
      </ContextMenuItem>
      <TableColorSubmenu
        label={t('menu.table.tintCells')}
        current={current}
        onPick={(token) => setTableCellRangeColor(doc, tableId, rect, token)}
      />
      <ContextMenuSeparator />
      <ContextMenuItem
        className={MENU_DESTRUCTIVE_CLASS}
        onSelect={() => {
          tableDeleteRowRange(doc, tableId, rect.top, rect.bottom);
          onClearRange?.();
        }}
      >
        <Trash2 className="mr-2 h-3.5 w-3.5" />{' '}
        {deletesAllRows
          ? t('menu.table.deleteTable')
          : rowCount === 1
            ? t('menu.table.deleteRow')
            : t('menu.table.deleteRowsN', {n: rowCount})}
      </ContextMenuItem>
      <ContextMenuItem
        className={MENU_DESTRUCTIVE_CLASS}
        onSelect={() => {
          tableDeleteColumnRange(doc, tableId, rect.left, rect.right);
          onClearRange?.();
        }}
      >
        <Trash2 className="mr-2 h-3.5 w-3.5" />{' '}
        {deletesAllColumns
          ? t('menu.table.deleteTable')
          : colCount === 1
            ? t('menu.table.deleteColumn')
            : t('menu.table.deleteColumnsN', {n: colCount})}
      </ContextMenuItem>
    </ContextMenuContent>
  );
};

const TableCellMenuContent: React.FC<{
  cell: BlockMap;
  tableId: string;
  editor: BlockEditorController;
  /** The live cell-range rectangle for THIS table (TBL-6), if any. */
  range?: CellRect | null;
  onClearRange?: () => void;
}> = ({cell, tableId, editor, range, onClearRange}) => {
  const doc = editor.doc;
  const pos = cellPosition(doc, blockId(cell));
  // An orphaned cell (its column was deleted concurrently) has no grid
  // position — fall back to nothing rather than fire ops at a bad index.
  if (!pos) return null;
  const {row, col, table, rows: rowCount, cols: colCount} = pos;
  // TBL-6: right-clicking INSIDE the live rectangle addresses the range;
  // right-clicking outside it addresses the single cell exactly as before (the
  // click does not move or shrink the selection — it just isn't the subject).
  if (range && isMultiCellRect(range) && cellInRect(range, row, col)) {
    return <TableRangeMenuContent rect={range} tableId={tableId} editor={editor} onClearRange={onClearRange} />;
  }
  // Ids for the move ops, resolved from the SORTED grid so a reordered table
  // still targets the right row/column (the sorted-vs-array trap, acceptance #6).
  const rowBlock = tableGrid(table).rows[row];
  const cellSlot = tableSpans(tableGrid(table))[row]?.[col];
  const merged = cellSlot?.kind === 'cell' && (cellSlot.colspan > 1 || cellSlot.rowspan > 1);
  const rowId = blockId(rowBlock);
  const colId = tableColumns(table)[col]?.id;
  const header = blockProp<boolean>(table, 'header') ?? false;
  return (
    <ContextMenuContent className={MENU_WIDTH_MD}>
      {merged && (
        <>
          <ContextMenuItem onSelect={() => tableSplitCell(doc, blockId(cell))}>
            <TableCellsSplit className="mr-2 h-3.5 w-3.5" /> {t('menu.table.splitCell')}
          </ContextMenuItem>
          <ContextMenuSeparator />
        </>
      )}
      <ContextMenuLabel>{t('menu.table.sectionRow')}</ContextMenuLabel>
      <TableRowMenuItems tableId={tableId} editor={editor} index={row} id={rowId} count={rowCount} header={header} />

      <ContextMenuSeparator />
      <ContextMenuLabel>{t('menu.table.sectionColumn')}</ContextMenuLabel>
      <TableColumnMenuItems tableId={tableId} editor={editor} index={col} id={colId} count={colCount} header={header} />

      <ContextMenuSeparator />
      <TableHeaderMenuItem menu={MENU_COMPONENTS.context} tableId={tableId} editor={editor} header={header} />
    </ContextMenuContent>
  );
};

/**
 * Wraps a cell's `<td>` in its own right-click menu. The trigger stops the
 * contextmenu event from bubbling to the table block's {@link BlockRowMenu}, so
 * inside a cell you get the table menu and on the table chrome (padding cells,
 * gaps) you still get the block menu — acceptance #1/#2. When `suppress` (read-
 * only page or a kit-locked cell) it renders the plain `<td>` with no menu, so
 * a locked table exposes no mutating items — acceptance #4.
 *
 * `range` is the live cell-range rectangle for this table (TBL-6): a right-click
 * on a cell INSIDE it opens the range variant of the menu, outside it the
 * unchanged single-cell menu. Omitted (as when the table renders outside a
 * {@link CellSelectionContext}) it is always the single-cell menu.
 */
export const TableCellMenu: React.FC<{
  cell: BlockMap;
  tableId: string;
  editor: BlockEditorController;
  suppress: boolean;
  range?: CellRect | null;
  onClearRange?: () => void;
  children: React.ReactNode;
}> = ({cell, tableId, editor, suppress, range, onClearRange, children}) => {
  if (suppress) return <>{children}</>;
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild onContextMenu={(e) => e.stopPropagation()}>
        {children}
      </ContextMenuTrigger>
      <TableCellMenuContent
        cell={cell}
        tableId={tableId}
        editor={editor}
        range={range}
        onClearRange={onClearRange}
      />
    </ContextMenu>
  );
};

/**
 * A live drag of a table row or column, by its GRIP handle. `from` is the grip's
 * SORTED position (a render index into `tableGrid`/`tableColumns`), `id` the row
 * block id or column id. `dropIndex` is a boundary in the current sorted order
 * (0…N) — the insertion slot shown by the indicator; it is converted to the
 * op's `toIndex` (moved item removed) at drop time. See {@link TableView}.
 */
interface TableDrag {
  axis: 'row' | 'col';
  from: number;
  id: string;
}

/**
 * Convert a drop indicator boundary (`dropIndex`, a slot 0…N in the CURRENT
 * sorted order) plus the moved item's current sorted position (`from`) into the
 * op's `toIndex` — the target counted with the moved item removed, per the
 * table order contract. Returns null for a no-op drop (dropping onto either
 * boundary of the item's own slot). Exported so the grip wiring is unit-tested
 * in isolation from the DOM (acceptance #6/#7 — the sorted-vs-array trap).
 */
export function tableDropTarget(dropIndex: number, from: number): number | null {
  if (dropIndex === from || dropIndex === from + 1) return null;
  return dropIndex > from ? dropIndex - 1 : dropIndex;
}

const tableColumnName = (index: number): string => {
  let value = index + 1;
  let name = '';
  while (value > 0) {
    value -= 1;
    name = String.fromCharCode(65 + (value % 26)) + name;
    value = Math.floor(value / 26);
  }
  return name;
};

interface TableGripMenuProps {
  axis: 'row' | 'col';
  tableId: string;
  index: number;
  itemId: string;
  count: number;
  header: boolean;
  editor: BlockEditorController;
  style?: React.CSSProperties;
  spanOffset?: number;
  onDragStart: (e: React.DragEvent) => void;
  onDragEnd: () => void;
}

const TableGripMenu: React.FC<TableGripMenuProps> = ({
  axis, tableId, index, itemId, count, header, editor, style, spanOffset, onDragStart, onDragEnd,
}) => {
  const [open, setOpen] = useState(false);
  const [ctxOpen, setCtxOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const press = useRef<{x: number; y: number; moved: boolean} | null>(null);
  const dragged = useRef(false);
  const label = axis === 'row'
    ? t('menu.table.rowOptions', {n: index + 1})
    : t('menu.table.columnOptions', {n: tableColumnName(index)});
  const items = (menu: MenuComponentSet): React.ReactNode => axis === 'row'
    ? <TableRowMenuItems tableId={tableId} editor={editor} index={index} id={itemId} count={count} header={header} menu={menu} />
    : <TableColumnMenuItems tableId={tableId} editor={editor} index={index} id={itemId} count={count} header={header} menu={menu} />;
  const openFromKeyboard = (e: React.KeyboardEvent): void => {
    if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    setOpen(true);
  };
  const refocus = (): void => {
    requestAnimationFrame(() => buttonRef.current?.focus());
  };
  const button = (
    <button
      ref={buttonRef}
      type="button"
      className={axis === 'row' ? 'obe-table-row-grip' : 'obe-table-col-grip'}
      aria-label={label}
      aria-haspopup="menu"
      aria-expanded={open || ctxOpen}
      contentEditable={false}
      data-drag-axis={axis}
      data-drag-from={index}
      data-drag-id={itemId}
      data-span-offset={spanOffset}
      draggable
      style={style}
      onMouseDown={(e) => e.stopPropagation()}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        press.current = {x: e.clientX, y: e.clientY, moved: false};
        dragged.current = false;
      }}
      onPointerMove={(e) => {
        const p = press.current;
        if (p && Math.hypot(e.clientX - p.x, e.clientY - p.y) >= 4) p.moved = true;
      }}
      onPointerUp={() => {
        const p = press.current;
        press.current = null;
        if (p && !p.moved && !dragged.current) setOpen(true);
      }}
      onKeyDown={openFromKeyboard}
      onDragStart={(e) => {
        dragged.current = true;
        setOpen(false);
        onDragStart(e);
      }}
      onDragEnd={() => {
        press.current = null;
        onDragEnd();
      }}
    >
      {axis === 'row' ? <GripVertical className="h-3.5 w-3.5" /> : <GripHorizontal className="h-3.5 w-3.5" />}
    </button>
  );
  return (
    <DropdownMenu open={open} onOpenChange={(next) => { setOpen(next); if (!next) refocus(); }}>
      <DropdownMenuTrigger asChild><span className={`obe-table-grip-anchor obe-table-${axis}-grip-anchor`} style={style} aria-hidden /></DropdownMenuTrigger>
      <ContextMenu onOpenChange={(next) => {
        if (next) {
          press.current = null;
          setOpen(false);
        }
        setCtxOpen(next);
      }}>
        <ContextMenuTrigger asChild onContextMenu={(e) => e.stopPropagation()}>{button}</ContextMenuTrigger>
        <ContextMenuContent className={MENU_WIDTH_MD} onCloseAutoFocus={(e) => { e.preventDefault(); refocus(); }}>
          <ContextMenuLabel>{axis === 'row' ? t('menu.table.sectionRow') : t('menu.table.sectionColumn')}</ContextMenuLabel>
          {items(MENU_COMPONENTS.context)}
          {axis === 'col' && <><ContextMenuSeparator /><TableHeaderMenuItem menu={MENU_COMPONENTS.context} tableId={tableId} editor={editor} header={header} /></>}
        </ContextMenuContent>
      </ContextMenu>
      <DropdownMenuContent className={MENU_WIDTH_MD} onCloseAutoFocus={(e) => { e.preventDefault(); refocus(); }}>
        <DropdownMenuLabel>{axis === 'row' ? t('menu.table.sectionRow') : t('menu.table.sectionColumn')}</DropdownMenuLabel>
        {items(MENU_COMPONENTS.dropdown)}
        {axis === 'col' && <><DropdownMenuSeparator /><TableHeaderMenuItem menu={MENU_COMPONENTS.dropdown} tableId={tableId} editor={editor} header={header} /></>}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

const TableView: React.FC<RowShared & {block: BlockMap}> = ({block, ...shared}) => {
  const {editor, ui} = shared;
  const id = blockId(block);
  // Defense in depth: a legacy / poisoned table doc may miss its `children`, have
  // ragged rows, or carry a non-`cell` block as a row child (the STAB-1 paste
  // poison). Guard every dereference so a malformed table renders a grid with
  // quiet fallbacks instead of throwing and white-screening the whole page.
  // Row/column ORDER comes from the table order contract (model.ts): tableGrid
  // sorts rows by their fractional `ord` key and binds cells to columns by id;
  // legacy tables (no keys) fall through it in pure array order, unchanged.
  const grid = tableGrid(block);
  const rows = grid.rows;
  const columns = tableColumns(block);
  const header = blockProp<boolean>(block, 'header') ?? false;
  // Widest row wins so ragged rows pad to a rectangle at render.
  const cols = grid.width;
  const spans = tableSpans(grid);
  // Cells render TextBlockView directly (not through BlockBody), so the table
  // must apply the lock swap itself — a locked group / present mode / the
  // export viewer would otherwise leave cell text EDITABLE (a lock leak).
  const locked = useKitLock();
  const lockText = locked && !editor.readOnly;
  const cellEditor = useMemo(() => (lockText ? {...editor, readOnly: true} : editor), [editor, lockText]);
  // Drag handles are chrome — hidden in readOnly and in a kit-locked / present
  // context (acceptance #4; also enumerated in the `.ob-present` CSS hide-list).
  const showHandles = !editor.readOnly && !lockText;

  // Internal (grip) drag state — separate from the block-level `shared.drag`
  // that moves the whole table block.
  const [drag, setDrag] = useState<TableDrag | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const clearDrag = useCallback(() => {
    setDrag(null);
    setDropIndex(null);
  }, []);

  const startDrag = (d: TableDrag) => (e: React.DragEvent): void => {
    e.dataTransfer.effectAllowed = 'move';
    // Some engines refuse to start a drag without payload; the value is unused.
    e.dataTransfer.setData('text/plain', d.id);
    setDrag(d);
  };
  const overRow = (r: number) => (e: React.DragEvent): void => {
    if (drag?.axis !== 'row') return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const rect = e.currentTarget.getBoundingClientRect();
    setDropIndex(e.clientY > rect.top + rect.height / 2 ? r + 1 : r);
  };
  const overCol = (c: number) => (e: React.DragEvent): void => {
    if (drag?.axis !== 'col') return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const rect = e.currentTarget.getBoundingClientRect();
    setDropIndex(e.clientX > rect.left + rect.width / 2 ? c + 1 : c);
  };
  const commitDrop = (e: React.DragEvent): void => {
    e.preventDefault();
    // Stop propagation so a drop on a td doesn't bubble to the tr and fire twice.
    e.stopPropagation();
    if (drag && dropIndex !== null) {
      const to = tableDropTarget(dropIndex, drag.from);
      if (to !== null) {
        if (drag.axis === 'row') tableMoveRow(editor.doc, id, drag.id, to);
        else tableMoveColumn(editor.doc, id, drag.id, to);
      }
    }
    clearDrag();
  };

  const rowDrag = drag?.axis === 'row' ? drag : null;
  const colDrag = drag?.axis === 'col' ? drag : null;

  // Cell-range selection (TBL-5): the rectangle for THIS table, if any. Cell
  // highlights are token-based (see `.obe-cell-selected`); `obe-cell-selecting`
  // hides the native blue while a drag lays down the range.
  const cellCtx = React.useContext(CellSelectionContext);
  const activeCellSel = cellCtx?.sel && cellCtx.sel.tableId === id ? cellCtx.sel : null;
  const cellRect = activeCellSel
    ? tableSnapRectToSpans(block, normalizeCellRect(activeCellSel.anchor, activeCellSel.focus))
    : null;
  // Drop the range (TBL-6): the row/column deletes in the range menu invalidate
  // its coordinates, so the highlight must not survive them.
  const clearCellRangeSel = useCallback(() => cellCtx?.setSel(null), [cellCtx]);
  // Shift-click a cell extends the range from its anchor (the live range's
  // anchor, else the focused cell of this table, else the clicked cell).
  // preventDefault stops the browser laying its own cross-cell native range.
  // Selection is allowed read-only (only clear/cut are gated).
  //
  // TBL-6: a SECONDARY (right) press inside the live rectangle is a menu
  // gesture, not a selection gesture — swallow it so the root's "any fresh
  // non-shift press starts over" reset (which runs on the mousedown that
  // precedes every real contextmenu) doesn't drop the very range the menu is
  // about to act on. Outside the rectangle it falls through, so the range
  // collapses as usual and the plain single-cell menu opens.
  const extendCellSelect = (r: number, c: number) => (e: React.MouseEvent): void => {
    if (e.button === 2) {
      if (
        cellRect &&
        isMultiCellRect(cellRect) &&
        cellInRect(cellRect, r, c)
      ) {
        e.stopPropagation();
      }
      return;
    }
    if (!cellCtx || !e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    (document.activeElement as HTMLElement | null)?.blur();
    document.getSelection()?.removeAllRanges();
    let anchor = activeCellSel?.anchor;
    if (!anchor) {
      const fpos = editor.focusedId ? cellPosition(editor.doc, editor.focusedId) : null;
      anchor = fpos && blockId(fpos.table) === id ? {row: fpos.row, col: fpos.col} : {row: r, col: c};
    }
    cellCtx.setSel({tableId: id, anchor, focus: {row: r, col: c}});
  };

  return (
    <div className={[showHandles ? 'obe-table-wrap obe-has-grips' : 'obe-table-wrap', activeCellSel && 'obe-cell-selecting'].filter(Boolean).join(' ')}>
      <table className="obe-table">
        <tbody>
          {rows.map((row, r) => {
            const cells = grid.cells[r];
            const rowId = blockId(row);
            const trClass = [
              header && r === 0 ? 'obe-table-header' : '',
              rowDrag && dropIndex === r ? 'obe-drop-row-above' : '',
              rowDrag && dropIndex === rows.length && r === rows.length - 1 ? 'obe-drop-row-below' : '',
              rowDrag?.id === rowId ? 'obe-row-dragging' : '',
            ]
              .filter(Boolean)
              .join(' ');
            return (
              <tr
                key={rowId}
                className={trClass || undefined}
                data-table-row-id={rowId}
                onDragOver={showHandles ? overRow(r) : undefined}
                onDrop={showHandles ? commitDrop : undefined}
              >
                {showHandles && (
                  <th
                    className="obe-table-row-grip-host"
                    data-obe-chrome="row-grip-host"
                    role="presentation"
                    contentEditable={false}
                  >
                    <TableGripMenu
                      axis="row"
                      tableId={id}
                      index={r}
                      itemId={rowId}
                      count={rows.length}
                      header={header}
                      editor={editor}
                      onDragStart={startDrag({axis: 'row', from: r, id: rowId})}
                      onDragEnd={clearDrag}
                    />
                  </th>
                )}
                {Array.from({length: Math.max(cols, cells.length, 1)}, (_, c) => {
                  const cell = cells[c];
                  const slot = spans[r]?.[c];
                  // A covered coordinate is represented by the anchor's native
                  // td span. Emitting a padding td here would split the layout.
                  if (slot?.kind === 'covered') return null;
                  const colId = columns[c]?.id;
                  // Cell tint composites CELL-over-ROW-over-COLUMN (TBL-4/TBL-6).
                  // All three are palette tokens → theme-aware `obe-bg-*` alpha
                  // classes (dark-safe).
                  const tint = tableCellColor(block, row, colId ?? null, cell ?? null);
                  const tdDropClass = [
                    colDrag && dropIndex === c ? 'obe-drop-col-before' : '',
                    colDrag && dropIndex === cols && c === cols - 1 ? 'obe-drop-col-after' : '',
                    colDrag &&
                    slot?.kind === 'cell' &&
                    Array.from({length: slot.colspan}, (_, offset) => columns[c + offset]?.id).includes(colDrag.id)
                      ? 'obe-col-dragging'
                      : '',
                    isColorToken(tint) ? `obe-bg-${tint}` : '',
                    cellRect && cellInRect(cellRect, r, c) ? 'obe-cell-selected' : '',
                  ]
                    .filter(Boolean)
                    .join(' ');
                  // A top-row anchor owns every coordinate in its colspan, so
                  // divide its top edge into one grip per logical column. Each
                  // segment closes over that column's own sorted index/id. The
                  // model moves registry columns independently; its positional,
                  // self-healing spans contract if a move separates a column
                  // from its anchor instead of silently moving the anchor col.
                  const colGrips =
                    showHandles && r === 0 && cell && slot?.kind === 'cell'
                      ? Array.from({length: slot.colspan}, (_, offset) => {
                        const from = c + offset;
                        const gripColId = columns[from]?.id;
                        if (!gripColId) return null;
                        return (
                          <TableGripMenu
                            key={gripColId}
                            axis="col"
                            tableId={id}
                            index={from}
                            itemId={gripColId}
                            count={cols}
                            header={header}
                            editor={editor}
                            spanOffset={offset}
                            style={{
                              left: `${(offset / slot.colspan) * 100}%`,
                              right: 'auto',
                              width: `${100 / slot.colspan}%`,
                            }}
                            onDragStart={startDrag({axis: 'col', from, id: gripColId})}
                            onDragEnd={clearDrag}
                          />
                        );
                      })
                      : null;
                  if (!cell) {
                    // Padding for a ragged row — an empty structural cell.
                    const pad = (
                      <td
                        key={`pad-${r}-${c}`}
                        aria-hidden
                        className={tdDropClass || undefined}
                        onMouseDownCapture={extendCellSelect(r, c)}
                        onDragOver={showHandles ? overCol(c) : undefined}
                        onDrop={showHandles ? commitDrop : undefined}
                      />
                    );
                    const padInRange =
                      cellRect &&
                      isMultiCellRect(cellRect) &&
                      cellInRect(cellRect, r, c);
                    if (!padInRange || editor.readOnly || lockText) return pad;
                    return (
                      <ContextMenu key={`pad-menu-${r}-${c}`}>
                        <ContextMenuTrigger asChild onContextMenu={(e) => e.stopPropagation()}>
                          {pad}
                        </ContextMenuTrigger>
                        <TableRangeMenuContent
                          rect={cellRect}
                          tableId={id}
                          editor={editor}
                          onClearRange={clearCellRangeSel}
                        />
                      </ContextMenu>
                    );
                  }
                  if (blockType(cell) !== 'cell') {
                    // A non-cell child (a container mis-inserted as a cell
                    // sibling): render a quiet fallback rather than feed a
                    // text-less block to TextBlockView (which would throw).
                    return (
                      <td key={blockId(cell)} className={tdDropClass || undefined}>
                        <div className="obe-unknown" contentEditable={false}>
                          Unsupported cell
                        </div>
                      </td>
                    );
                  }
                  return (
                    <TableCellMenu
                      key={blockId(cell)}
                      cell={cell}
                      tableId={id}
                      editor={editor}
                      suppress={editor.readOnly || lockText}
                      range={cellRect}
                      onClearRange={clearCellRangeSel}
                    >
                      <td
                        className={tdDropClass || undefined}
                        colSpan={slot?.kind === 'cell' && slot.colspan > 1 ? slot.colspan : undefined}
                        rowSpan={slot?.kind === 'cell' && slot.rowspan > 1 ? slot.rowspan : undefined}
                        onMouseDownCapture={extendCellSelect(r, c)}
                        onDragOver={showHandles ? overCol(c) : undefined}
                        onDrop={showHandles ? commitDrop : undefined}
                      >
                        {colGrips}
                        <TextBlockView block={cell} editor={cellEditor} ui={ui} />
                      </td>
                    </TableCellMenu>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
      {!editor.readOnly && (
        <>
          <button
            type="button"
            className="obe-table-add obe-table-add-row"
            aria-label="Add row"
            onClick={() => tableInsertRow(editor.doc, id, rows.length)}
          >
            +
          </button>
          <button
            type="button"
            className="obe-table-add obe-table-add-col"
            aria-label="Add column"
            onClick={() => tableInsertColumn(editor.doc, id, cols)}
          >
            +
          </button>
          <div className="obe-table-tools" contentEditable={false}>
            <button type="button" aria-label="Delete last row" onClick={() => tableDeleteRow(editor.doc, id, rows.length - 1)}>
              − row
            </button>
            <button type="button" aria-label="Delete last column" onClick={() => tableDeleteColumn(editor.doc, id, cols - 1)}>
              − col
            </button>
            <button
              type="button"
              aria-pressed={header}
              aria-label="Toggle header row"
              onClick={() => editor.doc.transact(() => setBlockProp(block, 'header', !header), 'local')}
            >
              header
            </button>
          </div>
        </>
      )}
    </div>
  );
};

export default BlockEditor;
