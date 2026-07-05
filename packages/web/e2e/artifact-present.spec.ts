import {test, expect} from './fixtures';
import {newPage} from './seed';

// "Run / present" an HTML artifact full-window (ArtifactOverlay): an expand
// affordance on the block's frame opens the sandboxed document edge-to-edge in
// a full-viewport overlay — for editors, readers, and inside present mode.
//
// State contract (documented on ArtifactOverlay): expanding is a CLEAN
// RE-INSTANTIATION — the overlay runs a fresh instance of the document (its
// state starts over), while the INLINE frame stays mounted untouched, so
// closing returns you to the inline instance exactly as you left it.

// A self-contained interactive artifact: inline JS wiring a counter button.
const COUNTER_HTML = `
<button id="btn" type="button" style="cursor:pointer;font:16px system-ui;padding:8px 14px">Count: 0</button>
<script>
  var n = 0;
  var b = document.getElementById('btn');
  b.addEventListener('click', function () { n += 1; b.textContent = 'Count: ' + n; });
</script>
`;

async function openEditor(page: import('@playwright/test').Page, pageId: string): Promise<void> {
  await page.goto(`/?page=${pageId}`);
  const para = page.locator('.obe-text').first();
  await para.waitFor({state: 'visible'});
  await expect(async () => {
    await para.click();
    await expect(para).toBeFocused({timeout: 500});
  }).toPass({timeout: 10_000});
}

/** Slash-insert the HTML artifact block and upload `html` through its picker. */
async function insertArtifact(page: import('@playwright/test').Page, html: string): Promise<void> {
  await page.keyboard.type('/HTML artifact');
  const item = page.locator('.obe-slash-item', {has: page.locator('.obe-slash-label', {hasText: 'HTML artifact'})});
  await item.first().click();
  const input = page.locator('.obe-artifact input[type=file]');
  await input.setInputFiles({name: 'counter_demo.html', mimeType: 'text/html', buffer: Buffer.from(html)});
  await expect(page.frameLocator('.obe-artifact iframe').locator('#btn')).toBeVisible();
}

/** The expand affordance is hover chrome — reveal it, then click. */
async function expand(page: import('@playwright/test').Page, scope = ''): Promise<void> {
  const frame = page.locator(`${scope} .obe-artifact-frame`.trim()).first();
  await frame.hover();
  await frame.locator('.obe-artifact-expand').click();
  await expect(page.getByTestId('artifact-overlay')).toBeVisible();
}

test('expand runs the artifact full-window; overlay is a fresh instance, inline state survives', {tag: ['@editor']}, async ({page, request}) => {
  const pageId = await newPage(request, 'Artifact Expand E2E');
  await openEditor(page, pageId);
  await insertArtifact(page, COUNTER_HTML);

  // Interact INLINE first, so the state contract is observable. (The overlay
  // portals to <body>, so `.obe-artifact iframe` only ever matches the inline frame.)
  const inlineBtn = page.frameLocator('.obe-artifact iframe').locator('#btn');
  await inlineBtn.click();
  await expect(inlineBtn).toHaveText('Count: 1');

  await expand(page);
  const overlay = page.getByTestId('artifact-overlay');

  // Edge-to-edge: the overlay frame fills the viewport (full width; full
  // height minus the slim chrome bar).
  const viewport = page.viewportSize()!;
  const frameBox = (await overlay.locator('iframe').boundingBox())!;
  expect(frameBox.width).toBeGreaterThanOrEqual(viewport.width - 2);
  expect(frameBox.height).toBeGreaterThanOrEqual(viewport.height - 60);

  // Clean re-instantiation: the overlay runs a FRESH document (Count: 0) —
  // and it is fully interactive inside.
  const overlayBtn = overlay.frameLocator('iframe').locator('#btn');
  await expect(overlayBtn).toHaveText('Count: 0');
  await overlayBtn.click();
  await overlayBtn.click();
  await expect(overlayBtn).toHaveText('Count: 2');

  // The always-visible close button restores the page view — and the INLINE
  // instance kept its own state untouched (still Count: 1).
  await overlay.getByRole('button', {name: 'Close full window'}).click();
  await expect(page.getByTestId('artifact-overlay')).toHaveCount(0);
  await expect(inlineBtn).toHaveText('Count: 1');
});

test('focus recovery: after clicking inside the sandbox, overlay chrome brings Esc back', {tag: ['@editor']}, async ({page, request}) => {
  const pageId = await newPage(request, 'Artifact Focus E2E');
  await openEditor(page, pageId);
  await insertArtifact(page, COUNTER_HTML);
  await expand(page);
  const overlay = page.getByTestId('artifact-overlay');

  // Click INSIDE the artifact: focus moves into the cross-origin frame, where
  // the app can't see keystrokes — that's the sandbox isolation working.
  await overlay.frameLocator('iframe').locator('#btn').click();
  // A click on the overlay chrome (app DOM) recovers focus; Esc then closes —
  // a mouse user is never trapped (the close button always works too).
  await overlay.locator('header').click();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('artifact-overlay')).toHaveCount(0);
});

test('present mode: the artifact expands full-window within the deck and back', {tag: ['@editor']}, async ({page, request}) => {
  const pageId = await newPage(request, 'Artifact Present Expand E2E');
  await openEditor(page, pageId);
  await insertArtifact(page, COUNTER_HTML);

  // Presenter view avoids the OS fullscreen request (flaky in headless).
  await page.getByRole('button', {name: 'Page actions'}).click();
  await page.getByRole('menuitem', {name: 'Present'}).click();
  await page.getByRole('menuitem', {name: 'Presenter view'}).click();
  const present = page.locator('.ob-present');
  await expect(present).toBeVisible();

  // The expand affordance is a VIEWING control: available on the presented
  // stage even though all authoring chrome is hidden.
  await expect(present.locator('.obe-artifact-tool')).toHaveCount(0);
  await expand(page, '.ob-present-stage');
  const overlay = page.getByTestId('artifact-overlay');

  // Interactive full-window inside the deck.
  const overlayBtn = overlay.frameLocator('iframe').locator('#btn');
  await overlayBtn.click();
  await expect(overlayBtn).toHaveText('Count: 1');

  // Close the overlay: the deck is still presenting underneath (the overlay is
  // the topmost layer — Esc/close never tears down the presentation itself).
  await overlay.getByRole('button', {name: 'Close full window'}).click();
  await expect(page.getByTestId('artifact-overlay')).toHaveCount(0);
  await expect(present).toBeVisible();

  // Exit present as usual (click app chrome first — focus may sit in the frame).
  await present.locator('.ob-present-aside').click();
  await page.keyboard.press('Escape');
  await expect(present).toHaveCount(0);
});
