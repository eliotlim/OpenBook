import {GearIcon} from '@radix-ui/react-icons';
import {Button} from '@/components/ui/button';
import {Kbd, ShortcutTooltip} from '@/components/ui/kbd';
import {useHud, useTranslation} from '@/providers';
import {SHORTCUTS} from '@/lib/shortcuts';
import {SIDEBAR_HOVER, SIDEBAR_PRESS} from '@/lib/sidebarStyles';
import {cn} from '@/lib/utils';

/** Sidebar launcher that opens the settings surface (modal or fullscreen). */
export default function SettingsButton() {
  const {setHud} = useHud();
  const {t} = useTranslation();
  return (
    <ShortcutTooltip combo={SHORTCUTS.openSettings} label={t('common.settings')}>
      <Button
        variant="ghost"
        className={cn('flex h-7 grow justify-start gap-2 px-2 text-muted-foreground', SIDEBAR_HOVER, SIDEBAR_PRESS)}
        onClick={() => setHud((draft) => {draft.settings.open = true; return draft;})}
      >
        <GearIcon className="h-4 w-4 shrink-0" />
        <span className="grow text-left">{t('common.settings')}</span>
        <Kbd combo={SHORTCUTS.openSettings} />
      </Button>
    </ShortcutTooltip>
  );
}
