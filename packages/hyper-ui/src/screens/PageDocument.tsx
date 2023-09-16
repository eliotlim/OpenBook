import {Editor} from 'novel';
import EmojiPicker, {Theme} from 'emoji-picker-react';
import React from 'react';
import {Menu} from "@headlessui/react";

const PageDocument = () => {
  const colorScheme = 'light';
  const [emoji, setEmoji] = React.useState('📝');
  return (
    <div
      className=""
    >
      <div
        style={{
          paddingTop: 15,
        }}
        className="flex"
      >
        <div
          className="flex"
        >
          <div
            className="relative inline-block text-left"
          >
            <Menu>
              <Menu.Button>
                <h1 className="text-4xl">{emoji}</h1>
              </Menu.Button>
              <Menu.Items
              >
                <EmojiPicker
                  onEmojiClick={(e) => {
                    setEmoji(e.emoji);
                  }}
                  theme={colorScheme === 'light' ? Theme.LIGHT : Theme.DARK}
                />
              </Menu.Items>
            </Menu>
            <h1
              className="text-4xl"
            >
              Untitled Page
            </h1>
          </div>
        </div>
      </div>
      <Editor
        className=""
      />
    </div>
  );
};

export default PageDocument;
