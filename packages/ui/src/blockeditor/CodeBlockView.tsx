import React, {useReducer, useState} from 'react';
import {Check, Copy, Eye, EyeOff, Play} from 'lucide-react';
import {blockId, blockProp, setBlockProp, type BlockMap} from './model';
import {TextBlockView} from './TextBlockView';
import {computeScope, formatValue} from './kit/scope';
import {KitSettings} from './kit/KitSettings';
import {ConfigField, ConfigInput, ConfigToggle} from './kit/KitFrame';
import {copyText} from '@/lib/pageActions';
import type {BlockEditorController} from './useBlockEditor';
import type {EditorUI} from './BlockEditor';

/**
 * The code block, unified with live computation (the old formula block): a
 * toolbar with show/hide · run · copy, and a ⚙ that opens the same settings
 * popover every kit block uses — variable name, language, and the *live* toggle.
 * Live = the code evaluates over the document's reactive scope (inputs + every
 * named live block above it) and publishes under a name later live blocks,
 * charts, status lights and formulas can reference. Off = an ordinary snippet,
 * whose name (if any) is a *filename* — name one `openbook.json` and the page
 * becomes an exportable plugin (see plugins/pagePlugin.ts).
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
  const collapsed = Boolean(blockProp<boolean>(block, 'collapsed'));
  // "Run" forces a re-render so the scope recomputes against the current inputs;
  // the value itself is always derived from doc state (no stale cache to bust).
  const [, forceRun] = useReducer((x: number) => x + 1, 0);
  const [copied, setCopied] = useState(false);

  const result = live ? computeScope(editor.doc).results.get(id) : undefined;
  // Large outputs (a 60-element series, a big object) must not blow out the
  // page — clamp the preview; the full value still flows to consumers.
  const shownValue = (() => {
    if (!result || result.error) return '';
    const full = formatValue(result.value);
    return full.length > 240 ? `${full.slice(0, 240)} …` : full;
  })();

  const set = (key: string, value: unknown): void => editor.doc.transact(() => setBlockProp(block, key, value), 'local');

  const onCopy = (): void => {
    void copyText(String(block.get('text') ?? '')).then((ok) => {
      if (!ok) return;
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  };

  const onRun = (): void => {
    if (!live) set('live', true);
    forceRun();
  };

  const config = (
    <div className="flex flex-col gap-3">
      <ConfigField
        label={live ? 'Output name' : 'File name'}
        hint={live ? 'The symbol later blocks, charts and formulas reference.' : 'Name it openbook.json to make the page an exportable plugin.'}
      >
        <ConfigInput
          mono
          value={name}
          placeholder={live ? 'result' : 'filename'}
          readOnly={editor.readOnly}
          spellCheck={false}
          aria-label={live ? 'Output name' : 'File name'}
          onChange={(e) => set('name', e.target.value.trim())}
        />
      </ConfigField>
      <ConfigField label="Language">
        <ConfigInput
          value={language}
          placeholder="js"
          readOnly={editor.readOnly}
          spellCheck={false}
          aria-label="Code language"
          onChange={(e) => set('language', e.target.value.trim())}
        />
      </ConfigField>
      <ConfigToggle
        label="Live"
        hint="Evaluate over the document's inputs and publish the result."
        checked={live}
        disabled={editor.readOnly}
        onChange={(next) => set('live', next || undefined)}
      />
    </div>
  );

  return (
    <div className={`obe-codeblock${live ? ' obe-codeblock-live' : ''}`}>
      <div className="obe-code-actions" contentEditable={false}>
        <span className="obe-code-lang-badge">{language || (live ? 'live' : 'code')}</span>
        <span className="obe-kit-spacer" />
        <button
          type="button"
          className="obe-code-btn"
          aria-label={collapsed ? 'Show code' : 'Hide code'}
          title={collapsed ? 'Show code' : 'Hide code'}
          onClick={() => set('collapsed', collapsed ? undefined : true)}
        >
          {collapsed ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
        </button>
        <button
          type="button"
          className="obe-code-btn"
          aria-label="Run code"
          title="Run code"
          disabled={editor.readOnly}
          onClick={onRun}
        >
          <Play className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          className="obe-code-btn"
          aria-label="Copy code"
          title="Copy code"
          onClick={onCopy}
        >
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
        </button>
        <KitSettings blockId={id} title={name || 'Code'}>
          {config}
        </KitSettings>
      </div>
      {collapsed ? (
        <button
          type="button"
          className="obe-code-collapsed"
          contentEditable={false}
          onClick={() => set('collapsed', undefined)}
        >
          Code hidden — click to show
        </button>
      ) : (
        <TextBlockView block={block} editor={editor} ui={ui} />
      )}
      {live && (
        <output className={`obe-code-out${result?.error ? ' obe-code-out-err' : ''}`} aria-live="polite" contentEditable={false}>
          <span className="obe-code-out-name">{name || 'result'}</span> ={' '}
          {result?.error ? `⚠ ${result.error}` : shownValue}
        </output>
      )}
    </div>
  );
};
