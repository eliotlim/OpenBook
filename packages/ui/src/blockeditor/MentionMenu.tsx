import React, {useEffect, useLayoutEffect, useMemo, useRef, useState} from 'react';
import {CalendarDays, FileText, User} from 'lucide-react';
import {pageLinks, type PageLinkResult} from '@/lib/pageLinks';
import {blockText, findBlock} from './model';
import {observePopupPosition, selectionAnchorRect, type PopupPosition} from './popupPosition';
import type {SlashState} from './SlashMenu';
import type {BlockEditorController} from './useBlockEditor';

type IconComp = React.ComponentType<{className?: string}>;

/**
 * The "@" mention menu: like the slash menu but for references — pages (live
 * chips), relative dates (@Today / @Tomorrow / @Yesterday), and the current
 * person. Trigger detection, query tracking and key forwarding mirror the slash
 * menu; this only differs in its items and how a pick is inserted.
 */

type MentionGroup = 'pages' | 'dates' | 'people';
const GROUP_ORDER: MentionGroup[] = ['pages', 'dates', 'people'];
const GROUP_LABEL: Record<MentionGroup, string> = {pages: 'Pages', dates: 'Dates', people: 'People'};

interface MentionItem {
  id: string;
  label: string;
  group: MentionGroup;
  icon: IconComp;
  /** A page to mention (inserts a live chip), or… */
  page?: PageLinkResult;
  /** …plain text to insert (dates, person names). */
  text?: string;
}

const fmtDate = (d: Date): string =>
  d.toLocaleDateString(undefined, {weekday: 'short', month: 'short', day: 'numeric', year: 'numeric'});

/** Identity read bare from persisted preferences (no provider dependency). */
function readIdentity(): string {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem('openbook.preferences') : null;
    const profile = raw ? (JSON.parse(raw) as {profile?: {displayName?: string; name?: string}}).profile : null;
    return (profile?.displayName?.trim() || profile?.name?.trim() || '').trim();
  } catch {
    return '';
  }
}

function dateItems(): MentionItem[] {
  const day = (offset: number): Date => {
    const d = new Date();
    d.setDate(d.getDate() + offset);
    return d;
  };
  return [
    {id: 'today', label: 'Today', group: 'dates', icon: CalendarDays, text: fmtDate(day(0))},
    {id: 'tomorrow', label: 'Tomorrow', group: 'dates', icon: CalendarDays, text: fmtDate(day(1))},
    {id: 'yesterday', label: 'Yesterday', group: 'dates', icon: CalendarDays, text: fmtDate(day(-1))},
  ];
}

export const MentionMenu: React.FC<{
  state: SlashState;
  editor: BlockEditorController;
  anchorEl: HTMLElement | null;
  onClose: () => void;
  /** Insert a page mention chip at the offset where "@" was typed. */
  onMentionPage: (blockId: string, anchorOffset: number, page: PageLinkResult) => void;
  /** Insert plain text (a date or a person name) at that offset. */
  onInsertText: (blockId: string, anchorOffset: number, text: string) => void;
}> = ({state, editor, anchorEl, onClose, onMentionPage, onInsertText}) => {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<PopupPosition | null>(null);
  const [index, setIndex] = useState(0);
  // Database rows matching the query (fetched async — rows are pages too, so a
  // mention can link one, mirroring backlinks). Merged into the "pages" group.
  const [rows, setRows] = useState<PageLinkResult[]>([]);
  // While a row search is in flight, don't dismiss an otherwise-empty menu — a
  // row-only match would otherwise close before its async results land.
  const [rowsLoading, setRowsLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setRowsLoading(true);
    void Promise.resolve(pageLinks.searchRows?.(state.query) ?? [])
      .then((res) => {
        if (!cancelled) setRows(res);
      })
      .finally(() => {
        if (!cancelled) setRowsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [state.query]);

  const items = useMemo(() => {
    const q = state.query.trim().toLowerCase();
    const pages: MentionItem[] = pageLinks.searchPages(state.query).map((p) => ({
      id: `page-${p.id}`,
      label: p.label,
      group: 'pages',
      icon: FileText,
      page: p,
    }));
    // Rows join the pages group; drop any already surfaced as a page.
    const seen = new Set(pages.map((it) => it.page!.id));
    const rowItems: MentionItem[] = rows
      .filter((r) => !seen.has(r.id))
      .map((r) => ({id: `row-${r.id}`, label: r.label, group: 'pages', icon: FileText, page: r}));
    const dates = dateItems();
    const identity = readIdentity();
    const people: MentionItem[] = identity
      ? [{id: 'me', label: identity, group: 'people', icon: User, text: identity}]
      : [];
    const match = (it: MentionItem): boolean => !q || it.label.toLowerCase().includes(q);
    return [...pages, ...rowItems, ...dates.filter(match), ...people.filter(match)].sort(
      (a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group),
    );
  }, [state.query, rows]);

  // Shared caret positioning measures, flips, clamps, retries late anchors,
  // and re-clamps when the viewport changes.
  useLayoutEffect(() => {
    return observePopupPosition({
      popup: () => ref.current,
      anchor: () => selectionAnchorRect(anchorEl, true),
      onPosition: setPos,
    });
  }, [anchorEl, state.anchorOffset, items.length]);

  useEffect(() => setIndex(0), [state.query]);

  // Keys forwarded from the focused text block (the caret stays in the doc).
  useEffect(() => {
    const ev = state.keyEvent;
    if (!ev) return;
    if (ev.key === 'ArrowDown') setIndex((i) => (i + 1) % Math.max(1, items.length));
    else if (ev.key === 'ArrowUp') setIndex((i) => (i - 1 + Math.max(1, items.length)) % Math.max(1, items.length));
    else if (ev.key === 'Enter' || ev.key === 'Tab') pick(items[index]);
    else if (ev.key === 'Escape') onClose();
    // (deliberately keyed on the event counter alone, like SlashMenu)
  }, [state.keyEvent?.n]);

  useEffect(() => {
    if (items.length === 0 && !rowsLoading) onClose();
  }, [items.length, rowsLoading, onClose]);

  const pick = (item: MentionItem | undefined): void => {
    if (!item) return;
    const found = findBlock(editor.doc, state.blockId);
    const text = found && blockText(found.block);
    if (text) {
      // Remove the typed "@query".
      const len = 1 + state.query.length;
      editor.doc.transact(() => {
        if (text.toString().slice(state.anchorOffset, state.anchorOffset + 1) === '@') {
          text.delete(state.anchorOffset, Math.min(len, text.length - state.anchorOffset));
        }
      }, 'local');
    }
    onClose();
    if (item.page) onMentionPage(state.blockId, state.anchorOffset, item.page);
    else if (item.text) onInsertText(state.blockId, state.anchorOffset, item.text);
  };

  return (
    <div
      ref={ref}
      className="obe-slash"
      data-placement={pos?.placement}
      style={pos ? {left: pos.left, top: pos.top, maxHeight: pos.maxHeight} : {left: 0, top: 0, visibility: 'hidden'}}
      role="listbox"
      aria-label="Insert a mention"
    >
      {items.map((item, i) => {
        const newGroup = item.group !== items[i - 1]?.group;
        return (
          <React.Fragment key={item.id}>
            {newGroup && (
              <div className="obe-slash-group" role="presentation">
                {GROUP_LABEL[item.group]}
              </div>
            )}
            <button
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
              <item.icon className="obe-slash-icon" />
              <span className="obe-slash-label">{item.label}</span>
            </button>
          </React.Fragment>
        );
      })}
    </div>
  );
};
