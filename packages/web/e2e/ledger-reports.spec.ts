import {test, expect} from './fixtures';
import {SERVER} from './seed';
import {ensureLedgerPlugin} from './ledgerPlugin';
import {
  createDraft,
  draftCount,
  ensureAccount,
  pageWithBlock,
  postEntry,
  serveTransactions,
  wirePosted as posted,
  wirePosting as posting,
  type ApiTransaction,
} from './ledgerApi';

test.use({ownerGatedRequests: true});

/**
 * LGR-8: the read-only ledger reports, end to end — the REAL first-party plugin
 * from examples/plugins/ledger (zipped from disk, installed through Settings →
 * Extensions), driving the REAL ledger server.
 *
 * Proves: the trial balance's zero assertion on a live book, drafts excluded AND
 * visibly labelled in both reports, the register's running balance under a
 * date-range filter and a cleared-state filter (with the opening balance carried
 * in), and that posting a new entry updates both reports live — no reload.
 *
 * The DAMAGED and TRUNCATED states get their own test at the bottom. The server
 * cannot produce either one (it refuses to post an unbalanced entry, has no
 * account-delete, and the cap needs a thousand entries), so that test serves the
 * transaction list through a route interception — the real block, the real fold,
 * against data the server will not make. Those surfaces are exactly where the
 * design review found the most, so they are no longer un-rendered.
 */

test('trial balance: pinned-at-zero assertion on a live book, drafts excluded and labelled, live on a new entry', {tag: ['@ledger', '@p1']}, async ({page, request}) => {
  const uniq = `${Date.now()}`;
  const bank = await ensureAccount(request, `TB${uniq}:Assets:Bank`, 'asset');
  const revenue = await ensureAccount(request, `TB${uniq}:Income:Sales`, 'revenue');
  const idle = await ensureAccount(request, `TB${uniq}:Assets:Idle`, 'asset'); // never posted to

  await postEntry(request, {date: '2026-02-01', description: 'Invoice 1', postings: [{accountId: bank, amountMinor: 100000}, {accountId: revenue, amountMinor: -100000}]});
  await postEntry(request, {date: '2026-03-01', description: 'Invoice 2', postings: [{accountId: bank, amountMinor: 25000}, {accountId: revenue, amountMinor: -25000}]});
  // A draft that must NEVER reach the report — its amount is deliberately
  // distinctive so a leak would be unmistakable.
  await createDraft(request, {date: '2026-03-05', description: 'Not posted', postings: [{accountId: bank, amountMinor: 999999}, {accountId: revenue, amountMinor: -999999}]});

  await ensureLedgerPlugin(page);
  await pageWithBlock(page, request, `Trial balance ${uniq}`, '/trial', 'Trial balance', '[data-ledger-trial-balance]');

  // The assertion: debits equal credits, stated positively (not merely absent).
  const assertion = page.locator('[data-ledger-assertion]');
  await expect(assertion).toHaveAttribute('data-ledger-balanced', 'true');
  await expect(assertion).toContainText('In balance');
  await expect(page.locator('[data-ledger-difference]')).toHaveText('0.00');
  await expect(page.locator('[data-ledger-culprits]')).toHaveCount(0);

  // This book's own rows: debit-normal asset in the debit column, credit-normal
  // revenue in the credit column, each on its normal side.
  const bankRow = page.locator(`[data-ledger-tb-row="${bank}"]`);
  await expect(bankRow.locator('[data-ledger-tb-debit]')).toHaveText('1,250.00');
  await expect(bankRow.locator('[data-ledger-tb-credit]')).toHaveText('');
  await expect(bankRow.locator('[data-ledger-tb-balance]')).toHaveText('1,250.00 Dr');
  // The scrolling table is keyboard-reachable and named (WCAG 2.1.1).
  await expect(page.getByRole('region', {name: 'Trial balance table'})).toHaveAttribute('tabindex', '0');
  const revenueRow = page.locator(`[data-ledger-tb-row="${revenue}"]`);
  await expect(revenueRow.locator('[data-ledger-tb-credit]')).toHaveText('1,250.00');
  await expect(revenueRow.locator('[data-ledger-tb-balance]')).toHaveText('1,250.00 Cr');

  // Drafts are excluded AND the exclusion is on screen with its count.
  await expect(page.locator('[data-ledger-trial-balance]')).not.toContainText('9,999.99');
  const drafts = page.locator('[data-ledger-drafts-excluded]');
  await expect(drafts).toContainText('Posted entries only');
  await expect(drafts).toContainText(`${await draftCount(request)} draft`);

  // The zero-balance toggle: hidden by default, reachable by keyboard, and the
  // untouched account appears only once it is ticked.
  await expect(page.locator(`[data-ledger-tb-row="${idle}"]`)).toHaveCount(0);
  await expect(page.locator('[data-ledger-hidden-zero]')).toBeVisible();
  const showZero = page.locator('[data-ledger-show-zero]');
  await showZero.focus();
  await expect(showZero).toBeFocused();
  await page.keyboard.press('Space');
  await expect(page.locator(`[data-ledger-tb-row="${idle}"]`)).toBeVisible();
  // Zero carries no side — a bare 0.00, not "0.00 Dr".
  await expect(page.locator(`[data-ledger-tb-row="${idle}"] [data-ledger-tb-balance]`)).toHaveText('0.00');
  await page.keyboard.press('Space');
  await expect(page.locator(`[data-ledger-tb-row="${idle}"]`)).toHaveCount(0);

  // LIVE: an entry posted from elsewhere lands in the open report — no reload.
  await postEntry(request, {date: '2026-04-01', description: 'Invoice 3', postings: [{accountId: bank, amountMinor: 50000}, {accountId: revenue, amountMinor: -50000}]});
  await expect(bankRow.locator('[data-ledger-tb-debit]')).toHaveText('1,750.00');
  await expect(revenueRow.locator('[data-ledger-tb-credit]')).toHaveText('1,750.00');
  // …and it is STILL balanced, which is the whole point of the assertion.
  await expect(assertion).toHaveAttribute('data-ledger-balanced', 'true');
  await expect(page.locator('[data-ledger-difference]')).toHaveText('0.00');

  // A new DRAFT changes the label, never the figures.
  await createDraft(request, {date: '2026-04-02', description: 'Still not posted', postings: [{accountId: bank, amountMinor: 4242}, {accountId: revenue, amountMinor: -4242}]});
  await expect(drafts).toContainText(`${await draftCount(request)} draft`);
  await expect(bankRow.locator('[data-ledger-tb-debit]')).toHaveText('1,750.00');
});

