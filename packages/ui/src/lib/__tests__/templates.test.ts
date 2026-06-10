import {describe, expect, it, vi} from 'vitest';
import {PAGE_TEMPLATES, instantiateTemplate, type PageTemplate} from '@open-book/sdk';
import type {DataClient, PageMeta, StoredPage} from '@open-book/sdk';

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
