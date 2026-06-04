import React, {useState} from 'react';
import {ArrowDownAZ, ArrowUpAZ, Filter, ListFilter, MoreHorizontal, Plus, Trash2} from 'lucide-react';
import {
  TITLE_PROPERTY_ID,
  type DatabaseFilter,
  type DatabasePropertyType,
  type DatabaseView,
  type FilterOperator,
  type StoredDatabase,
  shortId,
} from '@open-book/sdk';
import {Popover, PopoverContent, PopoverTrigger} from '@/components/ui/popover';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {cn} from '@/lib/utils';
import type {NewPropertyInput} from './useDatabase';

const PROPERTY_TYPES: {value: DatabasePropertyType; label: string}[] = [
  {value: 'text', label: 'Text'},
  {value: 'number', label: 'Number'},
  {value: 'select', label: 'Select'},
  {value: 'checkbox', label: 'Checkbox'},
  {value: 'date', label: 'Date'},
  {value: 'expr', label: 'Expression (exported cell)'},
];

const OPERATORS: {value: FilterOperator; label: string}[] = [
  {value: 'equals', label: 'is'},
  {value: 'not_equals', label: 'is not'},
  {value: 'contains', label: 'contains'},
  {value: 'not_contains', label: 'does not contain'},
  {value: 'gt', label: '>'},
  {value: 'lt', label: '<'},
  {value: 'gte', label: '≥'},
  {value: 'lte', label: '≤'},
  {value: 'is_empty', label: 'is empty'},
  {value: 'is_not_empty', label: 'is not empty'},
  {value: 'is_checked', label: 'is checked'},
  {value: 'is_unchecked', label: 'is unchecked'},
];

const VALUELESS = new Set<FilterOperator>(['is_empty', 'is_not_empty', 'is_checked', 'is_unchecked']);

const fieldClass = 'rounded border border-border bg-background px-1.5 py-1 text-sm outline-hidden';
const toolButtonClass =
  'flex items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground';

