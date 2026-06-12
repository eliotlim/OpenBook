import React from 'react';
import {blockId, blockProp, setBlockProp, type BlockMap} from './model';
import {TextBlockView} from './TextBlockView';
import {computeScope, formatValue} from './kit/scope';
import type {BlockEditorController} from './useBlockEditor';
import type {EditorUI} from './BlockEditor';

/**
 * The code block, unified with live computation (the old formula block): a
 * footer toggle makes the block *live* — its code evaluates over the
 * document's reactive scope (inputs + every named live block above it), and
 * its result publishes under a name that later live blocks, charts, status
 * lights, and formulas can reference. Off = an ordinary code snippet.
 */
export const CodeBlockView: React.FC<{
  block: BlockMap;
  editor: BlockEditorController;
  ui: EditorUI;
}> = ({block, editor, ui}) => {
  const id = blockId(block);
  const live = Boolean(blockProp<boolean>(block, 'live'));
  const name = blockProp<string>(block, 'name') ?? '';
  const language = blockProp<string>(block, 'language') ?? '';
  const result = live ? computeScope(editor.doc).results.get(id) : undefined;
  // Large outputs (a 60-element series, a big object) must not blow out the
  // page — clamp the preview; the full value still flows to consumers.
  const shownValue = (() => {
    if (!result || result.error) return '';
    const full = formatValue(result.value);
    return full.length > 240 ? `${full.slice(0, 240)} …` : full;
  })();

  const set = (key: string, value: unknown): void => editor.doc.transact(() => setBlockProp(block, key, value), 'local');

  return (
    <div className={`obe-codeblock${live ? ' obe-codeblock-live' : ''}`}>
      <TextBlockView block={block} editor={editor} ui={ui} />
      <div className="obe-code-bar" contentEditable={false}>
        <input
          className="obe-code-lang"
          value={language}
          placeholder="lang"
          aria-label="Code language"
          readOnly={editor.readOnly}
          spellCheck={false}
          onChange={(e) => set('language', e.target.value.trim())}
        />
        <span className="obe-kit-spacer" />
        {live && (
          <label className="obe-kit-field">
            <span>name</span>
            <input
              className="obe-kit-name"
              value={name}
              placeholder="result"
              aria-label="Output name"
              readOnly={editor.readOnly}
              spellCheck={false}
              onChange={(e) => set('name', e.target.value.trim())}
            />
          </label>
        )}
        <label className="obe-kit-field">
          <span>live</span>
          <button
            type="button"
            role="switch"
            aria-checked={live}
            aria-label="Evaluate this code live"
            className={`obe-kit-switch${live ? ' obe-kit-switch-on' : ''}`}
            disabled={editor.readOnly}
            onClick={() => set('live', !live)}
          >
            <span className="obe-kit-knob" />
          </button>
        </label>
      </div>
      {live && (
        <output className={`obe-code-out${result?.error ? ' obe-code-out-err' : ''}`} aria-live="polite" contentEditable={false}>
          <span className="obe-code-out-name">{name || 'result'}</span> ={' '}
          {result?.error ? `⚠ ${result.error}` : shownValue}
        </output>
      )}
    </div>
  );
};
