import {test, expect, takeSnapshot} from './fixtures';

// The OpenBook data server is used to seed a linking page directly so the
// backlink test is deterministic.
import {reclaimNames, SERVER} from './seed';

// Always work on a brand-new page (⌘N) so stored owner/verification from a
// previous run on the shared backend can't make these flaky.
async function freshPage(page: import('@playwright/test').Page): Promise<string> {
  await page.goto('/');
  await expect(page.getByRole('button', {name: 'Page actions'})).toBeVisible(); // hydrated
  // ⌘N creates asynchronously; the URL meanwhile already carries the
  // auto-selected existing page. Waiting for just ANY ?page= grabbed that
  // one — and when the slow create finally navigated, it unmounted the
  // document under whatever the test had opened (the dropdown flake). Wait
  // for the param to CHANGE to the page ⌘N made.
  const before = new URL(page.url()).searchParams.get('page');
  await page.keyboard.press('ControlOrMeta+n');
  await expect
    .poll(() => {
      const id = new URL(page.url()).searchParams.get('page');
      return id && id !== before ? id : null;
    }, {timeout: 15_000})
    .toBeTruthy();
  await expect(page.getByRole('button', {name: 'Page actions'})).toBeVisible();
  return new URL(page.url()).searchParams.get('page') as string;
}

// The owner / verification / backlinks cluster is revealed on hovering the
// cover+title region (Notion-style), so reveal it before clicking a control.
async function revealHeaderControls(page: import('@playwright/test').Page): Promise<void> {
  await page.locator('.ob-page-title').hover();
}

test('page properties: set an owner and verify the page', async ({page}, testInfo) => {
  await freshPage(page);

  // Owner: reveal the header controls, open the editor, type a name, commit.
  await revealHeaderControls(page);
  await page.getByRole('button', {name: 'Set owner'}).click();
  const input = page.getByPlaceholder('Type a name…');
  await input.fill('Ada Lovelace');
  await input.press('Enter');
  await expect(page.getByText('Ada Lovelace')).toBeVisible();

  // Verification: the Verify control opens an expiry menu; pick one, badge shows.
  await revealHeaderControls(page);
  await page.getByRole('button', {name: 'Verify', exact: true}).click();
  await page.getByRole('menuitem', {name: 'No expiry'}).click();
  await expect(page.getByText('Verified', {exact: true})).toBeVisible();
  await revealHeaderControls(page);
  await takeSnapshot(page, testInfo); // visual: header controls with owner + verified

  // It persists across a reload (stored on the page, server-side).
  await page.reload();
  await expect(page.getByText('Ada Lovelace')).toBeVisible();
  await expect(page.getByText('Verified', {exact: true})).toBeVisible();
});

test('page properties: backlinks list the pages that link here', async ({page, request}) => {
  // Page names are workspace-unique: free any prior run's names first.
  await reclaimNames(request, 'Backlink target', 'Linking page');

  // Create a fresh target page on the server and open it directly (avoids any
  // ⌘N navigation race, and a brand-new id has no prior backlinks).
  const targetRes = await request.post(`${SERVER}/api/pages`, {
    data: {name: 'Backlink target', data: {editorjs: {blocks: []}, values: [], names: []}},
  });
  expect(targetRes.ok()).toBeTruthy();
  const target = (await targetRes.json()) as {id: string};

  await page.goto(`/?page=${target.id}`);
  await expect(page.getByRole('button', {name: 'Page actions'})).toBeVisible();
  // Backlinks live (collapsed) in the cover-area controls — opacity-hidden until
  // hover, but present in the DOM. With none, it reads "No backlinks".
  await expect(page.getByText('No backlinks')).toBeVisible();

  // Seed a page whose document links to the target (an inline mention anchor).
  const linkRes = await request.post(`${SERVER}/api/pages`, {
    data: {
      name: 'Linking page',
      data: {
        editorjs: {
          blocks: [{type: 'paragraph', data: {text: `see <a class="ob-mention" data-page-id="${target.id}">📄 here</a>`}}],
        },
        values: [],
        names: [],
      },
    },
  });
  expect(linkRes.ok()).toBeTruthy();

  // Reload so the target re-fetches its backlinks deterministically; the count
  // collapses to a chip that opens the list of linking pages on click.
  await page.reload();
  await expect(page.getByRole('button', {name: 'Page actions'})).toBeVisible();
  await revealHeaderControls(page);
  await page.getByRole('button', {name: /1 backlink/}).click();
  await expect(page.getByRole('button', {name: /Linking page/})).toBeVisible();
});
