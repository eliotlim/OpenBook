import {Editor} from 'novel';
import EmojiPicker, {Theme} from 'emoji-picker-react';
import React from 'react';
import {useHud, useTheme} from '@/providers';
import {Popover, PopoverContent, PopoverTrigger} from '@/components/ui/popover';
import {Button} from '@/components/ui/button';

const PageCover = () => {
  return (
    <div
      className="bg-background text-foreground h-[10vh] w-full"
    >
    </div>
  );
};

const PageHeader = () => {
  const {colorScheme} = useTheme();
  const [emoji, setEmoji] = React.useState('📝');
  return (
    <div
      className="flex items-center justify-start gap-4 px-4 py-2"
    >
      <Popover>
        <PopoverTrigger>
          <Button
            variant="outline"
            className="px-2 py-6"
          >
            <h1 className="text-4xl">{emoji}</h1>
          </Button>
        </PopoverTrigger>
        <PopoverContent
          className="p-0 m-0 border-0 z-40"
        >
          <EmojiPicker
            onEmojiClick={(e) => {
              setEmoji(e.emoji);
            }}
            theme={colorScheme === 'light' ? Theme.LIGHT : Theme.DARK}
          />
        </PopoverContent>
      </Popover>
      <h1
        className="text-4xl"
      >
        Untitled Page
      </h1>
    </div>
  );
};

const PageDocument = () => {
  const {hud} = useHud();

  return (
    <div
      className={hud.viewMode.fullWidth ? "w-full" : "container mx-auto"}
    >
      <PageCover/>
      <PageHeader/>
      <Editor
        className={'bg-background text-foreground'}
      />
    </div>
  );
};

export default PageDocument;
