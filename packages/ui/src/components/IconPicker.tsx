import React from 'react';
import {emojiPicker} from '@/lib/emojiPicker';

/**
 * A click-to-pick emoji trigger. Opens the one app-wide grid picker (via the
 * {@link emojiPicker} bridge) anchored at this button and reports the chosen
 * emoji to `onPick`. Each call site styles its own trigger via `className` /
 * `children`; with no children it renders the current value (or `fallback`).
 */
export function IconPicker({
  id,
  value,
  onPick,
  className,
  ariaLabel,
  fallback = '📄',
  children,
}: {
  id?: string;
  value: string;
  onPick: (emoji: string) => void;
  className?: string;
  ariaLabel?: string;
  fallback?: string;
  children?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      id={id}
      aria-label={ariaLabel}
      className={className}
      onClick={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        emojiPicker.open({left: r.left, top: r.top, width: r.width, height: r.height}, value, onPick);
      }}
    >
      {children ?? <span>{value || fallback}</span>}
    </button>
  );
}
