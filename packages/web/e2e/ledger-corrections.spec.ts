import {test, expect} from './fixtures';
import {SERVER} from './seed';
import {ensureLedgerPlugin} from './ledgerPlugin';
import {closeAccount, ensureAccount, getTransaction, pageWithBlock, postEntry, type ApiTransaction} from './ledgerApi';

/**
 * LGR-6: immutability and the escape hatch, end to end — the REAL first-party
 * plugin from examples/plugins/ledger, driving the REAL ledger server.
 *
 * The freeze shipped in LGR-4 and the store has modelled void+reversal since
 * LGR-3, but until now nothing in the product could ASK for a reversal: every
 * M2 surface could find an error and none could fix one. What these specs prove
 * is the whole round trip a user actually performs — find the wrong number, be
 * told plainly that it cannot be edited, correct it, and end up with books that
 * read the corrected figure with all three entries still on them.
 *
 * Money is never added up in this file. Balances are asserted as the strings
 * the register renders, and cross-checked against the exact integer minor units
 * the server holds — compared as strings, so the check itself never does
 * arithmetic on an amount.
 */

const bankAmountsFor = async (request: import('@playwright/test').APIRequestContext, accountId: string): Promise<string[]> => {
  const transactions = (await (await request.get(`${SERVER}/api/ledger/transactions?limit=1000`)).json()) as ApiTransaction[];
  return transactions
    .filter((t) => t.state === 'posted' || t.state === 'void')
    .flatMap((t) => t.postings)
    .filter((p) => p.accountId === accountId)
    .map((p) => String(p.amountMinor))
    .sort();
};

