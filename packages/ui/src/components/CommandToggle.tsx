import {useHud, useTranslation} from '@/providers';
import {Button} from '@/components/ui/button';
import {MagnifyingGlassIcon} from '@radix-ui/react-icons';
import {Kbd} from '@/components/ui/kbd';
import {SHORTCUTS} from '@/lib/shortcuts';

/** Sidebar launcher for the command palette, with its keyboard hint inline. */
export default function CommandToggle() {
  const {setHud} = useHud();
  const {t} = useTranslation();
  return (
    <Button
      variant="ghost"
      className="flex h-7 grow justify-start gap-2 px-2 text-muted-foreground hover:text-foreground"
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
  );
}
