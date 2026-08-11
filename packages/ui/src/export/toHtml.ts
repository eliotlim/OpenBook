/**
 * Render a page — or a whole reachable mini-site — to a **self-contained,
 * interactive** HTML document, structured in three layers:
 *
 * 1. A **static first-paint body** — the `renderBlocks` projection: readable
 *    without JS, and the surface the PDF pipeline snapshots.
 * 2. The **`application/openbook+json` source island** — the lossless source
 *    of truth (block-doc + assetIds intact), always embedded for re-import.
 * 3. The **vendored viewer bundle** (the real OpenBook block renderer, built
 *    self-contained by `vite.viewer.config.js`) plus a small boot script that
 *    parses the island and mounts `OpenBookViewer` over the static body —
 *    locked-but-interactive: sliders drive charts, tabs switch, sections
 *    collapse, and nothing ever persists.
 *
 * Block-doc snapshots hydrate through the viewer. Two surfaces still use the
 * bespoke legacy runtime (`RUNTIME`/`NAV` + conditional d3/Plot vendoring):
 * legacy EditorJS-only snapshots (the viewer has no block-doc to mount) and
 * site bundles containing databases (the viewer does not render database
 * rosters yet), plus slide decks (a viewer deck mode is a follow-up).
 *
 * - {@link toHtml} renders one page snapshot (the Markdown/PDF-parity baseline).
 * - {@link toHtmlSite} renders a {@link SiteBundle}: every page as a section,
 *   navigable via the viewer's hash nav (or the legacy router on fallback).
 */
import type {DatabaseProperty, DatabaseRow, DatabaseSchema, PageSnapshot} from '@book.dev/sdk';
import {assetsIslandScript, isSafeHref, pageIslandScript, libraryIslandScript, type ExportAssetEntry} from '@book.dev/sdk';
import {DATA_COLOR_SCHEMES, DATA_PALETTE, DATA_STROKE, DEFAULT_DATA_COLOR_SCHEME, hexAlpha, isDataColorToken, statusColor, type DataColorScheme} from '@book.dev/sdk';
import {formToStaticHtml, projectSnapshotForExport} from '../blockeditor/exportBlocks';
import {formOriginUrl, formSchemaFromProps} from '../blockeditor/formBlock';
import {describeUnknownBlock} from '../blockeditor/unknownBlock';
import type {DbChartSeriesMap} from '../blockeditor/kit/chartData';
import {collectExportAssetIds, emptyExportAssets, type AssetMap, type ExportAssets} from './exportAssets';
// Inlined so a page with charts works fully offline: d3's UMD sets `window.d3`,
// then Plot's UMD (which expects a global d3) sets `window.Plot`. Inlined only
// when the document actually has a chart, and code-split (this module is a
// dynamic import) so it never weighs on the main bundle. LEGACY-PATH ONLY (see
// module doc) — viewer-hydrated exports carry their own chart renderer.
import d3Umd from './vendor/d3.min.js?raw';
import plotUmd from './vendor/plot.umd.min.js?raw';
import SAFE_EXPRESSION_JS from './safeExpressionRuntime.js?raw';
// The self-contained viewer bundle (IIFE exposing `OpenBookViewer`), generated
// into vendor/ by `pnpm --filter @book.dev/ui run build:viewer` (which runs
// FIRST in the ui package's build, so this ?raw always inlines a fresh bundle).
import viewerJs from './vendor/openbook-viewer.js?raw';
import {parseInline, type InlineRun, type ListItem} from './documentModel';
import {
  KEEP_STATIC_ATTR,
  describeLedgerInteractiveBlock,
  describeLedgerReportBlock,
  isLedgerBlockType,
  keepStaticAttrs,
  ledgerExportRecords,
  renderLedgerReportBlock,
  type LedgerExportRecords,
} from './exportLedgerReports';
import {COLOR_EXPORT_HEX} from '../blockeditor/colors';
import {kitChartRuntime, kitChartSvg} from './kitChart';
import {formatValue} from './format';
import {inlineScriptHash, pageCsp} from './exportCsp';
import {pageIconToText} from '@/lib/iconValue';
import {cellValue, formatCellValue} from '@/components/database/databaseCells';
import type {SiteBundle, SiteDatabase} from './exportSite';
import {sanitizeSnapshotForExport} from './sanitizeSnapshot';

// The legacy runtime is an inline module and can consume the raw file's named
// export directly. The hydrated viewer remains a classic IIFE, so its preceding
// interpreter copy drops that one module keyword and publishes a private hook.
const SAFE_EXPRESSION_CLASSIC =
  SAFE_EXPRESSION_JS.replace('export function readSafeExpression', 'function readSafeExpression') +
  '\nglobalThis.__OB_SAFE_EXPRESSION__=readSafeExpression;';

// D3's DSV helper generates a record-mapper with the Function constructor.
// Plot charts do not need code generation, but the helper still ships in the
// UMD. Replace that exact factory with the same mapping expressed as a closure
// before D3 becomes part of a recipient's file. The split literal ensures this
// source module does not itself advertise a dynamic-compiler call site.
const D3_DYNAMIC_RECORD_FACTORY =
  'function Wu(t){return new ' +
  'Function("d","return {"+t.map((function(t,n){return JSON.stringify(t)+": d["+n+\'] || ""\'})).join(",")+"}")}';
const D3_SAFE_RECORD_FACTORY =
  'function Wu(t){return function(n){return Object.fromEntries(t.map((function(t,e){return[t,n[e]||""]})))}}';
const SAFE_D3_UMD = d3Umd.replace(D3_DYNAMIC_RECORD_FACTORY, D3_SAFE_RECORD_FACTORY);
if (SAFE_D3_UMD === d3Umd) throw new Error('Vendored D3 record factory changed; safe export patch needs review');

// ── Canonical data-colour values, inlined at export (self-contained: no live
// CSS vars). The exporting user's chosen scheme (OB-379) is threaded through the
// render (`RenderCtx.scheme`) and `document_`, so the standalone file bakes the
// active Pastel/Vivid/Muted values rather than always pastel. ─────────────────
/**
 * Clamp the caller's scheme to a known value before it's baked into the file —
 * defense-in-depth. `JSON.stringify` does NOT escape `</script>`, so the
 * `window.__OB_DATA_SCHEME=…` injection (and every inlined palette lookup) must
 * never trust an unnormalized scheme from a future caller (OB-379 hardening).
 */
