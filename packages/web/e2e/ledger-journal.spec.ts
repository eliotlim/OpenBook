import {test, expect} from './fixtures';
import {SERVER} from './seed';
import {ensureLedgerPlugin} from './ledgerPlugin';

/**
 * LGR-5: the journal entry block, end to end — the REAL first-party plugin
 * from examples/plugins/ledger (read from disk, zipped, installed through
 * Settings → Extensions), driving the REAL ledger server.
 *
 * Proves: setup command (idempotent), the Post gate (impossible to post
 * unbalanced through the UI; disabled → enabled at Σ=0), integer minor units
 * on the wire, keyboard traversal (Tab cells, Enter adds row), draft
 * surviving reload, and typed LedgerError surfacing.
 */

const ledgerAccounts = async (): Promise<Array<{id: string; name: string}>> => {
  const res = await fetch(`${SERVER}/api/ledger/accounts`);
  return res.ok ? ((await res.json()) as Array<{id: string; name: string}>) : [];
};

async function runPaletteCommand(page: import('@playwright/test').Page, title: string): Promise<void> {
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByPlaceholder(/Search pages or run a command/).fill(title);
  await page.getByRole('option', {name: new RegExp(title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))}).click();
}

/** A fresh page hosting one journal entry block, inserted via the slash menu. */
async function pageWithJournalBlock(page: import('@playwright/test').Page, request: import('@playwright/test').APIRequestContext, name: string): Promise<string> {
  const res = await request.post(`${SERVER}/api/pages`, {
    data: {name, data: {editor: 'blocks', blockdoc: {blocks: [{id: 'p1', type: 'paragraph', text: [{t: ''}]}]}, editorjs: {blocks: []}, values: [], names: []}},
  });
  const {id} = (await res.json()) as {id: string};
  await page.goto(`/?page=${id}`);
  await expect(page.locator('.obe-text').first()).toBeVisible();
  await page.locator('.obe-text').first().click();
  // Retry the slash insertion: right after hydration the first keystrokes can
  // land before the editor (or the plugin's slash contribution) is live.
  const item = page.locator('.obe-slash-item', {has: page.locator('.obe-slash-label', {hasText: 'Journal entry'})});
  for (let attempt = 0; ; attempt += 1) {
    await page.keyboard.type('/journal');
    try {
      await expect(item.first()).toBeVisible({timeout: 3000});
      break;
    } catch (err) {
      if (attempt >= 2) throw err;
      await page.keyboard.press('Escape');
      for (let i = 0; i < '/journal'.length; i += 1) await page.keyboard.press('Backspace');
    }
  }
  await item.first().click();
  await expect(page.locator('[data-ledger-journal]')).toBeVisible();
  return id;
}

const row = (page: import('@playwright/test').Page, n: number) => ({
  account: page.getByLabel(`Row ${n} account`),
  debit: page.getByLabel(`Row ${n} debit`),
  credit: page.getByLabel(`Row ${n} credit`),
  memo: page.getByLabel(`Row ${n} memo`),
});

