import type * as Y from 'yjs';
import {resolveAgentEdits, type AgentEditsMode, type AgentProposal, type DataClient, type StoredSuggestion} from '@book.dev/sdk';
import {
  blockText,
  coerceNewBlock,
  decodeSnapshot,
  encodeSnapshot,
  findBlock,
  makeBlock,
  patchBlock,
  replaceText,
  rootBlocks,
  type BlockDocSnapshot,
  type NewBlock,
} from '@/blockeditor/model';
import {findInput, setInputValue} from '@/blockeditor/kit/scope';
import {merge3} from '@/lib/textMerge';
import {readPageTheme, writePageTheme} from '@/lib/pageTheme';
import {COVER_GRADIENTS, writePageCover} from '@/lib/pageCover';
import type {AppearanceOverride} from '@/lib/themes';

/**
 * Bridge between the (provider-less) block editor and the app's AI client —
 * the same singleton pattern as `pageLinks`. The app installs it once
 * (DefaultLayout); editor slash items consult `ready` to decide whether to
 * appear and call through for completions / task breakdowns.
 *
 * The bridge also owns the agent's WRITE path. Write tools never mutate; the
 * agent returns a PROPOSED change set, the AgentPanel shows it for approval,
 * and on approve the bridge applies it. Two application paths:
 *
 *  1. CRDT path — when a live block editor for the target page has registered
 *     its Y.Doc (via {@link registerBlockEditorDoc}), the change is applied in
 *     ONE Y transaction (origin 'local') so it's undoable and broadcasts live,
 *     exactly like a kit click or a streamed token.
 *  2. Server fallback — otherwise the change is applied through the data client
 *     (savePage / updateRow). A live editor on that page merges it (CRDT union)
 *     on its next server push.
 *
 * Keeping the editor-doc handle in a singleton (rather than coupling the agent
 * to React) mirrors how `aiBridge.complete` already streams tokens into the
 * editor's CRDT without the agent knowing about React at all.
 */

export interface ProposalApplyResult {
  applied: number;
  failed: Array<{id: string; error: string}>;
}

export interface AiBridgeImpl {
  /** Engine is configured and was ready at the last status poll. */
  ready: () => boolean;
  complete: (text: string, onToken: (token: string) => void) => Promise<string>;
  tasks: (goal: string, context?: string) => Promise<string[]>;
  /** Apply an approved set of agent proposals. */
  applyProposals: (proposals: AgentProposal[]) => Promise<ProposalApplyResult>;
  /**
   * Apply one accepted suggestion to the document — the same CRDT-first /
   * savePage-fallback path as {@link applyProposals}, keyed off the suggestion's
   * `payload.applyKind`. Throws on failure (the caller keeps the suggestion open).
   */
  applySuggestion: (suggestion: StoredSuggestion) => Promise<void>;
}

/**
 * Convert a persisted suggestion back into the {@link AgentProposal} shape the
 * editor-bridge apply path understands. The suggestion's `payload` carries the
 * original write-tool kind as `applyKind`, so applying an AI suggestion and a
 * human suggestion go through identical code.
 */
export const suggestionToProposal = (s: StoredSuggestion): AgentProposal => {
  const payload = s.payload ?? {};
  const kind = (payload.applyKind as AgentProposal['kind']) ?? 'update_block';
  return {
    id: s.id,
    kind,
    summary: typeof payload.summary === 'string' ? payload.summary : `${s.kind} on ${s.pageId}`,
    pageId: s.pageId,
    before: s.before,
    after: s.after,
    payload,
  };
};

// ── Live block-editor doc registry (pageId → Y.Doc) ─────────────────────────────
// A mounted block editor registers its doc here so the agent's CRDT write path
// can reach it. Weakly scoped by page id; unregistered on unmount. Declared up
// here (before the apply path) so {@link applyProposal} can consult it.

const editorDocs = new Map<string, Y.Doc>();

/** A mounted block editor registers its live doc. Returns an unregister fn. */
export const registerBlockEditorDoc = (pageId: string, doc: Y.Doc): (() => void) => {
  editorDocs.set(pageId, doc);
  return () => {
    if (editorDocs.get(pageId) === doc) editorDocs.delete(pageId);
  };
};

/** The live editor doc for a page, when one is currently mounted. */
export const getBlockEditorDoc = (pageId: string | undefined): Y.Doc | null =>
  (pageId && editorDocs.get(pageId)) || null;

/** Reverse lookup: the page id a live editor doc is registered under, if any. */
export const getPageIdForDoc = (doc: Y.Doc): string | null => {
  for (const [pageId, registered] of editorDocs) {
    if (registered === doc) return pageId;
  }
  return null;
};

