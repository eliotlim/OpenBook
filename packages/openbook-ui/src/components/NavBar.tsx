import BackForwardCluster from '@/components/BackForwardCluster';
import SideNavToggle from '@/components/SideNavToggle';
import BreadcrumbCluster from '@/components/BreadcrumbCluster';
import NavContextMenu from '@/components/NavContextMenu';

export default function NavBar() {
  return (
    <>
      <nav
        className="top-0 sticky z-50 bg-popover border-b dark:border-gray-700 shadow-md dark:shadow-md dark:shadow-black flex items-center justify-between px-0.5 py-0.5"
      >
        <div
          className="flex items-center gap-x-2"
        >
          <SideNavToggle/>
          <BackForwardCluster/>
          <BreadcrumbCluster/>
        </div>
        <div className="relative inline-block text-left">
          <NavContextMenu/>
        </div>
      </nav>
    </>
  );
}