import {ClipboardCheck, Image as ImageIcon, Link2, MoreHorizontal, Palette} from 'lucide-react';
import {OWNER_PROPERTY_ID, VERIFICATION_PROPERTY_ID} from '@book.dev/sdk';
import {useNavigation, useTranslation} from '@/providers';
import {IconButton} from '@/components/ui/icon-button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {BacklinksControl, OwnerEditor, VerificationEditor, usePageProperties} from '@/components/PageProperties';
import {LastEditedBy} from '@/components/LastEditedBy';
import {usePageCover} from '@/lib/pageCover';
import {setPageCustomiseTarget} from '@/lib/pageCustomise';
import {CUSTOMISE_PANE_ID, LINKS_PANE_ID, REVIEW_PANE_ID} from '@/lib/homePage';
import {setReviewTarget} from '@/lib/reviewPane';
import {setLinksTarget} from '@/lib/linksPane';
import {hasPageCustomisation} from '@/components/appearance/PageCustomiseBody';
import {cn} from '@/lib/utils';

function HeaderOverflowMenu({
  includeBacklinks,
  includeCover,
  onBacklinks,
  onCover,
  className,
}: {
  includeBacklinks: boolean;
  includeCover: boolean;
  onBacklinks: () => void;
  onCover: () => void;
  className: string;
}) {
  const {t} = useTranslation();

  return (
    <span data-page-header-item="overflow" className={className}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <IconButton size="sm" aria-label={t('nav.more')} title={t('nav.more')}>
            <MoreHorizontal className="h-4 w-4" aria-hidden />
          </IconButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48" hideWhenDetached>
          {includeBacklinks && (
            <DropdownMenuItem onSelect={onBacklinks} className="gap-2">
              <Link2 className="h-4 w-4" aria-hidden />
              {t('links.open')}
            </DropdownMenuItem>
          )}
          {includeCover && (
            <DropdownMenuItem onSelect={onCover} className="gap-2">
              <ImageIcon className="h-4 w-4" aria-hidden />
              {t('page.addCover')}
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  );
}

/**
 * The cover-area control cluster, sitting above the title: page customisation
 * (accent / fonts → the side pane), owner, verification, backlinks count, and —
 * when the page has no cover yet — an "Add cover" affordance that deep-links into
 * the same Customise pane (the one home for cover). Notion-style, it is
 * hidden until the cover / header region is hovered (the `group/pagehead` wrapper
 * in BlockPageDocument), and stays visible while any of its menus is open. Owner
 * and verification still write the reserved property ids, so they round-trip as
 * database columns.
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

  const openBacklinks = () => {
    setLinksTarget(pageId);
    openInSplit(LINKS_PANE_ID);
  };

  return (
    <div
      data-page-header-controls
      className="@container flex h-8 flex-nowrap items-center gap-1 text-sm text-muted-foreground supports-[not(container-type:inline-size)]:flex-wrap print:hidden"
    >
      {/* The two pane entry points stay quietly visible at rest — an invisible
          cluster was the only way into Customise/Review for a long time, and
          hover-gating shuts out touch and keyboard users entirely. */}
      <span
        data-page-header-item="page-tools"
        className={cn(
          'flex items-center gap-1 opacity-50 transition-opacity duration-150',
          'group-hover/pagehead:opacity-100 focus-within:opacity-100',
          '[&:has([data-state=open])]:opacity-100',
        )}
      >
        <IconButton
          size="sm"
          aria-label={t('command.customisePage')}
          title={t('command.customisePage')}
          onClick={openCustomise}
          className={customised ? 'text-primary hover:text-primary' : undefined}
        >
          <Palette className="h-4 w-4" />
        </IconButton>
        <IconButton
          size="sm"
          aria-label={t('command.reviewSuggestions')}
          title={t('command.reviewSuggestions')}
          onClick={openReview}
        >
          <ClipboardCheck className="h-4 w-4" />
        </IconButton>
      </span>
      {/* Page metadata (owner / verification / backlinks / provenance / cover)
          reveals on header hover, focus, or an open menu (Notion-style) — at
          rest it read as clutter above every note's title. */}
      <span
        data-page-header-meta
        className={cn(
          'flex min-w-0 flex-1 flex-nowrap items-center gap-1 supports-[not(container-type:inline-size)]:flex-wrap',
          'opacity-0 pointer-events-none transition-opacity duration-150',
          'group-hover/pagehead:opacity-100 group-hover/pagehead:pointer-events-auto',
          'focus-within:opacity-100 focus-within:pointer-events-auto',
          '[&:has([data-state=open])]:opacity-100 [&:has([data-state=open])]:pointer-events-auto',
        )}
      >
        {/* Container-width priority (split panes included): the page entry
            points, owner, and verification stay put; below 40rem provenance
            becomes icon-only and Add cover moves to overflow; below 30rem the
            backlinks action joins it. */}
        <span className="mx-0.5 h-4 w-px shrink-0 bg-border" aria-hidden />
        <span data-page-header-item="owner" className="min-w-0 max-w-40 shrink @max-[30rem]:max-w-28">
          <OwnerEditor owner={owner} onChange={(v) => setProperty(OWNER_PROPERTY_ID, v)} />
        </span>
        <span data-page-header-item="verification" className="shrink-0">
          <VerificationEditor value={verification} onChange={(v) => setProperty(VERIFICATION_PROPERTY_ID, v)} />
        </span>
        <span data-page-header-item="backlinks" className="shrink-0 @max-[30rem]:hidden">
          <BacklinksControl pageId={pageId} onOpen={openBacklinks} />
        </span>
        <LastEditedBy
          pageId={pageId}
          className="@max-[40rem]:px-0.5"
          labelClassName="@max-[40rem]:sr-only"
        />
        {/* "Add cover" deep-links into the Customise pane rather than opening its
            own popover — the pane is the single home for cover + full width, so
            cover is only ever set from one surface. */}
        {!cover && (
          <button
            data-page-header-item="add-cover"
            type="button"
            onClick={openCustomise}
            className="ml-auto inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded px-1.5 py-1 text-sm text-muted-foreground transition-colors hover:bg-hover hover:text-foreground @max-[40rem]:hidden"
          >
            <ImageIcon className="h-3.5 w-3.5" />
            {t('page.addCover')}
          </button>
        )}
        {!cover && (
          <HeaderOverflowMenu
            includeBacklinks={false}
            includeCover
            onBacklinks={openBacklinks}
            onCover={openCustomise}
            className="ml-auto hidden shrink-0 @max-[40rem]:inline-flex @max-[30rem]:hidden"
          />
        )}
        <HeaderOverflowMenu
          includeBacklinks
          includeCover={!cover}
          onBacklinks={openBacklinks}
          onCover={openCustomise}
          className="ml-auto hidden shrink-0 @max-[30rem]:inline-flex"
        />
      </span>
    </div>
  );
}

export default PageHeaderControls;
