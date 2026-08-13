import type {Db} from './dbCore';

interface Migration {
  name: string;
  statements: string[];
}

/**
 * Ordered, append-only schema migrations. Each runs once and is recorded in
 * `_migrations`. Runs on every boot in every mode (embedded PGlite or real
 * Postgres) — the SQL is identical.
 */
const MIGRATIONS: Migration[] = [
  {
    name: '0001_init',
    statements: [
      `CREATE TABLE IF NOT EXISTS pages (
        id          UUID        PRIMARY KEY,
        name        TEXT,
        data        JSONB       NOT NULL DEFAULT '{}'::jsonb,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
      'CREATE UNIQUE INDEX IF NOT EXISTS pages_name_key ON pages (name) WHERE name IS NOT NULL',
      'CREATE INDEX IF NOT EXISTS pages_updated_at_idx ON pages (updated_at DESC)',
    ],
  },
  {
    // Full-featured databases. A database is owned by a host page (1:1) and its
    // rows are ordinary pages tagged with `database_id`. Manual property values
    // live in `pages.properties`; `expr` columns are projected from the row
    // page's reactive snapshot at read time (see sdk `projectExports`).
    //
    // Circular FKs by design: `databases.page_id → pages.id` (the host) and
    // `pages.database_id → databases.id` (row membership). The databases table
    // is created first so the column FK below resolves. Deleting a host page
    // cascades to its database, which cascades to its row pages.
    name: '0002_databases',
    statements: [
      `CREATE TABLE IF NOT EXISTS databases (
        id          UUID        PRIMARY KEY,
        page_id     UUID        NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
        name        TEXT,
        schema      JSONB       NOT NULL DEFAULT '{"properties":[],"views":[]}'::jsonb,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
      'CREATE UNIQUE INDEX IF NOT EXISTS databases_page_id_key ON databases (page_id)',
      'ALTER TABLE pages ADD COLUMN IF NOT EXISTS database_id UUID REFERENCES databases(id) ON DELETE CASCADE',
      'ALTER TABLE pages ADD COLUMN IF NOT EXISTS properties JSONB NOT NULL DEFAULT \'{}\'::jsonb',
      'CREATE INDEX IF NOT EXISTS pages_database_id_idx ON pages (database_id)',
    ],
  },
  {
    // Page nesting: a page may be a child of another page. Deleting a parent
    // cascades to its children (and theirs), so a subtree is removed together.
    name: '0003_page_nesting',
    statements: [
      'ALTER TABLE pages ADD COLUMN IF NOT EXISTS parent_id UUID REFERENCES pages(id) ON DELETE CASCADE',
      'CREATE INDEX IF NOT EXISTS pages_parent_id_idx ON pages (parent_id)',
    ],
  },
  {
    // Soft delete: deleting a page sets `deleted_at` instead of removing the
    // row, so it can be restored from the trash. A cleanup job hard-deletes
    // pages whose `deleted_at` is older than the configured retention; the FK
    // cascades then remove nested children, the hosted database, and its rows.
    // The unique-name index is narrowed to live rows so a trashed page's name
    // can be reused (and is re-checked on restore).
    name: '0004_soft_delete',
    statements: [
      'ALTER TABLE pages ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ',
      'CREATE INDEX IF NOT EXISTS pages_deleted_at_idx ON pages (deleted_at) WHERE deleted_at IS NOT NULL',
      'DROP INDEX IF EXISTS pages_name_key',
      'CREATE UNIQUE INDEX IF NOT EXISTS pages_name_key ON pages (name) WHERE name IS NOT NULL AND deleted_at IS NULL',
    ],
  },
  {
    // Manual sidebar ordering. `position` orders a page among its siblings (the
    // pages sharing its `parent_id`, NULL = top level); the sidebar tree lists
    // pages by it instead of by recency. Backfilled from the previous
    // updated-at-desc order so existing libraries keep their current layout.
    // Drag-to-reorder / drag-to-nest renumbers a sibling group via `movePage`.
    name: '0005_page_order',
    statements: [
      'ALTER TABLE pages ADD COLUMN IF NOT EXISTS position DOUBLE PRECISION NOT NULL DEFAULT 0',
      `WITH ordered AS (
         SELECT id, row_number() OVER (PARTITION BY parent_id ORDER BY updated_at DESC) - 1 AS rn
         FROM pages
       )
       UPDATE pages p SET position = o.rn FROM ordered o WHERE p.id = o.id`,
      'CREATE INDEX IF NOT EXISTS pages_parent_position_idx ON pages (parent_id, position)',
    ],
  },
  {
    // Key-value settings (first consumer: the optional local-AI config).
    // JSONB values; identical SQL for embedded PGlite and Postgres.
    name: '0006_settings',
    statements: [
      `CREATE TABLE IF NOT EXISTS settings (
        key    TEXT  PRIMARY KEY,
        value  JSONB NOT NULL DEFAULT '{}'::jsonb
      )`,
    ],
  },
  {
    // Installed extensions: the whole package (manifest + TypeScript source
    // files + optional registry signature) lives in JSONB so every client of
    // the library loads the same plugins.
    name: '0007_plugins',
    statements: [
      `CREATE TABLE IF NOT EXISTS plugins (
        id            TEXT        PRIMARY KEY,
        manifest      JSONB       NOT NULL,
        files         JSONB       NOT NULL,
        signature     JSONB,
        enabled       BOOLEAN     NOT NULL DEFAULT TRUE,
        installed_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
    ],
  },
  {
    // The review layer: persisted SUGGESTIONS (proposed, reviewable changes —
    // AI write tools and humans both author these instead of mutating the
    // document directly) and COMMENTS (threaded on a suggestion, or standalone
    // on a block). Both cascade-delete with their host page. A suggestion's
    // `target`/`payload` are JSONB (the bridge replays `payload` to apply the
    // change); a comment's `body` is JSONB rich text (TextRun[]). Comments are
    // double-anchored: `suggestion_id` for a review thread, `block_id` for a
    // standalone block comment (exactly one is set in practice).
    name: '0008_suggestions',
    statements: [
      `CREATE TABLE IF NOT EXISTS suggestions (
        id           UUID        PRIMARY KEY,
        page_id      UUID        NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
        author_kind  TEXT        NOT NULL,
        author_name  TEXT        NOT NULL,
        kind         TEXT        NOT NULL,
        target       JSONB       NOT NULL DEFAULT '{}'::jsonb,
        before_text  TEXT        NOT NULL DEFAULT '',
        after_text   TEXT        NOT NULL DEFAULT '',
        status       TEXT        NOT NULL DEFAULT 'open',
        payload      JSONB       NOT NULL DEFAULT '{}'::jsonb,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
      'CREATE INDEX IF NOT EXISTS suggestions_page_id_idx ON suggestions (page_id)',
      'CREATE INDEX IF NOT EXISTS suggestions_status_idx ON suggestions (page_id, status)',
      `CREATE TABLE IF NOT EXISTS comments (
        id             UUID        PRIMARY KEY,
        page_id        UUID        NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
        suggestion_id  UUID        REFERENCES suggestions(id) ON DELETE CASCADE,
        block_id       TEXT,
        parent_id      UUID        REFERENCES comments(id) ON DELETE CASCADE,
        author_name    TEXT        NOT NULL,
        body           JSONB       NOT NULL DEFAULT '[]'::jsonb,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
      'CREATE INDEX IF NOT EXISTS comments_page_id_idx ON comments (page_id)',
      'CREATE INDEX IF NOT EXISTS comments_suggestion_id_idx ON comments (suggestion_id)',
    ],
  },
  {
    // Multi-user provenance (OB-165). The server is single-tenant (one shared
    // library), so this records *who* made each change, not data ownership.
    //
    // `edit_log` is an append-only trail — one row per mutating request — that
    // records what each user changed and which signed credential authorized it
    // (`assertion_kid`/`assertion_jti`), so a change traces back to its source
    // even on a federated instance. `verified_via` distinguishes a fresh JWS
    // from a guest or an expired-while-offline assertion. The newest row for a
    // page is its "last edited by". Purely additive: an instance with nobody
    // signed in (guest-by-default) keeps working exactly as before — the log
    // just attributes its writes to a guest. `page_id` is intentionally NOT a
    // FK: the trail outlives the page (a delete is itself a logged event).
    name: '0009_provenance',
    statements: [
      `CREATE TABLE IF NOT EXISTS edit_log (
        id             UUID        PRIMARY KEY,
        page_id        UUID,
        author_subject TEXT        NOT NULL,
        author_issuer  TEXT        NOT NULL DEFAULT '',
        author_name    TEXT        NOT NULL DEFAULT '',
        verified_via   TEXT        NOT NULL,
        kind           TEXT        NOT NULL,
        assertion_kid  TEXT,
        assertion_jti  TEXT,
        summary        TEXT        NOT NULL DEFAULT '',
        created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
      'CREATE INDEX IF NOT EXISTS edit_log_page_id_idx ON edit_log (page_id, created_at DESC)',
      'CREATE INDEX IF NOT EXISTS edit_log_author_idx ON edit_log (author_subject, created_at DESC)',
    ],
  },
  {
    // Server-stamped author identity on the review layer (OB-165). The
    // suggestions/comments tables already carry `author_name` (a display label
    // the client supplies) + `author_kind` ('ai'|'human'); these add the
    // *verified* principal behind the write (subject/issuer + how it was
    // established), so review-layer authorship is as trustworthy as the edit
    // log. All nullable/additive: pre-multi-user rows simply have no identity.
    name: '0010_review_authors',
    statements: [
      'ALTER TABLE suggestions ADD COLUMN IF NOT EXISTS author_subject TEXT',
      'ALTER TABLE suggestions ADD COLUMN IF NOT EXISTS author_issuer TEXT',
      'ALTER TABLE suggestions ADD COLUMN IF NOT EXISTS author_verified TEXT',
      'ALTER TABLE comments ADD COLUMN IF NOT EXISTS author_subject TEXT',
      'ALTER TABLE comments ADD COLUMN IF NOT EXISTS author_issuer TEXT',
      'ALTER TABLE comments ADD COLUMN IF NOT EXISTS author_verified TEXT',
    ],
  },
  {
    // Sharing & access schema (OB-188; contract docs/sharing-access-contract-spike-OB-182.md).
    // SCHEMA ONLY — no authorization logic (OB-189) or enforcement/middleware
    // (OB-190) here. Purely additive + idempotent: absent roster rows + every
    // existing page defaulting to visibility='inherit' + the unclaimed-instance
    // short-circuit means a live local library behaves exactly as before; no
    // backfill is required.
    //
    // `members` is the data-server-native roster (the instance owns subject→role).
    // A row is one of two shapes (§2.1): an EMAIL PERSONA (invited by email,
    // `subject` NULL until the invitee signs in and claims it) or a SUBJECT/handle
    // MEMBER (`email` NULL). One account `subject` may back several persona rows —
    // one per verified email — each its own library member with its own role.
    // `issuer` PINS the email-authority for a persona so a federated issuer can
    // never satisfy an account.book.pub-scoped grant (B1); the CHECK enforces that
    // any email row carries that pin. The partial-unique indexes use `lower(email)`
    // (case-insensitive persona uniqueness) — verified to create + enforce on the
    // embedded PGlite (PostgreSQL 17.5).
    //
    // `page_acl` is the per-page override (open a restricted/members page to one
    // persona, or elevate a viewer to writer on a single page). A table — not a
    // `pages.acl` JSONB blob — so the share UI's cross-cutting queries
    // ("everything shared with email X", "who can access this page") are plain
    // indexed selects and the invite-claim rewrite is a transactional UPDATE across
    // `members` + `page_acl`. Exactly one grantee key per row (subject XOR email);
    // an email grant MUST pin an issuer (B1); cascade-deletes with its page.
    name: '0011_sharing_access',
    statements: [
      `CREATE TABLE IF NOT EXISTS members (
        id          UUID        PRIMARY KEY,
        subject     TEXT,
        email       TEXT,
        issuer      TEXT        NOT NULL DEFAULT 'https://account.book.pub',
        role        TEXT        NOT NULL DEFAULT 'viewer',
        status      TEXT        NOT NULL DEFAULT 'active',
        invited_by  TEXT,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        CHECK (email IS NOT NULL OR subject IS NOT NULL)
      )`,
      'CREATE UNIQUE INDEX IF NOT EXISTS members_email_key ON members (lower(email)) WHERE email IS NOT NULL',
      'CREATE UNIQUE INDEX IF NOT EXISTS members_subject_key ON members (subject) WHERE email IS NULL AND subject IS NOT NULL',
      'CREATE INDEX IF NOT EXISTS members_subject_idx ON members (subject) WHERE subject IS NOT NULL',
      'ALTER TABLE pages ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT \'inherit\'',
      `CREATE TABLE IF NOT EXISTS page_acl (
        page_id     UUID        NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
        subject     TEXT,
        email       TEXT,
        issuer      TEXT,
        level       TEXT        NOT NULL,
        invited_by  TEXT,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        CHECK ((subject IS NOT NULL) <> (email IS NOT NULL)),
        CHECK (email IS NULL OR issuer IS NOT NULL)
      )`,
      'CREATE INDEX IF NOT EXISTS page_acl_page_idx ON page_acl (page_id)',
      'CREATE UNIQUE INDEX IF NOT EXISTS page_acl_page_subj_key ON page_acl (page_id, subject) WHERE subject IS NOT NULL',
      'CREATE UNIQUE INDEX IF NOT EXISTS page_acl_page_email_key ON page_acl (page_id, lower(email)) WHERE email IS NOT NULL',
      'CREATE INDEX IF NOT EXISTS page_acl_email_idx ON page_acl (lower(email)) WHERE email IS NOT NULL',
    ],
  },
  {
    // OB-199 — tag each roster row with its PROVENANCE. A row is now either a
    // `local` invite (the OB-191 path) or a `managed` row projected from the bound
    // account library's roster by the periodic sync. The two coexist: the sync
    // only ever writes/removes `managed` rows, so a local invite is never clobbered
    // — and a managed row never masquerades as a hand-issued one. Additive +
    // idempotent: every pre-existing row is a `local` invite, which is exactly the
    // column default, so no backfill is needed.
    name: '0012_member_source',
    statements: [
      'ALTER TABLE members ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT \'local\'',
    ],
  },
  {
    // Idempotency ledgers (ER-6 / ER-7 — the OB-241 family of replay storms). Two
    // small append-only ledgers that make a re-applied write a no-op:
    //
    //  - `import_log` keys a whole-bundle `/api/import` by a content hash of the
    //    bundle. Re-applying the SAME bundle short-circuits to the recorded result
    //    instead of re-INSERTing the entire library as fresh `copy`-mode pages +
    //    appending N `page.synced` edit-log rows on every call (the trap a future
    //    workspace-sync/restore daemon would otherwise fall into).
    //
    //  - `write_keys` keys a single keyless CREATE by (principal, client key) so a
    //    retried/replayed create POST (flaky net / SDK retry) returns the original
    //    page rather than minting a duplicate. The PRIMARY KEY is composite on
    //    (author_subject, client_key) — the dedup is SCOPED PER-PRINCIPAL, so one
    //    principal's key can never collide with or overwrite another's write.
    //
    // Both are pruned by the periodic cleanup (like `edit_log`) so they can't grow
    // unbounded on the autovacuum-less embedded store (OB-164). Purely additive.
    name: '0013_idempotency',
    statements: [
      `CREATE TABLE IF NOT EXISTS import_log (
        key         TEXT        PRIMARY KEY,
        result      JSONB       NOT NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
      'CREATE INDEX IF NOT EXISTS import_log_created_at_idx ON import_log (created_at)',
      `CREATE TABLE IF NOT EXISTS write_keys (
        author_subject  TEXT        NOT NULL,
        client_key      TEXT        NOT NULL,
        page_id         UUID        NOT NULL,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (author_subject, client_key)
      )`,
      'CREATE INDEX IF NOT EXISTS write_keys_created_at_idx ON write_keys (created_at)',
    ],
  },
  {
    // Content-addressed asset store (OB-ASSETS A1). Binary blobs (images, …) live
    // in `assets` keyed by the **SHA-256 hex of their bytes**, so byte-identical
    // uploads collapse to ONE row (dedup) and an id is a self-verifying content
    // hash — never a guessable sequential handle. `bytes` is `BYTEA` (Postgres
    // native; PGlite round-trips it as a `Uint8Array`), `size` caches the byte
    // length, `mime` the declared content type of the first upload of those bytes.
    //
    // `asset_refs` is the reachability/gating edge: a `(asset_id, page_id)` pair
    // records that a page references the asset, so the asset INHERITS that page's
    // read-gate (a caller may fetch an asset iff they can read at least one page
    // that references it — no page ⇒ unreachable ⇒ 404, no existence oracle). The
    // FK to `pages(id)` cascade-deletes a ref when its page is hard-purged; the FK
    // to `assets(id)` lets a future GC drop an asset once its last ref is gone.
    // The composite PK makes a re-ref of the same (asset, page) an idempotent no-op.
    name: '0014_assets',
    statements: [
      `CREATE TABLE IF NOT EXISTS assets (
        id          TEXT        PRIMARY KEY,
        bytes       BYTEA       NOT NULL,
        mime        TEXT        NOT NULL,
        size        INT         NOT NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
      `CREATE TABLE IF NOT EXISTS asset_refs (
        asset_id    TEXT        NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
        page_id     UUID        NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (asset_id, page_id)
      )`,
      'CREATE INDEX IF NOT EXISTS asset_refs_page_idx ON asset_refs (page_id)',
      'CREATE INDEX IF NOT EXISTS asset_refs_asset_idx ON asset_refs (asset_id)',
    ],
  },
  {
    // Page names are no longer unique. Identity is the UUID everywhere (routes,
    // links, mirror filenames all carry the id), so the unique index bought
    // nothing but rename/import/restore collisions. A plain index keeps
    // name lookups (`getPageByName`, import collision checks) fast.
    name: '0015_nonunique_names',
    statements: [
      'DROP INDEX IF EXISTS pages_name_key',
      'CREATE INDEX IF NOT EXISTS pages_name_idx ON pages (name) WHERE name IS NOT NULL AND deleted_at IS NULL',
    ],
  },
  {
    // Agent Personal-Access-Tokens (AGENT-6). A `Bearer obat_…` credential an
    // instance admin mints to authenticate an OUTWARD agent/MCP HTTP request. The
    // SECRET is never stored — only its SHA-256 hash (`token_hash`, UNIQUE so a
    // byte-identical mint can't collide) and a short non-secret `preview`. Each row
    // is BOUND at mint time to the minter's own verified subject/issuer (never a
    // client-chosen value); `scope` is the read/write ceiling the request-time
    // scope-gate enforces. `revoked_at`/`expires_at` gate resolution (a revoked or
    // expired token never resolves — the presenter hard-401s, never a silent guest
    // downgrade). `last_used_at` is a debounced best-effort touch. Purely additive +
    // idempotent: absent on every existing instance until an admin enables the dark
    // `agentApi` setting and mints one, so a live library behaves exactly as before.
    name: '0016_agent_tokens',
    statements: [
      `CREATE TABLE IF NOT EXISTS agent_tokens (
        id           UUID        PRIMARY KEY,
        name         TEXT        NOT NULL DEFAULT '',
        token_hash   TEXT        NOT NULL UNIQUE,
        preview      TEXT        NOT NULL DEFAULT '',
        subject      TEXT        NOT NULL,
        issuer       TEXT        NOT NULL DEFAULT '',
        scope        TEXT        NOT NULL DEFAULT 'read',
        created_by   TEXT        NOT NULL DEFAULT '',
        created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
        expires_at   TIMESTAMPTZ,
        last_used_at TIMESTAMPTZ,
        revoked_at   TIMESTAMPTZ
      )`,
      'CREATE INDEX IF NOT EXISTS agent_tokens_active_idx ON agent_tokens (created_at DESC) WHERE revoked_at IS NULL',
    ],
  },
  {
    // Per-token REMOTE opt-in (AGENT-7 / AGENT-10). A default-false flag that gates
    // whether a token may authenticate a FORWARDED `/api/mcp` request over the public
    // `*.book.cloud` edge (L7 in the remote-MCP defence-in-depth stack). Every
    // pre-existing token is local-only FOREVER unless re-minted with `remote:true` —
    // the origin's conjunctive forwarded-guard rejects a forwarded PAT whose row lacks
    // this flag. Purely additive + idempotent: a live library behaves exactly as
    // before (no forwarded PAT was ever admitted pre-0017), and a code rollback simply
    // stops reading the column.
    name: '0017_agent_token_remote',
    statements: [
      'ALTER TABLE agent_tokens ADD COLUMN IF NOT EXISTS remote_ok BOOLEAN NOT NULL DEFAULT FALSE',
    ],
  },
  {
    // Per-page version history — snapshot-on-save (PVH-1, OB-26). Each row is a
    // point-in-time snapshot of a page's block document: the store captures the
    // PRIOR `data` (the state being replaced) on every save that actually changes
    // `data`, so a row means "what the page looked like before this save" — a
    // coherent target to roll back TO. The current live state always stays in
    // `pages.data` (never duplicated here), which keeps the write-amplification of
    // this append-only table minimal on the autovacuum-less embedded store (OB-164);
    // rapid 600ms collab saves / typing bursts are coalesced by the store (min-gap
    // between rows) so a burst can't spam one row per keystroke.
    //
    // `author_*` records the VERIFIED principal of the save that produced the row
    // (the same subject/issuer/name the edit log carries) — i.e. who superseded the
    // captured state. All nullable: a server-merged checkpoint (`saveServerDoc`) has
    // per-block authorship inside the snapshot but no single save principal.
    //
    // ON DELETE CASCADE to `pages(id)` is intentional: a SOFT delete only sets
    // `deleted_at` (the row survives), so a trashed page KEEPS its history and can be
    // restored with it; the cascade only fires on the HARD purge that actually removes
    // the page row (the retention sweep), reclaiming its versions then rather than
    // orphaning them forever. Retention/pruning of versions on a still-live page is a
    // separate concern (PVH-2).
    name: '0018_page_versions',
    statements: [
      `CREATE TABLE IF NOT EXISTS page_versions (
        id             UUID        PRIMARY KEY,
        page_id        UUID        NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
        data           JSONB       NOT NULL,
        author_subject TEXT,
        author_issuer  TEXT,
        author_name    TEXT,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
      'CREATE INDEX IF NOT EXISTS page_versions_page_idx ON page_versions (page_id, created_at DESC)',
    ],
  },
  {
    // AGED-1 — per-page agent-edits policy. Governs whether an agent (an MCP tool or
    // the built-in AI) writes THIS page DIRECTLY or as a suggestion. `inherit` (the
    // column default) defers to the instance-wide `agentEdits` mode; `suggest` /
    // `direct` override it for this page. Modeled on `pages.visibility` (0011):
    // additive + idempotent — every pre-existing row backfills to the `inherit`
    // default, so no data migration is needed and re-running is a no-op.
    name: '0019_agent_edits',
    statements: [
      'ALTER TABLE pages ADD COLUMN IF NOT EXISTS agent_edits TEXT NOT NULL DEFAULT \'inherit\'',
    ],
  },
  {
    // LGR-3 — the append-only ledger AUDIT LOG. One row per ledger mutation
    // (init / account create-update / draft create-update-delete / post / reverse /
    // posting-cleared), written in the SAME store transaction as the mutation it
    // records, so a committed ledger write is never missing its audit event (and a
    // rolled-back write leaves none). APPEND-ONLY by construction: no code path
    // updates or deletes rows here, and no generic API route reaches this table
    // (it is not a page table). `seq` is the strictly-increasing order + the
    // pagination cursor; `entity_ids` lists every touched entity (a reverse names
    // both the reversing and the voided transaction); `payload` carries the full
    // after-content so the stream is REPLAYABLE (a pure reducer reconstructs
    // current ledger state — see sdk `replayLedgerAudit`); `before_hash`/
    // `after_hash` are SHA-256 of the canonical entity JSON around the mutation.
    // Byte-identical SQL on embedded PGlite and real Postgres; purely additive +
    // idempotent (IF NOT EXISTS) — existing non-ledger libraries are untouched.
    name: '0020_ledger_audit',
    statements: [
      `CREATE TABLE IF NOT EXISTS ledger_audit (
        seq            BIGSERIAL   PRIMARY KEY,
        id             UUID        NOT NULL UNIQUE,
        actor_subject  TEXT        NOT NULL DEFAULT '',
        actor_name     TEXT        NOT NULL DEFAULT '',
        action         TEXT        NOT NULL,
        entity_ids     JSONB       NOT NULL DEFAULT '[]'::jsonb,
        payload        JSONB       NOT NULL DEFAULT '{}'::jsonb,
        before_hash    TEXT,
        after_hash     TEXT,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
      'CREATE INDEX IF NOT EXISTS ledger_audit_action_idx ON ledger_audit (action, seq DESC)',
    ],
  },
  {
    // LGR-3 — TAMPER-EVIDENCE for the ledger audit log. 0020 made the log
    // append-only *by construction* (no code path updates or deletes it, no
    // generic route reaches it), which stops an API-level actor but says nothing
    // about one with direct database access: a rewritten row left no trace, and a
    // deleted row was indistinguishable from the BIGSERIAL gap a rolled-back
    // transaction leaves behind.
    //
    // `prev_hash` chains each event to its predecessor — SHA-256 over the
    // predecessor's canonical content INCLUDING ITS OWN `prev_hash` (sdk
    // `ledgerAuditEventHash`), written in the SAME transaction as the event it
    // follows. NULL for the genesis event only.
    //
    // WHAT THE CHAIN PROVES (be precise — a green verify is not "the log is
    // authentic"). The hash is UNKEYED and the log is UNANCHORED, so:
    //  - DETECTED: a partial edit or a middle deletion that does not recompute
    //    every following link — `verifyLedgerAuditChain` reports the exact `seq`.
    //  - NOT DETECTED: truncation of the HEAD or the TAIL (both verify clean),
    //    and a wholesale rewrite in which the actor recomputes every link —
    //    `ledgerAuditEventHash` is exported and unkeyed, so anyone with database
    //    access can do that.
    // Closing those requires an off-box anchor (periodically publishing the tail
    // hash somewhere the database owner cannot rewrite). That is filed as LGR-18
    // and deliberately NOT built here.
    //
    // COMPATIBILITY: verification requires a log chained from its GENESIS event.
    // A library seeded under 0020 (events written before this column existed) has
    // leading NULL links, and `verifyLedgerAuditChain` fails such a log at the
    // first chained event rather than resuming from it. That strictness is the
    // correct security posture and is not a bug to "fix" by skipping leading
    // nulls: tolerating a restart-on-NULL would let an attacker NULL one row to
    // re-anchor the chain after deleting everything before it. A pre-0021 library
    // therefore verifies as broken until its log is re-anchored (an operator
    // action), while everything seeded from 0021 onward verifies from genesis.
    name: '0021_ledger_audit_chain',
    statements: [
      'ALTER TABLE ledger_audit ADD COLUMN IF NOT EXISTS prev_hash TEXT',
    ],
  },
  {
    // LGR-3 — DATABASE-LEVEL backstop for the audit chain's linearity.
    //
    // The append path serializes on a transaction-scoped advisory lock, which is
    // what actually keeps the chain well-formed (a `SELECT … FOR UPDATE` of the
    // tail does NOT: it locks the row it found and cannot block a concurrent
    // INSERT of a new tail, so under READ COMMITTED two transactions could both
    // chain onto the same predecessor and permanently break the chain — a false
    // tampering accusation with no repair path).
    //
    // These indexes make that failure IMPOSSIBLE rather than merely unlikely:
    //  - `prev_hash` UNIQUE (where not null) — at most one event may claim any
    //    given predecessor, so a residual race becomes a rolled-back transaction
    //    instead of silent corruption.
    //  - the genesis index — at most one event may have no predecessor, so a
    //    second "first" event can't be spliced in to re-anchor a truncated log.
    //    `((true))` is a constant expression index: every NULL-prev_hash row maps
    //    to the same key, so the second insert conflicts. Verified to create and
    //    enforce on both backends (embedded PGlite = PostgreSQL 17.5, and real
    //    Postgres) — it is ordinary partial-expression-index territory.
    //
    // Additive + idempotent. A library seeded under 0020/0021 may hold several
    // NULL-prev_hash rows (pre-chain events); on such a library the genesis index
    // creation FAILS, which would wedge migrations — so it is created only when
    // the existing data permits, via the DO block below. A fresh library (and any
    // library whose chain starts at genesis) gets both indexes.
    name: '0022_ledger_audit_chain_linearity',
    statements: [
      'CREATE UNIQUE INDEX IF NOT EXISTS ledger_audit_prev_hash_uniq ON ledger_audit (prev_hash) WHERE prev_hash IS NOT NULL',
      `DO $$
       BEGIN
         IF (SELECT count(*) FROM ledger_audit WHERE prev_hash IS NULL) <= 1 THEN
           CREATE UNIQUE INDEX IF NOT EXISTS ledger_audit_genesis_uniq ON ledger_audit ((true)) WHERE prev_hash IS NULL;
         END IF;
       END $$`,
    ],
  },
  {
    // LGR-15 — performance hardening for row appends. Every database-row insert
    // (ledger postings above all: two per imported bank row) assigns
    // `position = MAX(position)+1 WHERE database_id = $n`. The existing
    // `pages_database_id_idx` narrows the scan to the database's rows but still
    // fetches EVERY one to find the max — O(rows) per insert, O(rows²) per
    // import batch, and the LGR-15 import benchmark showed exactly that curve
    // (each successive 1k-row batch ~50% slower). A composite
    // `(database_id, position)` turns the MAX into a reverse index scan.
    // Additive + idempotent; byte-identical SQL on PGlite and real Postgres.
    name: '0023_pages_database_position_idx',
    statements: [
      'CREATE INDEX IF NOT EXISTS pages_database_position_idx ON pages (database_id, position)',
    ],
  },
  {
    // FORM-6 — opaque staged-upload tokens. Asset bytes stay in the existing
    // content-addressed store; this table binds a random token to one form field
    // until submission. `claimed_by` is the submission idempotency key, allowing
    // exact retries but preventing a token being spent by a different submission.
    // `consumed_by` keeps the form-byte accounting tied to the live/trashed row and
    // cascade-removes it on hard purge. Unconsumed rows are swept after 30 minutes.
    name: '0024_form_uploads',
    statements: [
      `CREATE TABLE IF NOT EXISTS form_uploads (
        token        TEXT        PRIMARY KEY,
        asset_id     TEXT        NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
        page_id      UUID        NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
        form_id      TEXT        NOT NULL,
        field_id     TEXT        NOT NULL,
        file_name    TEXT        NOT NULL,
        owns_asset   BOOLEAN     NOT NULL DEFAULT false,
        claimed_by   TEXT,
        consumed_by  UUID        REFERENCES pages(id) ON DELETE CASCADE,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
      'CREATE INDEX IF NOT EXISTS form_uploads_form_idx ON form_uploads (page_id, form_id)',
      'CREATE INDEX IF NOT EXISTS form_uploads_expiry_idx ON form_uploads (created_at) WHERE consumed_by IS NULL',
      'CREATE INDEX IF NOT EXISTS form_uploads_asset_idx ON form_uploads (asset_id)',
    ],
  },
  {
    // F-4 — publication state for database-backed form views. The plaintext
    // 256-bit fill capability is never stored: only its SHA-256 digest is keyed to
    // one (database, view) pair. Presence is the publication binding; replacing the
    // digest rotates the link and deleting the row revokes it. Database deletion
    // cascades, while schema updates explicitly remove records for deleted/retyped
    // views in PageStore.updateDatabase.
    name: '0025_database_form_capabilities',
    statements: [
      // Legacy block forms leave this null. Database form views stamp their
      // publication digest so a token staged before rotation cannot be consumed
      // by the new capability for the same view.
      'ALTER TABLE form_uploads ADD COLUMN IF NOT EXISTS capability_hash TEXT',
      `CREATE TABLE IF NOT EXISTS database_form_capabilities (
        database_id       UUID        NOT NULL REFERENCES databases(id) ON DELETE CASCADE,
        view_id           TEXT        NOT NULL,
        capability_hash   TEXT        NOT NULL UNIQUE,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (database_id, view_id)
      )`,
      'CREATE INDEX IF NOT EXISTS database_form_capabilities_updated_idx ON database_form_capabilities (updated_at)',
      'CREATE INDEX IF NOT EXISTS form_uploads_capability_idx ON form_uploads (capability_hash) WHERE capability_hash IS NOT NULL',
    ],
  },
  {
    // UP-1 — discovery is independent of the visibility audience ladder. Existing
    // pages remain listed; ADD IF NOT EXISTS keeps a replay safe on every backend.
    name: '0026_page_listed',
    statements: ['ALTER TABLE pages ADD COLUMN IF NOT EXISTS listed BOOLEAN NOT NULL DEFAULT true'],
  },
];

/** Apply all pending migrations. Idempotent; safe on every boot. */
export async function runMigrations(db: Db): Promise<void> {
  await db.query(`CREATE TABLE IF NOT EXISTS _migrations (
    name        TEXT PRIMARY KEY,
    applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);

  const applied = await db.query<{name: string}>('SELECT name FROM _migrations');
  const done = new Set(applied.map((row) => row.name));

  for (const migration of MIGRATIONS) {
    if (done.has(migration.name)) continue;
    await db.begin(async (tx) => {
      for (const statement of migration.statements) {
        await tx.query(statement);
      }
      await tx.query('INSERT INTO _migrations (name) VALUES ($1)', [migration.name]);
    });
  }
}
