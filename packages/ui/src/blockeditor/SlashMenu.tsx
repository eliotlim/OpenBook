import React, {useEffect, useLayoutEffect, useMemo, useRef, useState} from 'react';
import {blockText, blockType, findBlock, makeTable, type BlockType, type NewBlock} from './model';
import {customSlashItems} from './registry';
import {aiSlashItems} from './aiBlocks';
import {t, type TKey} from '../i18n';
import type {BlockEditorController} from './useBlockEditor';

/**
 * The “/” command menu: filters as the user keeps typing after the slash,
 * arrow keys + Enter pick (keys are forwarded from the focused text block via
 * `state.keyEvent` so the caret never leaves the document), and applying a
 * command removes the typed “/query” before transforming or inserting.
 */

export interface SlashState {
  open: boolean;
  blockId: string;
  /** Offset of the '/' character inside the block's text. */
  anchorOffset: number;
  query: string;
  index: number;
  keyEvent?: {key: string; n: number};
}

interface SlashItem {
  id: string;
  label: string;
  hint: string;
  keywords: string;
  apply: (editor: BlockEditorController, blockId: string) => void;
}

const turn =
  (type: BlockType, props?: Record<string, unknown>) =>
    (editor: BlockEditorController, blockId: string): void => {
      editor.turnInto(blockId, type, props);
      editor.requestCaret({blockId, offset: 'end'});
    };

const insertAfterOrReplace =
  (make: () => NewBlock) =>
    (editor: BlockEditorController, blockId: string): void => {
      const found = findBlock(editor.doc, blockId);
      const empty = found && blockType(found.block) === 'paragraph' && (blockText(found.block)?.length ?? 0) === 0;
      const id = editor.insertAfter(blockId, make());
      if (empty && found) {
        editor.doc.transact(() => found.parent.delete(found.index, 1), 'local');
      }
      void id;
    };

const columns = (n: number): NewBlock => ({
  type: 'columns',
  children: Array.from({length: n}, () => ({type: 'column' as const, children: [{type: 'paragraph' as const}]})),
});

export const SLASH_ITEMS: SlashItem[] = [
  {id: 'text', label: 'Text', hint: 'Plain paragraph', keywords: 'text paragraph plain', apply: turn('paragraph')},
  {id: 'h1', label: 'Heading 1', hint: 'Large section heading', keywords: 'h1 heading title', apply: turn('heading', {level: 1})},
  {id: 'h2', label: 'Heading 2', hint: 'Medium section heading', keywords: 'h2 heading', apply: turn('heading', {level: 2})},
  {id: 'h3', label: 'Heading 3', hint: 'Small section heading', keywords: 'h3 heading', apply: turn('heading', {level: 3})},
  {id: 'bullet', label: 'Bulleted list', hint: 'Simple list', keywords: 'bullet list ul', apply: turn('list', {kind: 'bullet'})},
  {id: 'number', label: 'Numbered list', hint: 'Ordered list', keywords: 'number ordered list ol', apply: turn('list', {kind: 'number'})},
  {id: 'todo', label: 'To-do', hint: 'Checkbox item', keywords: 'todo check task', apply: turn('todo')},
  {id: 'quote', label: 'Quote', hint: 'Pull quote', keywords: 'quote blockquote', apply: turn('quote')},
  {id: 'callout', label: 'Callout', hint: 'Highlighted note', keywords: 'callout note info', apply: turn('callout', {variant: 'info'})},
  {id: 'code', label: 'Code', hint: 'Monospaced block', keywords: 'code snippet', apply: turn('code')},
  {id: 'livecode', label: 'Live code', hint: 'Computes over inputs; name the output to chain', keywords: 'livecode live code formula compute expr reactive calculation', apply: turn('code', {live: true, name: 'result', language: 'js'})},
  {id: 'divider', label: 'Divider', hint: 'Horizontal rule', keywords: 'divider rule hr line', apply: insertAfterOrReplace(() => ({type: 'divider'}))},
  {id: 'table', label: 'Table', hint: '3 × 3 to start', keywords: 'table grid cells', apply: insertAfterOrReplace(() => makeTable(3, 3))},
  {id: 'cols2', label: '2 columns', hint: 'Side-by-side layout', keywords: 'columns layout two 2', apply: insertAfterOrReplace(() => columns(2))},
  {id: 'cols3', label: '3 columns', hint: 'Three-across layout', keywords: 'columns layout three 3', apply: insertAfterOrReplace(() => columns(3))},
  {id: 'cols4', label: '4 columns', hint: 'Four-across layout', keywords: 'columns layout four 4', apply: insertAfterOrReplace(() => columns(4))},
];

