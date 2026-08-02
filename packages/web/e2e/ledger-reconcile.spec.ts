import {test, expect} from './fixtures';
import {SERVER} from './seed';
import {ensureLedgerPlugin} from './ledgerPlugin';
import {createDraft, ensureAccount, pageWithBlock, postEntry} from './ledgerApi';
import type {Page} from '@playwright/test';

/**
 * LGR-11: statement reconciliation, end to end — the REAL first-party plugin
 * from examples/plugins/ledger (zipped from disk, installed through Settings →
 * Extensions), driving the REAL ledger server.
 *
 * THE SPEC'S CANONICAL TEST is the first one: three months of bank activity
 * containing TWO MISSING ENTRIES and ONE DUPLICATE, reconciled to a 0.00
 * difference THROUGH THE UI ALONE. The fixture is arranged so all three
 * discrepancies must actually be found — no pair of them cancels, and no single
 * correction reaches zero — because a reconciliation fixture that can be
 * satisfied by accident tests nothing at all.
 *
 * The second test pins the gate from the other side: the store refuses a
 * nonzero finish even when the UI is bypassed entirely, so the disabled button
 * is an explanation rather than the enforcement.
 */

// ── The fixture, in signed integer minor units (debit-positive) ───────────────
//
// THE BOOKS hold nine posted entries. THE STATEMENT (5,134.50 at 2026-03-31)
// reflects the truth: it does NOT include the doubled rent, and it DOES include
// two entries nobody ever recorded.
//
//   books, all nine ticked                                        3,714.50
//   …untick the duplicated rent (+950.00 back)                    4,664.50
//   …add + tick the missing insurance (−180.00) and payment (+650.00)
//                                                                 5,134.50  ✓
//
// Each step is needed and none is sufficient: after only the duplicate is
// unticked the difference is 470.00 Dr, and after only the two additions it is
// 950.00 Dr (513,450 − 418,450) — a reader cannot stumble into zero.
const BOOKED: Array<{date: string; description: string; amountMinor: number}> = [
  {date: '2026-01-05', description: 'Opening float', amountMinor: 300_000},
  {date: '2026-01-12', description: 'Hosting bill', amountMinor: -12_000},
  {date: '2026-01-28', description: 'Customer payment — Jan', amountMinor: 150_000},
  {date: '2026-02-03', description: 'Coffee supplies', amountMinor: -4_550},
  {date: '2026-02-14', description: 'Customer payment — Feb', amountMinor: 87_500},
  {date: '2026-02-20', description: 'Rent — February', amountMinor: -95_000},
  // THE DUPLICATE: the same rent payment, entered twice. The bank charged it
  // once, so ticking both is what puts the reconciliation out.
  {date: '2026-02-20', description: 'Rent — February', amountMinor: -95_000},
  {date: '2026-03-02', description: 'Bank fee', amountMinor: -1_500},
  {date: '2026-03-18', description: 'Customer payment — Mar', amountMinor: 42_000},
];

/** The two statement lines that never reached the books. Typed in by hand. */
const MISSING = [
  {date: '2026-02-27', description: 'Insurance premium', credit: '180.00', category: 'Expenses'},
  {date: '2026-03-25', description: 'Customer payment — late Mar', debit: '650.00', category: 'Income'},
];

/** The bank's closing balance on 2026-03-31, as printed on the statement. */
const STATEMENT_BALANCE = '5,134.50';

const journalRow = (page: Page, n: number) => ({
  account: page.getByLabel(`Row ${n} account`),
  debit: page.getByLabel(`Row ${n} debit`),
  credit: page.getByLabel(`Row ${n} credit`),
});

