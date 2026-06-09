import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  applyView,
  defaultView,
  FormulaError,
  rowValue,
  SELECT_COLORS,
  shortId,
  type DatabaseProperty,
  type DatabasePropertyType,
  type DatabaseRow,
  type DatabaseSelectOption,
  type DatabaseView,
  type DatabaseViewType,
  type NumberFormat,
  type PropertyGroup,
  type StoredDatabase,
} from '@open-book/sdk';
import {useData} from '@/data';
import {useNavigation} from '@/providers';

const activeViewKey = (databaseId: string): string => `openbook.dbview.${databaseId}`;

export interface NewPropertyInput {
  name: string;
  type: DatabasePropertyType;
  /** For `select`/`multi_select`: initial option labels. */
  options?: string[];
  /** For `expr`: the exported cell name to read. */
  cellName?: string;
  /** For `formula`: the expression source. */
  formula?: string;
  /** For `number`/`formula`: the display format. */
  numberFormat?: NumberFormat;
  /** For `date`: store a start→end range. */
  dateRange?: boolean;
  /** A short helper description. */
  description?: string;
}

/** Fields editable on an existing property (any subset). */
export interface PropertyPatch {
  name?: string;
  type?: DatabasePropertyType;
  options?: DatabaseSelectOption[];
  cellName?: string;
  formula?: string;
  numberFormat?: NumberFormat;
  dateRange?: boolean;
  description?: string;
  groupId?: string | null;
  pageHidden?: boolean;
}

export interface UseDatabase {
  database: StoredDatabase | null;
  loading: boolean;
  /** All rows (unfiltered), in manual order. */
  rows: DatabaseRow[];
  /** Rows after the active view's filters + sorts + the quick-search query. */
  visibleRows: DatabaseRow[];
  activeView: DatabaseView | null;
  setActiveViewId: (viewId: string) => void;
  /** The quick-search query applied across every column. */
  search: string;
  setSearch: (query: string) => void;

  // Row mutations
  /** Create a row, optionally pre-setting property values. Returns the new id. */
  addRow: (initial?: Record<string, unknown>) => Promise<string | undefined>;
  renameRow: (rowId: string, name: string) => Promise<void>;
  setRowProperty: (rowId: string, propertyId: string, value: unknown) => Promise<void>;
  /** Set the manual order of rows (full ordered id list). */
  reorderRows: (orderedIds: string[]) => Promise<void>;
  deleteRow: (rowId: string) => Promise<void>;
  /** Open a row in the split pane for editing its document. */
  openRow: (rowId: string) => void;

  // Schema mutations — properties
  addProperty: (input: NewPropertyInput) => Promise<void>;
  updateProperty: (propertyId: string, patch: PropertyPatch) => Promise<void>;
  /** Move a property left/right among the columns (delta -1 or +1). */
  moveProperty: (propertyId: string, delta: number) => Promise<void>;
  deleteProperty: (propertyId: string) => Promise<void>;
  addSelectOption: (propertyId: string, label: string) => Promise<DatabaseSelectOption | null>;

  // Schema mutations — property groups (page-view organisation)
  addPropertyGroup: (name?: string) => Promise<string | undefined>;
  updatePropertyGroup: (groupId: string, patch: Partial<PropertyGroup>) => Promise<void>;
  deletePropertyGroup: (groupId: string) => Promise<void>;

  // Schema mutations — views
  updateView: (viewId: string, patch: Partial<DatabaseView>) => Promise<void>;
  /** Add a view of a given type and switch to it. */
  addView: (type: DatabaseViewType, name?: string) => Promise<void>;
  renameView: (viewId: string, name: string) => Promise<void>;
  duplicateView: (viewId: string) => Promise<void>;
  deleteView: (viewId: string) => Promise<void>;
  /** Rename the database itself. */
  renameDatabase: (name: string) => Promise<void>;
}

/**
 * Loads the database hosted by `pageId` (if any), keeps its rows live, and
 * exposes the row/schema mutations the database screen needs. Returns
 * `database: null` for ordinary pages so the caller can render nothing.
 *
 * `databaseIdHint` lets the caller short-circuit the lookup: `null` means "this
 * page hosts no database" (skip the request entirely — avoids a 404 probe on
 * every ordinary page), a string fetches that database by id, and `undefined`
 * falls back to looking it up by page.
 */
