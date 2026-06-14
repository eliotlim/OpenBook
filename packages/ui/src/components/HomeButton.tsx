import {House} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {useNavigation, useTranslation} from '@/providers';
import {HOME_PAGE_ID} from '@/lib/homePage';
import {SIDEBAR_ACTIVE, SIDEBAR_HOVER} from '@/lib/sidebarStyles';
import {cn} from '@/lib/utils';

/** Sidebar launcher for the Home view — the workspace's new-tab page. */
export default function HomeButton() {
  const {currentPageId, selectPageInPane} = useNavigation();
  const {t} = useTranslation();
  const selected = currentPageId === HOME_PAGE_ID;
  return (
    <Button
      variant="ghost"
      className={cn(
        'flex h-7 grow justify-start gap-2 px-2 text-muted-foreground',
        SIDEBAR_HOVER,
        selected && SIDEBAR_ACTIVE,
      )}
      onClick={() => selectPageInPane(HOME_PAGE_ID, 'primary')}
    >
      <House className="h-4 w-4 shrink-0" />
      <span className="grow text-left">{t('nav.home')}</span>
    </Button>
  );
}
