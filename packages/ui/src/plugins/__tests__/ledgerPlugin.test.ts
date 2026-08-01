import {describe, expect, it, vi} from 'vitest';
// The REAL first-party ledger plugin, byte-for-byte (vite `?raw`): every test
// below runs the shipped sources through the real loader — never a copy.
import ledgerManifestJson from '../../../../../examples/plugins/ledger/openbook.json?raw';
import ledgerIndexTs from '../../../../../examples/plugins/ledger/src/index.ts?raw';
import ledgerModelTs from '../../../../../examples/plugins/ledger/src/model.ts?raw';
import ledgerSetupTs from '../../../../../examples/plugins/ledger/src/setup.ts?raw';
import ledgerBlockTsx from '../../../../../examples/plugins/ledger/src/block.tsx?raw';
import {PLUGIN_API_VERSION, type DataClient, type LedgerAccount, type PluginManifest, type StoredPlugin} from '@book.dev/sdk';
import {executePlugin} from '../loader';
import {buildPluginApi, hostModulesFor, type PluginApi} from '../api';
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

const FILES: Record<string, string> = {
  'src/index.ts': ledgerIndexTs,
  'src/model.ts': ledgerModelTs,
  'src/setup.ts': ledgerSetupTs,
  'src/block.tsx': ledgerBlockTsx,
};

const manifest = JSON.parse(ledgerManifestJson) as PluginManifest;

const storedPlugin = (): StoredPlugin => ({
  manifest,
  files: FILES,
  enabled: true,
  installedAt: new Date(0).toISOString(),
});

/** The plugin's module exports, loaded through the REAL loader + host modules. */
function loadModule(client: DataClient = {} as DataClient): {
  exports: Record<string, unknown>;
  api: PluginApi;
} {
  const api = buildPluginApi({id: manifest.id, name: manifest.name, version: manifest.version}, client, () => {});
  const exports = executePlugin({manifest, files: FILES}, hostModulesFor(api));
  return {exports, api};
}

type ComputeEntryStatus = (rows: JournalRow[], date?: string) => JournalEntryStatus;
type RowsToPostings = (rows: JournalRow[]) => Array<{accountId: string; amountMinor: number}>;
type Describe = (status: JournalEntryStatus) => string | null;
type ParseCell = (raw: string) => number | null | 'invalid';
type NormalizeCell = (raw: string) => string;

const row = (accountId: string, debit = '', credit = '', memo = ''): JournalRow => ({accountId, debit, credit, memo});

describe('ledger plugin (real source through the real loader)', () => {
  it('declares apiVersion 2 and registers the journal-entry block + setup command', async () => {
    expect(manifest.apiVersion).toBe(2);
    expect(manifest.apiVersion).toBe(PLUGIN_API_VERSION);

    const client = {listPlugins: async () => [storedPlugin()]} as unknown as DataClient;
    await syncPlugins(client);
    expect(pluginStatuses().find((s) => s.plugin.manifest.id === 'openbook.ledger')?.state).toBe('active');
    expect(getCustomBlock('openbook.ledger/journal-entry')).toBeDefined();
    expect(getCustomBlock('openbook.ledger/journal-entry')?.slash?.label).toBe('Journal entry');
    expect(pluginCommands().some((c) => c.id === 'openbook.ledger/setup-books' && c.title === 'Ledger: set up books')).toBe(true);

    // Disable → the block and command tear down with the plugin.
    await syncPlugins({listPlugins: async () => []} as unknown as DataClient);
    expect(getCustomBlock('openbook.ledger/journal-entry')).toBeUndefined();
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

      const postings = toPostings(rows);
      expect(postings).toEqual([
        {accountId: 'exp', amountMinor: 250000},
        {accountId: 'bank', amountMinor: -200000},
        {accountId: 'tax', amountMinor: -50000},
      ]);
      for (const p of postings) expect(Number.isInteger(p.amountMinor)).toBe(true);
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
