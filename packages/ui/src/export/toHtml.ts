/**
 * Render a page — or a whole reachable mini-site — to a **self-contained,
 * interactive** HTML document. Prose, lists, code, mentions and links are styled
 * static HTML; reactive blocks stay *live* (sliders recompute their dependent
 * expressions and redraw charts) via a small inlined runtime; and nested pages,
 * subpages and database rows are **navigable** — clicking one swaps the document
 * to that page, all inside the single file.
 *
 * - {@link toHtml} renders one page snapshot (the Markdown/PDF-parity baseline).
 * - {@link toHtmlSite} renders a {@link SiteBundle}: every page as a section, a
 *   client-side router, and databases drawn as tables of navigable rows.
 */
import type {DatabaseProperty, DatabaseRow, DatabaseSchema, PageSnapshot} from '@open-book/sdk';
import {blockSnapshotToEditorJs} from '../blockeditor/exportBlocks';
// Inlined so a page with charts works fully offline: d3's UMD sets `window.d3`,
// then Plot's UMD (which expects a global d3) sets `window.Plot`. Inlined only
// when the document actually has a chart, and code-split (this module is a
// dynamic import) so it never weighs on the main bundle.
import d3Umd from './vendor/d3.min.js?raw';
import plotUmd from './vendor/plot.umd.min.js?raw';
import {parseInline, type InlineRun, type ListItem} from './documentModel';
import {formatValue} from './format';
import {cellValue, formatCellValue} from '@/components/database/databaseCells';
import {SWATCH_HEX} from '@/components/database/databaseColors';
import type {SiteBundle, SiteDatabase} from './exportSite';

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'})[c]!);
}

