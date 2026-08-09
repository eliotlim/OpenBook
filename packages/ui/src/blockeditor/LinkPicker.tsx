import React, {useEffect, useLayoutEffect, useMemo, useRef, useState} from 'react';
import {pageLinks, type PageLinkResult} from '@/lib/pageLinks';
import {PageIcon} from '@/components/PageIcon';
import {t} from '../i18n';

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
  const [pos, setPos] = useState<{left: number; top: number; maxHeight: number} | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const results = useMemo(
    () => pageLinks.searchPages(query, {databasesOnly: kind === 'database'}),
    [query, kind],
  );

  // Fixed positioning is based on the rendered picker, not an assumed box.
  // Keep the same 6px anchor gap / 8px viewport gutter as the editor menus,
  // flip when the room above is better, and remeasure when the viewport or
  // result-set height changes.
  useLayoutEffect(() => {
    const measure = (): void => {
      const picker = rootRef.current;
      if (!picker) return;

      const rect = anchorEl?.getBoundingClientRect();
      const left = rect?.left ?? 80;
      const anchorTop = rect?.top ?? 120;
      const anchorBottom = rect?.bottom ?? anchorTop;
      // Remove the previous viewport constraint while measuring. Otherwise a
      // filtered short list can permanently cap a later expanded result set.
      const previousMaxHeight = picker.style.maxHeight;
      picker.style.maxHeight = '';
      const pickerWidth = picker.offsetWidth;
      const pickerHeight = picker.offsetHeight;
      picker.style.maxHeight = previousMaxHeight;
      const below = window.innerHeight - anchorBottom - 14;
      const above = anchorTop - 14;
      const flip = pickerHeight > below && above > below;
      const availableHeight = Math.max(0, flip ? above : below);
      const maxHeight = Math.min(pickerHeight, availableHeight);
      const shownHeight = Math.min(pickerHeight, maxHeight);
      const top = flip
        ? Math.max(8, Math.min(anchorTop - 6 - shownHeight, window.innerHeight - shownHeight - 8))
        : Math.max(8, Math.min(anchorBottom + 6, window.innerHeight - shownHeight - 8));

      setPos({
        left: Math.max(8, Math.min(left, window.innerWidth - pickerWidth - 8)),
        top,
        maxHeight,
      });
    };

    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [anchorEl, results.length]);

  useEffect(() => inputRef.current?.focus(), []);
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
      className="fixed z-50 flex w-72 flex-col overflow-hidden rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-menu data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:pointer-events-none data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95"
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
        className="mb-1 w-full rounded-md border border-border bg-card px-2 py-1.5 text-sm outline-hidden focus:border-ring"
      />
      <div role="listbox" className="min-h-0 max-h-64 flex-1 overflow-y-auto overscroll-contain">
        {results.map((r, i) => (
          <button
            key={r.id}
            type="button"
            role="option"
            aria-selected={i === index}
            className={`flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm outline-hidden transition-colors hover:bg-hover focus:bg-hover ${i === index ? 'bg-hover' : ''}`}
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
