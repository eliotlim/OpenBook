import {describe, it, expect, vi} from 'vitest';
import type {ImportedDoc, ImportWriteClient, ImportWriteResult, PageMeta} from '@book.dev/sdk';
import {
  detectImportFormat,
  titleFromFileName,
  summarizeImportedDoc,
  parseImportSource,
  runImport,
  pickImportedJumpTarget,
} from '../importContent';

/** A minimal nav-list page (the store excludes database rows from this list). */
const meta = (id: string, parentId: string | null = null): PageMeta => ({
  id,
  name: id,
  icon: null,
  hostedDatabaseId: null,
  parentId,
  deletedAt: null,
  createdAt: '',
  updatedAt: '',
});

describe('detectImportFormat', () => {
  it('routes a .zip to the Notion adapter', () => {
    expect(detectImportFormat('My Workspace.zip')).toBe('notion-zip');
    expect(detectImportFormat('EXPORT.ZIP')).toBe('notion-zip');
  });

  it('routes Markdown extensions to the Markdown parser', () => {
    for (const name of ['notes.md', 'README.markdown', 'a.mdown', 'b.mkd', 'paste.txt']) {
      expect(detectImportFormat(name)).toBe('markdown');
    }
  });

  it('returns null for an unsupported file', () => {
    expect(detectImportFormat('photo.png')).toBeNull();
    expect(detectImportFormat('data.csv')).toBeNull();
    expect(detectImportFormat('noext')).toBeNull();
  });
});

describe('titleFromFileName', () => {
  it('drops the extension and tidies separators', () => {
    expect(titleFromFileName('my_launch-plan.md')).toBe('my launch plan');
    expect(titleFromFileName('/some/path/Weekly Notes.markdown')).toBe('Weekly Notes');
  });
});

describe('parseImportSource (markdown)', () => {
  it('parses Markdown text into a single titled page', () => {
    const doc = parseImportSource({format: 'markdown', text: '# Launch plan\n\nHello world'});
    expect(doc.pages).toHaveLength(1);
    expect(doc.pages[0].title).toBe('Launch plan');
  });

  it('falls back to the filename for the title when there is no heading', () => {
    const doc = parseImportSource({format: 'markdown', text: 'just a paragraph', fileName: 'trip-notes.md'});
    expect(doc.pages[0].title).toBe('trip notes');
  });

  it('keeps an image as a counted placeholder (never dropped)', () => {
    const doc = parseImportSource({format: 'markdown', text: '# Doc\n\n![a cat](https://x/cat.png)'});
    const summary = summarizeImportedDoc(doc);
    expect(summary.images).toBeGreaterThanOrEqual(1);
  });
});

describe('parseImportSource (notion-zip)', () => {
  it('turns a malformed zip into a handled Error, not an uncaught throw', () => {
    const garbage = new Uint8Array([1, 2, 3, 4, 5]);
    expect(() => parseImportSource({format: 'notion-zip', bytes: garbage, fileName: 'bad.zip'})).toThrow(
      /readable Notion export zip/i,
    );
  });
});

describe('summarizeImportedDoc', () => {
  it('tallies pages, databases, rows, and image placeholders across the tree', () => {
    const doc: ImportedDoc = {
      pages: [
        {
          title: 'Root',
          blocks: [],
          children: [{title: 'Child', blocks: []}],
          database: {
            schema: {properties: []} as never,
            rows: [
              {title: 'Row 1', children: [{title: 'Sub row'}]},
              {title: 'Row 2'},
            ],
          },
        },
      ],
    };
    expect(summarizeImportedDoc(doc)).toEqual({pages: 2, databases: 1, rows: 3, images: 0});
  });
});