test('account register: running balance in date order, correct under date-range and cleared-state filters, live on a new entry', {tag: ['@ledger', '@p1']}, async ({page, request}) => {
  const uniq = `${Date.now()}`;
  const bank = await ensureAccount(request, `RG${uniq}:Assets:Bank`, 'asset');
  const equity = await ensureAccount(request, `RG${uniq}:Equity:Opening`, 'equity');
  const expense = await ensureAccount(request, `RG${uniq}:Expenses:Hosting`, 'expense');

  //  Jan 05  +1,000.00 cleared  → 1,000.00
  //  Feb 10    −250.00 pending  →   750.00
  //  Mar 15    +500.00 cleared  → 1,250.00
  //
  // (`reconciled` is deliberately absent: reaching it is locked behind the
  // LGR-11 reconciliation hook, so no API a client can call produces one. The
  // register's reconciled filtering is covered directly against the fold.)
  await postEntry(request, {
    date: '2026-01-05',
    description: 'Opening float',
    postings: [
      {accountId: bank, amountMinor: 100000, cleared: 'cleared'},
      {accountId: equity, amountMinor: -100000},
    ],
  });
  await postEntry(request, {date: '2026-02-10', description: 'Hosting bill', postings: [{accountId: bank, amountMinor: -25000}, {accountId: expense, amountMinor: 25000}]});
  const march = await postEntry(request, {
    date: '2026-03-15',
    description: 'Customer payment',
    postings: [
      {accountId: bank, amountMinor: 50000, cleared: 'cleared'},
      {accountId: equity, amountMinor: -50000},
    ],
  });
  await createDraft(request, {date: '2026-03-20', description: 'Register draft', postings: [{accountId: bank, amountMinor: 888888}, {accountId: equity, amountMinor: -888888}]});

  await ensureLedgerPlugin(page);
  await pageWithBlock(page, request, `Register ${uniq}`, '/register', 'Account register', '[data-ledger-register]');

  // Nothing picked yet: a useful next step, not a blank grid.
  await expect(page.locator('[data-ledger-empty]')).toContainText('Pick an account');

  await page.locator('[data-ledger-register-account]').selectOption({label: `RG${uniq}:Assets:Bank`});
  const rows = page.locator('[data-ledger-register-row]');
  await expect(rows).toHaveCount(3);
  // One notation across both blocks: magnitude + side, never a bare minus sign.
  await expect(rows.locator('[data-ledger-amount]')).toHaveText(['1,000.00 Dr', '250.00 Cr', '500.00 Dr']);
  await expect(rows.locator('[data-ledger-running]')).toHaveText(['1,000.00 Dr', '750.00 Dr', '1,250.00 Dr']);
  await expect(page.locator('[data-ledger-closing]')).toHaveText('1,250.00 Dr');
  await expect(page.locator('[data-ledger-opening-balance]')).toHaveText('0.00');
  // Date order, the contra side named, and the entry number carried through.
  await expect(rows.nth(0)).toContainText('2026-01-05');
  await expect(rows.nth(0).locator('[data-ledger-contra]')).toHaveText(`RG${uniq}:Equity:Opening`);
  await expect(rows.nth(1).locator('[data-ledger-contra]')).toHaveText(`RG${uniq}:Expenses:Hosting`);
  await expect(rows.nth(2)).toContainText(`#${march.entryNo}`);
  // The draft is excluded and said to be excluded.
  await expect(page.locator('[data-ledger-register]')).not.toContainText('8,888.88');
  await expect(page.locator('[data-ledger-drafts-excluded]')).toContainText('Posted entries only');
  await expect(page.locator('[data-ledger-drafts-excluded]')).toContainText('draft entr');
  // Unfiltered, the register closes on the account's own balance — so no
  // "this is a filtered view" caveat is shown.
  await expect(page.locator('[data-ledger-filtered-balance]')).toHaveCount(0);

  // DATE RANGE: February only. The January posting is not dropped — it becomes
  // the opening balance, so the running balance stays true.
  await page.locator('[data-ledger-from]').fill('2026-02-01');
  await page.locator('[data-ledger-to]').fill('2026-02-28');
  await expect(rows).toHaveCount(1);
  await expect(page.locator('[data-ledger-opening-balance]')).toHaveText('1,000.00 Dr');
  await expect(rows.locator('[data-ledger-running]')).toHaveText(['750.00 Dr']);
  await expect(page.locator('[data-ledger-closing]')).toHaveText('750.00 Dr');
  // …and the report says plainly that this is not the account's real balance.
  await expect(page.locator('[data-ledger-filtered-balance]')).toContainText('1,250.00 Dr');
  await expect(page.locator('[data-ledger-register-summary]')).toContainText('2026-02-01 → 2026-02-28');

  await page.locator('[data-ledger-clear-filters]').click();
  await expect(rows).toHaveCount(3);
  await expect(page.locator('[data-ledger-closing]')).toHaveText('1,250.00 Dr');

  // CLEARED STATE: drop `pending` (keyboard-reachable checkbox) → the February
  // bill leaves both the rows and the running balance; a "what has settled"
  // view of the same account.
  const pending = page.locator('[data-ledger-cleared="pending"]');
  await pending.focus();
  await expect(pending).toBeFocused();
  await page.keyboard.press('Space');
  await expect(rows).toHaveCount(2);
  await expect(rows.locator('[data-ledger-running]')).toHaveText(['1,000.00 Dr', '1,500.00 Dr']);
  await expect(page.locator('[data-ledger-closing]')).toHaveText('1,500.00 Dr');
  // Display labels in user copy, never the raw enum ids.
  await expect(page.locator('[data-ledger-register-summary]')).toContainText('Cleared, Reconciled');
  await expect(page.locator('[data-ledger-filtered-balance]')).toContainText('1,250.00 Dr');

  // Dropping `reconciled` too leaves `cleared` alone — and that last box is
  // disabled, because an all-unticked filter would show everything and read as
  // a broken control.
  await page.locator('[data-ledger-cleared="reconciled"]').click();
  await expect(rows).toHaveCount(2);
  await expect(page.locator('[data-ledger-register-summary]')).toContainText('· Cleared ·');
  await expect(page.locator('[data-ledger-cleared="cleared"]')).toBeDisabled();
  // The constraint is readable without a mouse: persistent copy, not a title.
  await expect(page.locator('[data-ledger-cleared-hint]')).toBeVisible();
  await expect(page.locator('[data-ledger-cleared-hint]')).toHaveText('At least one state must be shown.');

  await page.locator('[data-ledger-clear-filters]').click();
  await expect(rows).toHaveCount(3);
  await expect(page.locator('[data-ledger-cleared="cleared"]')).toBeEnabled();

  // LIVE: a new entry posted from elsewhere appends to the open register with a
  // correct running balance — no reload.
  await postEntry(request, {date: '2026-04-01', description: 'Interest', postings: [{accountId: bank, amountMinor: 10000, cleared: 'cleared'}, {accountId: equity, amountMinor: -10000}]});
  await expect(rows).toHaveCount(4);
  await expect(rows.nth(3)).toContainText('Interest');
  await expect(rows.locator('[data-ledger-running]')).toHaveText(['1,000.00 Dr', '750.00 Dr', '1,250.00 Dr', '1,350.00 Dr']);
  await expect(page.locator('[data-ledger-closing]')).toHaveText('1,350.00 Dr');

  // The register's own closing figure still agrees with the trial balance's
  // figure for this account (the server's posted balance).
  const transactions = (await (await request.get(`${SERVER}/api/ledger/transactions?limit=1000`)).json()) as ApiTransaction[];
  const postedTx = transactions.filter((t) => t.state === 'posted' || t.state === 'void');
  // No arithmetic on money in the spec: assert the exact integer minor units
  // the server holds for this account (compared as strings, so the check itself
  // never adds or subtracts an amount) — the register's rendered closing balance
  // above is the figure they must fold to.
  const bankAmounts = postedTx
    .flatMap((t) => t.postings)
    .filter((p) => p.accountId === bank)
    .map((p) => String(p.amountMinor))
    .sort();
  expect(bankAmounts).toEqual(['-25000', '10000', '100000', '50000'].sort());

  // NARROW WIDTHS (LGR-23 F6): both edges are pinned at desktop width — the
  // Correct column left, the Balance right — but below the pins' combined
  // budget the right pin painted OVER the Correct button (fully hidden at a
  // 420px viewport). The Balance yields there and scrolls again; Correct keeps
  // its pin and must be genuinely hittable, which the trial click proves — a
  // covered control fails Playwright's actionability check.
  await expect(rows.first().locator('[data-ledger-running]')).toHaveCSS('position', 'sticky');
  await page.setViewportSize({width: 420, height: 900});
  await expect(rows.first().locator('[data-ledger-running]')).toHaveCSS('position', 'static');
  const firstCorrect = page.locator('[data-ledger-correct]').first();
  await expect(firstCorrect).toBeVisible();
  await firstCorrect.click({trial: true});
});


