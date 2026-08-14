import type {APIRequestContext, Page, TestInfo} from '@playwright/test';
import {expect, test} from './fixtures';
import {newPage} from './seed';

// BB-7 manager verification: Chromium is intentionally unavailable in the
// worker sandbox. The numbered frames are ready to combine into a short GIF.
test.use({freshWorkspace: true});

const SPANS = [5, 1, 1, 1, 4];

async function columnsPage(request: APIRequestContext): Promise<string> {
  return newPage(request, `BB-7 cascade ${Date.now()}`, {
    editor: 'blocks',
    blockdoc: {
      blocks: [{
        id: 'layout',
        type: 'columns',
        children: SPANS.map((span, i) => ({
          id: `col-${i}`,
          type: 'column',
          props: {span},
          children: [{id: `text-${i}`, type: 'paragraph', text: [{t: `Column ${i + 1}`}]}],
        })),
      }],
    },
    editorjs: {blocks: []},
    values: [],
    names: [],
  });
}

const renderedSpans = (page: Page): Promise<number[]> =>
  page.locator('.obe-columns > .obe-column').evaluateAll((columns) =>
    columns.map((column) => Number((column as HTMLElement).style.gridColumn.replace('span ', ''))),
  );

async function captureFrame(page: Page, testInfo: TestInfo, frame: number): Promise<void> {
  const name = `bb7-cascade-${String(frame).padStart(2, '0')}`;
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({path, animations: 'disabled'});
  await testInfo.attach(name, {path, contentType: 'image/png'});
}

test(
  'manager capture: last column cascades past 1-unit neighbours',
  {tag: ['@editor', '@manager-verified']},
  async ({page, request}, testInfo) => {
    await page.setViewportSize({width: 1280, height: 800});
    const pageId = await columnsPage(request);
    await page.goto(`/?page=${pageId}`);

    const layout = page.locator('.obe-columns');
    const divider = page.getByRole('separator', {name: 'Resize columns 4 and 5'});
    await expect(layout).toBeVisible();
    await expect(divider).toBeVisible();
    expect(await renderedSpans(page)).toEqual(SPANS);
    await captureFrame(page, testInfo, 0);

    const geometry = await layout.evaluate((element) => {
      const style = getComputedStyle(element);
      const gap = Number.parseFloat(style.columnGap || style.gap) || 0;
      return {width: element.getBoundingClientRect().width, gap, columns: element.children.length};
    });
    const unit = (geometry.width - geometry.gap * (geometry.columns - 1)) / 12;
    const box = (await divider.boundingBox())!;
    const startX = box.x + box.width / 2;
    const startY = box.y + Math.min(box.height / 2, 80);
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    for (let frame = 1; frame <= 4; frame += 1) {
      await page.mouse.move(startX - unit * frame / 2, startY);
      await captureFrame(page, testInfo, frame);
    }
    await page.mouse.up();

    await expect.poll(() => renderedSpans(page)).toEqual([3, 1, 1, 1, 6]);
    await expect(page.getByRole('separator', {name: 'Resize last column'})).toHaveAttribute('aria-valuenow', '6');
  },
);
