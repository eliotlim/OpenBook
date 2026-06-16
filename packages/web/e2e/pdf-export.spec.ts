import {test, expect} from './fixtures';
import {readFile} from 'node:fs/promises';
import {newPage as seedPage} from './seed';
import type {Page} from '@playwright/test';

// The PDF export renders the HTML export through dom-to-svg → svg2pdf (vector,
// selectable — not a screenshot). This exercises the real reactive block-doc
// path including the cases that used to export as "undefined": a formula that
// references another formula, and reactive content nested inside a `group`.
const BLOCKS = [
  {id: 'h', type: 'heading', text: [{t: 'Quarter close'}], props: {level: 1}},
  {id: 'p', type: 'paragraph', text: [{t: 'Status: '}, {t: 'on track', a: {b: true, hl: 'green'}}, {t: ' — '}, {t: 'watch spend', a: {tc: 'red'}}, {t: '.'}]},
  {id: 'c1', type: 'code', text: [{t: 'Math.round(revenue - cost)'}], props: {live: true, name: 'profit', language: 'js', collapsed: true}},
  {id: 'g', type: 'group', props: {name: 'inputs'}, children: [
    {id: 's1', type: 'slider', props: {name: 'revenue', label: 'Revenue (k)', value: 240, min: 0, max: 500}},
    {id: 's2', type: 'slider', props: {name: 'cost', label: 'Cost (k)', value: 180, min: 0, max: 500}},
    {id: 'f1', type: 'formula', props: {name: 'margin', source: 'profit / revenue'}},
    {id: 'f2', type: 'formula', props: {name: 'marginPct', source: 'Math.round(margin * 100)'}},
  ]},
  {id: 'call', type: 'callout', text: [{t: 'Keep margin above 20% to stay healthy.'}], props: {variant: 'success'}},
  {id: 'ch', type: 'kitchart', props: {kind: 'bar', title: 'Revenue vs cost', labels: 'Revenue, Cost', source: '[revenue, cost]'}},
  {id: 'sl', type: 'statuslight', props: {label: 'Profitable', source: 'profit', okAt: 0, warnAt: -20}},
  {id: 'pr', type: 'progressbar', props: {label: 'Margin', source: 'margin', max: 1, format: 'percent'}},
];

async function exportPdf(page: Page, item: string) {
  await page.getByRole('button', {name: 'Page actions'}).click();
  await page.getByRole('menuitem', {name: 'Export'}).click();
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', {name: item}).click()]);
  return dl;
}

test('reactive block-doc exports a vector PDF (paged + continuous)', async ({page, request}) => {
  const id = await seedPage(request, 'Quarter close', {editorjs: {blocks: []}, values: [], names: [], editor: 'blocks', blockdoc: {blocks: BLOCKS}} as never);
  await page.goto(`/?page=${id}`);
  await expect(page.getByRole('button', {name: 'Page actions'})).toBeVisible();

  for (const item of ['PDF — paged', 'PDF — continuous']) {
    const dl = await exportPdf(page, item);
    expect(dl.suggestedFilename()).toBe('Quarter close.pdf');
    const bytes = await readFile(await dl.path());
    expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-'); // vector PDF, not a raster image
    expect(bytes.byteLength).toBeGreaterThan(4000); // real content rendered (charts, text, widgets)
  }
});
