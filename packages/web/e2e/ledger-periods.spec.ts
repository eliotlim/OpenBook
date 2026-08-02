import {test, expect} from './fixtures';
import {SERVER} from './seed';
import {ensureLedgerPlugin} from './ledgerPlugin';
import {createDraft, ensureAccount, getTransaction, pageWithBlock, postEntry} from './ledgerApi';

/**
 * LGR-12: period close, end to end — the REAL first-party plugin driving the
 * REAL ledger server. One test walks the whole lifecycle the acceptance
 * criteria name: close through the UI (warn-not-block confirm included), a
 * posting dated inside the closed period rejected at the STORE (typed 409 over
 * the wire) AND in the journal UI (the block surfaces `period-closed`), the
 * display-only closed-period marker on a report, then the audited REOPEN —
 * void-by-reversal verified — after which the same posting succeeds.
 *
 * DATE ISOLATION: spec files can share a worker's data server, and a period
 * lock is BOOK-WIDE state (unlike the per-test account names every other spec
 * hides behind). Every date here lives in 2002 — two decades away from the
 * 2026 dates the rest of the suite posts — and the test REOPENS the period on
 * its way out, so the book it leaves behind accepts everything it accepted
 * before.
 */

const row = (page: import('@playwright/test').Page, n: number) => ({
  account: page.getByLabel(`Row ${n} account`),
  debit: page.getByLabel(`Row ${n} debit`),
  credit: page.getByLabel(`Row ${n} credit`),
  memo: page.getByLabel(`Row ${n} memo`),
});

