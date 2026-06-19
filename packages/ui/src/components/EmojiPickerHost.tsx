import {Suspense, lazy, useSyncExternalStore} from 'react';
import * as PopoverPrimitive from '@radix-ui/react-popover';
import {useTheme} from '@/providers';
import {emojiPicker} from '@/lib/emojiPicker';

const EmojiGrid = lazy(() => import('@/components/EmojiGrid'));

/**
 * The single app-wide emoji grid picker. Mounted once at the app shell; it
 * renders over the {@link emojiPicker} bridge's state, anchored at the rect the
 * caller passed (a 0-area Radix anchor positioned there), so it reuses Radix's
 * collision handling, outside-click and Escape dismissal. The picker itself is
 * lazy so its bundle loads only on first open.
 */
export default function EmojiPickerHost() {
  const {colorScheme} = useTheme();
  const {open, anchor, onPick} = useSyncExternalStore(
    emojiPicker.subscribe,
    emojiPicker.getState,
    emojiPicker.getState,
  );

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={(o) => !o && emojiPicker.close()}>
      <PopoverPrimitive.Anchor asChild>
        <div
          aria-hidden
          style={{
            position: 'fixed',
            left: anchor?.left ?? 0,
            top: anchor?.top ?? 0,
            width: anchor?.width ?? 0,
            height: anchor?.height ?? 0,
            pointerEvents: 'none',
          }}
        />
      </PopoverPrimitive.Anchor>
      {open && (
        <PopoverPrimitive.Portal>
          <PopoverPrimitive.Content
            align="start"
            sideOffset={6}
            collisionPadding={8}
            className="z-50 overflow-hidden rounded-md border-0 shadow-overlay outline-hidden data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95"
          >
            <Suspense fallback={<div className="h-[360px] w-[320px] rounded-md bg-popover" />}>
              <EmojiGrid
                dark={colorScheme === 'dark'}
                onPick={(emoji) => {
                  onPick?.(emoji);
                  emojiPicker.close();
                }}
              />
            </Suspense>
          </PopoverPrimitive.Content>
        </PopoverPrimitive.Portal>
      )}
    </PopoverPrimitive.Root>
  );
}
