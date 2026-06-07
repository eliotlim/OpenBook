import {useSyncExternalStore} from 'react';
import {Plus} from 'lucide-react';
import {cn} from '@/lib/utils';
import type {MentionController} from '@/editor/pageMention';

/**
 * The `@`-mention picker UI. Pure view over a {@link MentionController}: it
 * renders the page results + a "create page" row at the caret, highlights the
 * controller's active index, and routes clicks/hover back to it. All keyboard
 * (↑/↓/Enter/Esc) is owned by the controller, which intercepts it in the editor.
 */
export function MentionPopover({controller}: {controller: MentionController}) {
  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);

  if (!state.open || !state.position) return null;
  const {results, createName, activeIndex, position} = state;
  const total = results.length + (createName ? 1 : 0);
  if (total === 0) return null;

  return (
    <div
      role="listbox"
      aria-label="Link to page"
      className="fixed z-50 max-h-72 w-72 overflow-y-auto rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-lg"
      style={{left: position.left, top: position.top + 4}}
      // Keep the editor selection (the @query range) intact while clicking.
      onMouseDown={(e) => e.preventDefault()}
    >
      {results.map((r, i) => (
        <Row
          key={r.id}
          active={i === activeIndex}
          onHover={() => controller.setActiveIndex(i)}
          onPick={() => void controller.pick(i)}
        >
          <span className="shrink-0 text-base leading-none">{r.icon}</span>
          <span className="truncate">{r.label}</span>
        </Row>
      ))}
      {createName && (
        <Row
          active={activeIndex === results.length}
          onHover={() => controller.setActiveIndex(results.length)}
          onPick={() => void controller.pick(results.length)}
        >
          <Plus className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="truncate">
            Create page <span className="font-medium">“{createName}”</span>
          </span>
        </Row>
      )}
      {results.length === 0 && !createName && (
        <div className="px-2 py-1.5 text-sm text-muted-foreground">No pages — keep typing to create one.</div>
      )}
    </div>
  );
}

function Row({
  active,
  onHover,
  onPick,
  children,
}: {
  active: boolean;
  onHover: () => void;
  onPick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={active}
      onMouseEnter={onHover}
      onClick={onPick}
      className={cn(
        'flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm',
        active ? 'bg-accent text-accent-foreground' : 'text-foreground',
      )}
    >
      {children}
    </button>
  );
}