// ── The agent WRITE path (pure — no React) ──────────────────────────────────────
// Extracted here so both the React host (AiBridgeHost) and the client-side
// agent-edits policy router (AGED-4, below) share ONE apply implementation, and
// so the live-vs-stored branching is unit-testable against the doc registry.

/** The subset of the data client the agent write path calls. */
export type ApplyClient = Pick<DataClient, 'updateRow' | 'getPage' | 'savePage'>;

/** Mutate a live Y.Doc in one transaction (origin 'local' → tracked by the
 *  shared UndoManager, so an agent apply is undoable exactly like a manual edit). */
export const applyProposalToDoc = (doc: Y.Doc, p: AgentProposal): void => {
  doc.transact(() => {
    const payload = p.payload;
    if (p.kind === 'set_kit_value') {
      const block = findInput(doc, String(payload.name));
      if (block) setInputValue(block, payload.value);
    } else if (p.kind === 'update_block') {
      const found = findBlock(doc, String(payload.blockId));
      const text = found && blockText(found.block);
      if (text) {
        const theirs = String(payload.text ?? '');
        // `payload.before` is the block text when the suggestion was made.
        // Merging against it (rather than replacing wholesale) means a second
        // suggestion accepted on the same block keeps the first one's edit
        // instead of clobbering it; with no base we fall back to a replace.
        const base = typeof payload.before === 'string' ? payload.before : null;
        const next = base === null ? theirs : merge3(base, text.toString(), theirs);
        replaceText(text, next);
      }
    } else if (p.kind === 'append_blocks') {
      const list = rootBlocks(doc);
      const raw = Array.isArray(payload.blocks) ? payload.blocks : [];
      const built = raw
        .map(coerceNewBlock)
        .filter((b): b is NewBlock => b !== null)
        .map(makeBlock);
      if (built.length > 0) list.push(built);
    } else if (p.kind === 'delete_block') {
      const found = findBlock(doc, String(payload.blockId));
      if (found) found.parent.delete(found.index, 1);
    } else if (p.kind === 'set_block_props') {
      const found = findBlock(doc, String(payload.blockId));
      if (found) {
        patchBlock(found.block, {
          type: typeof payload.type === 'string' ? payload.type : undefined,
          props: payload.props && typeof payload.props === 'object' ? (payload.props as Record<string, unknown>) : undefined,
        });
      }
    }
  }, 'local');
};

/** Apply a per-page appearance proposal (theme + optional cover gradient). */
const applyPageAppearance = (pageId: string, payload: Record<string, unknown>): void => {
  if (payload.theme && typeof payload.theme === 'object') {
    // Merge over any existing override so we only change the named knobs.
    writePageTheme(pageId, {...readPageTheme(pageId), ...(payload.theme as AppearanceOverride)});
  }
  if (typeof payload.coverGradientId === 'string' && payload.coverGradientId) {
    const gradient = COVER_GRADIENTS.find((c) => c.id === payload.coverGradientId);
    if (gradient) writePageCover(pageId, {kind: 'gradient', css: gradient.css});
  }
};

/** Fallback: fetch, mutate the stored snapshot's block doc, and save. */
const applyToStoredPage = async (client: ApplyClient, pageId: string, p: AgentProposal): Promise<void> => {
  const page = await client.getPage(pageId);
  if (!page) throw new Error('page not found');
  const blockdoc = page.data.blockdoc as BlockDocSnapshot | undefined;
  // Rebuild a Y.Doc from the stored snapshot, mutate it, re-encode. This keeps
  // the CRDT history coherent for the next reader rather than hand-editing the
  // JSON projection.
  const doc = decodeSnapshot(blockdoc);
  applyProposalToDoc(doc, p);
  await client.savePage({
    id: page.id,
    name: page.name,
    data: {...page.data, editor: 'blocks', blockdoc: encodeSnapshot(doc)},
  });
};

/**
 * Apply ONE proposal (CRDT-first, server fallback). DB cells are page
 * properties (never in the editor CRDT); appearance is a per-page localStorage
 * preference; everything else mutates the block doc — live when the page's
 * editor is mounted, otherwise the stored snapshot.
 */
export const applyProposal = async (client: ApplyClient, p: AgentProposal): Promise<void> => {
  const payload = p.payload;
  if (p.kind === 'set_db_cell') {
    // DB cells are manual page properties — never in the editor CRDT.
    await client.updateRow(String(payload.databaseId), String(payload.rowId), {
      properties: {[String(payload.propertyId)]: payload.value},
    });
    return;
  }

  const pageId = String(payload.pageId ?? p.pageId ?? '');
  if (!pageId) throw new Error('proposal has no target page');

  if (p.kind === 'set_page_theme') {
    // Appearance is a per-page viewing preference (localStorage), not CRDT
    // content — apply it directly here on the client.
    applyPageAppearance(pageId, payload);
    return;
  }

  const liveDoc = getBlockEditorDoc(pageId);
  if (liveDoc) {
    applyProposalToDoc(liveDoc, p);
    return;
  }
  // No live editor — mutate the stored snapshot and save (merged on reopen).
  await applyToStoredPage(client, pageId, p);
};

