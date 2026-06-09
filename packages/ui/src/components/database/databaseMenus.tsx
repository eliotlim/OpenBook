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
  Copy,
  Download,
  EyeOff,
  Filter,
  GanttChartSquare,
  GripVertical,
  LayoutGrid,
  Link2,
  List,
  ListFilter,
  MoreHorizontal,
  PieChart,
  Plus,
  Settings2,
  Sigma,
  Table2,
  Trash2,
  Upload,
  Workflow,
  X,
} from 'lucide-react';
import {
  isFilterGroup,
  RELATIVE_DATE_OPS,
  SELECT_COLORS,
  STATUS_GROUPS,
  TITLE_PROPERTY_ID,
  shortId,
  summarizeColumn,
  type ChartAggregate,
  type ColorRule,
  type DatabaseMetric,
  type DatabaseFilter,
  type DatabaseFilterGroup,
  type FilterNode,
  type DatabaseProperty,
  type DatabasePropertyType,
  type NumberDisplay,
  type DatabaseSelectOption,
  type DatabaseView,
  type DatabaseViewType,
  type FilterOperator,
  type NumberFormat,
  type RollupConfig,
  type RollupFunction,
  type StatusGroup,
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
import {downloadText, safeFilename} from '@/lib/download';
import {SWATCH_HEX} from './databaseColors';
import {rowsToCsv} from './databaseCells';
import type {NewPropertyInput, UseDatabase} from './useDatabase';

const PROPERTY_TYPES: {value: DatabasePropertyType; label: string}[] = [
  {value: 'text', label: 'Text'},
  {value: 'number', label: 'Number'},
  {value: 'rating', label: 'Rating'},
  {value: 'select', label: 'Select'},
  {value: 'multi_select', label: 'Multi-select'},
  {value: 'status', label: 'Status'},
  {value: 'checkbox', label: 'Checkbox'},
  {value: 'date', label: 'Date'},
  {value: 'url', label: 'URL'},
  {value: 'email', label: 'Email'},
  {value: 'phone', label: 'Phone'},
  {value: 'files', label: 'Files & media'},
  {value: 'relation', label: 'Relation (link pages)'},
  {value: 'dependency', label: 'Dependency (link rows)'},
  {value: 'rollup', label: 'Rollup'},
  {value: 'person', label: 'Person'},
  {value: 'verification', label: 'Verification'},
  {value: 'created_time', label: 'Created time'},
  {value: 'last_edited_time', label: 'Last edited time'},
  {value: 'unique_id', label: 'Unique ID'},
  {value: 'formula', label: 'Formula'},
  {value: 'expr', label: 'Expression (exported cell)'},
];

const ROLLUP_FUNCTIONS: {value: RollupFunction; label: string}[] = [
  {value: 'show_original', label: 'Show original'},
  {value: 'count', label: 'Count'},
  {value: 'count_values', label: 'Count values'},
  {value: 'count_unique', label: 'Count unique'},
  {value: 'sum', label: 'Sum'},
  {value: 'avg', label: 'Average'},
  {value: 'min', label: 'Min'},
  {value: 'max', label: 'Max'},
  {value: 'range', label: 'Range'},
  {value: 'median', label: 'Median'},
  {value: 'checked', label: 'Checked'},
  {value: 'percent_checked', label: 'Percent checked'},
];

const NUMBER_FORMATS: {value: NumberFormat; label: string}[] = [
  {value: 'plain', label: 'Plain'},
  {value: 'integer', label: 'Integer (1,234)'},
  {value: 'decimal', label: 'Decimal (1,234.00)'},
  {value: 'percent', label: 'Percent (12%)'},
  {value: 'dollar', label: 'Dollar ($)'},
  {value: 'euro', label: 'Euro (€)'},
  {value: 'pound', label: 'Pound (£)'},
  {value: 'yen', label: 'Yen (¥)'},
  {value: 'rupee', label: 'Rupee (₹)'},
];

const NUMBER_DISPLAYS: {value: NumberDisplay; label: string}[] = [
  {value: 'number', label: 'Number'},
  {value: 'bar', label: 'Bar'},
  {value: 'ring', label: 'Ring'},
];

const OPERATOR_LABEL: Record<FilterOperator, string> = {
  equals: 'is',
  not_equals: 'is not',
  contains: 'contains',
  not_contains: 'does not contain',
  starts_with: 'starts with',
  ends_with: 'ends with',
  gt: '>',
  lt: '<',
  gte: '≥',
  lte: '≤',
  before: 'is before',
  after: 'is after',
  on_or_before: 'is on or before',
  on_or_after: 'is on or after',
  is_today: 'is today',
  is_this_week: 'is this week',
  is_past_week: 'is in the past week',
  is_next_week: 'is in the next week',
  is_this_month: 'is this month',
  is_empty: 'is empty',
  is_not_empty: 'is not empty',
  is_checked: 'is checked',
  is_unchecked: 'is unchecked',
};

const VALUELESS = new Set<FilterOperator>([
  'is_empty',
  'is_not_empty',
  'is_checked',
  'is_unchecked',
  ...RELATIVE_DATE_OPS,
]);
const DATE_OPS = new Set<FilterOperator>(['before', 'after', 'on_or_before', 'on_or_after']);

/** The operators that make sense for a property's type (Title → text operators). */
function operatorsFor(type: DatabasePropertyType | undefined): FilterOperator[] {
  switch (type) {
  case 'checkbox':
  case 'verification':
    return ['is_checked', 'is_unchecked'];
  case 'number':
  case 'rating':
  case 'formula':
  case 'rollup':
  case 'expr':
    return ['equals', 'not_equals', 'gt', 'lt', 'gte', 'lte', 'is_empty', 'is_not_empty'];
  case 'date':
  case 'created_time':
  case 'last_edited_time':
    return [
      'equals',
      'before',
      'after',
      'on_or_before',
      'on_or_after',
      'is_today',
      'is_this_week',
      'is_past_week',
      'is_next_week',
      'is_this_month',
      'is_empty',
      'is_not_empty',
    ];
  case 'select':
  case 'status':
    return ['equals', 'not_equals', 'is_empty', 'is_not_empty'];
  case 'multi_select':
  case 'relation':
  case 'dependency':
  case 'files':
    return ['contains', 'not_contains', 'is_empty', 'is_not_empty'];
  default:
    return ['contains', 'not_contains', 'equals', 'not_equals', 'starts_with', 'ends_with', 'is_empty', 'is_not_empty'];
  }
}

/** Per-view-type display metadata (icon + label), shared by the toolbar + menus. */
export const VIEW_TYPES: {value: DatabaseViewType; label: string; Icon: React.ComponentType<{className?: string}>}[] = [
  {value: 'table', label: 'Table', Icon: Table2},
  {value: 'board', label: 'Board', Icon: Columns3},
  {value: 'gallery', label: 'Gallery', Icon: LayoutGrid},
  {value: 'list', label: 'List', Icon: List},
  {value: 'calendar', label: 'Calendar', Icon: Calendar},
  {value: 'timeline', label: 'Timeline', Icon: GanttChartSquare},
  {value: 'graph', label: 'Graph', Icon: Workflow},
  {value: 'bar', label: 'Bar chart', Icon: BarChart3},
  {value: 'pie', label: 'Pie chart', Icon: PieChart},
];

export const viewIcon = (type: DatabaseViewType): React.ComponentType<{className?: string}> =>
  VIEW_TYPES.find((v) => v.value === type)?.Icon ?? Table2;

/** Open a file picker and feed the chosen CSV's text to `importCsv`. */
function importCsvFile(importCsv: (text: string) => Promise<number>): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.csv,text/csv';
  input.onchange = () => {
    const file = input.files?.[0];
    if (file) void file.text().then((text) => importCsv(text));
  };
  input.click();
}

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

  const numeric = type === 'number' || type === 'formula' || type === 'expr' || type === 'rollup';

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

