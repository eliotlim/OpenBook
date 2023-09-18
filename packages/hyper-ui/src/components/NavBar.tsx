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

export default function NavBar() {
  const {sideNav, setSideNav} = useSideNav();
  return (
    <>
      <div
        className="w-full top-0 sticky z-10"
      >
        <nav
          className="sticky top-0 bg-gray-100 dark:bg-gray-900 opacity-90 filter backdrop-blur-lg dark:backdrop-blur-lg"
        >
          <div
            className="flex items-center justify-between px-4 py-1"
          >
            <div
              className="flex items-center gap-x-2"
            >
              <Button
                className="bg-gray-100 dark:bg-gray-800 hover:dark:bg-gray-700 hover:bg-gray-300 dark:bg-gray-900 text-white rounded-md px-3 py-2"
                onClick={() => setSideNav({...sideNav, open: !sideNav.open})}
              >
                {sideNav.open ?
                  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth="1.5"
                    stroke="currentColor" className="w-6 h-6">
                    <path strokeLinecap="round" strokeLinejoin="round"
                      d="M18.75 19.5l-7.5-7.5 7.5-7.5m-6 15L5.25 12l7.5-7.5"/>
                  </svg>
                  :
                  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth="1.5"
                    stroke="currentColor" className="w-6 h-6">
                    <path strokeLinecap="round" strokeLinejoin="round"
                      d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5"/>
                  </svg>
                }
              </Button>
              <div
              >
                <Button
                  className="hover:dark:bg-gray-700 hover:bg-gray-300 dark:bg-gray-900 text-white rounded-md px-3 py-2"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth="1.5"
                    stroke="currentColor" className="w-6 h-6">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5"/>
                  </svg>
                </Button>
                <Button
                  className="hover:dark:bg-gray-700 hover:bg-gray-300 dark:bg-gray-900 text-white rounded-md px-3 py-2"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth="1.5"
                    stroke="currentColor" className="w-6 h-6">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5"/>
                  </svg>
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
                      <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth="1.5"
                        stroke="currentColor" className="w-6 h-6">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5"/>
                      </svg>
                    ),
                    element,
                  ])}
                </ol>
              </nav>
            </div>
            <div className="relative inline-block text-left">
              <DropdownMenu>
                <DropdownMenuTrigger>
                  <Button variant="outline">
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth="1.5"
                      stroke="currentColor" className="w-6 h-6">
                      <path strokeLinecap="round" strokeLinejoin="round"
                        d="M12 6.75a.75.75 0 110-1.5.75.75 0 010 1.5zM12 12.75a.75.75 0 110-1.5.75.75 0 010 1.5zM12 18.75a.75.75 0 110-1.5.75.75 0 010 1.5z"/>
                    </svg>
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