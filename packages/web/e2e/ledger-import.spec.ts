import {test, expect} from './fixtures';
import {SERVER} from './seed';
import {ensureLedgerPlugin} from './ledgerPlugin';
import {pageWithBlock, runPaletteCommand} from './ledgerApi';

test.use({ownerGatedRequests: true});

/**
 * LGR-10: the bank CSV importer, end to end — the REAL first-party plugin from
 * examples/plugins/ledger (read from disk, zipped, installed through Settings →
 * Extensions), driving the REAL ledger server.
 *
 * Proves the two things that decide whether anyone keeps using the books:
 *  - RE-IMPORTING THE SAME FILE CREATES ZERO NEW DRAFTS (asserted against the
 *    SERVER's draft list, not the UI's opinion of it);
 *  - the column mapping is remembered per SOURCE, so the second month's file
 *    needs no re-mapping.
 *
 * …plus the money invariants: integer `amountMinor` on the INTERCEPTED request
 * payloads (never the rendered text), and a minor-unit-denominated file landing
 * at the right scale rather than 100x.
 */

/**
 * Every spec in this file runs against ONE shared library, and dedup is exactly
 * what is under test — so each test tags its payee names, keeping its rows
 * distinct from every other test's without weakening what is asserted. The
 * HEADER is deliberately NOT tagged: the header shape is the source's identity,
 * and the mapping-reuse test depends on it being the same file format.
 */
const marchCsv = (tag: string): string =>
  [
    'Date,Description,Amount',
    `2026-03-01,BLUE BOTTLE ${tag},-4.50`,
    `2026-03-02,ACME PAYROLL ${tag},"2,500.00"`,
    `2026-03-03,"WIDGETS, INC ${tag}",-19.99`,
  ].join('\n');

/** April: the SAME bank, a different month — the mapping must already be known. */
const aprilCsv = (tag: string): string =>
  ['Date,Description,Amount', `2026-04-01,CITY PARKING ${tag},-12.00`, `2026-04-02,BLUE BOTTLE ${tag},-4.50`].join('\n');

/** A processor export denominated in CENTS: "1234" here is 12.34, not 1,234.00. */
const centsCsv = (tag: string): string =>
  ['Posted Date,Details,Amount (cents)', `2026-05-01,STRIPE PAYOUT ${tag},250000`, `2026-05-02,STRIPE FEE ${tag},-1250`].join('\n');

const upload = (name: string, csv: string) => ({name, mimeType: 'text/csv', buffer: Buffer.from(csv, 'utf8')});

const drafts = async (): Promise<Array<{id: string; date: string; description: string; postings: Array<{accountId: string; amountMinor: number; memo: string | null}>}>> => {
  const res = await fetch(`${SERVER}/api/ledger/transactions?state=draft`);
  return res.ok ? ((await res.json()) as never) : [];
};

const ledgerAccounts = async (): Promise<Array<{id: string; name: string}>> => {
  const res = await fetch(`${SERVER}/api/ledger/accounts`);
  return res.ok ? ((await res.json()) as Array<{id: string; name: string}>) : [];
};


