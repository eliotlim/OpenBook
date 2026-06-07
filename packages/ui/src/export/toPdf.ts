/**
 * Render a {@link DocModel} to a **vector** PDF (selectable text, never
 * rasterized) via jsPDF; charts embed as vector SVG via svg2pdf. Two modes:
 *  - `paged`: US-Letter pages, content paginated across them;
 *  - `continuous`: a single page sized to the full content height.
 *
 * Inline emphasis collapses to plain text in the PDF (it is preserved in the
 * Markdown/HTML exports); headings, lists, quotes, code, delimiters, reactive
 * values and charts are all rendered. Async because svg2pdf is.
 */
import {jsPDF} from 'jspdf';
import 'svg2pdf.js';
import type {DocBlock, DocModel, ListItem} from './documentModel';
import {runsToText} from './documentModel';
import {formatValue} from './format';
import {buildChartSvg} from './chartSvg';

const PAGE_W = 612; // US Letter, points
const PAGE_H = 792;
const MARGIN = 54;
const CONTENT_W = PAGE_W - MARGIN * 2;

export type PdfMode = 'paged' | 'continuous';

interface RenderState {
  doc: jsPDF;
  y: number;
  pageH: number | null; // null = continuous (no page breaks)
  draw: boolean;
}

const HEADER_SIZE: Record<number, number> = {1: 22, 2: 17, 3: 14, 4: 12.5, 5: 11.5, 6: 11};

function breakIfNeeded(s: RenderState, h: number): void {
  if (s.pageH && s.y + h > s.pageH - MARGIN) {
    if (s.draw) s.doc.addPage();
    s.y = MARGIN;
  }
}

interface TextOpts {
  size: number;
  style?: 'normal' | 'bold' | 'italic';
  font?: 'helvetica' | 'courier';
  x?: number;
  w?: number;
  color?: [number, number, number];
  gapAfter?: number;
}

/** Wrap + emit (or just measure) a run of text, advancing the cursor. */
function writeText(s: RenderState, text: string, o: TextOpts): void {
  const x = o.x ?? MARGIN;
  const w = o.w ?? CONTENT_W - (x - MARGIN);
  s.doc.setFont(o.font ?? 'helvetica', o.style ?? 'normal');
  s.doc.setFontSize(o.size);
  const lineH = o.size * 1.4;
  const lines: string[] = s.doc.splitTextToSize(text.length ? text : ' ', w);
  for (const line of lines) {
    breakIfNeeded(s, lineH);
    if (s.draw) {
      s.doc.setTextColor(...(o.color ?? [25, 25, 25]));
      s.doc.text(line, x, s.y, {baseline: 'top'});
    }
    s.y += lineH;
  }
  s.y += o.gapAfter ?? o.size * 0.5;
}

function writeList(s: RenderState, items: ListItem[], ordered: boolean, depth: number): void {
  const indent = MARGIN + depth * 18;
  items.forEach((item, i) => {
    const marker = ordered ? `${i + 1}.` : '•';
    if (s.draw) {
      s.doc.setFont('helvetica', 'normal');
      s.doc.setFontSize(11);
      s.doc.setTextColor(25, 25, 25);
      breakIfNeeded(s, 11 * 1.4);
      s.doc.text(marker, indent, s.y, {baseline: 'top'});
    }
    writeText(s, runsToText(item.runs), {size: 11, x: indent + 16, gapAfter: 2});
    if (item.items.length) writeList(s, item.items, ordered, depth + 1);
  });
  s.y += 4;
}

async function writeBlock(s: RenderState, block: DocBlock): Promise<void> {
  switch (block.type) {
  case 'header':
    writeText(s, runsToText(block.runs), {size: HEADER_SIZE[block.level] ?? 13, style: 'bold', gapAfter: 6});
    break;
  case 'paragraph':
    writeText(s, runsToText(block.runs), {size: 11, gapAfter: 8});
    break;
  case 'list':
    writeList(s, block.items, block.ordered, 0);
    break;
  case 'quote':
    writeText(s, runsToText(block.runs), {size: 11.5, style: 'italic', x: MARGIN + 14, color: [90, 90, 90], gapAfter: 4});
    if (block.caption) writeText(s, `— ${block.caption}`, {size: 9.5, x: MARGIN + 14, color: [140, 140, 140]});
    break;
  case 'code':
    writeText(s, block.code, {size: 9.5, font: 'courier', color: [40, 40, 40], gapAfter: 10});
    break;
  case 'delimiter':
    breakIfNeeded(s, 18);
    if (s.draw) {
      s.doc.setDrawColor(200, 200, 200);
      s.doc.line(MARGIN + CONTENT_W / 3, s.y + 6, MARGIN + (CONTENT_W * 2) / 3, s.y + 6);
    }
    s.y += 18;
    break;
  case 'slider':
  case 'expr':
    writeText(s, `${block.name} = ${formatValue(block.value)}`, {size: 11, font: 'courier', color: [40, 40, 90], gapAfter: 8});
    break;
  case 'chart': {
    const h = Math.round(CONTENT_W * 0.5);
    breakIfNeeded(s, h + 12);
    if (s.draw) {
      const svg = buildChartSvg(block.series, CONTENT_W);
      if (svg) {
        document.body.appendChild(svg);
        try {
          await s.doc.svg(svg, {x: MARGIN, y: s.y, width: CONTENT_W, height: h});
        } finally {
          svg.remove();
        }
      }
    }
    s.y += h + 12;
    break;
  }
  default:
    break;
  }
}

async function renderDocument(s: RenderState, model: DocModel): Promise<number> {
  s.y = MARGIN;
  writeText(s, `${model.icon ? `${model.icon}  ` : ''}${model.title}`, {size: 24, style: 'bold', gapAfter: 12});
  for (const block of model.blocks) await writeBlock(s, block);
  return s.y;
}

export async function toPdf(model: DocModel, mode: PdfMode): Promise<Blob> {
  // Measuring pass (no page breaks, no drawing) → total content height.
  const scratch = new jsPDF({unit: 'pt', format: [PAGE_W, 20000]});
  const totalH = await renderDocument({doc: scratch, y: MARGIN, pageH: null, draw: false}, model);

  const doc =
    mode === 'continuous'
      ? new jsPDF({unit: 'pt', format: [PAGE_W, Math.max(PAGE_H, Math.ceil(totalH) + MARGIN)]})
      : new jsPDF({unit: 'pt', format: 'letter'});
  await renderDocument({doc, y: MARGIN, pageH: mode === 'paged' ? PAGE_H : null, draw: true}, model);
  return doc.output('blob');
}
