# OB-182 Spike — Unified sharing, access & multi-account contract

**Decision spike (not code).** Define the one contract for *who can see and edit
what* across the whole product: per-page **visibility scope**, a data-server-native
**member roster** (`subject → role`, with **per-email personas**), per-page
**ACLs**, the existing **guest gate**, the **edge↔origin** trust bridge for
forwarded sites, and the client's **multi-account / multi-persona** model.
Downstream issues implement against this; this doc is the structure they build from.

It extends the OB-171 identity contract (`docs/identity-contract-spike-OB-171.md`):
identity is one layer (`Principal`, keyed by `subject = iss#sub`); **authorization
is a pure layer on top of it**, and that layer is what OB-182 specifies.

> **Revision 2 (post-review).** The owner has resolved all 6 forks (now contract
> requirements, see §0) and Sasha's security gate returned CHANGES REQUESTED. This
> revision folds every blocker (B1–B2), should-fix (S3–S7), and nit (N8–N10) into
> the body; §9 is the per-finding resolution map for the security re-clear.

## 0. Resolved decisions (owner — now binding requirements)
1. **Default page visibility on claim = `members` (private), per-page overridable.**
   `inherit` resolves to `config.defaultVisibility`, set to `members` at claim.
2. **Guest gate on claim = AUTO-DOWNGRADE `write → read`** (defense-in-depth; this
   supersedes the earlier "keep current"). `guestAccess='off'` blocks **even
   `public` reads**.
3. **Handle = HYBRID.** Account-level **unique handles only for whitelisted users**
   (custom colour/flair); everyone else uses a **roster-local display name**
   rendered gray. *Not* a global handle namespace. Lookup is rate-limited and not
   bulk-enumerable (§4.4).
