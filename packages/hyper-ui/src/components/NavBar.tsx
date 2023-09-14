import {
  Favorite,
  KeyboardArrowLeft,
  KeyboardArrowRight,
  MenuOpen,
  MenuOutlined,
  MoreVert,
  Settings} from '@mui/icons-material';
import {
  Breadcrumbs,
  Button, ButtonGroup,
  Divider,
  Dropdown,
  ListItemDecorator,
  Menu,
  MenuButton,
  MenuItem,
  Stack,
  useColorScheme,
} from '@mui/joy';

import {useSideNav} from '@/providers';

export default function NavBar() {
  const {colorScheme} = useColorScheme();
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
          backgroundColor: colorScheme === 'light' ? 'rgba(255, 255, 255, 0.7)' : 'rgba(0, 0, 0, 0.7)',
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
              color="neutral"
              variant="plain"
              size="sm"
              onClick={() => setSideNav({...sideNav, open: !sideNav.open})}
            >
              {sideNav.open ?
                <MenuOpen/> :
                <MenuOutlined/>
              }
            </Button>
            <ButtonGroup
              size="sm"
              variant="plain"
            >
              <Button
                sx={{padding: '0.5rem'}}
              >
                <KeyboardArrowLeft/>
              </Button>
              <Button
                sx={{padding: '0.5rem'}}
              >
                <KeyboardArrowRight/>
              </Button>
            </ButtonGroup>
            <Breadcrumbs
              size="sm"
              separator={'/'}
              style={{
                padding: 0,
              }}
            >
              {[
                {emoji: '💼', title: 'Workspace 1'},
                {emoji: '🏠', title: 'Home'},
                {emoji: '📄', title: 'Untitled Page'},
              ].map((pageDetails) => (
                <Button
                  key={pageDetails.title}
                  size="sm"
                  sx={{padding: '0.5rem'}}
                  color={pageDetails.title === 'Untitled Page' ? 'primary' : 'neutral'}
                  variant="plain"
                  startDecorator={<span>{pageDetails.emoji}</span>}
                >
                  {pageDetails.title}
                </Button>
              )
              )}
            </Breadcrumbs>
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
              <Menu
                size="sm"
              >
                <MenuItem>
                  <ListItemDecorator>
                    <Favorite/>
                  </ListItemDecorator>
                  Favorite
                </MenuItem>
                <Divider/>
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
  );
}