test('a posted entry cannot be edited, says why, and "Correct this entry" nets the books to the corrected figure', {tag: ['@ledger', '@p1']}, async ({page, request}) => {
  const uniq = `${Date.now()}`;
  const bank = await ensureAccount(request, `CR${uniq}:Assets:Bank`, 'asset');
  const expense = await ensureAccount(request, `CR${uniq}:Expenses:Hosting`, 'expense');

  // The mistake: 42.00 entered where 45.00 belonged.
  const wrong = await postEntry(request, {
    date: '2026-03-04',
    description: 'Hosting bill',
    postings: [
      {accountId: bank, amountMinor: -4200},
      {accountId: expense, amountMinor: 4200},
    ],
  });

  await ensureLedgerPlugin(page);
  await pageWithBlock(page, request, `Corrections ${uniq}`, '/register', 'Account register', '[data-ledger-register]');
  await page.locator('[data-ledger-register-account]').selectOption({label: `CR${uniq}:Assets:Bank`});

  const rows = page.locator('[data-ledger-register-row]');
  await expect(rows).toHaveCount(1);
  await expect(page.locator('[data-ledger-closing]')).toHaveText('42.00 Cr');

  // ── 1. The entry is visibly, statedly un-editable ──────────────────────────
  // Not "inert until you try": the rule is written where the entry is shown, and
  // it names the way out in the same breath.
  const immutable = page.locator('[data-ledger-immutable]');
  await expect(immutable).toBeVisible();
  await expect(immutable).toContainText('Posted entries are permanent');
  await expect(immutable).toContainText('cannot be edited or deleted');
  await expect(immutable).toContainText('Correct this entry');
  // …and there is no edit affordance on the row to discover by failure.
  await expect(rows.locator('input')).toHaveCount(0);
  await expect(rows.locator('select')).toHaveCount(0);
  await expect(rows.locator('[contenteditable="true"]')).toHaveCount(0);

  // ── 2. The confirmation states the whole bargain, and Cancel writes nothing ─
  const correct = page.locator(`[data-ledger-correct="${wrong.id}"]`);
  await expect(correct).toBeEnabled();
  // The live button's own picture, kept for the disabled comparison below.
  await expect(correct).toHaveCSS('border-style', 'solid');
  await correct.click();
  const confirm = page.locator('[data-ledger-correct-confirm]');
  await expect(confirm).toBeVisible();
  await expect(confirm).toContainText('Correct entry #');
  await expect(confirm).toContainText('Hosting bill');
  // All three consequences, before anything irreversible happens.
  await expect(confirm).toContainText('The original stays on the books');
  await expect(confirm).toContainText('an opposite entry that cancels its effect');
  await expect(confirm).toContainText('editable copy to correct');
  await expect(confirm).toContainText('The reversal is permanent too');
  // A decision point takes focus, so it is not something a keyboard user has to
  // go looking for.
  await expect(page.locator('[data-ledger-correct-go]')).toBeFocused();

  await page.locator('[data-ledger-correct-cancel]').click();
  await expect(confirm).toHaveCount(0);
  await expect(rows).toHaveCount(1); // nothing was written
  expect((await getTransaction(request, wrong.id)).state).toBe('posted');

  // ── 3. Confirm: the reversal is posted and a pre-filled copy comes back ────
  await correct.click();
  await page.locator('[data-ledger-correct-go]').click();

  const panel = page.locator('[data-ledger-correction]');
  await expect(panel).toBeVisible();
  // FOCUS FOLLOWS THE FLOW. The button that was pressed is gone; without this
  // the user is dropped to <body> at the top of the document, every time.
  await expect(panel).toBeFocused();
  // The consequence of bailing out is wired to the Close button itself, not
  // stranded below the whole journal form.
  const closeWhy = page.locator('[data-ledger-correction-close-why]');
  await expect(closeWhy).toContainText('unposted draft');
  await expect(page.locator('[data-ledger-correction-close]')).toHaveAttribute('aria-describedby', (await closeWhy.getAttribute('id')) ?? '');
  await expect(page.locator('[data-ledger-correction-head]')).toContainText('Correcting entry #');
  await expect(page.locator('[data-ledger-correction-head]')).toContainText('reversed by entry #');

  // PRE-FILLED: the copy is the original, read back out of the books through the
  // money core — not a blank form the user has to retype from memory.
  const journal = panel.locator('[data-ledger-journal]');
  await expect(journal.locator('[data-ledger-description]')).toHaveValue('Hosting bill');
  await expect(journal.locator('[data-ledger-date]')).toHaveValue('2026-03-04');
  await expect(journal.getByLabel('Row 1 credit')).toHaveValue('42.00');
  await expect(journal.getByLabel('Row 2 debit')).toHaveValue('42.00');

  // The books already hold the original AND its reversal, and they cancel.
  await expect(rows).toHaveCount(2);
  await expect(page.locator('[data-ledger-closing]')).toHaveText('0.00');
  expect((await getTransaction(request, wrong.id)).state).toBe('void');

  // ── 4. The pair is navigable, and the reversed row offers no second hatch ──
  const voidRow = rows.filter({has: page.locator('[data-ledger-counterpart="reversed-by"]')});
  const reversalRow = rows.filter({has: page.locator('[data-ledger-counterpart="reverses"]')});
  await expect(voidRow).toHaveAttribute('data-ledger-reversed', 'true');
  await expect(voidRow).toContainText('Hosting bill');
  await expect(voidRow.locator('[data-ledger-counterpart="reversed-by"]')).toContainText('Reversed by entry #');
  await expect(reversalRow).toContainText('Reversal of Hosting bill');
  await expect(reversalRow.locator('[data-ledger-counterpart="reverses"]')).toContainText('Reverses entry #');

  // Walk the pair: the link focuses the counterpart's own link, which points
  // back — so the two halves are reachable from each other by keyboard.
  const backLink = reversalRow.locator('[data-ledger-counterpart-link]');
  await voidRow.locator('[data-ledger-counterpart-link]').click();
  await expect(backLink).toBeFocused();
  await expect(reversalRow).toHaveAttribute('data-ledger-highlight', 'true');

  // The already-reversed row's Correct button is OFF, VISUALLY distinct, and
  // says why right beside itself — `disabled` takes it out of the tab order, so
  // a tooltip would be an explanation a keyboard user could never reach.
  const off = voidRow.locator('[data-ledger-correct-off="already-reversed"]');
  await expect(off).toBeDisabled();
  await expect(off).toHaveCSS('border-style', 'dashed');
  await expect(voidRow.locator('[data-ledger-correct-why="already-reversed"]')).toContainText('Already reversed — correct entry #');
  // Every other row is off too while a correction is open — and the reason is
  // stated ONCE above the table, not copied into every cell, with each disabled
  // button pointing at it.
  const blockReason = page.locator('[data-ledger-correct-why="correction-open"]');
  await expect(blockReason).toHaveCount(1);
  await expect(blockReason).toContainText('Finish or close the correction in progress');
  const otherOff = reversalRow.locator('[data-ledger-correct-off="correction-open"]');
  await expect(otherOff).toBeDisabled();
  await expect(otherOff).toHaveAttribute('aria-describedby', (await blockReason.getAttribute('id')) ?? '');

  // ── 5. Post the corrected copy: the books read 45.00 ───────────────────────
  await journal.getByLabel('Row 1 credit').fill('45.00');
  await journal.getByLabel('Row 2 debit').fill('45.00');
  const post = journal.locator('[data-ledger-post]');
  await expect(post).toBeEnabled();
  await post.click();

  // The panel closes itself off the BOOKS (the draft stopped being a draft),
  // and names all three entries in the chain.
  const doneNotice = page.locator('[data-ledger-correction-done]');
  await expect(doneNotice).toBeVisible();
  await expect(page.locator('[data-ledger-correction-dismiss]')).toBeFocused();
  await expect(doneNotice).toContainText('Corrected — entry #');
  await expect(doneNotice).toContainText('and your corrected copy is posted as entry #');
  await expect(panel).toHaveCount(0);

  // END TO END: three entries on the books, and the account reads the corrected
  // figure — not the wrong one, and not both added together.
  await expect(rows).toHaveCount(3);
  await expect(page.locator('[data-ledger-closing]')).toHaveText('45.00 Cr');
  expect(await bankAmountsFor(request, bank)).toEqual(['-4200', '-4500', '4200'].sort());

  // Correcting a REVERSAL is allowed — a reversal is an ordinary posted entry,
  // and correcting one is how an over-eager correction is itself undone.
  await expect(reversalRow.locator('[data-ledger-correct]')).toBeEnabled();
});

