/**
 * LX-2: the export-time "Include your books" dialog. Shown ONLY when the
 * interactive-HTML export set contains `openbook.ledger/*` blocks:
 *
 *  - Exporter can read the books (`canInclude`): a clearly visible toggle,
 *    DEFAULT ON (the owner decided owner-initiated exports carry the records by
 *    default), with a plain warning that the file will contain financial
 *    records. Unchecking swaps the warning for an "excluded" notice.
 *  - Exporter cannot read the books (guest/viewer, or no seeded ledger): no
 *    toggle to flip — just the notice that the books are excluded and ledger
 *    blocks export as placeholders. Never an error, never an escalation: the
 *    dialog only ever REPORTS what the caller's own read paths allow.
 *
 * Presentation-only: the actual capture (and its authorization) lives in the
 * SDK's `gatherLedgerExportSection`, driven by the export pipeline.
 */
import {useEffect, useState} from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {Button} from '@/components/ui/button';
import {useTranslation} from '@/providers';

/** What the dialog resolves to: proceed with/without records, or cancel. */
export type ExportBooksChoice = {includeBooks: boolean} | null;

export function ExportBooksDialog({
  open,
  canInclude,
  onClose,
}: {
  open: boolean;
  /** Whether the exporting principal can read the ledger (probe + capture both
   *  run through their own client; this only selects the dialog's mode). */
  canInclude: boolean;
  onClose: (choice: ExportBooksChoice) => void;
}) {
  const {t} = useTranslation();
  // Default ON whenever records CAN be included — the owner's decision.
  const [include, setInclude] = useState(canInclude);
  useEffect(() => {
    if (open) setInclude(canInclude);
  }, [open, canInclude]);

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose(null)}>
      {open && (
        <DialogContent className="sm:max-w-[440px]" data-testid="export-books-dialog">
          <DialogHeader>
            <DialogTitle>{t('page.exportBooksTitle')}</DialogTitle>
            {canInclude && include && (
              <DialogDescription data-testid="export-books-warning">
                {t('page.exportBooksWarning')}
              </DialogDescription>
            )}
          </DialogHeader>
          {canInclude ? (
            <label className="flex cursor-pointer items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4 accent-primary"
                checked={include}
                onChange={(e) => setInclude(e.target.checked)}
                data-testid="export-books-toggle"
              />
              <span className="font-medium">{t('page.exportBooksInclude')}</span>
            </label>
          ) : null}
          {(!canInclude || !include) && (
            <p className="text-sm text-muted-foreground" data-testid="export-books-excluded">
              {canInclude ? t('page.exportBooksExcluded') : t('page.exportBooksUnavailable')}
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => onClose(null)}>
              {t('common.cancel')}
            </Button>
            <Button onClick={() => onClose({includeBooks: canInclude && include})} data-testid="export-books-confirm">
              {t('page.exportBooksConfirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  );
}
