import {test, expect, takeSnapshot, chooseValue} from './fixtures';
import {newPage, SERVER} from './seed';

// The per-page Share dialog (OB-203): open it from the page-actions cluster, set
// the page's audience-scope visibility, and grant a person view access by email
// — all driving the OB-191 per-page API (`setPageVisibility` / `sharePage`).
//
// The worker's data server is a fresh, unclaimed instance with the default
// `guestAccess: 'write'`, so the (anonymous) browser counts as a manager and the
// Share control is shown — exactly the local-first / self-host default.

async function openShare(page: import('@playwright/test').Page, pageId: string): Promise<void> {
  await page.goto(`/?page=${pageId}`);
  const shareBtn = page.getByRole('button', {name: 'Share', exact: true});
  await expect(shareBtn).toBeVisible();
  await shareBtn.click();
  await expect(page.getByRole('dialog')).toBeVisible();
}

test('share: set the page scope and grant a person view access', {tag: ['@sharing', '@visual']}, async ({page, request}, testInfo) => {
  const id = await newPage(request, `Share E2E ${testInfo.workerIndex}`);

  await openShare(page, id);
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Share this page')).toBeVisible();

  // The worker instance is unclaimed, so the dialog honestly discloses that these
  // settings are saved but not yet enforced (OB-203 pre-claim notice).
  await expect(dialog.getByText(/Sharing takes effect once you claim this instance/)).toBeVisible();
  await takeSnapshot(page, testInfo); // visual: the open Share dialog

  // 1. Set the page's visibility scope → persisted via setPageVisibility.
  await chooseValue(page, '#share-scope', 'restricted');
  await expect(page.locator('#share-scope')).toHaveAttribute('data-value', 'restricted');
  await expect
    .poll(async () => (await (await request.get(`${SERVER}/api/pages/${id}/visibility`)).json()).visibility)
    .toBe('restricted');

  // 2. Add a person as can-view → persisted via sharePage, then listed.
  await dialog.getByLabel('Invite people').fill('alice@example.com');
  await dialog.getByRole('button', {name: 'Add', exact: true}).click();

  const grant = dialog.getByRole('listitem').filter({hasText: 'alice@example.com'});
  await expect(grant).toBeVisible();
  await expect(grant.getByText('Can view')).toBeVisible();
  await expect
    .poll(async () => (await (await request.get(`${SERVER}/api/pages/${id}/acl`)).json()).length)
    .toBe(1);

  // 3. Remove the grant → it disappears and the ACL empties.
  await grant.getByRole('button', {name: 'Remove alice@example.com'}).click();
  await expect(dialog.getByText('alice@example.com')).toHaveCount(0);
  await expect
    .poll(async () => (await (await request.get(`${SERVER}/api/pages/${id}/acl`)).json()).length)
    .toBe(0);
});
