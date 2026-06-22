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
import type {DatabaseProperty, DatabaseRow, DatabaseSchema, PageSnapshot} from '@book.dev/sdk';
import {blockSnapshotToEditorJs} from '../blockeditor/exportBlocks';
// Inlined so a page with charts works fully offline: d3's UMD sets `window.d3`,
// then Plot's UMD (which expects a global d3) sets `window.Plot`. Inlined only
// when the document actually has a chart, and code-split (this module is a
// dynamic import) so it never weighs on the main bundle.
import d3Umd from './vendor/d3.min.js?raw';
import plotUmd from './vendor/plot.umd.min.js?raw';
import {parseInline, type InlineRun, type ListItem} from './documentModel';
import {COLOR_EXPORT_HEX} from '../blockeditor/colors';
import {KIT_CHART_JS, kitChartSvg} from './kitChart';
import {formatValue} from './format';
import {pageIconToText} from '@/lib/iconValue';
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
interface KitInputSpec {
  cell: string;
  kind: string;
}
interface KitButtonSpec {
  id: string;
  action: string;
  target: string;
  amount: number;
  min?: number;
  max?: number;
}
interface KitLightSpec {
  cell: string;
  /** Thresholds so the runtime recomputes the 3-state colour (ok/warn/bad). */
  okAt: number;
  warnAt: number;
}
interface ProgressSpec {
  cell: string;
  max: number;
  format: string;
}

