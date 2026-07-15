/** The settings sidebar: four sections, each with its sub-screens, in order
 *  (SET2-6). Preferences = how the app behaves and looks; Account = who you are
 *  (identity first); Library = this library's policy + capabilities (Sharing
 *  leads — the most-used surface); Advanced = mixed-scope plumbing/admin/support
 *  that's rarely touched (the scope chips carry the truth for these). */
export const SETTINGS_SECTIONS = [
  {id: 'preferences', tabs: ['general', 'appearance', 'customisation']},
  {id: 'account', tabs: ['profile', 'signin']},
  {id: 'library', tabs: ['sharing', 'ai', 'extensions', 'admin']},
  {id: 'advanced', tabs: ['libraries', 'agents', 'diagnostics']},
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

/** Sub-screens that were renamed/merged when the flat tabs became grouped
 *  sections, plus the retired "coming soon" stubs (signup/support/integrations)
 *  mapped to their nearest real screen. `members` folded into the Sharing tab
 *  (SHR-5) — its roster is now the People section there. `connection` folded into
 *  the Libraries screen (SET2-1) — the per-library rows are the one place to set
 *  a server + token; `server`/`connection` both resolve there now. */
const LEGACY_TAB_MAP: Record<string, SettingsTab> = {
  server: 'libraries',
  connection: 'libraries',
  backup: 'admin',
  signup: 'signin',
  support: 'profile',
  integrations: 'extensions',
  members: 'sharing',
};

/**
 * In-tab scroll anchors carried transiently in `hud.settings.section`, so a
 * deep-link can land on a specific group *within* a merged tab. Doubles as the
 * DOM id of that group's container. Currently just the People roster, reached
 * from ShareDialog's "manage members" link and the legacy `?settings=members`.
 */
export const SETTINGS_SECTION_PEOPLE = 'settings-people';

/** Legacy tab params that should also scroll to a group inside the merged tab
 *  they resolve to (e.g. `members` → the Sharing tab's People section). */
export const SETTINGS_ALIAS_SECTIONS: Record<string, string> = {
  members: SETTINGS_SECTION_PEOPLE,
};

/** Whether a persisted/URL param names a real tab or a known legacy alias — so
 *  a stray value leaves the current tab alone instead of resetting it. */
export const isTabParam = (value: unknown): boolean =>
  isSettingsTab(value) || (typeof value === 'string' && value in LEGACY_TAB_MAP);

/**
 * Resolve a persisted tab id to a current one: map renamed/merged legacy ids
 * (`connection`/`server`→`libraries`, `backup`→`admin`, retired stubs → their
 * nearest real screen) and fall back to the default for anything no longer a
 * valid tab, so an old `settings.tab` never dead-ends.
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
    /** A transient in-tab scroll target (e.g. {@link SETTINGS_SECTION_PEOPLE}):
     *  a deep-link sets it, the target section scrolls itself into view and
     *  clears it. Never persisted or restored. */
    section?: string | null;
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
  importer: {
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
    section: null,
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
  importer: {
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
    // Resolve a possibly-legacy persisted tab to a current one; never restore a
    // stale in-tab scroll target (it's a one-shot nav hint, not a preference).
    settings: {...settings, tab: normalizeTab(settings.tab), section: null},
    sideNav: {...HudDefault.sideNav, ...stored.sideNav},
    // Never restore transient overlays open (the trash, the template gallery).
    trash: {open: false},
    templates: {open: false},
    importer: {open: false},
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
    settings: {...hud.settings, open: false, section: null},
    trash: {open: false},
    templates: {open: false},
    importer: {open: false},
    agent: {open: false},
    present: {...HudDefault.present},
  };
  localStorage.setItem(HUD_STORAGE_KEY, JSON.stringify(persisted));
};
