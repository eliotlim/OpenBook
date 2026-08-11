# Backup architecture & restore runbook

How an OpenBook library — and above all its **ledger** — is backed up, what a
backup contains, how to restore one, and how CI proves the whole story on every
change (LGR-15 / OB-603).

> Looking for the ledger-specific "which source do I restore from" decision —
> HTML export, CSV/Beancount, auto-export file? Start at the
> **[ledger recovery runbook](./recovery-runbook.md)** (LX-4); this document is
> its lane 1.

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
The scheduled writer serializes directly into that temp file, awaiting every
append and fetching/encoding one asset at a time. Its asset-specific high-water
mark is one 10 MiB raw asset plus its base64 value and serialized JSON (about
37 MiB, plus database/VM overhead), independent of the library's total asset
corpus; page/database metadata and an optional ledger section remain snapshot
arrays.

Scheduled backups default **on**, to `<dataDir>/backups`; policy (cadences,
retention counts, output dir) lives in Settings → Backup and
`GET/PUT /api/backups`. The in-webview (browser-storage) home has no
filesystem, so only the ad-hoc export applies there.

**Protect the backup directory permissions.** Version 3 bundles — including
scheduled on-disk snapshots — contain page ACLs and member email addresses in
addition to private page and ledger content. Only the service account and the
operators responsible for recovery should be able to read that directory.

### What a bundle contains (`BACKUP_VERSION = 3`)

```jsonc
{
  "version": 3,
  "exportedAt": "…",
  "instanceId": "…", // stable origin binding (ownerSubject is included when claimed)
  "pages": [ /* every live page: data, nesting, properties, position, created_at */ ],
  "databases": [ /* every database: schema, host page */ ],
  "icons": { /* pageId → emoji, added client-side */ },
  "assets": [ /* every referenced asset once: {id, mime, size, bytesBase64, refs[]} */ ],
  "pageAccess": [
    /* one per page: {pageId, visibility, agentEdits, acl:[{subject|email, issuer, level, invitedBy, createdAt}]} */
  ],
  "ledger": { // present iff a ledger is seeded — the DURABILITY SECTION (LGR-15)
    "settings": { "ledgerDb": {}, "ledgerPeriods": [], "ledgerEntrySeq": 0 },
    "audit":    [ /* the FULL append-only audit stream, seq order, hashes verbatim */ ]
  }
}
```

`assets` is the complete live-page asset corpus, including ordinary images,
HTML artifacts, property assets, and ledger evidence. Entries are deduplicated
by SHA-256 `id`; `refs` is derived from page documents/properties rather than
the potentially stale reachability table. Export fails if any referenced bytes
are missing or their stored hash/size is inconsistent. Restore verifies the
whole manifest (shape, coverage, refs, base64 size, SHA-256, mime/caps/budget)
before writing anything.

`pageAccess` preserves the stored access posture exactly: visibility scope,
agent-edits policy, and subject/email ACL grants with issuer, level, inviter,
and creation time. It contains exactly one record for every exported page.
The restore door installs it automatically only when the envelope's
`instanceId` matches the target. Foreign or older origin-less v3 bundles restore
pages as `restricted` with no ACLs and safe agent-edit settings, and return a
`partial-restore` diagnostic, unless the operator explicitly opts in with
`installForeignPageAccess: true` after reviewing the access delta.

The ledger's *entities* (accounts, transactions, postings, reconciliations and
their host pages) travel as ordinary pages/databases. The `ledger` section
carries what those rows cannot express:

- **`settings`** — the seeded database ids, the period records, and the
  entry-number sequence;
- **`audit`** — the tamper-evidence chain, **verbatim** (every `seq`, payload,
  `before/after/prev` hash). A restore re-inserts it as-is — the chain
  *survives* the round trip; it is never re-minted;
- evidence bytes now travel in the top-level `assets` manifest with every other
  referenced asset (drafts included, so a restored draft can still post).

**Version compatibility:** v1 and v2 still restore, but the response includes a
structured `diagnostics[]` entry with `code: "partial-restore"` and an explicit
`missing` list. v2 lacks the complete asset manifest and page access state; v1
also lacks the ledger durability section. Unknown future versions are refused
before writes with a clear unsupported-version error. Re-export from a current
server to obtain a complete v3 bundle. Two other deliberate refusals to know about:

- a restored library's audit stream ends with a **`ledger.restore`** event
  (see *Trust model* below). Builds that predate that action **refuse to read
  streams containing it** — the audit log's fail-closed unknown-action posture
  — so a bundle exported *from a restored library* must itself be restored on
  a current build. This is intentional: an old build silently mis-replaying a
  newer history is the worse outcome.
- a bundle whose audit history predates the linear hash chain (migration
  `0021`, i.e. carries mid-stream `prevHash: null`) is refused at the door as
  unverifiable — the door will not install a stream the tamper check rejects.

**Known limitation:** the bundle remains one JSON document. Ad-hoc HTTP export
and import still materialize it in memory (import is bounded by the route's 512
MiB body cap); only the scheduled on-disk writer streams today. A streaming
transport/parser for those HTTP paths is future work.

**Scope boundary:** this is a lossless restore of the documented *live library*
surface, not a raw instance clone. Trash, page-version history, review
comments/suggestions, general edit provenance, roster/instance configuration,
installed plugins, and agent credentials/settings remain operational state and
are not serialized. Orphaned assets with no live-page reference are likewise
excluded. Back up/deploy that control-plane state separately if it matters to
the recovery objective.

