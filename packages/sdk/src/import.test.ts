import {describe, expect, it} from 'vitest';
import {
  buildImportBundle,
  chooseStrategy,
  imagePlaceholderBlock,
  imagePlaceholderCell,
  importDoc,
  importedBlocksToSnapshot,
  writeViaBundle,
  writeViaCreateApis,
  IMAGE_PLACEHOLDER_KIND,
  IMAGE_PLACEHOLDER_PROP,
  type ImportedDoc,
  type ImportWriteClient,
} from './import';
import type {DatabaseSchema} from './database';
import type {ImportRequest, ImportResult} from './backup';
import type {DatabaseInput, RowInput} from './database';
import type {PageInput, StoredPage} from './types';

// ── Fixtures ──────────────────────────────────────────────────────────────────

/** A 2-property database schema (Status select + Notes text) for the fixtures. */
const twoColSchema: DatabaseSchema = {
  properties: [
    {id: 'p_status', name: 'Status', type: 'select', options: [{id: 'o_todo', label: 'Todo'}]},
    {id: 'p_notes', name: 'Notes', type: 'text'},
  ],
  views: [{id: 'v_table', name: 'Table', type: 'table', filters: [], sorts: []}],
};

const IMG = {kind: 'image' as const, ref: 'https://ex.com/diagram.png', alt: 'A system diagram'};

/** One page with mixed blocks + an image placeholder + a hosted 2-col database. */
const makeDoc = (): ImportedDoc => ({
  pages: [
    {
      title: 'Imported page',
      icon: '📥',
      blocks: [
        {type: 'heading', text: [{t: 'Title'}], props: {level: 1}},
        {type: 'paragraph', text: [{t: 'Hello '}, {t: 'world', a: {b: true}}]},
        {type: 'list', text: [{t: 'one'}], props: {kind: 'bullet'}},
        imagePlaceholderBlock(IMG),
      ],
      database: {
        name: 'Tasks',
        schema: twoColSchema,
        rows: [
          {title: 'Row A', properties: {p_status: 'o_todo', p_notes: 'first'}},
          {
            title: 'Row B',
            properties: {p_notes: 'second'},
            children: [{title: 'Row B child', properties: {}}],
          },
        ],
      },
    },
  ],
});

// ── A recording fake client ─────────────────────────────────────────────────

interface Calls {
  pages: PageInput[];
  properties: Array<{id: string; properties: Record<string, unknown>}>;
  databases: DatabaseInput[];
  rows: Array<{databaseId: string; input: RowInput}>;
  imports: ImportRequest[];
}

/**
 * A recording {@link ImportWriteClient} that — like the real server — enforces
 * GLOBALLY UNIQUE page names: `savePage`/`createRow` reject (a 409-style throw)
 * when a name is already taken, so the dedup retry path is exercised for real.
 * `seedNames` pre-populates the taken set to force a collision on import.
 * Successful creates are recorded; rejected attempts consume no id.
 */
