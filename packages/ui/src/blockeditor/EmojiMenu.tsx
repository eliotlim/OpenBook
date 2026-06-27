import React, {useEffect, useLayoutEffect, useMemo, useRef, useState} from 'react';
import {searchEmojis, type EmojiMatch} from '@/lib/emoji';
import {useTranslation} from '@/providers';
import {blockText, findBlock} from './model';
import type {SlashState} from './SlashMenu';
import type {BlockEditorController} from './useBlockEditor';

/**
 * The ":" emoji menu: like the slash and mention menus but for emoji. Trigger
 * detection, query tracking and key forwarding mirror those menus; this only
 * differs in its items (offline `searchEmojis`) and how a pick is inserted —
 * the typed ":query" is removed and the chosen glyph dropped in its place.
 */

export const EmojiMenu: React.FC<{
  state: SlashState;
  editor: BlockEditorController;
  anchorEl: HTMLElement | null;
  onClose: () => void;
  /** Insert the chosen glyph (plain text) at the offset where ":" was typed. */
  onInsertText: (blockId: string, anchorOffset: number, text: string) => void;
}> = ({state, editor, anchorEl, onClose, onInsertText}) => {
  const {t} = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{left: number; top: number; maxHeight: number} | null>(null);
  const [index, setIndex] = useState(0);

  const items = useMemo<EmojiMatch[]>(() => searchEmojis(state.query), [state.query]);

  // Caret-anchored fixed positioning (mirrors MentionMenu): measure after
  // render, flip above the line when there's no room below, clamp to viewport.
  useLayoutEffect(() => {
    let raf = 0;
    let attempts = 0;
    const isZero = (r: DOMRect | undefined | null): boolean => !r || (r.width === 0 && r.height === 0 && r.x === 0 && r.y === 0);
    const measure = (): void => {
      const sel = document.getSelection();
      const caretRect =
        sel && sel.rangeCount > 0 && anchorEl?.contains(sel.anchorNode) ? sel.getRangeAt(0).getBoundingClientRect() : null;
      const rect = !isZero(caretRect) ? caretRect! : anchorEl?.getBoundingClientRect();
      if (isZero(rect)) {
        if (attempts++ < 20) raf = requestAnimationFrame(measure);
        return;
      }
      const menu = ref.current;
      const menuH = menu?.offsetHeight ?? 280;
      const menuW = menu?.offsetWidth ?? 260;
      const below = window.innerHeight - rect!.bottom - 14;
      const above = rect!.top - 14;
      const flip = menuH > below && above > below;
      const maxHeight = Math.max(120, Math.min(300, flip ? above : below));
      const shownH = Math.min(menuH, maxHeight);
      const top = flip ? Math.max(8, rect!.top - 6 - shownH) : rect!.bottom + 6;
      const left = Math.max(8, Math.min(rect!.left, window.innerWidth - menuW - 8));
      setPos({left, top, maxHeight});
    };
    measure();
    return () => cancelAnimationFrame(raf);
  }, [anchorEl, state.anchorOffset, items.length]);

  useEffect(() => setIndex(0), [state.query]);

  // Keys forwarded from the focused text block (the caret stays in the doc).
  useEffect(() => {
    const ev = state.keyEvent;
    if (!ev) return;
    if (ev.key === 'ArrowDown') setIndex((i) => (i + 1) % Math.max(1, items.length));
    else if (ev.key === 'ArrowUp') setIndex((i) => (i - 1 + Math.max(1, items.length)) % Math.max(1, items.length));
    else if (ev.key === 'Enter' || ev.key === 'Tab') pick(items[index]);
    // The closing ':' of ":smile:" commits the TOP match (GitHub/Slack/Discord
    // muscle memory) regardless of any arrow navigation — forwarded by the text
    // block when a ':' is typed while this menu is open on a matching query.
    else if (ev.key === ':') pick(items[0]);
    else if (ev.key === 'Escape') onClose();
    // (deliberately keyed on the event counter alone, like SlashMenu)
  }, [state.keyEvent?.n]);

  // A non-empty query that matches nothing closes the menu. An empty query (the
  // bare ":") keeps it open — armed and showing a prompt — so the next
  // keystroke can start filtering rather than fold the menu on the first frame.
  useEffect(() => {
    if (state.query.length > 0 && items.length === 0) onClose();
  }, [state.query, items.length, onClose]);

  const pick = (item: EmojiMatch | undefined): void => {
    if (!item) return;
    const found = findBlock(editor.doc, state.blockId);
    const text = found && blockText(found.block);
    if (text) {
      // Remove the typed ":query".
      const len = 1 + state.query.length;
      editor.doc.transact(() => {
        if (text.toString().slice(state.anchorOffset, state.anchorOffset + 1) === ':') {
          text.delete(state.anchorOffset, Math.min(len, text.length - state.anchorOffset));
        }
      }, 'local');
    }
    onClose();
    onInsertText(state.blockId, state.anchorOffset, item.emoji);
  };

  return (
    <div
      ref={ref}
      className="obe-slash"
      style={pos ? {left: pos.left, top: pos.top, maxHeight: pos.maxHeight} : {left: 0, top: 0, visibility: 'hidden'}}
    >
      {items.length === 0 ? (
        // The bare ":" (no query yet) shows a muted prompt — a live status node,
        // NOT a fake option inside a listbox, so a screen reader doesn't
        // announce an empty option.
        <div className="obe-slash-empty" role="status" aria-live="polite">
          {t('emoji.searchEmoji')}
        </div>
      ) : (
        <div role="listbox" aria-label={t('emoji.label')}>
          {items.map((item, i) => (
            <button
              key={item.name}
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
              <span className="obe-slash-emoji" aria-hidden>
                {item.emoji}
              </span>
              <span className="obe-slash-label">{item.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
};
