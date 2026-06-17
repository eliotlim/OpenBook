/**
 * Suggestions + comments: a review layer over a page's content.
 *
 * A SUGGESTION is a proposed change to the document that is NOT applied
 * immediately — it is persisted, surfaced for review (inline in the document
 * and in a side-pane "Review" surface), and applied to the CRDT only when a
 * human accepts it. AI write tools and humans produce the SAME suggestion
 * model: the agent's write tools persist suggestions instead of mutating, and
 * a human "Suggest edit" affordance persists one too.
 *
 * A COMMENT is a general discussion layer: a threaded comment on a suggestion
 * (the suggestion's review thread) OR a standalone comment anchored to a block.
 * Comment bodies are rich text (`TextRun[]`, the same projection the block
 * editor uses), so they support bold/italic/underline/links.
 *
 * The `kind`/`payload` shape of a suggestion mirrors the agent's former
 * `AgentProposal` exactly, so the existing editor-bridge apply path
 * (CRDT-first, savePage fallback) replays a suggestion's `payload` unchanged.
 */

/**
 * One run of rich text in a comment body. Structurally identical to the block
 * editor's `TextRun` (a string plus optional inline attributes), defined here
 * so the SDK stays free of any UI dependency. The UI's `TextRun` is assignable
 * to this, and vice-versa.
 */
export interface CommentRun {
  t: string;
  a?: {
    b?: boolean;
    i?: boolean;
    u?: boolean;
    s?: boolean;
    /** Link href. */
    a?: string;
  };
}

/** Who authored a suggestion or comment. */
export type SuggestionAuthorKind = 'ai' | 'human';

/** The change a suggestion proposes — mirrors the agent write-tool kinds. */
export type SuggestionKind = 'replace-text' | 'set-cell' | 'insert' | 'delete' | 'set-theme';

/** Lifecycle of a suggestion. */
export type SuggestionStatus = 'open' | 'accepted' | 'rejected';

/**
 * What a suggestion targets. A block-level target carries the `blockId`; a
 * text-range target additionally carries character offsets within that block's
 * text (linear offsets over the block's plain text). A database-cell target
 * carries the database + row + property ids instead.
 */
export interface SuggestionTarget {
  /** The block this suggestion edits / inserts after / deletes (text targets). */
  blockId?: string;
  /** Character range within the block's text, when the suggestion is range-scoped. */
  range?: {start: number; end: number};
  /** Database-cell target (for `set-cell`). */
  databaseId?: string;
  rowId?: string;
  propertyId?: string;
}

/** A persisted, reviewable proposed change to a page. */
export interface StoredSuggestion {
  id: string;
  pageId: string;
  authorKind: SuggestionAuthorKind;
  /** Display name of the author (e.g. "Assistant" or a person's name). */
  authorName: string;
  kind: SuggestionKind;
  target: SuggestionTarget;
  /** Prior value, rendered in the before→after diff (plain text). */
  before: string;
  /** Proposed value, rendered in the before→after diff (plain text). */
  after: string;
  status: SuggestionStatus;
  /**
   * The structured payload the editor bridge replays to apply the change.
   * Same shape as the former agent proposal payloads (e.g.
   * `{pageId, blockId, text}` for replace-text). Kept opaque here so the SDK
   * never needs to know how the CRDT is mutated.
   */
  payload: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

/** Fields accepted when creating a suggestion (id/timestamps/status defaulted). */
export interface SuggestionInput {
  id?: string;
  pageId: string;
  authorKind: SuggestionAuthorKind;
  authorName: string;
  kind: SuggestionKind;
  target: SuggestionTarget;
  before: string;
  after: string;
  payload: Record<string, unknown>;
}

/** Fields accepted when updating a suggestion (only status today). */
export interface SuggestionUpdate {
  status?: SuggestionStatus;
}

/** A threaded comment on a suggestion, or a standalone comment on a block. */
export interface StoredComment {
  id: string;
  pageId: string;
  /** The suggestion this comment belongs to (a review-thread comment). */
  suggestionId?: string | null;
  /** The block this comment is anchored to (a standalone block comment). */
  blockId?: string | null;
  authorName: string;
  /** Rich-text body (bold/italic/underline/links). */
  body: CommentRun[];
  /** Parent comment id, for nested replies within a thread. */
  parentId?: string | null;
  createdAt: string;
}

/** Fields accepted when creating a comment (id/timestamp defaulted). */
export interface CommentInput {
  id?: string;
  pageId: string;
  suggestionId?: string | null;
  blockId?: string | null;
  authorName: string;
  body: CommentRun[];
  parentId?: string | null;
}
