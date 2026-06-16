/**
 * Render an exported HTML document to a **vector** PDF that mirrors the window.
 *
 * Instead of re-drawing an approximation with jsPDF primitives (the old path,
 * which looked nothing like the app), the HTML is laid out off-screen and
 * converted to a real SVG — native `<text>`/`<rect>`, so the text stays
 * selectable and searchable, NOT a rasterized screenshot — via `dom-to-svg`,
 * then drawn into jsPDF via `svg2pdf`. So fonts, colours, backgrounds, callouts,
 * tables and the (already-vector) charts all carry over faithfully.
 *
 * Modes: `continuous` (one tall page sized to the content) and `paged`
 * (US-Letter, sliced by viewBox so a tall document flows across pages).
 *
 * Browser-only — it needs real layout (getComputedStyle / getBoundingClientRect),
 * so it runs client-side from the export action, not under SSR / happy-dom.
 */
import {jsPDF} from 'jspdf';
import 'svg2pdf.js';
import {elementToSVG} from 'dom-to-svg';

const PAGE_W = 612; // US Letter, points
const PAGE_H = 792;
const MARGIN = 48;
/** jsPDF caps any page dimension at 14400pt — continuous mode clamps to it. */
const JSPDF_MAX = 14400;

export type PdfMode = 'paged' | 'continuous';

/** jsPDF after `import 'svg2pdf.js'` augments it with the async `.svg()` method. */
type SvgPdf = jsPDF & {
  svg: (el: Element, opts: {x: number; y: number; width: number; height: number}) => Promise<jsPDF>;
};

// svg2pdf's built-in font set is Helvetica/Times/Courier; the export's system
// font stack doesn't match, so headings fell back to a serif. Pin a mappable
// sans for the PDF render so every weight is a consistent Helvetica/Arial.
// svg2pdf only has Helvetica at weights 400/700 (and Courier for mono); any other
// weight (the title's 800, medium UI text at 500/600) makes it fall back to a
// SERIF (Times). So pin the family AND collapse weights to 400/700 — headings and
// bold stay bold, everything else regular — and keep code monospaced.
const PDF_FONT =
  '<style>' +
  '*{font-family:Arial,Helvetica,sans-serif !important;font-weight:400 !important}' +
  'code,pre,kbd,samp{font-family:"Courier New",Courier,monospace !important}' +
  'h1,h2,h3,h4,h5,h6,b,strong,th,.doc-title{font-weight:700 !important}' +
  // The callout variant icon is an emoji in a ::before (generated content, not a
  // text node — deEmoji can't reach it), which renders as mojibake. Drop it; the
  // tinted background already signals the variant.
  '.callout::before{content:none !important}' +
  '</style>';

// jsPDF's standard fonts are WinAnsi (Latin-1) — emoji render as mojibake and
// corrupt the surrounding glyph spacing. Strip them from the rendered text
// before conversion (HTML/Markdown exports keep emoji; only the PDF can't).
function stripEmoji(s: string): string {
  return s
    .replace(/[\u{10000}-\u{10FFFF}]/gu, '') // astral plane (most emoji)
    .replace(/[←-⇿☀-➿⬀-⯿™ℹ]/g, '') // BMP symbols/arrows
    .replace(/️/g, '') // emoji variation selector
    .replace(/‍/g, '') // zero-width joiner
    .replace(/⃣/g, ''); // combining enclosing keycap
}

/** Remove emoji from an element's text nodes in place (reflows, then converts). */
function deEmoji(root: Element): void {
  const doc = root.ownerDocument;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n as Text);
  for (const node of nodes) {
    const next = stripEmoji(node.nodeValue ?? '');
    if (next !== node.nodeValue) node.nodeValue = next;
  }
}

/**
 * Native `<input type=range>` renders badly through dom-to-svg — its track/thumb
 * live in UA shadow DOM (unreachable) and a stray value glyph leaks in. Replace
 * each with a static styled track (filled to the current value) so the PDF shows
 * a clean slider. The HTML export keeps the live range input.
 */
function staticizeSliders(root: Element): void {
  const doc = root.ownerDocument;
  for (const input of Array.from(root.querySelectorAll('input[type="range"]'))) {
    const el = input as HTMLInputElement;
    const min = Number(el.getAttribute('min') ?? '0');
    const max = Number(el.getAttribute('max') ?? '100');
    const val = Number(el.value || el.getAttribute('value') || '0');
    const pct = (max > min ? Math.max(0, Math.min(1, (val - min) / (max - min))) : 0) * 100;
    const track = doc.createElement('span');
    track.setAttribute('style', 'position:relative;display:inline-block;width:60%;height:8px;background:rgba(127,127,127,.18);border-radius:999px;vertical-align:middle');
    const fill = doc.createElement('span');
    fill.setAttribute('style', `position:absolute;left:0;top:0;height:8px;width:${pct.toFixed(2)}%;background:#6366f1;border-radius:999px`);
    const thumb = doc.createElement('span');
    thumb.setAttribute('style', `position:absolute;top:-3px;left:${pct.toFixed(2)}%;width:14px;height:14px;margin-left:-7px;background:#6366f1;border-radius:999px`);
    track.appendChild(fill);
    track.appendChild(thumb);
    el.replaceWith(track);
  }
}

/**
 * Lay the HTML out in a hidden iframe (real layout + the reactive runtime, so
 * computed values and charts render), and hand back its `<main>` element.
 */
