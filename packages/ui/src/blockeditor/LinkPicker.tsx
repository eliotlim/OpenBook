import React, {useEffect, useLayoutEffect, useMemo, useRef, useState} from 'react';
import {pageLinks, type PageLinkResult} from '@/lib/pageLinks';
import {PageIcon} from '@/components/PageIcon';
import {t} from '../i18n';
import {observePopupPosition, type PopupPosition} from './popupPosition';

const FALLBACK_ANCHOR_RECT = {
  left: 80,
  right: 80,
  top: 120,
  bottom: 120,
  width: 0,
  height: 0,
  x: 80,
  y: 120,
  toJSON: () => ({}),
} as DOMRect;

/**
 * The page/database link picker: a small search popover that the "Link to
 * page" / "Link to database" slash commands open. It searches existing pages
 * (optionally only those hosting a database) through the {@link pageLinks}
 * bridge — the same source the EditorJS `@`-mention uses — so it works whether
 * or not the editor sits inside the navigation provider. Picking inserts an
 * inline page-link mention where the command was typed.
 */
export const LinkPicker: React.FC<{
  kind: 'page' | 'database';
  anchorEl: HTMLElement | null;
  onPick: (result: PageLinkResult) => void;
  onClose: () => void;
}> = ({kind, anchorEl, onPick, onClose}) => {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const [pos, setPos] = useState<PopupPosition | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const results = useMemo(
    () => pageLinks.searchPages(query, {databasesOnly: kind === 'database'}),
    [query, kind],
  );

  // Shared positioning preserves the picker's measured content-height cap,
  // flip, viewport clamp, and result-growth remeasurement.
  useLayoutEffect(() => {
    return observePopupPosition({
      popup: () => rootRef.current,
      anchor: () => anchorEl?.getBoundingClientRect() ?? FALLBACK_ANCHOR_RECT,
      onPosition: setPos,
      options: {align: 'start', capHeightToContent: true},
    });
  }, [anchorEl, results.length]);

  // Land focus only once the popover has left the visibility:hidden
  // pre-measure frame — focusing a hidden element is a silent no-op in
  // Chromium. This layout effect runs after the DOM commit that clears
  // `visibility` (unlike a plain mount `useEffect`, which can fire before
  // that commit lands when the position update is still in flight), and the
  // ref guard keeps a later remeasure (e.g. the result list changing height)
  // from re-stealing focus once it has already landed.
  const focusedRef = useRef(false);
  useLayoutEffect(() => {
    if (pos && !focusedRef.current) {
      focusedRef.current = true;
      inputRef.current?.focus();
    }
  }, [pos]);
  useEffect(() => setIndex(0), [query]);

  // Clicks and scrolling outside the fixed popover cancel the pick. Its own
  // result list remains scrollable without dismissing itself.
  useEffect(() => {
    const onDocDown = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) onClose();
    };
    const onScroll = (e: Event): void => {
      if (e.target instanceof Node && rootRef.current?.contains(e.target)) return;
      onClose();
    };
    document.addEventListener('mousedown', onDocDown);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('mousedown', onDocDown);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [onClose]);

  const pick = (i: number): void => {
    const r = results[i];
    if (r) onPick(r);
  };

  const onKeyDown = (e: React.KeyboardEvent): void => {
    const n = Math.max(1, results.length);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setIndex((i) => (i + 1) % n);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setIndex((i) => (i - 1 + n) % n);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      pick(index);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <div
      ref={rootRef}
      data-state="open"
      className="fixed z-50 flex w-72 flex-col overflow-hidden rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-overlay data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:pointer-events-none data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95"
      style={pos ? {left: pos.left, top: pos.top, maxHeight: pos.maxHeight} : {left: 0, top: 0, visibility: 'hidden'}}
      role="dialog"
      aria-label={kind === 'database' ? t('link.databaseTitle') : t('link.pageTitle')}
    >
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={kind === 'database' ? t('link.databasePlaceholder') : t('link.pagePlaceholder')}
        aria-label={kind === 'database' ? t('link.databaseTitle') : t('link.pageTitle')}
        className="mb-1 w-full rounded-sm border border-border bg-card px-2 py-1.5 text-sm outline-hidden focus:border-ring"
      />
      <div role="listbox" className="min-h-0 max-h-64 flex-1 overflow-y-auto overscroll-contain">
        {results.map((r, i) => (
          <button
            key={r.id}
            type="button"
            role="option"
            aria-selected={i === index}
            className={`flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm outline-hidden transition-colors ${i === index ? 'bg-hover' : ''}`}
            onMouseEnter={() => setIndex(i)}
            onMouseDown={(e) => {
              e.preventDefault(); // keep focus; pick before the outside-click closes
              pick(i);
            }}
          >
            <PageIcon value={r.icon} className="shrink-0 text-base leading-none" />
            <span className="min-w-0 truncate">{r.label}</span>
            {r.path && <span className="ml-auto min-w-0 truncate pl-2 text-xs text-muted-foreground">{r.path}</span>}
          </button>
        ))}
        {results.length === 0 && (
          <div className="px-2 py-2 text-sm text-muted-foreground">
            {kind === 'database' ? t('link.noDatabases') : t('link.noPages')}
          </div>
        )}
      </div>
    </div>
  );
};
