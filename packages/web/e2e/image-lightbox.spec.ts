import {test, expect} from './fixtures';
import {SERVER} from './seed';

// Image lightbox (LBX-1): a full-viewport in-app overlay for the image block.
// Edit mode opens it from the hover toolbar's Expand button; a read-only /
// present page opens it with a plain click on the picture. Esc closes it.

// A minimal valid 1×1 transparent PNG as a data URL (the "legacy data-URL" src
// path — renders directly, no asset backend needed).
const TINY_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

// A 1600×1200 solid PNG (LBX-2): larger than the lightbox stage so it fits
// *below* 100% — the fit ↔ 100% toggle and zoom-past-fit are then observable.
const BIG_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAABkAAAASwCAMAAACU33alAAADAFBMVEUoWqoAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQ+xOvAAAHXElEQVR42u3BMQEAAADCoPVPbQwfoAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADgb1JjAAGpAurOAAAAAElFTkSuQmCC';

const seedImagePage = async (
  request: import('@playwright/test').APIRequestContext,
  name: string,
  src: string = TINY_PNG,
): Promise<string> => {
  const blockdoc = {
    blocks: [
      {id: 'h1', type: 'heading', props: {level: 1}, text: [{t: 'Photo Page'}]},
      {id: 'img', type: 'image', props: {src, alt: 'A test cat'}},
    ],
  };
  const res = await request.post(`${SERVER}/api/pages`, {
    data: {
      name: `${name} ${Date.now()}`,
      data: {editor: 'blocks', blockdoc, editorjs: {blocks: []}, values: [], names: []},
    },
  });
  const {id} = (await res.json()) as {id: string};
  return id;
};

test('edit mode: the Expand toolbar button opens the lightbox; Esc closes it', {tag: ['@editor']}, async ({page, request}) => {
  const id = await seedImagePage(request, 'Lightbox Edit');
  await page.goto(`/?page=${id}`);
  await expect(page.getByRole('button', {name: 'Page actions'})).toBeVisible();

  const img = page.locator('img.obe-image-img');
  await expect(img).toBeVisible();

  // A plain click on the picture must NOT open the overlay while editing.
  await img.click();
  await expect(page.getByRole('dialog', {name: 'A test cat'})).toHaveCount(0);

  // Reveal the hover toolbar and use the Expand button.
  await page.locator('.obe-image-frame').hover();
  await page.getByRole('button', {name: 'Open full size'}).click();

  const dialog = page.getByRole('dialog', {name: 'A test cat'});
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('img.obe-lightbox-img')).toBeVisible();
  // Alt renders as the caption line.
  await expect(dialog.locator('figcaption.obe-lightbox-caption')).toHaveText('A test cat');

  // Esc closes it.
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', {name: 'A test cat'})).toHaveCount(0);
});

test('read-only: clicking the image opens the lightbox, the close button dismisses it', {tag: ['@editor']}, async ({page, request}) => {
  const id = await seedImagePage(request, 'Lightbox Read-only');

  // Present the instance as guest-read-only to this context only (same trick as
  // viewer-readonly.spec) so the document renders locked and the image is a
  // click-to-open trigger.
  await page.route('**/api/instance', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const real = await route.fetch();
    const info = await real.json();
    await route.fulfill({json: {...info, guestAccess: 'read'}});
  });

  await page.goto(`/?page=${id}`);
  const root = page.locator('.obe-root');
  await expect(root).toHaveClass(/obe-readonly/);

  // The read-only image is a labelled button — a plain click opens the overlay.
  const img = page.getByRole('button', {name: 'View image full size'});
  await expect(img).toBeVisible();
  await img.click();

  const dialog = page.getByRole('dialog', {name: 'A test cat'});
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('img.obe-lightbox-img')).toBeVisible();

  // The labelled close button dismisses it.
  await dialog.getByRole('button', {name: 'Close'}).click();
  await expect(page.getByRole('dialog', {name: 'A test cat'})).toHaveCount(0);
});

test('zoom: wheel/button zoom, fit ↔ 100% toggle, reset control, Esc after zoom', {tag: ['@editor']}, async ({page, request}) => {
  const id = await seedImagePage(request, 'Lightbox Zoom', BIG_PNG);
  await page.goto(`/?page=${id}`);
  await expect(page.getByRole('button', {name: 'Page actions'})).toBeVisible();

  // Open the overlay via the edit-mode Expand button.
  await page.locator('.obe-image-frame').hover();
  await page.getByRole('button', {name: 'Open full size'}).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('img.obe-lightbox-img')).toBeVisible();

  // The zoom bar appears; a picture larger than the stage fits below 100%.
  const value = dialog.locator('.obe-lightbox-zoomvalue');
  await expect(value).toBeVisible();
  const fitText = (await value.textContent())?.trim() ?? '';
  const fitPct = parseInt(fitText, 10);
  expect(fitPct).toBeLessThan(100);

  // At fit the reset control is disabled.
  const reset = dialog.getByRole('button', {name: 'Reset zoom to fit'});
  await expect(reset).toBeDisabled();

  // Double-click toggles fit → 100%.
  await dialog.locator('.obe-lightbox-stage').dblclick();
  await expect(value).toHaveText('100%');
  await expect(reset).toBeEnabled();

  // The reset control returns to fit (and disables again).
  await reset.click();
  await expect(value).toHaveText(fitText);
  await expect(reset).toBeDisabled();

  // The zoom-in button zooms past fit; Esc still closes even while zoomed.
  await dialog.getByRole('button', {name: 'Zoom in'}).click();
  await dialog.getByRole('button', {name: 'Zoom in'}).click();
  await expect(reset).toBeEnabled();
  const zoomed = parseInt((await value.textContent())?.trim() ?? '0', 10);
  expect(zoomed).toBeGreaterThan(fitPct);

  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
});
