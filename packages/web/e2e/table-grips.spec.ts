import type {APIRequestContext} from '@playwright/test';
import {expect, test} from './fixtures';
import {newPage} from './seed';

test.describe.configure({mode: 'parallel'});

type Rect = {x: number; y: number; width: number; height: number};

function rectanglesIntersect(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

async function columnsPage(request: APIRequestContext): Promise<string> {
  return newPage(request, `TABLE-2 columns ${Date.now()}`, {
    editor: 'blocks',
    blockdoc: {
      blocks: [{
        id: 'layout',
        type: 'columns',
        children: [0, 1].map((i) => ({
          id: `col-${i}`,
          type: 'column',
          props: {span: 6},
          children: [{id: `text-${i}`, type: 'paragraph', text: [{t: `Column ${i + 1}`}]}],
        })),
      }],
    },
    editorjs: {blocks: []},
    values: [],
    names: [],
  });
}

async function freshTable(page: import('@playwright/test').Page): Promise<import('@playwright/test').Locator> {
  await page.addInitScript(() => {
    localStorage.removeItem('obe-lab-doc');
  });
  await page.goto('/editor-lab');
  const lastText = page.locator('.obe-text').last();
  await lastText.click();
  await page.keyboard.press('ControlOrMeta+ArrowDown');
  await page.keyboard.press('Enter');
  await page.keyboard.type('/table');
  await page.keyboard.press('Enter');
  const table = page.locator('.obe-table');
  await expect(table).toBeVisible();
  return table;
}

async function mergeTopLeft2x2(page: import('@playwright/test').Page): Promise<import('@playwright/test').Locator> {
  const table = await freshTable(page);
  const cells = table.locator('td');
  const from = (await cells.nth(0).boundingBox())!;
  const to = (await cells.nth(4).boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, {steps: 10});
  await page.mouse.up();
  await expect(table.locator('td.obe-cell-selected')).toHaveCount(4);
  await cells.nth(0).click({button: 'right'});
  await page.getByRole('menuitem', {name: 'Merge cells'}).click();
  await expect(table.locator('tbody > tr').nth(0).locator('td').first()).toHaveAttribute('colspan', '2');
  await expect(table.locator('tbody > tr').nth(0).locator('td').first()).toHaveAttribute('rowspan', '2');
  return table;
}

test('table fills the content column without blocking the block drag handle', {tag: ['@editor', '@p1']}, async ({
  page,
}) => {
  const table = await freshTable(page);
  const paragraph = page.locator('.obe-row[data-block-type="paragraph"] .obe-text').first();
  const tableBox = (await table.boundingBox())!;
  const paragraphBox = (await paragraph.boundingBox())!;
  expect(Math.abs(tableBox.x - paragraphBox.x)).toBeLessThanOrEqual(1);

  const tableBlock = table.locator('xpath=ancestor::*[contains(concat(" ", normalize-space(@class), " "), " obe-row ")][1]');
  const bodyRow = table.locator('tbody > tr').first();
  await bodyRow.hover();
  const rowGrip = bodyRow.locator('.obe-table-row-grip');
  await expect(rowGrip).toBeVisible();

  const dragHandle = tableBlock.locator('.obe-gutter .obe-handle');
  const gripBox = (await rowGrip.boundingBox())!;
  const handleBox = (await dragHandle.boundingBox())!;
  expect(rectanglesIntersect(gripBox, handleBox)).toBe(false);

  const hitTargetIsHandle = await dragHandle.evaluate((handle) => {
    const box = handle.getBoundingClientRect();
    return document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)?.closest('.obe-handle') === handle;
  });
  expect(hitTargetIsHandle).toBe(true);
});

test.describe('in columns', () => {
  test.use({freshWorkspace: true});

  test('row grip stays outside the cells inside a column layout', {tag: ['@editor', '@p1']}, async ({
    page,
    request,
  }) => {
    const pageId = await columnsPage(request);
    await page.goto(`/?page=${pageId}`);

    const secondColumn = page.locator('.obe-columns > .obe-column').nth(1);
    const paragraph = secondColumn.locator('.obe-text').first();
    await paragraph.click();
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await page.keyboard.type('/table');
    await page.keyboard.press('Enter');

    const table = secondColumn.locator('.obe-table');
    await expect(table).toBeVisible();
    const tableBlock = table.locator('xpath=ancestor::*[contains(concat(" ", normalize-space(@class), " "), " obe-row ")][1]');
    const bodyRow = table.locator('tbody > tr').first();

    await page.mouse.move(0, 0); // no row hovered: the grip is at rest
    // At rest the grip sits UNDER the column-resize divider (stacking, not
    // pointer-events — see index.css), so the divider stays grabbable.
    const divider = secondColumn.locator('.obe-col-divider').first();
    expect(await divider.evaluate((d) => {
      const b = d.getBoundingClientRect();
      return document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2)?.closest('.obe-col-divider') === d;
    })).toBe(true);

    await bodyRow.hover();

    const rowGrip = bodyRow.locator('.obe-table-row-grip');
    const firstCell = bodyRow.locator('td').first();
    const blockHandle = tableBlock.locator('.obe-gutter .obe-handle');
    await expect(rowGrip).toBeVisible();
    await expect(blockHandle).toBeVisible();
    expect(await rowGrip.evaluate((g) => {
      const b = g.getBoundingClientRect();
      return document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2)?.closest('.obe-table-row-grip') !== null;
    })).toBe(true);

    const gripBox = (await rowGrip.boundingBox())!;
    const cellBox = (await firstCell.boundingBox())!;
    const handleBox = (await blockHandle.boundingBox())!;
    expect(rectanglesIntersect(gripBox, cellBox)).toBe(false);
    expect(rectanglesIntersect(gripBox, handleBox)).toBe(false);
  });
});

