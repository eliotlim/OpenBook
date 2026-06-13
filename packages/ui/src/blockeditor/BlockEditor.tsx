import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {Boxes, GripVertical, Lock, LockOpen, Plus, RefreshCw} from 'lucide-react';
import type * as Y from 'yjs';
import {
  blockChildren,
  blockId,
  blockProp,
  blockText,
  blockType,
  dropBeside,
  findBlock,
  moveBlock,
  parentBlockOf,
  blockToJSON,
  cloneBlock,
  removeBlock,
  rootBlocks,
  setBlockProp,
  tableDeleteColumn,
  tableDeleteRow,
  tableInsertColumn,
  tableInsertRow,
  TEXT_BLOCKS,
  type BlockMap,
  type BlockType,
} from './model';
import {rangeHasAttr, readSelection, writeSelection} from './richtext';
import {blocksToHtml, blocksToMarkdown} from './exportBlocks';
import {getCustomBlock} from './registry';
import {CodeBlockView} from './CodeBlockView';
import {pageLinks} from '@/lib/pageLinks';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import {TextBlockView} from './TextBlockView';
import {SlashMenu, type SlashState} from './SlashMenu';
import {LinkPicker} from './LinkPicker';
import {hasKitConfig, openKitConfig} from './kit/kitConfig';
import {KitLockContext, useKitLock} from './kit/lock';
import {KitInlineText} from './kit/KitFrame';
import {groupInputs, inputValue, setInputValue} from './kit/scope';
import {readGroupSync, subscribeGroupSync, valueEqual, writeGroupSync} from './kit/groupSync';
import type {PageLinkResult} from '@/lib/pageLinks';
import {InlineToolbar, type ToolbarState} from './InlineToolbar';
import {useBlockEditor, type BlockEditorController} from './useBlockEditor';
import type {InlineAttrs} from './model';

/**
 * The block editor root: renders the block tree, owns the transient UI
 * (slash menu, inline toolbar, drag state, block selection), and routes
 * structural keyboard commands. Pure UI — all document state lives in the
 * Y.Doc handed in by the caller.
 */

/** Shared UI surface text blocks call into (menus, formatting, drag). */
export interface EditorUI {
  slash: SlashState;
  spellcheck: boolean;
  openSlash(blockId: string, anchorOffset: number): void;
  updateSlash(caret: number): void;
  closeSlash(): void;
  slashKey(key: string): void;
  toggleFormat(key: keyof InlineAttrs, value?: string): void;
  scheduleToolbar(): void;
}

