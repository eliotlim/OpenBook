import React, {useState} from 'react';
import {BadgeCheck, Check, ChevronDown, ExternalLink, Plus, X} from 'lucide-react';
import {
  isVerified,
  makeVerification,
  type DatabaseProperty,
  type DatabaseRow,
  type DatabaseSelectOption,
  type VerificationValue,
} from '@open-book/sdk';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {Popover, PopoverContent, PopoverTrigger} from '@/components/ui/popover';
import {IconButton} from '@/components/ui/icon-button';
import {usePreferences} from '@/providers';
import {pageLinks, subscribePageLinks} from '@/lib/pageLinks';
import {cn} from '@/lib/utils';

/**
 * The raw value to feed a property cell: the stored value for editable types,
 * and the *derived* value for the read-only ones — `expr` (a reactive export)
 * and the `created_time`/`last_edited_time` timestamps (from the row page).
 */
export function cellValue(row: DatabaseRow, property: DatabaseProperty): unknown {
  if (property.type === 'expr') return row.exports[property.cellName ?? property.name];
  if (property.type === 'created_time') return row.createdAt;
  if (property.type === 'last_edited_time') return row.updatedAt;
  return row.properties[property.id];
}

/** The current user's display name, used to stamp owner/verification. */
export function useIdentity(): string {
  const {preferences} = usePreferences();
  return preferences.profile.displayName.trim() || preferences.profile.name.trim() || 'You';
}

/** A person value rendered as an avatar chip. */
export const PersonChip: React.FC<{name: string}> = ({name}) => (
  <span className="inline-flex max-w-full items-center gap-1 truncate rounded-full bg-muted px-2 py-0.5 text-xs">
    <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-brand/15 text-[9px] font-semibold uppercase text-brand">
      {name.slice(0, 1) || '?'}
    </span>
    <span className="truncate">{name}</span>
  </span>
);

/** A verification badge (verified / not). */
export const VerificationBadge: React.FC<{value: unknown}> = ({value}) => {
  const verified = isVerified(value);
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs',
        verified ? 'text-green-700 dark:text-green-300' : 'text-muted-foreground',
      )}
    >
      <BadgeCheck className={cn('h-3.5 w-3.5', verified ? 'text-green-600 dark:text-green-400' : 'text-muted-foreground/50')} />
      {verified ? 'Verified' : 'Unverified'}
    </span>
  );
};

/** Tailwind classes for each `select` swatch token. */
const COLOR_CLASSES: Record<string, string> = {
  gray: 'bg-zinc-200 text-zinc-700 dark:bg-zinc-700/60 dark:text-zinc-200',
  brown: 'bg-amber-200/70 text-amber-900 dark:bg-amber-900/40 dark:text-amber-200',
  orange: 'bg-orange-200 text-orange-800 dark:bg-orange-900/40 dark:text-orange-200',
  yellow: 'bg-yellow-200 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-200',
  green: 'bg-green-200 text-green-800 dark:bg-green-900/40 dark:text-green-200',
  blue: 'bg-blue-200 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200',
  purple: 'bg-purple-200 text-purple-800 dark:bg-purple-900/40 dark:text-purple-200',
  pink: 'bg-pink-200 text-pink-800 dark:bg-pink-900/40 dark:text-pink-200',
  red: 'bg-red-200 text-red-800 dark:bg-red-900/40 dark:text-red-200',
};

const colorClass = (color?: string): string => COLOR_CLASSES[color ?? 'gray'] ?? COLOR_CLASSES.gray;

const findOption = (property: DatabaseProperty, value: unknown): DatabaseSelectOption | undefined =>
  property.options?.find((o) => o.id === value);

/** A colored select-option chip. */
export const SelectChip: React.FC<{option: DatabaseSelectOption}> = ({option}) => (
  <span className={cn('inline-flex max-w-full items-center truncate rounded px-1.5 py-0.5 text-xs', colorClass(option.color))}>
    {option.label}
  </span>
);

