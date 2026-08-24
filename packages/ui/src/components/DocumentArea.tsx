import {ScrollArea} from '@/components/ui/scroll-area';
import {ConnectedPageDocument, HomeScreen, TrashScreen} from '@/screens';
import {useNavigation} from '@/providers';
import {HOME_PAGE_ID, TRASH_PAGE_ID} from '@/lib/homePage';
import {cn} from '@/lib/utils';
import {Button} from '@/components/ui/button';
import {CloudOff} from 'lucide-react';
import {t} from '@/i18n';
import {libraryHostLabel, useLibrary} from '@/providers/LibraryProvider';

/**
 * The document workspace for this window: the primary page. Tabs themselves
 * are native (browser tabs on web, macOS window-tabs on desktop) — each
 * window runs one of these. The split view's secondary page renders as a
 * full-height side pane ({@link SplitPane} in the layout), not here, so the
 * primary keeps the NavBar and full width when alone.
 */
export default function DocumentArea() {
  const {panes, focusedPaneId, splitOpen, focusPane, loading, error, siteOffline, retryInitialLoad} = useNavigation();
  const {library} = useLibrary();

  if (loading) return null;
  if (error) {
    const host = library.serverUrl ? libraryHostLabel(library.serverUrl) : null;
    const libraryLabel = host && library.name !== host ? `${library.name} · ${host}` : host ?? library.name;
    return (
      <section className="flex h-full min-h-0 w-full items-center justify-center px-6 py-20" role="alert">
        <div className="flex max-w-sm flex-col items-center gap-4 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
            <CloudOff className="h-6 w-6" aria-hidden />
          </div>
          <div className="space-y-1.5">
            <h2 className="text-lg font-semibold text-foreground">{t('navigation.loadError.title')}</h2>
            <p className="text-[15px] leading-relaxed text-muted-foreground">
              {t(library.serverUrl == null
                ? 'navigation.loadError.localUnreachable'
                : siteOffline
                  ? 'navigation.loadError.siteOffline'
                  : 'navigation.loadError.unreachable')}
            </p>
            {libraryLabel && <p className="text-xs text-muted-foreground/70">{libraryLabel}</p>}
          </div>
          <Button onClick={retryInitialLoad}>{t('navigation.loadError.retry')}</Button>
        </div>
      </section>
    );
  }
  if (panes.length === 0) return null;
  const pane = panes[0];

  return (
    <section
      onMouseDownCapture={() => focusPane(pane.id)}
      className={cn(
        'relative flex h-full min-h-0 w-full min-w-0 flex-col',
        // When split, mark where keyboard focus lives (the side pane rings too).
        splitOpen && pane.id === focusedPaneId && 'ring-1 ring-inset ring-primary/15',
      )}
    >
      <ScrollArea className="min-h-0 flex-1">
        {pane.pageId === HOME_PAGE_ID ? (
          <HomeScreen />
        ) : pane.pageId === TRASH_PAGE_ID ? (
          <TrashScreen />
        ) : (
          <ConnectedPageDocument key={pane.pageId} pageId={pane.pageId} />
        )}
      </ScrollArea>
    </section>
  );
}
