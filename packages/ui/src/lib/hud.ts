/** The settings sidebar: three sections, each with its sub-screens, in order. */
export const SETTINGS_SECTIONS = [
  {id: 'preferences', tabs: ['general', 'profile', 'appearance', 'customisation']},
  {id: 'account', tabs: ['signup', 'signin', 'support']},
  {id: 'workspace', tabs: ['connection', 'integrations', 'admin']},
] as const;

export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]['id'];

/** Settings panels, flattened in display order (derived from the sections). */
export const SETTINGS_TABS = SETTINGS_SECTIONS.flatMap((s) => s.tabs);
export type SettingsTab = (typeof SETTINGS_SECTIONS)[number]['tabs'][number];

/** The first sub-screen — the default when nothing (valid) is persisted. */
export const DEFAULT_SETTINGS_TAB: SettingsTab = SETTINGS_SECTIONS[0].tabs[0];

/** How the settings screen is presented. */
export type SettingsMode = 'modal' | 'fullscreen';

export const isSettingsTab = (value: unknown): value is SettingsTab =>
  typeof value === 'string' && (SETTINGS_TABS as readonly string[]).includes(value);

/** Sub-screens that were renamed when the flat tabs became grouped sections. */
const LEGACY_TAB_MAP: Record<string, SettingsTab> = {
  server: 'connection',
  backup: 'admin',
};

/**
 * Resolve a persisted tab id to a current one: map renamed legacy ids
 * (`server`→`connection`, `backup`→`admin`) and fall back to the default for
 * anything no longer a valid tab, so an old `settings.tab` never dead-ends.
 */
export const normalizeTab = (value: unknown): SettingsTab => {
  if (isSettingsTab(value)) return value;
  if (typeof value === 'string' && value in LEGACY_TAB_MAP) return LEGACY_TAB_MAP[value];
  return DEFAULT_SETTINGS_TAB;
};

export interface HudProps {
  commandPalette: {
    open: boolean;
  };
  settings: {
    open: boolean;
    /** Whether settings show as a centered modal or fill the viewport. */
    mode: SettingsMode;
    /** The currently selected settings panel. */
    tab: SettingsTab;
  };
  sideNav: {
    open: boolean;
    docked: boolean;
  };
  trash: {
    open: boolean;
  };
  viewMode: {
    fullWidth: boolean;
  }
}

export const HudDefault: HudProps = {
  commandPalette: {
    open: false,
  },
  settings: {
    open: false,
    mode: 'modal',
    tab: DEFAULT_SETTINGS_TAB,
  },
  sideNav: {
    open: true,
    docked: true,
  },
  trash: {
    open: false,
  },
  viewMode: {
    fullWidth: false,
  },
};

export const HUD_STORAGE_KEY = 'hud';

export const loadHudStorage = (): HudProps => {
  if (typeof window === 'undefined' || localStorage.getItem(HUD_STORAGE_KEY) === null) {
    return HudDefault;
  }
  const stored = JSON.parse(localStorage.getItem(HUD_STORAGE_KEY) ?? '{}') as Partial<HudProps>;
  // Merge each section over its defaults so HUD shapes added after a value was
  // persisted (e.g. settings.mode/tab) don't come back undefined.
  const settings = {...HudDefault.settings, ...stored.settings};
  return {
    commandPalette: {...HudDefault.commandPalette, ...stored.commandPalette},
    // Resolve a possibly-legacy persisted tab to a current one.
    settings: {...settings, tab: normalizeTab(settings.tab)},
    sideNav: {...HudDefault.sideNav, ...stored.sideNav},
    // Never restore the trash open (a transient overlay, like settings).
    trash: {open: false},
    viewMode: {...HudDefault.viewMode, ...stored.viewMode},
  };
};

export const saveHudStorage = (hud: HudProps) => {
  // Persist preferences (mode, tab, dock state) but never the open state: a
  // reload should not pop settings (or the trash) back up. On the web the URL
  // re-opens settings.
  const persisted: HudProps = {
    ...hud,
    settings: {...hud.settings, open: false},
    trash: {open: false},
  };
  localStorage.setItem(HUD_STORAGE_KEY, JSON.stringify(persisted));
};
