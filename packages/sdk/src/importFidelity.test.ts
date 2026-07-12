/**
 * **Import fidelity corpus + the "never silently drop content" safety net (T8).**
 *
 * The per-feature importer suites (`import.test.ts`, `markdownImport.test.ts`,
 * `notionImport.test.ts`) lock individual behaviours. This suite is the corpus +
 * the cross-cutting guarantee: a handful of *representative, realistic* fixtures
 * spanning the construct space, each asserted for **structure** (the fidelity
 * lock) and swept for **content survival** (nothing the source carried vanishes
 * from the imported IR). The sweep is automatic over every token — so adding a
 * new fixture re-uses the same net for free — and it is the regression alarm:
 * any future importer change that silently drops a heading, list item, table
 * cell, database row, or image ref trips {@link expectNoSilentDrops}, naming the
 * tokens that disappeared.
 *
 * Markdown fixtures are inline line-array constants (the repo convention for
 * markdown fixtures — see `markdownImport.test.ts`; single-quoted lines keep
 * fenced code blocks and codespans backtick-clean, and the SDK ships no
 * `@types/node`, so the suite never touches the filesystem). Notion "Markdown &
 * CSV" exports are assembled in-memory with `fflate.zipSync` (the hash-suffixed
 * path tree IS the fixture, far more reviewable than a binary zip). A final pair
 * of round-trips drives a non-trivial fixture all the way through
 * {@link importDoc} against a recording fake client — Strategy A for a lone doc,
 * Strategy B for a tree — proving content also survives the *writer*.
 */

import {describe, expect, it} from 'vitest';
import {zipSync, strToU8} from 'fflate';
import {markdownToImportedDoc} from './markdownImport';
import {notionExportToImportedDoc} from './notionImport';
import {
  importDoc,
  IMAGE_PLACEHOLDER_PROP,
  type ImportedBlock,
  type ImportedDoc,
  type ImportedPage,
  type ImportedRow,
  type ImportTextRun,
  type ImportWriteClient,
} from './import';
import type {ImportRequest} from './backup';
import type {DatabasePropertyType} from './database';
import type {StoredDatabase} from './database';
import type {PageInput, StoredPage} from './types';

// ── The "never silently drop" sweep (the reusable safety net) ────────────────

/**
 * Lowercased content tokens (alphanumeric runs of length >= 2) in a string.
 * Single-character tokens are skipped: they are dominated by structural markers
 * (`#`/`-`/`>`/`|` are non-alphanumeric and never tokenize at all; an ordered
 * marker `1.` or a task marker `[x]` reduces to a lone character), not prose.
 *
 * `stripRelativeLinks` removes *relative* markdown link targets (`](path)` with
 * no URI scheme) before tokenizing. A relative internal-link path is structural
 * addressing — the Notion importer rewrites it to an `@`-mention and deliberately
 * does NOT keep the path; the link's display text (`[label]`) is the content and
 * stays. An absolute `https:`/`mailto:` target is content and is kept, because
 * the importers preserve it verbatim as a real link href.
 */
function contentTokens(text: string, opts: {stripRelativeLinks?: boolean} = {}): Set<string> {
  const src = opts.stripRelativeLinks ? text.replace(/\]\((?!\w+:)[^)]*\)/g, ']') : text;
  const out = new Set<string>();
  for (const m of src.toLowerCase().matchAll(/[a-z0-9]{2,}/g)) out.add(m[0]);
  return out;
}

/** Append every scalar (string/number, recursing arrays) a cell value may hold. */
function pushScalar(parts: string[], value: unknown): void {
  if (typeof value === 'string' || typeof value === 'number') parts.push(String(value));
  else if (Array.isArray(value)) for (const v of value) pushScalar(parts, v);
}

/** Append every bit of human text a block sub-tree carries (the "landed" side). */
function pushBlocks(parts: string[], blocks: ImportedBlock[]): void {
  for (const b of blocks) {
    for (const r of b.text ?? []) {
      parts.push(r.t);
      if (r.a?.a) parts.push(r.a.a); // a preserved (external/asset) link href is content
    }
    if (typeof b.props?.language === 'string') parts.push(b.props.language); // code fence info string
    const asset = b.props?.[IMAGE_PLACEHOLDER_PROP] as {ref?: string; alt?: string; title?: string} | undefined;
    if (asset) parts.push(asset.ref ?? '', asset.alt ?? '', asset.title ?? '');
    if (b.children) pushBlocks(parts, b.children);
  }
}

function pushRow(parts: string[], row: ImportedRow): void {
  parts.push(row.title);
  for (const v of Object.values(row.properties ?? {})) pushScalar(parts, v);
  if (row.blocks) pushBlocks(parts, row.blocks);
  for (const c of row.children ?? []) pushRow(parts, c);
}

