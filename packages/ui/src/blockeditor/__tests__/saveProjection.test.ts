import {describe, expect, it} from 'vitest';
import type {PageSnapshot} from '@book.dev/sdk';
import {createDoc, decodeSnapshot, findBlock, setBlockProp, type BlockDocSnapshot} from '../model';
import {projectBlockPageSnapshot} from '../saveProjection';
import {computeScopeAuthoritative} from '../kit/scope';

const baseSnapshot = (): PageSnapshot => ({editorjs: {blocks: []}, values: [], names: []});

describe('authoritative save projection', () => {
  it('round-trips inputs, chained values, and export cells from the specific document', async () => {
    const doc = createDoc([
      {id: 'n', type: 'number', props: {name: 'n', value: 4}},
      {id: 'double', type: 'code', text: 'n * 2', props: {live: true, name: 'double'}},
      {id: 'plus', type: 'formula', props: {name: 'plus', source: 'double + 1'}},
      {id: 'chart', type: 'kitchart', props: {kind: 'bar', source: '[n, double, plus]'}},
      {id: 'light', type: 'statuslight', props: {source: 'plus > 8', okAt: 1, warnAt: 0}},
    ]);

    const saved = await projectBlockPageSnapshot(doc, baseSnapshot());
    const savedValues = new Map(saved.values);
    expect(savedValues.get('n')).toBe(4);
    expect(savedValues.get('double')).toBe(8);
    expect(savedValues.get('plus')).toBe(9);
    expect(savedValues.get('chart')).toEqual([4, 8, 9]);
    expect(savedValues.get('light')).toBe(true);

    const reopened = decodeSnapshot(saved.blockdoc as BlockDocSnapshot);
    expect((await computeScopeAuthoritative(reopened)).scope).toMatchObject({n: 4, double: 8, plus: 9});
    expect((await projectBlockPageSnapshot(reopened, saved)).values).toEqual(saved.values);

    // The next checkpoint reads the supplied Y.Doc, not any last UI cache.
    const input = findBlock(doc, 'n')!.block;
    doc.transact(() => setBlockProp(input, 'value', 7), 'local');
    const next = await projectBlockPageSnapshot(doc, saved);
    const nextValues = new Map(next.values);
    expect(nextValues.get('n')).toBe(7);
    expect(nextValues.get('double')).toBe(14);
    expect(nextValues.get('plus')).toBe(15);
    expect(nextValues.get('chart')).toEqual([7, 14, 15]);
    expect(nextValues.get('light')).toBe(true);
  });
});
