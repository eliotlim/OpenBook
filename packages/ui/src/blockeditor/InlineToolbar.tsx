import React, {useState} from 'react';
import type {InlineAttrs} from './model';
import {COLOR_TOKENS} from './colors';

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
  /** Set (or, with `null`, clear) a colour on the selection. */
  onColor: (key: 'tc' | 'hl', token: string | null) => void;
}> = ({state, onToggle, onColor}) => {
  const [colorOpen, setColorOpen] = useState(false);
  const pick = (key: 'tc' | 'hl', token: string | null): void => {
    onColor(key, token);
    setColorOpen(false);
  };
  return (
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
      <span className="obe-tb-sep" />
      <button
        type="button"
        title="Colour & highlight"
        aria-label="Text colour and highlight"
        aria-pressed={colorOpen}
        className={`obe-tb-btn obe-tb-color${colorOpen ? ' obe-tb-on' : ''}`}
        onMouseDown={(e) => {
          e.preventDefault();
          setColorOpen((o) => !o);
        }}
      >
        A<span className="obe-tb-color-bar" aria-hidden />
      </button>
      {colorOpen && (
        <div className="obe-tb-colors" role="menu" aria-label="Colours" onMouseDown={(e) => e.preventDefault()}>
          <div className="obe-tb-colors-label">Text</div>
          <div className="obe-tb-colors-row">
            <button type="button" className="obe-sw obe-sw-reset" title="Default" aria-label="Default text colour" onMouseDown={(e) => {e.preventDefault(); pick('tc', null);}}>A</button>
            {COLOR_TOKENS.map((c) => (
              <button key={c.id} type="button" className={`obe-sw obe-fg-${c.id}`} title={c.label} aria-label={`Text ${c.label}`} onMouseDown={(e) => {e.preventDefault(); pick('tc', c.id);}}>A</button>
            ))}
          </div>
          <div className="obe-tb-colors-label">Highlight</div>
          <div className="obe-tb-colors-row">
            <button type="button" className="obe-sw obe-sw-fill obe-sw-reset" title="Default" aria-label="No highlight" onMouseDown={(e) => {e.preventDefault(); pick('hl', null);}} />
            {COLOR_TOKENS.map((c) => (
              <button key={c.id} type="button" className={`obe-sw obe-sw-fill obe-hl-${c.id}`} title={c.label} aria-label={`Highlight ${c.label}`} onMouseDown={(e) => {e.preventDefault(); pick('hl', c.id);}} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