function pushPage(parts: string[], p: ImportedPage): void {
  parts.push(p.title, p.icon ?? '');
  pushBlocks(parts, p.blocks);
  if (p.database) {
    parts.push(p.database.name ?? '');
    for (const prop of p.database.schema.properties) {
      parts.push(prop.name);
      for (const o of prop.options ?? []) parts.push(o.label);
    }
    for (const row of p.database.rows) pushRow(parts, row);
  }
  for (const c of p.children ?? []) pushPage(parts, c);
}

/**
 * Every scrap of human-meaningful text the import IR carries: page titles +
 * icons, block runs + preserved link hrefs + code languages, image-placeholder
 * refs/alt/title, and — for a hosted database — its name, schema property names,
 * select-option labels, row titles, scalar cell values, and row bodies. This is
 * the "did it land somewhere" side of the never-drop sweep.
 */
function survivingText(doc: ImportedDoc): string {
  const parts: string[] = [];
  doc.pages.forEach((p) => pushPage(parts, p));
  return parts.join(' ');
}

/**
 * **The reusable never-drop assertion.** Every content token in `source` must
 * resurface somewhere in `doc` — as text, a run, a cell, a property value, a
 * title, or a preserved placeholder ref. `allow` lists the handful of tokens a
 * faithful *transformation* legitimately consumes (a front-matter `title:` KEY,
 * whose VALUE becomes the page title; a checkbox `Yes`/`No` that becomes a
 * boolean; a CSV title-column header), each documented at its call site. A
 * regression that silently drops content trips this and names the missing tokens.
 */
function expectNoSilentDrops(
  source: string,
  doc: ImportedDoc,
  opts: {stripRelativeLinks?: boolean; allow?: string[]} = {},
): void {
  const survived = contentTokens(survivingText(doc));
  const allow = new Set(opts.allow ?? []);
  const dropped = [...contentTokens(source, {stripRelativeLinks: opts.stripRelativeLinks})].filter(
    (t) => !survived.has(t) && !allow.has(t),
  );
  expect(dropped, `silently dropped tokens: ${dropped.join(', ')}`).toEqual([]);
}

// ── The Markdown fixtures (realistic, spanning the construct space) ──────────

/** Kitchen-sink doc: nested headings/lists/task-lists/table/code/blockquote +
 *  inline emphasis/links and both block & inline images. */
const EVERYTHING_MD = [
  '# Orion Release Notes',
  '',
  'The **Orion** release focuses on _reliability_ and adds a handful of',
  '[documented APIs](https://docs.example.com/orion). The ~~legacy~~ workflow is gone.',
  '',
  '## Highlights',
  '',
  '- Faster cold starts',
  '  - Sidecar boots in under a second',
  '    - Measured on the reference laptop',
  '- Smaller install footprint',
  '',
  '### Migration steps',
  '',
  '1. Back up your workspace',
  '2. Run the upgrade command',
  '3. Restart the desktop app',
  '',
  '#### Pre-flight checklist',
  '',
  '- [x] Snapshot taken',
  '- [ ] Canary verified',
  '',
  '> Heads up: the upgrade is irreversible.',
  '> Keep a backup until the canary looks healthy.',
  '',
  '| Component | Status | Notes |',
  '| --- | --- | --- |',
  '| Importer | shipped | parses `marked` tokens |',
  '| Sync | beta | see the **rollout** plan |',
  '',
  '```ts',
  'const timeout = 30_000;',
  'export const ready = true;',
  '```',
  '',
  '![Architecture overview](https://docs.example.com/arch.png "System diagram")',
  '',
  'Inline figures like ![sparkline](https://img.example.com/spark.svg) survive too.',
].join('\n');

/** GFM-heavy doc: task lists, an aligned table, autolinks, nested task items. */
const GFM_MD = [
  '# Sprint 42 Board',
  '',
  '## Definition of done',
  '',
  '- [x] Code reviewed by a second engineer',
  '- [x] Tests green on ~~staging~~ production',
  '- [ ] Release notes drafted',
  '- [ ] Rollback plan attached',
  '',
  '## Capacity',
  '',
  '| Engineer | Focus | Load | Profile |',
  '| :--- | :--- | ---: | :--- |',
  '| Priya | importer corpus | 80 | <https://team.example/priya> |',
  '| Marcus | sync conflicts | 60 | <https://team.example/marcus> |',
  '| Wei | desktop sidecar | 100 | <https://team.example/wei> |',
  '',
  'Autolinked tracker: <https://issues.example.com/OB-302>.',
  '',
  'Nested follow-ups:',
  '',
  '- Backend',
  '  - [ ] Cache the parsed tokens',
  '  - [x] Benchmark the importer',
  '- Frontend',
  '  - [ ] Wire the drop zone',
].join('\n');

