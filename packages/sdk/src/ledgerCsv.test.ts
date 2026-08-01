/**
 * Canonical postings CSV (LGR-7) — pure-function pins.
 *
 *  - column set + long form (one row per posting);
 *  - deterministic ordering: entry_no ascending, drafts after numbered entries;
 *  - RFC-4180 quoting, LF endings, UTF-8 no BOM, trailing newline;
 *  - SAME DATA ⇒ IDENTICAL BYTES: byte equality across two builds, and
 *    independence from object KEY ORDER (only field values matter).
 */

import {describe, expect, it} from 'vitest';
import {buildLedgerPostingsCsv, LEDGER_CSV_COLUMNS} from './ledgerCsv';
import type {LedgerAccount, LedgerTransaction} from './ledger';

const account = (over: Partial<LedgerAccount>): LedgerAccount => ({
  id: 'acc-1',
  name: 'Assets:Cash',
  type: 'asset',
  status: 'open',
  currency: 'USD',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

const cash = account({id: 'acc-cash', name: 'Assets:Cash'});
const income = account({id: 'acc-inc', name: 'Revenue:Sales', type: 'revenue'});

const tx = (over: Partial<LedgerTransaction>): LedgerTransaction => ({
  id: 'tx-1',
  date: '2026-03-01',
  description: 'Sale',
  state: 'posted',
  postedAt: '2026-03-01T10:00:00.000Z',
  postedBy: 'https://iss#tester',
  reverses: null,
  entryNo: 1,
  evidence: [],
  postings: [],
  createdAt: '2026-03-01T09:00:00.000Z',
  updatedAt: '2026-03-01T10:00:00.000Z',
  ...over,
});

const posted = tx({
  id: 'tx-a',
  entryNo: 2,
  description: 'Groceries, "weekly"',
  evidence: [
    {filename: 'a.pdf', sha256: 'aa11', size: 10},
    {filename: 'b.pdf', sha256: 'bb22', size: 20},
  ],
  postings: [
    {id: 'p-1', transactionId: 'tx-a', accountId: 'acc-cash', amountMinor: -123456, cleared: 'cleared', reconciliationId: null},
    {id: 'p-2', transactionId: 'tx-a', accountId: 'acc-inc', amountMinor: 123456, cleared: 'pending', reconciliationId: 'rec-9'},
  ],
});

const first = tx({
  id: 'tx-b',
  entryNo: 1,
  postings: [
    {id: 'p-3', transactionId: 'tx-b', accountId: 'acc-cash', amountMinor: 500, cleared: 'pending', reconciliationId: null},
    {id: 'p-4', transactionId: 'tx-b', accountId: 'acc-inc', amountMinor: -500, cleared: 'pending', reconciliationId: null},
  ],
});

const draft = tx({
  id: 'tx-d',
  state: 'draft',
  entryNo: null,
  postedAt: null,
  postedBy: null,
  createdAt: '2026-03-05T00:00:00.000Z',
  postings: [{id: 'p-5', transactionId: 'tx-d', accountId: 'acc-cash', amountMinor: 1, cleared: 'pending', reconciliationId: null}],
});

describe('LGR-7 — canonical postings CSV', () => {
  it('emits the documented header + one row per posting, entries ordered by entry_no then drafts', () => {
    const csv = buildLedgerPostingsCsv([cash, income], [draft, posted, first]);
    const lines = csv.split('\n');
    expect(lines[0]).toBe(LEDGER_CSV_COLUMNS.join(','));
    // 5 postings + header + trailing '' from the final newline.
    expect(lines.length).toBe(7);
    expect(lines[lines.length - 1]).toBe('');
    // entry 1 (tx-b) first, then entry 2 (tx-a), then the draft (no entry_no).
    expect(lines[1].startsWith('1,tx-b,')).toBe(true);
    expect(lines[3].startsWith('2,tx-a,')).toBe(true);
    expect(lines[5].startsWith(',tx-d,')).toBe(true);
    // Postings keep their creation order within a transaction.
    expect(lines[3]).toContain(',p-1,');
    expect(lines[4]).toContain(',p-2,');
  });

  it('carries raw minor units AND the formatted display amount + joined evidence hashes', () => {
    const csv = buildLedgerPostingsCsv([cash, income], [posted]);
    const row = csv.split('\n')[1];
    expect(row).toContain(',-123456,');
    expect(row).toContain('-$1,234.56'); // formatted (quoted — contains a comma)
    expect(row).toContain('aa11;bb22');
    expect(row).toContain(',USD,');
  });

  it('quotes RFC-4180 style: inner quotes doubled, comma-bearing fields wrapped', () => {
    const csv = buildLedgerPostingsCsv([cash, income], [posted]);
    expect(csv).toContain('"Groceries, ""weekly"""');
    expect(csv).toContain('"-$1,234.56"');
    // LF only — never CRLF.
    expect(csv.includes('\r')).toBe(false);
    // No BOM.
    expect(csv.charCodeAt(0)).not.toBe(0xfeff);
  });

  it('same data ⇒ identical bytes, regardless of input array order and object key order', () => {
    const a = buildLedgerPostingsCsv([cash, income], [first, posted, draft]);
    // Reverse array order + rebuild every object with REVERSED key insertion order.
    const reverseKeys = <T>(obj: T): T => {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(obj as Record<string, unknown>).reverse()) {
        out[key] = (obj as Record<string, unknown>)[key];
      }
      return out as T;
    };
    const b = buildLedgerPostingsCsv(
      [income, cash].map(reverseKeys),
      [draft, posted, first].map((t) => ({...reverseKeys(t), postings: t.postings.map(reverseKeys)})),
    );
    // Byte-level equality (the sdk targets the browser lib — compare code units,
    // which for identical strings is exactly byte equality under UTF-8).
    expect(b === a).toBe(true);
    expect(b.length).toBe(a.length);
  });

  it('neutralizes spreadsheet formulas in FREE-TEXT columns only — never in amount_minor', () => {
    const evil = account({id: 'acc-evil', name: '=cmd|\' /c calc\'!A1', type: 'expense'});
    const attack = tx({
      id: 'tx-x',
      entryNo: 7,
      description: '=HYPERLINK("http://evil","click")',
      postedBy: '@SUM(A1:A9)',
      postings: [
        {id: 'p-x', transactionId: 'tx-x', accountId: 'acc-evil', amountMinor: -900, cleared: 'pending', reconciliationId: null},
      ],
    });
    const row = buildLedgerPostingsCsv([evil], [attack]).split('\n')[1];
    const cells = row.split(',');
    // description / account_name / posted_by are apostrophe-prefixed…
    expect(row).toContain('"\'=HYPERLINK(""http://evil"",""click"")"');
    expect(row).toContain('\'=cmd|\'');
    expect(row).toContain('\'@SUM(A1:A9)');
    // …while the negative amount (which also starts with a formula lead char)
    // stays verbatim: machine columns are never prefixed.
    expect(cells).toContain('-900');
    expect(row).not.toContain('\'-900');
  });

  it('an unformattable (raw-corrupted) amount empties amount_formatted but never throws', () => {
    const corrupt = tx({
      id: 'tx-c',
      entryNo: 3,
      postings: [
        // Raw storage corruption the ledger writer could never produce.
        {id: 'p-c1', transactionId: 'tx-c', accountId: 'acc-cash', amountMinor: 1.5, cleared: 'pending', reconciliationId: null},
        {id: 'p-c2', transactionId: 'tx-c', accountId: 'acc-cash', amountMinor: Number.NaN, cleared: 'pending', reconciliationId: null},
      ],
    });
    const lines = buildLedgerPostingsCsv([cash], [corrupt]).split('\n');
    // Raw values survive verbatim; the display column degrades to empty.
    expect(lines[1]).toContain(',1.5,,USD,');
    expect(lines[2]).toContain(',NaN,,USD,');
  });

  it('the formula prefix is INJECTIVE — a genuine leading apostrophe survives the round trip', () => {
    // `=SUM(1)` and `'=SUM(1)` must not both emit `'=SUM(1)`: the documented
    // re-import rule strips exactly ONE leading `'`, so a non-injective escape
    // would silently corrupt every value that legitimately starts with one.
    const rowFor = (description: string): string => {
      const t = tx({
        id: 'tx-q',
        description,
        postings: [{id: 'p-q', transactionId: 'tx-q', accountId: 'acc-cash', amountMinor: 1, cleared: 'pending', reconciliationId: null}],
      });
      return buildLedgerPostingsCsv([cash], [t]).split('\n')[1];
    };
    const unprefix = (cell: string): string => (cell.startsWith('\'') ? cell.slice(1) : cell);
    // Column 3 is `description` — none of these values needs RFC-4180 quoting.
    const cellOf = (description: string): string => rowFor(description).split(',')[3];

    expect(cellOf('=SUM(1)')).toBe('\'=SUM(1)');
    expect(cellOf('\'=SUM(1)')).toBe('\'\'=SUM(1)');
    expect(cellOf('\'tis a quote')).toBe('\'\'tis a quote');
    expect(cellOf('=SUM(1)')).not.toBe(cellOf('\'=SUM(1)')); // distinct inputs, distinct bytes
    for (const original of ['=SUM(1)', '\'=SUM(1)', '\'tis a quote', 'plain text']) {
      expect(unprefix(cellOf(original))).toBe(original); // exact recovery
    }
    expect(cellOf('plain text')).toBe('plain text'); // never prefixed gratuitously
  });

  it('a null EVIDENCE element does not throw — the insurance export always leaves the building', () => {
    // Raw storage can hold `lp_evidence: [null]`: `transactionFromRow`
    // normalizes a non-ARRAY value to `[]` but passes a null ELEMENT straight
    // through, and `e.sha256` on it used to throw the whole export away.
    const corrupt = tx({
      id: 'tx-n',
      entryNo: 4,
      evidence: [null, {filename: 'a.pdf', sha256: 'aa11', size: 1}, {} as never] as unknown as LedgerTransaction['evidence'],
      postings: [{id: 'p-n', transactionId: 'tx-n', accountId: 'acc-cash', amountMinor: 7, cleared: 'pending', reconciliationId: null}],
    });
    const row = buildLedgerPostingsCsv([cash], [corrupt]).split('\n')[1];
    expect(row.endsWith(';aa11;')).toBe(true); // null → '', shapeless → ''
  });

  it('a dangling account reference degrades to empty account columns instead of throwing', () => {
    const orphan = tx({
      id: 'tx-o',
      postings: [{id: 'p-9', transactionId: 'tx-o', accountId: 'acc-missing', amountMinor: 42, cleared: 'pending', reconciliationId: null}],
    });
    const row = buildLedgerPostingsCsv([], [orphan]).split('\n')[1];
    expect(row).toContain(',p-9,,,42,0.42,,');
  });
});
