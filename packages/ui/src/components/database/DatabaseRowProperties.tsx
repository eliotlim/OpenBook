import React, {useState} from 'react';
import {Select} from '@/components/ui/select';
import {ChevronRight, Eye, EyeOff, FolderPlus, Settings2, Trash2} from 'lucide-react';
import type {DatabaseProperty, PropertyGroup} from '@book.dev/sdk';
import {Popover, PopoverContent, PopoverTrigger} from '@/components/ui/popover';
import {readPageIcon} from '@/lib/pageIcon';
import {cn} from '@/lib/utils';
import {useDatabase, type UseDatabase} from './useDatabase';
import {cellValue, PropertyValueCell} from './databaseCells';

const UNGROUPED = '__ungrouped__';

/** One editable property row: label (+ description) and the type-aware editor. */
const FieldRow: React.FC<{
  property: DatabaseProperty;
  db: UseDatabase;
  pageId: string;
  schema: DatabaseProperty[];
  rowOptions: {id: string; label: string; icon?: string}[];
  dim?: boolean;
}> = ({property, db, pageId, schema, rowOptions, dim}) => {
  const row = db.rows.find((r) => r.id === pageId);
  if (!row) return null;
  return (
    // `group`: property cells reveal their "Empty" placeholder on row hover.
    <div className={cn('group flex min-h-[28px] items-start gap-2', dim && 'opacity-50')}>
      <span className="flex w-28 shrink-0 select-none flex-col pt-1.5 text-sm text-muted-foreground" title={property.description}>
        <span className="truncate">{property.name}</span>
        {property.description && <span className="truncate text-[10px] text-muted-foreground/60">{property.description}</span>}
      </span>
      <div className="min-w-0 flex-1">
        <PropertyValueCell
          property={property}
          value={cellValue(row, property, schema, db.rows)}
          exprValue={row.exports[property.cellName ?? property.name]}
          onChange={(value) => void db.setRowProperty(pageId, property.id, value)}
          onAddOption={(label) => db.addSelectOption(property.id, label)}
          rowOptions={rowOptions}
        />
      </div>
    </div>
  );
};

