import type {TKey} from '@/i18n';
import {SETTINGS_SECTION_PEOPLE, type SettingsTab} from '@/lib/hud';

/**
 * The single registry of searchable settings (SET2-3). One entry per meaningful
 * settings section/screen: the tab it lives on, a DOM `sectionId` anchor to land
 * on, the i18n keys that already name the control (so search reads the *same*
 * translated label + hint the panel shows), and English synonym `keywords`.
 *
 * This is the one source of truth for BOTH the in-panel settings search
 * (`SettingsPanel`) and the command palette's per-tab "Settings: …" deep links
 * (`useAppCommands`) — the hand-curated `SETTINGS_KEYWORDS` map that used to live
 * in the palette folded into the `keywords` here so the two never drift.
 *
 * `sectionId` doubles as the DOM id the section renders (see
 * `SettingsSection id=…`), so activating a result can scroll/focus straight to
 * it via the same transient `hud.settings.section` anchor the People roster uses
 * (`MembersSettings`). Entries that point at a screen's first/top section need no
 * explicit DOM id — landing on the tab already shows them at the top.
 */
export interface SettingsSearchEntry {
  /** The settings tab this section lives on. */
  tab: SettingsTab;
  /** DOM id anchor of the target section (a `hud.settings.section` value). */
  sectionId: string;
  /** i18n key for the section's translated label. */
  labelKey: TKey;
  /** i18n key for the section's translated hint/description, if any. */
  hintKey?: TKey;
  /** Extra English search synonyms so a natural query still finds the section. */
  keywords: string;
}

/** DOM id anchors for the searchable sections (also each section's `id`). */
export const SETTINGS_SECTION_GENERAL_BEHAVIOR = 'settings-general-behavior';
export const SETTINGS_SECTION_CUST_SHORTCUTS = 'settings-cust-shortcuts';
export const SETTINGS_SECTION_CUST_BLOCKS = 'settings-cust-blocks';
export const SETTINGS_SECTION_AGENTS_MCP = 'settings-agents-mcp';
export const SETTINGS_SECTION_AGENTS_USAGE = 'settings-agents-usage';

