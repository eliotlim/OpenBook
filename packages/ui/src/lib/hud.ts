/** The settings sidebar: three sections, each with its sub-screens, in order.
 *  Preferences = how the app behaves and looks; Account = who you are
 *  (identity first); Workspace = this workspace's server and capabilities. */
export const SETTINGS_SECTIONS = [
  {id: 'preferences', tabs: ['general', 'appearance', 'customisation']},
  {id: 'account', tabs: ['profile', 'signup', 'signin', 'support']},
  {id: 'workspace', tabs: ['connection', 'integrations', 'extensions', 'ai', 'admin']},
] as const;

export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]['id'];

/** Settings panels, flattened in display order (derived from the sections). */
export const SETTINGS_TABS = SETTINGS_SECTIONS.flatMap((s) => s.tabs);
export type SettingsTab = (typeof SETTINGS_SECTIONS)[number]['tabs'][number];

/** The first sub-screen — the default when nothing (valid) is persisted. */
export const DEFAULT_SETTINGS_TAB: SettingsTab = SETTINGS_SECTIONS[0].tabs[0];

/** How the settings screen is presented. */
export type SettingsMode = 'modal' | 'fullscreen';

/** How a page is presented: an immersive full-screen deck, or the presenter
 *  console (current + next slide, speaker notes, timer). */
export type PresentMode = 'fullscreen' | 'presenter';

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
  present: {
    open: boolean;
    /** Immersive full-screen deck, or the presenter console. */
    mode: PresentMode;
    /** The page being presented. */
    pageId: string | null;
  };
  sideNav: {
    open: boolean;
    docked: boolean;
  };
  trash: {
    open: boolean;
  };
  templates: {
    open: boolean;
  };
  ai: {
    open: boolean;
  };
  agent: {
    open: boolean;
  };
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
  present: {
    open: false,
    mode: 'fullscreen',
    pageId: null,
  },
  sideNav: {
    open: true,
    docked: true,
  },
  trash: {
    open: false,
  },
  templates: {
    open: false,
  },
  ai: {
    open: false,
  },
  agent: {
    open: false,
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
    // Never restore transient overlays open (the trash, the template gallery).
    trash: {open: false},
    templates: {open: false},
    ai: {open: false},
    agent: {open: false},
    present: {...HudDefault.present},
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
    templates: {open: false},
    ai: {open: false},
    agent: {open: false},
    present: {...HudDefault.present},
  };
  localStorage.setItem(HUD_STORAGE_KEY, JSON.stringify(persisted));
};
