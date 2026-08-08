import {isSafeHref} from '@book.dev/sdk';
import type {BlockJSON, BlockType, CellRangeExportCell, InlineAttrs, TextRun} from './model';
import {CONTAINER_BLOCKS, decodeSnapshot, TABLE_COLBG_PREFIX, TEXT_BLOCKS} from './model';
import {describeUnknownBlock} from './unknownBlock';
import {COLOR_EXPORT_HEX} from './colors';
import {resolveOptionsFromProps, varNameFromLabel} from './kit/options';
import {computeExportCells, type ExportCell} from './kit/scope';
import type {DbChartSeriesMap} from './kit/chartData';

// TextRun is referenced in the kit emit cases below.

/**
 * Exporters over the JSON projection of a block document. Markdown for
 * portability; HTML for the standalone/interactive export (the obe-* class
 * names match the editor stylesheet, so exported pages can ship the same
 * minimalist look by inlining that CSS).
 */

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function runToHtml(run: TextRun): string {
  let out = escapeHtml(run.t).replace(/\n/g, '<br>');
  const a: InlineAttrs = run.a ?? {};
  if (a.c) out = `<code>${out}</code>`;
  if (a.b) out = `<strong>${out}</strong>`;
  if (a.i) out = `<em>${out}</em>`;
  if (a.u) out = `<u>${out}</u>`;
  if (a.s) out = `<s>${out}</s>`;
  if (a.hl) out = `<mark${COLOR_EXPORT_HEX[a.hl] ? ` style="background:${COLOR_EXPORT_HEX[a.hl].hl}"` : ''}>${out}</mark>`;
  if (a.tc && COLOR_EXPORT_HEX[a.tc]) out = `<span style="color:${COLOR_EXPORT_HEX[a.tc].fg}">${out}</span>`;
  if (a.m) out = `<a class="ob-mention" data-page-id="${escapeHtml(a.m)}">${out}</a>`;
  // Scheme-gate the href (esc doesn't touch the scheme) — a rejected link
  // (javascript:/data:/…) degrades to inert text. See sdk isSafeHref.
  else if (a.a && isSafeHref(a.a)) out = `<a href="${escapeHtml(a.a)}">${out}</a>`;
  return out;
}

const textHtml = (runs: TextRun[] | undefined): string => (runs ?? []).map(runToHtml).join('');

// ── Cell-range clipboard (TBL-5) ─────────────────────────────────────────────
// A copied multi-cell selection is a rectangular grid of rich-text runs
// (`grid[r][c]` = a cell's runs). TSV feeds text/plain consumers (spreadsheets,
// editors); the HTML <table> round-trips through the paste importer
// (normalizeTableGrid → tableFromRuns) back into a fresh table block.

/** A cell RANGE as tab/newline-separated plain text (text/plain flavour). Tabs
 *  and newlines inside a cell collapse to a space so the row/column grid stays
 *  unambiguous. */
export function cellRangeToTsv(grid: TextRun[][][]): string {
  return grid
    .map((row) => row.map((cell) => cell.map((r) => r.t).join('').replace(/[\t\n]+/g, ' ')).join('\t'))
    .join('\n');
}

/** A cell RANGE as an HTML `<table>` (text/html flavour) — pasting it into an
 *  OpenBook page recreates a table with the same grid (acceptance #3). */
export function cellRangeToHtml(grid: TextRun[][][]): string {
  const body = grid
    .map((row) => `<tr>${row.map((cell) => `<td>${textHtml(cell)}</td>`).join('')}</tr>`)
    .join('');
  return `<table class="obe-x-table"><tbody>${body}</tbody></table>`;
}

/** Span-aware cell-range HTML. Covered slots emit nothing; anchors carry the
 *  native attributes that {@link htmlToBlocks} imports back to null gaps. */
export function cellRangeExportToHtml(grid: CellRangeExportCell[][]): string {
  const body = grid
    .map((row) =>
      `<tr>${row
        .flatMap((cell) =>
          cell.kind === 'covered'
            ? []
            : [`<td${cell.colspan > 1 ? ` colspan="${cell.colspan}"` : ''}${cell.rowspan > 1 ? ` rowspan="${cell.rowspan}"` : ''}>${textHtml(cell.runs)}</td>`],
        )
        .join('')}</tr>`,
    )
    .join('');
  return `<table class="obe-x-table"><tbody>${body}</tbody></table>`;
}

type Props = Record<string, unknown> | undefined;
const strProp = (p: Props, k: string): string | null => (typeof p?.[k] === 'string' && (p[k] as string) ? (p[k] as string) : null);

/**
 * The composited tint token for a table cell in an export projection (TBL-4 +
 * TBL-6): the CELL colour (`cell.props.bg`) wins over the ROW colour
 * (`row.props.bg`), which wins over the COLUMN colour
 * (`table.props['colbg:<colId>']`, keyed on the cell's `col` binding), matching
 * the editor's {@link tableCellColor} precedence. Returns the palette token, or
 * null. Column lookup is by colId so it is order-independent.
 */
function tableCellTint(tableProps: Props, rowProps: Props, cellProps: Props): string | null {
  const cellBg = strProp(cellProps, 'bg');
  if (cellBg) return cellBg;
  const rowBg = strProp(rowProps, 'bg');
  if (rowBg) return rowBg;
  const colId = strProp(cellProps, 'col');
  return colId ? strProp(tableProps, TABLE_COLBG_PREFIX + colId) : null;
}

/** An inline `style="background:…"` for a cell tint token, or '' (for the
 *  self-contained HTML/PDF exports that can't use the theme CSS classes). */
