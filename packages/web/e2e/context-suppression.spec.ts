import type {APIRequestContext, Locator} from '@playwright/test';
import {expect, test} from './fixtures';
import {SERVER, newPage} from './seed';

test.use({freshWorkspace: true});

const TINY_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

/** Dispatch a real cancelable event and report its final defaultPrevented state. */
const contextMenuPrevented = (locator: Locator): Promise<boolean> =>
  locator.evaluate((element) => {
    const event = new MouseEvent('contextmenu', {bubbles: true, cancelable: true});
    element.dispatchEvent(event);
    return event.defaultPrevented;
  });

const expectSuppressed = async (locator: Locator): Promise<void> => {
  await expect(locator).toBeVisible();
  expect(await contextMenuPrevented(locator)).toBe(true);
};

const seedSurfacePage = async (request: APIRequestContext): Promise<string> => {
  const response = await request.post(`${SERVER}/api/pages`, {
    data: {
      name: 'Context suppression surfaces',
      data: {
        editor: 'blocks',
        blockdoc: {
          blocks: [
            {id: 'heading', type: 'heading', props: {level: 1}, text: [{t: 'Suppression sweep'}]},
            {id: 'paragraph', type: 'paragraph', text: [{t: 'Gutter target'}]},
            {id: 'image', type: 'image', props: {src: TINY_PNG, alt: 'Suppression image'}},
          ],
        },
        editorjs: {blocks: []},
        values: [],
        names: [],
      },
    },
  });
  return ((await response.json()) as {id: string}).id;
};

test('sidebar actions and command-palette rows suppress native context menus', {tag: ['@shell']}, async ({page}) => {
  await page.goto('/');
  const sidebar = page.locator('[data-sidebar-drawer]');

  for (const name of ['Home', 'Search', 'Settings', 'Trash']) {
    await expectSuppressed(sidebar.getByRole('button', {name, exact: true}));
  }
  await expectSuppressed(sidebar.getByRole('button', {name: /My Library/}));
  await expectSuppressed(sidebar.locator('[data-profile-menu]'));

  await page.keyboard.press('ControlOrMeta+k');
  await expectSuppressed(page.getByRole('option').first());
});

test('template cards and settings chrome suppress while a settings input stays native', {tag: ['@shell']}, async ({page}) => {
  await page.goto('/');
  await page.getByRole('button', {name: 'Templates'}).first().click();
  await expectSuppressed(page.locator('[data-template]').first());
  await page.keyboard.press('Escape');

  await page.getByRole('button', {name: 'Settings'}).first().click();
  const settings = page.getByRole('dialog', {name: 'Settings'});
  await expectSuppressed(settings.locator('nav h4'));

  await settings.getByRole('button', {name: 'Profile'}).click();
  const nameInput = settings.locator('#ob-profile-name');
  await expect(nameInput).toBeVisible();
  expect(await contextMenuPrevented(nameInput)).toBe(false);
});

test('editor gutter, image lightbox, and present overlay suppress native context menus', {tag: ['@editor']}, async ({page, request}) => {
  const id = await seedSurfacePage(request);
  await page.goto(`/?page=${id}`);
  await expect(page.getByRole('button', {name: 'Page actions'})).toBeVisible();

  const paragraph = page.locator('[data-block-row="paragraph"]');
  await paragraph.locator('.obe-text').hover();
  await expectSuppressed(paragraph.locator('.obe-handle'));
  await expect(page.getByRole('menuitem', {name: /Delete/})).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expectSuppressed(paragraph.locator('.obe-gutter-btn').first());
  await page.keyboard.press('Escape');

  await page.locator('.obe-image-frame').hover();
  await page.getByRole('button', {name: 'Open full size'}).click();
  await expectSuppressed(page.locator('.obe-lightbox-stage'));
  await page.keyboard.press('Escape');

  await page.getByRole('button', {name: 'Page actions'}).click();
  await page.getByRole('menuitem', {name: 'Present'}).click();
  await page.getByRole('menuitem', {name: 'Presenter view'}).click();
  await expectSuppressed(page.locator('.ob-present'));
});

test('split-pane divider suppresses its native context menu', {tag: ['@shell']}, async ({page, request}) => {
  const primary = await newPage(request, 'Context split primary');
  const secondary = await newPage(request, 'Context split secondary');
  await page.goto(`/?page=${primary}&split=${secondary}`);

  await expectSuppressed(page.locator('[data-split-pane] [role="separator"]'));
});
