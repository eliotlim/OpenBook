import {useState} from 'react';
import {Bot, Check, ChevronDown, ChevronRight, Copy, User, X} from 'lucide-react';
import type {CommentInput, StoredComment, StoredSuggestion} from '@book.dev/sdk';
import {Button} from '@/components/ui/button';
import {ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger} from '@/components/ui/context-menu';
import {MENU_DESTRUCTIVE_CLASS, MENU_WIDTH_MD} from '@/components/ui/menu-components';
import {copyText} from '@/lib/pageActions';
import {useTranslation} from '@/providers';
import {cn} from '@/lib/utils';
import {CommentThread} from './CommentThread';

/**
 * One suggestion in the Review pane: a before→after diff, accept / reject
 * controls, and its threaded rich-text discussion. Accepting applies the change
 * to the document (via the editor bridge, in one CRDT transaction) and resolves
 * the suggestion's status; rejecting just resolves it. Both flow up to the host.
 */
export interface SuggestionCardProps {
  suggestion: StoredSuggestion;
  comments: StoredComment[];
  authorName: string;
  /** Highlighted (e.g. focused from an inline affordance or the agent panel). */
  focused?: boolean;
  busy?: boolean;
  onAccept: (s: StoredSuggestion) => Promise<void> | void;
  onReject: (s: StoredSuggestion) => Promise<void> | void;
  onPostComment: (input: CommentInput) => Promise<void> | void;
  onDeleteComment: (id: string) => Promise<void> | void;
}

const KIND_LABEL: Record<StoredSuggestion['kind'], string> = {
  'replace-text': 'Replace text',
  'set-cell': 'Set cell',
  insert: 'Insert',
  move: 'Move',
  delete: 'Delete',
  'set-theme': 'Page theme',
  'table-op': 'Table structure',
};

export function SuggestionCard({
  suggestion: s,
  comments,
  authorName,
  focused,
  busy,
  onAccept,
  onReject,
  onPostComment,
  onDeleteComment,
}: SuggestionCardProps) {
  const {t} = useTranslation();
  const [showThread, setShowThread] = useState(comments.length > 0);
  const open = s.status === 'open';
  const Chevron = showThread ? ChevronDown : ChevronRight;
  // Prefer the proposed text; a deletion has no `after`, so copy the quoted
  // original instead. Structural suggestions fall back to their summary.
  const copyableText = s.after || s.before || (typeof s.payload.summary === 'string' ? s.payload.summary : '');

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          data-suggestion={s.id}
          data-suggestion-status={s.status}
          className={cn(
            'flex flex-col gap-2 rounded-lg border border-border bg-background/60 px-3 py-2.5',
            focused && 'ring-1 ring-ring',
            !open && 'opacity-70',
          )}
        >
          <div className="flex items-center gap-2">
            {s.authorKind === 'ai' ? (
              <Bot className="size-3.5 text-muted-foreground" aria-hidden />
            ) : (
              <User className="size-3.5 text-muted-foreground" aria-hidden />
            )}
            <span className="text-xs font-medium">{s.authorName}</span>
            <span className="rounded-full border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">
              {KIND_LABEL[s.kind]}
            </span>
            <span className="flex-1" />
            {!open && (
              <span className={cn('text-[11px] font-medium', s.status === 'accepted' ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground')}>
                {s.status === 'accepted' ? 'Accepted' : 'Rejected'}
              </span>
            )}
          </div>

          {/* before → after diff */}
          <div className="rounded-md border border-border bg-muted px-2.5 py-1.5 font-mono text-[11px] leading-relaxed">
            {s.before ? (
              <p className="break-words text-destructive/80">- {s.before}</p>
            ) : (
              <p className="break-words text-muted-foreground">- (nothing)</p>
            )}
            {s.after ? (
              <p className="break-words text-emerald-600 dark:text-emerald-400">+ {s.after}</p>
            ) : (
              <p className="break-words text-muted-foreground">+ (removed)</p>
            )}
          </div>

          {open && (
            <div className="flex items-center gap-2">
              <Button size="sm" data-suggestion-accept disabled={busy} onClick={() => void onAccept(s)}>
                <Check className="size-3.5" />
                Accept
              </Button>
              <Button size="sm" variant="outline" data-suggestion-reject disabled={busy} onClick={() => void onReject(s)}>
                <X className="size-3.5" />
                Reject
              </Button>
            </div>
          )}

          <button
            type="button"
            onClick={() => setShowThread((v) => !v)}
            className="inline-flex items-center gap-1 self-start text-[11px] text-muted-foreground transition-colors hover:text-foreground"
            aria-expanded={showThread}
          >
            <Chevron className="size-3" aria-hidden />
            {comments.length > 0 ? `${comments.length} comment${comments.length === 1 ? '' : 's'}` : 'Discuss'}
          </button>

          {showThread && (
            <CommentThread
              compact
              comments={comments}
              newComment={{pageId: s.pageId, suggestionId: s.id, blockId: null}}
              authorName={authorName}
              onPost={onPostComment}
              onDelete={onDeleteComment}
            />
          )}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className={MENU_WIDTH_MD}>
        {open && (
          <>
            <ContextMenuItem disabled={busy} onSelect={() => void onAccept(s)}>
              <Check className="mr-2 h-4 w-4" />
              {t('menu.acceptSuggestion')}
            </ContextMenuItem>
            <ContextMenuItem
              className={MENU_DESTRUCTIVE_CLASS}
              disabled={busy}
              onSelect={() => void onReject(s)}
            >
              <X className="mr-2 h-4 w-4" />
              {t('menu.rejectSuggestion')}
            </ContextMenuItem>
            <ContextMenuSeparator />
          </>
        )}
        <ContextMenuItem disabled={!copyableText} onSelect={() => void copyText(copyableText)}>
          <Copy className="mr-2 h-4 w-4" />
          {t('common.copy')}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

export default SuggestionCard;
