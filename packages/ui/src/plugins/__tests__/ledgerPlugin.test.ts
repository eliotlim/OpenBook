import {describe, expect, it, vi} from 'vitest';
import {PLUGIN_API_VERSION, type DataClient, type LedgerAccount} from '@book.dev/sdk';
import {ledgerManifest as manifest, loadLedgerPlugin as loadModule, storedLedgerPlugin as storedPlugin} from './ledgerPluginFixture';
import {syncPlugins, pluginStatuses} from '../host';
import {pluginCommands} from '../commandRegistry';
import {getCustomBlock} from '../../blockeditor/registry';

// Structural mirrors of the plugin's exported shapes (the sources load through
// the runtime loader, so their types are not importable here).
interface JournalRow {
  accountId: string;
  debit: string;
  credit: string;
  memo: string;
}
interface JournalEntryStatus {
  rows: Array<{amountMinor: number | null; invalid: boolean; reason: 'both-columns' | 'unreadable-amount' | null; complete: boolean}>;
  sumMinor: number;
  debitMinor: number;
  creditMinor: number;
  valuedRowCount: number;
  balanced: boolean;
  canPost: boolean;
  problem: 'invalid-date' | 'too-few-rows' | 'incomplete-rows' | 'unbalanced' | null;
}
type StarterChart = ReadonlyArray<{name: string; type: LedgerAccount['type']}>;

type ComputeEntryStatus = (rows: JournalRow[], date?: string) => JournalEntryStatus;
type PostingInput = {accountId: string; amountMinor: number; memo: string | null};
type RowsToPostings = (rows: JournalRow[]) => PostingInput[];
type MergeMemos = (rows: JournalRow[], postings: ReadonlyArray<{memo?: string | null}>) => JournalRow[];
type Describe = (status: JournalEntryStatus) => string | null;
type ParseCell = (raw: string) => number | null | 'invalid';
type NormalizeCell = (raw: string) => string;

const row = (accountId: string, debit = '', credit = '', memo = ''): JournalRow => ({accountId, debit, credit, memo});

/**
 * EVERY block the ledger plugin registers, named once. The teardown assertion
 * walks this list, so adding a block without adding it here leaves a
 * registration nobody checks is released — which surfaces later as a phantom
 * block in an unrelated document.
 */
const ALL_LEDGER_BLOCKS = [
  'journal-entry',
  'trial-balance',
  'account-register',
  'bank-import',
  'reconcile',
  'balance-sheet',
  'income-statement',
  'period-close',
] as const;

