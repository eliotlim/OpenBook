import {
  MenuOpen,
  MenuOutlined, MoreVert, Settings
} from "@mui/icons-material";
import {
  Divider,
  Button,
  Stack, Dropdown, MenuButton, Menu, MenuItem, ListItemDecorator,
} from "@mui/joy";

import {useSideNav} from "@/providers";

export default function NavBar() {
  const {sideNav, setSideNav} = useSideNav();
  return (
    <>
      <Stack
        textAlign="center"
        justifyContent="center"
        paddingTop={0.5}
        gap={0.5}
        position="fixed"
        width="100%"
        zIndex={1000}
        sx={{
          backdropFilter: 'blur(10px)',
        }}
      >
        <Stack
          direction="row"
          justifyContent="space-between"
          paddingX={0.5}
        >
          <Stack
            direction="row"
          >
            <Button
              variant="plain"
              size="sm"
              onClick={() => setSideNav({...sideNav, open: !sideNav.open})}
            >
              {sideNav.open ?
                <MenuOpen/> :
                <MenuOutlined/>
              }
            </Button>
          </Stack>
          <Stack
            direction="row"
          >
            <Dropdown>
              <MenuButton
                size="sm"
                variant="plain"
              >
                <MoreVert/>
              </MenuButton>
              <Menu>
                <MenuItem>
                  <ListItemDecorator>
                    <Settings/>
                  </ListItemDecorator>
                  Settings
                </MenuItem>
              </Menu>
            </Dropdown>
          </Stack>
        </Stack>
        <Divider/>
      </Stack>
    </>
  )
}