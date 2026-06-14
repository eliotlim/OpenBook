import {test, expect} from './fixtures';
import {SERVER} from './seed';

// Present mode: a page rendered as a slide deck (split at dividers), read-only
// but with live widgets, speaker notes surfaced only in the presenter console.
test('present mode: slides, navigation, a live widget, and speaker notes', async ({page, request}) => {
  const blockdoc = {
    blocks: [
      {id: 'h1', type: 'heading', props: {level: 1}, text: [{t: 'Slide One'}]},
      {id: 'sl', type: 'slider', props: {name: 'x', value: 4, min: 0, max: 10}},
      {id: 'nt', type: 'notes', text: [{t: 'Remember to breathe'}]},
      {id: 'd1', type: 'divider'},
      {id: 'h2', type: 'heading', props: {level: 1}, text: [{t: 'Slide Two'}]},
      {id: 'p2', type: 'paragraph', text: [{t: 'Second slide body'}]},
    ],
  };
  const res = await request.post(`${SERVER}/api/pages`, {
    data: {
      name: `Deck ${Date.now()}`,
      data: {editor: 'blocks', blockdoc, editorjs: {blocks: []}, values: [], names: []},
    },
  });
  const {id} = (await res.json()) as {id: string};
  await page.goto(`/?page=${id}`);
  await expect(page.getByRole('button', {name: 'Page actions'})).toBeVisible();

  // Open Present → Presenter view from the "…" menu (presenter avoids the OS
  // fullscreen request, which headless Chromium handles inconsistently).
  await page.getByRole('button', {name: 'Page actions'}).click();
  await page.getByRole('menuitem', {name: 'Present'}).click();
  await page.getByRole('menuitem', {name: 'Presenter view'}).click();

  const present = page.locator('.ob-present');
  await expect(present).toBeVisible();
  const stage = present.locator('.ob-present-stage');

  // Slide one shows; its speaker note is NOT in the audience slide…
  await expect(stage.getByRole('heading', {name: 'Slide One'})).toBeVisible();
  await expect(stage.getByText('Remember to breathe')).toHaveCount(0);
  // …but the presenter notes panel shows it, and the next-slide preview is slide two.
  await expect(present.locator('.ob-present-notes-panel').getByText('Remember to breathe')).toBeVisible();
  await expect(present.locator('.ob-present-next').getByText('Slide Two')).toBeVisible();

  // The page reads as locked, but the slider stays interactive.
  await expect(stage.locator('.obe-kit-slider input[type=range]')).toBeEnabled();

  // Navigate to slide two.
  await present.getByRole('button', {name: 'Next slide'}).click();
  await expect(stage.getByRole('heading', {name: 'Slide Two'})).toBeVisible();
  await expect(stage.getByText('Second slide body')).toBeVisible();

  // Escape exits present mode.
  await page.keyboard.press('Escape');
  await expect(present).toHaveCount(0);
});
