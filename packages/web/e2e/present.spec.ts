import {test, expect} from './fixtures';
import {SERVER} from './seed';

// Structural per-test isolation (OB-223): wipe the worker's workspace before
// each test so the decks this file creates don't leak onto sibling specs sharing
// the worker (that cross-spec pollution is what destabilised the neighbouring
// update-scheduler spec). Note this does NOT make bare `/` render Home — a page
// created *within* a test repopulates the workspace, and the startup resolver
// then reopens that page (list[0]) rather than Home; the Home assertion below
// pins Home explicitly with `?page=home` instead.
test.use({freshWorkspace: true});

// Present mode: a page rendered as a slide deck (split at dividers), read-only
// but with live widgets, speaker notes surfaced only in the presenter console.
test('present mode: slides, navigation, a live widget, and speaker notes', {tag: ['@editor']}, async ({page, request}) => {
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

// IA-8: Present is a visible one-click affordance in the page-actions cluster
// (not only the "…" submenu). Click = full-screen deck; the OS fullscreen
// request may be refused in headless, but the overlay opens regardless.
test('present button in the page-actions cluster opens the deck', {tag: ['@editor']}, async ({page, request}) => {
  const blockdoc = {
    blocks: [
      {id: 'h1', type: 'heading', props: {level: 1}, text: [{t: 'Only Slide'}]},
    ],
  };
  const res = await request.post(`${SERVER}/api/pages`, {
    data: {
      name: `Deck Button ${Date.now()}`,
      data: {editor: 'blocks', blockdoc, editorjs: {blocks: []}, values: [], names: []},
    },
  });
  const {id} = (await res.json()) as {id: string};

  // Home offers no Present control (nothing to present there). Address Home
  // explicitly (`?page=home`): bare `/` is NOT reliably Home — with any page in
  // the workspace and no last-visited page, the startup resolver reopens the
  // first page (list[0]), which here is the deck just created above, so `/` would
  // render a document whose cluster legitimately shows Present. `?page=home`
  // pins the Home pseudo-page regardless of workspace contents. The copy-link
  // button always renders in the cluster (disabled on Home), so it anchors the
  // "cluster is mounted" wait without depending on doc-action registration.
  await page.goto('/?page=home');
  // Scope to the sticky nav bar: the sidebar renders row-action "Present"/"Copy
  // link" buttons that a page-wide query would also match.
  const topNav = page.locator('nav.sticky');
  await expect(topNav.getByRole('button', {name: 'Copy link'})).toBeVisible();
  await expect(topNav.getByRole('button', {name: 'Present', exact: true})).toHaveCount(0);

  // …a document page does, and one click opens the deck.
  await page.goto(`/?page=${id}`);
  await expect(topNav.getByRole('button', {name: 'Page actions'})).toBeVisible();
  const presentButton = topNav.getByRole('button', {name: 'Present', exact: true});
  await presentButton.click();
  const present = page.locator('.ob-present');
  await expect(present).toBeVisible();
  await expect(present.locator('.ob-present-stage').getByRole('heading', {name: 'Only Slide'})).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(present).toHaveCount(0);
});
