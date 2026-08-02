import {test, expect} from './fixtures';
import {ensureLedgerPlugin} from './ledgerPlugin';
import {createDraft, draftCount, ensureAccount, pageWithBlock, postEntry, serveTransactions, wirePosted as posted, wirePosting as posting} from './ledgerApi';
import type {Page} from '@playwright/test';

/**
 * LGR-9: the balance sheet and the income statement, end to end — the REAL
 * first-party plugin from examples/plugins/ledger (zipped from disk, installed
 * through Settings → Extensions), driving the REAL ledger server.
 *
 * Proves: the accounting identity on a live book, the colon hierarchy rolled up
 * and collapsible (a subtotal that does not move when the twisty does), the
 * as-at date moving the position with an INCLUSIVE boundary, net income over a
 * period with the reconciliation sentence that ties it to the equity movement,
 * drafts excluded and labelled, and both statements updating live when an entry
 * is posted from elsewhere — no reload.
 *
 * THREE ISOLATION RULES this file is arranged around. They are not ceremony:
 * spec files share a worker's data server, `resetWorkspace` only clears PAGES
 * (ledger accounts and transactions survive it), and a STATEMENT aggregates the
 * whole book rather than one account — so an absolute total is only meaningful
 * if nothing else can land inside its window.
 *
 *  1. Each live test owns a YEAR of its own: the balance sheet's book is 2027,
 *     the income statement's is 2028, and every other ledger spec lives in 2026.
 *     A date-ranged report (the income statement, and the reconciliation's equity
 *     delta) is then exactly that test's own entries, whoever shares the server.
 *  2. The balance sheet is CUMULATIVE and cannot be isolated by date at all, so
 *     its live test asserts the identity (true whatever else is on the book) and
 *     its OWN subtree subtotals, scoped by section — never a whole-book total.
 *  3. The exact section totals are pinned separately against an INTERCEPTED
 *     book, where the transaction list is the only source of balances and every
 *     figure is deterministic.
 *
 * Every assertion must also hold on an EMPTY book, because a Playwright retry
 * starts a fresh worker (and therefore a fresh, empty data server).
 */

/** This file's own subtree inside one section — immune to whatever else shares the book. */
const sectionSubtotal = (page: Page, section: string, root: string) =>
  page.locator(`[data-ledger-section="${section}"] [data-ledger-statement-row="${root}"][data-ledger-row-kind="node"] [data-ledger-statement-amount]`);

const totalRow = (page: Page, key: string) => page.locator(`[data-ledger-statement-total="${key}"]`);
const totalAmount = (page: Page, key: string) => totalRow(page, key).locator('[data-ledger-statement-amount]');