/** Edge doc: leading YAML front-matter (title + extra keys) + a 5-level list. */
const FRONTMATTER_MD = [
  '---',
  'title: Q3 Planning Notes',
  'author: Dana Whitfield',
  'status: draft',
  'tags: [roadmap, planning]',
  '---',
  '',
  '# Overview',
  '',
  'We will focus on three pillars: durability, clarity, and momentum.',
  '',
  '## Deeply nested agenda',
  '',
  '- Durability',
  '  - Backups',
  '    - Hourly snapshots',
  '      - Verified restores',
  '        - Off-site copies',
  '- Clarity',
  '  - Documentation',
  '- Momentum',
  '  - Weekly demos',
].join('\n');

/** Edge doc: a leading `---` that is a thematic break, NOT front-matter. */
const LEADING_RULE_MD = [
  '---',
  '',
  'Release checklist for the Orion milestone. Everything below the leading rule',
  'still imports without loss.',
  '',
  '## Remaining tasks',
  '',
  '- Finalize the rollback runbook',
  '- Confirm the canary dashboards',
  '- Archive the deprecated webhooks',
].join('\n');

/** Edge doc: raw HTML + a math block + a container directive (unknown). */
const RAW_HTML_MD = [
  '# Integration guide',
  '',
  '<div class="callout">',
  '  Heads up: the webhook retries five times before giving up.',
  '</div>',
  '',
  'A formula we have not taught the parser yet:',
  '',
  '$$ throughput = requests / latency $$',
  '',
  ':::warning',
  'Custom container directives are not parsed, so keep their wording verbatim.',
  ':::',
  '',
  'Use the `OPENBOOK_TIMEOUT` variable to override the default ceiling.',
].join('\n');

// ── Small accessors over the IR ──────────────────────────────────────────────

const plain = (b: ImportedBlock | undefined): string => (b?.text ?? []).map((r) => r.t).join('');
const types = (blocks: ImportedBlock[]): string[] => blocks.map((b) => b.type);

/** Every run anywhere in a block tree (top-level + nested cells/children). */
function allRuns(blocks: ImportedBlock[]): ImportTextRun[] {
  const out: ImportTextRun[] = [];
  for (const b of blocks) {
    out.push(...(b.text ?? []));
    if (b.children) out.push(...allRuns(b.children));
  }
  return out;
}

// ════════════════════════════════════════════════════════════════════════════
//  Markdown corpus
// ════════════════════════════════════════════════════════════════════════════

describe('markdown corpus — everything.md (kitchen-sink doc)', () => {
  const source = EVERYTHING_MD;
  const doc = markdownToImportedDoc(source);
  const page = doc.pages[0];

  it('promotes the leading H1 to the page title', () => {
    expect(page.title).toBe('Orion Release Notes');
  });

  it('maps the full construct space to the expected block sequence', () => {
    expect(types(page.blocks)).toEqual([
      'paragraph', // intro (H1 consumed as title)
      'heading', // Highlights
      'list', 'list', 'list', 'list', // nested bullets + sibling
      'heading', // Migration steps
      'list', 'list', 'list', // ordered list
      'heading', // Pre-flight checklist
      'todo', 'todo', // task list
      'quote', // folded multi-line blockquote
      'table',
      'code',
      'callout', // block image placeholder
      'paragraph', // inline-image host paragraph
      'callout', // inline image placeholder (sibling)
    ]);
  });

  it('preserves inline emphasis + a link href on the intro paragraph', () => {
    const runs = page.blocks[0].text ?? [];
    expect(runs.find((r) => r.t === 'Orion')?.a).toEqual({b: true});
    expect(runs.find((r) => r.t === 'reliability')?.a).toEqual({i: true});
    expect(runs.find((r) => r.t === 'legacy')?.a).toEqual({s: true});
    expect(runs.find((r) => r.t === 'documented APIs')?.a).toEqual({a: 'https://docs.example.com/orion'});
  });

  it('flattens the nested bullet list to indent props', () => {
    const bullets = page.blocks.slice(2, 6);
    expect(bullets.map((b) => [plain(b), b.props?.indent])).toEqual([
      ['Faster cold starts', undefined],
      ['Sidecar boots in under a second', 1],
      ['Measured on the reference laptop', 2],
      ['Smaller install footprint', undefined],
    ]);
  });

  it('maps the task list to todo blocks with checked state', () => {
    const todos = page.blocks.filter((b) => b.type === 'todo');
    expect(todos.map((b) => [plain(b), b.props?.checked ?? false])).toEqual([
      ['Snapshot taken', true],
      ['Canary verified', false],
    ]);
  });

  it('folds the multi-line blockquote into a single quote block', () => {
    const quote = page.blocks.find((b) => b.type === 'quote');
    expect(plain(quote)).toBe('Heads up: the upgrade is irreversible.\nKeep a backup until the canary looks healthy.');
  });

  it('maps the GFM table to a 3-column table preserving cell formatting', () => {
    const table = page.blocks.find((b) => b.type === 'table')!;
    expect(table.props?.header).toBe(true);
    expect(table.children?.map((row) => row.children?.length)).toEqual([3, 3, 3]);
    const cell = (r: number, c: number): ImportedBlock => table.children![r].children![c];
    expect(plain(cell(0, 0))).toBe('Component');
    // the `marked` codespan + the **rollout** bold survive as cell runs
    expect(cell(1, 2).text?.find((r) => r.t === 'marked')?.a).toEqual({c: true});
    expect(cell(2, 2).text?.find((r) => r.t === 'rollout')?.a).toEqual({b: true});
  });

  it('keeps the fenced code block with its language', () => {
    const code = page.blocks.find((b) => b.type === 'code')!;
    expect(code.props?.language).toBe('ts');
    expect(plain(code)).toContain('const timeout = 30_000;');
  });

  it('turns both images into placeholders that preserve ref + alt + title', () => {
    const callouts = page.blocks.filter((b) => b.type === 'callout');
    const block = callouts[0].props?.[IMAGE_PLACEHOLDER_PROP] as {ref: string; alt: string; title: string};
    expect(block).toMatchObject({
      ref: 'https://docs.example.com/arch.png',
      alt: 'Architecture overview',
      title: 'System diagram',
    });
    const inline = callouts[1].props?.[IMAGE_PLACEHOLDER_PROP] as {ref: string; alt: string};
    expect(inline).toMatchObject({ref: 'https://img.example.com/spark.svg', alt: 'sparkline'});
  });

  it('never silently drops any source token', () => {
    expectNoSilentDrops(source, doc);
  });
});

