# Beancount export (LGR-13)

The ledger exports the whole book as a [Beancount](https://beancount.github.io/)
journal — `GET /api/ledger/export.beancount`, `DataClient.ledgerExportBeancount()`,
or the **Beancount export** block's *Export & verify* action. The point is not a
second backup format (the canonical CSV, LGR-7, is the insurance copy): it is an
**external reference implementation**. `bean-check` and Fava re-derive every
balance from the exported directives with an independent codebase, so the export
turns the whole Beancount ecosystem into free QA for the ledger's arithmetic.

One read model, two serializers: the journal is built from exactly the entities
the CSV export reads (`accounts`, `transactions` + postings, `periods`), by the
pure `buildLedgerBeancount` in `packages/sdk/src/ledgerBeancount.ts`. The same
function serves the HTTP route, the in-app action, and the CI gate — there is no
second implementation to drift.

**Byte-stability.** Same book ⇒ identical bytes, across runs, restarts, and
unrelated mutations elsewhere in the library (asserted in
`packages/server/src/ledgerBeancountExport.test.ts`). Output depends only on
stored field values, never on read order, key order, locale, or the clock.

## What is emitted

| Directive | Source | Notes |
|---|---|---|
| `open` | every account | Date = earliest reported posting on the account, else the account's creation date. The account currency is pinned, so bean-check independently enforces the ledger's one-currency-per-account rule. `lp-id` metadata carries the row id; `lp-name` carries the original ledger name whenever mangling changed it. |
| `txn` (`*`) | every **posted or void** transaction | Drafts never export (not on the books). Ordered by entry number. Ledger-only facts ride as metadata: `lp-id`, `lp-entry-no`, `lp-state` (only `"void"`), `lp-kind` (only `"closing"`), `lp-reverses`, `lp-evidence-<n>`; postings carry `lp-memo` and `lp-cleared` (only `cleared`/`reconciled`). |
| `balance` | every **closed** period | Dated the day after the period end (Beancount assertions bind at the start of their date), one per account with a reported posting on or before the end, asserting the whole-book balance as of the end. Income-statement accounts assert **0.00** after the closing sweep, so bean-check re-verifies the close itself. Reopened periods assert nothing — they are history, not a live claim. |

### Why void transactions export

Both halves of a reversal pair export: the void original **and** its posted
reversal. This mirrors the ledger's own report folds (`REPORTED_STATES` =
posted + void — a void original is exactly offset by its reversal). Exporting
only posted entries would put reversals on the books without the entries they
reverse and misstate every affected balance; exporting neither half breaks on
reversal *chains* (A reversed by B, B reversed by C nets to A's effect). The
`lp-state: "void"` metadata lets a Beancount-side consumer filter pairs out if
it wants the netted view.

### Sign mapping — the identity

The ledger stores signed **debit-positive** integer minor units (LGR-2).
Beancount amounts are signed decimals with the same convention: an asset
increase is positive, and credit-normal balances (Income, Liabilities, Equity)
are carried negative. So a posting's `amountMinor` maps to its decimal value
with **no re-signing anywhere, including contra and credit-normal accounts** —
a revenue balance exports negative, exactly as Beancount's own Income accounts
hold it. Amounts are rendered by `formatBeancountAmount` (exact BigInt digit
math, `-?\d+\.\d\d`, negative zero normalised to `0.00`); no float ever touches
an amount.

### Account-name mangling

Beancount requires `Root:Component[:Component…]` where the root is one of
`Assets | Liabilities | Equity | Income | Expenses` and every component matches
`[A-Z0-9][A-Za-z0-9-]*`. Ledger names are colon-paths with a free charset, so:

1. **Root from the TYPE, never the name**: `asset→Assets`, `liability→Liabilities`,
   `equity→Equity`, `revenue→Income`, `expense→Expenses`. An account named
   `Revenue:Sales` (type `revenue`) becomes `Income:Revenue:Sales`.
2. **Component mangling**: every character outside `[A-Za-z0-9-]` becomes `-`
   (one dash per character, no collapsing); a leading lowercase letter is
   uppercased; any other invalid lead gets an `X` prefix. `Expenses:Bank Fees`
   → `Expenses:Bank-Fees`; `misc:stuff` (expense) → `Expenses:Misc:Stuff`;
   `Expenses:café & misc.` → `Expenses:Caf----misc-`.
3. A first component equal to the root is not repeated — unless dropping it
   would leave the bare root, which Beancount rejects (`Assets` → `Assets:Assets`).
4. **Collisions** (mangling is lossy): accounts are visited in creation order
   (`createdAt`, then id); the first claimant keeps the name, later ones append
   `-2`, `-3`, … to the final component, bumping until free. Deterministic for
   a given book; adding a colliding account is a data change and may re-suffix
   later claimants — the `lp-id`/`lp-name` metadata on `open` is the stable link
   back to the ledger row.

### Evidence

Evidence attachments are content hashes and ids, not exportable files. The
board sketched `document` directives, but bean-check **fails** on a `document`
whose file does not exist on disk (verified against beancount 3.1.0) — which
would redden every evidence-bearing export precisely in the toolchain this
task adopts for QA. Evidence therefore rides as transaction metadata:
`lp-evidence-<n>: "<filename> sha256=<hash> size=<bytes>"`. A future task that
materialises evidence files into an export directory can switch to real
`document` directives.

### Statement balances (reconciliations) are deliberately NOT asserted

A finished reconciliation proves the statement balance equals the sum of
**cleared** postings on the statement date. A Beancount `balance` assertion
checks the **whole-book** balance — cleared and pending alike — so asserting
statement balances would fail on any account with legitimate uncleared activity.
The reconciliation facts stay in the ledger; only whole-book claims export.

## Corrupt books are refused

Unlike the insurance CSV (which must always leave the building, LGR-7), the
reference export **throws** on a book it cannot vouch for: a posting whose
account does not resolve (`account-not-found`) or a stored amount that is not a
safe integer (`MoneyRangeError`). A reference journal that silently serialized
plausible-but-wrong directives would defeat its purpose; the LGR-7 verifier
(`/api/ledger/verify`, surfaced by the same *Export & verify* action) is the
tool that names the damage.

## Round-trip limitations

The journal is a faithful **projection**, not a lossless dump:

- **Names are mangled** (see above). Reversible via `lp-name`/`lp-id` metadata,
  not from the mangled name alone.
- **Closed accounts** emit no `close` directive — the ledger records status,
  not a closure date.
- **Open dates are inferred** (earliest posting, else creation date), not a
  stored fact.
- **Cleared workflow** round-trips only coarsely: `lp-cleared` marks
  `cleared`/`reconciled` legs, but reconciliation rows themselves (statement
  dates, balances, status history) do not export.
- **Drafts, the audit log, periods-as-records, and evidence bytes** do not
  export. The audit hash chain is verifiable only inside the ledger.
- **Amount scale** is the ledger's fixed 2-decimal minor unit for all
  currencies (LGR-2 v1) — a zero-decimal currency book would export scaled by
  100 until per-currency exponents land.
- Timestamps (`postedAt`, `createdAt`) do not export; the journal is dated at
  day granularity like Beancount itself.

## The CI gate (bean-check + Fava parity)

`pnpm run test:beancount` runs
`packages/server/src/ledgerBeancountGate.test.ts`:

- `bean-check` (via `python -m beancount.scripts.check`) must pass on the
  fixture exports — a small hostile book and a deterministic 500-transaction
  book (`packages/sdk/src/ledgerBeancountFixture.ts`; the generator is
  committed, not megabytes of fixture).
- **Parity to the cent**: per-account, per-currency balances in integer minor
  units AND the transaction count, comparing the ledger's own LGR-8 fold
  (`accountBalances`, imported from the shipped plugin sources with
  `@book.dev/plugin-sdk` aliased to `@book.dev/sdk` — the identical mapping the
  plugin host performs at runtime) against `scripts/beancount_parity.py`, which
  computes the same figures with the real beancount **loader** — the code path
  bean-check and Fava sit on. "Fava-computed" on the board means "computed by the Beancount
  ecosystem, not by us"; using `beancount.loader` directly keeps the pinned
  toolchain to one package while exercising the same computation Fava renders.
- Two **mutation tests** keep the gate falsifiable: dropping a transaction from
  the export input fails the count *and* balance comparison; deleting a txn
  block from the serialized text fails bean-check on the balance assertions.

CI pins Python 3.12 and `beancount==3.1.0` (`.github/workflows/ci.yml`, job
`beancount`) and sets `OPENBOOK_REQUIRE_BEANCOUNT=1`, so a missing toolchain is
a **failure** there. Locally the suite skips those tests with a printed notice
when no Python can `import beancount`; install it (`pip install beancount`) or
point `OPENBOOK_BEANCOUNT_PYTHON` at a venv's interpreter to run the gate live.