describe('ledger plugin (real source through the real loader)', () => {
  it('declares apiVersion 2 and registers the journal-entry + report blocks and the setup command', async () => {
    expect(manifest.apiVersion).toBe(2);
    expect(manifest.apiVersion).toBe(PLUGIN_API_VERSION);

    const client = {listPlugins: async () => [storedPlugin()]} as unknown as DataClient;
    await syncPlugins(client);
    expect(pluginStatuses().find((s) => s.plugin.manifest.id === 'openbook.ledger')?.state).toBe('active');
    expect(getCustomBlock('openbook.ledger/journal-entry')).toBeDefined();
    expect(getCustomBlock('openbook.ledger/journal-entry')?.slash?.label).toBe('Journal entry');
    // LGR-8: the two read-only report blocks ship in the same plugin, each with
    // a slash entry and NON-EMPTY seed props (an empty object would leave the
    // block without a props CRDT map, so its controls could not persist).
    expect(getCustomBlock('openbook.ledger/trial-balance')?.slash?.label).toBe('Trial balance');
    expect(getCustomBlock('openbook.ledger/account-register')?.slash?.label).toBe('Account register');
    // LGR-9: the two statements ship in the same plugin, on the same terms.
    expect(getCustomBlock('openbook.ledger/balance-sheet')?.slash?.label).toBe('Balance sheet');
    expect(getCustomBlock('openbook.ledger/income-statement')?.slash?.label).toBe('Income statement');
    // LGR-11: the reconcile surface — a write surface, not a report, but it
    // ships and tears down on exactly the same terms as the rest.
    expect(getCustomBlock('openbook.ledger/reconcile')?.slash?.label).toBe('Reconcile');
    // LGR-12: the period-close surface — closed periods listed, close flow,
    // audited reopen — on the same registration terms.
    expect(getCustomBlock('openbook.ledger/period-close')?.slash?.label).toBe('Period close');
    for (const type of ['trial-balance', 'account-register', 'balance-sheet', 'income-statement', 'reconcile', 'period-close']) {
      const made = getCustomBlock(`openbook.ledger/${type}`)?.slash?.make();
      expect(made?.type).toBe(`openbook.ledger/${type}`);
      expect(Object.keys(made?.props ?? {}).length).toBeGreaterThan(0);
    }
    expect(getCustomBlock('openbook.ledger/bank-import')).toBeDefined();
    expect(getCustomBlock('openbook.ledger/bank-import')?.slash?.label).toBe('Bank import');
    expect(pluginCommands().some((c) => c.id === 'openbook.ledger/setup-books' && c.title === 'Ledger: set up books')).toBe(true);
    // …and the enumeration is complete in the other direction too: every block
    // named above is live, and there are exactly this many.
    for (const type of ALL_LEDGER_BLOCKS) expect(getCustomBlock(`openbook.ledger/${type}`), type).toBeDefined();
    expect(ALL_LEDGER_BLOCKS).toHaveLength(8);

    // Disable → every block and the command tear down with the plugin. This
    // list must stay EXHAUSTIVE: a block registered but never torn down leaks
    // into whatever renders next, and the only thing that catches it is naming
    // every single one here.
    await syncPlugins({listPlugins: async () => []} as unknown as DataClient);
    for (const type of ALL_LEDGER_BLOCKS) expect(getCustomBlock(`openbook.ledger/${type}`), type).toBeUndefined();
    expect(pluginCommands().some((c) => c.id === 'openbook.ledger/setup-books')).toBe(false);
  });

  describe('computeEntryStatus — the pure Post gate', () => {
    const status = (): ComputeEntryStatus => loadModule().exports.computeEntryStatus as ComputeEntryStatus;

    it('gates on ≥2 rows', () => {
      const compute = status();
      const one = compute([row('a1', '10.00')]);
      expect(one.canPost).toBe(false);
      expect(one.problem).toBe('too-few-rows');
      expect(compute([]).canPost).toBe(false);
    });

    it('gates on every row complete (account + valid single-column amount)', () => {
      const compute = status();
      // Missing account.
      expect(compute([row('', '10.00'), row('a2', '', '10.00')]).problem).toBe('incomplete-rows');
      // Empty amount.
      expect(compute([row('a1'), row('a2', '', '10.00')]).problem).toBe('incomplete-rows');
      // Unparseable text, zero, negative, and both-columns-filled are invalid.
      for (const bad of [row('a1', 'ten dollars'), row('a1', '0'), row('a1', '-5.00'), row('a1', '5.00', '5.00')]) {
        const s = compute([bad, row('a2', '', '10.00')]);
        expect(s.rows[0].invalid).toBe(true);
        expect(s.canPost).toBe(false);
      }
    });

    it('gates on Σ = 0 and reports magnitude + side of the imbalance', () => {
      const compute = status();
      const heavy = compute([row('a1', '2,500.00'), row('a2', '', '2,000.00')]);
      expect(heavy.canPost).toBe(false);
      expect(heavy.problem).toBe('unbalanced');
      expect(heavy.sumMinor).toBe(50000); // debits exceed credits by 500.00
      expect(heavy.debitMinor).toBe(250000);
      expect(heavy.creditMinor).toBe(200000);

      const light = compute([row('a1', '1.00'), row('a2', '', '3.00')]);
      expect(light.sumMinor).toBe(-200); // credits exceed by 2.00
      expect(light.balanced).toBe(false);
    });

    it('opens the gate for a balanced 3-row compound entry (and integer minor units)', () => {
      const {exports} = loadModule();
      const compute = exports.computeEntryStatus as ComputeEntryStatus;
      const toPostings = exports.rowsToPostings as RowsToPostings;
      const rows = [row('exp', '2,500.00', '', 'gross'), row('bank', '', '2,000.00', 'net'), row('tax', '', '500.00', 'withheld')];
      const s = compute(rows);
      expect(s.balanced).toBe(true);
      expect(s.canPost).toBe(true);
      expect(s.problem).toBeNull();
      expect(s.sumMinor).toBe(0);

      // LGR-16: the memo travels WITH the leg, as real posting data.
      const postings = toPostings(rows);
      expect(postings).toEqual([
        {accountId: 'exp', amountMinor: 250000, memo: 'gross'},
        {accountId: 'bank', amountMinor: -200000, memo: 'net'},
        {accountId: 'tax', amountMinor: -50000, memo: 'withheld'},
      ]);
      for (const p of postings) expect(Number.isInteger(p.amountMinor)).toBe(true);
    });

    it('sends a blank memo as null — the server stores it that way, so the round trip is identity (LGR-16)', () => {
      const toPostings = loadModule().exports.rowsToPostings as RowsToPostings;
      expect(toPostings([row('a1', '1.00', '', '   '), row('a2', '', '1.00')])).toEqual([
        {accountId: 'a1', amountMinor: 100, memo: null},
        {accountId: 'a2', amountMinor: -100, memo: null},
      ]);
    });

    it('parses ONLY through the money core (symbols/grouping ok, floats never)', () => {
      const compute = status();
      const s = compute([row('a1', '$1,234.56'), row('a2', '', '1234.56')]);
      expect(s.balanced).toBe(true);
      expect(s.rows[0].amountMinor).toBe(123456);
      // parseAmount grammar rejects what Number() would happily accept.
      expect(compute([row('a1', '1e3'), row('a2', '', '10.00')]).rows[0].invalid).toBe(true);
      expect(compute([row('a1', '0x10'), row('a2', '', '10.00')]).rows[0].invalid).toBe(true);
      expect(compute([row('a1', 'Infinity'), row('a2', '', '10.00')]).rows[0].invalid).toBe(true);
    });
  });

  describe('the Post gate always says why (D1/D2/D8) and the date is part of it (C4)', () => {
    const mod = (): Record<string, unknown> => loadModule().exports;

    it('names every disabled reason in words', () => {
      const exports = mod();
      const compute = exports.computeEntryStatus as ComputeEntryStatus;
      const why = exports.describeProblem as Describe;

      expect(why(compute([row('a1', '10.00')]))).toMatch(/at least two rows/i);
      expect(why(compute([row('', '10.00'), row('a2', '', '10.00')]))).toMatch(/needs an account and one amount/i);
      expect(why(compute([row('a1', '5.00', '5.00'), row('a2', '', '10.00')]))).toBe('Row 1: enter a debit or a credit, not both.');
      expect(why(compute([row('a1', 'ten'), row('a2', '', '10.00')]))).toMatch(/^Row 1: that amount can’t be read/);
      expect(why(compute([row('a1', '10.00'), row('a2', '', '4.00')]))).toMatch(/debits exceed credits by 6\.00/);
      // Ready to post → nothing to say.
      expect(why(compute([row('a1', '10.00'), row('a2', '', '10.00')]))).toBeNull();
    });

    it('stays quiet about imbalance until two rows carry an amount (D2)', () => {
      const exports = mod();
      const compute = exports.computeEntryStatus as ComputeEntryStatus;
      const loud = exports.describeImbalance as Describe;

      // First keystrokes: no alarm, even though Σ ≠ 0.
      expect(compute([row('a1', '2'), row('a2')]).valuedRowCount).toBe(1);
      expect(loud(compute([row('a1', '2'), row('a2')]))).toBeNull();
      // Second amount lands and they disagree → the alarm is earned.
      expect(loud(compute([row('a1', '2.00'), row('a2', '', '1.00')]))).toMatch(/exceed/);
    });

    it('closes the gate on an unusable date and reopens on a real one (C4)', () => {
      const compute = mod().computeEntryStatus as ComputeEntryStatus;
      const balanced = [row('a1', '10.00'), row('a2', '', '10.00')];
      expect(compute(balanced, '').canPost).toBe(false);
      expect(compute(balanced, '').problem).toBe('invalid-date');
      expect(compute(balanced, '2026-02-30').canPost).toBe(false); // not a real calendar day
      expect(compute(balanced, '2026-02-28').canPost).toBe(true);
      // Omitted date = "don't ask" (rows-only callers are unaffected).
      expect(compute(balanced).canPost).toBe(true);
    });

    it('parseCell: blank-ish text is empty, never invalid (Quinn nit)', () => {
      const parseCell = mod().parseCell as ParseCell;
      expect(parseCell(' ')).toBeNull();
      expect(parseCell('')).toBeNull();
      expect(parseCell('\t\n ')).toBeNull();
      expect(parseCell('12.34')).toBe(1234);
      expect(parseCell('nope')).toBe('invalid');
    });

    it('mergeMemosFromDraft re-attaches STORED memos to the local rows, or nothing at all (LGR-16)', () => {
      const merge = mod().mergeMemosFromDraft as MergeMemos;
      // The block-props workaround is gone: raw amount text is local, memos come
      // back from the postings. Row 2 has no amount, so it is not a posting and
      // does not consume one.
      // …so it keeps whatever it holds locally, while the two legs that ARE
      // postings take their memo from the books.
      const rows = [row('a1', '10.00'), row('', '', '', 'typed but unsaved'), row('a2', '', '10.00', 'stale')];
      expect(merge(rows, [{memo: 'from the books'}, {memo: null}])).toEqual([
        row('a1', '10.00', '', 'from the books'),
        row('', '', '', 'typed but unsaved'),
        row('a2', '', '10.00', ''),
      ]);
      // Counts disagree (the draft changed elsewhere) → merge NOTHING rather
      // than show a memo against the wrong leg.
      const mismatched = merge(rows, [{memo: 'only one'}]);
      expect(mismatched).toBe(rows);
      // No postings at all is the same conservative no-op.
      expect(merge([row('a1', '1.00'), row('a2', '', '1.00')], [])).toEqual([row('a1', '1.00'), row('a2', '', '1.00')]);
    });

    it('normalizeCell settles readable amounts and leaves the rest alone (D3)', () => {
      const normalize = mod().normalizeCell as NormalizeCell;
      expect(normalize('2000')).toBe('2,000.00');
      expect(normalize('$1,234.5')).toBe('1,234.50');
      expect(normalize('')).toBe('');
      expect(normalize('12.')).toBe('12.'); // mid-edit text is never eaten
    });
  });

  describe('setUpBooks — idempotent seeding', () => {
    it('creates the starter chart once; a second run creates nothing', async () => {
      const {exports} = loadModule();
      const setUpBooks = exports.setUpBooks as (ledger: unknown) => Promise<{created: number}>;
      const chart = exports.STARTER_CHART as StarterChart;

      const accounts: LedgerAccount[] = [];
      const ledger = {
        init: vi.fn(async () => ({exists: true, hostPageId: 'host', databases: null})),
        listAccounts: vi.fn(async () => [...accounts]),
        createAccount: vi.fn(async (input: {name: string; type: LedgerAccount['type']}) => {
          const account: LedgerAccount = {
            id: `acct-${accounts.length}`,
            name: input.name,
            type: input.type,
            status: 'open',
            currency: 'USD',
            createdAt: new Date(0).toISOString(),
            updatedAt: new Date(0).toISOString(),
          };
          accounts.push(account);
          return account;
        }),
      };

      const first = await setUpBooks(ledger);
      expect(first.created).toBe(chart.length);
      expect(accounts.map((a) => a.name)).toEqual(chart.map((c) => c.name));
      expect(accounts.find((a) => a.name === 'Expenses:Bank Fees')?.type).toBe('expense');
      expect(accounts.find((a) => a.name === 'Income:Revenue')?.type).toBe('revenue');

      const second = await setUpBooks(ledger);
      expect(second.created).toBe(0);
      expect(accounts).toHaveLength(chart.length); // no dupes
      expect(ledger.init).toHaveBeenCalledTimes(2); // init itself is server-idempotent
    });
  });
});

