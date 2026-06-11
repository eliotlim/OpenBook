import {describe, expect, it} from 'vitest';
import {createDoc} from '../../model';
import {evalExpr, formatValue, inputScope, setNamedNumber} from '../scope';

const artifactDoc = () =>
  createDoc([
    {type: 'slider', props: {name: 'x', value: 30, min: 0, max: 100}},
    {type: 'number', props: {name: 'n', value: 4, min: 0, max: 10, step: 1}},
    {type: 'textfield', props: {name: 'who', value: 'Ada'}},
    {type: 'radio', props: {name: 'mode', options: 'A, B', value: 'B'}},
    {type: 'checklist', props: {name: 'tags', options: 'a, b, c', selected: ['a', 'c']}},
    {type: 'toggle', props: {name: 'on', value: true}},
    {type: 'paragraph', text: 'not an input'},
  ]);

describe('inputScope', () => {
  it('collects every named input with its typed value', () => {
    const scope = inputScope(artifactDoc());
    expect(scope).toMatchObject({x: 30, n: 4, who: 'Ada', mode: 'B', tags: ['a', 'c'], on: true});
  });

  it('skips names that are not valid identifiers', () => {
    const doc = createDoc([{type: 'number', props: {name: 'not a name', value: 1}}]);
    expect(inputScope(doc)).toEqual({});
  });
});

describe('evalExpr', () => {
  it('computes over the scope and surfaces errors instead of throwing', () => {
    const scope = inputScope(artifactDoc());
    expect(evalExpr('x + n', scope).value).toBe(34);
    expect(evalExpr('tags.length', scope).value).toBe(2);
    expect(evalExpr('on ? who : "off"', scope).value).toBe('Ada');
    expect(evalExpr('nope +', scope).error).toBeTruthy();
    expect(evalExpr('', scope)).toEqual({value: undefined});
  });
});

describe('setNamedNumber', () => {
  it('increments and clamps to the input declared range', () => {
    const doc = artifactDoc();
    setNamedNumber(doc, 'n', (v) => v + 100);
    expect(inputScope(doc).n).toBe(10); // clamped to max
    setNamedNumber(doc, 'n', () => -5);
    expect(inputScope(doc).n).toBe(0); // clamped to min
  });

  it('flips toggles and ignores unknown or non-numeric targets', () => {
    const doc = artifactDoc();
    setNamedNumber(doc, 'on', (v) => v);
    expect(inputScope(doc).on).toBe(false);
    setNamedNumber(doc, 'who', (v) => v + 1); // textfield: no-op
    expect(inputScope(doc).who).toBe('Ada');
    setNamedNumber(doc, 'ghost', (v) => v + 1); // unknown: no-op
  });
});

describe('formatValue', () => {
  it('renders numbers compactly and structures readably', () => {
    expect(formatValue(1.23456)).toBe('1.235');
    expect(formatValue(undefined)).toBe('—');
    expect(formatValue([1, 'a'])).toBe('1, a');
    expect(formatValue({a: 1})).toBe('{"a":1}');
  });
});