export const SlashMenu: React.FC<{
  state: SlashState;
  editor: BlockEditorController;
  anchorEl: HTMLElement | null;
  rootEl: HTMLElement | null;
  onClose: () => void;
}> = ({state, editor, anchorEl, rootEl, onClose}) => {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{left: number; top: number; maxHeight: number} | null>(null);
  const [index, setIndex] = useState(0);

  // Labels resolve through the catalog at open time (`slash.<id>` for core
  // items, `slash.custom.<type>` for registered blocks), falling back to the
  // registered English string — third-party blocks without catalog entries
  // still read fine. Keyword search matches BOTH the registered keywords and
  // the translated label, so /tabelle finds Table in German.
  const tr = (key: string, fallback: string): string => {
    const value = t(key as TKey);
    return value === key ? fallback : value;
  };

  const items = useMemo(() => {
    const q = state.query.toLowerCase();
    const core: SlashItem[] = SLASH_ITEMS.map((item) => ({
      ...item,
      label: tr(`slash.${item.id}.label`, item.label),
      hint: tr(`slash.${item.id}.hint`, item.hint),
    }));
    const custom: SlashItem[] = customSlashItems().map((def) => ({
      id: `custom-${def.type}`,
      label: tr(`slash.custom.${def.type}.label`, def.slash!.label),
      hint: tr(`slash.custom.${def.type}.hint`, def.slash!.hint),
      keywords: def.slash!.keywords,
      apply: insertAfterOrReplace(() => def.slash!.make()),
    }));
    const ai: SlashItem[] = aiSlashItems().map((item) => ({
      id: item.id,
      label: tr(`slash.${item.id}.label`, item.label),
      hint: tr(`slash.${item.id}.hint`, item.hint),
      keywords: item.keywords,
      apply: item.apply,
    }));
    return [...core, ...custom, ...ai].filter(
      (item) => !q || item.keywords.includes(q) || item.label.toLowerCase().includes(q),
    );
  }, [state.query]);

  // Fixed (viewport) positioning: anchored to the caret, measured after
  // render, flipped above the line when there's no room below, clamped to the
  // viewport edges. `pos === null` renders the menu invisibly for measuring
  // (the anchor block can mount a frame later than the menu — e.g. the “+”
  // gutter button inserts a block and opens the menu in the same action).
  useLayoutEffect(() => {
    let raf = 0;
    let attempts = 0;
    const isZero = (r: DOMRect | undefined | null): boolean => !r || (r.width === 0 && r.height === 0 && r.x === 0 && r.y === 0);
    const measure = (): void => {
      const sel = document.getSelection();
      // The caret rect is all-zero in a not-yet-painted empty block (the “+”
      // gutter flow) — fall back to the block's own rect, and retry a few
      // frames while the anchor finishes mounting; bailing silently left the
      // menu invisible until the first query keystroke re-ran this effect.
      const caretRect =
        sel && sel.rangeCount > 0 && anchorEl?.contains(sel.anchorNode) ? sel.getRangeAt(0).getBoundingClientRect() : null;
      const rect = !isZero(caretRect) ? caretRect! : anchorEl?.getBoundingClientRect();
      if (isZero(rect)) {
        if (attempts++ < 20) raf = requestAnimationFrame(measure);
        return;
      }
      const menu = ref.current;
      const menuH = menu?.offsetHeight ?? 304;
      const menuW = menu?.offsetWidth ?? 272;
      // Open into whichever side of the caret line has more room, and never
      // cover the line itself: the menu's height caps to the chosen side.
      const below = window.innerHeight - rect!.bottom - 14;
      const above = rect!.top - 14;
      const flip = menuH > below && above > below;
      const maxHeight = Math.max(120, Math.min(304, flip ? above : below));
      const shownH = Math.min(menuH, maxHeight);
      const top = flip ? Math.max(8, rect!.top - 6 - shownH) : rect!.bottom + 6;
      const left = Math.max(8, Math.min(rect!.left, window.innerWidth - menuW - 8));
      setPos({left, top, maxHeight});
    };
    measure();
    return () => cancelAnimationFrame(raf);
  }, [anchorEl, rootEl, state.anchorOffset, items.length]);

  useEffect(() => setIndex(0), [state.query]);

  /** Keys forwarded from the text block (the caret stays in the document). */
  useEffect(() => {
    const ev = state.keyEvent;
    if (!ev) return;
    if (ev.key === 'ArrowDown') setIndex((i) => (i + 1) % Math.max(1, items.length));
    else if (ev.key === 'ArrowUp') setIndex((i) => (i - 1 + Math.max(1, items.length)) % Math.max(1, items.length));
    else if (ev.key === 'Enter' || ev.key === 'Tab') pick(items[index]);
    else if (ev.key === 'Escape') onClose();
    // (deliberately keyed on the event counter alone)
  }, [state.keyEvent?.n]);  

  // Empty result set closes the menu (the query no longer matches anything).
  useEffect(() => {
    if (items.length === 0) onClose();
  }, [items.length, onClose]);

  const pick = (item: SlashItem | undefined): void => {
    if (!item) return;
    const found = findBlock(editor.doc, state.blockId);
    const text = found && blockText(found.block);
    if (text) {
      // Remove the typed “/query”.
      const len = 1 + state.query.length;
      editor.doc.transact(() => {
        if (text.toString().slice(state.anchorOffset, state.anchorOffset + 1) === '/') {
          text.delete(state.anchorOffset, Math.min(len, text.length - state.anchorOffset));
        }
      }, 'local');
    }
    onClose();
    item.apply(editor, state.blockId);
  };

  return (
    <div
      ref={ref}
      className="obe-slash"
      style={pos ? {left: pos.left, top: pos.top, maxHeight: pos.maxHeight} : {left: 0, top: 0, visibility: 'hidden'}}
      role="listbox"
      aria-label="Insert a block"
    >
      {items.map((item, i) => (
        <button
          key={item.id}
          type="button"
          role="option"
          aria-selected={i === index}
          className={`obe-slash-item${i === index ? ' obe-slash-active' : ''}`}
          title={item.hint}
          onMouseEnter={() => setIndex(i)}
          onMouseDown={(e) => {
            e.preventDefault(); // keep the caret in the document
            pick(item);
          }}
        >
          <span className="obe-slash-label">{item.label}</span>
        </button>
      ))}
    </div>
  );
};
