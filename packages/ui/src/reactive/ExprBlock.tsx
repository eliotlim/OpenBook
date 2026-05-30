import React, {useEffect, useRef, useState, useCallback} from 'react';
import type {ReactElement} from 'react';
import type {ToolboxConfig} from '@editorjs/editorjs';
import {effect} from '@preact/signals-core';
import {ReactBlockTool, type ReactiveBlockData} from './editorJsReactAdapter';
import {store} from './ReactiveStore';
import {useReactiveCell} from './useReactiveCell';
import {compile} from './compile';

interface ExprBlockData extends ReactiveBlockData {
  name?: string;
  source?: string;
}

interface ExprComponentProps {
  cellId: string;
  initialData: ExprBlockData;
  onChange: (data: ExprBlockData) => void;
}

// Source token format: `__C__{<cellId>}__`. Braces are unambiguous
// delimiters and allow cellIds containing any chars (EditorJS block ids
// contain hyphens like `mKTU-N2aPX`). Must match compile.ts.
const TOKEN_RE = /__C__\{([^}]+)\}__/g;

// Render the source string into DOM nodes: plain text between tokens,
// contentEditable=false spans for the tokens themselves (atomic delete).
function sourceToHTML(source: string): string {
  const parts: string[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  TOKEN_RE.lastIndex = 0;
  while ((match = TOKEN_RE.exec(source)) !== null) {
    if (match.index > lastIndex) {
      parts.push(escapeHTML(source.slice(lastIndex, match.index)));
    }
    const cellId = match[1];
    const displayName = store.getName(cellId) ?? `<missing:${cellId}>`;
    // contenteditable=false makes the span atomic — backspace removes the
    // whole token rather than letting the user split it.
    parts.push(
      `<span class="cell-token" contenteditable="false" data-cellid="${escapeAttr(cellId)}">${escapeHTML(displayName)}</span>`,
    );
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < source.length) {
    parts.push(escapeHTML(source.slice(lastIndex)));
  }
  return parts.join('');
}

function escapeHTML(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[c]!);
}
function escapeAttr(s: string): string {
  return s.replace(/"/g, '&quot;');
}

// Walk the contenteditable DOM and reconstruct the source string.
// Text nodes → verbatim text; .cell-token spans → __C__<cellId> tokens.
function htmlToSource(el: HTMLElement): string {
  const parts: string[] = [];
  const walk = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      parts.push(node.textContent ?? '');
      return;
    }
    if (node.nodeType === Node.ELEMENT_NODE) {
      const elNode = node as Element;
      if (elNode.classList.contains('cell-token')) {
        const cellId = elNode.getAttribute('data-cellid');
        if (cellId) {
          parts.push(`__C__{${cellId}}__`);
        }
        return;
      }
      // <br> from Enter key → newline (acceptable for v0 multi-line exprs)
      if (elNode.tagName === 'BR') {
        parts.push('\n');
        return;
      }
      // Recurse into other elements (e.g., divs that Chromium creates on Enter).
      elNode.childNodes.forEach(walk);
      // After block-level element close, treat as newline boundary.
      const display = window.getComputedStyle(elNode).display;
      if (display === 'block' && elNode.tagName !== 'DIV') {
        parts.push('\n');
      }
    }
  };
  el.childNodes.forEach(walk);
  return parts.join('');
}

// On blur: scan source for @<name> patterns and replace with __C__{<cellId>}__
// tokens (when name resolves in the store). Unknown names are left literal.
function resolveAtReferences(source: string): string {
  return source.replace(/@([A-Za-z_][A-Za-z0-9_]*)/g, (match, name: string) => {
    const cellId = store.getIdByName(name);
    return cellId ? `__C__{${cellId}}__` : match;
  });
}