test('the canonical reconciliation: 3 months with 2 missing entries and 1 duplicate, matched to 0.00 through the UI alone', {tag: ['@ledger', '@p1']}, async ({page, request}) => {
  const uniq = `${Date.now()}`;
  const bankName = `RC${uniq}:Assets:Bank`;
  const incomeName = `RC${uniq}:Income:Revenue`;
  const expenseName = `RC${uniq}:Expenses:General`;
  const bank = await ensureAccount(request, bankName, 'asset');
  const income = await ensureAccount(request, incomeName, 'revenue');
  const expense = await ensureAccount(request, expenseName, 'expense');

  for (const item of BOOKED) {
    await postEntry(request, {
      date: item.date,
      description: item.description,
      postings: [
        {accountId: bank, amountMinor: item.amountMinor},
        {accountId: item.amountMinor > 0 ? income : expense, amountMinor: -item.amountMinor},
      ],
    });
  }
  // A draft touching the same account: never on a statement, never in the
  // checklist, and SAID to be excluded.
  await createDraft(request, {
    date: '2026-03-30',
    description: 'Unposted guess',
    postings: [{accountId: bank, amountMinor: 777_777}, {accountId: income, amountMinor: -777_777}],
  });

  await ensureLedgerPlugin(page);
  const reconcilePage = await pageWithBlock(page, request, `Reconcile ${uniq}`, '/reconcile', 'Reconcile', '[data-ledger-reconcile]');

  // ── Start: account, statement date, closing balance ────────────────────────
  const start = page.locator('[data-ledger-reconcile-start]');
  // Nothing chosen yet: the Start control is closed AND says why, rather than
  // sitting greyed out with the reason in a tooltip.
  await expect(start).toBeDisabled();
  await expect(page.locator('[data-ledger-start-hint]')).toContainText('Pick the account');

  await page.locator('[data-ledger-reconcile-account]').selectOption({label: bankName});
  await expect(page.locator('[data-ledger-start-hint]')).toContainText('date the statement closes');
  await page.locator('[data-ledger-statement-date]').fill('2026-03-31');
  await expect(page.locator('[data-ledger-start-hint]')).toContainText('closing balance');
  // THE LABEL IS THE INSTRUCTION (LGR-22). It used to read "Closing balance
  // (debit-normal account)" — a true property of the account, and useless at
  // the moment of typing. It now says what to type, before anything is typed.
  await expect(page.getByText('Closing balance — as the statement prints it (a positive number is money in the account)')).toBeVisible();
  await expect(page.locator('[data-ledger-reconcile]')).not.toContainText('-normal account');
  await page.locator('[data-ledger-statement-balance-input]').fill(STATEMENT_BALANCE);
  // …and it echoes the MEANING before anything is committed. Reprinting the
  // digits would be a round-trip identity, silent about the side — which is the
  // one thing the user can get wrong, at a cost of twice the balance.
  await expect(page.locator('[data-ledger-balance-echo]')).toHaveText(`Reading it as ${STATEMENT_BALANCE} in the account.`);
  await expect(start).toBeEnabled();
  await start.click();

  // ── The checklist ─────────────────────────────────────────────────────────
  const rows = page.locator('[data-ledger-reconcile-row]');
  await expect(rows).toHaveCount(BOOKED.length);
  const difference = page.locator('[data-ledger-difference]');
  const finish = page.locator('[data-ledger-finish]');
  // The live region is polite, never an alert: this line changes on every tick.
  await expect(difference).toHaveAttribute('aria-live', 'polite');
  await expect(difference).toHaveAttribute('role', 'status');
  // Nothing ticked: the whole statement is still to explain.
  await expect(page.locator('[data-ledger-statement-balance]')).toHaveText(new RegExp(STATEMENT_BALANCE.replace('.', '\\.')));
  await expect(page.locator('[data-ledger-difference-amount]')).toHaveText('5,134.50 Dr');
  await expect(finish).toBeDisabled();
  // The draft is excluded and the exclusion is on screen.
  await expect(page.locator('[data-ledger-drafts-excluded]')).toContainText('Posted entries only');
  await expect(page.locator('[data-ledger-reconcile]')).not.toContainText('7,777.77');

  // Tick EVERY posting the books hold — the naive first pass.
  for (const row of await rows.all()) {
    await row.locator('input[type="checkbox"]').check();
  }
  await expect(page.locator('[data-ledger-cleared-balance]')).toHaveText('3,714.50');
  // Out by 1,420.00 — and the readout names which way to look.
  await expect(page.locator('[data-ledger-difference-amount]')).toHaveText('1,420.00 Dr');
  await expect(difference).toHaveAttribute('data-ledger-balanced', 'false');
  const gap = page.locator('[data-ledger-gap]');
  await expect(gap).toContainText('statement is 1,420.00 ahead');
  // BOTH causes, not one per direction: this very fixture's difference is
  // caused by a ticked duplicate, so advice that only names a missing entry
  // would send the reader after a receipt that does not exist.
  await expect(gap).toContainText('missing from the books');
  await expect(gap).toContainText('recorded twice on the other side');
  // Everything is ticked, so it must NOT suggest an unticked row — the footer
  // on this very screen reads "nothing unmatched".
  await expect(page.locator('[data-ledger-reconcile-summary]')).toContainText('nothing unmatched');
  await expect(gap).not.toContainText('not ticked yet');
  // No SINGLE posting accounts for 1,420.00, so the instrument says nothing —
  // an approximate suggestion here would be worse than silence.
  await expect(page.locator('[data-ledger-single-culprit]')).toHaveCount(0);
  // The guidance sits OUTSIDE the live region, so ticking does not re-announce
  // forty words of unchanged prose.
  await expect(difference.locator('[data-ledger-gap]')).toHaveCount(0);
  await expect(finish).toBeDisabled();
  const finishHint = page.locator('[data-ledger-finish-hint]');
  await expect(finishHint).toContainText('exactly 0.00');
  // The reason names the live difference and is wired to the control it is
  // about — a disabled button cannot be focused, so this is the only route to
  // it for a keyboard or screen-reader user. The figure is in the accessible
  // description but NOT printed again on screen.
  await expect(finishHint).toContainText('It is 1,420.00 Dr now.');
  await expect(finishHint.locator('span').filter({hasText: 'It is 1,420.00 Dr now.'})).toHaveCSS('clip', 'rect(0px, 0px, 0px, 0px)');
  await expect(finish).toHaveAttribute('aria-describedby', await finishHint.getAttribute('id') ?? '');
  // A disabled control must LOOK disabled: `buttonStyle` sets colour inline and
  // beat the UA rule, leaving the dead button pixel-identical to the live one.
  const deadColor = await finish.evaluate((el) => getComputedStyle(el).color);
  await expect(finish).toHaveCSS('cursor', 'not-allowed');

  // ── Discrepancy 1: the DUPLICATE ──────────────────────────────────────────
  // Two identical rent rows on 2026-02-20; the bank charged it once. Untick one.
  const rentRows = page.locator('[data-ledger-reconcile-row]', {hasText: 'Rent — February'});
  await expect(rentRows).toHaveCount(2);
  await rentRows.nth(1).locator('input[type="checkbox"]').uncheck();
  await expect(page.locator('[data-ledger-cleared-balance]')).toHaveText('4,664.50');
  await expect(page.locator('[data-ledger-difference-amount]')).toHaveText('470.00 Dr');
  await expect(finish).toBeDisabled();
  // …and the footer says plainly what is deliberately not ticked.
  await expect(page.locator('[data-ledger-reconcile-summary]')).toContainText('1 unmatched (950.00 Cr)');
  // Every row is distinguishable to a screen reader — including the two halves
  // of the duplicate, which is the one distinction this workflow turns on.
  const labels = await rows.locator('input[type="checkbox"]').evaluateAll((els) => els.map((el) => el.getAttribute('aria-label')));
  expect(new Set(labels).size).toBe(labels.length);
  expect(labels.filter((l) => l?.includes('Rent — February'))).toHaveLength(2);
  for (const label of labels.filter((l) => l?.includes('Rent — February'))) expect(label).toContain('950.00 Cr');

  // ── Discrepancies 2 and 3: the two MISSING entries ────────────────────────
  // Neither is in the books at all, so they are entered the only way the books
  // accept human entries: the journal block (LGR-5).
  await pageWithBlock(page, request, `Journal ${uniq}`, '/journal', 'Journal entry', '[data-ledger-journal]');
  for (const item of MISSING) {
    await page.locator('[data-ledger-description]').fill(item.description);
    await page.locator('[data-ledger-date]').fill(item.date);
    await journalRow(page, 1).account.selectOption({label: bankName});
    if (item.debit !== undefined) await journalRow(page, 1).debit.fill(item.debit);
    else await journalRow(page, 1).credit.fill(item.credit!);
    await journalRow(page, 2).account.selectOption({label: item.category === 'Income' ? incomeName : expenseName});
    if (item.debit !== undefined) await journalRow(page, 2).credit.fill(item.debit);
    else await journalRow(page, 2).debit.fill(item.credit!);
    const post = page.locator('[data-ledger-post]');
    await expect(post).toBeEnabled();
    await post.click();
    await expect(page.locator('[data-ledger-posted]')).toBeVisible();
  }

  // Back to the reconciliation — which RESUMES from the block's own props
  // across a full page load, rather than starting over.
  await page.goto(`/?page=${reconcilePage}`);
  await expect(page.locator('[data-ledger-arithmetic]')).toBeVisible();
  await expect(rows).toHaveCount(BOOKED.length + MISSING.length);
  // The two new entries arrive UNTICKED (they are not on the statement until a
  // human says so) so the difference has not moved.
  await expect(page.locator('[data-ledger-difference-amount]')).toHaveText('470.00 Dr');

  for (const item of MISSING) {
    await page.locator('[data-ledger-reconcile-row]', {hasText: item.description}).locator('input[type="checkbox"]').check();
  }

  // ── 0.00 ──────────────────────────────────────────────────────────────────
  await expect(page.locator('[data-ledger-cleared-balance]')).toHaveText(STATEMENT_BALANCE);
  await expect(page.locator('[data-ledger-difference-amount]')).toHaveText('0.00');
  await expect(difference).toHaveAttribute('data-ledger-balanced', 'true');
  // It claims only what it can prove — the STATEMENT is explained, not the books.
  await expect(page.locator('[data-ledger-difference-text]')).toContainText('this statement is fully explained');
  await expect(page.locator('[data-ledger-difference-text]')).not.toContainText('nothing left to explain');
  await expect(gap).toHaveCount(0);
  // …and the duplicate left on the books is stated as UNRESOLVED, not merely
  // excluded, right where the completeness claim is made.
  const caveat = page.locator('[data-ledger-unmatched-caveat]');
  await expect(caveat).toContainText('1 posting totalling 950.00 Cr is on the books but not on this statement');
  // BOTH readings, named — the innocent one (not cleared yet) and the one this
  // fixture actually holds (recorded twice). Naming only one sends half the
  // readers to the wrong place at the moment the books are being certified.
  await expect(caveat).toContainText('not cleared the bank yet that is expected');
  await expect(caveat).toContainText('recorded twice, this account is still out by 950.00');
  await expect(finish).toBeEnabled();
  await expect(page.locator('[data-ledger-finish-hint]')).toHaveCount(0);
  // The live button is visually distinct from the dead one it replaced.
  expect(await finish.evaluate((el) => getComputedStyle(el).color)).not.toBe(deadColor);
  await expect(finish).toHaveCSS('cursor', 'pointer');

  // A PROBE, because this is the case the guidance sentence exists for: re-tick
  // the duplicate by mistake and the screen names the exact row to undo, rather
  // than sending the reader after a receipt that does not exist.
  await rentRows.nth(1).locator('input[type="checkbox"]').check();
  await expect(page.locator('[data-ledger-difference-amount]')).toHaveText('950.00 Dr');
  const culprit = page.locator('[data-ledger-single-culprit]');
  await expect(culprit).toContainText('Unticking either of two identical postings would close this exactly');
  await expect(culprit).toContainText('Rent — February');
  await expect(culprit).toContainText('950.00 Cr');
  await rentRows.nth(1).locator('input[type="checkbox"]').uncheck();
  await expect(page.locator('[data-ledger-difference-amount]')).toHaveText('0.00');

  // FINISHING WITH SOMETHING UNACCOUNTED FOR ASKS FIRST (LGR-22). A step, not a
  // gate: the confirm names the amount and both readings, and "Finish anyway"
  // is right there. "Go back and check" returns without finishing, which is
  // what makes it a real choice rather than a speed bump.
  await finish.click();
  const confirm = page.locator('[data-ledger-finish-confirm]');
  await expect(confirm).toContainText('1 posting totalling 950.00 Cr');
  await expect(confirm).toContainText('not cleared the bank yet that is expected');
  await expect(confirm).toContainText('recorded twice');
  await expect(page.locator('[data-ledger-reconcile]')).toHaveAttribute('data-ledger-reconcile-status', 'open');
  // Focus moves to the confirm's primary — a real browser is the environment
  // where the alternative (focus dumped on <body>) actually happens, so the
  // after-press focus target is asserted HERE as well as in the unit tests.
  await expect(page.locator('[data-ledger-finish-confirm-yes]')).toBeFocused();
  // THE DOUBLE PRESS. The second click of a habitual double-click lands on the
  // still-enabled Finish button — it must NOT certify the books with the
  // confirm unread. This is the press that used to finish for real.
  await finish.click();
  await expect(confirm).toBeVisible();
  await expect(page.locator('[data-ledger-reconcile]')).toHaveAttribute('data-ledger-reconcile-status', 'open');
  await page.locator('[data-ledger-finish-confirm-no]').click();
  await expect(confirm).toHaveCount(0);
  await expect(page.locator('[data-ledger-reconcile]')).toHaveAttribute('data-ledger-reconcile-status', 'open');
  // Declining hands focus back to the Finish button it took it from.
  await expect(finish).toBeFocused();

  await finish.click();
  await page.locator('[data-ledger-finish-confirm-yes]').click();
  await expect(page.locator('[data-ledger-reconcile]')).toHaveAttribute('data-ledger-reconcile-status', 'finished');
  await expect(page.locator('[data-ledger-reopen]')).toBeVisible();
  await expect(finish).toHaveCount(0);
  // SUCCESS FOCUS: the pressed button ("Finish anyway") unmounted with the
  // status change, so focus targets the one control every status renders. This
  // is the only place the unmount premise is real — a unit render never races
  // the reloaded status — so it is pinned here, in the browser.
  await expect(page.locator('[data-ledger-reconcile-close]')).toBeFocused();
  // Every matched row is frozen — the ticks cannot be undone by a stray click.
  await expect(rows.locator('input[type="checkbox"]:checked')).toHaveCount(BOOKED.length + MISSING.length - 1);
  for (const box of await rows.locator('input[type="checkbox"]').all()) {
    await expect(box).toBeDisabled();
  }
  // …and what the statement did NOT account for is promoted from a grey count
  // in a footer to a named section that lists the actual rows (LGR-22). After
  // finishing, the leftovers stop being a live figure and become a to-do.
  const outstanding = page.locator('[data-ledger-outstanding]');
  await expect(page.locator('[data-ledger-outstanding-heading]')).toHaveText('Outstanding items (1 · 950.00 Cr)');
  await expect(outstanding.locator('[data-ledger-outstanding-row]')).toHaveCount(1);
  await expect(outstanding).toContainText('Rent — February');
  await expect(outstanding).toContainText('950.00 Cr');
  // The heading's count and the list's length are the same fact; a section that
  // said "1" over two rows would be the two-places-one-fact bug in the open.
  await expect(page.locator('[data-ledger-outstanding="1"]')).toBeVisible();

  // The server agrees, and it is the server that decides.
  const reconciliations = (await (await request.get(`${SERVER}/api/ledger/reconciliations?accountId=${bank}`)).json()) as Array<{
    id: string;
    status: string;
    statementBalanceMinor: number;
  }>;
  expect(reconciliations).toHaveLength(1);
  expect(reconciliations[0].status).toBe('finished');
  expect(reconciliations[0].statementBalanceMinor).toBe(513_450);
  const summary = (await (await request.get(`${SERVER}/api/ledger/reconciliations/${reconciliations[0].id}`)).json()) as {
    differenceMinor: number;
    clearedBalanceMinor: number;
  };
  expect(summary.differenceMinor).toBe(0);
  expect(summary.clearedBalanceMinor).toBe(513_450);

  // ── The register shows it ─────────────────────────────────────────────────
  await pageWithBlock(page, request, `Register ${uniq}`, '/register', 'Account register', '[data-ledger-register]');
  await page.locator('[data-ledger-register-account]').selectOption({label: bankName});
  const registerRows = page.locator('[data-ledger-register-row]');
  await expect(registerRows).toHaveCount(BOOKED.length + MISSING.length);
  // Ten reconciled legs, each naming the statement it was matched to — a
  // frozen posting whose statement cannot be named is an assurance with no
  // evidence behind it.
  const reconciledCells = page.locator('[data-ledger-cleared-cell="reconciled"]');
  await expect(reconciledCells).toHaveCount(BOOKED.length + MISSING.length - 1);
  await expect(reconciledCells.first()).toContainText('Reconciled');
  await expect(page.locator('[data-ledger-reconciled-statement="2026-03-31"]').first()).toBeVisible();
  // The duplicate is still on the books, still unreconciled, and visible as
  // such — reconciling did not quietly make it go away.
  await expect(page.locator('[data-ledger-cleared-cell="pending"]')).toHaveCount(1);
});