4/5. **Multi-email = PERSONAS** (this **inverts** R1's "emails collapse to one
   subject"). One account's several verified emails may appear as **separate
   members** in one workspace. The active account/email selects the **persona**
   presented; the member key = **the active persona email bound to the account
   subject**. The identity / forwarded token carries `subject` + the **single
   active-persona email**, never an array.
6. **Edge `owner` bit is NOT load-bearing.** Owner authorization is via the JWS
   `subject` only (edge `owner` is at most an attribution hint, §3).

## Product inputs (fixed by the owner — not re-litigated)
- Local-first: users start **unauthenticated**; a free account.book.pub account
  unlocks **publishing**. The no-account, loopback-only path keeps working unchanged.
- **Four audience scopes:** `public` · `authenticated` · `members` · `restricted`.
- **Roster is data-server-native:** the OpenBook instance owns `subject → role`;
  account/edge only mirror coarse visibility. Must work fully self-hosted.
- **Two OSS roles:** `admin` (full) and `viewer` (locked read-only).
- **Unit of sharing = per-page** (per-page scope + per-page ACL).
- **Invitees** by **email** (persona, not yet a member) or **handle** (already a
  member).

## Verified starting state (current code, 2026-06-27)
- Identity is solved: `sdk/identity.ts` (`verifyIdentity`, EdDSA, `iss/aud/alg`
  pinned), `server/principal.ts` (`resolvePrincipal` + `guestGate`), enforced once
  in `server/app.ts` (`app.use('/api/*', …)` sets `c.principal`).
- Instance policy: `InstanceConfig` (`guestAccess`, `ownerSubject`,
  `trustedIssuers`, `audience`, `requireAudience`) in `sdk/provenance.ts`;
  `getInstanceConfig`/`updateInstanceConfig` in `server/store.ts` (one JSONB
  `settings` row, shallow-merged).
- Migration head is **0010** (`0009_provenance`, `0010_review_authors`).
- **No per-page visibility / ACL / role exists today** — confirmed: nothing in
  `packages/server/src` or `packages/sdk/src` defines `members`, `page_acl`, page
  `visibility`, or a `role`. `sys_owner` (`sdk/pageProperties.ts`) is a *display*
  "person" property, **not** a gate.
- **CORRECTION (per review):** the `Principal` shape carries **no email today** —
  `principalFromClaims` builds `{kind, subject, issuer, name, verifiedVia,
  assertion}` and **drops the `email` claim entirely** (the JWS payload has it; the
  Principal does not). So `Principal.email` / persona-email matching is **entirely
  net-new threading**, not "an extension of an existing field".
- Edge principal (`open.book.pub` `forwarding/src/principal.ts`) is
  `{owner: boolean, viewerId: per-site pseudonym, iat, exp}`, HMAC-signed with
  `EDGE_PRINCIPAL_SECRET`. **It carries no `iss#sub` and no email — pseudonymous by
  design.** The origin does **not** consume `x-openbook-principal` yet.
- Edge `decideGate` (`open.book.pub` `edge/lib/gate.ts`) is a coarse **per-site**
  gate: `Site.visibility = public|private`; private + anonymous → SSO sign-in
  bounce. `Site.ownerId` is an account `userId`, **not** an `iss#sub`.
- `PageHub` (`server/hub.ts`) fans events out **unconditionally** —
  `liveListeners.forEach`, per-id listener sets, no principal filter. (The S4 gap.)
- Account (`open.book.pub` `account/prisma/schema.prisma`): `User.email` is a
  **single, unique** column. No multi-email, no `handle`, no Workspace/Membership.
- Client: `AccountProvider.tsx` holds **one** account/token; `connection.ts`
  `setIdentityToken` stores **one** module-global JWS.
- **Verified for this spike:** PGlite (`@electric-sql/pglite@^0.4.6` = PostgreSQL
  **17.5**) supports the expression / partial unique indexes migration 0011 needs —
  `CREATE UNIQUE INDEX … ON members (lower(email)) WHERE email IS NOT NULL` creates
  cleanly and rejects a case-insensitive duplicate (tested against the embedded DB).

---

## 1. Authorization model

### 1.1 The one function

```ts
// @book.dev/sdk — pure, isomorphic, no I/O. The single source of truth, called at
// the origin on every content request/event and reused by the client to grey out UI.
export type PageVisibility = 'inherit' | 'public' | 'authenticated' | 'members' | 'restricted';
export type Role = 'admin' | 'viewer';
export type AclLevel = 'read' | 'write';

export interface AclEntry {
  subject?: string;          // grantee already bound to a member/handle (any trusted issuer)
  email?: string;            // grantee by persona email (lowercased)
  issuer?: string;           // REQUIRED for an email entry — the pinned email-authority (B1)
  level: AclLevel;
}
export interface AccessPage { visibility: PageVisibility; acl: AclEntry[] }

export interface AccessCtx {
  config: Pick<InstanceConfig, 'guestAccess' | 'ownerSubject' | 'defaultVisibility' | 'emailAuthority'>;
  /** Role of the principal's ACTIVE persona, resolved by the store: a roster row
   *  with status='active' whose BOUND subject === principal.subject (and, for an
   *  email persona, whose email === principal.email under the pinned authority).
   *  invited/suspended rows resolve to null. (S3) */
  role: Role | null;
  /** Effective visibility after resolving `inherit`: up the PARENT chain for an
   *  ordinary page, but via the DATABASE HOST PAGE for a database row (N9); falls
   *  back to config.defaultVisibility at the root. */
  effectiveVisibility: Exclude<PageVisibility, 'inherit'>;
  /** True iff the principal's email may be trusted: verifiedVia==='jws' AND
   *  principal.issuer === config.emailAuthority. Only then does email-ACL/persona
   *  matching fire. (B1) */
  emailIsAuthoritative: boolean;
}

export interface Decision { canRead: boolean; canWrite: boolean; reason: string }
export function authorize(principal: Principal, page: AccessPage, ctx: AccessCtx): Decision;
```

`Principal` gains a single **`email?: string`** (the active-persona email, lowercased)
— net-new threading from the verified `email` claim (see CORRECTION above). No
`emails[]` array (Fork 4/5).

**Who counts as authenticated (N8).** For *request-time* decisions, "authenticated"
means **`verifiedVia === 'jws'`** only. `verifiedVia: 'synced'` is an
attribution-only marker for the merge path (OB-170) and is **never
request-assertable** — a live request can never present it. `verifiedVia:
'unverified'` and `'guest'` are **not** authenticated (still attributed in the edit
log, never granted). `verifiedVia: 'local'` is the loopback owner (rule 1).

### 1.2 Precedence ladder (highest authority first)

`authorize` evaluates these in order; the first rule that grants a field wins, and
write is only ever granted by rules 0/1/2/3:

0. **Unclaimed instance** (`config.ownerSubject === undefined`) → **legacy
   short-circuit**, preserving today's loopback behaviour exactly:
   - `canRead = guestAccess !== 'off' || isAuthenticated`
   - `canWrite = guestAccess === 'write' || isAuthenticated`
   - `reason = 'legacy-guest-gate'`. Roster/scope/ACL are not consulted (they don't
     exist until the instance is claimed). **Invariant (B2): an unclaimed instance
     is only ever reachable on loopback** — exposure (LAN/forward) requires a claim
     first (§2.6), so "unclaimed" can never be "anonymous + world-writable + on the
     network".
1. **Loopback owner** (`principal.verifiedVia === 'local'`) → `{read, write}`,
   `reason='local-owner'`. The in-process / desktop loopback caller is the machine
   owner and is **never locked out** of a claimed instance (S5). **`verifiedVia:
   'local'` is non-request-assertable** (symmetric with `synced`, §1.1): it arises
   **only** for the in-process embedded `LocalDataClient` and is **never** resolvable
   from any inbound request — not a header, not the Unix socket, not loopback HTTP.
   `resolvePrincipal` must never mint a `local` principal from request properties;
   "the connection looks local, therefore local owner" is a forbidden shortcut (it
   would be an SSRF / other-local-process privilege escalation). This grant sits at
   the top of the ladder precisely because the *only* thing that can produce it is
   the server calling itself.
2. **Owner** (`principal.verifiedVia === 'jws' && principal.subject ===
   config.ownerSubject`) → `{read, write}`, `reason='owner'`. Gated on `jws` (N8):
   an `unverified`/`synced` assertion can never be owner.
3. **Per-page ACL** entry matching the principal:
   - by **`subject`** (`entry.subject === principal.subject`) — any trusted issuer.
   - by **`email`** — only when `ctx.emailIsAuthoritative` **and** `entry.email ===
     principal.email` **and** `entry.issuer === config.emailAuthority` (B1).
   - `level='write'` → `{read, write}`, `reason='acl-write'`; `level='read'` →
     `read=true` (write falls through), `reason='acl-read'`. ACL is the per-page
     override: open a `restricted`/`members` page to one persona, or elevate a
     `viewer` to writer on a single page.
4. **Roster role** (`ctx.role`, already filtered to an *active, bound* persona — S3):
   - `admin` → `{read, write}`, `reason='admin'` (instance-wide full access)
   - `viewer` → `read` per scope (rule 5); **write always denied**,
     `reason='viewer-readonly'`
5. **Visibility scope vs principal class** (governs READ for everyone not decided
   above; write here is always `false`):
   - `public` → `read=true` for **all**, incl. anonymous — **overrides the guest
     gate** (publish-publicly), *except* `guestAccess='off'` (rule 6)
   - `authenticated` → `read=true` for any **jws** user; guests → no
   - `members` → only active roster members (handled in rule 4); a jws non-member →
     no; guests → no
   - `restricted` → only owner/admin/ACL (handled above); everyone else → no
6. **Guest gate floor** for the guest class (`principal.kind === 'guest'`):
   - `guestAccess === 'off'` → `{false,false}` on **every** page, **including
     `public`** (fully-private instance — Fork 2), `reason='guest-disabled'`.
   - `'read' | 'write'` → no grant beyond what rule 5 already gave a guest (read of
     `public` only). On a **claimed** instance guests **never write** — and claiming
     auto-downgrades `'write' → 'read'` anyway (Fork 2 / §2.6). `'write'` is
     therefore meaningful only on the unclaimed (rule 0) loopback path.
7. **Default deny** → `{false,false}`, `reason='no-grant'`.

> **Write, summarised:** granted only by loopback-owner (1), owner (2), ACL `write`
> (3), or `admin` (4). `viewer`, jws-non-members, and guests are read-only on a
> claimed instance — the "viewer = locked" guarantee, enforced in one place.

### 1.3 Truth table

READ, claimed instance, per principal class × effective scope. `✓`=read; `✗`=no;
`acl`=only if a matching ACL read/write entry exists (subject, or email under the
pinned authority).

| Principal class                  | public | authenticated | members | restricted |
|----------------------------------|:------:|:-------------:|:-------:|:----------:|
| loopback owner (`local`)         |   ✓    |       ✓       |    ✓    |     ✓      |
| owner (jws, `subject==owner`)    |   ✓    |       ✓       |    ✓    |     ✓      |
| admin (active roster)            |   ✓    |       ✓       |    ✓    |     ✓      |
| viewer (active roster)           |   ✓    |       ✓       |    ✓    |    acl     |
| granted via ACL only             |   ✓    |       ✓       |   acl   |    acl     |
| jws non-member                   |   ✓    |       ✓       |   acl   |    acl     |
| guest / anonymous                |   ✓¹   |       ✗       |    ✗    |     ✗      |
| invited/suspended persona²       |   ✓¹   |       ✗³      |    ✗    |    acl     |

¹ Unless `guestAccess='off'`, which denies guests even on `public` (rule 6).
² A roster row that is `invited` (unclaimed) or `suspended` grants **no role** (S3);
the principal is judged only by ACL + scope, exactly like a jws non-member, until it
becomes `active`. ³ A *signed-in but not-yet-active* persona is still a `jws` user,
so it reads `authenticated` pages via rule 5 — but gets nothing from the dormant
roster row.

WRITE, claimed instance — independent of scope:

| Principal class                  | canWrite | reason |
|----------------------------------|:--------:|--------|
| loopback owner / owner / admin   |    ✓     | local-owner / owner / admin |
| anyone with ACL `write`          |    ✓     | acl-write |
| viewer                           |    ✗     | viewer-readonly |
| jws non-member / guest / anon    |    ✗     | no-grant (or guest-disabled) |

Unclaimed instance (rule 0): read = `guestAccess !== 'off'` for all; write =
`guestAccess === 'write'` for all (jws/local always read+write). Loopback-only.

### 1.4 Where it is enforced — central default-deny + live channels (S4)

- **One default-deny helper** that *every* content route and *every* stream
  subscriber calls — there is no other path to page/row content:
  ```ts
  // throws 404 on !canRead (hide existence), 403 on !canWrite; returns the Decision.
  requireAccess(c, pageId, need: 'read'|'write'): Promise<Decision>
  ```
  Content fetches go through an **access-aware store method**
  (`getPageFor(principal, id)` / `listPagesFor(principal)` / `listRowsFor(principal,
  dbId)`) so a route that *forgets* to gate still returns nothing — **default-deny by
  construction**, not by discipline.
- **The `PageHub` fan-out becomes principal-aware.** Each SSE subscription carries
  its resolved `principal`; the hub evaluates `authorize(... ).canRead` per event
  per subscriber before emitting. This must cover **all live channels**:
  `GET /api/stream` (list), `GET /api/pages/:id/stream`, `GET /api/live` (firehose),
  `GET /api/databases/:id/stream`, plus the row **list** `GET
  /api/databases/:id/rows`. The list/firehose **filter** unreadable pages/rows out
  of each frame; a per-page/per-db stream that loses read access is closed (or never
  emits). A missed live channel is a silent read bypass, so this is a blocker-level
  requirement, not a nicety.
- `GET /api/pages` and the sidebar list filter to `canRead`. Suggestions / comments
  / review routes inherit their host page's decision. `guestGate` stays only as a
  cheap reachability pre-check; **`authorize` is authoritative** per page.

---

## 2. Data model + migration 0011

All additive; nothing rewrites existing rows. Existing pages default to
`visibility='inherit'`; unclaimed instances never reach the new path (rule 0); so
live local workspaces are unaffected.

### 2.1 `members` — the roster, with per-email personas (Fork 4/5, B1, S3)

A roster row is one of two shapes: an **email persona** (invited by email, bound to
an account subject on claim) or a **subject member** (invited by handle → already a
subject). One account `subject` may back **several** persona rows (its several
verified emails), each a distinct workspace member with its own role.

```sql
CREATE TABLE IF NOT EXISTS members (
  id          UUID        PRIMARY KEY,
  subject     TEXT,                              -- bound iss#sub; NULL until an email persona is claimed
  email       TEXT,                              -- persona email (lowercased); NULL for a subject/handle member
  issuer      TEXT        NOT NULL DEFAULT 'https://account.book.pub',  -- pinned email-authority for a persona (B1)
  role        TEXT        NOT NULL DEFAULT 'viewer',   -- 'admin' | 'viewer'
  status      TEXT        NOT NULL DEFAULT 'active',   -- 'invited' | 'active' | 'suspended'
  invited_by  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (email IS NOT NULL OR subject IS NOT NULL)
);
-- a persona email is unique within the workspace
CREATE UNIQUE INDEX IF NOT EXISTS members_email_key   ON members (lower(email)) WHERE email IS NOT NULL;
-- a pure subject/handle member is unique
CREATE UNIQUE INDEX IF NOT EXISTS members_subject_key ON members (subject)      WHERE email IS NULL AND subject IS NOT NULL;
-- list every persona bound to an account subject (multi-persona lookup)
CREATE INDEX        IF NOT EXISTS members_subject_idx ON members (subject)      WHERE subject IS NOT NULL;
```

**Role resolution (S3).** Request-time role = the row where `status='active'` **and**
the BOUND `subject == principal.subject`, with the active persona selected by email
for persona rows (`lower(email) == principal.email` **and** `issuer ==
principal.issuer == config.emailAuthority`). `invited`/`suspended` rows grant
**nothing**. Email matches **never** grant a role directly — they drive only ACL and
the invite-claim (§4.3). So a pending persona is a dormant row until its subject is
bound.

### 2.2 Per-page visibility

```sql
ALTER TABLE pages ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'inherit';
```
`inherit` resolves up the **parent** chain for an ordinary page, but via the
**database host page** for a database row (N9), then to `config.defaultVisibility`.

### 2.3 Per-page ACL — a `page_acl` table (not `pages.acl` JSONB), issuer-pinned (B1)

```sql
CREATE TABLE IF NOT EXISTS page_acl (
  page_id     UUID        NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  subject     TEXT,                              -- grantee already bound (any trusted issuer)
  email       TEXT,                              -- grantee by persona email (lowercased)
  issuer      TEXT,                              -- REQUIRED for an email grant: the pinned email-authority
  level       TEXT        NOT NULL,              -- 'read' | 'write'
  invited_by  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((subject IS NOT NULL) <> (email IS NOT NULL)),   -- exactly one grantee key
  CHECK (email IS NULL OR issuer IS NOT NULL)             -- an email grant MUST pin an issuer (B1)
);
CREATE INDEX        IF NOT EXISTS page_acl_page_idx       ON page_acl (page_id);
CREATE UNIQUE INDEX IF NOT EXISTS page_acl_page_subj_key  ON page_acl (page_id, subject)      WHERE subject IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS page_acl_page_email_key ON page_acl (page_id, lower(email)) WHERE email   IS NOT NULL;
CREATE INDEX        IF NOT EXISTS page_acl_email_idx      ON page_acl (lower(email))          WHERE email   IS NOT NULL;
```

**Why a table over `pages.acl` JSONB:** the share UI's cross-cutting queries
("everything shared with email X", "who can access this page") are plain indexed
selects; email matching wants a case-insensitive index + a global `lower(email)`
index for invite-claim; the invite-claim rewrite is a transactional `UPDATE` across
`members` + `page_acl`; FK gives cascade-delete with the page. JSONB would be atomic
with the page row and one fewer table, but the management/invite queries decide it —
**table**. (Note: an email grant carries the pinned `issuer`, so a federated issuer
can never satisfy an `account.book.pub`-scoped email grant — B1.)

### 2.4 `InstanceConfig` composition (JSONB `settings.instance` — no SQL)

```ts
export interface InstanceConfig {
  guestAccess: GuestAccess;                 // existing — guest-class floor (§1.2 rule 6); 'write'→'read' on claim
  ownerSubject?: string;                    // existing — undefined ⇒ unclaimed ⇒ rule-0 (loopback only)
  trustedIssuers: TrustedIssuerConfig[];    // existing
  audience?: string;                        // existing (OB-177) — set to the site host when forwarded (§3)
  requireAudience?: boolean;                // existing
  defaultVisibility?: Exclude<PageVisibility,'inherit'>; // NEW — `inherit` root; set to 'members' at claim (Fork 1)
  emailAuthority?: string;                  // NEW — the ONE issuer whose `email` claim is trusted for
                                            //       persona/email-ACL matching (B1). Default account.book.pub.
}
```
Only `emailAuthority`'s issuer can satisfy persona membership and email ACLs;
subject-based grants work for any `trustedIssuers` entry.

> **Config footgun (call it out):** `emailAuthority` **must be one of
> `trustedIssuers`**. If it names an issuer the instance does not trust, no token
> from it ever verifies, so `emailIsAuthoritative` is never true and **all**
> persona / email-ACL matching silently stops firing — it fails *safe* (→ deny,
> never a spoof), but it fails *silently*: every email-based grant quietly stops
> working. The settings writer should validate `emailAuthority ∈ trustedIssuers`
> (and surface it in the instance-policy UI) rather than let it drift.

### 2.5 Migration 0011 (append to `MIGRATIONS` in `server/migrations.ts`)

```ts
{
  name: '0011_sharing_access',
  statements: [
    /* members  CREATE TABLE + 3 indexes (§2.1) — verified to run on PGlite 17.5 */,
    `ALTER TABLE pages ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'inherit'`,
    /* page_acl CREATE TABLE + 4 indexes (§2.3) */,
  ],
}
```
Purely additive and idempotent. **No backfill:** absent roster + `visibility =
'inherit'` + unclaimed short-circuit = today's behaviour. The `lower(email)`
partial-unique indexes are confirmed to create and enforce on the embedded PGlite
(PostgreSQL 17.5) — see Verified starting state.

### 2.6 Ownership bootstrap & the claim (B2)

The dangerous state is a **reachable, unclaimed** instance: rule 0 makes it
anonymous world-writable. The contract forbids it from ever being exposed.

- **Exposure invariant.** No instance reachable beyond loopback is ever both
  *unclaimed* and *exposed*. **Publishing (LAN) and forwarding REQUIRE a claimed
  `ownerSubject`** (or atomically perform the claim as the first step of enabling
  exposure). If unclaimed, the publish/forward-enable flow refuses until a claim
  succeeds. Loopback-only stays claim-free (only the machine owner can reach it).
- **Claim binds `ownerSubject` to a verified identity tied to the registering
  account.** For forwarding, the site is registered under an account
  (`Site.ownerId = account userId`); the owner subject is
  `${emailAuthority}#${siteOwnerUserId}` — i.e. the account's own `iss#sub`. The
  device enabling exposure already holds that account (the device token / identity
  JWS), so it writes the **expected owner pin** and the first matching `jws` (or the
  loopback owner) claims it. A self-host with its own issuer claims with that
  issuer's owner subject.
- **TOCTOU close.** Setting `ownerSubject` is a **compare-and-set**: a single
  transactional update that succeeds only when it is currently unset, e.g.
  `UPDATE settings SET value = jsonb_set(value,'{ownerSubject}', $sub) WHERE key =
  'instance' AND NOT (value ? 'ownerSubject')`. A racing second claimant's update
  affects 0 rows and is rejected. `PUT /api/instance` must route owner-claim through
  this CAS, never a read-modify-write of the whole blob.
- **At claim, atomically (same transaction):** set `ownerSubject`; set
  `defaultVisibility = 'members'` (Fork 1); **downgrade `guestAccess 'write' →
  'read'`** (Fork 2); set `emailAuthority` (default account.book.pub).
- **Backstop for raw / manual self-host binds.** The exposure invariant above is
  enforced by the publish/forward *flow* — but an operator who hand-runs the server
  bound to a non-loopback interface *outside* that flow would still be rule-0
  world-writable while unclaimed. So the **server itself** is the last line: on
  startup it must **refuse to start (or loud-warn)** when it is about to listen on a
  **non-loopback** interface while `ownerSubject` is unset **and** no `accessToken`
  is configured. (Either an `accessToken` reachability gate or a claimed owner makes
  the bind safe; neither + public bind = the forbidden state, caught at boot rather
  than at first anonymous write.)

---

## 3. Edge↔origin trust bridge

### 3.1 The problem this reconciles
- **OB-140** wanted the origin to *trust the edge's signed principal* as identity.
- **OB-141** wanted a real per-page access model.
- The edge principal is `{owner, viewerId=per-site pseudonym}` **by design** — no
  `iss#sub`, no email, uncorrelatable across sites. It **cannot** match a roster
  `subject` or an email ACL, and an owner can't pre-invite a pseudonym. So the edge
  principal alone can never drive the invite model.

### 3.2 Recommendation — origin authz is JWS-only; the edge stays coarse (S7, Fork 6)

> **The viewer presents its own audience-scoped identity JWS
> (`X-OpenBook-Identity`) to the origin for ALL fine-grained authorization.** The
> origin runs the *same* `authorize()` whether reached directly, over LAN, or via
> the edge — one identity contract, one access model.

- **Self-host origins MUST NOT need `EDGE_PRINCIPAL_SECRET` (S7).** Origin authz is
  purely JWS-driven. `x-openbook-principal` is an **optional attribution hint**,
  consumed only by an origin that *already* shares the secret (the forwarded
  SaaS/self-host-behind-edge case) and only for (a) anonymous pseudonymous
  attribution of `public` browsing and (b) at most a UI hint. A pure self-host with
  no edge simply ignores the header; nothing in `authorize` depends on it.
- **Edge `owner` is not load-bearing (Fork 6).** Owner authz is the JWS rule (§1.2
  rule 2); the edge `owner` flag is keyed on account `userId` while `ownerSubject`
  is `iss#sub`, so it can never *safely* be the gate — only the JWS reconciles them.

Two layers, defense-in-depth:

| Layer | Granularity | Enforces | Mechanism |
|---|---|---|---|
| **Edge** (`decideGate`) | per **SITE** | reachability: public, or sign-in first | `Site.visibility` mirror; private + no `__Host-obviewer` → SSO bounce |
| **Origin** (`authorize`) | per **PAGE** | the four scopes + roster + ACL + guest gate | verified `Principal` from the JWS; **authoritative**, edge-secret-free |

A **public site with private pages**: edge passes traffic, origin 404s private pages
to non-members. A **private site**: edge bounces anonymous to sign-in, origin still
re-checks per page.

### 3.3 Forwarded JWS: getting it, disclosure, and refresh (S6, Fork 4/5)

A forwarded web viewer holds an account session cookie, but the identity-token route
is bearer-only cross-origin (no CORS credentials from `*.book.cloud`). Therefore:

> **Extend the SSO handoff** (`account .../api/forwarding/sso` → edge
> `/__obauth/callback`): alongside the `__Host-obviewer` cookie, mint an
> **audience-scoped identity JWS** (`aud = the site host`) for the **active persona**
> and deliver it to the web shell to send as `X-OpenBook-Identity`.

- **`aud` = the site's public host** (`<prefix>.book.cloud` or custom domain); the
  origin sets `InstanceConfig.audience` to that host and the account's
  `OPENBOOK_IDENTITY_ALLOWED_AUDIENCES` includes it. Closes the confused-deputy hole
  (a token for site A can't replay to site B) — the OB-177 mechanism, applied to
  forwarded hosts.
- **Email disclosure (S6).** The forwarded token carries `subject` + the **single
  active-persona email**, **never an array** (Fork 4/5). *Preferred:* carry a
  **salted hash** of that email — `emailHash = HMAC(salt, lower(email))` with a
  per-issuer published `salt` (alongside JWKS) — so the origin matches
  `HMAC(salt, lower(acl_email))` and learns **only addresses it already invited**,
  never the viewer's other addresses. *If hashing is out of scope for v1:* fall back
  to the single **plaintext** active-persona email (never the array). Persona
  selection and email-ACL matching work identically over either the plaintext or the
  hash. For `public` browsing, present **no JWS** at all (stay pseudonymous).
- **Refresh path.** Forwarded JWS TTL stays ~15 min. On expiry the web shell
  refreshes **without a full login bounce**: the `__Host-obviewer` cookie is still
  valid, so a **scoped refresh** (re-hit SSO, which short-circuits past `/login`
  when the obviewer session is present, or a dedicated `/__obauth/refresh`) re-mints
  the aud-scoped JWS for the same persona. Only a *missing/expired obviewer cookie*
  triggers a real re-SSO/login.

### 3.4 Sequence — forwarded read of a `members` page

```
viewer ─GET /p─▶ edge: site=private, no obviewer cookie
edge ─307─▶ account /api/forwarding/sso?next=…           (one-shot, host-bound)
account: signed in? → mint SSO token + AUD-scoped persona JWS(aud=site host,
                       sub=iss#sub, email=active-persona | emailHash)
account ─307─▶ edge /__obauth/callback → set __Host-obviewer; hand JWS to web shell
web shell ─GET /api/pages/:id (X-OpenBook-Identity: persona JWS)─▶ edge ─proxy─▶ origin
   (edge may add x-openbook-principal; origin treats it as an OPTIONAL hint only)  │
origin: resolvePrincipal(JWS) → Principal{subject, email}; emailIsAuthoritative?   │
origin: role = active persona row (active, bound subject, email under authority)   ▼
origin: authorize(...) — members ⇒ canRead iff active member            → 200 / 404
… ~15min later: JWS expires → web shell scoped-refresh via live obviewer cookie (no login)
```
Self-host with **no edge**: identical minus the SSO bounce and minus any edge
header — the client presents the JWS straight to the origin, which runs the same
`authorize()` with **no `EDGE_PRINCIPAL_SECRET`** anywhere. No behaviour depends on
the edge existing.

---

## 4. Multi-account + personas + handles

### 4.1 N accounts in the client
- Promote `AccountProvider` to hold a **list** of accounts: `{ id, label
  ('Work'|'Personal'), accountUrl, deviceToken, status, identityJws, expiresAt }`. A
  **workspace/account switcher** binds each workspace to one active account **and one
  active persona email**; the data client for a workspace presents *that* account's
  persona JWS.
- **`connection.ts` `setIdentityToken` is a module-global singleton today — it must
  become per-data-client / per-workspace.** Multiple instances open (work + personal)
  each carry the JWS of their bound account/persona. (Contract requirement.)
- Each account mints its own **audience-scoped, single-persona** JWS via
  `getIdentityToken(deviceToken, aud = server.audience, persona = activeEmail)`.
- Storage: today one `localStorage['openbook.account']` → a keyed set; on desktop
  device tokens live in the OS keychain (the forwarding-key pattern).

### 4.2 Personas: several verified emails → several members (Fork 4/5, B1)
- Add a `VerifiedEmail` model on account.book.pub: `{ id, userId, email @unique,
  verified, verifiedAt, isPrimary }`. `User.email` stays the primary display address.
- `issueIdentity` asserts **only a verified** email, and **only the single active
  persona** the client selected (never the full set) — `email` (or `emailHash`,
  §3.3) is one value. The token's `sub` is the stable account subject; the `email`
  is the persona facet chosen for *this* token.
- A workspace roster may therefore carry **separate `members` rows for the same
  `subject`**, one per persona email, each with its own role — exactly the inversion
  of R1's "collapse to one subject". The active persona (the email in the presented
  token) selects which row applies (§2.1).
- **Authority pin (B1).** Persona email and email-ACL are honoured **only** when the
  token's `issuer === config.emailAuthority` (default account.book.pub). A federated
  self-issuer that asserts arbitrary emails cannot impersonate a persona; it can
  still hold subject-based membership/grants. The pin is stored on the row
  (`members.issuer` / `page_acl.issuer`), so a grant minted for one authority can
  never be satisfied by another.

### 4.3 Email-or-handle invite resolution, end to end
1. **Invite** (owner/admin):
   - by **email** → `INSERT members(email, issuer=emailAuthority, role,
     status='invited')` and/or `INSERT page_acl(page_id, email, issuer=emailAuthority,
     level)`. No subject yet.
   - by **handle** (already a member) → resolve handle → `subject` (§4.4) → `INSERT
     page_acl(page_id, subject, level)` / `members(subject, …, status='active')`.
2. **Sign-in:** invitee authenticates, gets a persona JWS (`iss#sub` + active
   `email`/`emailHash`, `iss === emailAuthority`), presents it to the origin.
3. **Claim (MANDATORY rewrite — N10).** In a transaction, when the token's email is
   authoritative and matches an `invited` persona row or an `email` `page_acl` entry
   under the same pinned issuer: **bind** — `members`: `SET subject = $sub, status =
   'active'`; `page_acl`: `SET subject = $sub, email = NULL, issuer = NULL` (the grant
   becomes subject-keyed). This rewrite is **required, not optional**, so future
   lookups are by subject and a later email change can't silently re-open access.
4. **Authorize** proceeds with the now-active role / subject-keyed ACL (S3).

This one mechanism covers both invite kinds and both "already a member" / "brand
new" cases, identically whether the JWS arrives directly or via the edge.

### 4.4 Handles — HYBRID, enumeration-resistant (Fork 3)
- **Whitelisted accounts only** get an account-level **unique handle** (with custom
  colour / flair). This is a curated set, not an open namespace — most users have
  **no** handle.
- **Everyone else** is shown by a **roster-local display name**, rendered **gray**
  (visibly "not a verified global handle"). The display name is resolved within the
  instance roster, never globally.
- **Enumeration mitigation:** whitelisted-handle lookup is **rate-limited** and **not
  bulk-enumerable** — there is **no public handle directory** and no list endpoint.
  Only a whitelisted handle resolves (point lookup, throttled); any other input
  resolves to nothing and the inviter falls back to email or roster-local pick. This
  keeps handles from becoming a user-discovery / scraping surface.

---

## 5. Scope ownership (which layer enforces each scope) + self-host behaviour

| Scope | Edge (forwarded, per-SITE) | Origin (per-PAGE, authoritative, JWS-only) | Self-host (no edge, no edge-secret) |
|---|---|---|---|
| `public` | site `public` → pass through | read for **all** incl. anonymous (unless `guestAccess='off'`) | origin only: read for all; `off` blocks even public |
| `authenticated` | site `public` (let in) or `private` (bounce anon) | read for any **jws** user; guests denied | origin only: requires jws; guests denied |
| `members` | site `private` → bounce anon to SSO | read iff active roster member (persona under authority) | origin only: roster check on jws subject/persona |
| `restricted` | site `private` → bounce anon | read iff owner/admin/ACL(`subject` \| `email`@authority) | origin only: ACL/role on jws subject/persona |

- **The origin enforces all four scopes, per page.** The edge enforces only the
  coarse SITE `public|private` gate (DoS shield + the sign-in bounce) — "account/edge
  only mirror visibility".
- **Site visibility mirror:** set `Site.visibility = public` when **any** page is
  `public` (so the edge lets anonymous traffic reach the origin), else `private`.
  The fine decision is always re-made at the origin.
- **Self-host, no account at all:** roster + scopes + ACL + guest gate enforce at the
  origin with **zero** account/edge dependency and **no `EDGE_PRINCIPAL_SECRET`**
  (S7). Identity may come from the default-trusted account.book.pub issuer *or* a
  self-run issuer in `trustedIssuers` (OB-171); a self-host that wants email personas
  designates its own `emailAuthority`. `subject = iss#sub` regardless. Publishing is
  the only thing that needs account.book.pub; access control does not.

---

## 6. Open questions for owner
None outstanding — the 6 forks are resolved in §0 and folded into the body. The
remaining choices are **implementation latitude**, not product forks:
- **Email-hash vs plaintext in the forwarded JWS (§3.3):** ship plaintext-single-
  persona for v1 if the per-issuer salt/JWKS plumbing slips; upgrade to salted-hash
  without a contract change (matching is value-agnostic).
- **Scoped-refresh endpoint vs short-circuited re-SSO (§3.3):** either keeps TTL
  ~15 min; pick by edge plumbing cost.
  - **Refresh guardrail (Sasha — applies to whichever path):** the refreshed JWS
    **must re-assert `aud = site host`** (never a wider/unscoped audience — the
    confused-deputy protection has to survive every refresh). If a dedicated
    `/__obauth/refresh` endpoint is added it must be **host-bound + CSRF-safe** like
    the SSO callback, and it must **not silently extend the `__Host-obviewer`
    session's own lifetime** — it re-mints a short-lived *identity* JWS off the
    *existing* viewer session, it does not renew that session. (So a still-valid
    obviewer cookie buys cheap identity refreshes, but the viewer session's own
    expiry remains the real ceiling and still forces a true re-SSO when it lapses.)

---

## 7. Bottom line
One `authorize(principal, page, ctx)` at the origin is the single access decision for
the whole product. It composes per-page **visibility** + roster **role** (active,
bound personas) + per-page **ACL** (issuer-pinned for email) + the **guest gate**,
with a strict precedence ladder (loopback-owner → owner → ACL → role → scope → guest
gate → deny) and a legacy short-circuit that keeps the *unclaimed, loopback-only*
workspace exactly as it is today. The roster lives in the data server (`members`,
migration **0011**), per-page ACL is a queryable **`page_acl` table**, the origin is
**JWS-only and edge-secret-free**, the edge stays coarse (per-site visibility + SSO
bounce), exposure **requires a claim** (no reachable-and-unclaimed instance), and
every content route + live channel goes through one **default-deny** gate. No second
identity system, no second access model.

---

## 8. Security review resolution map (for Sasha's re-clear)

| # | Finding | Resolved in | How |
|---|---|---|---|
| **B1** | Cross-issuer email-ACL spoofing under federation | §1.1, §1.2 r3, §2.1, §2.3, §2.4, §4.2 | New `emailAuthority` config; email persona + email ACL honoured **only** when `principal.issuer === emailAuthority` and `verifiedVia==='jws'`; the pinned `issuer` is stored on every `members`/`page_acl` email row (`CHECK (email IS NULL OR issuer IS NOT NULL)`), so another issuer can never satisfy it. Personas pinned to the same authority. |
| **B2** | Ownership bootstrap: published-but-unclaimed = anon world-writable; PUT /api/instance TOCTOU | §1.2 r0, §2.6 | Exposure invariant (publish/forward REQUIRE or atomically trigger a claim; unclaimed ⇒ loopback-only); claim binds `ownerSubject` to the registering account's verified identity; CAS update (`… WHERE NOT (value ? 'ownerSubject')`) closes first-writer-wins. |
| **S3** | Role only from active, post-claim BOUND subject; invited/suspended grant nothing | §1.1, §1.2 r4, §2.1 | Role resolution filters `status='active'` + bound `subject==principal.subject`; email matches drive ACL/claim only, never role; truth-table row for invited/suspended personas. |
| **S4** | Live channels must enforce; central default-deny helper | §1.4 | Principal-aware `PageHub` fan-out across `/api/stream`, `/api/pages/:id/stream`, `/api/live`, `/api/databases/:id/{rows,stream}`; `requireAccess` + access-aware store methods so a missed route returns nothing (default-deny by construction). |
| **S5** | `local:owner` not locked out on a claimed instance | §1.1, §1.2 r1 | `verifiedVia==='local'` is rule 1 (loopback owner ⇒ read+write), above the owner-subject rule. |
| **S6** | Forwarded-JWS disclosure; refresh path | §3.3, Fork 4/5 | Token carries `subject` + **single** active-persona email, never an array; preferred **salted-hash** (origin learns only invited addresses), plaintext-single fallback if hashing deferred; ~15 min TTL with scoped-refresh via the live obviewer cookie (no re-login). |
| **S7** | Self-host must not need `EDGE_PRINCIPAL_SECRET` | §3.2, §5 | Origin authz is JWS-only; `x-openbook-principal` is an optional attribution hint consumed only where the secret already exists; self-host ignores it. |
| **N8** | `authenticated` = `jws`; gate owner on `jws`; `synced` not request-assertable | §1.1, §1.2 r2/r5 | "Authenticated" defined as `verifiedVia==='jws'`; owner rule gated on `jws`; `synced` stated to be attribution-only, never on a live request. |
| **N9** | Database-row `inherit` via the database host page | §1.1, §2.2 | `effectiveVisibility` resolves a row via its **database host page**, not the parent chain. |
| **N10** | Verify PGlite expression unique indexes; make claim rewrite mandatory | Verified-state note, §2.5, §4.3 | Tested `lower(email)` partial-unique index on PGlite 17.5 (creates + rejects dup); invite-claim ACL email→subject rewrite is **MANDATORY**. |
| **Correction** | Principal carries no email today | Verified starting state, §1.1 | Noted `principalFromClaims` drops the `email` claim; `Principal.email` (single persona) is net-new threading. |
