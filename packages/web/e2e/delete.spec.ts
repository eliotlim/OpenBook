import {test, expect, takeSnapshot} from './fixtures';
import {SERVER} from './seed';

// Regression for: delete uses an in-app confirm dialog (not window.confirm),
// the dialog is centered (not top-left), and confirming soft-deletes the page
// into the trash.

test('delete page: centered in-app confirm moves the page to the trash', {tag: ['@shell', '@visual']}, async ({page, request}, testInfo) => {
  await page.goto('/');

  const actions = page.getByRole('button', {name: 'Page actions'});
  await expect(actions).toBeVisible();
  await actions.click();
  await page.getByRole('menuitem', {name: 'Move to trash'}).click();

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

// The moment-of-mistake affordance: trashing shows a toast whose Undo restores
// the page without a trip to the Trash dialog.
test('delete page: the toast Undo restores the page', {tag: ['@shell', '@visual']}, async ({page, request}, testInfo) => {
  await page.goto('/');

  const actions = page.getByRole('button', {name: 'Page actions'});
  await expect(actions).toBeVisible();
  const deletedId = new URL(page.url()).searchParams.get('page');
  await actions.click();
  await page.getByRole('menuitem', {name: 'Move to trash'}).click();
  await page.getByRole('dialog').getByRole('button', {name: 'Move to trash'}).click();

  // The toast stack is a permanent polite live region (no per-item role) —
  // target it via the host hook.
  const toast = page.locator('[data-toast-host] > div').filter({hasText: 'to trash'});
  await expect(toast).toBeVisible();
  await takeSnapshot(page, testInfo); // visual: trash toast with Undo
  await toast.getByRole('button', {name: 'Undo'}).click();

  // Restored: gone from the trash, and reopened as the current page.
  await expect
    .poll(async () => {
      const trash = (await (await request.get(`${SERVER}/api/trash`)).json()) as {id: string}[];
      return trash.some((t) => t.id === deletedId);
    })
    .toBe(false);
  await expect.poll(() => new URL(page.url()).searchParams.get('page')).toBe(deletedId);
});
