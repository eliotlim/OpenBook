import {test, expect} from './fixtures';
import {SERVER} from './seed';

// The dataflow view: the page's reactive wiring as a live react-flow graph
// in the split pane — inputs → live code → charts/lights, values updating as
// the document changes, node clicks locating their block in the editor.

const reactivePage = (tag: string) => ({
  name: `Dataflow ${tag}`,
  data: {
    editor: 'blocks',
    blockdoc: {
      blocks: [
        {id: 'd1', type: 'paragraph', text: [{t: 'A tiny reactive model.'}]},
        {id: 'sld', type: 'slider', props: {name: 'rate', value: 5, min: 0, max: 10}},
        {id: 'num', type: 'number', props: {name: 'years', value: 3}},
        {id: 'lc', type: 'code', text: [{t: 'rate * years'}], props: {live: true, name: 'total'}},
        {id: 'chart', type: 'kitchart', props: {kind: 'bar', title: 'Growth', source: '[rate, total]'}},
        {id: 'light', type: 'statuslight', props: {label: 'Healthy', source: 'total > 10'}},
      ],
    },
    editorjs: {blocks: []},
    values: [],
    names: [],
  },
});

test('dataflow view: graph renders, values follow edits, node click locates the block', async ({page, request}) => {
  const res = await request.post(`${SERVER}/api/pages`, {data: reactivePage(`${Date.now()}`)});
  const {id} = (await res.json()) as {id: string};
  await page.goto(`/?page=${id}`);
  await expect(page.getByRole('button', {name: 'Page actions'})).toBeVisible();

  // Open from the page menu.
  await page.getByRole('button', {name: 'Page actions'}).click();
  await page.getByRole('menuitem', {name: 'Dataflow view'}).click();
  const view = page.locator('[data-dataflow-view]');
  await expect(view).toBeVisible();

  // Five reactive nodes (prose stays out), wired left to right.
  await expect(view.locator('[data-flow-node]')).toHaveCount(5);
  await expect(view.locator('[data-flow-node="input"]')).toHaveCount(2);
  const codeNode = view.locator('[data-flow-node="code"]');
  await expect(codeNode).toContainText('total');
  await expect(codeNode.locator('[data-flow-value]')).toHaveText('15');

  // Live: dragging the slider in the editor updates the graph value.
  await page.getByLabel('rate value').fill('8');
  await expect(codeNode.locator('[data-flow-value]')).toHaveText('24');

  // Clicking a node walks to (and flashes) its block in the editor pane.
  await codeNode.click();
  await expect(page.locator('[data-block-row="lc"]')).toHaveClass(/obe-locate-flash/);

  // The split survives a reload (?split=flow in the URL).
  await expect(page).toHaveURL(/split=flow/);
  await page.reload();
  await expect(page.locator('[data-dataflow-view]')).toBeVisible();
  await expect(page.locator('[data-flow-node]')).toHaveCount(5);
});

test('dataflow view: a page with no reactive blocks shows the empty state', async ({page, request}) => {
  const res = await request.post(`${SERVER}/api/pages`, {
    data: {
      name: `Dataflow Empty ${Date.now()}`,
      data: {
        editor: 'blocks',
        blockdoc: {blocks: [{id: 'p1', type: 'paragraph', text: [{t: 'Just prose.'}]}]},
        editorjs: {blocks: []},
        values: [],
        names: [],
      },
    },
  });
  const {id} = (await res.json()) as {id: string};
  await page.goto(`/?page=${id}&split=flow`);
  await expect(page.locator('[data-dataflow-empty]')).toBeVisible();
});
