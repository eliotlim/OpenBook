import {test, expect, takeSnapshot} from '@chromatic-com/playwright';

const SERVER = 'http://127.0.0.1:4319';

// A page seeded with one of each new block type.
async function seedPage(request: import('@playwright/test').APIRequestContext): Promise<string> {
  const res = await request.post(`${SERVER}/api/pages`, {
    data: {
      name: 'New Blocks E2E',
      data: {
        editorjs: {
          blocks: [
            {id: 'hdrone', type: 'header', data: {text: 'Section One', level: 2}},
            {id: 'tocblk', type: 'toc', data: {}},
            {id: 'callbk', type: 'callout', data: {variant: 'info', text: 'Heads up'}},
            {id: 'accbk', type: 'accordion', data: {title: 'Details', content: 'Hidden body', open: true}},
            {id: 'chkbk', type: 'checklist', data: {items: [{text: 'First item', checked: false}, {text: 'Second item', checked: true}]}},
            {id: 'tblbk', type: 'table', data: {withHeadings: true, content: [['Col A', 'Col B'], ['cell one', 'cell two']]}},
            {id: 'btnbk', type: 'button', data: {label: 'Visit', url: 'https://example.com'}},
            {id: 'divbk', type: 'divider', data: {style: 'dashed'}},
          ],
        },
        values: [],
        names: [],
      },
    },
  });
  return ((await res.json()) as {id: string}).id;
}

test('new block types render, the accordion toggles, and the collapse persists', async ({page, request}, testInfo) => {
  const id = await seedPage(request);
  await page.goto(`/?page=${id}`);

  // Each block renders.
  await expect(page.locator('.block-callout')).toHaveAttribute('data-variant', 'info');
  await expect(page.locator('.block-callout__body')).toHaveText('Heads up');
  await expect(page.locator('.block-accordion__title')).toHaveText('Details');
  await expect(page.getByText('First item')).toBeVisible();
  await expect(page.getByText('Second item')).toBeVisible();
  await expect(page.getByText('cell one')).toBeVisible();
  await expect(page.locator('.block-button__cta')).toHaveText('Visit');
  await expect(page.locator('.block-divider')).toHaveAttribute('data-style', 'dashed');

  // The table of contents picks up the heading (via its MutationObserver).
  await expect(page.locator('.block-toc__link')).toHaveText('Section One');

  await takeSnapshot(page, testInfo); // visual: all new block types

  // Toggling the accordion hides its body. This is a programmatic `block-changed`
  // with no `input` event — it only autosaves because the persist-worthiness
  // deny-list now counts non-reactive blocks (previously only `subpage` did).
  const content = page.locator('.block-accordion__content');
  await expect(content).toBeVisible();
  await page.locator('.block-accordion__chevron').click();
  await expect(content).toBeHidden();

  // Give the 800ms autosave debounce time to flush, then reload — collapse sticks.
  await page.waitForTimeout(1500);
  await page.reload();
  await expect(page.locator('.block-accordion')).toHaveAttribute('data-open', 'false');
});