export const SETTINGS_SEARCH_INDEX: readonly SettingsSearchEntry[] = [
  // ── Preferences ───────────────────────────────────────────────────────────
  {
    tab: 'general',
    sectionId: 'settings-general',
    labelKey: 'general.languageSection',
    hintKey: 'general.languageHint',
    keywords: 'language locale translation display',
  },
  {
    tab: 'general',
    sectionId: SETTINGS_SECTION_GENERAL_BEHAVIOR,
    labelKey: 'general.behavior',
    hintKey: 'general.confirmTrashHint',
    keywords: 'behavior confirm trash spellcheck',
  },
  {
    tab: 'appearance',
    sectionId: 'settings-appearance',
    labelKey: 'appearance.title',
    hintKey: 'appearance.colorThemeHint',
    // "auto-hide"/"sidebar"/"layout" land here now that the auto-hide-sidebar
    // toggle moved from the Shortcuts tab into Appearance (SET2-7).
    keywords: 'appearance theme dark light accent color colour sidebar auto-hide autohide layout font typeface customization',
  },
  {
    tab: 'customisation',
    sectionId: SETTINGS_SECTION_CUST_SHORTCUTS,
    labelKey: 'customisation.shortcuts',
    hintKey: 'customisation.shortcutsHint',
    keywords: 'keyboard shortcuts keybindings hotkeys',
  },
  {
    tab: 'customisation',
    sectionId: SETTINGS_SECTION_CUST_BLOCKS,
    labelKey: 'customisation.blockShortcuts',
    hintKey: 'customisation.blockShortcutsHint',
    keywords: 'block editing shortcuts editor',
  },
  // ── Account ───────────────────────────────────────────────────────────────
  {
    tab: 'profile',
    sectionId: 'settings-profile',
    labelKey: 'profile.title',
    hintKey: 'profile.description',
    keywords: 'profile identity name avatar bio display name',
  },
  {
    tab: 'signin',
    sectionId: 'settings-signin',
    labelKey: 'account.signin.title',
    hintKey: 'account.signin.description',
    keywords: 'account sync sign in login connect device',
  },
  // ── Library ───────────────────────────────────────────────────────────────
  {
    tab: 'sharing',
    sectionId: 'settings-sharing',
    labelKey: 'sharing.title',
    hintKey: 'sharing.description',
    keywords: 'sharing publishing publish guests access permissions link',
  },
  {
    tab: 'sharing',
    sectionId: SETTINGS_SECTION_PEOPLE,
    labelKey: 'members.title',
    hintKey: 'members.description',
    keywords: 'members people roster invite admin viewer roles',
  },
  {
    tab: 'ai',
    sectionId: 'settings-ai',
    labelKey: 'ai.title',
    hintKey: 'ai.description',
    keywords: 'ai assistant model provider engine claude llama mlx openai',
  },
  {
    tab: 'extensions',
    sectionId: 'settings-extensions',
    labelKey: 'settings.tab.extensions',
    hintKey: 'extensions.description',
    keywords: 'extensions plugins blocks commands integrations',
  },
  {
    tab: 'admin',
    sectionId: 'settings-admin',
    labelKey: 'admin.title',
    hintKey: 'admin.description',
    keywords: 'data backups backup restore export storage',
  },
  // ── Advanced ──────────────────────────────────────────────────────────────
  {
    tab: 'libraries',
    sectionId: 'settings-libraries',
    labelKey: 'librarySettings.title',
    hintKey: 'librarySettings.description',
    keywords: 'libraries servers server remote connect connection',
  },
  {
    tab: 'agents',
    sectionId: 'settings-agents',
    labelKey: 'agents.title',
    hintKey: 'agents.description',
    keywords: 'agent tokens api access token personal credential mcp',
  },
  {
    tab: 'agents',
    sectionId: SETTINGS_SECTION_AGENTS_MCP,
    labelKey: 'ai.mcp.title',
    hintKey: 'ai.mcp.hint',
    keywords: 'mcp external tools servers model context protocol',
  },
  {
    tab: 'agents',
    sectionId: SETTINGS_SECTION_AGENTS_USAGE,
    labelKey: 'aiUsage.usageTitle',
    hintKey: 'aiUsage.usageHint',
    keywords: 'ai usage tokens cost attribution pricing spend',
  },
  {
    tab: 'diagnostics',
    sectionId: 'settings-diagnostics',
    labelKey: 'diagnostics.title',
    hintKey: 'diagnostics.description',
    keywords: 'diagnostics identity ownership repair troubleshoot',
  },
];

/** The admin-only tab: its sections (agent tokens, MCP, AI usage) are hidden
 *  from a confirmed non-admin — matching the settings rail's own gate. */
const ADMIN_ONLY_TABS: ReadonlySet<SettingsTab> = new Set<SettingsTab>(['agents']);

/**
 * The palette's per-tab keyword blob: every index entry's keywords for that tab,
 * joined. Replaces the hand-curated `SETTINGS_KEYWORDS` so the palette deep links
 * and the in-panel search share one keyword registry.
 */
export function settingsKeywordsForTab(tab: SettingsTab): string {
  return SETTINGS_SEARCH_INDEX.filter((e) => e.tab === tab)
    .map((e) => e.keywords)
    .join(' ');
}

/**
 * Filter the index for a query. Matches case-insensitively on the *translated*
 * label + hint plus the raw keywords, requiring every whitespace-separated token
 * to appear somewhere (AND semantics) so "block shortcut" narrows sensibly.
 * `includeAgents=false` drops the admin-only sections for a confirmed non-admin.
 */
export function filterSettingsIndex(
  query: string,
  translate: (key: TKey) => string,
  {includeAgents}: {includeAgents: boolean},
): SettingsSearchEntry[] {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [];
  return SETTINGS_SEARCH_INDEX.filter((entry) => {
    if (!includeAgents && ADMIN_ONLY_TABS.has(entry.tab)) return false;
    const haystack = [
      translate(entry.labelKey),
      entry.hintKey ? translate(entry.hintKey) : '',
      entry.keywords,
      translate(`settings.tab.${entry.tab}` as TKey),
    ]
      .join(' ')
      .toLowerCase();
    return tokens.every((tok) => haystack.includes(tok));
  });
}
