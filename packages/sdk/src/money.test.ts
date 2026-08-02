import {describe, it, expect} from 'vitest';
import {
  MAX_AMOUNT_MINOR,
  MIN_AMOUNT_MINOR,
  MoneyCurrencyError,
  MoneyError,
  MoneyParseError,
  MoneyRangeError,
  addAmounts,
  assertUniformCurrency,
  compareAmounts,
  formatAmount,
  isValidCurrencyCode,
  isValidMinor,
  negateAmount,
  parseAmount,
  sumAmounts,
} from './money';

// Seeded PRNG (mulberry32) — deterministic across runs, no dependency.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Random valid minor amount with log-uniform magnitude (hits every scale from cents to near 2^53). */
function randomMinor(rand: () => number): number {
  const magnitude = Math.min(MAX_AMOUNT_MINOR, Math.floor(Math.exp(rand() * Math.log(MAX_AMOUNT_MINOR))));
  return rand() < 0.5 ? -magnitude : magnitude;
}

describe('parse ↔ format round-trip (property)', () => {
  it('round-trips 1e6 seeded random amounts with zero drift', () => {
    const rand = mulberry32(0x1ed6e12);
    // Deterministic edges first: zero, ±unit, boundary-of-grouping, near-bound, exact bounds.
    const edges = [
      0, 1, -1, 99, -99, 100, -100, 99999, 100000, -100000,
      123456, -123456, 99999999999, -99999999999,
      MAX_AMOUNT_MINOR, MIN_AMOUNT_MINOR, MAX_AMOUNT_MINOR - 1, MIN_AMOUNT_MINOR + 1,
    ];
    for (const minor of edges) {
      expect(parseAmount(formatAmount(minor))).toBe(minor);
    }
    for (let i = 0; i < 1_000_000; i++) {
      const minor = randomMinor(rand);
      const back = parseAmount(formatAmount(minor));
      if (back !== minor) {
        // Only build the expensive failure message off the hot path.
        expect.fail(`round-trip drift at i=${i}: ${minor} → ${formatAmount(minor)} → ${back}`);
      }
    }
  });

  it('round-trips through parens negative style and currency symbols (10k seeded)', () => {
    const rand = mulberry32(0xB0A4D);
    for (let i = 0; i < 10_000; i++) {
      const minor = randomMinor(rand);
      expect(parseAmount(formatAmount(minor, {negative: 'parens'}))).toBe(minor);
      expect(parseAmount(formatAmount(minor, {currency: 'USD'}))).toBe(minor);
      expect(parseAmount(formatAmount(minor, {currency: 'EUR', negative: 'parens'}))).toBe(minor);
    }
  });
});

describe('exact integer summation', () => {
  it('sums 10k × 10-minor-unit values exactly where float math drifts', () => {
    // Float control: 10,000 × 0.1 accumulated as doubles does NOT equal 1000.
    let float = 0;
    for (let i = 0; i < 10_000; i++) float += 0.1;
    expect(float).not.toBe(1000);

    // Integer minor units: 10,000 × 10 minor units is exactly 100,000 (== $1,000.00).
    const values = Array.from({length: 10_000}, () => 10);
    expect(sumAmounts(values)).toBe(100_000);
    expect(formatAmount(sumAmounts(values))).toBe('1,000.00');
  });

  it('matches a BigInt reference over 10k seeded random signed amounts', () => {
    const rand = mulberry32(0x5EED);
    const values: number[] = [];
    for (let i = 0; i < 10_000; i++) {
      // Bounded magnitudes so the running sum stays within ±(2^53 − 1).
      values.push(Math.floor(rand() * 1e12) * (rand() < 0.5 ? -1 : 1));
    }
    const reference = values.reduce((acc, v) => acc + BigInt(v), 0n);
    expect(BigInt(sumAmounts(values))).toBe(reference);
  });

  it('addAmounts is variadic sugar over sumAmounts', () => {
    expect(addAmounts()).toBe(0);
    expect(addAmounts(1, 2, 3)).toBe(6);
    expect(addAmounts(-500, 500)).toBe(0);
  });
});

