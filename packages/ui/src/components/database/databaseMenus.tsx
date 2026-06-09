import React, {useState} from 'react';
import {
  ArrowDownAZ,
  ArrowLeft,
  ArrowRight,
  ArrowUpAZ,
  BarChart3,
  Calendar,
  ChevronDown,
  Columns3,
  Filter,
  GanttChartSquare,
  LayoutGrid,
  List,
  ListFilter,
  MoreHorizontal,
  PieChart,
  Plus,
  Settings2,
  Sigma,
  Table2,
  Trash2,
} from 'lucide-react';
import {
  SELECT_COLORS,
  TITLE_PROPERTY_ID,
  shortId,
  type ChartAggregate,
  type DatabaseFilter,
  type DatabaseProperty,
  type DatabasePropertyType,
  type DatabaseSelectOption,
  type DatabaseView,
  type DatabaseViewType,
  type FilterOperator,
  type NumberFormat,
  type StoredDatabase,
  type SummaryType,
} from '@open-book/sdk';
import {Popover, PopoverContent, PopoverTrigger} from '@/components/ui/popover';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {IconButton} from '@/components/ui/icon-button';
import {cn} from '@/lib/utils';
import {SWATCH_HEX} from './databaseColors';
import type {NewPropertyInput, UseDatabase} from './useDatabase';

const PROPERTY_TYPES: {value: DatabasePropertyType; label: string}[] = [
  {value: 'text', label: 'Text'},
  {value: 'number', label: 'Number'},
  {value: 'select', label: 'Select'},
  {value: 'multi_select', label: 'Multi-select'},
  {value: 'checkbox', label: 'Checkbox'},
  {value: 'date', label: 'Date'},
  {value: 'url', label: 'URL'},
  {value: 'email', label: 'Email'},
  {value: 'phone', label: 'Phone'},
  {value: 'relation', label: 'Relation (link pages)'},
  {value: 'dependency', label: 'Dependency (link rows)'},
  {value: 'person', label: 'Person'},
  {value: 'verification', label: 'Verification'},
  {value: 'created_time', label: 'Created time'},
  {value: 'last_edited_time', label: 'Last edited time'},
  {value: 'formula', label: 'Formula'},
  {value: 'expr', label: 'Expression (exported cell)'},
];

