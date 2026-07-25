import {test, expect} from './fixtures';
import {newPage} from './seed';

// The whole-library page-link graph side pane (OB-33). Opens from the command
// palette (and the links-pane header); renders the current page's N-hop
// neighbourhood with mention vs relation edges drawn distinctly, the current
// page highlighted, and node-click navigation.

// Per-test workspace isolation so fixed page names can't collide across tests.
test.use({freshWorkspace: true});

/** A page snapshot whose body @-mentions `targetId` (a real link edge). */
const mentionData = (targetId: string) => ({
  editorjs: {blocks: [{type: 'paragraph', data: {text: `See <a data-page-id="${targetId}">the target</a> for more.`}}]},
  values: [],
  names: [],
});

/** The split side pane aside (aria-label "Split view"). */
const paneOf = (page: import('@playwright/test').Page) => page.getByRole('complementary', {name: 'Split view'});

test('command palette opens the page graph; the source node is visible and a node navigates', {tag: ['@shell']}, async ({page, request}) => {
  // A small mention chain: Source → Hub → Alpha (ids referenced must exist first).
  const alphaId = await newPage(request, 'Graph Alpha Page');
  const hubId = await newPage(request, 'Graph Hub Page', mentionData(alphaId));
  await newPage(request, 'Graph Source Page', mentionData(hubId));

  await page.goto(`/?page=${hubId}`);
  await expect(page.getByRole('button', {name: 'Page actions'})).toBeVisible();

  await page.keyboard.press('ControlOrMeta+k');
  await page.getByPlaceholder(/Search pages or run a command/).fill('Page graph');
  await page.keyboard.press('Enter');

  const pane = paneOf(page);
  await expect(pane.getByText('Page graph', {exact: true})).toBeVisible(); // pane header

  // The current page renders as the highlighted node, plus its neighbours.
  const current = pane.locator('[data-graph-node="current"]');
  await expect(current).toContainText('Graph Hub Page');
  const alpha = pane.locator('[data-graph-node]', {hasText: 'Graph Alpha Page'});
  await expect(alpha).toBeVisible();
  await expect(pane.locator('[data-graph-node]', {hasText: 'Graph Source Page'})).toBeVisible();

  // Clicking a node navigates the primary pane to that page.
  await alpha.click();
  await expect(page).toHaveURL(new RegExp(alphaId));
});

test('the graph shows an empty state for a library with no links', {tag: ['@shell']}, async ({page, request}) => {
  const soloId = await newPage(request, 'Graph Solo Unlinked Page');

  await page.goto(`/?page=${soloId}`);
  await expect(page.getByRole('button', {name: 'Page actions'})).toBeVisible();

  await page.keyboard.press('ControlOrMeta+k');
  await page.getByPlaceholder(/Search pages or run a command/).fill('Page graph');
  await page.keyboard.press('Enter');

  const pane = paneOf(page);
  // A single page with no edges has no neighbourhood to draw.
  await expect(pane.getByText('No linked pages yet')).toBeVisible();
});
