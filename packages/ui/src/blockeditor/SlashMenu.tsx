import React, {useEffect, useLayoutEffect, useMemo, useRef, useState} from 'react';
import {blockText, blockType, findBlock, makeTable, type BlockType, type NewBlock} from './model';
import {customSlashItems} from './registry';
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
  const [pos, setPos] = useState<{left: number; top: number}>({left: 0, top: 0});
  const [index, setIndex] = useState(0);

  const items = useMemo(() => {
    const q = state.query.toLowerCase();
    const custom: SlashItem[] = customSlashItems().map((def) => ({
      id: `custom-${def.type}`,
      label: def.slash!.label,
      hint: def.slash!.hint,
      keywords: def.slash!.keywords,
      apply: insertAfterOrReplace(() => def.slash!.make()),
    }));
    return [...SLASH_ITEMS, ...custom].filter((item) => !q || item.keywords.includes(q) || item.label.toLowerCase().includes(q));
  }, [state.query]);

  useLayoutEffect(() => {
    if (!anchorEl || !rootEl) return;
    const sel = document.getSelection();
    const rect =
      sel && sel.rangeCount > 0 && anchorEl.contains(sel.anchorNode)
        ? sel.getRangeAt(0).getBoundingClientRect()
        : anchorEl.getBoundingClientRect();
    const host = rootEl.getBoundingClientRect();
    setPos({left: Math.min(rect.left - host.left, host.width - 280), top: rect.bottom - host.top + 6});
  }, [anchorEl, rootEl, state.anchorOffset]);

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
      style={{left: pos.left, top: pos.top}}
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
          onMouseEnter={() => setIndex(i)}
          onMouseDown={(e) => {
            e.preventDefault(); // keep the caret in the document
            pick(item);
          }}
        >
          <span className="obe-slash-label">{item.label}</span>
          <span className="obe-slash-hint">{item.hint}</span>
        </button>
      ))}
    </div>
  );
};
