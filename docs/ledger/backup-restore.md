# Backup architecture & restore runbook

How an OpenBook library — and above all its **ledger** — is backed up, what a
backup contains, how to restore one, and how CI proves the whole story on every
change (LGR-15 / OB-603).

## Backup architecture

### What runs

| Path | Trigger | Output |
|---|---|---|
| Scheduled backups (`BackupScheduler`, OB-166) | daily / weekly / monthly / yearly cadences, grandfather-father-son rotation | `<backup dir>/<cadence>/openbook-backup-<ISO>.openbook.json` |
| Ad-hoc export | `GET /api/export`, or Settings → Backup → Export | the same bundle, downloaded |
| "Back up now" | `POST /api/backups/run` | one scheduled-style snapshot, on demand |

All three write the **same bundle format**, so anything below applies to every
snapshot regardless of how it was made. Snapshots are written atomically
(temp-file + rename): a crash mid-write never leaves a truncated backup.

Scheduled backups default **on**, to `<dataDir>/backups`; policy (cadences,
retention counts, output dir) lives in Settings → Backup and
`GET/PUT /api/backups`. The in-webview (browser-storage) home has no
filesystem, so only the ad-hoc export applies there.

### What a bundle contains (`BACKUP_VERSION = 2`)

```jsonc
{
  "version": 2,
  "exportedAt": "…",
  "pages": [ /* every live page: data, nesting, properties, position, created_at */ ],
  "databases": [ /* every database: schema, host page */ ],
  "icons": { /* pageId → emoji, added client-side */ },
  "ledger": { // present iff a ledger is seeded — the DURABILITY SECTION (LGR-15)
    "settings": { "ledgerDb": {}, "ledgerPeriods": [], "ledgerEntrySeq": 0 },
    "audit":    [ /* the FULL append-only audit stream, seq order, hashes verbatim */ ],
    "assets":   [ /* evidence bytes named by transaction manifests, base64, content-addressed */ ]
  }
}
```

The ledger's *entities* (accounts, transactions, postings, reconciliations and
their host pages) travel as ordinary pages/databases. The `ledger` section
carries what those rows cannot express:

- **`settings`** — the seeded database ids, the period records, and the
  entry-number sequence;
- **`audit`** — the tamper-evidence chain, **verbatim** (every `seq`, payload,
  `before/after/prev` hash). A restore re-inserts it as-is — the chain
  *survives* the round trip; it is never re-minted;
- **`assets`** — the receipt bytes behind each evidence manifest (drafts
  included, so a restored draft can still post). Each asset's id **is** the
  SHA-256 of its bytes; the importer re-hashes on the way in and refuses a
  mismatch.

**Version compatibility:** a v1 bundle (no `ledger` key) still restores its
pages/databases; a v2 bundle read by an older server restores pages/databases
and ignores the extra key. A v1 restore of a ledger library yields dead ledger
rows with no history — which the verifier reports loudly (see below). Re-export
from a current server to get a v2 bundle.

**Known limitation:** non-evidence assets (e.g. images embedded in ordinary
pages) are not yet carried by the bundle — unchanged from v1.

## Restore runbook

The supported ledger restore is **whole-space, overwrite mode, into a fresh
library**. (Copy mode re-ids every page, which would sever the audit stream's
entity references — the server refuses to apply the ledger section in copy
mode, and reports why.)

1. **Stop** the affected server (embedded mode: whatever owns the data dir).
2. **Point the server at a fresh store** — a new `--data-dir` /
   `OPENBOOK_DATA_DIR` (embedded) or a freshly created database behind
   `OPENBOOK_DATABASE_URL` (server mode). Do not reuse the damaged store;
   keep it for forensics.
3. **Restore the newest good snapshot**, either way:
   - UI: Settings → Backup → Restore → choose the `.openbook.json` file, keep
     **everything** selected, mode **Overwrite**.
   - API: `POST /api/import` with the bundle's `pages`, `databases`, `ledger`
     and `"mode": "overwrite"` (instance-admin gated).
