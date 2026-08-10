import {unzlibSync} from 'fflate';
import {describe, expect, it, vi} from 'vitest';
import {buildSampleDocument, PAGE_TEMPLATES, SAMPLE_DOCUMENT_NAME, coverImageUrl, instantiateTemplate, type PageTemplate} from '@book.dev/sdk';
import type {DatabaseSchema, DataClient, PageMeta, StoredPage} from '@book.dev/sdk';
import {decodeSnapshot, rootBlocks, walkBlocks, blockProp, blockType, type BlockDocSnapshot, type BlockMap} from '@/blockeditor/model';
import {computeScopeAuthoritative, evalExpr, setNamedNumber} from '@/blockeditor/kit/scope';

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

/** A client stub: page list + create/update fns the templates exercise. */
function stubClient(existing: string[]): DataClient {
  let seq = 0;
  return {
    listPages: vi.fn(async () => existing.map((name, i) => ({id: `p${i}`, name}) as PageMeta)),
    savePage: vi.fn(async (input: {name?: string | null}) => page({name: input.name ?? null})),
    createDatabase: vi.fn(async (input: {id?: string}) => ({id: input.id ?? 'db-1', pageId: 'pg-1', name: 'X', schema: {properties: [], views: []}})),
    // Distinct ids per row, so seeded cross-row links (relations/dependencies)
    // are tellable-apart in assertions.
    createRow: vi.fn(async () => page({id: `row-${(seq += 1)}`})),
    updateRow: vi.fn(async () => ({id: 'row-0', name: null, properties: {}, exports: {}})),
    ledgerInit: vi.fn(async () => ({initialized: true})),
    ledgerCreateAccount: vi.fn(async (input: {name: string; type: string; currency?: string}) => ({id: crypto.randomUUID(), ...input, status: 'open', currency: input.currency ?? 'USD', evidenceRequired: false, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z'})),
    ledgerCreateDraft: vi.fn(async () => ({id: 'draft-1', state: 'draft', postings: []})),
    ledgerPostTransaction: vi.fn(async () => ({id: 'draft-1', state: 'posted'})),
  } as unknown as DataClient;
}

/** Block-doc showcases shaped as slide decks (tagged `slides`): divider-cut
 *  slides, speaker notes, and the full visual kit. */
const SLIDE_DECK_IDS = ['grocery-tracker', 'project-intake', 'savings-planner', 'pitch-deck'] as const;
/** Every block-doc template (the decks plus the single-page dashboards). */
const BLOCK_DOC_IDS = [...SLIDE_DECK_IDS, 'compound-growth', 'team-status'] as const;
// Templates that create a database (the four fixtures, the two-database Product HQ,
// and the Dashboard — which lands on a document but seeds a sample sales database).
const DATABASE_IDS = ['task-board', 'reading-list', 'roadmap', 'field-map', 'product-hq', 'dashboard'] as const;
// Ledger templates: block-doc pages backed by the ledger plugin's double-entry
// accounting system (no reactive live code, no database — they seed accounts
// and transactions through the ledger API).
const LEDGER_IDS = ['simple-budget', 'startup-books'] as const;

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
    data: {editor?: string; blockdoc?: {blocks: Array<Record<string, unknown>>}};
  };
  expect(call.data.editor).toBe('blocks');
  return call.data.blockdoc?.blocks ?? [];
}

/** Decode a block-doc template into a live Y.Doc, exactly as the app does on load. */
async function docOf(id: PageTemplate['id']) {
  const blocks = await blockdocOf(id);
  return decodeSnapshot({v: 1, update: '', blocks} as unknown as BlockDocSnapshot);
}

/** Every block in the doc (depth-first, including nested), as a flat list. */
function allBlocks(doc: ReturnType<typeof decodeSnapshot>): BlockMap[] {
  return [...walkBlocks(rootBlocks(doc))].map((w) => w.block);
}

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

/** Adler-32 over a byte array — the checksum a zlib stream stores in its last
 *  four bytes, recomputed so we can prove the inflated IDAT matches it. */
function adler32(data: Uint8Array): number {
  let a = 1;
  let b = 0;
  const MOD = 65521;
  for (let i = 0; i < data.length; i++) {
    a = (a + data[i]) % MOD;
    b = (b + a) % MOD;
  }
  return ((b << 16) | a) >>> 0;
}

/**
 * Decode a `data:image/png;base64,…` cover far enough to prove it isn't corrupt.
 * The real defect (a mangled teal cover) had a valid signature AND an IEND — only
 * its IDAT zlib stream was bad — so a `toBeVisible()` (and even a signature+IEND
 * check) sails straight past it. The guard that actually catches it: inflate the
 * IDAT and confirm (a) it yields the exact raw-scanline byte count the IHDR
 * implies, and (b) its recomputed Adler-32 matches the checksum the zlib stream
 * trailer stores. Returns the inflated byte length so callers can assert size.
 */
function decodeSeededPng(dataUri: string): number {
  const b64 = dataUri.replace(/^data:image\/png;base64,/, '');
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  const dv = new DataView(buf.buffer);
  expect([...buf.subarray(0, 8)], 'PNG signature').toEqual(PNG_SIGNATURE);

  const idat: Uint8Array[] = [];
  let width = 0;
  let height = 0;
  let sawIend = false;
  let off = 8;
  while (off + 8 <= buf.length) {
    const len = dv.getUint32(off);
    const type = String.fromCharCode(buf[off + 4], buf[off + 5], buf[off + 6], buf[off + 7]);
    if (type === 'IHDR') {
      width = dv.getUint32(off + 8);
      height = dv.getUint32(off + 12);
    }
    if (type === 'IDAT') idat.push(buf.subarray(off + 8, off + 8 + len));
    if (type === 'IEND') sawIend = true;
    off += 12 + len;
  }
  expect(sawIend, 'IEND chunk').toBe(true);
  expect(idat.length, 'IDAT chunk(s)').toBeGreaterThan(0);

  const zlibStream = new Uint8Array(idat.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of idat) {
    zlibStream.set(p, o);
    o += p.length;
  }
  const inflated = unzlibSync(zlibStream);
  // Exact raw-scanline size: (w*3 + 1 filter byte) per row, for 8-bit RGB.
  expect(inflated.length, 'inflated scanline bytes').toBe(height * (width * 3 + 1));
  // …and the stored Adler-32 (last four bytes of the zlib stream) must match the
  // recomputed one — a corrupt stream decompresses to a mismatching checksum.
  const storedAdler = new DataView(zlibStream.buffer, zlibStream.byteOffset + zlibStream.length - 4, 4).getUint32(0) >>> 0;
  expect(adler32(inflated), 'IDAT Adler-32').toBe(storedAdler);
  return inflated.length;
}

describe('PAGE_TEMPLATES', () => {
  it('has twelve templates with unique ids, names, and icons', () => {
    const ids = PAGE_TEMPLATES.map((t) => t.id);
    const names = PAGE_TEMPLATES.map((t) => t.pageName);
    expect(PAGE_TEMPLATES).toHaveLength(14);
    expect(new Set(ids)).toEqual(new Set([...BLOCK_DOC_IDS, ...DATABASE_IDS, ...LEDGER_IDS]));
    expect(new Set(names).size).toBe(PAGE_TEMPLATES.length);
    for (const t of PAGE_TEMPLATES) expect(t.icon.length).toBeGreaterThan(0);
  });

  it('builds block-doc artifacts for the showcases and databases for the fixtures', async () => {
    for (const t of PAGE_TEMPLATES) {
      const client = stubClient([]);
      await t.create(client, t.pageName);
      const madeDb = (client.createDatabase as ReturnType<typeof vi.fn>).mock.calls.length > 0;
      if ((DATABASE_IDS as readonly string[]).includes(t.id)) {
        expect(madeDb).toBe(true);
        expect((client.createRow as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0);
      } else if ((LEDGER_IDS as readonly string[]).includes(t.id)) {
        expect(madeDb).toBe(false);
        expect((client.ledgerInit as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0);
        expect((client.ledgerCreateAccount as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0);
      } else {
        expect(madeDb).toBe(false);
      }
    }
  });
});

describe('block-doc artifacts', () => {
  it('every slide deck is slide-able (dividers) and has speaker notes', async () => {
    for (const id of SLIDE_DECK_IDS) {
      const doc = await docOf(id);
      const roots = [...rootBlocks(doc)];
      const topTypes = roots.map((b) => blockType(b));
      expect(topTypes.filter((t) => t === 'divider').length, `${id}: dividers`).toBeGreaterThanOrEqual(1);
      expect(topTypes.filter((t) => t === 'notes').length, `${id}: notes`).toBeGreaterThanOrEqual(2);
    }
  });

  it('every block doc has live code, hidden by default', async () => {
    for (const id of BLOCK_DOC_IDS) {
      const code = allBlocks(await docOf(id)).filter((b) => blockType(b) === 'code' && blockProp<boolean>(b, 'live'));
      expect(code.length, `${id}: live code`).toBeGreaterThanOrEqual(1);
      // The brief: interactive code is present but hidden by default.
      for (const c of code) expect(blockProp<boolean>(c, 'collapsed'), `${id}: collapsed code`).toBe(true);
    }
  });

  it('every slide deck carries the visual kit (charts, status lights, columns, callouts)', async () => {
    for (const id of SLIDE_DECK_IDS) {
      const types = new Set(allBlocks(await docOf(id)).map((b) => blockType(b) as string));
      expect(types.has('kitchart'), `${id}: chart`).toBe(true);
      expect(types.has('statuslight'), `${id}: status light`).toBe(true);
      expect(types.has('columns'), `${id}: columns`).toBe(true);
      expect(types.has('callout'), `${id}: callout`).toBe(true);
    }
  });

  it('the slide decks are exactly the templates tagged `slides`', () => {
    const tagged = PAGE_TEMPLATES.filter((t) => t.tags.includes('slides')).map((t) => t.id);
    expect(new Set(tagged)).toEqual(new Set(SLIDE_DECK_IDS));
  });

  it('every reactive expression evaluates without error', async () => {
    for (const id of BLOCK_DOC_IDS) {
      const {results} = await computeScopeAuthoritative(await docOf(id));
      for (const [blockId, res] of results) {
        expect(res.error, `${id}: live block ${blockId} → ${res.error}`).toBeUndefined();
      }
    }
  });
});

describe('grocery price tracker', () => {
  it('picks the cheapest shop and its saving from the basket sliders', async () => {
    const {scope} = await computeScopeAuthoritative(await docOf('grocery-tracker'));
    expect(scope.best).toBe(86); // min(86, 99, 112)
    expect(scope.store).toBe('Aldi');
    expect(scope.saving).toBe(26); // 112 − 86
    expect(String(scope.headline)).toContain('Aldi');
  });
});

describe('project task board (database)', () => {
  it('opens on a board grouped by status, with a table and seeded rows', async () => {
    const schema = await schemaOf('task-board');
    const status = schema.properties.find((p) => p.id === 'p_status')!;
    expect(status.type).toBe('status');
    expect(schema.views[0].type).toBe('board'); // the default view is the board
    const board = schema.views.find((v) => v.type === 'board')!;
    expect(board.groupByPropertyId).toBe('p_status');
    expect(schema.views.some((v) => v.type === 'table')).toBe(true);
    // A calendar view lays the tasks out on a month grid by their due date.
    const calendar = schema.views.find((v) => v.type === 'calendar')!;
    expect(calendar.datePropertyId).toBe('p_due');

    const template = PAGE_TEMPLATES.find((t) => t.id === 'task-board') as PageTemplate;
    const client = stubClient([]);
    await template.create(client, template.pageName);
    const rows = (client.createRow as ReturnType<typeof vi.fn>).mock.calls;
    expect(rows.length).toBeGreaterThanOrEqual(6);
  });
});

describe('reading list (database)', () => {
  it('exposes a shelf-grouped gallery with covers, plus a table', async () => {
    const schema = await schemaOf('reading-list');
    const shelf = schema.properties.find((p) => p.id === 'p_shelf')!;
    expect(shelf.type).toBe('select');
    expect(schema.properties.some((p) => p.type === 'rating')).toBe(true);
    const cover = schema.properties.find((p) => p.id === 'p_cover')!;
    expect(cover.type).toBe('files'); // the gallery cover renders a files-cell URL
    const gallery = schema.views.find((v) => v.type === 'gallery')!;
    expect(gallery.groupByPropertyId).toBe('p_shelf');
    expect(gallery.coverPropertyId).toBe('p_cover');
    expect(schema.views.some((v) => v.type === 'table')).toBe(true);
  });

  it('seeds inline image covers so the gallery renders real cards (one per shelf)', async () => {
    const template = PAGE_TEMPLATES.find((t) => t.id === 'reading-list') as PageTemplate;
    const client = stubClient([]);
    await template.create(client, template.pageName);
    const rows = (client.createRow as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[1] as {properties: Record<string, unknown>},
    );
    // Some rows carry covers, some don't (the placeholder path stays exercised).
    const covered = rows.filter((r) => Array.isArray(r.properties.p_cover));
    expect(covered.length).toBeGreaterThanOrEqual(2);
    // Every seeded cover is a loadable inline PNG (never SVG, never a store id) so
    // coverImageUrl resolves it straight into <img src> on both transports.
    for (const r of covered) {
      const urls = r.properties.p_cover as string[];
      expect(urls.length).toBe(1);
      expect(urls[0]).toMatch(/^data:image\/png;base64,/);
      expect(coverImageUrl(urls)).toBe(urls[0]);
    }
    // A cover lands in each of the three shelves, so no group is cover-less.
    const shelves = new Set(covered.map((r) => r.properties.p_shelf));
    expect(shelves).toEqual(new Set(['opt_toread', 'opt_reading', 'opt_done']));
  });

  it('every seeded cover is a decodable PNG (IDAT inflates — no silent corruption)', async () => {
    const template = PAGE_TEMPLATES.find((t) => t.id === 'reading-list') as PageTemplate;
    const client = stubClient([]);
    await template.create(client, template.pageName);
    const covers = (client.createRow as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => (c[1] as {properties: Record<string, unknown>}).properties.p_cover)
      .filter((v): v is string[] => Array.isArray(v))
      .map((urls) => urls[0]);
    expect(covers.length).toBeGreaterThanOrEqual(3); // one per shelf
    // Each cover must base64-decode to a valid PNG whose IDAT zlib-decompresses
    // (a bad Adler-32 throws) — the guard that would have caught the corrupt
    // teal cover a plain `toBeVisible()` sailed straight past.
    for (const uri of covers) {
      const decoded = decodeSeededPng(uri);
      expect(decoded, `decoded scanline bytes for ${uri.slice(0, 40)}…`).toBeGreaterThan(1000);
    }
  });
});

describe('project intake', () => {
  it('keeps the gated wizard and prioritises effort vs impact live', async () => {
    const doc = await docOf('project-intake');
    const {scope} = await computeScopeAuthoritative(doc);
    // The gated accordion with its three stages (the kit-blocks e2e fixture).
    const accordion = allBlocks(doc).find((b) => blockType(b) === 'accordion')!;
    const sections = allBlocks(doc).filter((b) => blockType(b) === 'accordionsection');
    expect(blockProp<boolean>(accordion, 'gated')).toBe(true);
    expect(sections.map((s) => blockProp<string>(s, 'label'))).toEqual(['Basics', 'Scope', 'Details']);
    expect(allBlocks(doc).some((b) => (blockType(b) as string) === 'choicecards')).toBe(true);
    // Live prioritisation + the accordion's auto-computed completion signals.
    expect(scope.verdict).toBe('Do it now'); // impact 7 ≥ effort 4 × 1.5 (= 6)
    expect((await evalExpr('intake.ratio', scope)).error).toBeUndefined();
    expect((await evalExpr('intake.complete', scope)).error).toBeUndefined();
  });
});

describe('savings & investing', () => {
  it('projects a compounding balance and an emergency-fund runway', async () => {
    const {scope} = await computeScopeAuthoritative(await docOf('savings-planner'));
    const projection = scope.projection as {Invested: number[]; Projected: number[]};
    expect(projection.Projected).toHaveLength(21); // years 20 → 21 points incl. year 0
    expect(scope.final).toBe(projection.Projected[projection.Projected.length - 1]);
    expect(typeof scope.final).toBe('number');
    expect(scope.final as number).toBeGreaterThan(0);
    expect(String(scope.headline)).toContain('After 20 years');
    expect(scope.months).toBe(4.4); // 8000 / 1800
  });
});

describe('pitch deck', () => {
  it('is a five-slide deck with a note per slide and a live donut driven by the sliders', async () => {
    const doc = await docOf('pitch-deck');
    const roots = [...rootBlocks(doc)];
    const topTypes = roots.map((b) => blockType(b));
    // Five slides = four top-level dividers, and speaker notes on every slide.
    expect(topTypes.filter((t) => t === 'divider').length).toBe(4);
    expect(topTypes.filter((t) => t === 'notes').length).toBe(5);
    // The first callout teaches the ⋯ → Present entry point.
    const callouts = allBlocks(doc).filter((b) => blockType(b) === 'callout');
    expect(callouts.length).toBeGreaterThanOrEqual(2);

    // The showcase chart kind: a donut (not used by any other template).
    const donut = allBlocks(doc).find((b) => (blockType(b) as string) === 'kitchart')!;
    expect(blockProp<string>(donut, 'kind')).toBe('donut');

    // Sliders → recurring-revenue share: 62 / (62 + 26 + 12) = 62%.
    const {scope} = await computeScopeAuthoritative(doc);
    expect(scope.recurring).toBe(62);
  });

  it('tags itself interactive + slides', () => {
    const template = PAGE_TEMPLATES.find((t) => t.id === 'pitch-deck') as PageTemplate;
    expect(template.tags).toEqual(['interactive', 'slides']);
  });
});

describe('team status dashboard', () => {
  it('locks a synced group of live controls, with a funnel chart and a tabs container', async () => {
    const doc = await docOf('team-status');
    const blocks = allBlocks(doc);

    // The locked group carries the cross-page sync key noted in the copy.
    const group = blocks.find((b) => blockType(b) === 'group')!;
    expect(blockProp<boolean>(group, 'locked')).toBe(true);
    expect(blockProp<string>(group, 'sync')).toBe('team-pulse');

    // The kit breadth: toggle + dropdown + counter + button + formula + light
    // in the group, a tabs container, and a funnel chart (a kind no other
    // template uses).
    const types = new Set(blocks.map((b) => blockType(b) as string));
    for (const t of ['toggle', 'dropdown', 'number', 'actionbutton', 'formula', 'statuslight', 'tabs', 'tab']) {
      expect(types.has(t), `team-status: ${t}`).toBe(true);
    }
    const chart = blocks.find((b) => (blockType(b) as string) === 'kitchart')!;
    expect(blockProp<string>(chart, 'kind')).toBe('funnel');
  });

  it('publishes the Pulse inputs namespaced, and the kudos button feeds the formula', async () => {
    const doc = await docOf('team-status');
    const {scope} = await computeScopeAuthoritative(doc);
    const pulse = scope.pulse as Record<string, {value: unknown}>;
    expect(pulse.kudos.value).toBe(2);
    expect(pulse.onCall.value).toBe(true);
    expect(pulse.focus.value).toBe('shipping');
    expect(scope.morale).toBe(25); // 2 kudos × 10 + on-call 5

    // The action button's increment path: bump the counter it targets and the
    // formula tracks it (what the e2e drives through the real button — the
    // click that flips the Momentum light from amber to green).
    setNamedNumber(doc, 'kudos', (v) => v + 1);
    expect((await computeScopeAuthoritative(doc)).scope.morale).toBe(35);
  });

  it('tags itself interactive only (a dashboard, not a deck)', () => {
    const template = PAGE_TEMPLATES.find((t) => t.id === 'team-status') as PageTemplate;
    expect(template.tags).toEqual(['interactive']);
  });
});

describe('compound growth (the sample document, in the gallery)', () => {
  it('mints a fresh copy of the sample under its own name', async () => {
    const template = PAGE_TEMPLATES.find((t) => t.id === 'compound-growth') as PageTemplate;
    expect(template.tags).toEqual(['interactive']);
    // The gallery name must NOT be the canonical sample name: the Home
    // starter's idempotent open-or-create targets that name, and the gallery
    // must never shadow it (nor vice versa).
    expect(template.pageName).not.toBe(SAMPLE_DOCUMENT_NAME);

    // Always a fresh page (a plain save — no open-or-create probing).
    const client = stubClient([template.pageName]);
    await template.create(client, `${template.pageName} 2`);
    expect(client.savePage).toHaveBeenCalledWith(expect.objectContaining({name: `${template.pageName} 2`}));
  });

  it('drives four growth curves off the months slider', async () => {
    const {scope} = await computeScopeAuthoritative(await docOf('compound-growth'));
    const growth = scope.growth as Record<string, number[]>;
    expect(Object.keys(growth)).toEqual(['3%', '5%', '7%', '10%']);
    for (const curve of Object.values(growth)) expect(curve).toHaveLength(120); // months default
  });
});

describe('roadmap swimlanes (database fixture)', () => {
  it('groups the board by a second select and bands the timeline', async () => {
    const schema = await schemaOf('roadmap');
    const board = schema.views.find((v) => v.type === 'board')!;
    const timeline = schema.views.find((v) => v.type === 'timeline')!;
    expect(board.groupByPropertyId).toBe('p_stage');
    expect(board.subGroupByPropertyId).toBe('p_area'); // horizontal swimlanes
    expect(timeline.groupByPropertyId).toBe('p_area'); // Gantt bands
  });
});

describe('field-map (database fixture)', () => {
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

describe('product hq (two linked databases)', () => {
  const template = PAGE_TEMPLATES.find((t) => t.id === 'product-hq') as PageTemplate;

  it('builds Initiatives + Tasks linked 1:n both ways, with rollups and a dependency timeline', async () => {
    const client = stubClient([]);
    await template.create(client, template.pageName);

    const dbs = (client.createDatabase as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[0] as {id: string; schema: DatabaseSchema},
    );
    expect(dbs).toHaveLength(2);
    const [initiatives, tasks] = dbs;

    // The 1:n relation pair: forward `Tasks` on Initiatives, reverse (single)
    // `Initiative` on Tasks — each referencing the OTHER pre-minted database id.
    const forward = initiatives.schema.properties.find((p) => p.id === 'p_tasks')!;
    expect(forward.type).toBe('relation');
    expect(forward.relationDatabaseId).toBe(tasks.id);
    expect(forward.relationCardinality).toBe('1:n');
    expect(forward.reversePropertyId).toBe('p_initiative');
    const reverse = tasks.schema.properties.find((p) => p.id === 'p_initiative')!;
    expect(reverse.type).toBe('relation');
    expect(reverse.relationDatabaseId).toBe(initiatives.id);
    expect(reverse.relationSingle).toBe(true);
    expect(reverse.reversePropertyId).toBe('p_tasks');

    // Rollups on Initiatives fold the linked tasks: % done + task count.
    const progress = initiatives.schema.properties.find((p) => p.id === 'p_progress')!;
    expect(progress.type).toBe('rollup');
    expect(progress.rollup).toEqual({relationPropertyId: 'p_tasks', targetPropertyId: 'p_done', function: 'percent_checked'});
    const count = initiatives.schema.properties.find((p) => p.id === 'p_count')!;
    expect(count.rollup?.function).toBe('count');

    // Tasks open on a timeline whose bars come from `When` and whose arrows
    // come from the `Blocked by` dependency property.
    expect(tasks.schema.views[0].type).toBe('timeline');
    const timeline = tasks.schema.views[0];
    expect(timeline.datePropertyId).toBe('p_when');
    expect(timeline.dependencyPropertyId).toBe('p_blockedby');
    expect(tasks.schema.properties.find((p) => p.id === 'p_blockedby')!.type).toBe('dependency');
  });

  it('seeds both sides of the relation and a dependency chain', async () => {
    const client = stubClient([]);
    await template.create(client, template.pageName);

    const rows = (client.createRow as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => ({dbId: c[0] as string, input: c[1] as {name: string | null; properties: Record<string, unknown>}}),
    );
    expect(rows.length).toBeGreaterThanOrEqual(8); // 3 initiatives + 5 tasks
    // Every task links back to exactly one initiative (the single reverse side)…
    const tasks = rows.filter((r) => r.input.properties.p_initiative !== undefined);
    expect(tasks).toHaveLength(5);
    for (const t of tasks) expect(t.input.properties.p_initiative).toHaveLength(1);
    // …some tasks are chained by the dependency, and some are done (so the
    // percent_checked rollup lands strictly between 0 and 100 somewhere).
    expect(tasks.filter((t) => Array.isArray(t.input.properties.p_blockedby)).length).toBeGreaterThanOrEqual(2);
    expect(tasks.filter((t) => t.input.properties.p_done === true).length).toBeGreaterThanOrEqual(1);
    expect(tasks.filter((t) => t.input.properties.p_done === false).length).toBeGreaterThanOrEqual(1);

    // The reverse side is written explicitly (seeding can't rely on the
    // cell-edit mirror): each initiative is patched with its task ids.
    const patches = (client.updateRow as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[2] as {properties: Record<string, unknown>},
    );
    expect(patches).toHaveLength(3);
    const linkedBack = patches.flatMap((p) => p.properties.p_tasks as string[]);
    expect(new Set(linkedBack).size).toBe(5); // every task appears exactly once
  });

  it('tags itself database', () => {
    expect(template.tags).toEqual(['database']);
  });
});

describe('sales dashboard (composite KPI + DB-backed charts)', () => {
  const template = PAGE_TEMPLATES.find((t) => t.id === 'dashboard') as PageTemplate;

  it('lands a document of DB-bound charts and seeds the sales database they read', async () => {
    const client = stubClient([]);
    await template.create(client, template.pageName);

    // Two pages: the dashboard document (saved first, so its charts' dbId is the
    // minted sample-db id) then the "… data" sub-page hosting the database.
    const saves = (client.savePage as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as {name?: string; data: {editor?: string}; parentId?: string});
    expect(saves).toHaveLength(2);
    expect(saves[0].data.editor).toBe('blocks'); // the dashboard document
    expect(saves[1].name).toMatch(/ data$/);
    expect(saves[1].parentId).toBeTruthy(); // the data DB is a sub-page

    // The sample sales database + its dozen deals.
    const dbCall = (client.createDatabase as ReturnType<typeof vi.fn>).mock.calls[0][0] as {id: string; schema: DatabaseSchema};
    const groupables = dbCall.schema.properties.filter((p) => p.type === 'select' || p.type === 'status').map((p) => p.id);
    expect(groupables).toEqual(expect.arrayContaining(['p_region', 'p_channel', 'p_stage', 'p_quarter']));
    expect(dbCall.schema.properties.some((p) => p.id === 'p_amount' && p.type === 'number')).toBe(true);
    expect((client.createRow as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(12);

    // Every kitchart is bound to that database (DASH-3 source mode), and the
    // composition covers the KPI tiles + bar + pie + trend, in column layouts.
    // Decode the SAME run's document (the dbId is a per-run minted uuid, so a
    // fresh `docOf` re-run would mint a different one).
    const blocks = (saves[0] as {data: {blockdoc?: {blocks: Array<Record<string, unknown>>}}}).data.blockdoc?.blocks ?? [];
    const doc = decodeSnapshot({v: 1, update: '', blocks} as unknown as BlockDocSnapshot);
    const charts = allBlocks(doc).filter((b) => (blockType(b) as string) === 'kitchart');
    for (const c of charts) {
      expect(blockProp<string>(c, 'sourceMode')).toBe('database');
      expect(blockProp<string>(c, 'dbId')).toBe(dbCall.id);
      expect(blockProp<string>(c, 'dbGroupBy')).toBeTruthy();
    }
    const kinds = charts.map((c) => blockProp<string>(c, 'kind'));
    expect(kinds.filter((k) => k === 'kpi').length).toBe(3); // the KPI row
    expect(kinds).toEqual(expect.arrayContaining(['bar', 'pie', 'line']));
    expect(allBlocks(doc).some((b) => (blockType(b) as string) === 'columns')).toBe(true);
  });

  it('ships a Quarter cross-filter that scopes every chart except the quarterly trend', async () => {
    const client = stubClient([]);
    await template.create(client, template.pageName);
    const saves = (client.savePage as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as {data: {blockdoc?: {blocks: Array<Record<string, unknown>>}}});
    const blocks = saves[0].data.blockdoc?.blocks ?? [];
    const doc = decodeSnapshot({v: 1, update: '', blocks} as unknown as BlockDocSnapshot);
    const all = allBlocks(doc);

    // The cross-filter control: a dropdown publishing `quarter`, defaulting to
    // the inactive "all" so the board opens showing the whole year.
    const control = all.find((b) => (blockType(b) as string) === 'dropdown');
    expect(control).toBeTruthy();
    expect(blockProp<string>(control!, 'name')).toBe('quarter');
    expect(blockProp<string>(control!, 'value')).toBe('all');

    // Every chart bound to it filters on the Quarter property — except the
    // quarterly trend (line), which IS the quarter axis and stays full-year.
    const charts = all.filter((b) => (blockType(b) as string) === 'kitchart');
    const bound = charts.filter((c) => blockProp<string>(c, 'dbFilterInput') === 'quarter');
    const unbound = charts.filter((c) => !blockProp<string>(c, 'dbFilterInput'));
    expect(bound.length).toBe(charts.length - 1);
    expect(bound.every((c) => blockProp<string>(c, 'dbFilterProp') === 'p_quarter')).toBe(true);
    expect(unbound.map((c) => blockProp<string>(c, 'kind'))).toEqual(['line']);
  });

  it('tags itself interactive (it lands on a document, not a database view)', () => {
    expect(template.tags).toEqual(['interactive']);
  });
});

describe('guidance callouts (the standardized "how to use this" lead block)', () => {
  /** The guided templates: the four database fixtures, the two-database Product
   *  HQ, and the Dashboard — the ones without strong in-doc guidance of their own,
   *  so each leads with the standardized callout. (The sample-document copy
   *  self-guides via its own intro paragraph, so it carries no standardized one.) */
  const GUIDED_IDS = ['task-board', 'reading-list', 'roadmap', 'field-map', 'product-hq', 'dashboard'] as const;

  type SavedDoc = {editor?: string; blockdoc?: {blocks: Array<Record<string, unknown>>}};
  type CalloutBlock = {type?: string; props?: {variant?: string}; text?: Array<{t?: string}>};

  /** The template's HOST page snapshot (its first savePage call). */
  async function hostDocOf(id: PageTemplate['id'], guidance?: string): Promise<SavedDoc> {
    const template = PAGE_TEMPLATES.find((t) => t.id === id) as PageTemplate;
    const client = stubClient([]);
    await template.create(client, template.pageName, guidance);
    return ((client.savePage as ReturnType<typeof vi.fn>).mock.calls[0][0] as {data: SavedDoc}).data;
  }

  it('every guided template leads with one consistent info callout', async () => {
    for (const id of GUIDED_IDS) {
      const data = await hostDocOf(id);
      expect(data.editor, `${id}: host page is a block-doc`).toBe('blocks');
      const first = data.blockdoc?.blocks[0] as CalloutBlock | undefined;
      expect(first?.type, `${id}: first block`).toBe('callout');
      expect(first?.props?.variant, `${id}: variant`).toBe('info');
      // Consistent shape: a description of what it demonstrates, THEN how to
      // try it — and the baked-in English default is exactly the text the
      // template advertises (the gallery swaps in the user's locale via the
      // same field). The lead phrasing varies per template (reading-list leads
      // on its gallery grouping, not a generic "This template shows…"), so we
      // assert the shape — a description ahead of the "Try it:" cue — not a
      // fixed opener.
      const text = (first?.text ?? []).map((r) => r.t ?? '').join('');
      expect(text.indexOf('Try it:'), `${id}: a description precedes the "Try it:" cue`).toBeGreaterThan(0);
      expect(text, `${id}: matches template.guidance`).toBe(PAGE_TEMPLATES.find((t) => t.id === id)?.guidance);
    }
  });

  it('a localized override replaces the callout text (the gallery path)', async () => {
    const data = await hostDocOf('task-board', 'Lokalisierter Hinweis');
    const first = data.blockdoc?.blocks[0] as CalloutBlock;
    expect((first.text ?? []).map((r) => r.t).join('')).toBe('Lokalisierter Hinweis');
  });

  it('product-hq guides the Initiatives page only — the Tasks sub-page stays bare', async () => {
    const template = PAGE_TEMPLATES.find((t) => t.id === 'product-hq') as PageTemplate;
    const client = stubClient([]);
    await template.create(client, template.pageName);
    const calls = (client.savePage as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(2);
    expect((calls[1][0] as {data: SavedDoc}).data.blockdoc).toBeUndefined();
  });

  it('compound-growth copies the sample verbatim — its own intro is the guide, no extra callout', async () => {
    // The sample already opens with its own intro paragraph, so the gallery copy
    // gets NO standardized callout prepended (that would double-guide): its first
    // block is `sample-intro`, exactly as the canonical seeder path produces.
    const gallery = await hostDocOf('compound-growth');
    expect((gallery.blockdoc?.blocks[0] as {id?: string}).id).toBe('sample-intro');
    const sample = buildSampleDocument().data as SavedDoc;
    expect((sample.blockdoc?.blocks[0] as {id?: string}).id).toBe('sample-intro');
  });

  it('templates that already open with strong in-doc guidance carry none', () => {
    // The database-style guided templates AND the ledger templates all carry
    // guidance text; every other template self-guides through its own content.
    const HAS_GUIDANCE = [...GUIDED_IDS, 'simple-budget', 'startup-books'] as const;
    for (const t of PAGE_TEMPLATES) {
      const guided = (HAS_GUIDANCE as readonly string[]).includes(t.id);
      expect(t.guidance !== undefined, t.id).toBe(guided);
    }
  });
});

describe('instantiateTemplate', () => {
  const grocery = PAGE_TEMPLATES.find((t) => t.id === 'grocery-tracker') as PageTemplate;

  it('uses the canonical name when free', async () => {
    const client = stubClient(['Something else']);
    await instantiateTemplate(client, grocery);
    expect(client.savePage).toHaveBeenCalledWith(expect.objectContaining({name: 'Grocery price tracker'}));
  });

  it('suffixes the name when taken (names are workspace-unique)', async () => {
    const client = stubClient(['Grocery price tracker', 'Grocery price tracker 2']);
    await instantiateTemplate(client, grocery);
    expect(client.savePage).toHaveBeenCalledWith(expect.objectContaining({name: 'Grocery price tracker 3'}));
  });

  it('threads a localized guidance text through to create', async () => {
    const taskBoard = PAGE_TEMPLATES.find((t) => t.id === 'task-board') as PageTemplate;
    const client = stubClient([]);
    await instantiateTemplate(client, taskBoard, {guidance: 'Übersetzter Hinweis'});
    const data = ((client.savePage as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      data: {blockdoc?: {blocks: Array<{text?: Array<{t?: string}>}>}};
    }).data;
    expect((data.blockdoc?.blocks[0].text ?? []).map((r) => r.t).join('')).toBe('Übersetzter Hinweis');
  });
});
