/**
 * Fractional order keys — pure, dependency-free (TBL-1).
 *
 * A key is a non-empty string over the base-62 alphabet `0-9A-Za-z` whose
 * plain lexicographic order IS its numeric order: read it as a fraction in
 * (0, 1) written in base 62 (`'V'` ≈ 0.5, `'0V'` ≈ 0.008…). The ASCII order
 * of the alphabet matches its digit order, so `a < b` on the raw strings is
 * the whole comparator — no parsing, ever.
 *
 * Invariant: a key never ends with the zero digit `'0'`. That guarantees any
 * two distinct keys (and either open end) always have a midpoint, so a move
 * only ever writes ONE small string — the mover's new key — and never has to
 * renumber neighbours. Keys grow ~1 character per ~5 inserts into the same
 * gap (worst case); callers that see a key longer than
 * {@link ORDER_KEY_REBALANCE_LENGTH} should rewrite the whole axis with
 * {@link keysBetween} (see `model.ts` table ops for the pattern).
 */

const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const ZERO = DIGITS[0];
const BASE = DIGITS.length;

/** Keys longer than this ask the owning axis for a rebalance (rare). */
export const ORDER_KEY_REBALANCE_LENGTH = 48;

/** True for a well-formed order key (base-62, non-empty, no trailing zero). */
export function isOrderKey(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    !value.endsWith(ZERO) &&
    [...value].every((ch) => DIGITS.includes(ch))
  );
}

/** Lexicographic comparator (identical to `<` on the raw strings). */
export function compareOrderKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The midpoint of two fraction strings, `a < result < b`.
 * `a === ''` means the lower bound 0; `b === null` means the upper bound 1.
 * Neither input may have a trailing zero digit; the result never does.
 */
function midpoint(a: string, b: string | null): string {
  if (b !== null) {
    // Shared prefix passes through untouched; recurse on the differing tail.
    let n = 0;
    while ((a[n] ?? ZERO) === b[n]) n += 1;
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
  }
  const digitA = a ? DIGITS.indexOf(a[0]) : 0;
  const digitB = b !== null && b.length > 0 ? DIGITS.indexOf(b[0]) : BASE;
  if (digitB - digitA > 1) {
    return DIGITS[Math.round((digitA + digitB) / 2)];
  }
  // Consecutive leading digits: either borrow b's head (when it has a tail to
  // stay below), or extend a's head with a midpoint above a's tail.
  if (b !== null && b.length > 1) return b[0];
  return DIGITS[digitA] + midpoint(a.slice(1), null);
}

/**
 * A key strictly between `a` and `b` (`null` = the open end of the axis).
 * Throws on malformed keys or `a >= b` — callers own their bounds (the table
 * ops fall back to a full-axis rebalance instead of passing bad bounds).
 */
export function keyBetween(a: string | null, b: string | null): string {
  if (a !== null && !isOrderKey(a)) throw new RangeError(`invalid order key: ${JSON.stringify(a)}`);
  if (b !== null && !isOrderKey(b)) throw new RangeError(`invalid order key: ${JSON.stringify(b)}`);
  if (a !== null && b !== null && a >= b) throw new RangeError(`order keys out of order: ${a} >= ${b}`);
  return midpoint(a ?? '', b);
}

/**
 * `n` fresh keys strictly between `a` and `b`, in ascending order — balanced
 * binary subdivision, so lengths stay ~log₆₂(n). Deterministic: the same
 * bounds and count always produce the same keys (two peers migrating the same
 * legacy table concurrently write identical values and converge trivially).
 */
export function keysBetween(a: string | null, b: string | null, n: number): string[] {
  if (n <= 0) return [];
  const mid = keyBetween(a, b);
  if (n === 1) return [mid];
  const left = (n - 1) >> 1;
  return [...keysBetween(a, mid, left), mid, ...keysBetween(mid, b, n - 1 - left)];
}
