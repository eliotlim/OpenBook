/**
 * LGR-13 — the Beancount reference gate: `bean-check` on the fixture exports,
 * and the Fava/OpenBook trial-balance parity comparison, to the cent.
 *
 * WHAT RUNS AGAINST WHAT:
 *  - the EXPORT side is the sdk's `buildLedgerBeancount` — the exact function
 *    the server route and the in-app "Export & verify" action run;
 *  - the LEDGER side is the plugin's LGR-8 fold (`accountBalances`), imported
 *    from the SHIPPED plugin sources (`examples/plugins/ledger/src/reports`),
 *    with `@book.dev/plugin-sdk` aliased to `@book.dev/sdk` — the identical
 *    mapping the host's `hostModulesFor` performs at runtime, so this is the
 *    same fold code the trial-balance block renders, not a re-implementation
 *    (the loader-driven execution path is covered by the ui plugin suites);
 *  - the BEANCOUNT side is the real beancount loader (the code path bean-check
 *    and Fava sit on), driven by `scripts/beancount_parity.py`.
 *
 * The comparison is falsifiable BY CONSTRUCTION: one mutation test drops a
 * transaction from the export input and asserts the gate reports BOTH a count
 * mismatch and balance mismatches; another deletes a serialized txn block and
 * asserts bean-check itself fails on the balance assertions.
 *
 * OPTIONAL-BUT-GATING: without a Python that can `import beancount`, the suite
 * SKIPS with a loud console notice (never silently) — unless
 * `OPENBOOK_REQUIRE_BEANCOUNT=1` (the CI `beancount` job's setting), where a
 * missing toolchain is a FAILURE. Locally: `pip install beancount` (any 3.x)
 * or point `OPENBOOK_BEANCOUNT_PYTHON` at a venv's python.
 */

import {spawnSync} from 'node:child_process';
import {existsSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {afterAll, describe, expect, it} from 'vitest';
import {
  buildBeancountAccountNames,
  buildBeancountMiniBook,
  buildBeancountParityBook,
  buildLedgerBeancount,
  BEANCOUNT_PARITY_TX_COUNT,
  type LedgerBeancountFixtureBook,
  type LedgerTransaction,
} from '@book.dev/sdk';
// The plugin's OWN LGR-8 fold, from the shipped sources (see module doc).
import {accountBalances, isReported} from '../../../examples/plugins/ledger/src/reports';

/** The repo root, walked up from the test cwd (vitest runs from packages/server). */
function repoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`could not locate the repo root above ${process.cwd()}`);
}

const PARITY_SCRIPT = join(repoRoot(), 'scripts', 'beancount_parity.py');
const REQUIRED = process.env.OPENBOOK_REQUIRE_BEANCOUNT === '1';

/** A python that can `import beancount`, or null (probed once per run). */
function findBeancountPython(): string | null {
  const candidates = [process.env.OPENBOOK_BEANCOUNT_PYTHON, 'python3', 'python'].filter(
    (c): c is string => typeof c === 'string' && c !== '',
  );
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['-c', 'import beancount, sys; sys.stdout.write(beancount.__version__)'], {
      encoding: 'utf8',
    });
    if (probe.status === 0) return candidate;
  }
  return null;
}

const python = findBeancountPython();
if (python === null) {
  // A VISIBLE skip notice (the board's "graceful skip" is graceful, not
  // silent) — and under the CI job's flag, not a skip at all (see below).
  console.warn(
    '[LGR-13] bean-check + Fava-parity gate SKIPPED: no Python with `beancount` importable. ' +
      'Install it (`pip install beancount`) or set OPENBOOK_BEANCOUNT_PYTHON to a venv python. ' +
      'CI runs this gate with a pinned toolchain regardless.',
  );
}

const tmp = mkdtempSync(join(tmpdir(), 'ob-lgr13-beancount-'));
afterAll(() => rmSync(tmp, {recursive: true, force: true}));

/** Write a book's export and return the journal path + text. */
function exportBook(name: string, book: LedgerBeancountFixtureBook, transactions?: LedgerTransaction[]): {path: string; text: string} {
  const text = buildLedgerBeancount(book.accounts, transactions ?? book.transactions, book.periods);
  const path = join(tmp, `${name}.beancount`);
  writeFileSync(path, text, 'utf8');
  return {path, text};
}

/** Run bean-check (via `python -m`, so no PATH entry point is needed). */
function beanCheck(path: string): {status: number | null; output: string} {
  const run = spawnSync(python as string, ['-m', 'beancount.scripts.check', path], {encoding: 'utf8'});
  return {status: run.status, output: `${run.stdout}${run.stderr}`.trim()};
}

interface ParityResult {
  transactionCount: number;
  balances: Record<string, Record<string, number>>;
}

/** Run the parity script and parse its JSON verdict. */
function beancountParity(path: string): ParityResult {
  const run = spawnSync(python as string, [PARITY_SCRIPT, path], {encoding: 'utf8'});
  expect(run.status, run.stderr).toBe(0);
  return JSON.parse(run.stdout) as ParityResult;
}

/** The ledger side of the comparison, from the plugin's OWN LGR-8 fold. */
function ledgerSide(book: LedgerBeancountFixtureBook): ParityResult {
  const names = buildBeancountAccountNames(book.accounts);
  const currencyById = new Map(book.accounts.map((a) => [a.id, a.currency]));
  const balances: Record<string, Record<string, number>> = {};
  accountBalances(book.transactions).forEach((minor, accountId) => {
    const name = names.get(accountId);
    const currency = currencyById.get(accountId);
    expect(name, `fold saw unknown account ${accountId}`).toBeDefined();
    balances[name as string] = {[currency as string]: minor};
  });
  return {
    transactionCount: book.transactions.filter((tx) => isReported(tx)).length,
    balances,
  };
}

