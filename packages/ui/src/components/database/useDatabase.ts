import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  applyView,
  defaultStatusOptions,
  defaultView,
  FormulaError,
  removeProperty,
  rowValue,
  SELECT_COLORS,
  shortId,
  syncInverseUpdates,
  TITLE_PROPERTY_ID,
  type DatabaseProperty,
  type DatabasePropertyType,
  type DatabaseRow,
  type DatabaseSelectOption,
  type DatabaseView,
  type DatabaseViewType,
  type NumberDisplay,
  type NumberFormat,
  type PropertyGroup,
  type RollupConfig,
  type RowTemplate,
  type StoredDatabase,
} from '@open-book/sdk';
import {useData} from '@/data';
import {useNavigation} from '@/providers';
import {parseCsv} from './databaseCells';

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
  numberDisplay?: NumberDisplay;
  numberTarget?: number;
  idPrefix?: string;
  dateRange?: boolean;
  includeTime?: boolean;
  dateDisplay?: 'absolute' | 'relative';
  description?: string;
  groupId?: string | null;
  pageHidden?: boolean;
  rollup?: RollupConfig;
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
  /** Create a sub-item nested under `parentId`. Returns the new row id. */
  addSubItem: (parentId: string) => Promise<string | undefined>;
  /** Re-parent a row (`null` = top level). Reverts if the server refuses (e.g. a cycle). */
  setRowParent: (rowId: string, parentId: string | null) => Promise<void>;
  renameRow: (rowId: string, name: string) => Promise<void>;
  setRowProperty: (rowId: string, propertyId: string, value: unknown) => Promise<void>;
  /** Set several properties of one row atomically (single optimistic update + PATCH). */
  setRowProperties: (rowId: string, patch: Record<string, unknown>) => Promise<void>;
  /** Duplicate a row (its title, properties, and document), at the same nesting level. */
  duplicateRow: (rowId: string) => Promise<void>;
  /** Import CSV text: first column → title, others map to (or create) columns. Returns the row count. */
  importCsv: (text: string) => Promise<number>;
  /** Set the manual order of rows (full ordered id list). */
  reorderRows: (orderedIds: string[]) => Promise<void>;
  /** Create a row positioned immediately after `rowId` in the manual order. */
  addRowAfter: (rowId: string) => Promise<void>;
  /** Create a row positioned immediately before `rowId` in the manual order. */
  addRowBefore: (rowId: string) => Promise<void>;
  deleteRow: (rowId: string) => Promise<void>;
  /** Open a row in the split pane for editing its document. */
  openRow: (rowId: string) => void;

  // Row templates (reusable new-row presets)
  /** The database's saved row templates. */
  templates: RowTemplate[];
  /** Capture a row's current property values as a named, reusable template. */
  saveAsTemplate: (rowId: string, name?: string) => Promise<void>;
  /** Create a row pre-filled from a template. Returns the new row id. */
  addRowFromTemplate: (templateId: string) => Promise<string | undefined>;
  /** Remove a saved template. */
  deleteTemplate: (templateId: string) => Promise<void>;

  // Schema mutations — properties
  addProperty: (input: NewPropertyInput) => Promise<void>;
  /** Clone a property (its full config) into a new column just after it. */
  duplicateProperty: (propertyId: string) => Promise<void>;
  updateProperty: (propertyId: string, patch: PropertyPatch) => Promise<void>;
  /** Move a property left/right among the columns (delta -1 or +1). */
  moveProperty: (propertyId: string, delta: number) => Promise<void>;
  /** Move a property to sit just before `beforeId` (or to the end when null). */
  reorderProperty: (propertyId: string, beforeId: string | null) => Promise<void>;
  deleteProperty: (propertyId: string) => Promise<void>;
  addSelectOption: (propertyId: string, label: string) => Promise<DatabaseSelectOption | null>;
  /** Pair a `dependency` property with a new inverse column (two-way / synced links). */
  makeDependencyTwoWay: (propertyId: string) => Promise<void>;

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
  /** Move a view tab to sit just before `toId` (drag-to-reorder the tabs). */
  reorderView: (fromId: string, toId: string) => Promise<void>;
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
  // Bumped on every optimistic row mutation. The add-row fallback refetch only
  // applies its (possibly stale) snapshot when nothing changed while it was in
  // flight — otherwise naming a row right after creating it gets clobbered back
  // to "Untitled" by a list fetched before the rename landed.
  const rowsMutationVersion = useRef(0);

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

  // Auto-assign sequential numbers to unassigned `unique_id` cells. Convergent:
  // each assignment optimistically updates `rows`, so the next pass sees the new
  // high-water mark and stops once every row is numbered — which covers new rows,
  // imports, and backfilling existing rows when the property is first added.
  useEffect(() => {
    if (!database) return;
    const idProps = database.schema.properties.filter((p) => p.type === 'unique_id');
    if (idProps.length === 0) return;
    let next = rows;
    for (const prop of idProps) {
      const numbered = (r: DatabaseRow): boolean => typeof r.properties[prop.id] === 'number';
      let max = Math.max(0, ...next.filter(numbered).map((r) => r.properties[prop.id] as number));
      const missing = next
        .filter((r) => !numbered(r))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
      if (missing.length === 0) continue;
      const assign = new Map<string, number>();
      for (const r of missing) assign.set(r.id, (max += 1));
      next = next.map((r) => (assign.has(r.id) ? {...r, properties: {...r.properties, [prop.id]: assign.get(r.id)}} : r));
    }
    if (next !== rows) {
      setRows(next);
      next.forEach((r, i) => {
        // Background assignment — swallow transient failures (e.g. a row removed
        // mid-flight) so the effect never surfaces an unhandled rejection.
        if (r !== rows[i]) void client.updateRow(database.id, r.id, {properties: r.properties}).catch(() => {});
      });
    }
  }, [database, rows, client]);

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
      // Optimistic: adopt the new schema at once so rapid successive edits (e.g.
      // adding two filter conditions, or editing several options) each read the
      // latest schema instead of racing the server round-trip and clobbering one
      // another. The server response then reconciles (e.g. updatedAt).
      setDatabase({...database, schema: next});
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
      // reconnect gap, or an environment where SSE is unavailable). Apply it only
      // if no local mutation raced it (see rowsMutationVersion).
      const before = rowsMutationVersion.current;
      const fresh = await client.listRows(database.id);
      setRows((prev) => (rowsMutationVersion.current === before ? fresh : prev));
      return page.id;
    },
    [client, database],
  );

  const addSubItem = useCallback(
    async (parentId: string): Promise<string | undefined> => {
      if (!database) return undefined;
      const page = await client.createRow(database.id, {name: null, parentId});
      const before = rowsMutationVersion.current;
      const fresh = await client.listRows(database.id);
      setRows((prev) => (rowsMutationVersion.current === before ? fresh : prev));
      return page.id;
    },
    [client, database],
  );

  const setRowParent = useCallback(
    async (rowId: string, parentId: string | null): Promise<void> => {
      if (!database || rowId === parentId) return;
      const prev = rowsRef.current.find((r) => r.id === rowId)?.parentId ?? null;
      if (prev === parentId) return;
      rowsMutationVersion.current += 1;
      setRows((rows) => rows.map((r) => (r.id === rowId ? {...r, parentId} : r)));
      try {
        await client.movePage(rowId, {parentId, orderedIds: []});
      } catch {
        // The server refused (e.g. the move would create a cycle) — restore.
        setRows((rows) => rows.map((r) => (r.id === rowId ? {...r, parentId: prev} : r)));
      }
    },
    [client, database],
  );

  // Drop `unique_id` values from a properties bag so a copied/templated row gets
  // a fresh number from the assignment effect rather than cloning the source's.
  const stripAutoIds = useCallback(
    (props: Record<string, unknown>): Record<string, unknown> => {
      const idIds = new Set((database?.schema.properties ?? []).filter((p) => p.type === 'unique_id').map((p) => p.id));
      if (idIds.size === 0) return props;
      return Object.fromEntries(Object.entries(props).filter(([k]) => !idIds.has(k)));
    },
    [database],
  );

  const duplicateRow = useCallback(
    async (rowId: string): Promise<void> => {
      if (!database) return;
      const src = await client.getPage(rowId);
      if (!src) return;
      // Copy the title, manual properties, and document, keeping the nesting
      // level. Page names are workspace-unique, so a named row's copy is suffixed
      // " (copy)" — retrying " (copy N)" on collision, then falling back to
      // untitled — rather than failing.
      const base = src.name?.trim();
      const rest = {properties: stripAutoIds(src.properties), data: src.data, parentId: src.parentId ?? undefined};
      const tryName = async (name: string | null): Promise<boolean> => {
        try {
          await client.createRow(database.id, {name, ...rest});
          return true;
        } catch {
          return false;
        }
      };
      if (!base) {
        await tryName(null);
      } else {
        let done = false;
        for (let n = 1; n <= 5 && !done; n += 1) {
          done = await tryName(n === 1 ? `${base} (copy)` : `${base} (copy ${n})`);
        }
        if (!done) await tryName(null); // give up on a unique name; copy the content
      }
      setRows(await client.listRows(database.id));
    },
    [client, database, stripAutoIds],
  );

  const importCsv = useCallback(
    async (text: string): Promise<number> => {
      if (!database) return 0;
      const grid = parseCsv(text);
      if (grid.length < 2) return 0; // need a header + at least one row
      const [header, ...dataRows] = grid;

      // Map each non-title header to an existing column (by name) or a fresh text
      // column; collect any new columns to add in one schema write.
      const byName = new Map(database.schema.properties.map((p) => [p.name.toLowerCase(), p]));
      const newProps: DatabaseProperty[] = [];
      const colProp = header.map((h, i) => {
        const name = h.trim();
        if (i === 0 || !name) return null; // first column is the title
        const existing = byName.get(name.toLowerCase());
        if (existing) return existing;
        const created: DatabaseProperty = {id: shortId('prop'), name, type: 'text'};
        newProps.push(created);
        byName.set(name.toLowerCase(), created);
        return created;
      });
      if (newProps.length > 0) {
        await saveSchema({...database.schema, properties: [...database.schema.properties, ...newProps]});
      }

      for (const cells of dataRows) {
        const properties: Record<string, unknown> = {};
        colProp.forEach((prop, i) => {
          const raw = (cells[i] ?? '').trim();
          if (!prop || raw === '') return;
          properties[prop.id] = prop.type === 'number' ? Number(raw) : raw;
        });
        await client.createRow(database.id, {name: cells[0]?.trim() || null, properties});
      }
      setRows(await client.listRows(database.id));
      return dataRows.length;
    },
    [client, database, saveSchema],
  );

  const renameRow = useCallback(
    async (rowId: string, name: string): Promise<void> => {
      if (!database) return;
      const next = name.trim().length > 0 ? name : null;
      const prevName = rowsRef.current.find((r) => r.id === rowId)?.name ?? null;
      setPageHint(rowId, name);
      // Optimistic: reflect the new title at once so a `formula`/`title` column
      // recomputes immediately (the row stream then confirms it).
      rowsMutationVersion.current += 1;
      setRows((prev) => prev.map((r) => (r.id === rowId ? {...r, name: next} : r)));
      try {
        await client.updateRow(database.id, rowId, {name: next});
      } catch {
        // The server rejected the rename (workspace names are unique, so a
        // duplicate title 409s). Revert the optimistic title instead of letting
        // the rejection bubble up as an unhandled crash.
        setRows((prev) => prev.map((r) => (r.id === rowId ? {...r, name: prevName} : r)));
        setPageHint(rowId, prevName ?? '');
      }
    },
    [client, database, setPageHint],
  );

  const setRowProperty = useCallback(
    async (rowId: string, propertyId: string, value: unknown): Promise<void> => {
      if (!database) return;
      const snapshot = rowsRef.current;
      const row = snapshot.find((r) => r.id === rowId);
      const properties = {...(row?.properties ?? {}), [propertyId]: value};
      // Optimistic: reflect the edit immediately, the stream confirms it.
      rowsMutationVersion.current += 1;
      setRows((prev) => prev.map((r) => (r.id === rowId ? {...r, properties} : r)));
      await client.updateRow(database.id, rowId, {properties});

      // Two-way dependency: mirror the change onto the related rows' inverse column.
      const prop = database.schema.properties.find((p) => p.id === propertyId);
      if (prop?.type === 'dependency' && prop.syncedPropertyId) {
        const oldIds = Array.isArray(row?.properties[propertyId]) ? (row!.properties[propertyId] as string[]) : [];
        const newIds = Array.isArray(value) ? (value as string[]) : [];
        const updates = syncInverseUpdates(rowId, oldIds, newIds, snapshot, prop.syncedPropertyId);
        if (updates.length > 0) {
          const valueByRow = new Map(updates.map((u) => [u.rowId, u.value]));
          setRows((prev) =>
            prev.map((r) =>
              valueByRow.has(r.id) ? {...r, properties: {...r.properties, [prop.syncedPropertyId!]: valueByRow.get(r.id)}} : r,
            ),
          );
          for (const u of updates) {
            const related = snapshot.find((r) => r.id === u.rowId);
            await client.updateRow(database.id, u.rowId, {
              properties: {...(related?.properties ?? {}), [prop.syncedPropertyId]: u.value},
            });
          }
        }
      }
    },
    [client, database],
  );

  // Several properties of one row in a single optimistic update + PATCH.
  // Two sequential setRowProperty calls each build their payload from the
  // pre-update snapshot (rowsRef only advances after a render), so the second
  // write silently reverts the first — a timeline drag over separate Start/End
  // columns moved only one edge. One bag, one write.
  const setRowProperties = useCallback(
    async (rowId: string, patch: Record<string, unknown>): Promise<void> => {
      if (!database) return;
      const row = rowsRef.current.find((r) => r.id === rowId);
      const properties = {...(row?.properties ?? {}), ...patch};
      rowsMutationVersion.current += 1;
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

  const addRowAfter = useCallback(
    async (rowId: string): Promise<void> => {
      if (!database) return;
      const id = await addRow();
      if (!id) return;
      const order = rowsRef.current.map((r) => r.id).filter((x) => x !== id);
      const at = order.indexOf(rowId);
      order.splice(at < 0 ? order.length : at + 1, 0, id);
      await reorderRows(order);
    },
    [database, addRow, reorderRows],
  );

  const addRowBefore = useCallback(
    async (rowId: string): Promise<void> => {
      if (!database) return;
      const id = await addRow();
      if (!id) return;
      const order = rowsRef.current.map((r) => r.id).filter((x) => x !== id);
      const at = order.indexOf(rowId);
      order.splice(at < 0 ? order.length : at, 0, id);
      await reorderRows(order);
    },
    [database, addRow, reorderRows],
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
      if (input.type === 'status') property.options = defaultStatusOptions();
      if (input.type === 'rollup') {
        // Default to counting whatever the first relation/dependency points at.
        const rel = database.schema.properties.find((p) => p.type === 'relation' || p.type === 'dependency');
        property.rollup = {relationPropertyId: rel?.id ?? '', targetPropertyId: TITLE_PROPERTY_ID, function: 'count'};
      }
      if (input.numberFormat) property.numberFormat = input.numberFormat;
      if (input.dateRange) property.dateRange = true;
      if (input.description) property.description = input.description;
      await saveSchema({...database.schema, properties: [...database.schema.properties, property]});
    },
    [database, saveSchema],
  );

  const duplicateProperty = useCallback(
    async (propertyId: string): Promise<void> => {
      if (!database) return;
      const props = database.schema.properties;
      const src = props.find((p) => p.id === propertyId);
      if (!src) return;
      const copy: DatabaseProperty = {
        ...src,
        id: shortId('prop'),
        name: `${src.name} copy`,
        // The clone isn't paired with the original's two-way partner.
        syncedPropertyId: undefined,
        options: src.options?.map((o) => ({...o, id: shortId('opt')})),
      };
      const at = props.findIndex((p) => p.id === propertyId);
      const next = [...props];
      next.splice(at + 1, 0, copy);
      await saveSchema({...database.schema, properties: next});
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

  const reorderProperty = useCallback(
    async (propertyId: string, beforeId: string | null): Promise<void> => {
      if (!database || propertyId === beforeId) return;
      const props = [...database.schema.properties];
      const from = props.findIndex((p) => p.id === propertyId);
      if (from < 0) return;
      const [moved] = props.splice(from, 1);
      const to = beforeId ? props.findIndex((p) => p.id === beforeId) : props.length;
      props.splice(to < 0 ? props.length : to, 0, moved);
      await saveSchema({...database.schema, properties: props});
    },
    [database, saveSchema],
  );

  const deleteProperty = useCallback(
    async (propertyId: string): Promise<void> => {
      if (!database) return;
      // `removeProperty` scrubs every dangling reference (filters incl. the nested
      // tree, sorts, summaries, group-by/date/cover config, and rollups).
      await saveSchema(removeProperty(database.schema, propertyId));
    },
    [database, saveSchema],
  );

  const makeDependencyTwoWay = useCallback(
    async (propertyId: string): Promise<void> => {
      if (!database) return;
      const prop = database.schema.properties.find((p) => p.id === propertyId);
      if (!prop || prop.type !== 'dependency' || prop.syncedPropertyId) return;
      const inverse: DatabaseProperty = {
        id: shortId('prop'),
        name: `${prop.name} (related)`,
        type: 'dependency',
        syncedPropertyId: prop.id,
      };
      await saveSchema({
        ...database.schema,
        properties: [
          ...database.schema.properties.map((p) => (p.id === propertyId ? {...p, syncedPropertyId: inverse.id} : p)),
          inverse,
        ],
      });
    },
    [database, saveSchema],
  );

  const saveAsTemplate = useCallback(
    async (rowId: string, name?: string): Promise<void> => {
      if (!database) return;
      const row = rowsRef.current.find((r) => r.id === rowId);
      if (!row) return;
      const existing = database.schema.templates ?? [];
      const label = (name ?? row.name ?? '').trim() || `Template ${existing.length + 1}`;
      const template: RowTemplate = {id: shortId('tmpl'), name: label, properties: stripAutoIds(row.properties)};
      await saveSchema({...database.schema, templates: [...existing, template]});
    },
    [database, saveSchema, stripAutoIds],
  );

  const addRowFromTemplate = useCallback(
    async (templateId: string): Promise<string | undefined> => {
      if (!database) return undefined;
      const template = (database.schema.templates ?? []).find((t) => t.id === templateId);
      if (!template) return undefined;
      return addRow({...template.properties});
    },
    [database, addRow],
  );

  const deleteTemplate = useCallback(
    async (templateId: string): Promise<void> => {
      if (!database) return;
      await saveSchema({
        ...database.schema,
        templates: (database.schema.templates ?? []).filter((t) => t.id !== templateId),
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

  const reorderView = useCallback(
    async (fromId: string, toId: string): Promise<void> => {
      if (!database || fromId === toId) return;
      const views = [...database.schema.views];
      const from = views.findIndex((v) => v.id === fromId);
      const to = views.findIndex((v) => v.id === toId);
      if (from < 0 || to < 0) return;
      const [moved] = views.splice(from, 1);
      views.splice(to, 0, moved);
      await saveSchema({...database.schema, views});
    },
    [database, saveSchema],
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
    addSubItem,
    setRowParent,
    renameRow,
    setRowProperty,
    setRowProperties,
    duplicateRow,
    importCsv,
    reorderRows,
    addRowAfter,
    addRowBefore,
    deleteRow,
    openRow,
    templates: database?.schema.templates ?? [],
    saveAsTemplate,
    addRowFromTemplate,
    deleteTemplate,
    addProperty,
    duplicateProperty,
    updateProperty,
    moveProperty,
    reorderProperty,
    deleteProperty,
    addSelectOption,
    makeDependencyTwoWay,
    addPropertyGroup,
    updatePropertyGroup,
    deletePropertyGroup,
    updateView,
    addView,
    renameView,
    reorderView,
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
  map: 'Map',
  graph: 'Graph',
  bar: 'Bar chart',
  pie: 'Pie chart',
};