const tintStyle = (token: string | null): string =>
  token && COLOR_EXPORT_HEX[token] ? ` style="background:${COLOR_EXPORT_HEX[token].hl}"` : '';

/** Canonical HTML span attributes from a projected cell (absent means one). */
const tableCellSpanAttrs = (props: Props): string => {
  const span = (key: 'colspan' | 'rowspan'): number => {
    const raw = props?.[key];
    return typeof raw === 'number' && Number.isFinite(raw) && raw >= 2 ? Math.min(512, Math.floor(raw)) : 1;
  };
  const colspan = span('colspan');
  const rowspan = span('rowspan');
  return `${colspan > 1 ? ` colspan="${colspan}"` : ''}${rowspan > 1 ? ` rowspan="${rowspan}"` : ''}`;
};

/** The current value of a June-2026 kit input rendered as HTML (selection text
 *  for the choosers, escaped/markup text for long/rich text). */
function kitInputText(b: BlockJSON): string {
  const p = b.props ?? {};
  if (b.type === 'richtext') return Array.isArray(p.runs) ? textHtml(p.runs as TextRun[]) : '';
  if (b.type === 'longtext') return textHtml([{t: String(p.value ?? '')}]);
  // Choosers: map the selected value(s) to their option labels.
  const opts = resolveOptionsFromProps(p);
  const labelFor = (v: string): string => opts.find((o) => o.value === v)?.label ?? v;
  const val = b.type === 'tagfield' || p.multi ? (Array.isArray(p.selected) ? p.selected : []) : (p.value ?? null);
  const shown = Array.isArray(val) ? (val as string[]).map(labelFor).join(', ') : val ? labelFor(String(val)) : '—';
  return textHtml([{t: shown}]);
}

function runToMd(run: TextRun): string {
  let out = run.t;
  const a: InlineAttrs = run.a ?? {};
  if (a.c) out = `\`${out}\``;
  if (a.b) out = `**${out}**`;
  if (a.i) out = `*${out}*`;
  if (a.s) out = `~~${out}~~`;
  if (a.a) out = `[${out}](${a.a})`;
  return out;
}

const textMd = (runs: TextRun[] | undefined): string => (runs ?? []).map(runToMd).join('');

