import {Editor} from 'novel';
import EmojiPicker, {Theme} from 'emoji-picker-react';
import {Container, Dropdown, Menu, MenuButton, Stack, Typography, useColorScheme} from '@mui/joy';
import React from 'react';

const PageDocument = () => {
  const { colorScheme } = useColorScheme();
  const [emoji, setEmoji] = React.useState('📝');
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
                  theme={colorScheme === 'light' ? Theme.LIGHT : Theme.DARK}
                />
              </Menu>
            </Dropdown>
            <Typography level="h1">
              Untitled Page
            </Typography>
          </Stack>
        </Container>
      </Stack>
      <Editor
        className=""
      />
    </Stack>
  );
};

export default PageDocument;
