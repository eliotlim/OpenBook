/**
 * A tiny in-memory bridge for human-authored suggestions + block comments from
 * inside the (provider-less) block editor. The editor's row menu calls
 * `requestSuggestEdit` / `requestComment` with the target block; a host
 * portaled from `BlockPageDocument` (which DOES sit inside the app providers /
 * data client — the editor's own React root does not) renders the composer and
 * persists through the data client. Mirrors the `kitPanel` / `aiBridge`
 * singleton pattern.
 */

export interface SuggestEditRequest {
  pageId: string;
  blockId: string;
  /** The block's current plain text (the suggestion's "before"). */
  before: string;
}

export interface CommentRequest {
  pageId: string;
  blockId: string;
}

type SuggestHandler = (req: SuggestEditRequest) => void;
type CommentHandler = (req: CommentRequest) => void;

let suggestHandler: SuggestHandler | null = null;
let commentHandler: CommentHandler | null = null;

/** The host (BlockPageDocument) registers how to open each composer. */
export const registerSuggestHost = (handlers: {
  onSuggestEdit: SuggestHandler;
  onComment: CommentHandler;
}): (() => void) => {
  suggestHandler = handlers.onSuggestEdit;
  commentHandler = handlers.onComment;
  return () => {
    suggestHandler = null;
    commentHandler = null;
  };
};

/** Whether a host is mounted (gate the menu items so they don't no-op). */
export const suggestHostReady = (): boolean => suggestHandler !== null;

/** Open the "Suggest edit" composer for a block (from the editor row menu). */
export const requestSuggestEdit = (req: SuggestEditRequest): void => suggestHandler?.(req);

/** Open the comment composer/thread for a block (from the editor row menu). */
export const requestComment = (req: CommentRequest): void => commentHandler?.(req);