const escapeMd = (s: string): string => s.replace(/([\\`*_[\]<>])/g, '\\$1');

/**
 * Whether a block type that fell through the export projection's switch is a
 * CORE type carrying nothing but text — a bare `paragraph` (which has no case
 * of its own), or a container child (`cell`, `tab`, …) orphaned from its parent.
 * Those keep the plain-text projection; every OTHER unhandled type is
 * plugin-contributed or from a newer version and must keep its identity so the
 * renderers can label it instead of silently flattening it (LX-1).
 */
const isCoreTextType = (type: string): boolean =>
  TEXT_BLOCKS.has(type as BlockType) || CONTAINER_BLOCKS.has(type as BlockType);

/** The current value of a June-2026 kit input rendered as Markdown. */
function kitInputMd(b: BlockJSON): string {
  const p = b.props ?? {};
  if (b.type === 'richtext') return Array.isArray(p.runs) ? textMd(p.runs as TextRun[]) : '';
  if (b.type === 'longtext') return String(p.value ?? '');
  const opts = resolveOptionsFromProps(p);
  const labelFor = (v: string): string => opts.find((o) => o.value === v)?.label ?? v;
  const val = b.type === 'tagfield' || p.multi ? (Array.isArray(p.selected) ? p.selected : []) : (p.value ?? null);
  return Array.isArray(val) ? (val as string[]).map(labelFor).join(', ') : val ? labelFor(String(val)) : '—';
}

/** Render block JSON to clean semantic HTML (one string, no wrapper). */
export function blocksToHtml(blocks: BlockJSON[]): string {
  const parts: string[] = [];
  let i = 0;
  while (i < blocks.length) {
    const b = blocks[i];
    switch (b.type) {
    case 'heading': {
      const level = Math.min(6, Math.max(1, Number(b.props?.level ?? 2)));
      parts.push(`<h${level}>${textHtml(b.text)}</h${level}>`);
      i += 1;
      break;
    }
    case 'list': {
      // Consecutive list items of the same kind join into one list element.
      const kind = (b.props?.kind as string) ?? 'bullet';
      const tag = kind === 'number' ? 'ol' : 'ul';
      const items: string[] = [];
      while (i < blocks.length && blocks[i].type === 'list' && ((blocks[i].props?.kind as string) ?? 'bullet') === kind) {
        items.push(`<li>${textHtml(blocks[i].text)}</li>`);
        i += 1;
      }
      parts.push(`<${tag}>${items.join('')}</${tag}>`);
      break;
    }
    case 'todo': {
      const checked = Boolean(b.props?.checked);
      parts.push(
        `<div class="obe-x-todo"><input type="checkbox" disabled${checked ? ' checked' : ''}> ${textHtml(b.text)}</div>`,
      );
      i += 1;
      break;
    }
    case 'quote':
      parts.push(`<blockquote>${textHtml(b.text)}</blockquote>`);
      i += 1;
      break;
    case 'callout':
      parts.push(`<aside class="obe-x-callout obe-x-${(b.props?.variant as string) ?? 'info'}">${textHtml(b.text)}</aside>`);
      i += 1;
      break;
    case 'code':
      parts.push(`<pre><code>${escapeHtml((b.text ?? []).map((r) => r.t).join(''))}</code></pre>`);
      i += 1;
      break;
    case 'notes': // speaker-only — never exported
      i += 1;
      break;
    case 'divider':
      parts.push('<hr>');
      i += 1;
      break;
    case 'image': {
      // Clipboard/standalone HTML: no asset store here, so render a legacy `src`
      // (data-URL / remote URL) directly and otherwise degrade to the alt text.
      const p = b.props ?? {};
      const src = typeof p.src === 'string' ? p.src : '';
      const alt = escapeHtml(String(p.alt ?? ''));
      const width = typeof p.width === 'string' && p.width ? ` style="width:${escapeHtml(p.width)}"` : '';
      const cap = String(p.caption ?? '').trim();
      const figcap = cap ? `<figcaption>${escapeHtml(cap)}</figcaption>` : '';
      parts.push(
        src
          ? `<figure class="obe-x-image"><img src="${escapeHtml(src)}" alt="${alt}"${width}>${figcap}</figure>`
          : `<figure class="obe-x-image"><span class="obe-x-image-alt">${alt || 'Image'}</span>${figcap}</figure>`,
      );
      i += 1;
      break;
    }
    case 'htmlArtifact': {
      // Captioned placeholder for now — embedding the live sandboxed document
      // (resolved bytes + the srcdoc/sandbox contract from lib/srcdoc.ts) is a
      // separate downstream export task.
      const artifactTitle = String(b.props?.title ?? '').trim();
      parts.push(
        `<figure class="obe-x-artifact"><span class="obe-x-artifact-label">${escapeHtml(artifactTitle) || 'HTML artifact'}</span><figcaption>Interactive HTML artifact — open in OpenBook to use it.</figcaption></figure>`,
      );
      i += 1;
      break;
    }
    case 'columns': {
      const cols = b.children ?? [];
      const colHtml = cols
        .map((col) => `<div style="flex:1;min-width:0">${blocksToHtml(col.children ?? [])}</div>`)
        .join('');
      parts.push(`<div style="display:flex;gap:1.25rem" class="obe-x-columns">${colHtml}</div>`);
      i += 1;
      break;
    }
    case 'table': {
      const rows = b.children ?? [];
      const header = Boolean(b.props?.header);
      const body = rows
        .map((row, r) => {
          const tag = header && r === 0 ? 'th' : 'td';
          // TBL-4/TBL-6: carry cell/row/column tints as inline styles into the
          // clipboard HTML.
          const cells = (row.children ?? [])
            .map(
              (cell) =>
                `<${tag}${tableCellSpanAttrs(cell.props)}${tintStyle(tableCellTint(b.props, row.props, cell.props))}>${textHtml(cell.text)}</${tag}>`,
            )
            .join('');
          return `<tr>${cells}</tr>`;
        })
        .join('');
      parts.push(`<table class="obe-x-table"><tbody>${body}</tbody></table>`);
      i += 1;
      break;
    }
    case 'dbview':
      // No live table in static HTML — export a link to the database page.
      parts.push(
        `<p><a class="ob-mention" data-page-id="${escapeHtml(String(b.props?.pageId ?? ''))}">🗃 ${escapeHtml(String(b.props?.name ?? 'Database'))}</a></p>`,
      );
      i += 1;
      break;
    case 'group': {
      const name = String(b.props?.name ?? '').trim();
      const heading = name ? `<p class="obe-x-group-name"><strong>${escapeHtml(name)}</strong></p>` : '';
      parts.push(`<section class="obe-x-group">${heading}${blocksToHtml(b.children ?? [])}</section>`);
      i += 1;
      break;
    }
    case 'tabs':
    case 'accordion': {
      // Each tab/section becomes a titled block (the static export has no
      // interactive tab/accordion widget).
      const sections = (b.children ?? [])
        .map((s) => {
          const label = String(s.props?.label ?? '').trim();
          const head = label ? `<h3>${escapeHtml(label)}</h3>` : '';
          return `<section class="obe-x-section">${head}${blocksToHtml(s.children ?? [])}</section>`;
        })
        .join('');
      parts.push(`<section class="obe-x-${b.type}">${sections}</section>`);
      i += 1;
      break;
    }
    case 'choicecards':
    case 'searchselect':
    case 'tagfield':
    case 'longtext':
    case 'richtext': {
      const label = String(b.props?.label ?? b.props?.name ?? '').trim();
      const head = label ? `<strong>${escapeHtml(label)}:</strong> ` : '';
      const body = kitInputText(b);
      parts.push(`<p class="obe-x-kitvalue">${head}${body}</p>`);
      i += 1;
      break;
    }
    default: {
      // Only PLUGIN-shaped types get the placeholder card here. Core kit blocks
      // (slider, kitchart, …) have no case in this exporter either, and calling
      // them “unsupported” in a paste would be a lie — they keep their
      // historical plain-text output.
      const {pluginId, label, hint} = describeUnknownBlock(b.type);
      if (pluginId === null) {
        parts.push(`<p>${textHtml(b.text) || '&nbsp;'}</p>`);
        i += 1;
        break;
      }
      const body = textHtml(b.text);
      parts.push(
        `<div class="obe-x-plugin" data-block-type="${escapeHtml(b.type)}">` +
          `<p class="obe-x-plugin-label"><strong>${escapeHtml(label)}</strong></p>` +
          `<p class="obe-x-plugin-hint">${escapeHtml(hint)}</p>` +
          (body ? `<p class="obe-x-plugin-text">${body}</p>` : '') +
          '</div>',
      );
      i += 1;
    }
    }
  }
  return parts.join('\n');
}

/** Render block JSON to GitHub-flavoured Markdown. */
export function blocksToMarkdown(blocks: BlockJSON[]): string {
  const out: string[] = [];
  let n = 0; // numbered-list counter (resets when the run breaks)
  for (const b of blocks) {
    if (b.type !== 'list' || (b.props?.kind as string) !== 'number') n = 0;
    switch (b.type) {
    case 'heading':
      out.push(`${'#'.repeat(Math.min(6, Math.max(1, Number(b.props?.level ?? 2))))} ${textMd(b.text)}`);
      break;
    case 'list':
      if ((b.props?.kind as string) === 'number') {
        n += 1;
        out.push(`${n}. ${textMd(b.text)}`);
      } else {
        out.push(`- ${textMd(b.text)}`);
      }
      break;
    case 'todo':
      out.push(`- [${b.props?.checked ? 'x' : ' '}] ${textMd(b.text)}`);
      break;
    case 'quote':
      out.push(`> ${textMd(b.text)}`);
      break;
    case 'callout':
      out.push(`> **${((b.props?.variant as string) ?? 'note').toUpperCase()}:** ${textMd(b.text)}`);
      break;
    case 'code':
      out.push(`\`\`\`${(b.props?.language as string) ?? ''}\n${(b.text ?? []).map((r) => r.t).join('')}\n\`\`\``);
      break;
    case 'notes': // speaker-only — never exported
      break;
    case 'divider':
      out.push('---');
      break;
    case 'image': {
      // Data-URIs aren't available in the clipboard/standalone path (no asset
      // store); render a legacy `src` and otherwise degrade to italicised alt.
      const p = b.props ?? {};
      const src = typeof p.src === 'string' ? p.src : '';
      const alt = String(p.alt ?? '').replace(/[[\]]/g, '');
      const cap = String(p.caption ?? '').trim();
      const body = src ? `![${alt}](${src})` : `_${alt || 'Image'}_`;
      out.push(cap ? `${body}\n\n*${cap}*` : body);
      break;
    }
    case 'htmlArtifact': {
      // A callout line — Markdown has no sandboxed-iframe equivalent.
      const artifactTitle = String(b.props?.title ?? '').trim();
      out.push(`> **HTML artifact:** ${artifactTitle || 'Untitled'} *(interactive — open in OpenBook)*`);
      break;
    }
    case 'columns':
      for (const col of b.children ?? []) out.push(blocksToMarkdown(col.children ?? []));
      break;
    case 'table': {
      const rows = (b.children ?? []).map((row) => (row.children ?? []).map((cell) => textMd(cell.text).replace(/\|/g, '\\|')));
      if (rows.length > 0) {
        const width = Math.max(...rows.map((r) => r.length));
        const pad = (r: string[]): string[] => [...r, ...Array.from({length: width - r.length}, () => '')];
        const lines = [
          `| ${pad(rows[0]).join(' | ')} |`,
          `| ${Array.from({length: width}, () => '---').join(' | ')} |`,
          ...rows.slice(1).map((r) => `| ${pad(r).join(' | ')} |`),
        ];
        out.push(lines.join('\n'));
      }
      break;
    }
    case 'dbview':
      out.push(`**🗃 ${String(b.props?.name ?? 'Database')}**`);
      break;
    case 'group': {
      const name = String(b.props?.name ?? '').trim();
      if (name) out.push(`**${name}**`);
      out.push(blocksToMarkdown(b.children ?? []));
      break;
    }
    case 'tabs':
    case 'accordion':
      for (const section of b.children ?? []) {
        const label = String(section.props?.label ?? '').trim();
        if (label) out.push(`### ${label}`);
        out.push(blocksToMarkdown(section.children ?? []));
      }
      break;
    case 'choicecards':
    case 'searchselect':
    case 'tagfield':
    case 'longtext':
    case 'richtext': {
      const label = String(b.props?.label ?? b.props?.name ?? '').trim();
      const body = kitInputMd(b);
      out.push(label ? `**${label}:** ${body}` : body);
      break;
    }
    default: {
      // Plugin-shaped types only — see the note in `blocksToHtml`.
      const {pluginId, label, hint} = describeUnknownBlock(b.type);
      if (pluginId === null) {
        out.push(textMd(b.text));
        break;
      }
      const body = textMd(b.text);
      // Mirror of toMarkdown's unknown-block emitter — keep the two identical.
      // `hint` (plugin name / verbatim type) is untrusted; escape it.
      out.push(`> **${escapeMd(label)}**\n>\n> ${escapeMd(hint)}${body ? `\n>\n> ${body}` : ''}`);
    }
    }
  }
  return out.join('\n\n');
}

