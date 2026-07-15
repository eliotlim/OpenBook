import {useEffect, useMemo, useState, type ComponentType, type KeyboardEvent as ReactKeyboardEvent} from 'react';
import {
  Cross2Icon,
  EnterFullScreenIcon,
  ExitFullScreenIcon,
  MagnifyingGlassIcon,
  PersonIcon,
  MixerHorizontalIcon,
  UpdateIcon,
} from '@radix-ui/react-icons';
import {ArchiveBoxIcon, CpuChipIcon, GlobeAltIcon, KeyIcon, LifebuoyIcon, PaintBrushIcon, PuzzlePieceIcon, Square3Stack3DIcon, WrenchIcon} from '@heroicons/react/24/outline';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import AppearanceSettings from '@/components/AppearanceSettings';
import GeneralSettings from '@/components/GeneralSettings';
import AiSettings from '@/components/AiSettings';
import ExtensionsSettings from '@/components/ExtensionsSettings';
import ProfileSettings from '@/components/settings/ProfileSettings';
import {ProfileAvatar} from '@/components/ProfileAvatar';
import CustomisationSettings from '@/components/settings/CustomisationSettings';
import LibrarySettings from '@/components/settings/LibrarySettings';
import SharingPublishingSettings from '@/components/settings/SharingPublishingSettings';
import AdminSettings from '@/components/settings/AdminSettings';
import AccountSettings from '@/components/settings/AccountSettings';
import AgentTokensSettings from '@/components/settings/AgentTokensSettings';
import DiagnosticsSettings from '@/components/settings/DiagnosticsSettings';
import {useIsSettingsAdmin} from '@/components/settings/adminGate';
import {cn} from '@/lib/utils';
import {useHud, useSelfIdentity, useTranslation} from '@/providers';
import type {TKey} from '@/i18n';
import {SETTINGS_SECTIONS, SETTINGS_SECTION_PEOPLE, type SettingsMode, type SettingsTab} from '@/lib/hud';
import {filterSettingsIndex, type SettingsSearchEntry} from '@/lib/settingsIndex';

const TAB_META: Record<SettingsTab, {labelKey: TKey; icon: ComponentType<{className?: string}>}> = {
  general: {labelKey: 'settings.tab.general', icon: WrenchIcon},
  libraries: {labelKey: 'settings.tab.libraries', icon: Square3Stack3DIcon},
  profile: {labelKey: 'settings.tab.profile', icon: PersonIcon},
  appearance: {labelKey: 'settings.tab.appearance', icon: PaintBrushIcon},
  customisation: {labelKey: 'settings.tab.customisation', icon: MixerHorizontalIcon},
  signin: {labelKey: 'settings.tab.signin', icon: UpdateIcon},
  sharing: {labelKey: 'settings.tab.sharing', icon: GlobeAltIcon},
  extensions: {labelKey: 'settings.tab.extensions', icon: PuzzlePieceIcon},
  ai: {labelKey: 'settings.tab.ai', icon: CpuChipIcon},
  admin: {labelKey: 'settings.tab.admin', icon: ArchiveBoxIcon},
  agents: {labelKey: 'settings.tab.agents', icon: KeyIcon},
  diagnostics: {labelKey: 'settings.tab.diagnostics', icon: LifebuoyIcon},
};

const SECTION_LABEL: Record<(typeof SETTINGS_SECTIONS)[number]['id'], TKey> = {
  preferences: 'settings.section.preferences',
  account: 'settings.section.account',
  library: 'settings.section.library',
  advanced: 'settings.section.advanced',
};

const PANELS: Record<SettingsTab, ComponentType> = {
  general: GeneralSettings,
  libraries: LibrarySettings,
  ai: AiSettings,
  profile: ProfileSettings,
  appearance: AppearanceSettings,
  customisation: CustomisationSettings,
  signin: AccountSettings,
  sharing: SharingPublishingSettings,
  extensions: ExtensionsSettings,
  admin: AdminSettings,
  agents: AgentTokensSettings,
  diagnostics: DiagnosticsSettings,
};

