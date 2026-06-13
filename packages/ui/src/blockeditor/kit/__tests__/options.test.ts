import {describe, it, expect} from 'vitest';
import {createDoc, rootBlocks} from '../../model';
import {labelOf, parseOptionsString, resolveOptions, resolveOptionsFromProps, slugify, optionValue} from '../options';

describe('kit options', () => {
  it('slugifies labels into clean values', () => {
    expect(slugify('Option 1')).toBe('option-1');
    expect(slugify('  Café & Bar!! ')).toBe('caf-bar');
  });

  it('defaults an option value to the slug of its label', () => {
    expect(optionValue({label: 'Option 1'})).toBe('option-1');
    expect(optionValue({label: 'Option 1', value: 'opt1'})).toBe('opt1');
  });

  it('parses the legacy comma string (value == label, or Label = value)', () => {
    expect(parseOptionsString('One, Two')).toEqual([
      {label: 'One', value: 'One'},
      {label: 'Two', value: 'Two'},
    ]);
    expect(parseOptionsString('Option 1 = opt1, Two')).toEqual([
      {label: 'Option 1', value: 'opt1'},
      {label: 'Two', value: 'Two'},
    ]);
  });

  it('resolves structured opts, slugging blank values', () => {
    expect(resolveOptionsFromProps({opts: [{label: 'Option 1'}, {label: 'Two', value: 'second'}]})).toEqual([
      {label: 'Option 1', value: 'option-1'},
      {label: 'Two', value: 'second'},
    ]);
  });

  it('reads either prop form off a real block, preferring opts', () => {
    const doc = createDoc([
      {id: 'a', type: 'radio', props: {opts: [{label: 'Yes', value: 'y'}, {label: 'No', value: 'n'}]}},
      {id: 'b', type: 'radio', props: {options: 'Up, Down'}},
    ]);
    const [a, b] = [rootBlocks(doc).get(0), rootBlocks(doc).get(1)];
    expect(resolveOptions(a)).toEqual([{label: 'Yes', value: 'y'}, {label: 'No', value: 'n'}]);
    expect(resolveOptions(b)).toEqual([{label: 'Up', value: 'Up'}, {label: 'Down', value: 'Down'}]);
  });

  it('maps a stored value back to its label', () => {
    const opts = [{label: 'Yes', value: 'y'}, {label: 'No', value: 'n'}];
    expect(labelOf(opts, 'n')).toBe('No');
    expect(labelOf(opts, 'missing')).toBe('missing');
  });
});
