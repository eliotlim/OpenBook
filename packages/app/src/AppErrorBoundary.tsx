import React from 'react';
import {ErrorBoundary, ErrorFallback, HOME_PAGE_ID, clearLastPage} from '@book.dev/ui';

/**
 * The desktop app's top-level render-crash boundary (STAB-3). Without it, any
 * throw during render unmounts the entire React tree — a white screen — and the
 * startup resolver re-opens the same (poisoned) page on the next launch, so the
 * app is stuck in a crash loop. This wraps the whole app so a crash shows a real
 * recovery UI instead, and both actions break the loop:
 *
 *  - "Go to Home" forgets the last-opened page and reloads pointed at Home, so
 *    the poisoned page is never re-opened automatically.
 *  - "Reload" restarts the webview (a page-scoped crash is quarantined by the
 *    page boundary, so the reload lands on Home too).
 *
 * Page-scoped crashes are caught closer to the document by the page boundary in
 * ConnectedPageDocument (nav/sidebar survive); this is the backstop for anything
 * that escapes it — a provider or layout throw.
 */
const goHome = (): void => {
  clearLastPage();
  try {
    const url = new URL(window.location.href);
    url.searchParams.set('page', HOME_PAGE_ID);
    url.searchParams.delete('split');
    url.searchParams.delete('view');
    url.searchParams.delete('paneTarget');
    // Assigning href navigates + reloads, remounting the app fresh on Home.
    window.location.href = `${url.pathname}${url.search}`;
  } catch {
    window.location.reload();
  }
};

export const AppErrorBoundary: React.FC<{children: React.ReactNode}> = ({children}) => (
  <ErrorBoundary
    onError={(error) => {
      console.error('OpenBook: the app crashed while rendering:', error);
      // A crash that escaped the page boundary might still be tied to the last
      // page; forget it so a plain reload doesn't reproduce the crash.
      clearLastPage();
    }}
    fallback={() => <ErrorFallback variant="screen" onHome={goHome} onReload={() => window.location.reload()} />}
  >
    {children}
  </ErrorBoundary>
);

export default AppErrorBoundary;