const ExprComponent: React.FC<ExprComponentProps> = ({cellId, initialData, onChange}) => {
  const [name, setName] = useState(initialData.name ?? 'expr');
  const [source, setSource] = useState(initialData.source ?? '');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [result, setResult] = useState<unknown>(undefined);
  const editorRef = useRef<HTMLDivElement>(null);
  const isFocusedRef = useRef(false);

  useReactiveCell(cellId, name);

  // Render the source into the contenteditable on mount and whenever source
  // changes from outside (hydrate, blur-resolve). Skip if user is focused
  // (would yank their cursor mid-edit).
  useEffect(() => {
    if (!editorRef.current) return;
    if (isFocusedRef.current) return;
    editorRef.current.innerHTML = sourceToHTML(source);
  }, [source]);

  // Subscribe to namesVersion: when a name changes elsewhere, re-render
  // contenteditable to refresh token-span display names. Skip if focused.
  useEffect(() => {
    return effect(() => {
      // Read namesVersion to subscribe.
      store.namesVersion.value;
      if (editorRef.current && !isFocusedRef.current) {
        editorRef.current.innerHTML = sourceToHTML(source);
      }
    });
  }, [source]);

  // Reactive evaluation: compile source and re-run whenever any referenced
  // cell value changes (via Signals' tracking inside compile's resolveCellId).
  useEffect(() => {
    let compiledFn: ReturnType<typeof compile> | null = null;
    try {
      compiledFn = compile(source);
      setErrorMsg(null);
    } catch (e) {
      setErrorMsg(`Compile error: ${(e as Error).message}`);
      store.setByCellId(cellId, undefined);
      setResult(undefined);
      return;
    }
    const disposer = effect(() => {
      try {
        const ret = compiledFn!(store);
        // Async-friendly: always await, even for sync returns. v1 sandbox
        // (QuickJS) will return Promise<unknown>; this code stays unchanged.
        Promise.resolve(ret).then(
          (value) => {
            store.setByCellId(cellId, value);
            setResult(value);
            setErrorMsg(null);
          },
          (err: Error) => {
            store.setByCellId(cellId, undefined);
            setResult(undefined);
            setErrorMsg(`Runtime error: ${err.message}`);
          },
        );
      } catch (e) {
        store.setByCellId(cellId, undefined);
        setResult(undefined);
        setErrorMsg(`Runtime error: ${(e as Error).message}`);
      }
    });
    return disposer;
  }, [cellId, source]);

  // Persist data back to the block.
  useEffect(() => {
    onChange({name, source});
  }, [name, source, onChange]);

  const handleInput = useCallback(() => {
    // Don't compile on every keystroke (source-on-blur per design).
    // Just update a "pending" source that we'll commit on blur.
    // Actually for v0 we keep this simple: input handler is a no-op,
    // we read the DOM on blur.
  }, []);

  const handlePaste = useCallback((e: React.ClipboardEvent<HTMLDivElement>) => {
    // EditorJS intercepts paste events for blocks that don't declare a
    // pasteConfig. We declare pasteConfig=false on the Tool class, but
    // some EditorJS versions still swallow the event at the document
    // level. Intercept here unconditionally and insert plain text at
    // the cursor.
    e.preventDefault();
    e.stopPropagation();
    const text = e.clipboardData.getData('text/plain');
    if (!text) return;
    // execCommand is deprecated but still works in WKWebView/Chromium
    // and is the simplest way to honor the current Selection inside a
    // contenteditable. Modern alternative (Selection.deleteFromDocument +
    // Range.insertNode + Selection.collapseToEnd) is correct but 8 lines
    // of careful DOM surgery for v0.
    document.execCommand('insertText', false, text);
  }, []);

  const handleBlur = useCallback(() => {
    isFocusedRef.current = false;
    if (!editorRef.current) return;
    const raw = htmlToSource(editorRef.current);
    const resolved = resolveAtReferences(raw);
    setSource(resolved);
    // The render-source effect will re-render the contenteditable with any
    // newly-tokenized @-references.
  }, []);

  const handleFocus = useCallback(() => {
    isFocusedRef.current = true;
  }, []);

  return (
    <div style={{padding: '8px', border: '1px solid #ddd', borderRadius: '4px', background: '#fafafa'}}>
      <div style={{display: 'flex', gap: '8px', marginBottom: '6px', fontSize: '12px', color: '#666'}}>
        <label>
          name:{' '}
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            style={{width: '120px'}}
          />
        </label>
        <span style={{color: '#999'}}>type @cellname to reference other cells (resolved on blur)</span>
      </div>
      <div
        ref={editorRef}
        contentEditable
        suppressContentEditableWarning
        onInput={handleInput}
        onPaste={handlePaste}
        onBlur={handleBlur}
        onFocus={handleFocus}
        style={{
          fontFamily: 'monospace',
          fontSize: '13px',
          padding: '6px 8px',
          minHeight: '24px',
          background: 'white',
          border: '1px solid #ccc',
          borderRadius: '3px',
          whiteSpace: 'pre-wrap',
          outline: 'none',
        }}
      />
      <div style={{marginTop: '4px', fontSize: '12px'}}>
        {errorMsg ? (
          <span style={{color: '#b00020'}}>{errorMsg}</span>
        ) : (
          <span style={{color: '#666'}}>
            = <code>{formatResult(result)}</code>
          </span>
        )}
      </div>
    </div>
  );
};

function formatResult(r: unknown): string {
  if (r === undefined) return 'undefined';
  if (Array.isArray(r)) return r.length > 6 ? `[${r.slice(0, 6).join(', ')}, ... (${r.length} items)]` : `[${r.join(', ')}]`;
  if (typeof r === 'object' && r !== null) return JSON.stringify(r);
  return String(r);
}

export class ExprBlock extends ReactBlockTool {
  static get toolbox(): ToolboxConfig {
    return {
      title: 'Expression',
      icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 5h14M5 12h14M5 19h14"/><circle cx="12" cy="12" r="2" fill="currentColor"/></svg>',
    };
  }

  // Opt out of EditorJS's paste pipeline; the contenteditable handles paste
  // natively (plus the React onPaste handler intercepts and inserts plain
  // text, so pasted HTML/styling never leaks into the source).
  static get pasteConfig(): false {
    return false;
  }

  protected toolName(): string {
    return 'reactive-expr';
  }

  protected renderComponent(): ReactElement {
    return (
      <ExprComponent
        cellId={this.cellId}
        initialData={this.data as ExprBlockData}
        onChange={(data) => {
          this.data = data;
        }}
      />
    );
  }

  save(): ExprBlockData {
    return this.data as ExprBlockData;
  }
}