function fakeClient(seedNames: string[] = []): {client: ImportWriteClient; calls: Calls} {
  const calls: Calls = {pages: [], properties: [], databases: [], rows: [], imports: []};
  const taken = new Set(seedNames);
  let n = 0;
  const page = (id: string, input?: Partial<StoredPage>): StoredPage => ({
    id,
    name: input?.name ?? null,
    data: input?.data ?? {editorjs: {blocks: []}, values: [], names: []},
    hostedDatabaseId: null,
    databaseId: null,
    parentId: null,
    properties: {},
    deletedAt: null,
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
    ...input,
  });
  const claimName = (name: string | null): void => {
    if (name && taken.has(name)) throw new Error(`OpenBook request failed (409 Conflict): name "${name}" is taken`);
    if (name) taken.add(name);
  };
  const client: ImportWriteClient = {
    savePage: (input) => {
      const name = input.name ?? null;
      try {
        claimName(name);
      } catch (err) {
        return Promise.reject(err as Error);
      }
      calls.pages.push(input);
      return Promise.resolve(page(`page_${++n}`, {name, data: input.data, parentId: input.parentId ?? null}));
    },
    setPageProperties: (id, properties) => {
      calls.properties.push({id, properties});
      return Promise.resolve(page(id, {properties}));
    },
    createDatabase: (input) => {
      calls.databases.push(input);
      return Promise.resolve({
        id: `db_${++n}`,
        pageId: input.pageId,
        name: input.name ?? null,
        schema: input.schema ?? {properties: [], views: []},
        createdAt: '2026-01-01',
        updatedAt: '2026-01-01',
      });
    },
    createRow: (databaseId, input = {}) => {
      const name = input.name ?? null;
      try {
        claimName(name);
      } catch (err) {
        return Promise.reject(err as Error);
      }
      calls.rows.push({databaseId, input});
      return Promise.resolve(page(`row_${++n}`, {name, databaseId, parentId: input.parentId ?? null}));
    },
    importSpace: (req) => {
      calls.imports.push(req);
      const idMap: Record<string, string> = {};
      for (const p of req.pages) idMap[p.id] = `new_${p.id}`;
      const result: ImportResult = {created: req.pages.length, overwritten: 0, renamed: 0, idMap};
      return Promise.resolve(result);
    },
  };
  return {client, calls};
}

// ── The image-placeholder shim ───────────────────────────────────────────────

describe('imagePlaceholderBlock', () => {
  it('preserves the ref + alt — never silently dropped', () => {
    const block = imagePlaceholderBlock(IMG);
    expect(block.type).toBe('callout');
    // The ref survives as a clickable link run...
    expect(block.text?.some((r) => r.a?.a === IMG.ref)).toBe(true);
    // ...the alt survives as visible text...
    expect(block.text?.map((r) => r.t).join('')).toContain(IMG.alt);
    // ...and the structured asset is stashed for a future asset store.
    const asset = block.props?.[IMAGE_PLACEHOLDER_PROP] as Record<string, unknown>;
    expect(asset).toMatchObject({kind: IMAGE_PLACEHOLDER_KIND, ref: IMG.ref, alt: IMG.alt});
  });

  it('falls back to the ref as the label when there is no alt', () => {
    const block = imagePlaceholderBlock({kind: 'image', ref: 'photo.jpg'});
    expect(block.text?.map((r) => r.t).join('')).toContain('photo.jpg');
  });

  it('exposes a files-cell placeholder that keeps the ref', () => {
    expect(imagePlaceholderCell(IMG)).toBe(IMG.ref);
  });

  it('derives a pure, stable id from the asset (deterministic re-imports)', () => {
    expect(imagePlaceholderBlock(IMG).id).toBe(imagePlaceholderBlock(IMG).id);
    expect(imagePlaceholderBlock(IMG).id).not.toBe(imagePlaceholderBlock({kind: 'image', ref: 'other.png'}).id);
  });
});

// ── Strategy selection ───────────────────────────────────────────────────────

describe('chooseStrategy', () => {
  it('picks the create writer for a single, simple page', () => {
    expect(chooseStrategy({pages: [{title: 'Solo', blocks: []}]})).toBe('create');
  });
  it('picks the bundle writer when a page hosts a database', () => {
    expect(chooseStrategy(makeDoc())).toBe('bundle');
  });
  it('picks the bundle writer for a multi-page tree', () => {
    expect(chooseStrategy({pages: [{title: 'A', blocks: []}, {title: 'B', blocks: []}]})).toBe('bundle');
  });
  it('picks the bundle writer when a page has children', () => {
    expect(chooseStrategy({pages: [{title: 'A', blocks: [], children: [{title: 'A1', blocks: []}]}]})).toBe('bundle');
  });
});

// ── Strategy A — writeViaCreateApis ──────────────────────────────────────────

