import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from '@/components/ui/command';
import React from 'react';
import type {PageMeta} from '@open-book/sdk';
import {FileText} from 'lucide-react';
import {useHud, useNavigation, useTranslation} from '@/providers';
import {useAppCommands, type AppCommand, type CommandGroup as CmdGroup} from '@/components/useAppCommands';
import {formatShortcut} from '@/lib/shortcuts';
import {readPageIcon} from '@/lib/pageIcon';
import {PageIcon} from '@/components/PageIcon';
import {readFavorites, subscribeFavorites} from '@/lib/favorites';
import {readRecents, subscribeRecents} from '@/lib/recents';
import {featureShown, isAiFeature, readFeatureVisibility} from '@/lib/aiFeatures';
import {t} from '@/i18n';

const displayName = (name: string | null): string =>
  name && name.trim().length > 0 ? name : t('common.untitled');

/** Command groups in display order, with their localised headings. */
const GROUP_ORDER: CmdGroup[] = ['create', 'view', 'navigation', 'app'];

export function CommandMenu() {
  const {hud, setHud} = useHud();
  const {pages, currentPageId, selectPage} = useNavigation();
  const {t} = useTranslation();
  const commands = useAppCommands();
  const open = hud.commandPalette.open;

  // Controlled query so AI features set to "enabled" surface only while the
  // user is searching (disabled ones never; recommended ones always).
  const [search, setSearch] = React.useState('');
  React.useEffect(() => {
    if (!open) setSearch('');
  }, [open]);
  const searching = search.trim().length > 0;
  const visibleCommands = React.useMemo(
    () => commands.filter((c) => !isAiFeature(c.id) || featureShown(readFeatureVisibility(c.id), searching)),
    [commands, searching],
  );

  // Favourites + recents live in localStorage; bump on change so the palette
  // reflects a pin/visit made while it's open.
  const [version, setVersion] = React.useState(0);
  React.useEffect(() => subscribeFavorites(() => setVersion((v) => v + 1)), []);
  React.useEffect(() => subscribeRecents(() => setVersion((v) => v + 1)), []);

  const setOpen = React.useCallback(
    (open: boolean) => {
      setHud((draft) => {
        draft.commandPalette.open = open;
        return draft;
      });
    },
    [setHud],
  );

  const run = React.useCallback(
    (action: () => void) => {
      action();
      setOpen(false);
    },
    [setOpen],
  );

  const byId = React.useMemo(() => new Map(pages.map((p) => [p.id, p] as const)), [pages]);
  // Resolve stored id lists to live pages (dropping any since deleted).
  const resolve = React.useCallback(
    (ids: string[]): PageMeta[] => ids.map((id) => byId.get(id)).filter((p): p is PageMeta => !!p),
    [byId],
  );
  // `version` participates so a pin/visit re-derives these lists.
  const favorites = React.useMemo(() => {
    void version;
    return resolve(readFavorites());
  }, [resolve, version]);
  const recents = React.useMemo(() => {
    void version;
    return resolve(readRecents())
      .filter((p) => p.id !== currentPageId)
      .slice(0, 6);
  }, [resolve, version, currentPageId]);

  const groupHeading: Record<CmdGroup, string> = {
    create: t('command.groupCreate'),
    view: t('command.groupView'),
    navigation: t('command.groupNavigation'),
    app: t('command.groupApp'),
  };

  const pageItem = (page: PageMeta, scope: string) => (
    <CommandItem
      key={`${scope}:${page.id}`}
      value={`${displayName(page.name)} ${page.id} ${scope}`}
      onSelect={() => run(() => selectPage(page.id))}
    >
      <PageIcon
        value={readPageIcon(page.id)}
        className="mr-2 inline-flex h-4 w-4 shrink-0 items-center justify-center text-center text-sm leading-none"
      />
      <span className="truncate">{displayName(page.name)}</span>
      {page.id === currentPageId && (
        <span className="ml-auto text-xs text-muted-foreground">{t('command.current')}</span>
      )}
    </CommandItem>
  );

  return (
    <CommandDialog open={open} onOpenChange={setOpen} title={t('command.title')} description={t('command.placeholder')}>
      <CommandInput placeholder={t('command.placeholder')} value={search} onValueChange={setSearch} />
      <CommandList>
        <CommandEmpty>{t('command.noResults')}</CommandEmpty>
        {favorites.length > 0 && (
          <CommandGroup heading={t('command.groupFavorites')}>
            {favorites.map((page) => pageItem(page, 'favorite'))}
          </CommandGroup>
        )}
        {recents.length > 0 && (
          <CommandGroup heading={t('command.groupRecent')}>
            {recents.map((page) => pageItem(page, 'recent'))}
          </CommandGroup>
        )}
        <CommandGroup heading={t('command.pages')}>
          {pages.map((page) => pageItem(page, 'page'))}
          {pages.length === 0 && (
            <CommandItem disabled value="__no_pages__">
              <FileText className="mr-2 h-4 w-4 text-muted-foreground" />
              <span className="text-muted-foreground">{t('command.noPages')}</span>
            </CommandItem>
          )}
        </CommandGroup>
        {GROUP_ORDER.map((group) => {
          const items = visibleCommands.filter((c) => c.group === group);
          if (items.length === 0) return null;
          return (
            <React.Fragment key={group}>
              <CommandSeparator />
              <CommandGroup heading={groupHeading[group]}>
                {items.map((cmd: AppCommand) => {
                  const Icon = cmd.icon;
                  return (
                    <CommandItem
                      key={cmd.id}
                      value={`${cmd.title} ${cmd.keywords ?? ''}`}
                      disabled={cmd.disabled}
                      onSelect={() => run(cmd.run)}
                    >
                      <Icon className="mr-2 h-4 w-4 text-muted-foreground" />
                      <span className="truncate">{cmd.title}</span>
                      {cmd.shortcut && <CommandShortcut>{formatShortcut(cmd.shortcut)}</CommandShortcut>}
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            </React.Fragment>
          );
        })}
      </CommandList>
    </CommandDialog>
  );
}
