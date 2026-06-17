import {describe, it, expect} from 'vitest';
import {blockChildren, blockText, blockToJSON, coerceNewBlock, createDoc, findBlock, makeBlock, replaceText, rootBlocks} from '../model';
import {merge3} from '@/lib/textMerge';

/**
 * The AI bridge's accept→apply path (AiBridgeHost) is built from these model
 * primitives. These tests pin the two behaviours the bridge relies on:
 *  - applying two `update_block` suggestions to the SAME block keeps both edits
 *    (the overwrite bug), via merge3 + replaceText;
 *  - `coerceNewBlock` turns an AI `append_blocks` payload into rich, nested
 *    blocks (interactive inputs inside a layout), not just flat paragraphs.
 */

/** Replay an update_block suggestion the way AiBridgeHost does. */
function applyUpdate(doc: ReturnType<typeof createDoc>, blockIdStr: string, base: string, text: string): void {
  const found = findBlock(doc, blockIdStr);
  const t = found && blockText(found.block);
  if (!t) throw new Error('block not found');
  replaceText(t, merge3(base, t.toString(), text));
}

describe('AI apply: update_block merge', () => {
  it('keeps both edits when two suggestions target the same block', () => {
    const doc = createDoc([{id: 'b1', type: 'paragraph', text: 'the quick brown fox'}]);
    // Two suggestions, both authored against the original text.
    applyUpdate(doc, 'b1', 'the quick brown fox', 'the slow brown fox'); // edit A
    applyUpdate(doc, 'b1', 'the quick brown fox', 'the quick brown dog'); // edit B
    const text = blockText(findBlock(doc, 'b1')!.block)!.toString();
    // Neither clobbered the other (the old full-replace would have lost A → "the quick brown dog").
    expect(text).toBe('the slow brown dog');
  });

  it('replaceText preserves inline formatting outside the changed span', () => {
    const doc = createDoc([{id: 'b1', type: 'paragraph', text: [{t: 'Hello '}, {t: 'world', a: {b: true}}]}]);
    const t = blockText(findBlock(doc, 'b1')!.block)!;
    replaceText(t, 'Hello brave world'); // only the middle changed
    const runs = blockToJSON(findBlock(doc, 'b1')!.block).text ?? [];
    // "world" keeps its bold run because the suffix was never deleted.
    expect(runs.some((r) => r.t.includes('world') && r.a?.b)).toBe(true);
    expect(t.toString()).toBe('Hello brave world');
  });
});

describe('AI apply: coerceNewBlock builds rich nested blocks', () => {
  it('builds a layout with interactive inputs and a chart', () => {
    const payload = [
      {type: 'heading', text: 'Budget', props: {level: 2}},
      {
        type: 'columns',
        children: [
          {
            type: 'column',
            props: {span: 5},
            children: [{type: 'slider', props: {name: 'spent', label: 'Spent', value: 80, min: 0, max: 200}}],
          },
          {
            type: 'column',
            props: {span: 7},
            children: [{type: 'kitchart', props: {kind: 'bar', source: '[spent]'}}],
          },
        ],
      },
    ];
    const doc = createDoc([{id: 'seed', type: 'paragraph'}]);
    const built = payload.map(coerceNewBlock).filter((b): b is NonNullable<typeof b> => b !== null).map(makeBlock);
    rootBlocks(doc).push(built);

    // Root now: [seed, heading, columns].
    expect(blockToJSON(rootBlocks(doc).get(1)).type).toBe('heading');
    const cols = rootBlocks(doc).get(2);
    const colsJson = blockToJSON(cols);
    expect(colsJson.type).toBe('columns');
    const slider = colsJson.children?.[0]?.children?.[0];
    expect(slider?.type).toBe('slider');
    expect(slider?.props?.name).toBe('spent');
    expect(colsJson.children?.[1]?.children?.[0]?.type).toBe('kitchart');
    // The container actually holds Y children (not just a JSON echo).
    expect(blockChildren(cols)?.length).toBe(2);
  });

  it('rejects junk and coerces missing types to paragraph', () => {
    expect(coerceNewBlock(null)).toBeNull();
    expect(coerceNewBlock(42)).toBeNull();
    expect(coerceNewBlock({})?.type).toBe('paragraph');
  });
});
