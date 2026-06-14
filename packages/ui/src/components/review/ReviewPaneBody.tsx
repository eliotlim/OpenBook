import {useEffect, useRef, useState} from 'react';
import {MessageSquare} from 'lucide-react';
import {getReviewTarget, subscribeReviewPane} from '@/lib/reviewPane';
import {useNavigation, usePreferences} from '@/providers';
import {CommentThread} from './CommentThread';
import {SuggestionCard} from './SuggestionCard';
import {useReview} from './useReview';

/**
 * The Review side-pane body: lists a page's open suggestions (each with a
 * before→after diff, accept/reject, and its rich-text thread) and any
 * standalone block comments. Reads the target page from the `reviewPane`
 * bridge (set by the "Review" affordance / inline accept/reject / agent panel),
 * mirroring how the Customise pane reads `pageCustomise`. Mounted by SplitPane
 * for the {@link REVIEW_PANE_ID} pseudo-pane.
 */

/** The human author name for new suggestions/comments (profile → "You"). */
export function useAuthorName(): string {
  const {preferences} = usePreferences();
  const p = preferences.profile;
  return (p.displayName || p.name || 'You').trim() || 'You';
}

export function ReviewPaneBody() {
  const [target, setTarget] = useState(getReviewTarget());
  useEffect(() => subscribeReviewPane(() => setTarget(getReviewTarget())), []);

  const pageId = target.pageId;
  const {pageLabel} = useNavigation();
  const authorName = useAuthorName();
  const {
    suggestions,
    comments,
    loading,
    commentsForSuggestion,
    commentsForBlock,
    acceptSuggestion,
    rejectSuggestion,
    postComment,
    deleteComment,
  } = useReview(pageId);

  // Scroll a focused suggestion into view when the pane opens (re-fires on the
  // bridge's revision bump, so re-opening the same target re-focuses).
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!target.focusSuggestionId) return;
    const el = listRef.current?.querySelector(`[data-suggestion="${target.focusSuggestionId}"]`);
    el?.scrollIntoView({behavior: 'smooth', block: 'center'});
  }, [target.revision, target.focusSuggestionId, suggestions.length]);

  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const accept = async (s: (typeof suggestions)[number]): Promise<void> => {
    setBusyId(s.id);
    setError(null);
    try {
      await acceptSuggestion(s);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  const reject = async (s: (typeof suggestions)[number]): Promise<void> => {
    setBusyId(s.id);
    try {
      await rejectSuggestion(s);
    } finally {
      setBusyId(null);
    }
  };

  // Blocks that carry standalone comments (a flat thread per block).
  const blockIds = [...new Set(comments.filter((c) => !c.suggestionId && c.blockId).map((c) => c.blockId as string))];
  const open = suggestions.filter((s) => s.status === 'open');
  const resolved = suggestions.filter((s) => s.status !== 'open');

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 border-b border-border px-4 py-2.5">
        <p className="truncate text-sm font-semibold">Review</p>
        <p className="truncate text-xs text-muted-foreground">{pageId ? pageLabel(pageId) : 'No page selected'}</p>
      </div>

      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto p-4">
        {!pageId && <p className="text-xs text-muted-foreground">Open a page to review its suggestions and comments.</p>}

        {pageId && loading && suggestions.length === 0 && comments.length === 0 && (
          <p className="text-xs text-muted-foreground">Loading…</p>
        )}

        {pageId && !loading && open.length === 0 && resolved.length === 0 && blockIds.length === 0 && (
          <div className="flex flex-col items-center gap-2 py-8 text-center">
            <MessageSquare className="size-5 text-muted-foreground" aria-hidden />
            <p className="text-xs text-muted-foreground">No suggestions or comments yet.</p>
            <p className="max-w-[16rem] text-[11px] text-muted-foreground">
              Select text or a block in the document and choose “Suggest edit”, or ask the assistant to propose changes.
            </p>
          </div>
        )}

        {error && (
          <p className="mb-3 rounded-md border border-destructive/40 px-2.5 py-1.5 text-[11px] text-destructive">{error}</p>
        )}

        {open.length > 0 && (
          <section className="mb-4 flex flex-col gap-2">
            <h3 className="px-0.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Open suggestions · {open.length}
            </h3>
            {open.map((s) => (
              <SuggestionCard
                key={s.id}
                suggestion={s}
                comments={commentsForSuggestion(s.id)}
                authorName={authorName}
                focused={s.id === target.focusSuggestionId}
                busy={busyId === s.id}
                onAccept={accept}
                onReject={reject}
                onPostComment={postComment}
                onDeleteComment={deleteComment}
              />
            ))}
          </section>
        )}

        {pageId && blockIds.length > 0 && (
          <section className="mb-4 flex flex-col gap-3">
            <h3 className="px-0.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Block comments · {blockIds.length}
            </h3>
            {blockIds.map((blockId) => (
              <div
                key={blockId}
                data-block-thread={blockId}
                className="flex flex-col gap-2 rounded-lg border border-border bg-background/60 px-3 py-2.5"
              >
                <p className="text-[11px] text-muted-foreground">Comment thread</p>
                <CommentThread
                  compact
                  comments={commentsForBlock(blockId)}
                  newComment={{pageId, blockId, suggestionId: null}}
                  authorName={authorName}
                  onPost={postComment}
                  onDelete={deleteComment}
                />
              </div>
            ))}
          </section>
        )}

        {resolved.length > 0 && (
          <section className="flex flex-col gap-2">
            <h3 className="px-0.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Resolved · {resolved.length}
            </h3>
            {resolved.map((s) => (
              <SuggestionCard
                key={s.id}
                suggestion={s}
                comments={commentsForSuggestion(s.id)}
                authorName={authorName}
                busy={busyId === s.id}
                onAccept={accept}
                onReject={reject}
                onPostComment={postComment}
                onDeleteComment={deleteComment}
              />
            ))}
          </section>
        )}
      </div>
    </div>
  );
}

export default ReviewPaneBody;
