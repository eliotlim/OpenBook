import {useEffect, useMemo, useState} from 'react';
import type {PageMeta} from '@open-book/sdk';
import {Clock, Database, FilePlus, Pencil, Search, SlidersHorizontal, Star} from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {IconButton} from '@/components/ui/icon-button';
import {useHud, useNavigation, usePreferences, useTranslation} from '@/providers';
import {readPageIcon, subscribePageIcon} from '@/lib/pageIcon';
import {readRecents, subscribeRecents} from '@/lib/recents';
import {readFavorites, subscribeFavorites} from '@/lib/favorites';
import {
  DEFAULT_HOME_WIDGETS,
  greetingKey,
  readHomeWidgets,
  writeHomeWidgets,
  type HomeWidgets,
} from '@/lib/homePage';
import {t as bareT} from '@/i18n';
import {cn} from '@/lib/utils';

const displayName = (name: string | null): string => (name && name.trim().length > 0 ? name : bareT('common.untitled'));

/** "5m ago" / "3d ago" — compact relative time for the edited list. */
function timeAgo(iso: string): string {
  const secs = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (secs < 60) return bareT('home.justNow');
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

/** A small tile linking to a page: icon + name, card-shaped. */
function PageTile({page, onOpen}: {page: PageMeta; onOpen: (id: string) => void}) {
  return (
    <button
      type="button"
      onClick={() => onOpen(page.id)}
      className="flex items-center gap-2.5 rounded-lg border border-border bg-card px-3 py-2.5 text-left transition-[background-color,border-color,box-shadow,transform] hover:-translate-y-px hover:border-foreground/15 hover:shadow-lift active:translate-y-0 active:shadow-none focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
    >
      <span className="text-lg leading-none" aria-hidden>
        {readPageIcon(page.id)}
      </span>
      <span className="min-w-0 truncate text-sm font-medium">{displayName(page.name)}</span>
    </button>
  );
}

function WidgetHeading({icon: Icon, children}: {icon: typeof Clock; children: string}) {
  return (
    <h2 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground/70">
      <Icon className="h-3.5 w-3.5" />
      {children}
    </h2>
  );
}

/**
 * Home — the new-tab page. A time-of-day greeting and a configurable set of
 * widgets over what's already known locally: jump back in (recents),
 * favorites, recently edited, and quick actions. Customization persists per
 * device; empty widgets hide themselves rather than render placeholders.
 */
export default function HomeScreen() {
  const {t, locale} = useTranslation();
  const {setHud} = useHud();
  const {pages, selectPage, createPage, createDatabasePage} = useNavigation();
  const {profile} = usePreferences().preferences;

  const [widgets, setWidgets] = useState<HomeWidgets>(DEFAULT_HOME_WIDGETS);
  useEffect(() => setWidgets(readHomeWidgets()), []);
  const setWidget = (key: keyof HomeWidgets, on: boolean): void => {
    const next = {...widgets, [key]: on};
    setWidgets(next);
    writeHomeWidgets(next);
  };

  // localStorage-backed signals (recents, favorites, icons) → re-render.
  const [version, setVersion] = useState(0);
  useEffect(() => subscribeRecents(() => setVersion((v) => v + 1)), []);
  useEffect(() => subscribeFavorites(() => setVersion((v) => v + 1)), []);
  useEffect(() => subscribePageIcon(() => setVersion((v) => v + 1)), []);

  // The greeting renders post-mount state only (Date at render would differ
  // between server HTML and hydration around boundaries) — start neutral.
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => setNow(new Date()), []);

  const firstName = (profile.displayName.trim() || profile.name.trim()).split(/\s+/)[0] ?? '';
  const greeting = now
    ? t(`home.${greetingKey(now.getHours())}`) + (firstName ? `, ${firstName}` : '')
    : '';
  const dateLine = now
    ? new Intl.DateTimeFormat(locale, {weekday: 'long', month: 'long', day: 'numeric'}).format(now)
    : '';

  const byId = useMemo(() => new Map(pages.map((p) => [p.id, p] as const)), [pages]);
  const recents = useMemo(() => {
    void version;
    return readRecents()
      .map((id) => byId.get(id))
      .filter((p): p is PageMeta => !!p)
      .slice(0, 6);
  }, [byId, version]);
  const favorites = useMemo(() => {
    void version;
    return readFavorites()
      .map((id) => byId.get(id))
      .filter((p): p is PageMeta => !!p)
      .slice(0, 6);
  }, [byId, version]);
  const edited = useMemo(
    () => [...pages].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 6),
    [pages],
  );

  const quickActions = [
    {icon: FilePlus, label: t('nav.newPage'), run: () => void createPage()},
    {icon: Database, label: t('nav.newDatabase'), run: () => void createDatabasePage()},
    {
      icon: Search,
      label: t('command.search'),
      run: () =>
        setHud((draft) => {
          draft.commandPalette.open = true;
          return draft;
        }),
    },
  ];

  const WIDGET_LABELS: Array<{key: keyof HomeWidgets; label: string}> = [
    {key: 'actions', label: t('home.widgetActions')},
    {key: 'recents', label: t('home.widgetRecents')},
    {key: 'favorites', label: t('home.widgetFavorites')},
    {key: 'edited', label: t('home.widgetEdited')},
  ];

  return (
    <div className="w-full px-6 pb-24 pt-16 md:px-10" data-home-screen>
      <div className="mx-auto w-full max-w-content">
        <header className="mb-10 flex items-start justify-between gap-4">
          <div className={cn('transition-opacity duration-300', now ? 'opacity-100' : 'opacity-0')}>
            <h1 className="text-3xl font-semibold tracking-tight" data-home-greeting>
              {greeting}
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">{dateLine}</p>
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <IconButton aria-label={t('home.customize')} title={t('home.customize')}>
                <SlidersHorizontal className="h-4 w-4" />
              </IconButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              <DropdownMenuLabel>{t('home.customize')}</DropdownMenuLabel>
              {WIDGET_LABELS.map(({key, label}) => (
                <DropdownMenuCheckboxItem
                  key={key}
                  checked={widgets[key]}
                  onCheckedChange={(on) => setWidget(key, on)}
                  onSelect={(e) => e.preventDefault()}
                >
                  {label}
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </header>

        <div className="flex flex-col gap-8">
          {widgets.actions && (
            <section className="flex flex-col gap-2.5" data-home-widget="actions">
              <WidgetHeading icon={FilePlus}>{t('home.widgetActions')}</WidgetHeading>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                {quickActions.map(({icon: Icon, label, run}) => (
                  <button
                    key={label}
                    type="button"
                    onClick={run}
                    className="flex items-center gap-2.5 rounded-lg border border-dashed border-border px-3 py-2.5 text-left text-sm text-muted-foreground transition-[background-color,border-color,color,box-shadow,transform] hover:-translate-y-px hover:border-solid hover:border-foreground/15 hover:bg-hover hover:text-foreground hover:shadow-lift active:translate-y-0 active:shadow-none focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                  >
                    <Icon className="h-4 w-4 shrink-0" />
                    {label}
                  </button>
                ))}
              </div>
            </section>
          )}

          {widgets.recents && recents.length > 0 && (
            <section className="flex flex-col gap-2.5" data-home-widget="recents">
              <WidgetHeading icon={Clock}>{t('home.widgetRecents')}</WidgetHeading>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {recents.map((page) => (
                  <PageTile key={page.id} page={page} onOpen={selectPage} />
                ))}
              </div>
            </section>
          )}

          {widgets.favorites && favorites.length > 0 && (
            <section className="flex flex-col gap-2.5" data-home-widget="favorites">
              <WidgetHeading icon={Star}>{t('home.widgetFavorites')}</WidgetHeading>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {favorites.map((page) => (
                  <PageTile key={page.id} page={page} onOpen={selectPage} />
                ))}
              </div>
            </section>
          )}

          {widgets.edited && edited.length > 0 && (
            <section className="flex flex-col gap-2.5" data-home-widget="edited">
              <WidgetHeading icon={Pencil}>{t('home.widgetEdited')}</WidgetHeading>
              <div className="flex flex-col">
                {edited.map((page) => (
                  <button
                    key={page.id}
                    type="button"
                    onClick={() => selectPage(page.id)}
                    className="flex items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-hover"
                  >
                    <span className="text-base leading-none" aria-hidden>
                      {readPageIcon(page.id)}
                    </span>
                    <span className="min-w-0 grow truncate text-sm">{displayName(page.name)}</span>
                    <span className="shrink-0 text-xs text-muted-foreground/70">{timeAgo(page.updatedAt)}</span>
                  </button>
                ))}
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
