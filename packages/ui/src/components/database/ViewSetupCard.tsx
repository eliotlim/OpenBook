import React from 'react';
import {BarChart3, CalendarDays, GanttChartSquare, MapPin, Plus, Workflow, type LucideIcon} from 'lucide-react';
import type {DatabaseProperty, DatabaseView as DbView} from '@book.dev/sdk';
import {Button} from '@/components/ui/button';
import {Select} from '@/components/ui/select';
import {useTranslation} from '@/providers';
import type {TKey} from '@/i18n';
import type {NewPropertyInput, UseDatabase, ViewPropertyField} from './useDatabase';

/**
 * The first-run setup card for a view that can't render yet because the
 * property it lays rows out by (a date, location, dependency, or group-by
 * column) doesn't exist or isn't chosen. Replaces the old dead-end prose hints
 * ("choose a … property in the view options") with the fix itself:
 *
 * - no compatible property → one disclosed click creates the typed property
 *   AND points the view at it (atomically, via `db.addPropertyForView`);
 * - compatible properties exist → an inline picker selects one (no duplicate
 *   column), with the same one-click create as its last option.
 */

/** Which view slot the card is setting up. */
export type ViewSetupKind = 'timeline' | 'calendar' | 'map' | 'graph' | 'chart';

/** The property archetypes the setup path can create. */
export type SetupPropertyKind = 'date' | 'endDate' | 'location' | 'dependency' | 'select';

/** Sentinel option value for "+ New … property" entries in property selects. */
export const NEW_PROPERTY_VALUE = '__new_property__';