describe('markdown corpus — gfm.md (GFM-heavy doc)', () => {
  const source = GFM_MD;
  const doc = markdownToImportedDoc(source);
  const page = doc.pages[0];

  it('maps task lists, an aligned table, autolinks, and nested task items', () => {
    expect(page.title).toBe('Sprint 42 Board');
    const todos = page.blocks.filter((b) => b.type === 'todo');
    // 4 top-level done-criteria todos + 3 nested follow-up todos
    expect(todos).toHaveLength(7);
    expect(todos.filter((b) => b.props?.checked).map(plain)).toEqual([
      'Code reviewed by a second engineer',
      'Tests green on staging production',
      'Benchmark the importer',
    ]);
    // strikethrough inside a todo survives as a run attr
    const struck = page.blocks.find((b) => plain(b) === 'Tests green on staging production');
    expect(struck?.text?.find((r) => r.t === 'staging')?.a).toEqual({s: true});
  });

  it('keeps autolinked URLs as link runs inside table cells and paragraphs', () => {
    const table = page.blocks.find((b) => b.type === 'table')!;
    const profile = table.children![1].children![3]; // Priya's profile cell
    expect(profile.text?.[0]).toEqual({t: 'https://team.example/priya', a: {a: 'https://team.example/priya'}});
    const tracker = page.blocks.find((b) => plain(b).startsWith('Autolinked tracker'))!;
    expect(tracker.text?.some((r) => r.a?.a === 'https://issues.example.com/OB-302')).toBe(true);
  });

  it('flattens nested task items under a bullet to indented todos', () => {
    const backend = page.blocks.find((b) => plain(b) === 'Backend')!;
    expect(backend.type).toBe('list');
    const cache = page.blocks.find((b) => plain(b) === 'Cache the parsed tokens')!;
    expect([cache.type, cache.props?.indent]).toEqual(['todo', 1]);
  });

  it('never silently drops any source token', () => {
    expectNoSilentDrops(source, doc);
  });
});

describe('markdown corpus — frontmatter.md (front-matter + deep nesting edge)', () => {
  const source = FRONTMATTER_MD;
  const doc = markdownToImportedDoc(source);
  const page = doc.pages[0];

  it('lifts the front-matter title and preserves the rest as a yaml code block', () => {
    expect(page.title).toBe('Q3 Planning Notes');
    const yaml = page.blocks[0];
    expect([yaml.type, yaml.props?.language]).toEqual(['code', 'yaml']);
    expect(plain(yaml)).toContain('author: Dana Whitfield');
    expect(plain(yaml)).toContain('tags: [roadmap, planning]');
    // the body H1 is kept (the title came from front-matter, not the heading)
    expect(page.blocks.some((b) => b.type === 'heading' && plain(b) === 'Overview')).toBe(true);
  });

  it('flattens the 5-level list, the indent reaching the deepest defined level (4)', () => {
    const deep = page.blocks.find((b) => plain(b) === 'Off-site copies')!;
    expect(deep.props?.indent).toBe(4);
  });

  it('never silently drops any source token (the title: KEY is consumed into the title)', () => {
    // `title` is the only structural casualty: its VALUE becomes the page title,
    // so the literal key word legitimately does not resurface as content.
    expectNoSilentDrops(source, doc, {allow: ['title']});
  });
});