test('merged table rows keep grips bound to their own row payload', {tag: ['@editor', '@p1']}, async ({page}) => {
  const table = await mergeTopLeft2x2(page);
  const bindings = await table.locator('tbody > tr').evaluateAll((rows) =>
    rows.map((row, from) => {
      const host = row as HTMLElement;
      const grips = [...row.querySelectorAll<HTMLElement>('.obe-table-row-grip')];
      return {
        from,
        rowId: host.dataset.tableRowId,
        grips: grips.map((grip) => {
          const transfer = new DataTransfer();
          grip.dispatchEvent(new DragEvent('dragstart', {bubbles: true, dataTransfer: transfer}));
          grip.dispatchEvent(new DragEvent('dragend', {bubbles: true, dataTransfer: transfer}));
          return {
            axis: grip.dataset.dragAxis,
            from: Number(grip.dataset.dragFrom),
            id: grip.dataset.dragId,
            payload: transfer.getData('text/plain'),
          };
        }),
      };
    }),
  );

  expect(bindings).toHaveLength(3);
  for (const binding of bindings) {
    expect(binding.grips).toEqual([
      {axis: 'row', from: binding.from, id: binding.rowId, payload: binding.rowId},
    ]);
  }
});

test('merged top-row anchor exposes one correctly bound grip segment per column', {tag: ['@editor', '@p1']}, async ({
  page,
}) => {
  const table = await mergeTopLeft2x2(page);
  const grips = table.locator('.obe-table-col-grip');
  const bindings = await grips.evaluateAll((elements) =>
    elements.map((element) => {
      const grip = element as HTMLElement;
      const transfer = new DataTransfer();
      grip.dispatchEvent(new DragEvent('dragstart', {bubbles: true, dataTransfer: transfer}));
      grip.dispatchEvent(new DragEvent('dragend', {bubbles: true, dataTransfer: transfer}));
      return {
        axis: grip.dataset.dragAxis,
        from: Number(grip.dataset.dragFrom),
        id: grip.dataset.dragId,
        payload: transfer.getData('text/plain'),
      };
    }),
  );

  expect(bindings.map(({from}) => from)).toEqual([0, 1, 2]);
  expect(bindings.every(({axis, id, payload}) => axis === 'col' && id === payload)).toBe(true);

  const anchorSegments = table.locator('tbody > tr').first().locator('td').first().locator('.obe-table-col-grip');
  await expect(anchorSegments).toHaveCount(2);
  const first = (await anchorSegments.nth(0).boundingBox())!;
  const second = (await anchorSegments.nth(1).boundingBox())!;
  expect(Math.abs(first.width - second.width)).toBeLessThanOrEqual(1);
  expect(Math.abs(first.x + first.width - second.x)).toBeLessThanOrEqual(1);
});

test('table grip menus insert a row and delete a column', {tag: ['@editor', '@p1']}, async ({page}) => {
  const table = await freshTable(page);
  const rows = table.locator('tbody > tr');
  const initialRows = await rows.count();
  const initialColumns = await table.locator('.obe-table-col-grip').count();

  const firstRow = rows.first();
  await firstRow.hover();
  await firstRow.getByRole('button', {name: 'Row 1 options'}).click();
  await expect(page.getByRole('menuitem', {name: 'Insert row below'})).toBeVisible();
  await page.getByRole('menuitem', {name: 'Insert row below'}).click();
  await expect(rows).toHaveCount(initialRows + 1);

  const firstColumnGrip = table.getByRole('button', {name: 'Column A options'});
  await firstColumnGrip.click({button: 'right'});
  await expect(page.getByRole('menuitem', {name: 'Delete column'})).toBeVisible();
  await page.getByRole('menuitem', {name: 'Delete column'}).click();
  await expect(table.locator('.obe-table-col-grip')).toHaveCount(initialColumns - 1);
});
