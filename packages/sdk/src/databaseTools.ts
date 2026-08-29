import type {
  DatabaseProperty,
  DatabasePropertyType,
  DatabaseRow,
  DatabaseSchema,
  DatabaseSelectOption,
  StoredDatabase,
} from './database';

export const DATABASE_TOOL_PROPERTY_TYPES = [
  'text', 'number', 'rating', 'select', 'multi_select', 'status', 'checkbox',
  'date', 'url', 'email', 'phone',
] as const satisfies readonly DatabasePropertyType[];

const PROPERTY_TYPES = new Set<DatabasePropertyType>(DATABASE_TOOL_PROPERTY_TYPES);
const id = (prefix: string): string => `${prefix}_${crypto.randomUUID().slice(0, 8)}`;

export type DatabaseToolErrorCode =
  | 'database_not_found'
  | 'property_not_found'
  | 'row_not_found'
  | 'invalid_input'
  | 'permission_denied';

/** Safe, stable errors returned by both agent and MCP database tools. */
export class DatabaseToolError extends Error {
  constructor(readonly code: DatabaseToolErrorCode, message: string) {
    super(message);
    this.name = 'DatabaseToolError';
  }
}

export interface DatabaseToolStore {
  getPageDatabase(pageId: string): Promise<StoredDatabase | null>;
  listRows(databaseId: string): Promise<DatabaseRow[]>;
  createDatabase(input: {pageId: string; name: string | null; schema: DatabaseSchema}): Promise<StoredDatabase>;
  updateDatabase(id: string, patch: {name?: string | null; schema?: DatabaseSchema}): Promise<StoredDatabase | null>;
  updateRow(databaseId: string, rowId: string, patch: {name?: string | null; properties?: Record<string, unknown>}): Promise<DatabaseRow | null>;
  deletePage(rowId: string): Promise<boolean>;
}

export interface DatabaseDescription {
  database: {id: string; pageId: string; name: string | null};
  properties: DatabaseProperty[];
  rows: Array<{id: string; name: string | null}>;
  rowCount: number;
}

const databaseForPage = async (store: DatabaseToolStore, pageId: string): Promise<StoredDatabase> => {
  const database = await store.getPageDatabase(pageId);
  if (!database) throw new DatabaseToolError('database_not_found', 'That page hosts no database.');
  return database;
};

export const buildDatabaseToolOptions = (
  labels: unknown[], existing: DatabaseSelectOption[] = [],
): DatabaseSelectOption[] => labels.map((raw) => String(raw).trim()).filter(Boolean).map((label) => {
  const previous = existing.find((option) => option.label.toLowerCase() === label.toLowerCase());
  return {id: previous?.id ?? id('opt'), label, ...(previous?.color ? {color: previous.color} : {})};
});

export const buildDatabaseToolProperty = (spec: Record<string, unknown>): DatabaseProperty => {
  const name = String(spec.name ?? '').trim();
  const type = String(spec.type ?? '') as DatabasePropertyType;
  if (!name) throw new DatabaseToolError('invalid_input', 'A property name is required.');
  if (!PROPERTY_TYPES.has(type)) {
    throw new DatabaseToolError('invalid_input', `Unsupported property type "${String(spec.type)}".`);
  }
  const property: DatabaseProperty = {id: id('p'), name, type};
  if ((type === 'select' || type === 'multi_select' || type === 'status') && Array.isArray(spec.options)) {
    property.options = buildDatabaseToolOptions(spec.options);
  }
  return property;
};

const optionId = (property: DatabaseProperty, value: unknown): string => {
  const candidate = String(value);
  const options = property.options ?? [];
  return (options.find((option) => option.id === candidate)
    ?? options.find((option) => option.label.toLowerCase() === candidate.toLowerCase()))?.id ?? candidate;
};

const cellValue = (property: DatabaseProperty, value: unknown): unknown => {
  if (value === null || value === undefined) return null;
  if (property.type === 'number' || property.type === 'rating') {
    const number = Number(value);
    if (!Number.isFinite(number)) throw new DatabaseToolError('invalid_input', `Invalid number for property "${property.name}".`);
    return number;
  }
  if (property.type === 'checkbox') {
    if (typeof value !== 'boolean') throw new DatabaseToolError('invalid_input', `Invalid checkbox value for property "${property.name}".`);
    return value;
  }
  if (property.type === 'select' || property.type === 'status') return optionId(property, value);
  if (property.type === 'multi_select') return (Array.isArray(value) ? value : [value]).map((entry) => optionId(property, entry));
  return typeof value === 'string' ? value : String(value);
};

export const resolveDatabaseToolRowValues = (
  schema: DatabaseSchema, input: Record<string, unknown>,
): Record<string, unknown> => {
  const values: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    const property = schema.properties.find((item) => item.id === key)
      ?? schema.properties.find((item) => item.name.toLowerCase() === key.toLowerCase());
    if (!property) throw new DatabaseToolError('property_not_found', `Unknown property "${key}".`);
    values[property.id] = cellValue(property, value);
  }
  return values;
};

