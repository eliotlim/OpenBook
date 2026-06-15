import {ClipboardCheck, Image as ImageIcon, Palette} from 'lucide-react';
import {OWNER_PROPERTY_ID, VERIFICATION_PROPERTY_ID} from '@open-book/sdk';
import {useNavigation, useTranslation} from '@/providers';
import {IconButton} from '@/components/ui/icon-button';
import {OwnerEditor, VerificationEditor, usePageProperties} from '@/components/PageProperties';
import {CoverPicker} from '@/components/PageCover';
import {usePageCover} from '@/lib/pageCover';
import {setPageCustomiseTarget} from '@/lib/pageCustomise';
import {CUSTOMISE_PANE_ID, REVIEW_PANE_ID} from '@/lib/homePage';
import {setReviewTarget} from '@/lib/reviewPane';
import {hasPageCustomisation} from '@/components/appearance/PageCustomiseBody';

/**
 * The cover-area control cluster, sitting above the title: page customisation
 * (accent / fonts → the side pane), owner, verification, and — when the page
 * has no cover yet — an "Add cover" affordance. Owner and verification still
 * write the reserved property ids, so they round-trip as database columns.
 */
export function PageHeaderControls({pageId}: {pageId: string}) {
  const {t} = useTranslation();
  const {openInSplit} = useNavigation();
  const {owner, verification, setProperty} = usePageProperties(pageId);
  const cover = usePageCover(pageId);
  const customised = hasPageCustomisation(pageId);

  const openCustomise = () => {
    setPageCustomiseTarget(pageId);
    openInSplit(CUSTOMISE_PANE_ID);
  };

  const openReview = () => {
    setReviewTarget(pageId);
    openInSplit(REVIEW_PANE_ID);
  };

  return (
    <div className="flex h-8 flex-wrap items-center gap-1 text-sm text-muted-foreground print:hidden">
      <IconButton
        size="sm"
        aria-label={t('appearance.pageTheme')}
        title={t('appearance.pageTheme')}
        onClick={openCustomise}
        className={customised ? 'text-primary hover:text-primary' : undefined}
      >
        <Palette className="h-4 w-4" />
      </IconButton>
      <IconButton size="sm" aria-label="Review suggestions" title="Review suggestions" onClick={openReview}>
        <ClipboardCheck className="h-4 w-4" />
      </IconButton>
      <span className="mx-0.5 h-4 w-px shrink-0 bg-border" aria-hidden />
      <OwnerEditor owner={owner} onChange={(v) => setProperty(OWNER_PROPERTY_ID, v)} />
      <VerificationEditor value={verification} onChange={(v) => setProperty(VERIFICATION_PROPERTY_ID, v)} />
      {!cover && (
        <CoverPicker pageId={pageId}>
          <button
            type="button"
            className="ml-auto inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-1 text-sm text-muted-foreground transition-colors hover:bg-hover hover:text-foreground"
          >
            <ImageIcon className="h-3.5 w-3.5" />
            {t('page.addCover')}
          </button>
        </CoverPicker>
      )}
    </div>
  );
}

export default PageHeaderControls;
