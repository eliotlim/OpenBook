import {expect, test} from './fixtures';

test.describe.configure({mode: 'parallel'});

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
  const horizontalOverlap = Math.max(
    0,
    Math.min(gripBox.x + gripBox.width, handleBox.x + handleBox.width) - Math.max(gripBox.x, handleBox.x),
  );
  expect(horizontalOverlap).toBeLessThanOrEqual(8);

  const hitTargetIsHandle = await dragHandle.evaluate((handle) => {
    const box = handle.getBoundingClientRect();
    return document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)?.closest('.obe-handle') === handle;
  });
  expect(hitTargetIsHandle).toBe(true);
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