describe('markdown corpus — leading-rule.md (a `---`-leading doc, NOT front-matter)', () => {
  const source = LEADING_RULE_MD;
  const doc = markdownToImportedDoc(source);
  const page = doc.pages[0];

  it('treats an unterminated leading `---` as a thematic break, not front-matter', () => {
    expect(page.title).toBe('Imported document'); // no front-matter title was consumed
    expect(page.blocks[0].type).toBe('divider'); // the leading rule survived as a divider
    expect(types(page.blocks)).toEqual(['divider', 'paragraph', 'heading', 'list', 'list', 'list']);
  });

  it('never silently drops any source token (content below the rule is intact)', () => {
    expectNoSilentDrops(source, doc);
  });
});

describe('markdown corpus — raw-html-and-unknown.md (raw HTML + unknown constructs)', () => {
  const source = RAW_HTML_MD;
  const doc = markdownToImportedDoc(source);
  const page = doc.pages[0];

  it('degrades raw HTML, a math block, and a container directive to paragraphs — never dropped', () => {
    expect(types(page.blocks)).toEqual(['paragraph', 'paragraph', 'paragraph', 'paragraph', 'paragraph']);
    expect(plain(page.blocks[0])).toContain('class="callout"'); // raw HTML markup kept verbatim
    expect(plain(page.blocks[0])).toContain('the webhook retries five times');
    expect(plain(page.blocks[2])).toBe('$$ throughput = requests / latency $$'); // unknown math block
    expect(plain(page.blocks[3])).toContain(':::warning'); // unknown container directive
  });

  it('never silently drops any source token', () => {
    expectNoSilentDrops(source, doc);
  });
});

// ════════════════════════════════════════════════════════════════════════════
//  Notion "Markdown & CSV" export corpus
// ════════════════════════════════════════════════════════════════════════════

const hex = (c: string): string => c.repeat(32);

/** Zip a path → text map into a Notion-export byte stream. */
function zipExport(files: Record<string, string>): Uint8Array {
  const tree: Record<string, Uint8Array> = {};
  for (const [k, v] of Object.entries(files)) tree[k] = strToU8(v);
  return zipSync(tree);
}

/** All page/db file CONTENTS, for the never-drop sweep (excludes OS junk). */
const exportSource = (files: Record<string, string>): string => Object.values(files).join('\n');

const findPage = (doc: ImportedDoc, title: string): ImportedPage => doc.pages.find((p) => p.title === title)!;
const mentionRuns = (blocks: ImportedBlock[]): ImportTextRun[] => allRuns(blocks).filter((r) => r.a?.m);

// ── Export 1: a realistic engineering workspace ──────────────────────────────

const A = hex('a'); // Engineering Handbook (root page, emoji icon, a child + mentions)
const B = hex('b'); // On-call Runbook (child page; a resolvable mention target)
const C = hex('c'); // Projects (database)
const D = hex('d'); // Orion (a database row page, with a body)
const Z = hex('e'); // Platform Charter (a link target NOT in the export → dangling)

const HANDBOOK_MD = [
  '# 📘 Engineering Handbook',
  '',
  `Welcome aboard. Start with the [On-call Runbook](Engineering%20Handbook%20${A}/On-call%20Runbook%20${B}.md) when you get paged.`,
  '',
  `For anything outside this space, read the [Platform Charter](Platform%20Charter%20${Z}.md) — that page lives elsewhere.`,
  '',
  '![Network topology](network.png)',
  '',
  '## FAQ',
  '',
  '- How do deploys work?',
  '    - Deploys ride the canary pipeline before promotion.',
  '- Where are the dashboards?',
  '    - Grafana, linked from the status banner.',
].join('\n');

const RUNBOOK_MD = [
  '# On-call Runbook',
  '',
  'Acknowledge a page within five minutes. Escalate to the incident commander if the canary keeps regressing.',
].join('\n');

const ORION_ROW_MD = [
  '# Orion',
  '',
  'Orion rewrites the durability layer and ships the journalled mirror.',
].join('\n');