test('a damaged book raises the alarm, names the entries responsible, and marks the deleted account', {tag: ['@ledger', '@p1']}, async ({page, request}) => {
  const uniq = `${Date.now()}`;
  const bank = await ensureAccount(request, `DM${uniq}:Assets:Bank`, 'asset');
  const revenue = await ensureAccount(request, `DM${uniq}:Income:Sales`, 'revenue');

  // Two entries have lost a posting, and one posting references an account that
  // no longer exists — the shapes a damaged/edited ledger table leaves behind.
  await serveTransactions(page, [
    posted({id: 'tx1', entryNo: 42, date: '2026-03-04', description: 'Invoice 0041', postings: [posting('p1', bank, 25000)]}),
    posted({id: 'tx2', entryNo: 43, date: '2026-03-05', description: 'Intact', postings: [posting('p2', bank, 1000), posting('p3', revenue, -1000)]}),
    posted({id: 'tx3', entryNo: 51, date: '2026-04-09', description: 'Sale 12', postings: [posting('p4', revenue, -900)]}),
    posted({id: 'tx4', entryNo: 60, date: '2026-04-10', description: 'Ghost', postings: [posting('p5', 'acc_deleted', 700), posting('p6', revenue, -700)]}),
  ]);

  await ensureLedgerPlugin(page);
  await pageWithBlock(page, request, `Damaged ${uniq}`, '/trial', 'Trial balance', '[data-ledger-trial-balance]');

  // THE alarm — loud, specific, and about the DATA, not the UI.
  const assertion = page.locator('[data-ledger-assertion]');
  await expect(assertion).toHaveAttribute('data-ledger-balanced', 'false');
  await expect(assertion).toContainText('THE BOOKS DO NOT BALANCE');
  await expect(assertion).toContainText('debits exceed credits by 241.00');
  // …and the next step: WHICH entries, by name, not a prohibition.
  const culprits = page.locator('[data-ledger-culprits]');
  await expect(culprits).toContainText('Entry #42 (2026-03-04 \u201CInvoice 0041\u201D) is out by 250.00 Dr');
  await expect(culprits).toContainText('Entry #51 (2026-04-09 \u201CSale 12\u201D) is out by 9.00 Cr');
  // The footer difference speaks the column's grammar, not a bare signed number.
  await expect(page.locator('[data-ledger-difference]')).toHaveText('241.00 Dr');

  // The deleted account is named as a finding and NOT flagged abnormal (its
  // type is unknowable, so it has no normal side to be abnormal against).
  const ghostRow = page.locator('[data-ledger-tb-row="acc_deleted"]');
  await expect(ghostRow).toContainText('Deleted account (acc_deleted)');
  await expect(ghostRow).toHaveAttribute('data-ledger-unknown-account', 'true');
  await expect(ghostRow.locator('[data-ledger-abnormal]')).toHaveCount(0);
  // Its balance is shown as the debit it is, not projected onto a normal side
  // the report cannot know (which rendered a 7.00 debit as “-7.00 Cr”).
  await expect(ghostRow.locator('[data-ledger-tb-balance]')).toContainText('7.00 Dr');
  // Its explanation sits ABOVE the table it explains, on the info tone — a
  // standing caveat, not a second copy of the catastrophic alarm.
  const notice = page.locator('[data-ledger-unknown-accounts]');
  await expect(notice).toBeVisible();
  await expect(notice).toContainText('deleted while postings still referenced it');
  // One deleted account has ONE balance — the singular branch is the one this
  // book takes, and it must read like a sentence.
  await expect(notice).toContainText('Its balance is listed below');

  // The OTHER failure the reports distinguish: the fold itself cannot total the
  // book, because a stored amount is not an integer of minor units. The server
  // rejects such an amount, but the interception above is already past the
  // server — so this branch is reachable, and rendering it is what proves the
  // two failures do not offer the same affordance. Retrying re-reads the same
  // damaged entry, so there must be NO Retry here.
  await serveTransactions(page, [posted({id: 'tx5', entryNo: 70, description: 'Fractional', postings: [posting('p7', bank, 12.5), posting('p8', revenue, -12.5)]})]);
  await pageWithBlock(page, request, `Damaged fold ${uniq}`, '/trial', 'Trial balance', '[data-ledger-trial-balance]');

  const foldError = page.locator('[data-ledger-error="fold"]');
  await expect(foldError).toBeVisible();
  await expect(foldError).toContainText('could not be computed');
  await expect(foldError).toContainText('The book has a damaged entry.');
  await expect(foldError.locator('[data-ledger-retry]')).toHaveCount(0);
  // …and the report does not also claim a balance it never computed.
  await expect(page.locator('[data-ledger-assertion]')).toHaveCount(0);
});

