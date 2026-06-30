import {describe, expect, it} from 'vitest';
import {zipSync, strToU8} from 'fflate';
import {notionExportToImportedDoc, parseCsv} from './notionImport';
import {remapBundle} from './backup';
import {
  buildImportBundle,
  importDoc,
  IMAGE_PLACEHOLDER_PROP,
  type ImportedBlock,
  type ImportedDoc,
  type ImportedPage,
  type ImportTextRun,
  type ImportWriteClient,
} from './import';
import type {DatabaseProperty} from './database';

// ── A synthetic Notion "Markdown & CSV" export ───────────────────────────────

const hex = (c: string): string => c.repeat(32);
const A = hex('a'); // Launch Plan (root page, has an emoji icon + a child)
const B = hex('b'); // Kickoff Notes (child page, a mention target)
const C = hex('c'); // Team Tasks (database)
const D = hex('d'); // Ship v1 (a database row page, with a body)
const E = hex('e'); // a link target NOT in the export (unresolved)

const ROOT_MD = [
  '# 🚀 Launch Plan',
  '',
  `The plan to launch. See [Kickoff Notes](Launch%20Plan%20${A}/Kickoff%20Notes%20${B}.md)`,
  `and [Missing Page](Ghost%20Page%20${E}.md).`,
  '',
  '![architecture](images/arch.png)',
  '',
  '- ▸ FAQ toggle',
  '    - What ships first?',
  '    - When does it land?',
].join('\n');

const KICKOFF_MD = '# Kickoff Notes\n\nNotes from the kickoff meeting.';
const SHIP_MD = '# Ship v1\n\nShip the first version of the product.';

const CSV = [
  'Name,Status,Priority,Tags,Estimate,Done,Owner URL,Contact,Due,Linked',
  'Ship v1,In progress,High,"backend, api",5,Yes,https://ex.com/ship,a@ex.com,2026-07-01,Write docs',
  'Write docs,Todo,Low,docs,2,No,https://ex.com/docs,b@ex.com,2026-07-15,Review',
  'Review,In progress,High,,3,No,,c@ex.com,2026-08-01,Ship v1',
].join('\n');

function notionZip(extra: Record<string, string> = {}): Uint8Array {
  const files: Record<string, string> = {
    [`Export-test/Launch Plan ${A}.md`]: ROOT_MD,
    [`Export-test/Launch Plan ${A}/Kickoff Notes ${B}.md`]: KICKOFF_MD,
    [`Export-test/Team Tasks ${C}.csv`]: CSV,
    [`Export-test/Team Tasks ${C}/Ship v1 ${D}.md`]: SHIP_MD,
    // OS junk that must be ignored, not imported.
    '__MACOSX/._Launch Plan.md': 'junk',
    'Export-test/.DS_Store': 'junk',
    ...extra,
  };
  const tree: Record<string, Uint8Array> = {};
  for (const [k, v] of Object.entries(files)) tree[k] = strToU8(v);
  return zipSync(tree);
}

// ── Helpers over the IR ──────────────────────────────────────────────────────

const plain = (b: ImportedBlock | undefined): string => (b?.text ?? []).map((r) => r.t).join('');

const propByName = (props: DatabaseProperty[], name: string): DatabaseProperty =>
  props.find((p) => p.name === name)!;

/** Every run carrying a mention (`a.m`) anywhere in a block tree. */
function mentionRuns(blocks: ImportedBlock[]): ImportTextRun[] {
  const out: ImportTextRun[] = [];
  for (const b of blocks) {
    for (const r of b.text ?? []) if (r.a?.m) out.push(r);
    if (b.children) out.push(...mentionRuns(b.children));
  }
  return out;
}

/** Every word of human text across the whole imported doc — for never-drop. */
function allText(doc: ImportedDoc): string {
  let s = '';
  const blocks = (bs: ImportedBlock[]): void => {
    for (const b of bs) {
      s += `${plain(b)} `;
      const asset = b.props?.[IMAGE_PLACEHOLDER_PROP] as {ref?: string} | undefined;
      if (asset?.ref) s += `${asset.ref} `;
      if (b.children) blocks(b.children);
    }
  };
  const page = (p: ImportedPage): void => {
    s += `${p.title} ${p.icon ?? ''} `;
    blocks(p.blocks);
    for (const prop of p.database?.schema.properties ?? []) {
      s += `${prop.name} ${(prop.options ?? []).map((o) => o.label).join(' ')} `;
    }
    for (const r of p.database?.rows ?? []) {
      s += `${r.title} `;
      blocks(r.blocks ?? []);
    }
    for (const ch of p.children ?? []) page(ch);
  };
  doc.pages.forEach(page);
  return s;
}