/** Read-only text of a cell value (for list-view chips and expr columns). */
export function formatCellValue(property: DatabaseProperty, value: unknown): string {
  if (property.type === 'verification') return isVerified(value) ? 'Verified' : '';
  if (property.type === 'backlinks' || property.type === 'relation') return ''; // rendered as chips
  if (property.type === 'created_time' || property.type === 'last_edited_time') {
    return value ? new Date(String(value)).toLocaleDateString() : '';
  }
  if (property.type === 'multi_select') {
    const ids = Array.isArray(value) ? (value as string[]) : [];
    return ids
      .map((id) => property.options?.find((o) => o.id === id)?.label)
      .filter(Boolean)
      .join(', ');
  }
  if (value === undefined || value === null || value === '') return '';
  if (property.type === 'checkbox') return value ? '✓' : '';
  if (property.type === 'select') return findOption(property, value)?.label ?? '';
  if (property.type === 'expr') return formatExprValue(value);
  return String(value);
}

/** Compact, human-readable rendering of an arbitrary exported expression value. */
export function formatExprValue(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : value.toFixed(2);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return `[${value.length}]`;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

const inputClass =
  'w-full bg-transparent px-2 py-1 text-sm outline-hidden placeholder:text-muted-foreground/40 focus:bg-accent/40';

export interface PropertyValueCellProps {
  property: DatabaseProperty;
  value: unknown;
  /** Live exported value (expr columns are read-only and use this). */
  exprValue?: unknown;
  onChange: (value: unknown) => void;
  /** Create a new select option (returns it), used by the select editor. */
  onAddOption?: (label: string) => Promise<DatabaseSelectOption | null>;
}

/**
 * An inline, type-aware editor for one row's value of one property. Manual
 * types edit in place; `expr` columns are read-only and show the live exported
 * value projected from the row page's reactive store.
 */
export const PropertyValueCell: React.FC<PropertyValueCellProps> = ({
  property,
  value,
  exprValue,
  onChange,
  onAddOption,
}) => {
  switch (property.type) {
  case 'expr':
    return (
      <div className="px-2 py-1 text-sm tabular-nums text-foreground/80" title="Computed from the row's exported cell">
        {formatExprValue(exprValue)}
      </div>
    );
  case 'checkbox':
    return (
      <div className="flex items-center px-2 py-1">
        <input
          type="checkbox"
          checked={value === true}
          onChange={(e) => onChange(e.target.checked)}
          className="h-4 w-4 cursor-pointer accent-primary"
          aria-label={property.name}
        />
      </div>
    );
  case 'number':
    return (
      <input
        type="number"
        defaultValue={value === undefined || value === null ? '' : String(value)}
        onBlur={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
        className={cn(inputClass, 'tabular-nums')}
        placeholder="—"
      />
    );
  case 'date':
    return (
      <input
        type="date"
        defaultValue={typeof value === 'string' ? value : ''}
        onChange={(e) => onChange(e.target.value || null)}
        className={inputClass}
      />
    );
  case 'select':
    return <SelectCell property={property} value={value} onChange={onChange} onAddOption={onAddOption} />;
  case 'multi_select':
    return <MultiSelectCell property={property} value={value} onChange={onChange} onAddOption={onAddOption} />;
  case 'relation':
    return <RelationCell value={value} onChange={onChange} />;
  case 'url':
  case 'email':
  case 'phone':
    return <LinkCell kind={property.type} value={value} onChange={onChange} />;
  case 'created_time':
  case 'last_edited_time':
    return (
      <div className="px-2 py-1 text-sm text-muted-foreground/80" title="Set automatically">
        {formatCellValue(property, value)}
      </div>
    );
  case 'person':
    return (
      <input
        type="text"
        defaultValue={typeof value === 'string' ? value : value == null ? '' : String(value)}
        onBlur={(e) => onChange(e.target.value.trim() || null)}
        className={inputClass}
        placeholder="Add a person…"
        aria-label={property.name}
      />
    );
  case 'verification':
    return <VerificationCell value={value} onChange={onChange} />;
  case 'backlinks':
    // Backlinks are computed from the link graph, not stored per row; the page
    // properties panel is where they're shown. A row cell stays read-only.
    return <div className="px-2 py-1 text-xs text-muted-foreground/50">—</div>;
  default:
    return (
      <input
        type="text"
        defaultValue={typeof value === 'string' ? value : value == null ? '' : String(value)}
        onBlur={(e) => onChange(e.target.value)}
        className={inputClass}
        placeholder="Empty"
      />
    );
  }
};

/** Verification cell: a clickable badge that toggles verified, stamping the
 *  current user + time. The full {verified, by, at} object is stored. */
const VerificationCell: React.FC<{value: unknown; onChange: (value: unknown) => void}> = ({value, onChange}) => {
  const identity = useIdentity();
  const verified = isVerified(value);
  const toggle = () => {
    const next: VerificationValue = verified
      ? {verified: false}
      : makeVerification(identity, new Date().toISOString());
    onChange(next);
  };
  return (
    <button
      type="button"
      onClick={toggle}
      className="flex w-full items-center px-2 py-1 text-left hover:bg-accent/40"
      title={verified && (value as VerificationValue).by ? `Verified by ${(value as VerificationValue).by}` : 'Toggle verification'}
    >
      <VerificationBadge value={value} />
    </button>
  );
};

const LINK_HREF = {
  url: (v: string) => (/^https?:\/\//i.test(v) ? v : `https://${v}`),
  email: (v: string) => `mailto:${v}`,
  phone: (v: string) => `tel:${v}`,
} as const;

/** Editable url / email / phone cell with an "open" affordance when filled. */
const LinkCell: React.FC<{kind: 'url' | 'email' | 'phone'; value: unknown; onChange: (value: unknown) => void}> = ({
  kind,
  value,
  onChange,
}) => {
  const str = typeof value === 'string' ? value : '';
  return (
    <div className="flex items-center">
      <input
        type={kind === 'phone' ? 'tel' : kind}
        defaultValue={str}
        onBlur={(e) => onChange(e.target.value.trim() || null)}
        className={inputClass}
        placeholder="Empty"
        aria-label={kind}
      />
      {str && (
        <a
          href={LINK_HREF[kind](str)}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="px-1.5 text-muted-foreground transition-colors hover:text-foreground"
          title="Open"
        >
          <ExternalLink className="h-3.5 w-3.5" />
        </a>
      )}
    </div>
  );
};

/** Multi-select: toggle any number of option chips; create options inline. */
const MultiSelectCell: React.FC<PropertyValueCellProps> = ({property, value, onChange, onAddOption}) => {
  const [draft, setDraft] = useState('');
  const ids = Array.isArray(value) ? (value as string[]) : [];
  const selected = (property.options ?? []).filter((o) => ids.includes(o.id));
  const toggle = (id: string) => onChange(ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]);
  const create = async () => {
    const option = await onAddOption?.(draft);
    setDraft('');
    if (option) onChange([...ids, option.id]);
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button className="flex min-h-[28px] w-full flex-wrap items-center gap-1 px-2 py-1 text-left text-sm hover:bg-accent/40">
          {selected.length > 0 ? (
            selected.map((o) => <SelectChip key={o.id} option={o} />)
          ) : (
            <span className="text-muted-foreground/40">Empty</span>
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-52">
        {(property.options ?? []).map((option) => (
          <DropdownMenuItem
            key={option.id}
            onSelect={(e) => e.preventDefault()}
            onClick={() => toggle(option.id)}
            className="gap-2"
          >
            <SelectChip option={option} />
            {ids.includes(option.id) && <Check className="ml-auto h-3.5 w-3.5" />}
          </DropdownMenuItem>
        ))}
        {onAddOption && (
          <>
            <DropdownMenuSeparator />
            <div className="flex items-center gap-1 px-1.5 py-1" onKeyDown={(e) => e.stopPropagation()}>
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void create();
                }}
                onClick={(e) => e.stopPropagation()}
                placeholder="New option…"
                className="w-full rounded bg-accent/40 px-1.5 py-1 text-xs outline-hidden"
              />
              <IconButton
                size="sm"
                onClick={(e) => {
                  e.stopPropagation();
                  void create();
                }}
                aria-label="Add option"
              >
                <Plus className="h-3.5 w-3.5" />
              </IconButton>
            </div>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

/** Relation: link the row to any pages — chips you can remove + a search to add. */
const RelationCell: React.FC<{value: unknown; onChange: (value: unknown) => void}> = ({value, onChange}) => {
  const ids = Array.isArray(value) ? (value as string[]) : [];
  const [query, setQuery] = useState('');
  // Page titles/icons resolve through the live bridge; refresh on change.
  const [, bump] = React.useReducer((x: number) => x + 1, 0);
  React.useEffect(() => subscribePageLinks(bump), []);

  const results = pageLinks.searchPages(query).filter((r) => !ids.includes(r.id));
  const add = (id: string) => {
    onChange([...ids, id]);
    setQuery('');
  };
  const remove = (id: string) => onChange(ids.filter((x) => x !== id));

  return (
    <div className="flex min-h-[28px] flex-wrap items-center gap-1 px-2 py-1">
      {ids.map((id) => (
        <span key={id} className="inline-flex max-w-full items-center gap-1 rounded-md border border-border/60 px-1.5 py-0.5 text-xs">
          <span className="leading-none">{pageLinks.icon(id)}</span>
          <span className="max-w-[120px] truncate">{pageLinks.label(id)}</span>
          <button
            type="button"
            onClick={() => remove(id)}
            className="text-muted-foreground/70 transition-colors hover:text-destructive"
            aria-label="Remove link"
          >
            <X className="h-3 w-3" />
          </button>
        </span>
      ))}
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="rounded p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            aria-label="Link a page"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-60 p-1">
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Link a page…"
            className="mb-1 w-full rounded bg-accent/40 px-1.5 py-1 text-sm outline-hidden"
          />
          <div className="max-h-52 overflow-y-auto">
            {results.length === 0 && <div className="px-1.5 py-1.5 text-xs text-muted-foreground">No pages found</div>}
            {results.map((r) => (
              <button
                key={r.id}
                type="button"
                onClick={() => add(r.id)}
                className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-sm transition-colors hover:bg-accent"
              >
                <span className="leading-none">{r.icon}</span>
                <span className="truncate">{r.label}</span>
              </button>
            ))}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
};

const SelectCell: React.FC<PropertyValueCellProps> = ({property, value, onChange, onAddOption}) => {
  const [draft, setDraft] = useState('');
  const selected = findOption(property, value);

  const create = async () => {
    const option = await onAddOption?.(draft);
    setDraft('');
    if (option) onChange(option.id);
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button className="flex w-full items-center justify-between gap-1 px-2 py-1 text-left text-sm hover:bg-accent/40">
          {selected ? <SelectChip option={selected} /> : <span className="text-muted-foreground/40">Empty</span>}
          <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground/60" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-52">
        {(property.options ?? []).map((option) => (
          <DropdownMenuItem key={option.id} onClick={() => onChange(option.id)} className="gap-2">
            <SelectChip option={option} />
            {option.id === value && <Check className="ml-auto h-3.5 w-3.5" />}
          </DropdownMenuItem>
        ))}
        {value != null && (
          <DropdownMenuItem onClick={() => onChange(null)} className="text-muted-foreground">
            Clear
          </DropdownMenuItem>
        )}
        {onAddOption && (
          <>
            <DropdownMenuSeparator />
            <div className="flex items-center gap-1 px-1.5 py-1" onKeyDown={(e) => e.stopPropagation()}>
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void create();
                }}
                onClick={(e) => e.stopPropagation()}
                placeholder="New option…"
                className="w-full rounded bg-accent/40 px-1.5 py-1 text-xs outline-hidden"
              />
              <IconButton
                size="sm"
                onClick={(e) => {
                  e.stopPropagation();
                  void create();
                }}
                aria-label="Add option"
              >
                <Plus className="h-3.5 w-3.5" />
              </IconButton>
            </div>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