test('a reversal into a CLOSED account is refused with the typed error, legibly, and nothing is reversed', {tag: ['@ledger', '@p1']}, async ({page, request}) => {
  const uniq = `${Date.now()}`;
  const bank = await ensureAccount(request, `CC${uniq}:Assets:Bank`, 'asset');
  const parked = await ensureAccount(request, `CC${uniq}:Expenses:Parked`, 'expense');

  // Two entries that cancel on BOTH accounts, so `parked` can legally be closed
  // — and the first one's reversal would then have to post into it.
  const first = await postEntry(request, {
    date: '2026-03-04',
    description: 'Parked spend',
    postings: [
      {accountId: bank, amountMinor: -10000},
      {accountId: parked, amountMinor: 10000},
    ],
  });
  await postEntry(request, {
    date: '2026-03-05',
    description: 'Parked refund',
    postings: [
      {accountId: bank, amountMinor: 10000},
      {accountId: parked, amountMinor: -10000},
    ],
  });
  await closeAccount(request, parked);

  await ensureLedgerPlugin(page);
  await pageWithBlock(page, request, `Closed account ${uniq}`, '/register', 'Account register', '[data-ledger-register]');
  await page.locator('[data-ledger-register-account]').selectOption({label: `CC${uniq}:Assets:Bank`});
  await expect(page.locator('[data-ledger-register-row]')).toHaveCount(2);

  await page.locator(`[data-ledger-correct="${first.id}"]`).click();
  await page.locator('[data-ledger-correct-go]').click();

  // The typed rejection, surfaced as a sentence — with the code kept for a bug
  // report, not used AS the message.
  const error = page.locator('[data-ledger-correct-error="account-closed"]');
  await expect(error).toBeVisible();
  // The refusal shares its tone with the confirmation it just refused, and they
  // can be on screen together — so the LEAD carries weight instead of a second
  // colour, and `alarm` stays reserved for the books not balancing.
  await expect(error.locator('[data-ledger-correct-error-lead]')).toHaveCSS('font-weight', '600');
  await expect(error).toBeFocused();
  await expect(error).toContainText('Nothing was reversed');
  await expect(error).toContainText(`CC${uniq}:Expenses:Parked`);
  await expect(error).toContainText('reopen the account, then correct the entry');
  await expect(error).toContainText('(account-closed)');
  // NOT the alarm tone: that colour is spoken for by "the books do not balance"
  // and by a report that could not be computed. A refused action is neither.
  await expect(error).not.toHaveCSS('font-weight', '600');

  // Nothing happened: the entry is still posted, no reversal exists, no draft
  // copy was stranded, and the hatch is still open for a second attempt.
  expect((await getTransaction(request, first.id)).state).toBe('posted');
  await expect(page.locator('[data-ledger-register-row]')).toHaveCount(2);
  await expect(page.locator('[data-ledger-correction]')).toHaveCount(0);
  await expect(page.locator(`[data-ledger-correct="${first.id}"]`)).toBeEnabled();

  // Dismissing hands focus back to the control the user actually pressed.
  await page.locator('[data-ledger-correct-error-dismiss]').click();
  await expect(page.locator(`[data-ledger-correct="${first.id}"]`)).toBeFocused();
});
