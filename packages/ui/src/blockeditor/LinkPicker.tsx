import React, {useEffect, useMemo, useRef, useState} from 'react';
import {pageLinks, type PageLinkResult} from '@/lib/pageLinks';
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
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const results = useMemo(
    () => pageLinks.searchPages(query, {databasesOnly: kind === 'database'}),
    [query, kind],
  );

  const pos = useMemo(() => {
    const r = anchorEl?.getBoundingClientRect();
    const left = r ? Math.min(r.left, window.innerWidth - 308) : 80;
    const top = r ? Math.min(r.bottom + 6, window.innerHeight - 320) : 120;
    return {left: Math.max(8, left), top: Math.max(8, top)};
  }, [anchorEl]);

  useEffect(() => inputRef.current?.focus(), []);
  useEffect(() => setIndex(0), [query]);

  // Click anywhere outside the popover cancels the pick.
  useEffect(() => {
    const onDocDown = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', onDocDown);
    return () => document.removeEventListener('mousedown', onDocDown);
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
      className="fixed z-50 flex w-72 flex-col rounded-lg border border-border bg-popover p-1.5 text-popover-foreground shadow-lg"
      style={{left: pos.left, top: pos.top}}
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
      <div role="listbox" className="max-h-64 overflow-y-auto">
        {results.map((r, i) => (
          <button
            key={r.id}
            type="button"
            role="option"
            aria-selected={i === index}
            className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm ${i === index ? 'bg-accent' : ''}`}
            onMouseEnter={() => setIndex(i)}
            onMouseDown={(e) => {
              e.preventDefault(); // keep focus; pick before the outside-click closes
              pick(i);
            }}
          >
            <span className="shrink-0 text-base leading-none">{r.icon}</span>
            <span className="truncate">{r.label}</span>
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
