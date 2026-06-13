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

  it('draws charts in the export by referencing the computed cell', () => {
    const out = blocksToEditorJs(kitDoc());
    const plot = out.blocks.find((b) => b.type === 'chart');
    expect(plot).toMatchObject({id: 'k1-plot', data: {refCellIds: ['k1']}});
  });

  it('keeps option inputs interactive (kitinput) and buttons working (kitbutton)', () => {
    const out = blocksToEditorJs(kitDoc());
    const inputs = out.blocks.filter((b) => b.type === 'kitinput');
    expect(inputs.map((b) => (b.data as {kind: string}).kind).sort()).toEqual(['checklist', 'radio', 'textfield']);
    const radio = inputs.find((b) => (b.data as {kind: string}).kind === 'radio');
    // Legacy `options` strings resolve to {label,value} pairs (value == label).
    expect(radio).toMatchObject({
      id: 'r1',
      data: {name: 'mode', opts: [{label: 'A', value: 'A'}, {label: 'B', value: 'B'}], value: 'B'},
    });
    // The button resolves its target name to the cell id, with clamp bounds.
    const button = out.blocks.find((b) => b.type === 'kitbutton');
    expect(button).toMatchObject({id: 'b1', data: {label: 'Go', action: 'increment', target: 'n1', min: 0, max: 10}});
    // The status light renders as a live light fed by a hidden expr.
    const light = out.blocks.find((b) => b.type === 'kitlight');
    expect(light).toMatchObject({data: {refCellId: 's1', label: 'Health'}});
    const texts = out.blocks.filter((b) => b.type === 'paragraph').map((b) => (b.data as {text: string}).text);
    expect(texts.some((t) => t.includes('<a href="https://example.com">Docs</a> — Read me'))).toBe(true);
  });

  it('exports the dropdown as an interactive kitinput publishing its value', () => {
    const out = blocksToEditorJs(
      docToJSON(createDoc([{id: 'd1', type: 'dropdown', props: {name: 'region', options: 'EU, US', value: 'US'}}])),
    );
    expect(out.blocks.find((b) => b.type === 'kitinput')).toMatchObject({
      id: 'd1',
      data: {kind: 'dropdown', value: 'US'},
    });
    expect(out.values).toEqual(expect.arrayContaining([['d1', 'US']]));
    expect(out.names).toEqual(expect.arrayContaining([['region', 'd1']]));
  });
});

describe('live code export', () => {
  it('exports live code as named exprs with chained references tokenized', () => {
    const out = blocksToEditorJs(
      docToJSON(
        createDoc([
          {id: 'n1', type: 'number', props: {name: 'n', value: 2}},
          {id: 'c1', type: 'code', text: 'n * 2', props: {live: true, name: 'double', language: 'js'}},
          {id: 'c2', type: 'code', text: 'double + n', props: {live: true, name: 'sum'}},
          {id: 'c3', type: 'code', text: 'plain snippet', props: {language: 'md'}},
        ]),
      ),
    );
    const exprs = out.blocks.filter((b) => b.type === 'expr');
    expect(exprs).toHaveLength(2);
    expect(exprs[0].data).toMatchObject({name: 'double', source: '__C__{n1}__ * 2'});
    expect(exprs[1].data).toMatchObject({name: 'sum', source: '__C__{c1}__ + __C__{n1}__'});
    expect(out.names).toEqual(expect.arrayContaining([['double', 'c1'], ['sum', 'c2']]));
    const code = out.blocks.find((b) => b.type === 'code');
    expect(code?.data).toMatchObject({code: 'plain snippet', language: 'md'});
  });
});
