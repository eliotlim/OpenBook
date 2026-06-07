/**
 * Render a page to a **self-contained, interactive** HTML document: prose,
 * lists, code, mentions and links are styled static HTML; the reactive blocks
 * stay *live* — sliders recompute their dependent expressions and redraw charts,
 * exactly like in the app — via a small inlined runtime that reuses the saved
 * `__C__{cellId}__` reference tokens and Observable Plot (loaded from a CDN).
 *
 * A page with no reactive blocks produces a purely static document.
 */
import type {PageSnapshot} from '@open-book/sdk';
// Inlined so a page with charts works fully offline: d3's UMD sets `window.d3`,
// then Plot's UMD (which expects a global d3) sets `window.Plot`. Inlined only
// when the document actually has a chart, and code-split (this module is a
// dynamic import) so it never weighs on the main bundle.
import d3Umd from './vendor/d3.min.js?raw';
import plotUmd from './vendor/plot.umd.min.js?raw';
import {parseInline, type InlineRun, type ListItem} from './documentModel';
import {formatValue} from './format';

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'})[c]!);
}

/** Make JS safe to inline inside a `<script>` element. */
function escapeScript(js: string): string {
  return js.replace(/<\/script>/gi, '<\\/script>');
}

function runToHtml(r: InlineRun): string {
  if (r.text === '\n') return '<br>';
  let html = escapeHtml(r.text);
  if (r.code) return `<code>${html}</code>`;
  if (r.mention) return `<a class="mention" data-page-id="${escapeHtml(r.mention.pageId)}">${html}</a>`;
  if (r.bold) html = `<strong>${html}</strong>`;
  if (r.italic) html = `<em>${html}</em>`;
  if (r.marker) html = `<mark>${html}</mark>`;
  if (r.link) html = `<a href="${escapeHtml(r.link)}">${html}</a>`;
  return html;
}

const inlineToHtml = (runs: InlineRun[]): string => runs.map(runToHtml).join('');

