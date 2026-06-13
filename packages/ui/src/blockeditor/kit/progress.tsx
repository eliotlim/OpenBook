import React from 'react';
import {blockId, blockProp} from '../model';
import type {CustomBlockProps} from '../registry';
import {computeScope, evalExpr} from './scope';
import {ConfigField, ConfigInput, kitSet, KitInlineText} from './KitFrame';
import {KitSettings} from './KitSettings';

/**
 * Progress bar — a DISPLAY block computed from an expression over the page's
 * inputs (like the chart / status light). It does NOT publish a value. A common
 * binding is a tab/accordion completion signal (e.g. `setup.complete` or
 * `setup.ratio`), but any `evalExpr` result works.
 *
 * Props: `label`, `source` (expression), `max` (default 100), `format`
 * (`percent` shows %, `fraction` shows value / max).
 */

const set = kitSet;

const ProgressBarBlock: React.FC<CustomBlockProps> = ({block, editor}) => {
  const label = blockProp<string>(block, 'label') ?? 'Progress';
  const source = blockProp<string>(block, 'source') ?? '';
  const max = Number(blockProp<number>(block, 'max') ?? 100) || 100;
  const format = blockProp<string>(block, 'format') ?? 'percent';
  const {value, error} = evalExpr(source, computeScope(editor.doc).scope);

  // Coerce the result to a number: a boolean completion → 0/1, a fraction in
  // [0,1] is taken as-is when max is 1, otherwise the raw value over max.
  const raw = typeof value === 'boolean' ? (value ? max : 0) : Number(value ?? 0);
  const fraction = Number.isFinite(raw) ? Math.max(0, Math.min(1, max === 0 ? 0 : raw / max)) : 0;
  const pct = Math.round(fraction * 100);
  const readout = error ? `⚠ ${error}` : format === 'fraction' ? `${trim(raw)} / ${trim(max)}` : `${pct}%`;

  return (
    <div className="obe-kit obe-kit-progress" contentEditable={false} data-progress={pct}>
      <span className="obe-kit-progress-head">
        <KitInlineText
          className="obe-kit-progress-label"
          value={label}
          placeholder="Progress"
          readOnly={editor.readOnly}
          ariaLabel="Progress label"
          onCommit={(v) => set(editor, block, 'label', v)}
        />
        <span className="obe-kit-progress-value">{readout}</span>
      </span>
      <span className="obe-kit-progress-track" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
        <span className="obe-kit-progress-fill" style={{width: `${pct}%`}} />
      </span>
      <KitSettings blockId={blockId(block)} title={label || 'Progress'}>
        <div className="flex flex-col gap-3">
          <ConfigField label="Label">
            <ConfigInput value={label} readOnly={editor.readOnly} aria-label="Progress label" onChange={(e) => set(editor, block, 'label', e.target.value)} />
          </ConfigField>
          <ConfigField label="Value" hint="An expression over inputs — e.g. a tab/accordion completion (setup.ratio).">
            <ConfigInput
              mono
              value={source}
              readOnly={editor.readOnly}
              spellCheck={false}
              aria-label="Progress expression"
              placeholder="setup.ratio  ·  done / total  ·  score"
              onChange={(e) => set(editor, block, 'source', e.target.value)}
            />
          </ConfigField>
          <div className="flex gap-2">
            <ConfigField label="Max">
              <ConfigInput
                inputMode="decimal"
                value={blockProp<number>(block, 'max') ?? 100}
                readOnly={editor.readOnly}
                aria-label="Max"
                onChange={(e) => Number.isFinite(Number(e.target.value)) && set(editor, block, 'max', Number(e.target.value))}
              />
            </ConfigField>
            <ConfigField label="Format">
              <select
                className="w-full rounded-md border border-border bg-card px-2 py-1 text-sm"
                value={format}
                disabled={editor.readOnly}
                aria-label="Format"
                onChange={(e) => set(editor, block, 'format', e.target.value)}
              >
                <option value="percent">percent</option>
                <option value="fraction">fraction</option>
              </select>
            </ConfigField>
          </div>
        </div>
      </KitSettings>
    </div>
  );
};

/** Compact number for the readout (whole numbers stay whole). */
const trim = (n: number): string => (Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100));

export const PROGRESS_BLOCKS = [
  {
    type: 'progressbar',
    render: ProgressBarBlock,
    slash: {
      label: 'Progress bar',
      hint: 'A bar computed from an expression over inputs',
      keywords: 'progress bar meter completion percent gauge status indicator',
      make: () => ({type: 'progressbar', props: {label: 'Progress', source: '', max: 100, format: 'percent'}}),
    },
  },
] as const;