test('Finish is impossible while the difference is not zero — the UI says so, and the server enforces it', {tag: ['@ledger', '@p1']}, async ({page, request}) => {
  const uniq = `${Date.now()}`;
  const bankName = `RG${uniq}:Assets:Bank`;
  const bank = await ensureAccount(request, bankName, 'asset');
  const income = await ensureAccount(request, `RG${uniq}:Income:Revenue`, 'revenue');
  await postEntry(request, {
    date: '2026-04-01',
    description: 'Only entry',
    postings: [{accountId: bank, amountMinor: 100_000}, {accountId: income, amountMinor: -100_000}],
  });

  await ensureLedgerPlugin(page);
  await pageWithBlock(page, request, `Gate ${uniq}`, '/reconcile', 'Reconcile', '[data-ledger-reconcile]');
  await page.locator('[data-ledger-reconcile-account]').selectOption({label: bankName});
  await page.locator('[data-ledger-statement-date]').fill('2026-04-30');
  await page.locator('[data-ledger-statement-balance-input]').fill('1,125.00');
  await page.locator('[data-ledger-reconcile-start]').click();
  await expect(page.locator('[data-ledger-arithmetic]')).toBeVisible();

  // Out by 1,125.00 with nothing ticked; 125.00 with the one entry ticked.
  await expect(page.locator('[data-ledger-finish]')).toBeDisabled();
  await page.locator('[data-ledger-reconcile-row] input[type="checkbox"]').check();
  await expect(page.locator('[data-ledger-difference-amount]')).toHaveText('125.00 Dr');
  await expect(page.locator('[data-ledger-finish]')).toBeDisabled();

  // BYPASS THE UI ENTIRELY. The disabled button is an explanation; the rule
  // lives in the store, so the same finish over raw HTTP is refused with a
  // typed 409 — and the reconciliation is left exactly as it was.
  const [rec] = (await (await request.get(`${SERVER}/api/ledger/reconciliations?accountId=${bank}`)).json()) as Array<{id: string}>;
  const refused = await request.post(`${SERVER}/api/ledger/reconciliations/${rec.id}/finish`);
  expect(refused.status()).toBe(409);
  expect(((await refused.json()) as {code: string}).code).toBe('reconciliation-unbalanced');
  const after = (await (await request.get(`${SERVER}/api/ledger/reconciliations/${rec.id}`)).json()) as {
    reconciliation: {status: string};
    differenceMinor: number;
  };
  expect(after.reconciliation.status).toBe('open');
  expect(after.differenceMinor).toBe(12_500);
  // …and the block still shows an open, unfinished reconciliation.
  await expect(page.locator('[data-ledger-reconcile]')).toHaveAttribute('data-ledger-reconcile-status', 'open');
  await expect(page.locator('[data-ledger-finish]')).toBeDisabled();
});

