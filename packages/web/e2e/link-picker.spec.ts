import {test, expect} from './fixtures';
import {newPage} from './seed';

test.use({freshWorkspace: true});

async function openEditor(page: import('@playwright/test').Page, pageId: string): Promise<void> {
  await page.goto(`/?page=${pageId}`);
  const para = page.locator('.obe-text').first();
  await para.waitFor({state: 'visible'});
  await expect(async () => {
    await para.click();
    await expect(para).toBeFocused({timeout: 500});
  }).toPass({timeout: 10_000});
}

test('Link to page picker inserts the keyboard-selected page', {tag: ['@editor']}, async ({page, request}) => {
  await newPage(request, 'Picker Target');
  const secondId = await newPage(request, 'Picker Target Two');
  const hostId = await newPage(request, 'Picker Host');

  await openEditor(page, hostId);
  await page.keyboard.type('/link to page');
  await expect(page.getByRole('option', {name: 'Link to page'})).toBeVisible();
  await page.keyboard.press('Enter');

  const picker = page.getByRole('dialog', {name: 'Link to page'});
  await expect(picker).toBeVisible();
  await expect(picker.getByRole('textbox')).toBeFocused();
  await page.keyboard.type('Picker Target');
  // Both seeded pages match this query ("Picker Target" and "Picker Target
  // Two") — .first() disambiguates the strict-mode locator; it's just a
  // "results have rendered" gate before the ArrowDown/Enter below moves
  // off the default (first) result onto the second one.
  await expect(picker.getByRole('option', {name: /Picker Target/}).first()).toBeVisible();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');

  const link = page.locator('a.obe-mention');
  await expect(link).toHaveText(/Picker Target/);
  await expect(link).toHaveAttribute('data-page-id', secondId);
});
