# Multi‑User Support & Scheduled Backups — Design (2026‑06)

Covers two roadmap epics:

- **OB‑165 — Multi‑User Support** (the focus): let multiple people edit one
  OpenBook instance under their own identity, with durable, verifiable
  provenance for every change, and a guest‑by‑default access model.
- **OB‑166 — Regular Scheduled Backup Intervals**: tiered, automatic backups
  (daily / weekly / monthly / yearly) on top of today's ad‑hoc export.

---

## 1. Multi‑user in a *single‑tenant* context

### 1.1 The key reframing

OpenBook's data server is **single‑tenant**: one running server == one shared
workspace (`pages`, `databases`, `settings`, …). There is no `workspace_id`, no
per‑row owner, no tenant partitioning — and for this epic we keep it that way.

"Multi‑user" here does **not** mean multi‑tenant SaaS. It means:

> Many people collaborate on the *one* shared workspace, each acting under their
> own **identity**, with every change **attributed** and **provenance‑stamped**,
> and anonymous access **gated** by an owner‑controlled policy.

So the three things we add are **identity, attribution, and an access gate** —
not data isolation. That is what makes this tractable without a tenancy rewrite.

Today (confirmed in code): the server has zero identity. The only auth is an
optional instance‑wide `accessToken` shared secret (`app.ts` gate). Pages have
no `created_by`. account.book.pub authenticates users and issues opaque
DeviceTokens, but that token is **never sent to the data server** — it only
drives `/api/settings` sync and forwarding provisioning.

### 1.2 Vocabulary

- **Instance** — one data server == one shared workspace. May be a desktop
  sidecar (portless IPC), a headless server, or a desktop reached over a
  `*.book.pub` forwarding tunnel. All expose the same `/api`.
- **Principal** — the actor behind a request. Two kinds:
  - `guest` — unauthenticated (or a self‑named guest). Not vouched for by any
    issuer. Default for anyone who hasn't signed in.
  - `user` — authenticated by a **verifiable identity assertion** (a JWS) from a
    trusted **issuer**. Globally identified by `iss#sub`.
- **Issuer** — an identity authority that mints verifiable assertions and
  publishes a JWKS (public keys). Primary issuer: account.book.pub. An instance
  trusts one or more issuers — that set is what makes identities *federated*.
- **Owner** — the principal that administers this instance (sets the guest
  policy and the trusted‑issuer config). Single‑tenant ⇒ exactly one workspace,
  so "owner" is an instance‑level role, not a per‑page one.

### 1.3 Identity assertion: an EdDSA JWS (the "e.g. JWS" in the epic)

A user proves who they are with a compact **JWS** (JSON Web Signature), signed
by the issuer with **Ed25519 (`alg: EdDSA`)** — the same primitive the repo
already uses for forwarding site keys and plugin provenance, so **no new
dependency** (Node/WebCrypto `crypto.subtle` Ed25519).

```
header   { "alg": "EdDSA", "typ": "JWT", "kid": "<issuer key id>" }
payload  { "iss": "https://account.book.pub",
           "sub": "<stable user id>",
           "name": "Caryl", "email": "caryl@…",   // email optional
           "iat": 1750000000, "exp": 1750086400,
           "jti": "<assertion id>" }
signature  Ed25519( base64url(header) "." base64url(payload) )
```

Why a *signed, verifiable* assertion rather than the existing opaque
DeviceToken? Because the epic requires recording **what source authenticated a
user** and attributing changes **on any federated instance, even offline**:

- **Verifiable offline / federated.** Any instance can verify the signature
  against the issuer's **cached** JWKS — no call back to the issuer per request,
  no per‑instance shared secret. A brand‑new federated instance trusts the same
  issuer key set and recognizes the same `iss#sub`. Opaque tokens can't do this
  (they require an online introspection call to the minting service).
- **Self‑describing provenance.** The claims *are* the record of who and which
  authority. We persist `iss`, `kid`, and `jti` so a change traces back to the
  exact credential that authorized it.

This assertion is **additive** to account.book.pub: it keeps issuing Device
Tokens for settings sync; it additionally mints these identity JWSes for the
data server. (Account‑side minting + JWKS endpoint is follow‑up work in the
sibling `open.book.pub` repo — see §1.9. This repo ships the **verifier** and a
**dev issuer** so the whole path is testable now.)

### 1.4 Transport: a dedicated identity header

The client sends the assertion on every data‑server request as:

```
X-OpenBook-Identity: <jws>
```

Deliberately **separate** from `Authorization: Bearer <accessToken>`. They are
orthogonal axes:

| Axis | Header | Question it answers | Scope |
|---|---|---|---|
| Reachability gate | `Authorization: Bearer` | "May you reach this instance at all?" | instance‑wide shared secret (only when LAN‑published) |
| Identity | `X-OpenBook-Identity` | "Who are you?" | per‑user, verifiable |

A LAN‑published instance can require **both**: the access token to connect, and
an identity to attribute writes. Overloading one header would conflate them.