// ── CSV parser ───────────────────────────────────────────────────────────────

describe('parseCsv', () => {
  it('handles quoted commas, doubled quotes, and CRLF', () => {
    const m = parseCsv('a,b,c\r\n"x,y","he said ""hi""",z\r\n');
    expect(m).toEqual([
      ['a', 'b', 'c'],
      ['x,y', 'he said "hi"', 'z'],
    ]);
  });

  it('keeps a newline inside a quoted field', () => {
    const m = parseCsv('Name,Note\n"Row","line one\nline two"');
    expect(m[1]).toEqual(['Row', 'line one\nline two']);
  });
});

// ── Page tree + folder nesting ───────────────────────────────────────────────

describe('notionExportToImportedDoc — page tree', () => {
  const doc = notionExportToImportedDoc(notionZip());

  it('maps folder nesting to the page children tree, stripping the hash suffix', () => {
    expect(doc.pages.map((p) => p.title)).toEqual(['Launch Plan', 'Team Tasks']);
    const launch = doc.pages[0];
    expect(launch.children?.map((c) => c.title)).toEqual(['Kickoff Notes']);
  });

  it('lifts a leading emoji on the title into the page icon', () => {
    expect(doc.pages[0].icon).toBe('🚀');
    expect(doc.pages[0].title).toBe('Launch Plan');
  });

  it('pins a stable bundle id derived from the Notion id (for mention resolution)', () => {
    expect(doc.pages[0].id).toBe(`imp_n_${A}`);
    expect(doc.pages[0].children?.[0].id).toBe(`imp_n_${B}`);
  });
});

// ── Database: schema inference + rows ────────────────────────────────────────

describe('notionExportToImportedDoc — database', () => {
  const doc = notionExportToImportedDoc(notionZip());
  const db = doc.pages[1].database!;
  const props = db.schema.properties;

  it('infers a scalar property type per column', () => {
    expect(props.map((p) => [p.name, p.type])).toEqual([
      ['Status', 'select'],
      ['Priority', 'select'],
      ['Tags', 'multi_select'],
      ['Estimate', 'number'],
      ['Done', 'checkbox'],
      ['Owner URL', 'url'],
      ['Contact', 'email'],
      ['Due', 'date'],
      ['Linked', 'text'],
    ]);
  });

  it('degrades a relation-style column (no CSV type) to a scalar — never relation/rollup/formula', () => {
    // "Linked" holds related row titles; with no schema it lands as plain text.
    expect(propByName(props, 'Linked').type).toBe('text');
    for (const p of props) expect(['relation', 'rollup', 'formula', 'dependency']).not.toContain(p.type);
  });

  it('parses rows, coercing each cell to its column type', () => {
    expect(db.rows.map((r) => r.title)).toEqual(['Ship v1', 'Write docs', 'Review']);
    const ship = db.rows[0];
    const status = propByName(props, 'Status');
    const tags = propByName(props, 'Tags');
    expect(ship.properties![status.id]).toBe(status.options!.find((o) => o.label === 'In progress')!.id);
    expect(ship.properties![tags.id]).toEqual(
      ['backend', 'api'].map((l) => tags.options!.find((o) => o.label === l)!.id),
    );
    expect(ship.properties![propByName(props, 'Estimate').id]).toBe(5);
    expect(ship.properties![propByName(props, 'Done').id]).toBe(true);
    expect(ship.properties![propByName(props, 'Due').id]).toBe('2026-07-01');
    expect(ship.properties![propByName(props, 'Owner URL').id]).toBe('https://ex.com/ship');
  });

  it('links a row to its `.md` body, and lands a body-less row with just its properties', () => {
    expect(plain(db.rows[0].blocks?.[0])).toContain('Ship the first version');
    expect(db.rows[1].blocks).toEqual([]); // "Write docs" has no row page
    expect(db.rows[1].properties![propByName(props, 'Priority').id]).toBe(
      propByName(props, 'Priority').options!.find((o) => o.label === 'Low')!.id,
    );
  });
});

