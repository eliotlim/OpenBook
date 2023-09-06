import {
  MenuOpen,
  MenuOutlined
} from "@mui/icons-material";
import {
  Divider,
  Button,
  Stack,
} from "@mui/joy";

import {ModeToggle} from "../ModeToggle";
import React from "react";

export default function NavBar() {
  const [menuOpen, setMenuOpen] = React.useState(false);
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
          <Button
            variant="plain"
            size="sm"
            onClick={() => setMenuOpen(!menuOpen)}
          >
            {menuOpen ?
              <MenuOpen/> :
              <MenuOutlined/>
            }
          </Button>
          <ModeToggle/>
        </Stack>
        <Divider/>
      </Stack>
    </>
  )
}