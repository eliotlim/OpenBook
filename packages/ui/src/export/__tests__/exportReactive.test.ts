import {describe, it, expect} from 'vitest';
import type {PageSnapshot} from '@open-book/sdk';
import {createDoc, encodeSnapshot, type NewBlock} from '../../blockeditor/model';
import {buildDocumentModel} from '../documentModel';
import {toHtml, toSlideDeck} from '../toHtml';
import {toMarkdown} from '../toMarkdown';
import {toPdf} from '../toPdf';

/**
 * Exports start from a CRDT block document (`editor: 'blocks'` + `blockdoc`), not
 * the EditorJS shape the other tests feed directly. This exercises that real path:
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
    expect(html).toContain('<span data-val>86</span>'); // best
    expect(html).toContain('data-status="ok"'); // status light colour
    expect(html).toContain('width:72%'); // progress fill
    expect(html).toContain('<figcaption class="chart-title">Baskets</figcaption>');
    expect(html).toContain('<svg'); // the kit chart is drawn at build time (first paint)
    expect(html).toContain('id="ob-data"'); // live runtime seeded
    expect(html).not.toContain('= <span data-val>—</span>'); // nothing left uncomputed
  });

  it('splits a divider-delimited deck and keeps widgets live', () => {
    const html = toSlideDeck(blockSnapshot(), 'T', '🛒');
    expect((html.match(/class="slide"/g) ?? []).length).toBe(2);
    expect(html).toContain('data-status="ok"');
    expect(html).toContain('id="ob-data"');
    expect(html).toContain('<section class="slide" data-current>'); // first slide visible on first paint

  });

  it('produces valid paged + continuous PDFs', async () => {
    const model = buildDocumentModel({title: 'T', icon: '🛒', snapshot: blockSnapshot()});
    for (const mode of ['paged', 'continuous'] as const) {
      const blob = await toPdf(model, mode);
      const head = new Uint8Array(await blob.arrayBuffer()).subarray(0, 5);
      expect(String.fromCharCode(...head)).toBe('%PDF-');
    }
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
    // Text colour re-emits as a var() with the light hex as the fallback, so light
    // mode shows #b91c1c and dark mode picks up the brighter --obtc-red override.
    expect(html).toContain('color:var(--obtc-red, #b91c1c)');
    expect(html).toContain('--obtc-red: #f87171'); // dark-mode override defined
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
