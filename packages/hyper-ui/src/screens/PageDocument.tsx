import {Editor} from 'novel';
import EmojiPicker from 'emoji-picker-react';
import {Container, Dropdown, Menu, MenuButton, Stack, Typography} from "@mui/joy";
import React from "react";

const PageDocument = () => {
  const [emoji, setEmoji] = React.useState("📝");
  return (
    <Stack
      gap={3}
    >
      <Stack
        sx={{
          paddingTop: 15,
        }}
      >
        <Container>
          <Stack
            direction="row"
            alignItems="center"
            gap={2}
          >
            <Dropdown>
              <MenuButton>
                <Typography level="h1">{emoji}</Typography>
              </MenuButton>
              <Menu>
                <EmojiPicker
                  onEmojiClick={(e) => {
                    setEmoji(e.emoji);
                  }}
                />
              </Menu>
            </Dropdown>
            <Typography level="h1">
              Untitled Page
            </Typography>
          </Stack>
        </Container>
      </Stack>
      <Editor/>
    </Stack>
  );
}

export default PageDocument;
