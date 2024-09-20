import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command';
import React from 'react';
import {useHud} from '@/providers';

export function CommandMenu() {
  const {hud, setHud} = useHud();
  const open = hud.commandPalette.open;
  const setOpen = React.useCallback((open: boolean) => {
    setHud(draft => {draft.commandPalette.open = open; return draft;});
  }, [setHud]);

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandInput placeholder="Type a command or search..." />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>
        <CommandGroup heading="Suggestions">
          <CommandItem>Calendar</CommandItem>
          <CommandItem>Search Emoji</CommandItem>
          <CommandItem>Calculator</CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
