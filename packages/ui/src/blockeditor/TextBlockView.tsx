import React, {useLayoutEffect, useRef} from 'react';
import {blockId, blockProp, blockText, blockType, findBlock, setBlockProp, type BlockMap, type BlockType} from './model';
import {attrsAt, diffText, readSelection, runsToHtml, writeSelection} from './richtext';
import type {BlockEditorController} from './useBlockEditor';
import type {EditorUI} from './BlockEditor';

/**
 * One editable rich-text block. The DOM is owned imperatively: Y.Text is the
 * source of truth, every keystroke is intercepted (`beforeinput`), applied to
 * Y.Text, and the element re-rendered from the model — so local typing,
 * remote edits, and undo all flow through the same render path. The only
 * exception is IME composition, where the browser must own the DOM until
 * `compositionend`, after which the result is diffed back into Y.Text.
 */

const PLACEHOLDERS: Partial<Record<BlockType, string>> = {
  heading: 'Heading',
  todo: 'To-do',
  list: 'List item',
  quote: 'Quote',
  callout: 'Callout',
  code: 'Code',
};

export const TextBlockView: React.FC<{
  block: BlockMap;
  editor: BlockEditorController;
  ui: EditorUI;
}> = ({block, editor, ui}) => {
  const ref = useRef<HTMLDivElement>(null);
  const composing = useRef(false);
  const id = blockId(block);
  const type = blockType(block);
  const text = blockText(block)!;
  const isCode = type === 'code';

  // Native beforeinput binding (always calling the latest render's handler).
  const beforeInputRef = useRef<(ev: InputEvent) => void>(() => {});
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const listener = (ev: Event): void => beforeInputRef.current(ev as InputEvent);
    el.addEventListener('beforeinput', listener);
    return () => el.removeEventListener('beforeinput', listener);
  }, []);

  // ── Model → DOM ────────────────────────────────────────────────────────────
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || composing.current) return;
    const target = runsToHtml(text);
    if (el.innerHTML !== target) el.innerHTML = target;

    const pending = editor.pendingCaret.current;
    if (pending && pending.blockId === id) {
      editor.pendingCaret.current = null;
      el.focus({preventScroll: false});
      const offset = pending.offset === 'end' ? text.length : Math.min(pending.offset, text.length);
      writeSelection(el, offset);
    }
  });

  // ── Local edits ────────────────────────────────────────────────────────────
  const apply = (fn: () => void): void => {
    editor.doc.transact(fn, 'local');
  };

  const deleteSelection = (sel: {start: number; end: number}): void => {
    if (sel.end > sel.start) text.delete(sel.start, sel.end - sel.start);
  };

  const insertPlain = (at: number, data: string): void => {
    text.insert(at, data, isCode ? {} : attrsAt(text, at));
  };

  /** Markdown prefixes: typed at the start of a block, space converts it. */
  const markdownTransform = (prefix: string): boolean => {
    const map: Record<string, {type: BlockType; props?: Record<string, unknown>}> = {
      '#': {type: 'heading', props: {level: 1}},
      '##': {type: 'heading', props: {level: 2}},
      '###': {type: 'heading', props: {level: 3}},
      '-': {type: 'list', props: {kind: 'bullet'}},
      '*': {type: 'list', props: {kind: 'bullet'}},
      '1.': {type: 'list', props: {kind: 'number'}},
      '[]': {type: 'todo'},
      '[ ]': {type: 'todo'},
      '[x]': {type: 'todo', props: {checked: true}},
      '>': {type: 'quote'},
    };
    const hit = map[prefix];
    if (!hit || type !== 'paragraph') return false;
    apply(() => {
      text.delete(0, prefix.length);
      editor.turnInto(id, hit.type, hit.props);
    });
    editor.requestCaret({blockId: id, offset: 0});
    return true;
  };

  // React's onBeforeInput is a legacy keypress polyfill whose preventDefault
  // does NOT cancel the native event — a custom editor must bind natively.
  const onBeforeInput = (ev: InputEvent): void => {
    if (editor.readOnly) {
      ev.preventDefault();
      return;
    }
    if (composing.current || ev.isComposing) return; // IME owns the DOM until compositionend
    const el = ref.current!;
    const sel = readSelection(el) ?? {start: text.length, end: text.length};

    switch (ev.inputType) {
    case 'insertText':
    case 'insertReplacementText': {
      ev.preventDefault();
      const data = ev.data ?? '';
      // Slash menu: '/' at start or after whitespace opens it.
      if (data === '/' && !isCode) {
        const before = text.toString().slice(0, sel.start);
        if (before === '' || /\s$/.test(before)) {
          apply(() => {
            deleteSelection(sel);
            insertPlain(sel.start, '/');
          });
          editor.requestCaret({blockId: id, offset: sel.start + 1});
          ui.openSlash(id, sel.start);
          return;
        }
      }
      // Markdown shortcuts fire on the space after a known prefix.
      if (data === ' ' && sel.start === sel.end && !isCode) {
        const prefix = text.toString().slice(0, sel.start);
        if (markdownTransform(prefix)) return;
        if (prefix === '``' ) {
          apply(() => {
            text.delete(0, 2);
            editor.turnInto(id, 'code');
          });
          return;
        }
      }
      apply(() => {
        deleteSelection(sel);
        insertPlain(sel.start, data);
      });
      editor.requestCaret({blockId: id, offset: sel.start + data.length});
      if (ui.slash.open && ui.slash.blockId === id) ui.updateSlash();
      return;
    }

    case 'insertParagraph': {
      ev.preventDefault();
      if (ui.slash.open) return; // Enter belongs to the menu
      if (isCode) {
        apply(() => {
          deleteSelection(sel);
          insertPlain(sel.start, '\n');
        });
        editor.requestCaret({blockId: id, offset: sel.start + 1});
        return;
      }
      // Enter on an empty list/todo/quote exits the structure first.
      if (text.length === 0 && type !== 'paragraph') {
        editor.turnInto(id, 'paragraph');
        editor.requestCaret({blockId: id, offset: 0});
        return;
      }
      apply(() => deleteSelection(sel));
      editor.splitAt(id, sel.start);
      return;
    }

    case 'insertLineBreak': {
      ev.preventDefault();
      apply(() => {
        deleteSelection(sel);
        insertPlain(sel.start, '\n');
      });
      editor.requestCaret({blockId: id, offset: sel.start + 1});
      return;
    }

    case 'deleteContentBackward': {
      ev.preventDefault();
      if (sel.end > sel.start) {
        apply(() => deleteSelection(sel));
        editor.requestCaret({blockId: id, offset: sel.start});
      } else if (sel.start > 0) {
        // Surrogate-pair aware single delete.
        const s = text.toString();
        const len = sel.start >= 2 && /[\uD800-\uDBFF]/.test(s[sel.start - 2]) && /[\uDC00-\uDFFF]/.test(s[sel.start - 1]) ? 2 : 1;
        apply(() => text.delete(sel.start - len, len));
        editor.requestCaret({blockId: id, offset: sel.start - len});
        if (ui.slash.open && ui.slash.blockId === id) ui.updateSlash();
      } else {
        const indent = blockProp<number>(block, 'indent') ?? 0;
        if (indent > 0) {
          apply(() => setBlockProp(block, 'indent', indent - 1));
          editor.requestCaret({blockId: id, offset: 0});
        } else {
          editor.mergeUp(id);
        }
      }
      return;
    }

    case 'deleteContentForward': {
      ev.preventDefault();
      if (sel.end > sel.start) {
        apply(() => deleteSelection(sel));
      } else if (sel.start < text.length) {
        const s = text.toString();
        const len = /[\uD800-\uDBFF]/.test(s[sel.start] ?? '') ? 2 : 1;
        apply(() => text.delete(sel.start, len));
      } else {
        // Forward-delete at the end pulls the next block up into this one.
        const next = nextSiblingTextId(editor, id);
        if (next) {
          const offset = text.length;
          editor.doc.transact(() => {
            const merged = mergeNext(editor, id, next);
            if (merged) editor.requestCaret({blockId: id, offset});
          }, 'local');
        }
      }
      editor.requestCaret({blockId: id, offset: sel.start});
      return;
    }

    case 'deleteWordBackward': {
      ev.preventDefault();
      const s = text.toString().slice(0, sel.start);
      const m = s.match(/(\s*\S+|\s+)$/);
      const len = sel.end > sel.start ? sel.end - sel.start : (m?.[0].length ?? sel.start);
      const from = sel.end > sel.start ? sel.start : sel.start - len;
      if (len > 0) {
        apply(() => text.delete(from, len));
        editor.requestCaret({blockId: id, offset: from});
      }
      return;
    }

    case 'insertFromPaste': {
      ev.preventDefault();
      const plain = ev.dataTransfer?.getData('text/plain') ?? '';
      if (!plain) return;
      const lines = plain.replace(/\r\n?/g, '\n').split('\n');
      apply(() => {
        deleteSelection(sel);
        insertPlain(sel.start, isCode ? plain : lines[0]);
      });
      if (isCode || lines.length === 1) {
        editor.requestCaret({blockId: id, offset: sel.start + (isCode ? plain.length : lines[0].length)});
        return;
      }
      // Multi-line paste: each subsequent line becomes a sibling paragraph.
      let after: string | null = id;
      for (const line of lines.slice(1)) {
        after = editor.insertAfter(after, {type: 'paragraph', text: line});
      }
      return;
    }

    case 'historyUndo':
      ev.preventDefault();
      editor.undo.undo();
      return;
    case 'historyRedo':
      ev.preventDefault();
      editor.undo.redo();
      return;

    default:
      // Unhandled input types (drops, exotic IME) — let them mutate the DOM,
      // then reconcile against the model like a composition.
      requestAnimationFrame(() => reconcileDom());
    }
  };
  beforeInputRef.current = onBeforeInput;

  /** Diff the DOM's text back into Y.Text (IME / unhandled input fallback). */
  const reconcileDom = (): void => {
    const el = ref.current;
    if (!el) return;
    const domText = el.innerText.replace(/\n$/, '');
    const change = diffText(text.toString(), domText);
    if (!change) return;
    apply(() => {
      if (change.deleteLen > 0) text.delete(change.start, change.deleteLen);
      if (change.insert) text.insert(change.start, change.insert, isCode ? {} : attrsAt(text, change.start));
    });
    editor.requestCaret({blockId: id, offset: change.start + change.insert.length});
  };

  // ── Keyboard (structure + formatting) ──────────────────────────────────────
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    const el = ref.current!;
    if (ui.slash.open && ui.slash.blockId === id) {
      if (['ArrowDown', 'ArrowUp', 'Enter', 'Escape', 'Tab'].includes(e.key)) {
        e.preventDefault();
        ui.slashKey(e.key);
        return;
      }
    }

    const mod = e.metaKey || e.ctrlKey;
    if (mod && !isCode) {
      const fmt: Record<string, 'b' | 'i' | 'u' | 's' | 'c'> = {b: 'b', i: 'i', u: 'u', e: 'c'};
      const key = e.key.toLowerCase();
      if (fmt[key] && !(e.shiftKey && key !== 's')) {
        e.preventDefault();
        ui.toggleFormat(fmt[key]);
        return;
      }
      if (e.shiftKey && key === 's') {
        e.preventDefault();
        ui.toggleFormat('s');
        return;
      }
    }
    if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) editor.undo.redo();
      else editor.undo.undo();
      return;
    }
    if (mod && e.key.toLowerCase() === 'd') {
      e.preventDefault();
      editor.setSelection([id]);
      editor.duplicateSelected();
      return;
    }

    if (e.key === 'Escape') {
      e.preventDefault();
      el.blur();
      editor.setSelection([id]);
      return;
    }

    if (e.key === 'Tab' && !isCode) {
      e.preventDefault();
      const indent = blockProp<number>(block, 'indent') ?? 0;
      const next = e.shiftKey ? Math.max(0, indent - 1) : Math.min(4, indent + 1);
      if (next !== indent) {
        apply(() => setBlockProp(block, 'indent', next === 0 ? undefined : next));
        const sel = readSelection(el);
        editor.requestCaret({blockId: id, offset: sel?.start ?? 0});
      }
      return;
    }
    if (e.key === 'Tab' && isCode) {
      e.preventDefault();
      const sel = readSelection(el) ?? {start: 0, end: 0};
      apply(() => {
        if (sel.end > sel.start) text.delete(sel.start, sel.end - sel.start);
        text.insert(sel.start, '  ', {});
      });
      editor.requestCaret({blockId: id, offset: sel.start + 2});
      return;
    }

    // Edge navigation between blocks.
    const sel = readSelection(el);
    if (!sel || sel.start !== sel.end) return;
    const atStart = sel.start === 0;
    const atEnd = sel.start === text.length;
    if ((e.key === 'ArrowUp' && isOnFirstLine(el)) || (e.key === 'ArrowLeft' && atStart)) {
      const prev = siblingTextId(editor, id, -1);
      if (prev) {
        e.preventDefault();
        editor.requestCaret({blockId: prev, offset: 'end'});
      }
      return;
    }
    if ((e.key === 'ArrowDown' && isOnLastLine(el)) || (e.key === 'ArrowRight' && atEnd)) {
      const next = siblingTextId(editor, id, 1);
      if (next) {
        e.preventDefault();
        editor.requestCaret({blockId: next, offset: 0});
      }
    }
  };

  const placeholder =
    type === 'heading' ? `Heading ${blockProp<number>(block, 'level') ?? 2}` : (PLACEHOLDERS[type] ?? '');

  return (
    <div
      ref={ref}
      contentEditable={!editor.readOnly}
      suppressContentEditableWarning
      role="textbox"
      aria-multiline="true"
      aria-label={ariaLabelFor(type)}
      data-block-text={id}
      data-placeholder={editor.focusedId === id && type === 'paragraph' ? 'Type “/” for commands…' : placeholder}
      className={`obe-text obe-text-${type}`}
      spellCheck={!isCode}
      onKeyDown={onKeyDown}
      onCompositionStart={() => {
        composing.current = true;
      }}
      onCompositionEnd={() => {
        composing.current = false;
        reconcileDom();
      }}
      onFocus={() => {
        editor.setFocusedId(id);
        editor.clearSelection();
      }}
      onBlur={() => {
        if (editor.focusedId === id) editor.setFocusedId(null);
        if (ui.slash.open && ui.slash.blockId === id) ui.closeSlash();
      }}
      onMouseUp={() => ui.scheduleToolbar()}
      onKeyUp={(e) => {
        if (e.shiftKey || ['Shift', 'Meta', 'Alt'].includes(e.key)) ui.scheduleToolbar();
      }}
    />
  );
};