const NUMBER_FORMATS: {value: NumberFormat; label: string}[] = [
  {value: 'plain', label: 'Plain'},
  {value: 'integer', label: 'Integer (1,234)'},
  {value: 'decimal', label: 'Decimal (1,234.00)'},
  {value: 'percent', label: 'Percent (12%)'},
  {value: 'dollar', label: 'Dollar ($)'},
  {value: 'euro', label: 'Euro (€)'},
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

/** Per-view-type display metadata (icon + label), shared by the toolbar + menus. */
export const VIEW_TYPES: {value: DatabaseViewType; label: string; Icon: React.ComponentType<{className?: string}>}[] = [
  {value: 'table', label: 'Table', Icon: Table2},
  {value: 'board', label: 'Board', Icon: Columns3},
  {value: 'gallery', label: 'Gallery', Icon: LayoutGrid},
  {value: 'list', label: 'List', Icon: List},
  {value: 'calendar', label: 'Calendar', Icon: Calendar},
  {value: 'timeline', label: 'Timeline', Icon: GanttChartSquare},
  {value: 'bar', label: 'Bar chart', Icon: BarChart3},
  {value: 'pie', label: 'Pie chart', Icon: PieChart},
];

export const viewIcon = (type: DatabaseViewType): React.ComponentType<{className?: string}> =>
  VIEW_TYPES.find((v) => v.value === type)?.Icon ?? Table2;

const fieldClass = 'rounded border border-border bg-background px-1.5 py-1 text-sm outline-hidden';
const toolButtonClass =
  'flex items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground';
const sectionLabel = 'text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/70';

/** The `+` column header: add a new property to the database. */
export const AddPropertyMenu: React.FC<{onAdd: (input: NewPropertyInput) => void}> = ({onAdd}) => {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [type, setType] = useState<DatabasePropertyType>('text');
  const [options, setOptions] = useState('');
  const [cellName, setCellName] = useState('');
  const [formula, setFormula] = useState('');
  const [numberFormat, setNumberFormat] = useState<NumberFormat>('plain');
  const [dateRange, setDateRange] = useState(false);
  const [description, setDescription] = useState('');

  const numeric = type === 'number' || type === 'formula' || type === 'expr';

  const submit = () => {
    if (!name.trim()) return;
    onAdd({
      name,
      type,
      options: type === 'select' || type === 'multi_select' ? options.split(',') : undefined,
      cellName: type === 'expr' ? cellName : undefined,
      formula: type === 'formula' ? formula : undefined,
      numberFormat: numeric && numberFormat !== 'plain' ? numberFormat : undefined,
      dateRange: type === 'date' && dateRange ? true : undefined,
      description: description.trim() || undefined,
    });
    setName('');
    setOptions('');
    setCellName('');
    setFormula('');
    setNumberFormat('plain');
    setDateRange(false);
    setDescription('');
    setType('text');
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          className="flex h-full w-full items-center justify-center px-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          aria-label="Add column"
          title="Add a column"
        >
          <Plus className="h-4 w-4" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 space-y-2 p-3">
        <div className={sectionLabel}>New property</div>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && type !== 'formula' && submit()}
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
        {(type === 'select' || type === 'multi_select') && (
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
        {type === 'formula' && (
          <>
            <textarea
              value={formula}
              onChange={(e) => setFormula(e.target.value)}
              placeholder={'e.g. prop("Price") * prop("Qty")'}
              rows={2}
              className={cn(fieldClass, 'w-full font-mono text-xs')}
            />
            <FormulaHint />
          </>
        )}
        {numeric && (
          <select value={numberFormat} onChange={(e) => setNumberFormat(e.target.value as NumberFormat)} className={cn(fieldClass, 'w-full')}>
            {NUMBER_FORMATS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>
        )}
        {type === 'date' && (
          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <input type="checkbox" checked={dateRange} onChange={(e) => setDateRange(e.target.checked)} className="h-3.5 w-3.5 accent-primary" />
            End date (range)
          </label>
        )}
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Description (optional)"
          className={cn(fieldClass, 'w-full')}
        />
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

const FormulaHint: React.FC = () => (
  <div className="rounded bg-muted/50 px-2 py-1.5 text-[11px] leading-relaxed text-muted-foreground">
    Reference other columns by name: <code>prop(&quot;Name&quot;)</code> or a bare word. Use <code>+ - * /</code>,{' '}
    <code>if(c, a, b)</code>, <code>round</code>, <code>concat</code>, <code>min</code>, <code>max</code>.
  </div>
);

/** A colored dot that opens a swatch grid to recolor a select option. */
const ColorSwatch: React.FC<{value?: string; onChange: (color: string) => void}> = ({value, onChange}) => (
  <Popover>
    <PopoverTrigger asChild>
      <button
        type="button"
        className="h-5 w-5 shrink-0 rounded-full border border-black/10 transition-transform hover:scale-110 dark:border-white/15"
        style={{backgroundColor: SWATCH_HEX[value ?? 'gray']}}
        aria-label="Option color"
        title={value ?? 'gray'}
      />
    </PopoverTrigger>
    <PopoverContent align="start" className="w-auto p-2">
      <div className="grid grid-cols-5 gap-1.5">
        {SELECT_COLORS.map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => onChange(c)}
            title={c}
            aria-label={c}
            className={cn(
              'h-5 w-5 rounded-full border border-black/10 transition-transform hover:scale-110 dark:border-white/15',
              (value ?? 'gray') === c && 'ring-2 ring-foreground/50 ring-offset-1',
            )}
            style={{backgroundColor: SWATCH_HEX[c]}}
          />
        ))}
      </div>
    </PopoverContent>
  </Popover>
);

/** Inline editor for one `select`/`multi_select` property's options. */
const OptionsEditor: React.FC<{property: DatabaseProperty; db: UseDatabase}> = ({property, db}) => {
  const [draft, setDraft] = useState('');
  const options = property.options ?? [];

  const setOption = (id: string, patch: Partial<DatabaseSelectOption>) =>
    void db.updateProperty(property.id, {options: options.map((o) => (o.id === id ? {...o, ...patch} : o))});
  const removeOption = (id: string) =>
    void db.updateProperty(property.id, {options: options.filter((o) => o.id !== id)});
  const addOption = () => {
    const label = draft.trim();
    if (!label) return;
    const option: DatabaseSelectOption = {id: shortId('opt'), label, color: SELECT_COLORS[options.length % SELECT_COLORS.length]};
    void db.updateProperty(property.id, {options: [...options, option]});
    setDraft('');
  };

  return (
    <div className="space-y-1.5">
      <div className={sectionLabel}>Options</div>
      {options.map((option) => (
        <div key={option.id} className="flex items-center gap-1">
          <ColorSwatch value={option.color} onChange={(color) => setOption(option.id, {color})} />
          <input
            defaultValue={option.label}
            onBlur={(e) => e.target.value.trim() && setOption(option.id, {label: e.target.value.trim()})}
            className={cn(fieldClass, 'min-w-0 flex-1')}
          />
          <IconButton size="sm" onClick={() => removeOption(option.id)} aria-label="Remove option">
            <Trash2 className="h-3.5 w-3.5" />
          </IconButton>
        </div>
      ))}
      <div className="flex items-center gap-1">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && addOption()}
          placeholder="New option…"
          className={cn(fieldClass, 'min-w-0 flex-1')}
        />
        <IconButton size="sm" onClick={addOption} aria-label="Add option">
          <Plus className="h-3.5 w-3.5" />
        </IconButton>
      </div>
    </div>
  );
};

/**
 * Per-column header editor: rename, change type, edit select options / formula /
 * number format, reorder, and delete the property. Opens from the `⋯` in a
 * column header.
 */
export const PropertyMenu: React.FC<{property: DatabaseProperty; db: UseDatabase; index: number; count: number}> = ({
  property,
  db,
  index,
  count,
}) => {
  const [open, setOpen] = useState(false);
  const numeric = property.type === 'number' || property.type === 'formula' || property.type === 'expr';

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          className="rounded p-0.5 text-muted-foreground/60 opacity-0 transition hover:bg-accent hover:text-foreground group-hover:opacity-100 data-[state=open]:opacity-100"
          aria-label="Property options"
        >
          <MoreHorizontal className="h-3.5 w-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 space-y-2 p-2.5">
        <input
          defaultValue={property.name}
          onBlur={(e) => e.target.value.trim() !== property.name && db.updateProperty(property.id, {name: e.target.value})}
          className={cn(fieldClass, 'w-full font-medium')}
          aria-label="Property name"
        />
        <select
          value={property.type}
          onChange={(e) => void db.updateProperty(property.id, {type: e.target.value as DatabasePropertyType})}
          className={cn(fieldClass, 'w-full')}
        >
          {PROPERTY_TYPES.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>

        {(property.type === 'select' || property.type === 'multi_select') && <OptionsEditor property={property} db={db} />}

        {property.type === 'formula' && (
          <>
            <textarea
              defaultValue={property.formula ?? ''}
              onBlur={(e) => db.updateProperty(property.id, {formula: e.target.value})}
              rows={2}
              placeholder={'prop("Price") * prop("Qty")'}
              className={cn(fieldClass, 'w-full font-mono text-xs')}
            />
            <FormulaHint />
          </>
        )}

        {property.type === 'expr' && (
          <input
            defaultValue={property.cellName ?? ''}
            onBlur={(e) => db.updateProperty(property.id, {cellName: e.target.value})}
            placeholder="Exported cell name"
            className={cn(fieldClass, 'w-full')}
          />
        )}

        {property.type === 'date' && (
          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={!!property.dateRange}
              onChange={(e) => void db.updateProperty(property.id, {dateRange: e.target.checked})}
              className="h-3.5 w-3.5 accent-primary"
            />
            End date (range)
          </label>
        )}

        {numeric && (
          <select
            value={property.numberFormat ?? 'plain'}
            onChange={(e) => void db.updateProperty(property.id, {numberFormat: e.target.value as NumberFormat})}
            className={cn(fieldClass, 'w-full')}
          >
            {NUMBER_FORMATS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>
        )}

        <input
          defaultValue={property.description ?? ''}
          onBlur={(e) => e.target.value !== (property.description ?? '') && db.updateProperty(property.id, {description: e.target.value})}
          placeholder="Description"
          className={cn(fieldClass, 'w-full text-xs')}
        />

        <div className="flex items-center gap-1 border-t border-border pt-2">
          <button
            disabled={index <= 0}
            onClick={() => void db.moveProperty(property.id, -1)}
            className={cn(toolButtonClass, 'flex-1 justify-center disabled:opacity-30')}
          >
            <ArrowLeft className="h-3.5 w-3.5" /> Left
          </button>
          <button
            disabled={index >= count - 1}
            onClick={() => void db.moveProperty(property.id, 1)}
            className={cn(toolButtonClass, 'flex-1 justify-center disabled:opacity-30')}
          >
            Right <ArrowRight className="h-3.5 w-3.5" />
          </button>
        </div>
        <button
          onClick={() => {
            setOpen(false);
            void db.deleteProperty(property.id);
          }}
          className={cn(toolButtonClass, 'w-full justify-center text-destructive hover:text-destructive')}
        >
          <Trash2 className="h-3.5 w-3.5" /> Delete property
        </button>
      </PopoverContent>
    </Popover>
  );
};

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
            <IconButton size="sm" onClick={() => removeFilter(filter.id)} aria-label="Remove filter">
              <Trash2 className="h-3.5 w-3.5" />
            </IconButton>
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
            <IconButton size="sm" onClick={() => removeSort(index)} aria-label="Remove sort">
              <Trash2 className="h-3.5 w-3.5" />
            </IconButton>
          </div>
        ))}
        <button onClick={addSort} className={cn(toolButtonClass, 'w-full justify-center border border-dashed border-border')}>
          <Plus className="h-3.5 w-3.5" /> Add sort
        </button>
      </PopoverContent>
    </Popover>
  );
};

