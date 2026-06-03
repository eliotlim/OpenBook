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
import {FileText, FlaskConical, Plus, Settings as SettingsIcon} from 'lucide-react';
import {seedSampleDocument} from '@open-book/sdk';
import {useHud, useNavigation} from '@/providers';
import {useData} from '@/data';

const displayName = (name: string | null): string =>
  name && name.trim().length > 0 ? name : 'Untitled';

export function CommandMenu() {
  const {hud, setHud} = useHud();
  const {pages, currentPageId, selectPage, createPage, reload} = useNavigation();
  const client = useData();
  const open = hud.commandPalette.open;

  // Seed a known-good reactive document (slider → expression → chart) and open
  // it. Idempotent: refreshes the existing sample page rather than duplicating.
  const insertSampleDocument = React.useCallback(async () => {
    const page = await seedSampleDocument(client);
    await reload();
    selectPage(page.id);
  }, [client, reload, selectPage]);

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
          <CommandItem
            value="insert sample document test seed reactive slider chart"
            onSelect={() => run(() => void insertSampleDocument())}
          >
            <FlaskConical className="mr-2 h-4 w-4 text-muted-foreground" />
            Insert sample document
          </CommandItem>
          <CommandItem
            value="open settings preferences"
            onSelect={() => run(() => setHud((draft) => {draft.settings.open = true; return draft;}))}
          >
            <SettingsIcon className="mr-2 h-4 w-4 text-muted-foreground" />
            Open settings
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
