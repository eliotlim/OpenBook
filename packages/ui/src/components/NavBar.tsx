import BackForwardCluster from '@/components/BackForwardCluster';
import SideNavToggle from '@/components/SideNavToggle';
import BreadcrumbCluster from '@/components/BreadcrumbCluster';
import NavContextMenu from '@/components/NavContextMenu';

export default function NavBar() {
  return (
    <nav className="sticky top-0 z-40 flex h-12 items-center justify-between gap-2 border-b border-border bg-background/80 px-2 backdrop-blur-md">
      <div className="flex min-w-0 items-center gap-1">
        <SideNavToggle />
        <BackForwardCluster />
        <BreadcrumbCluster />
      </div>
      <div className="flex items-center">
        <NavContextMenu />
      </div>
    </nav>
  );
}
