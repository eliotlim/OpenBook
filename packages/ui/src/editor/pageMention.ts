/**
 * `@`-to-link page mentions for the EditorJS document.
 *
 * `MentionController` attaches to an editor holder, watches for an `@` typed at
 * a word boundary, and exposes a small subscribable state that a React popover
 * ({@link components/MentionPopover}) renders — a page search plus a
 * "create page" option. Picking one replaces the `@query` text with an atomic
 * inline anchor (`<a class="ob-mention" data-page-id contenteditable="false">`),
 * which survives EditorJS's save sanitization thanks to {@link PageLinkInlineTool}.
 *
 * One controller per `PageDocument` (the split pane mounts two editors).
 */
import {pageLinks, type PageLinkResult} from '@/lib/pageLinks';
import {readPageIcon} from '@/lib/pageIcon';

export interface MentionState {
  open: boolean;
  query: string;
  /** Viewport coords (left, below the caret) for the popover. */
  position: {left: number; top: number} | null;
  results: PageLinkResult[];
  /** When set, offer "Create page '<createName>'" as the last row. */
  createName: string | null;
  /** Highlighted row index across results + the optional create row. */
  activeIndex: number;
}

const CLOSED: MentionState = {
  open: false,
  query: '',
  position: null,
  results: [],
  createName: null,
  activeIndex: 0,
};

/** Max characters after `@` before we give up treating it as a query. */
const MAX_QUERY = 60;

/**
 * Pure: given a text node's content and the caret offset within it, find an
 * active `@query` ending at the caret — the `@` must start the word (preceded by
 * whitespace or the start) and the query must hold no `@`/newline and stay under
 * {@link MAX_QUERY}. Returns the `@` offset and the query, or `null`. Extracted
 * from the DOM glue so it can be unit-tested.
 */
export function findMentionQuery(text: string, caret: number): {atOffset: number; query: string} | null {
  for (let i = caret - 1; i >= 0 && caret - i <= MAX_QUERY + 1; i -= 1) {
    const ch = text[i];
    if (ch === '\n') return null;
    if (ch === '@') {
      const before = i === 0 ? ' ' : text[i - 1];
      // `\s` already covers the non-breaking spaces contenteditable inserts.
      if (!/\s/.test(before) && i !== 0) return null; // mid-word @ (e.g. email)
      const query = text.slice(i + 1, caret);
      return query.includes('@') ? null : {atOffset: i, query};
    }
  }
  return null;
}

export class MentionController {
  private holder: HTMLElement | null = null;
  private state: MentionState = CLOSED;
  private readonly listeners = new Set<() => void>();
  /** The text node + offset of the `@` that opened the current session. */
  private anchor: {node: Text; offset: number} | null = null;
  /** An explicit range to replace (the inline-toolbar "link selection" path). */
  private surroundRange: Range | null = null;