describe('writeViaCreateApis', () => {
  it('issues savePage / createDatabase / createRow for the tree', async () => {
    const {client, calls} = fakeClient();
    const result = await writeViaCreateApis(client, makeDoc());

    // One page, one database, three rows (Row A, Row B, Row B child).
    expect(calls.pages).toHaveLength(1);
    expect(calls.databases).toHaveLength(1);
    expect(calls.rows).toHaveLength(3);
    expect(result).toMatchObject({strategy: 'create', databaseIds: ['db_2'], rowIds: ['row_3', 'row_4', 'row_5']});

    // The saved page carries the block body — including the image placeholder.
    const saved = calls.pages[0];
    expect(saved.name).toBe('Imported page');
    const blocks = (saved.data.blockdoc as {blocks: Array<{type: string; props?: Record<string, unknown>}>}).blocks;
    expect(blocks.map((b) => b.type)).toEqual(['heading', 'paragraph', 'list', 'callout']);
    expect(blocks[3].props?.[IMAGE_PLACEHOLDER_PROP]).toMatchObject({ref: IMG.ref, alt: IMG.alt});

    // The icon is applied via setPageProperties.
    expect(calls.properties).toEqual([{id: 'page_1', properties: {sys_icon: '📥'}}]);

    // The database is created on the host page with the 2-col schema.
    expect(calls.databases[0]).toMatchObject({pageId: 'page_1', name: 'Tasks'});
    expect(calls.databases[0].schema?.properties).toHaveLength(2);

    // Rows carry their properties; the sub-item nests under Row B's created id.
    expect(calls.rows[0].input).toMatchObject({name: 'Row A', properties: {p_status: 'o_todo', p_notes: 'first'}});
    expect(calls.rows[1].input).toMatchObject({name: 'Row B', parentId: null});
    expect(calls.rows[2].input).toMatchObject({name: 'Row B child', parentId: 'row_4'});
  });

  it('resolves nested child pages under their parent', async () => {
    const {client, calls} = fakeClient();
    await writeViaCreateApis(client, {
      pages: [{title: 'Parent', blocks: [], children: [{title: 'Child', blocks: []}]}],
    });
    expect(calls.pages[0]).toMatchObject({name: 'Parent', parentId: null});
    expect(calls.pages[1]).toMatchObject({name: 'Child', parentId: 'page_1'});
  });

  it('suffixes a colliding page or row title instead of hard-failing', async () => {
    // The workspace already holds pages named "Imported page" and "Row A".
    const {client, calls} = fakeClient(['Imported page', 'Row A']);
    const result = await writeViaCreateApis(client, makeDoc());

    // No throw: the page lands under the deduped name...
    expect(calls.pages).toHaveLength(1);
    expect(calls.pages[0].name).toBe('Imported page (imported)');
    // ...and so does the clashing row, while the non-clashing rows keep theirs.
    expect(calls.rows.map((r) => r.input.name)).toEqual(['Row A (imported)', 'Row B', 'Row B child']);
    expect(result.pageIds).toHaveLength(1);
    expect(result.rowIds).toHaveLength(3);
  });

  it('lands an untitled page when the title and every suffix are taken', async () => {
    const seeded = ['Solo', 'Solo (imported)', 'Solo (imported) 2', 'Solo (imported) 3', 'Solo (imported) 4', 'Solo (imported) 5'];
    const {client, calls} = fakeClient(seeded);
    const result = await writeViaCreateApis(client, {pages: [{title: 'Solo', blocks: []}]});
    expect(calls.pages).toHaveLength(1);
    expect(calls.pages[0].name).toBeNull();
    expect(result.pageIds).toHaveLength(1);
  });
});

// ── Strategy B — buildImportBundle / writeViaBundle ──────────────────────────

