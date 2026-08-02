/**
 * Beancount serializer (LGR-13) — pure-layer pins.
 *
 * What is pinned here (no Python needed — the live bean-check/Fava gate runs
 * in the ui suite and CI):
 *  - `formatBeancountAmount` is exact, injective with `parseAmount`, and agrees
 *    digit-for-digit with `formatAmount` (property-tested);
 *  - `quoteBeancountString` is injective (unescape recovers the original);
 *  - name mangling always yields grammar-valid Beancount accounts under the
 *    type-derived root, and collision handling is deterministic and
 *    input-order independent (property-tested);
 *  - the builder is byte-deterministic, excludes drafts, exports BOTH halves
 *    of a reversal pair, asserts balances only for `closed` periods, and
 *    REFUSES corrupt books with typed errors.
 */

import {describe, expect, it} from 'vitest';
import {MoneyRangeError, formatAmount, parseAmount} from './money';
import {LedgerError, type LedgerAccount, type LedgerAccountType} from './ledger';
import {
  BEANCOUNT_ROOT_BY_TYPE,
  beancountAccountName,
  buildBeancountAccountNames,
  buildLedgerBeancount,
  formatBeancountAmount,
  mangleBeancountComponent,
  quoteBeancountString,
} from './ledgerBeancount';
import {BEANCOUNT_PARITY_TX_COUNT, buildBeancountMiniBook, buildBeancountParityBook} from './ledgerBeancountFixture';

