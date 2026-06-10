import type * as Y from 'yjs';
import type {InlineAttrs} from './model';

/**
 * The DOM half of text editing: rendering Y.Text runs into a contenteditable
 * element, and mapping carets between DOM positions and linear offsets.
 *
 * The contract that keeps everything simple: the rendered DOM's
 * `textContent` is exactly the Y.Text string (no decoration characters), so
 * a caret is always "the number of characters before it".
 */

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Render Y.Text (or a delta) to the innerHTML of a text block. */
export function runsToHtml(text: Y.Text): string {
  const delta = text.toDelta() as {insert: string; attributes?: InlineAttrs}[];
  if (delta.length === 0) return '';
  let html = '';
  for (const op of delta) {
    let piece = escapeHtml(op.insert).replace(/\n/g, '<br>');
    const a = op.attributes ?? {};
    if (a.c) piece = `<code class="obe-code">${piece}</code>`;
    if (a.b) piece = `<strong>${piece}</strong>`;
    if (a.i) piece = `<em>${piece}</em>`;
    if (a.u) piece = `<u>${piece}</u>`;
    if (a.s) piece = `<s>${piece}</s>`;
    if (a.m) piece = `<a class="obe-mention" data-page-id="${escapeHtml(a.m)}" contenteditable="false">${piece}</a>`;
    else if (a.a) piece = `<a class="obe-link" href="${escapeHtml(a.a)}" target="_blank" rel="noreferrer">${piece}</a>`;
    html += piece;
  }
  return html;
}

/** The linear caret offset of (node, nodeOffset) within `root`, or null. */
export function domToOffset(root: HTMLElement, node: Node, nodeOffset: number): number | null {
  if (!root.contains(node)) return null;
  let offset = 0;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, null);
  let current: Node | null = walker.currentNode;
  // When the position is an element boundary, count characters of children
  // before `nodeOffset` instead.
  if (node.nodeType === Node.ELEMENT_NODE) {
    let count = 0;
    const el = node as HTMLElement;
    for (let i = 0; i < Math.min(nodeOffset, el.childNodes.length); i += 1) {
      count += textLengthOf(el.childNodes[i]);
    }
    const before = offsetOfNode(root, node);
    return before === null ? null : before + count;
  }
  while (current) {
    if (current === node) return offset + nodeOffset;
    if (current.nodeType === Node.TEXT_NODE) offset += (current.textContent ?? '').length;
    else if (current.nodeName === 'BR') offset += 1;
    current = walker.nextNode();
  }
  return null;
}

function textLengthOf(node: Node): number {
  if (node.nodeType === Node.TEXT_NODE) return (node.textContent ?? '').length;
  if (node.nodeName === 'BR') return 1;
  let n = 0;
  node.childNodes.forEach((c) => {
    n += textLengthOf(c);
  });
  return n;
}

function offsetOfNode(root: HTMLElement, target: Node): number | null {
  let offset = 0;
  const walk = (node: Node): boolean => {
    if (node === target) return true;
    if (node.nodeType === Node.TEXT_NODE) {
      offset += (node.textContent ?? '').length;
      return false;
    }
    if (node.nodeName === 'BR') {
      offset += 1;
      return false;
    }
    for (const child of Array.from(node.childNodes)) {
      if (walk(child)) return true;
    }
    return false;
  };
  return walk(root) ? offset : null;
}

/** Resolve a linear offset to a (node, offset) DOM position inside `root`. */
export function offsetToDom(root: HTMLElement, offset: number): {node: Node; offset: number} {
  let remaining = Math.max(0, offset);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, null);
  let node: Node | null = walker.nextNode();
  let last: {node: Node; offset: number} = {node: root, offset: 0};
  while (node) {
    if (node.nodeType === Node.TEXT_NODE) {
      const len = (node.textContent ?? '').length;
      if (remaining <= len) return {node, offset: remaining};
      remaining -= len;
      last = {node, offset: len};
    } else if (node.nodeName === 'BR') {
      if (remaining === 0) {
        const parent = node.parentNode!;
        return {node: parent, offset: Array.from(parent.childNodes).indexOf(node as ChildNode)};
      }
      remaining -= 1;
      const parent = node.parentNode!;
      last = {node: parent, offset: Array.from(parent.childNodes).indexOf(node as ChildNode) + 1};
    }
    node = walker.nextNode();
  }
  return last;
}

/** The current selection within `root` as linear offsets, or null. */
export function readSelection(root: HTMLElement): {start: number; end: number} | null {
  const sel = document.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  const start = domToOffset(root, range.startContainer, range.startOffset);
  const end = range.collapsed ? start : domToOffset(root, range.endContainer, range.endOffset);
  if (start === null || end === null) return null;
  return start <= end ? {start, end} : {start: end, end: start};
}

/** Place the caret (or a range) at linear offsets inside `root`. */
export function writeSelection(root: HTMLElement, start: number, end = start): void {
  const sel = document.getSelection();
  if (!sel) return;
  const from = offsetToDom(root, start);
  const to = end === start ? from : offsetToDom(root, end);
  const range = document.createRange();
  range.setStart(from.node, from.offset);
  range.setEnd(to.node, to.offset);
  sel.removeAllRanges();
  sel.addRange(range);
}

/**
 * Diff two strings into one splice (used after IME composition, where we let
 * the browser mutate the DOM and reconcile afterwards). Returns the region
 * [start, delEnd) of `before` replaced by `insert` from `after`.
 */
export function diffText(before: string, after: string): {start: number; deleteLen: number; insert: string} | null {
  if (before === after) return null;
  let start = 0;
  const maxStart = Math.min(before.length, after.length);
  while (start < maxStart && before[start] === after[start]) start += 1;
  let endB = before.length;
  let endA = after.length;
  while (endB > start && endA > start && before[endB - 1] === after[endA - 1]) {
    endB -= 1;
    endA -= 1;
  }
  return {start, deleteLen: endB - start, insert: after.slice(start, endA)};
}

/** The inline attributes at `offset` (the formatting typing would continue). */
export function attrsAt(text: Y.Text, offset: number): InlineAttrs {
  const delta = text.toDelta() as {insert: string; attributes?: InlineAttrs}[];
  let seen = 0;
  for (const op of delta) {
    const end = seen + op.insert.length;
    if (offset <= end && offset > seen) return {...(op.attributes ?? {})};
    seen = end;
  }
  return {};
}

/** Whether the whole [start,end) range carries attribute `key`. */
export function rangeHasAttr(text: Y.Text, start: number, end: number, key: keyof InlineAttrs): boolean {
  if (end <= start) return Boolean(attrsAt(text, start)[key]);
  const delta = text.toDelta() as {insert: string; attributes?: InlineAttrs}[];
  let seen = 0;
  for (const op of delta) {
    const opStart = seen;
    const opEnd = seen + op.insert.length;
    if (opEnd > start && opStart < end) {
      if (!op.attributes?.[key]) return false;
    }
    seen = opEnd;
  }
  return true;
}