4. **Check the outcome field.** The response's `ledger` field must read
   `"restored"`. Anything else names the reason it was skipped:
   `skipped-existing-ledger` (the target already has a ledger — LGR-3
   protections stand; use a genuinely fresh library),
   `skipped-copy-mode`, or `skipped-incomplete` (the selection didn't include
   the ledger's own pages — restore with everything selected).
5. **Verify — mandatory.** Run `GET /api/ledger/verify` (or the in-app
   *Export & verify* action / the CLI verify). The report must show
   `findings: []` with nonzero `checked*` counts. This runs the full LGR-7
   invariant re-check *including* the audit-chain re-derivation and the
   evidence re-hash — a restore that silently lost or altered anything cannot
   pass it.
6. Resume service. The restored ledger is live: posting continues the restored
   audit chain and entry numbering (the restore advances the audit sequence
   past the restored tail).

A restore is **transactional**: if any part of the ledger section is invalid
(non-ascending audit seqs, unknown audit action, asset bytes that don't hash to
their id), the entire import — pages included — rolls back with a descriptive
error. There is no half-restored state to clean up.

Restores are also **deduplicated** (ER-6): re-applying the byte-identical
bundle is a no-op that echoes the recorded result — a retried restore cannot
duplicate the library.

## What "equal" means (the canonicalization decision)

The restore CI asserts equality on two axes, and it's worth being precise about
what is and is not promised:

- **Byte equality** is defined over the *canonical serializers*: the postings
  CSV (`exportPostingsCsv`) and the Beancount journal (`exportBeancount`) must
  be **byte-identical** before and after the round trip, and the audit stream
  must round-trip verbatim under `canonicalLedgerJson`. These serializers
  impose a total, storage-independent order — that is exactly why LGR-7/LGR-13
  built them byte-stable, and the restore test reuses them as the diff tool
  rather than inventing a second one.
- **Raw SQL dumps are *not* compared**, deliberately: storage incidentals
  (physical row order, `updated_at` touch-stamps, JSONB key order) legitimately
  differ across a dump/restore and carry no ledger meaning.
- Everything that **feeds a ledger content hash** *is* preserved bit-for-bit by
  the bundle and proven by the verifier: page `properties` (the audited
  content), posting **`position`** (posting order is hashed — bundles carry
  `position` since v2 for exactly this reason), `created_at`, and the audit
  rows' recorded hashes.
- **Semantic equality** is the LGR-7 verifier (`findings: []`, all `checked*`
  counts equal to the source's) plus a clean `verifyAuditChain` of unchanged
  length.

## CI enforcement

The `durability` job (`.github/workflows/ci.yml`) proves the story on every PR,
on **both** storage backends — embedded PGlite and a **pinned real Postgres
service container**. (Real Postgres matters: the wire driver has its own
parameter serialization; the PGlite-only era hid a real jsonb double-encoding
bug that this job now regression-pins.)

1. **Restore round-trip** — `src/ledgerRestore.test.ts` with
   `OPENBOOK_RESTORE_FIXTURE=parity` (the 500-transaction LGR-13 parity book,
   seeded through the real API with evidence, reversals, and a closed + a
   reopened period): back up → destroy → restore → assert everything in the
   section above, then post again to prove the book is alive. The suite also
   pins the doors: no ledger-section apply over an existing ledger, in copy
   mode, or without the ledger's own pages; forged asset bytes reject the
   whole import.
2. **Benchmarks** — `pnpm run bench:ledger` (`src/ledgerDurability.bench.ts`),
   thresholds **asserted**, numbers appended to the job summary:

   | metric | budget | measured shape |
   |---|---|---|
   | trial balance over 10 000 postings | **< 500 ms** | one full `listTransactions` read (1000 × 10-leg entries — the report's single-page read) + the **shipped** plugin fold (`buildTrialBalance` from the plugin's own sources) |
   | 1 000-row import | **< 5 s** | 1000 sequential two-leg `createDraft` calls — the LGR-10 import block's apply-loop shape |

   Anti-flake structure (and what it deliberately does *not* do): one
   unmeasured warm-up, then the **median of N** runs (7 for the read, 3 for
   the write) is asserted — a lone GC pause or scheduler hiccup cannot fail
   the job, only a shift of the distribution's middle can.
   `OPENBOOK_BENCH_TIME_MULTIPLIER` scales the budgets for slow **local**
   machines only; **CI does not set it** — the proof job asserts the board's
   own numbers at ×1. The budgets stay falsifiable: measured baselines (in
   every job summary) sit several-fold under budget, so the headroom absorbs
   machine noise, not algorithmic regressions — an accidental O(n²) on a
   10k-posting read or a per-row scan on inserts (the exact regression class
   migration `0023` fixed) blows through them on any hardware.

Both halves run the two backends via `OPENBOOK_TEST_DATABASE_URL` (a Postgres
server scratch databases may be created on) with
`OPENBOOK_REQUIRE_LEDGER_PG=1` in CI: locally, an absent server **skips the
Postgres half loudly** (a console notice, LGR-13's optional-but-gating
pattern); in CI, absence is a hard failure — the real-Postgres coverage can
never be lost silently.

Run locally:

```sh
# restore round-trip (PGlite; + Postgres when OPENBOOK_TEST_DATABASE_URL is set)
pnpm --filter @book.dev/server exec vitest run src/ledgerRestore.test.ts

# benchmarks (kept OUT of `pnpm verify` — wall-clock asserts live in their own job)
pnpm run bench:ledger

# with a local Postgres, e.g.:
docker run -d --name ob-pg -e POSTGRES_PASSWORD=postgres -p 55432:5432 postgres:16.9-alpine
OPENBOOK_TEST_DATABASE_URL='postgres://postgres:postgres@127.0.0.1:55432/postgres' pnpm run bench:ledger
```
