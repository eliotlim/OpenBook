import React, {useEffect, useLayoutEffect, useMemo, useRef, useState} from 'react';
import {FilePlus2, FileText} from 'lucide-react';
import {pageLinks, type PageLinkResult} from '@/lib/pageLinks';
import {t} from '../i18n';
import {blockText, findBlock} from './model';
import {observePopupPosition, selectionAnchorRect, type PopupPosition} from './popupPosition';
import type {SlashState} from './SlashMenu';
import type {BlockEditorController} from './useBlockEditor';

/**
 * The "[[" wikilink menu — a Notion-style alternative to the "@" mention. It
 * lists the same targets as {@link MentionMenu}'s Pages group (pages via
 * `pageLinks.searchPages` + database rows via `searchRows`) and inserts the pick
 * through the very same `insertMention` path, so a wikilink chip renders and
 * backlinks identically to an "@"-mention. What it adds is the auto-create edge:
 * when nothing matches the typed name it offers an explicit
 * "Create '<name>'" row that creates the page as a CHILD of the current page
 * (duplicate names are allowed — migration 0015) and links it.
 *
 * Trigger detection, query tracking and key forwarding mirror the mention menu;
 * the accept path differs only in stripping the two-char "[[" trigger (and any
 * typed closing "]]") from the literal text.
 */

/** A resolved page/row target, or the synthetic "create a new page" action. */
type WikiItem =
  | {kind: 'page'; id: string; label: string; page: PageLinkResult}
  | {kind: 'create'; id: 'create'; label: string; name: string};

/** The literal typed after "[[", with any trailing "]]" (a typed close) trimmed. */
const cleanQuery = (raw: string): string => raw.replace(/\]+$/, '');

