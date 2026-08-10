import {describe, it, expect, vi} from 'vitest';
import type {PageSnapshot} from '@book.dev/sdk';
import {createDoc, encodeSnapshot, type NewBlock} from '../../blockeditor/model';
import {projectSnapshotForExport} from '../../blockeditor/exportBlocks';
import {buildDocumentModel} from '../documentModel';
import {toHtml, toSlideDeck} from '../toHtml';
import {toMarkdown} from '../toMarkdown';
import {buildChartSvg} from '../chartSvg';
import type {NormalizedSeries} from '../chartNormalize';

/**
 * Exports start from a CRDT block document (`editor: 'blocks'` + `blockdoc`), not
 * the export-projection shape the other tests feed directly. This exercises that real path:
 * the reactive graph must be resolved the way the live editor resolves it, so a
 * static export shows the SAME computed numbers, chart series, status-light state,
 * and progress as the window — instead of empty `—` cells.
 */

const DOC: NewBlock[] = [
  {type: 'heading', text: [{t: 'Shop'}], props: {level: 2}},
  {type: 'code', text: [{t: 'Math.min(aldi, tesco)'}], props: {live: true, name: 'best', language: 'js', collapsed: true}},
  {type: 'code', text: [{t: '"Cheapest at " + best'}], props: {live: true, name: 'headline', language: 'js', collapsed: true}},
  {type: 'slider', props: {name: 'aldi', label: 'Aldi', value: 86, min: 30, max: 200}},
  {type: 'slider', props: {name: 'tesco', label: 'Tesco', value: 99, min: 30, max: 200}},
  {type: 'number', props: {name: 'budget', label: 'Budget', value: 120, min: 40, max: 300, step: 5}},
  {type: 'kitchart', props: {kind: 'bar', title: 'Baskets', labels: 'Aldi, Tesco', source: '[aldi, tesco]'}},
  {type: 'statuslight', props: {label: 'Within budget', source: 'budget - best', okAt: 0, warnAt: -20}},
  {type: 'progressbar', props: {label: 'Budget used', source: 'best / budget', max: 1, format: 'percent'}},
  {type: 'divider'},
  {type: 'heading', text: [{t: 'Notes'}], props: {level: 2}},
  {type: 'notes', text: [{t: 'speaker only'}]},
  {type: 'callout', text: [{t: 'Tip'}], props: {variant: 'success'}},
];

const blockSnapshot = (): PageSnapshot => {
  const doc = createDoc(DOC);
  return {editorjs: {blocks: []}, values: [], names: [], editor: 'blocks', blockdoc: encodeSnapshot(doc)} as never;
};

