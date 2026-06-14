import React, {useEffect, useRef} from 'react';
import type {InlineAttrs, TextRun} from './model';

/**
 * A small, self-contained rich-text editor over `TextRun[]` — a contentEditable
 * surface with a B/I/U + link toolbar, no app providers required. Extracted from
 * the `richtext` kit input (`kit/inputs2.tsx`) so the comment composer and the
 * kit input share one model: runs are rendered to inline HTML ONCE per identity
 * (re-rendering on every keystroke would fight the caret) and read back from the
 * DOM via `domToRuns` on input/blur.
 *
 * Formatting uses `document.execCommand`, which is enough for inline B/I/U +
 * links without pulling in the full block-editor text pipeline. Keystrokes are
 * stopped from bubbling so a host editor's shortcuts don't fire while typing.
 */

const FORMATS: Array<{cmd: string; label: string; mark: string}> = [
  {cmd: 'bold', label: 'B', mark: 'b'},
  {cmd: 'italic', label: 'I', mark: 'i'},
  {cmd: 'underline', label: 'U', mark: 'u'},
];

export interface RichTextEditorProps {
  /** Current value as runs. Re-seeds the surface only when `seed` changes. */
  value: TextRun[];
  onChange: (runs: TextRun[]) => void;
  readOnly?: boolean;
  placeholder?: string;
  ariaLabel?: string;
  /**
   * Identity token: the surface re-renders its HTML from `value` whenever this
   * changes (e.g. bump it to clear the composer after posting a comment). When
   * stable, the DOM stays the source of truth while editing.
   */
  seed?: string | number;
}

export const RichTextEditor: React.FC<RichTextEditorProps> = ({
  value,
  onChange,
  readOnly = false,
  placeholder = 'Write a comment…',
  ariaLabel = 'Comment',
  seed,
}) => {
  const ref = useRef<HTMLDivElement>(null);
  // Seed the contentEditable IMPERATIVELY (not via dangerouslySetInnerHTML) on
  // mount and whenever `seed` changes — a host bumps `seed` to reset after a
  // submit. Crucially this does NOT depend on `value`: re-rendering the editable
  // from `value` on every keystroke (React re-applying innerHTML) wipes what the
  // user just typed. While editing, the DOM is the source of truth; `onInput`
  // projects it back out via `sync`.
  // `value` is intentionally NOT a dep — see the comment above.
  const seededValue = useRef(value);
  seededValue.current = value;
  useEffect(() => {
    if (ref.current) ref.current.innerHTML = runsToHtml(Array.isArray(seededValue.current) ? seededValue.current : []);
  }, [seed]);

  const sync = (): void => {
    const el = ref.current;
    if (!el) return;
    onChange(domToRuns(el));
  };

  const link = (): void => {
    const url = window.prompt('Link URL'); // composer is web/desktop chrome, not WKWebView document content
    if (url) document.execCommand('createLink', false, url);
    sync();
  };

  return (
    <div className="obe-kit-richtext">
      {!readOnly && (
        <div className="obe-kit-richtext-bar" contentEditable={false}>
          {FORMATS.map((f) => (
            <button
              key={f.cmd}
              type="button"
              className={`obe-kit-richtext-btn obe-kit-richtext-${f.mark}`}
              aria-label={f.cmd}
              title={f.cmd}
              onMouseDown={(e) => {
                e.preventDefault(); // keep the selection in the editable surface
                document.execCommand(f.cmd);
                sync();
              }}
            >
              {f.label}
            </button>
          ))}
          <button
            type="button"
            className="obe-kit-richtext-btn"
            aria-label="link"
            title="link"
            onMouseDown={(e) => {
              e.preventDefault();
              link();
            }}
          >
            🔗
          </button>
        </div>
      )}
      <div
        ref={ref}
        className="obe-kit-richtext-body"
        contentEditable={!readOnly}
        suppressContentEditableWarning
        role="textbox"
        aria-multiline
        aria-label={ariaLabel}
        data-placeholder={placeholder}
        onInput={sync}
        onBlur={sync}
        onKeyDown={(e) => e.stopPropagation()}
      />
    </div>
  );
};

/** TextRun[] → simple inline HTML (b/i/u/links) for the editable surface. */
export function runsToHtml(runs: TextRun[]): string {
  const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return runs
    .map((run) => {
      let out = esc(run.t).replace(/\n/g, '<br>');
      const a: InlineAttrs = run.a ?? {};
      if (a.b) out = `<strong>${out}</strong>`;
      if (a.i) out = `<em>${out}</em>`;
      if (a.u) out = `<u>${out}</u>`;
      if (a.a) out = `<a href="${esc(a.a)}">${out}</a>`;
      return out;
    })
    .join('');
}

/** Read a contentEditable surface back into TextRun[] (b/i/u/links survive). */
export function domToRuns(root: HTMLElement): TextRun[] {
  const runs: TextRun[] = [];
  const visit = (node: Node, attrs: InlineAttrs): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      const t = node.textContent ?? '';
      if (t) runs.push({t, ...(Object.keys(attrs).length > 0 ? {a: attrs} : {})});
      return;
    }
    if (!(node instanceof HTMLElement)) return;
    if (node.tagName === 'BR') {
      runs.push({t: '\n'});
      return;
    }
    const next = {...attrs};
    const tag = node.tagName.toLowerCase();
    if (tag === 'b' || tag === 'strong') next.b = true;
    if (tag === 'i' || tag === 'em') next.i = true;
    if (tag === 'u') next.u = true;
    if (tag === 'a' && node.getAttribute('href')) next.a = node.getAttribute('href')!;
    node.childNodes.forEach((child) => visit(child, next));
  };
  root.childNodes.forEach((child) => visit(child, {}));
  return runs;
}

/** Whether a runs array has any visible text (for "post" button enablement). */
export const runsHaveText = (runs: TextRun[]): boolean => runs.some((r) => r.t.trim().length > 0);

/** Render runs to read-only inline HTML for displaying a posted comment. */
export const RichTextView: React.FC<{runs: TextRun[]; className?: string}> = ({runs, className}) => (
  <div className={className} dangerouslySetInnerHTML={{__html: runsToHtml(Array.isArray(runs) ? runs : [])}} />
);

export default RichTextEditor;