function ariaLabelFor(type: BlockType): string {
  switch (type) {
  case 'heading':
    return 'Heading';
  case 'list':
    return 'List item';
  case 'todo':
    return 'To-do item';
  case 'quote':
    return 'Quote';
  case 'callout':
    return 'Callout';
  case 'code':
    return 'Code';
  case 'cell':
    return 'Table cell';
  default:
    return 'Text';
  }
}

/** Whether the caret's rect sits on the element's first/last rendered line. */
function isOnFirstLine(el: HTMLElement): boolean {
  const rect = caretRect();
  if (!rect) return true;
  const box = el.getBoundingClientRect();
  return rect.top - box.top < lineHeightOf(el) * 0.8;
}

function isOnLastLine(el: HTMLElement): boolean {
  const rect = caretRect();
  if (!rect) return true;
  const box = el.getBoundingClientRect();
  return box.bottom - rect.bottom < lineHeightOf(el) * 0.8;
}

function caretRect(): DOMRect | null {
  const sel = document.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0).cloneRange();
  range.collapse(true);
  const rects = range.getClientRects();
  if (rects.length > 0) return rects[0];
  // Empty line: fall back to the nearest element rect.
  const node = range.startContainer;
  return node instanceof HTMLElement ? node.getBoundingClientRect() : null;
}