describe('reactive export from a block document', () => {
  it('sandboxes document formulas on the synchronous export path', () => {
    const invoke = vi.fn();
    const host = globalThis as typeof globalThis & {
      __TAURI_INTERNALS__?: {invoke: typeof invoke};
    };
    host.__TAURI_INTERNALS__ = {invoke};
    try {
      const snapshot = (): PageSnapshot => ({
        editorjs: {blocks: []},
        values: [],
        names: [],
        editor: 'blocks',
        blockdoc: encodeSnapshot(createDoc([{
          type: 'code',
          text: [{t: 'globalThis.__TAURI_INTERNALS__?.invoke?.("api_request", {path: "/keychain"})'}],
          props: {live: true, name: 'attempt', language: 'js'},
        }])),
      }) as never;
      const model = buildDocumentModel({title: 'T', icon: '', snapshot: snapshot()});
      expect((model.blocks.find((block) => block.type === 'expr') as {value?: unknown})?.value).toBeUndefined();
      expect(invoke).not.toHaveBeenCalled();
    } finally {
      delete host.__TAURI_INTERNALS__;
    }
  });

  it('resolves the reactive graph into the document model (matches the editor)', () => {
    const model = buildDocumentModel({title: 'T', icon: '🛒', snapshot: blockSnapshot()});
    const byType = (t: string) => model.blocks.filter((b) => b.type === t);

    // Live code computes its real value (best = min(86,99) = 86; headline derives it).
    const exprs = byType('expr') as Array<{name: string; value: unknown}>;
    expect(exprs.find((e) => e.name === 'best')?.value).toBe(86);
    expect(exprs.find((e) => e.name === 'headline')?.value).toBe('Cheapest at 86');

    // The chart carries its computed series + kind (not an empty cell).
    const chart = byType('chart')[0] as {series: Array<{data: number[]}>; kind: string; value: unknown};
    expect(chart.kind).toBe('bar');
    expect(chart.value).toEqual([86, 99]);

    // The status light resolves to a 3-state colour (budget 120 - best 86 = 34 ≥ okAt 0 → ok).
    const light = byType('light')[0] as {status: string; value: unknown};
    expect(light.status).toBe('ok');
    expect(light.value).toBe(34);

    // The progress bar resolves to a percentage (86 / 120 ≈ 72%).
    const progress = byType('progress')[0] as {pct: number; readout: string};
    expect(progress.pct).toBe(72);
    expect(progress.readout).toBe('72%');

    // Speaker notes never export; the chart's data cell is hidden (no `Baskets = …`).
    expect(model.blocks.some((b) => b.type === 'unknown')).toBe(false);
    expect(exprs.some((e) => e.name === 'Baskets')).toBe(false);
  });

  it('renders the resolved values into Markdown', () => {
    const md = toMarkdown(buildDocumentModel({title: 'T', icon: '🛒', snapshot: blockSnapshot()}));
    expect(md).toContain('**best** = 86');
    expect(md).toContain('**headline** = Cheapest at 86');
    expect(md).toContain('🟢 **Within budget** — 34');
    expect(md).toContain('**Budget used:** 72%');
    expect(md).toContain('**Baskets**'); // chart title + series, not "Baskets = —"
    expect(md).not.toContain('= —');
    expect(md).not.toContain('speaker only'); // notes stripped
  });

  it('renders interactive HTML with computed values, a 3-state light, a bar, and a drawn chart', () => {
    const html = toHtml(blockSnapshot(), 'T', '🛒');
    // The static first-paint body carries the fully computed render (also what
    // the no-JS fallback and the PDF pipeline consume).
    expect(html).toContain('<span data-val>86</span>'); // best
    expect(html).toContain('data-status="ok"'); // status light colour
    expect(html).toContain('width:72%'); // progress fill
    expect(html).toContain('<figcaption class="chart-title">Baskets</figcaption>');
    expect(html).toContain('<svg'); // the kit chart is drawn at build time (first paint)
    expect(html).not.toContain('= <span data-val>—</span>'); // nothing left uncomputed
    // Block-doc exports hydrate through the vendored viewer (the island is the
    // mount source) — the bespoke #ob-data runtime is retired on this path.
    expect(html).toContain('OpenBookViewer');
    expect(html).toContain('__OB_NO_HYDRATE'); // the PDF pipeline's static opt-out
    expect(html).not.toContain('id="ob-data"');
  });

  it('splits a divider-delimited deck and keeps widgets live', () => {
    const html = toSlideDeck(blockSnapshot(), 'T', '🛒');
    expect((html.match(/class="slide"/g) ?? []).length).toBe(2);
    expect(html).toContain('data-status="ok"');
    expect(html).toContain('id="ob-data"');
    expect(html).toContain('<section class="slide" data-current>'); // first slide visible on first paint

  });

  // OB-378: exports inline the canonical soft-pastel data palette (self-contained:
  // no live CSS vars), so an exported doc's colours match the in-app render.
  it('inlines the canonical soft-pastel palette for status lights and kit charts', () => {
    const html = toHtml(blockSnapshot(), 'T', '🛒');
    // Status-light CSS: soft-pastel green `ok` (#9fdf9f), the 25%-alpha ring, and
    // the pastel/muted light-mode hairline. Warn is yellow, bad is red.
    expect(html).toContain('.kitlight[data-status=ok] .kit-light-dot { background: #9fdf9f;');
    expect(html).toContain('0 0 0 3px rgba(159,223,159,0.25)');
    expect(html).toContain('inset 0 0 0 1px rgba(0,0,0,0.12)');
    expect(html).toContain('.kitlight[data-status=warn] .kit-light-dot { background: #dac495;'); // yellow
    expect(html).toContain('.kitlight[data-status=bad] .kit-light-dot { background: #deaea6;'); // red
    // The drawn kit bar (series 0) uses the canonical blue-first SERIES_ORDER fill.
    expect(html).toContain('fill="#a9ccdf"');
  });

  it('prepends the canonical KIT_PALETTE to the live chart runtime (no drift)', () => {
    const html = toSlideDeck(blockSnapshot(), 'T', '🛒'); // legacy runtime path (#ob-data)
    // The blue-first SERIES_ORDER, resolved to soft-pastel fills, is inlined as
    // the runtime palette — one source shared with the in-app kit charts.
    expect(html).toContain('const KIT_PALETTE=["#a9ccdf","#debea6","#9fdf9f","#cdade1"');
  });

  // OB-379: the export bakes the ACTIVE data-colour scheme (not always pastel),
  // so a Vivid/Muted user's file is self-contained in their chosen colours.
  it('bakes the chosen data-colour scheme into charts, status lights, and the viewer', () => {
    const vivid = toHtml(blockSnapshot(), 'T', '🛒', undefined, {}, 'vivid');
    // Status-light green + drawn kit bar swap pastel → the vivid set. (The inlined
    // viewer bundle still carries pastel fallback literals in its code — it repaints
    // to vivid at runtime via the scheme global — so only the emitted CSS/SVG asserts.)
    expect(vivid).toContain('.kitlight[data-status=ok] .kit-light-dot { background: #22c55e;');
    expect(vivid).toContain('fill="#3b82f6"'); // vivid blue (series 0), not pastel #a9ccdf
    // The provider-less viewer bundle is told which scheme to paint.
    expect(vivid).toContain('window.__OB_DATA_SCHEME="vivid"');

    // The legacy runtime path (deck) inlines the vivid palette too.
    const deck = toSlideDeck(blockSnapshot(), 'T', '🛒', undefined, {}, 'muted');
    expect(deck).toContain('const KIT_PALETTE=["#778db1"'); // muted blue leads SERIES_ORDER
  });

  // PDF is now rendered from the HTML in a real browser (dom-to-svg → svg2pdf),
  // so it can't run under happy-dom — its coverage lives in the e2e suite
  // (export.spec.ts downloads + validates the paged/continuous PDFs).
});

