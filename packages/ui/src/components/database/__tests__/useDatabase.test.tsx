import {act, cleanup, renderHook, waitFor} from '@testing-library/react';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {DatabaseProperty, DatabaseView, StoredDatabase} from '@book.dev/sdk';
import {useDatabase} from '../useDatabase';

const {client} = vi.hoisted(() => ({
  client: {
    getDatabase: vi.fn(),
    listRows: vi.fn(),
    subscribeRows: vi.fn(),
    updateDatabase: vi.fn(),
  },
}));

vi.mock('@/data', () => ({useData: () => client}));
vi.mock('@/providers', () => ({
  useNavigation: () => ({
    openInSplit: vi.fn(),
    openInNew: vi.fn(),
    setPageHint: vi.fn(),
    primaryPageId: 'page-1',
    activeViewParam: null,
    setActiveViewParam: vi.fn(),
  }),
}));

const source: DatabaseProperty = {id: 'p-source', name: 'Status', type: 'select', options: []};
const tail: DatabaseProperty = {id: 'p-tail', name: 'Owner', type: 'text'};
const pinnedView = {
  id: 'v-pinned',
  name: 'Pinned',
  type: 'table',
  filters: [],
  sorts: [],
  visiblePropertyIds: [source.id, tail.id],
} as DatabaseView;
const otherView = {
  id: 'v-other',
  name: 'Other',
  type: 'table',
  filters: [],
  sorts: [],
  visiblePropertyIds: [tail.id],
} as DatabaseView;
const database = {
  id: 'db-1',
  pageId: 'page-1',
  name: 'Tasks',
  schema: {properties: [source, tail], views: [pinnedView, otherView]},
} as StoredDatabase;

beforeEach(() => {
  client.getDatabase.mockReset().mockResolvedValue(database);
  client.listRows.mockReset().mockResolvedValue([]);
  client.subscribeRows.mockReset().mockReturnValue(vi.fn());
  client.updateDatabase.mockReset().mockImplementation(async (_id: string, patch: Partial<StoredDatabase>) => ({
    ...database,
    ...patch,
  }));
});

afterEach(cleanup);

async function loadDatabase(): Promise<ReturnType<typeof renderHook<ReturnType<typeof useDatabase>, unknown>>> {
  const hook = renderHook(() => useDatabase('page-1', database.id));
  await waitFor(() => expect(hook.result.current.database?.id).toBe(database.id));
  return hook;
}

function savedSchema(): StoredDatabase['schema'] {
  expect(client.updateDatabase).toHaveBeenCalledTimes(1);
  return client.updateDatabase.mock.calls[0][1].schema as StoredDatabase['schema'];
}

describe('property insertion in pinned database views', () => {
  it('inserts a new property beside its anchor in the requested pinned view', async () => {
    const {result} = await loadDatabase();

    await act(() => result.current.insertProperty({name: 'Estimate', type: 'number'}, source.id, 'right', pinnedView.id));

    const schema = savedSchema();
    const inserted = schema.properties[1];
    expect(inserted.name).toBe('Estimate');
    expect(schema.views[0].visiblePropertyIds).toEqual([source.id, inserted.id, tail.id]);
    expect(schema.views[1]).toBe(otherView);
  });

  it('duplicates a property beside its source in the active pinned view', async () => {
    const {result} = await loadDatabase();

    await act(() => result.current.duplicateProperty(source.id));

    const schema = savedSchema();
    const copy = schema.properties[1];
    expect(copy).toMatchObject({name: 'Status copy', type: source.type});
    expect(copy.id).not.toBe(source.id);
    expect(schema.views[0].visiblePropertyIds).toEqual([source.id, copy.id, tail.id]);
    expect(schema.views[1]).toBe(otherView);
  });
});
