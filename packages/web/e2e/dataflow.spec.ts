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

test('dataflow composition: a row page shows its exports flowing into the parent', async ({page, request}) => {
  const tag = `${Date.now()}`;
  // A parent page hosting a database with an expr column reading `total`.
  const host = await request.post(`${SERVER}/api/pages`, {
    data: {name: `Projects ${tag}`, data: {editorjs: {blocks: []}, values: [], names: []}},
  });
  const hostId = ((await host.json()) as {id: string}).id;
  const db = await request.post(`${SERVER}/api/databases`, {
    data: {
      pageId: hostId,
      name: 'Projects',
      schema: {
        properties: [{id: 'p_total', name: 'Total', type: 'expr', cellName: 'total'}],
        views: [{id: 'v_table', name: 'Table', type: 'table', filters: [], sorts: []}],
      },
    },
  });
  const dbId = ((await db.json()) as {id: string}).id;
  const row = await request.post(`${SERVER}/api/databases/${dbId}/rows`, {data: {name: `Row ${tag}`, properties: {}}});
  const rowId = ((await row.json()) as {id: string}).id;
  // The row's own document: a reactive model exporting `total`.
  await request.put(`${SERVER}/api/pages/${rowId}`, {
    data: {
      name: `Row ${tag}`,
      data: reactivePage(tag).data,
    },
  });

  await page.goto(`/?page=${rowId}&split=flow`);
  await expect(page.locator('[data-dataflow-view]')).toBeVisible();

  // The outlet node: the parent's expr column, labeled with where it lands.
  const outlet = page.locator('[data-flow-node="outlet"]');
  await expect(outlet).toContainText('Total');
  await expect(outlet.locator('[data-flow-outlet-page]')).toContainText(`Projects ${tag}`);

  // Drive the model, let the save debounce flush the new exports…
  await page.getByLabel('rate value').fill('8');
  await expect(page.locator('[data-flow-node="code"] [data-flow-value]')).toHaveText('24');
  await page.waitForTimeout(900);

  // …then walk up via the outlet: the parent's expr cell carries the value.
  await outlet.click();
  await expect(page).toHaveURL(new RegExp(`page=${hostId}`));
  await expect(page.getByRole('table')).toContainText('24');
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
