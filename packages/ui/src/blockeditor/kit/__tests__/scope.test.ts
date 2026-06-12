import {describe, expect, it} from 'vitest';
import {createDoc} from '../../model';
import {computeScope, evalCode, evalExpr, formatValue, inputScope, setNamedNumber} from '../scope';

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

describe('computeScope (live code chaining)', () => {
  it('evaluates live code in document order, names chaining forward', () => {
    const doc = createDoc([
      {id: 'b1', type: 'number', props: {name: 'n', value: 3}},
      {id: 'b2', type: 'code', text: 'n * 2', props: {live: true, name: 'double'}},
      {id: 'b3', type: 'code', text: 'double + 1', props: {live: true, name: 'plus'}},
      {id: 'b4', type: 'formula', props: {source: 'plus * 10'}},
    ]);
    const {scope, results} = computeScope(doc);
    expect(scope).toMatchObject({n: 3, double: 6, plus: 7});
    expect(results.get('b2')).toEqual({value: 6});
    expect(results.get('b4')).toEqual({value: 70});
  });

  it('forward references read undefined (single ordered pass, no cycles)', () => {
    const doc = createDoc([
      {id: 'b1', type: 'code', text: 'typeof later', props: {live: true, name: 'early'}},
      {id: 'b2', type: 'code', text: '5', props: {live: true, name: 'later'}},
    ]);
    expect(computeScope(doc).scope.early).toBe('undefined');
  });

  it('supports multi-line function bodies and isolates errors', () => {
    const doc = createDoc([
      {id: 'b1', type: 'number', props: {name: 'n', value: 4}},
      {id: 'b2', type: 'code', text: 'const out = []; for (let i = 0; i < n; i++) out.push(i * i); return out;', props: {live: true, name: 'squares'}},
      {id: 'b3', type: 'code', text: 'nope(', props: {live: true, name: 'broken'}},
      {id: 'b4', type: 'formula', props: {source: 'squares.length'}},
    ]);
    const {scope, results} = computeScope(doc);
    expect(scope.squares).toEqual([0, 1, 4, 9]);
    expect(results.get('b3')?.error).toBeTruthy();
    expect('broken' in scope).toBe(false); // errors never publish
    expect(results.get('b4')).toEqual({value: 4});
  });

  it('non-live code blocks stay inert', () => {
    const doc = createDoc([{id: 'b1', type: 'code', text: '1 + 1', props: {name: 'x'}}]);
    const {scope, results} = computeScope(doc);
    expect('x' in scope).toBe(false);
    expect(results.size).toBe(0);
  });
});

describe('evalCode', () => {
  it('takes expressions, falls back to function bodies', () => {
    expect(evalCode('2 + 2', {}).value).toBe(4);
    expect(evalCode('const x = 2; return x * 3;', {}).value).toBe(6);
    expect(evalCode('throw new Error("boom")', {}).error).toContain('boom');
  });
});