test('close locks the range (store 409 + journal UI); reopen voids by reversal and restores postability', {tag: ['@ledger', '@p1']}, async ({page, request}) => {
  const uniq = `${Date.now()}`;
  const cashName = `PC${uniq}:Assets:Cash`;
  const salesName = `PC${uniq}:Income:Sales`;
  const cash = await ensureAccount(request, cashName, 'asset');
  const sales = await ensureAccount(request, salesName, 'revenue');
  // The account the closing entry resolves BY NAME (idempotent on a shared book).
  const retained = await ensureAccount(request, 'Equity:RetainedEarnings', 'equity');
  await postEntry(request, {
    date: '2002-02-14',
    description: `Q1/2002 sale ${uniq}`,
    postings: [
      {accountId: cash, amountMinor: 5_000},
      {accountId: sales, amountMinor: -5_000},
    ],
  });

  await ensureLedgerPlugin(page);

  // ── Close 2002 Q1 through the block: confirm step, then the done notice ────
  const periodsPageId = await pageWithBlock(page, request, `Periods ${uniq}`, '/period', 'Period close', '[data-ledger-periods]');
  await page.locator('[data-ledger-period-start]').fill('2002-01-01');
  await page.locator('[data-ledger-period-end]').fill('2002-03-31');
  await page.locator('[data-ledger-period-close]').click();
  // The confirm says what will happen before it happens.
  await expect(page.locator('[data-ledger-period-close-confirm-box]')).toContainText('swept into Equity:RetainedEarnings');
  await page.locator('[data-ledger-period-close-confirm]').click();
  await expect(page.locator('[data-ledger-periods-done]')).toContainText('Closed 2002-01-01 – 2002-03-31');
  await expect(page.locator('[data-ledger-period-row]')).toContainText('Closed — closing entry posted');

  // The closing entry is a REAL posted transaction: income zeroed into
  // retained earnings, visible on the ordinary read surface.
  const listed = (await (await request.get(`${SERVER}/api/ledger/transactions?limit=1000`)).json()) as Array<{
    id: string; state: string; postings: Array<{accountId: string; amountMinor: number}>; description: string;
  }>;
  const closing = listed.find((t) => t.description === 'Closing entry — 2002-01-01 to 2002-03-31');
  expect(closing).toBeDefined();
  expect(closing!.state).toBe('posted');
  expect(closing!.postings.find((p) => p.accountId === sales)?.amountMinor).toBe(5_000);
  expect(closing!.postings.find((p) => p.accountId === retained)?.amountMinor).toBe(-5_000);

  // ── STORE: a posting dated inside the closed period is a typed 409 ─────────
  const blocked = await createDraft(request, {
    date: '2002-02-20',
    description: `blocked ${uniq}`,
    postings: [
      {accountId: cash, amountMinor: 700},
      {accountId: sales, amountMinor: -700},
    ],
  });
  const refused = await request.post(`${SERVER}/api/ledger/transactions/${blocked.id}/post`);
  expect(refused.status()).toBe(409);
  expect(((await refused.json()) as {code: string}).code).toBe('period-closed');
  expect((await getTransaction(request, blocked.id)).state).toBe('draft'); // rolled back whole

  // ── UI: the journal block surfaces the same rejection, in words ────────────
  await pageWithBlock(page, request, `Journal periods ${uniq}`, '/journal', 'Journal entry', '[data-ledger-journal]');
  await page.locator('[data-ledger-description]').fill(`UI blocked ${uniq}`);
  await page.locator('[data-ledger-date]').fill('2002-02-20');
  await row(page, 1).account.selectOption({label: cashName});
  await row(page, 1).debit.fill('10.00');
  await row(page, 2).account.selectOption({label: salesName});
  await row(page, 2).credit.fill('10.00');
  await expect(page.locator('[data-ledger-post]')).toBeEnabled();
  await page.locator('[data-ledger-post]').click();
  const banner = page.locator('[data-ledger-error="period-closed"]');
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('closed');

  // ── Report marker: display-only, and present while the period is closed ────
  await pageWithBlock(page, request, `TB periods ${uniq}`, '/trial', 'Trial balance', '[data-ledger-trial-balance]');
  await expect(page.locator('[data-ledger-closed-periods]')).toContainText('2002-01-01 – 2002-03-31');

  // ── REOPEN through the block: explicit confirm, void-by-reversal ───────────
  await page.goto(`/?page=${periodsPageId}`);
  await expect(page.locator('[data-ledger-periods]')).toBeVisible();
  await page.locator('[data-ledger-period-reopen]').click();
  await page.locator('[data-ledger-period-reopen-confirm]').click();
  await expect(page.locator('[data-ledger-periods-done]')).toContainText('Reopened 2002-01-01 – 2002-03-31');
  await expect(page.locator('[data-ledger-period-row]')).toContainText('Reopened');

  // Void-by-reversal, verified against the books: the closing entry is void
  // and a posted reversal points back at it with negated legs.
  const voided = await getTransaction(request, closing!.id);
  expect(voided.state).toBe('void');
  const after = (await (await request.get(`${SERVER}/api/ledger/transactions?limit=1000`)).json()) as Array<{
    id: string; state: string; reverses?: string | null; postings: Array<{accountId: string; amountMinor: number}>;
  }>;
  const reversal = after.find((t) => t.reverses === closing!.id);
  expect(reversal).toBeDefined();
  expect(reversal!.state).toBe('posted');
  expect(reversal!.postings.find((p) => p.accountId === sales)?.amountMinor).toBe(-5_000);

  // Postability restored: the draft the lock refused now posts unchanged.
  const allowed = await request.post(`${SERVER}/api/ledger/transactions/${blocked.id}/post`);
  expect(allowed.ok()).toBe(true);

  // The audit trail carries the whole story, and the book verifies clean.
  const audit = (await (await request.get(`${SERVER}/api/ledger/audit?limit=50`)).json()) as Array<{action: string}>;
  expect(audit.map((e) => e.action)).toContain('period.close');
  expect(audit.map((e) => e.action)).toContain('period.reopen');
  const report = (await (await request.get(`${SERVER}/api/ledger/verify`)).json()) as {findings: unknown[]};
  expect(report.findings).toEqual([]);
});
