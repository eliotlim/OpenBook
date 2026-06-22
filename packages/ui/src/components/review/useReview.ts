import {useCallback, useEffect, useState} from 'react';
import type {CommentInput, StoredComment, StoredSuggestion} from '@book.dev/sdk';
import {useData} from '@/data';
import {aiBridge} from '@/lib/aiBridge';
import {pingReviewData, subscribeReviewData} from '@/lib/reviewPane';

/**
 * Loads and mutates a page's review layer (suggestions + comments) and keeps it
 * in sync across surfaces. Suggestions/comments have no SSE channel, so every
 * mutation pings a module-level signal (`pingReviewData`) that all `useReview`
 * consumers listen to and refetch from — the inline indicators, the Review
 * pane, and the agent panel stay consistent without a live stream.
 *
 * Accepting a suggestion applies the change through the editor bridge (one CRDT
 * transaction when the editor is mounted; a savePage fallback otherwise), then
 * marks it accepted. Rejecting only marks it rejected.
 */
export interface UseReview {
  suggestions: StoredSuggestion[];
  comments: StoredComment[];
  loading: boolean;
  /** Comments anchored to a specific suggestion (its review thread). */
  commentsForSuggestion: (suggestionId: string) => StoredComment[];
  /** Standalone comments anchored to a block (no suggestion). */
  commentsForBlock: (blockId: string) => StoredComment[];
  acceptSuggestion: (s: StoredSuggestion) => Promise<void>;
  rejectSuggestion: (s: StoredSuggestion) => Promise<void>;
  postComment: (input: CommentInput) => Promise<void>;
  deleteComment: (id: string) => Promise<void>;
  reload: () => Promise<void>;
}

export function useReview(pageId: string | null): UseReview {
  const client = useData();
  const [suggestions, setSuggestions] = useState<StoredSuggestion[]>([]);
  const [comments, setComments] = useState<StoredComment[]>([]);
  const [loading, setLoading] = useState(false);

  const reload = useCallback(async (): Promise<void> => {
    if (!pageId) {
      setSuggestions([]);
      setComments([]);
      return;
    }
    setLoading(true);
    try {
      const [s, c] = await Promise.all([client.listSuggestions(pageId), client.listComments(pageId)]);
      setSuggestions(s);
      setComments(c);
    } catch {
      // a fresh page with no review rows just shows nothing
    } finally {
      setLoading(false);
    }
  }, [client, pageId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Refetch whenever any surface reports a mutation (no SSE for this layer).
  useEffect(() => subscribeReviewData(() => void reload()), [reload]);

  const commentsForSuggestion = useCallback(
    (suggestionId: string) => comments.filter((c) => c.suggestionId === suggestionId),
    [comments],
  );
  const commentsForBlock = useCallback(
    (blockId: string) => comments.filter((c) => !c.suggestionId && c.blockId === blockId),
    [comments],
  );

  const acceptSuggestion = useCallback(
    async (s: StoredSuggestion): Promise<void> => {
      // Apply first; only resolve the status if the change actually landed.
      await aiBridge.applySuggestion(s);
      await client.updateSuggestion(s.id, {status: 'accepted'});
      pingReviewData();
    },
    [client],
  );

  const rejectSuggestion = useCallback(
    async (s: StoredSuggestion): Promise<void> => {
      await client.updateSuggestion(s.id, {status: 'rejected'});
      pingReviewData();
    },
    [client],
  );

  const postComment = useCallback(
    async (input: CommentInput): Promise<void> => {
      await client.createComment(input);
      pingReviewData();
    },
    [client],
  );

  const deleteComment = useCallback(
    async (id: string): Promise<void> => {
      await client.deleteComment(id);
      pingReviewData();
    },
    [client],
  );

  return {
    suggestions,
    comments,
    loading,
    commentsForSuggestion,
    commentsForBlock,
    acceptSuggestion,
    rejectSuggestion,
    postComment,
    deleteComment,
    reload,
  };
}