// ── Export projection (the bridge into the app's export pipeline) ────────────

/**
 * The block-native intermediate representation every exporter consumes: a flat
 * `{blocks}` list plus the reactive `values`/`names` indices. Persisted on the
 * page snapshot under the back-compat storage key `editorjs` (see
 * `projectSnapshotForExport`); in memory it is always this `ExportDoc` shape.
 */
interface ExportDoc {
  blocks: Array<{id?: string; type: string; data: Record<string, unknown>}>;
  values: Array<[string, unknown]>;
  names: Array<[string, string]>;
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Project a block document into the export-projection shape the export pipeline
 * (markdown / PDF / the interactive HTML site) consumes — so block pages get
 * every exporter, including the live reactive runtime, without a second
 * pipeline. Sliders/formulas become reactive blocks keyed by their block id
 * (formula sources have slider names re-tokenized to `__C__{id}__`, the
 * format the export runtime evaluates); columns flatten in reading order.
 */
/** Kit input types and the value they publish (mirrors kit/scope.ts). */
const KIT_INPUT_VALUE: Record<string, (props: Record<string, unknown>) => unknown> = {
  slider: (p) => Number(p.value ?? 50),
  number: (p) => Number(p.value ?? 0),
  textfield: (p) => String(p.value ?? ''),
  radio: (p) => p.value ?? null,
  dropdown: (p) => p.value ?? null,
  checklist: (p) => (Array.isArray(p.selected) ? p.selected : []),
  toggle: (p) => Boolean(p.value ?? false),
  location: (p) => ({lat: p.lat ?? null, lng: p.lng ?? null, label: p.labeltext ?? ''}),
  // June-2026 inputs. Choice cards / search-select publish a scalar (single) or
  // string[] (multi); the tag field is always string[]; long text a string;
  // rich text its plain-text projection (the markup lives in `runs`).
  choicecards: (p) => (p.multi ? (Array.isArray(p.selected) ? p.selected : []) : (p.value ?? null)),
  searchselect: (p) => (p.multi ? (Array.isArray(p.selected) ? p.selected : []) : (p.value ?? null)),
  tagfield: (p) => (Array.isArray(p.selected) ? p.selected : []),
  longtext: (p) => String(p.value ?? ''),
  richtext: (p) => (Array.isArray(p.runs) ? (p.runs as Array<{t?: string}>).map((r) => r?.t ?? '').join('') : ''),
};

export function projectBlocksForExport(blocks: BlockJSON[], computed?: Map<string, ExportCell>, dbSeries?: DbChartSeriesMap): ExportDoc {
  const out: ExportDoc = {blocks: [], values: [], names: []};
  // Seed a reactive cell's CURRENT value (resolved by the editor's evaluator) so
  // static exports show the same numbers/series/states as the live window. Only
  // when a value was actually computed — never a spurious `undefined` entry.
  const pushCell = (id: string): void => {
    if (computed?.has(id)) out.values.push([id, computed.get(id)!.value]);
  };

  // First pass: every named input AND named live-code output → block id (for
  // expression re-tokenizing; the export runtime evaluates exprs in document
  // order, so chained references resolve there exactly as in the editor).
  const inputs: Array<{id: string; name: string}> = [];
  const propsById = new Map<string, Record<string, unknown>>();
  // Mirror the editor's scope exactly (kit/scope.ts): an INPUT inside a named
  // `group` is addressable as `<group>.<field>.value` (inputScope namespaces it);
  // a top-level input as the bare `<field>`. Live code / formulas publish their
  // bare name regardless of nesting (computeScope does NOT namespace them). `group`
  // tracks the nearest enclosing group's key (`varNameFromLabel` of its name).
  const collect = (list: BlockJSON[], group: string): void => {
    for (const b of list) {
      if (KIT_INPUT_VALUE[b.type] && b.props?.name) {
        const field = String(b.props.name);
        inputs.push({id: b.id, name: group ? `${group}.${field}.value` : field});
        propsById.set(b.id, b.props ?? {});
      }
      if (b.type === 'code' && b.props?.live && b.props?.name) inputs.push({id: b.id, name: String(b.props.name)});
      // Formula blocks publish a named value too (computeScope treats them the
      // same as live code) — so a formula referencing another formula/input must
      // be tokenizable, or its dependents resolve to `undefined` in the runtime.
      if (b.type === 'formula' && b.props?.name) inputs.push({id: b.id, name: String(b.props.name)});
      if (b.children) collect(b.children, b.type === 'group' ? varNameFromLabel(String(b.props?.name ?? '')) || group : group);
    }
  };
  collect(blocks, '');
  inputs.sort((a, b) => b.name.length - a.name.length); // longest names first

  const tokenize = (source: string): string => {
    let s = source;
    for (const {id, name} of inputs) {
      s = s.replace(new RegExp(`\\b${escapeRe(name)}\\b`, 'g'), `__C__{${id}}__`);
    }
    return s;
  };

  /** Publish an input's value/name so tokenized expressions read it live. */
  const publish = (b: BlockJSON): void => {
    const read = KIT_INPUT_VALUE[b.type];
    if (!read) return;
    out.values.push([b.id, read(b.props ?? {})]);
    if (b.props?.name) out.names.push([String(b.props.name), b.id]);
  };

  const emit = (list: BlockJSON[], sink: ExportDoc['blocks'] = out.blocks): void => {
    let i = 0;
    while (i < list.length) {
      const b = list[i];
      switch (b.type) {
      case 'heading':
        sink.push({id: b.id, type: 'header', data: {text: textHtml(b.text), level: Number(b.props?.level ?? 2)}});
        i += 1;
        break;
      case 'list': {
        const kind = (b.props?.kind as string) ?? 'bullet';
        const items: string[] = [];
        while (i < list.length && list[i].type === 'list' && ((list[i].props?.kind as string) ?? 'bullet') === kind) {
          items.push(textHtml(list[i].text));
          i += 1;
        }
        sink.push({type: 'list', data: {style: kind === 'number' ? 'ordered' : 'unordered', items}});
        break;
      }
      case 'todo': {
        const items: Array<{text: string; checked: boolean}> = [];
        while (i < list.length && list[i].type === 'todo') {
          items.push({text: textHtml(list[i].text), checked: Boolean(list[i].props?.checked)});
          i += 1;
        }
        sink.push({type: 'checklist', data: {items}});
        break;
      }
      case 'quote':
        sink.push({id: b.id, type: 'quote', data: {text: textHtml(b.text)}});
        i += 1;
        break;
      case 'callout':
        sink.push({id: b.id, type: 'callout', data: {variant: (b.props?.variant as string) ?? 'info', text: textHtml(b.text)}});
        i += 1;
        break;
      case 'code': {
        const codeText = (b.text ?? []).map((r) => r.t).join('');
        if (b.props?.live) {
          // Live code exports as a computed cell — named, so later expressions
          // (and charts) keep referencing it in the standalone HTML. Seed its
          // resolved value so the static export (and pre-hydration HTML) reads
          // the same result the editor shows.
          sink.push({id: b.id, type: 'expr', data: {name: String(b.props?.name ?? ''), source: tokenize(codeText)}});
          pushCell(b.id);
          if (b.props?.name) out.names.push([String(b.props.name), b.id]);
        } else {
          sink.push({id: b.id, type: 'code', data: {code: codeText, language: b.props?.language}});
        }
        i += 1;
        break;
      }
      case 'notes': // speaker-only — never exported
        i += 1;
        break;
      case 'divider':
        sink.push({id: b.id, type: 'divider', data: {style: 'line'}});
        i += 1;
        break;
      case 'table': {
        const rows = b.children ?? [];
        const content = rows.map((row) => (row.children ?? []).map((cell) => textHtml(cell.text)));
        // TBL-4/TBL-6: parallel per-cell tint tokens (cell-over-row-over-column)
        // so the static HTML/PDF exporter can paint them with COLOR_EXPORT_HEX.
        const cellColors = rows.map((row) => (row.children ?? []).map((cell) => tableCellTint(b.props, row.props, cell.props)));
        const cellSpans = rows.map((row) =>
          (row.children ?? []).map((cell) => ({
            colspan: typeof cell.props?.colspan === 'number' ? cell.props.colspan : 1,
            rowspan: typeof cell.props?.rowspan === 'number' ? cell.props.rowspan : 1,
          })),
        );
        sink.push({id: b.id, type: 'table', data: {withHeadings: Boolean(b.props?.header), content, cellColors, cellSpans}});
        i += 1;
        break;
      }
      case 'image': {
        // Carry the picture's resolution keys through to the exporters; the bytes
        // behind an `assetId` are resolved to a data-URI up front (exportAssets).
        const p = b.props ?? {};
        sink.push({
          id: b.id,
          type: 'image',
          data: {
            assetId: typeof p.assetId === 'string' ? p.assetId : undefined,
            src: typeof p.src === 'string' ? p.src : undefined,
            alt: String(p.alt ?? ''),
            caption: String(p.caption ?? ''),
            width: typeof p.width === 'string' ? p.width : undefined,
          },
        });
        i += 1;
        break;
      }
      case 'htmlArtifact': {
        // Carry the artifact's keys through the projection so the export asset
        // pre-pass (exportAssets.collectAssetIds) sees its assetId. Honest
        // status of the renderers over this projection: only the CLIPBOARD
        // arms in this file (blocksToHtml / blocksToMarkdown) emit a captioned
        // placeholder — the real export pipeline (export/documentModel.ts →
        // toHtml/toPdf/toMarkdown) maps 'htmlArtifact' to its `unknown` block —
        // Markdown emits a bare "(htmlArtifact block)" note; HTML/PDF render
        // nothing. Accepted scope: full sandboxed embedding (and a proper
        // placeholder there) is the downstream export task.
        const p = b.props ?? {};
        sink.push({
          id: b.id,
          type: 'htmlArtifact',
          data: {
            assetId: typeof p.assetId === 'string' ? p.assetId : undefined,
            title: String(p.title ?? ''),
            height: typeof p.height === 'number' ? p.height : undefined,
          },
        });
        i += 1;
        break;
      }
      case 'columns': {
        // Keep columns as a nested block so the HTML export lays them
        // side-by-side (PDF/Markdown flatten them later). Inner reactive blocks
        // still publish via emit, so charts/formulas stay live wherever they sit.
        const columns = (b.children ?? []).map((col) => {
          const sub: ExportDoc['blocks'] = [];
          emit(col.children ?? [], sub);
          return sub;
        });
        sink.push({id: b.id, type: 'columns', data: {columns}});
        i += 1;
        break;
      }
      case 'tabs':
      case 'accordion':
        // No tab/accordion widget in the standalone runtime — flatten each
        // tab/section's blocks in reading order (a labelled heading per
        // section keeps them legible). Inputs inside still publish/stay live.
        for (const section of b.children ?? []) {
          const heading = String(section.props?.label ?? '').trim();
          if (heading) sink.push({type: 'header', data: {text: textHtml([{t: heading}]), level: 3}});
          emit(section.children ?? [], sink);
        }
        i += 1;
        break;
      case 'group':
        // A group is a container (lock / cross-page sync in the editor); the
        // standalone runtime has no frame widget, so flatten its children inline.
        // Without this the group fell through to `default` and ALL its reactive
        // content (inputs, code, charts) was silently dropped from the export.
        emit(b.children ?? [], sink);
        i += 1;
        break;
      case 'slider': {
        const name = String(b.props?.name ?? 'x');
        const value = Number(b.props?.value ?? 50);
        sink.push({
          id: b.id,
          type: 'slider',
          data: {name, min: Number(b.props?.min ?? 0), max: Number(b.props?.max ?? 100), step: 1, initial: value},
        });
        publish(b);
        i += 1;
        break;
      }
      case 'number': {
        // Steppers stay interactive in the export as range inputs.
        const name = String(b.props?.name ?? 'n');
        const value = Number(b.props?.value ?? 0);
        const min = Number(b.props?.min ?? Math.min(0, value));
        const max = Number(b.props?.max ?? Math.max(100, value * 2 || 10));
        sink.push({id: b.id, type: 'slider', data: {name, min, max, step: Number(b.props?.step ?? 1), initial: value}});
        publish(b);
        i += 1;
        break;
      }
      case 'formula': {
        const name = String(b.props?.name ?? '');
        sink.push({id: b.id, type: 'expr', data: {name, source: tokenize(String(b.props?.source ?? ''))}});
        pushCell(b.id);
        // Publish the name so the runtime maps cell→name (and downstream
        // tokenized refs to this formula resolve live), matching computeScope.
        if (name) out.names.push([name, b.id]);
        i += 1;
        break;
      }
      case 'statuslight': {
        // A computed cell drives a real light (dot + label) in the export. The
        // expr is hidden (the light IS the readout); the light carries the
        // thresholds so the runtime recomputes its 3-state colour live, plus the
        // resolved status for the static (PDF/Markdown) render.
        sink.push({id: b.id, type: 'expr', data: {name: String(b.props?.label ?? 'Status'), source: tokenize(String(b.props?.source ?? '')), hidden: true}});
        pushCell(b.id);
        sink.push({
          id: `${b.id}-light`,
          type: 'kitlight',
          data: {
            refCellId: b.id,
            label: String(b.props?.label ?? 'Status'),
            okAt: Number(b.props?.okAt ?? 1),
            warnAt: Number(b.props?.warnAt ?? 0),
            status: computed?.get(b.id)?.status ?? 'off',
          },
        });
        i += 1;
        break;
      }
      case 'kitchart': {
        // The chart's data expression becomes a HIDDEN computed cell (the chart
        // is the readout — no `title = value` line), and a chart block draws it.
        // Exported charts stay LIVE: moving a slider recomputes the cell and the
        // plot redraws; the seeded value renders the static export + first paint.
        //
        // A DATABASE-bound chart (DASH-3) has no reactive expression — its data is
        // the series resolved live at export time and threaded in via `dbSeries`
        // (never persisted to the doc). Bake it in as a constant literal so both
        // the static render and the runtime's recompute show that data; its labels
        // are the groups (from the resolved series), not the manual `labels` prop.
        const dbBound = b.props?.sourceMode === 'database';
        const series = dbBound ? dbSeries?.get(b.id) : undefined;
        const exprSource = dbBound ? JSON.stringify(series?.value ?? []) : String(b.props?.source ?? '');
        const chartLabels = dbBound ? (series?.labels ?? []).map(String).join(', ') : String(b.props?.labels ?? '');
        sink.push({id: b.id, type: 'expr', data: {name: String(b.props?.title ?? 'chart'), source: tokenize(exprSource), hidden: true}});
        pushCell(b.id);
        sink.push({
          id: `${b.id}-plot`,
          type: 'chart',
          data: {refCellIds: [b.id], kind: String(b.props?.kind ?? 'line'), title: String(b.props?.title ?? ''), labels: chartLabels},
        });
        i += 1;
        break;
      }
      case 'textfield':
      case 'radio':
      case 'checklist':
      case 'dropdown':
      case 'toggle': {
        // These stay INTERACTIVE in the export — flipping a choice offline
        // recomputes everything downstream, exactly like the editor.
        const read = KIT_INPUT_VALUE[b.type];
        sink.push({
          id: b.id,
          type: 'kitinput',
          data: {
            kind: b.type,
            name: String(b.props?.name ?? b.type),
            label: String(b.props?.label ?? b.props?.name ?? b.type),
            // Resolved {label,value} pairs so the export shows labels but
            // serialises values; full-width unless the block opted into compact.
            opts: resolveOptionsFromProps(b.props ?? {}),
            placeholder: String(b.props?.placeholder ?? ''),
            wide: !b.props?.compact,
            value: read(b.props ?? {}),
          },
        });
        publish(b);
        i += 1;
        break;
      }
      case 'location': {
        const lat = b.props?.lat;
        const lng = b.props?.lng;
        const place = String(b.props?.labeltext ?? '');
        const coords = typeof lat === 'number' && typeof lng === 'number' ? `<a href="https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}">${lat}, ${lng}</a>` : '';
        sink.push({id: b.id, type: 'paragraph', data: {text: [`<b>${String(b.props?.name ?? 'place')}</b>:`, place, coords].filter(Boolean).join(' ')}});
        publish(b);
        i += 1;
        break;
      }
      case 'tooltipcard':
        sink.push({id: b.id, type: 'paragraph', data: {text: `<b>${String(b.props?.term ?? '')}</b> — ${String(b.props?.tip ?? '')}`}});
        i += 1;
        break;
      case 'linkcard': {
        const url = String(b.props?.url ?? '');
        const href = url && (/^https?:\/\//.test(url) ? url : `https://${url}`);
        const title = String(b.props?.title ?? 'Untitled');
        const desc = String(b.props?.description ?? '');
        sink.push({id: b.id, type: 'paragraph', data: {text: [href ? `<a href="${href}">${title}</a>` : `<b>${title}</b>`, desc].filter(Boolean).join(' — ')}});
        i += 1;
        break;
      }
      case 'actionbutton': {
        const action = String(b.props?.action ?? 'increment');
        const label = String(b.props?.btnlabel ?? 'Button');
        if (action === 'link') {
          const url = String(b.props?.url ?? '');
          if (url) sink.push({id: b.id, type: 'kitbutton', data: {label, action, url: /^https?:\/\//.test(url) ? url : `https://${url}`}});
          i += 1;
          break;
        }
        const target = inputs.find((x) => x.name === String(b.props?.target ?? ''));
        if (target) {
          const tprops = propsById.get(target.id) ?? {};
          sink.push({
            id: b.id,
            type: 'kitbutton',
            data: {label, action, target: target.id, amount: Number(b.props?.amount ?? 1), min: tprops.min, max: tprops.max},
          });
        }
        i += 1;
        break;
      }
      case 'choicecards':
      case 'searchselect':
      case 'tagfield': {
        // The standalone runtime has no searchable/card widgets — export the
        // current selection as readable text, but still PUBLISH the value so
        // downstream charts/formulas read it live (longest-names-first
        // tokenizing means an expr over this input resolves in the export).
        const read = KIT_INPUT_VALUE[b.type];
        const val = read(b.props ?? {});
        const opts = resolveOptionsFromProps(b.props ?? {});
        const labelFor = (v: string): string => opts.find((o) => o.value === v)?.label ?? v;
        const shown = Array.isArray(val) ? val.map(labelFor).join(', ') : val ? labelFor(String(val)) : '—';
        const label = String(b.props?.label ?? b.props?.name ?? b.type);
        sink.push({id: b.id, type: 'paragraph', data: {text: `<b>${label}:</b> ${textHtml([{t: shown}])}`}});
        publish(b);
        i += 1;
        break;
      }
      case 'longtext':
      case 'richtext': {
        // Long/rich text export as paragraphs; rich text keeps its inline
        // markup (the runs already carry b/i/u/links), plain long text is
        // escaped. Both publish their value (plain string) for expressions.
        const runs = b.type === 'richtext' && Array.isArray(b.props?.runs) ? (b.props!.runs as TextRun[]) : [{t: String(b.props?.value ?? '')}];
        sink.push({id: b.id, type: 'paragraph', data: {text: textHtml(runs)}});
        publish(b);
        i += 1;
        break;
      }
      case 'progressbar': {
        // A hidden computed cell drives a real progress bar (label + track +
        // readout) that recomputes live; the seeded value renders the static
        // export and first paint.
        sink.push({id: b.id, type: 'expr', data: {name: String(b.props?.label ?? 'Progress'), source: tokenize(String(b.props?.source ?? '')), hidden: true}});
        pushCell(b.id);
        sink.push({
          id: `${b.id}-bar`,
          type: 'kitprogress',
          data: {refCellId: b.id, label: String(b.props?.label ?? 'Progress'), max: Number(b.props?.max ?? 100), format: String(b.props?.format ?? 'percent')},
        });
        i += 1;
        break;
      }
      case 'dbview':
        // Embedded databases export as a link to their page (the standalone
        // runtime has no database engine).
        sink.push({
          id: b.id,
          type: 'paragraph',
          data: {text: textHtml([{t: `🗃 ${String(b.props?.name ?? 'Database')}`, a: {m: String(b.props?.pageId ?? '')}}])},
        });
        i += 1;
        break;
      default: {
        // Core text-only types (a bare `paragraph`, or an orphaned container
        // child) project as paragraphs — they have no props worth carrying.
        if (isCoreTextType(b.type)) {
          sink.push({id: b.id, type: 'paragraph', data: {text: textHtml(b.text)}});
          i += 1;
          break;
        }
        // LX-1: a plugin-contributed (`{pluginId}/{blockName}`) or newer-version
        // type. PRESERVE ITS IDENTITY — `type` verbatim plus `props` nested (so a
        // plugin prop can never collide with the projection's own `data` keys
        // like `text`/`level`). Relabelling these `paragraph` erased both, and
        // since plugin blocks carry no text it printed a literal empty <p> into
        // every HTML/PDF/Markdown export. Downstream renderers now see the real
        // type and draw a labelled placeholder; unknown types are inert in every
        // other consumer of this projection (assets/link/search/mtime walks).
        sink.push({id: b.id, type: b.type, data: {props: b.props ?? {}, text: textHtml(b.text)}});
        i += 1;
      }
      }
    }
  };
  emit(blocks);
  return out;
}

/** Snapshot-level normalization: pages written by the block editor project
 *  into the export-projection shape; everything else passes through untouched.
 *  Export entry points call this so mixed trees (a legacy stored page linking
 *  block subpages, or vice versa) export every page faithfully. */
export function projectSnapshotForExport<T extends {editor?: string; blockdoc?: unknown}>(snapshot: T, dbSeries?: DbChartSeriesMap): T {
  if (!snapshot || snapshot.editor !== 'blocks' || !snapshot.blockdoc) return snapshot;
  const blockdoc = snapshot.blockdoc as {blocks?: BlockJSON[]; update?: string};
  const blocks = (blockdoc.blocks ?? []) as BlockJSON[];
  // Resolve the reactive graph the way the editor does, so the export carries the
  // same computed values (numbers, chart series, light/progress states) the
  // window shows — not empty cells. Falls back to an empty map if the CRDT update
  // can't be decoded (the projection still works, just without precomputed
  // values; the interactive HTML recomputes them anyway).
  let computed: Map<string, ExportCell> | undefined;
  try {
    computed = computeExportCells(decodeSnapshot(blockdoc as never), dbSeries);
  } catch {
    computed = undefined;
  }
  const projected = projectBlocksForExport(blocks, computed, dbSeries);
  // `editorjs` is the RETAINED on-disk storage key for the export projection
  // (back-compat alias — see PageSnapshot in sdk/types.ts). Every consumer reads
  // `snapshot.editorjs.blocks`; the key name must not change or persisted
  // snapshots would be stranded. Only the in-memory TYPE is `ExportDoc`.
  return {...snapshot, editorjs: {blocks: projected.blocks}, values: projected.values, names: projected.names};
}