describe('rejections', () => {
  it('rejects non-integer (float) amounts in arithmetic, formatting, negate, compare', () => {
    for (const bad of [12.5, 0.1, -0.30000000000000004, NaN, Infinity, -Infinity]) {
      expect(() => sumAmounts([bad])).toThrow(MoneyRangeError);
      expect(() => addAmounts(0, bad)).toThrow(MoneyRangeError);
      expect(() => formatAmount(bad)).toThrow(MoneyRangeError);
      expect(() => negateAmount(bad)).toThrow(MoneyRangeError);
      expect(() => compareAmounts(bad, 0)).toThrow(MoneyRangeError);
      expect(() => compareAmounts(0, bad)).toThrow(MoneyRangeError);
    }
  });

  it('rejects unsafe magnitudes (beyond ±(2^53 − 1))', () => {
    for (const bad of [2 ** 53, -(2 ** 53), 2 ** 60]) {
      expect(() => sumAmounts([bad])).toThrow(MoneyRangeError);
      expect(() => formatAmount(bad)).toThrow(MoneyRangeError);
    }
    expect(() => sumAmounts([MAX_AMOUNT_MINOR, 1])).toThrow(MoneyRangeError);
    expect(() => sumAmounts([MIN_AMOUNT_MINOR, -1])).toThrow(MoneyRangeError);
    // Recoverable overshoot must still throw: the running sum is checked at every step.
    expect(() => sumAmounts([MAX_AMOUNT_MINOR, MAX_AMOUNT_MINOR, MIN_AMOUNT_MINOR])).toThrow(MoneyRangeError);
  });

  it('rejects >2 decimals', () => {
    for (const bad of ['1.234', '0.001', '-12.345', '$1.999']) {
      expect(() => parseAmount(bad)).toThrow(MoneyParseError);
    }
  });

  it('rejects ambiguous or misplaced separators', () => {
    for (const bad of ['1,23.45', '1234,567', '12,34', '1,2345', '1..2', '1.2.3', '12.', '1 234.56', '1.234,56']) {
      expect(() => parseAmount(bad)).toThrow(MoneyParseError);
    }
  });

  it('rejects empty, sign-only, and non-numeric input', () => {
    for (const bad of ['', '   ', '-', '+', '$', '-$', '.', 'abc', '12abc', '1e5', '0x10', '()', '( )', 'NaN', 'Infinity']) {
      expect(() => parseAmount(bad)).toThrow(MoneyParseError);
    }
  });

  it('rejects conflicting or ambiguous negatives and unbalanced parens', () => {
    for (const bad of ['(-12.30)', '(+12.30)', '-(12.30)', '(12.30', '12.30)', '--12', '+-12', '-$-12']) {
      expect(() => parseAmount(bad)).toThrow(MoneyParseError);
    }
  });

  it('rejects parse overflow with MoneyRangeError (distinct from MoneyParseError)', () => {
    expect(() => parseAmount('90071992547409.92')).toThrow(MoneyRangeError);
    expect(() => parseAmount('99999999999999999999')).toThrow(MoneyRangeError);
    expect(parseAmount('90071992547409.91')).toBe(MAX_AMOUNT_MINOR);
    expect(parseAmount('-90071992547409.91')).toBe(MIN_AMOUNT_MINOR);
  });

  it('honours strictness options', () => {
    expect(() => parseAmount('(12.30)', {allowParens: false})).toThrow(MoneyParseError);
    expect(() => parseAmount('$12.30', {allowCurrencySymbol: false})).toThrow(MoneyParseError);
  });

  it('rejects bad currency codes everywhere codes are accepted', () => {
    for (const bad of ['usd', 'US', 'USDT', 'U$D', '', 'usd ', '€', 123 as unknown as string]) {
      expect(isValidCurrencyCode(bad)).toBe(false);
      expect(() => formatAmount(100, {currency: bad})).toThrow(MoneyCurrencyError);
      expect(() => assertUniformCurrency([bad])).toThrow(MoneyCurrencyError);
    }
    expect(() => assertUniformCurrency(['USD', 'EUR'])).toThrow(MoneyCurrencyError);
  });

  it('exposes a typed taxonomy: parse vs range vs currency, all MoneyError', () => {
    const caught = (fn: () => unknown): unknown => {
      try { fn(); return undefined; } catch (e) { return e; }
    };
    const parse = caught(() => parseAmount('x')) as MoneyParseError;
    const range = caught(() => formatAmount(0.5)) as MoneyRangeError;
    const currency = caught(() => assertUniformCurrency(['bad'])) as MoneyCurrencyError;
    expect(parse).toBeInstanceOf(MoneyError);
    expect(range).toBeInstanceOf(MoneyError);
    expect(currency).toBeInstanceOf(MoneyError);
    expect(parse.code).toBe('parse');
    expect(range.code).toBe('range');
    expect(currency.code).toBe('currency');
    expect(parse.name).toBe('MoneyParseError');
    expect(range.name).toBe('MoneyRangeError');
    expect(currency.name).toBe('MoneyCurrencyError');
  });
});