test('an overdrawn asset is marked abnormal, out of the numeric column, with a legend', {tag: ['@ledger']}, async ({page, request}) => {
  const uniq = `${Date.now()}`;
  const bank = await ensureAccount(request, `AB${uniq}:Assets:Bank`, 'asset');
  const equity = await ensureAccount(request, `AB${uniq}:Equity:Opening`, 'equity');

  // A real, server-producible book: the asset account ends on the credit side.
  await postEntry(request, {
    date: '2026-05-01',
    description: 'Overdraft',
    postings: [
      {accountId: bank, amountMinor: -75000},
      {accountId: equity, amountMinor: 75000},
    ],
  });

  await ensureLedgerPlugin(page);
  await pageWithBlock(page, request, `Abnormal ${uniq}`, '/trial', 'Trial balance', '[data-ledger-trial-balance]');

  const row = page.locator(`[data-ledger-tb-row="${bank}"]`);
  const balance = row.locator('[data-ledger-tb-balance]');
  await expect(balance).toHaveAttribute('data-ledger-abnormal', 'true');
  // The side it is actually on, not a negative on the side it is not.
  await expect(balance).toContainText('750.00 Cr');
  // The mark carries real text for assistive tech, not a mouse-only tooltip…
  await expect(balance).toContainText('Abnormal: this asset balance sits on the credit side.');
  // …and the glyph is explained in words rather than left to be guessed.
  await expect(page.locator('[data-ledger-abnormal-legend]')).toContainText('opposite side to the account type');
  // The books still balance — an abnormal balance is not a broken book.
  await expect(page.locator('[data-ledger-assertion]')).toHaveAttribute('data-ledger-balanced', 'true');
});