test('install the real plugin, set up books (idempotent), post a 3-row compound entry — gate flips disabled → enabled at Σ=0, integers on the wire', {tag: ['@ledger', '@p1']}, async ({page, request}) => {
  // Install the shipped sources through Settings → Extensions (the whole
  // package, walked from disk — see ./ledgerPlugin).
  await ensureLedgerPlugin(page);

  // "Ledger: set up books" seeds the ledger + the 10-account starter chart…
  await runPaletteCommand(page, 'Ledger: set up books');
  await expect.poll(async () => (await ledgerAccounts()).length).toBe(10);
  await expect.poll(async () => ((await (await fetch(`${SERVER}/api/ledger`)).json()) as {exists: boolean}).exists).toBe(true);

  // …idempotently: a second run creates nothing (no dupes). Proven
  // positively — the command runs again and account IDENTITY is unchanged, so
  // a re-seed would show up as new ids rather than being waited out.
  const before = (await ledgerAccounts()).map((a) => `${a.id}:${a.name}`).sort();
  let seedingRequests = 0;
  page.on('request', (req) => {
    if (req.method() === 'POST' && new URL(req.url()).pathname === '/api/ledger') seedingRequests += 1;
  });
  await runPaletteCommand(page, 'Ledger: set up books');
  // The second run demonstrably reached the server (POST /api/ledger)…
  await expect.poll(() => seedingRequests).toBeGreaterThanOrEqual(1);
  // …and changed nothing: same account ids, same names. A re-seed would show
  // up as NEW ids, so this catches duplicates without waiting one out.
  expect((await ledgerAccounts()).map((a) => `${a.id}:${a.name}`).sort()).toEqual(before);
  const names = (await ledgerAccounts()).map((a) => a.name);
  expect(names).toContain('Assets:Bank:Checking');
  expect(names).toContain('Expenses:Bank Fees');

  // Capture every draft/post wire payload to assert integer minor units.
  const wire: Array<{method: string; url: string; body: unknown}> = [];
  page.on('request', (req) => {
    if (req.url().includes('/api/ledger/transactions') && (req.method() === 'POST' || req.method() === 'PATCH')) {
      let body: unknown = null;
      try {
        body = req.postDataJSON() as unknown;
      } catch {
        body = null; // the atomic post op sends no body
      }
      wire.push({method: req.method(), url: req.url(), body});
    }
  });

  await pageWithJournalBlock(page, request, `Journal ${Date.now()}`);
  const post = page.locator('[data-ledger-post]');
  const desc = `Payroll ${Date.now()}`;

  // Empty block: gate closed, and the block says what to do rather than
  // scolding an untouched form.
  await expect(post).toBeDisabled();
  await expect(page.locator('[data-ledger-hint]')).toBeVisible();
  await expect(page.locator('[data-ledger-imbalance]')).toHaveCount(0);

  // Payroll-style compound entry, dated deliberately (not just "today").
  await page.locator('[data-ledger-description]').fill(desc);
  await page.locator('[data-ledger-date]').fill('2026-03-31');
  await row(page, 1).account.selectOption({label: 'Expenses:Office'});
  await row(page, 1).debit.fill('2,500.00');
  await row(page, 1).memo.fill('gross wages');

  // One amount in: still no alarm — every entry is unbalanced while typing.
  await expect(page.locator('[data-ledger-imbalance]')).toHaveCount(0);
  await expect(page.locator('[data-ledger-problem]')).toBeVisible();

  // Second amount disagrees → the alarm is earned: magnitude AND side.
  await row(page, 2).account.selectOption({label: 'Assets:Bank:Checking'});
  await row(page, 2).credit.fill('2000');
  await row(page, 2).memo.click(); // blur the amount → canonical display
  await expect(row(page, 2).credit).toHaveValue('2,000.00');
  await expect(page.locator('[data-ledger-imbalance]')).toHaveText(/debits exceed credits by 500\.00/);
  await expect(page.locator('[data-ledger-sum]')).toHaveAttribute('data-ledger-balanced', 'false');
  await expect(page.locator('[data-ledger-sum]')).toContainText('Out by 500.00');
  await expect(post).toBeDisabled();

  // Third leg balances it: alarm gone, gate open, balance confirmed positively.
  await page.locator('[data-ledger-add-row]').click();
  await row(page, 3).account.selectOption({label: 'Liabilities:CreditCard'});
  await row(page, 3).credit.fill('500.00');
  await row(page, 3).memo.fill('withheld to card');
  await expect(page.locator('[data-ledger-imbalance]')).toHaveCount(0);
  await expect(page.locator('[data-ledger-problem]')).toHaveCount(0);
  await expect(page.locator('[data-ledger-sum]')).toContainText('In balance');
  await expect(page.locator('[data-ledger-sum]')).toHaveAttribute('data-ledger-balanced', 'true');
  await expect(post).toBeEnabled();

  // Post: atomic server op; success clears to a fresh draft.
  await post.click();
  await expect(page.locator('[data-ledger-posted]')).toBeVisible();
  await expect(page.locator('[data-ledger-account]')).toHaveCount(2);
  await expect(row(page, 1).debit).toHaveValue('');
  await expect(page.locator('[data-ledger-description]')).toHaveValue('');
  await expect(post).toBeDisabled();

  // The wire only ever carried signed INTEGER minor units (never floats or
  // formatted strings): the final full payload is exactly the compound entry.
  const payloads = wire
    .map((w) => (w.body as {postings?: Array<{accountId: string; amountMinor: number}>})?.postings)
    .filter((p): p is Array<{accountId: string; amountMinor: number}> => Array.isArray(p));
  expect(payloads.length).toBeGreaterThan(0);
  for (const postings of payloads) {
    for (const p of postings) {
      expect(Number.isInteger(p.amountMinor)).toBe(true);
    }
  }
  const full = payloads.filter((p) => p.length === 3).at(-1);
  expect(full?.map((p) => p.amountMinor).sort((a, b) => a - b)).toEqual([-200000, -50000, 250000]);

  // And the server agrees: exactly one posted transaction for this entry,
  // balanced, entry number assigned.
  const posted = (await (await fetch(`${SERVER}/api/ledger/transactions?state=posted`)).json()) as Array<{
    description: string;
    date: string;
    entryNo: number | null;
    postings: Array<{amountMinor: number}>;
  }>;
  const mine = posted.filter((t) => t.description === desc);
  expect(mine).toHaveLength(1);
  expect(mine[0].entryNo).not.toBeNull();
  expect(mine[0].postings.reduce((n, p) => n + p.amountMinor, 0)).toBe(0);
  // The date the user chose is the date on the books — not the day the draft
  // happened to be created.
  expect(mine[0].date).toBe('2026-03-31');

  // LGR-16 round trip: the memos typed in the block are on the POSTINGS of the
  // posted (immutable) entry, and they reach the canonical CSV export — the
  // whole point of moving them out of block props.
  const memos = (mine[0] as unknown as {postings: Array<{memo: string | null}>}).postings.map((p) => p.memo ?? '').sort();
  expect(memos).toEqual(['', 'gross wages', 'withheld to card']);
  const csv = await (await fetch(`${SERVER}/api/ledger/export.csv`)).text();
  expect(csv.split('\n')[0].split(',')).toContain('memo');
  expect(csv).toContain(',gross wages');
  expect(csv).toContain(',withheld to card');
});

