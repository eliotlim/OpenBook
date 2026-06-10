import {test, expect, takeSnapshot} from '@chromatic-com/playwright';

// The custom CRDT block editor, exercised through its sandbox (/editor-lab).
// The lab persists to localStorage only — every test starts it blank, so
// these are immune to the workspace name-pollution issues.

async function freshLab(page: import('@playwright/test').Page): Promise<void> {
  // Clear the sandbox doc once per tab (not on every navigation — reload
  // tests need the saved state to survive).
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('obe-e2e-cleared')) {
      localStorage.removeItem('obe-lab-doc');
      sessionStorage.setItem('obe-e2e-cleared', '1');
    }
  });
  await page.goto('/editor-lab');
  await expect(page.locator('.obe-text').first()).toBeVisible();
}

/** Place the caret at the end of the nth text block. */
async function caretAtEnd(page: import('@playwright/test').Page, nth: number): Promise<void> {
  await page.locator('.obe-text').nth(nth).click();
  await page.keyboard.press('ControlOrMeta+ArrowDown'); // end of block on mac; harmless elsewhere
  await page.evaluate((n) => {
    const el = [...document.querySelectorAll('.obe-text')][n] as HTMLElement;
    el.focus();
    const sel = getSelection()!;
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
  }, nth);
}

const blockTypes = (page: import('@playwright/test').Page): Promise<string[]> =>
  page.evaluate(() => [...document.querySelectorAll('[data-block-type]')].map((r) => (r as HTMLElement).dataset.blockType!));

test('typing, Enter split, and markdown shortcuts build structure', async ({page}) => {
  await freshLab(page);
  await caretAtEnd(page, 1);
  await page.keyboard.type(' Plus typed text.');
  await expect(page.locator('.obe-text').nth(1)).toContainText('Plus typed text.');

  await page.keyboard.press('Enter');
  await page.keyboard.type('## ');
  await page.keyboard.type('A new section');
  await expect(page.locator('.obe-h2 .obe-text')).toHaveText('A new section');

  await page.keyboard.press('Enter');
  await page.keyboard.type('- ');
  await page.keyboard.type('first bullet');
  await page.keyboard.press('Enter');
  await page.keyboard.type('second bullet');
  expect(await blockTypes(page)).toEqual(expect.arrayContaining(['heading', 'list']));
  await expect(page.locator('.obe-list')).toHaveCount(2);
});

