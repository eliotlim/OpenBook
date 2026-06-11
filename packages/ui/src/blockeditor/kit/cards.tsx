import React, {useState} from 'react';
import {blockProp, setBlockProp, type BlockMap} from '../model';
import type {BlockEditorController} from '../useBlockEditor';
import type {CustomBlockProps} from '../registry';
import {evalExpr, formatValue, inputScope} from './scope';

/**
 * The kit's display blocks: a status light driven by an expression, a term
 * with a hover tooltip, and a hyperlinked card. With the inputs and charts
 * these close the artifact loop — state in, computation, visible result.
 */

const set = (editor: BlockEditorController, block: BlockMap, key: string, value: unknown): void =>
  editor.doc.transact(() => setBlockProp(block, key, value), 'local');

const Gear: React.FC<{open: boolean; onClick: () => void}> = ({open, onClick}) => (
  <button type="button" className={`obe-kit-gear${open ? ' obe-kit-gear-on' : ''}`} aria-label="Configure block" aria-expanded={open} onClick={onClick}>
    ⚙
  </button>
);

// ── Status light ─────────────────────────────────────────────────────────────
// The expression decides the colour: booleans → ok/bad; numbers → ok at or
// above `okAt`, warn at or above `warnAt`, bad below; strings ok/warn/bad
// pass through. Anything unevaluable shows as neutral.

type Status = 'ok' | 'warn' | 'bad' | 'off';

function statusOf(value: unknown, error: string | undefined, okAt: number, warnAt: number): Status {
  if (error || value === undefined || value === null) return 'off';
  if (typeof value === 'boolean') return value ? 'ok' : 'bad';
  if (typeof value === 'string') return value === 'ok' || value === 'warn' || value === 'bad' ? value : 'off';
  if (typeof value === 'number') {
    if (value >= okAt) return 'ok';
    if (value >= warnAt) return 'warn';
    return 'bad';
  }
  return 'off';
}

const StatusLightBlock: React.FC<CustomBlockProps> = ({block, editor}) => {
  const [config, setConfig] = useState(false);
  const label = blockProp<string>(block, 'label') ?? 'Status';
  const source = blockProp<string>(block, 'source') ?? '';
  const okAt = Number(blockProp<number>(block, 'okAt') ?? 1);
  const warnAt = Number(blockProp<number>(block, 'warnAt') ?? 0);
  const {value, error} = evalExpr(source, inputScope(editor.doc));
  const status = statusOf(value, error, okAt, warnAt);

  return (
    <div className="obe-kit obe-kit-status" contentEditable={false} data-status={status}>
      <span className={`obe-kit-light obe-kit-light-${status}`} aria-hidden />
      <span className="obe-kit-status-label">{label}</span>
      <span className="obe-kit-status-value">{error ? `⚠ ${error}` : formatValue(value)}</span>
      <Gear open={config} onClick={() => setConfig(!config)} />
      {config && (
        <div className="obe-kit-config">
          <label className="obe-kit-field">
            <span>label</span>
            <input className="obe-kit-name" value={label} readOnly={editor.readOnly} aria-label="Status label" onChange={(e) => set(editor, block, 'label', e.target.value)} />
          </label>
          <label className="obe-kit-field obe-kit-field-grow">
            <span>value</span>
            <input
              className="obe-kit-options obe-kit-mono"
              value={source}
              readOnly={editor.readOnly}
              spellCheck={false}
              aria-label="Status expression"
              placeholder="x > 10  ·  errors  ·  'warn'"
              onChange={(e) => set(editor, block, 'source', e.target.value)}
            />
          </label>
          <label className="obe-kit-field">
            <span>ok ≥</span>
            <input className="obe-kit-num" inputMode="decimal" value={blockProp<number>(block, 'okAt') ?? 1} readOnly={editor.readOnly} aria-label="Ok threshold" onChange={(e) => Number.isFinite(Number(e.target.value)) && set(editor, block, 'okAt', Number(e.target.value))} />
          </label>
          <label className="obe-kit-field">
            <span>warn ≥</span>
            <input className="obe-kit-num" inputMode="decimal" value={blockProp<number>(block, 'warnAt') ?? 0} readOnly={editor.readOnly} aria-label="Warn threshold" onChange={(e) => Number.isFinite(Number(e.target.value)) && set(editor, block, 'warnAt', Number(e.target.value))} />
          </label>
        </div>
      )}
    </div>
  );
};

