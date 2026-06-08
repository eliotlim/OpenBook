import React from 'react';
import {useHud} from '@/providers';
import {useAppCommands} from '@/components/useAppCommands';
import {matchShortcut, SHORTCUTS} from '@/lib/shortcuts';

/**
 * Binds the app's global keyboard shortcuts. Every combo uses a modifier (⌘/Ctrl)
 * so it fires even while the editor or a text field has focus without stealing
 * ordinary typing. The shortcuts come from the same {@link useAppCommands}
 * registry the command palette renders, so a key and its menu entry never drift.
 *
 * Renders nothing — it's a behavior, mounted once in the layout.
 */
export default function GlobalShortcuts() {
  const {setHud} = useHud();
  const commands = useAppCommands();
  // Read the latest commands inside the listener without re-binding it each render
  // (commands change as nav/theme state changes, e.g. Back enabling).
  const commandsRef = React.useRef(commands);
  commandsRef.current = commands;

  React.useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // ⌘K toggles the command palette (palette visibility isn't a registry
      // command, so it's owned here).
      if (matchShortcut(e, SHORTCUTS.commandPalette)) {
        e.preventDefault();
        setHud((draft) => {
          draft.commandPalette.open = !draft.commandPalette.open;
          return draft;
        });
        return;
      }
      for (const cmd of commandsRef.current) {
        if (cmd.shortcut && matchShortcut(e, cmd.shortcut)) {
          // Claim the combo even when disabled, so e.g. ⌘[ never falls through
          // to the browser's own Back while we own that key.
          e.preventDefault();
          if (!cmd.disabled) cmd.run();
          return;
        }
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [setHud]);

  return null;
}
