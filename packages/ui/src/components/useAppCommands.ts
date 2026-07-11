import React from 'react';
import type {LucideIcon} from 'lucide-react';
import {GitFork,
  LayoutTemplate,
  ArrowLeft,
  ArrowRight,
  Bot,
  ClipboardCheck,
  Columns2,
  FilePlus2,
  FlaskConical,
  Monitor,
  Moon,
  Palette,
  PanelLeft,
  Presentation,
  Puzzle,
  Settings as SettingsIcon,
  Star,
  StarOff,
  StretchHorizontal,
  Sun,
  Table2,
  Sparkles,
  Trash2,
  Upload,
} from 'lucide-react';
import {seedSampleDocument} from '@book.dev/sdk';
import {useData} from '@/data';
import {useHud, useNavigation, useTheme, useTranslation} from '@/providers';
import {SHORTCUTS, type ShortcutCombo} from '@/lib/shortcuts';
import {AGENT_PANE_ID, CUSTOMISE_PANE_ID, FLOW_PANE_ID, HOME_PAGE_ID, REVIEW_PANE_ID} from '@/lib/homePage';
import {SETTINGS_TABS, type SettingsTab} from '@/lib/hud';
import {setPageCustomiseTarget} from '@/lib/pageCustomise';
import {setReviewTarget} from '@/lib/reviewPane';
import {togglePageFullWidth} from '@/lib/pageFullWidth';
import {isFavorite, subscribeFavorites, toggleFavorite} from '@/lib/favorites';
import {pluginCommands, subscribePluginCommands} from '@/plugins';

/** A command's bucket in the palette (each renders as a labelled group). */
export type CommandGroup = 'create' | 'view' | 'navigation' | 'app';

export interface AppCommand {
  id: string;
  group: CommandGroup;
  /** Localised display label. */
  title: string;
  /** Extra search terms so the palette finds it under synonyms. */
  keywords?: string;
  icon: LucideIcon;
  /** Shown as a hint and bound by the global key handler when present. */
  shortcut?: ShortcutCombo;
  /** Runs the command. Does *not* close the palette — the caller decides. */
  run: () => void;
  /** Greyed out and non-firing (e.g. Back with no history). */
  disabled?: boolean;
  /** Only surfaced while the user is searching, to keep the default list calm
   *  (the per-pane "Settings: …" deep links). */
  searchOnly?: boolean;
}

/** Extra English search synonyms for settings panes whose id/label wouldn't
 *  otherwise match a natural query (e.g. "account" → the `signin` pane). */
const SETTINGS_KEYWORDS: Partial<Record<SettingsTab, string>> = {
  signin: 'account sync sign in login',
  connection: 'server remote connect',
  admin: 'data backups backup export storage',
  customisation: 'customisation customization shortcuts layout',
  sharing: 'sharing publishing publish',
  extensions: 'extensions plugins',
  ai: 'ai assistant model provider',
};

/**
 * The single source of truth for app-level commands. The command palette
 * renders them, the global key handler ({@link useGlobalShortcuts}) fires the
 * ones with a shortcut, and both stay in sync because they read this list.
 */
