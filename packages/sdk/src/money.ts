/**
 * Money core (LGR-2): signed integer minor-unit amounts for the ledger.
 *
 * INVARIANT — amounts are SIGNED INTEGER MINOR UNITS (cents) everywhere:
 * storage, arithmetic, wire, and the boundaries of this API. No floats ever
 * cross this API: every function throws a typed {@link MoneyError} subclass on
 * non-integer or out-of-range numbers instead of rounding, truncating, or
 * returning `NaN`.
 *
 * Bounds: amounts must satisfy `Number.isSafeInteger`, i.e. lie within
 * ±(2^53 − 1) minor units (`±9,007,199,254,740,991` ≈ ±$90 trillion at 2
 * decimal places). Anything beyond is rejected with {@link MoneyRangeError}.
 * Internally, parsing and formatting route digit math through `BigInt` so the
 * bound check itself is exact.
 *
 * Scale (v1): a fixed 2-decimal minor-unit scale (1 major unit = 100 minor
 * units) for ALL currencies. Zero-decimal currencies (JPY-style) are
 * v1-unsupported as a scale: `formatAmount(minor, {currency: 'JPY'})` still
 * renders `minor / 100` with 2 decimals. Per-currency exponents are a later
 * ledger task.
 */

/** Discriminant for {@link MoneyError} subclasses. */
export type MoneyErrorCode = 'parse' | 'range' | 'currency';

/**
 * Base class for all money errors. Callers can `instanceof`-match the
 * subclasses ({@link MoneyParseError}, {@link MoneyRangeError},
 * {@link MoneyCurrencyError}) or switch on {@link MoneyError.code}.
 */
export class MoneyError extends Error {
  /** Machine-readable error category. */
  readonly code: MoneyErrorCode;

