import React from 'react';
import {blockProp, setBlockProp} from './model';
import {computeScope, formatValue} from './kit/scope';
import {registerCustomBlock, type CustomBlockProps} from './registry';

/**
 * Reactive blocks for the block editor: a named **slider** input and a live
 * **formula** that recomputes over every named input's value (sliders plus
 * the whole artifact kit — steppers, text fields, radios, checklists…).
 * Drag a slider and every formula reading it updates, on every
 * collaborator's screen (the values are ordinary CRDT block props, so they
 * sync like text does).
 *
 * Registered through the custom-block registry, i.e. these are plugins: the
 * core editor knows nothing about them.
 */

const SliderBlock: React.FC<CustomBlockProps> = ({block, editor}) => {
  const name = blockProp<string>(block, 'name') ?? 'x';
  const value = Number(blockProp<number>(block, 'value') ?? 50);
  const min = Number(blockProp<number>(block, 'min') ?? 0);
  const max = Number(blockProp<number>(block, 'max') ?? 100);

  return (
    <div className="obe-slider" contentEditable={false}>
      <input
        className="obe-slider-name"
        value={name}
        aria-label="Slider name"
        readOnly={editor.readOnly}
        onChange={(e) => editor.doc.transact(() => setBlockProp(block, 'name', e.target.value || 'x'), 'local')}
      />
      <input
        type="range"
        min={min}
        max={max}
        value={value}
        aria-label={`${name} value`}
        disabled={editor.readOnly}
        onChange={(e) => editor.doc.transact(() => setBlockProp(block, 'value', Number(e.target.value)), 'local')}
      />
      <span className="obe-slider-value">{value}</span>
    </div>
  );
};

const FormulaBlock: React.FC<CustomBlockProps> = ({block, editor}) => {
  const source = blockProp<string>(block, 'source') ?? '';
  // Evaluated centrally (in document order, so named live-code outputs chain).
  const evaluated = computeScope(editor.doc).results.get(String(block.get('id')));
  const result = evaluated?.error ? `⚠ ${evaluated.error}` : formatValue(evaluated?.value);

  return (
    <div className="obe-formula" contentEditable={false}>
      <input
        className="obe-formula-src"
        value={source}
        placeholder="x * 2 + 1"
        aria-label="Formula source"
        readOnly={editor.readOnly}
        spellCheck={false}
        onChange={(e) => editor.doc.transact(() => setBlockProp(block, 'source', e.target.value), 'local')}
      />
      <span className="obe-formula-eq" aria-hidden>
        =
      </span>
      <output className="obe-formula-out" aria-live="polite">
        {result}
      </output>
    </div>
  );
};

/** Register the built-in reactive blocks (idempotent enough for app startup). */
export function registerReactiveBlocks(): void {
  registerCustomBlock({
    type: 'slider',
    render: SliderBlock,
    slash: {
      label: 'Slider',
      hint: 'A named live input',
      keywords: 'slider input range reactive',
      make: () => ({type: 'slider', props: {name: 'x', value: 50, min: 0, max: 100}}),
    },
  });
  // Legacy formula blocks keep rendering, but the slash menu steers new
  // documents to the unified live CODE block (toggle in the code footer).
  registerCustomBlock({type: 'formula', render: FormulaBlock});
}
