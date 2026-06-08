import * as React from 'react';
import {cn} from '@/lib/utils';
import {formatShortcut, isMacPlatform, type ShortcutCombo} from '@/lib/shortcuts';

/**
 * Platform flag for rendering. Initialised to `false` (Ctrl-style) so the first
 * client render matches the server HTML, then adopts the real platform after
 * mount — surfaces shown during SSR (the sidebar search/settings buttons) can
 * use this without a hydration mismatch. See the SSR-hydration note in the docs.
 */
export function useIsMac(): boolean {
  const [mac, setMac] = React.useState(false);
  React.useEffect(() => setMac(isMacPlatform), []);
  return mac;
}

/**
 * A keyboard-shortcut hint, styled as a subtle key cap. Decorative — marked
 * `aria-hidden` so assistive tech reads the action label, not "Command K".
 */
export function Kbd({combo, className}: {combo: ShortcutCombo; className?: string}) {
  const mac = useIsMac();
  return (
    <kbd
      aria-hidden="true"
      className={cn(
        'pointer-events-none inline-flex h-5 select-none items-center justify-center rounded border border-border/70 bg-muted px-1.5 font-sans text-[11px] font-medium leading-none text-muted-foreground',
        className,
      )}
    >
      {formatShortcut(combo, mac)}
    </kbd>
  );
}
