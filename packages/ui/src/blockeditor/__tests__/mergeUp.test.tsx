import {describe, it, expect} from 'vitest';
import {renderHook, act} from '@testing-library/react';
import {createDoc, rootBlocks, blockId, blockType, blockPlainText} from '../model';
import {useBlockEditor} from '../useBlockEditor';

/**
 * #7: pressing Backspace on an empty block must delete the line and move up.
 * The keydown wiring is exercised in the app; here we test the controller op
 * it calls (`mergeUp`), which is where the empty-block deletion lives.
 */
describe('mergeUp on an empty block', () => {
  it('deletes an empty paragraph and merges into the previous text block', () => {
    const doc = createDoc([
      {id: 'a', type: 'paragraph', text: 'hello'},
      {id: 'b', type: 'paragraph'},
    ]);
    const {result} = renderHook(() => useBlockEditor(doc));
    act(() => result.current.mergeUp('b'));

    const roots = rootBlocks(doc);
    expect(roots.length).toBe(1);
    expect(blockId(roots.get(0))).toBe('a');
    expect(blockPlainText(roots.get(0))).toBe('hello');
  });

  it('removes an empty paragraph that follows a non-text block', () => {
    const doc = createDoc([
      {id: 's', type: 'slider', props: {name: 'x', value: 1}},
      {id: 'p', type: 'paragraph'},
    ]);
    const {result} = renderHook(() => useBlockEditor(doc));
    act(() => result.current.mergeUp('p'));

    const roots = rootBlocks(doc);
    expect(roots.length).toBe(1);
    expect(blockType(roots.get(0))).toBe('slider');
  });

  it('downgrades a non-paragraph before deleting (first Backspace keeps the line)', () => {
    const doc = createDoc([{id: 'h', type: 'heading', props: {level: 1}}]);
    const {result} = renderHook(() => useBlockEditor(doc));
    act(() => result.current.mergeUp('h'));

    const roots = rootBlocks(doc);
    expect(roots.length).toBe(1);
    expect(blockType(roots.get(0))).toBe('paragraph'); // heading → paragraph, not deleted
  });
});
