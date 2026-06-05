import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  applyView,
  SELECT_COLORS,
  shortId,
  type DatabaseProperty,
  type DatabasePropertyType,
  type DatabaseRow,
  type DatabaseSelectOption,
  type DatabaseView,
  type StoredDatabase,
} from '@open-book/sdk';
import {useData} from '@/data';
import {useNavigation} from '@/providers';

const activeViewKey = (databaseId: string): string => `openbook.dbview.${databaseId}`;

export interface NewPropertyInput {
  name: string;
  type: DatabasePropertyType;
  /** For `select`: initial option labels. */
  options?: string[];
  /** For `expr`: the exported cell name to read. */
  cellName?: string;
}

export interface UseDatabase {
  database: StoredDatabase | null;
  loading: boolean;
  /** All rows (unfiltered), most-recently-updated first. */
  rows: DatabaseRow[];
  /** Rows after the active view's filters + sorts. */
  visibleRows: DatabaseRow[];
  activeView: DatabaseView | null;
  setActiveViewId: (viewId: string) => void;

  // Row mutations
  addRow: () => Promise<void>;
  renameRow: (rowId: string, name: string) => Promise<void>;
  setRowProperty: (rowId: string, propertyId: string, value: unknown) => Promise<void>;
  deleteRow: (rowId: string) => Promise<void>;
  /** Open a row in the split pane for editing its document. */
  openRow: (rowId: string) => void;

  // Schema mutations
  addProperty: (input: NewPropertyInput) => Promise<void>;
  deleteProperty: (propertyId: string) => Promise<void>;
  addSelectOption: (propertyId: string, label: string) => Promise<DatabaseSelectOption | null>;
  updateView: (viewId: string, patch: Partial<DatabaseView>) => Promise<void>;
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
    return applyView(rows, activeView, database.schema.properties);
  }, [rows, database, activeView]);

  // Persist a schema edit and adopt the returned database.
  const saveSchema = useCallback(
    async (next: StoredDatabase['schema']): Promise<void> => {
      if (!database) return;
      const updated = await client.updateDatabase(database.id, {schema: next});
      setDatabase(updated);
    },
    [client, database],
  );

  const addRow = useCallback(async (): Promise<void> => {
    if (!database) return;
    await client.createRow(database.id, {name: null});
    // The row stream pushes the new list; no local mutation needed.
  }, [client, database]);

  const renameRow = useCallback(
    async (rowId: string, name: string): Promise<void> => {
      if (!database) return;
      setPageHint(rowId, name);
      await client.updateRow(database.id, rowId, {name: name.trim().length > 0 ? name : null});
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

  const deleteRow = useCallback(
    async (rowId: string): Promise<void> => {
      await client.deletePage(rowId);
    },
    [client],
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
      if (input.type === 'select') {
        property.options = (input.options ?? [])
          .map((label) => label.trim())
          .filter(Boolean)
          .map((label, i) => ({id: shortId('opt'), label, color: SELECT_COLORS[i % SELECT_COLORS.length]}));
      }
      if (input.type === 'expr') property.cellName = input.cellName?.trim() || input.name.trim();
      await saveSchema({...database.schema, properties: [...database.schema.properties, property]});
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

  return {
    database,
    loading,
    rows,
    visibleRows,
    activeView,
    setActiveViewId,
    addRow,
    renameRow,
    setRowProperty,
    deleteRow,
    openRow,
    addProperty,
    deleteProperty,
    addSelectOption,
    updateView,
  };
}