test('balance sheet: identity satisfied on a live book, hierarchy rolled up and collapsible, live on a new entry', {tag: ['@ledger', '@p1']}, async ({page, request}) => {
  const uniq = `${Date.now()}`;
  const root = `BS${uniq}`;
  // A chart with real depth, and `Expenses` as BOTH a group and an account.
  const checking = await ensureAccount(request, `${root}:Assets:Bank:Checking`, 'asset');
  const savings = await ensureAccount(request, `${root}:Assets:Bank:Savings`, 'asset');
  const card = await ensureAccount(request, `${root}:Liabilities:CreditCard`, 'liability');
  const equity = await ensureAccount(request, `${root}:Equity:Opening`, 'equity');
  const revenue = await ensureAccount(request, `${root}:Income:Sales`, 'revenue');
  const expensesRoot = await ensureAccount(request, `${root}:Expenses`, 'expense');
  const hosting = await ensureAccount(request, `${root}:Expenses:Hosting`, 'expense');

  await postEntry(request, {date: '2027-01-05', description: 'Founder capital', postings: [{accountId: checking, amountMinor: 1000000}, {accountId: equity, amountMinor: -1000000}]});
  await postEntry(request, {date: '2027-02-01', description: 'Invoice 1', postings: [{accountId: savings, amountMinor: 400000}, {accountId: revenue, amountMinor: -400000}]});
  await postEntry(request, {date: '2027-03-01', description: 'Hosting', postings: [{accountId: hosting, amountMinor: 150000}, {accountId: card, amountMinor: -150000}]});
  // Posted DIRECTLY to the parent account — the case the rollup has to keep
  // apart from its children's subtotal.
  await postEntry(request, {date: '2027-03-02', description: 'Sundry', postings: [{accountId: expensesRoot, amountMinor: 5000}, {accountId: card, amountMinor: -5000}]});
  // Dated INSIDE the as-at window below: the exclusion label counts drafts in
  // scope, so a draft after the as-at date would (correctly) not be counted.
  await createDraft(request, {date: '2027-02-15', description: 'Not posted', postings: [{accountId: checking, amountMinor: 999999}, {accountId: revenue, amountMinor: -999999}]});

  await ensureLedgerPlugin(page);
  await pageWithBlock(page, request, `Balance sheet ${uniq}`, '/balance', 'Balance sheet', '[data-ledger-balance-sheet]');

  // PIN the as-at date. Both blocks default to the WALL CLOCK now, so a test that
  // leaned on the default would assert against whatever day it happened to run —
  // the defaulting behaviour gets its own test, with a fixture built relative to
  // today, at the bottom of this file.
  const identity = page.locator('[data-ledger-identity]');
  await page.locator('[data-ledger-as-of]').fill('2027-03-02');
  await expect(page.locator('[data-ledger-as-of]')).toHaveValue('2027-03-02');

  // THE ASSERTION: assets = liabilities + equity, stated positively, not merely
  // absent — and true whatever else shares this book.
  //
  // Asserted only ONCE THE DATE IS PINNED, and that ordering is the point: this
  // fixture is dated 2027, so on the wall-clock default the window can hold
  // nothing at all — and a ✓ over zero postings is a certificate of soundness
  // issued over a read of nothing (the empty case is asserted directly at the
  // bottom of this file, where an interception makes it deterministic).
  await expect(identity).toHaveAttribute('data-ledger-balanced', 'true');
  await expect(identity).toContainText('Balances — assets');
  await expect(identity).toContainText('= liabilities + equity');
  await expect(page.locator('[data-ledger-culprits]')).toHaveCount(0);

  // This file's own money, per section: assets 14,000.00 Dr, liabilities
  // 1,550.00 Cr, equity accounts 10,000.00 Cr.
  await expect(sectionSubtotal(page, 'assets', root)).toHaveText('14,000.00 Dr');
  await expect(sectionSubtotal(page, 'liabilities', root)).toHaveText('1,550.00 Cr');
  await expect(sectionSubtotal(page, 'equity', root)).toHaveText('10,000.00 Cr');
  // The computed equity line is labelled as computed, never as an account — the
  // starter chart ships a real `Equity:RetainedEarnings`, so this matters.
  await expect(totalRow(page, 'current-earnings')).toContainText('not an account');

  // THE HIERARCHY, rolled up: `Assets:Bank` is a grouping node whose subtotal is
  // its two children, and the leaves sit under it.
  // A `direct` row shares its node's path, so every node lookup qualifies the
  // KIND — otherwise a parent-that-is-also-an-account matches two rows.
  const row = (path: string) => page.locator(`[data-ledger-statement-row="${path}"][data-ledger-row-kind="node"]`);
  const rowAmount = (path: string) => row(path).locator('[data-ledger-statement-amount]');
  await expect(rowAmount(`${root}:Assets:Bank`)).toHaveText('14,000.00 Dr');
  await expect(rowAmount(`${root}:Assets:Bank:Checking`)).toHaveText('10,000.00 Dr');
  await expect(rowAmount(`${root}:Assets:Bank:Savings`)).toHaveText('4,000.00 Dr');
  // Revenue and expense accounts are NOT balance-sheet lines — they reach it
  // only through the computed current-earnings line.
  await expect(row(`${root}:Expenses:Hosting`)).toHaveCount(0);
  await expect(row(`${root}:Income:Sales`)).toHaveCount(0);
  // The scrolling table is keyboard-reachable and named (WCAG 2.1.1).
  await expect(page.getByRole('region', {name: 'Balance sheet table'})).toHaveAttribute('tabindex', '0');

  // COLLAPSE: a real button with aria-expanded, reachable by keyboard. The
  // subtree goes; the SUBTOTAL does not move — expanding is a disclosure, never
  // a recomputation.
  const bankToggle = page.locator(`[data-ledger-toggle="${root}:Assets:Bank"]`);
  await expect(bankToggle).toHaveAttribute('aria-expanded', 'true');
  await bankToggle.focus();
  await expect(bankToggle).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(bankToggle).toHaveAttribute('aria-expanded', 'false');
  await expect(row(`${root}:Assets:Bank:Checking`)).toHaveCount(0);
  await expect(rowAmount(`${root}:Assets:Bank`)).toHaveText('14,000.00 Dr');
  await expect(row(`${root}:Assets:Bank`)).toContainText('2 accounts');
  await page.keyboard.press('Enter');
  await expect(row(`${root}:Assets:Bank:Checking`)).toBeVisible();

  // Ungrouped, every account is listed flat — no grouping rows, same money.
  await page.locator('[data-ledger-rolled]').uncheck();
  await expect(row(`${root}:Assets:Bank`)).toHaveCount(0);
  await expect(rowAmount(`${root}:Assets:Bank:Checking`)).toHaveText('10,000.00 Dr');
  await expect(sectionSubtotal(page, 'assets', root)).toHaveCount(0); // no grouping rows at all
  await page.locator('[data-ledger-rolled]').check();

  // Drafts are excluded AND the exclusion is on screen with its count.
  await expect(page.locator('[data-ledger-balance-sheet]')).not.toContainText('9,999.99');
  const drafts = page.locator('[data-ledger-drafts-excluded]');
  await expect(drafts).toContainText('Posted entries only');
  await expect(drafts).toContainText('draft entr');
  // Every draft on this book is dated inside the window, so the label's count is
  // the whole book's draft count.
  await expect(drafts).toHaveAttribute('data-ledger-drafts-excluded', String(await draftCount(request)));

  // AS-AT is INCLUSIVE: dated to the day the hosting bill landed, it is IN…
  await page.locator('[data-ledger-as-of]').fill('2027-03-01');
  await expect(rowAmount(`${root}:Liabilities:CreditCard`)).toHaveText('1,500.00 Cr');
  await expect(identity).toHaveAttribute('data-ledger-balanced', 'true');
  // …and the next day's entry is OUT, and named as held back rather than
  // silently missing.
  await expect(page.locator('[data-ledger-as-of-excluded]')).toContainText('dated after 2027-03-01');
  // One day earlier and the bill has not happened yet — the identity still holds.
  await page.locator('[data-ledger-as-of]').fill('2027-02-28');
  await expect(rowAmount(`${root}:Liabilities:CreditCard`)).toHaveText('0.00');
  await expect(sectionSubtotal(page, 'assets', root)).toHaveText('14,000.00 Dr');
  await expect(identity).toHaveAttribute('data-ledger-balanced', 'true');

  await page.locator('[data-ledger-as-of]').fill('2027-04-30');

  // LIVE: an entry posted from elsewhere lands in the open statement — no
  // reload — and the identity still holds.
  await postEntry(request, {date: '2027-04-01', description: 'Invoice 2', postings: [{accountId: savings, amountMinor: 60000}, {accountId: revenue, amountMinor: -60000}]});
  await expect(rowAmount(`${root}:Assets:Bank:Savings`)).toHaveText('4,600.00 Dr');
  await expect(sectionSubtotal(page, 'assets', root)).toHaveText('14,600.00 Dr');
  await expect(identity).toHaveAttribute('data-ledger-balanced', 'true');
});

