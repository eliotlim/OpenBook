import {test, expect, takeSnapshot} from '@chromatic-com/playwright';
import {newPage} from './seed';

// Right-clicking an editor block opens a *block-aware* context menu: block
// actions (delete/move/duplicate) above the page actions. Deleting removes that
// block and leaves the rest of the document intact.
test('block context menu: delete removes the right block', async ({page, request}, testInfo) => {
  const id = await newPage(request, 'Block Menu E2E', {
    editorjs: {
      blocks: [
        {id: 'blkone', type: 'paragraph', data: {text: 'First block here'}},
        {id: 'blktwo', type: 'paragraph', data: {text: 'Second block here'}},
      ],
    },
    values: [],
    names: [],
  });

  await page.goto(`/?page=${id}`);

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