// ── Tooltip card ─────────────────────────────────────────────────────────────

const TooltipCardBlock: React.FC<CustomBlockProps> = ({block, editor}) => {
  const [config, setConfig] = useState(false);
  const term = blockProp<string>(block, 'term') ?? 'Term';
  const tip = blockProp<string>(block, 'tip') ?? '';

  return (
    <div className="obe-kit obe-kit-tooltip" contentEditable={false}>
      <span className="obe-kit-term" tabIndex={0}>
        {term}
        <span className="obe-kit-term-mark" aria-hidden>
          ?
        </span>
        {tip && (
          <span role="tooltip" className="obe-kit-tip">
            {tip}
          </span>
        )}
      </span>
      <Gear open={config} onClick={() => setConfig(!config)} />
      {config && (
        <div className="obe-kit-config">
          <label className="obe-kit-field">
            <span>term</span>
            <input className="obe-kit-name" value={term} readOnly={editor.readOnly} aria-label="Term" onChange={(e) => set(editor, block, 'term', e.target.value)} />
          </label>
          <label className="obe-kit-field obe-kit-field-grow">
            <span>tip</span>
            <input className="obe-kit-options" value={tip} readOnly={editor.readOnly} aria-label="Tooltip text" placeholder="Shown on hover or focus" onChange={(e) => set(editor, block, 'tip', e.target.value)} />
          </label>
        </div>
      )}
    </div>
  );
};

// ── Hyperlinked card ─────────────────────────────────────────────────────────

const LinkCardBlock: React.FC<CustomBlockProps> = ({block, editor}) => {
  const [config, setConfig] = useState(false);
  const title = blockProp<string>(block, 'title') ?? 'Untitled';
  const description = blockProp<string>(block, 'description') ?? '';
  const url = blockProp<string>(block, 'url') ?? '';
  const href = url && (/^https?:\/\//.test(url) ? url : `https://${url}`);

  return (
    <div className="obe-kit obe-kit-linkcard-wrap" contentEditable={false}>
      <a className="obe-kit-linkcard" href={href || undefined} target="_blank" rel="noreferrer" aria-disabled={!href}>
        <span className="obe-kit-linkcard-title">{title}</span>
        {description && <span className="obe-kit-linkcard-desc">{description}</span>}
        {url && <span className="obe-kit-linkcard-url">{url.replace(/^https?:\/\//, '')}</span>}
      </a>
      <Gear open={config} onClick={() => setConfig(!config)} />
      {config && (
        <div className="obe-kit-config">
          <label className="obe-kit-field">
            <span>title</span>
            <input className="obe-kit-name" value={title} readOnly={editor.readOnly} aria-label="Card title" onChange={(e) => set(editor, block, 'title', e.target.value)} />
          </label>
          <label className="obe-kit-field obe-kit-field-grow">
            <span>text</span>
            <input className="obe-kit-options" value={description} readOnly={editor.readOnly} aria-label="Card description" onChange={(e) => set(editor, block, 'description', e.target.value)} />
          </label>
          <label className="obe-kit-field obe-kit-field-grow">
            <span>url</span>
            <input className="obe-kit-options" value={url} readOnly={editor.readOnly} aria-label="Card URL" placeholder="https://…" spellCheck={false} onChange={(e) => set(editor, block, 'url', e.target.value)} />
          </label>
        </div>
      )}
    </div>
  );
};

export const CARD_BLOCKS = [
  {
    type: 'statuslight',
    render: StatusLightBlock,
    slash: {
      label: 'Status light',
      hint: 'Green / amber / red from a live value',
      keywords: 'status light indicator traffic health ok warn red green',
      make: () => ({type: 'statuslight', props: {label: 'Status', source: '', okAt: 1, warnAt: 0}}),
    },
  },
  {
    type: 'tooltipcard',
    render: TooltipCardBlock,
    slash: {
      label: 'Tooltip',
      hint: 'A term that explains itself on hover',
      keywords: 'tooltip hint term definition hover help',
      make: () => ({type: 'tooltipcard', props: {term: 'Term', tip: 'Explanation shown on hover.'}}),
    },
  },
  {
    type: 'linkcard',
    render: LinkCardBlock,
    slash: {
      label: 'Link card',
      hint: 'A titled card that opens a URL',
      keywords: 'link card url bookmark website external',
      make: () => ({type: 'linkcard', props: {title: 'Untitled', description: '', url: ''}}),
    },
  },
] as const;
