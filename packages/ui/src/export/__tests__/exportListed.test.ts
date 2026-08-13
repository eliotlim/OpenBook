import {describe, expect, it} from 'vitest';
import type {DataClient, DatabaseRow, PageSnapshot, StoredPage} from '@book.dev/sdk';
import {gatherSite} from '../exportSite';
import {toHtmlSite} from '../toHtml';

const ids = {
  root: 'up4-root-visible-91',
  visibleChild: 'up4-child-visible-92',
  hiddenChild: 'up4-child-hidden-93',
  hiddenMention: 'up4-mention-hidden-94',
  visibleRow: 'up4-row-visible-95',
  hiddenRow: 'up4-row-hidden-96',
  database: 'up4-database-97',
} as const;

const hiddenTitles = {
  child: 'UP4 SECRET SUBPAGE 93',
  mention: 'UP4 SECRET MENTION 94',
  row: 'UP4 SECRET ROW 96',
} as const;

const snapshot = (blocks: unknown[] = []): PageSnapshot => ({
  editorjs: {blocks},
  values: [],
  names: [],
});

const rootSnapshot = snapshot([
  {type: 'subpage', data: {kind: 'page', pageId: ids.visibleChild}},
  {type: 'subpage', data: {kind: 'page', pageId: ids.hiddenChild}},
  {
    type: 'paragraph',
    data: {
      text: `before <a class="ob-mention" data-page-id="${ids.hiddenMention}">${hiddenTitles.mention}</a> after`,
    },
  },
]);

const storedPage = (id: string, name: string, data: PageSnapshot, over: Partial<StoredPage> = {}): StoredPage => ({
  id,
  name,
  data,
  hostedDatabaseId: null,
  databaseId: null,
  parentId: null,
  properties: {},
  deletedAt: null,
  createdAt: '',
  updatedAt: '',
  ...over,
});

const row = (id: string, name: string): DatabaseRow => ({
  id,
  name,
  properties: {},
  exports: {},
  parentId: null,
  createdAt: '',
  updatedAt: '',
});

function fixtureClient(): DataClient {
  const pages: Record<string, StoredPage> = {
    [ids.root]: storedPage(ids.root, 'UP4 Export Root', rootSnapshot, {hostedDatabaseId: ids.database}),
    [ids.visibleChild]: storedPage(ids.visibleChild, 'UP4 Visible Child', snapshot()),
    [ids.hiddenChild]: storedPage(ids.hiddenChild, hiddenTitles.child, snapshot()),
    [ids.hiddenMention]: storedPage(ids.hiddenMention, hiddenTitles.mention, snapshot()),
    [ids.visibleRow]: storedPage(ids.visibleRow, 'UP4 Visible Row', snapshot(), {databaseId: ids.database}),
    [ids.hiddenRow]: storedPage(ids.hiddenRow, hiddenTitles.row, snapshot(), {databaseId: ids.database}),
  };
  const hidden = new Set<string>([ids.hiddenChild, ids.hiddenMention, ids.hiddenRow]);
  return {
    ledgerInfo: async () => ({exists: false, hostPageId: null, databases: null}),
    getPage: async (id: string) => pages[id] ?? null,
    getPageVisibility: async (id: string) => ({visibility: 'inherit', listed: !hidden.has(id)}),
    getDatabase: async (id: string) =>
      id === ids.database
        ? {id, pageId: ids.root, name: 'UP4 Tasks', schema: {properties: [], views: []}, createdAt: '', updatedAt: ''}
        : null,
    listRows: async (id: string) =>
      id === ids.database
        ? [row(ids.visibleRow, 'UP4 Visible Row'), row(ids.hiddenRow, hiddenTitles.row)]
        : [],
  } as unknown as DataClient;
}

describe('gatherSite — unlisted export leak fence (UP-4)', () => {
  it('hard-skips hidden subpages, mentions, and database rows with no id/title left in the bundle', async () => {
    const bundle = await gatherSite(fixtureClient(), ids.root, {
      snapshot: rootSnapshot,
      title: 'UP4 Export Root',
      icon: '',
    });

    expect(bundle.hiddenPagesSkipped).toBe(3);
    expect(bundle.pages.map((page) => page.id).sort()).toEqual(
      [ids.root, ids.visibleChild, ids.visibleRow].sort(),
    );
    expect(bundle.pages.find((page) => page.id === ids.root)?.database?.rows.map((item) => item.id)).toEqual([
      ids.visibleRow,
    ]);

    // This is the non-browser leak gate: the emitted data object itself must be
    // clean, not merely hidden by the viewer or static renderer.
    const serialized = JSON.stringify(bundle);
    for (const secret of [
      ids.hiddenChild,
      hiddenTitles.child,
      ids.hiddenMention,
      hiddenTitles.mention,
      ids.hiddenRow,
      hiddenTitles.row,
    ]) {
      expect(serialized).not.toContain(secret);
      expect(toHtmlSite(bundle)).not.toContain(secret);
    }
  });
});
