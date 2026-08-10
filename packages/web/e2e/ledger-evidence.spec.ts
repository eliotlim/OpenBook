import {createHash} from 'node:crypto';
import {mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {test, expect} from './fixtures';
import {SERVER} from './seed';
import {ensureLedgerPlugin} from './ledgerPlugin';
import {ensureAccount, pageWithBlock, postEntry, type ApiTransaction} from './ledgerApi';

test.use({ownerGatedRequests: true});

/**
 * LGR-14: evidence integrity, end to end — the REAL plugin against the REAL
 * ledger server.
 *
 * Proves the acceptance criteria's UI half:
 *  - an evidence-REQUIRED account blocks posting without an attachment, in the
 *    block (dead Post + reason) AND at the server (a direct API post of the
 *    same draft 409s `evidence-required` — the negative that matters as much
 *    as the disabled button);
 *  - attaching a receipt lifts the gate; the posted entry carries the
 *    `{filename, sha256, size}` manifest, where the sha256 provably IS the
 *    SHA-256 of the uploaded bytes (computed independently here);
 *  - the register wears the informational badge on exactly the posted-without-
 *    evidence entry (the OPTIONAL case), and the count on the documented one;
 *  - the per-account toggle is operable from the register and lands in the
 *    account row.
 *
 * PR captures: run with LGR14_CAPTURES=1 to write the badge/blocked PNGs into
 * pr-captures/lgr-14/ (untracked; never committed).
 */

const CAPTURE = process.env.LGR14_CAPTURES === '1';
const captureDir = resolve(process.cwd(), '../../pr-captures/lgr-14');

const row = (page: import('@playwright/test').Page, n: number) => ({
  account: page.getByLabel(`Row ${n} account`),
  debit: page.getByLabel(`Row ${n} debit`),
  credit: page.getByLabel(`Row ${n} credit`),
  memo: page.getByLabel(`Row ${n} memo`),
});

test('evidence-required blocks the post (UI + server); a receipt unblocks it; the register badges the optional case', {tag: ['@ledger', '@p1']}, async ({page, request}) => {
  const uniq = `${Date.now()}`;
  const strictName = `EV${uniq}:Expenses:Travel`;
  const bankName = `EV${uniq}:Assets:Bank`;
  const miscName = `EV${uniq}:Expenses:Misc`;
  const strictId = await ensureAccount(request, strictName, 'expense');
  const bankId = await ensureAccount(request, bankName, 'asset');
  const miscId = await ensureAccount(request, miscName, 'expense');
  const desc = `Evidence ${uniq}`;

  // The per-account toggle, via the API it rides on (the UI toggle is proven
  // on the register below).
  const patched = await request.patch(`${SERVER}/api/ledger/accounts/${strictId}`, {data: {evidenceRequired: true}});
  expect(patched.ok()).toBe(true);
  expect(((await patched.json()) as {evidenceRequired: boolean}).evidenceRequired).toBe(true);

  await ensureLedgerPlugin(page);
  await pageWithBlock(page, request, `Journal evidence ${uniq}`, '/journal', 'Journal entry', '[data-ledger-journal]');

  // A BALANCED entry into the evidence-required account — the exact state in
  // which only the evidence gate stands between the user and Post.
  await page.locator('[data-ledger-description]').fill(desc);
  await page.locator('[data-ledger-date]').fill('2026-04-02');
  await row(page, 1).account.selectOption({label: strictName});
  await row(page, 1).debit.fill('42.00');
  await row(page, 2).account.selectOption({label: bankName});
  await row(page, 2).credit.fill('42.00');

  // The gate: dead Post wearing the evidence-required face, the reason naming
  // the account and the fix, wired to the button by aria-describedby. And the
  // evidence line drops its "(optional)" tail — the affordance must not
  // contradict the gate.
  const post = page.locator('[data-ledger-post]');
  await expect(post).toBeDisabled();
  await expect(post).toHaveAttribute('data-ledger-post-off', 'evidence-required');
  const why = page.locator('[data-ledger-evidence-required-why]');
  await expect(why).toContainText(strictName);
  await expect(why).toContainText(/attach a receipt/i);
  await expect(post).toHaveAttribute('aria-describedby', (await why.getAttribute('id')) ?? '');
  await expect(page.locator('[data-ledger-evidence-none]')).not.toContainText('optional');

  // THE SERVER-SIDE NEGATIVE: the same draft, posted straight at the API —
  // bypassing the disabled button entirely — is refused with the typed code,
  // and nothing lands on the books.
  let draftId = '';
  await expect
    .poll(async () => {
      const drafts = (await (await fetch(`${SERVER}/api/ledger/transactions?state=draft`)).json()) as Array<{id: string; description: string}>;
      draftId = drafts.find((d) => d.description === desc)?.id ?? '';
      return draftId;
    })
    .not.toBe('');
  const refused = await request.post(`${SERVER}/api/ledger/transactions/${draftId}/post`);
  expect(refused.status()).toBe(409);
  const refusal = (await refused.json()) as {code: string; error: string};
  expect(refusal.code).toBe('evidence-required');
  expect(refusal.error).toContain(strictName);
  const postedNone = (await (await fetch(`${SERVER}/api/ledger/transactions?state=posted`)).json()) as Array<{description: string}>;
  expect(postedNone.filter((t) => t.description === desc)).toHaveLength(0);

  if (CAPTURE) {
    mkdirSync(captureDir, {recursive: true});
    await page.locator('[data-ledger-journal]').screenshot({path: resolve(captureDir, 'journal-blocked.png')});
  }

  // Attach a receipt through the block. The bytes are ours, so the manifest's
  // hash is independently checkable below.
  const receiptBytes = Buffer.from(`%PDF-1.4 fake receipt ${uniq}`);
  const expectedSha = createHash('sha256').update(receiptBytes).digest('hex');
  await page.locator('[data-ledger-evidence-file]').setInputFiles({name: 'receipt.pdf', mimeType: 'application/pdf', buffer: receiptBytes});
  await expect(page.locator('[data-ledger-evidence-item]')).toHaveCount(1);
  await expect(page.locator('[data-ledger-evidence-item]')).toContainText('receipt.pdf');

  // The gate lifts, and the entry posts.
  await expect(post).toBeEnabled();
  await post.click();
  await expect(page.locator('[data-ledger-posted]')).toBeVisible();

  // The books carry the post-time manifest, and its sha256 IS the hash of the
  // uploaded bytes — computed here, not read back from the server.
  const posted = (await (await fetch(`${SERVER}/api/ledger/transactions?state=posted`)).json()) as Array<{
    id: string;
    description: string;
    evidence: Array<{filename: string; sha256: string; size: number}>;
    postings: Array<{id: string; accountId: string}>;
  }>;
  const mine = posted.filter((t) => t.description === desc);
  expect(mine).toHaveLength(1);
  expect(mine[0].evidence).toEqual([{filename: 'receipt.pdf', sha256: expectedSha, size: receiptBytes.byteLength}]);

  // The verifier agrees the book is clean — and provably CHECKED the manifest.
  const report = (await (await fetch(`${SERVER}/api/ledger/verify`)).json()) as {findings: unknown[]; checkedEvidence: number};
  expect(report.findings).toEqual([]);
  expect(report.checkedEvidence).toBeGreaterThanOrEqual(1);

  // A second entry, posted WITHOUT evidence on ordinary accounts — legal, and
  // the register's badge case.
  const bare = (await postEntry(request, {
    date: '2026-04-03',
    description: `Bare ${uniq}`,
    postings: [
      {accountId: bankId, amountMinor: 1_500},
      {accountId: miscId, amountMinor: -1_500},
    ],
  })) as ApiTransaction;
  expect(bare.state).toBe('posted');

  // The register on the bank account: the documented entry counts its files,
  // the bare one wears the informational badge — each asserted INSIDE its own
  // row, so a badge on the wrong transaction fails rather than passes.
  await pageWithBlock(page, request, `Register evidence ${uniq}`, '/register', 'Account register', '[data-ledger-register]');
  await page.locator('[data-ledger-register-account]').selectOption({label: bankName});
  const documentedRow = page.locator(`[data-ledger-register-row="${mine[0].postings.find((p) => p.accountId === bankId)!.id}"]`);
  const bareRow = page.locator(`[data-ledger-register-row="${bare.postings.find((p) => p.accountId === bankId)!.id}"]`);
  await expect(documentedRow.locator('[data-ledger-evidence-count]')).toHaveAttribute('data-ledger-evidence-count', '1');
  await expect(documentedRow.locator('[data-ledger-no-evidence]')).toHaveCount(0);
  await expect(bareRow.locator('[data-ledger-no-evidence]')).toBeVisible();
  await expect(bareRow.locator('[data-ledger-no-evidence]')).toContainText('no evidence');
  await expect(bareRow.locator('[data-ledger-evidence-count]')).toHaveCount(0);

  if (CAPTURE) {
    mkdirSync(captureDir, {recursive: true});
    await page.locator('[data-ledger-register]').screenshot({path: resolve(captureDir, 'register-badge.png')});
  }

  // The per-account toggle, through the register UI this time: flip the BANK
  // account to evidence-required and watch it land on the account row.
  const toggle = page.locator('[data-ledger-evidence-required]');
  await expect(toggle).not.toBeChecked();
  await toggle.check();
  await expect
    .poll(async () => ((await (await fetch(`${SERVER}/api/ledger/accounts/${bankId}`)).json()) as {evidenceRequired: boolean}).evidenceRequired)
    .toBe(true);
  await expect(toggle).toBeChecked();
  // Put it back — accounts are shared across specs on this server.
  await toggle.uncheck();
  await expect
    .poll(async () => ((await (await fetch(`${SERVER}/api/ledger/accounts/${bankId}`)).json()) as {evidenceRequired: boolean}).evidenceRequired)
    .toBe(false);
});