test('income statement: net income over a period, tied to the equity movement, live on a new entry', {tag: ['@ledger', '@p1']}, async ({page, request}) => {
  const uniq = `${Date.now()}`;
  const root = `IS${uniq}`;
  const bank = await ensureAccount(request, `${root}:Assets:Bank`, 'asset');
  const equity = await ensureAccount(request, `${root}:Equity:Opening`, 'equity');
  const product = await ensureAccount(request, `${root}:Income:Revenue:Product`, 'revenue');
  const services = await ensureAccount(request, `${root}:Income:Revenue:Services`, 'revenue');
  const hosting = await ensureAccount(request, `${root}:Expenses:Hosting`, 'expense');
  const cdn = await ensureAccount(request, `${root}:Expenses:Hosting:CDN`, 'expense');

  // January carries the ONLY direct equity posting, so a February-onwards period
  // has no equity movement other than earnings.
  await postEntry(request, {date: '2028-01-05', description: 'Capital', postings: [{accountId: bank, amountMinor: 500000}, {accountId: equity, amountMinor: -500000}]});
  await postEntry(request, {date: '2028-02-10', description: 'Product sale', postings: [{accountId: bank, amountMinor: 300000}, {accountId: product, amountMinor: -300000}]});
  await postEntry(request, {date: '2028-03-10', description: 'Consulting', postings: [{accountId: bank, amountMinor: 120000}, {accountId: services, amountMinor: -120000}]});
  await postEntry(request, {date: '2028-03-15', description: 'Hosting bill', postings: [{accountId: hosting, amountMinor: 90000}, {accountId: bank, amountMinor: -90000}]});
  await postEntry(request, {date: '2028-03-16', description: 'CDN', postings: [{accountId: cdn, amountMinor: 30000}, {accountId: bank, amountMinor: -30000}]});
  // Outside the period below — proves the range actually bounds the report.
  await postEntry(request, {date: '2028-09-01', description: 'Late sale', postings: [{accountId: bank, amountMinor: 777700}, {accountId: product, amountMinor: -777700}]});
  await createDraft(request, {date: '2028-03-20', description: 'Not posted', postings: [{accountId: bank, amountMinor: 888888}, {accountId: product, amountMinor: -888888}]});

  await ensureLedgerPlugin(page);
  await pageWithBlock(page, request, `Income statement ${uniq}`, '/income', 'Income statement', '[data-ledger-income-statement]');

  // Pin February–March: revenue 4,200.00, expenses 1,200.00, net profit 3,000.00.
  await page.locator('[data-ledger-period-from]').fill('2028-02-01');
  await page.locator('[data-ledger-period-to]').fill('2028-03-31');

  await expect(totalAmount(page, 'revenue')).toHaveText('4,200.00 Cr');
  await expect(totalAmount(page, 'expenses')).toHaveText('1,200.00 Dr');
  await expect(page.locator('[data-ledger-net-income]')).toContainText('Net profit of 3,000.00 from 2028-02-01 to 2028-03-31.');
  // A profit is a CREDIT to equity — never a bare signed number.
  // The bottom line sits in the table, in the same amount column as every other
  // figure — it used to be a flex div below it, 7-8px out of the column.
  await expect(totalAmount(page, 'net-income')).toHaveText('3,000.00 Cr');
  await expect(totalRow(page, 'net-income')).toContainText('Net income');
  await expect(page.locator('[data-ledger-net-income]')).toHaveAttribute('data-ledger-profit', 'true');

  // THE RECONCILIATION: nothing was contributed or drawn in this period, so the
  // equity movement IS this net income — the sentence a reader checks the two
  // statements against each other with.
  const reconciliation = page.locator('[data-ledger-reconciliation]');
  await expect(reconciliation).toHaveAttribute('data-ledger-reconciles', 'true');
  await expect(reconciliation).toContainText('equity moved 3,000.00 Cr');
  await expect(reconciliation).toContainText('which is this net income exactly');

  // Widen to include January's capital: the tie is still stated, but as net
  // income PLUS the contribution, not as if the delta were all earnings.
  await page.locator('[data-ledger-period-from]').fill('2028-01-01');
  await expect(reconciliation).toContainText('this net income plus 5,000.00 Cr posted directly to equity accounts');
  await expect(reconciliation).toHaveAttribute('data-ledger-reconciles', 'true');
  await page.locator('[data-ledger-period-from]').fill('2028-02-01');

  // THE HIERARCHY: `Expenses:Hosting` is a leaf account that is ALSO the parent
  // of CDN, so its own postings get their own row inside its subtotal.
  // A `direct` row shares its node's path, so every node lookup qualifies the
  // KIND — otherwise a parent-that-is-also-an-account matches two rows.
  const row = (path: string) => page.locator(`[data-ledger-statement-row="${path}"][data-ledger-row-kind="node"]`);
  const rowAmount = (path: string) => row(path).locator('[data-ledger-statement-amount]');
  await expect(rowAmount(`${root}:Expenses:Hosting`)).toHaveText('1,200.00 Dr');
  const direct = page.locator(`[data-ledger-statement-row="${root}:Expenses:Hosting"][data-ledger-row-kind="direct"]`);
  await expect(direct).toContainText('Posted to Hosting itself');
  await expect(direct.locator('[data-ledger-statement-amount]')).toHaveText('900.00 Dr');
  await expect(rowAmount(`${root}:Expenses:Hosting:CDN`)).toHaveText('300.00 Dr');
  // Revenue nests two levels and rolls up to this file's own section subtotal.
  await expect(rowAmount(`${root}:Income:Revenue`)).toHaveText('4,200.00 Cr');
  await expect(rowAmount(`${root}:Income:Revenue:Product`)).toHaveText('3,000.00 Cr');

  // Collapsing keeps the subtotal and hides the breakdown; Expand all restores it.
  await page.locator(`[data-ledger-toggle="${root}:Income:Revenue"]`).click();
  await expect(row(`${root}:Income:Revenue:Product`)).toHaveCount(0);
  await expect(rowAmount(`${root}:Income:Revenue`)).toHaveText('4,200.00 Cr');
  await page.locator('[data-ledger-expand-all]').click();
  await expect(row(`${root}:Income:Revenue:Product`)).toBeVisible();

  // Drafts excluded and labelled; out-of-period entries named, not silently gone.
  await expect(page.locator('[data-ledger-income-statement]')).not.toContainText('8,888.88');
  await expect(page.locator('[data-ledger-drafts-excluded]')).toContainText('Posted entries only');
  await expect(page.locator('[data-ledger-outside-period]')).toContainText('outside this period');

  // LIVE: an entry posted from elsewhere INSIDE the period moves the bottom line
  // and its reconciliation together — no reload.
  await postEntry(request, {date: '2028-03-25', description: 'Extra sale', postings: [{accountId: bank, amountMinor: 50000}, {accountId: product, amountMinor: -50000}]});
  await expect(totalAmount(page, 'revenue')).toHaveText('4,700.00 Cr');
  await expect(totalAmount(page, 'net-income')).toHaveText('3,500.00 Cr');
  await expect(reconciliation).toContainText('equity moved 3,500.00 Cr');
  // …and one posted OUTSIDE it does not move a figure.
  await postEntry(request, {date: '2028-10-01', description: 'Much later', postings: [{accountId: bank, amountMinor: 11100}, {accountId: product, amountMinor: -11100}]});
  await expect(page.locator('[data-ledger-outside-period]')).toContainText('outside this period');
  await expect(totalAmount(page, 'net-income')).toHaveText('3,500.00 Cr');
  await expect(totalAmount(page, 'revenue')).toHaveText('4,700.00 Cr');
});

