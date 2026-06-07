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
import type {PageSnapshot} from '@open-book/sdk';
import {normalizeChartInput, type NormalizedSeries} from '@/reactive/chartNormalize';

export interface InlineRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  marker?: boolean;
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
  | {type: 'chart'; series: NormalizedSeries[]}
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
    if (tag === 'b' || tag === 'strong') next.bold = true;
    else if (tag === 'i' || tag === 'em') next.italic = true;
    else if (tag === 'mark') next.marker = true;
    else if (tag === 'code') next.code = true;
    else if (tag === 'a') next.link = el.getAttribute('href') ?? undefined;
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

export function buildDocumentModel({title, icon, snapshot}: BuildModelOptions): DocModel {
  const blocks = ((snapshot.editorjs as {blocks?: RawBlock[]} | undefined)?.blocks ?? []) as RawBlock[];
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
      out.push({type: 'chart', series});
      break;
    }
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
