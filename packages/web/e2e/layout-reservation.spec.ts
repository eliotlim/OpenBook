import type {Locator} from '@playwright/test';
import {expect, test} from './fixtures';
import {newPage, SERVER} from './seed';

test.use({freshWorkspace: true});

const x = async (locator: Locator): Promise<number> => {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  return box!.x;
};

const layoutX = (locator: Locator): Promise<number> =>
  locator.evaluate((element) => (element as HTMLElement).offsetLeft);

const settledX = async (locator: Locator, coordinate: 'bounding' | 'layout' = 'bounding'): Promise<number> => {
  let settled: number | undefined;
  await expect
    .poll(async () => {
      const [first, second] = await locator.evaluate(
        (element, coordinate) =>
          new Promise<[number, number]>((resolve) => {
            const read = () =>
              coordinate === 'layout' ? (element as HTMLElement).offsetLeft : element.getBoundingClientRect().x;
            requestAnimationFrame(() => {
              const first = read();
              requestAnimationFrame(() => resolve([first, read()]));
            });
          }),
        coordinate,
      );
      settled = first === second ? second : undefined;
      return settled;
    })
    .not.toBeUndefined();
  return settled!;
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
  await page.evaluate(() => document.fonts.ready);

  const libraryTrigger = page.getByRole('button').filter({hasText: new URL(SERVER).host}).first();
  await libraryTrigger.click();
  const localRow = page.getByRole('menuitem').filter({hasText: 'My Library'});
  const remoteRow = page.getByRole('menuitem').filter({hasText: new URL(SERVER).host});
  const status = localRow.getByRole('img');
  const remove = localRow.getByRole('button', {name: 'Remove My Library'});

  // Radix focuses the first menu item when the menu opens. Move focus away so
  // the hidden baseline is deterministic, then exercise both intended reveal
  // paths without changing the status sibling's position.
  await remoteRow.focus();
  await expect(remove).toHaveCSS('opacity', '0');
  const statusBeforeReveal = await settledX(status);
  await localRow.focus();
  await expect(remove).toHaveCSS('opacity', '1');
  await expect.poll(() => x(status)).toBe(statusBeforeReveal);
  await remoteRow.focus();
  await expect(remove).toHaveCSS('opacity', '0');
  await localRow.hover();
  await expect(remove).toHaveCSS('opacity', '1');
  await expect.poll(() => x(status)).toBe(statusBeforeReveal);
  await page.keyboard.press('Escape');

  await page.getByRole('button', {name: 'New tab'}).click();
  const tabs = page.getByRole('tab');
  await expect(tabs).toHaveCount(2);
  const secondTabBeforeSwitch = await settledX(tabs.nth(1));
  await tabs.nth(0).click();
  await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'true');
  await expect.poll(() => x(tabs.nth(1))).toBe(secondTabBeforeSwitch);

  await page.keyboard.press('ControlOrMeta+k');
  await page.getByPlaceholder(/Search pages or run a command/).fill('New database');
  await page.keyboard.press('Enter');
  const toolbar = page.locator('[data-database-toolbar]');
  await expect(toolbar).toBeVisible();
  await page.setViewportSize({width: 620, height: 800});
  const search = page.getByRole('textbox', {name: 'Search rows'});
  const filter = toolbar.getByRole('button', {name: 'Filter', exact: true});
  await filter.scrollIntoViewIfNeeded();
  // Focus may scroll the narrow toolbar to reveal the search input. offsetLeft
  // measures the filter's position in the flex layout, independent of that
  // scroll, and therefore distinguishes viewport movement from sibling reflow.
  const filterBeforeFocus = await settledX(filter, 'layout');
  await search.focus();
  await expect(search).toBeFocused();
  await expect.poll(() => layoutX(filter)).toBe(filterBeforeFocus);
});
