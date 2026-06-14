import {describe, expect, it, vi} from 'vitest';
import {PAGE_TEMPLATES, instantiateTemplate, type PageTemplate} from '@open-book/sdk';
import type {DatabaseSchema, DataClient, PageMeta, StoredPage} from '@open-book/sdk';

const page = (over: Partial<StoredPage> = {}): StoredPage =>
  ({
    id: 'pg-1',
    name: 'X',
    data: {editorjs: {blocks: []}, values: [], names: []},
    parentId: null,
    databaseId: null,
    hostedDatabaseId: null,
    properties: {},
    deletedAt: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...over,
  }) as StoredPage;

/** A client stub: page list + create fns the templates exercise. */
function stubClient(existing: string[]): DataClient {
  return {
    listPages: vi.fn(async () => existing.map((name, i) => ({id: `p${i}`, name}) as PageMeta)),
    savePage: vi.fn(async (input: {name?: string | null}) => page({name: input.name ?? null})),
    createDatabase: vi.fn(async () => ({id: 'db-1', pageId: 'pg-1', name: 'X', schema: {properties: [], views: []}})),
    createRow: vi.fn(async () => page()),
  } as unknown as DataClient;
}

describe('PAGE_TEMPLATES', () => {
  it('has unique ids, names, and icons', () => {
    const ids = PAGE_TEMPLATES.map((t) => t.id);
    const names = PAGE_TEMPLATES.map((t) => t.pageName);
    expect(new Set(ids).size).toBe(PAGE_TEMPLATES.length);
    expect(new Set(names).size).toBe(PAGE_TEMPLATES.length);
    for (const t of PAGE_TEMPLATES) expect(t.icon.length).toBeGreaterThan(0);
  });

  it('covers both document and database kinds', async () => {
    // Database templates call createDatabase; document templates don't.
    const kinds = await Promise.all(
      PAGE_TEMPLATES.map(async (t) => {
        const client = stubClient([]);
        await t.create(client, t.pageName);
        return (client.createDatabase as ReturnType<typeof vi.fn>).mock.calls.length > 0 ? 'database' : 'doc';
      }),
    );
    expect(kinds).toContain('database');
    expect(kinds).toContain('doc');
  });

  it('database templates seed at least one sample row', async () => {
    for (const t of PAGE_TEMPLATES) {
      const client = stubClient([]);
      await t.create(client, t.pageName);
      const dbCalls = (client.createDatabase as ReturnType<typeof vi.fn>).mock.calls.length;
      if (dbCalls > 0) {
        expect((client.createRow as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0);
      }
    }
  });
});

/** Run a template against a stub and return the schema it created (database templates). */
async function schemaOf(id: PageTemplate['id']): Promise<DatabaseSchema> {
  const template = PAGE_TEMPLATES.find((t) => t.id === id) as PageTemplate;
  const client = stubClient([]);
  await template.create(client, template.pageName);
  const call = (client.createDatabase as ReturnType<typeof vi.fn>).mock.calls[0][0] as {schema: DatabaseSchema};
  return call.schema;
}

/** Run a block-doc template and return its JSON block projection. */
async function blockdocOf(id: PageTemplate['id']): Promise<Array<Record<string, unknown>>> {
  const template = PAGE_TEMPLATES.find((t) => t.id === id) as PageTemplate;
  const client = stubClient([]);
  await template.create(client, template.pageName);
  const call = (client.savePage as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
    data: {blockdoc?: {blocks: Array<Record<string, unknown>>}};
  };
  return call.data.blockdoc?.blocks ?? [];
}

describe('roadmap swimlanes', () => {
  it('groups the board by a second select and bands the timeline', async () => {
    const schema = await schemaOf('roadmap');
    const board = schema.views.find((v) => v.type === 'board')!;
    const timeline = schema.views.find((v) => v.type === 'timeline')!;
    expect(board.groupByPropertyId).toBe('p_stage');
    expect(board.subGroupByPropertyId).toBe('p_area'); // horizontal swimlanes
    expect(timeline.groupByPropertyId).toBe('p_area'); // Gantt bands
  });
});

describe('field-map template', () => {
  it('exposes a location property and a configured map view', async () => {
    const schema = await schemaOf('field-map');
    const place = schema.properties.find((p) => p.id === 'p_place')!;
    expect(place.type).toBe('location');
    const map = schema.views.find((v) => v.type === 'map')!;
    expect(map.geoPropertyId).toBe('p_place');
    expect(map.addressPropertyId).toBe('p_address');
    expect(map.groupByPropertyId).toBe('p_region');
    expect(map.mapClustered).toBe(true);
    expect(schema.views.some((v) => v.type === 'table')).toBe(true);
  });

  it('seeds rows across regions plus one address-only (unplaced) row', async () => {
    const template = PAGE_TEMPLATES.find((t) => t.id === 'field-map') as PageTemplate;
    const client = stubClient([]);
    await template.create(client, template.pageName);
    const rows = (client.createRow as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[1] as {properties: Record<string, unknown>},
    );
    expect(rows.length).toBeGreaterThanOrEqual(8);
    const placed = rows.filter((r) => r.properties.p_place);
    const unplaced = rows.filter((r) => !r.properties.p_place && r.properties.p_address);
    expect(placed.length).toBeGreaterThanOrEqual(7);
    expect(unplaced.length).toBe(1); // exercises the geocode affordance
  });
});

describe('intake-form wizard', () => {
  it('binds a progress bar to a gated accordion of new kit inputs', async () => {
    const blocks = await blockdocOf('intake-form');
    const types = blocks.map((b) => b.type);
    expect(types).toContain('progressbar');
    const acc = blocks.find((b) => b.type === 'accordion') as {
      props: {name: string; gated: boolean};
      children: Array<{type: string; props: {label: string}; children: Array<{type: string}>}>;
    };
    expect(acc.props.name).toBe('intake');
    expect(acc.props.gated).toBe(true);
    expect(acc.children.map((s) => s.props.label)).toEqual(['Basics', 'Scope', 'Details']);
    // The progress bar reads the accordion's auto-computed completion.
    const progress = blocks.find((b) => b.type === 'progressbar') as {props: {source: string}};
    expect(progress.props.source).toBe('intake.ratio');
    // The new kit inputs all appear inside the accordion's sections.
    const inner = acc.children.flatMap((s) => s.children.map((c) => c.type));
    for (const t of ['choicecards', 'longtext', 'searchselect', 'tagfield', 'richtext']) {
      expect(inner).toContain(t);
    }
  });
});

describe('interactive-dashboard new kit', () => {
  it('adds a choice-card phase picker and a progress bar', async () => {
    const blocks = await blockdocOf('interactive-dashboard');
    const phase = blocks.find((b) => (b.props as {name?: string} | undefined)?.name === 'phase') as {type: string};
    expect(phase.type).toBe('choicecards');
    expect(blocks.some((b) => b.type === 'progressbar')).toBe(true);
  });
});

describe('instantiateTemplate', () => {
  const tasks = PAGE_TEMPLATES.find((t) => t.id === 'tasks') as PageTemplate;

  it('uses the canonical name when free', async () => {
    const client = stubClient(['Something else']);
    await instantiateTemplate(client, tasks);
    expect(client.savePage).toHaveBeenCalledWith(expect.objectContaining({name: 'Task tracker'}));
  });

  it('suffixes the name when taken (names are workspace-unique)', async () => {
    const client = stubClient(['Task tracker', 'Task tracker 2']);
    await instantiateTemplate(client, tasks);
    expect(client.savePage).toHaveBeenCalledWith(expect.objectContaining({name: 'Task tracker 3'}));
  });
});