export function useDatabase(pageId: string, databaseIdHint?: string | null): UseDatabase {
  const client = useData();
  const {openInSplit, setPageHint} = useNavigation();

  const [database, setDatabase] = useState<StoredDatabase | null>(null);
  const [rows, setRows] = useState<DatabaseRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeViewId, setActiveViewIdState] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  // Latest rows for read-modify-write of a single row's properties.
  const rowsRef = useRef<DatabaseRow[]>(rows);
  rowsRef.current = rows;

  // Resolve the database for this page.
  useEffect(() => {
    let cancelled = false;
    setDatabase(null);
    setRows([]);
    if (databaseIdHint === null) {
      setLoading(false);
      return;
    }
    setLoading(true);
    const lookup = databaseIdHint ? client.getDatabase(databaseIdHint) : client.getPageDatabase(pageId);
    void lookup
      .then((db) => {
        if (cancelled) return;
        setDatabase(db);
        if (db) {
          const saved = typeof localStorage !== 'undefined' ? localStorage.getItem(activeViewKey(db.id)) : null;
          const valid = saved && db.schema.views.some((v) => v.id === saved) ? saved : db.schema.views[0]?.id ?? null;
          setActiveViewIdState(valid);
        }
      })
      .catch(() => undefined)
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [client, pageId, databaseIdHint]);

  // Seed rows once, then keep them live. The live stream is a firehose that
  // only carries *updates*, so the initial row set is fetched over REST.
  useEffect(() => {
    if (!database) return;
    let cancelled = false;
    void client
      .listRows(database.id)
      .then((initial) => {
        if (!cancelled) setRows(initial);
      })
      .catch(() => undefined);
    const unsubscribe = client.subscribeRows(database.id, (next) => setRows(next));
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [client, database]);

  const setActiveViewId = useCallback(
    (viewId: string) => {
      setActiveViewIdState(viewId);
      if (database && typeof localStorage !== 'undefined') localStorage.setItem(activeViewKey(database.id), viewId);
    },
    [database],
  );

  const activeView = useMemo<DatabaseView | null>(() => {
    if (!database) return null;
    return database.schema.views.find((v) => v.id === activeViewId) ?? database.schema.views[0] ?? null;
  }, [database, activeViewId]);

  const visibleRows = useMemo<DatabaseRow[]>(() => {
    if (!database || !activeView) return rows;
    const viewed = applyView(rows, activeView, database.schema.properties);
    const query = search.trim().toLowerCase();
    if (!query) return viewed;
    return viewed.filter((row) => rowMatchesSearch(row, query, database.schema.properties));
  }, [rows, database, activeView, search]);

  // Persist a schema edit and adopt the returned database.
  const saveSchema = useCallback(
    async (next: StoredDatabase['schema']): Promise<void> => {
      if (!database) return;
      const updated = await client.updateDatabase(database.id, {schema: next});
      setDatabase(updated);
    },
    [client, database],
  );

  const addRow = useCallback(
    async (initial?: Record<string, unknown>): Promise<string | undefined> => {
      if (!database) return undefined;
      const page = await client.createRow(database.id, {name: null, properties: initial});
      // The live row stream normally pushes the new list; refetch as a fallback so
      // the row appears immediately even if that event is missed (e.g. a stream
      // reconnect gap, or an environment where SSE is unavailable).
      setRows(await client.listRows(database.id));
      return page.id;
    },
    [client, database],
  );

  const renameRow = useCallback(
    async (rowId: string, name: string): Promise<void> => {
      if (!database) return;
      const next = name.trim().length > 0 ? name : null;
      setPageHint(rowId, name);
      // Optimistic: reflect the new title at once so a `formula`/`title` column
      // recomputes immediately (the row stream then confirms it).
      setRows((prev) => prev.map((r) => (r.id === rowId ? {...r, name: next} : r)));
      await client.updateRow(database.id, rowId, {name: next});
    },
    [client, database, setPageHint],
  );

  const setRowProperty = useCallback(
    async (rowId: string, propertyId: string, value: unknown): Promise<void> => {
      if (!database) return;
      const row = rowsRef.current.find((r) => r.id === rowId);
      const properties = {...(row?.properties ?? {}), [propertyId]: value};
      // Optimistic: reflect the edit immediately, the stream confirms it.
      setRows((prev) => prev.map((r) => (r.id === rowId ? {...r, properties} : r)));
      await client.updateRow(database.id, rowId, {properties});
    },
    [client, database],
  );

  const reorderRows = useCallback(
    async (orderedIds: string[]): Promise<void> => {
      if (!database) return;
      // Optimistic: apply the new order at once (the row stream confirms it).
      setRows((prev) => {
        const byId = new Map(prev.map((r) => [r.id, r]));
        const ordered = orderedIds.map((id) => byId.get(id)).filter(Boolean) as DatabaseRow[];
        const seen = new Set(orderedIds);
        return [...ordered, ...prev.filter((r) => !seen.has(r.id))];
      });
      await client.reorderRows(database.id, orderedIds);
    },
    [client, database],
  );

  const deleteRow = useCallback(
    async (rowId: string): Promise<void> => {
      await client.deletePage(rowId);
      // Refetch as a fallback (see addRow) so the row leaves the view promptly.
      if (database) setRows(await client.listRows(database.id));
    },
    [client, database],
  );

  const openRow = useCallback(
    (rowId: string) => {
      const row = rowsRef.current.find((r) => r.id === rowId);
      setPageHint(rowId, row?.name ?? null);
      openInSplit(rowId);
    },
    [openInSplit, setPageHint],
  );

  const addProperty = useCallback(
    async (input: NewPropertyInput): Promise<void> => {
      if (!database) return;
      const property: DatabaseProperty = {
        id: shortId('prop'),
        name: input.name.trim() || 'Property',
        type: input.type,
      };
      if (input.type === 'select' || input.type === 'multi_select') {
        property.options = (input.options ?? [])
          .map((label) => label.trim())
          .filter(Boolean)
          .map((label, i) => ({id: shortId('opt'), label, color: SELECT_COLORS[i % SELECT_COLORS.length]}));
      }
      if (input.type === 'expr') property.cellName = input.cellName?.trim() || input.name.trim();
      if (input.type === 'formula') property.formula = input.formula?.trim() ?? '';
      if (input.numberFormat) property.numberFormat = input.numberFormat;
      if (input.dateRange) property.dateRange = true;
      if (input.description) property.description = input.description;
      await saveSchema({...database.schema, properties: [...database.schema.properties, property]});
    },
    [database, saveSchema],
  );

  const updateProperty = useCallback(
    async (propertyId: string, patch: PropertyPatch): Promise<void> => {
      if (!database) return;
      await saveSchema({
        ...database.schema,
        properties: database.schema.properties.map((p) => {
          if (p.id !== propertyId) return p;
          // `groupId: null` clears membership; spread otherwise merges the patch.
          const {groupId, ...rest} = patch;
          const next: DatabaseProperty = {...p, ...rest};
          if (patch.name !== undefined) next.name = patch.name.trim() || p.name;
          if (groupId !== undefined) next.groupId = groupId ?? undefined;
          return next;
        }),
      });
    },
    [database, saveSchema],
  );

  const moveProperty = useCallback(
    async (propertyId: string, delta: number): Promise<void> => {
      if (!database) return;
      const props = [...database.schema.properties];
      const from = props.findIndex((p) => p.id === propertyId);
      const to = from + delta;
      if (from < 0 || to < 0 || to >= props.length) return;
      [props[from], props[to]] = [props[to], props[from]];
      await saveSchema({...database.schema, properties: props});
    },
    [database, saveSchema],
  );

  const deleteProperty = useCallback(
    async (propertyId: string): Promise<void> => {
      if (!database) return;
      const schema = database.schema;
      await saveSchema({
        ...schema,
        properties: schema.properties.filter((p) => p.id !== propertyId),
        // Drop any references to the removed column from every view.
        views: schema.views.map((v) => ({
          ...v,
          filters: v.filters.filter((f) => f.propertyId !== propertyId),
          sorts: v.sorts.filter((s) => s.propertyId !== propertyId),
          visiblePropertyIds: v.visiblePropertyIds?.filter((id) => id !== propertyId),
        })),
      });
    },
    [database, saveSchema],
  );

  const addSelectOption = useCallback(
    async (propertyId: string, label: string): Promise<DatabaseSelectOption | null> => {
      if (!database) return null;
      const trimmed = label.trim();
      if (!trimmed) return null;
      const property = database.schema.properties.find((p) => p.id === propertyId);
      if (!property) return null;
      const existing = property.options ?? [];
      const match = existing.find((o) => o.label.toLowerCase() === trimmed.toLowerCase());
      if (match) return match;
      const option: DatabaseSelectOption = {
        id: shortId('opt'),
        label: trimmed,
        color: SELECT_COLORS[existing.length % SELECT_COLORS.length],
      };
      await saveSchema({
        ...database.schema,
        properties: database.schema.properties.map((p) =>
          p.id === propertyId ? {...p, options: [...existing, option]} : p,
        ),
      });
      return option;
    },
    [database, saveSchema],
  );

  const addPropertyGroup = useCallback(
    async (name?: string): Promise<string | undefined> => {
      if (!database) return undefined;
      const group: PropertyGroup = {id: shortId('grp'), name: name?.trim() || 'New group'};
      await saveSchema({...database.schema, propertyGroups: [...(database.schema.propertyGroups ?? []), group]});
      return group.id;
    },
    [database, saveSchema],
  );

  const updatePropertyGroup = useCallback(
    async (groupId: string, patch: Partial<PropertyGroup>): Promise<void> => {
      if (!database) return;
      await saveSchema({
        ...database.schema,
        propertyGroups: (database.schema.propertyGroups ?? []).map((g) => (g.id === groupId ? {...g, ...patch} : g)),
      });
    },
    [database, saveSchema],
  );

  const deletePropertyGroup = useCallback(
    async (groupId: string): Promise<void> => {
      if (!database) return;
      await saveSchema({
        ...database.schema,
        propertyGroups: (database.schema.propertyGroups ?? []).filter((g) => g.id !== groupId),
        // Orphaned properties fall back to "ungrouped".
        properties: database.schema.properties.map((p) => (p.groupId === groupId ? {...p, groupId: undefined} : p)),
      });
    },
    [database, saveSchema],
  );

  const updateView = useCallback(
    async (viewId: string, patch: Partial<DatabaseView>): Promise<void> => {
      if (!database) return;
      await saveSchema({
        ...database.schema,
        views: database.schema.views.map((v) => (v.id === viewId ? {...v, ...patch} : v)),
      });
    },
    [database, saveSchema],
  );

  const addView = useCallback(
    async (type: DatabaseViewType, name?: string): Promise<void> => {
      if (!database) return;
      const count = database.schema.views.filter((v) => v.type === type).length;
      const label = name?.trim() || `${VIEW_TYPE_LABEL[type]}${count > 0 ? ` ${count + 1}` : ''}`;
      const view = defaultView(type, label, database.schema.properties);
      await saveSchema({...database.schema, views: [...database.schema.views, view]});
      setActiveViewId(view.id);
    },
    [database, saveSchema, setActiveViewId],
  );

  const renameView = useCallback(
    async (viewId: string, name: string): Promise<void> => updateView(viewId, {name: name.trim() || 'View'}),
    [updateView],
  );

  const duplicateView = useCallback(
    async (viewId: string): Promise<void> => {
      if (!database) return;
      const src = database.schema.views.find((v) => v.id === viewId);
      if (!src) return;
      const copy: DatabaseView = {...src, id: shortId('view'), name: `${src.name} copy`};
      await saveSchema({...database.schema, views: [...database.schema.views, copy]});
      setActiveViewId(copy.id);
    },
    [database, saveSchema, setActiveViewId],
  );

  const deleteView = useCallback(
    async (viewId: string): Promise<void> => {
      if (!database || database.schema.views.length <= 1) return; // keep at least one
      const remaining = database.schema.views.filter((v) => v.id !== viewId);
      await saveSchema({...database.schema, views: remaining});
      if (activeViewId === viewId) setActiveViewId(remaining[0].id);
    },
    [database, saveSchema, activeViewId, setActiveViewId],
  );

  const renameDatabase = useCallback(
    async (name: string): Promise<void> => {
      if (!database) return;
      const updated = await client.updateDatabase(database.id, {name: name.trim() || null});
      setDatabase(updated);
    },
    [client, database],
  );

  return {
    database,
    loading,
    rows,
    visibleRows,
    activeView,
    setActiveViewId,
    search,
    setSearch,
    addRow,
    renameRow,
    setRowProperty,
    reorderRows,
    deleteRow,
    openRow,
    addProperty,
    updateProperty,
    moveProperty,
    deleteProperty,
    addSelectOption,
    addPropertyGroup,
    updatePropertyGroup,
    deletePropertyGroup,
    updateView,
    addView,
    renameView,
    duplicateView,
    deleteView,
    renameDatabase,
  };
}

/** Does any of a row's columns (title included) contain the search needle? */
function rowMatchesSearch(row: DatabaseRow, needle: string, properties: DatabaseProperty[]): boolean {
  if ((row.name ?? '').toLowerCase().includes(needle)) return true;
  for (const property of properties) {
    let text = '';
    if (property.type === 'select') {
      text = property.options?.find((o) => o.id === row.properties[property.id])?.label ?? '';
    } else if (property.type === 'multi_select') {
      const ids = Array.isArray(row.properties[property.id]) ? (row.properties[property.id] as string[]) : [];
      text = (property.options ?? []).filter((o) => ids.includes(o.id)).map((o) => o.label).join(' ');
    } else {
      const v = rowValue(row, property, properties);
      if (v instanceof FormulaError) text = '';
      else if (Array.isArray(v)) text = v.map(String).join(' ');
      else if (v != null) text = String(v);
    }
    if (text.toLowerCase().includes(needle)) return true;
  }
  return false;
}

/** Default display name for a freshly-added view of each type. */
const VIEW_TYPE_LABEL: Record<DatabaseViewType, string> = {
  table: 'Table',
  list: 'List',
  gallery: 'Gallery',
  board: 'Board',
  calendar: 'Calendar',
  timeline: 'Timeline',
  bar: 'Bar chart',
  pie: 'Pie chart',
};