// ── Links, images, never-drop ────────────────────────────────────────────────

describe('notionExportToImportedDoc — links, images, never-drop', () => {
  const doc = notionExportToImportedDoc(notionZip());
  const launch = doc.pages[0];

  it('resolves an internal link to an imported page as a mention run', () => {
    const mentions = mentionRuns(launch.blocks);
    expect(mentions).toHaveLength(1);
    expect(mentions[0].a?.m).toBe(`imp_n_${B}`);
    expect(mentions[0].t).toBe('Kickoff Notes');
  });

  it('keeps the visible text of an unresolved internal link (never drops it)', () => {
    const text = launch.blocks.map(plain).join(' ');
    expect(text).toContain('Missing Page');
    // ...but it is neither a (dead) mention nor a click-to-nowhere relative link.
    const runs = launch.blocks.flatMap((b) => b.text ?? []);
    const missing = runs.find((r) => r.t === 'Missing Page')!;
    expect(missing.a?.m).toBeUndefined();
    expect(missing.a?.a).toBeUndefined();
  });

  it('preserves an image as a placeholder that keeps the ref (not a mention)', () => {
    const img = launch.blocks.find((b) => b.props?.[IMAGE_PLACEHOLDER_PROP]);
    expect(img).toBeDefined();
    expect((img!.props![IMAGE_PLACEHOLDER_PROP] as {ref: string}).ref).toContain('arch.png');
  });

  it('never silently drops content (flattened toggle, links, rows, bodies)', () => {
    const text = allText(doc);
    for (const word of [
      'Launch Plan', '🚀', 'Kickoff', 'kickoff meeting', 'first version',
      'Missing Page', 'FAQ toggle', 'What ships first', 'backend',
      'Ship v1', 'Write docs', 'Review', 'arch.png',
    ]) {
      expect(text, `missing "${word}"`).toContain(word);
    }
  });
});

// ── Round-trip through importDoc → Strategy B bundle ─────────────────────────

describe('notionExportToImportedDoc → importDoc bundle', () => {
  it('lands the whole tree via the bundle strategy', async () => {
    const doc = notionExportToImportedDoc(notionZip());
    let captured: {pages: unknown[]; databases: unknown[]} | undefined;
    const client: ImportWriteClient = {
      savePage: () => Promise.reject(new Error('not used')),
      setPageProperties: () => Promise.reject(new Error('not used')),
      createDatabase: () => Promise.reject(new Error('not used')),
      createRow: () => Promise.reject(new Error('not used')),
      importSpace: (req) => {
        captured = {pages: req.pages, databases: req.databases};
        return Promise.resolve({created: req.pages.length, overwritten: 0, renamed: 0, idMap: {}});
      },
    };
    const result = await importDoc(client, doc);
    expect(result.strategy).toBe('bundle');
    // The host page + its row pages + the nested child page are all staged.
    expect(captured!.databases).toHaveLength(1);
    expect(captured!.pages.length).toBeGreaterThanOrEqual(5);
  });

  it('re-keys the bundle so a cross-page mention follows its target through copy-mode remap', () => {
    const doc = notionExportToImportedDoc(notionZip());
    const {pages, databases} = buildImportBundle(doc);
    let n = 0;
    const {pages: remapped, idMap} = remapBundle(pages, databases, () => `srv_${++n}`);

    // The Kickoff page was pinned `imp_n_B`; copy-mode minted it a fresh id.
    const newKickoffId = idMap[`imp_n_${B}`];
    expect(newKickoffId).toBeTruthy();

    // The Launch page's block-doc mention now points at that fresh id (not the
    // stale synthetic one) — the backup remap rewrites the `m` run form too.
    const launch = remapped.find((p) => p.name === 'Launch Plan')!;
    const blocks = (launch.data.blockdoc as {blocks: ImportedBlock[]}).blocks;
    expect(mentionRuns(blocks).map((r) => r.a?.m)).toEqual([newKickoffId]);
  });
});
