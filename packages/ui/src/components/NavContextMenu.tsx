import {useSyncExternalStore} from 'react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {Button} from '@/components/ui/button';
import {DotsVerticalIcon} from '@radix-ui/react-icons';
import {useNavigation, useTranslation} from '@/providers';
import {pageDocActions, pageDocActionsVersion, subscribePageDocActions} from '@/lib/pageDocActions';
import {PageMenuItems} from '@/components/PageContextMenu';

/**
 * The page "…" actions menu. Targets {@link pageId} (defaults to the focused
 * page) so the split view's cluster can act on the right pane's page. Renders
 * the shared {@link PageMenuItems} `page` surface, so the click dropdown offers
 * the same actions as right-clicking the page body.
 */
export default function NavContextMenu({pageId}: {pageId?: string | null} = {}) {
  const {currentPageId: focusedPageId} = useNavigation();
  const {t} = useTranslation();
  const currentPageId = pageId !== undefined ? pageId : focusedPageId;

  // The open document registers its capabilities; subscribe so the trigger's
  // accessible name flips to "Page actions" once the page is ready to act on.
  useSyncExternalStore(subscribePageDocActions, pageDocActionsVersion, pageDocActionsVersion);
  const docActions = pageDocActions(currentPageId);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {/* The accessible name flips to "Page actions" once the open document
            has registered its capabilities — it doubles as the signal (for
            assistive tech and tests alike) that the page is ready to act on.
            Registration happens in post-mount effects, so the first client
            render still matches the server HTML. */}
        <Button
          variant="ghost"
          className="px-3 py-1"
          aria-label={docActions ? t('page.actions') : t('menu.options')}
        >
          <DotsVerticalIcon className="h-4 w-4"/>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-60">
        <PageMenuItems pageId={currentPageId} surface="page" menu="dropdown" />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
