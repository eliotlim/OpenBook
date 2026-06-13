import {useHud, useTranslation} from '@/providers';
import type {TKey} from '@/i18n';
import {SettingsScreen, SettingsSection, SettingsToggle} from '@/components/settings/primitives';
import {formatShortcut, isMacPlatform, SHORTCUTS, type ShortcutCombo} from '@/lib/shortcuts';

/** A keystroke rendered as a <kbd> chip. */
function Keys({label}: {label: string}) {
  return (
    <kbd className="inline-flex h-5 min-w-[20px] items-center justify-center rounded border border-border bg-muted px-1.5 font-sans text-xs font-medium text-muted-foreground">
      {label}
    </kbd>
  );
}

/** Layout toggles (backed by the live HUD) + a reference list of shortcuts. */
export default function CustomisationSettings() {
  const {t} = useTranslation();
  const {hud, setHud} = useHud();

  // The settings panel is client-only (a modal), so reading the platform
  // directly is safe — no SSR render to mismatch.
  const fmt = (combo: ShortcutCombo): string => formatShortcut(combo, isMacPlatform);

  const shortcuts: Array<{key: TKey; label: string}> = [
    {key: 'customisation.shortcut.commandPalette', label: fmt(SHORTCUTS.commandPalette)},
    {key: 'customisation.shortcut.newPage', label: fmt(SHORTCUTS.newPage)},
    {key: 'customisation.shortcut.toggleSidebar', label: fmt(SHORTCUTS.toggleSidebar)},
    {key: 'customisation.shortcut.fullWidth', label: fmt(SHORTCUTS.toggleFullWidth)},
    {key: 'customisation.shortcut.theme', label: fmt(SHORTCUTS.toggleTheme)},
    {key: 'customisation.shortcut.back', label: fmt(SHORTCUTS.goBack)},
    {key: 'customisation.shortcut.forward', label: fmt(SHORTCUTS.goForward)},
    {key: 'customisation.shortcut.openSettings', label: fmt(SHORTCUTS.openSettings)},
    {key: 'customisation.shortcut.trash', label: fmt(SHORTCUTS.openTrash)},
    {key: 'customisation.shortcut.slashMenu', label: '/'},
    {key: 'customisation.shortcut.mention', label: '@'},
    {key: 'customisation.shortcut.closeOverlay', label: 'Esc'},
  ];

  return (
    <SettingsScreen title={t('customisation.title')} description={t('customisation.description')}>
      <SettingsSection title={t('customisation.layout')}>
        {/* Full width is now a per-page choice (page "…" menu / ⌘. / the page's
            customise pane), so it's no longer a global switch here. */}
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
              <Keys label={s.label} />
            </li>
          ))}
        </ul>
      </SettingsSection>
    </SettingsScreen>
  );
}