// OB-380: a kind-less reactive chart (a chart cell with no fixed `kind`) exports
// via Observable Plot. Its colour range is the canonical data palette for the
// active scheme — the same blue-first SERIES_ORDER fills the kit/db charts use —
// not Plot's default categorical scheme, so an exported chart colour-matches the
// window. Both the client runtime (inlined) and the server SVG path are covered.
describe('kind-less (Plot) reactive chart export uses the canonical palette (OB-380)', () => {
  const multiSeries: NormalizedSeries[] = [
    {name: 'A', data: [1, 2, 3]},
    {name: 'B', data: [3, 2, 1]},
    {name: 'C', data: [2, 2, 2]},
  ];

  it('server SVG paints the SERIES_ORDER fills (blue/orange/green), not Plot defaults', () => {
    const pastel = buildChartSvg(multiSeries);
    expect(pastel).not.toBeNull();
    const svg = pastel!.outerHTML;
    // Series 0/1/2 → canonical pastel blue/orange/green (SERIES_ORDER lead trio),
    // inlined as concrete `stroke` hex — Plot's default scheme would lead elsewhere.
    expect(svg).toContain('stroke="#a9ccdf"'); // blue
    expect(svg).toContain('stroke="#debea6"'); // orange
    expect(svg).toContain('stroke="#9fdf9f"'); // green
    // The passed scheme is honoured — vivid swaps to the saturated set.
    const vivid = buildChartSvg(multiSeries, 600, '#111111', 'vivid');
    expect(vivid!.outerHTML).toContain('stroke="#3b82f6"'); // vivid blue (not pastel #a9ccdf)
  });

  it('client runtime sets Plot color.range to the inlined KIT_PALETTE (self-contained)', () => {
    const deck = toSlideDeck(blockSnapshot(), 'T', '🛒'); // legacy runtime path (#ob-data)
    // The kind-less Plot spec draws its series colours from the prepended palette
    // const (not Plot's default scheme); the const inlines the pastel fills, so the
    // export needs no live CSS vars or app modules at runtime.
    expect(deck).toContain('color:{range:KIT_PALETTE,legend:series.length>1}');
    expect(deck).toContain('const KIT_PALETTE=["#a9ccdf"'); // pastel blue leads SERIES_ORDER
    // A vivid export bakes the vivid fills into that same range.
    const vividDeck = toSlideDeck(blockSnapshot(), 'T', '🛒', undefined, {}, 'vivid');
    expect(vividDeck).toContain('color:{range:KIT_PALETTE,legend:series.length>1}');
    expect(vividDeck).toContain('const KIT_PALETTE=["#3b82f6"'); // vivid blue leads
  });
});

