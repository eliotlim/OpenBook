import {useEffect, useState} from 'react';
import {createPortal} from 'react-dom';
import {MessageSquare, PencilLine} from 'lucide-react';
import {useNavigation} from '@/providers';
import {REVIEW_PANE_ID} from '@/lib/homePage';
import {setReviewTarget} from '@/lib/reviewPane';
import {useReview} from './useReview';

/**
 * Inline review affordances: for every block that has an OPEN suggestion or a
 * standalone comment, this adds a quiet highlight (a left border accent via the
 * `ob-block-reviewed` class) to the block's `[data-block-row]` element and
 * floats a small clickable indicator at the row's right edge. Clicking it opens
 * the Review pane focused on that block/suggestion.
 *
 * The block editor renders its own React root outside the app providers, so we
 * cannot decorate from within it; instead this component (rendered from
 * `BlockPageDocument`, inside providers) reaches into the editor's DOM by id —
 * the robust integration point, since block ids are stable across re-renders.
 * Highlighting and the indicator are presentation-only; nothing mutates the
 * CRDT, so concurrent edits are unaffected.
 */
export function BlockReviewMarkers({pageId, containerRef}: {pageId: string; containerRef: React.RefObject<HTMLElement | null>}) {
  const {openInSplit} = useNavigation();
  const {suggestions, comments} = useReview(pageId);

  // Block id → {suggestionId?, comments} activity, derived from open
  // suggestions + standalone block comments.
  const activity = new Map<string, {suggestionId?: string; comments: number}>();
  for (const s of suggestions) {
    if (s.status !== 'open') continue;
    const blockId = s.target.blockId;
    if (!blockId) continue;
    const prev = activity.get(blockId) ?? {comments: 0};
    activity.set(blockId, {...prev, suggestionId: s.id});
  }
  for (const c of comments) {
    if (c.suggestionId || !c.blockId) continue;
    const prev = activity.get(c.blockId) ?? {comments: 0};
    activity.set(c.blockId, {...prev, comments: prev.comments + 1});
  }

  // Resolve each active block id to its row element and track positions so the
  // indicators stay aligned on layout changes (typing, window resize, scroll).
  const [rows, setRows] = useState<Array<{blockId: string; top: number; suggestionId?: string; comments: number}>>([]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      setRows([]);
      return;
    }
    const measure = (): void => {
      const cRect = container.getBoundingClientRect();
      const next: Array<{blockId: string; top: number; suggestionId?: string; comments: number}> = [];
      for (const [blockId, info] of activity) {
        const el = container.querySelector<HTMLElement>(`[data-block-row="${CSS.escape(blockId)}"]`);
        if (!el) continue;
        el.classList.add('ob-block-reviewed');
        const r = el.getBoundingClientRect();
        next.push({blockId, top: r.top - cRect.top, suggestionId: info.suggestionId, comments: info.comments});
      }
      // Drop the highlight class from rows that no longer have activity.
      container.querySelectorAll('.ob-block-reviewed').forEach((el) => {
        const id = (el as HTMLElement).dataset.blockRow;
        if (id && !activity.has(id)) el.classList.remove('ob-block-reviewed');
      });
      setRows(next);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(container);
    window.addEventListener('resize', measure);
    // Re-measure shortly after, once the editor's async layout settles.
    const t = setTimeout(measure, 120);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', measure);
      clearTimeout(t);
    };
    // `activity` is derived fresh each render; depend on its serialised shape so
    // the effect re-measures whenever the set of reviewed blocks changes.
  }, [pageId, containerRef, JSON.stringify([...activity.entries()])]);

  const container = containerRef.current;
  if (!container || rows.length === 0) return null;

  return createPortal(
    <>
      {rows.map((row) => (
        <button
          key={row.blockId}
          type="button"
          data-review-indicator={row.blockId}
          title={row.suggestionId ? 'Open suggestion' : 'View comments'}
          aria-label={row.suggestionId ? 'Open suggestion' : 'View comments'}
          onClick={() => {
            setReviewTarget(pageId, {suggestionId: row.suggestionId ?? null, blockId: row.suggestionId ? null : row.blockId});
            openInSplit(REVIEW_PANE_ID);
          }}
          className="ob-review-indicator absolute right-0 z-10 inline-flex items-center gap-0.5 rounded-md border border-border bg-background/90 px-1.5 py-0.5 text-[11px] text-muted-foreground shadow-sm transition-colors hover:bg-accent hover:text-foreground"
          style={{top: row.top}}
        >
          {row.suggestionId ? <PencilLine className="size-3" aria-hidden /> : <MessageSquare className="size-3" aria-hidden />}
          {row.comments > 0 && <span>{row.comments}</span>}
        </button>
      ))}
    </>,
    container,
  );
}

export default BlockReviewMarkers;
