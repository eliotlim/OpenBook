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
import {FileText} from 'lucide-react';
import {useHud, useNavigation, useTranslation} from '@/providers';
import {useAppCommands, type AppCommand, type CommandGroup as CmdGroup} from '@/components/useAppCommands';
import {formatShortcut} from '@/lib/shortcuts';
import {readPageIcon} from '@/lib/pageIcon';
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

  const groupHeading: Record<CmdGroup, string> = {
    create: t('command.groupCreate'),
    view: t('command.groupView'),
    navigation: t('command.groupNavigation'),
    app: t('command.groupApp'),
  };

  const byGroup = (group: CmdGroup): AppCommand[] => commands.filter((c) => c.group === group);

  return (
    <CommandDialog open={open} onOpenChange={setOpen} title={t('command.title')} description={t('command.placeholder')}>
      <CommandInput placeholder={t('command.placeholder')} />
      <CommandList>
        <CommandEmpty>{t('command.noResults')}</CommandEmpty>
        <CommandGroup heading={t('command.pages')}>
          {pages.map((page) => (
            <CommandItem
              key={page.id}
              value={`${displayName(page.name)} ${page.id}`}
              onSelect={() => run(() => selectPage(page.id))}
            >
              <span className="mr-2 inline-flex h-4 w-4 shrink-0 items-center justify-center text-center text-sm leading-none">
                {readPageIcon(page.id)}
              </span>
              <span className="truncate">{displayName(page.name)}</span>
              {page.id === currentPageId && (
                <span className="ml-auto text-xs text-muted-foreground">{t('command.current')}</span>
              )}
            </CommandItem>
          ))}
          {pages.length === 0 && (
            <CommandItem disabled value="__no_pages__">
              <FileText className="mr-2 h-4 w-4 text-muted-foreground" />
              <span className="text-muted-foreground">{t('command.noPages')}</span>
            </CommandItem>
          )}
        </CommandGroup>
        {GROUP_ORDER.map((group) => {
          const items = byGroup(group);
          if (items.length === 0) return null;
          return (
            <React.Fragment key={group}>
              <CommandSeparator />
              <CommandGroup heading={groupHeading[group]}>
                {items.map((cmd) => {
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
