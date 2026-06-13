import BackForwardCluster from '@/components/BackForwardCluster';
import SideNavToggle from '@/components/SideNavToggle';
import BreadcrumbCluster from '@/components/BreadcrumbCluster';
import PageActionsCluster from '@/components/PageActionsCluster';
import WindowActionsCluster from '@/components/WindowActionsCluster';
import {useNavigation} from '@/providers';

export default function NavBar() {
  // On desktop the sidebar toggle and back/forward live in the titlebar instead,
  // and so does the page-actions cluster (status / copy / star / "…"). On the
  // web there's no titlebar, so that cluster stays here in the nav bar.
  const {inWindowTabs} = useNavigation();
  return (
    <nav className="sticky top-0 z-40 flex h-12 items-center justify-between gap-2 border-b border-border bg-background/80 px-2 backdrop-blur-md print:hidden">
      <div className="flex min-w-0 items-center gap-1">
        {!inWindowTabs && <SideNavToggle />}
        {!inWindowTabs && <BackForwardCluster />}
        <BreadcrumbCluster />
      </div>
      <div className="flex items-center gap-1">
        <WindowActionsCluster />
        {!inWindowTabs && <PageActionsCluster />}
      </div>
    </nav>
  );
}