test('a truncated read says so on the INFO tone, and each report says what truncation costs it', {tag: ['@ledger']}, async ({page, request}) => {
  const uniq = `${Date.now()}`;
  const bank = await ensureAccount(request, `TR${uniq}:Assets:Bank`, 'asset');
  const revenue = await ensureAccount(request, `TR${uniq}:Income:Sales`, 'revenue');

  // Exactly a full page: the report cannot tell this from "there is more".
  const full = Array.from({length: 1000}, (_, i) =>
    posted({
      id: `tx${i}`,
      entryNo: i + 1,
      date: '2026-02-02',
      description: `Entry ${i}`,
      postings: [posting(`pa${i}`, bank, 100), posting(`pb${i}`, revenue, -100)],
    }),
  );
  await serveTransactions(page, full);

  await ensureLedgerPlugin(page);
  await pageWithBlock(page, request, `Truncated ${uniq}`, '/trial', 'Trial balance', '[data-ledger-trial-balance]');

  const notice = page.locator('[data-ledger-truncated]');
  await expect(notice).toBeVisible();
  await expect(notice).toContainText('Partial read');
  // "most recently ENTERED", not "most recent" — the server orders by entry
  // time, so a book with backdated entries is not ordered by date.
  await expect(notice).toContainText('most recently ENTERED');
  // INFO, not alarm: a standing caveat must not wear the colour reserved for
  // "the books are broken", or the real alarm arrives pre-ignored.
  await expect(notice).not.toHaveCSS('font-weight', '600');
  // The caption no longer claims completeness the notice just denied.
  await expect(page.locator('[data-ledger-trial-balance] caption')).toContainText('NOT the whole book');

  // The register's cost is worse than a missing total and is stated as such.
  await pageWithBlock(page, request, `Truncated register ${uniq}`, '/register', 'Account register', '[data-ledger-register]');
  await page.locator('[data-ledger-register-account]').selectOption({label: `TR${uniq}:Assets:Bank`});
  await expect(page.locator('[data-ledger-truncated]')).toContainText('EVERY running balance below is understated');
});
