import {test, expect, takeSnapshot} from '@chromatic-com/playwright';

const primary = (page: import('@playwright/test').Page) =>
  page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--primary').trim());

test('color theme: switching the palette updates the accent and persists', async ({page}, testInfo) => {
  await page.goto('/');
  await page.getByRole('button', {name: 'Settings'}).first().click();
  await page.getByRole('button', {name: 'Appearance'}).click();

  const before = await primary(page);
  await page.getByRole('button', {name: 'Forest'}).click();
  await expect.poll(() => primary(page)).not.toBe(before);
  const forest = await primary(page);
  await takeSnapshot(page, testInfo); // visual: Appearance tab with theme swatches

  await page.reload();
  await expect(page.getByRole('button', {name: 'Settings'}).first()).toBeVisible(); // settle
  await expect.poll(() => primary(page)).toBe(forest); // persisted
});

test('language: switching translates the chrome and persists', async ({page}, testInfo) => {
  await page.goto('/');
  await expect.poll(() => page.evaluate(() => document.documentElement.lang)).toBe('en');

  await page.getByRole('button', {name: 'Settings'}).first().click();
  await page.getByRole('button', {name: 'General'}).click();
  await page.locator('#ob-language').selectOption('de');

  // The settings tab rail re-labels in German ("Darstellung" = Appearance).
  await expect(page.getByRole('button', {name: 'Darstellung'})).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.lang)).toBe('de');
  await takeSnapshot(page, testInfo); // visual: German settings (also primes the chromatic snapshot helper)

  await page.reload();
  // Settle on a locale-stable landmark: the chrome (incl. the Settings button)
  // now translates, so wait for the sidebar tree instead of an English label.
  await expect(page.getByRole('treeitem').first()).toBeVisible(); // settle
  await expect.poll(() => page.evaluate(() => document.documentElement.lang)).toBe('de'); // persisted
});
