import {test, expect, chooseValue} from './fixtures';
import {SERVER, emptySnapshot} from './seed';

// AGED-5: the agent-edits policy UI — the library-wide default (Settings → Agent
// access) and the per-page tri-state override (the Customise pane). Both round-trip
// through the in-webview PGlite transport and survive a reload.

test('agent-edits: library default round-trips and survives reload', {tag: ['@shell']}, async ({page}) => {
  await page.goto('/');
  await page.getByRole('button', {name: 'Settings'}).first().click();
  // Agent access lives under Advanced; the tab shows once the admin probe resolves
  // (single-user web instance → owner-equivalent).
  await page.getByRole('button', {name: 'Agents & AI admin'}).click();

  const combo = page.getByRole('combobox', {name: 'When an agent edits a page'});
  await expect(combo).toBeVisible();
  // Ships as Suggest (the safe default).
  await expect(combo).toContainText('Suggest edits for review');

  await chooseValue(page, combo, 'direct');
  await expect(combo).toContainText('Edit pages directly');

  // Persisted server-side (PGlite): the tab lives in the URL, so a reload reopens
  // Settings on the Agents tab and the restored mode is read back from the store.
  await page.reload();
  await expect(
    page.getByRole('combobox', {name: 'When an agent edits a page'}),
  ).toContainText('Edit pages directly');
});

test('agent-edits: per-page tri-state overrides the library default and persists', {tag: ['@shell']}, async ({page, request}) => {
  // A fresh page starts at the library default (Inherit).
  const res = await request.post(`${SERVER}/api/pages`, {
    data: {name: `Agent Edits ${Date.now()}`, data: emptySnapshot},
  });
  const {id} = (await res.json()) as {id: string};
  await page.goto(`/?page=${id}`);
  await expect(page.getByRole('button', {name: 'Page actions'})).toBeVisible();

  // Open the Customise pane from the page header cluster.
  await page.getByRole('button', {name: 'Customise page'}).first().click();

  const combo = page.getByRole('combobox', {name: 'Agent edits'});
  await expect(combo).toBeVisible();
  await expect(combo).toContainText('Library default');
  // Inheriting spells out what the library default currently resolves to.
  await expect(page.getByText(/Following the library default/)).toBeVisible();

  // Pin this page to Direct; the effective hint disappears (no longer inheriting).
  await chooseValue(page, combo, 'direct');
  await expect(combo).toContainText('Edit page directly');
  await expect(page.getByText(/Following the library default/)).toHaveCount(0);

  // Persisted per-page: reload, reopen the pane, the override is restored.
  await page.reload();
  await expect(page.getByRole('button', {name: 'Page actions'})).toBeVisible();
  await page.getByRole('button', {name: 'Customise page'}).first().click();
  await expect(page.getByRole('combobox', {name: 'Agent edits'})).toContainText('Edit page directly');
});