describe('buildImportBundle', () => {
  it('emits a well-formed bundle with wired-up links', () => {
    const {pages, databases} = buildImportBundle(makeDoc(), {now: '2026-06-30'});

    // Host page + 3 row pages; one database.
    expect(pages).toHaveLength(4);
    expect(databases).toHaveLength(1);

    const host = pages[0];
    const db = databases[0];
    // The host page hosts the database; the database points back at the host page.
    expect(host.hostedDatabaseId).toBe(db.id);
    expect(db.pageId).toBe(host.id);
    expect(db.name).toBe('Tasks');
    expect(host.properties).toEqual({sys_icon: '📥'});

    // Every row page belongs to the database; the sub-item parents to Row B.
    const rows = pages.filter((p) => p.databaseId === db.id);
    expect(rows).toHaveLength(3);
    const rowB = rows.find((r) => r.name === 'Row B');
    const child = rows.find((r) => r.name === 'Row B child');
    expect(child?.parentId).toBe(rowB?.id);
    expect(rows.find((r) => r.name === 'Row A')?.parentId).toBeNull();

    // The image placeholder survives in the host page's block body.
    const blocks = (host.data.blockdoc as {blocks: Array<{type: string; props?: Record<string, unknown>}>}).blocks;
    expect(blocks[3].props?.[IMAGE_PLACEHOLDER_PROP]).toMatchObject({ref: IMG.ref, alt: IMG.alt});

    // Synthetic ids are unique and timestamps are stamped.
    expect(new Set(pages.map((p) => p.id)).size).toBe(pages.length);
    expect(host.createdAt).toBe('2026-06-30');
  });

  it('wires child-page parent links and keeps roots at the top level', () => {
    const {pages} = buildImportBundle(
      {pages: [{title: 'Parent', blocks: [], children: [{title: 'Child', blocks: []}]}]},
      {parentId: 'some-existing-page'},
    );
    const parent = pages.find((p) => p.name === 'Parent');
    const child = pages.find((p) => p.name === 'Child');
    // External parents are never set on the bundle roots (copy-mode would null them).
    expect(parent?.parentId).toBeNull();
    expect(child?.parentId).toBe(parent?.id);
  });
});

describe('writeViaBundle', () => {
  it('imports the bundle in copy mode and returns the server result', async () => {
    const {client, calls} = fakeClient();
    const result = await writeViaBundle(client, makeDoc());

    expect(calls.imports).toHaveLength(1);
    expect(calls.imports[0].mode).toBe('copy');
    expect(calls.imports[0].pages).toHaveLength(4);
    expect(calls.imports[0].databases).toHaveLength(1);

    expect(result.strategy).toBe('bundle');
    expect(result.importResult?.created).toBe(4);
    expect(result.pageIds).toHaveLength(4);
  });
});

// ── importDoc (the chooser entry point) ──────────────────────────────────────

describe('importDoc', () => {
  it('routes a lone simple page through Strategy A (create path)', async () => {
    const {client, calls} = fakeClient();
    const result = await importDoc(client, {pages: [{title: 'Solo', blocks: [{type: 'paragraph', text: [{t: 'hi'}]}]}]});
    expect(result.strategy).toBe('create');
    expect(calls.pages).toHaveLength(1);
    expect(calls.imports).toHaveLength(0);
  });

  it('routes a database tree through Strategy B (bundle path)', async () => {
    const {client, calls} = fakeClient();
    const result = await importDoc(client, makeDoc());
    expect(result.strategy).toBe('bundle');
    expect(calls.imports).toHaveLength(1);
    expect(calls.pages).toHaveLength(0);
  });
});

// ── importedBlocksToSnapshot ─────────────────────────────────────────────────

describe('importedBlocksToSnapshot', () => {
  it('produces a blocks-editor snapshot (no CRDT update)', () => {
    const snap = importedBlocksToSnapshot([{type: 'paragraph', text: [{t: 'hi'}]}]);
    expect(snap.editor).toBe('blocks');
    expect((snap.blockdoc as {blocks: unknown[]; update?: unknown}).blocks).toHaveLength(1);
    expect((snap.blockdoc as {update?: unknown}).update).toBeUndefined();
  });
});
