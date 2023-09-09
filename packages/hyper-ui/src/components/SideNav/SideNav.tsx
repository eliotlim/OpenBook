import {Drawer} from "@/components/Drawer";
import {useSideNav} from "@/providers";
import {
  Dropdown,
  ListItemDecorator,
  Menu,
  MenuButton,
  MenuItem,
  Stack,
  useColorScheme
} from "@mui/joy";
import {
  ArrowDropDown,
  Brightness1,
  Brightness7,
  BrightnessAuto, Workspaces
} from "@mui/icons-material";

export default function SideNav() {
  const {mode, setMode} = useColorScheme();
  const {sideNav, setSideNav} = useSideNav();
  return (
    <>
      <Drawer
        title={"Workspaces"}
        open={sideNav.open}
        slotProps={{
          backdrop: {
            sx: {
              opacity: 0,
              backdropFilter: 'none',
            },
          },
        }}
        onClose={() => {
          setSideNav({
            ...sideNav,
            open: false
          });
        }}
        docked={sideNav.docked}
      >
        <Stack
          gap={0.5}
          height="100%"
          justifyContent="space-between"
        >
          <Stack
            direction="column"
          >
            <Dropdown>
              <MenuButton
                size="lg"
                variant="plain"
              >
                Workspaces
              </MenuButton>
              <Menu
                size="lg"
                style={{
                  zIndex: 2000,
                }}
              >
                <MenuItem>
                  <ListItemDecorator>
                    <Workspaces/>
                  </ListItemDecorator>
                  Workspace 1
                </MenuItem>
                <MenuItem>
                  <ListItemDecorator>
                    <Workspaces/>
                  </ListItemDecorator>
                  Workspace 2
                </MenuItem>
                <MenuItem>
                  <ListItemDecorator>
                    <Workspaces/>
                  </ListItemDecorator>
                  Workspace 3
                </MenuItem>
              </Menu>
            </Dropdown>
          </Stack>
          <Stack
            direction="column"
            style={{
              height: '5rem',
            }}
          >
            <Dropdown>
              <MenuButton
                size="sm"
                variant="plain"
                startDecorator={mode === "light" ? <Brightness7/>: mode === "dark" ? <Brightness1/> : <BrightnessAuto/> }
                endDecorator={<ArrowDropDown/>}
              >
                {`${(mode ?? ' ').substring(0, 1).toUpperCase()}${(mode ?? ' ').substring(1)} Mode`}
              </MenuButton>
              <Menu
                size="sm"
                style={{
                  zIndex: 2000,
                }}
              >
                <MenuItem onClick={() => setMode('light')}>
                  <ListItemDecorator>
                    <Brightness7/>
                  </ListItemDecorator>
                  Light Mode
                </MenuItem>
                <MenuItem onClick={() => setMode('dark')}>
                  <ListItemDecorator>
                    <Brightness1/>
                  </ListItemDecorator>
                  Dark Mode
                </MenuItem>
                <MenuItem onClick={() => setMode('system')}>
                  <ListItemDecorator>
                    <BrightnessAuto/>
                  </ListItemDecorator>
                  System Mode
                </MenuItem>
              </Menu>
            </Dropdown>
          </Stack>
        </Stack>
      </Drawer>
    </>
  )
}