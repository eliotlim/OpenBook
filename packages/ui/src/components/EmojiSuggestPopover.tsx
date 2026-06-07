import {useSyncExternalStore} from 'react';
import {cn} from '@/lib/utils';
import {useTranslation} from '@/providers';
import type {EmojiSuggestController} from '@/editor/emojiSuggest';

/**
 * The inline `:`-shortcode emoji picker UI. Pure view over an
 * {@link EmojiSuggestController}: renders the matching emoji at the caret,
 * highlights the controller's active index, and routes clicks/hover back to it.
 * All keyboard (↑/↓/Enter/Esc) is owned by the controller.
 */
export function EmojiSuggestPopover({controller}: {controller: EmojiSuggestController}) {
  const {t} = useTranslation();
  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);

  if (!state.open || !state.position || state.results.length === 0) return null;
  const {results, activeIndex, position} = state;

  return (
    <div
      role="listbox"
      aria-label={t('emoji.label')}
      className="fixed z-50 max-h-72 w-64 overflow-y-auto rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-lg"
      style={{left: position.left, top: position.top + 4}}
      // Keep the editor selection (the :query range) intact while clicking.
      onMouseDown={(e) => e.preventDefault()}
    >
      {results.map((r, i) => (
        <button
          key={r.name}
          type="button"
          role="option"
          aria-selected={i === activeIndex}
          onMouseEnter={() => controller.setActiveIndex(i)}
          onClick={() => controller.pick(i)}
          className={cn(
            'flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm',
            i === activeIndex ? 'bg-accent text-accent-foreground' : 'text-foreground',
          )}
        >
          <span className="w-5 shrink-0 text-center text-base leading-none">{r.emoji}</span>
          <span className="truncate text-muted-foreground">:{r.name}:</span>
        </button>
      ))}
    </div>
  );
}
