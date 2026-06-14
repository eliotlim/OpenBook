import {describe, it, expect} from 'vitest';
import {createDoc, blockId} from '../model';
import {splitSlides} from '../present';

const ids = (blocks: ReturnType<typeof splitSlides>[number]['content']): string[] => blocks.map((b) => blockId(b));

describe('splitSlides', () => {
  it('splits at top-level dividers and routes notes aside', () => {
    const doc = createDoc([
      {id: 'h', type: 'heading', props: {level: 1}},
      {id: 'n1', type: 'notes'},
      {id: 'b', type: 'paragraph'},
      {id: 'd1', type: 'divider'},
      {id: 'c', type: 'paragraph'},
      {id: 'n2', type: 'notes'},
    ]);
    const slides = splitSlides(doc);
    expect(slides).toHaveLength(2);
    expect(ids(slides[0].content)).toEqual(['h', 'b']);
    expect(ids(slides[0].notes)).toEqual(['n1']);
    expect(ids(slides[1].content)).toEqual(['c']);
    expect(ids(slides[1].notes)).toEqual(['n2']);
  });

  it('a divider-less doc is a single slide', () => {
    const doc = createDoc([{id: 'a', type: 'paragraph'}, {id: 'b', type: 'paragraph'}]);
    const slides = splitSlides(doc);
    expect(slides).toHaveLength(1);
    expect(ids(slides[0].content)).toEqual(['a', 'b']);
  });

  it('leading / trailing / doubled dividers never yield empty slides', () => {
    const doc = createDoc([
      {id: 'd1', type: 'divider'},
      {id: 'a', type: 'paragraph'},
      {id: 'd2', type: 'divider'},
      {id: 'd3', type: 'divider'},
      {id: 'b', type: 'paragraph'},
      {id: 'd4', type: 'divider'},
    ]);
    const slides = splitSlides(doc);
    expect(slides).toHaveLength(2);
    expect(ids(slides[0].content)).toEqual(['a']);
    expect(ids(slides[1].content)).toEqual(['b']);
  });

  it('a minimal doc yields a single slide', () => {
    // createDoc always keeps at least one block, so this is never truly empty.
    const slides = splitSlides(createDoc([]));
    expect(slides).toHaveLength(1);
  });

  it('a divider-only doc falls back to one (empty) slide rather than none', () => {
    const slides = splitSlides(createDoc([{id: 'd', type: 'divider'}]));
    expect(slides).toHaveLength(1);
    expect(slides[0].content.every((b) => blockId(b) !== 'd')).toBe(true); // divider is a boundary, not content
  });
});