/**
 * The parity verdict: every mismatch NAMED. Both sides compare per-account,
 * per-currency, in integer minor units — to the cent — plus the transaction
 * count, so a dropped transaction whose postings cancel still fails.
 */
function compareParity(expected: ParityResult, actual: ParityResult): string[] {
  const problems: string[] = [];
  if (expected.transactionCount !== actual.transactionCount) {
    problems.push(`transaction count: ledger ${expected.transactionCount} vs beancount ${actual.transactionCount}`);
  }
  const accounts = new Set([...Object.keys(expected.balances), ...Object.keys(actual.balances)]);
  for (const account of [...accounts].sort()) {
    const want = expected.balances[account];
    const got = actual.balances[account];
    if (want === undefined) {
      problems.push(`${account}: beancount carries it, the ledger fold does not`);
      continue;
    }
    if (got === undefined) {
      problems.push(`${account}: the ledger fold carries it, beancount does not`);
      continue;
    }
    const currencies = new Set([...Object.keys(want), ...Object.keys(got)]);
    for (const currency of [...currencies].sort()) {
      if ((want[currency] ?? 0) !== (got[currency] ?? 0)) {
        problems.push(`${account}: ${currency} ${want[currency] ?? 0} (ledger) vs ${got[currency] ?? 0} (beancount)`);
      }
    }
  }
  return problems;
}

it('the beancount toolchain is present when the gate is REQUIRED (CI)', () => {
  if (REQUIRED) {
    expect(python, 'OPENBOOK_REQUIRE_BEANCOUNT=1 but no python with beancount importable').not.toBeNull();
  }
});

describe.skipIf(python === null)('LGR-13 — bean-check + Fava parity gate', () => {
  it('bean-check passes on the mini fixture export', {timeout: 60_000}, () => {
    const {path} = exportBook('mini', buildBeancountMiniBook());
    const {status, output} = beanCheck(path);
    expect(output).toBe('');
    expect(status).toBe(0);
  });

  it('bean-check passes on the 500-transaction parity export (balance assertions included)', {timeout: 60_000}, () => {
    const book = buildBeancountParityBook();
    const {path, text} = exportBook('parity', book);
    // The export must actually carry assertions for bean-check to re-verify.
    expect(text).toMatch(/^\d{4}-\d{2}-\d{2} balance /m);
    const {status, output} = beanCheck(path);
    expect(output).toBe('');
    expect(status).toBe(0);
  });

  it('Fava/OpenBook trial balance parity holds to the cent on the 500-transaction book', {timeout: 60_000}, () => {
    const book = buildBeancountParityBook();
    const {path} = exportBook('parity', book);
    const expected = ledgerSide(book);
    expect(expected.transactionCount).toBe(BEANCOUNT_PARITY_TX_COUNT);
    const actual = beancountParity(path);
    expect(compareParity(expected, actual)).toEqual([]);
  });

  it('MUTATION: dropping one exported transaction fails the comparison on count AND balances', {timeout: 60_000}, () => {
    const book = buildBeancountParityBook();
    const expected = ledgerSide(book);
    // Drop a transaction dated AFTER the last balance assertion (2025-01-01),
    // so the tampered journal still LOADS cleanly — proving the comparison
    // itself catches the drop, not just bean-check's assertions upstream.
    const victim = book.transactions.find(
      (tx) => tx.state === 'posted' && tx.reverses === null && tx.kind === null && tx.date > '2025-02-01',
    );
    expect(victim).toBeDefined();
    const {path} = exportBook('parity-tampered', book, book.transactions.filter((tx) => tx.id !== victim?.id));
    const actual = beancountParity(path);
    const problems = compareParity(expected, actual);
    expect(problems.some((p) => p.startsWith('transaction count'))).toBe(true);
    expect(problems.some((p) => !p.startsWith('transaction count'))).toBe(true);
  });

  it('MUTATION: a txn block lost AFTER serialization fails bean-check on the balance assertions', {timeout: 60_000}, () => {
    // This models the serializer bug class (a directive mis-emitted or lost on
    // the way out): the assertions were computed from the full book, so a
    // journal missing one pre-assertion transaction must fail bean-check.
    // (Dropping the transaction from the INPUT instead would self-heal — the
    // exporter would recompute consistent assertions — which is exactly what
    // the count+balance comparison above exists to catch.)
    const book = buildBeancountParityBook();
    const {text} = exportBook('parity', book);
    const victim = book.transactions.find((tx) => tx.state === 'posted' && tx.reverses === null && tx.kind === null && tx.date < '2024-12-01');
    expect(victim).toBeDefined();
    const block = new RegExp(`^\\d{4}-\\d{2}-\\d{2} \\* [^\\n]*\\n  lp-id: "${victim?.id}"\\n(?:.+\\n)*?\\n`, 'm');
    const tampered = text.replace(block, '');
    expect(tampered).not.toBe(text);
    expect(tampered).not.toContain(`lp-id: "${victim?.id}"`);
    const path = join(tmp, 'parity-tampered-text.beancount');
    writeFileSync(path, tampered, 'utf8');
    const {status, output} = beanCheck(path);
    expect(status).not.toBe(0);
    expect(output).toMatch(/Balance failed/i);
  });
});