  constructor(code: MoneyErrorCode, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

/** Input text could not be parsed as a money amount (malformed, ambiguous, empty…). */
export class MoneyParseError extends MoneyError {
  constructor(message: string) {
    super('parse', message);
  }
}

/**
 * A numeric amount is not an integer or exceeds the safe bound of
 * ±(2^53 − 1) minor units (non-integer input, unsafe magnitude, or overflow
 * during arithmetic).
 */
export class MoneyRangeError extends MoneyError {
  constructor(message: string) {
    super('range', message);
  }
}

/** A currency code is malformed, or amounts mix currencies where one is required. */
export class MoneyCurrencyError extends MoneyError {
  constructor(message: string) {
    super('currency', message);
  }
}

/** Largest representable amount: 2^53 − 1 minor units (≈ $90,071,992,547,409.91). */
export const MAX_AMOUNT_MINOR: number = Number.MAX_SAFE_INTEGER;

/** Smallest representable amount: −(2^53 − 1) minor units. */
export const MIN_AMOUNT_MINOR: number = -Number.MAX_SAFE_INTEGER;

const MAX_MINOR_BIG = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * True iff `n` is a valid minor-unit amount: a `number` that is a safe integer
 * (`Number.isSafeInteger`), i.e. within ±(2^53 − 1). Narrowing type guard.
 */
export function isValidMinor(n: unknown): n is number {
  return typeof n === 'number' && Number.isSafeInteger(n);
}

/** Throw {@link MoneyRangeError} unless `n` is a valid minor-unit amount. */
function assertMinor(n: number, context: string): void {
  if (!isValidMinor(n)) {
    throw new MoneyRangeError(`${context}: amount must be a safe integer of minor units, got ${String(n)}`);
  }
}

/** Options for {@link parseAmount}. */
export interface ParseAmountOptions {
  /** Accept accounting-style parentheses for negatives, e.g. `(12.30)`. Default `true`. */
  allowParens?: boolean;
  /** Accept a leading currency symbol (`$ € £ ¥ ₹`), e.g. `$1,234.56`. Default `true`. */
  allowCurrencySymbol?: boolean;
  /**
   * What DECIMAL-POINT-FREE input means (`"1234"`, `"+1,000"`, `"0"`):
   *
   * - `'major'` (default, and the historical behaviour): whole MAJOR units —
   *   `"1234"` → `123400`.
   * - `'reject'`: throw {@link MoneyParseError}. For MACHINE input whose scale
   *   is not established by the data itself.
   *
   * WHY THIS EXISTS. For a human typing into a form, "1234" unambiguously means
   * 1234 dollars, and `'major'` is right. For a BANK or PROCESSOR export it is
   * not: Stripe-style feeds denominate in MINOR units ("amount in cents"), where
   * the same bare integer means 1/100th as much. Defaulting silently in that
   * context is the single worst failure this module exists to prevent — a
   * 100× import error that balances perfectly and looks plausible. So an
   * importer must DECIDE (from profile detection, or by asking) and pass an
   * explicit value; `'reject'` is how it makes an unestablished scale fail
   * LOUDLY at the parse instead of quietly at the wrong magnitude.
   *
   * `'reject'` keys off the DECIMAL POINT, not the value: `".5"` and `"12.30"`
   * pass, `"0"` and `"1,000"` do not.
   */
  bareDigits?: 'major' | 'reject';
}

const CURRENCY_SYMBOLS = new Set(['$', '€', '£', '¥', '₹']);

// Digits of a human-typed amount, after sign/symbol/paren stripping:
// either comma-grouped thousands (strict 3-digit groups) or plain digits,
// with an optional dot and exactly 1–2 fraction digits. The integer part may
// be empty only when a fraction is present (".5"). Anything else — >2
// decimals, misplaced separators ("1,23.45"), trailing dot, stray text —
// fails to match and is rejected.
const AMOUNT_DIGITS_RE = /^(\d{1,3}(?:,\d{3})+|\d*)(?:\.(\d{1,2}))?$/;

/**
 * Parse human-typed money input into signed integer minor units (cents).
 *
 * Rules:
 * - Input is in MAJOR units; input without a decimal point is whole major
 *   units: `"1234"` → `123400`, `"1,234.56"` → `123456`, `".5"` → `50`.
 *   Machine input whose scale is not established by the data can opt out of
 *   that assumption with `bareDigits: 'reject'` (see
 *   {@link ParseAmountOptions.bareDigits}) — the default is unchanged.
 * - Negatives: leading sign (`"-12.30"`) or accounting parentheses
 *   (`"(12.30)"`) → `-1230`. Combining both is rejected as ambiguous.
 * - A single leading currency symbol (`$ € £ ¥ ₹`) is tolerated, before or
 *   after the sign: `"$-1,234.56"` and `"-$1,234.56"` both → `-123456`.
 * - Thousands grouping uses commas in strict 3-digit groups; the decimal
 *   separator is `.` with at most 2 digits. (Locale-specific separators —
 *   `1.234,56`, space grouping — are v1-unsupported and rejected.)
 *
 * Rejections (typed errors, never `NaN`):
 * - {@link MoneyParseError}: empty/sign-only input, non-numeric text, more
 *   than 2 decimals, ambiguous or misplaced separators (`"1,23.45"`),
 *   trailing dot (`"12."`), unbalanced parentheses, conflicting signs, and —
 *   under `bareDigits: 'reject'` — any input with no decimal point.
 * - {@link MoneyRangeError}: magnitude beyond ±(2^53 − 1) minor units.
 *
 * @param input Human-typed amount text.
 * @param opts See {@link ParseAmountOptions}.
 * @returns The amount in signed integer minor units.
 */
export function parseAmount(input: string, opts?: ParseAmountOptions): number {
  const allowParens = opts?.allowParens ?? true;
  const allowSymbol = opts?.allowCurrencySymbol ?? true;
  if (typeof input !== 'string') throw new MoneyParseError('amount must be a string');
  let s = input.trim();
  if (s === '') throw new MoneyParseError('empty amount');

  let parenNegative = false;
  if (s.startsWith('(') || s.endsWith(')')) {
    if (!allowParens) throw new MoneyParseError(`parentheses not allowed: ${JSON.stringify(input)}`);
    if (!s.startsWith('(') || !s.endsWith(')')) {
      throw new MoneyParseError(`unbalanced parentheses: ${JSON.stringify(input)}`);
    }
    parenNegative = true;
    s = s.slice(1, -1).trim();
  }

  // Optional sign and currency symbol, in either order, then the digits.
  let sign = '';
  const takeSign = () => {
    if (s.startsWith('-') || s.startsWith('+')) {
      if (sign !== '') throw new MoneyParseError(`conflicting signs: ${JSON.stringify(input)}`);
      sign = s[0];
      s = s.slice(1).trimStart();
    }
  };
  takeSign();
  if (s.length > 0 && CURRENCY_SYMBOLS.has(s[0])) {
    if (!allowSymbol) throw new MoneyParseError(`currency symbol not allowed: ${JSON.stringify(input)}`);
    s = s.slice(1).trimStart();
  }
  takeSign();

  if (parenNegative && sign !== '') {
    throw new MoneyParseError(`ambiguous negative (both sign and parentheses): ${JSON.stringify(input)}`);
  }

  const m = AMOUNT_DIGITS_RE.exec(s);
  if (m === null) throw new MoneyParseError(`unparseable amount: ${JSON.stringify(input)}`);
  const intDigits = m[1].replace(/,/g, '');
  const fracDigits = m[2] ?? '';
  if (intDigits === '' && fracDigits === '') {
    throw new MoneyParseError(`no digits in amount: ${JSON.stringify(input)}`);
  }
  // A caller that has NOT established the scale of bare digits refuses them
  // outright rather than inheriting the major-units default. The test is
  // structural — group 2 is absent exactly when the input carried no `.` — so
  // it does not depend on the value, the sign, or any separator.
  if (opts?.bareDigits === 'reject' && m[2] === undefined) {
    throw new MoneyParseError(
      `amount has no decimal point and its scale is not established — major or minor units is ambiguous: ${JSON.stringify(input)}`,
    );
  }

  // Exact digit math via BigInt so the safe-integer bound check cannot drift.
  const magnitude = BigInt(intDigits === '' ? '0' : intDigits) * 100n + BigInt(fracDigits.padEnd(2, '0') || '0');
  if (magnitude > MAX_MINOR_BIG) {
    throw new MoneyRangeError(`amount exceeds ±(2^53 − 1) minor units: ${JSON.stringify(input)}`);
  }
  const minor = Number(magnitude);
  return parenNegative || sign === '-' ? (minor === 0 ? 0 : -minor) : minor;
}

/** Options for {@link formatAmount}. */
export interface FormatAmountOptions {
  /**
   * ISO-4217-shaped currency code (3 uppercase letters). Known codes
   * (USD, EUR, GBP, JPY, INR) render their symbol as a prefix
   * (`$1,234.56`); other valid codes render as a code prefix
   * (`CAD 1,234.56`). Invalid codes throw {@link MoneyCurrencyError}.
   */
  currency?: string;
  /** Negative style: `'sign'` → `-1,234.56` (default); `'parens'` → `(1,234.56)`. */
  negative?: 'sign' | 'parens';
}

const CURRENCY_SYMBOL_BY_CODE: Readonly<Record<string, string>> = {
  USD: '$',
  EUR: '€',
  GBP: '£',
  JPY: '¥',
  INR: '₹',
};

/**
 * Format signed integer minor units for display: fixed 2 decimals, comma
 * thousands grouping, locale-pinned (the output is built from digits — it
 * never consults the host locale, so it is byte-identical across
 * machines/runs). `123456` → `"1,234.56"`.
 *
 * Negative zero normalises to positive `"0.00"`. Round-trips through
 * {@link parseAmount} exactly for every valid amount (including `'parens'`
 * style and symbol-prefixed currencies).
 *
 * Zero-decimal currencies (JPY-style) are v1-unsupported as a scale: the
 * amount still renders as `minor / 100` with 2 decimals (see module doc).
 *
 * @param minor Amount in signed integer minor units; invalid amounts throw {@link MoneyRangeError}.
 * @param opts See {@link FormatAmountOptions}.
 */
export function formatAmount(minor: number, opts?: FormatAmountOptions): string {
  assertMinor(minor, 'formatAmount');
  const currency = opts?.currency;
  if (currency !== undefined && !isValidCurrencyCode(currency)) {
    throw new MoneyCurrencyError(`invalid currency code: ${JSON.stringify(currency)}`);
  }

  // Exact split into whole/fraction via BigInt (float division of large
  // magnitudes is inexact; digit math is not).
  const big = BigInt(minor);
  const negative = big < 0n;
  const abs = negative ? -big : big;
  const whole = (abs / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const frac = (abs % 100n).toString().padStart(2, '0');
  const digits = `${whole}.${frac}`;

  const symbol = currency !== undefined ? CURRENCY_SYMBOL_BY_CODE[currency] : undefined;
  const codePrefix = currency !== undefined && symbol === undefined ? `${currency} ` : '';
  const body = `${symbol ?? ''}${digits}`;
  if (!negative) return `${codePrefix}${body}`;
  return opts?.negative === 'parens' ? `${codePrefix}(${body})` : `${codePrefix}-${body}`;
}

/**
 * Add minor-unit amounts exactly. Every input and the running sum must be a
 * safe integer; otherwise {@link MoneyRangeError} is thrown (no silent float
 * drift, no wrap-around). `addAmounts()` → `0`.
 */
export function addAmounts(...amounts: number[]): number {
  return sumAmounts(amounts);
}

/**
 * Sum an iterable of minor-unit amounts exactly. Each value is validated with
 * {@link isValidMinor}, and the running sum is re-validated after every step
 * so overflow past ±(2^53 − 1) throws {@link MoneyRangeError} instead of
 * losing precision. An empty iterable sums to `0`.
 */
export function sumAmounts(amounts: Iterable<number>): number {
  let sum = 0;
  for (const amount of amounts) {
    assertMinor(amount, 'sumAmounts');
    sum += amount;
    if (!Number.isSafeInteger(sum)) {
      throw new MoneyRangeError('sumAmounts: sum exceeds ±(2^53 − 1) minor units');
    }
  }
  return sum;
}

/** Negate a minor-unit amount (`negateAmount(0)` stays `0`, never `-0`). Throws {@link MoneyRangeError} on invalid input. */
export function negateAmount(minor: number): number {
  assertMinor(minor, 'negateAmount');
  return minor === 0 ? 0 : -minor;
}

/**
 * Three-way comparison of minor-unit amounts: `-1` if `a < b`, `0` if equal,
 * `1` if `a > b`. Suitable as an `Array.prototype.sort` comparator. Throws
 * {@link MoneyRangeError} on invalid inputs.
 */
export function compareAmounts(a: number, b: number): -1 | 0 | 1 {
  assertMinor(a, 'compareAmounts');
  assertMinor(b, 'compareAmounts');
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * True iff `code` is ISO-4217-shaped: exactly 3 uppercase ASCII letters
 * (`USD`, `EUR`…). Shape-only — this does not check the code against the
 * live ISO registry. Narrowing type guard.
 */
export function isValidCurrencyCode(code: unknown): code is string {
  return typeof code === 'string' && /^[A-Z]{3}$/.test(code);
}

/**
 * Assert every code in `codes` is valid ({@link isValidCurrencyCode}) and
 * identical — ledger entries must not silently mix currencies. Returns the
 * uniform code, or `undefined` for an empty iterable. Throws
 * {@link MoneyCurrencyError} on an invalid code or a mix.
 */
export function assertUniformCurrency(codes: Iterable<string>): string | undefined {
  let uniform: string | undefined;
  for (const code of codes) {
    if (!isValidCurrencyCode(code)) {
      throw new MoneyCurrencyError(`invalid currency code: ${JSON.stringify(code)}`);
    }
    if (uniform === undefined) uniform = code;
    else if (code !== uniform) {
      throw new MoneyCurrencyError(`mixed currencies: ${uniform} vs ${code}`);
    }
  }
  return uniform;
}