export async function describeDatabaseTool(store: DatabaseToolStore, pageId: string): Promise<DatabaseDescription> {
  const database = await databaseForPage(store, pageId);
  const rows = await store.listRows(database.id);
  return {
    database: {id: database.id, pageId: database.pageId, name: database.name},
    properties: database.schema.properties,
    rows: rows.slice(0, 40).map(({id: rowId, name}) => ({id: rowId, name})),
    rowCount: rows.length,
  };
}

export async function createDatabaseTool(
  store: DatabaseToolStore,
  input: {pageId: string; title: string; properties?: Array<Record<string, unknown>>},
): Promise<StoredDatabase> {
  const title = input.title.trim();
  if (!title) throw new DatabaseToolError('invalid_input', 'A title is required.');
  const schema: DatabaseSchema = {
    properties: (input.properties ?? []).map(buildDatabaseToolProperty),
    views: [{id: id('v'), name: 'Table', type: 'table', filters: [], sorts: []}],
  };
  return store.createDatabase({pageId: input.pageId, name: title, schema});
}

export async function updateDatabaseTool(
  store: DatabaseToolStore, input: {pageId: string; name: string},
): Promise<StoredDatabase> {
  const database = await databaseForPage(store, input.pageId);
  const name = input.name.trim();
  if (!name) throw new DatabaseToolError('invalid_input', 'A name is required.');
  const updated = await store.updateDatabase(database.id, {name});
  if (!updated) throw new DatabaseToolError('database_not_found', 'That page hosts no database.');
  return updated;
}

export async function createPropertyTool(
  store: DatabaseToolStore, input: {pageId: string; name: string; type: string; options?: unknown[]},
): Promise<{database: StoredDatabase; property: DatabaseProperty}> {
  const database = await databaseForPage(store, input.pageId);
  const property = buildDatabaseToolProperty(input);
  const schema = {...database.schema, properties: [...database.schema.properties, property]};
  const updated = await store.updateDatabase(database.id, {schema});
  if (!updated) throw new DatabaseToolError('database_not_found', 'That page hosts no database.');
  return {database: updated, property};
}

export async function updatePropertyTool(
  store: DatabaseToolStore,
  input: {pageId: string; propertyId: string; name?: string; options?: unknown[]},
): Promise<{database: StoredDatabase; property: DatabaseProperty}> {
  const database = await databaseForPage(store, input.pageId);
  const index = database.schema.properties.findIndex((property) => property.id === input.propertyId);
  if (index < 0) throw new DatabaseToolError('property_not_found', `Unknown property "${input.propertyId}".`);
  if (input.name === undefined && input.options === undefined) throw new DatabaseToolError('invalid_input', 'Pass a name and/or options.');
  const property = {...database.schema.properties[index]};
  if (input.name !== undefined) {
    const name = input.name.trim();
    if (!name) throw new DatabaseToolError('invalid_input', 'A property name is required.');
    property.name = name;
  }
  if (input.options !== undefined) property.options = buildDatabaseToolOptions(input.options, property.options);
  const properties = database.schema.properties.map((current, position) => position === index ? property : current);
  const updated = await store.updateDatabase(database.id, {schema: {...database.schema, properties}});
  if (!updated) throw new DatabaseToolError('database_not_found', 'That page hosts no database.');
  return {database: updated, property};
}

export async function updateRowTool(
  store: DatabaseToolStore,
  input: {pageId: string; rowId: string; name?: string; properties?: Record<string, unknown>},
): Promise<DatabaseRow> {
  const database = await databaseForPage(store, input.pageId);
  const rows = await store.listRows(database.id);
  const row = rows.find((candidate) => candidate.id === input.rowId);
  if (!row) throw new DatabaseToolError('row_not_found', 'Row not found in this database.');
  if (input.name === undefined && input.properties === undefined) throw new DatabaseToolError('invalid_input', 'Pass a name and/or properties.');
  const patch = {
    ...(input.name !== undefined ? {name: input.name} : {}),
    ...(input.properties !== undefined
      ? {properties: {...row.properties, ...resolveDatabaseToolRowValues(database.schema, input.properties)}}
      : {}),
  };
  const updated = await store.updateRow(database.id, input.rowId, patch);
  if (!updated) throw new DatabaseToolError('row_not_found', 'Row not found in this database.');
  return updated;
}

/** Rows are pages, so deletion uses the normal recoverable trash path. */
export async function deleteRowTool(
  store: DatabaseToolStore, input: {pageId: string; rowId: string},
): Promise<{id: string; name: string | null}> {
  const database = await databaseForPage(store, input.pageId);
  const row = (await store.listRows(database.id)).find((candidate) => candidate.id === input.rowId);
  if (!row) throw new DatabaseToolError('row_not_found', 'Row not found in this database.');
  if (!(await store.deletePage(row.id))) throw new DatabaseToolError('row_not_found', 'Row not found in this database.');
  return {id: row.id, name: row.name};
}
