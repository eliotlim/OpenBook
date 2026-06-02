import EmojiPicker, {Theme} from 'emoji-picker-react';
import React, {useEffect, useRef, useState} from 'react';
import {useHud, useTheme} from '@/providers';
import {Popover, PopoverContent, PopoverTrigger} from '@/components/ui/popover';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {cn} from '@/lib/utils';
import {MoreHorizontal, Trash2} from 'lucide-react';
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
  onSave?: (snap: PageSnapshot) => void | Promise<void>;
  onLoad?: () => Promise<PageSnapshot | null>;
  /** Current page title (the page name). Controlled. */
  title?: string;
  /** Called when the title input changes. */
  onTitleChange?: (title: string) => void;
  /** Page icon (emoji). */
  icon?: string;
  /** Called when the icon changes. */
  onIconChange?: (emoji: string) => void;
  /** When provided, enables the delete action in the page menu. */
  onDelete?: () => void;
  /** A newer snapshot pushed from the server to apply live (collaboration). */
  incoming?: {data: PageSnapshot; version: number};
  /** Notifies when the title input gains/loses focus (to avoid clobbering it). */
  onTitleActiveChange?: (active: boolean) => void;
}

const STATUS_LABEL: Record<string, string> = {
  unsaved: 'Saving…',
  saved: 'Saved',
  'save failed': 'Couldn’t save',
};

const isSSR = () => typeof window === 'undefined';

const PageHeader: React.FC<{
  title: string;
  icon: string;
  onTitleChange?: (title: string) => void;
  onIconChange?: (emoji: string) => void;
  onTitleActiveChange?: (active: boolean) => void;
}> = ({title, icon, onTitleChange, onIconChange, onTitleActiveChange}) => {
  const {colorScheme} = useTheme();
  return (
    <div className="pt-2 pb-1">
      <Popover>
        <PopoverTrigger asChild>
          <button
            className="-ml-1 mb-1 inline-flex h-[68px] w-[68px] items-center justify-center rounded-lg text-[3.5rem] leading-none transition-colors hover:bg-accent"
            aria-label="Change page icon"
          >
            <span>{icon || '📄'}</span>
          </button>
        </PopoverTrigger>
        <PopoverContent className="z-50 w-auto border-0 p-0 shadow-lg">
          <EmojiPicker
            onEmojiClick={(e) => onIconChange?.(e.emoji)}
            theme={colorScheme === 'light' ? Theme.LIGHT : Theme.DARK}
          />
        </PopoverContent>
      </Popover>
      <input
        className="w-full bg-transparent text-[2.5rem] font-bold leading-tight tracking-tight outline-none placeholder:text-muted-foreground/35"
        value={title}
        placeholder="Untitled"
        onChange={(e) => onTitleChange?.(e.target.value)}
        onFocus={() => onTitleActiveChange?.(true)}
        onBlur={() => onTitleActiveChange?.(false)}
        aria-label="Page title"
      />
    </div>
  );
};