export function useAppCommands(): AppCommand[] {
  const {setHud} = useHud();
  const {
    createPage,
    createDatabasePage,
    goBack,
    goForward,
    canGoBack,
    canGoForward,
    currentPageId,
    openInSplit,
    closeSplit,
    splitOpen,
    reload,
    selectPage,
  } = useNavigation();
  const {colorScheme, setMode} = useTheme();
  const {t} = useTranslation();
  const client = useData();

  // Re-derive the favourite command's label/icon when the pin state changes.
  const [favVersion, setFavVersion] = React.useState(0);
  React.useEffect(() => subscribeFavorites(() => setFavVersion((v) => v + 1)), []);
  // Plugin commands join the palette live as extensions (de)activate.
  const [pluginVersion, setPluginVersion] = React.useState(0);
  React.useEffect(() => subscribePluginCommands(() => setPluginVersion((v) => v + 1)), []);

  const seedingRef = React.useRef(false);
  const insertSampleDocument = React.useCallback(async () => {
    // In-flight guard: without unique names, re-firing mid-seed would race the
    // open-or-create check and mint a duplicate sample.
    if (seedingRef.current) return;
    seedingRef.current = true;
    try {
      const page = await seedSampleDocument(client);
      await reload();
      selectPage(page.id);
    } finally {
      seedingRef.current = false;
    }
  }, [client, reload, selectPage]);

  return React.useMemo<AppCommand[]>(() => {
    const isDark = colorScheme === 'dark';
    const fav = !!currentPageId && isFavorite(currentPageId);
    return [
      // ── Create ──────────────────────────────────────────────────────────
      {
        id: 'new-page',
        group: 'create',
        title: t('command.createPage'),
        keywords: 'new page create document add',
        icon: FilePlus2,
        shortcut: SHORTCUTS.newPage,
        run: () => void createPage(),
      },
      {
        id: 'new-database',
        group: 'create',
        title: t('command.newDatabase'),
        keywords: 'new database table grid create',
        icon: Table2,
        run: () => void createDatabasePage(),
      },
      {
        id: 'new-from-template',
        group: 'create',
        title: t('command.newFromTemplate'),
        keywords: 'template gallery starter tasks roadmap reading meeting planner create',
        icon: LayoutTemplate,
        run: () => setHud((draft) => {draft.templates.open = true; return draft;}),
      },
      {
        id: 'import-content',
        group: 'create',
        title: t('command.importContent'),
        keywords: 'import notion markdown bring content migrate upload zip',
        icon: Upload,
        run: () => setHud((draft) => {draft.importer.open = true; return draft;}),
      },
      {
        id: 'ai-search',
        group: 'navigation',
        title: t('command.aiSearch'),
        keywords: 'ai search notes semantic ask find',
        icon: Sparkles,
        run: () => setHud((draft) => {draft.ai.open = true; return draft;}),
      },
      {
        id: 'ask-assistant',
        group: 'navigation',
        title: t('command.askAssistant'),
        keywords: 'ai assistant agent chat ask help workspace',
        icon: Bot,
        run: () => openInSplit(AGENT_PANE_ID),
      },
      {
        id: 'insert-sample',
        group: 'create',
        title: t('command.insertSample'),
        keywords: 'sample document explore example learn tour reactive slider chart demo insert',
        icon: FlaskConical,
        run: () => void insertSampleDocument(),
      },
      // ── View ────────────────────────────────────────────────────────────
      {
        id: 'toggle-sidebar',
        group: 'view',
        title: t('command.toggleSidebar'),
        keywords: 'sidebar panel hide show toggle',
        icon: PanelLeft,
        shortcut: SHORTCUTS.toggleSidebar,
        run: () =>
          setHud((draft) => {
            draft.sideNav.open = !draft.sideNav.docked;
            draft.sideNav.docked = !draft.sideNav.docked;
            return draft;
          }),
      },
      {
        id: 'toggle-full-width',
        group: 'view',
        title: t('command.toggleFullWidth'),
        keywords: 'full width wide narrow column layout',
        icon: StretchHorizontal,
        shortcut: SHORTCUTS.toggleFullWidth,
        // Full width is a per-page layout choice — toggle the focused page's.
        run: () => {
          if (currentPageId) togglePageFullWidth(currentPageId);
        },
      },
      {
        id: 'toggle-theme',
        group: 'view',
        title: isDark ? t('command.themeToLight') : t('command.themeToDark'),
        keywords: 'theme dark light mode appearance color',
        icon: isDark ? Sun : Moon,
        shortcut: SHORTCUTS.toggleTheme,
        run: () => setMode(isDark ? 'light' : 'dark'),
      },
      {
        id: 'dataflow-view',
        group: 'view',
        title: t('flow.open'),
        keywords: 'dataflow graph network nodes flow wiring reactive',
        icon: GitFork,
        disabled: !currentPageId || currentPageId === HOME_PAGE_ID,
        run: () => openInSplit(FLOW_PANE_ID),
      },
      {
        id: 'customise-page',
        group: 'view',
        title: t('command.customisePage'),
        keywords: 'customise customize page theme accent font typeface appearance style',
        icon: Palette,
        disabled: !currentPageId || currentPageId === HOME_PAGE_ID,
        run: () => {
          if (!currentPageId) return;
          setPageCustomiseTarget(currentPageId);
          openInSplit(CUSTOMISE_PANE_ID);
        },
      },
      {
        id: 'review-suggestions',
        group: 'view',
        title: t('command.reviewSuggestions'),
        keywords: 'review suggestions comments edits accept reject feedback ai',
        icon: ClipboardCheck,
        disabled: !currentPageId || currentPageId === HOME_PAGE_ID,
        run: () => {
          if (!currentPageId) return;
          setReviewTarget(currentPageId);
          openInSplit(REVIEW_PANE_ID);
        },
      },
      {
        id: 'present-fullscreen',
        group: 'view',
        title: t('command.presentFull'),
        keywords: 'present presentation slides deck slideshow full screen',
        icon: Presentation,
        disabled: !currentPageId || currentPageId === HOME_PAGE_ID,
        run: () => {
          if (!currentPageId) return;
          setHud((draft) => {
            draft.present = {open: true, mode: 'fullscreen', pageId: currentPageId};
            return draft;
          });
        },
      },
      {
        id: 'present-presenter',
        group: 'view',
        title: t('command.presentPresenter'),
        keywords: 'present presenter view speaker notes console slides timer',
        icon: Monitor,
        disabled: !currentPageId || currentPageId === HOME_PAGE_ID,
        run: () => {
          if (!currentPageId) return;
          setHud((draft) => {
            draft.present = {open: true, mode: 'presenter', pageId: currentPageId};
            return draft;
          });
        },
      },
      {
        id: 'split-view',
        group: 'view',
        title: splitOpen ? t('command.closeSplit') : t('command.splitView'),
        keywords: 'split view pane side by side columns',
        icon: Columns2,
        disabled: !splitOpen && !currentPageId,
        run: () => (splitOpen ? closeSplit() : currentPageId && openInSplit(currentPageId)),
      },
      // ── Navigation ──────────────────────────────────────────────────────
      {
        id: 'go-back',
        group: 'navigation',
        title: t('command.goBack'),
        keywords: 'back previous history navigate',
        icon: ArrowLeft,
        shortcut: SHORTCUTS.goBack,
        disabled: !canGoBack,
        run: () => goBack(),
      },
      {
        id: 'go-forward',
        group: 'navigation',
        title: t('command.goForward'),
        keywords: 'forward next history navigate',
        icon: ArrowRight,
        shortcut: SHORTCUTS.goForward,
        disabled: !canGoForward,
        run: () => goForward(),
      },
      // ── App ─────────────────────────────────────────────────────────────
      {
        id: 'toggle-favorite',
        group: 'app',
        title: fav ? t('command.unfavorite') : t('command.favorite'),
        keywords: 'favorite favourite pin star bookmark unpin',
        icon: fav ? StarOff : Star,
        disabled: !currentPageId,
        run: () => {
          if (currentPageId) toggleFavorite(currentPageId);
        },
      },
      {
        id: 'open-settings',
        group: 'app',
        title: t('command.openSettings'),
        keywords: 'settings preferences options config',
        icon: SettingsIcon,
        shortcut: SHORTCUTS.openSettings,
        run: () =>
          setHud((draft) => {
            draft.settings.open = true;
            return draft;
          }),
      },
      // A "Settings: <pane>" deep link per settings tab, so the palette opens the
      // right screen directly. Search-only so they don't crowd the default list.
      ...SETTINGS_TABS.map(
        (settingsTab): AppCommand => ({
          id: `settings-${settingsTab}`,
          group: 'app',
          title: t('command.settingsFor', {name: t(`settings.tab.${settingsTab}`)}),
          keywords: `settings preferences ${settingsTab} ${SETTINGS_KEYWORDS[settingsTab] ?? ''}`,
          icon: SettingsIcon,
          searchOnly: true,
          run: () =>
            setHud((draft) => {
              draft.settings.open = true;
              draft.settings.tab = settingsTab;
              return draft;
            }),
        }),
      ),
      ...pluginCommands().map((cmd) => ({
        id: cmd.id,
        group: 'app' as const,
        title: cmd.title,
        keywords: cmd.keywords,
        icon: Puzzle,
        run: cmd.run,
      })),
      {
        id: 'open-trash',
        group: 'app',
        title: t('command.openTrash'),
        keywords: 'trash bin deleted restore recover',
        icon: Trash2,
        shortcut: SHORTCUTS.openTrash,
        run: () =>
          setHud((draft) => {
            draft.trash.open = true;
            return draft;
          }),
      },
    ];
  }, [
    t,
    colorScheme,
    splitOpen,
    currentPageId,
    favVersion,
    pluginVersion,
    canGoBack,
    canGoForward,
    createPage,
    createDatabasePage,
    insertSampleDocument,
    setHud,
    setMode,
    closeSplit,
    openInSplit,
    goBack,
    goForward,
  ]);
}
