import React, {useState} from 'react';
import {BadgeCheck, Check, ChevronDown, ExternalLink, Plus, X} from 'lucide-react';
import {
  dateEnd,
  dateStart,
  formatNumber,
  FormulaError,
  isImageUrl,
  formatUniqueId,
  isVerified,
  makeVerification,
  numberProgress,
  rowValue,
  STATUS_GROUPS,
  type DatabaseProperty,
  type DatabaseRow,
  type DatabaseSelectOption,
  type DateRange,
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
import {SWATCH_HEX} from './databaseColors';

/**
 * The raw value to feed a property cell: the stored value for editable types,
 * and the *derived* value for the read-only ones — `expr` (a reactive export),
 * `formula` (computed from sibling properties; needs the full property list),
 * and the `created_time`/`last_edited_time` timestamps (from the row page).
 */
export function cellValue(
  row: DatabaseRow,
  property: DatabaseProperty,
  properties?: DatabaseProperty[],
  rows?: DatabaseRow[],
): unknown {
  if (property.type === 'expr') return row.exports[property.cellName ?? property.name];
  if (property.type === 'formula') return rowValue(row, property, properties, rows);
  if (property.type === 'rollup') return rowValue(row, property, properties, rows);
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
/** A stored day string (`YYYY-MM-DD` or `…THH:mm`) as a locale date (+ time when present). */
function absoluteDay(d: string): string {
  const hasTime = d.includes('T');
  const dt = new Date(hasTime ? d : `${d}T00:00:00`);
  if (Number.isNaN(dt.getTime())) return d;
  return hasTime ? dt.toLocaleString(undefined, {dateStyle: 'medium', timeStyle: 'short'}) : dt.toLocaleDateString();
}

/** A day string as a friendly relative phrase ("Today", "In 3 days", "Yesterday"),
 *  falling back to {@link absoluteDay} beyond a week. */
function relativeDay(d: string): string {
  const hasTime = d.includes('T');
  const dt = new Date(hasTime ? d : `${d}T00:00:00`);
  if (Number.isNaN(dt.getTime())) return d;
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfTarget = new Date(dt.getFullYear(), dt.getMonth(), dt.getDate()).getTime();
  const diff = Math.round((startOfTarget - startOfToday) / 86_400_000);
  let label: string;
  if (diff === 0) label = 'Today';
  else if (diff === 1) label = 'Tomorrow';
  else if (diff === -1) label = 'Yesterday';
  else if (diff > 1 && diff < 7) label = `In ${diff} days`;
  else if (diff < -1 && diff > -7) label = `${-diff} days ago`;
  else return absoluteDay(d);
  return hasTime ? `${label}, ${dt.toLocaleTimeString(undefined, {hour: 'numeric', minute: '2-digit'})}` : label;
}

export function formatCellValue(property: DatabaseProperty, value: unknown): string {
  if (property.type === 'verification') return isVerified(value) ? 'Verified' : '';
  if (property.type === 'backlinks' || property.type === 'relation' || property.type === 'dependency' || property.type === 'files') return ''; // chips
  if (property.type === 'created_time' || property.type === 'last_edited_time') {
    return value ? new Date(String(value)).toLocaleDateString() : '';
  }
  if (property.type === 'date') {
    const s = dateStart(value);
    if (!s) return '';
    const e = dateEnd(value);
    const day = (d: string) => (property.dateDisplay === 'relative' ? relativeDay(d) : absoluteDay(d));
    return e ? `${day(s)} → ${day(e)}` : day(s);
  }
  if (property.type === 'unique_id') return formatUniqueId(value, property.idPrefix);
  if (property.type === 'formula') return formatFormulaValue(value, property.numberFormat);
  if (property.type === 'rollup') return formatRollupValue(property, value);
  if (property.type === 'multi_select') {
    const ids = Array.isArray(value) ? (value as string[]) : [];
    return ids
      .map((id) => property.options?.find((o) => o.id === id)?.label)
      .filter(Boolean)
      .join(', ');
  }
  if (property.type === 'rating') {
    const n = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(n) && n > 0 ? '★'.repeat(Math.round(n)) : '';
  }
  if (value === undefined || value === null || value === '') return '';
  if (property.type === 'checkbox') return value ? '✓' : '';
  if (property.type === 'select' || property.type === 'status') return findOption(property, value)?.label ?? '';
  if (property.type === 'number') return formatNumber(value, property.numberFormat);
  if (property.type === 'expr') return formatExprValue(value, property.numberFormat);
  return String(value);
}

/** Render a computed rollup value (a list for "show original", else a number). */
export function formatRollupValue(property: DatabaseProperty, value: unknown): string {
  if (Array.isArray(value)) return value.map((v) => String(v ?? '')).filter(Boolean).join(', ');
  if (value === undefined || value === null || value === '') return '';
  if (property.rollup?.function === 'percent_checked') return `${value}%`;
  if (typeof value === 'number') return formatNumber(value, property.numberFormat);
  return String(value);
}

/** Render a computed formula value, surfacing errors and honouring number format. */
export function formatFormulaValue(value: unknown, format?: DatabaseProperty['numberFormat']): string {
  if (value instanceof FormulaError) return `⚠ ${value.message}`;
  if (typeof value === 'number') return formatNumber(value, format);
  if (typeof value === 'boolean') return value ? '✓' : '✗';
  return formatExprValue(value, format);
}

/** Compact, human-readable rendering of an arbitrary exported expression value. */
export function formatExprValue(value: unknown, format?: DatabaseProperty['numberFormat']): string {
  if (value === undefined || value === null) return '';
  if (value instanceof FormulaError) return `⚠ ${value.message}`;
  if (typeof value === 'number') return formatNumber(value, format);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return `[${value.length}]`;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** A row's value of one property as a flat CSV string (links/files resolved). */
function csvValue(row: DatabaseRow, property: DatabaseProperty, properties: DatabaseProperty[], rows: DatabaseRow[]): string {
  const value = cellValue(row, property, properties, rows);
  if (property.type === 'relation') {
    return (Array.isArray(value) ? (value as string[]) : []).map((id) => pageLinks.label(id)).join('; ');
  }
  if (property.type === 'dependency') {
    return (Array.isArray(value) ? (value as string[]) : []).map((id) => rows.find((r) => r.id === id)?.name?.trim() || 'Untitled').join('; ');
  }
  if (property.type === 'files') {
    return (Array.isArray(value) ? (value as string[]) : []).join('; ');
  }
  return formatCellValue(property, value);
}

/** Serialise rows to CSV — a header of "Name" + column names, then a row each.
 *  Values are flattened and RFC-4180-escaped. Pure (shared by the export action). */
export function rowsToCsv(rows: DatabaseRow[], columns: DatabaseProperty[], properties: DatabaseProperty[]): string {
  const esc = (s: string): string => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const lines = [['Name', ...columns.map((c) => c.name)].map(esc).join(',')];
  for (const row of rows) {
    const cells = [row.name ?? '', ...columns.map((c) => csvValue(row, c, properties, rows))];
    lines.push(cells.map(esc).join(','));
  }
  return lines.join('\n');
}

/** Parse CSV text into a grid of cells (RFC-4180: quotes, escaped quotes,
 *  embedded commas/newlines). Pure — shared by the import action and tests. */
export function parseCsv(text: string): string[][] {
  const s = text.replace(/\r\n?/g, '\n');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += c;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  // Drop fully-empty trailing lines.
  return rows.filter((r) => r.some((cell) => cell !== ''));
}

/* Placeholders ("Empty") stay invisible until the row is hovered or the field
   focused — a table of mostly-empty cells reads as calm whitespace, not a grid
   of grey "Empty" labels. Rows (and the page property panel) carry `group`. */
const inputClass =
  'w-full bg-transparent px-2 py-1 text-sm outline-hidden placeholder:text-muted-foreground/40 placeholder:opacity-0 placeholder:transition-opacity group-hover:placeholder:opacity-100 focus:placeholder:opacity-100 focus:bg-accent/40';

/** The hover-revealed "Empty" label for button-style cells (select, date…). */
const emptyHint = 'text-muted-foreground/40 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100';

export interface PropertyValueCellProps {
  property: DatabaseProperty;
  value: unknown;
  /** Live exported value (expr columns are read-only and use this). */
  exprValue?: unknown;
  onChange: (value: unknown) => void;
  /** Create a new select option (returns it), used by the select editor. */
  onAddOption?: (label: string) => Promise<DatabaseSelectOption | null>;
  /** Candidate rows for a `dependency` cell (the database's own rows, sans self). */
  rowOptions?: {id: string; label: string; icon?: string}[];
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
  rowOptions,
}) => {
  switch (property.type) {
  case 'expr':
    return (
      <div className="px-2 py-1 text-sm tabular-nums text-foreground/80" title="Computed from the row's exported cell">
        {formatExprValue(exprValue, property.numberFormat)}
      </div>
    );
  case 'formula':
    return (
      <div
        className={cn(
          'px-2 py-1 text-sm tabular-nums',
          value instanceof FormulaError ? 'text-destructive' : 'text-foreground/80',
        )}
        title={value instanceof FormulaError ? value.message : 'Computed from other properties'}
      >
        {formatFormulaValue(value, property.numberFormat)}
      </div>
    );
  case 'rollup':
    return (
      <div className="px-2 py-1 text-sm tabular-nums text-foreground/80" title="Rolled up from related rows">
        {formatRollupValue(property, value) || <span className="text-muted-foreground/40">—</span>}
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
    return <NumberCell property={property} value={value} onChange={onChange} />;
  case 'rating':
    return <RatingCell property={property} value={value} onChange={onChange} />;
  case 'date':
    return <DateCell property={property} value={value} onChange={onChange} />;
  case 'select':
    return <SelectCell property={property} value={value} onChange={onChange} onAddOption={onAddOption} />;
  case 'status':
    return <StatusCell property={property} value={value} onChange={onChange} />;
  case 'multi_select':
    return <MultiSelectCell property={property} value={value} onChange={onChange} onAddOption={onAddOption} />;
  case 'relation':
    return <RelationCell value={value} onChange={onChange} />;
  case 'dependency':
    return <DependencyCell value={value} onChange={onChange} rowOptions={rowOptions ?? []} />;
  case 'files':
    return <FilesCell value={value} onChange={onChange} />;
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
  case 'unique_id':
    return (
      <div className="px-2 py-1 font-mono text-xs text-muted-foreground/80 tabular-nums" title="Assigned automatically">
        {formatUniqueId(value, property.idPrefix) || <span className="text-muted-foreground/40">—</span>}
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

/** A slim horizontal progress track filled to `frac` (0..1). The min-width
 *  keeps it legible in squeezed columns (e.g. an inline database in a doc). */
const ProgressBar: React.FC<{frac: number}> = ({frac}) => (
  <div className="h-1.5 min-w-10 flex-1 overflow-hidden rounded-full bg-muted" aria-hidden>
    <div className="h-full rounded-full bg-primary transition-[width]" style={{width: `${frac * 100}%`}} />
  </div>
);

/** A small circular progress ring filled to `frac` (0..1). */
const ProgressRing: React.FC<{frac: number}> = ({frac}) => {
  const r = 6;
  const c = 2 * Math.PI * r;
  return (
    <svg width={16} height={16} viewBox="0 0 16 16" className="shrink-0 -rotate-90" aria-hidden>
      <circle cx={8} cy={8} r={r} fill="none" strokeWidth={2} className="stroke-muted" />
      <circle
        cx={8}
        cy={8}
        r={r}
        fill="none"
        strokeWidth={2}
        strokeLinecap="round"
        className="stroke-primary transition-[stroke-dashoffset]"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - frac)}
      />
    </svg>
  );
};

/**
 * A number cell. Plain by default; when the property's `numberDisplay` is `bar`
 * or `ring` it pairs the editable input with a progress visual scaled to the
 * property's `numberTarget` (defaults to 100).
 */
const NumberCell: React.FC<Pick<PropertyValueCellProps, 'property' | 'value' | 'onChange'>> = ({
  property,
  value,
  onChange,
}) => {
  const input = (
    <input
      type="number"
      defaultValue={value === undefined || value === null ? '' : String(value)}
      onBlur={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
      className={cn(
        inputClass,
        'tabular-nums',
        property.numberDisplay === 'bar' && 'w-14 flex-none',
        property.numberDisplay === 'ring' && 'flex-1',
      )}
      placeholder="—"
      aria-label={property.name}
    />
  );
  if (property.numberDisplay !== 'bar' && property.numberDisplay !== 'ring') return input;
  const frac = numberProgress(value, property.numberTarget);
  return (
    <div className="flex items-center gap-2 pr-2" data-number-display={property.numberDisplay}>
      {property.numberDisplay === 'ring' && <span className="pl-2">{<ProgressRing frac={frac} />}</span>}
      {input}
      {property.numberDisplay === 'bar' && <ProgressBar frac={frac} />}
    </div>
  );
};

/** Rating cell: a row of clickable stars (0..max, default 5). Clicking the
 *  current value clears it; the stored value is a plain number. */
const RatingCell: React.FC<Pick<PropertyValueCellProps, 'property' | 'value' | 'onChange'>> = ({property, value, onChange}) => {
  const max = property.numberTarget && property.numberTarget > 0 ? Math.min(10, Math.round(property.numberTarget)) : 5;
  const current = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : 0;
  return (
    <div className="flex items-center gap-0.5 px-2 py-1" role="group" aria-label={property.name}>
      {Array.from({length: max}, (_, i) => i + 1).map((n) => (
        <button
          key={n}
          type="button"
          onClick={() => onChange(current === n ? null : n)}
          className={cn('text-base leading-none transition-colors', n <= current ? 'text-amber-400' : 'text-muted-foreground/30 hover:text-amber-400/60')}
          aria-label={`${n} ${n === 1 ? 'star' : 'stars'}`}
          aria-pressed={n <= current}
        >
          ★
        </button>
      ))}
    </div>
  );
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

/** Date cell — a single day, or a start→end range when the property is `dateRange`. */
const DateCell: React.FC<{property: DatabaseProperty; value: unknown; onChange: (value: unknown) => void}> = ({
  property,
  value,
  onChange,
}) => {
  const inputType = property.includeTime ? 'datetime-local' : 'date';
  const [editing, setEditing] = useState(false);
  const start = dateStart(value);
  const end = dateEnd(value);
  const hasValue = Boolean(start ?? end);

  // A dated cell reads as text — "12/06/2026", "In 3 days", "Jun 10 → Jun 13" —
  // until clicked, when the native picker(s) appear. Empty cells go straight to
  // the input so a date can be typed without an extra click.
  if (hasValue && !editing) {
    const text = formatCellValue(property, value);
    return (
      <button
        onClick={() => setEditing(true)}
        className="flex w-full items-center px-2 py-1 text-left text-sm outline-hidden hover:bg-accent/30"
        aria-label={property.name}
      >
        {text || <span className={emptyHint}>Empty</span>}
      </button>
    );
  }
  // Focusing the empty-state input also counts as editing (so a range being
  // filled in doesn't flip to text the moment its first half gets a value);
  // leaving the cell returns it to the text rendering.
  const enter = () => setEditing(true);
  const exit = () => setEditing(false);

  // `required` marks an *empty* native date input :invalid, which the CSS uses
  // to hide its dd/mm/yyyy scaffold until the row is hovered or it's focused
  // (date inputs have no placeholder to restyle). See `.ob-date-empty` rules.
  if (!property.dateRange) {
    return (
      <input
        type={inputType}
        autoFocus={editing}
        required={!start}
        defaultValue={start ?? ''}
        onFocus={enter}
        onChange={(e) => onChange(e.target.value || null)}
        onBlur={exit}
        className={cn(inputClass, 'ob-date-empty')}
        aria-label={property.name}
      />
    );
  }
  const emit = (next: DateRange) => onChange(next.start || next.end ? next : null);
  return (
    <div
      className="group/dates flex items-center gap-1 px-1 text-sm"
      onFocus={enter}
      onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && exit()}
    >
      <input
        type={inputType}
        autoFocus={editing}
        required={!start}
        defaultValue={start ?? ''}
        onChange={(e) => emit({start: e.target.value || null, end})}
        className="ob-date-empty bg-transparent py-1 outline-hidden focus:bg-accent/40"
        aria-label={`${property.name} start`}
      />
      {/* Visible whenever either end has a value, otherwise only on hover/edit. */}
      <span className={cn('text-muted-foreground/50', !start && !end && 'opacity-0 transition-opacity group-hover:opacity-100 group-focus-within/dates:opacity-100')}>→</span>
      <input
        type={inputType}
        required={!end}
        defaultValue={end ?? ''}
        onChange={(e) => emit({start, end: e.target.value || null})}
        className="ob-date-empty bg-transparent py-1 outline-hidden focus:bg-accent/40"
        aria-label={`${property.name} end`}
      />
    </div>
  );
};

/**
 * Dependency cell — links a row to other rows of the *same* database (e.g. a
 * task's predecessors). Like {@link RelationCell} but its candidates are the
 * supplied `rowOptions` (the database's rows) rather than every page.
 */
const DependencyCell: React.FC<{
  value: unknown;
  onChange: (value: unknown) => void;
  rowOptions: {id: string; label: string; icon?: string}[];
}> = ({value, onChange, rowOptions}) => {
  const ids = Array.isArray(value) ? (value as string[]) : [];
  const [query, setQuery] = useState('');
  const labelOf = (id: string) => rowOptions.find((o) => o.id === id)?.label ?? 'Untitled';
  // Snapshotted when the picker opens so live row updates don't re-render the
  // candidate buttons mid-pick (see RelationCell).
  const [open, setOpen] = useState(false);
  const [pool, setPool] = useState(rowOptions);
  const candidates = pool
    .filter((o) => !ids.includes(o.id))
    .filter((o) => (query ? o.label.toLowerCase().includes(query.toLowerCase()) : true));

  return (
    <div className="flex min-h-[28px] flex-wrap items-center gap-1 px-2 py-1">
      {ids.map((id) => (
        <span key={id} className="inline-flex max-w-full items-center gap-1 rounded-md border border-border/60 px-1.5 py-0.5 text-xs">
          <span className="max-w-[120px] truncate">{labelOf(id)}</span>
          <button
            type="button"
            onClick={() => onChange(ids.filter((x) => x !== id))}
            className="text-muted-foreground/70 transition-colors hover:text-destructive"
            aria-label="Remove dependency"
          >
            <X className="h-3 w-3" />
          </button>
        </span>
      ))}
      <Popover
        open={open}
        onOpenChange={(next) => {
          if (next) setPool(rowOptions);
          setOpen(next);
        }}
      >
        <PopoverTrigger asChild>
          <button
            type="button"
            className="rounded p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            aria-label="Add dependency"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-60 p-1">
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Depends on…"
            className="mb-1 w-full rounded bg-accent/40 px-1.5 py-1 text-sm outline-hidden"
          />
          <div className="max-h-52 overflow-y-auto">
            {candidates.length === 0 && <div className="px-1.5 py-1.5 text-xs text-muted-foreground">No other rows</div>}
            {candidates.map((o) => (
              <button
                key={o.id}
                type="button"
                onClick={() => {
                  onChange([...ids, o.id]);
                  setQuery('');
                }}
                className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-sm transition-colors hover:bg-accent"
              >
                {o.icon && <span className="leading-none">{o.icon}</span>}
                <span className="truncate">{o.label}</span>
              </button>
            ))}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
};

const fileName = (url: string): string => {
  try {
    const path = new URL(url).pathname;
    return decodeURIComponent(path.split('/').filter(Boolean).pop() || url);
  } catch {
    return url.split('/').filter(Boolean).pop() || url;
  }
};

/**
 * Files & media cell — a list of URLs. Image URLs render as thumbnails (click to
 * open); other URLs render as named file chips. Add via a small URL popover.
 * No upload backend: media is referenced by URL.
 */
const FilesCell: React.FC<{value: unknown; onChange: (value: unknown) => void}> = ({value, onChange}) => {
  const urls = Array.isArray(value) ? (value as string[]) : [];
  const [draft, setDraft] = useState('');
  const add = () => {
    const u = draft.trim();
    if (!u) return;
    onChange([...urls, u]);
    setDraft('');
  };
  const remove = (i: number) => onChange(urls.filter((_, idx) => idx !== i));

  return (
    <div className="flex min-h-[28px] flex-wrap items-center gap-1 px-2 py-1">
      {urls.map((url, i) =>
        isImageUrl(url) ? (
          <span key={i} className="group/file relative inline-block">
            <a href={url} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>
              <img src={url} alt="" className="h-7 w-7 rounded border border-border object-cover" />
            </a>
            <button
              type="button"
              onClick={() => remove(i)}
              className="absolute -right-1 -top-1 hidden rounded-full bg-background text-muted-foreground shadow group-hover/file:block hover:text-destructive"
              aria-label="Remove file"
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        ) : (
          <span key={i} className="inline-flex max-w-full items-center gap-1 rounded-md border border-border/60 px-1.5 py-0.5 text-xs">
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="max-w-[120px] truncate hover:text-foreground"
            >
              {fileName(url)}
            </a>
            <button type="button" onClick={() => remove(i)} className="text-muted-foreground/70 transition-colors hover:text-destructive" aria-label="Remove file">
              <X className="h-3 w-3" />
            </button>
          </span>
        ),
      )}
      <Popover>
        <PopoverTrigger asChild>
          <button type="button" className="rounded p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground" aria-label="Add file">
            <Plus className="h-3.5 w-3.5" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-64 p-1.5">
          <div className="flex items-center gap-1">
            <input
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && add()}
              placeholder="Image or file URL…"
              className="w-full rounded bg-accent/40 px-1.5 py-1 text-sm outline-hidden"
            />
            <IconButton size="sm" onClick={add} aria-label="Add file URL">
              <Plus className="h-3.5 w-3.5" />
            </IconButton>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
};

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
            <span className={emptyHint}>Empty</span>
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

  // The candidate pool is snapshotted when the picker opens: live page-list
  // events otherwise re-render the result buttons mid-pick, and the list
  // jumps under the pointer. (Chips above still resolve labels live.)
  const [open, setOpen] = useState(false);
  const [pool, setPool] = useState<ReturnType<typeof pageLinks.searchPages>>([]);
  const results = pool.filter(
    (r) => !ids.includes(r.id) && (query ? r.label.toLowerCase().includes(query.toLowerCase()) : true),
  );
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
      <Popover
        open={open}
        onOpenChange={(next) => {
          if (next) setPool(pageLinks.searchPages(''));
          setOpen(next);
        }}
      >
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
          {selected ? <SelectChip option={selected} /> : <span className={emptyHint}>Empty</span>}
          <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground/60 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100" />
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

/**
 * Status cell — a single-select whose options are bucketed into To-do /
 * In progress / Complete groups (the lifecycle `status` type). Renders a coloured
 * dot + label and groups the dropdown by lifecycle.
 */
const StatusCell: React.FC<{property: DatabaseProperty; value: unknown; onChange: (value: unknown) => void}> = ({
  property,
  value,
  onChange,
}) => {
  const selected = findOption(property, value);
  const options = property.options ?? [];
  const dot = (color?: string) => (
    <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{backgroundColor: SWATCH_HEX[color ?? 'gray'] ?? SWATCH_HEX.gray}} />
  );

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button className="flex w-full items-center justify-between gap-1 px-2 py-1 text-left text-sm hover:bg-accent/40">
          {selected ? (
            <span className="inline-flex items-center gap-1.5 text-xs">
              {dot(selected.color)}
              {selected.label}
            </span>
          ) : (
            <span className={emptyHint}>Empty</span>
          )}
          <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground/60 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        {STATUS_GROUPS.map((group) => {
          const opts = options.filter((o) => (o.group ?? 'todo') === group.id);
          if (opts.length === 0) return null;
          return (
            <React.Fragment key={group.id}>
              <div className="px-2 pb-0.5 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/60">
                {group.label}
              </div>
              {opts.map((o) => (
                <DropdownMenuItem key={o.id} onClick={() => onChange(o.id)} className="gap-2">
                  {dot(o.color)}
                  <span className="truncate">{o.label}</span>
                  {o.id === value && <Check className="ml-auto h-3.5 w-3.5" />}
                </DropdownMenuItem>
              ))}
            </React.Fragment>
          );
        })}
        {value != null && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => onChange(null)} className="text-muted-foreground">
              Clear
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