interface RenderCtx {
  values: Map<string, unknown>;
  nameByCell: Map<string, string>;
  sliders: SliderSpec[];
  exprs: ExprSpec[];
  charts: ChartSpec[];
  inputs: KitInputSpec[];
  buttons: KitButtonSpec[];
  lights: KitLightSpec[];
  progress: ProgressSpec[];
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

/**
 * Reverse map from a baked text-colour hex back to its palette token. The runs
 * carry concrete light-theme hex (resolved upstream in `exportBlocks`), but the
 * self-contained HTML also supports dark mode — and the light-tuned hex go muddy
 * on a dark background (brown/purple especially). So we re-emit text colour as a
 * `var(--obtc-<token>, <light hex>)`: light mode falls back to the hex, dark mode
 * picks up the brighter override defined in `STYLES`. (Highlights need no such
 * map — their tints are light pastels in both themes, with forced-dark text.)
 */
const FG_TOKEN = new Map(Object.entries(COLOR_EXPORT_HEX).map(([token, v]) => [v.fg, token]));

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
  if (r.underline) html = `<u>${html}</u>`;
  if (r.strike) html = `<s>${html}</s>`;
  if (r.marker) html = `<mark${r.markerColor ? ` style="background:${escapeHtml(r.markerColor)}"` : ''}>${html}</mark>`;
  if (r.color) {
    const token = FG_TOKEN.get(r.color);
    const value = token ? `var(--obtc-${token}, ${escapeHtml(r.color)})` : escapeHtml(r.color);
    html = `<span style="color:${value}">${html}</span>`;
  }
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
    case 'columns': {
      // Side-by-side columns (the projection keeps them nested for HTML; PDF/MD
      // flatten). Each column's blocks render through the shared context so any
      // reactive widgets inside stay live.
      const cols = Array.isArray(d.columns) ? (d.columns as RawBlock[][]) : [];
      const colHtml = cols.map((col) => `<div class="col">${renderBlocks(col, ctx)}</div>`).join('');
      if (colHtml) html.push(`<div class="cols">${colHtml}</div>`);
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
      // hidden exprs feed other blocks (status lights) without a readout
      if (!d.hidden) {
        html.push(
          `<p class="reactive expr" data-cell="${id}"><code>${escapeHtml(str(d.name) || ctx.nameByCell.get(id) || 'expr')} = <span data-val>${escapeHtml(formatValue(ctx.values.get(id)))}</span></code></p>`,
        );
      }
      break;
    case 'chart': {
      const cid = `chart-${ctx.chartSeq.n++}`;
      const cells = Array.isArray(d.refCellIds) ? (d.refCellIds as string[]) : d.refCellId ? [String(d.refCellId)] : [];
      for (const cell of cells) if (ctx.values.has(cell)) ctx.initialValues[cell] = ctx.values.get(cell);
      const labels = str(d.labels)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const title = str(d.title);
      ctx.charts.push({id: cid, cells, ...(d.kind ? {kind: str(d.kind), labels} : {})});
      // Kit charts (with a kind) are drawn at build time too, so the chart shows
      // on first paint and without JS — the runtime then redraws it live. Classic
      // (Plot) charts need d3/Plot at runtime, so they hydrate from empty.
      const initial = d.kind && cells.length && ctx.values.has(cells[0]) ? kitChartSvg(ctx.values.get(cells[0]), str(d.kind), labels) : '';
      // The title is a sibling of the plotted node — the runtime replaces the
      // `[data-chart]` node's innerHTML, so a caption inside it would be wiped.
      html.push(
        `<figure class="chart">${title ? `<figcaption class="chart-title">${escapeHtml(title)}</figcaption>` : ''}<div data-chart="${cid}">${initial}</div></figure>`,
      );
      break;
    }
    case 'kitinput': {
      const kind = str(d.kind);
      const label = escapeHtml(str(d.label) || str(d.name));
      const wide = d.wide ? ' kit-wide' : '';
      // Prefer the structured {label,value} options; fall back to parsing the
      // legacy comma string (where value == label) for older exports.
      const options: Array<{label: string; value: string}> = Array.isArray(d.opts)
        ? (d.opts as Array<{label: string; value: string}>)
        : str(d.options)
          .split(',')
          .map((o) => o.trim())
          .filter(Boolean)
          .map((o) => ({label: o, value: o}));
      const value = ctx.values.has(id) ? ctx.values.get(id) : d.value;
      ctx.initialValues[id] = value;
      ctx.inputs.push({cell: id, kind});
      if (kind === 'radio') {
        const pills = options
          .map(
            (o) =>
              `<button type="button" data-opt="${escapeHtml(o.value)}" class="kit-pill${o.value === value ? ' kit-on' : ''}">` +
              `<span class="kit-dot"></span>${escapeHtml(o.label)}</button>`,
          )
          .join('');
        html.push(`<div class="reactive kitinput kit-radio${wide}" data-cell="${id}"><span class="kit-label">${label}</span><div class="kit-options">${pills}</div></div>`);
      } else if (kind === 'checklist') {
        const selected = new Set(Array.isArray(value) ? (value as string[]) : []);
        const checks = options
          .map(
            (o) =>
              `<label class="kit-check"><input type="checkbox" data-opt="${escapeHtml(o.value)}"${selected.has(o.value) ? ' checked' : ''}> ${escapeHtml(o.label)}</label>`,
          )
          .join('');
        html.push(`<div class="reactive kitinput kit-checklist${wide}" data-cell="${id}"><span class="kit-label">${label}</span><div class="kit-options">${checks}</div></div>`);
      } else if (kind === 'dropdown') {
        const opts = options.map((o) => `<option value="${escapeHtml(o.value)}"${o.value === value ? ' selected' : ''}>${escapeHtml(o.label)}</option>`).join('');
        html.push(`<div class="reactive kitinput kit-dropdown${wide}" data-cell="${id}"><label class="kit-label">${label} <select>${opts}</select></label></div>`);
      } else if (kind === 'toggle') {
        html.push(
          `<div class="reactive kitinput kit-toggle" data-cell="${id}"><label class="kit-label">${label} <input type="checkbox"${value ? ' checked' : ''}></label></div>`,
        );
      } else {
        html.push(
          `<div class="reactive kitinput kit-text${wide}" data-cell="${id}"><label class="kit-label">${label} <input type="text" value="${escapeHtml(String(value ?? ''))}" placeholder="${escapeHtml(str(d.placeholder))}"></label></div>`,
        );
      }
      break;
    }
    case 'kitbutton': {
      if (str(d.action) === 'link') {
        html.push(`<p class="kitbtn"><a class="kit-btn" href="${escapeHtml(str(d.url))}" target="_blank" rel="noreferrer noopener">${escapeHtml(str(d.label))}</a></p>`);
        break;
      }
      ctx.buttons.push({id, action: str(d.action), target: str(d.target), amount: num(d.amount, 1), ...(typeof d.min === 'number' ? {min: d.min} : {}), ...(typeof d.max === 'number' ? {max: d.max} : {})});
      html.push(`<p class="kitbtn"><button type="button" class="kit-btn" data-btn="${id}">${escapeHtml(str(d.label))}</button></p>`);
      break;
    }
    case 'kitlight': {
      const cell = str(d.refCellId);
      const okAt = num(d.okAt, 1);
      const warnAt = num(d.warnAt, 0);
      const status = str(d.status) || 'off';
      ctx.lights.push({cell, okAt, warnAt});
      const readout = ctx.values.has(cell) ? formatValue(ctx.values.get(cell)) : '';
      html.push(
        `<p class="reactive kitlight" data-light="${cell}" data-status="${escapeHtml(status)}"><span class="kit-light-dot"></span> <span class="kit-light-label">${escapeHtml(str(d.label))}</span> <span class="kit-light-val" data-val>${escapeHtml(readout)}</span></p>`,
      );
      break;
    }
    case 'kitprogress': {
      const cell = str(d.refCellId);
      const max = num(d.max, 100) || 100;
      const format = str(d.format) || 'percent';
      ctx.progress.push({cell, max, format});
      const {pct, readout} = progressOf(ctx.values.get(cell), max, format);
      html.push(
        `<div class="reactive kitprogress" data-progress="${cell}" data-max="${max}" data-format="${escapeHtml(format)}">` +
          `<div class="kit-prog-head"><span class="kit-prog-label">${escapeHtml(str(d.label))}</span><span class="kit-prog-val" data-val>${escapeHtml(readout)}</span></div>` +
          `<div class="kit-prog-track"><div class="kit-prog-fill" data-fill style="width:${pct}%"></div></div></div>`,
      );
      break;
    }
    default:
      break;
    }
  }
  return html.join('\n');
}

