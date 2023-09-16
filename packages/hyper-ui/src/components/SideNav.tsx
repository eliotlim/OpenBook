import {Drawer} from '@/components';
import {useSideNav} from '@/providers';
import {
  useColorScheme
} from '@mui/joy';
import {Menu} from '@headlessui/react';

export default function SideNav() {
  const {mode, setMode} = useColorScheme();
  const {sideNav} = useSideNav();
  return (
    <>
      <Drawer
        open={sideNav.open}
        docked={sideNav.docked}
      >
        <div
          className="flex flex-col "
        >
          <div
            className="flex flex-col gap-y-2"
          >
            <Menu>
              <Menu.Button
                className="p-2 rounded bg-gray-200 dark:bg-gray-800 hover:bg-gray-100 dark:hover:bg-gray-600"
              >
                Workspaces
              </Menu.Button>
              <Menu.Items
              >
                <Menu.Item><div className="flex p-2 rounded hover:bg-gray-100 dark:hovuer:bg-gray-600">
                  <div className="flex items-center h-5">
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" className="w-6 h-6">
                      <path stroke-linecap="round" stroke-linejoin="round" d="M12 21a9.004 9.004 0 008.716-6.747M12 21a9.004 9.004 0 01-8.716-6.747M12 21c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3m0 0a8.997 8.997 0 017.843 4.582M12 3a8.997 8.997 0 00-7.843 4.582m15.686 0A11.953 11.953 0 0112 10.5c-2.998 0-5.74-1.1-7.843-2.918m15.686 0A8.959 8.959 0 0121 12c0 .778-.099 1.533-.284 2.253m0 0A17.919 17.919 0 0112 16.5c-3.162 0-6.133-.815-8.716-2.247m0 0A9.015 9.015 0 013 12c0-1.605.42-3.113 1.157-4.418" />
                    </svg>
                  </div>
                  <div className="ml-2 text-sm">
                    <label htmlFor="helper-checkbox-1" className="font-medium text-gray-900 dark:text-gray-300">
                      <div>Workspace 1</div>
                      <p id="helper-checkbox-text-1" className="text-xs font-normal text-gray-500 dark:text-gray-300">https://workspace1.hyper.app</p>
                    </label>
                  </div>
                </div>
                </Menu.Item>
              </Menu.Items>
            </Menu>
          </div>
          <div
            className="justify-end"
          >
            <Menu>
              <Menu.Button>
                {`${(mode ?? ' ').substring(0, 1).toUpperCase()}${(mode ?? ' ').substring(1)} Mode`}
              </Menu.Button>
              <Menu.Items
                className="z-50"
              >
                <Menu.Item>
                  <button onClick={() => setMode('light')}>
                    Light Mode
                  </button>
                </Menu.Item>
                <Menu.Item>
                  <button onClick={() => setMode('dark')}>
                    Dark Mode
                  </button>
                </Menu.Item>
                <Menu.Item>
                  <button onClick={() => setMode('system')}>
                    System Mode
                  </button>
                </Menu.Item>
              </Menu.Items>
            </Menu>
          </div>
        </div>
      </Drawer>
    </>
  );
}