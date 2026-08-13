import type {Page} from '@playwright/test';
import {test, expect} from './fixtures';
import {newPage} from './seed';

// Manager verification gate: this regression spec requires the Chromium
// project supplied by playwright.config.ts; the worker sandbox has no browser.
test.use({freshWorkspace: true});

async function expectDocumentLocked(page: Page): Promise<void> {
  const dimensions = await page.evaluate(() => {
    const scroller = document.scrollingElement;
    if (!scroller) throw new Error('document has no scrolling element');
    return {clientHeight: scroller.clientHeight, scrollHeight: scroller.scrollHeight};
  });
  expect(dimensions.scrollHeight).toBe(dimensions.clientHeight);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);

  await page.mouse.move(8, 8);
  await page.mouse.wheel(0, 1200);

  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
}

test(
  'document stays locked on home, page, database, and settings screens',
  {tag: ['@shell', '@p1', '@manager-verified']},
  async ({page, request}) => {
    await page.goto('/?page=home');
    await expect(page.locator('[data-home-screen]')).toBeVisible();
    await expectDocumentLocked(page);

    const pageId = await newPage(request, 'Document scroll lock');
    await page.goto(`/?page=${pageId}`);
    await expect(page.getByRole('button', {name: 'Page actions'})).toBeVisible();
    await expectDocumentLocked(page);

    await page.keyboard.press('ControlOrMeta+k');
    await page.getByPlaceholder(/Search pages or run a command/).fill('New database');
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-database-toolbar]')).toBeVisible();
    await expectDocumentLocked(page);

    const bodyPaddingBeforeDialog = await page.evaluate(() => getComputedStyle(document.body).paddingRight);
    await page.getByRole('button', {name: 'Settings'}).first().click();
    await expect(page.getByText('Preferences', {exact: true})).toBeVisible();
    await expectDocumentLocked(page);
    expect(await page.evaluate(() => getComputedStyle(document.body).paddingRight)).toBe(bodyPaddingBeforeDialog);
  },
);
