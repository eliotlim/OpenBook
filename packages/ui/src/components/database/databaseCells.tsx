import React, {useState} from 'react';
import {Check, ChevronDown, Plus} from 'lucide-react';
import type {DatabaseProperty, DatabaseSelectOption} from '@open-book/sdk';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {IconButton} from '@/components/ui/icon-button';
import {cn} from '@/lib/utils';

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
