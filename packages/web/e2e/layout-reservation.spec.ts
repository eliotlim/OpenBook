import {expect, test} from './fixtures';
import {newPage, SERVER} from './seed';

test.use({freshWorkspace: true});

const x = async (locator: import('@playwright/test').Locator): Promise<number> => {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  return box!.x;
};

// Manager verification gate: this sandbox has no Chromium. Run with
// `pnpm --filter @book.dev/web test:e2e --grep @manager-verified`.
test('BB-3 reserved reveals keep sibling x-coordinates fixed', {tag: ['@shell', '@database', '@manager-verified']}, async ({page, request}) => {
  await page.addInitScript((serverUrl) => {
    localStorage.setItem(
      'openbook.libraries',
      JSON.stringify([
        {id: 'local', icon: '🏡', name: 'My Library', serverUrl: null},
        {id: 'remote', icon: '🌐', name: new URL(serverUrl).host, serverUrl},
      ]),
    );
  }, SERVER);

  const pageId = await newPage(request, 'BB-3 layout reservation');
  await page.goto(`/?page=${pageId}&shell=desktop`);

  const libraryTrigger = page.getByRole('button').filter({hasText: new URL(SERVER).host}).first();
  await libraryTrigger.click();
  const localRow = page.getByRole('menuitem').filter({hasText: 'My Library'});
  const status = localRow.getByRole('img');
  const remove = localRow.getByRole('button', {name: 'Remove My Library'});
  await expect(remove).toHaveCSS('opacity', '0');
  const statusBeforeHover = await x(status);
  await localRow.hover();
  await expect(remove).toHaveCSS('opacity', '1');
  expect(await x(status)).toBe(statusBeforeHover);
  await page.keyboard.press('Escape');

  await page.getByRole('button', {name: 'New tab'}).click();
  const tabs = page.getByRole('tab');
  await expect(tabs).toHaveCount(2);
  const secondTabBeforeSwitch = await x(tabs.nth(1));
  await tabs.nth(0).click();
  await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'true');
  expect(await x(tabs.nth(1))).toBe(secondTabBeforeSwitch);

  await page.keyboard.press('ControlOrMeta+k');
  await page.getByPlaceholder(/Search pages or run a command/).fill('New database');
  await page.keyboard.press('Enter');
  const toolbar = page.locator('[data-database-toolbar]');
  await expect(toolbar).toBeVisible();
  await page.setViewportSize({width: 620, height: 800});
  const search = page.getByRole('textbox', {name: 'Search rows'});
  const filter = toolbar.getByRole('button', {name: 'Filter', exact: true});
  await filter.scrollIntoViewIfNeeded();
  const filterBeforeFocus = await x(filter);
  await search.focus();
  await expect(search).toBeFocused();
  expect(await x(filter)).toBe(filterBeforeFocus);
});