## Trust model — what restoring a bundle means

**Restoring a bundle is trusting its author.** The restore door proves the
section is *internally consistent* (hash chain verified end-to-end, asset
bytes matching their content hashes, a genesis event present) and the LGR-7
verifier then proves the installed rows match the installed history — but a
**consistent forger is undetectable by construction**: the chain is
self-contained (unanchored — no external notarization; LGR-18's residual), so
a fabricated history whose hashes are computed correctly verifies exactly like
a genuine one. The same honesty applies to routine verification: a green
`verifyAuditChain` means *no one edited this log without recomputing every
following link* — the tail event's own payload is covered only once a later
event chains onto it, and "this history is authentic" is not a claim any
self-contained chain can make.

Therefore: **restore only bundles you produced yourself or whose custody you
can account for out-of-band** (where it was stored, who could write to it,
checksums if you keep them). To make restores attributable, the door appends a
`ledger.restore` audit event ON TOP of the restored tail — chained from it,
naming the restoring actor and the bundle's content hash — so an installed
history is always bracketed by an event answering "who put these books here,
and from which bytes". Doctoring that event's payload after the fact is caught
by the verifier (`audit-hash-forged`), exactly like every other audited
payload.

One prerequisite worth stating (pre-existing platform posture, not changed
here): on an **unclaimed** instance the import/export gate falls back to the
general write gate, and the default `guestAccess: 'write'` would let a guest
restore a bundle — ledger included — before an owner exists. Claim the
instance (or run loopback-only, the default) before exposing it.

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
     **everything** selected, mode **Overwrite**. A fresh recovery target has a
     different instance id, so review the displayed access delta and explicitly
     enable installing the backup's access settings if that is intended.
   - API: `POST /api/import` with the bundle's `version`, `pages`, `databases`,
     `assets`, `pageAccess`, `ledger`, `instanceId`, optional `ownerSubject`, and
     `"mode": "overwrite"` (instance-admin gated). Add
     `"installForeignPageAccess": true` only after reviewing the ACL/public/
     agent-edit delta; otherwise the fresh target restores those pages restricted.
4. **Check the outcome field.** The response's `ledger` field must read
   `"restored"`. Anything else names the reason it was skipped:
   `skipped-existing-ledger` (the target already has a ledger — LGR-3
   protections stand; use a genuinely fresh library),
   `skipped-copy-mode`, or `skipped-incomplete` (the selection didn't include
   the ledger's own pages — restore with everything selected). For a complete
   v3 restore, `diagnostics` must be absent; v1/v2 return `partial-restore`.
5. **Verify — mandatory.** Run `GET /api/ledger/verify` (or the in-app
   *Export & verify* action / the CLI verify). The report must show
   `findings: []` with nonzero `checked*` counts and `auditChain.ok: true`.
   Since LGR-15 this report *includes* the linear hash-chain verification
   (`audit-prev-hash-broken` is a tamper finding, so the CLI exit code covers
   it) alongside the per-entity re-derivations and the evidence re-hash — a
   restore that silently lost or altered anything cannot pass it. What a green
   result does and does not claim is scoped honestly under *Trust model*
   above.
6. Resume service. The restored ledger is live: posting continues the restored
   audit chain and entry numbering (the restore advances the audit sequence
   past the restored tail).

A restore is **transactional**: if any part of the bundle is invalid
(incomplete access/asset manifest, non-ascending audit seqs, unknown audit action, a broken hash chain, asset
bytes that don't hash to their id, an over-cap or over-budget asset), the
entire import — pages included — rolls back with a descriptive error. There is
no half-restored state to clean up. Restored assets pass the same
door controls as uploads: mime sanitized against the image allowlist (nothing
executable is ever stored), the 10 MiB per-asset cap, and the instance's
storage budget; asset references attach only to pages the bundle itself
carried. The ledger host pages come back `restricted`, exactly as seeding
created them.

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

**Legacy note for external-Postgres deployments** (the double-encoding bug's
residue, stated so nobody rediscovers it): rows written through the wire
driver *before* the fix hold jsonb string scalars. There is deliberately **no
repair migration** — a stored string that parses as JSON is indistinguishable
from a value that legitimately *is* a JSON string, so a mechanical rewrite
could corrupt genuine data. Application reads keep working (every read path
re-parses strings); SQL-level extractions (`properties->>'…'`) on legacy rows
return NULL — visible as e.g. missing icons in list projections for pre-fix
pages. New writes are correct. An export + restore into a fresh library
rewrites every row through the fixed driver.

1. **Restore round-trip** — `src/ledgerRestore.test.ts` with
   `OPENBOOK_RESTORE_FIXTURE=parity` (the 500-transaction LGR-13 parity book,
   seeded through the real API with evidence, reversals, reconciliations —
   open and abandoned — and a closed + a reopened period): back up → destroy →
   restore → assert everything in the section above, then post again to prove
   the book is alive. The suite also pins every door, probe-style: no
   ledger-section apply over an existing ledger, in copy mode, or without the
   ledger's own pages IN the bundle (an existing database cannot be
   conscripted into "being the ledger"); a forged hash-chain link or forged
   asset bytes reject the whole import; ordinary image bytes plus page
   visibility/ACL/policy state are asserted after destructive restore; a member
   is denied the restored host page, row pages, and evidence bytes over HTTP; restore races (against a
   second restore, and against ledger setup) end in typed outcomes; and the
   `ledger.restore` provenance event plus the chain finding are
   mutation-verified (doctor the row, watch the verifier fire).
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
