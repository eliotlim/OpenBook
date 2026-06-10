import {test, expect, takeSnapshot} from '@chromatic-com/playwright';

// The OpenBook data server is used to seed a linking page directly so the
// backlink test is deterministic.
import {reclaimNames, SERVER} from './seed';

// Always work on a brand-new page (⌘N) so stored owner/verification from a
// previous run on the shared backend can't make these flaky.
async function freshPage(page: import('@playwright/test').Page): Promise<string> {
  await page.goto('/');
  await expect(page.getByRole('button', {name: 'Page actions'})).toBeVisible(); // hydrated
  await page.keyboard.press('ControlOrMeta+n');
  await expect.poll(() => new URL(page.url()).searchParams.get('page')).toBeTruthy();
  await expect(page.getByRole('button', {name: 'Page actions'})).toBeVisible();
  return new URL(page.url()).searchParams.get('page') as string;
}

test('page properties: set an owner and verify the page', async ({page}, testInfo) => {
  await freshPage(page);

  // Owner: open the editor, type a name, commit.
  await page.getByRole('button', {name: 'Set owner'}).click();
  const input = page.getByPlaceholder('Type a name…');
  await input.fill('Ada Lovelace');
  await input.press('Enter');
  await expect(page.getByText('Ada Lovelace')).toBeVisible();

  // Verification: verify, then the badge shows.
  await page.getByRole('button', {name: 'Verify', exact: true}).click();
  await expect(page.getByText('Verified', {exact: true})).toBeVisible();
  await takeSnapshot(page, testInfo); // visual: properties panel with owner + verified

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
  await expect(page.getByText('No backlinks yet')).toBeVisible();

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

  // Refresh the backlinks and see the linking page as a chip.
  await page.getByRole('button', {name: 'Refresh'}).click();
  await expect(page.getByRole('button', {name: /Linking page/})).toBeVisible();
});