/** The `+` column header: add a new property to the database. */
export const AddPropertyMenu: React.FC<{onAdd: (input: NewPropertyInput) => void}> = ({onAdd}) => {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [type, setType] = useState<DatabasePropertyType>('text');
  const [options, setOptions] = useState('');
  const [cellName, setCellName] = useState('');

  const submit = () => {
    if (!name.trim()) return;
    onAdd({
      name,
      type,
      options: type === 'select' ? options.split(',') : undefined,
      cellName: type === 'expr' ? cellName : undefined,
    });
    setName('');
    setOptions('');
    setCellName('');
    setType('text');
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          className="flex h-full w-full items-center justify-center px-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          aria-label="Add property"
          title="Add a column"
        >
          <Plus className="h-4 w-4" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 space-y-2 p-3">
        <div className="text-xs font-semibold text-muted-foreground">New property</div>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          placeholder="Property name"
          className={cn(fieldClass, 'w-full')}
        />
        <select value={type} onChange={(e) => setType(e.target.value as DatabasePropertyType)} className={cn(fieldClass, 'w-full')}>
          {PROPERTY_TYPES.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
        {type === 'select' && (
          <input
            value={options}
            onChange={(e) => setOptions(e.target.value)}
            placeholder="Options, comma separated"
            className={cn(fieldClass, 'w-full')}
          />
        )}
        {type === 'expr' && (
          <input
            value={cellName}
            onChange={(e) => setCellName(e.target.value)}
            placeholder="Exported cell name (e.g. total)"
            className={cn(fieldClass, 'w-full')}
          />
        )}
        <button
          onClick={submit}
          className="w-full rounded bg-primary px-2 py-1.5 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
        >
          Add property
        </button>
      </PopoverContent>
    </Popover>
  );
};

/** Per-column header dropdown: delete the property. */
export const PropertyHeaderMenu: React.FC<{onDelete: () => void}> = ({onDelete}) => (
  <DropdownMenu>
    <DropdownMenuTrigger asChild>
      <button
        className="rounded p-0.5 text-muted-foreground/60 opacity-0 transition hover:bg-accent hover:text-foreground group-hover:opacity-100"
        aria-label="Property options"
      >
        <MoreHorizontal className="h-3.5 w-3.5" />
      </button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="start" className="w-40">
      <DropdownMenuItem onClick={onDelete} className="text-destructive focus:text-destructive">
        <Trash2 className="mr-2 h-3.5 w-3.5" />
        Delete property
      </DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>
);

interface MenuProps {
  database: StoredDatabase;
  view: DatabaseView;
  onChange: (patch: Partial<DatabaseView>) => void;
}

/** Property picker options including the reserved Title pseudo-property. */
const propertyChoices = (database: StoredDatabase) => [
  {id: TITLE_PROPERTY_ID, name: 'Title'},
  ...database.schema.properties.map((p) => ({id: p.id, name: p.name})),
];

/** Filter editor: AND-ed conditions applied to the current view. */
export const FilterMenu: React.FC<MenuProps> = ({database, view, onChange}) => {
  const choices = propertyChoices(database);
  const filters = view.filters ?? [];

  const addFilter = () => {
    const filter: DatabaseFilter = {id: shortId('flt'), propertyId: choices[0].id, operator: 'contains', value: ''};
    onChange({filters: [...filters, filter]});
  };
  const setFilter = (id: string, patch: Partial<DatabaseFilter>) =>
    onChange({filters: filters.map((f) => (f.id === id ? {...f, ...patch} : f))});
  const removeFilter = (id: string) => onChange({filters: filters.filter((f) => f.id !== id)});

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button className={cn(toolButtonClass, filters.length > 0 && 'text-foreground')}>
          <Filter className="h-3.5 w-3.5" />
          Filter{filters.length > 0 ? ` (${filters.length})` : ''}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[22rem] space-y-2 p-3">
        {filters.length === 0 && <div className="text-xs text-muted-foreground">No filters yet.</div>}
        {filters.map((filter) => (
          <div key={filter.id} className="flex items-center gap-1">
            <select value={filter.propertyId} onChange={(e) => setFilter(filter.id, {propertyId: e.target.value})} className={cn(fieldClass, 'min-w-0 flex-1')}>
              {choices.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <select value={filter.operator} onChange={(e) => setFilter(filter.id, {operator: e.target.value as FilterOperator})} className={cn(fieldClass, 'min-w-0 flex-1')}>
              {OPERATORS.map((op) => (
                <option key={op.value} value={op.value}>
                  {op.label}
                </option>
              ))}
            </select>
            {!VALUELESS.has(filter.operator) && (
              <input
                value={typeof filter.value === 'string' || typeof filter.value === 'number' ? String(filter.value) : ''}
                onChange={(e) => setFilter(filter.id, {value: e.target.value})}
                placeholder="value"
                className={cn(fieldClass, 'w-20')}
              />
            )}
            <button onClick={() => removeFilter(filter.id)} className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground" aria-label="Remove filter">
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
        <button onClick={addFilter} className={cn(toolButtonClass, 'w-full justify-center border border-dashed border-border')}>
          <Plus className="h-3.5 w-3.5" /> Add filter
        </button>
      </PopoverContent>
    </Popover>
  );
};

/** Sort editor: ordered sort keys applied to the current view. */
export const SortMenu: React.FC<MenuProps> = ({database, view, onChange}) => {
  const choices = propertyChoices(database);
  const sorts = view.sorts ?? [];

  const addSort = () => onChange({sorts: [...sorts, {propertyId: choices[0].id, direction: 'asc'}]});
  const setSort = (index: number, patch: Partial<(typeof sorts)[number]>) =>
    onChange({sorts: sorts.map((s, i) => (i === index ? {...s, ...patch} : s))});
  const removeSort = (index: number) => onChange({sorts: sorts.filter((_, i) => i !== index)});

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button className={cn(toolButtonClass, sorts.length > 0 && 'text-foreground')}>
          <ListFilter className="h-3.5 w-3.5" />
          Sort{sorts.length > 0 ? ` (${sorts.length})` : ''}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 space-y-2 p-3">
        {sorts.length === 0 && <div className="text-xs text-muted-foreground">No sorts yet.</div>}
        {sorts.map((sort, index) => (
          <div key={index} className="flex items-center gap-1">
            <select value={sort.propertyId} onChange={(e) => setSort(index, {propertyId: e.target.value})} className={cn(fieldClass, 'min-w-0 flex-1')}>
              {choices.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <button
              onClick={() => setSort(index, {direction: sort.direction === 'asc' ? 'desc' : 'asc'})}
              className={cn(fieldClass, 'flex items-center gap-1')}
              title={sort.direction === 'asc' ? 'Ascending' : 'Descending'}
            >
              {sort.direction === 'asc' ? <ArrowDownAZ className="h-3.5 w-3.5" /> : <ArrowUpAZ className="h-3.5 w-3.5" />}
            </button>
            <button onClick={() => removeSort(index)} className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground" aria-label="Remove sort">
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
        <button onClick={addSort} className={cn(toolButtonClass, 'w-full justify-center border border-dashed border-border')}>
          <Plus className="h-3.5 w-3.5" /> Add sort
        </button>
      </PopoverContent>
    </Popover>
  );
};
