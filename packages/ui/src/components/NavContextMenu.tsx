import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {Button} from '@/components/ui/button';
import {DotsVerticalIcon} from '@radix-ui/react-icons';
import {AppWindow, Columns2, ExternalLink, Link2, Settings as SettingsIcon, Star, StarOff, Trash2} from 'lucide-react';
import {useHud, useNavigation, useTranslation} from '@/providers';
import {copyPageLink} from '@/lib/pageActions';
import {isFavorite, toggleFavorite} from '@/lib/favorites';
import {formatShortcut, SHORTCUTS} from '@/lib/shortcuts';

export default function NavContextMenu() {
  const {hud, setHud} = useHud();
  const {openInNew, openInSplit, currentPageId} = useNavigation();
  const {t} = useTranslation();
  const fav = !!currentPageId && isFavorite(currentPageId);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          className="px-3 py-1"
        >
          <DotsVerticalIcon className="h-4 w-4"/>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-60">
        <DropdownMenuLabel>{t('menu.viewOptions')}</DropdownMenuLabel>
        {/* A real menu item (role=menuitemcheckbox), not a Switch inside a Label:
            Radix only routes pointer/keyboard activation to its menu items, so a
            bare control nested in a label never toggled (dead on click in the
            desktop WKWebView especially). `onSelect` preventDefault keeps the
            menu open so you can see the layout change. */}
        <DropdownMenuCheckboxItem
          checked={hud.viewMode.fullWidth}
          onCheckedChange={(checked) =>
            setHud({...hud, viewMode: {...hud.viewMode, fullWidth: checked}})
          }
          onSelect={(e) => e.preventDefault()}
        >
          {t('menu.fullWidth')}
          <DropdownMenuShortcut>{formatShortcut(SHORTCUTS.toggleFullWidth)}</DropdownMenuShortcut>
        </DropdownMenuCheckboxItem>
        <DropdownMenuSeparator/>
        <DropdownMenuItem
          disabled={!currentPageId}
          onClick={() => currentPageId && toggleFavorite(currentPageId)}
        >
          {fav ? <StarOff className="mr-2 h-4 w-4" /> : <Star className="mr-2 h-4 w-4" />}
          {fav ? t('menu.unfavorite') : t('menu.favorite')}
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={!currentPageId}
          onClick={() => currentPageId && openInNew(currentPageId, 'tab')}
        >
          <ExternalLink className="mr-2 h-4 w-4" />
          {t('menu.openTab')}
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={!currentPageId}
          onClick={() => currentPageId && openInNew(currentPageId, 'window')}
        >
          <AppWindow className="mr-2 h-4 w-4" />
          {t('menu.openWindow')}
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={!currentPageId}
          onClick={() => currentPageId && openInSplit(currentPageId)}
        >
          <Columns2 className="mr-2 h-4 w-4" />
          {t('menu.openSplit')}
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={!currentPageId}
          onClick={() => currentPageId && void copyPageLink(currentPageId)}
        >
          <Link2 className="mr-2 h-4 w-4" />
          {t('menu.copyLink')}
        </DropdownMenuItem>
        <DropdownMenuSeparator/>
        <DropdownMenuItem onClick={() => setHud((draft) => {draft.settings.open = true; return draft;})}>
          <SettingsIcon className="mr-2 h-4 w-4" />
          {t('common.settings')}
          <DropdownMenuShortcut>{formatShortcut(SHORTCUTS.openSettings)}</DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setHud((draft) => {draft.trash.open = true; return draft;})}>
          <Trash2 className="mr-2 h-4 w-4" />
          {t('nav.trash')}
          <DropdownMenuShortcut>{formatShortcut(SHORTCUTS.openTrash)}</DropdownMenuShortcut>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