/**
 * LGR-10 — the bank CSV importer, driven through the REAL plugin loader.
 *
 * The block itself is IO and rendering; everything that can be got wrong lives
 * in the pure `importModel.ts` and is pinned here: money scale, sign, dates,
 * dedup, and the behaviour of a file that arrived from the internet.
 */
describe('LGR-10 — bank CSV import (real source through the real loader)', () => {
  interface ColumnMapping {date: number; amount: number; description: number}
  type Denomination = 'major' | 'minor';
  type SignConvention = 'outflow-negative' | 'outflow-positive';
  type DateFormat = 'iso' | 'mdy' | 'dmy' | 'dmy-dot';
  interface SourceProfile {
    sourceId: string;
    label: string;
    accountId: string;
    mapping: ColumnMapping;
    dateFormat: DateFormat;
    sign: SignConvention;
    denomination: Denomination | null;
  }
  interface PreparedRow {
    line: number;
    date: string | null;
    amountMinor: number | null;
    rawAmount: string;
    description: string;
    normalizedDescription: string;
    hash: string | null;
    status: 'new' | 'duplicate' | 'duplicate-draft' | 'near-duplicate' | 'error';
    problem: string | null;
    suggestedAccountId: string | null;
  }
  interface PreparedImport {
    rows: PreparedRow[];
    counts: Record<'new' | 'duplicate' | 'duplicate-draft' | 'near-duplicate' | 'error', number>;
    importable: boolean;
  }
  interface KnownImports {counts: Record<string, number>; draftCounts: Record<string, number>; descriptionsByDateAmount: Record<string, string[]>}
  type AmountResult = {ok: true; minor: number} | {ok: false; problem: string};

  const mod = (): Record<string, unknown> => loadModule().exports;
  const parse = (text: string): {ok: boolean; matrix?: string[][]; problem?: string} =>
    (mod().readImportCsv as (t: string) => {ok: boolean; matrix?: string[][]; problem?: string})(text);
  interface DetectionNote {text: string; severity: 'note' | 'ask'; topic: 'columns' | 'date' | 'scale' | 'sign'}
  interface Detection {mapping: ColumnMapping; dateFormat: DateFormat; sign: SignConvention; denomination: Denomination | null; notes: DetectionNote[]}
  const detect = (matrix: string[][]): Detection => (mod().detectProfile as (m: string[][]) => Detection)(matrix);
  const prepare = (matrix: string[][], profile: SourceProfile, known?: KnownImports, rules?: Record<string, string>): PreparedImport =>
    (mod().prepareImport as (m: string[][], p: SourceProfile, k?: KnownImports, r?: Record<string, string>) => PreparedImport)(matrix, profile, known, rules);
  /** What the ledger holds, as the block reads it back. `state` defaults to the
   *  posted (on-the-books) case; the draft and void cases are exercised below. */
  const knownFrom = (
    rows: Array<{date: string | null; description: string; amountMinor: number | null; state?: string; id?: string}>,
    sourceId: string,
  ): KnownImports =>
    (mod().knownFromTransactions as (t: unknown[], s: {sourceId: string; accountId: string}) => KnownImports)(
      rows.map((r, i) => ({
        id: r.id ?? `tx-${i}`,
        state: r.state ?? 'posted',
        date: r.date,
        description: r.description,
        postings: [{accountId: 'acct-bank', amountMinor: r.amountMinor}],
      })),
      {sourceId, accountId: 'acct-bank'},
    );
  const profileFor = (matrix: string[][], over: Partial<SourceProfile> = {}): SourceProfile => {
    const d = detect(matrix);
    return {
      sourceId: (mod().sourceIdForHeader as (h: string[]) => string)(matrix[0]),
      label: 'test.csv',
      accountId: 'acct-bank',
      mapping: d.mapping,
      dateFormat: d.dateFormat,
      sign: d.sign,
      denomination: d.denomination,
      ...over,
    };
  };
  const matrixOf = (text: string): string[][] => {
    const read = parse(text);
    expect(read.ok).toBe(true);
    return read.matrix!;
  };

  const MAJOR_CSV = [
    'Date,Description,Amount',
    '2026-03-01,BLUE BOTTLE #12,-4.50',
    '2026-03-02,ACME PAYROLL,"2,500.00"',
    '2026-03-03,"WIDGETS, INC",-19.99',
  ].join('\n');

  // Stripe-style: the header NAMES the scale, so "1234" is 12.34 — not 1,234.00.
  const MINOR_CSV = [
    'Posted Date,Details,Amount (cents)',
    '2026-03-01,BLUE BOTTLE #12,-450',
    '2026-03-02,ACME PAYROLL,250000',
  ].join('\n');

  describe('profile detection — nothing about money is ever guessed', () => {
    it('maps the columns by header name and says what it decided', () => {
      const d = detect(matrixOf(MAJOR_CSV));
      expect(d.mapping).toEqual({date: 0, amount: 2, description: 1});
      expect(d.dateFormat).toBe('iso');
      expect(d.notes.map((n) => n.text).join(' ')).toMatch(/Date from "Date"/);
      expect(d.notes.map((n) => n.text).join(' ')).toMatch(/major units/i);
    });

    it('reads a MINOR-unit column at the right scale — never 100x (the LGR-2 precondition)', () => {
      const matrix = matrixOf(MINOR_CSV);
      const d = detect(matrix);
      expect(d.denomination).toBe('minor');
      expect(d.notes.map((n) => n.text).join(' ')).toMatch(/MINOR units/);

      const prepared = prepare(matrix, profileFor(matrix));
      // -450 cents is −4.50, NOT −450.00; 250000 cents is 2,500.00.
      expect(prepared.rows.map((r) => r.amountMinor)).toEqual([-450, 250000]);
      expect(prepared.counts.error).toBe(0);
    });

    it('REFUSES to guess when the scale is unestablished, and passes bareDigits explicitly', () => {
      const bareDigitsFor = mod().bareDigitsFor as (d: Denomination | null) => string;
      // The importer never inherits parseAmount's default — it always chooses.
      expect(bareDigitsFor('major')).toBe('major');
      expect(bareDigitsFor('minor')).toBe('major');
      expect(bareDigitsFor(null)).toBe('reject');

      // Decimal-point-free amounts with no naming signal: ambiguous.
      const ambiguous = matrixOf(['Date,Description,Amount', '2026-03-01,COFFEE,-450', '2026-03-02,PAY,250000'].join('\n'));
      const d = detect(ambiguous);
      expect(d.denomination).toBeNull();
      expect(d.notes.map((n) => n.text).join(' ')).toMatch(/ambiguous/i);

      // …and with the scale unchosen, every bare row REJECTS rather than
      // importing at a guessed magnitude.
      const prepared = prepare(ambiguous, profileFor(ambiguous));
      expect(prepared.counts.error).toBe(2);
      expect(prepared.counts.new).toBe(0);
      expect(prepared.importable).toBe(false);
      expect(prepared.rows[0].problem).toMatch(/no decimal point/);

      // A cell that DOES carry a decimal point is unambiguous and still imports
      // even while the column's scale is unchosen.
      const mixed = matrixOf(['Date,Description,Amount', '2026-03-01,COFFEE,-4.50', '2026-03-02,PAY,250000'].join('\n'));
      const half = prepare(mixed, profileFor(mixed, {denomination: null}));
      expect(half.counts.error).toBe(1);
      expect(half.rows[0].amountMinor).toBe(-450);
    });

    it('detects the sign convention and honours an override', () => {
      const matrix = matrixOf(MAJOR_CSV);
      expect(detect(matrix).sign).toBe('outflow-negative');
      const flipped = prepare(matrix, profileFor(matrix, {sign: 'outflow-positive'}));
      expect(flipped.rows.map((r) => r.amountMinor)).toEqual([450, -250000, 1999]);
      // A file with no negatives says so, rather than silently assuming.
      const allPositive = matrixOf(['Date,Description,Amount', '2026-03-01,COFFEE,4.50'].join('\n'));
      expect(detect(allPositive).notes.map((n) => n.text).join(' ')).toMatch(/No negative amounts seen/);
    });

    it('settles DD/MM vs MM/DD from the data, and says when it cannot', () => {
      const dmy = matrixOf(['Date,Description,Amount', '25/03/2026,A,-1.00'].join('\n'));
      expect(detect(dmy).dateFormat).toBe('dmy');
      expect(prepare(dmy, profileFor(dmy)).rows[0].date).toBe('2026-03-25');

      const mdy = matrixOf(['Date,Description,Amount', '03/25/2026,A,-1.00'].join('\n'));
      expect(detect(mdy).dateFormat).toBe('mdy');
      expect(prepare(mdy, profileFor(mdy)).rows[0].date).toBe('2026-03-25');

      const ambiguous = matrixOf(['Date,Description,Amount', '03/04/2026,A,-1.00'].join('\n'));
      expect(detect(ambiguous).dateFormat).toBe('mdy');
      expect(detect(ambiguous).notes.map((n) => n.text).join(' ')).toMatch(/ambiguous/i);
      // The override is honoured, and lands on a different day — which is
      // exactly why the ambiguity is stated out loud.
      const asDmy = prepare(ambiguous, profileFor(ambiguous, {dateFormat: 'dmy'}));
      expect(asDmy.rows[0].date).toBe('2026-04-03');
    });
  });

  describe('a SAVED profile never silently overrides the evidence in the file', () => {
    const validate = (raw: unknown, ctx: {sourceId: string; accountIds: string[]; columnCount: number}): SourceProfile | null =>
      (mod().validateStoredProfile as (r: unknown, c: unknown) => SourceProfile | null)(raw, ctx);
    const reconcile = (saved: SourceProfile, detected: Detection, accountName: string): {profile: SourceProfile; notes: DetectionNote[]} =>
      (mod().reconcileSavedProfile as (s: SourceProfile, d: Detection, n: string) => {profile: SourceProfile; notes: DetectionNote[]})(saved, detected, accountName);
    const CTX = {sourceId: 's1', accountIds: ['acct-bank', 'acct-coffee'], columnCount: 3};
    const GOOD = {
      sourceId: 'stale',
      label: 'march.csv',
      accountId: 'acct-bank',
      mapping: {date: 0, amount: 2, description: 1},
      dateFormat: 'iso' as DateFormat,
      sign: 'outflow-negative' as SignConvention,
      denomination: 'major' as Denomination,
    };

    it('storage is untrusted: a malformed profile falls back to fresh detection', () => {
      expect(validate(GOOD, CTX)?.sourceId).toBe('s1'); // the caller's id wins
      expect(validate(GOOD, CTX)?.accountId).toBe('acct-bank');
      for (const bad of [
        null,
        'not an object',
        {...GOOD, mapping: {date: 0, amount: 3, description: 1}}, // past the header
        {...GOOD, mapping: {date: -2, amount: 1, description: 1}}, // below "not mapped"
        {...GOOD, mapping: {date: 0.5, amount: 1, description: 1}}, // not an integer
        {...GOOD, mapping: undefined},
        {...GOOD, accountId: 'acct-deleted'}, // no such account any more
        {...GOOD, accountId: 42},
        {...GOOD, dateFormat: 'ymd'},
        {...GOOD, sign: 'whatever'},
        {...GOOD, denomination: 'micro'},
      ]) {
        expect(validate(bad, CTX)).toBeNull();
      }
      // `null` denomination is a legitimate stored state, not a malformed one.
      expect(validate({...GOOD, denomination: null}, CTX)?.denomination).toBeNull();
    });

    it('a scale change under an UNCHANGED header re-opens the scale question', () => {
      // The concrete case: same bank, same columns, amounts switched from -4.50
      // to -450. Same sourceId ⇒ same saved profile ⇒ every amount 100x wrong,
      // with the old UI saying "Nothing needed re-mapping."
      const cents = matrixOf(['Date,Description,Amount (cents)', '2026-03-01,COFFEE,-450'].join('\n'));
      const detected = detect(cents);
      expect(detected.denomination).toBe('minor');

      const merged = reconcile(GOOD, detected, 'Assets:Bank:Checking');
      // Back to null — which fires the SAME hard block a fresh ambiguous file
      // gets. Nothing imports until a human chooses.
      expect(merged.profile.denomination).toBeNull();
      const asks = merged.notes.filter((n) => n.severity === 'ask');
      expect(asks.some((n) => /CENTS/.test(n.text) && /saved/.test(n.text))).toBe(true);
    });

    it('detection is ALWAYS narrated, and the reuse notice names the ACCOUNT, not a file', () => {
      const matrix = matrixOf(MAJOR_CSV);
      const detected = detect(matrix);
      const merged = reconcile(GOOD, detected, 'Assets:Bank:Checking');
      const text = merged.notes.map((n) => n.text).join(' ');
      // Every detection sentence survives the merge…
      for (const note of detected.notes) expect(text).toContain(note.text);
      // …and the reuse line says where the money is about to land.
      expect(text).toContain('importing into Assets:Bank:Checking');
      expect(text).not.toContain('Nothing needed re-mapping');
      // Agreement is quiet: no scale conflict, no date conflict.
      expect(merged.notes.filter((n) => n.severity === 'ask')).toEqual([]);
      expect(merged.profile.denomination).toBe('major');
    });

    it('NO decimal point anywhere is the case this guard exists for — and it must not print a lie', () => {
      // The exact regression: a bank switches "-4.50" to "-450" without renaming
      // a column. That file has no decimal point ANYWHERE, so detection reports
      // `null` — not `minor` — and a guard keyed on `detected !== null` never
      // fired: the saved `major` stood and every row imported 100x high.
      const bare = matrixOf(['Date,Description,Amount', '2026-03-01,COFFEE,-450', '2026-03-02,PAY,250000'].join('\n'));
      const detected = detect(bare);
      expect(detected.denomination).toBeNull();

      const merged = reconcile(GOOD, detected, 'Assets:Bank:Checking');
      // The saved answer is still USED — an always-bare-integer bank must not be
      // re-interrogated every month…
      expect(merged.profile.denomination).toBe('major');
      const texts = merged.notes.map((n) => n.text);
      // …but detection's line about it is GONE, because the profile in force
      // contradicts it. Printing "Nothing is imported until you do" above a live
      // Create button is a louder failure than the silence it replaced.
      expect(texts.join(' ')).not.toContain('Nothing is imported until you do');
      expect(merged.notes.filter((n) => n.topic === 'scale')).toHaveLength(1);
      // What replaces it says what is actually happening, and asks for a check.
      const scale = merged.notes.find((n) => n.topic === 'scale')!;
      expect(scale.severity).toBe('ask');
      expect(scale.text).toContain('no decimal point');
      expect(scale.text).toContain('dollars');
      expect(scale.text).toMatch(/check one row/i);
      // Every OTHER detection line still passes through untouched.
      for (const note of detected.notes.filter((n) => n.topic !== 'scale')) expect(texts).toContain(note.text);
    });

    it('a real CONFLICT still re-opens the scale, and keeps the note that justifies it', () => {
      const cents = matrixOf(['Date,Description,Amount (cents)', '2026-03-01,COFFEE,-450'].join('\n'));
      const merged = reconcile(GOOD, detect(cents), 'Assets:Bank:Checking');
      expect(merged.profile.denomination).toBeNull();
      // Detection's own scale sentence describes the FILE and is still true —
      // it is the evidence for the conflict — so it stays alongside the ask.
      expect(merged.notes.filter((n) => n.topic === 'scale')).toHaveLength(2);
      expect(merged.notes.map((n) => n.text).join(' ')).toContain('MINOR units');
    });

    it('with no saved answer either, the ambiguity note is exactly what detection said', () => {
      const bare = matrixOf(['Date,Description,Amount', '2026-03-01,COFFEE,-450'].join('\n'));
      const detected = detect(bare);
      const merged = reconcile({...GOOD, denomination: null}, detected, 'Assets:Bank:Checking');
      expect(merged.profile.denomination).toBeNull();
      // Nothing was overridden, so nothing is suppressed: the block IS accurate.
      expect(merged.notes.map((n) => n.text).join(' ')).toContain('Nothing is imported until you do');
    });

    it('a date-format disagreement is raised loudly, but never blocks', () => {
      const dmy = matrixOf(['Date,Description,Amount', '25/03/2026,A,-1.00'].join('\n'));
      const merged = reconcile(GOOD, detect(dmy), 'Assets:Bank:Checking'); // saved says ISO
      expect(merged.profile.dateFormat).toBe('iso'); // the user's own choice stands
      expect(merged.notes.some((n) => n.severity === 'ask' && /DD\/MM\/YYYY/.test(n.text))).toBe(true);
    });

    it('ONE decimal cell in a column no longer settles the scale for the whole file', () => {
      // The asymmetry ran the wrong way: a single "-4.50" among bare integers
      // concluded 'major', and every bare cell then imported 100x high.
      const mixed = matrixOf(
        ['Date,Description,Amount', '2026-03-01,ONE,-4.50', '2026-03-02,TWO,250000', '2026-03-03,THREE,-1200'].join('\n'),
      );
      const d = detect(mixed);
      expect(d.denomination).toBeNull();
      expect(d.notes.some((n) => n.severity === 'ask' && /MIXES shapes/.test(n.text))).toBe(true);
      // …and the file behaves exactly like any other unestablished scale: the
      // unambiguous cell imports, the bare ones reject.
      const prepared = prepare(mixed, profileFor(mixed));
      expect(prepared.rows[0].amountMinor).toBe(-450);
      expect(prepared.counts.error).toBe(2);
      // An all-decimal column is still settled without a question.
      expect(detect(matrixOf(MAJOR_CSV)).denomination).toBe('major');
    });
  });

  describe('dedup', () => {
    it('re-importing the SAME file produces ZERO new rows', () => {
      const matrix = matrixOf(MAJOR_CSV);
      const profile = profileFor(matrix);
      const first = prepare(matrix, profile);
      expect(first.counts.new).toBe(3);

      // What the ledger holds after that import, read back the way the block
      // reads it — not a local record of "what we think we imported".
      const known = knownFrom(first.rows, profile.sourceId);
      const second = prepare(matrix, profile, known);
      expect(second.counts.new).toBe(0);
      expect(second.counts.duplicate).toBe(3);
      expect(second.importable).toBe(false);
      expect((mod().importableRows as (p: PreparedImport) => PreparedRow[])(second)).toEqual([]);
    });

    it('a genuinely repeated transaction in ONE file imports twice, and still dedups on re-import', () => {
      // Two identical 3.20 coffees on one day are two transactions, not a
      // mistake — dedup counts occurrences rather than collapsing to a set.
      const matrix = matrixOf(['Date,Description,Amount', '2026-03-01,COFFEE,-3.20', '2026-03-01,COFFEE,-3.20'].join('\n'));
      const profile = profileFor(matrix);
      const first = prepare(matrix, profile);
      expect(first.counts.new).toBe(2);
      expect(prepare(matrix, profile, knownFrom(first.rows, profile.sourceId)).counts.duplicate).toBe(2);
    });

    it('a NEAR-duplicate (same date + amount, different wording) WARNS but is allowed', () => {
      const matrix = matrixOf(['Date,Description,Amount', '2026-03-01,SQ *BLUE BOTTLE 12,-4.50'].join('\n'));
      const profile = profileFor(matrix);
      const known = knownFrom([{date: '2026-03-01', description: 'BLUE BOTTLE PENDING', amountMinor: -450}], profile.sourceId);
      const prepared = prepare(matrix, profile, known);
      expect(prepared.counts['near-duplicate']).toBe(1);
      expect(prepared.counts.duplicate).toBe(0);
      // ALLOWED: it is still importable, and it still says so out loud.
      expect(prepared.importable).toBe(true);
      expect((mod().importableRows as (p: PreparedImport) => PreparedRow[])(prepared)).toHaveLength(1);
      expect(prepared.rows[0].problem).toMatch(/same date and amount/);
    });

    it('the dedup key is (source, date, amount, normalized description) — each part matters', () => {
      const hash = mod().importRowHash as (p: {sourceId: string; date: string; amountMinor: number; normalizedDescription: string}) => string;
      const base = {sourceId: 's1', date: '2026-03-01', amountMinor: -450, normalizedDescription: 'blue bottle 12'};
      expect(hash(base)).toBe(hash({...base}));
      for (const differing of [{sourceId: 's2'}, {date: '2026-03-02'}, {amountMinor: -451}, {normalizedDescription: 'other'}]) {
        expect(hash({...base, ...differing})).not.toBe(hash(base));
      }
      // Case and spacing are NOT part of the identity — one payee, one key.
      const normalize = mod().normalizeDescription as (s: string) => string;
      expect(normalize('SQ *BLUE BOTTLE  #12')).toBe(normalize('sq blue bottle 12'));
    });

    it('a NON-LATIN payee is a payee: two different ones never collapse into a duplicate', () => {
      const normalize = mod().normalizeDescription as (s: string) => string;
      // An ASCII-only class erased these to '' — and an empty normalized
      // description makes every entry with the same date and amount look like
      // the same transaction.
      expect(normalize('Кофейня')).toBe('кофейня');
      expect(normalize('コーヒー')).not.toBe('');
      expect(normalize('Кофейня')).not.toBe(normalize('Магазин'));
      // NFKC first, so the two spellings of `café` are one payee.
      expect(normalize('café')).toBe(normalize('café'));

      // The failure that mattered: a DIFFERENT Cyrillic payee, same day, same
      // money — a genuine transaction that used to be silently skipped as
      // "already on the books".
      const matrix = matrixOf(['Date,Description,Amount', '2026-03-01,Магазин,-5.00'].join('\n'));
      const profile = profileFor(matrix);
      const known = knownFrom([{date: '2026-03-01', description: 'Кофейня', amountMinor: -500}], profile.sourceId);
      const prepared = prepare(matrix, profile, known);
      expect(prepared.counts.duplicate).toBe(0);
      expect(prepared.counts['near-duplicate']).toBe(1); // flagged, but IMPORTED
      expect(prepared.importable).toBe(true);

      // …and two unrelated non-Latin banks no longer share one saved profile
      // (which would mean sharing its accountId).
      const sourceId = mod().sourceIdForHeader as (h: string[]) => string;
      expect(sourceId(['Дата', 'Сумма', 'Описание'])).not.toBe(sourceId(['日付', '金額', '摘要']));
    });
  });

  describe('the draft lifecycle — an interrupted import is resumable, not a dead end', () => {
    const strandedFor = (
      transactions: Array<{id: string; state: string; date: string; description: string; postings: Array<{accountId: string; amountMinor: number}>}>,
      sourceId: string,
      rules: Record<string, string> = {},
    ): Array<{draftId: string; bankAccountId: string; row: PreparedRow}> =>
      (mod().strandedDrafts as (t: unknown[], s: {sourceId: string; accountId: string}, r?: Record<string, string>) => Array<{draftId: string; bankAccountId: string; row: PreparedRow}>)(
        transactions,
        {sourceId, accountId: 'acct-bank'},
        rules,
      );

    it('an unfinished DRAFT is not "on the books" — it gets its own verdict', () => {
      const matrix = matrixOf(MAJOR_CSV);
      const profile = profileFor(matrix);
      const first = prepare(matrix, profile);
      // Everything imported, nothing categorised yet: three one-legged drafts.
      const known = knownFrom(
        first.rows.map((r) => ({date: r.date, description: r.description, amountMinor: r.amountMinor, state: 'draft'})),
        profile.sourceId,
      );
      const second = prepare(matrix, profile, known);
      // Still ZERO new — dedup counts drafts exactly as before…
      expect(second.counts.new).toBe(0);
      expect(second.importable).toBe(false);
      // …but it no longer claims they are on the books, which is what made the
      // re-upload a dead end: "already imported" + Create 0 drafts + no list.
      expect(second.counts.duplicate).toBe(0);
      expect(second.counts['duplicate-draft']).toBe(3);
      expect(second.rows[0].problem).toMatch(/draft for this row is already waiting/);
      expect((mod().describeImport as (p: PreparedImport) => string)(second)).toBe('0 new · 3 already drafted.');
    });

    it('a VOIDED entry does not suppress its row — re-importing IS the repair', () => {
      const matrix = matrixOf(MAJOR_CSV);
      const profile = profileFor(matrix);
      const rows = prepare(matrix, profile).rows;
      const voided = knownFrom(
        rows.map((r) => ({date: r.date, description: r.description, amountMinor: r.amountMinor, state: 'void'})),
        profile.sourceId,
      );
      const again = prepare(matrix, profile, voided);
      expect(again.counts.new).toBe(3);
      expect(again.counts.duplicate + again.counts['duplicate-draft']).toBe(0);
      expect(again.importable).toBe(true);
    });

    it('the ledger hands back the stranded one-legged drafts, ready to categorise', () => {
      const matrix = matrixOf(MAJOR_CSV);
      const profile = profileFor(matrix);
      const learn = mod().learnRule as (r: Record<string, string>, d: string, a: string) => Record<string, string>;
      const normalize = mod().normalizeDescription as (s: string) => string;
      const rules = learn({}, normalize('BLUE BOTTLE #12'), 'acct-coffee');

      const stranded = strandedFor(
        [
          {id: 'd1', state: 'draft', date: '2026-03-01', description: 'BLUE BOTTLE #12', postings: [{accountId: 'acct-bank', amountMinor: -450}]},
          // Two legs: already categorised (or somebody else's entry) — left alone.
          {id: 'd2', state: 'draft', date: '2026-03-02', description: 'DONE', postings: [{accountId: 'acct-bank', amountMinor: -100}, {accountId: 'acct-coffee', amountMinor: 100}]},
          // A different bank account is a different statement.
          {id: 'd3', state: 'draft', date: '2026-03-03', description: 'OTHER BANK', postings: [{accountId: 'acct-savings', amountMinor: -100}]},
          // Posted entries are finished business.
          {id: 'd4', state: 'posted', date: '2026-03-04', description: 'POSTED', postings: [{accountId: 'acct-bank', amountMinor: -100}]},
        ],
        profile.sourceId,
        rules,
      );
      expect(stranded.map((d) => d.draftId)).toEqual(['d1']);
      // The draft carries its OWN bank account, so confirming it can never be
      // redirected by whatever the account dropdown happens to say later.
      expect(stranded[0].bankAccountId).toBe('acct-bank');
      expect(stranded[0].row.amountMinor).toBe(-450);
      expect(stranded[0].row.description).toBe('BLUE BOTTLE #12');
      // The remembered category comes back with it, so resuming is one click.
      expect(stranded[0].row.suggestedAccountId).toBe('acct-coffee');
      // …and it round-trips into a balanced confirm patch, same as a fresh row.
      const confirm = mod().buildConfirmPatch as (r: PreparedRow, p: SourceProfile, a: string) => {postings: Array<{amountMinor: number}>};
      expect(confirm(stranded[0].row, profile, 'acct-coffee').postings.reduce((n, x) => n + x.amountMinor, 0)).toBe(0);
      // No account selected yet ⇒ nothing to rehydrate (and no accidental match).
      expect(
        (mod().strandedDrafts as (t: unknown[], s: {sourceId: string; accountId: string}) => unknown[])(
          [{id: 'd1', state: 'draft', date: '2026-03-01', description: 'X', postings: [{accountId: '', amountMinor: -1}]}],
          {sourceId: profile.sourceId, accountId: ''},
        ),
      ).toEqual([]);
    });

    it('a MID-LOOP failure strands rows on the server — the retry must not create them twice', () => {
      // The block creates drafts one row at a time. A reject at row k leaves
      // rows 1..k-1 written. `created` is hoisted out of the try precisely so
      // the catch can show them AND re-read the ledger; this pins the contract
      // that re-read depends on — the partial write is recognised, so pressing
      // the button again imports the REMAINDER and not the whole file.
      const matrix = matrixOf(MAJOR_CSV);
      const profile = profileFor(matrix);
      const all = prepare(matrix, profile).rows;
      expect(all).toHaveLength(3);

      const k = 2; // rows 1..1 landed, row 2 rejected
      const partial = knownFrom(
        all.slice(0, k - 1).map((r) => ({date: r.date, description: r.description, amountMinor: r.amountMinor, state: 'draft'})),
        profile.sourceId,
      );
      const retry = prepare(matrix, profile, partial);
      expect(retry.rows[0].status).toBe('duplicate-draft');
      expect(retry.counts['duplicate-draft']).toBe(k - 1);
      expect(retry.counts.new).toBe(all.length - (k - 1));
      // The retry creates only what is missing — never the rows already written.
      expect((mod().importableRows as (p: PreparedImport) => PreparedRow[])(retry).map((r) => r.line)).toEqual([2, 3]);
    });
  });

  describe('description to account memory', () => {
    it('suggests the last-used account and learns on confirm', () => {
      const learn = mod().learnRule as (r: Record<string, string>, d: string, a: string) => Record<string, string>;
      const normalize = mod().normalizeDescription as (s: string) => string;
      const matrix = matrixOf(MAJOR_CSV);
      const profile = profileFor(matrix);

      expect(prepare(matrix, profile).rows[0].suggestedAccountId).toBeNull();
      const rules = learn({}, normalize('BLUE BOTTLE #12'), 'acct-coffee');
      expect(prepare(matrix, profile, undefined, rules).rows[0].suggestedAccountId).toBe('acct-coffee');
      // Last one wins — a payee that moves follows the user's newest decision.
      expect(learn(rules, normalize('BLUE BOTTLE #12'), 'acct-meals')[normalize('blue bottle 12')]).toBe('acct-meals');
      // Nothing is learned from an empty choice.
      expect(learn({}, '', 'acct-x')).toEqual({});
    });
  });

  describe('draft payloads — integer minor units, bank side filled, category prompted', () => {
    it('creates a one-legged draft with the raw statement line as the leg memo', () => {
      const matrix = matrixOf(MAJOR_CSV);
      const profile = profileFor(matrix);
      const prepared = prepare(matrix, profile);
      const build = mod().buildDraftInput as (r: PreparedRow, p: SourceProfile) => {date: string; description: string; postings: Array<{accountId: string; amountMinor: number; memo: string | null}>};
      const draft = build(prepared.rows[0], profile);
      expect(draft).toEqual({
        date: '2026-03-01',
        description: 'BLUE BOTTLE #12',
        // Deliberately ONE leg: the category is prompted, never guessed into a
        // suspense account somebody has to find and undo later. The raw
        // statement line rides along as the leg MEMO (LGR-16).
        postings: [{accountId: 'acct-bank', amountMinor: -450, memo: 'BLUE BOTTLE #12'}],
      });
      expect(Number.isInteger(draft.postings[0].amountMinor)).toBe(true);
    });

    it('confirming adds the category leg and balances EXACTLY', () => {
      const matrix = matrixOf(MAJOR_CSV);
      const profile = profileFor(matrix);
      const prepared = prepare(matrix, profile);
      const confirm = mod().buildConfirmPatch as (r: PreparedRow, p: SourceProfile, a: string) => {postings: Array<{accountId: string; amountMinor: number; memo: string | null}>};
      for (const row of prepared.rows) {
        const patch = confirm(row, profile, 'acct-coffee');
        expect(patch.postings).toHaveLength(2);
        expect(patch.postings.reduce((n, p) => n + p.amountMinor, 0)).toBe(0);
        for (const p of patch.postings) expect(Number.isInteger(p.amountMinor)).toBe(true);
      }
    });
  });

  describe('the file is hostile — malformed input never crashes', () => {
    const bankProfile = (matrix: string[][]): SourceProfile => profileFor(matrix, {denomination: 'major'});

    it('a BOM is stripped and does not break the header mapping', () => {
      const matrix = matrixOf('\ufeffDate,Description,Amount\n2026-03-01,COFFEE,-4.50');
      expect(matrix[0][0]).toBe('Date');
      expect(detect(matrix).mapping.date).toBe(0);
      expect(prepare(matrix, bankProfile(matrix)).counts.new).toBe(1);
    });

    it('CRLF endings and quoted newlines survive intact', () => {
      const matrix = matrixOf('Date,Description,Amount\r\n2026-03-01,"LINE ONE\nLINE TWO",-4.50\r\n');
      const prepared = prepare(matrix, bankProfile(matrix));
      expect(prepared.counts.new).toBe(1);
      // The embedded newline is collapsed by sanitisation, not lost.
      expect(prepared.rows[0].description).toBe('LINE ONE LINE TWO');
    });

    it('ragged rows read as empty cells, and a blank line is skipped, not reported', () => {
      const matrix = matrixOf('Date,Description,Amount\n2026-03-01,SHORT\n\n2026-03-02,OK,-1.00\n2026-03-03,EXTRA,-2.00,junk,more');
      const prepared = prepare(matrix, bankProfile(matrix));
      // Short row: no amount ⇒ a reported error, not a throw.
      expect(prepared.rows[0].status).toBe('error');
      expect(prepared.rows[0].problem).toMatch(/no amount/);
      // The blank line contributes nothing at all — it is not an error the user
      // can act on, and exporters emit them.
      expect(prepared.rows.map((r) => r.line)).toEqual([1, 3, 4]);
      // Extra columns are simply ignored.
      expect(prepared.rows[2].amountMinor).toBe(-200);
    });

    it('bad dates and thousand separators are reported per row, never thrown', () => {
      const matrix = matrixOf(
        [
          'Date,Description,Amount',
          '2026-02-30,NOT A REAL DAY,-1.00',
          'yesterday,WORDS,-1.00',
          '2026-03-01,GROUPED,"1,234.56"',
          '2026-03-02,EURO,"1.234,56"',
          '2026-03-03,SPACED,"1 234.56"',
        ].join('\n'),
      );
      const prepared = prepare(matrix, bankProfile(matrix));
      expect(prepared.counts.error).toBe(4);
      expect(prepared.rows[0].problem).toMatch(/unreadable date/); // February 30th
      expect(prepared.rows[1].problem).toMatch(/unreadable date/);
      expect(prepared.rows[2].amountMinor).toBe(123456); // valid grouping imports
      expect(prepared.rows[3].problem).toMatch(/unparseable/); // European separators: v1-unsupported
      expect(prepared.rows[4].problem).toMatch(/unparseable/); // space grouping likewise
    });

    it('control characters and formula lead-ins are handled at the right layer', () => {
      const sanitize = mod().sanitizeText as (s: string) => string;
      // C0/C1 and NUL are removed — they render as nothing and can reorder a line.
      expect(sanitize('AB\u0000C\u001BD\u009FE')).toBe('AB C D E');
      expect(sanitize('  lots   of\tspace  ')).toBe('lots of space');
      expect(sanitize('x'.repeat(5000))).toHaveLength(1000); // the ledger's own cap
      // A leading `=` is NOT mangled here: it is legitimate in a payee name, and
      // the canonical CSV export neutralizes it injectively on the way OUT.
      expect(sanitize('=SUM(A1:A9)')).toBe('=SUM(A1:A9)');
    });

    it('BIDI and invisible formatting are stripped — a line cannot lie about what it says', () => {
      const sanitize = mod().sanitizeText as (s: string) => string;
      // RLO: `Refund <RLO>00.001-` RENDERS as "Refund -100.00" while storing a
      // refund of +100.00, and the deception travels into the memo, the CSV
      // export and the content hash.
      expect(sanitize('Refund ‮00.001-')).toBe('Refund 00.001-');
      for (const invisible of ['­', '​', '‎', '‪', '‭', '⁠', '⁦', '⁩', '￹']) {
        expect(sanitize(`AB${invisible}CD`)).toBe('AB CD');
      }
      // Removing a leading bidi control can only expose a formula lead-in to the
      // export's neutraliser, never hide one.
      expect(sanitize('‮=SUM(A1:A9)')).toBe('=SUM(A1:A9)');
      // The rest of Bidi_Control and the invisible formatting neighbourhood:
      // ALM (the Arabic twin of LRM/RLM, same neutral-run reordering), the
      // Mongolian vowel separator, and the deprecated format characters.
      for (const invisible of ['\u061C', '\u180E', '\u206A', '\u206F']) {
        expect(sanitize(`AB${invisible}CD`)).toBe('AB CD');
      }
      // The TAG BLOCK — not a rendering trick at all. It is the standard channel
      // for smuggling instructions past a human into an agent, and these books
      // are MCP-readable, so a payee name is an injection surface.
      expect(sanitize('Invoice \u{E0001}\u{E0049}\u{E0067}\u{E006E}\u{E006F}\u{E0072}\u{E0065} 42')).toBe('Invoice 42');
      // Ordinary non-Latin text is untouched.
      expect(sanitize('Кофейня コーヒー café')).toBe('Кофейня コーヒー café');
    });

    it('a LARGE file is bounded, and refuses loudly rather than importing a prefix', () => {
      const limits = mod().IMPORT_LIMITS as {maxRows: number; maxLength: number; maxFieldLength: number};
      // Well within the limits: 20k rows parse and prepare without incident.
      const big = ['Date,Description,Amount', ...Array.from({length: 20_000}, (_, i) => `2026-03-01,ROW ${i},-1.00`)].join('\n');
      const matrix = matrixOf(big);
      expect(matrix).toHaveLength(20_001);
      const prepared = prepare(matrix, bankProfile(matrix));
      expect(prepared.rows).toHaveLength(20_000);
      expect(prepared.counts.new).toBe(20_000);

      // Beyond them: a sentence, not a dead tab and not a silent truncation.
      const tooMany = ['Date,Description,Amount', ...Array.from({length: limits.maxRows + 10}, () => '2026-03-01,X,-1.00')].join('\n');
      const refused = parse(tooMany);
      expect(refused.ok).toBe(false);
      expect(refused.problem).toMatch(/too many rows/);
      expect(parse(`Date\n${'x'.repeat(limits.maxLength + 1)}`).problem).toMatch(/too large/);
      expect(parse(`Date,Description,Amount\n2026-03-01,"${'y'.repeat(limits.maxFieldLength + 1)}",-1.00`).problem).toMatch(/too long/);
    });

    it('an empty or header-only file is a sentence, not a crash', () => {
      expect(parse('').problem).toMatch(/no rows/);
      expect(parse('Date,Description,Amount\n').problem).toMatch(/no transactions/);
    });

    it('PROPERTY: 5k seeded amount cells yield an exact integer or an explained error, never anything else', () => {
      // Deterministic PRNG (mulberry32) — no dependency, reproducible failures.
      let a = 0x1ed6e10a >>> 0;
      const rand = (): number => {
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
      const parseRowAmount = mod().parseRowAmount as (raw: string, d: Denomination | null, s: SignConvention) => AmountResult;

      const pieces = ['', '-', '+', '(', ')', '$', '€', '.', ',', ' ', '0', '00', '1234', '1,234', '1,234.56', '12.3', '12.', '1e3', '0x10', 'NaN', 'Infinity', 'abc', '1.234,56', '90071992547409.91', '99999999999999999999'];
      for (let i = 0; i < 5000; i += 1) {
        const cell = Array.from({length: 1 + Math.floor(rand() * 3)}, () => pieces[Math.floor(rand() * pieces.length)]).join('');
        for (const denomination of ['major', 'minor', null] as Array<Denomination | null>) {
          for (const sign of ['outflow-negative', 'outflow-positive'] as SignConvention[]) {
            const result = parseRowAmount(cell, denomination, sign);
            if (result.ok) {
              // The ONLY success shape: a safe signed integer of minor units.
              expect(Number.isSafeInteger(result.minor)).toBe(true);
              expect(Object.is(result.minor, -0)).toBe(false);
            } else {
              // …and every failure is a sentence, never a bare throw.
              expect(typeof result.problem).toBe('string');
              expect(result.problem.length).toBeGreaterThan(0);
            }
          }
        }
      }
    });

    it('TABLE: a minor-unit column is never off by 100 for any decimal-free integer', () => {
      const parseRowAmount = mod().parseRowAmount as (raw: string, d: Denomination | null, s: SignConvention) => AmountResult;
      for (const n of [0, 1, 5, 99, 100, 101, 999, 1234, 100_000, 90_071_992_547_409]) {
        for (const signText of ['', '-']) {
          const cell = `${signText}${n}`;
          const minor = parseRowAmount(cell, 'minor', 'outflow-negative');
          expect(minor).toEqual({ok: true, minor: signText === '-' && n !== 0 ? -n : n});
          // The same cell read as MAJOR is exactly 100x — the error this whole
          // mechanism exists to prevent.
          const major = parseRowAmount(cell, 'major', 'outflow-negative');
          if (major.ok) expect(major.minor).toBe((minor as {ok: true; minor: number}).minor * 100);
        }
      }
      // A decimal point in a cents column is a MIXED file, and is rejected.
      expect(parseRowAmount('12.34', 'minor', 'outflow-negative')).toEqual({ok: false, problem: expect.stringMatching(/mixes scales/) as unknown as string});
    });
  });

  describe('per-source mapping identity', () => {
    it('the same bank export shape yields the same source id — a second import needs no re-mapping', () => {
      const sourceId = mod().sourceIdForHeader as (h: string[]) => string;
      const march = matrixOf(MAJOR_CSV);
      const april = matrixOf(['Date,Description,Amount', '2026-04-01,SOMETHING ELSE,-1.00'].join('\n'));
      expect(sourceId(april[0])).toBe(sourceId(march[0]));
      // Header case/spacing noise does not change the source's identity…
      expect(sourceId(['  date ', 'DESCRIPTION', 'Amount'])).toBe(sourceId(march[0]));
      // …but a genuinely different export shape does (fails safe: asks once more).
      expect(sourceId(['Date', 'Amount', 'Description'])).not.toBe(sourceId(march[0]));
      expect(sourceId([])).toBe('unknown');
    });
  });

  describe('the capped preview tells the truth about what it is not showing', () => {
    it('sorts the rows needing attention to the top, so they are never the ones cut off', () => {
      const preview = mod().previewRows as (p: PreparedImport, n: number) => PreparedRow[];
      // 250 rows: three unreadable ones buried past the 200-row cap, where
      // per-row reporting stopped working exactly when it mattered most.
      const lines = ['Date,Description,Amount'];
      for (let i = 1; i <= 250; i += 1) lines.push(`2026-03-01,ROW ${i},${i === 205 || i === 230 || i === 249 ? 'not money' : '-1.00'}`);
      const matrix = matrixOf(lines.join('\n'));
      const profile = profileFor(matrix, {denomination: 'major'});
      const prepared = prepare(matrix, profile);
      expect(prepared.counts.error).toBe(3);

      const shown = preview(prepared, 200);
      expect(shown).toHaveLength(200);
      // Errors first, in file order — not sorted out of existence.
      expect(shown.slice(0, 3).map((r) => r.line)).toEqual([205, 230, 249]);
      expect(shown.every((r, i) => i < 3 || r.status === 'new')).toBe(true);
      // File order is preserved within a rank.
      expect(shown.slice(3, 6).map((r) => r.line)).toEqual([1, 2, 3]);
    });

    it('the footer states the REAL counts, not "all of them import"', () => {
      const describe_ = mod().describePreviewLimit as (p: PreparedImport, shown: number) => string;
      const counts = {new: 240, duplicate: 6, 'duplicate-draft': 1, 'near-duplicate': 0, error: 3};
      const rows = Array.from({length: 250}, () => null) as unknown as PreparedRow[];
      const text = describe_({rows, counts, importable: true}, 200);
      expect(text).toContain('Showing 200 of 250 rows');
      expect(text).toContain('240 of 250 will import');
      expect(text).toContain('10 will not');
      expect(text).not.toMatch(/all of them/i);
    });

    it('the near-duplicate warning quotes the entry as WRITTEN, not the flattened key', () => {
      const matrix = matrixOf(['Date,Description,Amount', '2026-03-01,SQ *BLUE BOTTLE 12,-4.50'].join('\n'));
      const profile = profileFor(matrix);
      const known = knownFrom([{date: '2026-03-01', description: 'SQ *Blue Bottle #12 PENDING', amountMinor: -450}], profile.sourceId);
      const prepared = prepare(matrix, profile, known);
      expect(prepared.rows[0].problem).toContain('SQ *Blue Bottle #12 PENDING');
      expect(prepared.rows[0].problem).not.toContain('sq blue bottle 12 pending');
    });

    it('every row carries the RAW amount cell beside the parsed one', () => {
      // `450` next to `$4.50` is the cheapest check there is on the money scale.
      const matrix = matrixOf(['Posted Date,Details,Amount (cents)', '2026-03-01,COFFEE,-450'].join('\n'));
      const prepared = prepare(matrix, profileFor(matrix));
      expect(prepared.rows[0].rawAmount).toBe('-450');
      expect(prepared.rows[0].amountMinor).toBe(-450);
    });
  });

  describe('the summary line the live region reads out', () => {
    it('counts every outcome in words', () => {
      const summarize = mod().describeImport as (p: PreparedImport) => string;
      expect(summarize({rows: [], counts: {new: 3, duplicate: 0, 'duplicate-draft': 0, 'near-duplicate': 0, error: 0}, importable: true})).toBe('3 new.');
      expect(summarize({rows: [], counts: {new: 1, duplicate: 2, 'duplicate-draft': 3, 'near-duplicate': 1, error: 4}, importable: true})).toBe(
        '1 new · 1 possible duplicate · 3 already drafted · 2 already imported · 4 unreadable.',
      );
    });
  });
});
