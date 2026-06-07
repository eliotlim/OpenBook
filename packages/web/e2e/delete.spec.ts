import {test, expect, takeSnapshot} from '@chromatic-com/playwright';

// Regression for: delete uses an in-app confirm dialog (not window.confirm),
// the dialog is centered (not top-left), and confirming soft-deletes the page
// into the trash.
const SERVER = 'http://127.0.0.1:4319';

test('delete page: centered in-app confirm moves the page to the trash', async ({page, request}, testInfo) => {
  await page.goto('/');

  const actions = page.getByRole('button', {name: 'Page actions'});
  await expect(actions).toBeVisible();
  await actions.click();
  await page.getByRole('menuitem', {name: 'Delete page'}).click();

  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('Move this page to the trash?')).toBeVisible();

  // Centered, not slammed to the top-left corner (the Tailwind v4 translate bug).
  const box = await dialog.boundingBox();
  const vp = page.viewportSize()!;
  expect(box).not.toBeNull();
  expect(Math.abs(box!.x + box!.width / 2 - vp.width / 2)).toBeLessThan(12);

  await takeSnapshot(page, testInfo); // visual: centered confirm dialog

  await dialog.getByRole('button', {name: 'Move to trash'}).click();
  await expect(dialog).toBeHidden();

  // Soft delete: the page is recoverable from the trash (verified via the API,
  // which is independent of the collapsible sidebar's Trash panel).
  await expect.poll(async () => (await (await request.get(`${SERVER}/api/trash`)).json()).length).toBeGreaterThan(0);
});
