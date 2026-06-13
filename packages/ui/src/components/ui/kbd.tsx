import * as React from 'react';
import {cn} from '@/lib/utils';
import {formatShortcut, isMacPlatform, type ShortcutCombo} from '@/lib/shortcuts';
import {useModifierHeld} from '@/lib/useModifierHeld';
import {Tooltip, TooltipContent, TooltipProvider, TooltipTrigger} from '@/components/ui/tooltip';

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
 * A keyboard-shortcut hint, styled as a subtle key cap. Hidden at rest to keep
 * the UI quiet; it fades in only while ⌘/Ctrl is held (the space is reserved so
 * nothing shifts). Decorative — `aria-hidden` so assistive tech reads the
 * action label, not "Command K". The shortcut is also available on long hover
 * via {@link ShortcutTooltip}.
 */
export function Kbd({combo, className}: {combo: ShortcutCombo; className?: string}) {
  const mac = useIsMac();
  const held = useModifierHeld();
  return (
    <kbd
      aria-hidden="true"
      className={cn(
        'pointer-events-none inline-flex h-5 select-none items-center justify-center rounded border border-border/70 bg-muted px-1.5 font-sans text-[11px] font-medium leading-none text-muted-foreground transition-opacity duration-150',
        held ? 'opacity-100' : 'opacity-0',
        className,
      )}
    >
      {formatShortcut(combo, mac)}
    </kbd>
  );
}

/**
 * Wrap a control to reveal its keyboard shortcut in a tooltip on long hover —
 * the quiet way to discover a shortcut without a permanent badge. Self-contained
 * provider with a deliberate delay so it only appears on a real, lingering hover.
 */
export function ShortcutTooltip({
  combo,
  label,
  side = 'right',
  children,
}: {
  combo: ShortcutCombo;
  label?: string;
  side?: 'top' | 'right' | 'bottom' | 'left';
  children: React.ReactNode;
}) {
  const mac = useIsMac();
  return (
    <TooltipProvider delayDuration={600}>
      <Tooltip>
        <TooltipTrigger asChild>{children}</TooltipTrigger>
        <TooltipContent side={side} className="flex items-center gap-2">
          {label && <span>{label}</span>}
          <span className="font-semibold tracking-wide">{formatShortcut(combo, mac)}</span>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
