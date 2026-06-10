import React from 'react';
import {blockProp, blockType, rootBlocks, setBlockProp, walkBlocks} from './model';
import {registerCustomBlock, type CustomBlockProps} from './registry';

/**
 * Reactive blocks for the block editor: a named **slider** input and a live
 * **formula** that recomputes over every slider's value. Together they make
 * documents programmable — drag a slider and every formula reading it
 * updates, on every collaborator's screen (the values are ordinary CRDT
 * block props, so they sync like text does).
 *
 * Registered through the custom-block registry, i.e. these are plugins: the
 * core editor knows nothing about them.
 */

/** All slider values in the doc, by name (the formula's input scope). */
function sliderScope(editor: CustomBlockProps['editor']): Record<string, number> {
  const scope: Record<string, number> = {};
  for (const {block} of walkBlocks(rootBlocks(editor.doc))) {
    if ((blockType(block) as string) === 'slider') {
      const name = blockProp<string>(block, 'name');
      if (name) scope[name] = Number(blockProp<number>(block, 'value') ?? 0);
    }
  }
  return scope;
}

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
  const scope = sliderScope(editor);

  let result: string;
  try {
    if (!source.trim()) {
      result = '—';
    } else {
      // Same trust model as the app's expr blocks: the document's own code
      // runs client-side with the slider values in scope.
      const fn = new Function(...Object.keys(scope), `"use strict"; return (${source});`);
      const value = fn(...Object.values(scope)) as unknown;
      result = typeof value === 'number' && !Number.isInteger(value) ? String(Math.round(value * 1000) / 1000) : String(value);
    }
  } catch (err) {
    result = `⚠ ${err instanceof Error ? err.message : String(err)}`;
  }

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
  registerCustomBlock({
    type: 'formula',
    render: FormulaBlock,
    slash: {
      label: 'Formula',
      hint: 'Live code over sliders',
      keywords: 'formula code expr compute reactive',
      make: () => ({type: 'formula', props: {source: ''}}),
    },
  });
}