For SSE (`EventSource` can't set headers) identity rides a `?identity=` query
param, exactly as the access token already rides `?token=`.

### 1.5 Server: principal resolution + the guest gate

A single middleware resolves a principal and attaches it to the Hono context
(`c.set('principal', …)`), then enforces the guest policy:

```
1. (existing) accessToken gate — unchanged; runs first.
2. Read X-OpenBook-Identity. If present and it verifies against a trusted
   issuer's JWKS (with clock‑skew grace) → user principal
   { kind:'user', issuer, subject, name, verifiedVia:'jws', assertion:{kid,jti} }.
   If present but does NOT verify → 401 (a presented‑but‑bad credential is an
   error, never silently downgraded to guest).
3. No identity → guest principal
   { kind:'guest', subject:'guest:<name-or-anon>', name, verifiedVia:'guest' }.
4. Enforce instance.guestAccess:
     'write' (default) → guests may read + write   (identical to today)
     'read'            → guests may GET; writes → 401
     'off'             → guests get 401 on everything
   Verified users are always allowed (per‑page ACLs are out of scope, §1.8).
```

`guestAccess` lives in the `settings` table under key `instance`, default
`'write'`. **Default `write` is important**: it means an instance with nobody
signed in behaves exactly as it does today, so this change is fully
backward‑compatible. Tightening to `read`/`off` is an explicit owner choice.

### 1.6 Attribution & durable provenance

Everything below is **server‑stamped from the verified principal**. The server
never trusts an author field sent in a request body — that would let any caller
forge authorship.

Two records, both written inside the same transaction as the mutation:

1. **Last‑author columns on `pages`** (cheap "last edited by X"):
   `last_author_subject`, `last_author_issuer`, `last_author_name`,
   `last_author_verified` — stamped on every `upsertPage` / row update.
2. **Append‑only `edit_log`** (the durable trail — *what changes each user
   made*):
   ```
   edit_log(
     id, page_id, author_subject, author_issuer, author_name,
     verified_via,                 -- 'jws' | 'guest' | 'access-token' | 'local'
     kind,                         -- 'page.save' | 'page.create' | 'row.update' | …
     assertion_kid, assertion_jti, -- which signed credential authorized it (null for guests)
     summary, created_at )
   ```
   One row per mutating request. This is the per‑user, per‑instance history. It
   is also the natural seam for a future "page history / who‑changed‑what" UI.

The review layer (`suggestions`, `comments`) already carries `author_kind` +
`author_name` (display only). We extend those inputs with the structured
`author_subject` / `author_issuer` from the principal, so AI‑vs‑human stays, but
"which human" becomes a real identity rather than a free string.

#### Offline & CRDT attribution

Edits are Yjs CRDT mutations; today every local transaction uses the bare origin
`'local'`. We change local edits to a structured origin `{ src:'local', author }`
where `author` is the principal's short id (`iss#sub`, or `guest:<name>`):

- The author travels **with the edit**, so an offline desktop attributes every
  change locally without a server round‑trip, and stamps the `edit_log` on the
  next sync.
- Federation works because identity is **issuer‑rooted**: `iss#sub` is globally
  meaningful, so the same person editing two federated instances is the same
  subject on both. Each instance keeps its own `edit_log`; the union is the
  user's complete cross‑instance history. No central coordinator required — the
  CRDT merges content, the issuer roots the identity.
- **Long‑offline degradation:** an assertion can expire while offline. Rather
  than silently trust or silently drop it, a principal whose assertion is
  expired but otherwise well‑formed and cache‑verifiable is recorded as
  `verified_via:'unverified'` — provenance still names the claimed subject, but
  flags that the credential wasn't fresh. A small configurable grace window
  covers normal clock skew / short offline spells.

### 1.7 Federation over the forwarding tunnel

A user reaching a desktop instance over a `*.book.pub` tunnel must still be
attributed. The tunnel protocol already forwards request headers verbatim
(`tunnelClient` builds `init.headers` from the inbound frame), so
`X-OpenBook-Identity` passes straight through to the local `/api`. The local
server verifies and attributes it identically to a same‑origin request. The
forwarding **site key** (Ed25519) authenticates the *tunnel* (which desktop),
not the *user* — the two are independent and compose: the site key says "this is
Caryl's laptop", the identity JWS says "and Dana is the one editing right now".

### 1.8 Out of scope (intentionally, for single‑tenant v1)

- **No per‑row `workspace_id` / tenant partitioning.** One shared workspace.
- **No per‑page ACLs or sharing model.** Everyone with write access edits
  everything. The principal + `edit_log` make a future ACL layer purely
  additive (gate writes on `principal` + a per‑page grant table).
- **No account‑service code in this repo.** We ship the verifier + a dev issuer;
  real JWS minting + JWKS hosting is follow‑up in `open.book.pub`.

### 1.9 account.book.pub issuance — DONE (sibling repo `open.book.pub`)

Shipped on branch `feat/identity-jws` in `open.book.pub` (`@book/account`):

1. ✅ An Ed25519 issuer key (`lib/identity.ts`, from `OPENBOOK_IDENTITY_*` env) +
   `GET /api/identity/jwks` publishing the public key by `kid`. Signing is
   self‑contained on Web Crypto — **byte‑compatible** with this repo's
   `verifyIdentity` (cross‑checked end‑to‑end: an account‑signed JWS verifies to
   a `verifiedVia:'jws'` principal `https://account.book.pub#<sub>`).
2. ✅ `GET /api/identity/token` — Bearer DeviceToken / session → a short‑lived
   identity JWS (claims in §1.3). The OpenBook client (`AccountClient.getIdentityToken`)
   fetches one after sign‑in (`AccountProvider`) and refreshes it before `exp`.
3. ✅ Reuses `resolveUserId`, so `sub` is the same stable user id as settings sync.

Gated on env: with no signing key set both routes answer 501, so an un‑keyed
deploy is a no‑op. This repo default‑trusts `account.book.pub`
(`DEFAULT_INSTANCE_CONFIG.trustedIssuers`), so once the account env key is set,
signed‑in users are verified out of the box — no per‑instance configuration.

### 1.10 Why this satisfies the epic, point by point

> "use account.book.pub to enable multiple users to modify things with their own
> identity on a given server"

Each user signs in to account.book.pub, gets an identity JWS, and sends it to
the (single, shared) data server, which resolves a distinct verified principal
per user. ✔

> "durable mechanism to specify what source authenticated a user (e.g. JWS) and
> what changes the user made on any federated OpenBook instance (even offline)"

`edit_log` + `last_author_*` record the source (`issuer`/`kid`/`jti`,
`verified_via`) and the changes (one row per mutation). Issuer‑rooted identity +
cached‑JWKS verification + CRDT author‑in‑origin make it work across federated
instances and offline. ✔

> "by default, users start out as a guest, and we should enable / disable guest
> access"

`instance.guestAccess` defaults to `write` (guest‑by‑default, backward
compatible); the owner can set it to `read` or `off`. ✔

### 1.11 Delivery slices

1. **SDK `identity` module** — `Principal` type, EdDSA‑JWS sign/verify, JWKS
   verification, dev keypair/issuer. *(no deps; reuses `forwarding/encoding`.)*
2. **Server principal middleware + guest gate** — `instance` settings, resolve
   principal, enforce policy, `c.set('principal')`. Back‑compat default `write`.
3. **Provenance** — migration (`last_author_*`, `edit_log`), stamp from
   `c.principal` in store writes.
4. **Client plumbing** — AccountProvider surfaces identity claims; DataClient
   sends `X-OpenBook-Identity`; guest identity when signed out; owner toggle UI.
5. **Forwarding passthrough** — confirm header survives the tunnel (+ test).
6. **Attribution UI** — "last edited by", structured suggestion/comment authors.

Slices 1–3 are the server‑verifiable core and land first, behind tests, fully
backward compatible.

---

## 2. Regular scheduled backups (OB‑166)

### 2.1 Goal

Beyond today's manual export (`exportSpace()` JSON, `spaceToBookFiles()` folder),
add **automatic, tiered** backups with increasing intervals — daily, weekly,
monthly, yearly — and bounded retention, so a workspace self‑protects without
the user remembering to export.

### 2.2 Mechanism

Reuse the server's existing periodic‑job pattern (`setInterval().unref()`, used
by trash cleanup and PGlite maintenance; embedded mode):

