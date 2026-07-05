import {test, expect} from './fixtures';
import {SERVER} from './seed';
import type {Locator, Page} from '@playwright/test';

// OB-376: pressing a control must change colour only — zero geometry delta. The
// old treatments scaled the element on :active (Button `active:scale-[0.97]`,
// IconButton `active:scale-[0.94]`, kit action `translateY(1px)`), which shifts
// getBoundingClientRect. This guard holds a real mousedown (so `:active`
// engages) and asserts the element's rect is byte-identical before vs during
// the press. To prove the mousedown actually engaged `:active` in this harness
// (otherwise rect-equality would be trivially true), it also asserts the
// background-color changes during the press — the surviving colour-only feedback.

type Rect = {x: number; y: number; width: number; height: number};

const rectOf = (loc: Locator): Promise<Rect> =>
  loc.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return {x: r.x, y: r.y, width: r.width, height: r.height};
  });

const bgOf = (loc: Locator): Promise<string> =>
  loc.evaluate((el) => getComputedStyle(el).backgroundColor);

/**
 * Hold a real mousedown over the centre of `loc`, assert its bounding rect is
 * identical to the resting rect (no scale/translate on :active), and assert the
 * background-color changed while pressed (press engaged + colour-only feedback).
 * The mouseup happens off the target so no click side-effect (dialog, dropdown,
 * clipboard) fires — keeping the run overlay-free.
 */
async function expectColourOnlyPress(page: Page, loc: Locator): Promise<void> {
  await expect(loc).toBeVisible();
  const box = await loc.boundingBox();
  if (!box) throw new Error('target has no bounding box');
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  const restRect = await rectOf(loc);
  const restBg = await bgOf(loc);

  await page.mouse.move(cx, cy);
  await page.mouse.down();
  try {
    // Let any :active transition finish before measuring — background-color (and
    // the *old* transform) animate on the shared tempo, so an instantaneous read
    // would miss a would-be scale/translate and catch a pre-transition colour.
    await page.waitForTimeout(350);
    const pressedRect = await rectOf(loc);
    const pressedBg = await bgOf(loc);
    expect(pressedRect).toEqual(restRect); // geometry must not shift on press
    expect(pressedBg).not.toBe(restBg); // press engaged, and it is colour-only
  } finally {
    await page.mouse.move(2, 2); // release off-target: mouseup must not = click
    await page.mouse.up();
  }
}

test('press-state: Button and IconButton change colour only, no geometry shift', {tag: ['@shell']}, async ({page, request}) => {
  const res = await request.post(`${SERVER}/api/pages`, {
    data: {name: `Press State ${Date.now()}`, data: {editorjs: {blocks: []}, values: [], names: []}},
  });
  const {id} = (await res.json()) as {id: string};
  await page.goto(`/?page=${id}`);
  await expect(page.getByRole('button', {name: 'Page actions'})).toBeVisible();

  // Representative shared Button — the sidebar Settings launcher (opens on click,
  // so a held mousedown engages :active without any side effect).
  const settings = page.getByRole('button', {name: 'Settings'}).first();
  // Representative shared IconButton — the page-actions cluster copy-link button.
  const copyLink = page.getByRole('button', {name: 'Copy link'});

  // Light mode.
  await expectColourOnlyPress(page, settings);
  await expectColourOnlyPress(page, copyLink);

  // Dark mode — press feedback must still be visible and geometry-stable.
  await page.locator('[data-profile-menu]').click();
  await page.getByRole('menuitem', {name: 'Color mode'}).click();
  await page.getByRole('menuitemradio', {name: 'Dark'}).click();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.classList.contains('dark')))
    .toBe(true);
  await page.keyboard.press('Escape'); // dismiss the profile menu

  await expectColourOnlyPress(page, settings);
  await expectColourOnlyPress(page, copyLink);
});