test('every statement total is exact on a controlled book, and net income is the equity movement', {tag: ['@ledger', '@p1']}, async ({page, request}) => {
  const uniq = `${Date.now()}`;
  const root = `CT${uniq}`;
  const checking = await ensureAccount(request, `${root}:Assets:Bank:Checking`, 'asset');
  const card = await ensureAccount(request, `${root}:Liabilities:CreditCard`, 'liability');
  const equity = await ensureAccount(request, `${root}:Equity:Opening`, 'equity');
  const revenue = await ensureAccount(request, `${root}:Income:Sales`, 'revenue');
  const hosting = await ensureAccount(request, `${root}:Expenses:Hosting`, 'expense');

  // Serving the transaction LIST makes it the only source of balances, so every
  // total below is exact no matter which other specs share this data server.
  await serveTransactions(page, [
    posted({id: 'c1', entryNo: 1, date: '2027-01-05', description: 'Capital', postings: [posting('cp1', checking, 1000000), posting('cp2', equity, -1000000)]}),
    posted({id: 'c2', entryNo: 2, date: '2027-02-01', description: 'Invoice', postings: [posting('cp3', checking, 400000), posting('cp4', revenue, -400000)]}),
    posted({id: 'c3', entryNo: 3, date: '2027-03-01', description: 'Hosting', postings: [posting('cp5', hosting, 150000), posting('cp6', card, -150000)]}),
  ]);

  await ensureLedgerPlugin(page);
  await pageWithBlock(page, request, `Controlled sheet ${uniq}`, '/balance', 'Balance sheet', '[data-ledger-balance-sheet]');

  // Pinned, not defaulted — the default is today's clock (see the D1 test below).
  await page.locator('[data-ledger-as-of]').fill('2027-03-01');
  await expect(page.locator('[data-ledger-identity]')).toHaveAttribute('data-ledger-balanced', 'true');
  await expect(totalAmount(page, 'assets')).toHaveText('14,000.00 Dr');
  await expect(totalAmount(page, 'liabilities')).toHaveText('1,500.00 Cr');
  // Equity is the ACCOUNTS (10,000.00) plus the COMPUTED current earnings
  // (4,000.00 revenue less 1,500.00 expenses) — without that line the identity
  // is out by the period's profit on every real book.
  await expect(totalAmount(page, 'current-earnings')).toHaveText('2,500.00 Cr');
  await expect(totalAmount(page, 'equity')).toHaveText('12,500.00 Cr');
  await expect(totalAmount(page, 'liabilities-and-equity')).toHaveText('14,000.00 Cr');
  await expect(page.locator('[data-ledger-identity]')).toContainText('assets 14,000.00 Dr = liabilities + equity 14,000.00 Cr ✓');

  // The same book as an income statement: the bottom line IS the balance
  // sheet's current-earnings line, by two independent routes.
  await pageWithBlock(page, request, `Controlled income ${uniq}`, '/income', 'Income statement', '[data-ledger-income-statement]');
  await page.locator('[data-ledger-period-from]').fill('2027-01-01');
  await page.locator('[data-ledger-period-to]').fill('2027-03-01');
  await expect(totalAmount(page, 'revenue')).toHaveText('4,000.00 Cr');
  await expect(totalAmount(page, 'expenses')).toHaveText('1,500.00 Dr');
  await expect(totalAmount(page, 'net-income')).toHaveText('2,500.00 Cr');
  // The period includes January's capital, so the equity movement is net income
  // PLUS the contribution — stated, rather than glossed as all earnings.
  const reconciliation = page.locator('[data-ledger-reconciliation]');
  await expect(reconciliation).toHaveAttribute('data-ledger-reconciles', 'true');
  await expect(reconciliation).toContainText('equity moved 12,500.00 Cr');
  await expect(reconciliation).toContainText('this net income plus 10,000.00 Cr posted directly to equity accounts');
});

