import {useHud, useTranslation} from '@/providers';
import type {TKey} from '@/i18n';
import {SettingsScreen, SettingsSection, SettingsToggle} from '@/components/settings/primitives';

/** A keystroke rendered as one or more <kbd> chips. */
function Keys({keys}: {keys: string[]}) {
  return (
    <span className="flex items-center gap-1">
      {keys.map((k) => (
        <kbd
          key={k}
          className="inline-flex h-5 min-w-[20px] items-center justify-center rounded border border-border bg-muted px-1.5 text-xs font-medium text-muted-foreground"
        >
          {k}
        </kbd>
      ))}
    </span>
  );
}

/** Layout toggles (backed by the live HUD) + a reference list of shortcuts. */
export default function CustomisationSettings() {
  const {t} = useTranslation();
  const {hud, setHud} = useHud();

  const isMac =
    typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  const mod = isMac ? '⌘' : 'Ctrl';

  const shortcuts: Array<{key: TKey; keys: string[]}> = [
    {key: 'customisation.shortcut.commandPalette', keys: [mod, 'K']},
    {key: 'customisation.shortcut.closeOverlay', keys: ['Esc']},
    {key: 'customisation.shortcut.slashMenu', keys: ['/']},
    {key: 'customisation.shortcut.mention', keys: ['@']},
  ];

  return (
    <SettingsScreen title={t('customisation.title')} description={t('customisation.description')}>
      <SettingsSection title={t('customisation.layout')}>
        <SettingsToggle
          label={t('customisation.fullWidth')}
          hint={t('customisation.fullWidthHint')}
          checked={hud.viewMode.fullWidth}
          onCheckedChange={(v) =>
            setHud((draft) => {
              draft.viewMode.fullWidth = v;
              return draft;
            })
          }
        />
        <SettingsToggle
          label={t('customisation.autoHideSidebar')}
          hint={t('customisation.autoHideSidebarHint')}
          // The sidebar auto-hides when it's *not* docked.
          checked={!hud.sideNav.docked}
          onCheckedChange={(v) =>
            setHud((draft) => {
              draft.sideNav.docked = !v;
              if (!draft.sideNav.docked) draft.sideNav.open = false;
              return draft;
            })
          }
        />
      </SettingsSection>

      <SettingsSection title={t('customisation.shortcuts')} description={t('customisation.shortcutsHint')}>
        <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
          {shortcuts.map((s) => (
            <li key={s.key} className="flex items-center justify-between px-3.5 py-2.5 text-sm">
              <span>{t(s.key)}</span>
              <Keys keys={s.keys} />
            </li>
          ))}
        </ul>
      </SettingsSection>
    </SettingsScreen>
  );
}
