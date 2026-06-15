/**
 * Render a {@link DocModel} to a **vector** PDF (selectable text, never
 * rasterized) via jsPDF; charts embed as vector SVG via svg2pdf. Two modes:
 *  - `paged`: US-Letter pages, content paginated across them;
 *  - `continuous`: a single page sized to the full content height.
 *
 * Inline emphasis is preserved (bold/italic/underline/strike/`code`/highlight,
 * with clickable links) via run-aware layout; headings, lists, quotes, code,
 * tables, reactive values, status lights, progress bars and kind-faithful charts
 * are all rendered. Emoji are stripped (jsPDF's fonts are Latin-1). Async
 * because svg2pdf is.
 */
import {jsPDF} from 'jspdf';
import 'svg2pdf.js';
import type {DocBlock, DocModel, InlineRun, ListItem} from './documentModel';
import {runsToText} from './documentModel';
import {formatValue} from './format';
import {buildChartSvg} from './chartSvg';
import {kitChartSvg, KIT_CHART_W, KIT_CHART_H} from './kitChart';

const STATUS_COLOR: Record<string, [number, number, number]> = {
  ok: [16, 185, 129],
  warn: [245, 158, 11],
  bad: [239, 68, 68],
  off: [156, 163, 175],
};

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
/** jsPDF caps any page dimension at 14400pt — continuous mode clamps to it. */
const JSPDF_MAX = 14400;

export type PdfMode = 'paged' | 'continuous';

interface RenderState {
  doc: jsPDF;
  y: number;
  pageH: number | null; // null = continuous (no page breaks)
  draw: boolean;
  /** Slide deck: each `divider` forces a new page instead of drawing a rule. */
  slides?: boolean;
}

const HEADER_SIZE: Record<number, number> = {1: 22, 2: 17, 3: 14, 4: 12.5, 5: 11.5, 6: 11};

function breakIfNeeded(s: RenderState, h: number): void {
  if (s.pageH && s.y + h > s.pageH - MARGIN) {
    if (s.draw) s.doc.addPage();
    s.y = MARGIN;
  }
}

/** jsPDF's standard fonts are WinAnsi (Latin-1) only — emoji and other astral /
 *  symbol characters render as mojibake. Strip them so the PDF stays clean
 *  (the Markdown/HTML exports keep them). Vector glyphs (status dots, bars)
 *  carry the meaning emoji would in the live view. */
function pdfSafe(text: string): string {
  return text
    .replace(/[\u{10000}-\u{10FFFF}]/gu, '') // astral plane (most emoji)
    .replace(/[←-⇿☀-➿⬀-⯿™ℹ]/g, '') // BMP symbols/arrows
    .replace(/️/g, '') // emoji variation selector
    .replace(/‍/g, '') // zero-width joiner
    .replace(/⃣/g, ''); // combining enclosing keycap
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
function writeText(s: RenderState, rawText: string, o: TextOpts): void {
  const text = pdfSafe(rawText);
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

const LINK_COLOR: [number, number, number] = [79, 70, 229];
const CODE_COLOR: [number, number, number] = [60, 60, 70];

/** The jsPDF font + style for an inline run (so bold/italic/code render like the window). */
function runFont(r: InlineRun, base: 'normal' | 'bold' | 'italic'): {family: 'helvetica' | 'courier'; style: 'normal' | 'bold' | 'italic' | 'bolditalic'} {
  const bold = !!r.bold || base === 'bold';
  const italic = !!r.italic || base === 'italic';
  if (r.code) return {family: 'courier', style: bold ? 'bold' : 'normal'};
  return {family: 'helvetica', style: bold && italic ? 'bolditalic' : bold ? 'bold' : italic ? 'italic' : 'normal'};
}

interface RunsOpts {
  size: number;
  x?: number;
  w?: number;
  color?: [number, number, number];
  gapAfter?: number;
  /** A base emphasis applied to every run (headings = bold, quotes = italic). */
  base?: 'normal' | 'bold' | 'italic';
}

/**
 * Lay out a sequence of inline runs with per-run font styles and word wrap, so a
 * PDF paragraph shows the same bold / italic / `code` / link styling the editor
 * does (jsPDF's single-style `splitTextToSize` can't). Greedy word layout;
 * over-long single tokens hard-wrap by character.
 */
function writeRuns(s: RenderState, runs: InlineRun[], o: RunsOpts): void {
  const x0 = o.x ?? MARGIN;
  const maxX = x0 + (o.w ?? CONTENT_W - (x0 - MARGIN));
  const lineH = o.size * 1.4;
  const baseColor = o.color ?? [25, 25, 25];
  const base = o.base ?? 'normal';
  s.doc.setFontSize(o.size);

  let cx = x0;
  let atLineStart = true;
  const newline = (): void => {
    s.y += lineH;
    cx = x0;
    atLineStart = true;
  };

  // Tokenize runs into words + explicit line breaks, each keeping its run's style.
  const toks: Array<{text: string; run: InlineRun; nl?: boolean}> = [];
  for (const run of runs.length ? runs : [{text: ''} as InlineRun]) {
    pdfSafe(run.text || '').split('\n').forEach((part, pi) => {
      if (pi > 0) toks.push({text: '', run, nl: true});
      for (const w of part.split(/(\s+)/)) if (w.length) toks.push({text: w, run});
    });
  }

  breakIfNeeded(s, lineH);
  for (const tok of toks) {
    if (tok.nl) {
      newline();
      breakIfNeeded(s, lineH);
      continue;
    }
    const isSpace = /^\s+$/.test(tok.text);
    if (isSpace && atLineStart) continue; // swallow leading space on a wrapped line
    const {family, style} = runFont(tok.run, base);
    s.doc.setFont(family, style);
    const width = s.doc.getTextWidth(tok.text);

    // Hard-wrap a token too wide for a whole line (e.g. a long URL).
    if (!isSpace && width > maxX - x0) {
      for (const piece of s.doc.splitTextToSize(tok.text, maxX - x0) as string[]) {
        if (!atLineStart) newline();
        breakIfNeeded(s, lineH);
        emitWord(s, piece, cx, tok.run, baseColor);
        cx += s.doc.getTextWidth(piece);
        atLineStart = false;
      }
      continue;
    }
    if (!isSpace && !atLineStart && cx + width > maxX) {
      newline();
      breakIfNeeded(s, lineH);
    }
    if (isSpace && atLineStart) continue;
    emitWord(s, tok.text, cx, tok.run, baseColor);
    cx += width;
    atLineStart = false;
  }
  s.y += lineH + (o.gapAfter ?? o.size * 0.5);
}

/** Draw one already-positioned word, with its run's colour + link/strike decoration. */
/** Parse a CSS colour (`#rgb`, `#rrggbb`, or `rgb(r,g,b)`) to a PDF tuple, or null. */
function parseColor(css: string | undefined): [number, number, number] | null {
  if (!css) return null;
  const hex = css.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    const h = hex[1];
    const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
    return [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16)];
  }
  const rgb = css.match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i);
  return rgb ? [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])] : null;
}