// Inline marks, columns, and every chart kind must survive the projection into
// each export format (these are the fidelity gaps the polish pass closed).
describe('export block fidelity', () => {
  const fancy = (): PageSnapshot => {
    const doc = createDoc([
      {type: 'paragraph', text: [
        {t: 'B', a: {b: true}}, {t: 'I', a: {i: true}}, {t: 'U', a: {u: true}}, {t: 'S', a: {s: true}}, {t: 'C', a: {c: true}},
        {t: 'L', a: {a: 'https://x.test'}},
      ]},
      {type: 'columns', children: [
        {type: 'column', children: [{type: 'paragraph', text: [{t: 'LEFTCOL'}]}]},
        {type: 'column', children: [{type: 'paragraph', text: [{t: 'RIGHTCOL'}]}]},
      ]},
      {type: 'kitchart', props: {kind: 'pie', title: 'Slices', source: '{Red: 2, Blue: 3}'}},
    ]);
    return {editorjs: {blocks: []}, values: [], names: [], editor: 'blocks', blockdoc: encodeSnapshot(doc)} as never;
  };

  it('preserves bold/italic/underline/strike/code/link in HTML and Markdown', () => {
    const html = toHtml(fancy(), 'T', '');
    expect(html).toContain('<strong>B</strong>');
    expect(html).toContain('<em>I</em>');
    expect(html).toContain('<u>U</u>');
    expect(html).toContain('<s>S</s>');
    expect(html).toContain('<code>C</code>');
    expect(html).toContain('href="https://x.test"');
    const md = toMarkdown(buildDocumentModel({title: 'T', icon: '', snapshot: fancy()}));
    expect(md).toContain('**B**');
    expect(md).toContain('*I*');
    expect(md).toContain('~~S~~');
    expect(md).toContain('[L](https://x.test)');
  });

  it('carries text colour + highlight tint into HTML (from palette tokens)', () => {
    const doc = createDoc([
      {type: 'paragraph', text: [
        {t: 'red', a: {tc: 'red'}}, {t: ' and '}, {t: 'lit', a: {hl: 'yellow'}},
      ]},
    ]);
    const snap = {editorjs: {blocks: []}, values: [], names: [], editor: 'blocks', blockdoc: encodeSnapshot(doc)} as never;
    const html = toHtml(snap, 'T', '');
    // Text colour re-emits as a var() with the light hex as the fallback. The
    // HYDRATE path is light-only v1 (the viewer bundle has no dark theme), so
    // the var() just falls back; the brighter dark override is only defined on
    // the legacy/no-hydrate path, whose static body honours the OS scheme.
    expect(html).toContain('color:var(--obtc-red, #b91c1c)');
    expect(html).not.toContain('--obtc-red: #f87171'); // no dark override on the light-only hydrate path
    const legacy = toHtml({editorjs: {blocks: [{type: 'paragraph', data: {text: 'x'}}]}, values: [], names: []} as never, 'T', '');
    expect(legacy).toContain('--obtc-red: #f87171'); // dark-capable legacy path keeps it
    expect(html).toMatch(/<mark style="background:#fef3c7">lit<\/mark>/); // yellow highlight tint
    // The document model resolves the run colours so the PDF can use them.
    const model = buildDocumentModel({title: 'T', icon: '', snapshot: snap});
    const para = model.blocks.find((b) => b.type === 'paragraph') as {runs: Array<{color?: string; markerColor?: string}>};
    expect(para.runs.find((r) => r.color)?.color).toBe('#b91c1c');
    expect(para.runs.find((r) => r.markerColor)?.markerColor).toBe('#fef3c7');
  });

  it('lays columns side-by-side in HTML but flattens them for Markdown', () => {
    const html = toHtml(fancy(), 'T', '');
    expect(html).toContain('<div class="cols">');
    expect(html).toMatch(/<div class="col">[\s\S]*LEFTCOL[\s\S]*<\/div><div class="col">[\s\S]*RIGHTCOL/);
    const md = toMarkdown(buildDocumentModel({title: 'T', icon: '', snapshot: fancy()}));
    expect(md).toContain('LEFTCOL');
    expect(md).toContain('RIGHTCOL');
    expect(md).not.toContain('class="cols"');
  });

  it('summarises a pie chart by label:value in Markdown', () => {
    const md = toMarkdown(buildDocumentModel({title: 'T', icon: '', snapshot: fancy()}));
    expect(md).toContain('**Slices**');
    expect(md).toContain('- Red: 2');
    expect(md).toContain('- Blue: 3');
  });

  // The intake template binds a progress bar to a gated accordion's auto-computed
  // completion (`intake.ratio`) — a container-completion signal that must resolve
  // in the export the same way it does live.
  it('resolves a gated-accordion completion into a progress bar', () => {
    const doc = createDoc([
      {type: 'accordion', props: {name: 'intake', gated: true}, children: [
        {type: 'accordionsection', props: {label: 'A'}, children: [{type: 'textfield', props: {name: 'goal', value: 'ship'}}]},
        {type: 'accordionsection', props: {label: 'B'}, children: [{type: 'textfield', props: {name: 'scope', value: ''}}]},
      ]},
      {type: 'progressbar', props: {label: 'Completed', source: 'intake.ratio', max: 1, format: 'percent'}},
    ]);
    const snap = {editorjs: {blocks: []}, values: [], names: [], editor: 'blocks', blockdoc: encodeSnapshot(doc)} as never;
    const model = buildDocumentModel({title: 'T', icon: '', snapshot: snap});
    const progress = model.blocks.find((b) => b.type === 'progress') as {pct: number} | undefined;
    expect(progress?.pct).toBe(50); // one of two fields filled → 50%
    expect(toHtml(snap, 'T', '')).toContain('width:50%');
  });

  // The savings template's live code returns an object of arrays (multi-series);
  // the chart and the Markdown summary must both read it.
  it('handles a multi-series object chart (object of arrays)', () => {
    const doc = createDoc([
      {type: 'code', text: [{t: 'return {Invested: [10, 20, 30], Projected: [10, 25, 44]}'}], props: {live: true, name: 'proj'}},
      {type: 'kitchart', props: {kind: 'area', title: 'Balance', source: 'proj'}},
    ]);
    const snap = {editorjs: {blocks: []}, values: [], names: [], editor: 'blocks', blockdoc: encodeSnapshot(doc)} as never;
    const md = toMarkdown(buildDocumentModel({title: 'T', icon: '', snapshot: snap}));
    expect(md).toContain('**Balance**');
    expect(md).toContain('- Invested: 10, 20, 30');
    expect(md).toContain('- Projected: 10, 25, 44');
  });
});

