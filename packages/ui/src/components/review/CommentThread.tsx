import {useState} from 'react';
import {Trash2} from 'lucide-react';
import type {CommentInput, StoredComment} from '@open-book/sdk';
import type {TextRun} from '@/blockeditor/model';
import {RichTextEditor, RichTextView, runsHaveText} from '@/blockeditor/RichTextEditor';
import {Button} from '@/components/ui/button';
import {IconButton} from '@/components/ui/icon-button';

/**
 * A threaded rich-text discussion: the comments for a target (a suggestion's
 * review thread, or a block's standalone comments) plus a composer. Comment
 * bodies are rich text (bold/italic/underline/links) via the shared
 * {@link RichTextEditor}. Posting and deleting bubble up to the host so it can
 * persist through the data client and refetch.
 */
export interface CommentThreadProps {
  comments: StoredComment[];
  /** The new-comment skeleton minus body (pageId + suggestionId/blockId). */
  newComment: Omit<CommentInput, 'body' | 'authorName'>;
  authorName: string;
  onPost: (input: CommentInput) => Promise<void> | void;
  onDelete: (id: string) => Promise<void> | void;
  /** Compact spacing when nested inside a suggestion card. */
  compact?: boolean;
}

const fmtTime = (iso: string): string => {
  try {
    return new Date(iso).toLocaleString(undefined, {month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'});
  } catch {
    return '';
  }
};

export function CommentThread({comments, newComment, authorName, onPost, onDelete, compact}: CommentThreadProps) {
  const [draft, setDraft] = useState<TextRun[]>([]);
  const [seed, setSeed] = useState(0);
  const [posting, setPosting] = useState(false);

  const post = async (): Promise<void> => {
    if (!runsHaveText(draft) || posting) return;
    setPosting(true);
    try {
      await onPost({...newComment, authorName, body: draft});
      setDraft([]);
      setSeed((s) => s + 1); // re-seed the composer so it clears
    } finally {
      setPosting(false);
    }
  };

  return (
    <div className={compact ? 'flex flex-col gap-2' : 'flex flex-col gap-3'}>
      {comments.length > 0 && (
        <ul className="flex flex-col gap-2">
          {comments.map((c) => (
            <li key={c.id} className="group rounded-md border border-border bg-sheet-1 px-2.5 py-2">
              <div className="mb-1 flex items-center gap-2">
                <span className="text-xs font-medium">{c.authorName}</span>
                <span className="text-[11px] text-muted-foreground">{fmtTime(c.createdAt)}</span>
                <span className="flex-1" />
                <IconButton
                  size="sm"
                  className="opacity-0 transition-opacity group-hover:opacity-100"
                  aria-label="Delete comment"
                  title="Delete comment"
                  onClick={() => void onDelete(c.id)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </IconButton>
              </div>
              <RichTextView runs={c.body as TextRun[]} className="ob-comment-body text-sm" />
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-col gap-1.5">
        <RichTextEditor
          value={draft}
          onChange={setDraft}
          seed={seed}
          placeholder="Add a comment…"
          ariaLabel="Comment body"
        />
        <Button size="sm" className="self-end" disabled={!runsHaveText(draft) || posting} onClick={() => void post()}>
          Comment
        </Button>
      </div>
    </div>
  );
}

export default CommentThread;