/** mulberry32 — the tests' own deterministic PRNG (mirrors the fixture's). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('formatBeancountAmount', () => {
  it('serializes the canonical examples', () => {
    expect(formatBeancountAmount(0)).toBe('0.00');
    expect(formatBeancountAmount(-0)).toBe('0.00'); // negative zero normalises
    expect(formatBeancountAmount(5)).toBe('0.05');
    expect(formatBeancountAmount(-5)).toBe('-0.05');
    expect(formatBeancountAmount(123456)).toBe('1234.56');
    expect(formatBeancountAmount(-123456)).toBe('-1234.56');
    expect(formatBeancountAmount(Number.MAX_SAFE_INTEGER)).toBe('90071992547409.91');
    expect(formatBeancountAmount(-Number.MAX_SAFE_INTEGER)).toBe('-90071992547409.91');
  });

  it('rejects non-integers, NaN, infinities and unsafe magnitudes with MoneyRangeError', () => {
    for (const bad of [1.5, NaN, Infinity, -Infinity, 2 ** 53, -(2 ** 53)]) {
      expect(() => formatBeancountAmount(bad)).toThrow(MoneyRangeError);
    }
  });

  it('property: shape, parseAmount round-trip, and digit agreement with formatAmount', () => {
    const rnd = mulberry32(0xbea9);
    const samples = [0, 1, -1, 99, -99, 100, -100, Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER];
    for (let i = 0; i < 500; i += 1) {
      // Spread across magnitudes: small change, invoices, and huge totals.
      const magnitude = Math.floor(rnd() * [100, 1_000_000, Number.MAX_SAFE_INTEGER][i % 3]);
      samples.push(rnd() < 0.5 ? magnitude : -magnitude);
    }
    for (const minor of samples) {
      const text = formatBeancountAmount(minor);
      expect(text).toMatch(/^-?\d+\.\d\d$/);
      // Injective against the money core's parser (major units with a decimal
      // point — exactly the grammar this emits).
      expect(parseAmount(text)).toBe(minor === 0 ? 0 : minor);
      // Digit-for-digit the display formatter minus grouping: one fact (the
      // BigInt split), two renderings.
      expect(text.replace('-', '')).toBe(formatAmount(minor === 0 ? 0 : Math.abs(minor)).replace(/,/g, ''));
    }
  });
});

describe('quoteBeancountString', () => {
  /** The documented re-import rule: strip quotes, unescape `\\"` and `\\\\`. */
  const unquote = (quoted: string): string => {
    expect(quoted.startsWith('"') && quoted.endsWith('"')).toBe(true);
    return quoted.slice(1, -1).replace(/\\(["\\])/g, '$1');
  };

  it('escapes exactly backslash and double-quote, injectively', () => {
    const hostile = [
      'plain',
      'He said "hi"',
      'trailing backslash \\',
      '\\" already escaped-looking',
      'newline\nkept\nverbatim',
      'unicode café ☕ — ok',
      '=SUM(A1)',
      '',
    ];
    for (const value of hostile) expect(unquote(quoteBeancountString(value))).toBe(value);
  });

  it('property: random strings over a hostile alphabet round-trip', () => {
    const rnd = mulberry32(0x5712);
    const alphabet = ['a', 'Z', '9', '"', '\\', '\n', ' ', ':', 'é', '☕'];
    for (let i = 0; i < 300; i += 1) {
      const length = Math.floor(rnd() * 12);
      const value = Array.from({length}, () => alphabet[Math.floor(rnd() * alphabet.length)]).join('');
      expect(unquote(quoteBeancountString(value))).toBe(value);
    }
  });
});

describe('account-name mangling', () => {
  it('mangles the canonical examples', () => {
    expect(mangleBeancountComponent('Bank Fees')).toBe('Bank-Fees');
    expect(mangleBeancountComponent('café & misc.')).toBe('Caf----misc-');
    expect(mangleBeancountComponent('misc')).toBe('Misc');
    expect(mangleBeancountComponent('9lives')).toBe('9lives');
    expect(mangleBeancountComponent('-lead')).toBe('X-lead');
    expect(mangleBeancountComponent('')).toBe('X');
  });

  it('derives the root from the TYPE, never the name', () => {
    expect(beancountAccountName({name: 'Assets:Bank:Checking', type: 'asset'})).toBe('Assets:Bank:Checking');
    expect(beancountAccountName({name: 'Revenue:Sales', type: 'revenue'})).toBe('Income:Revenue:Sales');
    expect(beancountAccountName({name: 'Income:Revenue', type: 'revenue'})).toBe('Income:Revenue');
    expect(beancountAccountName({name: 'misc:stuff', type: 'expense'})).toBe('Expenses:Misc:Stuff');
    // A bare-root name cannot map to the bare root (Beancount rejects it).
    expect(beancountAccountName({name: 'Assets', type: 'asset'})).toBe('Assets:Assets');
  });

  it('property: every mapped name is grammar-valid under the five roots', () => {
    const rnd = mulberry32(0xacc7);
    const chars = ['a', 'B', '9', ' ', '-', '_', '.', '"', ':', 'é', '☕', '='];
    const types: LedgerAccountType[] = ['asset', 'liability', 'equity', 'revenue', 'expense'];
    for (let i = 0; i < 400; i += 1) {
      const segments = Math.max(1, Math.floor(rnd() * 4));
      const name = Array.from({length: segments}, () => {
        const len = 1 + Math.floor(rnd() * 8);
        return Array.from({length: len}, () => chars[Math.floor(rnd() * chars.length)]).join('');
      }).join(':');
      const type = types[Math.floor(rnd() * types.length)];
      const mapped = beancountAccountName({name, type});
      const components = mapped.split(':');
      expect(components[0]).toBe(BEANCOUNT_ROOT_BY_TYPE[type]);
      expect(components.length).toBeGreaterThanOrEqual(2);
      for (const component of components.slice(1)) {
        expect(component).toMatch(/^[A-Z0-9][A-Za-z0-9-]*$/);
      }
    }
  });

  it('resolves collisions deterministically, bumping past occupied suffixes', () => {
    const acct = (id: string, name: string, createdAt: string): LedgerAccount => ({
      id,
      name,
      type: 'expense',
      status: 'open',
      currency: 'USD',
      evidenceRequired: false,
      createdAt,
      updatedAt: createdAt,
    });
    const names = buildBeancountAccountNames([
      acct('a-3', 'Expenses:Bank-Fees-2', '2026-01-03T00:00:00.000Z'),
      acct('a-1', 'Expenses:Bank Fees', '2026-01-01T00:00:00.000Z'),
      acct('a-2', 'Expenses:Bank-Fees', '2026-01-02T00:00:00.000Z'),
    ]);
    // CREATION order (not input order) decides who claims what: a-1 keeps the
    // plain name; a-2 collides and takes `-2`; a-3's own base is now occupied
    // by a-2's suffix, so a-3 bumps to `-2-2`.
    expect(names.get('a-1')).toBe('Expenses:Bank-Fees');
    expect(names.get('a-2')).toBe('Expenses:Bank-Fees-2');
    expect(names.get('a-3')).toBe('Expenses:Bank-Fees-2-2');
  });

  it('is stable under input-array shuffling (order comes from stored data)', () => {
    const acct = (id: string, name: string, createdAt: string): LedgerAccount => ({
      id,
      name,
      type: 'expense',
      status: 'open',
      currency: 'USD',
      evidenceRequired: false,
      createdAt,
      updatedAt: createdAt,
    });
    const accounts = [
      acct('a-1', 'Expenses:Bank Fees', '2026-01-01T00:00:00.000Z'),
      acct('a-2', 'Expenses:Bank-Fees', '2026-01-02T00:00:00.000Z'),
      acct('a-3', 'Expenses:Bank-Fees-2', '2026-01-03T00:00:00.000Z'),
    ];
    const forward = buildBeancountAccountNames(accounts);
    const reversed = buildBeancountAccountNames([...accounts].reverse());
    expect(Object.fromEntries(reversed)).toEqual(Object.fromEntries(forward));
  });
});

describe('buildLedgerBeancount', () => {
  it('is byte-deterministic: two builds of the same book are identical', () => {
    const a = buildBeancountMiniBook();
    const b = buildBeancountMiniBook();
    const first = buildLedgerBeancount(a.accounts, a.transactions, a.periods);
    const second = buildLedgerBeancount(b.accounts, b.transactions, b.periods);
    expect(second).toBe(first);
    expect(first.endsWith('\n')).toBe(true);
    expect(first.endsWith('\n\n')).toBe(false);
  });

  it('excludes drafts — and only drafts', () => {
    const {accounts, transactions, periods} = buildBeancountMiniBook();
    const text = buildLedgerBeancount(accounts, transactions, periods);
    expect(text).not.toContain('must not export');
    const drafts = transactions.filter((t) => t.state === 'draft');
    expect(drafts.length).toBeGreaterThan(0);
    for (const draft of drafts) expect(text).not.toContain(draft.id);
    // One `txn` block per reported transaction — none dropped, none invented.
    const txnHeads = text.match(/^\d{4}-\d{2}-\d{2} \* /gm) ?? [];
    expect(txnHeads.length).toBe(transactions.filter((t) => t.state !== 'draft').length);
  });

  it('exports BOTH halves of a reversal pair (a void original offsets its reversal)', () => {
    const {accounts, transactions, periods} = buildBeancountMiniBook();
    const text = buildLedgerBeancount(accounts, transactions, periods);
    const voided = transactions.find((t) => t.state === 'void');
    const reversal = transactions.find((t) => t.reverses === voided?.id);
    expect(voided).toBeDefined();
    expect(reversal).toBeDefined();
    expect(text).toContain(`lp-id: "${voided?.id}"`);
    expect(text).toContain('lp-state: "void"');
    expect(text).toContain(`lp-reverses: "${voided?.id}"`);
  });

  it('asserts balances after CLOSED periods only (a reopened period is history)', () => {
    const parity = buildBeancountParityBook();
    const text = buildLedgerBeancount(parity.accounts, parity.transactions, parity.periods);
    // The 2024 close asserts on 2025-01-01…
    expect(text).toContain('; Balance assertions after closed period 2024-01-01 .. 2024-12-31.');
    expect(text).toMatch(/^2025-01-01 balance /m);
    // …and the reopened January close asserts NOTHING.
    expect(text).not.toContain('2025-01-31.');
    expect(text).not.toMatch(/^2025-02-01 balance /m);
    // Income-statement accounts assert to ZERO after the sweep.
    expect(text).toMatch(/^2025-01-01 balance Income:Revenue 0\.00 USD$/m);
  });

  it('the parity book carries exactly the advertised 500 reported transactions', () => {
    const parity = buildBeancountParityBook();
    expect(parity.transactions.filter((t) => t.entryNo != null).length).toBe(BEANCOUNT_PARITY_TX_COUNT);
    const text = buildLedgerBeancount(parity.accounts, parity.transactions, parity.periods);
    expect((text.match(/^\d{4}-\d{2}-\d{2} \* /gm) ?? []).length).toBe(BEANCOUNT_PARITY_TX_COUNT);
  });

  it('refuses a posting on an unknown account with a typed account-not-found', () => {
    const {accounts, transactions, periods} = buildBeancountMiniBook();
    const broken = structuredClone(transactions);
    broken[0].postings[0].accountId = 'no-such-account';
    expect(() => buildLedgerBeancount(accounts, broken, periods)).toThrowError(LedgerError);
    expect(() => buildLedgerBeancount(accounts, broken, periods)).toThrowError(/account-not-found|unknown account/);
  });

  it('refuses a raw-corrupted amount with MoneyRangeError instead of serializing it', () => {
    const {accounts, transactions, periods} = buildBeancountMiniBook();
    const broken = structuredClone(transactions);
    broken[0].postings[0].amountMinor = 12.5 as number;
    expect(() => buildLedgerBeancount(accounts, broken, periods)).toThrow(MoneyRangeError);
  });
});