/** `name` de-duplicated against the existing columns ("Date", "Date 2", …). */
const uniquePropertyName = (properties: DatabaseProperty[], name: string): string => {
  const taken = new Set(properties.map((p) => p.name.trim().toLowerCase()));
  if (!taken.has(name.trim().toLowerCase())) return name;
  for (let n = 2; ; n += 1) {
    const candidate = `${name} ${n}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
};

const NAME_KEY: Record<SetupPropertyKind, TKey> = {
  date: 'database.setup.names.date',
  endDate: 'database.setup.names.endDate',
  location: 'database.setup.names.location',
  dependency: 'database.setup.names.dependency',
  select: 'database.setup.names.category',
};

/** The label for a "+ New … property" sentinel of each archetype. */
export const NEW_PROPERTY_LABEL_KEY: Record<SetupPropertyKind, TKey> = {
  date: 'database.setup.newProperty.date',
  endDate: 'database.setup.newProperty.date',
  location: 'database.setup.newProperty.location',
  dependency: 'database.setup.newProperty.dependency',
  select: 'database.setup.newProperty.select',
};

/**
 * The property a one-click setup action creates, localised and name-deduped.
 * Shared by the setup cards and the view-options "+ New … property" sentinels
 * so both paths mint identical columns. A timeline's date is a start→end
 * range (bars have width, and are edge-resizable, out of the box).
 */
export function setupPropertyInput(
  kind: SetupPropertyKind,
  properties: DatabaseProperty[],
  t: (key: TKey) => string,
  opts?: {range?: boolean},
): NewPropertyInput {
  const name = uniquePropertyName(properties, t(NAME_KEY[kind]));
  switch (kind) {
  case 'date':
    return {name, type: 'date', dateRange: opts?.range};
  case 'endDate':
    return {name, type: 'date'};
  case 'location':
    return {name, type: 'location'};
  case 'dependency':
    return {name, type: 'dependency'};
  default:
    return {name, type: 'select'};
  }
}

interface SetupConfig {
  Icon: LucideIcon;
  /** The view field the setup fills. */
  field: ViewPropertyField;
  /** Which existing properties can fill the slot (mirrors the view-options select). */
  compatible: (p: DatabaseProperty) => boolean;
  /** What the one-click action creates. */
  creates: SetupPropertyKind;
  /** Timeline dates are ranges (see {@link setupPropertyInput}). */
  range?: boolean;
  missingKey: TKey;
  pickKey: TKey;
  createKey: TKey;
  pickLabelKey: TKey;
}

const isDateish = (p: DatabaseProperty): boolean =>
  p.type === 'date' || p.type === 'created_time' || p.type === 'last_edited_time';

const CONFIG: Record<ViewSetupKind, SetupConfig> = {
  timeline: {
    Icon: GanttChartSquare,
    field: 'datePropertyId',
    compatible: isDateish,
    creates: 'date',
    range: true,
    missingKey: 'database.setup.timeline.missing',
    pickKey: 'database.setup.timeline.pick',
    createKey: 'database.setup.timeline.create',
    pickLabelKey: 'database.setup.timeline.pickLabel',
  },
  calendar: {
    Icon: CalendarDays,
    field: 'datePropertyId',
    compatible: isDateish,
    creates: 'date',
    missingKey: 'database.setup.calendar.missing',
    pickKey: 'database.setup.calendar.pick',
    createKey: 'database.setup.calendar.create',
    pickLabelKey: 'database.setup.calendar.pickLabel',
  },
  map: {
    Icon: MapPin,
    field: 'geoPropertyId',
    compatible: (p) => p.type === 'location',
    creates: 'location',
    missingKey: 'database.setup.map.missing',
    pickKey: 'database.setup.map.pick',
    createKey: 'database.setup.map.create',
    pickLabelKey: 'database.setup.map.pickLabel',
  },
  graph: {
    Icon: Workflow,
    field: 'dependencyPropertyId',
    compatible: (p) => p.type === 'dependency',
    creates: 'dependency',
    missingKey: 'database.setup.graph.missing',
    pickKey: 'database.setup.graph.pick',
    createKey: 'database.setup.graph.create',
    pickLabelKey: 'database.setup.graph.pickLabel',
  },
  chart: {
    Icon: BarChart3,
    field: 'groupByPropertyId',
    compatible: () => true, // any property can group a chart
    creates: 'select',
    missingKey: 'database.setup.chart.missing',
    pickKey: 'database.setup.chart.pick',
    createKey: 'database.setup.chart.create',
    pickLabelKey: 'database.setup.chart.pickLabel',
  },
};

export const ViewSetupCard: React.FC<{
  db: UseDatabase;
  view: DbView;
  properties: DatabaseProperty[];
  kind: ViewSetupKind;
}> = ({db, view, properties, kind}) => {
  const {t} = useTranslation();
  const {Icon, field, compatible, creates, range, missingKey, pickKey, createKey, pickLabelKey} = CONFIG[kind];
  const candidates = properties.filter(compatible);

  const createAndUse = (): void => {
    void db.addPropertyForView(view.id, setupPropertyInput(creates, properties, t, {range}), field);
  };

  return (
    <div className="rounded-md border border-dashed border-border px-6 py-8 text-center">
      <Icon className="mx-auto h-6 w-6 text-muted-foreground/50" aria-hidden />
      <p className="mx-auto mt-2.5 max-w-md text-sm text-muted-foreground">
        {t(candidates.length > 0 ? pickKey : missingKey)}
      </p>
      {candidates.length > 0 ? (
        <Select
          value=""
          placeholder={t('database.setup.pickPlaceholder')}
          aria-label={t(pickLabelKey)}
          onChange={(e) => {
            if (e.target.value === NEW_PROPERTY_VALUE) createAndUse();
            else if (e.target.value) void db.updateView(view.id, {[field]: e.target.value});
          }}
          className="mt-4 w-64 max-w-full"
          wrapperClassName="inline-block"
          align="center"
        >
          {candidates.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
          <option value={NEW_PROPERTY_VALUE}>{t(NEW_PROPERTY_LABEL_KEY[creates])}</option>
        </Select>
      ) : (
        <Button size="sm" onClick={createAndUse} className="mt-4 gap-1.5">
          <Plus className="h-4 w-4" aria-hidden />
          {t(createKey)}
        </Button>
      )}
    </div>
  );
};

export default ViewSetupCard;
