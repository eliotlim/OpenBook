# Ledger recovery runbook

How to get your books back, from best source to last resort (LX-4 / OB-663).

Three recovery lanes exist, and they are **not equal**. Prefer the highest one
your situation still has:

| # | Source you hold | What comes back | How |
|---|---|---|---|
| 1 | **Backup bundle** (`*.openbook.json`, LGR-15) | Everything: rows, the original audit chain verbatim, evidence bytes, ids, entry numbers | [Bundle restore](#1-backup-bundle--restore-the-gold-path) |
| 2 | **Site HTML export with records** (LX-2, "Include the books" was on) | The full book replayed — accounts, entries, postings, reconciliations, periods; a **fresh** audit chain with import provenance; **no evidence bytes** | [HTML island restore](#2-html-export--restore-the-round-trip) |
| 3 | **CSV / Beancount export** (LGR-7 / LGR-13, incl. the auto-export file) | The financial data, by re-entry — amounts, dates, accounts; no workflow state, no audit history | [Data-level re-entry](#3-csv--beancount--re-entry-the-last-resort) |

Whatever the lane, finish with the verifier:
`GET /api/ledger/verify` (or `openbook --verify-ledger`) must report
`findings: []` and a green `auditChain` before you trust the restored book.

---

## 1. Backup bundle → restore (the gold path)

The whole-space bundle carries the ledger's **durability section**: settings,
the full audit stream verbatim, and every evidence asset. Restoring it is the
only lane that preserves the original tamper-evidence chain.

Follow the LGR-15 runbook: **[backup-restore.md → Restore runbook](./backup-restore.md#restore-runbook)**.
Short form: fresh library → `POST /api/import` with the bundle in `overwrite`
mode → verify. The restore door refuses over an existing ledger, refuses a
broken hash chain, and brackets the installed history with a `ledger.restore`
provenance event naming the actor and the bundle's content hash.

## 2. HTML export → restore (the round trip)

A **site export** made with *"Include the books"* consent (LX-2) embeds a
machine-readable ledger section — `{settings, library, auditHead}` — in the
file's source island, alongside the pages.

**To restore:** open the target library → **Import** (Home quick action or
Settings) → choose the exported `.html` file. When the file carries ledger
records the preview shows a **"Restore ledger records"** toggle with the tally;
confirm to land both the pages (always a copy) and the books.

What happens under the hood (`POST /api/ledger/restore-section`,
instance-admin gated):

- the section is **deep-validated first** (`parseLedgerExportSection` — the
  same validator the import dialog previews with): balance, reversal pairing,
  reconciliation ownership, period coherence. An incoherent section is refused
  before the first write.
- the book is **replayed through the ledger writer** — `createAccount`,
  `createDraft`/`post`, `reverse`, the reconciliation and period calls. No
  direct row writes, so every store invariant holds on the restored book by
  construction, and every replayed mutation appends its ordinary audit event.
- the fresh chain ends with a **`ledger.restore` provenance event** recording
  who imported, the section's content hash (`bundleSha`),
  `source: 'export-section'`, the source book's exported audit-chain anchor
  (`sourceAuditHeadSeq`/`sourceAuditHeadHash`), and the degradation counters.

**Empty target only.** If the library already keeps *any* ledger data — an
account, a journal entry (drafts included), a reconciliation, a period record —
the restore refuses with a typed error naming what exists. Merging is
explicitly out of scope: restore into a fresh library, or back up and clear
first. (Seeded-but-empty — someone merely opened the ledger screen — is fine.)

**Known, honest degradations** (surfaced in the result and on the provenance
event, never silent):

- **Evidence bytes are not in an HTML export.** Manifests are dropped and
  counted (`evidenceDropped`). Recover receipts from a backup bundle.
- **The original audit stream is not in an HTML export** — only its head
  anchor, which the provenance event records. The restored chain is fresh;
  entry numbers and posted-at stamps are re-minted (report numbers are
  date-driven and unaffected).
- A **reopened** period's void closing entry + reversal are regenerated; if
  entries were posted into the range after the source's reopen, that void pair
  can differ in amount from the source's — it nets to zero either way.
- An exotic reconciliation history (a finish that leaned on a later-reopened
  statement) may not re-freeze exactly; the replay then leaves that statement
  **abandoned** and counts it (`reconciliationsDowngraded`). Amounts are
  untouched.
- The replay is **not one transaction** (each writer mutation commits itself).
  The up-front validation makes a mid-replay failure an environment problem,
  not an expected path — but if one happens, treat the target as a partial
  book: verify, then clear/re-restore. Concurrent restores are serialized
  in-process and refused; don't race two restores from different processes.

## 3. CSV / Beancount → re-entry (the last resort)

The canonical postings CSV (LGR-7; also what [auto-export](#ledger-auto-export-the-standing-insurance)
writes) and the Beancount journal (LGR-13) are **data-level** exports: they
carry every posted amount, date, account, and memo, but no drafts-vs-void
workflow, no reconciliation state, no evidence, no audit history — and there is
no automated importer for them.

They are for when lanes 1–2 are gone, or for migrating into other tooling:

- **Into other tools:** the Beancount journal loads directly into
  beancount/fava; the CSV loads into any spreadsheet or `bean-extract`-style
  pipeline. This is often the *right* destination after a disaster — the books
  stay usable even if OpenBook never reopens.
- **Back into OpenBook:** re-enter through the ordinary surfaces — recreate the
  chart of accounts, then re-key entries (or script them against the ledger
  API: `POST /api/ledger/transactions` + `/post`). The bank-statement import
  flow in the ledger plugin can shortcut bulk re-entry of bank rows.
  Re-entered history starts a new audit chain that begins with you.

## Ledger auto-export (the standing insurance)

Off by default. When enabled, the server rewrites the canonical postings CSV —
atomically, debounced — after **every** ledger mutation, so lane 3 always
exists on disk even if the app never opens again.

- **Turn it on:** Settings → Data (admin) → *Ledger auto-export*: enter an
  absolute path and flip the switch. Owner-only (`PUT /api/instance`,
  `ledgerAutoExportPath`); the change itself is audited
  (`ledger.autoExportPath`).
- **The path is fenced.** It must sit inside an allowed export root — by
  default `<dataDir>/exports`; operators may add roots via
  `--ledger-export-root` / `OPENBOOK_LEDGER_EXPORT_ROOTS` (process-side only,
  never settable over HTTP). A path outside the fence is refused, visibly.
- The write is atomic (temp file + rename, fsync'd, 0600) — a crash never
  leaves a truncated CSV.

Pair it with scheduled backups (lane 1): auto-export keeps the *numbers* safe
in a tool-neutral form; only a bundle keeps the *history and evidence*.
