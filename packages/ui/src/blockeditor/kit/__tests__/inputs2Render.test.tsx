import {describe, it, expect, afterEach} from 'vitest';
import {render, screen, cleanup, fireEvent} from '@testing-library/react';
import {createDoc, rootBlocks, blockProp, type BlockMap} from '../../model';
import type {BlockEditorController} from '../../useBlockEditor';
import {INPUT2_BLOCKS} from '../inputs2';
import {PROGRESS_BLOCKS} from '../progress';
import {hasKitConfig} from '../kitConfig';

function renderBlock(blocks: typeof INPUT2_BLOCKS | typeof PROGRESS_BLOCKS, type: string, props: Record<string, unknown>) {
  const doc = createDoc([{id: 'x', type, props}]);
  const block: BlockMap = rootBlocks(doc).get(0);
  const def = blocks.find((d) => d.type === type)!;
  const Comp = def.render;
  const editor = {doc, readOnly: false} as unknown as BlockEditorController;
  return {...render(<Comp block={block} editor={editor} />), doc, block};
}

afterEach(() => cleanup());

describe('choice cards', () => {
  it('renders cards and selects one (single) on click', () => {
    const {block} = renderBlock(INPUT2_BLOCKS, 'choicecards', {name: 'plan', opts: [{label: 'Free'}, {label: 'Pro'}]});
    const cards = screen.getAllByRole('radio');
    expect(cards).toHaveLength(2);
    fireEvent.click(cards[1]);
    expect(blockProp(block, 'value')).toBe('pro');
  });

  it('multi-select cards toggle into the selected array', () => {
    // The stub editor doesn't re-render on doc updates (the real one does, via
    // the version counter), so assert one toggle at a time — the component
    // reads `selected` fresh from props on each render.
    const {block} = renderBlock(INPUT2_BLOCKS, 'choicecards', {name: 'a', multi: true, opts: [{label: 'A'}, {label: 'B'}], selected: ['a']});
    fireEvent.click(screen.getAllByRole('checkbox')[1]); // add B
    expect(blockProp(block, 'selected')).toEqual(['a', 'b']);
  });

  it('exposes the settings affordance', () => {
    renderBlock(INPUT2_BLOCKS, 'choicecards', {name: 'plan', opts: [{label: 'Free'}]});
    expect(screen.getByLabelText('Configure block')).toBeTruthy();
    expect(hasKitConfig('x')).toBe(true);
  });
});

describe('long text', () => {
  it('writes the textarea value to the block', () => {
    const {block} = renderBlock(INPUT2_BLOCKS, 'longtext', {name: 'notes', value: ''});
    const ta = screen.getByLabelText('notes value');
    fireEvent.change(ta, {target: {value: 'a longer note'}});
    expect(blockProp(block, 'value')).toBe('a longer note');
  });
});

describe('tag field', () => {
  it('adds a free-entry tag on Enter and removes the last on Backspace', () => {
    const {block} = renderBlock(INPUT2_BLOCKS, 'tagfield', {name: 'topics', selected: ['ai'], freeEntry: true});
    const input = screen.getByLabelText('Add a tag');
    fireEvent.change(input, {target: {value: 'ml'}});
    fireEvent.keyDown(input, {key: 'Enter'});
    expect(blockProp(block, 'selected')).toEqual(['ai', 'ml']);
    fireEvent.keyDown(input, {key: 'Backspace'});
    expect(blockProp(block, 'selected')).toEqual(['ai']);
  });
});

describe('progress bar', () => {
  it('renders a progressbar role with the computed percentage and publishes nothing', () => {
    const {block} = renderBlock(PROGRESS_BLOCKS, 'progressbar', {label: 'Done', source: '0.5', max: 1, format: 'percent'});
    const bar = screen.getByRole('progressbar');
    expect(bar.getAttribute('aria-valuenow')).toBe('50');
    // It's a display, not an input — no value prop written.
    expect(blockProp(block, 'value')).toBeUndefined();
  });
});