/** Coerce a progress cell value to {pct, readout} the way the editor's bar does. */
function progressOf(value: unknown, max: number, format: string): {pct: number; readout: string} {
  const raw = typeof value === 'boolean' ? (value ? max : 0) : Number(value ?? 0);
  const fraction = Number.isFinite(raw) ? Math.max(0, Math.min(1, max === 0 ? 0 : raw / max)) : 0;
  const pct = Math.round(fraction * 100);
  const trim = (n: number): string => (Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100));
  return {pct, readout: format === 'fraction' ? `${trim(raw)} / ${trim(max)}` : `${pct}%`};
}

/** Seed a context's reactive lookups from a page snapshot's persisted cell data. */
function loadSnapshot(snapshot: PageSnapshot, values: Map<string, unknown>, nameByCell: Map<string, string>): void {
  for (const [cell, value] of snapshot.values as Array<[string, unknown]>) values.set(cell, value);
  for (const [name, cell] of snapshot.names as Array<[string, string]>) nameByCell.set(cell, name);
}

/** Assemble the final HTML document from rendered body markup + collected specs.
 *  `extra` injects deck-specific CSS + a nav script (used by the slide deck). */
function document_(
  bodyHtml: string,
  headTitle: string,
  ctx: RenderCtx,
  rootId?: string,
  extra?: {styles?: string; script?: string},
): string {
  const live =
    ctx.sliders.length > 0 ||
    ctx.exprs.length > 0 ||
    ctx.charts.length > 0 ||
    ctx.inputs.length > 0 ||
    ctx.buttons.length > 0 ||
    ctx.lights.length > 0 ||
    ctx.progress.length > 0;
  // Seed EVERY persisted cell value, then overlay the render-time ones: an
  // expression may read a name whose block isn't itself reactive in the
  // export, and an unseeded cell poisons whole dependency chains (undefined
  // .length throws → the expr dies → NaN everywhere downstream).
  const data = {
    values: {...Object.fromEntries(ctx.values), ...ctx.initialValues},
    sliders: ctx.sliders,
    exprs: ctx.exprs,
    charts: ctx.charts,
    inputs: ctx.inputs,
    buttons: ctx.buttons,
    lights: ctx.lights,
    progress: ctx.progress,
  };
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
<style>${STYLES}</style>${extra?.styles ? `\n<style>${extra.styles}</style>` : ''}
</head>
<body${rootId ? ` data-root="${escapeHtml(rootId)}"` : ''}>
${rootId ? '<header class="ob-nav"><button id="ob-back" hidden>← Back</button></header>\n' : ''}${bodyHtml}
${reactive}${nav}${extra?.script ? `\n<script>${escapeScript(extra.script)}</script>` : ''}
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
    inputs: [],
    buttons: [],
    lights: [],
    progress: [],
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

/** Slide-deck CSS: one slide visible at a time, fading + sliding up, with a
 *  floating nav. `@media print` falls back to one slide per page. */
const SLIDE_STYLES = `
.ob-deck { max-width: none; padding: 0; }
.slide { display: none; box-sizing: border-box; min-height: 100vh; max-width: 60rem; margin: 0 auto; padding: clamp(2rem,6vh,5rem) clamp(1.5rem,6vw,5rem); }
.slide[data-current] { display: block; animation: ob-slide-in 340ms cubic-bezier(.2,.7,.2,1) both; }
.slide .slide-title h1 { font-size: 2.4rem; margin: 0 0 1.5rem; }
@keyframes ob-slide-in { from { opacity: 0; transform: translateY(18px); } to { opacity: 1; transform: none; } }
.deck-nav { position: fixed; bottom: 1rem; left: 50%; transform: translateX(-50%); display: flex; align-items: center; gap: .6rem; padding: .3rem .6rem; border: 1px solid #e5e7eb; border-radius: 999px; background: rgba(255,255,255,.92); box-shadow: 0 2px 10px rgba(0,0,0,.08); font: 14px system-ui, sans-serif; }
.deck-nav button { border: 0; background: none; cursor: pointer; font-size: 1.25rem; line-height: 1; padding: .1rem .45rem; color: #333; }
#deck-counter { min-width: 3.5rem; text-align: center; font-variant-numeric: tabular-nums; color: #555; }
@media print { .slide { display: block !important; min-height: 0; page-break-after: always; } .deck-nav { display: none; } }
`;

/** Slide navigation runtime: arrow / space / page keys + the nav buttons. Skips
 *  key handling while a form control is focused so widgets keep their keys. */
const SLIDE_NAV = `
(function(){
  var slides = [].slice.call(document.querySelectorAll('.slide'));
  if (!slides.length) return;
  var i = 0, counter = document.getElementById('deck-counter');
  function show(n){
    i = Math.max(0, Math.min(slides.length - 1, n));
    for (var k = 0; k < slides.length; k++) { if (k === i) slides[k].setAttribute('data-current',''); else slides[k].removeAttribute('data-current'); }
    if (counter) counter.textContent = (i + 1) + ' / ' + slides.length;
    try { window.dispatchEvent(new Event('resize')); } catch (e) {}
  }
  function field(t){ return t && t.closest && t.closest('input,textarea,select,[contenteditable=true]'); }
  document.addEventListener('keydown', function(e){
    if (field(e.target)) return;
    if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'Spacebar' || e.key === 'PageDown') { e.preventDefault(); show(i + 1); }
    else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); show(i - 1); }
  });
  var p = document.getElementById('deck-prev'), n = document.getElementById('deck-next');
  if (p) p.addEventListener('click', function(){ show(i - 1); });
  if (n) n.addEventListener('click', function(){ show(i + 1); });
  show(0);
})();
`;

/** Build a self-contained, interactive slide deck: blocks split into slides at
 *  every divider, widgets stay live offline, arrow-key navigation. */
export function toSlideDeck(rawSnapshot: PageSnapshot, title: string, icon: string): string {
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
    inputs: [],
    buttons: [],
    lights: [],
    progress: [],
    initialValues: {},
    chartSeq: {n: 0},
    anchorPrefix: '',
    pageExists: () => false,
    titleOf: (id) => id,
    iconOf: () => '',
    databaseOf: () => undefined,
  };
  const blocks = (snapshot.editorjs as {blocks?: RawBlock[]} | undefined)?.blocks ?? [];
  // Group blocks into slides at each divider (notes are already stripped by the
  // block→editorjs projection); drop empty groups from doubled/edge dividers.
  const groups: RawBlock[][] = [[]];
  for (const b of blocks) {
    if (b.type === 'divider') groups.push([]);
    else groups[groups.length - 1].push(b);
  }
  const slides = groups.filter((g) => g.length > 0);
  if (slides.length === 0) slides.push([]);
  const sections = slides
    .map((g, idx) => {
      const head =
        idx === 0
          ? `<header class="slide-title"><h1>${icon ? `${escapeHtml(icon)} ` : ''}${escapeHtml(title)}</h1></header>\n`
          : '';
      // Mark the first slide current at build time so it shows on first paint
      // (and without JS / when printing); the nav runtime then takes over.
      return `<section class="slide"${idx === 0 ? ' data-current' : ''}>${head}${renderBlocks(g, ctx)}</section>`;
    })
    .join('\n');
  const body = `<main class="ob-deck">\n${sections}\n<nav class="deck-nav"><button id="deck-prev" aria-label="Previous slide">‹</button><span id="deck-counter"></span><button id="deck-next" aria-label="Next slide">›</button></nav>\n</main>`;
  return document_(body, title, ctx, undefined, {styles: SLIDE_STYLES, script: SLIDE_NAV});
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
    inputs: [],
    buttons: [],
    lights: [],
    progress: [],
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
      const iconText = pageIconToText(page.icon);
      return (
        `<section class="page" data-page="${escapeHtml(page.id)}"${hidden}>\n` +
        `<h1 class="doc-title">${iconText ? `${escapeHtml(iconText)} ` : ''}${escapeHtml(page.title)}</h1>\n` +
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
@media (prefers-color-scheme: dark) {
  body { background: #18181b; color: #e7e7ea; }
  /* Brighter text-colour tokens so palette colours stay legible on the dark page
     (the light-theme hex go muddy). Inline runs reference these via var(); when
     this query is inactive the var() falls back to the baked light hex. */
  :root {
    --obtc-gray: #9ca3af; --obtc-brown: #c8956b; --obtc-orange: #fb923c;
    --obtc-yellow: #fcd34d; --obtc-green: #4ade80; --obtc-blue: #60a5fa;
    --obtc-purple: #c084fc; --obtc-pink: #f472b6; --obtc-red: #f87171;
  }
}
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
/* Highlight tints are always light pastels (in both themes), so the marked text
   must stay dark. An inherited colour would be light-on-light (unreadable) in dark mode. */
mark { background: #fde68a; color: #1c1917; padding: 0 .1em; border-radius: 2px; }
hr { border: none; border-top: 1px solid rgba(127,127,127,.3); width: 30%; margin: 2em auto; }
a.mention { font-weight: 600; text-decoration: underline; text-underline-offset: 2px; cursor: pointer; color: inherit; }
span.mention { font-weight: 600; opacity: .7; }
a.subpage, span.subpage { display: flex; align-items: center; gap: 8px; margin: .4em 0; padding: 8px 12px; border: 1px solid rgba(127,127,127,.22); border-radius: 8px; text-decoration: none; color: inherit; font-weight: 600; cursor: pointer; }
a.subpage:hover { background: rgba(127,127,127,.08); }
.subpage.is-missing { opacity: .55; cursor: default; }
.subpage__icon { font-size: 1.1em; line-height: 1; }
.cols { display: flex; gap: 1.5rem; flex-wrap: wrap; align-items: flex-start; margin: 1em 0; }
.cols > .col { flex: 1 1 12rem; min-width: 0; }
.cols > .col > :first-child { margin-top: 0; }
@media (max-width: 640px) { .cols { flex-direction: column; gap: .25rem; } }
.reactive { background: rgba(127,127,127,.06); border: 1px solid rgba(127,127,127,.16); border-radius: 8px; padding: 10px 12px; margin: 1em 0; }
.kitinput { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.kit-label { font-weight: 600; font-size: .92rem; }
.kit-options { display: flex; flex-wrap: wrap; gap: 6px; }
.kit-pill { font: inherit; font-size: .85rem; cursor: pointer; border: 1px solid rgba(127,127,127,.35); background: transparent; color: inherit; border-radius: 999px; padding: 3px 12px; display: inline-flex; align-items: center; gap: 8px; }
.kit-pill .kit-dot { display: none; }
.kit-pill.kit-on { background: #6366f1; border-color: #6366f1; color: #fff; }
.kit-check { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; font-size: .9rem; }
.kit-check input, .kit-toggle input { accent-color: #6366f1; }
.kitinput select, .kitinput input[type=text] { font: inherit; font-size: .9rem; color: inherit; background: transparent; border: 1px solid rgba(127,127,127,.35); border-radius: 6px; padding: 4px 8px; }
.kit-wide { display: block; }
.kit-wide .kit-label { display: block; margin-bottom: 8px; }
.kit-wide .kit-options { flex-direction: column; }
.kit-wide .kit-pill, .kit-wide .kit-check { width: 100%; border-radius: 8px; padding: 9px 14px; display: flex; justify-content: flex-start; }
.kit-wide .kit-pill { background: transparent; color: inherit; }
.kit-wide .kit-pill:hover, .kit-wide .kit-check:hover { background: rgba(127,127,127,.1); }
.kit-wide .kit-pill .kit-dot { display: inline-block; width: 13px; height: 13px; border-radius: 999px; border: 1.5px solid rgba(127,127,127,.6); flex-shrink: 0; }
.kit-wide .kit-pill.kit-on { background: rgba(99,102,241,.1); border-color: #6366f1; }
.kit-wide .kit-pill.kit-on .kit-dot { border-color: #6366f1; background: radial-gradient(circle, #6366f1 0 38%, transparent 42%); }
.kit-wide select { width: 100%; padding: 8px 10px; }
.kit-btn { font: inherit; font-size: .9rem; font-weight: 600; cursor: pointer; border: 1px solid rgba(127,127,127,.35); background: rgba(127,127,127,.08); color: inherit; border-radius: 8px; padding: 6px 16px; text-decoration: none; display: inline-block; }
.kit-btn:hover { background: rgba(127,127,127,.16); }
.kitlight { display: flex; align-items: center; gap: 8px; font-weight: 600; }
.kit-light-val { font-weight: 500; opacity: .6; font-size: .9em; }
.kit-light-dot { width: 12px; height: 12px; border-radius: 999px; background: #9ca3af; box-shadow: 0 0 0 3px rgba(156,163,175,.25); }
.kitlight[data-status=ok] .kit-light-dot { background: #10b981; box-shadow: 0 0 0 3px rgba(16,185,129,.25); }
.kitlight[data-status=warn] .kit-light-dot { background: #f59e0b; box-shadow: 0 0 0 3px rgba(245,158,11,.25); }
.kitlight[data-status=bad] .kit-light-dot { background: #ef4444; box-shadow: 0 0 0 3px rgba(239,68,68,.25); }
.kitprogress { display: flex; flex-direction: column; gap: 6px; }
.kit-prog-head { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; }
.kit-prog-label { font-weight: 600; font-size: .92rem; }
.kit-prog-val { font-variant-numeric: tabular-nums; opacity: .65; font-size: .9em; }
.kit-prog-track { height: 8px; border-radius: 999px; background: rgba(127,127,127,.18); overflow: hidden; }
.kit-prog-fill { height: 100%; border-radius: 999px; background: #6366f1; transition: width .25s ease; }
.slider input[type=range] { vertical-align: middle; width: 60%; }
.expr code { color: #4f46e5; }
figure.chart { margin: 1.2em 0; }
figure.chart svg { max-width: 100%; height: auto; }
figure.chart .chart-title { font-weight: 600; font-size: .92rem; margin-bottom: 6px; }
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
const RUNTIME = KIT_CHART_JS + `
const Plot = (typeof window !== "undefined" && window.Plot) || null;
const D = JSON.parse(document.getElementById("ob-data").textContent);
const store = new Map(Object.entries(D.values));
const get = (id) => store.get(id);
const fmt = (v) => v === undefined ? "—" : typeof v === "number" ? (Number.isInteger(v) ? ""+v : ""+(Math.round(v*1000)/1000)) : Array.isArray(v) ? "["+v.slice(0,8).join(", ")+(v.length>8?", …":"")+"]" : JSON.stringify(v);
function evalExpr(src){ const code = src.replace(/__C__\\{([^}]+)\\}__/g, (_,id)=>"get("+JSON.stringify(id)+")"); try { return new Function("get","return ("+code+");")(get); } catch(e){ if(!(e instanceof SyntaxError)) return undefined; } try { return new Function("get",code)(get); } catch(e){ return undefined; } }
function normalize(v,name){ if(Array.isArray(v)&&v.every(n=>typeof n==="number")) return [{name,data:v}]; if(v&&Array.isArray(v.series)) return v.series.map(s=>({name:String(s.name),data:(s.data||[]).filter(n=>typeof n==="number")})); return []; }

function statusOf(v, okAt, warnAt){ if(v===undefined||v===null) return "off"; if(typeof v==="boolean") return v?"ok":"bad"; if(typeof v==="string") return (v==="ok"||v==="warn"||v==="bad")?v:"off"; if(typeof v==="number"){ if(v>=okAt) return "ok"; if(v>=warnAt) return "warn"; return "bad"; } return "off"; }
function progressOf(v, max, format){ const raw = typeof v==="boolean"?(v?max:0):Number(v==null?0:v); const fr = isFinite(raw)?Math.max(0,Math.min(1, max===0?0:raw/max)):0; const pct=Math.round(fr*100); const trim=(n)=>Number.isInteger(n)?(""+n):(""+(Math.round(n*100)/100)); return {pct:pct, readout: format==="fraction"?(trim(raw)+" / "+trim(max)):(pct+"%")}; }
function recompute(){
  for (const e of D.exprs) store.set(e.cell, evalExpr(e.source));
  for (const e of D.exprs){ const el=document.querySelector('[data-cell="'+e.cell+'"] [data-val]'); if(el) el.textContent = fmt(get(e.cell)); }
  for (const l of (D.lights||[])){ const el=document.querySelector('[data-light="'+l.cell+'"]'); if(el){ const v=get(l.cell); el.setAttribute("data-status", statusOf(v, l.okAt, l.warnAt)); const val=el.querySelector("[data-val]"); if(val) val.textContent = fmt(v); } }
  for (const p of (D.progress||[])){ const el=document.querySelector('[data-progress="'+p.cell+'"]'); if(el){ const r=progressOf(get(p.cell), p.max, p.format); const fill=el.querySelector("[data-fill]"); if(fill) fill.style.width = r.pct+"%"; const val=el.querySelector("[data-val]"); if(val) val.textContent = r.readout; } }
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
for (const inp of (D.inputs||[])){
  const wrap = document.querySelector('[data-cell="'+inp.cell+'"]'); if(!wrap) continue;
  if (inp.kind === "radio"){
    const pills = Array.from(wrap.querySelectorAll("[data-opt]"));
    pills.forEach(btn => btn.addEventListener("click", () => {
      store.set(inp.cell, btn.dataset.opt);
      pills.forEach(b => b.classList.toggle("kit-on", b === btn));
      recompute();
    }));
  } else if (inp.kind === "checklist"){
    const boxes = Array.from(wrap.querySelectorAll("input[type=checkbox]"));
    boxes.forEach(b => b.addEventListener("change", () => {
      store.set(inp.cell, boxes.filter(x => x.checked).map(x => x.dataset.opt));
      recompute();
    }));
  } else if (inp.kind === "dropdown"){
    const sel = wrap.querySelector("select");
    sel.addEventListener("change", () => { store.set(inp.cell, sel.value); recompute(); });
  } else if (inp.kind === "toggle"){
    const box = wrap.querySelector("input[type=checkbox]");
    box.addEventListener("change", () => { store.set(inp.cell, box.checked); recompute(); });
  } else {
    const t = wrap.querySelector("input[type=text]");
    if (t) t.addEventListener("input", () => { store.set(inp.cell, t.value); recompute(); });
  }
}
for (const b of (D.buttons||[])){
  const el = document.querySelector('[data-btn="'+b.id+'"]'); if(!el) continue;
  el.addEventListener("click", () => {
    const cur = store.get(b.target);
    let next = b.action === "toggle" ? !cur : b.action === "set" ? b.amount : (typeof cur === "number" ? cur : 0) + b.amount;
    if (typeof next === "number"){
      if (typeof b.min === "number") next = Math.max(b.min, next);
      if (typeof b.max === "number") next = Math.min(b.max, next);
    }
    store.set(b.target, next);
    // Mirror the target's visible control so the UI tracks the store.
    const wrap = document.querySelector('[data-cell="'+b.target+'"]');
    if (wrap){
      const range = wrap.querySelector("input[type=range]");
      if (range){ range.value = next; const out = wrap.querySelector("output"); if (out) out.textContent = String(next); }
      const box = wrap.querySelector("input[type=checkbox]");
      if (box && typeof next === "boolean") box.checked = next;
    }
    recompute();
  });
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
