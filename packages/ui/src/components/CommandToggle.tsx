import {useHud, useTranslation} from '@/providers';
import {Button} from '@/components/ui/button';
import {MagnifyingGlassIcon} from '@radix-ui/react-icons';
import {Kbd, ShortcutTooltip} from '@/components/ui/kbd';
import {SHORTCUTS} from '@/lib/shortcuts';
import {SIDEBAR_HOVER} from '@/lib/sidebarStyles';
import {cn} from '@/lib/utils';

/** Sidebar launcher for the command palette. The shortcut is quiet: it reveals
 *  inline while ⌘/Ctrl is held, and on long hover via the tooltip. */
export default function CommandToggle() {
  const {setHud} = useHud();
  const {t} = useTranslation();
  return (
    <ShortcutTooltip combo={SHORTCUTS.commandPalette} label={t('command.search')}>
      <Button
        variant="ghost"
        className={cn('flex h-7 grow justify-start gap-2 px-2 text-muted-foreground', SIDEBAR_HOVER)}
        onClick={() => {
          setHud((draft) => {
            draft.commandPalette.open = true;
            return draft;
          });
        }}
      >
        <MagnifyingGlassIcon className="h-4 w-4 shrink-0" />
        <span className="grow text-left">{t('command.search')}</span>
        <Kbd combo={SHORTCUTS.commandPalette} />
      </Button>
    </ShortcutTooltip>
  );
}