async function layout(html: string): Promise<{frame: HTMLIFrameElement; el: Element}> {
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  Object.assign(frame.style, {
    position: 'fixed', left: '-99999px', top: '0', width: '820px', height: '1400px', border: '0', visibility: 'hidden',
  });
  document.body.appendChild(frame);
  const idoc = frame.contentDocument!;
  idoc.open();
  idoc.write(html.includes('</head>') ? html.replace('</head>', `${PDF_FONT}</head>`) : PDF_FONT + html);
  idoc.close();
  await new Promise<void>((res) => {
    if (idoc.readyState === 'complete') res();
    else frame.addEventListener('load', () => res(), {once: true});
  });
  try {
    await (idoc as unknown as {fonts?: {ready?: Promise<unknown>}}).fonts?.ready;
  } catch {
    /* font loading API absent — ignore */
  }
  await new Promise((r) => setTimeout(r, 300)); // let the reactive runtime recompute + draw charts
  const el = idoc.querySelector('main') ?? idoc.body;
  deEmoji(el);
  staticizeSliders(el);
  return {frame, el};
}

/** Convert a laid-out element to an SVG attached to the main document (svg2pdf
 *  measures via the live DOM, so the SVG must be in a document). */
function toSvg(el: Element): {svg: SVGSVGElement; holder: HTMLDivElement} {
  const svg = elementToSVG(el).documentElement as unknown as SVGSVGElement; // returns an XMLDocument
  const holder = document.createElement('div');
  Object.assign(holder.style, {position: 'fixed', left: '-99999px', top: '0', visibility: 'hidden'});
  holder.appendChild(svg);
  document.body.appendChild(holder);
  return {svg, holder};
}

/** Parse the SVG viewBox, preserving dom-to-svg's baked-in min-x/min-y (the
 *  element's viewport offset — a centred `<main>` has min-x > 0). */
function viewBox(svg: SVGSVGElement): [number, number, number, number] {
  const v = (svg.getAttribute('viewBox') ?? `0 0 ${PAGE_W} ${PAGE_H}`).split(/\s+/).map(Number);
  return [v[0] || 0, v[1] || 0, v[2] || PAGE_W, v[3] || PAGE_H];
}

/**
 * Render exported HTML to a vector PDF. `mode` controls pagination:
 *  - `continuous`: a single page sized to the full content height;
 *  - `paged`: US-Letter pages, the content sliced across them by viewBox.
 */
export async function toPdf(html: string, mode: PdfMode): Promise<Blob> {
  const {frame, el} = await layout(html);
  const {svg, holder} = toSvg(el);
  try {
    const [minX, minY, w, h] = viewBox(svg);
    const contW = PAGE_W - 2 * MARGIN;
    const scale = contW / w;

    if (mode === 'continuous') {
      const pageH = Math.min(JSPDF_MAX, h * scale + 2 * MARGIN);
      const pdf = new jsPDF({unit: 'pt', format: [PAGE_W, pageH]}) as SvgPdf;
      svg.setAttribute('viewBox', `${minX} ${minY} ${w} ${h}`);
      await pdf.svg(svg, {x: MARGIN, y: MARGIN, width: contW, height: h * scale});
      return pdf.output('blob');
    }

    const contH = PAGE_H - 2 * MARGIN;
    const sliceH = contH / scale; // SVG units shown per page
    const pages = Math.max(1, Math.min(2000, Math.ceil(h / sliceH)));
    const pdf = new jsPDF({unit: 'pt', format: [PAGE_W, PAGE_H]}) as SvgPdf;
    for (let p = 0; p < pages; p++) {
      if (p > 0) pdf.addPage([PAGE_W, PAGE_H], 'portrait');
      // Slice the y-range; keep min-x and width so content stays aligned.
      svg.setAttribute('viewBox', `${minX} ${minY + p * sliceH} ${w} ${sliceH}`);
      await pdf.svg(svg, {x: MARGIN, y: MARGIN, width: contW, height: contH});
    }
    return pdf.output('blob');
  } finally {
    holder.remove();
    frame.remove();
  }
}

/**
 * Render a slide-deck HTML (from {@link toHtmlSlides}) to a PDF — one slide per
 * page, each fit to a landscape page at the slide's own aspect. All slides are
 * forced visible first (the deck hides all but the current one).
 */
export async function toPdfSlides(html: string): Promise<Blob> {
  const show = '<style>section.slide{display:block !important;position:static !important;opacity:1 !important;transform:none !important}</style>';
  const {frame} = await layout(html.includes('</head>') ? html.replace('</head>', `${show}</head>`) : show + html);
  const idoc = frame.contentDocument!;
  const slides = Array.from(idoc.querySelectorAll('section.slide'));
  const targets: Element[] = slides.length ? slides : [idoc.querySelector('main') ?? idoc.body];
  // 16:9 landscape letter-ish page.
  const pageW = 960;
  const pageH = 540;
  const pdf = new jsPDF({unit: 'pt', format: [pageW, pageH], orientation: 'landscape'}) as SvgPdf;
  try {
    let first = true;
    for (const slide of targets) {
      const {svg, holder} = toSvg(slide);
      try {
        const [minX, minY, w, h] = viewBox(svg);
        const pad = 24;
        const scale = Math.min((pageW - 2 * pad) / w, (pageH - 2 * pad) / h);
        const dw = w * scale;
        const dh = h * scale;
        if (!first) pdf.addPage([pageW, pageH], 'landscape');
        first = false;
        svg.setAttribute('viewBox', `${minX} ${minY} ${w} ${h}`);
        await pdf.svg(svg, {x: (pageW - dw) / 2, y: (pageH - dh) / 2, width: dw, height: dh});
      } finally {
        holder.remove();
      }
    }
    return pdf.output('blob');
  } finally {
    frame.remove();
  }
}
