/**
 * A normalized, presentation-agnostic model of a page document, built once from
 * a {@link PageSnapshot} and consumed by every exporter (Markdown, PDF, HTML).
 *
 * It parses each EditorJS block into a typed shape: inline HTML → formatting
 * runs (bold/italic/code/marker/link/`@`-mention), lists into nested items, and
 * reactive blocks (slider/expr/chart) resolved against the snapshot's persisted
 * `values`/`names`. Pure and DOM-light (uses `DOMParser`, available in the
 * browser and happy-dom) so it is unit-tested directly.
 */
import type {PageSnapshot} from '@book.dev/sdk';
import {blockSnapshotToEditorJs} from '../blockeditor/exportBlocks';
import {normalizeChartInput, type NormalizedSeries} from './chartNormalize';

export interface InlineRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  code?: boolean;
  marker?: boolean;
  /** Text colour (CSS hex) — from the editor's `tc` palette token. */
  color?: string;
  /** Highlight colour (CSS hex) when a `<mark>` carries one. */
  markerColor?: string;
  link?: string;
  mention?: {pageId: string; label: string};
}

export interface ListItem {
  runs: InlineRun[];
  items: ListItem[];
}

export type DocBlock =
  | {type: 'paragraph'; runs: InlineRun[]}
  | {type: 'header'; level: number; runs: InlineRun[]}
  | {type: 'list'; ordered: boolean; items: ListItem[]}
  | {type: 'quote'; runs: InlineRun[]; caption: string}
  | {type: 'code'; code: string}
  | {type: 'delimiter'}
  | {type: 'table'; withHeadings: boolean; rows: InlineRun[][][]}
  | {type: 'callout'; variant: string; runs: InlineRun[]}
  | {type: 'accordion'; title: InlineRun[]; content: InlineRun[]; open: boolean}
  | {type: 'checklist'; items: {runs: InlineRun[]; checked: boolean}[]}
  | {type: 'toc'; entries: {level: number; text: string}[]}
  | {type: 'button'; label: string; url: string}
  | {type: 'divider'; style: string; label: string}
  | {type: 'slider'; name: string; value: unknown}
  | {type: 'expr'; name: string; value: unknown; source: string}
  | {type: 'chart'; series: NormalizedSeries[]; kind: string; labels: string[]; title: string; value: unknown}
  | {type: 'kvalue'; label: string; value: unknown}
  | {type: 'light'; label: string; status: string; value: unknown}
  | {type: 'progress'; label: string; pct: number; readout: string}
  | {type: 'unknown'; raw: string};

export interface DocModel {
  title: string;
  icon: string;
  blocks: DocBlock[];
}

interface RawBlock {
  id?: string;
  type?: string;
  data?: Record<string, unknown>;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** The HTML export keeps `columns` nested for side-by-side layout; the linear
 *  PDF/Markdown model flattens each column's blocks into reading order. */
function flattenColumns(blocks: RawBlock[]): RawBlock[] {
  const out: RawBlock[] = [];
  for (const b of blocks) {
    if (b.type === 'columns' && Array.isArray(b.data?.columns)) {
      for (const col of b.data!.columns as RawBlock[][]) out.push(...flattenColumns(col));
    } else {
      out.push(b);
    }
  }
  return out;
}

/** Parse a block's inline HTML into formatting runs. */
export function parseInline(html: string): InlineRun[] {
  if (typeof DOMParser === 'undefined') return html ? [{text: stripTags(html)}] : [];
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  const runs: InlineRun[] = [];
  const walk = (node: Node, fmt: Omit<InlineRun, 'text'>): void => {
    if (node.nodeType === 3 /* text */) {
      const text = node.textContent ?? '';
      if (text) runs.push({...fmt, text});
      return;
    }
    if (node.nodeType !== 1 /* element */) return;
    const el = node as HTMLElement;
    const tag = el.tagName.toLowerCase();
    if (tag === 'a' && el.classList.contains('ob-mention')) {
      const label = el.textContent ?? '';
      runs.push({text: label, mention: {pageId: el.getAttribute('data-page-id') ?? '', label}});
      return;
    }
    if (tag === 'br') {
      runs.push({...fmt, text: '\n'});
      return;
    }
    const next: Omit<InlineRun, 'text'> = {...fmt};
    const style = el.getAttribute('style') ?? '';
    if (tag === 'b' || tag === 'strong') next.bold = true;
    else if (tag === 'i' || tag === 'em') next.italic = true;
    else if (tag === 'u') next.underline = true;
    else if (tag === 's' || tag === 'del' || tag === 'strike') next.strike = true;
    else if (tag === 'mark') {
      next.marker = true;
      const bg = style.match(/background(?:-color)?:\s*([^;]+)/i);
      if (bg) next.markerColor = bg[1].trim();
    } else if (tag === 'code') next.code = true;
    else if (tag === 'span') {
      const c = style.match(/(?:^|[^-])color:\s*([^;]+)/i);
      if (c) next.color = c[1].trim();
    } else if (tag === 'a') next.link = el.getAttribute('href') ?? undefined;
    el.childNodes.forEach((c) => walk(c, next));
  };
  doc.body.childNodes.forEach((c) => walk(c, {}));
  return runs;
}

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ');
}