test('keyboard-first: Tab walks account → debit → credit → memo → next row; Enter adds a row', {tag: ['@ledger', '@p1']}, async ({page, request}) => {
  await pageWithJournalBlock(page, request, `Journal keys ${Date.now()}`);

  await row(page, 1).account.focus();
  await expect(row(page, 1).account).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(row(page, 1).debit).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(row(page, 1).credit).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(row(page, 1).memo).toBeFocused();
  // The (hidden, disabled) remove button is out of the tab order at 2 rows:
  // focus lands straight on the next row's account picker.
  await page.keyboard.press('Tab');
  await expect(row(page, 2).account).toBeFocused();

  // Enter in any ROW cell appends a row and focuses its account picker.
  await expect(page.locator('[data-ledger-account]')).toHaveCount(2);
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-ledger-account]')).toHaveCount(3);
  await expect(row(page, 3).account).toBeFocused();

  // At 3 rows the remove-× is visible but OUT of the typing tab order: Tab
  // from a memo cell still reaches the next row's account picker, never the
  // destructive button.
  await row(page, 1).memo.focus();
  await page.keyboard.press('Tab');
  await expect(row(page, 2).account).toBeFocused();

  // Enter in the description must NOT add a row (it is not a row cell).
  await page.locator('[data-ledger-description]').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-ledger-account]')).toHaveCount(3);

  // Alt+Backspace is the documented keyboard removal path; focus survives it.
  await row(page, 3).debit.focus();
  await page.keyboard.press('Alt+Backspace');
  await expect(page.locator('[data-ledger-account]')).toHaveCount(2);
  await expect(row(page, 2).account).toBeFocused();

  // Escape still belongs to the host (the block no longer swallows it).
  await row(page, 1).debit.focus();
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-ledger-journal]')).toBeVisible();
});

