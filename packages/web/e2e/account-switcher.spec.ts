import {test, expect, takeSnapshot} from './fixtures';
import type {Page} from '@playwright/test';

/**
 * OB-206 — the multi-account switcher (Settings → Account) and the
 * sign-up-to-publish onboarding nudge.
 *
 * The switcher test seeds two already-connected accounts straight into the
 * namespaced localStorage the AccountProvider reads on mount, so it exercises the
 * UI without driving the real OAuth deep-link flow. The account service is
 * stubbed (settings + identity) so the reconcile-on-activate succeeds offline and
 * never 401s the seeded tokens away.
 */

const ACCOUNTS = [
  {
    id: 'acct-personal',
    name: 'personal@home.example',
    email: 'personal@home.example',
    subject: null,
    accountUrl: 'https://account.book.pub',
    connectedAt: 1,
    lastServerUpdatedAt: null,
  },
  {
    id: 'acct-work',
    name: 'work@corp.example',
    email: 'work@corp.example',
    subject: null,
    accountUrl: 'https://account.book.pub',
    connectedAt: 2,
    lastServerUpdatedAt: null,
  },
];

/** Answer the account service offline: empty settings + no issued identity. */
async function stubAccountService(page: Page): Promise<void> {
  await page.route('https://account.book.pub/api/**', (route) => {
    const url = route.request().url();
    if (url.includes('/api/identity/token')) {
      return route.fulfill({status: 501, contentType: 'application/json', body: '{}'});
    }
    // /api/settings (GET pull / PUT push) — an empty, never-written remote.
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({settings: {}, updatedAt: null}),
    });
  });
}

test('account switcher: lists accounts and switches the active one', {tag: ['@sharing', '@visual']}, async ({page}, testInfo) => {
  await stubAccountService(page);
  await page.addInitScript((accounts) => {
    localStorage.setItem('openbook.accounts', JSON.stringify(accounts));
    localStorage.setItem('openbook.accounts.active', 'acct-personal');
    localStorage.setItem('openbook.account.token.acct-personal', 'tok-personal');
    localStorage.setItem('openbook.account.token.acct-work', 'tok-work');
  }, ACCOUNTS);

  await page.goto('/');
  await page.getByRole('button', {name: 'Settings'}).first().click();
  await page.getByRole('button', {name: 'Account & sync'}).click();

  // Both personas are listed; the seeded account is the active one.
  // The email also renders in the ProfileMenu + SettingsPanel's ProfileChip, so
  // scope each assertion to its own switcher row.
  await expect(page.locator('[data-account-id="acct-personal"]').getByText('personal@home.example')).toBeVisible();
  await expect(page.locator('[data-account-id="acct-work"]').getByText('work@corp.example')).toBeVisible();
  await expect(page.locator('[data-account-id="acct-personal"]')).toHaveAttribute('data-active', 'true');
  await expect(page.locator('[data-account-id="acct-work"]')).toHaveAttribute('data-active', 'false');
  await takeSnapshot(page, testInfo); // visual: the account switcher

  // Switching makes the other account active; the live marker follows it.
  await page.getByRole('button', {name: 'Switch to work@corp.example'}).click();
  await expect(page.locator('[data-account-id="acct-work"]')).toHaveAttribute('data-active', 'true');
  await expect(page.locator('[data-account-id="acct-personal"]')).toHaveAttribute('data-active', 'false');
});

test('onboarding nudge: shows when unauthenticated and opens sign-in', {tag: ['@sharing', '@visual']}, async ({page}, testInfo) => {
  await page.goto('/');

  const nudge = page.locator('[data-onboarding-nudge]');
  await expect(nudge).toBeVisible();
  await expect(nudge.getByText('Sync and publish')).toBeVisible();
  await takeSnapshot(page, testInfo); // visual: the onboarding nudge

  // The CTA lands in Settings → Account, where the real sign-in lives.
  await nudge.getByRole('button', {name: 'Get started free'}).click();
  await expect(page.getByRole('button', {name: 'Continue with account.book.pub'})).toBeVisible();
});

test('onboarding nudge: dismissal sticks across reloads', {tag: ['@sharing']}, async ({page}) => {
  await page.goto('/');

  const nudge = page.locator('[data-onboarding-nudge]');
  await expect(nudge).toBeVisible();
  await nudge.getByRole('button', {name: 'Dismiss'}).click();
  await expect(nudge).toHaveCount(0);

  // A reload must not bring it back — the dismissal is persisted.
  await page.reload();
  await expect(page.locator('[data-onboarding-nudge]')).toHaveCount(0);
});
