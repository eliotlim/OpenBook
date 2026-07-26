/**
 * AGED-2 — server-side teeth for the agent-edits policy.
 *
 * AGED-1 delivered the CONTRACT (types, the `resolveAgentEdits` resolver, the store
 * accessors, the jws-only policy routes). This module is the ENFORCEMENT primitive:
 * given the `PageStore`, resolve one page's effective agent-edits mode and answer the
 * single question every write path asks — "may an agent PAT edit THIS page directly?"
 *
 * Shared by the REST write gate (app.ts) and the remote-MCP per-write seam
 * (mcpHttp.ts) so the two decisions can never drift. Runtime dependency is `@book.dev/
 * sdk` only (the `PageStore` reference is type-only, erased at build → no import cycle
 * with the store).
 *
 * ── LOAD-BEARING FAIL-SAFE (Sasha, AGED-1 review) ─────────────────────────────────
 * A direct edit is permitted ONLY when the resolved mode is EXACTLY `=== 'direct'`.
 * Any other value — `'suggest'`, an `'inherit'` that leaked through, `undefined`,
 * garbage from a corrupted row — MUST fail safe to suggest-mode (deny the direct
 * write). Every branch here is written `mode === 'direct'`, never
 * `mode === 'suggest' ? … : direct`, so an unexpected value can never fall through to
 * a direct write. Callers MUST preserve this direction.
 */
import {resolveAgentEdits, type AgentEditsMode, type Principal} from '@book.dev/sdk';
import type {PageStore} from './store';

/**
 * The subject the SERVER stamps as a block's author for a request write path (AGED-2
 * extends OB-170). `jws` is the cryptographically-verified persona; `pat` is an agent
 * token bound AT MINT to a verified subject (never presenter-influenced, resolved by
 * hash lookup — not spoofable, not process-local), so an agent PAT's direct edits are
 * legitimately attributable to that subject in `pages.data.authors`. Every other class
 * (`guest` / `local` / `unverified`) carries no attributable identity and stamps `''`,
 * honestly leaving the block un-attributed rather than recording a spoofable or
 * process-local id — the same discipline `verifiedSubject` applies for the jws-only
 * paths that must NOT credit a PAT.
 */
export function authoredSubject(p: Principal | null | undefined): string {
  return p?.verifiedVia === 'jws' || p?.verifiedVia === 'pat' ? p.subject : '';
}

/**
 * Resolve one page's effective agent-edits mode: its raw policy (a missing page — e.g.
 * a not-yet-created id — resolves as `'inherit'`) against the instance mode, via the
 * AGED-1 single-source-of-truth resolver. Never returns `'inherit'`.
 */
export async function resolveAgentEditsForPage(store: PageStore, pageId: string): Promise<AgentEditsMode> {
  const page = await store.getPageAgentEdits(pageId);
  const instance = await store.getInstanceConfig();
  return resolveAgentEdits(page ?? 'inherit', instance.agentEdits);
}

/**
 * Whether an agent PAT may edit `pageId` DIRECTLY. Fail-safe: TRUE only when the
 * resolved mode is exactly `'direct'`; every other value (suggest / leaked inherit /
 * garbage) returns FALSE (steer the agent to a suggestion). See the module fail-safe
 * note — do not invert this.
 */
export async function agentMayEditDirectly(store: PageStore, pageId: string): Promise<boolean> {
  return (await resolveAgentEditsForPage(store, pageId)) === 'direct';
}
