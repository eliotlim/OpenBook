import EmojiPicker, {Theme} from 'emoji-picker-react';
import React, {useEffect, useRef, useState} from 'react';
import {useHud, useTheme} from '@/providers';
import {Popover, PopoverContent, PopoverTrigger} from '@/components/ui/popover';
import {Button} from '@/components/ui/button';
// Type-only imports: the EditorJS class is loaded dynamically (client-only)
// inside the effect below, so importing this module never pulls EditorJS's
// browser-dependent bundle during SSR (e.g. the Next.js web shell). The default
// import is kept type-only so `EditorJS` is usable as the instance type.
import type EditorJS from '@editorjs/editorjs';
import type {OutputData} from '@editorjs/editorjs';
import {SliderBlock, ExprBlock, ChartBlock} from '@/reactive';
import {store} from '@/reactive/ReactiveStore';
import type {PageSnapshot} from '@open-book/sdk';

// The document save format (`PageSnapshot`) is defined in `@open-book/sdk` so
// the server, persistence clients, and the editor share one source of truth.

export interface PageDocumentProps {
  /**
   * Called whenever the document content changes (debounced ~800ms).
   * The host (Tauri app) is responsible for serializing this to disk.
   * If omitted, save is a no-op (useful for the web shell where there
   * is no filesystem).
   */
  onSave?: (snap: PageSnapshot) => void | Promise<void>;
  /**
   * Returns the saved document (or null if none exists). Called once on
   * mount before EditorJS initializes.
   */
  onLoad?: () => Promise<PageSnapshot | null>;
}

const PageCover = () => {
  return <div className="bg-background text-foreground h-[10vh] w-full" />;
};

const PageHeader = () => {
  const {colorScheme} = useTheme();
  const [emoji, setEmoji] = React.useState('📝');
  return (
    <div className="flex items-center justify-start gap-4 px-4 py-2">
      <Popover>
        <PopoverTrigger>
          <Button variant="outline" className="px-2 py-6">
            <h1 className="text-4xl">{emoji}</h1>
          </Button>
        </PopoverTrigger>
        <PopoverContent className="p-0 m-0 border-0 z-40">
          <EmojiPicker
            onEmojiClick={(e) => {
              setEmoji(e.emoji);
            }}
            theme={colorScheme === 'light' ? Theme.LIGHT : Theme.DARK}
          />
        </PopoverContent>
      </Popover>
      <h1 className="text-4xl">Untitled Page</h1>
    </div>
  );
};

const isSSR = () => typeof window === 'undefined';

const PageDocument: React.FC<PageDocumentProps> = ({onSave, onLoad}) => {
  'use client';
  const {hud} = useHud();

  const editorJsInstance = useRef<EditorJS | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [status, setStatus] = useState<string>('initializing');

  useEffect(() => {
    let cancelled = false;

    const init = async () => {
      // Load saved snapshot first, then hydrate the store and pass the saved
      // blocks (including their IDs) into the EditorJS constructor. Block IDs
      // round-trip so the same cellIds are reassigned to the same blocks on
      // reload — critical for the saved `values` map to line up with the
      // blocks' cellIds at runtime.
      let initialData: OutputData | undefined;
      if (onLoad) {
        try {
          const snap = await onLoad();
          if (snap) {
            store.hydrate({values: snap.values, names: snap.names});
            // `editorjs` is opaque (`unknown`) in the SDK snapshot type; it is
            // the EditorJS OutputData this editor produced when saving.
            initialData = snap.editorjs as OutputData;
          }
        } catch (e) {
          // Load failure: start with an empty doc rather than crashing.
          console.error('PageDocument: load failed:', e);
        }
      }
      if (cancelled) return;

      // Load EditorJS lazily on the client only.
      const {default: EditorJSCtor} = await import('@editorjs/editorjs');
      if (cancelled) return;

      const editorJs = new EditorJSCtor({
        holder: 'editorJs',
        autofocus: true,
        data: initialData,
        tools: {
          slider: SliderBlock as unknown as never,
          expr: ExprBlock as unknown as never,
          chart: ChartBlock as unknown as never,
        },
        onReady: () => {
          editorJsInstance.current = editorJs;
          setStatus('ready');
        },
        onChange: () => {
          setStatus('unsaved');
          if (saveTimer.current) clearTimeout(saveTimer.current);
          saveTimer.current = setTimeout(() => {
            void doSave();
          }, 800);
        },
      });
    };

    const doSave = async () => {
      const inst = editorJsInstance.current;
      if (!inst || !onSave) return;
      try {
        const editorjs = await inst.save();
        const snap = store.snapshot();
        await onSave({editorjs, values: snap.values, names: snap.names});
        setStatus('saved');
      } catch (e) {
        console.error('PageDocument: save failed:', e);
        setStatus('save failed');
      }
    };

    void init();

    return () => {
      cancelled = true;
      if (saveTimer.current) clearTimeout(saveTimer.current);
      editorJsInstance.current?.destroy();
      editorJsInstance.current = null;
    };
  }, [onSave, onLoad]);

  return (
    <div className={hud.viewMode.fullWidth ? 'w-full' : 'container mx-auto'}>
      <PageCover />
      <PageHeader />
      <div style={{padding: '0 16px', fontSize: '11px', color: '#888', textAlign: 'right'}}>{status}</div>
      {!isSSR() && (
        <div className="h-fill">
          <div id={'editorJs'} />
        </div>
      )}
    </div>
  );
};

export default PageDocument;
