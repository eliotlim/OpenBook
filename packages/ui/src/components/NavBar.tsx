import BackForwardCluster from '@/components/BackForwardCluster';
import SideNavToggle from '@/components/SideNavToggle';
import BreadcrumbCluster from '@/components/BreadcrumbCluster';
import PageActionsCluster from '@/components/PageActionsCluster';
import WindowActionsCluster from '@/components/WindowActionsCluster';
import {useNavigation} from '@/providers';

export default function NavBar() {
  // On desktop the sidebar toggle and back/forward live in the titlebar instead.
  // The page-actions cluster ("…" menu + status/copy/star) lives here in the
  // breadcrumb nav bar on every platform, acting on the *primary* pane; the
  // split view's right pane carries its own cluster (see SplitPane).
  const {inWindowTabs, panes, currentPageId} = useNavigation();
  const primaryPageId = panes[0]?.pageId ?? currentPageId;
  return (
    <nav className="sticky top-0 z-40 flex h-12 items-center justify-between gap-2 border-b border-border bg-background/80 px-2 backdrop-blur-md print:hidden">
      <div className="flex min-w-0 items-center gap-1">
        {!inWindowTabs && <SideNavToggle />}
        {!inWindowTabs && <BackForwardCluster />}
        <BreadcrumbCluster />
      </div>
      <div className="flex items-center gap-1">
        <WindowActionsCluster />
        <PageActionsCluster pageId={primaryPageId} />
      </div>
    </nav>
  );
}