test('install the plugin, import a bank CSV → drafts; re-importing the SAME file creates ZERO new drafts', {tag: ['@ledger', '@p1']}, async ({page, request}) => {
  await ensureLedgerPlugin(page);
  await page.keyboard.press('Escape');

  await runPaletteCommand(page, 'Ledger: set up books');
  await expect.poll(async () => (await ledgerAccounts()).length).toBe(10);

  // Capture every draft-creating payload: the wire must carry INTEGER minor
  // units, not the formatted text the table happens to render.
  const wire: Array<{postings?: Array<{amountMinor: number; memo: string | null}>}> = [];
  page.on('request', (req) => {
    if (req.url().includes('/api/ledger/transactions') && (req.method() === 'POST' || req.method() === 'PATCH')) {
      try {
        wire.push(req.postDataJSON() as never);
      } catch {
        // the atomic post op sends no body
      }
    }
  });

  const tag = `T1-${Date.now()}`;
  await pageWithBlock(page, request, `Bank import ${tag}`, '/bank', 'Bank import', '[data-ledger-import]');
  const before = (await drafts()).length;

  // ── First import ───────────────────────────────────────────────────────────
  await page.locator('[data-import-file]').setInputFiles(upload('march.csv', marchCsv(tag)));

  // Detection is SHOWN, not silently applied.
  await expect(page.locator('[data-import-detected]')).toBeVisible();
  await expect(page.locator('[data-import-detected]')).toContainText('Date from "Date"');
  await expect(page.locator('[data-import-map-date]')).toHaveValue('0');
  await expect(page.locator('[data-import-map-amount]')).toHaveValue('2');
  await expect(page.locator('[data-import-map-description]')).toHaveValue('1');
  await expect(page.locator('[data-import-denomination]')).toHaveValue('major');
  await expect(page.locator('[data-import-summary]')).toHaveText('3 new.');
  await expect(page.locator('[data-import-row]')).toHaveCount(3);

  // The button waits for the one thing only the user knows: which account this
  // statement IS.
  await expect(page.locator('[data-import-run]')).toBeDisabled();
  await page.locator('[data-import-source-account]').selectOption({label: 'Assets:Bank:Checking'});
  await expect(page.locator('[data-import-run]')).toBeEnabled();
  await page.locator('[data-import-run]').click();

  await expect(page.locator('[data-import-created="3"]')).toBeVisible();
  await expect.poll(async () => (await drafts()).length).toBe(before + 3);

  // Every created draft carries the bank leg at integer minor units, with the
  // raw statement line as the leg MEMO (LGR-16) — and the category side still
  // open, because the importer does not guess what a payment was for.
  const created = (await drafts()).filter((d) => d.description === `BLUE BOTTLE ${tag}`);
  expect(created).toHaveLength(1);
  expect(created[0].date).toBe('2026-03-01');
  expect(created[0].postings).toHaveLength(1);
  expect(created[0].postings[0].amountMinor).toBe(-450);
  expect(created[0].postings[0].memo).toBe(`BLUE BOTTLE ${tag}`);
  // The comma-bearing quoted field survived RFC-4180 parsing intact.
  expect((await drafts()).some((d) => d.description === `WIDGETS, INC ${tag}`)).toBe(true);
  expect((await drafts()).some((d) => d.postings[0]?.amountMinor === 250000)).toBe(true);

  for (const payload of wire) {
    for (const posting of payload.postings ?? []) expect(Number.isInteger(posting.amountMinor)).toBe(true);
  }

  // ── Confirm one row: the category leg lands and the entry balances ─────────
  await page.locator('[data-import-category="1"]').selectOption({label: 'Expenses:Office'});
  await page.locator('[data-import-confirm="1"]').click();
  await expect(page.locator('[data-import-draft="1"]')).toHaveAttribute('data-import-draft-confirmed', 'true');
  await expect
    .poll(async () => {
      const mine = (await drafts()).find((d) => d.description === `BLUE BOTTLE ${tag}`);
      return mine?.postings.reduce((n, p) => n + p.amountMinor, 0);
    })
    .toBe(0);

  // ── Re-import the SAME file: ZERO new drafts ──────────────────────────────
  const afterFirst = (await drafts()).length;
  await page.locator('[data-import-file]').setInputFiles(upload('march.csv', marchCsv(tag)));
  // These rows are DRAFTS, not entries on the books, and the verdict says so:
  // telling the user they are "already imported" while offering no way back to
  // them is what turned an interrupted import into a dead end.
  await expect(page.locator('[data-import-summary]')).toContainText('3 already drafted');
  await expect(page.locator('[data-import-draft-warning]')).toContainText('unfinished draft');
  await expect(page.locator('[data-import-row][data-import-status="duplicate-draft"]')).toHaveCount(3);
  // The button cannot even be pressed — there is nothing to import.
  await expect(page.locator('[data-import-run]')).toBeDisabled();
  // …and the SERVER agrees: not one new draft.
  expect((await drafts()).length).toBe(afterFirst);

  // …and the two rows still awaiting a category are REACHABLE, rehydrated from
  // the books rather than from React state that died with the last render.
  await expect(page.locator('[data-import-stranded]')).toBeVisible();
  await expect(page.locator('[data-import-draft-confirmed="false"]').first()).toBeVisible();
});

