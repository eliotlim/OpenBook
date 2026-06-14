import React from 'react';
import {blockProp, setBlockProp} from './model';
import {computeScope, formatValue} from './kit/scope';
import {ConfigField, ConfigInput, KitFrame, kitSet} from './kit/KitFrame';
import {varNameFromLabel} from './kit/options';
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
  // The published symbol mirrors KitFrame: explicit name, else derived from the
  // display label, else the `x` fallback — used only to label the control here.
  const name = (blockProp<string>(block, 'name') ?? '').trim() || varNameFromLabel(blockProp<string>(block, 'label') ?? '') || 'x';
  const value = Number(blockProp<number>(block, 'value') ?? 50);
  const min = Number(blockProp<number>(block, 'min') ?? 0);
  const max = Number(blockProp<number>(block, 'max') ?? 100);
  const step = Number(blockProp<number>(block, 'step') ?? 1);

  const control = (
    <div className="obe-kit-range" role="group" aria-label={`${name} slider`}>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={`${name} value`}
        disabled={editor.readOnly}
        onChange={(e) => kitSet(editor, block, 'value', Number(e.target.value))}
      />
      <span className="obe-kit-range-value">{value}</span>
    </div>
  );

  const config = (
    <div className="flex gap-2">
      {(['min', 'max', 'step'] as const).map((key) => (
        <ConfigField key={key} label={key}>
          <ConfigInput
            inputMode="decimal"
            value={blockProp<number>(block, key) ?? ''}
            readOnly={editor.readOnly}
            aria-label={key}
            onChange={(e) => {
              const v = e.target.value.trim();
              kitSet(editor, block, key, v === '' ? undefined : Number(v));
            }}
          />
        </ConfigField>
      ))}
    </div>
  );

  return <KitFrame block={block} editor={editor} kind="slider" defaultName="x" control={control} config={config} supportsWide />;
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
      group: 'interactive',
    },
  });
  // Legacy formula blocks keep rendering, but the slash menu steers new
  // documents to the unified live CODE block (toggle in the code footer).
  registerCustomBlock({type: 'formula', render: FormulaBlock});
}
