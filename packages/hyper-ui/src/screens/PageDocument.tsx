import {Editor} from 'novel';
import EmojiPicker, {Theme} from 'emoji-picker-react';
import React from 'react';
import {Menu} from '@headlessui/react';
import {useTheme} from "@/providers";

const PageDocument = () => {
  const {colorScheme} = useTheme();

  const [emoji, setEmoji] = React.useState('📝');
  return (
    <div
      className="bg-white dark:bg-gray-900 dark:text-gray-300 py-10"
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
        className={`relative min-h-[500px] max-w-screen-lg border-stone-200 sm:mb-[calc(20vh)] sm:rounded-lg sm:border sm:shadow-lg w-full h-full bg-white dark:bg-gray-900 dark:border-gray-800 dark:shadow-lg dark:text-gray-300`}
      />
    </div>
  );
};

export default PageDocument;