describe('parseAmount accepted forms', () => {
  it('parses the documented shapes into minor units', () => {
    expect(parseAmount('1,234.56')).toBe(123456);
    expect(parseAmount('-12.30')).toBe(-1230);
    expect(parseAmount('(12.30)')).toBe(-1230);
    expect(parseAmount('$1,234.56')).toBe(123456);
    expect(parseAmount('1234')).toBe(123400); // whole major units × 100
    expect(parseAmount('0')).toBe(0);
    expect(parseAmount('0.00')).toBe(0);
    expect(parseAmount('.5')).toBe(50);
    expect(parseAmount('0.5')).toBe(50);
    expect(parseAmount('12.3')).toBe(1230); // 1 decimal digit = tenths
    expect(parseAmount('+12.30')).toBe(1230);
    expect(parseAmount('-$1,234.56')).toBe(-123456);
    expect(parseAmount('$-1,234.56')).toBe(-123456);
    expect(parseAmount('($1,234.56)')).toBe(-123456);
    expect(parseAmount('€99.99')).toBe(9999);
    expect(parseAmount('  42.00  ')).toBe(4200);
    expect(parseAmount('1,000,000')).toBe(100_000_000);
  });

  it('normalises negative zero to 0', () => {
    expect(Object.is(parseAmount('-0.00'), 0)).toBe(true);
    expect(Object.is(parseAmount('(0)'), 0)).toBe(true);
    expect(Object.is(negateAmount(0), 0)).toBe(true);
    expect(Object.is(negateAmount(-0), 0)).toBe(true);
  });
});

// LGR-10 precondition: an importer of MACHINE money (bank/processor exports)
// cannot inherit the "bare digits are major units" default — a Stripe-style
// minor-unit feed would import 100× too large and still balance. One test per
// mode, so the default stays pinned as backward compatible.
describe('parseAmount bareDigits', () => {
  it('\'major\' (the default) reads decimal-point-free input as whole major units', () => {
    // Default and explicit are the SAME function: no behaviour change for any
    // existing caller.
    for (const opts of [undefined, {bareDigits: 'major' as const}]) {
      expect(parseAmount('1234', opts)).toBe(123400);
      expect(parseAmount('0', opts)).toBe(0);
      expect(parseAmount('+1,000', opts)).toBe(100_000);
      expect(parseAmount('(42)', opts)).toBe(-4200);
      expect(parseAmount('$1,234.56', opts)).toBe(123456);
    }
  });

  it('\'reject\' throws MoneyParseError on decimal-point-free input, and only on that', () => {
    const reject = {bareDigits: 'reject'} as const;
    // No decimal point ⇒ scale unestablished ⇒ typed rejection, never a guess.
    // Covers the leading `+`, leading zeros and `"0,000"` the grammar accepts.
    for (const bare of ['1234', '0', '00', '007', '+1234', '-1234', '(1234)', '$1,234', '1,000,000', '0,000']) {
      expect(() => parseAmount(bare, reject)).toThrow(MoneyParseError);
      expect(() => parseAmount(bare, reject)).toThrow(/no decimal point/);
    }
    // A decimal point establishes the scale — these are unaffected.
    expect(parseAmount('12.34', reject)).toBe(1234);
    expect(parseAmount('1,234.56', reject)).toBe(123456);
    expect(parseAmount('.5', reject)).toBe(50);
    expect(parseAmount('0.00', reject)).toBe(0);
    expect(parseAmount('-$1,234.56', reject)).toBe(-123456);
    expect(parseAmount('(12.30)', reject)).toBe(-1230);
    // Malformed input still fails as malformed, not as "no decimal point".
    expect(() => parseAmount('12.', reject)).toThrow(/unparseable/);
    expect(() => parseAmount('ten', reject)).toThrow(MoneyParseError);
  });
});

