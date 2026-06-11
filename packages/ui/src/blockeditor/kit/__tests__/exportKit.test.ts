import {describe, expect, it} from 'vitest';
import {createDoc, docToJSON} from '../../model';
import {blocksToEditorJs} from '../../exportBlocks';

const kitDoc = () =>
  docToJSON(
    createDoc([
      {id: 'n1', type: 'number', props: {name: 'n', value: 4, min: 0, max: 10, step: 2}},
      {id: 't1', type: 'textfield', props: {name: 'who', label: 'Name', value: 'Ada'}},
      {id: 'r1', type: 'radio', props: {name: 'mode', options: 'A, B', value: 'B'}},
      {id: 'c1', type: 'checklist', props: {name: 'tags', options: 'a, b', selected: ['a', 'b']}},
      {id: 's1', type: 'statuslight', props: {label: 'Health', source: 'n + 1', okAt: 1, warnAt: 0}},
      {id: 'k1', type: 'kitchart', props: {kind: 'bar', title: 'Powers', source: '[n, n*n]'}},
      {id: 'b1', type: 'actionbutton', props: {btnlabel: 'Go', action: 'increment', target: 'n'}},
      {id: 'l1', type: 'linkcard', props: {title: 'Docs', description: 'Read me', url: 'example.com'}},
    ]),
  );

describe('kit export mappings', () => {
  it('keeps steppers interactive as sliders and publishes every input value', () => {
    const out = blocksToEditorJs(kitDoc());
    const slider = out.blocks.find((b) => b.type === 'slider');
    expect(slider).toMatchObject({id: 'n1', data: {name: 'n', min: 0, max: 10, step: 2, initial: 4}});
    expect(out.values).toEqual(
      expect.arrayContaining([
        ['n1', 4],
        ['t1', 'Ada'],
        ['r1', 'B'],
        ['c1', ['a', 'b']],
      ]),
    );
    expect(out.names).toEqual(
      expect.arrayContaining([
        ['n', 'n1'],
        ['who', 't1'],
        ['mode', 'r1'],
        ['tags', 'c1'],
      ]),
    );
  });

  it('tokenizes status and chart expressions over every named input', () => {
    const out = blocksToEditorJs(kitDoc());
    const exprs = out.blocks.filter((b) => b.type === 'expr');
    expect(exprs).toHaveLength(2);
    const status = exprs.find((b) => (b.data as {name: string}).name === 'Health');
    expect((status?.data as {source: string}).source).toBe('__C__{n1}__ + 1');
    const chart = exprs.find((b) => (b.data as {name: string}).name === 'Powers');
    expect((chart?.data as {source: string}).source).toBe('[__C__{n1}__, __C__{n1}__*__C__{n1}__]');
  });

  it('freezes text-ish inputs to readable paragraphs and links cards', () => {
    const out = blocksToEditorJs(kitDoc());
    const texts = out.blocks.filter((b) => b.type === 'paragraph').map((b) => (b.data as {text: string}).text);
    expect(texts.some((t) => t.includes('<b>Name</b>: Ada'))).toBe(true);
    expect(texts.some((t) => t.includes('<b>mode</b>: B'))).toBe(true);
    expect(texts.some((t) => t.includes('a, b'))).toBe(true);
    expect(texts.some((t) => t.includes('<a href="https://example.com">Docs</a> — Read me'))).toBe(true);
    // Buttons act on the live doc only — no export artifact.
    expect(out.blocks.some((b) => JSON.stringify(b).includes('Go'))).toBe(false);
  });
});
