import React from 'react';
import {blockId, blockProp, setBlockProp, type BlockMap} from '../model';
import type {BlockEditorController} from '../useBlockEditor';
import type {CustomBlockProps} from '../registry';
import {computeScope, evalExpr, formatValue, statusOf} from './scope';
import {ConfigField, ConfigInput, KitInlineText, NameDescriptionFields} from './KitFrame';
import {KitSettings} from './KitSettings';

/**
 * The kit's display blocks: a status light driven by an expression, a term
 * with a hover tooltip, and a hyperlinked card. With the inputs and charts
 * these close the artifact loop — state in, computation, visible result.
 * Each shares the {@link KitConfig} settings affordance (hover gear → popover →
 * side pane), the same as every other interactive block.
 */

const set = (editor: BlockEditorController, block: BlockMap, key: string, value: unknown): void =>
  editor.doc.transact(() => setBlockProp(block, key, value), 'local');

// ── Status light ─────────────────────────────────────────────────────────────
// The expression decides the colour: booleans → ok/bad; numbers → ok at or
// above `okAt`, warn at or above `warnAt`, bad below; strings ok/warn/bad
// pass through. Anything unevaluable shows as neutral.

const StatusLightBlock: React.FC<CustomBlockProps> = ({block, editor}) => {
  const label = blockProp<string>(block, 'label') ?? 'Status';
  const source = blockProp<string>(block, 'source') ?? '';
  const okAt = Number(blockProp<number>(block, 'okAt') ?? 1);
  const warnAt = Number(blockProp<number>(block, 'warnAt') ?? 0);
  const {value, error} = evalExpr(source, computeScope(editor.doc).scope);
  const status = statusOf(value, error, okAt, warnAt);

  return (
    <div className="obe-kit obe-kit-status" contentEditable={false} data-status={status}>
      <span className={`obe-kit-light obe-kit-light-${status}`} aria-hidden />
      <KitInlineText
        className="obe-kit-status-label"
        value={label}
        placeholder="Status"
        readOnly={editor.readOnly}
        ariaLabel="Status label"
        onCommit={(v) => set(editor, block, 'label', v)}
      />
      <span className="obe-kit-status-value">{error ? `⚠ ${error}` : formatValue(value)}</span>
      <KitSettings blockId={blockId(block)} title={label || 'Status'}>
        <div className="flex flex-col gap-3">
          <ConfigField label="Label">
            <ConfigInput value={label} readOnly={editor.readOnly} aria-label="Status label" onChange={(e) => set(editor, block, 'label', e.target.value)} />
          </ConfigField>
          <ConfigField label="Value" hint="An expression — boolean, number, or 'ok' / 'warn' / 'bad'.">
            <ConfigInput
              mono
              value={source}
              readOnly={editor.readOnly}
              spellCheck={false}
              aria-label="Status expression"
              placeholder="x > 10  ·  errors  ·  'warn'"
              onChange={(e) => set(editor, block, 'source', e.target.value)}
            />
          </ConfigField>
          <div className="flex gap-2">
            <ConfigField label="ok ≥">
              <ConfigInput inputMode="decimal" value={blockProp<number>(block, 'okAt') ?? 1} readOnly={editor.readOnly} aria-label="Ok threshold" onChange={(e) => Number.isFinite(Number(e.target.value)) && set(editor, block, 'okAt', Number(e.target.value))} />
            </ConfigField>
            <ConfigField label="warn ≥">
              <ConfigInput inputMode="decimal" value={blockProp<number>(block, 'warnAt') ?? 0} readOnly={editor.readOnly} aria-label="Warn threshold" onChange={(e) => Number.isFinite(Number(e.target.value)) && set(editor, block, 'warnAt', Number(e.target.value))} />
            </ConfigField>
          </div>
        </div>
      </KitSettings>
    </div>
  );
};

// ── Tooltip card ─────────────────────────────────────────────────────────────

const TooltipCardBlock: React.FC<CustomBlockProps> = ({block, editor}) => {
  const term = blockProp<string>(block, 'term') ?? 'Term';
  const tip = blockProp<string>(block, 'tip') ?? '';

  return (
    <div className="obe-kit obe-kit-tooltip" contentEditable={false}>
      <span className="obe-kit-term" tabIndex={0}>
        <KitInlineText
          className="obe-kit-term-text"
          value={term}
          placeholder="Term"
          readOnly={editor.readOnly}
          ariaLabel="Term"
          onCommit={(v) => set(editor, block, 'term', v)}
        />
        <span className="obe-kit-term-mark" aria-hidden>
          ?
        </span>
        {tip && (
          <span role="tooltip" className="obe-kit-tip">
            {tip}
          </span>
        )}
      </span>
      <KitSettings blockId={blockId(block)} title={term || 'Tooltip'}>
        <div className="flex flex-col gap-3">
          <ConfigField label="Term">
            <ConfigInput value={term} readOnly={editor.readOnly} aria-label="Term" onChange={(e) => set(editor, block, 'term', e.target.value)} />
          </ConfigField>
          <ConfigField label="Tip">
            <ConfigInput value={tip} readOnly={editor.readOnly} aria-label="Tooltip text" placeholder="Shown on hover or focus" onChange={(e) => set(editor, block, 'tip', e.target.value)} />
          </ConfigField>
        </div>
      </KitSettings>
    </div>
  );
};

// ── Hyperlinked card ─────────────────────────────────────────────────────────

const LinkCardBlock: React.FC<CustomBlockProps> = ({block, editor}) => {
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
      <KitSettings blockId={blockId(block)} title={title || 'Link card'}>
        <div className="flex flex-col gap-3">
          <NameDescriptionFields block={block} editor={editor} nameKey="title" namePlaceholder="Untitled" />
          <ConfigField label="URL">
            <ConfigInput value={url} readOnly={editor.readOnly} aria-label="Card URL" placeholder="https://…" spellCheck={false} onChange={(e) => set(editor, block, 'url', e.target.value)} />
          </ConfigField>
        </div>
      </KitSettings>
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