function lineHeightOf(el: HTMLElement): number {
  const lh = parseFloat(getComputedStyle(el).lineHeight);
  return Number.isFinite(lh) ? lh : 24;
}

/** Next/previous text block id in document order. */
function siblingTextId(editor: BlockEditorController, id: string, dir: -1 | 1): string | null {
  const ids = editor.textBlockIds();
  const at = ids.indexOf(id);
  if (at < 0) return null;
  return ids[at + dir] ?? null;
}

function nextSiblingTextId(editor: BlockEditorController, id: string): string | null {
  return siblingTextId(editor, id, 1);
}

/** Pull `nextId`'s text into `id` (forward-delete join). */
function mergeNext(editor: BlockEditorController, id: string, nextId: string): boolean {
  const here = findBlock(editor.doc, id);
  const next = findBlock(editor.doc, nextId);
  if (!here || !next || here.parent !== next.parent || next.index !== here.index + 1) return false;
  const target = blockText(here.block);
  const source = blockText(next.block);
  if (!target || !source) return false;
  const delta = source.toDelta() as {insert: string; attributes?: Record<string, unknown>}[];
  let at = target.length;
  for (const op of delta) {
    target.insert(at, op.insert, (op.attributes ?? {}) as Record<string, unknown>);
    at += op.insert.length;
  }
  next.parent.delete(next.index, 1);
  return true;
}