const PROJECTS_CSV = [
  'Name,Status,Priority,Tags,Budget,Launch,Tracker,Lead Contact,Shipped,Depends On',
  'Orion,In progress,High,"backend, search",120000,2026-09-01,https://track.example/orion,orion-lead@example.com,No,Mercury',
  'Mercury,Shipped,Medium,frontend,80000,2026-05-15,https://track.example/mercury,mercury-lead@example.com,Yes,Saturn',
  'Saturn,In progress,High,"backend, infra",200000,2027-01-10,https://track.example/saturn,saturn-lead@example.com,No,Orion',
].join('\n');

const EXPORT1_FILES: Record<string, string> = {
  [`Acme Workspace Export/Engineering Handbook ${A}.md`]: HANDBOOK_MD,
  [`Acme Workspace Export/Engineering Handbook ${A}/On-call Runbook ${B}.md`]: RUNBOOK_MD,
  [`Acme Workspace Export/Projects ${C}.csv`]: PROJECTS_CSV,
  [`Acme Workspace Export/Projects ${C}/Orion ${D}.md`]: ORION_ROW_MD,
};
const EXPORT1_JUNK: Record<string, string> = {
  '__MACOSX/._Engineering Handbook.md': 'junk',
  'Acme Workspace Export/.DS_Store': 'junk',
};

describe('notion corpus — engineering workspace export', () => {
  const doc = notionExportToImportedDoc(zipExport({...EXPORT1_FILES, ...EXPORT1_JUNK}));
  const handbook = findPage(doc, 'Engineering Handbook');
  const projects = findPage(doc, 'Projects');

  it('maps folder nesting to the page tree, stripping hash suffixes and ignoring OS junk', () => {
    expect(doc.pages.map((p) => p.title).sort()).toEqual(['Engineering Handbook', 'Projects']);
    expect(handbook.children?.map((c) => c.title)).toEqual(['On-call Runbook']);
    // junk never became a page
    expect(doc.pages.some((p) => /junk/i.test(p.title))).toBe(false);
  });

  it('lifts a leading emoji into the page icon and pins a stable Notion-derived id', () => {
    expect(handbook.icon).toBe('📘');
    expect(handbook.title).toBe('Engineering Handbook');
    expect(handbook.id).toBe(`imp_n_${A}`);
    expect(handbook.children?.[0].id).toBe(`imp_n_${B}`);
  });

  it('resolves an internal link to an imported page as an @-mention run', () => {
    const mentions = mentionRuns(handbook.blocks);
    expect(mentions).toHaveLength(1);
    expect(mentions[0].a?.m).toBe(`imp_n_${B}`);
    expect(mentions[0].t).toBe('On-call Runbook');
  });

  it('keeps a dangling internal link as plain visible text (never a click-to-nowhere)', () => {
    const charter = allRuns(handbook.blocks).find((r) => r.t === 'Platform Charter')!;
    expect(charter.a?.m).toBeUndefined(); // not a dead mention
    expect(charter.a?.a).toBeUndefined(); // not a dead relative href
  });

  it('preserves an image as a placeholder that keeps the ref (not a page link)', () => {
    const img = handbook.blocks.find((b) => b.props?.[IMAGE_PLACEHOLDER_PROP])!;
    expect((img.props![IMAGE_PLACEHOLDER_PROP] as {ref: string}).ref).toBe('network.png');
  });

  it('flattens a toggle into a nested list, keeping its content', () => {
    const faq = handbook.blocks.filter((b) => /deploys|dashboards|canary|grafana/i.test(plain(b)));
    expect(faq.length).toBeGreaterThanOrEqual(4);
    expect(faq.some((b) => b.props?.indent === 1)).toBe(true);
  });

  it('infers a scalar property type per CSV column', () => {
    const got = projects.database!.schema.properties.map((p) => [p.name, p.type]);
    expect(got).toEqual([
      ['Status', 'select'],
      ['Priority', 'select'],
      ['Tags', 'multi_select'],
      ['Budget', 'number'],
      ['Launch', 'date'],
      ['Tracker', 'url'],
      ['Lead Contact', 'email'],
      ['Shipped', 'checkbox'],
      ['Depends On', 'text'],
    ]);
  });

  it('degrades a relation/rollup/formula-style column to a plain scalar — never a dangling relation', () => {
    const props = projects.database!.schema.properties;
    // "Depends On" holds related row titles; with no CSV schema it lands as text.
    expect(props.find((p) => p.name === 'Depends On')!.type).toBe('text');
    const relational: DatabasePropertyType[] = ['relation', 'rollup', 'formula', 'dependency'];
    for (const p of props) expect(relational).not.toContain(p.type);
  });

  it('parses + coerces rows, links a row to its `.md` body, and lands a body-less row with props only', () => {
    const db = projects.database!;
    const prop = (name: string) => db.schema.properties.find((p) => p.name === name)!;
    expect(db.rows.map((r) => r.title)).toEqual(['Orion', 'Mercury', 'Saturn']);

    const orion = db.rows[0];
    expect(orion.properties![prop('Budget').id]).toBe(120000);
    expect(orion.properties![prop('Launch').id]).toBe('2026-09-01');
    expect(orion.properties![prop('Tracker').id]).toBe('https://track.example/orion');
    expect(orion.properties![prop('Lead Contact').id]).toBe('orion-lead@example.com');
    expect(orion.properties![prop('Shipped').id]).toBe(false);
    const tags = prop('Tags');
    expect(orion.properties![tags.id]).toEqual(['backend', 'search'].map((l) => tags.options!.find((o) => o.label === l)!.id));
    // Orion has a row page → a body; Mercury has none → empty body, props intact.
    expect(plain(orion.blocks?.[0])).toContain('durability layer');
    expect(db.rows[1].blocks).toEqual([]);
    expect(db.rows[1].properties![prop('Shipped').id]).toBe(true);
  });

  it('never silently drops any source token (the safety net over the whole export)', () => {
    // `name`   — the CSV title-column header is not retained as a property.
    // `yes`/`no` — checkbox cells become booleans (a faithful transformation).
    expectNoSilentDrops(exportSource(EXPORT1_FILES), doc, {stripRelativeLinks: true, allow: ['name', 'yes', 'no']});
  });
});