test('slash menu inserts blocks; query filters; Escape closes', async ({page}, testInfo) => {
  await freshLab(page);
  await caretAtEnd(page, 2);
  await page.keyboard.press('Enter');

  await page.keyboard.type('/');
  await expect(page.locator('.obe-slash')).toBeVisible();
  await takeSnapshot(page, testInfo); // visual: slash menu

  await page.keyboard.type('table');
  await expect(page.locator('.obe-slash-item')).toHaveCount(1);
  await page.keyboard.press('Enter');
  await expect(page.locator('.obe-table')).toBeVisible();
  // 3×3 with a header row to start.
  await expect(page.locator('.obe-table td')).toHaveCount(9);

  // Escape path: open on a fresh block and dismiss.
  await caretAtEnd(page, 0);
  await page.keyboard.press('Enter');
  await page.keyboard.type('/');
  await expect(page.locator('.obe-slash')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.obe-slash')).toBeHidden();
});

test('inline toolbar formats a selection as bold rich-text runs', async ({page}) => {
  await freshLab(page);
  // Select the word "scratch" in the intro paragraph.
  await page.evaluate(() => {
    const p = [...document.querySelectorAll('.obe-text')][1] as HTMLElement;
    const tn = p.firstChild as Text;
    const idx = tn.textContent!.indexOf('scratch');
    const sel = getSelection()!;
    const range = document.createRange();
    range.setStart(tn, idx);
    range.setEnd(tn, idx + 7);
    sel.removeAllRanges();
    sel.addRange(range);
    p.focus();
  });
  await page.locator('.obe-text').nth(1).dispatchEvent('mouseup');
  await expect(page.locator('.obe-toolbar')).toBeVisible();

  await page.locator('.obe-tb-btn', {hasText: 'B'}).first().dispatchEvent('mousedown');
  await expect(page.locator('.obe-text strong', {hasText: 'scratch'})).toBeVisible();

  // ⌘B over the same range toggles it back off.
  await page.evaluate(() => {
    const p = [...document.querySelectorAll('.obe-text')][1] as HTMLElement;
    const strong = p.querySelector('strong')!;
    const sel = getSelection()!;
    const range = document.createRange();
    range.selectNodeContents(strong);
    sel.removeAllRanges();
    sel.addRange(range);
    p.focus();
  });
  await page.keyboard.press('ControlOrMeta+b');
  await expect(page.locator('.obe-text strong')).toHaveCount(0);
});

test('drag a block beside another to create columns; mobile stays stacked', async ({page}) => {
  await freshLab(page);
  const heading = page.locator('[data-block-row][data-block-type=todo]');
  const target = page.locator('[data-block-row][data-block-type=paragraph]').first();

  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  await heading.locator('.obe-handle').dispatchEvent('dragstart', {dataTransfer});
  const box = (await target.boundingBox())!;
  await target.dispatchEvent('dragover', {clientX: box.x + box.width * 0.95, clientY: box.y + box.height / 2});
  await target.dispatchEvent('drop', {clientX: box.x + box.width * 0.95, clientY: box.y + box.height / 2});

  await expect(page.locator('.obe-columns')).toBeVisible();
  await expect(page.locator('.obe-columns .obe-column')).toHaveCount(2);

  // Mobile: the grid collapses to a stack (flex column).
  await page.setViewportSize({width: 420, height: 800});
  const direction = await page.locator('.obe-columns').evaluate((el) => getComputedStyle(el).flexDirection);
  expect(direction).toBe('column');
});

test('block selection: Escape selects, Backspace deletes, undo restores', async ({page}) => {
  await freshLab(page);
  await caretAtEnd(page, 1);
  await page.keyboard.press('Escape');
  await expect(page.locator('.obe-row-selected')).toHaveCount(1);

  await page.keyboard.press('Backspace');
  await expect(page.locator('[data-block-type=paragraph]')).toHaveCount(0);

  await page.keyboard.press('ControlOrMeta+z');
  await expect(page.locator('[data-block-type=paragraph]')).toHaveCount(1);
  await expect(page.locator('.obe-text').nth(1)).toContainText('A scratch document');
});

test('todo checkbox toggles and persists through reload', async ({page}) => {
  await freshLab(page);
  await page.locator('.obe-todo-box').check();
  await expect(page.locator('.obe-todo')).toHaveClass(/obe-todo-done/);
  // The lab autosaves (debounced) to localStorage.
  await page.waitForTimeout(700);
  await page.reload();
  await expect(page.locator('.obe-todo')).toHaveClass(/obe-todo-done/);
});

test('CRDT: edits in one tab appear live in another', async ({page, context}) => {
  await freshLab(page);
  const other = await context.newPage();
  await other.goto('/editor-lab');
  await expect(other.locator('.obe-text').first()).toBeVisible();

  await caretAtEnd(page, 1);
  await page.keyboard.type(' [from tab one]');
  await expect(other.locator('.obe-text').nth(1)).toContainText('[from tab one]', {timeout: 5000});

  // And the reverse direction, concurrently with tab one's content intact.
  await other.bringToFront();
  await caretAtEnd(other, 2);
  await other.keyboard.type(' [from tab two]');
  await expect(other.locator('.obe-text').nth(2)).toContainText('[from tab two]'); // landed locally
  await expect(page.locator('.obe-text').nth(2)).toContainText('[from tab two]', {timeout: 5000});
  await expect(page.locator('.obe-text').nth(1)).toContainText('[from tab one]');
  await other.close();
});

test('real page: legacy EditorJS content migrates, saves, and reopens in the block editor', async ({page, request}) => {
  // Seed a legacy page through the API (run-tagged name — workspace-unique).
  const res = await request.post('http://127.0.0.1:4319/api/pages', {
    data: {
      name: `BlockNext ${Date.now()}`,
      data: {
        editorjs: {
          blocks: [
            {id: 'l1', type: 'header', data: {text: 'Migrated heading', level: 2}},
            {id: 'l2', type: 'paragraph', data: {text: 'Legacy <b>bold</b> text.'}},
          ],
        },
        values: [],
        names: [],
      },
    },
  });
  const {id} = (await res.json()) as {id: string};

  // Opt in via the query flag: the legacy document migrates into the editor.
  await page.goto(`/?page=${id}&editor=next`);
  await expect(page.locator('.obe-root')).toBeVisible();
  await expect(page.locator('.obe-h2 .obe-text')).toHaveText('Migrated heading');
  await expect(page.locator('.obe-text strong')).toHaveText('bold');

  // Edit → autosave stamps the page `editor: 'blocks'`.
  await page.evaluate(() => {
    const el = [...document.querySelectorAll('.obe-text')][1] as HTMLElement;
    el.focus();
    const sel = getSelection()!;
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
  });
  await page.keyboard.type(' Now ours.');
  await expect
    .poll(async () => {
      const stored = (await (await request.get(`http://127.0.0.1:4319/api/pages/${id}`)).json()) as {
        data: {editor?: string};
      };
      return stored.data.editor;
    })
    .toBe('blocks');

  // Reopening WITHOUT the flag stays in the block editor with the edit intact.
  await page.goto(`/?page=${id}`);
  await expect(page.locator('.obe-root')).toBeVisible();
  await expect(page.locator('.obe-text').nth(1)).toContainText('Now ours.');
});

test('table editing: type in cells, add a row and a column', async ({page}) => {
  await freshLab(page);
  await caretAtEnd(page, 2);
  await page.keyboard.press('Enter');
  await page.keyboard.type('/table');
  await page.keyboard.press('Enter');
  await expect(page.locator('.obe-table')).toBeVisible();

  await page.locator('.obe-table .obe-text').first().click();
  await page.keyboard.type('Header A');
  await expect(page.locator('.obe-table .obe-text').first()).toHaveText('Header A');

  await page.locator('.obe-table-add-row').click();
  await expect(page.locator('.obe-table tr')).toHaveCount(4);
  await page.locator('.obe-table-add-col').click();
  await expect(page.locator('.obe-table tr').first().locator('td')).toHaveCount(4);
});
