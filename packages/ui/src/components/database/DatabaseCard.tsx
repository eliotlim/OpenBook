import React, {useEffect, useRef, useState} from 'react';
import {TITLE_PROPERTY_ID, type DatabaseProperty} from '@open-book/sdk';
import {Popover, PopoverContent, PopoverTrigger} from '@/components/ui/popover';
import {useData} from '@/data';
import {readPageIcon} from '@/lib/pageIcon';
import {readPageCover} from '@/lib/pageCover';
import {pageLinks} from '@/lib/pageLinks';
import {cn} from '@/lib/utils';
import {SWATCH_HEX} from './databaseColors';

/**
 * The extensible **database card** — a compact preview of an entity used for
 * hover and popovers. It's deliberately generic: an optional cover, an icon +
 * title, and a list of `fields` (label + node). {@link useRowCard} builds one
 * from a database row, but any caller can assemble its own `fields` to reuse the
 * card for mentions, search results, or other entities.
 */

export interface CardField {
  id: string;
  label: string;
  node: React.ReactNode;
}

export interface DatabaseCardData {
  title: string;
  icon?: string;
  /** A CSS background for the cover band (gradient or image), or none. */
  cover?: React.CSSProperties;
  fields: CardField[];
}

export const DatabaseCard: React.FC<{data: DatabaseCardData; onOpen?: () => void}> = ({data, onOpen}) => (
  <div className="w-full overflow-hidden">
    {data.cover && <div className="h-14 w-full" style={data.cover} aria-hidden />}
    <div className="flex flex-col gap-2 p-3">
      <button
        type="button"
        onClick={onOpen}
        disabled={!onOpen}
        className={cn('flex items-center gap-1.5 text-left text-sm font-medium', onOpen && 'cursor-pointer hover:underline')}
      >
        {data.icon && <span className="shrink-0 leading-none">{data.icon}</span>}
        <span className="min-w-0 truncate">{data.title}</span>
      </button>
      {data.fields.length > 0 ? (
        <dl className="flex flex-col gap-1">
          {data.fields.map((f) => (
            <div key={f.id} className="flex items-center gap-2 text-xs">
              <dt className="w-20 shrink-0 truncate text-muted-foreground">{f.label}</dt>
              <dd className="min-w-0 flex-1 truncate">{f.node}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="text-xs text-muted-foreground">No properties</p>
      )}
    </div>
  </div>
);

/** A small colour dot + label for a select/status value. */
const OptionChip: React.FC<{label: string; color?: string}> = ({label, color}) => (
  <span className="inline-flex items-center gap-1">
    {color && <span className="h-2 w-2 shrink-0 rounded-full" style={{backgroundColor: SWATCH_HEX[color] ?? color}} />}
    <span className="truncate">{label}</span>
  </span>
);

/** Render one property's value as a compact card field node (or null to skip). */
function fieldNode(property: DatabaseProperty, value: unknown): React.ReactNode {
  if (value == null || value === '' || (Array.isArray(value) && value.length === 0)) return null;
  switch (property.type) {
  case 'select':
  case 'status': {
    const opt = property.options?.find((o) => o.id === value);
    return opt ? <OptionChip label={opt.label} color={opt.color} /> : null;
  }
  case 'multi_select': {
    const ids = Array.isArray(value) ? (value as string[]) : [];
    const opts = (property.options ?? []).filter((o) => ids.includes(o.id));
    return opts.length ? <span className="truncate">{opts.map((o) => o.label).join(', ')}</span> : null;
  }
  case 'relation':
  case 'dependency': {
    const ids = Array.isArray(value) ? (value as string[]) : [];
    return ids.length ? <span className="truncate">{ids.map((id) => pageLinks.label(id)).join(', ')}</span> : null;
  }
  case 'checkbox':
    return value === true ? '✓' : null;
  case 'date': {
    const v = value as {start?: string | null; end?: string | null} | string;
    if (typeof v === 'string') return v;
    return v.start ? (v.end ? `${v.start} → ${v.end}` : v.start) : null;
  }
  default:
    return <span className="truncate">{String(value)}</span>;
  }
}

// Card data is cached per row id — a hover preview needn't be real-time, and the
// cache avoids a flash + refetch on every re-hover.
const cardCache = new Map<string, DatabaseCardData>();

/** Build (and cache) a {@link DatabaseCardData} for a database row, fetched on demand. */
export function useRowCard(rowId: string, active: boolean): DatabaseCardData | null {
  const client = useData();
  const [data, setData] = useState<DatabaseCardData | null>(() => cardCache.get(rowId) ?? null);
  useEffect(() => {
    if (!active || data) return;
    let alive = true;
    void (async () => {
      const page = await client.getPage(rowId);
      if (!page || !alive) return;
      const schema = page.databaseId ? (await client.getDatabase(page.databaseId))?.schema.properties ?? [] : [];
      const cover = readPageCover(rowId);
      const fields: CardField[] = [];
      for (const p of schema) {
        if (fields.length >= 5) break;
        if (p.id === TITLE_PROPERTY_ID || p.pageHidden) continue;
        const node = fieldNode(p, page.properties[p.id]);
        if (node != null) fields.push({id: p.id, label: p.name, node});
      }
      const built: DatabaseCardData = {
        title: page.name?.trim() || 'Untitled',
        icon: readPageIcon(rowId),
        cover:
          cover?.kind === 'gradient'
            ? {background: cover.css}
            : cover?.kind === 'image'
              ? {backgroundImage: `url("${cover.url}")`, backgroundSize: 'cover', backgroundPosition: `50% ${cover.position ?? 50}%`}
              : undefined,
        fields,
      };
      cardCache.set(rowId, built);
      if (alive) setData(built);
    })();
    return () => {
      alive = false;
    };
  }, [active, rowId, data, client]);
  return data;
}

/**
 * Wrap a trigger so hovering it (after a short delay) reveals the row's
 * {@link DatabaseCard} in a popover. Built on {@link Popover} with hover
 * handlers (no focus stealing); clicking the card title opens the row.
 */
export const RowHoverCard: React.FC<{rowId: string; children: React.ReactNode; openDelay?: number}> = ({
  rowId,
  children,
  openDelay = 280,
}) => {
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const card = useRowCard(rowId, open);
  const scheduleOpen = (): void => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(true), openDelay);
  };
  const scheduleClose = (): void => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(false), 140);
  };
  useEffect(() => () => clearTimeout(timer.current), []);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <span onMouseEnter={scheduleOpen} onMouseLeave={scheduleClose}>
          {children}
        </span>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-64 p-0"
        onMouseEnter={scheduleOpen}
        onMouseLeave={scheduleClose}
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        {card ? (
          <DatabaseCard data={card} onOpen={() => pageLinks.openPage(rowId)} />
        ) : (
          <div className="p-3 text-xs text-muted-foreground">Loading…</div>
        )}
      </PopoverContent>
    </Popover>
  );
};