test('a damaged book breaks the identity LOUDLY and names the cause; a truncated read says so on the INFO tone', {tag: ['@ledger', '@p1']}, async ({page, request}) => {
  const uniq = `${Date.now()}`;
  const bank = await ensureAccount(request, `DS${uniq}:Assets:Bank`, 'asset');
  const revenue = await ensureAccount(request, `DS${uniq}:Income:Sales`, 'revenue');

  // Two entries have lost a posting — the shape a damaged ledger table leaves
  // behind, and one the server will never post.
  await serveTransactions(page, [
    posted({id: 'tx1', entryNo: 42, date: '2020-03-04', description: 'Invoice 0041', postings: [posting('p1', bank, 25000)]}),
    posted({id: 'tx2', entryNo: 43, date: '2020-03-05', description: 'Intact', postings: [posting('p2', bank, 1000), posting('p3', revenue, -1000)]}),
    posted({id: 'tx3', entryNo: 51, date: '2020-04-09', description: 'Sale 12', postings: [posting('p4', revenue, -900)]}),
  ]);

  await ensureLedgerPlugin(page);
  await pageWithBlock(page, request, `Damaged sheet ${uniq}`, '/balance', 'Balance sheet', '[data-ledger-balance-sheet]');

  const identity = page.locator('[data-ledger-identity]');
  await expect(identity).toHaveAttribute('data-ledger-balanced', 'false');
  await expect(identity).toContainText('THE BALANCE SHEET DOES NOT BALANCE');
  await expect(identity).toContainText('assets exceed liabilities + equity by 241.00');
  // It is about the DATA, not the UI…
  await expect(identity).toContainText('missing or damaged');
  // …and it names the next step: WHICH entries, by name, not a prohibition.
  const culprits = page.locator('[data-ledger-culprits]');
  await expect(culprits).toContainText('Entry #42 (2020-03-04 “Invoice 0041”) is out by 250.00 Dr');
  await expect(culprits).toContainText('Entry #51 (2020-04-09 “Sale 12”) is out by 9.00 Cr');
  // The alarm wears the alarm weight — this is one of the two messages that may.
  await expect(identity).toHaveCSS('font-weight', '600');

  // A stranded posting on a DELETED account is a different repair and is named
  // as one — with NO entry accused, because every entry here balances.
  await serveTransactions(page, [
    posted({id: 'tx4', entryNo: 60, date: '2020-04-10', description: 'Ghost', postings: [posting('p5', 'acc_deleted', 700), posting('p6', revenue, -700)]}),
  ]);
  await pageWithBlock(page, request, `Ghost sheet ${uniq}`, '/balance', 'Balance sheet', '[data-ledger-balance-sheet]');
  await expect(page.locator('[data-ledger-identity]')).toHaveAttribute('data-ledger-balanced', 'false');
  await expect(page.locator('[data-ledger-culprits]')).toHaveCount(0);
  const cause = page.locator('[data-ledger-unclassified-cause]');
  await expect(cause).toContainText('1 account was deleted');
  await expect(cause).toContainText('NOT in the identity above');
  // Its balance is disclosed in its own section rather than folded into a side
  // the report cannot know.
  await expect(page.locator('[data-ledger-section="unclassified"]')).toContainText('Deleted account (acc_deleted)');

  // The OTHER failure the reports distinguish: the fold cannot total the book at
  // all. Retrying re-reads the same damaged entry, so there is NO Retry here —
  // and the report does not claim an identity it never computed.
  await serveTransactions(page, [posted({id: 'tx5', entryNo: 70, date: '2020-05-01', description: 'Fractional', postings: [posting('p7', bank, 12.5), posting('p8', revenue, -12.5)]})]);
  await pageWithBlock(page, request, `Fold fail ${uniq}`, '/balance', 'Balance sheet', '[data-ledger-balance-sheet]');
  const foldError = page.locator('[data-ledger-error="fold"]');
  await expect(foldError).toBeVisible();
  await expect(foldError).toContainText('could not be computed');
  await expect(foldError.locator('[data-ledger-retry]')).toHaveCount(0);
  await expect(page.locator('[data-ledger-identity]')).toHaveCount(0);
});