/** Make JS safe to inline inside a `<script>` element. */
function escapeScript(js: string): string {
  return js.replace(/<\/script>/gi, '<\\/script>');
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

function num(v: unknown, fallback: number): number {
  const n = typeof v === 'string' ? Number(v) : (v as number);
  return typeof n === 'number' && Number.isFinite(n) ? n : fallback;
}

interface SliderSpec {cell: string; min: number; max: number; step: number; name: string}
interface ExprSpec {cell: string; source: string}
interface ChartSpec {
  id: string;
  cells: string[];
  /** Kit charts carry their kind + labels so the export draws faithfully. */
  kind?: string;
  labels?: string[];
}

/**
 * Per-render context shared across a page's blocks (and, for a site, accumulated
 * across pages — cell ids are globally unique so the reactive runtime stays
 * correct even with many pages embedded at once).
 */
interface RenderCtx {
  values: Map<string, unknown>;
  nameByCell: Map<string, string>;
  sliders: SliderSpec[];
  exprs: ExprSpec[];
  charts: ChartSpec[];
  initialValues: Record<string, unknown>;
  /** Global chart counter (chart ids must be unique across the whole document). */
  chartSeq: {n: number};
  /** Prefix making this page's heading anchors unique within the document. */
  anchorPrefix: string;
  /** True when a referenced page is in the bundle (so the link can navigate). */
  pageExists: (id: string) => boolean;
  titleOf: (id: string) => string;
  iconOf: (id: string) => string;
  /** The database hosted by a page id, when that page is in the bundle. */
  databaseOf: (hostPageId: string) => SiteDatabase | undefined;
}

function runToHtml(r: InlineRun, ctx: RenderCtx): string {
  if (r.text === '\n') return '<br>';
  let html = escapeHtml(r.text);
  if (r.code) return `<code>${html}</code>`;
  if (r.mention) {
    const id = r.mention.pageId;
    const label = escapeHtml(ctx.titleOf(id) || r.mention.label || id);
    return ctx.pageExists(id)
      ? `<a class="mention" href="#${escapeHtml(id)}" data-page-id="${escapeHtml(id)}">${label}</a>`
      : `<span class="mention">${label}</span>`;
  }
  if (r.bold) html = `<strong>${html}</strong>`;
  if (r.italic) html = `<em>${html}</em>`;
  if (r.marker) html = `<mark>${html}</mark>`;
  if (r.link) html = `<a href="${escapeHtml(r.link)}">${html}</a>`;
  return html;
}

const inlineToHtml = (runs: InlineRun[], ctx: RenderCtx): string => runs.map((r) => runToHtml(r, ctx)).join('');

function listToHtml(items: ListItem[], ordered: boolean, ctx: RenderCtx): string {
  const tag = ordered ? 'ol' : 'ul';
  const lis = items
    .map((it) => `<li>${inlineToHtml(it.runs, ctx)}${it.items.length ? listToHtml(it.items, ordered, ctx) : ''}</li>`)
    .join('');
  return `<${tag}>${lis}</${tag}>`;
}

function toListItems(items: unknown): ListItem[] {
  if (!Array.isArray(items)) return [];
  return items.map((it): ListItem => {
    if (typeof it === 'string') return {runs: parseInline(it), items: []};
    const o = (it ?? {}) as {content?: unknown; items?: unknown};
    return {runs: parseInline(str(o.content)), items: toListItems(o.items)};
  });
}

/** A subpage card: an icon + title that navigates to the nested page. */
function subpageLink(pageId: string, ctx: RenderCtx): string {
  const label = escapeHtml(ctx.titleOf(pageId) || 'Untitled');
  const icon = escapeHtml(ctx.iconOf(pageId));
  return ctx.pageExists(pageId)
    ? `<a class="subpage" href="#${escapeHtml(pageId)}" data-page-id="${escapeHtml(pageId)}"><span class="subpage__icon">${icon}</span><span>${label}</span></a>`
    : `<span class="subpage is-missing"><span class="subpage__icon">${icon}</span><span>${label}</span></span>`;
}

// ── Database table ───────────────────────────────────────────────────────────

/** The properties a database shows, honouring its first view's chosen columns. */
function visibleProps(schema: DatabaseSchema): DatabaseProperty[] {
  const ids = schema.views[0]?.visiblePropertyIds;
  const chosen = ids && ids.length > 0
    ? (ids.map((id) => schema.properties.find((p) => p.id === id)).filter(Boolean) as DatabaseProperty[])
    : schema.properties;
  // Drop columns that don't render as text (files, backlinks are chip-only).
  return chosen.filter((p) => p.type !== 'files' && p.type !== 'backlinks');
}

const tag = (label: string, color?: string): string =>
  `<span class="tag" style="background:${SWATCH_HEX[color ?? 'gray'] ?? SWATCH_HEX.gray}33">${escapeHtml(label)}</span>`;

function cellHtml(row: DatabaseRow, prop: DatabaseProperty, props: DatabaseProperty[], rows: DatabaseRow[], ctx: RenderCtx): string {
  const raw = cellValue(row, prop, props, rows);
  if (prop.type === 'select' || prop.type === 'status') {
    const opt = prop.options?.find((o) => o.id === raw);
    return opt ? tag(opt.label, opt.color) : '';
  }
  if (prop.type === 'multi_select') {
    const ids = Array.isArray(raw) ? (raw as string[]) : [];
    return (prop.options ?? []).filter((o) => ids.includes(o.id)).map((o) => tag(o.label, o.color)).join(' ');
  }
  if (prop.type === 'relation' || prop.type === 'dependency') {
    const ids = Array.isArray(raw) ? (raw as string[]) : [];
    return ids
      .map((id) =>
        ctx.pageExists(id)
          ? `<a class="mention" href="#${escapeHtml(id)}" data-page-id="${escapeHtml(id)}">${escapeHtml(ctx.titleOf(id))}</a>`
          : escapeHtml(ctx.titleOf(id) || id),
      )
      .join(', ');
  }
  return escapeHtml(formatCellValue(prop, raw));
}

/** A database rendered as a table: a row per record, the title linking to it. */
function renderDatabaseTable(db: SiteDatabase, ctx: RenderCtx): string {
  const props = visibleProps(db.schema);
  const head = `<tr><th>Name</th>${props.map((p) => `<th>${escapeHtml(p.name)}</th>`).join('')}</tr>`;
  const body = db.rows
    .map((row) => {
      const title = (row.name ?? '').trim() || 'Untitled';
      const icon = escapeHtml(ctx.iconOf(row.id));
      const titleCell = ctx.pageExists(row.id)
        ? `<td><a class="db-row" href="#${escapeHtml(row.id)}" data-page-id="${escapeHtml(row.id)}"><span class="subpage__icon">${icon}</span>${escapeHtml(title)}</a></td>`
        : `<td><span class="subpage__icon">${icon}</span>${escapeHtml(title)}</td>`;
      const cells = props.map((p) => `<td>${cellHtml(row, p, db.schema.properties, db.rows, ctx)}</td>`).join('');
      return `<tr>${titleCell}${cells}</tr>`;
    })
    .join('');
  const empty = db.rows.length === 0 ? '<p class="db-empty">No rows.</p>' : '';
  return `<div class="db"><table class="db-table"><thead>${head}</thead><tbody>${body}</tbody></table>${empty}</div>`;
}

// ── Block rendering ──────────────────────────────────────────────────────────

interface RawBlock {id?: string; type?: string; data?: Record<string, unknown>}

/** Render a page's blocks to HTML, collecting reactive specs into the context. */
function renderBlocks(blocks: RawBlock[], ctx: RenderCtx): string {
  // Pre-pass: stable, document-unique anchor per heading (for table-of-contents).
  const headerList: {anchor: string; level: number; text: string}[] = [];
  for (const block of blocks) {
    if (block.type !== 'header') continue;
    const runs = parseInline(str(block.data?.text));
    headerList.push({
      anchor: `${ctx.anchorPrefix}h-${headerList.length}`,
      level: typeof block.data?.level === 'number' ? Math.min(6, Math.max(1, block.data.level as number)) : 2,
      text: runs.map((r) => r.text).join(''),
    });
  }

  const html: string[] = [];
  let headerSeq = 0;
  for (const block of blocks) {
    const d = block.data ?? {};
    const id = block.id ?? '';
    switch (block.type) {
    case 'header': {
      const level = typeof d.level === 'number' ? Math.min(6, Math.max(1, d.level)) : 2;
      const anchor = headerList[headerSeq++]?.anchor ?? '';
      html.push(`<h${level} id="${anchor}">${inlineToHtml(parseInline(str(d.text)), ctx)}</h${level}>`);
      break;
    }
    case 'paragraph':
      html.push(`<p>${inlineToHtml(parseInline(str(d.text)), ctx)}</p>`);
      break;
    case 'list':
      html.push(listToHtml(toListItems(d.items), d.style === 'ordered', ctx));
      break;
    case 'quote':
      html.push(`<blockquote>${inlineToHtml(parseInline(str(d.text)), ctx)}</blockquote>`);
      break;
    case 'code':
      html.push(`<pre><code>${escapeHtml(str(d.code))}</code></pre>`);
      break;
    case 'delimiter':
      html.push('<hr>');
      break;
    case 'table': {
      const content = Array.isArray(d.content) ? (d.content as unknown[][]) : [];
      const cell = (c: unknown) => inlineToHtml(parseInline(str(c)), ctx);
      const rowsHtml = content.map((row, ri) => {
        const cells = (Array.isArray(row) ? row : [])
          .map((c) => (ri === 0 && d.withHeadings === true ? `<th>${cell(c)}</th>` : `<td>${cell(c)}</td>`))
          .join('');
        return `<tr>${cells}</tr>`;
      });
      html.push(`<table class="block-table">${rowsHtml.join('')}</table>`);
      break;
    }
    case 'callout':
      html.push(
        `<div class="callout" data-variant="${escapeHtml(str(d.variant) || 'info')}"><div class="callout__body">${inlineToHtml(parseInline(str(d.text)), ctx)}</div></div>`,
      );
      break;
    case 'accordion':
      html.push(
        `<details class="accordion"${d.open === false ? '' : ' open'}><summary>${inlineToHtml(parseInline(str(d.title)), ctx)}</summary><div class="accordion__content">${inlineToHtml(parseInline(str(d.content)), ctx)}</div></details>`,
      );
      break;
    case 'checklist': {
      const items = Array.isArray(d.items) ? (d.items as Array<Record<string, unknown>>) : [];
      const lis = items
        .map(
          (it) =>
            `<li><label><input type="checkbox"${it.checked === true ? ' checked' : ''}> ${inlineToHtml(parseInline(str(it.text)), ctx)}</label></li>`,
        )
        .join('');
      html.push(`<ul class="checklist">${lis}</ul>`);
      break;
    }
    case 'toc': {
      if (headerList.length === 0) break;
      const min = Math.min(...headerList.map((h) => h.level));
      const lis = headerList
        .map((h) => `<li style="margin-left:${(h.level - min) * 14}px"><a href="#${h.anchor}">${escapeHtml(h.text)}</a></li>`)
        .join('');
      html.push(`<nav class="toc"><ul>${lis}</ul></nav>`);
      break;
    }
    case 'button': {
      const label = escapeHtml(str(d.label) || str(d.url));
      const url = str(d.url);
      const ext = /^https?:\/\//i.test(url) ? ' target="_blank" rel="noreferrer noopener"' : '';
      html.push(url ? `<p><a class="button" href="${escapeHtml(url)}"${ext}>${label}</a></p>` : `<p><span class="button is-empty">${label}</span></p>`);
      break;
    }
    case 'divider': {
      const style = escapeHtml(str(d.style) || 'line');
      const label = str(d.label);
      html.push(
        style === 'labeled' && label
          ? `<div class="divider" data-style="labeled"><span>${escapeHtml(label)}</span></div>`
          : `<hr class="divider" data-style="${style}">`,
      );
      break;
    }
    case 'subpage': {
      const pid = str(d.pageId);
      const db = d.kind === 'database' ? ctx.databaseOf(pid) : undefined;
      html.push(db ? renderDatabaseTable(db, ctx) : subpageLink(pid, ctx));
      break;
    }
    case 'database': {
      const pid = str(d.pageId);
      const db = ctx.databaseOf(pid);
      html.push(db ? renderDatabaseTable(db, ctx) : subpageLink(pid, ctx));
      break;
    }
    case 'slider': {
      const min = num(d.min, 0);
      const max = num(d.max, 100);
      const step = num(d.step, 1);
      const val = num(ctx.values.get(id), num(d.initial, min));
      ctx.initialValues[id] = val;
      const name = str(d.name) || ctx.nameByCell.get(id) || 'value';
      ctx.sliders.push({cell: id, min, max, step, name});
      html.push(
        `<div class="reactive slider" data-cell="${id}"><label>${escapeHtml(name)} ` +
          `<input type="range" min="${min}" max="${max}" step="${step}" value="${val}"> <output>${val}</output></label></div>`,
      );
      break;
    }
    case 'expr':
      ctx.exprs.push({cell: id, source: str(d.source)});
      if (ctx.values.has(id)) ctx.initialValues[id] = ctx.values.get(id);
      html.push(
        `<p class="reactive expr" data-cell="${id}"><code>${escapeHtml(str(d.name) || ctx.nameByCell.get(id) || 'expr')} = <span data-val>${escapeHtml(formatValue(ctx.values.get(id)))}</span></code></p>`,
      );
      break;
    case 'chart': {
      const cid = `chart-${ctx.chartSeq.n++}`;
      const cells = Array.isArray(d.refCellIds) ? (d.refCellIds as string[]) : d.refCellId ? [String(d.refCellId)] : [];
      for (const cell of cells) if (ctx.values.has(cell)) ctx.initialValues[cell] = ctx.values.get(cell);
      const labels = str(d.labels)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      ctx.charts.push({id: cid, cells, ...(d.kind ? {kind: str(d.kind), labels} : {})});
      html.push(`<figure class="chart" data-chart="${cid}"></figure>`);
      break;
    }
    default:
      break;
    }
  }
  return html.join('\n');
}

/** Seed a context's reactive lookups from a page snapshot's persisted cell data. */
function loadSnapshot(snapshot: PageSnapshot, values: Map<string, unknown>, nameByCell: Map<string, string>): void {
  for (const [cell, value] of snapshot.values as Array<[string, unknown]>) values.set(cell, value);
  for (const [name, cell] of snapshot.names as Array<[string, string]>) nameByCell.set(cell, name);
}

/** Assemble the final HTML document from rendered body markup + collected specs. */
function document_(bodyHtml: string, headTitle: string, ctx: RenderCtx, rootId?: string): string {
  const live = ctx.sliders.length > 0 || ctx.exprs.length > 0 || ctx.charts.length > 0;
  const data = {values: ctx.initialValues, sliders: ctx.sliders, exprs: ctx.exprs, charts: ctx.charts};
  // Kit charts draw themselves (drawKit in the runtime) — only classic
  // cell-driven charts need the vendored d3 + Observable Plot bundles.
  const libs = ctx.charts.some((c) => !c.kind) ? `<script>${escapeScript(d3Umd)}</script>\n<script>${escapeScript(plotUmd)}</script>\n` : '';
  const reactive = live
    ? `${libs}<script type="application/json" id="ob-data">${JSON.stringify(data)}</script>\n<script type="module">${RUNTIME}</script>\n`
    : '';
  const nav = rootId ? `<script>${NAV.replace('__ROOT__', JSON.stringify(rootId))}</script>` : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(headTitle)}</title>
<style>${STYLES}</style>
</head>
<body${rootId ? ` data-root="${escapeHtml(rootId)}"` : ''}>
${rootId ? '<header class="ob-nav"><button id="ob-back" hidden>← Back</button></header>\n' : ''}${bodyHtml}
${reactive}${nav}
</body>
</html>`;
}

/** Build the interactive HTML for a single page snapshot (Markdown/PDF parity). */
export function toHtml(rawSnapshot: PageSnapshot, title: string, icon: string): string {
  const snapshot = blockSnapshotToEditorJs(rawSnapshot);
  const values = new Map<string, unknown>();
  const nameByCell = new Map<string, string>();
  loadSnapshot(snapshot, values, nameByCell);
  const ctx: RenderCtx = {
    values,
    nameByCell,
    sliders: [],
    exprs: [],
    charts: [],
    initialValues: {},
    chartSeq: {n: 0},
    anchorPrefix: '',
    pageExists: () => false,
    titleOf: (id) => id,
    iconOf: () => '',
    databaseOf: () => undefined,
  };
  const blocks = (snapshot.editorjs as {blocks?: RawBlock[]} | undefined)?.blocks ?? [];
  const body = `<main>\n<h1 class="doc-title">${icon ? `${escapeHtml(icon)} ` : ''}${escapeHtml(title)}</h1>\n${renderBlocks(blocks, ctx)}\n</main>`;
  return document_(body, title, ctx);
}

/**
 * Build one interactive HTML file for a whole {@link SiteBundle}: every page as a
 * navigable section, databases as tables of navigable rows, and a client-side
 * router that swaps the visible page on link clicks (with browser back/forward).
 */
export function toHtmlSite(bundle: SiteBundle): string {
  const byId = new Map(bundle.pages.map((p) => [p.id, p]));
  const values = new Map<string, unknown>();
  const nameByCell = new Map<string, string>();
  for (const page of bundle.pages) loadSnapshot(page.snapshot, values, nameByCell);

  const ctx: RenderCtx = {
    values,
    nameByCell,
    sliders: [],
    exprs: [],
    charts: [],
    initialValues: {},
    chartSeq: {n: 0},
    anchorPrefix: '',
    pageExists: (id) => byId.has(id),
    titleOf: (id) => byId.get(id)?.title ?? '',
    iconOf: (id) => byId.get(id)?.icon ?? '',
    databaseOf: (hostId) => byId.get(hostId)?.database,
  };

  const sections = bundle.pages
    .map((page, i) => {
      ctx.anchorPrefix = `p${i}-`;
      const blocks = (page.snapshot.editorjs as {blocks?: RawBlock[]} | undefined)?.blocks ?? [];
      const bodyHtml = renderBlocks(blocks, ctx);
      const dbHtml = page.database ? renderDatabaseTable(page.database, ctx) : '';
      const hidden = page.id === bundle.rootId ? '' : ' hidden';
      return (
        `<section class="page" data-page="${escapeHtml(page.id)}"${hidden}>\n` +
        `<h1 class="doc-title">${page.icon ? `${escapeHtml(page.icon)} ` : ''}${escapeHtml(page.title)}</h1>\n` +
        `${bodyHtml}\n${dbHtml}\n</section>`
      );
    })
    .join('\n');

  const rootTitle = byId.get(bundle.rootId)?.title ?? 'Export';
  return document_(`<main>\n${sections}\n</main>`, rootTitle, ctx, bundle.rootId);
}

const STYLES = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body { margin: 0; background: #fff; color: #1a1a1a; font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
@media (prefers-color-scheme: dark) { body { background: #18181b; color: #e7e7ea; } }
main { max-width: 720px; margin: 0 auto; padding: 48px 24px 120px; }
section.page[hidden] { display: none; }
.ob-nav { position: sticky; top: 0; z-index: 10; padding: 8px 24px; backdrop-filter: blur(8px); background: rgba(127,127,127,.06); border-bottom: 1px solid rgba(127,127,127,.18); }
.ob-nav button { font: inherit; font-size: .9rem; cursor: pointer; border: 1px solid rgba(127,127,127,.3); background: transparent; color: inherit; border-radius: 6px; padding: 4px 12px; }
.ob-nav button:hover { background: rgba(127,127,127,.12); }
h1.doc-title { font-size: 2.4rem; font-weight: 800; letter-spacing: -.02em; margin: 0 0 1.2rem; }
h1,h2,h3,h4 { font-weight: 700; line-height: 1.25; margin: 1.6em 0 .4em; }
p { margin: .6em 0; }
ul,ol { margin: .4em 0; padding-left: 1.4em; }
blockquote { margin: 1em 0; padding: .2em 0 .2em 1em; border-left: 3px solid currentColor; opacity: .85; font-style: italic; }
pre { background: rgba(127,127,127,.12); padding: 12px 14px; border-radius: 8px; overflow-x: auto; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .9em; }
mark { background: #fde68a; color: inherit; padding: 0 .1em; }
hr { border: none; border-top: 1px solid rgba(127,127,127,.3); width: 30%; margin: 2em auto; }
a.mention { font-weight: 600; text-decoration: underline; text-underline-offset: 2px; cursor: pointer; color: inherit; }
span.mention { font-weight: 600; opacity: .7; }
a.subpage, span.subpage { display: flex; align-items: center; gap: 8px; margin: .4em 0; padding: 8px 12px; border: 1px solid rgba(127,127,127,.22); border-radius: 8px; text-decoration: none; color: inherit; font-weight: 600; cursor: pointer; }
a.subpage:hover { background: rgba(127,127,127,.08); }
.subpage.is-missing { opacity: .55; cursor: default; }
.subpage__icon { font-size: 1.1em; line-height: 1; }
.reactive { background: rgba(127,127,127,.06); border: 1px solid rgba(127,127,127,.16); border-radius: 8px; padding: 10px 12px; margin: 1em 0; }
.slider input[type=range] { vertical-align: middle; width: 60%; }
.expr code { color: #4f46e5; }
figure.chart { margin: 1.2em 0; }
figure.chart svg { max-width: 100%; height: auto; }
table.block-table, table.db-table { border-collapse: collapse; width: 100%; margin: 1em 0; font-size: .95em; }
table.block-table th, table.block-table td, table.db-table th, table.db-table td { border: 1px solid rgba(127,127,127,.3); padding: 6px 10px; text-align: left; vertical-align: top; }
table.block-table th, table.db-table th { background: rgba(127,127,127,.08); font-weight: 600; }
table.db-table a.db-row { display: inline-flex; align-items: center; gap: 6px; color: inherit; text-decoration: none; font-weight: 600; cursor: pointer; }
table.db-table a.db-row:hover { text-decoration: underline; }
.db-empty { opacity: .6; font-size: .9em; }
.tag { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: .82em; margin: 1px 2px 1px 0; }
.callout { display: flex; gap: 10px; margin: 1em 0; padding: 12px 14px; border-radius: 8px; border: 1px solid; }
.callout::before { content: "💡"; }
.callout[data-variant=warning]::before { content: "⚠️"; }
.callout[data-variant=success]::before { content: "✅"; }
.callout[data-variant=danger]::before { content: "🛑"; }
.callout { background: rgba(59,130,246,.10); border-color: rgba(59,130,246,.35); }
.callout[data-variant=warning] { background: rgba(245,158,11,.12); border-color: rgba(245,158,11,.4); }
.callout[data-variant=success] { background: rgba(34,197,94,.12); border-color: rgba(34,197,94,.4); }
.callout[data-variant=danger] { background: rgba(239,68,68,.12); border-color: rgba(239,68,68,.4); }
.callout__body { flex: 1; }
.accordion { margin: 1em 0; border: 1px solid rgba(127,127,127,.25); border-radius: 8px; padding: 4px 14px; }
.accordion summary { cursor: pointer; font-weight: 600; padding: 6px 0; }
.accordion__content { padding: 2px 0 8px; }
ul.checklist { list-style: none; padding-left: .2em; }
ul.checklist li { margin: .25em 0; }
ul.checklist input { margin-right: .5em; }
nav.toc { margin: 1em 0; padding: 10px 14px; border-left: 3px solid rgba(127,127,127,.3); }
nav.toc ul { list-style: none; padding-left: 0; margin: 0; }
nav.toc a { text-decoration: none; opacity: .85; }
nav.toc a:hover { opacity: 1; text-decoration: underline; }
a.button { display: inline-block; background: #4f46e5; color: #fff; padding: 8px 18px; border-radius: 8px; font-weight: 600; text-decoration: none; }
a.button:hover { filter: brightness(1.08); }
.button.is-empty { background: rgba(127,127,127,.3); }
hr.divider[data-style=dashed] { border-top-style: dashed; }
hr.divider[data-style=dotted] { border-top-style: dotted; }
hr.divider[data-style=thick] { border-top-width: 3px; }
.divider[data-style=labeled] { display: flex; align-items: center; gap: 12px; text-align: center; width: 100%; margin: 2em 0; opacity: .7; font-size: .85em; }
.divider[data-style=labeled]::before, .divider[data-style=labeled]::after { content: ""; flex: 1; border-top: 1px solid rgba(127,127,127,.3); }
`;

// Inlined live runtime: recomputes expressions from slider values and redraws
// charts. Reuses the saved \`__C__{cellId}__\` reference tokens. Observable Plot
// (and d3) are inlined as classic scripts above, so this works offline.
const RUNTIME = `
const Plot = (typeof window !== "undefined" && window.Plot) || null;
const D = JSON.parse(document.getElementById("ob-data").textContent);
const store = new Map(Object.entries(D.values));
const get = (id) => store.get(id);
const fmt = (v) => v === undefined ? "—" : typeof v === "number" ? (Number.isInteger(v) ? ""+v : ""+(Math.round(v*1000)/1000)) : Array.isArray(v) ? "["+v.slice(0,8).join(", ")+(v.length>8?", …":"")+"]" : JSON.stringify(v);
function evalExpr(src){ const code = src.replace(/__C__\\{([^}]+)\\}__/g, (_,id)=>"get("+JSON.stringify(id)+")"); try { return new Function("get","return ("+code+");")(get); } catch(e){ return undefined; } }
function normalize(v,name){ if(Array.isArray(v)&&v.every(n=>typeof n==="number")) return [{name,data:v}]; if(v&&Array.isArray(v.series)) return v.series.map(s=>({name:String(s.name),data:(s.data||[]).filter(n=>typeof n==="number")})); return []; }

// Kind-faithful drawing for kit charts (mirrors the editor's chartMath
// geometry): line, area, bar, pie, donut, scatter, funnel — no libraries.
const KIT_PALETTE=["#6366f1","#f59e0b","#10b981","#ef4444","#8b5cf6","#06b6d4","#f97316","#14b8a6"];
function kitSeries(v){ if(Array.isArray(v)&&v.every(n=>typeof n==="number")) return v.length?[{name:"",values:v}]:[]; if(Array.isArray(v)&&v.length&&v.every(p=>p&&typeof p==="object"&&isFinite(p.x)&&isFinite(p.y))) return [{name:"",values:v.map(p=>p.y)}]; if(Array.isArray(v)&&v.every(a=>Array.isArray(a)&&a.every(n=>typeof n==="number"))) return v.filter(a=>a.length).map((a,i)=>({name:"s"+(i+1),values:a})); if(v&&typeof v==="object"&&!Array.isArray(v)) return Object.entries(v).filter(([,a])=>Array.isArray(a)&&a.every(n=>typeof n==="number")&&a.length).map(([n,a])=>({name:n,values:a})); if(typeof v==="number"&&isFinite(v)) return [{name:"",values:[v]}]; return []; }
function kitLabelled(v,labels){ if(v&&typeof v==="object"&&!Array.isArray(v)){ const e=Object.entries(v).filter(([,n])=>typeof n==="number"&&isFinite(n)); if(e.length) return e.map(([label,value])=>({label,value})); } if(Array.isArray(v)&&v.every(n=>typeof n==="number")) return v.map((value,i)=>({label:labels[i]||("#"+(i+1)),value})); return []; }
function kitExtent(vals){ if(!vals.length) return {min:0,max:1}; let min=Math.min.apply(null,vals.concat([0])), max=Math.max.apply(null,vals); if(min===max){min-=1;max+=1;} return {min,max}; }
function kitScale(v,d,r0,r1){ return r0+((v-d.min)/(d.max-d.min))*(r1-r0); }
function kitTicks(d){ const span=d.max-d.min, step0=Math.pow(10,Math.floor(Math.log10(span/3))); const step=[step0,step0*2,step0*5,step0*10].find(s=>span/s<=4)||step0*10; const out=[]; for(let v=Math.ceil(d.min/step)*step; v<=d.max+1e-9; v+=step) out.push(Math.round(v*1e6)/1e6); return out; }
function drawKit(v,kind,labels){
  const W=660,H=300,PAD=34,P=KIT_PALETTE;
  const grid=(d)=>kitTicks(d).map(t=>{const y=kitScale(t,d,H-PAD,PAD);return '<line x1="'+PAD+'" x2="'+(W-PAD)+'" y1="'+y+'" y2="'+y+'" stroke="currentColor" opacity="0.15" stroke-dasharray="2 4"/><text x="'+(PAD-6)+'" y="'+(y+3)+'" font-size="10" fill="currentColor" opacity="0.55" text-anchor="end">'+t+'</text>';}).join('');
  let body='';
  if(kind==='pie'||kind==='donut'){
    const slices=kitLabelled(v,labels).filter(s=>s.value>0); if(!slices.length) return '';
    const total=slices.reduce((a,s)=>a+s.value,0), r=H/2-16, r0=kind==='donut'?r*0.55:0, cx=H/2, cy=H/2; let ang=-Math.PI/2;
    body=slices.map((s,i)=>{ const sweep=s.value/total*Math.PI*2, a0=ang, a1=ang+sweep; ang=a1; const end=sweep>=Math.PI*2-1e-6?a1-1e-4:a1, large=sweep>Math.PI?1:0; const pt=(a,rad)=>(cx+Math.cos(a)*rad)+','+(cy+Math.sin(a)*rad);
      const path=r0>0?'M '+pt(a0,r)+' A '+r+' '+r+' 0 '+large+' 1 '+pt(end,r)+' L '+pt(end,r0)+' A '+r0+' '+r0+' 0 '+large+' 0 '+pt(a0,r0)+' Z':'M '+cx+','+cy+' L '+pt(a0,r)+' A '+r+' '+r+' 0 '+large+' 1 '+pt(end,r)+' Z';
      return '<path d="'+path+'" fill="'+P[i%P.length]+'"/>';
    }).join('')+slices.map((s,i)=>'<g transform="translate('+(H+24)+','+(28+i*20)+')"><rect width="10" height="10" rx="2" fill="'+P[i%P.length]+'"/><text x="16" y="9" font-size="11" fill="currentColor" opacity="0.7">'+s.label+' · '+Math.round(s.value/total*100)+'%</text></g>').join('');
  } else if(kind==='funnel'){
    const stages=kitLabelled(v,labels); const max=Math.max.apply(null,stages.map(s=>Math.max(0,s.value)).concat([0])); if(!stages.length||max<=0) return '';
    const gap=3, rowH=(H-PAD-gap*(stages.length-1))/stages.length;
    body=stages.map((s,i)=>{ const w=Math.max(Math.max(0,s.value)/max*(W-PAD*2),2), x=PAD+((W-PAD*2)-w)/2, y=12+i*(rowH+gap);
      return '<rect x="'+x+'" y="'+y+'" width="'+w+'" height="'+rowH+'" rx="4" fill="'+P[i%P.length]+'" opacity="0.85"/><text x="'+(W/2)+'" y="'+(y+rowH/2+4)+'" font-size="11" font-weight="600" text-anchor="middle" fill="#fff">'+s.label+' · '+s.value+'</text>';
    }).join('');
  } else if(kind==='scatter'){
    const pts=Array.isArray(v)&&v.length&&v.every(p=>p&&typeof p==="object"&&isFinite(p.x)&&isFinite(p.y))?v:(Array.isArray(v)&&v.every(n=>typeof n==="number")?v.map((y,x)=>({x,y})):[]); if(!pts.length) return '';
    const dx=kitExtent(pts.map(p=>p.x)), dy=kitExtent(pts.map(p=>p.y));
    body=grid(dy)+pts.map(p=>'<circle cx="'+kitScale(p.x,dx,PAD,W-PAD)+'" cy="'+kitScale(p.y,dy,H-PAD,PAD)+'" r="4" fill="'+P[0]+'" opacity="0.75"/>').join('');
  } else if(kind==='bar'){
    const series=kitSeries(v); if(!series.length) return '';
    const d=kitExtent(series.flatMap(s=>s.values)), n=Math.max.apply(null,series.map(s=>s.values.length)), groupW=(W-PAD*2)/n, barW=Math.max(groupW*0.7/series.length,2), zero=kitScale(Math.max(d.min,0),d,H-PAD,PAD);
    body=grid(d)+series.map((s,si)=>s.values.map((val,i)=>{ const y=kitScale(val,d,H-PAD,PAD), x=PAD+i*groupW+groupW*0.15+si*barW; return '<rect x="'+x+'" y="'+Math.min(y,zero)+'" width="'+(barW-1)+'" height="'+Math.max(Math.abs(zero-y),1)+'" rx="2" fill="'+P[si%P.length]+'"/>'; }).join('')).join('')+labels.slice(0,n).map((l,i)=>'<text x="'+(PAD+i*groupW+groupW/2)+'" y="'+(H-8)+'" font-size="10" text-anchor="middle" fill="currentColor" opacity="0.55">'+l+'</text>').join('');
  } else { // line / area
    const series=kitSeries(v); if(!series.length) return '';
    const d=kitExtent(series.flatMap(s=>s.values)), base=kitScale(Math.max(d.min,0),d,H-PAD,PAD);
    body=grid(d)+series.map((s,i)=>{ const n=s.values.length; const pts=s.values.map((val,j)=>{ const x=n===1?W/2:PAD+(j/(n-1))*(W-PAD*2); return (Math.round(x*10)/10)+','+(Math.round(kitScale(val,d,H-PAD,PAD)*10)/10); }).join(' ');
      const first=pts.split(' ')[0].split(',')[0], parts=pts.split(' '), last=parts[parts.length-1].split(',')[0];
      return (kind==='area'?'<polygon points="'+first+','+base+' '+pts+' '+last+','+base+'" fill="'+P[i%P.length]+'" opacity="0.15"/>':'')+'<polyline points="'+pts+'" fill="none" stroke="'+P[i%P.length]+'" stroke-width="2" stroke-linejoin="round"/>';
    }).join('');
  }
  return '<svg viewBox="0 0 '+W+' '+H+'" style="width:100%;height:auto">'+body+'</svg>';
}

function recompute(){
  for (const e of D.exprs) store.set(e.cell, evalExpr(e.source));
  for (const e of D.exprs){ const el=document.querySelector('[data-cell="'+e.cell+'"] [data-val]'); if(el) el.textContent = fmt(get(e.cell)); }
  for (const c of D.charts){
    const fig = document.querySelector('[data-chart="'+c.id+'"]'); if(!fig) continue;
    if (c.kind){ fig.innerHTML = drawKit(get(c.cells[0]), c.kind, c.labels||[]); continue; }
    const series=[]; for(const cell of c.cells) series.push(...normalize(get(cell), cell));
    const long=[]; series.forEach(s=>s.data.forEach((y,i)=>long.push({i,y,series:s.name})));
    fig.innerHTML="";
    if(Plot && long.length) fig.appendChild(Plot.plot({marks:[Plot.lineY(long,{x:"i",y:"y",stroke:"series"})],width:660,height:330,marginLeft:44,grid:true,style:{background:"transparent",color:"currentColor",fontSize:"12px"},color:{legend:series.length>1}}));
  }
}
for (const s of D.sliders){
  const wrap = document.querySelector('[data-cell="'+s.cell+'"]'); if(!wrap) continue;
  const input = wrap.querySelector("input"), out = wrap.querySelector("output");
  input.addEventListener("input", () => { out.textContent = input.value; store.set(s.cell, Number(input.value)); recompute(); });
}
recompute();
`;

// Inlined navigation runtime: shows one page section at a time, swapping on clicks
// of any in-bundle link (mentions, subpages, database rows) via the URL hash, so
// browser back/forward work for free.
const NAV = `
(function(){
  var root = __ROOT__;
  var sections = {};
  document.querySelectorAll("section.page").forEach(function(s){ sections[s.dataset.page] = s; });
  var back = document.getElementById("ob-back");
  function show(id){
    var target = sections[id] ? id : root;
    Object.keys(sections).forEach(function(k){ sections[k].hidden = k !== target; });
    if (back) back.hidden = target === root;
    window.scrollTo(0, 0);
  }
  document.addEventListener("click", function(e){
    var a = e.target.closest("[data-page-id]");
    if (!a) return;
    var id = a.getAttribute("data-page-id");
    if (sections[id]) { e.preventDefault(); if (location.hash.slice(1) === id) show(id); else location.hash = id; }
  });
  if (back) back.addEventListener("click", function(){ if (history.length > 1) history.back(); else location.hash = ""; });
  window.addEventListener("hashchange", function(){ show(location.hash.slice(1) || root); });
  show(location.hash.slice(1) || root);
})();
`;
