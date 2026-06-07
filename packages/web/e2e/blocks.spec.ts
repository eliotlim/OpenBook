import {test, expect, takeSnapshot} from '@chromatic-com/playwright';

const SERVER = 'http://127.0.0.1:4319';

// Right-clicking an editor block opens a *block-aware* context menu: block
// actions (delete/move/duplicate) above the page actions. Deleting removes that
// block and leaves the rest of the document intact.
test('block context menu: delete removes the right block', async ({page, request}, testInfo) => {
  const create = await request.post(`${SERVER}/api/pages`, {
    data: {
      name: 'Block Menu E2E',
      data: {
        editorjs: {
          blocks: [
            {id: 'blkone', type: 'paragraph', data: {text: 'First block here'}},
            {id: 'blktwo', type: 'paragraph', data: {text: 'Second block here'}},
          ],
        },
        values: [],
        names: [],
      },
    },
  });
  const created = (await create.json()) as {id: string};

  await page.goto(`/?page=${created.id}`);

  const firstBlock = page.locator('.ce-block', {hasText: 'First block here'});
  await expect(firstBlock).toBeVisible();
  await firstBlock.click({button: 'right'});

  // The block menu is shown (a page-only menu would not have this item).
  const deleteBlock = page.getByRole('menuitem', {name: 'Delete block'});
  await expect(deleteBlock).toBeVisible();
  await takeSnapshot(page, testInfo); // visual: block-aware context menu (block + page actions)
  await deleteBlock.click();

  await expect(page.getByText('First block here')).toHaveCount(0);
  await expect(page.getByText('Second block here')).toBeVisible();
});
