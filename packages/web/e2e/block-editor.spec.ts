import {test, expect, takeSnapshot} from './fixtures';
import {SERVER} from './seed';

// The custom CRDT block editor, exercised through its sandbox (/editor-lab).
// The lab persists to localStorage only — every test starts it blank, so
// these are immune to the workspace name-pollution issues.

// Every test here is self-contained (a fresh lab context, or a server page
// seeded under a Date.now()-unique name), so the file — the suite's longest —
// fans its tests out across workers instead of running them in sequence.
test.describe.configure({mode: 'parallel'});

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

test('typing, Enter split, and markdown shortcuts build structure', {tag: ['@editor', '@p1']}, async ({page}) => {
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

test('slash menu inserts blocks; query filters; Escape closes', {tag: ['@editor', '@visual', '@p1']}, async ({page}, testInfo) => {
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

// Regression: on a REAL page (unlike the lab) the pages group is present, and
// "New database" matches the keyword "table" — a keyword-only hit in an
// earlier group must not outrank the Table block's exact label, or "/table"
// + Enter creates a database subpage instead of inserting a table.
test('slash ranking: label matches beat keyword-only matches across groups', {tag: ['@editor', '@p1']}, async ({page}) => {
  await page.goto('/');
  await expect(page.getByRole('button', {name: 'Page actions'})).toBeVisible();
  const before = new URL(page.url()).searchParams.get('page');
  await page.keyboard.press('ControlOrMeta+n');
  await expect
    .poll(() => {
      const id = new URL(page.url()).searchParams.get('page');
      return id && id !== before ? id : null;
    })
    .toBeTruthy();

  await page.locator('.obe-text').first().click();
  await page.keyboard.type('/table');
  await expect(page.locator('.obe-slash-label').first()).toHaveText('Table');
  await page.keyboard.press('Enter');
  await expect(page.locator('.obe-table')).toBeVisible();

  // The caret lands in the table's first cell, so typing continues without a
  // click — inserting used to orphan the selection (the focused empty source
  // paragraph was deleted) and the next keystrokes vanished.
  await page.keyboard.type('Quarter');
  await expect(page.locator('.obe-table td').first()).toHaveText('Quarter');
});

// Regression: the editor folds fixed popups on document scroll via a CAPTURE
// listener — which also saw the slash menu's own internal scroll and closed
// it the moment you tried to browse a long item list.
test('slash menu scrolls internally without closing', {tag: ['@editor']}, async ({page}) => {
  await freshLab(page);
  await caretAtEnd(page, 2);
  await page.keyboard.press('Enter');
  await page.keyboard.type('/');
  const menu = page.locator('.obe-slash');
  await expect(menu).toBeVisible();

  // The full item list overflows the menu's max height.
  const overflowing = await menu.evaluate((el) => el.scrollHeight > el.clientHeight);
  expect(overflowing).toBe(true);

  // Wheel over the menu scrolls it — and the menu stays open and live
  // (typing still filters).
  await menu.hover();
  await page.mouse.wheel(0, 150);
  await expect.poll(() => menu.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  await expect(menu).toBeVisible();
  await page.keyboard.type('table');
  await expect(page.locator('.obe-slash-item')).toHaveCount(1);
});

test('inline toolbar formats a selection as bold rich-text runs', {tag: ['@editor']}, async ({page}) => {
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

test('drag a block beside another to create columns; a narrow editor container stays stacked', {tag: ['@editor']}, async ({page}) => {
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

  // Container query: a narrow pane stacks even while the browser window is wide.
  await page.setViewportSize({width: 1280, height: 800});
  await page.locator('.obe-root').evaluate((element) => { (element as HTMLElement).style.width = '420px'; });
  const direction = await page.locator('.obe-columns').evaluate((el) => getComputedStyle(el).flexDirection);
  expect(direction).toBe('column');
});

test('REAL mouse drag: handle drags a block beside another into columns', {tag: ['@editor']}, async ({page}) => {
  // Regression guard: making the handle a Radix menu trigger killed genuine
  // HTML5 drags (the menu's overlay swallowed them) while synthetic
  // dragstart/drop dispatches kept passing. This test drags for real.
  await freshLab(page);
  const row = page.locator('[data-block-row][data-block-type=todo]');
  await row.hover();
  const target = page.locator('[data-block-row][data-block-type=paragraph]').first();
  const box = (await target.boundingBox())!;
  await row.locator('.obe-handle').dragTo(target, {targetPosition: {x: box.width * 0.95, y: box.height / 2}});
  await expect(page.locator('.obe-columns')).toHaveCount(1);
  await expect(page.locator('.obe-columns .obe-column')).toHaveCount(2);

  // Regression: blocks INSIDE a column kept their drop targets but lost their
  // drag handle (the gutter only rendered at the top level) — once a block
  // entered a column it could never leave. Drag it back out below a root row.
  const inColumn = page.locator('.obe-columns [data-block-row][data-block-type=todo]');
  await inColumn.hover();
  await expect(inColumn.locator('.obe-handle')).toBeVisible();
  const lastRoot = page.locator('.obe-root > [data-block-row]').last();
  const rootBox = (await lastRoot.boundingBox())!;
  await inColumn.locator('.obe-handle').dragTo(lastRoot, {targetPosition: {x: rootBox.width / 2, y: rootBox.height * 0.9}});
  // The columns dissolve (one occupant left) and the todo is a root row again.
  await expect(page.locator('.obe-columns')).toHaveCount(0);
  await expect(page.locator('.obe-root > [data-block-row][data-block-type=todo]')).toHaveCount(1);
});

test('block selection: Escape selects, Backspace deletes, undo restores', {tag: ['@editor']}, async ({page}) => {
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

test('todo checkbox toggles and persists through reload', {tag: ['@editor']}, async ({page}) => {
  await freshLab(page);
  const before = await page.evaluate(() => localStorage.getItem('obe-lab-doc'));
  await page.locator('.obe-todo-box').check();
  await expect(page.locator('.obe-todo')).toHaveClass(/obe-todo-done/);
  // The lab autosaves (debounced) to localStorage; wait for that write to land
  // before reloading (reload drops in-memory state).
  await expect.poll(() => page.evaluate(() => localStorage.getItem('obe-lab-doc'))).not.toBe(before);
  await page.reload();
  await expect(page.locator('.obe-todo')).toHaveClass(/obe-todo-done/);
});

test('CRDT: edits in one tab appear live in another', {tag: ['@editor']}, async ({page, context}) => {
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

test('real page: legacy EditorJS content migrates, saves, and reopens in the block editor', {tag: ['@editor', '@p1']}, async ({page, request}) => {
  // Seed a legacy page through the API (run-tagged name — workspace-unique).
  const res = await request.post(`${SERVER}/api/pages`, {
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
      const stored = (await (await request.get(`${SERVER}/api/pages/${id}`)).json()) as {
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

test('reactive plugins: a slider drives live code (and legacy formulas still render)', {tag: ['@editor', '@p1']}, async ({page, request}) => {
  await freshLab(page);
  await caretAtEnd(page, 2);

  await page.keyboard.press('Enter');
  await page.keyboard.type('/slider');
  await page.keyboard.press('Enter');
  await expect(page.locator('.obe-kit-slider')).toBeVisible();

  // Insert a live code block below and compute over the slider's name.
  await page.evaluate(() => {
    const blocks = [...document.querySelectorAll('.obe-text')];
    const last = blocks[blocks.length - 1] as HTMLElement;
    last.focus();
    const sel = getSelection()!;
    const range = document.createRange();
    range.selectNodeContents(last);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
  });
  await page.keyboard.press('Enter');
  await page.keyboard.type('/livecode');
  await page.keyboard.press('Enter');
  await page.locator('.obe-codeblock-live .obe-text').click();
  await page.keyboard.type('x * 2 + 1');

  // Move the slider → the live output recomputes.
  await page.locator('.obe-kit-slider input[type=range]').fill('80');
  await expect(page.locator('.obe-code-out')).toContainText('result = 161');
  await page.locator('.obe-kit-slider input[type=range]').fill('10');
  await expect(page.locator('.obe-code-out')).toContainText('result = 21');

  // Legacy formula blocks (pre-merge documents) still render and compute.
  const res = await request.post(`${SERVER}/api/pages`, {
    data: {
      name: `LegacyFormula ${Date.now()}`,
      data: {
        editor: 'blocks',
        blockdoc: {blocks: [
          {id: 's1', type: 'slider', props: {name: 'x', value: 5, min: 0, max: 10}},
          {id: 'f1', type: 'formula', props: {source: 'x * 3'}},
        ]},
        editorjs: {blocks: []}, values: [], names: [],
      },
    },
  });
  const {id} = (await res.json()) as {id: string};
  await page.goto(`/?page=${id}`);
  await expect(page.locator('.obe-formula-out')).toHaveText('15');
});

test('code block gutter centers on the first code line below its actions', {tag: ['@editor', '@p1']}, async ({page}) => {
  await freshLab(page);
  await caretAtEnd(page, 2);
  await page.keyboard.press('Enter');
  await page.keyboard.type('/code');
  await page.keyboard.press('Enter');

  const row = page.locator('[data-block-type="code"]').last();
  const code = row.locator('.obe-codeblock .obe-text');
  await code.click();
  await page.keyboard.type('const total = 42;');

  // A Range rect follows the first rendered glyph even when syntax highlighting
  // wraps it in a token span; the editor/container rect would include padding.
  const centerDelta = await row.evaluate((el) => {
    const handle = el.querySelector<HTMLElement>('.obe-handle')!;
    const text = el.querySelector<HTMLElement>('.obe-codeblock .obe-text')!;
    const walker = document.createTreeWalker(text, NodeFilter.SHOW_TEXT);
    let first: Text | null = null;
    while (!first) {
      const node = walker.nextNode();
      if (!node) break;
      if ((node.textContent?.length ?? 0) > 0) first = node as Text;
    }
    if (!first) throw new Error('Code block has no rendered text node');
    const range = document.createRange();
    range.setStart(first, 0);
    range.setEnd(first, 1);
    const lineRect = range.getClientRects()[0];
    const handleRect = handle.getBoundingClientRect();
    return handleRect.top + handleRect.height / 2 - (lineRect.top + lineRect.height / 2);
  });

  expect(Math.abs(centerDelta)).toBeLessThanOrEqual(3);
});

test('block page: interactive HTML export stays live offline', {tag: ['@editor']}, async ({page, request, context}) => {
  // A legacy reactive page, migrated into the block editor on open.
  const res = await request.post(`${SERVER}/api/pages`, {
    data: {
      name: `BlockExport ${Date.now()}`,
      data: {
        editorjs: {
          blocks: [
            {id: 'h', type: 'header', data: {text: 'Live export', level: 2}},
            {id: 'm1', type: 'slider', data: {cellId: 'm1', name: 'n', min: 0, max: 10, initial: 3}},
            {id: 'e1', type: 'expr', data: {name: 'doubled', source: '__C__{m1}__ * 2'}},
          ],
        },
        values: [['m1', 3]],
        names: [['n', 'm1']],
      },
    },
  });
  const {id} = (await res.json()) as {id: string};
  await page.goto(`/?page=${id}&editor=next`);
  await expect(page.locator('.obe-root')).toBeVisible();
  await expect(page.locator('.obe-formula-out')).toHaveText('6'); // migrated and computing

  // Export Interactive HTML from the block page's menu.
  await page.getByRole('button', {name: 'Page actions'}).click();
  await page.getByRole('menuitem', {name: 'Export'}).click();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('menuitem', {name: 'Interactive HTML'}).click(),
  ]);
  const {readFile} = await import('node:fs/promises');
  const html = await readFile((await download.path())!, 'utf8');

  // The exported file is fully offline-interactive: move the slider, the
  // formula recomputes.
  const viewer = await context.newPage();
  await viewer.route('**/*', (route) => route.abort());
  await viewer.setContent(html, {waitUntil: 'load'});
  // The export hydrates the island-mounted OpenBookViewer over the static body;
  // wait for its locked-but-interactive surface (only present post-hydration) so
  // we don't read the pre-hydration static projection.
  await expect(viewer.locator('.obe-present-blocks')).toBeVisible();
  const out = viewer.locator('.obe-formula-out').first();
  await expect(out).toHaveText('6');
  const input = viewer.locator('.obe-kit-slider input[type=range]').first();
  await input.fill('9');
  await input.dispatchEvent('input');
  await expect(out).toHaveText('18');
  await viewer.close();
});

test('table cells are a grid: Enter moves down, Tab walks cells, Backspace never merges', {tag: ['@editor']}, async ({page}) => {
  await freshLab(page);
  await caretAtEnd(page, 2);
  await page.keyboard.press('Enter');
  await page.keyboard.type('/table');
  await page.keyboard.press('Enter');
  await expect(page.locator('.obe-table')).toBeVisible();

  await page.locator('.obe-table .obe-text').first().click();
  await page.keyboard.type('alpha');
  await page.keyboard.press('Enter'); // down a row — never splits the cell
  const cellCounts = () =>
    page.evaluate(() => [...document.querySelectorAll('.obe-table tr')].map((tr) => tr.querySelectorAll('td').length));
  expect(await cellCounts()).toEqual([3, 3, 3]);
  await expect(page.locator('.obe-table .obe-text').nth(3)).toBeFocused();

  await page.keyboard.press('Tab');
  await expect(page.locator('.obe-table .obe-text').nth(4)).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(page.locator('.obe-table .obe-text').nth(3)).toBeFocused();

  await page.keyboard.press('Backspace'); // at cell start: a no-op, not a merge
  expect(await cellCounts()).toEqual([3, 3, 3]);

  // Enter on the last row grows the table.
  await page.locator('.obe-table .obe-text').nth(6).click();
  await page.keyboard.press('Enter');
  expect(await cellCounts()).toEqual([3, 3, 3, 3]);
});

test('table drag-reorder: row + column grips, menu moves, single undo', {tag: ['@editor', '@p1']}, async ({page}) => {
  await freshLab(page);
  await caretAtEnd(page, 2);
  await page.keyboard.press('Enter');
  await page.keyboard.type('/table');
  await page.keyboard.press('Enter');
  await expect(page.locator('.obe-table')).toBeVisible();

  const rows = page.locator('.obe-table tbody > tr');
  await expect(rows).toHaveCount(3);
  // The slash table is born empty — type a marker into each row's first cell so
  // a row reorder is observable by content (no select-all needed; cells blank).
  for (let i = 0; i < 3; i += 1) {
    await rows.nth(i).locator('.obe-text').first().click();
    await page.keyboard.type(`R${i}`);
  }
  const firstCol = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('.obe-table tbody > tr')].map((tr) => tr.querySelector('td .obe-text')!.textContent),
    );
  const headRow = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('.obe-table tbody > tr')[0].querySelectorAll('td .obe-text')].map((e) => e.textContent),
    );
  expect(await firstCol()).toEqual(['R0', 'R1', 'R2']);
  await page.waitForTimeout(600); // let the label edits settle into their own undo step

  // Drag row 3 (index 2) above row 1 (index 0) — cell contents follow the grip.
  await rows.nth(2).locator('.obe-table-row-grip').dragTo(rows.nth(0), {targetPosition: {x: 24, y: 2}});
  expect(await firstCol()).toEqual(['R2', 'R0', 'R1']);

  // A single undo restores the original order (the move is one transact).
  await page.locator('.obe-table .obe-text').first().click();
  await page.keyboard.press('ControlOrMeta+z');
  expect(await firstCol()).toEqual(['R0', 'R1', 'R2']);

  // The context-menu move path (keyboard/a11y): move the top row down one.
  await rows.nth(0).locator('.obe-text').first().click({button: 'right'});
  await page.getByRole('menuitem', {name: 'Move row down'}).click();
  expect(await firstCol()).toEqual(['R1', 'R0', 'R2']);

  // Column drag: mark the top row's other two cells (still blank), then drag
  // column 3 (index 2) to column 1 (index 0). Header content follows the grip.
  await rows.nth(0).locator('td').nth(1).locator('.obe-text').click();
  await page.keyboard.type('X');
  await rows.nth(0).locator('td').nth(2).locator('.obe-text').click();
  await page.keyboard.type('Y');
  const headCells = rows.nth(0).locator('td');
  expect(await headRow()).toEqual(['R1', 'X', 'Y']);
  await headCells.nth(2).locator('.obe-table-col-grip').dragTo(headCells.nth(0), {targetPosition: {x: 2, y: 12}});
  expect(await headRow()).toEqual(['Y', 'R1', 'X']);
});

test('table drag-reorder: after-last boundary — drop into bottom/right half lands last', {tag: ['@editor', '@p1']}, async ({page}) => {
  await freshLab(page);
  await caretAtEnd(page, 2);
  await page.keyboard.press('Enter');
  await page.keyboard.type('/table');
  await page.keyboard.press('Enter');
  await expect(page.locator('.obe-table')).toBeVisible();

  const rows = page.locator('.obe-table tbody > tr');
  await expect(rows).toHaveCount(3);
  for (let i = 0; i < 3; i += 1) {
    await rows.nth(i).locator('.obe-text').first().click();
    await page.keyboard.type(`R${i}`);
  }
  const firstCol = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('.obe-table tbody > tr')].map((tr) => tr.querySelector('td .obe-text')!.textContent),
    );
  const headRow = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('.obe-table tbody > tr')[0].querySelectorAll('td .obe-text')].map((e) => e.textContent),
    );
  expect(await firstCol()).toEqual(['R0', 'R1', 'R2']);
  await page.waitForTimeout(600); // let the label edits settle into their own undo step

  // Drag row 0 into the BOTTOM half of the LAST row (y near its bottom edge). This
  // drives overRow's midpoint true-branch → dropIndex === rows.length (after-last),
  // so the row must land LAST.
  const lastRow = rows.nth(2);
  const lastRowBox = (await lastRow.boundingBox())!;
  await rows.nth(0).locator('.obe-table-row-grip').dragTo(lastRow, {targetPosition: {x: 24, y: lastRowBox.height - 2}});
  expect(await firstCol()).toEqual(['R1', 'R2', 'R0']);

  // Column: mark the header row's other two cells, then drag column 0 into the
  // RIGHT half of the LAST column (x near its right edge) → dropIndex === cols
  // (after-last), so the column must land LAST.
  const header = rows.nth(0);
  await header.locator('td').nth(1).locator('.obe-text').click();
  await page.keyboard.type('X');
  await header.locator('td').nth(2).locator('.obe-text').click();
  await page.keyboard.type('Y');
  const headCells = header.locator('td');
  expect(await headRow()).toEqual(['R1', 'X', 'Y']);
  const lastColBox = (await headCells.nth(2).boundingBox())!;
  await headCells.nth(0).locator('.obe-table-col-grip').dragTo(headCells.nth(2), {targetPosition: {x: lastColBox.width - 2, y: 12}});
  expect(await headRow()).toEqual(['X', 'Y', 'R1']);
});

test('multi-cell selection: drag-select highlights a rectangle, copy→paste makes a new table, delete clears + undo restores', {tag: ['@editor', '@p1']}, async ({page}) => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await freshLab(page);
  await caretAtEnd(page, 2);
  await page.keyboard.press('Enter');
  await page.keyboard.type('/table');
  await page.keyboard.press('Enter');
  await expect(page.locator('.obe-table')).toBeVisible();

  // Fill the top-left 2×2 of the (3-col) slash table: cell indices 0,1,3,4.
  const cellText = page.locator('.obe-table .obe-text');
  const vals: Record<number, string> = {0: 'A1', 1: 'B1', 3: 'A2', 4: 'B2'};
  for (const [i, v] of Object.entries(vals)) {
    await cellText.nth(Number(i)).click();
    await page.keyboard.type(v);
  }
  await page.waitForTimeout(500); // let the fills settle into their own undo step

  // REAL mouse drag from cell (0,0) to cell (1,1) → a live 2×2 rectangle.
  const td = page.locator('.obe-table td');
  const dragCells = async (fromIdx: number, toIdx: number) => {
    const a = (await td.nth(fromIdx).boundingBox())!;
    const b = (await td.nth(toIdx).boundingBox())!;
    await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, {steps: 10});
    await page.mouse.up();
  };
  await dragCells(0, 4);
  await expect(page.locator('.obe-table td.obe-cell-selected')).toHaveCount(4);

  // Copy the range, then paste into a fresh empty paragraph → a NEW table.
  await page.keyboard.press('ControlOrMeta+c');
  await page.locator('.obe-text').first().click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter'); // empty paragraph, outside any table
  await page.keyboard.press('ControlOrMeta+v');
  await expect(page.locator('.obe-table')).toHaveCount(2);
  // The pasted table (inserted near the top) carries the same 2×2 grid.
  const pastedGrid = await page.evaluate(() => {
    const t = document.querySelectorAll('.obe-table')[0];
    return [...t.querySelectorAll('tbody > tr')].map((tr) => [...tr.querySelectorAll('td .obe-text')].map((c) => c.textContent));
  });
  expect(pastedGrid).toEqual([
    ['A1', 'B1'],
    ['A2', 'B2'],
  ]);

  // Re-select the ORIGINAL table's 2×2 (now the second table), clear it, undo it.
  const orig = page.locator('.obe-table').nth(1).locator('td');
  const dragOrig = async (fromIdx: number, toIdx: number) => {
    const a = (await orig.nth(fromIdx).boundingBox())!;
    const b = (await orig.nth(toIdx).boundingBox())!;
    await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, {steps: 10});
    await page.mouse.up();
  };
  await page.waitForTimeout(500);
  await dragOrig(0, 4);
  await expect(page.locator('.obe-table').nth(1).locator('td.obe-cell-selected')).toHaveCount(4);
  const origTexts = () =>
    page.evaluate(() =>
      [0, 1, 3, 4].map((i) => document.querySelectorAll('.obe-table')[1].querySelectorAll('td .obe-text')[i].textContent),
    );
  await page.keyboard.press('Delete');
  expect(await origTexts()).toEqual(['', '', '', '']);
  await page.keyboard.press('ControlOrMeta+z'); // one undo restores all four
  expect(await origTexts()).toEqual(['A1', 'B1', 'A2', 'B2']);
});

test('cross-block selection becomes block selection and deletes cleanly', {tag: ['@editor']}, async ({page}) => {
  await freshLab(page);
  await page.evaluate(() => {
    const blocks = [...document.querySelectorAll('.obe-text')];
    const sel = getSelection()!;
    const range = document.createRange();
    range.setStart(blocks[1].firstChild!, 10);
    range.setEnd(blocks[2].firstChild!, 8);
    sel.removeAllRanges();
    sel.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
    document.dispatchEvent(new MouseEvent('mouseup', {bubbles: true}));
  });
  await expect(page.locator('.obe-row-selected')).toHaveCount(2);
  await page.keyboard.press('Backspace');
  await expect(page.locator('[data-block-type=paragraph]')).toHaveCount(0);
  await expect(page.locator('[data-block-type=todo]')).toHaveCount(0);
  await expect(page.locator('[data-block-type=heading]')).toHaveCount(1);
});

test('handle menu: turn into a heading and delete from the menu', {tag: ['@editor']}, async ({page}) => {
  await freshLab(page);
  const row = page.locator('[data-block-row][data-block-type=paragraph]');
  await row.locator('.obe-text').hover();
  await row.locator('.obe-handle').click();
  await page.getByRole('menuitem', {name: 'Turn into'}).hover();
  await page.getByRole('menuitem', {name: 'Heading 2'}).click();
  await expect(page.locator('.obe-h2 .obe-text')).toContainText('A scratch document');
  // Wait out the first menu's teardown — a click during Radix's exit gets
  // swallowed as an outside-dismiss instead of opening the next menu.
  await expect(page.getByRole('menu')).toHaveCount(0);

  const heading = page.locator('[data-block-row][data-block-type=heading]').nth(1);
  await heading.locator('.obe-text').hover();
  await expect(heading.locator('.obe-handle')).toBeVisible();
  await heading.locator('.obe-handle').click();
  await page.getByRole('menuitem', {name: 'Delete'}).click();
  await expect(page.locator('.obe-h2')).toHaveCount(0);
});

test('mention runs navigate to their page on click', {tag: ['@editor']}, async ({page, request}) => {
  const target = await request.post(`${SERVER}/api/pages`, {
    data: {name: `MentionNav target ${Date.now()}`, data: {editorjs: {blocks: []}, values: [], names: []}},
  });
  const targetId = ((await target.json()) as {id: string}).id;
  const host = await request.post(`${SERVER}/api/pages`, {
    data: {
      name: `MentionNav host ${Date.now()}`,
      data: {editorjs: {blocks: [{id: 's1', type: 'subpage', data: {kind: 'page', pageId: targetId}}]}, values: [], names: []},
    },
  });
  const hostId = ((await host.json()) as {id: string}).id;

  await page.goto(`/?page=${hostId}&editor=next`);
  const mention = page.locator('a.obe-mention');
  await expect(mention).toContainText('MentionNav target'); // live title, not a generic label
  await mention.click();
  await expect(page).toHaveURL(new RegExp(targetId));
});

test('clipboard: block selection copies three flavours and pastes back losslessly', {tag: ['@editor']}, async ({page}) => {
  await freshLab(page);
  // Select the paragraph as a block, copy via a synthetic clipboard event.
  await caretAtEnd(page, 1);
  await page.keyboard.press('Escape');
  await expect(page.locator('.obe-row-selected')).toHaveCount(1);
  const payload = await page.evaluate(() => {
    const dt = new DataTransfer();
    document.dispatchEvent(new ClipboardEvent('copy', {clipboardData: dt, bubbles: true, cancelable: true}));
    return {
      md: dt.getData('text/plain'),
      html: dt.getData('text/html'),
      blocks: dt.getData('application/x-obe-blocks'),
    };
  });
  expect(payload.md).toContain('A scratch document');
  expect(payload.html).toContain('<p>');
  expect(JSON.parse(payload.blocks).blocks[0].type).toBe('paragraph');

  // Paste the block payload at the end of the todo → a new paragraph block.
  await caretAtEnd(page, 2);
  await page.evaluate((blocks) => {
    const dt = new DataTransfer();
    dt.setData('application/x-obe-blocks', blocks);
    document.activeElement!.dispatchEvent(
      new InputEvent('beforeinput', {inputType: 'insertFromPaste', dataTransfer: dt, bubbles: true, cancelable: true}),
    );
  }, payload.blocks);
  await expect(page.locator('[data-block-type=paragraph]')).toHaveCount(2);
  await expect(page.locator('.obe-text').nth(3)).toContainText('A scratch document');
});

test('clipboard: external rich HTML pastes as real blocks', {tag: ['@editor']}, async ({page}) => {
  await freshLab(page);
  await caretAtEnd(page, 2);
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.setData('text/html', '<h2>Imported</h2><ul><li>alpha <strong>bold</strong></li><li>beta</li></ul>');
    dt.setData('text/plain', 'Imported\nalpha bold\nbeta');
    document.activeElement!.dispatchEvent(
      new InputEvent('beforeinput', {inputType: 'insertFromPaste', dataTransfer: dt, bubbles: true, cancelable: true}),
    );
  });
  await expect(page.locator('.obe-h2 .obe-text')).toHaveText('Imported');
  await expect(page.locator('.obe-list')).toHaveCount(2);
  await expect(page.locator('.obe-list strong')).toHaveText('bold');
});

// Regression guard for a fixed selection-clobber bug: toggleFormat's
// restore-selection rAF used to fire unconditionally, so a caret moved
// within a frame of applying a format got replaced by the stale range and
// the next keystroke wiped the formatted text. The apply-phase retry stays
// (toolbar anchoring is inherently racy to script), with a safety retry.
test.describe('link edge typing', () => {
  test.describe.configure({retries: 1});

  test('typing at a link\'s trailing edge does not extend the link', {tag: ['@editor']}, async ({page}) => {
    await freshLab(page);
    await expect(page.locator('.obe-text').nth(1)).toContainText('scratch');
    // Link the word "scratch" via the toolbar. Retried as one unit: a late lab
    // re-render (CPU contention in parallel runs) can clear the programmatic
    // selection before the toolbar button reads it, applying no link; a second
    // pass on settled DOM links it (and an off-toggle self-corrects next pass).
    await expect(async () => {
      // Idempotent: once a link exists, never touch the toolbar again — a
      // second ⛓ toggle over a stale selection can corrupt the text run.
      if ((await page.locator('.obe-text a.obe-link').count()) === 0) {
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
        await expect(page.locator('.obe-toolbar')).toBeVisible({timeout: 2000});
        await page.locator('.obe-tb-btn', {hasText: '⛓'}).dispatchEvent('mousedown');
      }
      await expect(page.locator('.obe-text a.obe-link')).toHaveText('scratch', {timeout: 2000});
    }).toPass({timeout: 20_000});

    // Caret at the link's end, type — the text lands OUTSIDE the link.
    await page.evaluate(() => {
      const a = document.querySelector('.obe-text a.obe-link')!;
      const sel = getSelection()!;
      const range = document.createRange();
      range.setStart(a.firstChild!, a.textContent!.length);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
      (a.closest('.obe-text') as HTMLElement).focus({preventScroll: true});
    });
    await page.keyboard.type('XY');
    await expect(page.locator('.obe-text a.obe-link')).toHaveText('scratch');
    await expect(page.locator('.obe-text').nth(1)).toContainText('scratchXY');
  });
});

test('table editing: type in cells, add a row and a column', {tag: ['@editor']}, async ({page}) => {
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

// TBL-3: right-click inside a cell opens the table's Row/Column menu (not the
// generic block menu), and its positional ops mutate the grid.
test('table cell context menu: insert row, delete column, toggle header', {tag: ['@editor']}, async ({page}) => {
  await freshLab(page);
  await caretAtEnd(page, 2);
  await page.keyboard.press('Enter');
  await page.keyboard.type('/table');
  await page.keyboard.press('Enter');
  await expect(page.locator('.obe-table')).toBeVisible();
  await expect(page.locator('.obe-table tr')).toHaveCount(3);
  await expect(page.locator('.obe-table tr').first().locator('td')).toHaveCount(3);

  // Right-click the first cell → the table cell menu, not the block menu.
  await page.locator('.obe-table td').first().click({button: 'right'});
  await expect(page.getByRole('menuitem', {name: 'Insert row below'})).toBeVisible();
  await page.getByRole('menuitem', {name: 'Insert row below'}).click();
  await expect(page.locator('.obe-table tr')).toHaveCount(4);

  // Delete a column via the menu.
  await page.locator('.obe-table td').first().click({button: 'right'});
  await page.getByRole('menuitem', {name: 'Delete column'}).click();
  await expect(page.locator('.obe-table tr').first().locator('td')).toHaveCount(2);

  // Toggle the header row off.
  await expect(page.locator('.obe-table-header')).toHaveCount(1);
  await page.locator('.obe-table td').first().click({button: 'right'});
  await page.getByRole('menuitem', {name: 'Toggle header row'}).click();
  await expect(page.locator('.obe-table-header')).toHaveCount(0);
});

test('table colours: tint a row and a column via the menu; row wins (TBL-4)', {tag: ['@editor']}, async ({page}) => {
  await freshLab(page);
  await caretAtEnd(page, 2);
  await page.keyboard.press('Enter');
  await page.keyboard.type('/table');
  await page.keyboard.press('Enter');
  await expect(page.locator('.obe-table')).toBeVisible();
  await expect(page.locator('.obe-table tr')).toHaveCount(3);

  const rows = page.locator('.obe-table tr');
  // Tint row 1 (a body row) green via the "Row colour" submenu.
  await rows.nth(1).locator('td').first().click({button: 'right'});
  await page.getByRole('menuitem', {name: 'Row colour'}).hover();
  await page.getByRole('menuitem', {name: 'Green'}).click();
  await expect(rows.nth(1).locator('td.obe-bg-green')).toHaveCount(3);

  // Tint column 0 blue via the "Column colour" submenu.
  await rows.nth(0).locator('td').first().click({button: 'right'});
  await page.getByRole('menuitem', {name: 'Column colour'}).hover();
  await page.getByRole('menuitem', {name: 'Blue'}).click();
  // Column 0 is blue in the untinted rows; the row-1 cell stays green (row wins).
  await expect(rows.nth(0).locator('td').first()).toHaveClass(/obe-bg-blue/);
  await expect(rows.nth(2).locator('td').first()).toHaveClass(/obe-bg-blue/);
  await expect(rows.nth(1).locator('td').first()).toHaveClass(/obe-bg-green/);

  // Clear the row tint; column blue then shows through at the intersection.
  await rows.nth(1).locator('td').first().click({button: 'right'});
  await page.getByRole('menuitem', {name: 'Row colour'}).hover();
  await page.getByRole('menuitem', {name: 'Default'}).click();
  await expect(rows.nth(1).locator('td').first()).toHaveClass(/obe-bg-blue/);
  await expect(rows.nth(1).locator('td.obe-bg-green')).toHaveCount(0);
});

test('range-aware cell menu: right-click inside a selection tints/deletes the whole range (TBL-6)', {tag: ['@editor']}, async ({page}) => {
  await freshLab(page);
  await caretAtEnd(page, 2);
  await page.keyboard.press('Enter');
  await page.keyboard.type('/table');
  await page.keyboard.press('Enter');
  await expect(page.locator('.obe-table')).toBeVisible();
  await expect(page.locator('.obe-table tr')).toHaveCount(3);

  // REAL mouse drag over the top two rows of the 3-column table → a 2×3 range.
  const td = page.locator('.obe-table td');
  const dragCells = async (fromIdx: number, toIdx: number) => {
    const a = (await td.nth(fromIdx).boundingBox())!;
    const b = (await td.nth(toIdx).boundingBox())!;
    await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, {steps: 10});
    await page.mouse.up();
  };
  await dragCells(0, 5);
  await expect(page.locator('.obe-table td.obe-cell-selected')).toHaveCount(6);

  // Right-click a cell INSIDE the rectangle → the RANGE variant, with the exact
  // selected counts and none of the single-cell row/column items.
  await td.nth(1).click({button: 'right'});
  await expect(page.getByText('Selection · 2 × 3')).toBeVisible();
  await expect(page.getByRole('menuitem', {name: 'Clear contents'})).toBeVisible();
  await expect(page.getByRole('menuitem', {name: 'Delete 2 rows'})).toBeVisible();
  await expect(page.getByRole('menuitem', {name: 'Delete table'})).toBeVisible();
  await expect(page.getByRole('menuitem', {name: 'Duplicate row'})).toHaveCount(0);

  // Tint every selected cell green in one step.
  await page.getByRole('menuitem', {name: 'Cell colour'}).hover();
  await page.getByRole('menuitem', {name: 'Green'}).click();
  await expect(page.locator('.obe-table td.obe-bg-green')).toHaveCount(6);
  await expect(page.locator('.obe-table td.obe-cell-selected')).toHaveCount(6);
  await expect(page.locator('.obe-table tr').nth(2).locator('td.obe-bg-green')).toHaveCount(0);
  // Paint-level guard: the selected cell must compute to the SAME green as a
  // plain palette cell while the ring + wash remain layered above it. The old
  // high-specificity `background:` selection shorthand made these differ even
  // though the td carried both classes, so class assertions alone missed P1.
  const selectedPaint = await page.locator('.obe-table td.obe-bg-green.obe-cell-selected').first().evaluate((cell) => {
    const probe = document.createElement('div');
    probe.className = 'obe-bg-green';
    document.body.append(probe);
    const expectedBackground = getComputedStyle(probe).backgroundColor;
    probe.remove();
    const computed = getComputedStyle(cell);
    return {background: computed.backgroundColor, expectedBackground, shadow: computed.boxShadow};
  });
  expect(selectedPaint.background).toBe(selectedPaint.expectedBackground);
  expect(selectedPaint.shadow.match(/inset/g)).toHaveLength(2);

  // A right-click OUTSIDE the rectangle still opens the single-cell menu.
  await td.nth(6).click({button: 'right'});
  await expect(page.getByRole('menuitem', {name: 'Duplicate row'})).toBeVisible();
  await expect(page.getByRole('menuitem', {name: 'Clear contents'})).toHaveCount(0);
  await page.keyboard.press('Escape');

  // Delete the selected rows: exactly two go, and the stale highlight is dropped.
  await dragCells(0, 5);
  await expect(page.locator('.obe-table td.obe-cell-selected')).toHaveCount(6);
  await td.nth(0).click({button: 'right'});
  await page.getByRole('menuitem', {name: 'Delete 2 rows'}).click();
  await expect(page.locator('.obe-table tr')).toHaveCount(1);
  await expect(page.locator('.obe-table td.obe-cell-selected')).toHaveCount(0);
});

// ── Marquee (rubber-band) select + shift-click extension (SEL-1) ─────────────

/** Grow the lab from its 3 seeded blocks to 5 top-level blocks. */
async function fiveBlocks(page: import('@playwright/test').Page): Promise<void> {
  const rows = page.locator('.obe-root > [data-block-row]');
  // freshLab only waits for the FIRST block — wait for the whole seed (3 rows)
  // before driving the caret, or a click can miss a not-yet-rendered row.
  await expect(rows).toHaveCount(3);
  await page.locator('.obe-text').nth(2).click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('four');
  await expect(rows).toHaveCount(4);
  await page.keyboard.press('Enter');
  await page.keyboard.type('five');
  await expect(rows).toHaveCount(5);
}

test('marquee: drag over empty space selects the intersected blocks', {tag: ['@editor']}, async ({page}) => {
  await freshLab(page);
  await fiveBlocks(page);
  // The UndoManager coalesces edits within 400ms — pause so the later delete
  // is its own undo step (one undo restores the five blocks, not the typing).
  await page.waitForTimeout(500);

  const rows = page.locator('.obe-root > [data-block-row]');
  const r2 = (await rows.nth(2).boundingBox())!;
  const r4 = (await rows.nth(4).boundingBox())!;
  // Start in the empty page space below the last block and drag diagonally up
  // into row 2 — the rectangle sweeps the last three rows (2, 3, 4). A diagonal
  // (not straight-up) drag gives the rect real width so the overlay is visible.
  await page.mouse.move(r4.x + r4.width * 0.75, r4.y + r4.height + 24);
  await page.mouse.down();
  await page.mouse.move(r4.x + r4.width * 0.5, r4.y, {steps: 6});
  await page.mouse.move(r4.x + r4.width * 0.25, r2.y + r2.height / 2, {steps: 6});
  // The marquee overlay is visible while dragging.
  await expect(page.locator('.obe-marquee')).toBeVisible();
  await page.mouse.up();

  await expect(page.locator('.obe-row-selected')).toHaveCount(3);
  // Release keeps the selection; the overlay is gone.
  await expect(page.locator('.obe-marquee')).toHaveCount(0);

  // Backspace deletes the three; undo restores all five.
  await page.keyboard.press('Backspace');
  await expect(page.locator('.obe-root > [data-block-row]')).toHaveCount(2);
  await page.keyboard.press('ControlOrMeta+z');
  await expect(page.locator('.obe-root > [data-block-row]')).toHaveCount(5);
});

test('marquee: right-click bulk delete removes three blocks and one undo restores them', {tag: ['@editor']}, async ({page}) => {
  await freshLab(page);
  await fiveBlocks(page);
  // Guard captureTimeout=400 merging: isolate the bulk command from fiveBlocks' typing.
  await page.waitForTimeout(500);

  const rows = page.locator('.obe-root > [data-block-row]');
  const r2 = (await rows.nth(2).boundingBox())!;
  const r4 = (await rows.nth(4).boundingBox())!;
  await page.mouse.move(r4.x + r4.width * 0.75, r4.y + r4.height + 24);
  await page.mouse.down();
  await page.mouse.move(r4.x + r4.width * 0.5, r4.y, {steps: 6});
  await page.mouse.move(r4.x + r4.width * 0.25, r2.y + r2.height / 2, {steps: 6});
  await page.mouse.up();
  await expect(page.locator('.obe-row-selected')).toHaveCount(3);

  // A selected row scopes the context menu to the whole marquee selection.
  await rows.nth(3).click({button: 'right', position: {x: r2.width / 2, y: r2.height / 2}});
  await expect(page.getByText('3 blocks selected', {exact: true})).toBeVisible();
  await expect(page.getByRole('menuitem', {name: 'Duplicate 3'})).toBeVisible();
  await page.getByRole('menuitem', {name: 'Delete 3'}).click();
  await expect(rows).toHaveCount(2);

  await page.keyboard.press('ControlOrMeta+z');
  await expect(rows).toHaveCount(5);
});

test('marquee: a plain click on empty space still clears the selection', {tag: ['@editor']}, async ({page}) => {
  await freshLab(page);
  await caretAtEnd(page, 1);
  await page.keyboard.press('Escape');
  await expect(page.locator('.obe-row-selected')).toHaveCount(1);

  // A click (no drag) on the empty area below the blocks clears — no marquee.
  const root = (await page.locator('.obe-root').boundingBox())!;
  await page.mouse.click(root.x + root.width / 2, root.y + root.height - 20);
  await expect(page.locator('.obe-row-selected')).toHaveCount(0);
  await expect(page.locator('.obe-marquee')).toHaveCount(0);
});

test('shift-click extends the block selection contiguously', {tag: ['@editor']}, async ({page}) => {
  await freshLab(page);
  await fiveBlocks(page);

  // Select the second block (index 1) via the existing Escape path.
  await caretAtEnd(page, 1);
  await page.keyboard.press('Escape');
  await expect(page.locator('.obe-row-selected')).toHaveCount(1);

  // Shift-click the fourth block (index 3) → contiguous range 1..3.
  const rows = page.locator('.obe-root > [data-block-row]');
  await rows.nth(3).click({modifiers: ['Shift'], position: {x: 40, y: 8}});
  await expect(page.locator('.obe-row-selected')).toHaveCount(3);
  await expect(rows.nth(1)).toHaveClass(/obe-row-selected/);
  await expect(rows.nth(3)).toHaveClass(/obe-row-selected/);
  await expect(rows.nth(0)).not.toHaveClass(/obe-row-selected/);
});

// ── Multi-block drag (SEL-2) ────────────────────────────────────────────────

/** Text of each top-level row, in document order. */
const rowOrder = (page: import('@playwright/test').Page): Promise<string[]> =>
  page.evaluate(() =>
    [...document.querySelectorAll('.obe-root > [data-block-row]')].map(
      (row) => row.querySelector('.obe-text')?.textContent ?? '',
    ),
  );

test('SEL-2 multi-drag: marquee 3 blocks, group-drag to the top, one undo restores', {tag: ['@editor']}, async ({page}) => {
  await freshLab(page);
  await fiveBlocks(page);
  // Let the typing settle into its own undo step (400ms coalesce window), so the
  // later group-move is a distinct, single undo.
  await page.waitForTimeout(500);

  const rows = page.locator('.obe-root > [data-block-row]');
  const before = await rowOrder(page); // [s0, s1, s2, four, five]

  // Marquee-select the last three rows (2, 3, 4) — same sweep the marquee test uses.
  const r2 = (await rows.nth(2).boundingBox())!;
  const r4 = (await rows.nth(4).boundingBox())!;
  await page.mouse.move(r4.x + r4.width * 0.75, r4.y + r4.height + 24);
  await page.mouse.down();
  await page.mouse.move(r4.x + r4.width * 0.5, r4.y, {steps: 6});
  await page.mouse.move(r4.x + r4.width * 0.25, r2.y + r2.height / 2, {steps: 6});
  await page.mouse.up();
  await expect(page.locator('.obe-row-selected')).toHaveCount(3);
  const moved = before.slice(2); // [s2, four, five]

  // Grab a SELECTED row's handle and drop above the first row: the whole
  // selection moves to the top as one block, in its original relative order.
  await rows.nth(2).hover();
  const target = rows.nth(0);
  const tb = (await target.boundingBox())!;
  await rows.nth(2).locator('.obe-handle').dragTo(target, {targetPosition: {x: tb.width / 2, y: tb.height * 0.15}});

  await expect(rows).toHaveCount(5);
  await expect.poll(() => rowOrder(page)).toEqual([...moved, before[0], before[1]]);

  // A single undo restores the original order (one transaction). Focus a text
  // block first — the undo shortcut lives on the focused block.
  await rows.nth(0).locator('.obe-text').click();
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => rowOrder(page)).toEqual(before);
});