// The interactive HTML runtime resolves reactive references by rewriting names to
// cell tokens (the static seed alone isn't enough — `recompute()` runs on load and
// in a real browser overwrites any reference it can't resolve with `undefined`).
// These guard the two gaps that made real docs export as "everything undefined":
// formula→formula references, and reactive content nested inside a `group`.
describe('export runtime reference resolution', () => {
  type Out = {editorjs: {blocks: Array<{type?: string; data?: Record<string, unknown>}>}; names: Array<[string, string]>};
  const project = (blocks: NewBlock[]): Out =>
    projectSnapshotForExport({editorjs: {blocks: []}, values: [], names: [], editor: 'blocks', blockdoc: encodeSnapshot(createDoc(blocks))} as never) as unknown as Out;

  it('tokenizes formula→formula references so dependents stay live (not undefined)', () => {
    const out = project([
      {type: 'slider', props: {name: 'price', label: 'Price', value: 50, min: 0, max: 100}},
      {type: 'formula', props: {name: 'total', source: 'price * 2'}},
      {type: 'formula', props: {name: 'withTax', source: 'total * 1.2'}},
    ]);
    const withTax = out.editorjs.blocks.find((b) => b.type === 'expr' && b.data?.name === 'withTax');
    // `total` (a formula) must be rewritten to a cell token, not left as a bare
    // name the runtime can't resolve → undefined.
    expect(String(withTax?.data?.source)).toMatch(/__C__\{[^}]+\}__ \* 1\.2/);
    // And the formula publishes its name (cell→name), like live code does.
    expect(out.names.some(([n]) => n === 'total')).toBe(true);
    expect(out.editorjs.blocks.find((b) => b.type === 'expr' && b.data?.name === 'total')).toBeTruthy();
  });

  it('emits reactive children of a group (they were dropped entirely before)', () => {
    const out = project([
      {type: 'group', props: {name: 'box'}, children: [
        {type: 'number', props: {name: 'b', label: 'B', value: 5, min: 0, max: 100}},
        {type: 'code', text: [{t: 'b + 1'}], props: {live: true, name: 'inc', language: 'js'}},
      ]},
    ]);
    expect(out.editorjs.blocks.some((b) => b.type === 'slider')).toBe(true); // the number input
    expect(out.editorjs.blocks.some((b) => b.type === 'expr' && b.data?.name === 'inc')).toBe(true);
  });

  it('tokenizes a grouped input by its namespaced ref (group.field.value)', () => {
    const out = project([
      {type: 'group', props: {name: 'inputs'}, children: [
        {type: 'slider', props: {name: 'revenue', label: 'Revenue', value: 240, min: 0, max: 500}},
      ]},
      // The editor scopes the grouped slider as `inputs.revenue.value`; the export
      // must rewrite that WHOLE reference to a cell token — not the bare `revenue`
      // word mid-path (which would leave `inputs.<token>.value` → undefined).
      {type: 'code', text: [{t: 'inputs.revenue.value * 2'}], props: {live: true, name: 'doubled', language: 'js'}},
    ]);
    const doubled = out.editorjs.blocks.find((b) => b.type === 'expr' && b.data?.name === 'doubled');
    expect(String(doubled?.data?.source)).toMatch(/^__C__\{[^}]+\}__ \* 2$/);
  });
});
