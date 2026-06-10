import React from 'react';
import type {InlineAttrs} from './model';

/**
 * The floating formatting toolbar shown over a non-collapsed text selection.
 * Buttons use mousedown + preventDefault so the document selection survives
 * the click (the toolbar lives outside the contenteditable).
 */

export interface ToolbarState {
  left: number;
  top: number;
  active: Partial<Record<keyof InlineAttrs, boolean>>;
}

const BUTTONS: {key: keyof InlineAttrs; label: string; title: string; className?: string}[] = [
  {key: 'b', label: 'B', title: 'Bold (⌘B)', className: 'obe-tb-bold'},
  {key: 'i', label: 'i', title: 'Italic (⌘I)', className: 'obe-tb-italic'},
  {key: 'u', label: 'U', title: 'Underline (⌘U)', className: 'obe-tb-underline'},
  {key: 's', label: 'S', title: 'Strikethrough (⌘⇧S)', className: 'obe-tb-strike'},
  {key: 'c', label: '</>', title: 'Code (⌘E)'},
];

export const InlineToolbar: React.FC<{
  state: ToolbarState;
  onToggle: (key: keyof InlineAttrs, value?: string) => void;
}> = ({state, onToggle}) => (
  <div
    className="obe-toolbar"
    role="toolbar"
    aria-label="Text formatting"
    style={{left: state.left, top: state.top}}
  >
    {BUTTONS.map((b) => (
      <button
        key={b.key}
        type="button"
        title={b.title}
        aria-label={b.title}
        aria-pressed={Boolean(state.active[b.key])}
        className={`obe-tb-btn ${b.className ?? ''}${state.active[b.key] ? ' obe-tb-on' : ''}`}
        onMouseDown={(e) => {
          e.preventDefault();
          onToggle(b.key);
        }}
      >
        {b.label}
      </button>
    ))}
    <span className="obe-tb-sep" />
    <button
      type="button"
      title="Link"
      aria-label="Add link"
      aria-pressed={Boolean(state.active.a)}
      className={`obe-tb-btn${state.active.a ? ' obe-tb-on' : ''}`}
      onMouseDown={(e) => {
        e.preventDefault();
        if (state.active.a) {
          onToggle('a'); // toggles off
          return;
        }
        const url = document.getSelection()?.toString().match(/^https?:\/\/\S+$/)
          ? document.getSelection()!.toString()
          : null;
        // Minimal inline prompt-free flow: selection that *is* a URL links
        // itself; otherwise link to the selected text as https://<text>.
        const fallback = document.getSelection()?.toString().trim() ?? '';
        const href = url ?? (fallback && !fallback.includes(' ') ? `https://${fallback}` : null);
        if (href) onToggle('a', href);
      }}
    >
      ⛓
    </button>
  </div>
);