/** The gear menu: per-property show/hide + group assignment, and group management. */
const ConfigMenu: React.FC<{db: UseDatabase; properties: DatabaseProperty[]; groups: PropertyGroup[]}> = ({
  db,
  properties,
  groups,
}) => (
  <Popover>
    <PopoverTrigger asChild>
      <button
        className="rounded p-1 text-muted-foreground/50 opacity-0 transition hover:bg-hover hover:text-foreground group-hover/props:opacity-100"
        aria-label="Configure properties"
        title="Show, hide & group properties"
      >
        <Settings2 className="h-3.5 w-3.5" />
      </button>
    </PopoverTrigger>
    <PopoverContent align="end" className="w-72 space-y-3 p-3">
      <div>
        <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/70">Properties</div>
        <div className="max-h-56 space-y-0.5 overflow-y-auto">
          {properties.map((p) => (
            <div key={p.id} className="flex items-center gap-1.5 rounded px-1 py-0.5 text-sm hover:bg-hover">
              <button
                onClick={() => void db.updateProperty(p.id, {pageHidden: !p.pageHidden})}
                className="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
                aria-label={p.pageHidden ? `Show ${p.name}` : `Hide ${p.name}`}
                title={p.pageHidden ? 'Hidden — click to show' : 'Shown — click to hide'}
              >
                {p.pageHidden ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              </button>
              <span className={cn('min-w-0 flex-1 truncate', p.pageHidden && 'text-muted-foreground/60')}>{p.name}</span>
              <Select unstyled
                value={p.groupId && groups.some((g) => g.id === p.groupId) ? p.groupId : ''}
                onChange={(e) => void db.updateProperty(p.id, {groupId: e.target.value || null})}
                className="max-w-[7rem] rounded border border-border bg-background px-1 py-0.5 text-xs outline-hidden"
                aria-label={`Group for ${p.name}`}
              >
                <option value="">No group</option>
                {groups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </Select>
            </div>
          ))}
        </div>
      </div>

      <div className="border-t border-border pt-2">
        <div className="mb-1 flex items-center justify-between">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/70">Groups</span>
          <button
            onClick={() => void db.addPropertyGroup()}
            className="flex items-center gap-1 rounded px-1 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-hover hover:text-foreground"
          >
            <FolderPlus className="h-3.5 w-3.5" /> Add
          </button>
        </div>
        {groups.length === 0 && <div className="px-1 text-xs text-muted-foreground/60">No groups yet.</div>}
        <div className="space-y-1">
          {groups.map((g) => (
            <div key={g.id} className="flex items-center gap-1">
              <button
                onClick={() => void db.updatePropertyGroup(g.id, {hidden: !g.hidden})}
                className="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
                aria-label={g.hidden ? `Show group ${g.name}` : `Hide group ${g.name}`}
                title={g.hidden ? 'Group hidden — click to show' : 'Group shown — click to hide'}
              >
                {g.hidden ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              </button>
              <input
                defaultValue={g.name}
                onBlur={(e) => e.target.value.trim() && e.target.value.trim() !== g.name && db.updatePropertyGroup(g.id, {name: e.target.value.trim()})}
                className="min-w-0 flex-1 rounded border border-border bg-background px-1.5 py-1 text-sm outline-hidden"
                aria-label="Group name"
              />
              <button
                onClick={() => void db.deletePropertyGroup(g.id)}
                className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:text-destructive"
                aria-label={`Delete group ${g.name}`}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      </div>
    </PopoverContent>
  </Popover>
);

/**
 * The database-row half of the page-view properties panel. When a page is a
 * database row, its columns appear here as editable fields — organised into
 * collapsible **property groups**, with per-property and per-group show/hide.
 * Reuses {@link useDatabase} (keyed on the row's database) so edits round-trip
 * through the same path as the table and stay live with it.
 */
export const DatabaseRowProperties: React.FC<{pageId: string; databaseId: string}> = ({pageId, databaseId}) => {
  const db = useDatabase(pageId, databaseId);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [showHidden, setShowHidden] = useState(false);

  if (!db.database) return null;
  const schema = db.database.schema.properties;
  if (schema.length === 0) return null;

  const groups = db.database.schema.propertyGroups ?? [];
  const groupById = new Map(groups.map((g) => [g.id, g]));
  const rowOptions = db.rows.filter((r) => r.id !== pageId).map((r) => ({id: r.id, label: r.name?.trim() || 'Untitled', icon: readPageIcon(r.id)}));

  const groupOf = (p: DatabaseProperty): string => (p.groupId && groupById.has(p.groupId) ? p.groupId : UNGROUPED);
  const propHidden = (p: DatabaseProperty): boolean => !!p.pageHidden || !!groupById.get(groupOf(p))?.hidden;

  const ungrouped = schema.filter((p) => groupOf(p) === UNGROUPED);
  const hiddenCount = schema.filter(propHidden).length;

  const toggleGroup = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const field = (p: DatabaseProperty, dim?: boolean) => (
    <FieldRow key={p.id} property={p} db={db} pageId={pageId} schema={schema} rowOptions={rowOptions} dim={dim} />
  );

  return (
    <div className="group/props mb-2 flex flex-col gap-0.5">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/60">Properties</span>
        <ConfigMenu db={db} properties={schema} groups={groups} />
      </div>

      {/* Ungrouped, shown properties. */}
      {ungrouped.filter((p) => !propHidden(p)).map((p) => field(p))}

      {/* Property groups. */}
      {groups.map((g) => {
        if (g.hidden) return null;
        const members = schema.filter((p) => p.groupId === g.id);
        if (members.length === 0) return null;
        const isCollapsed = collapsed.has(g.id);
        return (
          <div key={g.id} className="mt-1">
            <button
              onClick={() => toggleGroup(g.id)}
              className="flex w-full items-center gap-1 py-0.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              <ChevronRight className={cn('h-3.5 w-3.5 transition-transform', !isCollapsed && 'rotate-90')} />
              {g.name}
              <span className="text-muted-foreground/50">{members.filter((p) => !p.pageHidden).length}</span>
            </button>
            {!isCollapsed && (
              <div className="flex flex-col gap-0.5 border-l border-border/50 pl-2">
                {members.filter((p) => !p.pageHidden).map((p) => field(p))}
              </div>
            )}
          </div>
        );
      })}

      {/* Reveal hidden properties on demand. */}
      {hiddenCount > 0 && (
        <button
          onClick={() => setShowHidden((v) => !v)}
          className="mt-1 inline-flex w-fit items-center gap-1 rounded px-1 py-0.5 text-xs text-muted-foreground/70 transition-colors hover:bg-hover hover:text-foreground"
        >
          {showHidden ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
          {showHidden ? 'Hide' : `${hiddenCount} hidden`}
        </button>
      )}
      {showHidden && schema.filter(propHidden).map((p) => field(p, true))}
    </div>
  );
};

export default DatabaseRowProperties;