/** Inline editor for one `select`/`multi_select`/`status` property's options. */
const OptionsEditor: React.FC<{property: DatabaseProperty; db: UseDatabase}> = ({property, db}) => {
  const [draft, setDraft] = useState('');
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const options = property.options ?? [];
  const isStatus = property.type === 'status';

  const setOption = (id: string, patch: Partial<DatabaseSelectOption>) =>
    void db.updateProperty(property.id, {options: options.map((o) => (o.id === id ? {...o, ...patch} : o))});
  const removeOption = (id: string) =>
    void db.updateProperty(property.id, {options: options.filter((o) => o.id !== id)});
  const addOption = () => {
    const label = draft.trim();
    if (!label) return;
    const option: DatabaseSelectOption = {id: shortId('opt'), label, color: SELECT_COLORS[options.length % SELECT_COLORS.length]};
    if (isStatus) option.group = 'todo';
    void db.updateProperty(property.id, {options: [...options, option]});
    setDraft('');
  };
  // Reorder by moving the dragged option to sit where the drop target is. Option
  // order drives the dropdown list and the board's kanban columns.
  const reorder = (fromId: string, toId: string) => {
    if (fromId === toId) return;
    const from = options.findIndex((o) => o.id === fromId);
    const to = options.findIndex((o) => o.id === toId);
    if (from < 0 || to < 0) return;
    const next = [...options];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    void db.updateProperty(property.id, {options: next});
  };

  return (
    <div className="space-y-1.5">
      <div className={sectionLabel}>Options</div>
      {options.map((option) => (
        <div
          key={option.id}
          data-opt-key={option.id}
          onDragOver={(e) => {
            if (dragId && dragId !== option.id) {
              e.preventDefault();
              setOverId(option.id);
            }
          }}
          onDrop={() => {
            if (dragId) reorder(dragId, option.id);
            setDragId(null);
            setOverId(null);
          }}
          className={cn(
            'flex items-center gap-1 rounded',
            dragId === option.id && 'opacity-40',
            overId === option.id && dragId !== option.id && 'border-t-2 border-brand/50',
          )}
        >
          <span
            draggable
            onDragStart={() => setDragId(option.id)}
            onDragEnd={() => {
              setDragId(null);
              setOverId(null);
            }}
            className="shrink-0 cursor-grab text-muted-foreground/40 transition-colors hover:text-muted-foreground active:cursor-grabbing"
            aria-label="Reorder option"
          >
            <GripVertical className="h-3.5 w-3.5" />
          </span>
          <ColorSwatch value={option.color} onChange={(color) => setOption(option.id, {color})} />
          <input
            defaultValue={option.label}
            onBlur={(e) => e.target.value.trim() && setOption(option.id, {label: e.target.value.trim()})}
            className={cn(fieldClass, 'min-w-0 flex-1')}
          />
          {isStatus && (
            <select
              value={option.group ?? 'todo'}
              onChange={(e) => setOption(option.id, {group: e.target.value as StatusGroup})}
              className={cn(fieldClass, 'w-24')}
              aria-label="Status group"
            >
              {STATUS_GROUPS.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.label}
                </option>
              ))}
            </select>
          )}
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

/** Rollup configuration: which relation, which target property, how to fold it. */
const RollupEditor: React.FC<{property: DatabaseProperty; db: UseDatabase}> = ({property, db}) => {
  const props = db.database!.schema.properties;
  const relations = props.filter((p) => p.type === 'relation' || p.type === 'dependency');
  const targets = props.filter((p) => p.id !== property.id && p.type !== 'rollup');
  const cfg: RollupConfig = property.rollup ?? {relationPropertyId: '', targetPropertyId: TITLE_PROPERTY_ID, function: 'count'};
  const set = (patch: Partial<RollupConfig>) => void db.updateProperty(property.id, {rollup: {...cfg, ...patch}});

  return (
    <div className="space-y-1.5">
      <div className={sectionLabel}>Rollup</div>
      <label className="block">
        <span className="text-xs text-muted-foreground">Relation</span>
        <select value={cfg.relationPropertyId} onChange={(e) => set({relationPropertyId: e.target.value})} className={cn(fieldClass, 'mt-0.5 w-full')}>
          <option value="">—</option>
          {relations.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      <label className="block">
        <span className="text-xs text-muted-foreground">Property</span>
        <select value={cfg.targetPropertyId} onChange={(e) => set({targetPropertyId: e.target.value})} className={cn(fieldClass, 'mt-0.5 w-full')}>
          <option value={TITLE_PROPERTY_ID}>Title</option>
          {targets.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      <label className="block">
        <span className="text-xs text-muted-foreground">Calculate</span>
        <select value={cfg.function} onChange={(e) => set({function: e.target.value as RollupFunction})} className={cn(fieldClass, 'mt-0.5 w-full')}>
          {ROLLUP_FUNCTIONS.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>
      </label>
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
  const numeric = property.type === 'number' || property.type === 'formula' || property.type === 'expr' || property.type === 'rollup';

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

        {(property.type === 'select' || property.type === 'multi_select' || property.type === 'status') && (
          <OptionsEditor property={property} db={db} />
        )}

        {property.type === 'rollup' && <RollupEditor property={property} db={db} />}

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
          <>
            <label className="flex cursor-pointer items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={!!property.dateRange}
                onChange={(e) => void db.updateProperty(property.id, {dateRange: e.target.checked})}
                className="h-3.5 w-3.5 accent-primary"
              />
              End date (range)
            </label>
            <label className="flex cursor-pointer items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={!!property.includeTime}
                onChange={(e) => void db.updateProperty(property.id, {includeTime: e.target.checked})}
                className="h-3.5 w-3.5 accent-primary"
              />
              Include time
            </label>
            <label className="block">
              <span className={sectionLabel}>Display</span>
              <select
                value={property.dateDisplay ?? 'absolute'}
                onChange={(e) => void db.updateProperty(property.id, {dateDisplay: e.target.value as 'absolute' | 'relative'})}
                className={cn(fieldClass, 'mt-1 w-full')}
                aria-label="Date display"
              >
                <option value="absolute">Absolute (Jun 12, 2026)</option>
                <option value="relative">Relative (In 3 days)</option>
              </select>
            </label>
          </>
        )}

        {property.type === 'unique_id' && (
          <input
            defaultValue={property.idPrefix ?? ''}
            onBlur={(e) => e.target.value !== (property.idPrefix ?? '') && db.updateProperty(property.id, {idPrefix: e.target.value})}
            placeholder="ID prefix (e.g. TASK)"
            className={cn(fieldClass, 'w-full')}
            aria-label="ID prefix"
          />
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

        {property.type === 'number' && (
          <div className="flex items-center gap-1.5">
            <select
              value={property.numberDisplay ?? 'number'}
              onChange={(e) => void db.updateProperty(property.id, {numberDisplay: e.target.value as NumberDisplay})}
              className={cn(fieldClass, 'flex-1')}
              aria-label="Show number as"
            >
              {NUMBER_DISPLAYS.map((d) => (
                <option key={d.value} value={d.value}>
                  Show as {d.label}
                </option>
              ))}
            </select>
            {property.numberDisplay && property.numberDisplay !== 'number' && (
              <input
                type="number"
                defaultValue={property.numberTarget ?? 100}
                onBlur={(e) => void db.updateProperty(property.id, {numberTarget: Number(e.target.value) || 100})}
                className={cn(fieldClass, 'w-20')}
                aria-label="Bar target (100%)"
                title="Value that fills the bar"
              />
            )}
          </div>
        )}

        {property.type === 'rating' && (
          <label className="block">
            <span className={sectionLabel}>Max stars</span>
            <input
              type="number"
              min={1}
              max={10}
              defaultValue={property.numberTarget ?? 5}
              onBlur={(e) => void db.updateProperty(property.id, {numberTarget: Math.min(10, Math.max(1, Number(e.target.value) || 5))})}
              className={cn(fieldClass, 'mt-1 w-full')}
              aria-label="Max stars"
            />
          </label>
        )}

        {property.type === 'dependency' &&
          (property.syncedPropertyId ? (
            <p className="flex items-center gap-1.5 rounded-md bg-muted/60 px-2 py-1.5 text-xs text-muted-foreground">
              <Link2 className="h-3.5 w-3.5 shrink-0" />
              Two-way · edits sync to{' '}
              <span className="font-medium text-foreground">
                {db.database?.schema.properties.find((p) => p.id === property.syncedPropertyId)?.name ?? 'related'}
              </span>
            </p>
          ) : (
            <button
              onClick={() => void db.makeDependencyTwoWay(property.id)}
              className={cn(toolButtonClass, 'w-full justify-center')}
            >
              <Link2 className="h-3.5 w-3.5" /> Make two-way
            </button>
          ))}

        <input
          defaultValue={property.description ?? ''}
          onBlur={(e) => e.target.value !== (property.description ?? '') && db.updateProperty(property.id, {description: e.target.value})}
          placeholder="Description"
          className={cn(fieldClass, 'w-full text-xs')}
        />

        {db.activeView && (
          <div className="flex items-center gap-1 border-t border-border pt-2">
            <button
              onClick={() => {
                setOpen(false);
                void db.updateView(db.activeView!.id, {sorts: [{propertyId: property.id, direction: 'asc'}]});
              }}
              className={cn(toolButtonClass, 'flex-1 justify-center')}
            >
              <ArrowDownAZ className="h-3.5 w-3.5" /> Sort asc
            </button>
            <button
              onClick={() => {
                setOpen(false);
                void db.updateView(db.activeView!.id, {sorts: [{propertyId: property.id, direction: 'desc'}]});
              }}
              className={cn(toolButtonClass, 'flex-1 justify-center')}
            >
              <ArrowUpAZ className="h-3.5 w-3.5" /> Sort desc
            </button>
          </div>
        )}

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
            void db.duplicateProperty(property.id);
          }}
          className={cn(toolButtonClass, 'w-full justify-center')}
        >
          <Copy className="h-3.5 w-3.5" /> Duplicate property
        </button>
        {db.activeView && (
          <button
            onClick={() => {
              setOpen(false);
              const all = (db.database?.schema.properties ?? []).map((p) => p.id);
              const current = db.activeView!.visiblePropertyIds?.length ? db.activeView!.visiblePropertyIds : all;
              void db.updateView(db.activeView!.id, {visiblePropertyIds: current.filter((id) => id !== property.id)});
            }}
            className={cn(toolButtonClass, 'w-full justify-center')}
          >
            <EyeOff className="h-3.5 w-3.5" /> Hide in view
          </button>
        )}
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

/** Count the leaf conditions anywhere in a filter tree (for the toolbar badge). */
const countConditions = (group: DatabaseFilterGroup): number =>
  group.filters.reduce((n, node) => n + (isFilterGroup(node) ? countConditions(node) : 1), 0);

/** Editor for one condition row: property · operator · value, type-aware. */
const ConditionRow: React.FC<{
  database: StoredDatabase;
  filter: DatabaseFilter;
  onChange: (patch: Partial<DatabaseFilter>) => void;
  onRemove: () => void;
}> = ({database, filter, onChange, onRemove}) => {
  const choices = propertyChoices(database);
  const prop = database.schema.properties.find((p) => p.id === filter.propertyId);
  const ops = operatorsFor(filter.propertyId === TITLE_PROPERTY_ID ? undefined : prop?.type);
  // Keep the operator valid for the chosen property type.
  const operator = ops.includes(filter.operator) ? filter.operator : ops[0];
  const options = prop?.options ?? [];
  const isChoice = (prop?.type === 'select' || prop?.type === 'status') && (operator === 'equals' || operator === 'not_equals');

  return (
    <div className="flex items-center gap-1">
      <select
        value={filter.propertyId}
        onChange={(e) => {
          const nextProp = database.schema.properties.find((p) => p.id === e.target.value);
          const nextOps = operatorsFor(e.target.value === TITLE_PROPERTY_ID ? undefined : nextProp?.type);
          onChange({propertyId: e.target.value, operator: nextOps[0], value: ''});
        }}
        className={cn(fieldClass, 'min-w-0 flex-1')}
      >
        {choices.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
      <select value={operator} onChange={(e) => onChange({operator: e.target.value as FilterOperator})} className={cn(fieldClass, 'min-w-0 flex-1')}>
        {ops.map((op) => (
          <option key={op} value={op}>
            {OPERATOR_LABEL[op]}
          </option>
        ))}
      </select>
      {!VALUELESS.has(operator) &&
        (isChoice ? (
          <select
            value={typeof filter.value === 'string' ? filter.value : ''}
            onChange={(e) => onChange({value: e.target.value})}
            className={cn(fieldClass, 'w-24')}
          >
            <option value="">—</option>
            {options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        ) : (
          <input
            type={DATE_OPS.has(operator) ? 'date' : 'text'}
            value={typeof filter.value === 'string' || typeof filter.value === 'number' ? String(filter.value) : ''}
            onChange={(e) => onChange({value: e.target.value})}
            placeholder="value"
            className={cn(fieldClass, 'w-24')}
          />
        ))}
      <IconButton size="sm" onClick={onRemove} aria-label="Remove condition">
        <Trash2 className="h-3.5 w-3.5" />
      </IconButton>
    </div>
  );
};

/** Recursive editor for a filter group (and/or conjunction + conditions + sub-groups). */
const GroupEditor: React.FC<{
  database: StoredDatabase;
  group: DatabaseFilterGroup;
  onChange: (next: DatabaseFilterGroup) => void;
  onRemove?: () => void;
  depth: number;
}> = ({database, group, onChange, onRemove, depth}) => {
  const choices = propertyChoices(database);
  const setChild = (i: number, node: FilterNode) => onChange({...group, filters: group.filters.map((f, idx) => (idx === i ? node : f))});
  const removeChild = (i: number) => onChange({...group, filters: group.filters.filter((_, idx) => idx !== i)});
  const addCondition = () =>
    onChange({...group, filters: [...group.filters, {id: shortId('flt'), propertyId: choices[0].id, operator: 'contains', value: ''}]});
  const addGroup = () =>
    onChange({...group, filters: [...group.filters, {id: shortId('grp'), conjunction: 'and', filters: []}]});

  return (
    <div className={cn(depth > 0 && 'rounded-md border border-border/70 bg-muted/20 p-2')}>
      <div className="mb-1.5 flex items-center justify-between">
        <div className="inline-flex overflow-hidden rounded border border-border text-xs">
          {(['and', 'or'] as const).map((c) => (
            <button
              key={c}
              onClick={() => onChange({...group, conjunction: c})}
              className={cn('px-2 py-0.5 transition-colors', group.conjunction === c ? 'bg-accent font-medium text-foreground' : 'text-muted-foreground hover:bg-accent/40')}
            >
              {c === 'and' ? 'All' : 'Any'}
            </button>
          ))}
        </div>
        {onRemove && (
          <IconButton size="sm" onClick={onRemove} aria-label="Remove group">
            <Trash2 className="h-3.5 w-3.5" />
          </IconButton>
        )}
      </div>
      <div className="space-y-1.5">
        {group.filters.length === 0 && <div className="text-xs text-muted-foreground">No conditions yet.</div>}
        {group.filters.map((node, i) =>
          isFilterGroup(node) ? (
            <GroupEditor key={node.id} database={database} group={node} onChange={(n) => setChild(i, n)} onRemove={() => removeChild(i)} depth={depth + 1} />
          ) : (
            <ConditionRow key={node.id} database={database} filter={node} onChange={(patch) => setChild(i, {...node, ...patch})} onRemove={() => removeChild(i)} />
          ),
        )}
      </div>
      <div className="mt-1.5 flex gap-1">
        <button onClick={addCondition} className={cn(toolButtonClass, 'flex-1 justify-center border border-dashed border-border')}>
          <Plus className="h-3.5 w-3.5" /> Condition
        </button>
        {depth === 0 && (
          <button onClick={addGroup} className={cn(toolButtonClass, 'flex-1 justify-center border border-dashed border-border')}>
            <Plus className="h-3.5 w-3.5" /> Group
          </button>
        )}
      </div>
    </div>
  );
};

/** Filter editor: a nested and/or tree of conditions applied to the current view. */
export const FilterMenu: React.FC<MenuProps> = ({database, view, onChange}) => {
  const root = view.filterRoot ?? {id: 'root', conjunction: 'and' as const, filters: view.filters ?? []};
  const count = countConditions(root);

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button className={cn(toolButtonClass, count > 0 && 'text-foreground')}>
          <Filter className="h-3.5 w-3.5" />
          Filter{count > 0 ? ` (${count})` : ''}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[24rem] p-3">
        <GroupEditor
          database={database}
          group={root}
          // Writing a tree supersedes the legacy flat list, so clear it.
          onChange={(next) => onChange({filterRoot: next, filters: []})}
          depth={0}
        />
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

const METRIC_TYPES = SUMMARY_TYPES.filter((s) => s.value !== 'none');

/** One conditional-formatting rule row: property + operator + value + colour. */
const ColorRuleRow: React.FC<{db: UseDatabase; view: DatabaseView; rule: ColorRule; properties: DatabaseProperty[]}> = ({db, view, rule, properties}) => {
  const prop = properties.find((p) => p.id === rule.propertyId);
  const ops = operatorsFor(prop?.type);
  const update = (patch: Partial<ColorRule>): void =>
    void db.updateView(view.id, {colorRules: (view.colorRules ?? []).map((r) => (r.id === rule.id ? {...r, ...patch} : r))});
  const remove = (): void => void db.updateView(view.id, {colorRules: (view.colorRules ?? []).filter((r) => r.id !== rule.id)});
  const isSelect = prop?.type === 'select' || prop?.type === 'status';

  return (
    <div className="flex items-center gap-1">
      <span className="h-4 w-1.5 shrink-0 rounded-full" style={{backgroundColor: SWATCH_HEX[rule.color] ?? '#9ca3af'}} />
      <select
        value={rule.propertyId}
        onChange={(e) => {
          const next = properties.find((p) => p.id === e.target.value);
          update({propertyId: e.target.value, operator: operatorsFor(next?.type)[0], value: undefined});
        }}
        className={cn(fieldClass, 'min-w-0 flex-1')}
        aria-label="Rule property"
      >
        {properties.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      <select value={rule.operator} onChange={(e) => update({operator: e.target.value as FilterOperator})} className={cn(fieldClass, 'min-w-0')} aria-label="Rule operator">
        {ops.map((o) => (
          <option key={o} value={o}>
            {OPERATOR_LABEL[o]}
          </option>
        ))}
      </select>
      {!VALUELESS.has(rule.operator) &&
        (isSelect ? (
          <select value={typeof rule.value === 'string' ? rule.value : ''} onChange={(e) => update({value: e.target.value})} className={cn(fieldClass, 'min-w-0 flex-1')} aria-label="Rule value">
            <option value="">—</option>
            {(prop?.options ?? []).map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        ) : (
          <input
            value={typeof rule.value === 'string' || typeof rule.value === 'number' ? String(rule.value) : ''}
            onChange={(e) => update({value: prop?.type === 'number' || prop?.type === 'rating' ? Number(e.target.value) : e.target.value})}
            className={cn(fieldClass, 'min-w-0 flex-1')}
            placeholder="value"
            aria-label="Rule value"
          />
        ))}
      <select value={rule.color} onChange={(e) => update({color: e.target.value})} className={cn(fieldClass, 'w-16')} aria-label="Rule colour">
        {SELECT_COLORS.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </select>
      <button onClick={remove} aria-label="Remove rule" className="shrink-0 rounded p-0.5 text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground">
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
};

/** Conditional-formatting editor: rules that tint each row/card edge. */
export const ColorRulesEditor: React.FC<{db: UseDatabase; view: DatabaseView}> = ({db, view}) => {
  const properties = db.database!.schema.properties;
  const rules = view.colorRules ?? [];
  const add = (): void => {
    const prop = properties[0];
    if (!prop) return;
    void db.updateView(view.id, {
      colorRules: [...rules, {id: shortId('rule'), propertyId: prop.id, operator: operatorsFor(prop.type)[0], value: undefined, color: SELECT_COLORS[rules.length % SELECT_COLORS.length]}],
    });
  };
  return (
    <div className="space-y-1.5">
      <div className={sectionLabel}>Color rules</div>
      {rules.map((rule) => (
        <ColorRuleRow key={rule.id} db={db} view={view} rule={rule} properties={properties} />
      ))}
      <button onClick={add} className={cn(toolButtonClass, 'w-full justify-center')}>
        <Plus className="h-3.5 w-3.5" /> Add rule
      </button>
    </div>
  );
};

/** The label shown above a metric card (a custom label, or "<property> · <summary>"). */
function metricLabel(metric: DatabaseMetric, properties: DatabaseProperty[]): string {
  if (metric.label?.trim()) return metric.label;
  const name = metric.propertyId === TITLE_PROPERTY_ID ? 'Rows' : properties.find((p) => p.id === metric.propertyId)?.name ?? 'Rows';
  return `${name} · ${METRIC_TYPES.find((t) => t.value === metric.type)?.label ?? metric.type}`;
}

/** One dashboard metric card: its live value, click to reconfigure or remove. */
const MetricCard: React.FC<{db: UseDatabase; view: DatabaseView; metric: DatabaseMetric}> = ({db, view, metric}) => {
  const properties = db.database!.schema.properties;
  const prop = metric.propertyId === TITLE_PROPERTY_ID ? TITLE_PROPERTY_ID : properties.find((p) => p.id === metric.propertyId);
  const value = prop ? summarizeColumn(db.visibleRows, prop, metric.type, properties) : '—';
  // Parse the formatted value back to a number for the optional progress bar
  // (tolerates thousands separators, currency symbols and a trailing %).
  const numeric = Number(value.replace(/[^0-9.-]/g, ''));
  const pct = metric.target && metric.target > 0 && Number.isFinite(numeric)
    ? Math.max(0, Math.min(100, Math.round((numeric / metric.target) * 100)))
    : null;
  const patch = (changes: Partial<DatabaseMetric>): void =>
    void db.updateView(view.id, {metrics: (view.metrics ?? []).map((m) => (m.id === metric.id ? {...m, ...changes} : m))});
  const remove = (): void => void db.updateView(view.id, {metrics: (view.metrics ?? []).filter((m) => m.id !== metric.id)});

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button className="min-w-[110px] rounded-lg border border-border bg-card px-3 py-2 text-left transition-colors hover:border-foreground/25">
          <div className="truncate text-[10px] font-medium uppercase tracking-wide text-muted-foreground" title={metricLabel(metric, properties)}>
            {metricLabel(metric, properties)}
          </div>
          <div className="flex items-baseline gap-1.5">
            <span className="text-xl font-semibold tabular-nums">{value || '—'}</span>
            {pct !== null && <span className="text-xs tabular-nums text-muted-foreground">/ {metric.target} · {pct}%</span>}
          </div>
          {pct !== null && (
            <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-muted">
              <div className="h-full rounded-full bg-brand transition-all" style={{width: `${pct}%`}} />
            </div>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-56 space-y-2 p-2.5">
        <label className="block">
          <span className={sectionLabel}>Property</span>
          <select
            value={metric.propertyId}
            onChange={(e) => patch({propertyId: e.target.value})}
            className={cn(fieldClass, 'mt-1 w-full')}
          >
            <option value={TITLE_PROPERTY_ID}>Rows (count)</option>
            {properties.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className={sectionLabel}>Calculate</span>
          <select value={metric.type} onChange={(e) => patch({type: e.target.value as SummaryType})} className={cn(fieldClass, 'mt-1 w-full')}>
            {METRIC_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
        <input
          defaultValue={metric.label ?? ''}
          onBlur={(e) => e.target.value !== (metric.label ?? '') && patch({label: e.target.value || undefined})}
          placeholder="Custom label (optional)"
          className={cn(fieldClass, 'w-full')}
          aria-label="Metric label"
        />
        <input
          type="number"
          defaultValue={metric.target ?? ''}
          onBlur={(e) => {
            const next = e.target.value === '' ? undefined : Number(e.target.value);
            if (next !== metric.target) patch({target: Number.isFinite(next as number) ? next : undefined});
          }}
          placeholder="Target / goal (optional)"
          className={cn(fieldClass, 'w-full')}
          aria-label="Metric target"
        />
        <button onClick={remove} className={cn(toolButtonClass, 'w-full justify-center text-destructive hover:text-destructive')}>
          <Trash2 className="h-3.5 w-3.5" /> Remove metric
        </button>
      </PopoverContent>
    </Popover>
  );
};

/**
 * Dashboard metric cards above a database view: each is an aggregate (count, sum,
 * average, …) over the view's *filtered* rows, so they update live as filters and
 * data change. Rendered only when the view defines metrics; a trailing "+" adds
 * another (defaulting to a row count — a sensible first metric).
 */
export const MetricsBar: React.FC<{db: UseDatabase; view: DatabaseView}> = ({db, view}) => {
  const metrics = view.metrics ?? [];
  if (metrics.length === 0) return null;
  const add = (): void =>
    void db.updateView(view.id, {metrics: [...metrics, {id: shortId('metric'), propertyId: TITLE_PROPERTY_ID, type: 'count_all'}]});
  return (
    <div className="mb-3 flex flex-wrap items-stretch gap-2">
      {metrics.map((m) => (
        <MetricCard key={m.id} db={db} view={view} metric={m} />
      ))}
      <button
        onClick={add}
        className="flex min-w-[40px] items-center justify-center rounded-lg border border-dashed border-border text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground"
        aria-label="Add metric"
        title="Add metric"
      >
        <Plus className="h-4 w-4" />
      </button>
    </div>
  );
};

/** Add the first metric card to a view (a row count) — the dashboard entry point. */
export function addFirstMetric(db: UseDatabase, view: DatabaseView): void {
  void db.updateView(view.id, {metrics: [...(view.metrics ?? []), {id: shortId('metric'), propertyId: TITLE_PROPERTY_ID, type: 'count_all'}]});
}

/** A human label for a filter condition, e.g. "Status is Done". */
function filterChipText(filter: DatabaseFilter, properties: DatabaseProperty[]): string {
  const name = filter.propertyId === TITLE_PROPERTY_ID ? 'Name' : properties.find((p) => p.id === filter.propertyId)?.name ?? 'Property';
  const op = OPERATOR_LABEL[filter.operator] ?? filter.operator;
  if (VALUELESS.has(filter.operator)) return `${name} ${op}`;
  const prop = properties.find((p) => p.id === filter.propertyId);
  let value: unknown = filter.value;
  if (prop && (prop.type === 'select' || prop.type === 'status' || prop.type === 'multi_select')) {
    value = prop.options?.find((o) => o.id === value)?.label ?? value;
  }
  return `${name} ${op} ${value ?? ''}`.trim();
}

/**
 * Active-filter chips: each top-level condition of the view's filter as a small
 * removable pill, so the filters added from the toolbar or a cell's right-click
 * menu are visible at a glance and one click to drop. Nested filter groups stay
 * managed in the Filter menu (a single "advanced" pill stands in for them).
 */
export const FilterChips: React.FC<{db: UseDatabase; view: DatabaseView}> = ({db, view}) => {
  const properties = db.database!.schema.properties;
  const root = view.filterRoot ?? {id: 'root', conjunction: 'and' as const, filters: view.filters ?? []};
  const leaves = root.filters.filter((n): n is DatabaseFilter => !isFilterGroup(n));
  const groups = root.filters.length - leaves.length;
  if (leaves.length === 0 && groups === 0) return null;

  const removeLeaf = (id: string): void =>
    void db.updateView(view.id, {filterRoot: {...root, filters: root.filters.filter((n) => isFilterGroup(n) || n.id !== id)}, filters: []});
  const clearAll = (): void => void db.updateView(view.id, {filterRoot: {...root, filters: []}, filters: []});

  return (
    <div className="mb-2 flex flex-wrap items-center gap-1.5">
      {leaves.map((f, i) => (
        <React.Fragment key={f.id}>
          {i > 0 && <span className="text-[11px] uppercase text-muted-foreground/60">{root.conjunction}</span>}
          <span className="flex items-center gap-1 rounded-full border border-border bg-muted/50 py-0.5 pl-2 pr-1 text-xs">
            <Filter className="h-3 w-3 shrink-0 text-muted-foreground" />
            <span className="max-w-[16rem] truncate text-muted-foreground" title={filterChipText(f, properties)}>
              {filterChipText(f, properties)}
            </span>
            <button onClick={() => removeLeaf(f.id)} aria-label="Remove filter" className="rounded-full p-0.5 text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground">
              <X className="h-3 w-3" />
            </button>
          </span>
        </React.Fragment>
      ))}
      {groups > 0 && (
        <span className="rounded-full border border-dashed border-border px-2 py-0.5 text-xs text-muted-foreground">+{groups} advanced</span>
      )}
      {leaves.length + groups > 1 && (
        <button onClick={clearAll} className="ml-0.5 text-xs text-muted-foreground transition-colors hover:text-foreground">
          Clear all
        </button>
      )}
    </div>
  );
};

/**
 * Active-sort chips: each sort key as a removable pill — click the label to flip
 * its direction, the × to drop it. Mirrors {@link FilterChips} so the otherwise
 * hidden sort state is visible and editable at a glance.
 */
export const SortChips: React.FC<{db: UseDatabase; view: DatabaseView}> = ({db, view}) => {
  const properties = db.database!.schema.properties;
  const sorts = view.sorts ?? [];
  if (sorts.length === 0) return null;
  const name = (id: string): string => (id === TITLE_PROPERTY_ID ? 'Name' : properties.find((p) => p.id === id)?.name ?? 'Property');
  const flip = (i: number): void =>
    void db.updateView(view.id, {sorts: sorts.map((s, j) => (j === i ? {...s, direction: s.direction === 'asc' ? 'desc' : 'asc'} : s))});
  const remove = (i: number): void => void db.updateView(view.id, {sorts: sorts.filter((_, j) => j !== i)});

  return (
    <div className="mb-2 flex flex-wrap items-center gap-1.5">
      {sorts.map((sort, i) => (
        <span key={i} className="flex items-center gap-1 rounded-full border border-border bg-muted/50 py-0.5 pl-1.5 pr-1 text-xs text-muted-foreground">
          <button onClick={() => flip(i)} className="flex items-center gap-1 transition-colors hover:text-foreground" title="Flip sort direction">
            <span className="max-w-[12rem] truncate">{name(sort.propertyId)}</span>
            {sort.direction === 'asc' ? <ArrowDownAZ className="h-3 w-3 shrink-0" /> : <ArrowUpAZ className="h-3 w-3 shrink-0" />}
          </button>
          <button onClick={() => remove(i)} aria-label="Remove sort" className="rounded-full p-0.5 text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground">
            <X className="h-3 w-3" />
          </button>
        </span>
      ))}
    </div>
  );
};

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

  const showGroup =
    view.type === 'board' || view.type === 'bar' || view.type === 'pie' || view.type === 'table' || view.type === 'list' || view.type === 'gallery';
  const showChart = view.type === 'bar' || view.type === 'pie';
  const showDate = view.type === 'calendar' || view.type === 'timeline';
  const showTimeline = view.type === 'timeline';
  const showDependency = view.type === 'timeline' || view.type === 'graph';
  const dependencyProps = properties.filter((p) => p.type === 'dependency');
  const showCover = view.type === 'gallery';
  const coverProps = properties.filter((p) => p.type === 'files' || p.type === 'url');
  const showCardColor =
    view.type === 'gallery' ||
    view.type === 'board' ||
    view.type === 'calendar' ||
    view.type === 'timeline' ||
    view.type === 'table' ||
    view.type === 'list';
  const colorProps = properties.filter((p) => p.type === 'select' || p.type === 'status');
  const showColumns =
    view.type === 'table' ||
    view.type === 'list' ||
    view.type === 'gallery' ||
    view.type === 'board' ||
    view.type === 'calendar' ||
    view.type === 'timeline';

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

        {showGroup && view.groupByPropertyId && (
          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={!!view.hideEmptyGroups}
              onChange={(e) => db.updateView(view.id, {hideEmptyGroups: e.target.checked})}
              className="h-3.5 w-3.5 accent-primary"
            />
            Hide empty groups
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

        {showChart && (
          <label className="block">
            <span className={sectionLabel}>Break down by</span>
            <select
              value={view.breakdownPropertyId ?? ''}
              onChange={(e) => db.updateView(view.id, {breakdownPropertyId: e.target.value || undefined})}
              className={cn(fieldClass, 'mt-1 w-full')}
            >
              <option value="">None</option>
              {groupable
                .filter((p) => p.id !== view.groupByPropertyId)
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
            </select>
          </label>
        )}

        {view.type === 'bar' && view.breakdownPropertyId && (
          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={!!view.chartStacked100}
              onChange={(e) => db.updateView(view.id, {chartStacked100: e.target.checked})}
              className="h-3.5 w-3.5 accent-primary"
            />
            100% stacked
          </label>
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
        )}

        {showDependency && (
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
        )}

        {showCover && (
          <label className="block">
            <span className={sectionLabel}>Card cover</span>
            <select
              value={view.coverPropertyId ?? ''}
              onChange={(e) => db.updateView(view.id, {coverPropertyId: e.target.value || undefined})}
              className={cn(fieldClass, 'mt-1 w-full')}
            >
              <option value="">None</option>
              {coverProps.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        )}

        {showCover && (
          <label className="block">
            <span className={sectionLabel}>Card size</span>
            <select
              value={view.cardSize ?? 'medium'}
              onChange={(e) => db.updateView(view.id, {cardSize: e.target.value as 'small' | 'medium' | 'large'})}
              className={cn(fieldClass, 'mt-1 w-full')}
              aria-label="Card size"
            >
              <option value="small">Small</option>
              <option value="medium">Medium</option>
              <option value="large">Large</option>
            </select>
          </label>
        )}

        {showCardColor && colorProps.length > 0 && (
          <label className="block">
            <span className={sectionLabel}>Color by</span>
            <select
              value={view.cardColorPropertyId ?? ''}
              onChange={(e) => db.updateView(view.id, {cardColorPropertyId: e.target.value || undefined})}
              className={cn(fieldClass, 'mt-1 w-full')}
            >
              <option value="">None</option>
              {colorProps.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        )}

        {showCardColor && <ColorRulesEditor db={db} view={view} />}

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

        <div className="border-t border-border pt-2">
          <button onClick={() => addFirstMetric(db, view)} className={cn(toolButtonClass, 'w-full justify-center')}>
            <Sigma className="h-3.5 w-3.5" /> Add metric card
          </button>
        </div>

        <div className="flex items-center gap-1 border-t border-border pt-2">
          <button
            onClick={() =>
              downloadText(`${safeFilename(view.name, 'database')}.csv`, rowsToCsv(db.visibleRows, properties, properties), 'text/csv')
            }
            className={cn(toolButtonClass, 'flex-1 justify-center')}
          >
            <Download className="h-3.5 w-3.5" /> Export CSV
          </button>
          <button onClick={() => importCsvFile(db.importCsv)} className={cn(toolButtonClass, 'flex-1 justify-center')}>
            <Upload className="h-3.5 w-3.5" /> Import CSV
          </button>
        </div>

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
  if (type === 'graph' && !view.dependencyPropertyId) {
    patch.dependencyPropertyId = properties.find((p) => p.type === 'dependency')?.id;
  }
  return patch;
}
