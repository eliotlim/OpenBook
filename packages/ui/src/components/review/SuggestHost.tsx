import {useEffect, useState} from 'react';
import type {SuggestionInput} from '@book.dev/sdk';
import {Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle} from '@/components/ui/dialog';
import {Button} from '@/components/ui/button';
import {useData} from '@/data';
import {useNavigation} from '@/providers';
import {REVIEW_PANE_ID} from '@/lib/homePage';
import {pingReviewData, setReviewTarget} from '@/lib/reviewPane';
import {registerSuggestHost, type SuggestEditRequest} from '@/lib/suggestBridge';
import {useAuthorName} from './ReviewPaneBody';

/**
 * Bridges the (provider-less) block editor's inline "Suggest edit" / "Comment"
 * affordances to the app's data client + Review pane. Rendered from
 * `BlockPageDocument` (which sits inside the providers the editor's own React
 * root does not), it registers handlers on the `suggestBridge` singleton:
 *
 *  - Suggest edit → a small composer dialog; submitting persists a human
 *    `replace-text` suggestion (same model as an AI one) targeting the block,
 *    then opens the Review pane focused on it.
 *  - Comment → opens the Review pane focused on the block's comment thread.
 */
export function SuggestHost() {
  const client = useData();
  const {openInSplit} = useNavigation();
  const authorName = useAuthorName();
  const [editReq, setEditReq] = useState<SuggestEditRequest | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(
    () =>
      registerSuggestHost({
        onSuggestEdit: (req) => {
          setEditReq(req);
          setDraft(req.before);
        },
        onComment: (req) => {
          setReviewTarget(req.pageId, {blockId: req.blockId});
          openInSplit(REVIEW_PANE_ID);
        },
      }),
    [openInSplit],
  );

  const submit = async (): Promise<void> => {
    if (!editReq || busy) return;
    setBusy(true);
    try {
      const input: SuggestionInput = {
        pageId: editReq.pageId,
        authorKind: 'human',
        authorName,
        kind: 'replace-text',
        target: {blockId: editReq.blockId},
        before: editReq.before,
        after: draft,
        // Same payload shape the AI bridge replays: applyKind drives the CRDT
        // mutation; summary feeds the diff/agent cards.
        payload: {
          applyKind: 'update_block',
          pageId: editReq.pageId,
          blockId: editReq.blockId,
          text: draft,
          // The block text at suggestion time → the merge base, so accepting two
          // edits to the same block keeps both rather than clobbering one.
          before: editReq.before,
          summary: 'Suggested edit',
        },
      };
      const created = await client.createSuggestion(input);
      pingReviewData();
      setEditReq(null);
      setReviewTarget(created.pageId, {suggestionId: created.id});
      openInSplit(REVIEW_PANE_ID);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={editReq !== null} onOpenChange={(o) => !o && setEditReq(null)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Suggest an edit</DialogTitle>
          <DialogDescription>Propose new text for this block. It is saved for review, not applied.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-foreground/80">Current</span>
            <p className="rounded-md border border-border bg-sheet-1 px-2.5 py-1.5 text-sm text-muted-foreground">
              {editReq?.before || '(empty)'}
            </p>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-foreground/80">Suggested</span>
            <textarea
              autoFocus
              rows={4}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              className="w-full resize-none rounded-md border border-border bg-card px-2.5 py-1.5 text-sm outline-hidden focus:border-ring"
              aria-label="Suggested text"
            />
          </label>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setEditReq(null)}>
            Cancel
          </Button>
          <Button disabled={busy || draft === editReq?.before} onClick={() => void submit()}>
            Suggest
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default SuggestHost;