export type DropRegion = 'above' | 'below' | 'left' | 'right';
interface DragState {
  id: string;
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
}> = ({doc, readOnly = false, ariaLabel, fullWidth = false, compact = false, spellcheck = true, pageId}) => {
  const editor = useBlockEditor(doc, readOnly);
  const rootRef = useRef<HTMLDivElement>(null);

  const [slash, setSlash] = useState<SlashState>({open: false, blockId: '', anchorOffset: 0, query: '', index: 0});
  const [toolbar, setToolbar] = useState<ToolbarState | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [linkPicker, setLinkPicker] = useState<{kind: 'page' | 'database'; blockId: string; anchorOffset: number} | null>(null);
  const [live, setLive] = useState(''); // aria-live announcements

  // Insert an inline page-link mention (chosen in the LinkPicker) at the caret.
  const insertMention = useCallback(
    (blockId: string, at: number, r: PageLinkResult): void => {
      const found = findBlock(doc, blockId);
      const text = found && blockText(found.block);
      if (!text) return;
      const label = `${r.icon} ${r.label}`;
      const start = Math.min(at, text.length);
      doc.transact(() => {
        text.insert(start, label, {m: r.id});
        text.insert(start + label.length, ' ', {m: null}); // plain space so the caret exits the chip
      }, 'local');
      editor.requestCaret({blockId, offset: start + label.length + 1});
    },
    [doc, editor],
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
      const rect = domSel.getRangeAt(0).getBoundingClientRect();
      const found = findBlock(doc, id);
      const text = found && blockText(found.block);
      // Viewport (fixed) coords: centered over the selection, clamped at the
      // edges, dropped below the selection when the line sits near the top.
      const half = 124;
      const nearTop = rect.top < 56;
      setToolbar({
        left: Math.max(half, Math.min(rect.left + rect.width / 2, window.innerWidth - half)),
        top: nearTop ? rect.bottom + 44 : rect.top,
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
      const after = s.slice(state.anchorOffset + 1);
      return after.slice(0, Math.max(0, caret - state.anchorOffset - 1));
    },
    [doc],
  );

  const ui = useMemo<EditorUI>(() => {
    const closeSlash = (): void => setSlash((s) => ({...s, open: false, query: '', index: 0}));
    return {
      slash,
      spellcheck,
      openSlash: (id, anchorOffset) => setSlash({open: true, blockId: id, anchorOffset, query: '', index: 0}),
      updateSlash: (caret) =>
        setSlash((s) => {
          if (!s.open) return s;
          const found = findBlock(doc, s.blockId);
          const text = found && blockText(found.block);
          // '/' deleted → close.
          if (!text || text.toString()[s.anchorOffset] !== '/') return {...s, open: false};
          return {...s, query: slashQuery(s, caret), index: 0};
        }),
      closeSlash,
      slashKey: (key) => {
        // handled inside SlashMenu via props — stored here so text blocks can forward keys
        setSlash((s) => ({...s, keyEvent: {key, n: (s.keyEvent?.n ?? 0) + 1}}));
      },
      toggleFormat,
      scheduleToolbar,
    };
  }, [slash, doc, slashQuery, toggleFormat, scheduleToolbar, spellcheck]);

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
    (sourceId: string, targetId: string, region: DropRegion): void => {
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
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'd') {
      e.preventDefault();
      editor.duplicateSelected();
      setLive('Duplicated');
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      editor.moveSelected(e.key === 'ArrowDown' ? 1 : -1);
      setLive(e.key === 'ArrowDown' ? 'Moved down' : 'Moved up');
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

  return (
    <div
      ref={rootRef}
      className={['obe-root', fullWidth && 'obe-full', compact && 'obe-compact'].filter(Boolean).join(' ')}
      role="region"
      aria-label={ariaLabel ?? 'Page content'}
      onKeyDownCapture={onRootKeyDownCapture}
      onMouseDown={(e) => {
        if (e.target === rootRef.current) editor.clearSelection();
      }}
      onClick={(e) => {
        // Mentions navigate; links open in a new tab. (Mentions are
        // contenteditable=false so a plain click is unambiguous; links keep
        // the caret behavior on plain click only when editing is impossible.)
        const anchor = (e.target as HTMLElement).closest?.('a.obe-mention, a.obe-link');
        if (anchor instanceof HTMLElement) {
          const pageRef = anchor.dataset.pageId;
          if (pageRef) {
            e.preventDefault();
            pageLinks.openPage(pageRef);
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
      <BlockList list={rootBlocks(doc)} editor={editor} ui={ui} drag={drag} setDrag={setDrag} performDrop={performDrop} computeRegion={computeRegion} depth={0} />
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
      {toolbar && !readOnly && <InlineToolbar state={toolbar} onToggle={toggleFormat} />}
      <div aria-live="polite" className="obe-sr-only">
        {live}
      </div>
    </div>
  );
};

const topLevelIds = (doc: Y.Doc): string[] => rootBlocks(doc).map((b) => blockId(b));

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

interface RowShared {
  editor: BlockEditorController;
  ui: EditorUI;
  drag: DragState | null;
  setDrag: React.Dispatch<React.SetStateAction<DragState | null>>;
  performDrop: (sourceId: string, targetId: string, region: DropRegion) => void;
  computeRegion: (e: React.DragEvent | React.PointerEvent, el: HTMLElement, allowSides: boolean) => DropRegion;
  depth: number;
}

const BlockList: React.FC<RowShared & {list: Y.Array<BlockMap>}> = ({list, ...shared}) => (
  <>
    {list.map((block) => (
      <BlockRow key={blockId(block)} block={block} {...shared} />
    ))}
  </>
);

/** One block row: hover gutter (add + drag handle), drop targeting, dispatch. */
const BlockRow: React.FC<RowShared & {block: BlockMap}> = ({block, ...shared}) => {
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
  const allowSides = depth === 0 && type !== 'columns'; // side-drop creates/extends columns at top level
  const indent = blockProp<number>(block, 'indent') ?? 0;

  const onDragOver = (e: React.DragEvent): void => {
    if (!drag || drag.id === id || editor.readOnly) return;
    e.preventDefault();
    e.stopPropagation();
    const region = computeRegion(e, rowRef.current!, allowSides);
    setDrag((d) => (d && (d.over?.id !== id || d.over.region !== region) ? {...d, over: {id, region}} : d));
  };

  const onDrop = (e: React.DragEvent): void => {
    if (!drag) return;
    e.preventDefault();
    e.stopPropagation();
    performDrop(drag.id, id, computeRegion(e, rowRef.current!, allowSides));
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
    >
      {!editor.readOnly && (
        <div className={`obe-gutter${depth > 0 ? ' obe-gutter-nested' : ''}`} contentEditable={false}>
          {depth === 0 && (
            <button
              type="button"
              tabIndex={-1}
              aria-label="Add a block below"
              className="obe-gutter-btn"
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
              onDragStart={(e) => {
                // dataTransfer is null on synthetic events (tests) — optional.
                if (e.dataTransfer) {
                  e.dataTransfer.effectAllowed = 'move';
                  e.dataTransfer.setData('text/plain', id);
                }
                setDrag({id, over: null});
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
      <BlockBody block={block} {...shared} />
    </div>
  );

  // Right-clicking a block opens its own actions (not the page menu). In
  // read-only mode there are no block actions, so fall through to the page menu.
  if (editor.readOnly) return rowEl;
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{rowEl}</ContextMenuTrigger>
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
  };
}

/** The drag handle's click menu: block actions without leaving the mouse. */
const HandleMenu: React.FC<{block: BlockMap; editor: BlockEditorController}> = ({block, editor}) => {
  const id = blockId(block);
  const isText = TEXT_BLOCKS.has(blockType(block));
  const ops = blockOps(editor, id);
  return (
    <DropdownMenuContent align="start" side="bottom" className="w-44">
      {isText && (
        <>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>Turn into</DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-40">
              {TURN_OPTIONS.map((o) => (
                <DropdownMenuItem key={o.label} onClick={() => ops.turn(o.type, o.props)}>
                  {o.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSeparator />
        </>
      )}
      <DropdownMenuItem onClick={ops.duplicate}>Duplicate</DropdownMenuItem>
      <DropdownMenuItem onClick={() => ops.move(-1)}>Move up</DropdownMenuItem>
      <DropdownMenuItem onClick={() => ops.move(1)}>Move down</DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={ops.remove}>
        Delete
      </DropdownMenuItem>
    </DropdownMenuContent>
  );
};

/** The block's right-click menu — block actions in place of the page menu, so
 *  right-clicking a block reads as "this block", not "this page". */
const BlockRowMenu: React.FC<{block: BlockMap; editor: BlockEditorController}> = ({block, editor}) => {
  const id = blockId(block);
  const isText = TEXT_BLOCKS.has(blockType(block));
  const ops = blockOps(editor, id);
  return (
    <ContextMenuContent className="w-44">
      {/* Interactive blocks expose their settings popover right from the menu. */}
      {hasKitConfig(id) && (
        <>
          <ContextMenuItem onSelect={() => openKitConfig(id)}>Configure…</ContextMenuItem>
          <ContextMenuSeparator />
        </>
      )}
      {isText && (
        <>
          <ContextMenuSub>
            <ContextMenuSubTrigger>Turn into</ContextMenuSubTrigger>
            <ContextMenuSubContent className="w-40">
              {TURN_OPTIONS.map((o) => (
                <ContextMenuItem key={o.label} onSelect={() => ops.turn(o.type, o.props)}>
                  {o.label}
                </ContextMenuItem>
              ))}
            </ContextMenuSubContent>
          </ContextMenuSub>
          <ContextMenuSeparator />
        </>
      )}
      <ContextMenuItem onSelect={() => editor.setSelection([id])}>Select block</ContextMenuItem>
      <ContextMenuItem onSelect={ops.duplicate}>Duplicate</ContextMenuItem>
      <ContextMenuItem onSelect={() => ops.move(-1)}>Move up</ContextMenuItem>
      <ContextMenuItem onSelect={() => ops.move(1)}>Move down</ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem className="text-destructive focus:text-destructive" onSelect={ops.remove}>
        Delete
      </ContextMenuItem>
    </ContextMenuContent>
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
            placeholder="Group"
            readOnly={editor.readOnly}
            ariaLabel="Group name"
            onCommit={(v) => set('name', v)}
          />
          <span className="obe-group-spacer" />
          <button
            type="button"
            className={`obe-group-btn${sync ? ' obe-group-btn-on' : ''}`}
            aria-label={sync ? `Synced across pages as ${sync}` : 'Sync this group across pages'}
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
            aria-label={locked ? 'Unlock group' : 'Lock group'}
            aria-pressed={locked}
            title={locked ? 'Unlock group' : 'Lock group'}
            disabled={editor.readOnly}
            onClick={() => set('locked', !ownLocked)}
          >
            {locked ? <Lock className="h-3.5 w-3.5" /> : <LockOpen className="h-3.5 w-3.5" />}
          </button>
        </header>
        <div className="obe-group-body">
          {children && <BlockList list={children} {...shared} depth={shared.depth + 1} />}
        </div>
      </section>
    </KitLockContext.Provider>
  );
};

/** Type dispatch for a block's content. */
const BlockBody: React.FC<RowShared & {block: BlockMap}> = ({block, ...shared}) => {
  const {editor, ui} = shared;
  const type = blockType(block);
  const id = blockId(block);

  // A locked group makes its descendants read-only: text and structure
  // entirely, kit widgets unless they're flagged `interactive` (a reader keeps
  // operating those). Containers keep the real editor and re-apply the lock at
  // each leaf via the context.
  const locked = useKitLock();
  const lockText = locked && !editor.readOnly;
  const interactive = Boolean(blockProp<boolean>(block, 'interactive'));
  const textEditor = useMemo(() => (lockText ? {...editor, readOnly: true} : editor), [editor, lockText]);
  const kitEditor = useMemo(
    () => (lockText && !interactive ? {...editor, readOnly: true} : editor),
    [editor, lockText, interactive],
  );

  switch (type) {
  case 'divider':
    return <hr className="obe-divider" aria-label="Divider" />;

  case 'columns':
    return <ColumnsView block={block} {...shared} />;

  case 'group':
    return <GroupView block={block} {...shared} />;

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
          <Custom block={block} editor={kitEditor} />
        </div>
      );
    }
    // A text-carrying unknown type still edits as text; anything else shows
    // a quiet placeholder instead of crashing (forward compatibility).
    if (blockText(block)) return <TextBlockView block={block} editor={textEditor} ui={ui} />;
    return (
      <div className="obe-unknown" contentEditable={false}>
        Unsupported block “{type}”
      </div>
    );
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

/** A columns layout on the 12-col grid, with draggable dividers between
 *  columns that redistribute the adjacent pair's spans. */
const ColumnsView: React.FC<RowShared & {block: BlockMap}> = ({block, ...shared}) => {
  const {editor} = shared;
  const wrapRef = useRef<HTMLDivElement>(null);
  const cols = blockChildren(block)!;
  const fallback = Math.floor(12 / Math.max(1, cols.length));
  const spanOf = (col: BlockMap): number => Math.max(1, Math.min(12, blockProp<number>(col, 'span') ?? fallback));
  const styleFor = (col: BlockMap): React.CSSProperties => ({gridColumn: `span ${spanOf(col)}`});

  /** Drag the divider between columns i and i+1: shift grid units between them. */
  const onDividerDown = (e: React.PointerEvent, i: number): void => {
    if (editor.readOnly) return;
    e.preventDefault();
    const wrap = wrapRef.current;
    if (!wrap) return;
    const unit = wrap.getBoundingClientRect().width / 12;
    const left = cols.get(i);
    const right = cols.get(i + 1);
    const startLeft = spanOf(left);
    const startRight = spanOf(right);
    const startX = e.clientX;
    const move = (ev: PointerEvent): void => {
      const delta = Math.round((ev.clientX - startX) / unit);
      const nextLeft = Math.max(1, Math.min(startLeft + startRight - 1, startLeft + delta));
      const nextRight = startLeft + startRight - nextLeft;
      if (nextLeft !== spanOf(left) || nextRight !== spanOf(right)) {
        editor.doc.transact(() => {
          setBlockProp(left, 'span', nextLeft);
          setBlockProp(right, 'span', nextRight);
        }, 'local');
      }
    };
    const up = (): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <div ref={wrapRef} className="obe-columns" data-cols={cols.length} role="group" aria-label={`${cols.length} columns`}>
      {cols.map((col, i) => (
        <React.Fragment key={blockId(col)}>
          <div className="obe-column" style={styleFor(col)} data-block-row={blockId(col)}>
            {i > 0 && !editor.readOnly && (
              <div
                className="obe-col-divider"
                role="separator"
                aria-orientation="vertical"
                aria-label="Resize columns"
                onPointerDown={(e) => onDividerDown(e, i - 1)}
              />
            )}
            <BlockList list={blockChildren(col)!} {...shared} depth={shared.depth + 1} />
          </div>
        </React.Fragment>
      ))}
    </div>
  );
};

// ── Table ─────────────────────────────────────────────────────────────────────

const TableView: React.FC<RowShared & {block: BlockMap}> = ({block, ...shared}) => {
  const {editor, ui} = shared;
  const id = blockId(block);
  const rows = blockChildren(block)!;
  const header = blockProp<boolean>(block, 'header') ?? false;
  const cols = rows.length > 0 ? (blockChildren(rows.get(0))?.length ?? 0) : 0;

  return (
    <div className="obe-table-wrap">
      <table className="obe-table">
        <tbody>
          {rows.map((row, r) => (
            <tr key={blockId(row)} className={header && r === 0 ? 'obe-table-header' : undefined}>
              {blockChildren(row)!.map((cell) => (
                <td key={blockId(cell)}>
                  <TextBlockView block={cell} editor={editor} ui={ui} />
                </td>
              ))}
            </tr>
          ))}
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
