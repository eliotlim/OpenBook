import React, {useEffect, useId, useLayoutEffect, useMemo, useRef, useState} from 'react';
import {isSafeHref} from '@book.dev/sdk';
import {pageLinks, type PageLinkResult} from '@/lib/pageLinks';
import {PageIcon} from '@/components/PageIcon';
import {t} from '../i18n';
import {observePopupPosition, type PopupPosition} from './popupPosition';

// The non-zero x/y are load-bearing: zero-rect classification would burn the
// 20-frame retry budget. All unit-test renders with anchorEl=null use this path.
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
  const listboxId = useId();

  const results = useMemo(
    () => pageLinks.searchPages(query, {databasesOnly: kind === 'database'}),
    [query, kind],
  );

  // Shared positioning preserves the picker's measured content-height cap,
  // flip, horizontal and above-placement viewport clamps; below placement can
  // exceed the viewport only via the shared min-height floor, matching the other
  // popups. Bring a fully off-screen command block back first so its live rect,
  // rather than an out-of-viewport coordinate, drives the initial measurement.
  // Result growth still triggers remeasurement.
  useLayoutEffect(() => {
    const rect = anchorEl?.getBoundingClientRect();
    if (
      anchorEl &&
      rect &&
      (rect.bottom <= 0 || rect.top >= window.innerHeight || rect.right <= 0 || rect.left >= window.innerWidth)
    ) {
      anchorEl.scrollIntoView({block: 'center'});
    }
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

  const optionId = (result: PageLinkResult): string => `${listboxId}-option-${encodeURIComponent(result.id)}`;
  const activeOptionId = results[index] ? optionId(results[index]) : undefined;

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
        role="combobox"
        aria-expanded={true}
        aria-controls={listboxId}
        aria-activedescendant={activeOptionId}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={kind === 'database' ? t('link.databasePlaceholder') : t('link.pagePlaceholder')}
        aria-label={kind === 'database' ? t('link.databaseTitle') : t('link.pageTitle')}
        className="mb-1 w-full rounded-sm border border-border bg-card px-2 py-1.5 text-sm outline-hidden focus:border-ring"
      />
      <div id={listboxId} role="listbox" className="min-h-0 max-h-64 flex-1 overflow-y-auto overscroll-contain">
        {results.map((r, i) => (
          <button
            key={r.id}
            id={optionId(r)}
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

/** Prompt-free URL editor used by the inline-link context menu. */
export const LinkUrlEditor: React.FC<{
  anchorEl: HTMLElement | null;
  href: string;
  onSave: (href: string) => void;
  onClose: () => void;
}> = ({anchorEl, href, onSave, onClose}) => {
  const [value, setValue] = useState(href);
  const [pos, setPos] = useState<PopupPosition | null>(null);
  const rootRef = useRef<HTMLFormElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useLayoutEffect(
    () =>
      observePopupPosition({
        popup: () => rootRef.current,
        anchor: () => anchorEl?.getBoundingClientRect() ?? FALLBACK_ANCHOR_RECT,
        onPosition: setPos,
        options: {align: 'start', capHeightToContent: true},
      }),
    [anchorEl],
  );

  useLayoutEffect(() => {
    if (pos) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [pos]);

  useEffect(() => {
    const onDocDown = (event: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) onClose();
    };
    document.addEventListener('mousedown', onDocDown);
    return () => document.removeEventListener('mousedown', onDocDown);
  }, [onClose]);

  const normalizedValue = (() => {
    const next = value.trim();
    if (!next) return null;
    const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(next);
    if (hasScheme && !isSafeHref(next)) return null;
    const href = hasScheme ? next : `https://${next}`;
    return isSafeHref(href) ? href : null;
  })();

  const save = (): void => {
    if (normalizedValue) onSave(normalizedValue);
  };

  return (
    <form
      ref={rootRef}
      className="fixed z-50 flex w-72 items-center gap-1.5 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-overlay"
      style={pos ? {left: pos.left, top: pos.top} : {left: 0, top: 0, visibility: 'hidden'}}
      role="dialog"
      aria-label={t('link.edit')}
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          onClose();
        }
      }}
    >
      <input
        ref={inputRef}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        aria-label={t('link.urlLabel')}
        placeholder="https://…"
        spellCheck={false}
        className="min-w-0 flex-1 rounded-sm border border-border bg-card px-2 py-1.5 text-sm outline-hidden focus:border-ring"
      />
      <button
        type="submit"
        disabled={!normalizedValue}
        className="shrink-0 rounded-sm bg-primary px-2.5 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-40"
      >
        {t('common.save')}
      </button>
    </form>
  );
};