export const WikilinkMenu: React.FC<{
  state: SlashState;
  editor: BlockEditorController;
  anchorEl: HTMLElement | null;
  /** The page hosting the editor — the parent for an auto-created page. */
  parentPageId?: string;
  onClose: () => void;
  /** Insert a page-link chip at the offset where "[[" was typed. */
  onMentionPage: (blockId: string, anchorOffset: number, page: PageLinkResult) => void;
  /** Create a page titled `name` as a child of `parentPageId`; resolves the id. */
  onCreatePage: (name: string) => Promise<PageLinkResult>;
}> = ({state, editor, anchorEl, parentPageId, onClose, onMentionPage, onCreatePage}) => {
  void parentPageId; // the parent is applied inside onCreatePage (provided by BlockEditor)
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<PopupPosition | null>(null);
  const [index, setIndex] = useState(0);
  const [rows, setRows] = useState<PageLinkResult[]>([]);
  const [rowsLoading, setRowsLoading] = useState(false);
  // Guards the async create so a double Enter (or Enter + a stray ]]) can't
  // spawn two pages / two chips for one accept.
  const creatingRef = useRef(false);

  const query = cleanQuery(state.query);

  useEffect(() => {
    let cancelled = false;
    setRowsLoading(true);
    void Promise.resolve(pageLinks.searchRows?.(query) ?? [])
      .then((res) => {
        if (!cancelled) setRows(res);
      })
      .finally(() => {
        if (!cancelled) setRowsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [query]);

  const items = useMemo<WikiItem[]>(() => {
    const q = query.trim();
    const ql = q.toLowerCase();
    const pages: WikiItem[] = pageLinks.searchPages(query).map((p) => ({kind: 'page', id: p.id, label: p.label, page: p}));
    const seen = new Set(pages.map((it) => (it.kind === 'page' ? it.page.id : '')));
    const rowItems: WikiItem[] = rows
      .filter((r) => !seen.has(r.id))
      .map((r) => ({kind: 'page', id: r.id, label: r.label, page: r}));
    const results = [...pages, ...rowItems];
    // The Create row is offered when the typed name matches no existing page
    // EXACTLY (a lookalike prefix still offers create — that's the whole point of
    // duplicate names). Suppressed for an empty query (nothing to name).
    // Placement: when there ARE matches, Create goes LAST so the highlight (index
    // 0) sits on the first real match and Enter links a near-match rather than
    // spawning a duplicate child. Only when there are NO matches does Create lead
    // and become the auto-selected row.
    const hasExact = results.some((it) => it.label.trim().toLowerCase() === ql);
    if (q !== '' && !hasExact) {
      const createItem: WikiItem = {kind: 'create', id: 'create', label: t('mention.create', {name: q}), name: q};
      return results.length > 0 ? [...results, createItem] : [createItem];
    }
    return results;
  }, [query, rows]);

  // Shared caret positioning mirrors the other trigger menus.
  useLayoutEffect(() => {
    return observePopupPosition({
      popup: () => ref.current,
      anchor: () => selectionAnchorRect(anchorEl, true),
      onPosition: setPos,
    });
  }, [anchorEl, state.anchorOffset, items.length]);

  useEffect(() => setIndex(0), [query]);

  // Keys forwarded from the focused text block (the caret stays in the doc).
  useEffect(() => {
    const ev = state.keyEvent;
    if (!ev) return;
    if (ev.key === 'ArrowDown') setIndex((i) => (i + 1) % Math.max(1, items.length));
    else if (ev.key === 'ArrowUp') setIndex((i) => (i - 1 + Math.max(1, items.length)) % Math.max(1, items.length));
    else if (ev.key === 'Enter' || ev.key === 'Tab') void pick(items[index]);
    else if (ev.key === 'Escape') onClose();
    // (deliberately keyed on the event counter alone, like MentionMenu)
  }, [state.keyEvent?.n]);

  // Close only once results have settled AND there's nothing to show — never
  // mid-search (a row-only match would otherwise flash closed). The Create row
  // keeps the menu open on any non-empty query, so this fires only for the empty
  // no-pages case.
  useEffect(() => {
    if (items.length === 0 && !rowsLoading) onClose();
  }, [items.length, rowsLoading, onClose]);

  const trigger = state.trigger ?? '[[';

  /** Strip the literal "[[query" (+ a typed closing "]]") the user typed. */
  const removeLiteral = (): void => {
    const found = findBlock(editor.doc, state.blockId);
    const text = found && blockText(found.block);
    if (!text) return;
    const at = state.anchorOffset;
    // state.query includes any leading close bracket typed so far; the accept
    // path prevented the final ']' from being inserted, so removing
    // trigger + query wipes the whole literal run.
    const len = trigger.length + state.query.length;
    editor.doc.transact(() => {
      if (text.toString().slice(at, at + trigger.length) === trigger) {
        text.delete(at, Math.min(len, text.length - at));
      }
    }, 'local');
  };

  const pick = async (item: WikiItem | undefined): Promise<void> => {
    if (!item) return;
    // Start a fresh undo item so replacing the "[[query" literal with the chip
    // is one undo step: a single undo restores the literal typed text (the
    // typing before it is a separate, earlier step).
    editor.undo.stopCapturing();
    if (item.kind === 'page') {
      removeLiteral();
      onClose();
      onMentionPage(state.blockId, state.anchorOffset, item.page);
      return;
    }
    // Create path — async page creation, guarded against a double-accept.
    if (creatingRef.current) return;
    creatingRef.current = true;
    try {
      const page = await onCreatePage(item.name);
      editor.undo.stopCapturing(); // the await may have crossed the capture window
      removeLiteral();
      onClose();
      onMentionPage(state.blockId, state.anchorOffset, page);
    } catch {
      creatingRef.current = false;
      onClose();
    }
  };

  return (
    <div
      ref={ref}
      className="obe-slash"
      data-placement={pos?.placement}
      style={pos ? {left: pos.left, top: pos.top, maxHeight: pos.maxHeight} : {left: 0, top: 0, visibility: 'hidden'}}
      role="listbox"
      aria-label={t('mention.label')}
    >
      <div className="obe-slash-group" role="presentation">
        {t('mention.label')}
      </div>
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
            void pick(item);
          }}
        >
          {item.kind === 'create' ? (
            <FilePlus2 className="obe-slash-icon" />
          ) : (
            <FileText className="obe-slash-icon" />
          )}
          <span className="obe-slash-label">{item.label}</span>
        </button>
      ))}
    </div>
  );
};
