import Button from "@mui/joy/Button";
import Container from "@mui/joy/Container";
import Divider from "@mui/joy/Divider";
import Stack from "@mui/joy/Stack";
import Typography from "@mui/joy/Typography";

import {ModeToggle} from "../ModeToggle";
import React from "react";

export default function NavBar() {
  return (
    <>
      <Stack
        textAlign="center" justifyContent="center" paddingTop={2} gap={2} position="fixed" width="100%" zIndex={1000}
        sx={{
          backdropFilter: 'blur(10px)',
        }}
      >
        <Container>
          <Stack direction="row" justifyContent="space-between">
            <Button
              variant="plain"
            >
              <Typography level="h4">hyper</Typography>
            </Button>
            <ModeToggle/>
          </Stack>
        </Container>
        <Divider/>
      </Stack>
    </>
  )
}