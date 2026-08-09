import {test, expect} from './fixtures';
import {newPage} from './seed';

test.use({freshWorkspace: true});

test('Link to page picker inserts the keyboard-selected page', {tag: ['@editor']}, async ({page, request}) => {
  const targetId = await newPage(request, 'Picker Target');
  const hostId = await newPage(request, 'Picker Host');
  await page.goto(`/?page=${hostId}`);

  const paragraph = page.locator('.obe-text').first();
  await paragraph.click();
  await page.keyboard.type('/link to page');
  await expect(page.getByRole('option', {name: 'Link to page'})).toBeVisible();
  await page.keyboard.press('Enter');

  const picker = page.getByRole('dialog', {name: 'Link to page'});
  await expect(picker).toBeVisible();
  await expect(picker.getByRole('textbox')).toBeFocused();
  await page.keyboard.type('Picker Target');
  await expect(picker.getByRole('option', {name: /Picker Target/})).toBeVisible();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');

  const link = page.locator('a.obe-mention');
  await expect(link).toHaveText(/Picker Target/);
  await expect(link).toHaveAttribute('data-page-id', targetId);
});
