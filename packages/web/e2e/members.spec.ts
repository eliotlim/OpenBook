import {test, expect, takeSnapshot, chooseValue} from './fixtures';
import {SERVER} from './seed';

// The instance Members roster (OB-204): open Settings → Workspace → Members,
// invite someone by email, and change their role — all driving the OB-191 roster
// API (`listMembers` / `inviteMember` / `updateMember`).
//
// The worker's data server is a fresh, unclaimed instance with the default
// `guestAccess: 'write'`, so the (anonymous) browser passes the `requireCreate`
// gate that fronts every roster route — it counts as a manager and sees the full
// surface, exactly the local-first / self-host default.

async function openMembers(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', {name: 'Settings'}).first().click();
  await page.getByRole('button', {name: 'Members'}).click();
  await expect(page.getByRole('heading', {name: 'Members'})).toBeVisible();
}

test('members: list, invite by email, and change a role', async ({page, request}, testInfo) => {
  await openMembers(page);

  // A fresh instance starts with an empty roster + the invite affordance.
  await expect(page.getByText('No members yet.', {exact: false})).toBeVisible();
  await expect(page.getByRole('button', {name: 'Invite', exact: true})).toBeVisible();
  await takeSnapshot(page, testInfo); // visual: the Members roster surface

  // 1. Invite a person by email → persisted via inviteMember, then listed as an
  //    invited viewer (email personas default to `invited`).
  const email = `rae-${testInfo.workerIndex}@example.com`;
  await page.locator('#member-invitee').fill(email);
  await page.getByRole('button', {name: 'Invite', exact: true}).click();

  const row = page.getByRole('listitem').filter({hasText: email});
  await expect(row).toBeVisible();
  await expect(row.getByText('Invited')).toBeVisible();
  await expect
    .poll(async () => (await (await request.get(`${SERVER}/api/members`)).json()).length)
    .toBe(1);

  // 2. Change the member's role viewer → admin via the row's role picker →
  //    persisted via updateMember.
  await chooseValue(page, row.getByRole('combobox'), 'admin');
  await expect
    .poll(async () => (await (await request.get(`${SERVER}/api/members`)).json())[0].role)
    .toBe('admin');
});
