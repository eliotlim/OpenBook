/**
 * `:`-to-emoji inline picker for the EditorJS document — the `:shortcode:` flow.
 *
 * `EmojiSuggestController` attaches to an editor holder, watches for a `:` typed
 * at a word boundary followed by a shortcode (`:hea…`), and exposes a small
 * subscribable state that a React popover ({@link components/EmojiSuggestPopover})
 * renders. Picking one replaces the `:query` text with the plain unicode emoji.
 *
 * Modeled on {@link editor/pageMention.MentionController}; one per `PageDocument`.
 */
import {searchEmojis, type EmojiMatch} from '@/lib/emoji';

export interface EmojiSuggestState {
  open: boolean;
  query: string;
  /** Viewport coords (left, below the caret) for the popover. */
  position: {left: number; top: number} | null;
  results: EmojiMatch[];
  /** Highlighted row index. */
  activeIndex: number;
}

const CLOSED: EmojiSuggestState = {open: false, query: '', position: null, results: [], activeIndex: 0};

/** Max characters after `:` before we give up treating it as a shortcode. */
const MAX_QUERY = 40;

/**
 * Pure: find an active `:query` ending at the caret — the `:` must start the
 * "word" (preceded by whitespace or the start) and everything between it and the
 * caret must be a shortcode char (`[\w+-]`). Returns the `:` offset and query, or
 * `null` (so `10:30`, `http://`, `a:b` never trigger). Extracted for unit tests.
 */
export function findEmojiQuery(text: string, caret: number): {colonOffset: number; query: string} | null {
  for (let i = caret - 1; i >= 0 && caret - i <= MAX_QUERY + 1; i -= 1) {
    const ch = text[i];
    if (ch === ':') {
      const before = i === 0 ? ' ' : text[i - 1];
      if (i !== 0 && !/\s/.test(before)) return null; // mid-word colon (time, url, ratio)
      return {colonOffset: i, query: text.slice(i + 1, caret)};
    }
    if (!/[\w+-]/.test(ch)) return null; // a non-shortcode char before the colon
  }
  return null;
}

export class EmojiSuggestController {
  private holder: HTMLElement | null = null;
  private state: EmojiSuggestState = CLOSED;
  private readonly listeners = new Set<() => void>();
  /** The text node + offset of the `:` that opened the current session. */
  private anchor: {node: Text; offset: number} | null = null;

  // ── External store (for useSyncExternalStore) ──────────────────────────────
  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  };
  getState = (): EmojiSuggestState => this.state;

  private set(next: Partial<EmojiSuggestState>): void {
    this.state = {...this.state, ...next};
    this.listeners.forEach((cb) => cb());
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────
  attach(holder: HTMLElement): void {
    this.holder = holder;
    holder.addEventListener('keydown', this.onKeyDown, true);
    holder.addEventListener('input', this.onInput);
    document.addEventListener('selectionchange', this.onSelectionChange);
  }

  detach(): void {
    const h = this.holder;
    h?.removeEventListener('keydown', this.onKeyDown, true);
    h?.removeEventListener('input', this.onInput);
    document.removeEventListener('selectionchange', this.onSelectionChange);
    this.holder = null;
    this.close();
  }

  close = (): void => {
    this.anchor = null;
    if (this.state.open) this.set(CLOSED);
  };

  // ── `:` detection ────────────────────────────────────────────────────────────
  private onInput = (): void => this.refresh();
  private onSelectionChange = (): void => {
    if (this.state.open) this.refresh();
  };

  private refresh(): void {
    const ctx = this.readContext();
    if (!ctx) {
      this.close();
      return;
    }
    this.anchor = {node: ctx.node, offset: ctx.colonOffset};
    const results = searchEmojis(ctx.query);
    this.set({
      open: results.length > 0,
      query: ctx.query,
      results,
      position: this.caretRect(ctx.node, ctx.colonOffset),
      activeIndex: 0,
    });
  }

  private readContext(): {node: Text; colonOffset: number; query: string} | null {
    const sel = document.getSelection();
    if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return null;
    const node = sel.anchorNode;
    if (!node || node.nodeType !== Node.TEXT_NODE || !this.holder?.contains(node)) return null;
    const found = findEmojiQuery(node.textContent ?? '', sel.anchorOffset);
    return found ? {node: node as Text, ...found} : null;
  }

  private caretRect(node: Text, colonOffset: number): {left: number; top: number} | null {
    try {
      const sel = document.getSelection();
      const end = sel && sel.isCollapsed ? sel.anchorOffset : (node.textContent ?? '').length;
      const range = document.createRange();
      range.setStart(node, colonOffset);
      range.setEnd(node, Math.max(end, colonOffset));
      const rect = range.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return this.state.position;
      return {left: rect.left, top: rect.bottom};
    } catch {
      return this.state.position;
    }
  }

  // ── Keyboard ─────────────────────────────────────────────────────────────────
  private onKeyDown = (e: KeyboardEvent): void => {
    if (!this.state.open || this.state.results.length === 0) return;
    const total = this.state.results.length;
    switch (e.key) {
    case 'ArrowDown':
      e.preventDefault();
      e.stopPropagation();
      this.set({activeIndex: (this.state.activeIndex + 1) % total});
      break;
    case 'ArrowUp':
      e.preventDefault();
      e.stopPropagation();
      this.set({activeIndex: (this.state.activeIndex - 1 + total) % total});
      break;
    case 'Enter':
    case 'Tab':
      e.preventDefault();
      e.stopPropagation();
      this.pick(this.state.activeIndex);
      break;
    case 'Escape':
      e.preventDefault();
      e.stopPropagation();
      this.close();
      break;
    default:
      break;
    }
  };

  setActiveIndex = (i: number): void => {
    if (this.state.open) this.set({activeIndex: i});
  };

  // ── Insertion ────────────────────────────────────────────────────────────────
  pick = (index: number): void => {
    const match = this.state.results[index];
    const range = this.replacementRange();
    this.close();
    if (!match || !range || !this.holder) return;
    range.deleteContents();
    const text = document.createTextNode(match.emoji);
    range.insertNode(text);
    const after = document.createRange();
    after.setStartAfter(text);
    after.collapse(true);
    const sel = document.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(after);
    // Tell EditorJS (and PageDocument's edit gate) a real edit happened.
    this.holder.dispatchEvent(new Event('input', {bubbles: true}));
  };

  /** The range from the `:` to the current caret. */
  private replacementRange(): Range | null {
    const sel = document.getSelection();
    if (!this.anchor || !sel || sel.rangeCount === 0) return null;
    const range = document.createRange();
    range.setStart(this.anchor.node, this.anchor.offset);
    try {
      range.setEnd(sel.anchorNode!, sel.anchorOffset);
    } catch {
      return null;
    }
    return range;
  }
}