// ── Agent-edits policy router (AGED-4) ──────────────────────────────────────────

/** The outcome of routing a batch of AI suggestions through the resolved policy. */
export interface AiSuggestionRouting {
  /** How many suggestions were applied directly (and their review rows removed). */
  applied: number;
  /** Suggestions kept for human review (resolved policy was `suggest`). */
  suggested: StoredSuggestion[];
  /** Direct applies that threw — their review rows are left intact. */
  failed: Array<{id: string; error: string}>;
}

/** The data-client surface the policy router needs (on top of {@link ApplyClient}). */
export type PolicyClient = Pick<DataClient, 'getInstanceInfo' | 'getPageAgentEdits' | 'deleteSuggestion'>;

/**
 * Route the built-in AI's proposed suggestions through the resolved agent-edits
 * policy (AGED-1 `resolveAgentEdits`). The built-in AI runs under the USER's own
 * session identity, so the server cannot tell its writes from a human's — the
 * suggest-vs-direct decision is therefore enforced HERE on the client, not by a
 * server gate.
 *
 *  - `direct` → apply immediately through the SAME editor-bridge path an accepted
 *    suggestion takes (live doc when open, stored snapshot otherwise) and DELETE
 *    the review row the server persisted optimistically, so no shadow suggestion
 *    lingers. Audit trail stays in edit_log + block authorship.
 *  - `suggest` → leave the suggestion for review (returned in `suggested`).
 *
 * Instance mode is instance-wide, so it's read ONCE per batch; the page policy
 * must bite immediately, so it's re-read per suggestion at apply time (never
 * cached). Any policy-read failure falls back to the safe `suggest` default.
 */
export async function routeAiSuggestions(
  client: ApplyClient & PolicyClient,
  suggestions: StoredSuggestion[],
): Promise<AiSuggestionRouting> {
  let instanceMode: AgentEditsMode | undefined;
  try {
    instanceMode = (await client.getInstanceInfo()).agentEdits;
  } catch {
    instanceMode = undefined; // pre-AGED / unreachable instance → resolve() defaults to 'suggest'
  }

  const suggested: StoredSuggestion[] = [];
  const failed: Array<{id: string; error: string}> = [];
  let applied = 0;

  for (const s of suggestions) {
    let mode: AgentEditsMode;
    try {
      mode = resolveAgentEdits(await client.getPageAgentEdits(s.pageId), instanceMode);
    } catch {
      mode = 'suggest'; // fail safe: keep for review if the page policy can't be read
    }
    if (mode !== 'direct') {
      suggested.push(s);
      continue;
    }
    try {
      // Attribution: a direct AI apply saves under the USER's session identity
      // (recorded in edit_log + block authorship) — the built-in AI has no
      // separate principal, and the server can't distinguish its write from a
      // human's. Acceptable for v1; the per-page override to 'suggest' is the
      // user's recourse if they want AI edits held for review.
      await applyProposal(client, suggestionToProposal(s));
      // Direct mode leaves NO shadow suggestion. The server persisted this row
      // before the client resolved the policy (it can't know the resolution), so
      // drop it now that we've applied it.
      await client.deleteSuggestion(s.id);
      applied += 1;
    } catch (err) {
      failed.push({id: s.id, error: err instanceof Error ? err.message : String(err)});
    }
  }
  return {applied, suggested, failed};
}

let bridge: AiBridgeImpl | null = null;
const subscribers = new Set<() => void>();

export const setAiBridge = (next: AiBridgeImpl | null): void => {
  bridge = next;
  subscribers.forEach((cb) => cb());
};

export const subscribeAiBridge = (cb: () => void): (() => void) => {
  subscribers.add(cb);
  return () => subscribers.delete(cb);
};

export const aiBridge = {
  ready: (): boolean => bridge?.ready() ?? false,
  complete: (text: string, onToken: (token: string) => void): Promise<string> =>
    bridge ? bridge.complete(text, onToken) : Promise.reject(new Error('AI not available')),
  tasks: (goal: string, context?: string): Promise<string[]> =>
    bridge ? bridge.tasks(goal, context) : Promise.reject(new Error('AI not available')),
  applyProposals: (proposals: AgentProposal[]): Promise<ProposalApplyResult> =>
    bridge ? bridge.applyProposals(proposals) : Promise.reject(new Error('AI not available')),
  applySuggestion: (suggestion: StoredSuggestion): Promise<void> =>
    bridge ? bridge.applySuggestion(suggestion) : Promise.reject(new Error('editor bridge not available')),
};