describe('formatAmount', () => {
  it('formats with fixed 2 decimals and comma thousands grouping', () => {
    expect(formatAmount(0)).toBe('0.00');
    expect(formatAmount(5)).toBe('0.05');
    expect(formatAmount(50)).toBe('0.50');
    expect(formatAmount(100)).toBe('1.00');
    expect(formatAmount(123456)).toBe('1,234.56');
    expect(formatAmount(1234567890)).toBe('12,345,678.90');
    expect(formatAmount(MAX_AMOUNT_MINOR)).toBe('90,071,992,547,409.91');
  });

  it('renders negative styles: sign (default) and parens', () => {
    expect(formatAmount(-123456)).toBe('-1,234.56');
    expect(formatAmount(-123456, {negative: 'sign'})).toBe('-1,234.56');
    expect(formatAmount(-123456, {negative: 'parens'})).toBe('(1,234.56)');
    expect(formatAmount(MIN_AMOUNT_MINOR)).toBe('-90,071,992,547,409.91');
    // Zero is never negative, in either style.
    expect(formatAmount(-0)).toBe('0.00');
    expect(formatAmount(0, {negative: 'parens'})).toBe('0.00');
  });

  it('renders currency: known codes as symbols, other valid codes as prefixes', () => {
    expect(formatAmount(123456, {currency: 'USD'})).toBe('$1,234.56');
    expect(formatAmount(-123456, {currency: 'USD'})).toBe('-$1,234.56');
    expect(formatAmount(-123456, {currency: 'USD', negative: 'parens'})).toBe('($1,234.56)');
    expect(formatAmount(9999, {currency: 'EUR'})).toBe('€99.99');
    expect(formatAmount(9999, {currency: 'GBP'})).toBe('£99.99');
    expect(formatAmount(9999, {currency: 'INR'})).toBe('₹99.99');
    // v1 scale note: JPY still renders minor/100 at 2 decimals (documented).
    expect(formatAmount(12345, {currency: 'JPY'})).toBe('¥123.45');
    expect(formatAmount(123456, {currency: 'CAD'})).toBe('CAD 1,234.56');
    expect(formatAmount(-123456, {currency: 'CAD'})).toBe('CAD -1,234.56');
    expect(formatAmount(-123456, {currency: 'CAD', negative: 'parens'})).toBe('CAD (1,234.56)');
  });

  it('is deterministic and host-locale independent (digit-built, no Intl)', () => {
    // Same inputs, repeated calls, byte-identical output — no locale consult.
    for (let i = 0; i < 5; i++) {
      expect(formatAmount(987654321)).toBe('9,876,543.21');
      expect(formatAmount(-100000, {negative: 'parens'})).toBe('(1,000.00)');
    }
  });
});

describe('negate / compare / validity / currency helpers', () => {
  it('negateAmount mirrors amounts exactly', () => {
    expect(negateAmount(123456)).toBe(-123456);
    expect(negateAmount(-123456)).toBe(123456);
    expect(negateAmount(MAX_AMOUNT_MINOR)).toBe(MIN_AMOUNT_MINOR);
  });

  it('compareAmounts is a three-way comparator', () => {
    expect(compareAmounts(1, 2)).toBe(-1);
    expect(compareAmounts(2, 1)).toBe(1);
    expect(compareAmounts(5, 5)).toBe(0);
    expect(compareAmounts(-1, 1)).toBe(-1);
    expect([300, -100, 200, 0].sort(compareAmounts)).toEqual([-100, 0, 200, 300]);
  });

  it('isValidMinor accepts exactly the safe integers', () => {
    expect(isValidMinor(0)).toBe(true);
    expect(isValidMinor(-1)).toBe(true);
    expect(isValidMinor(MAX_AMOUNT_MINOR)).toBe(true);
    expect(isValidMinor(MIN_AMOUNT_MINOR)).toBe(true);
    expect(isValidMinor(2 ** 53)).toBe(false);
    expect(isValidMinor(0.5)).toBe(false);
    expect(isValidMinor(NaN)).toBe(false);
    expect(isValidMinor('100')).toBe(false);
    expect(isValidMinor(100n)).toBe(false);
    expect(isValidMinor(null)).toBe(false);
  });

  it('isValidCurrencyCode / assertUniformCurrency', () => {
    expect(isValidCurrencyCode('USD')).toBe(true);
    expect(isValidCurrencyCode('JPY')).toBe(true);
    expect(assertUniformCurrency([])).toBeUndefined();
    expect(assertUniformCurrency(['EUR'])).toBe('EUR');
    expect(assertUniformCurrency(['EUR', 'EUR', 'EUR'])).toBe('EUR');
  });
});
