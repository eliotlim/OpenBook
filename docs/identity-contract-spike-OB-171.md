# OB-171 Spike — One identity contract across OB-165 / OB-74 / OB-66

**Decision spike (not code).** Reconcile the multi-user epic's
account.book.pub-JWS identity model (OB-165) with **OB-74 — Launch: Multi-Tenant
Data Isolation** (the *data* half) and **OB-66 — Access-control foundation
(owner/token)** (the *auth* half). Question: is account.book.pub the **issuer**
those consume, or a **parallel** identity system? Goal: don't build two.

## Decision

**account.book.pub is THE issuer, and there is ONE identity contract.** OB-74 and
OB-66 consume the same verified `Principal` that OB-165 already produces; they do
**not** introduce their own identity issuance. Federation is supported by making
the *contract* issuer-agnostic (a trusted-issuer set), with account.book.pub as
the default — so a self-hosted/enterprise deployment can run its own issuer
against the same contract rather than a different system.

Put plainly: **identity is one layer; tenancy and access-control are layers on
top of it, keyed by the principal's `subject`.**

## The one contract (already shipped in OB-165)

```
EdDSA JWS  { iss, sub, name?, email?, iat, exp, jti, kid }   (account.book.pub, or any trusted issuer)
   │  verify against the issuer's cached JWKS (offline-capable)
   ▼
Principal { kind: 'user'|'guest',
            subject: `${iss}#${sub}` (globally unique),
            issuer, name, verifiedVia: 'jws'|'guest'|'unverified'|'local',
            assertion: { kid, jti } }
```

`subject` is the **join key** every higher layer uses. It is globally
meaningful (issuer-rooted), so the same person is the same subject on every
instance — which is exactly what federation and cross-instance attribution need.

## How each consumer layers on top

### OB-66 — Access-control foundation (owner / token) → the *auth* half
- **Owner** = a principal `subject`. Already modelled: `instance.ownerSubject`
  (set on first claim; only the owner may change instance policy). No new
  identity concept — the owner is just a distinguished subject.
- **Access token** = the **orthogonal reachability gate** (instance-wide shared
  secret, `Authorization: Bearer`), which already exists and is a *different
  axis* from identity (it answers "may you reach this instance", not "who are
  you"). OB-66's owner/token split maps 1:1 onto what OB-165 shipped:
  `accessToken` (reachability) + `Principal`/`ownerSubject` (identity + role).
- **Roles** (owner / member / guest) are a function `subject → role` an instance
  evaluates. Today: owner (ownerSubject) + guest (the gate) — a `members` grant
  table is the additive next step, keyed by `subject`.

### OB-74 — Multi-Tenant Data Isolation → the *data* half
- A hosted server that serves **many** workspaces (tenants) needs `workspace_id`
  on rows and a `principal.subject → workspace grants` mapping. **Identity is
  unchanged** — the issuer still only asserts *who* you are; the **host** maps
  subject → which tenant(s) you may touch, and scopes queries by `workspace_id`.
- So OB-74 = (this same Principal) + (a membership/grant table) + (row-level
  `workspace_id` scoping). It is an **authorization + partitioning** layer, not a
  second identity system.
- Note the axes are independent and compose:
  - **OB-165 single-tenant multi-user** = many subjects → ONE shared workspace
    (attribution + guest gate, no partitioning). **Shipped.**
  - **OB-74 multi-tenant** = subjects → MANY isolated workspaces (partitioning).
  - Both read the same `Principal`. A single-tenant instance is just the
    degenerate case (one implicit workspace, every member mapped to it).

### Forwarding (OB-140/141) — reconcile the *edge-injected* principal
Forwarding introduces a **second way a principal arrives**: for a forwarded web
viewer, the edge vouches for identity (HMAC via `EDGE_PRINCIPAL_SECRET`) and
injects a principal, rather than the client presenting a JWS. To avoid a third
identity system, both paths must resolve to the **same `Principal` shape**:

| Path | Vouched by | Trust mechanism | Carrier |
|---|---|---|---|
| App sign-in (OB-165) | the issuer (account.book.pub) | JWS verified vs JWKS | `X-OpenBook-Identity` |
| Forwarded viewer (OB-140) | the edge | HMAC `EDGE_PRINCIPAL_SECRET` | edge-injected header |

Recommendation: the data server's principal middleware accepts **either** a
verified JWS **or** an edge-injected principal trusted via the edge secret, both
producing a `Principal` with the appropriate `verifiedVia` (`'jws'` vs a new
`'edge'`). One `Principal`, multiple trust sources.

## What this rules out (so we don't build two systems)
- ❌ A separate JWT/session format for tenancy or access-control. They reuse the
  OB-165 JWS + `Principal`.
- ❌ account.book.pub as merely "one option among several first-class identity
  systems." It is the **default issuer of the single contract**; other issuers
  are additional entries in `trustedIssuers`, not parallel systems.
- ❌ Per-feature identity verification. Verification happens once, in the
  principal middleware; every layer reads `c.principal`.

## Concrete contract surface (already in code)
- `@book.dev/sdk` `identity.ts`: `Principal`, `IdentityClaims`, `Jwk/Jwks`,
  `signIdentity` / `verifyIdentity` (issuer-agnostic), `principalFromClaims`.
- `@book.dev/sdk` `provenance.ts`: `TrustedIssuerConfig`, `InstanceConfig`
  (`guestAccess`, `ownerSubject`, `trustedIssuers`) — the per-instance policy.
- server `principal.ts`: `resolvePrincipal` + `guestGate` (the single choke
  point all consumers read `c.principal` from).
- account.book.pub `lib/identity.ts` + `/api/identity/{jwks,token}`: the issuer.

## Recommended sequencing for OB-74 / OB-66
1. **OB-66**: add a `members` grant table keyed by `subject` (owner already
   done); roles gate writes in the existing middleware. Small, additive.
2. **OB-74**: add `workspace_id` to content tables + a `subject → workspace`
   membership; scope every query by the caller's workspace. Larger, but identity
   is a solved input.
3. Forwarding: unify the edge-injected principal into `resolvePrincipal`
   (`verifiedVia:'edge'`) so forwarded viewers attribute like everyone else.

**Bottom line: one issuer (account.book.pub, federatable), one `Principal`
contract, consumed by attribution (OB-165, done), access-control (OB-66), and
tenancy (OB-74). No second identity system.**