const safeScheme = (scheme: DataColorScheme): DataColorScheme =>
  (DATA_COLOR_SCHEMES as readonly string[]).includes(scheme) ? scheme : DEFAULT_DATA_COLOR_SCHEME;

/** Status-light CSS for a scheme: the lamps + the pastel/muted light-mode
 *  hairline (§1.2; vivid has none — `DATA_STROKE` stays the ring). */
const statusLightCss = (scheme: DataColorScheme): string =>
  (['ok', 'warn', 'bad'] as const)
    .map((s) => {
      const fill = statusColor(s, scheme);
      return `.kitlight[data-status=${s}] .kit-light-dot { background: ${fill}; box-shadow: inset 0 0 0 1px ${DATA_STROKE}, 0 0 0 3px ${hexAlpha(fill, 0.25)}; }`;
    })
    .join('\n');

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'})[c]!);
}

/** Make serialized data safe to inline inside a `<script>` element. */
function escapeScript(js: string): string {
  return js.replace(/<\//g, '<\\/');
}

/** Neutralize real script end tags without rewriting JavaScript token boundaries. */
function escapeExecutableScript(js: string): string {
  return js.replace(/<\/script(?=[\t\n\f\r />])/gi, '<\\/script');
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
  /** Image assets resolved up front: `assetId` → a `data:` URI (see exportAssets). */
  assets: Map<string, string>;
  /** Global chart counter (chart ids must be unique across the whole document). */
  chartSeq: {n: number};
  /** Prefix making this page's heading anchors unique within the document. */
  anchorPrefix: string;
  /** Canonical live page URL used by frozen forms when this export can know it. */
  originPageUrl?: string | null;
  /** True when a referenced page is in the bundle (so the link can navigate). */
  pageExists: (id: string) => boolean;
  titleOf: (id: string) => string;
  iconOf: (id: string) => string;
  /** The database hosted by a page id, when that page is in the bundle. */
  databaseOf: (hostPageId: string) => SiteDatabase | undefined;
  /** The exporting user's data-colour scheme, baked into chips/charts/status
   *  (the file is self-contained — no live CSS vars to read; OB-379). */
  scheme: DataColorScheme;
  /** LX-3: the fold-ready ledger records recovered from the export's embedded
   *  ledger section (LX-2), when the exporter included the books. Present ⇒
   *  ledger REPORT blocks render as real static tables; absent ⇒ they keep the
   *  LX-1 placeholder card. */
  ledger?: LedgerExportRecords;
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
  // Scheme-gate the link href (escapeHtml doesn't touch the scheme); an unsafe
  // scheme (javascript:/data:/…) degrades to inert text. See sdk isSafeHref.
  if (r.link && isSafeHref(r.link)) html = `<a href="${escapeHtml(r.link)}">${html}</a>`;
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

const tag = (label: string, color: string | undefined, scheme: DataColorScheme): string => {
  const chip = DATA_PALETTE[scheme][isDataColorToken(color) ? color : 'gray'].chip.light;
  return `<span class="tag" style="background:${chip.bg};color:${chip.fg}">${escapeHtml(label)}</span>`;
};

function cellHtml(row: DatabaseRow, prop: DatabaseProperty, props: DatabaseProperty[], rows: DatabaseRow[], ctx: RenderCtx): string {
  const raw = cellValue(row, prop, props, rows);
  if (prop.type === 'select' || prop.type === 'status') {
    const opt = prop.options?.find((o) => o.id === raw);
    return opt ? tag(opt.label, opt.color, ctx.scheme) : '';
  }
  if (prop.type === 'multi_select') {
    const ids = Array.isArray(raw) ? (raw as string[]) : [];
    return (prop.options ?? []).filter((o) => ids.includes(o.id)).map((o) => tag(o.label, o.color, ctx.scheme)).join(' ');
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

interface ExportBlock {id?: string; type?: string; data?: Record<string, unknown>}

/** Render a page's blocks to HTML, collecting reactive specs into the context. */
function renderBlocks(blocks: ExportBlock[], ctx: RenderCtx): string {
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
      // TBL-4: per-cell tint tokens (parallel to `content`) → inline background.
      const colors = Array.isArray(d.cellColors) ? (d.cellColors as unknown[][]) : [];
      const spans = Array.isArray(d.cellSpans) ? (d.cellSpans as unknown[][]) : [];
      const cell = (c: unknown) => inlineToHtml(parseInline(str(c)), ctx);
      const tint = (ri: number, ci: number): string => {
        const tok = colors[ri]?.[ci];
        return typeof tok === 'string' && COLOR_EXPORT_HEX[tok] ? ` style="background:${COLOR_EXPORT_HEX[tok].hl}"` : '';
      };
      const spanAttrs = (ri: number, ci: number): string => {
        const raw = spans[ri]?.[ci];
        if (!raw || typeof raw !== 'object') return '';
        const value = (key: 'colspan' | 'rowspan'): number => {
          const n = (raw as Record<string, unknown>)[key];
          return typeof n === 'number' && Number.isFinite(n) && n >= 2 ? Math.min(512, Math.floor(n)) : 1;
        };
        const colspan = value('colspan');
        const rowspan = value('rowspan');
        return `${colspan > 1 ? ` colspan="${colspan}"` : ''}${rowspan > 1 ? ` rowspan="${rowspan}"` : ''}`;
      };
      const rowsHtml = content.map((row, ri) => {
        const cells = (Array.isArray(row) ? row : [])
          .map((c, ci) =>
            ri === 0 && d.withHeadings === true
              ? `<th${spanAttrs(ri, ci)}${tint(ri, ci)}>${cell(c)}</th>`
              : `<td${spanAttrs(ri, ci)}${tint(ri, ci)}>${cell(c)}</td>`,
          )
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
      const cols = Array.isArray(d.columns) ? (d.columns as ExportBlock[][]) : [];
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
      // Scheme-gate the button href; an unsafe/empty url renders as the inert
      // is-empty span (same as no url). See sdk isSafeHref.
      const safeUrl = url && isSafeHref(url);
      html.push(safeUrl ? `<p><a class="button" href="${escapeHtml(url)}"${ext}>${label}</a></p>` : `<p><span class="button is-empty">${label}</span></p>`);
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
    case 'image': {
      // Resolve the picture: a pre-resolved `assetId` → data-URI, else a legacy
      // `data:`/remote `src` used directly. Unresolvable → a captioned alt-text
      // placeholder (never a broken <img>, so the PDF snapshot stays clean too).
      const assetId = str(d.assetId);
      const rawSrc = str(d.src);
      const direct = rawSrc && (rawSrc.startsWith('data:') || /^https?:\/\//i.test(rawSrc)) ? rawSrc : '';
      const resolved = (assetId ? ctx.assets.get(assetId) : '') ?? '';
      const src = resolved || direct;
      const alt = escapeHtml(str(d.alt));
      const caption = str(d.caption).trim();
      const widthStyle = d.width ? ` style="width:${escapeHtml(str(d.width))}"` : '';
      const figcap = caption ? `<figcaption>${escapeHtml(caption)}</figcaption>` : '';
      // A store-resolved image is tagged with its content-addressed `assetId` so
      // an island-first import (and the viewer's boot) can recover the bytes
      // from this very file: the island's block-doc keeps the assetId, this
      // <img> carries the data-URI (artifact documents ride the assets island
      // instead), and re-uploading those bytes restores the SAME id.
      const assetAttr = resolved ? ` data-asset-id="${escapeHtml(assetId)}"` : '';
      html.push(
        src
          ? `<figure class="ob-image"><img src="${escapeHtml(src)}" alt="${alt}"${widthStyle}${assetAttr}>${figcap}</figure>`
          : `<figure class="ob-image is-missing"><div class="ob-image-alt"${widthStyle}>${alt || 'Image'}</div>${figcap}</figure>`,
      );
      break;
    }
    case 'form': {
      const props = d.props && typeof d.props === 'object' && !Array.isArray(d.props)
        ? (d.props as Record<string, unknown>)
        : d;
      html.push(formToStaticHtml(formSchemaFromProps(props), ctx.originPageUrl));
      break;
    }
    case 'htmlArtifact': {
      // Static first-paint: a captioned placeholder figure, NEVER a live
      // iframe — the artifact only runs once the vendored viewer hydrates it
      // through the sandboxed renderer (page/site exports). Slide decks and
      // legacy-path exports never hydrate, so they keep this placeholder. The
      // bytes travel in the assets island (see sdk `assetsIslandScript`), keyed
      // by the `data-artifact-asset-id` stamped here.
      const artifactId = str(d.assetId);
      const artifactTitle = escapeHtml(str(d.title).trim()) || 'HTML artifact';
      const idAttr = artifactId ? ` data-artifact-asset-id="${escapeHtml(artifactId)}"` : '';
      html.push(
        `<figure class="ob-artifact"${idAttr}><div class="ob-artifact-placeholder"><span class="ob-artifact-label">${artifactTitle}</span>` +
          '<span class="ob-artifact-hint">Interactive HTML artifact — needs JavaScript (or open in OpenBook).</span></div></figure>',
      );
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
      const initial = d.kind && cells.length && ctx.values.has(cells[0]) ? kitChartSvg(ctx.values.get(cells[0]), str(d.kind), labels, ctx.scheme) : '';
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
        // Scheme-gate the kit-button href; an unsafe scheme renders as an inert
        // labelled span (no live link). See sdk isSafeHref.
        const url = str(d.url);
        html.push(
          url && isSafeHref(url)
            ? `<p class="kitbtn"><a class="kit-btn" href="${escapeHtml(url)}" target="_blank" rel="noreferrer noopener">${escapeHtml(str(d.label))}</a></p>`
            : `<p class="kitbtn"><span class="kit-btn is-empty">${escapeHtml(str(d.label))}</span></p>`,
        );
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
    default: {
      // A plugin-contributed (`{pluginId}/{blockName}`) or newer-version block
      // type. The projection now preserves its identity (LX-1), so render the
      // same labelled placeholder the app shows for a missing plugin rather
      // than dropping the block: the reader sees WHAT is here and why it isn't
      // drawn. Any text the block carried rides along. This is the final render
      // for decks, the PDF path and no-JS/no-hydrate exports; on the hydrate
      // path the viewer replaces it with its own missing-plugin card.
      //
      // LX-3: ledger REPORT blocks are better than a placeholder when the
      // export carries the books (LX-2's ledger section): compute the report
      // with the same pure folds the in-app block uses and emit a real static
      // table, honouring the block's persisted props. A fold refusal (corrupt
      // stored amount, unlinkable journal entry) falls through to the card.
      if (ctx.ledger) {
        const table = renderLedgerReportBlock({type: str(block.type), id}, (d.props ?? {}) as Record<string, unknown>, ctx.ledger);
        if (table !== null) {
          html.push(table);
          break;
        }
      }
      // The four interactive ledger tools act on the LIVE books — no static
      // render exists, records or not, so their card says "interactive"
      // instead of implying a missing plugin. A ledger REPORT block with no
      // usable books (records off) gets its own ledger-aware hint too: the
      // plugin is first-party, so "install the plugin" would be the wrong
      // diagnosis — the books just weren't included in this export. With
      // records ON, a report the renderer refused (fold error, unlinkable
      // journal entry) keeps the generic card.
      const {label, hint} =
        describeLedgerInteractiveBlock(str(block.type)) ??
        (ctx.ledger ? null : describeLedgerReportBlock(str(block.type))) ??
        describeUnknownBlock(str(block.type));
      const text = str(d.text) ? inlineToHtml(parseInline(str(d.text)), ctx) : '';
      // LX-5: a LEDGER card's wording is already the honest, first-party one
      // (interactive tool / books-not-included), so it is marked keep-on-hydrate
      // exactly like a report table — the viewer re-attaches it instead of
      // replacing it with the generic "install the plugin" card. Third-party
      // plugin blocks are NOT marked: for those the viewer's own card (plugin
      // icon, "Open in OpenBook to install") is the better render.
      const keep = isLedgerBlockType(str(block.type)) ? keepStaticAttrs(id) : '';
      html.push(
        `<div class="ob-plugin-block" data-block-type="${escapeHtml(str(block.type))}"${keep}>` +
          `<p class="ob-plugin-block-label">${escapeHtml(label)}</p>` +
          `<p class="ob-plugin-block-hint">${escapeHtml(hint)}</p>` +
          (text ? `<p class="ob-plugin-block-text">${text}</p>` : '') +
          '</div>',
      );
      break;
    }
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

/**
 * The viewer boot: parses the source island and mounts the vendored
 * `OpenBookViewer` over the static body. Emitted only on the hydrate path
 * (block-doc content), directly after the island + bundle scripts.
 *
 * Island access: the boot reads the island element's `textContent` from the
 * live DOM. That is safe **here, by construction**: every character of the
 * static body is HTML-escaped by this renderer (no raw `<!--` can reach the
 * parser) and the island's `</` are `<\/`-escaped (sdk `encodeIsland`), so the
 * browser's parse of this generated document is faithful. Consumers that hold
 * the export as a *string* (import, tooling, tests) must extract the island
 * with the sdk's `readIslandRaw`/`readIsland` (string/regex) — never by
 * feeding untrusted HTML through a DOM parser, where hostile raw text can
 * swallow a trailing island.
 *
 * Assets: the boot assembles the viewer's `Map<assetId, bytes>` payload from
 * two carriers — the assets island (artifact document text) and the static
 * body's `<img data-asset-id src="data:…">` tags (image bytes, which are never
 * duplicated into the island). Harvesting happens BEFORE the static body is
 * replaced. This is the same recovery contract island-first import uses.
 *
 * Kept static blocks (LX-5): the same pre-swap pass also harvests the static
 * renders the viewer cannot reproduce and must NOT overwrite — ledger report
 * tables (LX-3) and the ledger placeholder cards — keyed by block id off the
 * `${KEEP_STATIC_ATTR}` marker, and hands them to `mount` as `staticBlocks`.
 * The viewer replants those nodes where its missing-plugin card would have gone,
 * so a reader who opens the file with JS ON sees the SAME numbers a no-JS/print
 * reader sees. No ledger code (and no ledger bytes) enter the viewer bundle: the
 * marker, the report folds and the wording all stay on the export side.
 *
 * Failure modes all keep the static render: no island, corrupt JSON, a legacy
 * snapshot without a block-doc, or a mount throw (the static body is restored).
 * `window.__OB_NO_HYDRATE` short-circuits the boot entirely — the PDF pipeline
 * sets it so `toPdf` snapshots the static projection (see toPdf `layout`).
 */
const VIEWER_BOOT = `
(function(){
  if (window.__OB_NO_HYDRATE) return; // static consumers (the PDF pipeline) opt out
  var tag = document.querySelector('script[type="application/openbook+json"]');
  if (!tag || !window.OpenBookViewer) return;
  var island = null;
  try { island = JSON.parse(tag.textContent); } catch (e) { /* corrupt island */ }
  if (!island) return; // keep the static render
  var source = null, pageRef;
  // Dual-read the whole-space bundle key: new exports carry it under 'library'
  // (LIB-4), already-published files under the legacy 'space' key.
  var bundle = island.library || island.space;
  if (bundle && bundle.pages) { source = bundle; pageRef = island.rootId || undefined; }
  else if (island.data && island.data.blockdoc) { source = island; }
  if (!source) return; // legacy snapshot: the static body IS the render
  var main = document.querySelector('main');
  if (!main || !main.parentNode) return;
  // The asset payload: artifact text from the assets island…
  var assets = {};
  var assetsTag = document.querySelector('script[type="application/openbook-assets+json"]');
  if (assetsTag) {
    try {
      var carried = JSON.parse(assetsTag.textContent);
      if (carried && carried.version === 1 && carried.assets && typeof carried.assets === 'object') assets = carried.assets;
    } catch (e) { /* corrupt assets island — artifacts degrade to placeholders */ }
  }
  // …plus image bytes harvested from the static body's data-URIs.
  main.querySelectorAll('img[data-asset-id]').forEach(function(img){
    var id = img.getAttribute('data-asset-id');
    var m = /^data:([^;,]*);base64,(.*)$/.exec(img.getAttribute('src') || '');
    if (id && m && !assets[id]) assets[id] = {mime: m[1] || 'application/octet-stream', encoding: 'base64', data: m[2]};
  });
  // LX-5: static renders this document already carries and the viewer must KEEP
  // (ledger report tables + the ledger placeholder cards), harvested by block id
  // BEFORE the body is swapped. CLONES, not the live nodes: a mount throw
  // restores the original <main> intact, and the viewer plants copies.
  var keep = {};
  main.querySelectorAll('[${KEEP_STATIC_ATTR}][data-block-id]').forEach(function(el){
    var bid = el.getAttribute('data-block-id');
    if (bid && !keep[bid]) keep[bid] = el.cloneNode(true);
  });
  // Preserve each frozen form's canonical live-page target across hydration.
  // A file:// viewer cannot infer that target after the static body is swapped.
  var formOrigins = {};
  main.querySelectorAll('section.page[data-page]').forEach(function(section){
    var pid = section.getAttribute('data-page');
    var link = section.querySelector('a.ob-form-live[href]');
    if (pid && link) formOrigins[pid] = link.getAttribute('href');
  });
  if (!bundle && source.id) {
    var singleLink = main.querySelector('a.ob-form-live[href]');
    if (singleLink) formOrigins[source.id] = singleLink.getAttribute('href');
  }
  var host = document.createElement('div');
  host.id = 'ob-viewer-host';
  main.parentNode.replaceChild(host, main);
  try { window.OpenBookViewer.mount(host, source, {page: pageRef, assets: assets, staticBlocks: keep, formOrigins: formOrigins}); }
  catch (e) { if (host.parentNode) host.parentNode.replaceChild(main, host); }
})();
`;

/** Assemble the final HTML document from rendered body markup + collected specs.
 *  `extra` injects deck-specific CSS + a nav script (used by the slide deck).
 *  `island` is the lossless `application/openbook+json` source blob — ALWAYS
 *  embedded (no toggle) so the standalone file round-trips back into OpenBook; it
 *  is inert data (a non-JS `<script type>`), and its `</`-escaping means hostile
 *  page content can't break out of it or the document. Its block-doc keeps image
 *  `assetId`s (the visible body carries the data-URIs); see the SDK `island.ts`
 *  asset contract.
 *
 *  `hydrate` picks the runtime: the vendored viewer bundle + boot (block-doc
 *  content — the island precedes them in the body so the boot can read it), or
 *  the legacy `RUNTIME`/`NAV` scripts (`rootId` wires the legacy site router). */
function document_(
  bodyHtml: string,
  headTitle: string,
  ctx: RenderCtx,
  opts: {
    rootId?: string;
    extra?: {styles?: string; script?: string};
    island?: string;
    /** The assets island (artifact bytes) — MUST follow the source island (sdk
     *  ordering contract: string readers trust the first plausible tag). */
    assetsIsland?: string;
    hydrate?: boolean;
  } = {},
): string {
  const {rootId, extra, island, assetsIsland, hydrate} = opts;
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
  const scriptHashes: string[] = [];
  const inlineScript = (source: string, type?: 'module'): string => {
    // Hash the exact bytes the HTML parser sees, after closing-tag escaping.
    const escaped = escapeExecutableScript(source);
    scriptHashes.push(inlineScriptHash(escaped));
    return `<script${type ? ` type="${type}"` : ''}>${escaped}</script>`;
  };
  // Kit charts draw themselves (drawKit in the runtime) — only classic
  // cell-driven charts need the vendored d3 + Observable Plot bundles.
  const libs = ctx.charts.some((c) => !c.kind) ? `${inlineScript(SAFE_D3_UMD)}\n${inlineScript(plotUmd)}\n` : '';
  const reactive = !hydrate && live
    ? `${libs}<script type="application/json" id="ob-data">${escapeScript(JSON.stringify(data))}</script>\n${inlineScript(runtimeFor(ctx.scheme), 'module')}\n`
    : '';
  const nav = !hydrate && rootId ? inlineScript(NAV.replace('__ROOT__', JSON.stringify(rootId))) : '';
  // Hydrate path: the island must already be in the DOM when the boot runs, so
  // the order is island → viewer bundle → boot, at the end of <body>. The scheme
  // global is set FIRST so the viewer (provider-less) recolours its data surfaces
  // to the exporting user's scheme rather than the pastel default (OB-379).
  const viewer = hydrate
    ? `\n${inlineScript(SAFE_EXPRESSION_CLASSIC)}\n${inlineScript(`window.__OB_DATA_SCHEME=${JSON.stringify(ctx.scheme)}`)}\n${inlineScript(viewerJs)}\n${inlineScript(VIEWER_BOOT)}`
    : '';
  const extraScript = extra?.script ? `\n${inlineScript(extra.script)}` : '';
  const legacyHeader = !hydrate && rootId ? '<header class="ob-nav"><button id="ob-back" hidden>← Back</button></header>\n' : '';
  const csp = pageCsp(scriptHashes);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<title>${escapeHtml(headTitle)}</title>
<style>${stylesFor(ctx.scheme)}${hydrate ? SCHEME_LIGHT : SCHEME_DUAL}</style>${extra?.styles ? `\n<style>${extra.styles}</style>` : ''}
</head>
<body${!hydrate && rootId ? ` data-root="${escapeHtml(rootId)}"` : ''}>
${legacyHeader}${bodyHtml}
${reactive}${nav}${extraScript}${island ? `\n${island}` : ''}${assetsIsland ? `\n${assetsIsland}` : ''}${viewer}
</body>
</html>`;
}

/** Whether a snapshot carries the native block-doc the viewer can hydrate. */
function hasBlockdoc(snapshot: {editor?: string; blockdoc?: unknown} | null | undefined): boolean {
  return Boolean(snapshot && snapshot.editor === 'blocks' && snapshot.blockdoc);
}

/** Exporters accept the full {@link ExportAssets} resolution or (legacy call
 *  sites and tests) a bare image `AssetMap`; normalize to the full shape. */
type ExportAssetsLike = ExportAssets | AssetMap;
function normalizeAssets(assets: ExportAssetsLike | undefined): ExportAssets {
  if (!assets) return emptyExportAssets();
  return assets instanceof Map ? {images: assets, artifactText: new Map()} : assets;
}

/** Build the assets island for the artifact documents these snapshots actually
 *  reference (filtered so an unrelated resolution entry never leaks into the
 *  file), or '' when there is nothing to carry. Hydrate-path only: the island
 *  feeds the viewer's sandboxed renderer; placeholder-only surfaces (decks,
 *  the legacy runtime) have no consumer for the bytes. */
function artifactAssetsIsland(snapshots: PageSnapshot[], artifactText: Map<string, string>): string {
  if (artifactText.size === 0) return '';
  const entries: Record<string, ExportAssetEntry> = {};
  for (const snapshot of snapshots) {
    for (const id of collectExportAssetIds(snapshot).artifacts) {
      const text = artifactText.get(id);
      if (text !== undefined && !(id in entries)) entries[id] = {mime: 'text/html', encoding: 'utf8', data: text};
    }
  }
  return Object.keys(entries).length > 0 ? assetsIslandScript(entries) : '';
}

/** Identity carried into a single-page export's source island (all optional —
 *  an unsaved page has no id/updatedAt; the island still round-trips its data). */
export interface PageExportMeta {
  id?: string | null;
  updatedAt?: string | null;
}

/** Build the interactive HTML for a single page snapshot (Markdown/PDF parity).
 *  `assets` is the pre-resolved {@link ExportAssets} (image data-URIs +
 *  artifact document text; a bare image `AssetMap` is still accepted).
 *  Always embeds the content-lossless `rawSnapshot` as an `openbook+json`
 *  source island (same shape as `.book.html`), with write capabilities removed
 *  at that boundary; artifact bytes ride the sibling assets island (hydrate
 *  path). */
export function toHtml(
  rawSnapshot: PageSnapshot,
  title: string,
  icon: string,
  assets: ExportAssetsLike = emptyExportAssets(),
  meta: PageExportMeta = {},
  scheme: DataColorScheme = DEFAULT_DATA_COLOR_SCHEME,
  dbSeries?: DbChartSeriesMap,
): string {
  const {images, artifactText} = normalizeAssets(assets);
  const snapshot = projectSnapshotForExport(rawSnapshot, dbSeries);
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
    assets: images,
    chartSeq: {n: 0},
    anchorPrefix: '',
    originPageUrl: formOriginUrl(meta.id ?? ''),
    pageExists: () => false,
    titleOf: (id) => id,
    iconOf: () => '',
    databaseOf: () => undefined,
    scheme: safeScheme(scheme),
  };
  const blocks = (snapshot.editorjs as {blocks?: ExportBlock[]} | undefined)?.blocks ?? [];
  const body = `<main>\n<h1 class="doc-title">${icon ? `${escapeHtml(icon)} ` : ''}${escapeHtml(title)}</h1>\n${renderBlocks(blocks, ctx)}\n</main>`;
  // Block-doc pages hydrate through the vendored viewer (the island IS the
  // mount source); legacy EditorJS snapshots keep the bespoke reactive runtime.
  const hydrate = hasBlockdoc(rawSnapshot);
  return document_(body, title, ctx, {
    island: pageIsland(rawSnapshot, title, icon, meta),
    assetsIsland: hydrate ? artifactAssetsIsland([rawSnapshot], artifactText) : '',
    hydrate,
  });
}

/** The source island for a single page export: a versioned page record carrying
 *  the content-lossless `rawSnapshot` (block-doc + assetIds intact, form write
 *  capabilities stripped), not the flattened render. Same shape read back by
 *  the SDK `bookHtmlToPage` / `readIsland`. */
function pageIsland(rawSnapshot: PageSnapshot, title: string, icon: string, meta: PageExportMeta): string {
  return pageIslandScript({
    id: meta.id ?? '',
    name: title,
    icon: icon || null,
    updatedAt: meta.updatedAt ?? '',
    data: sanitizeSnapshotForExport(rawSnapshot),
  });
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
 *  every divider, widgets stay live offline, arrow-key navigation. HTML
 *  artifacts render as their captioned placeholder — a deck never hydrates the
 *  viewer (phase-2 deferral), so no assets island is emitted either. */
export function toSlideDeck(
  rawSnapshot: PageSnapshot,
  title: string,
  icon: string,
  assets: ExportAssetsLike = emptyExportAssets(),
  meta: PageExportMeta = {},
  scheme: DataColorScheme = DEFAULT_DATA_COLOR_SCHEME,
  dbSeries?: DbChartSeriesMap,
): string {
  const {images} = normalizeAssets(assets);
  const snapshot = projectSnapshotForExport(rawSnapshot, dbSeries);
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
    assets: images,
    chartSeq: {n: 0},
    anchorPrefix: '',
    originPageUrl: formOriginUrl(meta.id ?? ''),
    pageExists: () => false,
    titleOf: (id) => id,
    iconOf: () => '',
    databaseOf: () => undefined,
    scheme: safeScheme(scheme),
  };
  const blocks = (snapshot.editorjs as {blocks?: ExportBlock[]} | undefined)?.blocks ?? [];
  // Group blocks into slides at each divider (notes are already stripped by the
  // block→export projection); drop empty groups from doubled/edge dividers.
  const groups: ExportBlock[][] = [[]];
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
  // The deck's island carries the WHOLE page snapshot (every slide) losslessly —
  // the divider-split into slides is a render, the island re-imports the source.
  // Decks stay on the legacy runtime (never `hydrate`): the viewer renders a
  // page as one scrolling document, so a viewer-based deck mode (slide split +
  // keyboard nav) is an explicit follow-up.
  return document_(body, title, ctx, {extra: {styles: SLIDE_STYLES, script: SLIDE_NAV}, island: pageIsland(rawSnapshot, title, icon, meta)});
}

/**
 * Build one interactive HTML file for a whole {@link SiteBundle}: every page as a
 * navigable section, databases as tables of navigable rows, and a client-side
 * router that swaps the visible page on link clicks (with browser back/forward).
 */
export function toHtmlSite(
  bundle: SiteBundle,
  assets: ExportAssetsLike = emptyExportAssets(),
  scheme: DataColorScheme = DEFAULT_DATA_COLOR_SCHEME,
): string {
  const {images, artifactText} = normalizeAssets(assets);
  const byId = new Map(bundle.pages.map((p) => [p.id, p]));
  const values = new Map<string, unknown>();
  const nameByCell = new Map<string, string>();
  for (const page of bundle.pages) loadSnapshot(page.snapshot, values, nameByCell);

  // LX-3: when the bundle carries the books (LX-2), adapt the embedded rows to
  // the report folds' inputs ONCE — every ledger report block on every page
  // renders from the same recovered records. `null` (malformed section) means
  // the report blocks keep their LX-1 placeholders. The adapter null-guards
  // its own inputs, but this call is belt-and-braces wrapped too: NOTHING a
  // malformed ledger section carries may crash the whole site export.
  let ledger: LedgerExportRecords | null = null;
  if (bundle.ledger) {
    try {
      ledger = ledgerExportRecords(bundle.ledger);
    } catch {
      ledger = null;
    }
  }

  const ctx: RenderCtx = {
    ...(ledger ? {ledger} : {}),
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
    assets: images,
    chartSeq: {n: 0},
    anchorPrefix: '',
    pageExists: (id) => byId.has(id),
    titleOf: (id) => byId.get(id)?.title ?? '',
    iconOf: (id) => byId.get(id)?.icon ?? '',
    databaseOf: (hostId) => byId.get(hostId)?.database,
    scheme: safeScheme(scheme),
  };

  const sections = bundle.pages
    .map((page, i) => {
      ctx.anchorPrefix = `p${i}-`;
      ctx.originPageUrl = page.originUrl ?? formOriginUrl(page.id);
      const blocks = (page.snapshot.editorjs as {blocks?: ExportBlock[]} | undefined)?.blocks ?? [];
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
  // One island carries the WHOLE space bundle (pages + databases + nesting), the
  // `openbook.library.json` structure, so a site export re-imports with structure
  // intact. The visible sections are a render; this is the authoritative source
  // after export-only write capabilities have been removed from every page.
  // LX-2: when the exporter opted in (and could read the books), the island
  // additionally carries the ledger records under their own `ledger` key.
  const islandSpace = {
    ...bundle.space,
    pages: bundle.space.pages.map((page) => ({...page, data: sanitizeSnapshotForExport(page.data)})),
  };
  const island = libraryIslandScript(bundle.rootId, islandSpace, bundle.ledger ? {ledger: bundle.ledger} : {});
  // Hydrate through the viewer (its `#page=` hash nav replaces the legacy
  // router) only when the viewer can faithfully render the WHOLE bundle: every
  // page a block-doc, and no databases anywhere (the viewer has no database
  // roster renderer yet — those bundles keep the legacy router + runtime).
  const hydrate =
    bundle.space.pages.length > 0 &&
    bundle.space.databases.length === 0 &&
    bundle.pages.every((p) => !p.database) &&
    bundle.space.pages.every((p) => hasBlockdoc(p.data));
  return document_(`<main>\n${sections}\n</main>`, rootTitle, ctx, {
    rootId: bundle.rootId,
    island,
    assetsIsland: hydrate ? artifactAssetsIsland(bundle.pages.map((p) => p.snapshot), artifactText) : '',
    hydrate,
  });
}

/** Colour-scheme tail appended after {@link STYLES}, picked per runtime.
 *
 *  Hydrate path: the viewer bundle is LIGHT-ONLY (v1 — end-to-end dark support
 *  is backlog), so the static first paint is forced light too; honouring the
 *  OS dark preference there produced a dark->light snap the moment the viewer
 *  mounted. Legacy/no-hydrate exports (and decks) keep the dual scheme — their
 *  static body IS the final render, and it supports dark fine. */
const SCHEME_LIGHT = `
:root { color-scheme: light; }
`;
const SCHEME_DUAL = `
:root { color-scheme: light dark; }
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
  /* The ledger alarm red (#b91c1c) goes muddy on the dark page — lighten it. */
  .ob-ledger-note.is-alarm { color: #f87171; }
}
`;

const stylesFor = (scheme: DataColorScheme): string => `
* { box-sizing: border-box; }
body { margin: 0; background: #fff; color: #1a1a1a; font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
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
.kit-light-dot { width: 12px; height: 12px; border-radius: 999px; background: ${hexAlpha(DATA_PALETTE[scheme].gray.fill, 0.35)}; box-shadow: inset 0 0 0 1px ${DATA_STROKE}; }
${statusLightCss(scheme)}
.kitprogress { display: flex; flex-direction: column; gap: 6px; }
.kit-prog-head { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; }
.kit-prog-label { font-weight: 600; font-size: .92rem; }
.kit-prog-val { font-variant-numeric: tabular-nums; opacity: .65; font-size: .9em; }
.kit-prog-track { height: 8px; border-radius: 999px; background: rgba(127,127,127,.18); overflow: hidden; }
.kit-prog-fill { height: 100%; border-radius: 999px; background: #6366f1; transition: width .25s ease; }
.slider input[type=range] { vertical-align: middle; width: 60%; }
.expr code { color: #4f46e5; }
/* Long stringified readouts (arrays from live code) must wrap, not blow the
   page to tens of thousands of px wide (which also degrades the PDF slice). */
.reactive code { overflow-wrap: anywhere; }
figure.chart { margin: 1.2em 0; }
figure.chart svg { max-width: 100%; height: auto; }
figure.chart .chart-title { font-weight: 600; font-size: .92rem; margin-bottom: 6px; }
figure.ob-image { margin: 1.2em 0; }
figure.ob-image img { max-width: 100%; height: auto; border-radius: 8px; display: block; }
figure.ob-image figcaption { margin-top: 6px; text-align: center; font-size: .88rem; opacity: .7; }
figure.ob-image .ob-image-alt { padding: 24px; text-align: center; border: 1px dashed rgba(127,127,127,.4); border-radius: 8px; opacity: .6; font-size: .9rem; }
.ob-form { display: grid; gap: 12px; margin: 1.2em 0; padding: 16px; border: 1px solid rgba(127,127,127,.22); border-radius: 10px; break-inside: avoid; page-break-inside: avoid; }
.ob-form-field { display: grid; gap: 5px; font-size: .9rem; font-weight: 600; }
.ob-form-field input:not([type=checkbox]):not([type=range]), .ob-form-field textarea, .ob-form-field select { width: 100%; min-height: 38px; padding: 7px 9px; border: 1px solid rgba(127,127,127,.3); border-radius: 7px; background: rgba(127,127,127,.04); color: inherit; font: inherit; }
.ob-form-field input[type=checkbox] { width: 17px; height: 17px; }
.ob-form-field input[type=range] { width: 60%; }
.ob-form > button { justify-self: start; padding: 7px 16px; border: 1px solid rgba(127,127,127,.3); border-radius: 7px; background: rgba(127,127,127,.12); color: inherit; font: inherit; font-weight: 600; }
.ob-form-empty { margin: 0; opacity: .65; font-size: .9rem; }
.ob-form-live { font-size: .86rem; color: inherit; opacity: .75; }
figure.ob-artifact { margin: 1.2em 0; }
.ob-artifact-placeholder { display: flex; flex-direction: column; gap: 4px; padding: 18px 20px; border: 1px dashed rgba(127,127,127,.4); border-radius: 8px; }
.ob-artifact-label { font-weight: 600; }
.ob-artifact-hint { font-size: .85rem; opacity: .65; }
/* Plugin / unknown block placeholder (LX-1). Same dashed-card language as the
   artifact placeholder above; kept whole across a PDF page break.
   Metrics match the app's .obe-missing-plugin card (Devon F2): a hydrated
   export can show BOTH families on one page — a preserved ledger card next to
   the viewer's install card (LX-5) — and mismatched padding/tint made their
   left text edges disagree by a couple of pixels down the page. Same padding,
   same untinted ground, same 0.8rem body. */
.ob-plugin-block { margin: 1.2em 0; padding: 0.6rem 0.75rem; border: 1px dashed rgba(127,127,127,.4); border-radius: 8px; break-inside: avoid; page-break-inside: avoid; }
.ob-plugin-block > p { margin: 0; font-size: .8rem; line-height: 1.3; }
.ob-plugin-block > p.ob-plugin-block-label { font-weight: 600; }
.ob-plugin-block > p.ob-plugin-block-hint { opacity: .65; margin-top: 2px; }
.ob-plugin-block > p.ob-plugin-block-text { margin-top: 8px; }
/* Ledger report tables (LX-3). Money columns are right-aligned tabular digits;
   totals carry the double-rule emphasis; a report never splits across a PDF
   page (same discipline as the placeholder card above). */
figure.ob-ledger-report { margin: 1.2em 0; break-inside: avoid; page-break-inside: avoid; }
figure.ob-ledger-report > figcaption.ob-ledger-title { font-weight: 700; margin-bottom: 6px; }
.ob-ledger-sub { font-weight: 400; opacity: .7; font-size: .9em; }
.ob-ledger-currency { float: right; font-weight: 400; font-size: .85em; opacity: .75; }
table.ledger-table { border-collapse: collapse; width: 100%; margin: .4em 0; font-size: .92em; font-variant-numeric: tabular-nums; }
/* An oversized register CAN outgrow a page despite the figure's break-inside:
   avoid — when it splits, repeat the header on every page and keep rows (and
   the Totals foot) whole instead of orphaning half a money row. */
table.ledger-table thead { display: table-header-group; }
table.ledger-table tfoot { display: table-footer-group; }
table.ledger-table tr { break-inside: avoid; page-break-inside: avoid; }
table.ledger-table th, table.ledger-table td { border: 1px solid rgba(127,127,127,.3); padding: 5px 10px; text-align: left; vertical-align: top; }
table.ledger-table thead th { background: rgba(127,127,127,.08); font-weight: 600; }
table.ledger-table th.num, table.ledger-table td.num { text-align: right; white-space: nowrap; }
/* An ISO date is one token, not two: the register's narrow date column used to
   break it as "2026-" / "07-09" (Devon F3). */
table.ledger-table th.date, table.ledger-table td.date { white-space: nowrap; }
table.ledger-table tr.ledger-section th { background: rgba(127,127,127,.08); font-weight: 700; }
table.ledger-table tr.ledger-total td { font-weight: 700; border-top: 2px solid rgba(127,127,127,.55); }
table.ledger-table td.ledger-empty { opacity: .6; font-style: italic; }
.ledger-reversed { opacity: .6; font-size: .9em; }
.ob-ledger-note { font-size: .85rem; opacity: .8; margin: 4px 0 0; }
.ob-ledger-note.is-alarm { color: #b91c1c; font-weight: 600; opacity: 1; }
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

// Inlined live runtime: safely interprets expressions from slider values and
// redraws charts. Reuses the saved \`__C__{cellId}__\` reference tokens. The
// interpreter accepts literals, arithmetic/comparison/logical/ternary operators,
// arrays/plain objects, safe member reads, Math.*, allowlisted array/string
// helpers, and the bounded local statement shell used by bundled pages;
// unsupported sources retain their last export-time value. Observable Plot
// (and d3) are inlined as classic scripts above, so this works offline. The kit
// palette prepended by `kitChartRuntime(scheme)` bakes the active scheme (OB-379)
// so a redrawn kit chart keeps the exporting user's colours — and the kind-less
// (Plot) chart below sets `color.range` to that same `KIT_PALETTE`, so it paints
// the canonical data palette rather than Plot's default categorical scheme (OB-380).
const RUNTIME_REST = `
const Plot = (typeof window !== "undefined" && window.Plot) || null;
const D = JSON.parse(document.getElementById("ob-data").textContent);
const store = new Map(Object.entries(D.values));
const get = (id) => store.get(id);
const fmt = (v) => v === undefined ? "—" : typeof v === "number" ? (Number.isInteger(v) ? ""+v : ""+(Math.round(v*1000)/1000)) : Array.isArray(v) ? "["+v.slice(0,8).join(", ")+(v.length>8?", …":"")+"]" : JSON.stringify(v);
function normalize(v,name){ if(Array.isArray(v)&&v.every(n=>typeof n==="number")) return [{name,data:v}]; if(v&&Array.isArray(v.series)) return v.series.map(s=>({name:String(s.name),data:(s.data||[]).filter(n=>typeof n==="number")})); return []; }

function statusOf(v, okAt, warnAt){ if(v===undefined||v===null) return "off"; if(typeof v==="boolean") return v?"ok":"bad"; if(typeof v==="string") return (v==="ok"||v==="warn"||v==="bad")?v:"off"; if(typeof v==="number"){ if(v>=okAt) return "ok"; if(v>=warnAt) return "warn"; return "bad"; } return "off"; }
function progressOf(v, max, format){ const raw = typeof v==="boolean"?(v?max:0):Number(v==null?0:v); const fr = isFinite(raw)?Math.max(0,Math.min(1, max===0?0:raw/max)):0; const pct=Math.round(fr*100); const trim=(n)=>Number.isInteger(n)?(""+n):(""+(Math.round(n*100)/100)); return {pct:pct, readout: format==="fraction"?(trim(raw)+" / "+trim(max)):(pct+"%")}; }
function recompute(){
  for (const e of D.exprs){ const result=readSafeExpression(e.source,get); if(result.ok) store.set(e.cell,result.value); }
  for (const e of D.exprs){ const el=document.querySelector('[data-cell="'+e.cell+'"] [data-val]'); if(el) el.textContent = fmt(get(e.cell)); }
  for (const l of (D.lights||[])){ const el=document.querySelector('[data-light="'+l.cell+'"]'); if(el){ const v=get(l.cell); el.setAttribute("data-status", statusOf(v, l.okAt, l.warnAt)); const val=el.querySelector("[data-val]"); if(val) val.textContent = fmt(v); } }
  for (const p of (D.progress||[])){ const el=document.querySelector('[data-progress="'+p.cell+'"]'); if(el){ const r=progressOf(get(p.cell), p.max, p.format); const fill=el.querySelector("[data-fill]"); if(fill) fill.style.width = r.pct+"%"; const val=el.querySelector("[data-val]"); if(val) val.textContent = r.readout; } }
  for (const c of D.charts){
    const fig = document.querySelector('[data-chart="'+c.id+'"]'); if(!fig) continue;
    if (c.kind){ fig.innerHTML = drawKit(get(c.cells[0]), c.kind, c.labels||[], KIT_PALETTE); continue; }
    const series=[]; for(const cell of c.cells) series.push(...normalize(get(cell), cell));
    const long=[]; series.forEach(s=>s.data.forEach((y,i)=>long.push({i,y,series:s.name})));
    fig.innerHTML="";
    if(Plot && long.length) fig.appendChild(Plot.plot({marks:[Plot.lineY(long,{x:"i",y:"y",stroke:"series"})],width:660,height:330,marginLeft:44,grid:true,style:{background:"transparent",color:"currentColor",fontSize:"12px"},color:{range:KIT_PALETTE,legend:series.length>1}}));
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

/** The full live runtime for a scheme: the kit palette (scheme-baked) + drawing
 *  source + the slider/expr/chart re-computation loop. */
const runtimeFor = (scheme: DataColorScheme): string => kitChartRuntime(scheme) + SAFE_EXPRESSION_JS + RUNTIME_REST;

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