export interface SettingsPanelProps {
  tab: SettingsTab;
  onTabChange: (tab: SettingsTab) => void;
  mode: SettingsMode;
  onModeChange: (mode: SettingsMode) => void;
  onClose: () => void;
}

/** A small user chip at the foot of the nav; clicking it opens the Profile tab. */
function ProfileChip({onClick}: {onClick: () => void}) {
  const {name, profile} = useSelfIdentity();
  return (
    <button
      type="button"
      onClick={onClick}
      className="mt-2 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-hover"
    >
      <ProfileAvatar profile={profile} className="h-7 w-7 text-[11px] [&[data-avatar-kind=emoji]]:text-base" />
      <span className="truncate text-sm font-medium">{name}</span>
    </button>
  );
}

/**
 * The settings UI (grouped tab rail + active panel + window controls), fully
 * controlled. Rendered identically inside the modal and fullscreen surfaces so
 * the two only differ in how the surrounding surface is sized.
 */
export default function SettingsPanel({tab, onTabChange, mode, onModeChange, onClose}: SettingsPanelProps) {
  const fullscreen = mode === 'fullscreen';
  const {t} = useTranslation();
  const {hud, setHud} = useHud();
  const Panel = PANELS[tab];
  // The "Agents & AI admin" tab is admin-only: hide it from the rail entirely for
  // a confirmed non-admin (the panel still self-gates for a deep-link). Shown only
  // on an explicit `true`, so it never flashes for a viewer while the probe runs.
  const isAdmin = useIsSettingsAdmin();
  const canSeeAgents = isAdmin === true;

  // Generic in-tab landing (SET2-3): a search result (or any deep-link) sets the
  // transient `hud.settings.section` anchor; once the target tab's panel has
  // mounted, scroll that section into view and move focus to it, then clear the
  // one-shot — the same machinery the People roster uses (MembersSettings), which
  // still owns its own anchor, so we skip it here to avoid double-handling.
  const section = hud.settings.section;
  useEffect(() => {
    if (!section || section === SETTINGS_SECTION_PEOPLE) return;
    let raf = 0;
    let tries = 0;
    const land = () => {
      const el = document.getElementById(section);
      if (el) {
        const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
        el.scrollIntoView({behavior: reduce ? 'auto' : 'smooth', block: 'start'});
        if (el.tabIndex < 0 && !el.hasAttribute('tabindex')) el.tabIndex = -1;
        (el as HTMLElement).focus({preventScroll: true});
        setHud((draft) => {
          draft.settings.section = null;
          return draft;
        });
        return;
      }
      // The panel may mount a tick after the tab switch (async data); retry a few
      // frames before giving up so we don't clear the anchor prematurely.
      if (tries++ < 12) raf = requestAnimationFrame(land);
      else
        setHud((draft) => {
          draft.settings.section = null;
          return draft;
        });
    };
    raf = requestAnimationFrame(land);
    return () => cancelAnimationFrame(raf);
  }, [section, tab, setHud]);

  // ── In-panel search (SET2-3) ──────────────────────────────────────────────
  // Typing replaces the rail's group/tab list with matching setting rows drawn
  // from the shared registry; activating one lands on its tab and scrolls/focuses
  // the section via the same `hud.settings.section` anchor the People roster uses.
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const searching = query.trim().length > 0;
  const results = useMemo(
    () => (searching ? filterSettingsIndex(query, (key) => t(key), {includeAgents: canSeeAgents}) : []),
    [query, searching, canSeeAgents, t],
  );
  // Keep the highlighted row in range as the result set shrinks/grows.
  useEffect(() => setActiveIndex(0), [query]);

  const openResult = (entry: SettingsSearchEntry) => {
    onTabChange(entry.tab);
    setHud((draft) => {
      draft.settings.section = entry.sectionId;
      return draft;
    });
    setQuery('');
  };

  const onSearchKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (!searching) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      const entry = results[activeIndex];
      if (entry) {
        e.preventDefault();
        openResult(entry);
      }
    } else if (e.key === 'Escape') {
      // Clear the search first (don't let it bubble up and close the dialog).
      e.preventDefault();
      e.stopPropagation();
      setQuery('');
    }
  };

  return (
    <div className="relative flex h-full min-h-0 w-full flex-row">
      <nav
        className={cn(
          'ob-accent-chrome flex w-[210px] shrink-0 flex-col gap-1 overflow-y-auto bg-sheet-1 px-3 pb-4 pt-8 text-sheet-1-foreground',
          !fullscreen && 'rounded-l-lg',
        )}
      >
        <h4 className="px-2 pb-1 text-sm font-semibold">{t('settings.title')}</h4>
        <div className="relative px-1 pb-1 pt-1">
          <MagnifyingGlassIcon className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            inputSize="sm"
            aria-label={t('settings.searchPlaceholder')}
            placeholder={t('settings.searchPlaceholder')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onSearchKeyDown}
            className="bg-background pl-7"
          />
        </div>

        {searching ? (
          <div className="flex flex-col gap-0.5" role="listbox" aria-label={t('settings.searchPlaceholder')}>
            {results.length === 0 ? (
              <p className="px-2 py-3 text-xs text-muted-foreground">{t('settings.searchNoResults')}</p>
            ) : (
              results.map((entry, i) => {
                const {icon: Icon} = TAB_META[entry.tab];
                return (
                  <button
                    key={`${entry.tab}:${entry.sectionId}`}
                    type="button"
                    role="option"
                    aria-selected={i === activeIndex}
                    onMouseEnter={() => setActiveIndex(i)}
                    onClick={() => openResult(entry)}
                    className={cn(
                      'flex w-full flex-col items-start gap-0.5 rounded-md px-2 py-1.5 text-left transition-colors',
                      i === activeIndex ? 'bg-secondary' : 'hover:bg-hover',
                    )}
                  >
                    <span className="flex w-full items-center gap-2">
                      <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                      <span className="truncate text-sm">{t(entry.labelKey)}</span>
                    </span>
                    <span className="truncate pl-6 text-[11px] text-muted-foreground">{t(TAB_META[entry.tab].labelKey)}</span>
                  </button>
                );
              })
            )}
          </div>
        ) : (
          SETTINGS_SECTIONS.map((section) => (
            <div key={section.id} className="flex flex-col gap-0.5">
              <span className="px-2 pb-0.5 pt-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {t(SECTION_LABEL[section.id])}
              </span>
              {section.tabs
                .filter((id) => id !== 'agents' || canSeeAgents)
                .map((id) => {
                  const {labelKey, icon: Icon} = TAB_META[id];
                  return (
                    <Button
                      key={id}
                      variant={tab === id ? 'secondary' : 'ghost'}
                      className="flex h-7 justify-start px-2 font-normal"
                      onClick={() => onTabChange(id)}
                    >
                      <Icon className="mr-2 h-4 w-4 shrink-0" />
                      <span className="truncate">{t(labelKey)}</span>
                    </Button>
                  );
                })}
            </div>
          ))
        )}
        <div className="mt-auto">
          <ProfileChip onClick={() => onTabChange('profile')} />
        </div>
      </nav>

      {/* The panel wrapper carries the tab's screen-level anchor (`settings-<tab>`),
          so a search result pointing at a screen's top lands here immediately;
          sub-section results resolve to their own inner ids inside the panel. */}
      <div id={`settings-${tab}`} className="flex min-h-0 w-full flex-col overflow-y-auto px-8 pb-8 pt-12">
        <Panel />
      </div>

      <div className="absolute right-3 top-3 flex items-center gap-1">
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          aria-label={fullscreen ? t('settings.exitFullscreen') : t('settings.enterFullscreen')}
          title={fullscreen ? t('settings.exitFullscreen') : t('settings.fullscreen')}
          onClick={() => onModeChange(fullscreen ? 'modal' : 'fullscreen')}
        >
          {fullscreen ? <ExitFullScreenIcon className="h-4 w-4" /> : <EnterFullScreenIcon className="h-4 w-4" />}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          aria-label={t('settings.closeSettings')}
          title={t('common.close')}
          onClick={onClose}
        >
          <Cross2Icon className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