test('a truncated read is a caveat, not an alarm, and each statement says what truncation costs it', {tag: ['@ledger']}, async ({page, request}) => {
  const uniq = `${Date.now()}`;
  const bank = await ensureAccount(request, `TS${uniq}:Assets:Bank`, 'asset');
  const revenue = await ensureAccount(request, `TS${uniq}:Income:Sales`, 'revenue');

  // Exactly a full page: the report cannot tell this from "there is more".
  await serveTransactions(
    page,
    Array.from({length: 1000}, (_, i) =>
      posted({id: `tx${i}`, entryNo: i + 1, date: '2020-02-02', description: `Entry ${i}`, postings: [posting(`pa${i}`, bank, 100), posting(`pb${i}`, revenue, -100)]}),
    ),
  );

  await ensureLedgerPlugin(page);
  await pageWithBlock(page, request, `Truncated sheet ${uniq}`, '/balance', 'Balance sheet', '[data-ledger-balance-sheet]');

  const notice = page.locator('[data-ledger-truncated]');
  await expect(notice).toBeVisible();
  await expect(notice).toContainText('Partial read');
  // "most recently ENTERED", not "most recent" — the server orders by entry
  // time, so a book with backdated entries is not ordered by date.
  await expect(notice).toContainText('most recently ENTERED');
  // INFO, not alarm: a standing caveat must not wear the colour reserved for a
  // broken book, or the real alarm arrives pre-ignored.
  await expect(notice).not.toHaveCSS('font-weight', '600');
  await expect(notice).toContainText('the identity itself');
  // The caption no longer claims completeness the notice just denied.
  await expect(page.locator('[data-ledger-balance-sheet] caption')).toContainText('NOT the whole book');

  await pageWithBlock(page, request, `Truncated income ${uniq}`, '/income', 'Income statement', '[data-ledger-income-statement]');
  await expect(page.locator('[data-ledger-truncated]')).toContainText('a subset of the period');
  // The income statement's default window is THIS year to date, so the 2020 book
  // needs a pinned period before it has a table to caption.
  await page.locator('[data-ledger-period-from]').fill('2020-01-01');
  await page.locator('[data-ledger-period-to]').fill('2020-12-31');
  await expect(page.locator('[data-ledger-income-statement] caption')).toContainText('NOT the whole book');
});