const SUMMARY_TYPES: {value: SummaryType; label: string}[] = [
  {value: 'none', label: 'None'},
  {value: 'count_all', label: 'Count all'},
  {value: 'count_values', label: 'Count values'},
  {value: 'count_unique', label: 'Count unique'},
  {value: 'count_empty', label: 'Count empty'},
  {value: 'count_filled', label: 'Count filled'},
  {value: 'percent_empty', label: 'Percent empty'},
  {value: 'percent_filled', label: 'Percent filled'},
  {value: 'sum', label: 'Sum'},
  {value: 'avg', label: 'Average'},
  {value: 'min', label: 'Min'},
  {value: 'max', label: 'Max'},
  {value: 'range', label: 'Range'},
  {value: 'median', label: 'Median'},
];

/**
 * A table column-footer summary control: shows the computed value (`display`)
 * and, on click, a menu to choose the calculation (count/sum/avg/…). Shows a
 * subtle "Calculate" affordance on hover when no summary is set.
 */
export const SummaryPicker: React.FC<{current: SummaryType; display: string; onChange: (t: SummaryType) => void}> = ({
  current,
  display,
  onChange,
}) => (
  <DropdownMenu>
    <DropdownMenuTrigger asChild>
      <button className="group/sum flex w-full items-center justify-end gap-1 px-2 py-1 text-right text-xs text-muted-foreground transition-colors hover:text-foreground">
        {current === 'none' ? (
          <span className="flex items-center gap-1 opacity-0 transition-opacity group-hover/sum:opacity-100">
            <Sigma className="h-3 w-3" /> Calculate
          </span>
        ) : (
          <span className="flex items-center gap-1 tabular-nums">
            <span className="text-muted-foreground/60">{SUMMARY_TYPES.find((s) => s.value === current)?.label}</span>
            <span className="font-medium text-foreground/80">{display}</span>
            <ChevronDown className="h-3 w-3 opacity-0 transition-opacity group-hover/sum:opacity-100" />
          </span>
        )}
      </button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end" className="max-h-72 w-44 overflow-y-auto">
      {SUMMARY_TYPES.map((s) => (
        <DropdownMenuItem key={s.value} onClick={() => onChange(s.value)} className={cn(s.value === current && 'font-medium')}>
          {s.label}
        </DropdownMenuItem>
      ))}
    </DropdownMenuContent>
  </DropdownMenu>
);

