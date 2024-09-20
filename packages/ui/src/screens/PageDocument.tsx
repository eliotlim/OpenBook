import EmojiPicker, {Theme} from 'emoji-picker-react';
import React, {useEffect, useRef} from 'react';
import {useHud, useTheme} from '@/providers';
import {Popover, PopoverContent, PopoverTrigger} from '@/components/ui/popover';
import {Button} from '@/components/ui/button';
import EditorJS from '@editorjs/editorjs';

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

const isSSR = () => typeof window === 'undefined';

const PageDocument = () => {
  'use client';
  const {hud} = useHud();

  let editorJsInstance = useRef<EditorJS>();

  useEffect(() => {
    const editorJs = new EditorJS({
      holder: 'editorJs',
      onReady: () => {
        editorJsInstance.current = editorJs;
      },
      autofocus: true,
    });

    return () => {
      editorJsInstance.current?.destroy();
    };
  }, []);

  return (
    <div
      className={hud.viewMode.fullWidth ? 'w-full' : 'container mx-auto'}
    >
      <PageCover/>
      <PageHeader/>
      {!isSSR() && <div className="h-fill">
        <div id={"editorJs"} />
      </div>
      }
    </div>
  );
};

export default PageDocument;
