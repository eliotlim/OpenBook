import React from 'react';
import type {LucideIcon} from 'lucide-react';
import {LayoutTemplate,
  ArrowLeft,
  ArrowRight,
  Bot,
  Columns2,
  FilePlus2,
  FlaskConical,
  Moon,
  PanelLeft,
  Settings as SettingsIcon,
  Star,
  StarOff,
  StretchHorizontal,
  Sun,
  Table2,
  Sparkles,
  Trash2,
} from 'lucide-react';
import {seedSampleDocument} from '@open-book/sdk';
import {useData} from '@/data';
import {useHud, useNavigation, useTheme, useTranslation} from '@/providers';
import {SHORTCUTS, type ShortcutCombo} from '@/lib/shortcuts';
import {isFavorite, subscribeFavorites, toggleFavorite} from '@/lib/favorites';

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
}

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

  const insertSampleDocument = React.useCallback(async () => {
    const page = await seedSampleDocument(client);
    await reload();
    selectPage(page.id);
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
        run: () => setHud((draft) => {draft.agent.open = !draft.agent.open; return draft;}),
      },
      {
        id: 'insert-sample',
        group: 'create',
        title: t('command.insertSample'),
        keywords: 'insert sample document test seed reactive slider chart demo',
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
        run: () =>
          setHud((draft) => {
            draft.viewMode.fullWidth = !draft.viewMode.fullWidth;
            return draft;
          }),
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