/** The `+` next to the view tabs: add a new view of a chosen layout. */
export const AddViewMenu: React.FC<{onAdd: (type: DatabaseViewType) => void}> = ({onAdd}) => (
  <DropdownMenu>
    <DropdownMenuTrigger asChild>
      <button className="flex items-center gap-1 rounded px-1.5 py-1 text-sm text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground" aria-label="Add view">
        <Plus className="h-3.5 w-3.5" />
      </button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="start" className="w-44">
      {VIEW_TYPES.map(({value, label, Icon}) => (
        <DropdownMenuItem key={value} onClick={() => onAdd(value)}>
          <Icon className="mr-2 h-4 w-4" />
          {label}
        </DropdownMenuItem>
      ))}
    </DropdownMenuContent>
  </DropdownMenu>
);

/**
 * The active view's settings: rename, switch layout, configure layout-specific
 * options (board/chart grouping, chart aggregation, calendar date, visible
 * columns), duplicate, and delete.
 */
export const ViewOptionsMenu: React.FC<{db: UseDatabase; view: DatabaseView}> = ({db, view}) => {
  const properties = db.database!.schema.properties;
  const groupable = properties; // any property can group
  const numericProps = properties.filter((p) => p.type === 'number' || p.type === 'formula' || p.type === 'expr');
  const dateProps = properties.filter((p) => p.type === 'date' || p.type === 'created_time' || p.type === 'last_edited_time');
  const aggregate: ChartAggregate = view.aggregate ?? {type: 'count'};
  const visible = view.visiblePropertyIds && view.visiblePropertyIds.length > 0 ? view.visiblePropertyIds : null;

  const isVisible = (id: string): boolean => (visible ? visible.includes(id) : true);
  const toggleVisible = (id: string): void => {
    const shown = properties.filter((p) => (visible ? visible.includes(p.id) : true)).map((p) => p.id);
    const next = shown.includes(id) ? shown.filter((x) => x !== id) : [...shown, id];
    db.updateView(view.id, {visiblePropertyIds: next});
  };

  const showGroup = view.type === 'board' || view.type === 'bar' || view.type === 'pie' || view.type === 'table';
  const showChart = view.type === 'bar' || view.type === 'pie';
  const showDate = view.type === 'calendar' || view.type === 'timeline';
  const showTimeline = view.type === 'timeline';
  const dependencyProps = properties.filter((p) => p.type === 'dependency');
  const showColumns = view.type === 'table' || view.type === 'list' || view.type === 'gallery';

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button className={toolButtonClass} aria-label="View options">
          <Settings2 className="h-3.5 w-3.5" />
          View
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 space-y-2.5 p-3">
        <input
          defaultValue={view.name}
          onBlur={(e) => e.target.value.trim() && e.target.value.trim() !== view.name && db.renameView(view.id, e.target.value)}
          className={cn(fieldClass, 'w-full font-medium')}
          aria-label="View name"
        />

        <div>
          <div className={cn(sectionLabel, 'mb-1')}>Layout</div>
          <div className="grid grid-cols-4 gap-1">
            {VIEW_TYPES.map(({value, label, Icon}) => (
              <button
                key={value}
                onClick={() => db.updateView(view.id, viewTypePatch(value, view, properties))}
                title={label}
                className={cn(
                  'flex flex-col items-center gap-1 rounded border px-1 py-1.5 text-[10px] transition-colors',
                  view.type === value ? 'border-brand/50 bg-accent text-foreground' : 'border-border text-muted-foreground hover:bg-accent/50',
                )}
              >
                <Icon className="h-4 w-4" />
                {label.split(' ')[0]}
              </button>
            ))}
          </div>
        </div>

        {showGroup && (
          <label className="block">
            <span className={sectionLabel}>Group by</span>
            <select
              value={view.groupByPropertyId ?? ''}
              onChange={(e) => db.updateView(view.id, {groupByPropertyId: e.target.value || undefined})}
              className={cn(fieldClass, 'mt-1 w-full')}
            >
              <option value="">—</option>
              {groupable.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        )}

        {showChart && (
          <div className="flex gap-1">
            <label className="flex-1">
              <span className={sectionLabel}>Measure</span>
              <select
                value={aggregate.type}
                onChange={(e) => db.updateView(view.id, {aggregate: {...aggregate, type: e.target.value as ChartAggregate['type']}})}
                className={cn(fieldClass, 'mt-1 w-full')}
              >
                {(['count', 'sum', 'avg', 'min', 'max'] as const).map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </label>
            {aggregate.type !== 'count' && (
              <label className="flex-1">
                <span className={sectionLabel}>Of</span>
                <select
                  value={aggregate.propertyId ?? ''}
                  onChange={(e) => db.updateView(view.id, {aggregate: {...aggregate, propertyId: e.target.value || undefined}})}
                  className={cn(fieldClass, 'mt-1 w-full')}
                >
                  <option value="">—</option>
                  {numericProps.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
        )}

        {showDate && (
          <label className="block">
            <span className={sectionLabel}>{showTimeline ? 'Start date' : 'Date property'}</span>
            <select
              value={view.datePropertyId ?? ''}
              onChange={(e) => db.updateView(view.id, {datePropertyId: e.target.value || undefined})}
              className={cn(fieldClass, 'mt-1 w-full')}
            >
              <option value="">—</option>
              {dateProps.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        )}

        {showTimeline && (
          <>
            <label className="block">
              <span className={sectionLabel}>End date</span>
              <select
                value={view.endDatePropertyId ?? ''}
                onChange={(e) => db.updateView(view.id, {endDatePropertyId: e.target.value || undefined})}
                className={cn(fieldClass, 'mt-1 w-full')}
              >
                <option value="">Same as start (or range end)</option>
                {dateProps
                  .filter((p) => p.id !== view.datePropertyId)
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
              </select>
            </label>
            <label className="block">
              <span className={sectionLabel}>Dependencies</span>
              <select
                value={view.dependencyPropertyId ?? ''}
                onChange={(e) => db.updateView(view.id, {dependencyPropertyId: e.target.value || undefined})}
                className={cn(fieldClass, 'mt-1 w-full')}
              >
                <option value="">—</option>
                {dependencyProps.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}

        {showColumns && properties.length > 0 && (
          <div>
            <div className={cn(sectionLabel, 'mb-1')}>Properties</div>
            <div className="max-h-40 space-y-0.5 overflow-y-auto">
              {properties.map((p) => (
                <label key={p.id} className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-sm hover:bg-accent/40">
                  <input type="checkbox" checked={isVisible(p.id)} onChange={() => toggleVisible(p.id)} className="h-3.5 w-3.5 accent-primary" />
                  <span className="truncate">{p.name}</span>
                </label>
              ))}
            </div>
          </div>
        )}

        <div className="flex items-center gap-1 border-t border-border pt-2">
          <button onClick={() => void db.duplicateView(view.id)} className={cn(toolButtonClass, 'flex-1 justify-center')}>
            Duplicate
          </button>
          <button
            onClick={() => void db.deleteView(view.id)}
            disabled={db.database!.schema.views.length <= 1}
            className={cn(toolButtonClass, 'flex-1 justify-center text-destructive hover:text-destructive disabled:opacity-30')}
          >
            <Trash2 className="h-3.5 w-3.5" /> Delete
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
};

/** Build the patch for switching a view's layout, defaulting layout-specific config. */
function viewTypePatch(type: DatabaseViewType, view: DatabaseView, properties: DatabaseProperty[]): Partial<DatabaseView> {
  const patch: Partial<DatabaseView> = {type};
  if ((type === 'board' || type === 'bar' || type === 'pie') && !view.groupByPropertyId) {
    const select = properties.find((p) => p.type === 'select');
    patch.groupByPropertyId = (select ?? properties[0])?.id;
  }
  if ((type === 'calendar' || type === 'timeline') && !view.datePropertyId) {
    patch.datePropertyId = properties.find((p) => p.type === 'date' || p.type === 'created_time' || p.type === 'last_edited_time')?.id;
  }
  if (type === 'timeline') {
    const dates = properties.filter((p) => p.type === 'date');
    if (!view.endDatePropertyId && dates.length >= 2 && !dates[0].dateRange) patch.endDatePropertyId = dates[1].id;
    if (!view.dependencyPropertyId) patch.dependencyPropertyId = properties.find((p) => p.type === 'dependency')?.id;
  }
  return patch;
}