/**
 * LGR-22 — the recovery path, through the UI alone.
 *
 * THE DEAD END THIS CLOSES: type the closing balance on the wrong side (the
 * single easiest mistake on this screen) and the difference lands at exactly
 * twice the balance. No tick can move it, because the books are already right;
 * Finish needs a zero it can never reach; Reopen applies only to a FINISHED
 * statement; and Start refuses a second open one. Before this the only exits
 * were posting a fake entry to force the difference to zero — corrupting the
 * books to escape a UI dead end — or editing the database by hand.
 */
test('a mistyped closing balance is correctable, and a bad statement abandonable, without posting anything', {tag: ['@ledger', '@p1']}, async ({page, request}) => {
  const uniq = `${Date.now()}`;
  const bankName = `RA${uniq}:Assets:Bank`;
  const bank = await ensureAccount(request, bankName, 'asset');
  const income = await ensureAccount(request, `RA${uniq}:Income:Revenue`, 'revenue');
  await postEntry(request, {
    date: '2026-05-01',
    description: 'Customer payment',
    postings: [{accountId: bank, amountMinor: 100_000}, {accountId: income, amountMinor: -100_000}],
  });
  /** Every posted entry in the book right now — the "nothing was posted" probe. */
  const entryCount = async (): Promise<number> =>
    ((await (await request.get(`${SERVER}/api/ledger/transactions?limit=500`)).json()) as unknown[]).length;
  const before = await entryCount();

  await ensureLedgerPlugin(page);
  await pageWithBlock(page, request, `Amend ${uniq}`, '/reconcile', 'Reconcile', '[data-ledger-reconcile]');
  await page.locator('[data-ledger-reconcile-account]').selectOption({label: bankName});
  await page.locator('[data-ledger-statement-date]').fill('2026-05-31');
  // THE MISTAKE: 1,000.00 in the account, typed as -1,000.00.
  await page.locator('[data-ledger-statement-balance-input]').fill('-1,000.00');
  // The echo names it as overdrawn before anything is committed — the meaning,
  // not the digits, because the digits round-trip and prove nothing.
  await expect(page.locator('[data-ledger-balance-echo]')).toHaveText('Reading it as 1,000.00 overdrawn.');
  await page.locator('[data-ledger-reconcile-start]').click();
  await expect(page.locator('[data-ledger-arithmetic]')).toBeVisible();

  await page.locator('[data-ledger-reconcile-row] input[type="checkbox"]').check();
  // Everything on the account is ticked and it is out by exactly twice — the
  // signature of the wrong side, and the state that used to be terminal.
  await expect(page.locator('[data-ledger-difference-amount]')).toHaveText('2,000.00 Cr');
  await expect(page.locator('[data-ledger-reconcile-summary]')).toContainText('nothing unmatched');
  await expect(page.locator('[data-ledger-finish]')).toBeDisabled();
  const gap = page.locator('[data-ledger-gap]');
  await expect(gap).toContainText('exactly twice the closing balance you typed');
  await expect(gap).toContainText('a positive number is money in the account');
  // It names the control that fixes it rather than sending the reader into
  // books that are already correct.
  await expect(gap).toContainText('Amend statement');
  await expect(gap).not.toContainText('missing from the books');

  // ── AMEND ─────────────────────────────────────────────────────────────────
  await page.locator('[data-ledger-amend]').click();
  const amendBalance = page.locator('[data-ledger-amend-balance]');
  // Prefilled with the value as it stands, in a form its own parser reads back.
  await expect(amendBalance).toHaveValue('-1,000.00');
  await expect(page.locator('[data-ledger-amend-date]')).toHaveValue('2026-05-31');
  // Opening the form DISABLED the invoker — the element that was focused. In a
  // real browser that dumps focus on <body> unless the block moves it, so the
  // after-press target is asserted here, at the transition.
  await expect(page.locator('[data-ledger-amend]')).toBeDisabled();
  await expect(page.locator('[data-ledger-amend-date]')).toBeFocused();
  await amendBalance.fill('1,000.00');
  await expect(page.locator('[data-ledger-amend-echo]')).toHaveText('Reading it as 1,000.00 in the account.');
  await page.locator('[data-ledger-amend-save]').click();
  await expect(page.locator('[data-ledger-amend-form]')).toHaveCount(0);

  // Zero — reached by correcting the TARGET, with the tick untouched.
  await expect(page.locator('[data-ledger-difference-amount]')).toHaveText('0.00');
  await expect(page.locator('[data-ledger-reconcile-row] input[type="checkbox"]')).toBeChecked();
  await expect(page.locator('[data-ledger-finish]')).toBeEnabled();
  // Nothing unaccounted for, so Finish goes straight through — the confirm is
  // for leftovers, not a standing speed bump.
  await page.locator('[data-ledger-finish]').click();
  await expect(page.locator('[data-ledger-reconcile]')).toHaveAttribute('data-ledger-reconcile-status', 'finished');
  await expect(page.locator('[data-ledger-finish-confirm]')).toHaveCount(0);
  await expect(page.locator('[data-ledger-outstanding]')).toHaveCount(0);
  // SUCCESS FOCUS: the Finish button the user pressed has unmounted with the
  // finished status — focus lands on the surviving control, never <body>.
  await expect(page.locator('[data-ledger-reconcile-close]')).toBeFocused();

  // ── ABANDON ───────────────────────────────────────────────────────────────
  // A second statement started on the wrong account balance and given up on.
  await page.locator('[data-ledger-reconcile-close]').click();
  await page.locator('[data-ledger-reconcile-account]').selectOption({label: bankName});
  await page.locator('[data-ledger-statement-date]').fill('2026-06-30');
  await page.locator('[data-ledger-statement-balance-input]').fill('4,242.00');
  await page.locator('[data-ledger-reconcile-start]').click();
  await expect(page.locator('[data-ledger-arithmetic]')).toBeVisible();

  await page.locator('[data-ledger-abandon]').click();
  const abandonConfirm = page.locator('[data-ledger-abandon-confirm]');
  // The confirm states the two guarantees the person deciding cannot read off
  // the store: nothing is posted, and no tick is undone.
  await expect(abandonConfirm).toContainText('nothing is posted to the books');
  await expect(abandonConfirm).toContainText('keeps the cleared state it has now');
  await expect(page.locator('[data-ledger-abandon-confirm-yes]')).toBeFocused();
  await page.locator('[data-ledger-abandon-confirm-no]').click();
  await expect(abandonConfirm).toHaveCount(0);
  await expect(page.locator('[data-ledger-reconcile]')).toHaveAttribute('data-ledger-reconcile-status', 'open');
  // Declining re-enabled the invoker and handed focus back to it — the exit
  // button the user pressed no longer exists, so anywhere else is <body>.
  await expect(page.locator('[data-ledger-abandon]')).toBeFocused();

  await page.locator('[data-ledger-abandon]').click();
  await page.locator('[data-ledger-abandon-confirm-yes]').click();
  await expect(page.locator('[data-ledger-reconcile]')).toHaveAttribute('data-ledger-reconcile-status', 'abandoned');
  // SUCCESS FOCUS: the confirm's own button unmounted with the whole action
  // set when the abandoned status landed — the surviving control takes focus.
  await expect(page.locator('[data-ledger-reconcile-close]')).toBeFocused();
  // Neither Finish nor Reopen — an abandoned statement froze nothing, so there
  // is nothing to release; the screen names the way forward instead.
  await expect(page.locator('[data-ledger-finish]')).toHaveCount(0);
  await expect(page.locator('[data-ledger-reopen]')).toHaveCount(0);
  await expect(page.locator('[data-ledger-finish-hint]')).toContainText('start a new reconciliation');
  // Amend and Abandon are gone too — every write surface on this record is
  // closed. (That the CHECKBOXES are locked is pinned in the fold's unit test,
  // on rows that are not also frozen by an earlier statement; asserting it here
  // would pass on the freeze rather than on the abandonment.)
  await expect(page.locator('[data-ledger-amend]')).toHaveCount(0);
  await expect(page.locator('[data-ledger-abandon]')).toHaveCount(0);

  // THE POINT: the account is reconcilable again, immediately, through the UI.
  await page.locator('[data-ledger-reconcile-close]').click();
  await page.locator('[data-ledger-reconcile-account]').selectOption({label: bankName});
  await page.locator('[data-ledger-statement-date]').fill('2026-06-30');
  await page.locator('[data-ledger-statement-balance-input]').fill('1,000.00');
  await page.locator('[data-ledger-reconcile-start]').click();
  await expect(page.locator('[data-ledger-arithmetic]')).toBeVisible();
  await expect(page.locator('[data-ledger-reconcile]')).toHaveAttribute('data-ledger-reconcile-status', 'open');

  // ── The server agrees, and NOTHING was posted to the books ────────────────
  // The whole point of a recovery path is that it does not require corrupting
  // the ledger to escape a UI dead end, so this is the assertion that matters
  // most: not one entry was created across the amend and the abandon.
  expect(await entryCount()).toBe(before);
  const list = (await (await request.get(`${SERVER}/api/ledger/reconciliations?accountId=${bank}`)).json()) as Array<{
    id: string;
    status: string;
    statementBalanceMinor: number;
  }>;
  expect(list.map((r) => r.status).sort()).toEqual(['abandoned', 'finished', 'open']);
  // The abandoned one is still ON RECORD, not deleted: a reader can tell "someone
  // tried and gave up" from "this account has never been reconciled".
  expect(list.filter((r) => r.status === 'abandoned')).toHaveLength(1);
  // The amend corrected the target rather than leaving a second statement behind.
  expect(list.find((r) => r.status === 'finished')!.statementBalanceMinor).toBe(100_000);
  // …and the postings are exactly where the workflow put them: the one leg is
  // frozen by the finished statement, never touched by the abandon.
  const audit = (await (await request.get(`${SERVER}/api/ledger/audit?limit=200`)).json()) as Array<{action: string}>;
  expect(audit.map((e) => e.action)).toContain('reconciliation.amend');
  expect(audit.map((e) => e.action)).toContain('reconciliation.abandon');
});