// ── Export 2: `_all` view preference + a row sub-page flatten + wrapper ───────

const F = hex('f'); // Reading List (database, exported with a `_all` view variant)
const G = hex('1'); // a row page WITH a body and its own sub-page
const H = hex('2'); // the row's sub-page → flattened into the row body

const READING_CSV_ALL = [
  'Name,Author,Rating,Status,Started',
  'Designing Data-Intensive Applications,Martin Kleppmann,5,Reading,2026-06-01',
  'The Pragmatic Programmer,Hunt and Thomas,4,Done,2026-03-12',
].join('\n');

// The narrow default view Notion also emits — the importer must prefer `_all`.
const READING_CSV = ['Name,Status', 'Designing Data-Intensive Applications,Reading', 'The Pragmatic Programmer,Done'].join('\n');

const DDIA_MD = ['# Designing Data-Intensive Applications', '', 'Notes on partitioning, replication, and consensus.'].join('\n');
const CHAPTER_MD = ['# Chapter Notes', '', 'Chapter five covers replication lag and read-your-writes consistency.'].join('\n');

const EXPORT2_FILES: Record<string, string> = {
  [`Notion Export 2/Reading List ${F}.csv`]: READING_CSV,
  [`Notion Export 2/Reading List ${F}_all.csv`]: READING_CSV_ALL,
  [`Notion Export 2/Reading List ${F}/Designing Data-Intensive Applications ${G}.md`]: DDIA_MD,
  [`Notion Export 2/Reading List ${F}/Designing Data-Intensive Applications ${G}/Chapter Notes ${H}.md`]: CHAPTER_MD,
};

describe('notion corpus — `_all` view + row sub-page flatten', () => {
  const doc = notionExportToImportedDoc(zipExport(EXPORT2_FILES));
  const reading = findPage(doc, 'Reading List');
  const db = reading.database!;

  it('collapses the two CSV variants to one database, preferring the richer `_all` view', () => {
    expect(doc.pages).toHaveLength(1); // not two databases
    // the `_all` view carries all five columns; the narrow view had only Name+Status
    expect(db.schema.properties.map((p) => p.name)).toEqual(['Author', 'Rating', 'Status', 'Started']);
  });

  it('flattens a row page\'s own sub-page into the row body — never dropped', () => {
    const ddia = db.rows.find((r) => r.title === 'Designing Data-Intensive Applications')!;
    const body = ddia.blocks ?? [];
    expect(plain(body[0])).toContain('partitioning');
    // the sub-page is appended after a divider + its title heading
    expect(body.some((b) => b.type === 'divider')).toBe(true);
    expect(body.some((b) => b.type === 'heading' && plain(b) === 'Chapter Notes')).toBe(true);
    expect(body.some((b) => /read-your-writes/.test(plain(b)))).toBe(true);
  });

  it('never silently drops any source token', () => {
    // `name` — the CSV title-column header is not retained as a property.
    expectNoSilentDrops(exportSource(EXPORT2_FILES), doc, {stripRelativeLinks: true, allow: ['name']});
  });
});

// ════════════════════════════════════════════════════════════════════════════
//  Round-trips through importDoc against a recording fake client
// ════════════════════════════════════════════════════════════════════════════