test('a half-entered draft survives reload (ledger draft ops + block props)', {tag: ['@ledger']}, async ({page, request}) => {
  const pageId = await pageWithJournalBlock(page, request, `Journal draft ${Date.now()}`);

  const accounts = await ledgerAccounts();
  const cash = accounts.find((a) => a.name === 'Assets:Cash')!;
  await page.locator('[data-ledger-date]').fill('2026-01-17');
  await row(page, 1).account.selectOption({label: 'Assets:Cash'});
  await row(page, 1).debit.fill('42.00');
  await row(page, 1).memo.fill('half done');

  // The debounced sync lands the draft server-side (the LGR-3 draft ops) —
  // and since LGR-16 the MEMO is real posting data that lands with it, not a
  // block prop that never reaches the books.
  await expect
    .poll(async () => {
      const drafts = (await (await fetch(`${SERVER}/api/ledger/transactions?state=draft`)).json()) as Array<{postings: Array<{accountId: string; amountMinor: number; memo: string | null}>}>;
      return drafts.some((d) => d.postings.some((p) => p.accountId === cash.id && p.amountMinor === 4200 && p.memo === 'half done'));
    })
    .toBe(true);
  // …and the block props carry the raw cell text plus a local CACHE of the
  // memo. The books remain the source of truth — mergeMemosFromDraft overwrites
  // this copy on boot — but props cannot DROP it: the prop write is synchronous
  // while the draft sync is debounced, so the two routinely disagree on posting
  // count, the merge then (correctly) merges nothing, and with no local copy the
  // memo rendered blank and the next keystroke wrote that blank back as
  // `memo: null`, destroying the stored memo server-side.
  await expect
    .poll(async () => JSON.stringify(await (await fetch(`${SERVER}/api/pages/${pageId}`)).json()).includes('42.00'), {timeout: 15000})
    .toBe(true);
  await expect
    .poll(async () => JSON.stringify(await (await fetch(`${SERVER}/api/pages/${pageId}`)).json()).includes('half done'), {timeout: 15000})
    .toBe(true);

  await page.reload();
  await expect(page.locator('[data-ledger-journal]')).toBeVisible();
  await expect(row(page, 1).debit).toHaveValue('42.00');
  await expect(row(page, 1).memo).toHaveValue('half done');
  await expect(row(page, 1).account).toHaveValue(cash.id);
  await expect(page.locator('[data-ledger-date]')).toHaveValue('2026-01-17'); // the chosen date survives too (C4)
  await expect(page.locator('[data-ledger-post]')).toBeDisabled(); // still incomplete — gate stays shut
});

