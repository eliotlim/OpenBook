import {describe, expect, it, vi} from 'vitest';
import {PAGE_TEMPLATES, SAMPLE_DOCUMENT_NAME, instantiateTemplate, type PageTemplate} from '@book.dev/sdk';
import type {DatabaseSchema, DataClient, PageMeta, StoredPage} from '@book.dev/sdk';
import {decodeSnapshot, rootBlocks, walkBlocks, blockProp, blockType, type BlockDocSnapshot, type BlockMap} from '@/blockeditor/model';
import {computeScope, evalExpr, setNamedNumber} from '@/blockeditor/kit/scope';

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

/** Block-doc showcases shaped as slide decks (tagged `slides`): divider-cut
 *  slides, speaker notes, and the full visual kit. */
const SLIDE_DECK_IDS = ['grocery-tracker', 'project-intake', 'savings-planner', 'pitch-deck'] as const;
/** Every block-doc template (the decks plus the single-page dashboards). */
const BLOCK_DOC_IDS = [...SLIDE_DECK_IDS, 'compound-growth', 'team-status'] as const;
const DATABASE_IDS = ['task-board', 'reading-list', 'roadmap', 'field-map'] as const;

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

describe('PAGE_TEMPLATES', () => {
  it('has ten templates with unique ids, names, and icons', () => {
    const ids = PAGE_TEMPLATES.map((t) => t.id);
    const names = PAGE_TEMPLATES.map((t) => t.pageName);
    expect(PAGE_TEMPLATES).toHaveLength(10);
    expect(new Set(ids)).toEqual(new Set([...BLOCK_DOC_IDS, ...DATABASE_IDS]));
    expect(new Set(names).size).toBe(PAGE_TEMPLATES.length);
    for (const t of PAGE_TEMPLATES) expect(t.icon.length).toBeGreaterThan(0);
  });

  it('builds block-doc artifacts for the showcases and databases for the four fixtures', async () => {
    for (const t of PAGE_TEMPLATES) {
      const client = stubClient([]);
      await t.create(client, t.pageName);
      const madeDb = (client.createDatabase as ReturnType<typeof vi.fn>).mock.calls.length > 0;
      if ((DATABASE_IDS as readonly string[]).includes(t.id)) {
        expect(madeDb).toBe(true);
        expect((client.createRow as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0);
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
      const {results} = computeScope(await docOf(id));
      for (const [blockId, res] of results) {
        expect(res.error, `${id}: live block ${blockId} → ${res.error}`).toBeUndefined();
      }
    }
  });
});

describe('grocery price tracker', () => {
  it('picks the cheapest shop and its saving from the basket sliders', async () => {
    const {scope} = computeScope(await docOf('grocery-tracker'));
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
    const gallery = schema.views.find((v) => v.type === 'gallery')!;
    expect(gallery.groupByPropertyId).toBe('p_shelf');
    expect(gallery.coverPropertyId).toBe('p_cover');
    expect(schema.views.some((v) => v.type === 'table')).toBe(true);
  });
});

describe('project intake', () => {
  it('keeps the gated wizard and prioritises effort vs impact live', async () => {
    const doc = await docOf('project-intake');
    const {scope} = computeScope(doc);
    // The gated accordion with its three stages (the kit-blocks e2e fixture).
    const accordion = allBlocks(doc).find((b) => blockType(b) === 'accordion')!;
    const sections = allBlocks(doc).filter((b) => blockType(b) === 'accordionsection');
    expect(blockProp<boolean>(accordion, 'gated')).toBe(true);
    expect(sections.map((s) => blockProp<string>(s, 'label'))).toEqual(['Basics', 'Scope', 'Details']);
    expect(allBlocks(doc).some((b) => (blockType(b) as string) === 'choicecards')).toBe(true);
    // Live prioritisation + the accordion's auto-computed completion signals.
    expect(scope.verdict).toBe('Do it now'); // impact 7 ≥ effort 4 × 1.5 (= 6)
    expect(evalExpr('intake.ratio', scope).error).toBeUndefined();
    expect(evalExpr('intake.complete', scope).error).toBeUndefined();
  });
});

describe('savings & investing', () => {
  it('projects a compounding balance and an emergency-fund runway', async () => {
    const {scope} = computeScope(await docOf('savings-planner'));
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
    const {scope} = computeScope(doc);
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
    const {scope} = computeScope(doc);
    const pulse = scope.pulse as Record<string, {value: unknown}>;
    expect(pulse.kudos.value).toBe(3);
    expect(pulse.onCall.value).toBe(true);
    expect(pulse.focus.value).toBe('shipping');
    expect(scope.morale).toBe(35); // 3 kudos × 10 + on-call 5

    // The action button's increment path: bump the counter it targets and the
    // formula tracks it (what the e2e drives through the real button).
    setNamedNumber(doc, 'kudos', (v) => v + 1);
    expect(computeScope(doc).scope.morale).toBe(45);
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
    const {scope} = computeScope(await docOf('compound-growth'));
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
});