interface Recorder {
  client: ImportWriteClient;
  saved: PageInput[];
  imports: ImportRequest[];
}

/** A recording {@link ImportWriteClient} — enough surface for both writers. */
function recorder(): Recorder {
  const saved: PageInput[] = [];
  const imports: ImportRequest[] = [];
  let n = 0;
  const stored = (id: string, input?: Partial<StoredPage>): StoredPage => ({
    id,
    name: input?.name ?? null,
    data: input?.data ?? {editorjs: {blocks: []}, values: [], names: []},
    hostedDatabaseId: null,
    databaseId: null,
    parentId: input?.parentId ?? null,
    properties: input?.properties ?? {},
    deletedAt: null,
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
  });
  const client: ImportWriteClient = {
    savePage: (input) => {
      saved.push(input);
      return Promise.resolve(stored(`page_${++n}`, {name: input.name ?? null, data: input.data, parentId: input.parentId ?? null}));
    },
    setPageProperties: (id, properties) => Promise.resolve(stored(id, {properties})),
    createDatabase: () => Promise.reject(new Error('not used in these round-trips')),
    createRow: () => Promise.reject(new Error('not used in these round-trips')),
    importLibrary: (req) => {
      imports.push(req);
      const idMap: Record<string, string> = {};
      for (const p of req.pages) idMap[p.id] = `srv_${p.id}`;
      return Promise.resolve({created: req.pages.length, overwritten: 0, renamed: 0, idMap});
    },
  };
  return {client, saved, imports};
}

/** Pull all surviving text out of a staged copy-mode bundle (the landed side). */
function bundleText(pages: StoredPage[], databases: StoredDatabase[]): string {
  const parts: string[] = [];
  for (const p of pages) {
    if (p.name) parts.push(p.name);
    for (const v of Object.values(p.properties ?? {})) pushScalar(parts, v);
    const blocks = (p.data as {blockdoc?: {blocks?: ImportedBlock[]}}).blockdoc?.blocks;
    if (blocks) pushBlocks(parts, blocks);
  }
  for (const d of databases) {
    if (d.name) parts.push(d.name);
    for (const prop of d.schema.properties) {
      parts.push(prop.name);
      for (const o of prop.options ?? []) parts.push(o.label);
    }
  }
  return parts.join(' ');
}

describe('round-trip — Strategy A (a lone doc, the create path)', () => {
  it('lands everything.md via savePage with no content lost on the way to the store', async () => {
    const source = EVERYTHING_MD;
    const doc = markdownToImportedDoc(source);
    const {client, saved, imports} = recorder();

    const result = await importDoc(client, doc);

    expect(result.strategy).toBe('create'); // lone, childless, database-less page
    expect(imports).toHaveLength(0);
    expect(saved).toHaveLength(1);
    expect(saved[0].name).toBe('Orion Release Notes');

    const landed = (saved[0].data.blockdoc as {blocks: ImportedBlock[]}).blocks;
    expect(types(landed)).toEqual(types(doc.pages[0].blocks)); // structure preserved verbatim
    // the never-drop net, re-run over what actually reached the store
    expectNoSilentDrops(source, {pages: [{title: saved[0].name ?? '', blocks: landed}]});
  });
});

describe('round-trip — Strategy B (a tree, the bundle path)', () => {
  it('stages the engineering export as a copy-mode bundle, preserving the whole tree', async () => {
    const doc = notionExportToImportedDoc(zipExport(EXPORT1_FILES));
    const {client, saved, imports} = recorder();

    const result = await importDoc(client, doc);

    expect(result.strategy).toBe('bundle'); // multi-page tree with a hosted database
    expect(saved).toHaveLength(0);
    expect(imports).toHaveLength(1);
    const {pages, databases, mode} = imports[0];
    expect(mode).toBe('copy');
    expect(databases).toHaveLength(1);
    // host page + child page + 3 database row pages all staged
    expect(pages.length).toBeGreaterThanOrEqual(5);

    // a cross-page mention is staged in a landed block body (it follows its target
    // through the server's copy-mode remap; proven end-to-end in notionImport.test)
    const host = pages.find((p) => p.name === 'Engineering Handbook')!;
    const hostBlocks = (host.data.blockdoc as {blocks: ImportedBlock[]}).blocks;
    expect(mentionRuns(hostBlocks)).toHaveLength(1);

    // every content token the IR carried is present in the staged bundle: the
    // writer dropped nothing on the way from IR → wire records.
    const irTokens = contentTokens(survivingText(doc));
    const staged = contentTokens(bundleText(pages, databases));
    const missing = [...irTokens].filter((t) => !staged.has(t));
    expect(missing, `writer dropped: ${missing.join(', ')}`).toEqual([]);
  });
});