test('a server rejection surfaces its typed LedgerError reason in the block', {tag: ['@ledger']}, async ({page, request}) => {
  await pageWithJournalBlock(page, request, `Journal reject ${Date.now()}`);
  const desc = `Reject ${Date.now()}`;

  await page.locator('[data-ledger-description]').fill(desc);
  await row(page, 1).account.selectOption({label: 'Expenses:Hosting'});
  await row(page, 1).debit.fill('12.00');
  await row(page, 2).account.selectOption({label: 'Assets:Cash'});
  await row(page, 2).credit.fill('12.00');
  await expect(page.locator('[data-ledger-post]')).toBeEnabled();

  // Wait for the block's debounced sync to land the draft, then post it OUT
  // FROM UNDER the UI via the API: the block's own Post now hits the typed
  // invalid-state rejection (post of a non-draft), and the block says so.
  let draftId = '';
  await expect
    .poll(async () => {
      const drafts = (await (await fetch(`${SERVER}/api/ledger/transactions?state=draft`)).json()) as Array<{id: string; description: string}>;
      draftId = drafts.find((d) => d.description === desc)?.id ?? '';
      return draftId;
    })
    .not.toBe('');
  const postedUnder = await request.post(`${SERVER}/api/ledger/transactions/${draftId}/post`);
  expect(postedUnder.ok()).toBe(true);

  // The block's own Post now hits the typed `immutable` rejection: it says so
  // plainly, does NOT post a second copy, and — crucially — does not wedge.
  await page.locator('[data-ledger-post]').click();
  const banner = page.locator('[data-ledger-error="immutable"]');
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('already posted');
  await expect(banner).toContainText('immutable'); // the code is kept, demoted
  const postedTwice = (await (await fetch(`${SERVER}/api/ledger/transactions?state=posted`)).json()) as Array<{description: string}>;
  expect(postedTwice.filter((t) => t.description === desc)).toHaveLength(1);

  // Recovery (C2): the block detached the dead draft, so editing on works and
  // the next Post commits a NEW entry rather than failing forever.
  const desc2 = `${desc} take two`;
  await page.locator('[data-ledger-description]').fill(desc2);
  await expect(page.locator('[data-ledger-post]')).toBeEnabled();
  await page.locator('[data-ledger-post]').click();
  await expect(page.locator('[data-ledger-posted]')).toBeVisible();
  await expect(page.locator('[data-ledger-error]')).toHaveCount(0); // no stale rejection alongside success
  const after = (await (await fetch(`${SERVER}/api/ledger/transactions?state=posted`)).json()) as Array<{description: string}>;
  expect(after.filter((t) => t.description === desc2)).toHaveLength(1);
});

test('a draft that failed to save is never posted (stale-commit guard)', {tag: ['@ledger', '@p1']}, async ({page, request}) => {
  await pageWithJournalBlock(page, request, `Journal stale ${Date.now()}`);
  const desc = `Stale ${Date.now()}`;

  // A first, balanced entry syncs normally.
  await page.locator('[data-ledger-description]').fill(desc);
  await row(page, 1).account.selectOption({label: 'Expenses:Software'});
  await row(page, 1).debit.fill('100.00');
  await row(page, 2).account.selectOption({label: 'Assets:Cash'});
  await row(page, 2).credit.fill('100.00');
  await expect
    .poll(async () => {
      const drafts = (await (await fetch(`${SERVER}/api/ledger/transactions?state=draft`)).json()) as Array<{description: string}>;
      return drafts.some((d) => d.description === desc);
    })
    .toBe(true);

  // Now every draft update fails at the transport (a 502/restart/offline blip
  // — NOT a typed LedgerError). The user corrects both amounts and posts.
  await page.route('**/api/ledger/transactions/*', (route) => (route.request().method() === 'PATCH' ? route.abort('failed') : route.continue()));
  await row(page, 1).debit.fill('250.00');
  await row(page, 2).credit.fill('250.00');
  await expect(page.locator('[data-ledger-post]')).toBeEnabled();
  await page.locator('[data-ledger-post]').click();

  // Nothing was posted: the failed save is surfaced, and the 100.00 the user
  // already replaced was NOT committed behind their back.
  await expect(page.locator('[data-ledger-error]')).toBeVisible();
  await expect(page.locator('[data-ledger-posted]')).toHaveCount(0);
  const posted = (await (await fetch(`${SERVER}/api/ledger/transactions?state=posted`)).json()) as Array<{description: string}>;
  expect(posted.filter((t) => t.description === desc)).toHaveLength(0);

  // With the transport healthy again the same entry posts — at the corrected
  // amounts, never the stale ones.
  await page.unroute('**/api/ledger/transactions/*');
  await row(page, 1).memo.fill('retry');
  await page.locator('[data-ledger-post]').click();
  await expect(page.locator('[data-ledger-posted]')).toBeVisible();
  const after = (await (await fetch(`${SERVER}/api/ledger/transactions?state=posted`)).json()) as Array<{
    description: string;
    postings: Array<{amountMinor: number}>;
  }>;
  const mine = after.filter((t) => t.description === desc);
  expect(mine).toHaveLength(1);
  expect(mine[0].postings.map((p) => p.amountMinor).sort((a, b) => a - b)).toEqual([-25000, 25000]);
});
