import {useSideNav} from '@/providers';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu';
import {Button} from '@/components/ui/button';
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  DotsVerticalIcon,
  DoubleArrowLeftIcon,
  HamburgerMenuIcon, SlashIcon
} from "@radix-ui/react-icons";

export default function NavBar() {
  const {sideNav, setSideNav} = useSideNav();
  return (
    <>
      <div
        className="w-full top-0 sticky z-10"
      >
        <nav
          className="sticky top-0 bg-background filter backdrop-blur-lg"
        >
          <div
            className="flex items-center justify-between px-4 py-1"
          >
            <div
              className="flex items-center gap-x-2"
            >
              <Button
                variant="outline"
                className="px-2 py-1"
                onClick={() => setSideNav({...sideNav, open: !sideNav.open})}
              >
                {sideNav.open ? <DoubleArrowLeftIcon className="h-4 w-4"/> :<HamburgerMenuIcon className="h-4 w-4"/>}
              </Button>
              <div
              >
                <Button
                  variant="outline"
                  className="px-2 py-1"
                >
                  <ChevronLeftIcon className="h-4 w-4"/>
                </Button>
                <Button
                  variant="outline"
                  className="px-2 py-1"
                >
                  <ChevronRightIcon className="h-4 w-4"/>
                </Button>
              </div>
              <nav className="flex" aria-label="Breadcrumb">
                <ol className="inline-flex items-center space-x-1 md:space-x-3">
                  {[
                    {emoji: '💼', title: 'Workspace 1'},
                    {emoji: '🏠', title: 'Home'},
                    {emoji: '📄', title: 'Untitled Page'},
                  ].map((pageDetails) => (
                    <li className="inline-flex items-center" key={`breadcrumb-${pageDetails.title}`}>
                      <div className="flex items-center">
                        <a href="#"
                          className="ml-1 text-sm font-medium text-gray-700 hover:text-blue-600 md:ml-2 dark:text-gray-400 dark:hover:text-white">
                          {pageDetails.emoji} {pageDetails.title}
                        </a>
                      </div>
                    </li>
                  )
                  ).flatMap((element, index) => [
                    index > 0 && (
                      <SlashIcon className=""/>
                    ),
                    element,
                  ])}
                </ol>
              </nav>
            </div>
            <div className="relative inline-block text-left">
              <DropdownMenu>
                <DropdownMenuTrigger>
                  <Button
                    variant="outline"
                    className="px-2 py-1"
                  >
                    <DotsVerticalIcon className="h-4 w-4"/>
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent>
                  <DropdownMenuLabel>My Account</DropdownMenuLabel>
                  <DropdownMenuSeparator/>
                  <DropdownMenuItem>Favourite</DropdownMenuItem>
                  <DropdownMenuItem>Settings</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>

          </div>

        </nav>
      </div>
    </>
  );
}