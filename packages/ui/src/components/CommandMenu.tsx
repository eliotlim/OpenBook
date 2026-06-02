import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@/components/ui/command';
import React from 'react';
import {FileText, Plus} from 'lucide-react';
import {useHud, useNavigation} from '@/providers';

const displayName = (name: string | null): string =>
  name && name.trim().length > 0 ? name : 'Untitled';

export function CommandMenu() {
  const {hud, setHud} = useHud();
  const {pages, currentPageId, selectPage, createPage} = useNavigation();
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

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandInput placeholder="Search pages or run a command…" />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>
        <CommandGroup heading="Pages">
          {pages.map((page) => (
            <CommandItem
              key={page.id}
              value={`${displayName(page.name)} ${page.id}`}
              onSelect={() => run(() => selectPage(page.id))}
            >
              <FileText className="mr-2 h-4 w-4 text-muted-foreground" />
              <span className="truncate">{displayName(page.name)}</span>
              {page.id === currentPageId && (
                <span className="ml-auto text-xs text-muted-foreground">current</span>
              )}
            </CommandItem>
          ))}
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading="Actions">
          <CommandItem value="new page create" onSelect={() => run(() => void createPage())}>
            <Plus className="mr-2 h-4 w-4 text-muted-foreground" />
            Create new page
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
