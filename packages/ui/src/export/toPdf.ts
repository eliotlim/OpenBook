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
import type {DocBlock, DocModel, InlineRun, ListItem} from './documentModel';
import {runsToText} from './documentModel';
import {formatValue} from './format';
import {buildChartSvg} from './chartSvg';

const CALLOUT_COLOR: Record<string, [number, number, number]> = {
  info: [59, 130, 246],
  warning: [245, 158, 11],
  success: [34, 197, 94],
  danger: [239, 68, 68],
};

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

/** Render an equal-column grid with cell borders (deterministic across passes). */
function writeTable(s: RenderState, rows: InlineRun[][][], withHeadings: boolean): void {
  if (rows.length === 0) return;
  const cols = Math.max(...rows.map((r) => r.length), 1);
  const colW = CONTENT_W / cols;
  const pad = 5;
  const size = 10;
  const lineH = size * 1.35;
  s.doc.setFontSize(size);
  for (let r = 0; r < rows.length; r++) {
    const head = r === 0 && withHeadings;
    s.doc.setFont('helvetica', head ? 'bold' : 'normal');
    const cellLines: string[][] = [];
    let maxLines = 1;
    for (let c = 0; c < cols; c++) {
      const text = runsToText(rows[r][c] ?? []) || ' ';
      const lines = s.doc.splitTextToSize(text, colW - pad * 2) as string[];
      cellLines.push(lines);
      maxLines = Math.max(maxLines, lines.length);
    }
    const rowH = maxLines * lineH + pad * 2;
    breakIfNeeded(s, rowH);
    const y0 = s.y;
    if (s.draw) {
      s.doc.setDrawColor(205, 205, 205);
      if (head) {
        s.doc.setFillColor(244, 244, 245);
        s.doc.rect(MARGIN, y0, CONTENT_W, rowH, 'F');
      }
      for (let c = 0; c <= cols; c++) s.doc.line(MARGIN + c * colW, y0, MARGIN + c * colW, y0 + rowH);
      s.doc.line(MARGIN, y0, MARGIN + CONTENT_W, y0);
      s.doc.line(MARGIN, y0 + rowH, MARGIN + CONTENT_W, y0 + rowH);
      s.doc.setTextColor(25, 25, 25);
      for (let c = 0; c < cols; c++) {
        cellLines[c].forEach((ln, li) =>
          s.doc.text(ln, MARGIN + c * colW + pad, y0 + pad + li * lineH, {baseline: 'top'}),
        );
      }
    }
    s.y = y0 + rowH;
  }
  s.y += 8;
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
  case 'table':
    writeTable(s, block.rows, block.withHeadings);
    break;
  case 'callout': {
    const start = s.y;
    writeText(s, runsToText(block.runs) || ' ', {size: 11, x: MARGIN + 16, color: [50, 50, 55], gapAfter: 8});
    if (s.draw) {
      s.doc.setDrawColor(...(CALLOUT_COLOR[block.variant] ?? CALLOUT_COLOR.info));
      s.doc.setLineWidth(2.5);
      s.doc.line(MARGIN + 6, start, MARGIN + 6, Math.max(start, s.y - 8));
      s.doc.setLineWidth(1);
    }
    break;
  }
  case 'accordion':
    writeText(s, runsToText(block.title) || ' ', {size: 12, style: 'bold', gapAfter: 2});
    writeText(s, runsToText(block.content), {size: 11, x: MARGIN + 14, color: [60, 60, 60], gapAfter: 8});
    break;
  case 'checklist':
    for (const item of block.items) {
      writeText(s, `${item.checked ? '[x]' : '[ ]'} ${runsToText(item.runs)}`, {size: 11, x: MARGIN + 4, gapAfter: 2});
    }
    s.y += 6;
    break;
  case 'toc':
    if (block.entries.length) {
      const min = Math.min(...block.entries.map((e) => e.level));
      writeText(s, 'Contents', {size: 12, style: 'bold', gapAfter: 4});
      for (const e of block.entries) {
        writeText(s, e.text, {size: 10.5, x: MARGIN + 14 + (e.level - min) * 14, color: [60, 60, 60], gapAfter: 1});
      }
      s.y += 6;
    }
    break;
  case 'button':
    writeText(s, block.url ? `${block.label || block.url}  →  ${block.url}` : block.label, {
      size: 11,
      style: 'bold',
      color: [79, 70, 229],
      gapAfter: 8,
    });
    break;
  case 'divider': {
    breakIfNeeded(s, 18);
    if (s.draw) {
      const yy = s.y + 6;
      s.doc.setDrawColor(200, 200, 200);
      if (block.style === 'thick') s.doc.setLineWidth(2);
      if (block.style === 'dashed') s.doc.setLineDashPattern([4, 3], 0);
      if (block.style === 'dotted') s.doc.setLineDashPattern([1, 3], 0);
      if (block.style === 'labeled' && block.label) {
        s.doc.setFont('helvetica', 'normal');
        s.doc.setFontSize(9.5);
        s.doc.setTextColor(140, 140, 140);
        const tw = s.doc.getTextWidth(block.label);
        const cx = MARGIN + CONTENT_W / 2;
        s.doc.line(MARGIN, yy, cx - tw / 2 - 8, yy);
        s.doc.line(cx + tw / 2 + 8, yy, MARGIN + CONTENT_W, yy);
        s.doc.text(block.label, cx - tw / 2, yy, {baseline: 'middle'});
      } else {
        s.doc.line(MARGIN, yy, MARGIN + CONTENT_W, yy);
      }
      s.doc.setLineWidth(1);
      s.doc.setLineDashPattern([], 0);
    }
    s.y += 18;
    break;
  }
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
