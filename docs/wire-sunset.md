# Wire-residue sunset plan (v3.0.0)

_Created 2026-07-15 (IA-12 / OB-551). Owner-ratified policy: the three signed /
persisted / wire `workspace` residues are **deprecated now, removed at v3.0.0** —
NOT this epic. Every dual-accept / dual-write path stays live until cutover._

During the `workspace` → `library` container-noun rename (LIB-0..5) three
identifiers could not be renamed in place because they live on the wire, in signed
bytes, or in a persisted blob — changing them would break an already-shipped peer.
Each was made dual-accept / dual-write instead. This doc tracks their removal.

**Rule:** wire / persisted / exported identifiers are IMMUTABLE. Do not rename or
delete any residue below before v3.0.0, and only after its verification gate is met.

## The three residues

| # | Residue | Location | v2 replacement | Compat mechanism |
|---|---------|----------|----------------|------------------|
| 1 | `workspaceSync` route alias `/api/workspace/sync` | `packages/sdk/src/routes.ts` (`API.workspaceSync`); registered in `packages/server/src/app.ts` | `librarySync` → `/api/library/sync` | Both paths registered to the identical handlers; alias resolves for a not-yet-updated caller. |
| 2 | v1 roster assertion tag `openbook.roster.v1` carrying `workspaceId` | `packages/sdk/src/forwarding/rosterAssertion.ts` (`ROSTER_ASSERTION_VERSION`, `RosterAssertionV1Payload`, the v1 entry of `AUDIENCE_KEY_BY_VERSION`) | `openbook.roster.v2` carrying `libraryId` (SAME id VALUE) | Signer emits v2 only; verifier **dual-accepts** v1 + v2, fail-closed. Version tag is inside the signed bytes → immutable. |
| 3 | `workspaces` account sync-blob mirror | `packages/ui/src/providers/AccountProvider.tsx` (`SyncBlob.workspaces`, `makeSyncBlob`, `readIncomingLibraries`) | `libraries` | Outgoing blob **dual-writes** `libraries` + `workspaces` (always equal); incoming read as `libraries ?? workspaces`. |

Related legacy-compat reads that are NOT part of this epic's three residues but ride
the same cutover (verify alongside, remove when convenient after v3.0.0):
- `packages/server/src/rosterSync.ts` — account roster fetch falls back to
  `GET <account>/api/workspaces/:id/roster` and reads `libraryId ?? workspaceId`.
- `packages/ui/src/providers/LibraryProvider.tsx` — `LEGACY_LIBRARIES_KEY =
  'openbook.workspaces'` localStorage migration key (persisted value; keep for
  one-time local migration).
- `packages/server/src/server.ts` — `OPENBOOK_WORKSPACE_SYNC_TOKEN` env var (external
  operator config; read as `librarySyncToken ?? env`).

## Local migration observability (NO telemetry)

The app collects no analytics (see the privacy policy). To let a developer confirm
cutover is safe, two **dev-only** (`NODE_ENV !== 'production'`) `console.warn`s fire
when a v1 residue is exercised locally — no counters, no network, no persistence:
- **Residue 1:** server logs when `/api/workspace/sync` is hit (`app.ts`,
  `warnLegacyWorkspaceSync`).
- **Residue 3:** UI logs when an incoming account blob is `workspaces`-only
  (`AccountProvider.tsx`, `readIncomingLibraries`).
- **Residue 2:** no safe in-repo hook. The verifier runs in the account service
  (separate repo, workerd) where dev-gating isn't reliable and a security path
  should not log per-request. Observe via the account's own logs instead; the
  cutover gate below covers it.

## Verification gates — ALL must hold before removing a residue at v3.0.0

1. **Residue 1 (`workspaceSync`):** no client still calls `/api/workspace/sync`.
   Every shipped client resolves `librarySync`; confirm the dev warning above no
   longer fires against current builds, and grep released clients for the alias.
2. **Residue 2 (v1 `workspaceId`):** no deployed desktop build still signs
   `openbook.roster.v1`. Only drop `ROSTER_ASSERTION_VERSION` from
   `ACCEPTED_ROSTER_VERSIONS` once every updatable build emits v2 and the minimum
   supported desktop version is past the v2 cutover. Never drop it while any
   un-updatable build in the field signs v1 (fail-closed = those instances lose
   roster sync).
3. **Residue 3 (`workspaces` mirror):** no persisted account blob is
   `workspaces`-only. Every account has been re-pushed with the dual-written blob
   (so `libraries` is present); confirm the UI dev warning no longer fires.

## Removal checklist (execute at v3.0.0, one residue at a time, reversible)

- [ ] Residue 1: delete `API.workspaceSync` + its two `app.ts` registrations + the dev warn.
- [ ] Residue 2: drop `ROSTER_ASSERTION_VERSION` from `ACCEPTED_ROSTER_VERSIONS`; delete `RosterAssertionV1Payload` and the v1 `AUDIENCE_KEY_BY_VERSION` entry. Coordinate with the account repo's verifier.
- [ ] Residue 3: stop writing `workspaces` in `makeSyncBlob`; drop the `workspaces` fallback in `readIncomingLibraries`; remove the field from `SyncBlob`.
- [ ] Remove the two dev-only migration warnings and this doc's "observability" note.