- Config in `settings` under key `backups`:
  ```
  { enabled, dir,
    cadences: { daily, weekly, monthly, yearly },   // each on/off
    keep:     { daily:7, weekly:5, monthly:12, yearly:5 },
    lastRun:  { daily:ISO, weekly:ISO, … } }
  ```
- A single low‑frequency timer (e.g. hourly) checks each enabled cadence: if
  `now - lastRun[cadence] >= interval(cadence)`, write a snapshot and update
  `lastRun`. Running once on boot catches up after downtime (same idea as the
  trash sweep). This is the **grandfather‑father‑son** rotation: short cadences
  churn fast, long ones are retained sparsely → "increasing intervals".
- Each snapshot = `store.exportAll()` serialized to the existing `SpaceBackup`
  JSON (lossless), written atomically to
  `<dir>/<cadence>/openbook-backup-<ISO>.openbook.json`, then prune oldest beyond
  `keep[cadence]`. (Folder/HTML format is a later option; JSON is the canonical
  restore path `importSpace` already understands.)
- Default `dir`: `<dataDir>/backups` (embedded) — self‑contained, survives app
  restarts; overridable to a user folder via a Tauri picker (reuse the
  `chooseBookDir` pattern).

### 2.3 UI

Extend `BackupSettings.tsx`: a "Scheduled backups" section — master toggle,
per‑cadence enable + retention, chosen folder (+ reveal), and a status line
("Last daily backup 3h ago · next in 21h"), plus a "Back up now" action. Config
round‑trips through a small settings endpoint.

### 2.4 Out of scope (v1)

- Cloud/off‑device backup targets (local/though chosen‑folder only; the folder
  can itself live in Dropbox/iCloud).
- Encrypted backups.
- Restore UI beyond the existing import (the files are plain `.openbook.json`).
</content>
</invoke>
