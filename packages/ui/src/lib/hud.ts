/** Settings panels, in display order. */
export const SETTINGS_TABS = ['general', 'appearance', 'server', 'profile'] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number];

/** How the settings screen is presented. */
export type SettingsMode = 'modal' | 'fullscreen';

export const isSettingsTab = (value: unknown): value is SettingsTab =>
  typeof value === 'string' && (SETTINGS_TABS as readonly string[]).includes(value);

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
    tab: 'general',
  },
  sideNav: {
    open: true,
    docked: true,
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
  return {
    commandPalette: {...HudDefault.commandPalette, ...stored.commandPalette},
    settings: {...HudDefault.settings, ...stored.settings},
    sideNav: {...HudDefault.sideNav, ...stored.sideNav},
    viewMode: {...HudDefault.viewMode, ...stored.viewMode},
  };
};

export const saveHudStorage = (hud: HudProps) => {
  // Persist preferences (mode, tab, dock state) but never the open state: a
  // reload should not pop settings back up. On the web the URL re-opens it.
  const persisted: HudProps = {...hud, settings: {...hud.settings, open: false}};
  localStorage.setItem(HUD_STORAGE_KEY, JSON.stringify(persisted));
};
