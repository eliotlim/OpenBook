import {test, expect, takeSnapshot} from '@chromatic-com/playwright';

const SERVER = 'http://127.0.0.1:4319';

// Regression for the save loop: a page with reactive blocks must settle and stop
// saving. We seed it via the API, let it compute, then assert `updatedAt` is
// stable over time (a loop would keep bumping it). Also covers diff-render: the
// values compute correctly without a full re-render storm.
test('reactive page computes and does not save-loop', async ({page, request}, testInfo) => {
  const create = await request.post(`${SERVER}/api/pages`, {
    data: {
      // Run-tagged: page names are globally unique, so a bare name 409s when
      // the suite reuses a dev server across runs.
      name: `Reactive E2E ${Date.now()}`,
      data: {
        editorjs: {
          blocks: [
            {id: 'e1', type: 'expr', data: {name: 'x', source: '2 + 3'}},
            {id: 'e2', type: 'expr', data: {name: 'y', source: '__C__{e1}__ * 10'}},
          ],
        },
        values: [],
        names: [],
      },
    },
  });
  const created = (await create.json()) as {id: string};

  await page.goto(`/?page=${created.id}`);

  // The chained expression evaluates (x=5, y=50) — proves reactive recompute
  // works. Scoped to the expr result readouts: a bare getByText('50') also
  // matches sidebar page names whose timestamp tags contain '50'.
  await expect(page.locator('.reactive-block code').getByText('50', {exact: true})).toBeVisible();
  await takeSnapshot(page, testInfo); // visual: computed reactive blocks

  // No save loop: updatedAt must be stable once settled.
  const first = await (await request.get(`${SERVER}/api/pages/${created.id}`)).json();
  await page.waitForTimeout(3000);
  const second = await (await request.get(`${SERVER}/api/pages/${created.id}`)).json();
  expect(second.updatedAt).toBe(first.updatedAt);
});

// Regression for subpage idempotency: adding a subpage via the page context menu
// creates exactly one nested child, and reloading does not create another.
test('add subpage creates exactly one nested child (idempotent)', async ({page, request}) => {
  await page.goto('/');
  await expect(page.getByRole('button', {name: 'Page actions'})).toBeVisible();

  const childrenBefore = await countChildren(request);
  await page.locator('main .px-6').first().click({button: 'right'});
  await page.getByRole('menuitem', {name: 'Add subpage'}).click();

  await expect.poll(() => countChildren(request)).toBe(childrenBefore + 1);

  // Reload — the child must NOT be recreated (pageId is persisted).
  await page.reload();
  await page.waitForTimeout(1500);
  expect(await countChildren(request)).toBe(childrenBefore + 1);
});

async function countChildren(request: import('@playwright/test').APIRequestContext): Promise<number> {
  const pages = (await (await request.get(`${SERVER}/api/pages`)).json()) as Array<{parentId: string | null}>;
  return pages.filter((p) => p.parentId).length;
}
