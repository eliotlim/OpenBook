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
  // saved but unenforced until the library is claimed (OB-203 pre-claim notice).
  await expect(dialog.getByText(/take effect only once you claim this library/)).toBeVisible();
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

// SHR-4 progressive disclosure: the scope picker surfaces only the everyday
// scopes (Workspace default / public / restricted) up front and tucks the
// obscure `authenticated` behind a "More access options" reveal, hiding the
// dormant `members` scope entirely. The reveal moves focus onto the picker so a
// keyboard user lands on the control that just gained options, and a scope
// chosen from behind the reveal persists and rehydrates on reopen.
test('share: the scope picker progressively discloses advanced scopes', {tag: ['@sharing']}, async ({page, request}, testInfo) => {
  const id = await newPage(request, `Share Scope E2E ${testInfo.workerIndex}`);
  await openShare(page, id);
  const dialog = page.getByRole('dialog');

  const option = (v: string) => page.locator(`[role="option"][data-value="${v}"]`);

  // Collapsed: the three primary scopes are offered; `authenticated`/`members`
  // are not.
  await page.locator('#share-scope').click();
  await expect(option('inherit')).toBeVisible();
  await expect(option('public')).toBeVisible();
  await expect(option('restricted')).toBeVisible();
  await expect(option('authenticated')).toHaveCount(0);
  await expect(option('members')).toHaveCount(0);
  await page.keyboard.press('Escape'); // dismiss the listbox
  await expect(page.locator('[role="option"]')).toHaveCount(0);

  // The reveal exposes `authenticated` and shifts focus onto the scope Select.
  await dialog.getByRole('button', {name: 'More access options'}).click();
  await expect(page.locator('#share-scope')).toBeFocused();
  await page.locator('#share-scope').click();
  await expect(option('authenticated')).toBeVisible();

  // Select the newly-revealed scope → it persists via setPageVisibility.
  await option('authenticated').click({force: true});
  await expect(page.locator('[role="option"]')).toHaveCount(0);
  await expect(page.locator('#share-scope')).toHaveAttribute('data-value', 'authenticated');
  await expect
    .poll(async () => (await (await request.get(`${SERVER}/api/pages/${id}/visibility`)).json()).visibility)
    .toBe('authenticated');

  // Round-trip: reopen the dialog — the stored advanced scope rehydrates and is
  // still shown even though it lives behind the reveal (the current value is
  // always offered).
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await page.getByRole('button', {name: 'Share', exact: true}).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.locator('#share-scope')).toHaveAttribute('data-value', 'authenticated');
});