/** A fake {@link ImportWriteClient} that records every call the writers make. */
function fakeClient() {
  const calls = {savePage: 0, createDatabase: 0, createRow: 0, importLibrary: 0, setPageProperties: 0};
  const importSpaceReqs: unknown[] = [];
  const client: ImportWriteClient = {
    savePage: vi.fn(async (input: {name?: string | null}) => {
      calls.savePage += 1;
      return {id: `p${calls.savePage}`, name: input.name ?? null} as never;
    }),
    setPageProperties: vi.fn(async () => {
      calls.setPageProperties += 1;
    }) as never,
    createDatabase: vi.fn(async () => {
      calls.createDatabase += 1;
      return {id: `d${calls.createDatabase}`} as never;
    }),
    createRow: vi.fn(async (_dbId: string, input: {name?: string | null}) => {
      calls.createRow += 1;
      return {id: `r${calls.createRow}`, name: input.name ?? null} as never;
    }) as never,
    importLibrary: vi.fn(async (req: unknown) => {
      calls.importLibrary += 1;
      importSpaceReqs.push(req);
      return {created: 2, overwritten: 0, renamed: 0, idMap: {imp_1: 'np1', imp_2: 'np2'}} as never;
    }),
  };
  return {client, calls, importSpaceReqs};
}

describe('runImport wiring', () => {
  it('drives the create APIs for a lone simple page (Strategy A)', async () => {
    const {client, calls} = fakeClient();
    const doc = parseImportSource({format: 'markdown', text: '# Solo\n\nbody'});
    const result = await runImport(client, doc);

    expect(calls.savePage).toBe(1);
    expect(calls.importLibrary).toBe(0);
    expect(result.strategy).toBe('create');
    expect(result.pageIds).toEqual(['p1']);
  });

  it('stages a copy-mode bundle for a multi-page tree (Strategy B)', async () => {
    const {client, calls, importSpaceReqs} = fakeClient();
    const doc: ImportedDoc = {
      pages: [
        {title: 'One', blocks: []},
        {title: 'Two', blocks: []},
      ],
    };
    const result = await runImport(client, doc);

    expect(calls.savePage).toBe(0);
    expect(calls.importLibrary).toBe(1);
    expect((importSpaceReqs[0] as {mode: string}).mode).toBe('copy');
    expect((importSpaceReqs[0] as {pages: unknown[]}).pages).toHaveLength(2);
    expect(result.strategy).toBe('bundle');
  });
});

describe('pickImportedJumpTarget', () => {
  it('returns the first top-level imported page (create path)', () => {
    const result = {strategy: 'create', pageIds: ['p1'], databaseIds: [], rowIds: [], placeholderPageIds: []} as ImportWriteResult;
    expect(pickImportedJumpTarget(result, [meta('other'), meta('p1')])).toBe('p1');
  });

  it('never lands on a database row for a bundle import', () => {
    // The bundle result's pageIds include re-keyed ROW ids (np_row), but the nav
    // list excludes rows — so the jump resolves to the real top-level page.
    const result = {
      strategy: 'bundle',
      pageIds: ['np_root', 'np_row'],
      databaseIds: [],
      rowIds: [],
      placeholderPageIds: [],
      importResult: {created: 1, overwritten: 0, renamed: 0, idMap: {imp_1: 'np_root', imp_2: 'np_row'}},
    } as ImportWriteResult;
    const navPages = [meta('np_root')]; // row np_row is absent (database_id IS NULL filter)
    expect(pickImportedJumpTarget(result, navPages)).toBe('np_root');
  });

  it('skips nested children and prefers a root', () => {
    const result = {strategy: 'bundle', pageIds: ['child', 'root'], databaseIds: [], rowIds: [], placeholderPageIds: []} as ImportWriteResult;
    expect(pickImportedJumpTarget(result, [meta('child', 'root'), meta('root')])).toBe('root');
  });

  it('returns null when nothing top-level landed', () => {
    const result = {strategy: 'create', pageIds: ['gone'], databaseIds: [], rowIds: [], placeholderPageIds: []} as ImportWriteResult;
    expect(pickImportedJumpTarget(result, [meta('unrelated')])).toBeNull();
  });
});
