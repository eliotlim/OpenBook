import {test, expect} from './fixtures';
import {newPage, SERVER} from './seed';

// The htmlArtifact block: an untrusted .html document rendered through the
// sandboxed-iframe surface (SandboxedHtml — opaque origin, allow-scripts but
// never allow-same-origin). Real-browser coverage because jsdom can't execute
// iframe scripts: the slash → picker flow, the drop-at-position funnel, and
// present mode keeping the document interactive with the authoring chrome gone.

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
  // Clicking before the editor finishes wiring focus silently drops the caret —
  // retry until the paragraph holds focus (same guard as mention.spec).
  await expect(async () => {
    await para.click();
    await expect(para).toBeFocused({timeout: 500});
  }).toPass({timeout: 10_000});
}

/** Slash-insert the HTML artifact block and upload `html` through its picker. */
async function insertArtifact(page: import('@playwright/test').Page, html: string, fileName = 'counter_demo.html'): Promise<void> {
  await page.keyboard.type('/HTML artifact');
  const item = page.locator('.obe-slash-item', {has: page.locator('.obe-slash-label', {hasText: 'HTML artifact'})});
  await item.first().click();
  // The empty block's placeholder hosts a hidden picker filtered to .html.
  const input = page.locator('.obe-artifact input[type=file]');
  await expect(input).toHaveAttribute('accept', '.html,.htm,text/html');
  await input.setInputFiles({name: fileName, mimeType: 'text/html', buffer: Buffer.from(html)});
}

test('slash → pick a .html file → the sandboxed artifact renders and its script runs', {tag: ['@editor']}, async ({page, request}) => {
  const pageId = await newPage(request, 'Artifact Host E2E');
  await openEditor(page, pageId);
  await insertArtifact(page, COUNTER_HTML);

  // The document renders inside the sandboxed frame, and its inline script is
  // ALIVE: clicking the button mutates the frame's own DOM.
  const frame = page.frameLocator('.obe-artifact iframe');
  const btn = frame.locator('#btn');
  await expect(btn).toHaveText('Count: 0');
  await btn.click();
  await expect(btn).toHaveText('Count: 1');

  // The sandbox posture is the exported constant — never allow-same-origin.
  const sandbox = await page.locator('.obe-artifact iframe').getAttribute('sandbox');
  expect(sandbox).toContain('allow-scripts');
  expect(sandbox).not.toContain('allow-same-origin');

  // The title seeded from the file name, and the block persisted with an
  // assetId (the CRDT carries the pointer, not the markup).
  await expect(page.locator('input.obe-artifact-title')).toHaveValue('counter demo');
  await expect
    .poll(async () => {
      const snap = JSON.stringify((await (await request.get(`${SERVER}/api/pages/${pageId}`)).json()).data);
      return snap.includes('htmlArtifact') && snap.includes('assetId');
    })
    .toBe(true);
});

test('drag-dropping a .html file inserts an artifact block at the drop position', {tag: ['@editor']}, async ({page, request}) => {
  // Two paragraphs seeded directly; the drop lands on the FIRST row, so the
  // artifact must appear between them (insert-after-row semantics).
  const blockdoc = {
    blocks: [
      {id: 'p1', type: 'paragraph', text: [{t: 'First paragraph'}]},
      {id: 'p2', type: 'paragraph', text: [{t: 'Second paragraph'}]},
    ],
  };
  const res = await request.post(`${SERVER}/api/pages`, {
    data: {name: `Artifact Drop E2E ${Date.now()}`, data: {editor: 'blocks', blockdoc, editorjs: {blocks: []}, values: [], names: []}},
  });
  const {id} = (await res.json()) as {id: string};
  await page.goto(`/?page=${id}`);
  await expect(page.locator('.obe-text').first()).toHaveText('First paragraph');

  const dataTransfer = await page.evaluateHandle((html) => {
    const dt = new DataTransfer();
    dt.items.add(new File([html], 'dropped_widget.html', {type: 'text/html'}));
    return dt;
  }, COUNTER_HTML);
  await page.locator('[data-block-row]').first().dispatchEvent('drop', {dataTransfer});

  // The artifact lands as the second row — after the drop target, before the
  // second paragraph — and renders its interactive frame.
  const rows = page.locator('.obe-root > [data-block-row]');
  await expect(rows.nth(1)).toHaveAttribute('data-block-type', 'htmlArtifact');
  await expect(rows.nth(2).locator('.obe-text')).toHaveText('Second paragraph');
  await expect(page.frameLocator('.obe-artifact iframe').locator('#btn')).toHaveText('Count: 0');
});

test('present mode: the artifact stays interactive with no edit chrome', {tag: ['@editor']}, async ({page, request}) => {
  const pageId = await newPage(request, 'Artifact Present E2E');
  await openEditor(page, pageId);
  await insertArtifact(page, COUNTER_HTML);
  await expect(page.frameLocator('.obe-artifact iframe').locator('#btn')).toBeVisible();

  // Presenter view avoids the OS fullscreen request (flaky in headless).
  await page.getByRole('button', {name: 'Page actions'}).click();
  await page.getByRole('menuitem', {name: 'Present'}).click();
  await page.getByRole('menuitem', {name: 'Presenter view'}).click();
  const present = page.locator('.ob-present');
  await expect(present).toBeVisible();

  // The sandboxed document is LIVE on the stage: the counter still counts.
  const stageBtn = page.frameLocator('.ob-present-stage .obe-artifact iframe').locator('#btn');
  await expect(stageBtn).toHaveText('Count: 0');
  await stageBtn.click();
  await expect(stageBtn).toHaveText('Count: 1');

  // …but every authoring affordance is gone: no title input, no replace tool,
  // no resize handle (the reader sees the static title instead).
  await expect(present.locator('input.obe-artifact-title')).toHaveCount(0);
  await expect(present.locator('.obe-artifact-tool')).toHaveCount(0);
  await expect(present.locator('.obe-artifact-resize')).toHaveCount(0);
  await expect(present.locator('.obe-artifact-title-static')).toHaveText('counter demo');

  // Clicking inside the artifact moved focus INTO the sandboxed frame, where
  // the app can't see keystrokes (that's the isolation working). Click back on
  // the app surface (the presenter aside — a plain panel, safe to click with a
  // single slide) first, then Escape exits present mode.
  await present.locator('.ob-present-aside').click();
  await page.keyboard.press('Escape');
  await expect(present).toHaveCount(0);
});