function listToHtml(items: ListItem[], ordered: boolean): string {
  const tag = ordered ? 'ol' : 'ul';
  const lis = items
    .map((it) => `<li>${inlineToHtml(it.runs)}${it.items.length ? listToHtml(it.items, ordered) : ''}</li>`)
    .join('');
  return `<${tag}>${lis}</${tag}>`;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

interface SliderSpec {cell: string; min: number; max: number; step: number; name: string}
interface ExprSpec {cell: string; source: string}
interface ChartSpec {id: string; cells: string[]}

/** Build the interactive HTML for a page snapshot. */
export function toHtml(snapshot: PageSnapshot, title: string, icon: string): string {
  const blocks = ((snapshot.editorjs as {blocks?: Array<{id?: string; type?: string; data?: Record<string, unknown>}>})?.blocks ?? []);
  const values = new Map<string, unknown>(snapshot.values as Array<[string, unknown]>);
  const nameByCell = new Map<string, string>();
  for (const [name, cell] of snapshot.names as Array<[string, string]>) nameByCell.set(cell, name);

  const sliders: SliderSpec[] = [];
  const exprs: ExprSpec[] = [];
  const charts: ChartSpec[] = [];
  const initialValues: Record<string, unknown> = {};

  const html: string[] = [];
  let chartSeq = 0;
  for (const block of blocks) {
    const d = block.data ?? {};
    const id = block.id ?? '';
    switch (block.type) {
    case 'header': {
      const level = typeof d.level === 'number' ? Math.min(6, Math.max(1, d.level)) : 2;
      html.push(`<h${level}>${inlineToHtml(parseInline(str(d.text)))}</h${level}>`);
      break;
    }
    case 'paragraph':
      html.push(`<p>${inlineToHtml(parseInline(str(d.text)))}</p>`);
      break;
    case 'list':
      html.push(listToHtml(toListItems(d.items), d.style === 'ordered'));
      break;
    case 'quote':
      html.push(`<blockquote>${inlineToHtml(parseInline(str(d.text)))}</blockquote>`);
      break;
    case 'code':
      html.push(`<pre><code>${escapeHtml(str(d.code))}</code></pre>`);
      break;
    case 'delimiter':
      html.push('<hr>');
      break;
    case 'slider': {
      const min = num(d.min, 0);
      const max = num(d.max, 100);
      const step = num(d.step, 1);
      const val = num(values.get(id), num(d.initial, min));
      initialValues[id] = val;
      sliders.push({cell: id, min, max, step, name: str(d.name) || nameByCell.get(id) || 'value'});
      html.push(
        `<div class="reactive slider" data-cell="${id}"><label>${escapeHtml(str(d.name) || nameByCell.get(id) || 'value')} ` +
            `<input type="range" min="${min}" max="${max}" step="${step}" value="${val}"> <output>${val}</output></label></div>`,
      );
      break;
    }
    case 'expr':
      exprs.push({cell: id, source: str(d.source)});
      if (values.has(id)) initialValues[id] = values.get(id);
      html.push(
        `<p class="reactive expr" data-cell="${id}"><code>${escapeHtml(str(d.name) || nameByCell.get(id) || 'expr')} = <span data-val>${escapeHtml(formatValue(values.get(id)))}</span></code></p>`,
      );
      break;
    case 'chart': {
      const cid = `chart-${chartSeq++}`;
      const cells = Array.isArray(d.refCellIds) ? (d.refCellIds as string[]) : d.refCellId ? [String(d.refCellId)] : [];
      for (const cell of cells) if (values.has(cell)) initialValues[cell] = values.get(cell);
      charts.push({id: cid, cells});
      html.push(`<figure class="chart" data-chart="${cid}"></figure>`);
      break;
    }
    default:
      break;
    }
  }

  const live = sliders.length > 0 || exprs.length > 0 || charts.length > 0;
  const data = {values: initialValues, sliders, exprs, charts};
  // Classic scripts run before the deferred module, so window.d3/window.Plot
  // exist when the runtime executes — fully offline, no CDN.
  const libs = charts.length > 0 ? `<script>${escapeScript(d3Umd)}</script>\n<script>${escapeScript(plotUmd)}</script>\n` : '';
  const scripts = live
    ? `${libs}<script type="application/json" id="ob-data">${JSON.stringify(data)}</script>\n<script type="module">${RUNTIME}</script>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${STYLES}</style>
</head>
<body>
<main>
<h1 class="doc-title">${icon ? `${escapeHtml(icon)} ` : ''}${escapeHtml(title)}</h1>
${html.join('\n')}
</main>
${scripts}
</body>
</html>`;
}

function num(v: unknown, fallback: number): number {
  const n = typeof v === 'string' ? Number(v) : (v as number);
  return typeof n === 'number' && Number.isFinite(n) ? n : fallback;
}

function toListItems(items: unknown): ListItem[] {
  if (!Array.isArray(items)) return [];
  return items.map((it): ListItem => {
    if (typeof it === 'string') return {runs: parseInline(it), items: []};
    const o = (it ?? {}) as {content?: unknown; items?: unknown};
    return {runs: parseInline(str(o.content)), items: toListItems(o.items)};
  });
}

const STYLES = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body { margin: 0; background: #fff; color: #1a1a1a; font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
@media (prefers-color-scheme: dark) { body { background: #18181b; color: #e7e7ea; } }
main { max-width: 720px; margin: 0 auto; padding: 48px 24px 120px; }
h1.doc-title { font-size: 2.4rem; font-weight: 800; letter-spacing: -.02em; margin: 0 0 1.2rem; }
h1,h2,h3,h4 { font-weight: 700; line-height: 1.25; margin: 1.6em 0 .4em; }
p { margin: .6em 0; }
ul,ol { margin: .4em 0; padding-left: 1.4em; }
blockquote { margin: 1em 0; padding: .2em 0 .2em 1em; border-left: 3px solid currentColor; opacity: .85; font-style: italic; }
pre { background: rgba(127,127,127,.12); padding: 12px 14px; border-radius: 8px; overflow-x: auto; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .9em; }
mark { background: #fde68a; color: inherit; padding: 0 .1em; }
hr { border: none; border-top: 1px solid rgba(127,127,127,.3); width: 30%; margin: 2em auto; }
a.mention { font-weight: 600; text-decoration: underline; text-underline-offset: 2px; }
.reactive { background: rgba(127,127,127,.06); border: 1px solid rgba(127,127,127,.16); border-radius: 8px; padding: 10px 12px; margin: 1em 0; }
.slider input[type=range] { vertical-align: middle; width: 60%; }
.expr code { color: #4f46e5; }
figure.chart { margin: 1.2em 0; }
figure.chart svg { max-width: 100%; height: auto; }
`;

// Inlined live runtime: recomputes expressions from slider values and redraws
// charts. Reuses the saved `__C__{cellId}__` reference tokens. Observable Plot
// (and d3) are inlined as classic scripts above, so this works offline.
const RUNTIME = `
const Plot = (typeof window !== "undefined" && window.Plot) || null;
const D = JSON.parse(document.getElementById("ob-data").textContent);
const store = new Map(Object.entries(D.values));
const get = (id) => store.get(id);
const fmt = (v) => v === undefined ? "—" : typeof v === "number" ? (Number.isInteger(v) ? ""+v : ""+(Math.round(v*1000)/1000)) : Array.isArray(v) ? "["+v.slice(0,8).join(", ")+(v.length>8?", …":"")+"]" : JSON.stringify(v);
function evalExpr(src){ const code = src.replace(/__C__\\{([^}]+)\\}__/g, (_,id)=>"get("+JSON.stringify(id)+")"); try { return new Function("get","return ("+code+");")(get); } catch(e){ return undefined; } }
function normalize(v,name){ if(Array.isArray(v)&&v.every(n=>typeof n==="number")) return [{name,data:v}]; if(v&&Array.isArray(v.series)) return v.series.map(s=>({name:String(s.name),data:(s.data||[]).filter(n=>typeof n==="number")})); return []; }
function recompute(){
  for (const e of D.exprs) store.set(e.cell, evalExpr(e.source));
  for (const e of D.exprs){ const el=document.querySelector('[data-cell="'+e.cell+'"] [data-val]'); if(el) el.textContent = fmt(get(e.cell)); }
  for (const c of D.charts){
    const fig = document.querySelector('[data-chart="'+c.id+'"]'); if(!fig) continue;
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