/**
 * LGR-23 — the reconcile block on a READ-ONLY page, through the same
 * guest-read intercept the register's read-only spec uses.
 *
 * The custom-block kit deliberately hands an interactive widget a live editor
 * (`readOnly: false`) on a locked page, so a block gating its write controls on
 * `editor.readOnly` renders Finish/Amend/Abandon fully pressable on exactly the
 * page where none of them may do anything — and it TYPECHECKS, because the
 * extra `pageReadOnly` prop is legally ignorable. The sheet here is BALANCED
 * before the lock, so every disabled-assertion below fails if the host stops
 * passing `pageReadOnly` or the block slides back to `editor.readOnly`.
 */
test('on a read-only page the reconcile write surface is inert, with the reason stated — same books, same zero difference', {tag: ['@ledger', '@p1']}, async ({page, request}) => {
  const uniq = `${Date.now()}`;
  const bankName = `RO${uniq}:Assets:Bank`;
  const bank = await ensureAccount(request, bankName, 'asset');
  const income = await ensureAccount(request, `RO${uniq}:Income:Revenue`, 'revenue');
  await postEntry(request, {
    date: '2026-07-01',
    description: 'Only entry',
    postings: [{accountId: bank, amountMinor: 100_000}, {accountId: income, amountMinor: -100_000}],
  });

  await ensureLedgerPlugin(page);
  const pageId = await pageWithBlock(page, request, `Reconcile read only ${uniq}`, '/reconcile', 'Reconcile', '[data-ledger-reconcile]');
  await page.locator('[data-ledger-reconcile-account]').selectOption({label: bankName});
  await page.locator('[data-ledger-statement-date]').fill('2026-07-31');
  await page.locator('[data-ledger-statement-balance-input]').fill('1,000.00');
  await page.locator('[data-ledger-reconcile-start]').click();
  await expect(page.locator('[data-ledger-arithmetic]')).toBeVisible();

  // Tick the one row: the sheet balances, so on this WRITABLE page every write
  // control is live. That is the baseline the lock is measured against.
  await page.locator('[data-ledger-reconcile-row] input[type="checkbox"]').check();
  await expect(page.locator('[data-ledger-difference-amount]')).toHaveText('0.00');
  await expect(page.locator('[data-ledger-finish]')).toBeEnabled();
  await expect(page.locator('[data-ledger-amend]')).toBeEnabled();
  await expect(page.locator('[data-ledger-abandon]')).toBeEnabled();

  // The statement id reaches the block's props by a DEBOUNCED write; reloading
  // before it lands would test the start form, not the resumed sheet.
  const [rec] = (await (await request.get(`${SERVER}/api/ledger/reconciliations?accountId=${bank}`)).json()) as Array<{id: string}>;
  await expect
    .poll(async () => JSON.stringify(await (await request.get(`${SERVER}/api/pages/${pageId}`)).json()).includes(rec.id), {timeout: 15_000})
    .toBe(true);

  // Present the instance as guest-read-only to this context only, and reload.
  await page.route('**/api/instance', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const real = await route.fetch();
    const info = (await real.json()) as Record<string, unknown>;
    await route.fulfill({json: {...info, guestAccess: 'read'}});
  });
  await page.goto(`/?page=${pageId}`);
  // Asserted INDEPENDENTLY of any ledger assertion: a broken intercept must
  // fail here, not stay silently green below.
  await expect(page.locator('.obe-root')).toHaveClass(/obe-readonly/);

  // The READ side is untouched — the sheet resumes, still balanced.
  await expect(page.locator('[data-ledger-arithmetic]')).toBeVisible();
  await expect(page.locator('[data-ledger-difference-amount]')).toHaveText('0.00');

  // THE POINT: same books, same zero difference — only the page lock differs,
  // and the surface that certifies the books is honestly inert.
  await expect(page.locator('[data-ledger-finish]')).toBeDisabled();
  await expect(page.locator('[data-ledger-finish]')).toHaveCSS('cursor', 'not-allowed');
  await expect(page.locator('[data-ledger-amend]')).toBeDisabled();
  await expect(page.locator('[data-ledger-abandon]')).toBeDisabled();
  await expect(page.locator('[data-ledger-reconcile-row] input[type="checkbox"]')).toBeDisabled();

  // The reason is stated once, without an imperative, and the dead controls
  // point at it by `aria-describedby`.
  const why = page.locator('[data-ledger-reconcile-why="read-only"]');
  await expect(why).toHaveCount(1);
  await expect(why).toContainText('This page is read-only');
  await expect(page.locator('[data-ledger-amend]')).toHaveAttribute('aria-describedby', (await why.getAttribute('id')) ?? '');
  const finishDescribedBy = (await page.locator('[data-ledger-finish]').getAttribute('aria-describedby')) ?? '';
  expect(finishDescribedBy).toContain((await why.getAttribute('id')) ?? 'MISSING-ID');

  // No server round-trip discovered any of this, and none changed anything:
  // the statement is still open on the books.
  const after = (await (await request.get(`${SERVER}/api/ledger/reconciliations/${rec.id}`)).json()) as {reconciliation: {status: string}};
  expect(after.reconciliation.status).toBe('open');

  // ── The START form, locked (F1) ───────────────────────────────────────────
  // "Pick another statement" is navigation and stays live — it lands on the
  // start form, whose inputs are PURE WRITE INTENT: on an editable page these
  // exact controls are live (the starts above used them). The widget editor is
  // still live here, so a block reverted to `editor.readOnly` renders all
  // three enabled and every assertion below fails.
  await page.locator('[data-ledger-reconcile-close]').click();
  const startButton = page.locator('[data-ledger-reconcile-start]');
  await expect(startButton).toBeVisible();
  await expect(startButton).toBeDisabled();
  await expect(page.locator('[data-ledger-reconcile-account]')).toBeDisabled();
  await expect(page.locator('[data-ledger-statement-date]')).toBeDisabled();
  await expect(page.locator('[data-ledger-statement-balance-input]')).toBeDisabled();
  // The reason is stated (the start form's own copy of it), the dead inputs
  // point at it, and the imperative missing-input checklist is not shown.
  const startWhy = page.locator('[data-ledger-reconcile-why="read-only"]');
  await expect(startWhy).toHaveCount(1);
  await expect(startWhy).toContainText('This page is read-only');
  await expect(page.locator('[data-ledger-reconcile-account]')).toHaveAttribute('aria-describedby', (await startWhy.getAttribute('id')) ?? '');
  await expect(page.locator('[data-ledger-statement-balance-input]')).toHaveAttribute('aria-describedby', (await startWhy.getAttribute('id')) ?? '');
  await expect(page.locator('[data-ledger-start-hint]')).toHaveCount(0);
});