  // ── External store (for useSyncExternalStore) ──────────────────────────────
  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  };
  getState = (): MentionState => this.state;

  private set(next: Partial<MentionState>): void {
    this.state = {...this.state, ...next};
    this.listeners.forEach((cb) => cb());
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────
  attach(holder: HTMLElement): void {
    this.holder = holder;
    // Capture phase so we intercept Enter/Arrows before EditorJS acts on them.
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
    this.surroundRange = null;
    if (this.state.open) this.set(CLOSED);
  };

  // ── `@` detection ───────────────────────────────────────────────────────────
  private onInput = (): void => this.refresh();
  private onSelectionChange = (): void => {
    // Only react to caret moves while a session is open (cheap otherwise).
    if (this.state.open) this.refresh();
  };

  /** Recompute the mention session from the current caret, or close it. */
  private refresh(): void {
    if (this.surroundRange) return; // toolbar-driven session: don't re-derive from caret
    const ctx = this.readContext();
    if (!ctx) {
      this.close();
      return;
    }
    this.anchor = {node: ctx.node, offset: ctx.atOffset};
    this.openWith(ctx.query, this.caretRange(ctx.node, ctx.atOffset));
  }

  /** Find an active `@query` immediately before the collapsed caret. */
  private readContext(): {node: Text; atOffset: number; query: string} | null {
    const sel = document.getSelection();
    if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return null;
    const node = sel.anchorNode;
    if (!node || node.nodeType !== Node.TEXT_NODE || !this.holder?.contains(node)) return null;
    const found = findMentionQuery(node.textContent ?? '', sel.anchorOffset);
    return found ? {node: node as Text, ...found} : null;
  }

  private openWith(query: string, rect: DOMRect | null): void {
    const results = pageLinks.searchPages(query);
    const trimmed = query.trim();
    const exact = results.some((r) => r.label.toLowerCase() === trimmed.toLowerCase());
    this.set({
      open: true,
      query,
      results,
      createName: trimmed && !exact ? trimmed : null,
      position: rect ? {left: rect.left, top: rect.bottom} : this.state.position,
      activeIndex: 0,
    });
  }

  /** A non-empty rect for the `@…caret` span (a collapsed caret has no rect). */
  private caretRange(node: Text, atOffset: number): DOMRect | null {
    try {
      const sel = document.getSelection();
      const end = sel && sel.isCollapsed ? sel.anchorOffset : (node.textContent ?? '').length;
      const range = document.createRange();
      range.setStart(node, atOffset);
      range.setEnd(node, Math.max(end, atOffset + 1 <= (node.textContent ?? '').length ? atOffset + 1 : atOffset));
      const rect = range.getBoundingClientRect();
      return rect.width === 0 && rect.height === 0 ? null : rect;
    } catch {
      return null;
    }
  }

  // ── Keyboard ─────────────────────────────────────────────────────────────────
  private onKeyDown = (e: KeyboardEvent): void => {
    if (!this.state.open) return;
    const total = this.itemCount();
    switch (e.key) {
    case 'ArrowDown':
      e.preventDefault();
      e.stopPropagation();
      if (total) this.set({activeIndex: (this.state.activeIndex + 1) % total});
      break;
    case 'ArrowUp':
      e.preventDefault();
      e.stopPropagation();
      if (total) this.set({activeIndex: (this.state.activeIndex - 1 + total) % total});
      break;
    case 'Enter':
      if (total) {
        e.preventDefault();
        e.stopPropagation();
        void this.pick(this.state.activeIndex);
      }
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

  private itemCount(): number {
    return this.state.results.length + (this.state.createName ? 1 : 0);
  }

  // ── Insertion ────────────────────────────────────────────────────────────────
  /** Pick a row (existing result, or the trailing create row). */
  pick = async (index: number): Promise<void> => {
    const {results, createName} = this.state;
    // Capture the range to replace *before* any async work moves the caret.
    const range = this.replacementRange();
    this.close();
    if (!range) return;
    try {
      if (index < results.length) {
        const r = results[index];
        this.insert(range, r.id, r.icon, r.label);
      } else if (createName) {
        const id = await pageLinks.createPage(createName);
        this.insert(range, id, readPageIcon(id), createName);
      }
    } catch (err) {
      console.error('pageMention: insert failed:', err);
    }
  };

  /** Open the menu to link the current selection (inline-toolbar path). */
  openForSelection(range: Range): void {
    if (!this.holder || range.collapsed) return;
    this.surroundRange = range.cloneRange();
    const rect = range.getBoundingClientRect();
    this.openWith(range.toString().trim(), rect);
  }

  /** The range the pick should replace: the `@query`, or the toolbar selection. */
  private replacementRange(): Range | null {
    if (this.surroundRange) return this.surroundRange.cloneRange();
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

  private insert(range: Range, pageId: string, icon: string, label: string): void {
    const holder = this.holder;
    if (!holder) return;
    range.deleteContents();
    const a = document.createElement('a');
    a.className = 'ob-mention';
    a.setAttribute('data-page-id', pageId);
    a.setAttribute('contenteditable', 'false');
    a.setAttribute('href', '#');
    a.textContent = `${icon} ${label}`;
    range.insertNode(a);
    // A trailing space so the caret has somewhere to land after the atomic link.
    const space = document.createTextNode(' ');
    a.after(space);
    const after = document.createRange();
    after.setStartAfter(space);
    after.collapse(true);
    const sel = document.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(after);
    // Tell EditorJS (and PageDocument's edit gate) a real edit happened.
    holder.dispatchEvent(new Event('input', {bubbles: true}));
  }
}

// ── EditorJS inline tool (sanitize + "link selection" affordance) ──────────────

interface InlineToolConfig {
  controller?: MentionController;
}

/**
 * Registered as an inline tool purely so its `sanitize` rule preserves the
 * mention anchor (class + `data-page-id` + `contenteditable`) when EditorJS
 * saves a block. Its toolbar button links the current selection to a page.
 */
export class PageLinkInlineTool {
  static get isInline(): boolean {
    return true;
  }
  static get title(): string {
    return 'Link to page';
  }
  static get sanitize(): {a: {class: boolean; href: boolean; contenteditable: boolean; 'data-page-id': boolean}} {
    return {a: {class: true, href: true, contenteditable: true, 'data-page-id': true}};
  }

  private readonly controller?: MentionController;
  private range: Range | null = null;

  constructor({config}: {config?: InlineToolConfig}) {
    this.controller = config?.controller;
  }

  render(): HTMLElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.classList.add('ce-inline-tool');
    button.innerHTML =
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>';
    return button;
  }

  surround(range: Range): void {
    if (range) this.range = range.cloneRange();
    if (this.range) this.controller?.openForSelection(this.range);
  }

  checkState(): boolean {
    return false;
  }
}