/**
 * Today, and the way out of an empty today.
 *
 * Both blocks default to the WALL CLOCK, so this fixture is built relative to
 * the clock — a future year — and SERVED THROUGH AN INTERCEPTION. The
 * interception is what makes "today's window is empty" provable: the balance
 * sheet is cumulative and whole-book, so a sibling spec's 2026 entries sharing
 * this worker's server would otherwise populate it and there would be no empty
 * state to recover from.
 *
 * The premise being tested is also the one that killed the old default: a book
 * merely dated in the PAST is FULLY visible at today's date (`tx.date <= asOf`),
 * so "today opens empty" is only ever true of a future-dated book — while
 * `latestReportedDate` maxes over future-dated entries, which is how a single
 * post-dated invoice used to pull money that had not happened into the opening
 * position.
 */
const iso = (d: Date): string => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

test('both statements default to today, and offer the latest period when today’s window is empty', {tag: ['@ledger', '@p1']}, async ({page, request}) => {
  const uniq = `${Date.now()}`;
  const root = `TD${uniq}`;
  const today = iso(new Date());
  // Three years out: always ahead of the clock, and never colliding with the
  // fixed years the tests above use for isolation.
  const future = `${new Date().getFullYear() + 3}`;
  const bank = await ensureAccount(request, `${root}:Assets:Bank`, 'asset');
  const equity = await ensureAccount(request, `${root}:Equity:Opening`, 'equity');
  const revenue = await ensureAccount(request, `${root}:Income:Sales`, 'revenue');

  const capital = posted({id: 'f1', entryNo: 1, date: `${future}-02-01`, description: 'Future capital', postings: [posting('fp1', bank, 700000), posting('fp2', equity, -700000)]});
  const sale = posted({id: 'f2', entryNo: 2, date: `${future}-05-20`, description: 'Future sale', postings: [posting('fp3', bank, 120000), posting('fp4', revenue, -120000)]});
  await serveTransactions(page, [capital, sale]);

  await ensureLedgerPlugin(page);
  await pageWithBlock(page, request, `Today balance sheet ${uniq}`, '/balance', 'Balance sheet', '[data-ledger-balance-sheet]');

  // DEFAULT = TODAY, and it says so.
  await expect(page.locator('[data-ledger-as-of]')).toHaveValue(today);
  await expect(page.locator('[data-ledger-as-of-defaulted]')).toContainText(`Dated to today (${today})`);
  // Nothing has happened yet, so the block hands over the next step rather than
  // rendering a bare empty grid — and the step is a PIN, not a redirect.
  const empty = page.locator('[data-ledger-empty]');
  await expect(empty).toContainText(`Nothing was posted on or before ${today}`);
  await expect(empty).toContainText(`latest posted entry is ${future}-05-20`);
  await expect(page.locator('[data-ledger-as-of-excluded]')).toContainText(`dated after ${today}`);
  // …and the identity does NOT hand out a ✓ over that read of nothing. Zero
  // entries satisfy assets = liabilities + equity vacuously, and this is the line
  // a reader screenshots as proof the books are sound.
  await expect(page.locator('[data-ledger-identity]')).toContainText(`Nothing to balance — no posted entries on or before ${today}.`);
  await expect(page.locator('[data-ledger-identity]')).not.toContainText('✓');

  await page.locator('[data-ledger-show-latest]').click();
  await expect(page.locator('[data-ledger-as-of]')).toHaveValue(`${future}-05-20`);
  await expect(page.locator('[data-ledger-as-of-defaulted]')).toHaveCount(0);
  await expect(sectionSubtotal(page, 'assets', root)).toHaveText('8,200.00 Dr');
  await expect(page.locator('[data-ledger-identity]')).toHaveAttribute('data-ledger-balanced', 'true');
  // …and the block then says, plainly, that what is on screen is not today. This
  // book's latest entry is AHEAD of the clock, which is the sharper half of the
  // warning: the position counts money that has not happened — exactly what the
  // old latest-entry default did silently on any book with a post-dated invoice.
  await expect(page.locator('[data-ledger-as-of-ahead]')).toContainText(
    `Dated to your latest posted entry (${future}-05-20) — ahead of today (${today}); this position includes entries that have not happened yet.`,
  );
  await expect(page.locator('[data-ledger-as-of-backdated]')).toHaveCount(0);

  // The other direction, pinned by hand: stale rather than premature.
  await page.locator('[data-ledger-as-of]').fill('2020-06-30');
  await expect(page.locator('[data-ledger-as-of-backdated]')).toContainText(`Dated 2020-06-30 — not today (${today})`);
  await expect(page.locator('[data-ledger-as-of-ahead]')).toHaveCount(0);

  // Back to today restores the default, and the label with it.
  await page.locator('[data-ledger-reset-as-of]').click();
  await expect(page.locator('[data-ledger-as-of]')).toHaveValue(today);
  await expect(page.locator('[data-ledger-as-of-defaulted]')).toBeVisible();
  await expect(page.locator('[data-ledger-as-of-backdated]')).toHaveCount(0);
  await expect(page.locator('[data-ledger-as-of-ahead]')).toHaveCount(0);

  // The income statement is on the SAME clock — one document, one date, so its
  // closing equity can never disagree with Total equity for no visible reason.
  await pageWithBlock(page, request, `Today income ${uniq}`, '/income', 'Income statement', '[data-ledger-income-statement]');
  await expect(page.locator('[data-ledger-period-to]')).toHaveValue(today);
  await expect(page.locator('[data-ledger-period-from]')).toHaveValue(`${today.slice(0, 4)}-01-01`);
  await expect(page.locator('[data-ledger-period-defaulted]')).toContainText('This year to date');
  await expect(page.locator('[data-ledger-empty]')).toContainText(`Show your latest period instead — through ${future}-05-20`);

  await page.locator('[data-ledger-show-latest]').click();
  await expect(page.locator('[data-ledger-period-from]')).toHaveValue(`${future}-01-01`);
  await expect(page.locator('[data-ledger-period-to]')).toHaveValue(`${future}-05-20`);
  await expect(totalAmount(page, 'net-income')).toHaveText('1,200.00 Cr');
  await expect(page.locator('[data-ledger-period-ahead]')).toContainText(`runs past today (${today})`);

  // F2: the period pins AS A UNIT. Touching ONE end used to leave the other on a
  // live default with the "year to date" notice gone — both boxes filled, Reset
  // offered, and nothing saying one end still floated.
  await page.locator('[data-ledger-reset-period]').click();
  await expect(page.locator('[data-ledger-period-defaulted]')).toBeVisible();
  await page.locator('[data-ledger-period-to]').fill(`${future}-05-20`);
  await expect(page.locator('[data-ledger-period-defaulted]')).toHaveCount(0);
  // The untouched end was written too, so it is a real pinned value…
  await expect(page.locator('[data-ledger-period-from]')).toHaveValue(`${today.slice(0, 4)}-01-01`);

  // …and a later entry arriving no longer moves it underneath the reader. (The
  // list is intercepted; a real POST is what wakes the block's subscription.)
  await serveTransactions(page, [capital, sale, posted({id: 'f3', entryNo: 3, date: `${future}-09-09`, description: 'Even later', postings: [posting('fp5', bank, 5000), posting('fp6', revenue, -5000)]})]);
  await postEntry(request, {date: `${future}-09-09`, description: 'Wake the subscription', postings: [{accountId: bank, amountMinor: 5000}, {accountId: revenue, amountMinor: -5000}]});
  await expect(page.locator('[data-ledger-outside-period]')).toContainText('outside this period');
  await expect(page.locator('[data-ledger-period-from]')).toHaveValue(`${today.slice(0, 4)}-01-01`);
  await expect(page.locator('[data-ledger-period-to]')).toHaveValue(`${future}-05-20`);
});