function emitWord(s: RenderState, text: string, x: number, run: InlineRun, baseColor: [number, number, number]): void {
  if (!s.draw || !text) return;
  const size = s.doc.getFontSize();
  const w = s.doc.getTextWidth(text);
  if (run.marker) {
    // Highlight (the editor's <mark>): the token's tint, or a soft amber default.
    s.doc.setFillColor(...(parseColor(run.markerColor) ?? [253, 230, 138]));
    s.doc.rect(x, s.y, w, size * 1.1, 'F');
  }
  const textColor = run.link ? LINK_COLOR : run.code ? CODE_COLOR : (parseColor(run.color) ?? baseColor);
  s.doc.setTextColor(...textColor);
  s.doc.text(text, x, s.y, {baseline: 'top'});
  if (run.link || run.underline) {
    s.doc.setDrawColor(...(run.link ? LINK_COLOR : baseColor));
    s.doc.setLineWidth(0.5);
    s.doc.line(x, s.y + size, x + w, s.y + size);
  }
  if (run.strike) {
    s.doc.setDrawColor(...baseColor);
    s.doc.setLineWidth(0.5);
    s.doc.line(x, s.y + size * 0.55, x + w, s.y + size * 0.55);
  }
  if (run.link) s.doc.link(x, s.y, w, size * 1.1, {url: run.link}); // a real clickable annotation
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
    writeRuns(s, item.runs, {size: 11, x: indent + 16, gapAfter: 2});
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
      const text = pdfSafe(runsToText(rows[r][c] ?? [])) || ' ';
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
    writeRuns(s, block.runs, {size: HEADER_SIZE[block.level] ?? 13, base: 'bold', gapAfter: 6});
    break;
  case 'paragraph':
    writeRuns(s, block.runs, {size: 11, gapAfter: 8});
    break;
  case 'list':
    writeList(s, block.items, block.ordered, 0);
    break;
  case 'quote':
    writeRuns(s, block.runs, {size: 11.5, base: 'italic', x: MARGIN + 14, color: [90, 90, 90], gapAfter: 4});
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
    writeRuns(s, block.runs.length ? block.runs : [{text: ' '}], {size: 11, x: MARGIN + 16, color: [50, 50, 55], gapAfter: 8});
    if (s.draw) {
      s.doc.setDrawColor(...(CALLOUT_COLOR[block.variant] ?? CALLOUT_COLOR.info));
      s.doc.setLineWidth(2.5);
      s.doc.line(MARGIN + 6, start, MARGIN + 6, Math.max(start, s.y - 8));
      s.doc.setLineWidth(1);
    }
    break;
  }
  case 'accordion':
    writeRuns(s, block.title.length ? block.title : [{text: ' '}], {size: 12, base: 'bold', gapAfter: 2});
    writeRuns(s, block.content, {size: 11, x: MARGIN + 14, color: [60, 60, 60], gapAfter: 8});
    break;
  case 'checklist':
    for (const item of block.items) {
      writeRuns(s, [{text: item.checked ? '[x] ' : '[ ] '}, ...item.runs], {size: 11, x: MARGIN + 4, gapAfter: 2});
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
    writeText(s, block.url ? `${block.label || block.url}  ->  ${block.url}` : block.label, {
      size: 11,
      style: 'bold',
      color: [79, 70, 229],
      gapAfter: 8,
    });
    break;
  case 'divider': {
    // Slide deck: a divider ends the slide — start a fresh page, no rule.
    if (s.slides) {
      if (s.draw) s.doc.addPage();
      s.y = MARGIN;
      break;
    }
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
  case 'kvalue':
    writeText(s, `${block.label}: ${formatValue(block.value)}`, {size: 11, gapAfter: 8});
    break;
  case 'light': {
    const lineH = 11 * 1.4;
    breakIfNeeded(s, lineH);
    if (s.draw) {
      s.doc.setFillColor(...(STATUS_COLOR[block.status] ?? STATUS_COLOR.off));
      s.doc.circle(MARGIN + 5, s.y + lineH / 2 - 1, 4, 'F');
    }
    writeText(s, `${block.label}${block.value != null ? `  —  ${formatValue(block.value)}` : ''}`, {size: 11, style: 'bold', x: MARGIN + 16, gapAfter: 8});
    break;
  }
  case 'progress': {
    const barW = CONTENT_W;
    const barH = 7;
    const lineH = 10 * 1.4;
    breakIfNeeded(s, lineH + barH + 10);
    writeText(s, `${block.label}`, {size: 10, style: 'bold', gapAfter: 2, w: barW - 70});
    if (s.draw) {
      // Readout right-aligned on the label line just drawn.
      s.doc.setFont('helvetica', 'normal');
      s.doc.setFontSize(10);
      s.doc.setTextColor(110, 110, 110);
      s.doc.text(block.readout, MARGIN + barW, s.y - lineH, {baseline: 'top', align: 'right'});
      s.doc.setFillColor(228, 228, 231);
      s.doc.roundedRect(MARGIN, s.y, barW, barH, 3, 3, 'F');
      if (block.pct > 0) {
        s.doc.setFillColor(99, 102, 241);
        s.doc.roundedRect(MARGIN, s.y, Math.max((barW * block.pct) / 100, 4), barH, 3, 3, 'F');
      }
    }
    s.y += barH + 12;
    break;
  }
  case 'chart': {
    if (block.title) writeText(s, block.title, {size: 11, style: 'bold', gapAfter: 4});
    const h = Math.round(CONTENT_W * (KIT_CHART_H / KIT_CHART_W));
    breakIfNeeded(s, h + 12);
    if (s.draw) {
      // Prefer the kind-faithful kit chart (bar/pie/line/…) drawn from the cell's
      // value; fall back to the Plot line chart over normalized series.
      const markup = block.value !== undefined ? kitChartSvg(block.value, block.kind, block.labels) : '';
      const svg = markup
        ? (new DOMParser().parseFromString(markup, 'image/svg+xml').documentElement as unknown as SVGElement)
        : buildChartSvg(block.series, CONTENT_W);
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
  // The icon is an emoji jsPDF's Latin-1 fonts can't render — the title carries
  // the page name alone (the Markdown/HTML exports keep the icon).
  writeText(s, model.title, {size: 24, style: 'bold', gapAfter: 12});
  for (const block of model.blocks) await writeBlock(s, block);
  return s.y;
}

export async function toPdf(model: DocModel, mode: PdfMode, opts?: {slides?: boolean}): Promise<Blob> {
  // Slide deck: one slide per page (dividers force the breaks); no measuring
  // pass needed since the page format is fixed.
  if (opts?.slides) {
    const doc = new jsPDF({unit: 'pt', format: 'letter'});
    await renderDocument({doc, y: MARGIN, pageH: PAGE_H, draw: true, slides: true}, model);
    return doc.output('blob');
  }

  // Measuring pass (no page breaks, no drawing) → total content height. The
  // scratch page never paginates (pageH: null), so its own height is irrelevant
  // to the measurement; keep it within jsPDF's 14400pt page cap to avoid a warning.
  const scratch = new jsPDF({unit: 'pt', format: [PAGE_W, JSPDF_MAX]});
  const totalH = await renderDocument({doc: scratch, y: MARGIN, pageH: null, draw: false}, model);

  const doc =
    mode === 'continuous'
      ? new jsPDF({unit: 'pt', format: [PAGE_W, Math.min(JSPDF_MAX, Math.max(PAGE_H, Math.ceil(totalH) + MARGIN))]})
      : new jsPDF({unit: 'pt', format: 'letter'});
  await renderDocument({doc, y: MARGIN, pageH: mode === 'paged' ? PAGE_H : null, draw: true}, model);
  return doc.output('blob');
}