function parseListItems(items: unknown): ListItem[] {
  if (!Array.isArray(items)) return [];
  return items.map((it): ListItem => {
    if (typeof it === 'string') return {runs: parseInline(it), items: []};
    const obj = (it ?? {}) as {content?: unknown; items?: unknown; text?: unknown};
    return {
      runs: parseInline(str(obj.content ?? obj.text)),
      items: parseListItems(obj.items),
    };
  });
}

/** Plain text of an inline run list (for titles, captions, etc.). */
export function runsToText(runs: InlineRun[]): string {
  return runs.map((r) => r.text).join('');
}

export interface BuildModelOptions {
  title: string;
  icon: string;
  snapshot: PageSnapshot;
}

export function buildDocumentModel({title, icon, snapshot: rawSnapshot}: BuildModelOptions): DocModel {
  // Pages written by the CRDT block editor project into the EditorJS shape
  // first, so every exporter below works on one block dialect.
  const snapshot = blockSnapshotToEditorJs(rawSnapshot);
  const blocks = flattenColumns(((snapshot.editorjs as {blocks?: RawBlock[]} | undefined)?.blocks ?? []) as RawBlock[]);
  const values = new Map<string, unknown>(snapshot.values as Array<[string, unknown]>);
  const nameByCell = new Map<string, string>();
  for (const [name, cellId] of snapshot.names as Array<[string, string]>) nameByCell.set(cellId, name);

  const out: DocBlock[] = [];
  for (const block of blocks) {
    const data = block.data ?? {};
    const id = block.id ?? '';
    switch (block.type) {
    case 'paragraph':
      out.push({type: 'paragraph', runs: parseInline(str(data.text))});
      break;
    case 'header': {
      const level = typeof data.level === 'number' ? Math.min(6, Math.max(1, data.level)) : 2;
      out.push({type: 'header', level, runs: parseInline(str(data.text))});
      break;
    }
    case 'list':
      out.push({type: 'list', ordered: data.style === 'ordered', items: parseListItems(data.items)});
      break;
    case 'quote':
      out.push({type: 'quote', runs: parseInline(str(data.text)), caption: stripTags(str(data.caption))});
      break;
    case 'code':
      out.push({type: 'code', code: str(data.code)});
      break;
    case 'delimiter':
      out.push({type: 'delimiter'});
      break;
    case 'table': {
      const content = Array.isArray(data.content) ? (data.content as unknown[][]) : [];
      const rows = content.map((row) => (Array.isArray(row) ? row : []).map((cell) => parseInline(str(cell))));
      out.push({type: 'table', withHeadings: data.withHeadings === true, rows});
      break;
    }
    case 'callout':
      out.push({type: 'callout', variant: str(data.variant) || 'info', runs: parseInline(str(data.text))});
      break;
    case 'accordion':
      out.push({
        type: 'accordion',
        title: parseInline(str(data.title)),
        content: parseInline(str(data.content)),
        open: data.open !== false,
      });
      break;
    case 'checklist': {
      const items = Array.isArray(data.items) ? (data.items as Array<Record<string, unknown>>) : [];
      out.push({
        type: 'checklist',
        items: items.map((it) => ({runs: parseInline(str(it.text)), checked: it.checked === true})),
      });
      break;
    }
    case 'toc':
      // Entries are filled from the document's headers in a post-process pass.
      out.push({type: 'toc', entries: []});
      break;
    case 'button':
      out.push({type: 'button', label: str(data.label), url: str(data.url)});
      break;
    case 'divider':
      out.push({type: 'divider', style: str(data.style) || 'line', label: str(data.label)});
      break;
    case 'slider':
      out.push({type: 'slider', name: str(data.name) || nameByCell.get(id) || 'value', value: values.get(id)});
      break;
    case 'expr':
      // Hidden cells feed other blocks (a chart, light, or progress bar) — they
      // have no readout of their own, so they don't appear in the document.
      if (data.hidden === true) break;
      out.push({
        type: 'expr',
        name: str(data.name) || nameByCell.get(id) || 'expr',
        value: values.get(id),
        source: str(data.source),
      });
      break;
    case 'chart': {
      const ids = Array.isArray(data.refCellIds)
        ? (data.refCellIds as string[])
        : data.refCellId
          ? [String(data.refCellId)]
          : [];
      const series: NormalizedSeries[] = [];
      for (const cellId of ids) {
        series.push(...normalizeChartInput(values.get(cellId), nameByCell.get(cellId) ?? cellId));
      }
      const labels = str(data.labels)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      out.push({type: 'chart', series, kind: str(data.kind) || 'line', labels, title: str(data.title), value: ids.length ? values.get(ids[0]) : undefined});
      break;
    }
    case 'kitinput':
      out.push({type: 'kvalue', label: str(data.label) || str(data.name) || 'Field', value: values.has(id) ? values.get(id) : data.value});
      break;
    case 'kitlight':
      out.push({
        type: 'light',
        label: str(data.label) || 'Status',
        status: str(data.status) || 'off',
        value: values.get(str(data.refCellId)),
      });
      break;
    case 'kitprogress': {
      const cell = str(data.refCellId);
      const max = Number(data.max ?? 100) || 100;
      const format = str(data.format) || 'percent';
      const raw = typeof values.get(cell) === 'boolean' ? (values.get(cell) ? max : 0) : Number(values.get(cell) ?? 0);
      const fraction = Number.isFinite(raw) ? Math.max(0, Math.min(1, max === 0 ? 0 : raw / max)) : 0;
      const pct = Math.round(fraction * 100);
      const trim = (n: number): string => (Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100));
      out.push({type: 'progress', label: str(data.label) || 'Progress', pct, readout: format === 'fraction' ? `${trim(raw)} / ${trim(max)}` : `${pct}%`});
      break;
    }
    case 'kitbutton':
      // A static document can't run the action; show link buttons, drop the rest.
      if (str(data.action) === 'link' && str(data.url)) out.push({type: 'button', label: str(data.label) || str(data.url), url: str(data.url)});
      break;
    case 'subpage':
      // An inline link to a nested page; represent as a paragraph mention run.
      out.push({
        type: 'paragraph',
        runs: [{text: str(data.pageId), mention: {pageId: str(data.pageId), label: str(data.pageId)}}],
      });
      break;
    default:
      out.push({type: 'unknown', raw: block.type ?? 'unknown'});
      break;
    }
  }

  // Fill any table-of-contents blocks from the document's headers.
  const entries = out
    .filter((b): b is Extract<DocBlock, {type: 'header'}> => b.type === 'header')
    .map((h) => ({level: h.level, text: runsToText(h.runs)}));
  for (const b of out) if (b.type === 'toc') b.entries = entries;

  return {title: title.trim() || 'Untitled', icon, blocks: out};
}
