import {test, expect} from './fixtures';
import {newPage} from './seed';

// The persistent "Linked references" side pane (OB-32). Promotes the backlinks
// popover chip to a durable pane with two sections: Backlinks (pages that
// @-mention or relate to this one) and Unlinked mentions (pages whose text names
// it without linking). Opens from the header chip and the command palette.

// Per-test workspace isolation so fixed page names can't collide across tests
// sharing this worker.
test.use({freshWorkspace: true});

/** A page snapshot whose body @-mentions `targetId` (a real backlink). */
const backlinkData = (targetId: string) => ({
  editorjs: {blocks: [{type: 'paragraph', data: {text: `See <a data-page-id="${targetId}">the target</a> for details.`}}]},
  values: [],
  names: [],
});

/** A page snapshot whose body is plain text (no links). */
const textData = (text: string) => ({
  editorjs: {blocks: [{type: 'paragraph', data: {text}}]},
  values: [],
  names: [],
});

/** A page snapshot that BOTH @-links `targetId` AND names it in plain text. */
const linkAndNameData = (targetId: string, name: string) => ({
  editorjs: {
    blocks: [
      {type: 'paragraph', data: {text: `Notes on ${name} — see <a data-page-id="${targetId}">the target</a> too.`}},
    ],
  },
  values: [],
  names: [],
});

/** The split side pane aside (aria-label "Split view"). */
const paneOf = (page: import('@playwright/test').Page) => page.getByRole('complementary', {name: 'Split view'});

test('backlinks chip opens the links pane; a seeded backlink row navigates', {tag: ['@shell', '@p1']}, async ({page, request}) => {
  const targetId = await newPage(request, 'Quokkaphile Reference');
  const sourceId = await newPage(request, 'Backlink Source Page', backlinkData(targetId));

  await page.goto(`/?page=${targetId}`);
  await expect(page.getByRole('button', {name: 'Page actions'})).toBeVisible();

  // The header controls are hover-gated; reveal them, then click the chip.
  await page.getByLabel('Page title').hover();
  await page.getByRole('button', {name: 'Linked references'}).click();

  const pane = paneOf(page);
  await expect(pane.getByRole('heading', {name: /^Backlinks/})).toBeVisible();
  const row = pane.getByRole('button', {name: /Backlink Source Page/});
  await expect(row).toBeVisible();

  // Clicking the backlink navigates the primary pane to the source page.
  await row.click();
  await expect(page).toHaveURL(new RegExp(sourceId));
});

test('command palette opens the pane; unlinked mentions surface with backlink/self exclusions', {tag: ['@shell']}, async ({page, request}) => {
  const targetId = await newPage(request, 'Wolfram Beacon');
  // Links here → a backlink, so it must NOT appear as an unlinked mention.
  await newPage(request, 'Linking Page', backlinkData(targetId));
  // Names the target in plain text without linking → an unlinked mention.
  await newPage(request, 'Mentioning Page', textData('a discussion of Wolfram Beacon and related topics'));

  await page.goto(`/?page=${targetId}`);
  await expect(page.getByRole('button', {name: 'Page actions'})).toBeVisible();

  await page.keyboard.press('ControlOrMeta+k');
  await page.getByPlaceholder(/Search pages or run a command/).fill('Linked references');
  await page.keyboard.press('Enter');

  const pane = paneOf(page);
  await expect(pane.getByText('Linked references', {exact: true})).toBeVisible(); // pane header
  await expect(pane.getByRole('heading', {name: /^Backlinks/})).toBeVisible();
  await expect(pane.getByRole('heading', {name: /^Unlinked mentions/})).toBeVisible();

  // The mentioning page is an unlinked mention; the linking page is a backlink.
  await expect(pane.getByRole('button', {name: /Mentioning Page/})).toBeVisible();
  await expect(pane.getByRole('button', {name: /Linking Page/})).toBeVisible();

  // Exclusions: the Unlinked mentions section holds exactly one row (the
  // Mentioning Page). The linking page (a backlink) and the target itself never
  // leak in. (Rows also carry snippet text that may echo the page name, so we
  // assert on the row count rather than name-matching.)
  const mentions = pane.getByRole('region', {name: 'Unlinked mentions'});
  await expect(mentions.getByRole('button', {name: /Mentioning Page/})).toBeVisible();
  await expect(mentions.getByRole('button', {name: /Linking Page/})).toHaveCount(0);
  await expect(mentions.getByRole('button')).toHaveCount(1);
});

test('a page that both links and names the target appears under Backlinks only', {tag: ['@shell']}, async ({
  page,
  request,
}) => {
  const targetId = await newPage(request, 'Platypus Digest');
  // This page @-links the target AND spells its name in plain text. The
  // already-linked exclusion must win: it's a Backlink, never an unlinked mention.
  await newPage(request, 'Link And Name Page', linkAndNameData(targetId, 'Platypus Digest'));

  await page.goto(`/?page=${targetId}`);
  await expect(page.getByRole('button', {name: 'Page actions'})).toBeVisible();

  await page.getByLabel('Page title').hover();
  await page.getByRole('button', {name: 'Linked references'}).click();

  const pane = paneOf(page);
  const backlinks = pane.getByRole('region', {name: 'Backlinks'});
  const mentions = pane.getByRole('region', {name: 'Unlinked mentions'});

  // Present under Backlinks…
  await expect(backlinks.getByRole('button', {name: /Link And Name Page/})).toBeVisible();
  // …and absent from Unlinked mentions (the already-linked exclusion).
  await expect(mentions.getByRole('button', {name: /Link And Name Page/})).toHaveCount(0);
});

test('empty state shows when a page has no backlinks or mentions', {tag: ['@shell']}, async ({page, request}) => {
  const targetId = await newPage(request, 'Lonely Unreferenced Page');

  await page.goto(`/?page=${targetId}`);
  await expect(page.getByRole('button', {name: 'Page actions'})).toBeVisible();

  await page.getByLabel('Page title').hover();
  await page.getByRole('button', {name: 'Linked references'}).click();

  const pane = paneOf(page);
  await expect(pane.getByText('Nothing links here yet.')).toBeVisible();
});

test('Escape closes the pane when focus is inside it', {tag: ['@shell']}, async ({page, request}) => {
  const targetId = await newPage(request, 'Escape Target Page');
  await newPage(request, 'Escape Source Page', backlinkData(targetId));

  await page.goto(`/?page=${targetId}`);
  await expect(page.getByRole('button', {name: 'Page actions'})).toBeVisible();

  await page.getByLabel('Page title').hover();
  await page.getByRole('button', {name: 'Linked references'}).click();

  const pane = paneOf(page);
  const row = pane.getByRole('button', {name: /Escape Source Page/});
  await expect(row).toBeVisible();

  // Focus a row (keyboard entry point), then Escape dismisses the pane.
  await row.focus();
  await page.keyboard.press('Escape');
  await expect(pane).toHaveCount(0);
});