test('the mapping is remembered per source: the next month needs no re-mapping', {tag: ['@ledger', '@p1']}, async ({page, request}) => {
  const tag = `T2-${Date.now()}`;
  await pageWithBlock(page, request, `Bank import april ${tag}`, '/bank', 'Bank import', '[data-ledger-import]');

  // March, with one deliberate OVERRIDE of what detection chose, so the thing
  // being remembered is demonstrably the USER's mapping and not a re-detection.
  await page.locator('[data-import-file]').setInputFiles(upload('march.csv', marchCsv(tag)));
  await page.locator('[data-import-source-account]').selectOption({label: 'Assets:Bank:Checking'});
  await page.locator('[data-import-dateformat]').selectOption('iso');
  await page.locator('[data-import-sign]').selectOption('outflow-negative');
  await expect(page.locator('[data-import-run]')).toBeEnabled();
  await page.locator('[data-import-run]').click();
  await expect(page.locator('[data-import-created]')).toBeVisible();

  // A fresh block on a fresh page — nothing carries over except the SAVED
  // profile, which is keyed on the bank's export shape.
  await pageWithBlock(page, request, `Bank import april 2 ${tag}`, '/bank', 'Bank import', '[data-ledger-import]');
  await page.locator('[data-import-file]').setInputFiles(upload('april.csv', aprilCsv(tag)));

  await expect(page.locator('[data-import-saved-mapping]')).toBeVisible();
  // The reuse notice names the ACCOUNT the money is about to land in — not a
  // file name — and detection is still narrated underneath it, so a bank that
  // quietly changes its money scale cannot hide behind a saved mapping.
  await expect(page.locator('[data-import-detected]')).toContainText('importing into Assets:Bank:Checking');
  await expect(page.locator('[data-import-detected]')).toContainText('Date from "Date"');
  // Nothing disagrees here, so nothing is raised loudly.
  await expect(page.locator('[data-import-note-ask]')).toHaveCount(0);
  // The account is pre-filled too: the user is not asked again which bank this is.
  await expect(page.locator('[data-import-source-account]')).not.toHaveValue('');
  await expect(page.locator('[data-import-run]')).toBeEnabled();
  await expect(page.locator('[data-import-summary]')).toContainText('2 new');

  const before = (await drafts()).length;
  await page.locator('[data-import-run]').click();
  await expect.poll(async () => (await drafts()).length).toBe(before + 2);
  expect((await drafts()).some((d) => d.description === `CITY PARKING ${tag}` && d.postings[0].amountMinor === -1200)).toBe(true);
});

test('a CENTS-denominated export imports at the right scale, never 100x', {tag: ['@ledger', '@p1']}, async ({page, request}) => {
  const tag = `T3-${Date.now()}`;
  await pageWithBlock(page, request, `Bank import cents ${tag}`, '/bank', 'Bank import', '[data-ledger-import]');
  await page.locator('[data-import-file]').setInputFiles(upload('stripe.csv', centsCsv(tag)));

  // Detection SAYS what it concluded about the money scale, and shows it in the
  // control the user can override.
  await expect(page.locator('[data-import-detected]')).toContainText('MINOR units');
  await expect(page.locator('[data-import-denomination]')).toHaveValue('minor');

  await page.locator('[data-import-source-account]').selectOption({label: 'Assets:Bank:Checking'});
  const before = (await drafts()).length;
  await page.locator('[data-import-run]').click();
  await expect.poll(async () => (await drafts()).length).toBe(before + 2);

  const payout = (await drafts()).find((d) => d.description === `STRIPE PAYOUT ${tag}`);
  // 250000 CENTS is 2,500.00 — not 250,000.00. The 100x error is the whole
  // reason `bareDigits` exists.
  expect(payout?.postings[0].amountMinor).toBe(250000);
  expect((await drafts()).find((d) => d.description === `STRIPE FEE ${tag}`)?.postings[0].amountMinor).toBe(-1250);
});

test('a malformed statement reports per row and still imports the good ones', {tag: ['@ledger']}, async ({page, request}) => {
  const tag = `T4-${Date.now()}`;
  await pageWithBlock(page, request, `Bank import messy ${tag}`, '/bank', 'Bank import', '[data-ledger-import]');
  const messy = [
    'Date,Description,Amount',
    `2026-06-01,GOOD ROW ${tag},-1.00`,
    `2026-02-30,FEBRUARY THIRTIETH ${tag},-2.00`,
    `2026-06-02,NO AMOUNT ${tag},`,
    `2026-06-03,EURO SEPARATORS ${tag},"1.234,56"`,
    `2026-06-04,SHORT ROW ${tag}`,
  ].join('\n');
  await page.locator('[data-import-file]').setInputFiles(upload('messy.csv', messy));

  await expect(page.locator('[data-import-summary]')).toContainText('1 new');
  await expect(page.locator('[data-import-summary]')).toContainText('4 unreadable');
  await expect(page.locator('[data-import-row][data-import-status="error"]')).toHaveCount(4);
  // The reason is on the row, so the user can fix the file rather than guess.
  await expect(page.locator('[data-import-row="2"] [data-import-row-problem]')).toContainText('unreadable date');

  await page.locator('[data-import-source-account]').selectOption({label: 'Assets:Bank:Checking'});
  const before = (await drafts()).length;
  await page.locator('[data-import-run]').click();
  await expect.poll(async () => (await drafts()).length).toBe(before + 1);
  expect((await drafts()).some((d) => d.description === `GOOD ROW ${tag}`)).toBe(true);
  // Nothing unreadable slipped through under a guessed value.
  expect((await drafts()).some((d) => d.description === `FEBRUARY THIRTIETH ${tag}`)).toBe(false);
  expect((await drafts()).some((d) => d.description === `EURO SEPARATORS ${tag}`)).toBe(false);
});
