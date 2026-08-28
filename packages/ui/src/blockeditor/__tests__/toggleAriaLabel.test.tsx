import {afterEach, describe, expect, it} from 'vitest';
import {cleanup, render, screen} from '@testing-library/react';
import {createDoc, rootBlocks, type BlockMap} from '../model';
import type {BlockEditorController} from '../useBlockEditor';
import {INPUT_BLOCKS} from '../kit/inputs';

function renderToggle(props: Record<string, unknown>): void {
  const doc = createDoc([{id: 'toggle', type: 'toggle', props}]);
  const block: BlockMap = rootBlocks(doc).get(0);
  const Toggle = INPUT_BLOCKS.find((definition) => definition.type === 'toggle')!.render;
  const editor = {doc, readOnly: false} as unknown as BlockEditorController;
  render(<Toggle block={block} editor={editor} pageReadOnly={false} />);
}

afterEach(() => cleanup());

describe('ToggleBlock accessible name', () => {
  it('uses the canonical display label', () => {
    renderToggle({name: 'diet', label: 'Low-fat', value: false});

    expect(screen.getByRole('switch', {name: 'Low-fat'})).toBeTruthy();
  });

  it('falls back to the input name when no label is set', () => {
    renderToggle({name: 'diet', value: false});

    expect(screen.getByRole('switch', {name: 'diet toggle'})).toBeTruthy();
  });

  it('treats a whitespace-only label as absent', () => {
    renderToggle({name: 'diet', label: '   ', value: false});

    expect(screen.getByRole('switch', {name: 'diet toggle'})).toBeTruthy();
  });
});
