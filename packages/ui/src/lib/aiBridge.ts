import type * as Y from 'yjs';
import type {AgentProposal, StoredSuggestion} from '@open-book/sdk';

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

let bridge: AiBridgeImpl | null = null;
const subscribers = new Set<() => void>();

// ── Live block-editor doc registry (pageId → Y.Doc) ─────────────────────────────
// A mounted block editor registers its doc here so the agent's CRDT write path
// can reach it. Weakly scoped by page id; unregistered on unmount.

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