const PageDocument: React.FC<PageDocumentProps> = ({
  onSave,
  onLoad,
  title = '',
  onTitleChange,
  icon = '📄',
  onIconChange,
  onDelete,
  incoming,
  onTitleActiveChange,
}) => {
  'use client';
  const {hud} = useHud();

  const editorJsInstance = useRef<EditorJS | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Suppresses autosave while a server-pushed update is being applied, so we
  // don't echo it straight back to the server.
  const suppressSaveRef = useRef(false);
  const [status, setStatus] = useState<string>('initializing');
  const statusRef = useRef(status);
  statusRef.current = status;

  useEffect(() => {
    let cancelled = false;

    const init = async () => {
      let initialData: OutputData | undefined;
      if (onLoad) {
        try {
          const snap = await onLoad();
          if (snap) {
            store.hydrate({values: snap.values, names: snap.names});
            initialData = snap.editorjs as OutputData;
          }
        } catch (e) {
          console.error('PageDocument: load failed:', e);
        }
      }
      if (cancelled) return;

      // Load the editor + block tools client-side only.
      const [
        {default: EditorJSCtor},
        {default: Header},
        {default: List},
        {default: Quote},
        {default: Delimiter},
        {default: CodeTool},
        {default: Marker},
        {default: InlineCode},
      ] = await Promise.all([
        import('@editorjs/editorjs'),
        import('@editorjs/header'),
        import('@editorjs/list'),
        import('@editorjs/quote'),
        import('@editorjs/delimiter'),
        import('@editorjs/code'),
        import('@editorjs/marker'),
        import('@editorjs/inline-code'),
      ]);
      if (cancelled) return;

      const editorJs = new EditorJSCtor({
        holder: 'editorJs',
        autofocus: true,
        data: initialData,
        placeholder: 'Write something, or press Tab for blocks…',
        tools: {
          header: {
            class: Header as unknown as never,
            inlineToolbar: true,
            shortcut: 'CMD+SHIFT+H',
            config: {placeholder: 'Heading', levels: [1, 2, 3], defaultLevel: 2},
          },
          list: {class: List as unknown as never, inlineToolbar: true, config: {defaultStyle: 'unordered'}},
          quote: {class: Quote as unknown as never, inlineToolbar: true},
          code: CodeTool as unknown as never,
          delimiter: Delimiter as unknown as never,
          marker: {class: Marker as unknown as never, shortcut: 'CMD+SHIFT+M'},
          inlineCode: {class: InlineCode as unknown as never, shortcut: 'CMD+SHIFT+C'},
          slider: SliderBlock as unknown as never,
          expr: ExprBlock as unknown as never,
          chart: ChartBlock as unknown as never,
        },
        onReady: () => {
          editorJsInstance.current = editorJs;
          setStatus('ready');
        },
        onChange: () => {
          if (suppressSaveRef.current) return;
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

  // Apply a server-pushed snapshot live (collaboration), unless the local user
  // is mid-edit. Autosave is suppressed during the re-render so it isn't echoed.
  useEffect(() => {
    if (!incoming) return;
    const inst = editorJsInstance.current;
    if (!inst || statusRef.current === 'initializing' || statusRef.current === 'unsaved') return;
    let cancelled = false;
    void (async () => {
      suppressSaveRef.current = true;
      store.hydrate({values: incoming.data.values, names: incoming.data.names});
      try {
        await inst.render((incoming.data.editorjs ?? {blocks: []}) as OutputData);
      } catch (e) {
        console.error('PageDocument: live update failed:', e);
      }
      if (!cancelled) setStatus('saved');
      setTimeout(() => {
        suppressSaveRef.current = false;
      }, 120);
    })();
    return () => {
      cancelled = true;
    };
  }, [incoming?.version]);

  const statusLabel = STATUS_LABEL[status] ?? '';

  // The title lives in a centered column; the editor is full-width and centers
  // its own content to the same width (so the toolbar/+ stays in the left gutter
  // and EditorJS never enters its narrow, right-aligned layout).
  const columnClass = cn('mx-auto w-full', hud.viewMode.fullWidth ? 'max-w-none' : 'max-w-content');

  return (
    <div className="w-full px-6 pb-40 pt-6 md:px-10">
      <div className={columnClass}>
        {/* Page action bar: subtle save status + overflow menu. */}
        <div className="flex h-8 items-center justify-end gap-2 text-xs text-muted-foreground">
          <span className={cn('transition-opacity', status === 'save failed' && 'text-destructive')}>
            {statusLabel}
          </span>
          {onDelete && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  aria-label="Page actions"
                >
                  <MoreHorizontal className="h-4 w-4" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-44">
                <DropdownMenuItem onClick={onDelete} className="text-destructive focus:text-destructive">
                  <Trash2 className="mr-2 h-4 w-4" />
                  Delete page
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>

        <PageHeader
          title={title}
          icon={icon}
          onTitleChange={onTitleChange}
          onIconChange={onIconChange}
          onTitleActiveChange={onTitleActiveChange}
        />
      </div>

      {!isSSR() && <div id="editorJs" className="min-h-[40vh]" />}
    </div>
  );
};

export default PageDocument;
