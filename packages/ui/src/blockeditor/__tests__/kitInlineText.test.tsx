import {cleanup, fireEvent, render, screen} from '@testing-library/react';
import {afterEach, beforeAll, describe, expect, it} from 'vitest';
import {BlockEditor} from '../BlockEditor';
import {blockProp, createDoc, findBlock} from '../model';
import {computeScopeAuthoritative, setNamedNumber} from '../kit/scope';
import {registerReactiveBlocks} from '../reactiveBlocks';

beforeAll(() => registerReactiveBlocks());
afterEach(() => cleanup());

const renderSlider = (props: Record<string, unknown> = {}) => {
  const doc = createDoc([{id: 'slider', type: 'slider', props: {name: 'months', value: 1, ...props}}]);
  render(<BlockEditor doc={doc} />);
  const block = findBlock(doc, 'slider')!.block;
  return {block};
};

describe('kit inline text editing', () => {
  it('commits an inline slider label with an interior space exactly', () => {
    const {block} = renderSlider({label: ''});
    const label = screen.getByRole('textbox', {name: 'Display name'});

    fireEvent.change(label, {target: {value: 'a'}});
    fireEvent.change(label, {target: {value: 'a '}});
    expect((label as HTMLInputElement).value).toBe('a ');
    fireEvent.change(label, {target: {value: 'a b'}});

    expect((label as HTMLInputElement).value).toBe('a b');
    expect(blockProp(block, 'label')).toBe('a b');
  });

  it('keeps every interior space while typing a multi-word label', () => {
    const {block} = renderSlider({label: ''});
    const label = screen.getByRole('textbox', {name: 'Display name'});

    for (const value of ['Number', 'Number ', 'Number of', 'Number of ', 'Number of months']) {
      fireEvent.change(label, {target: {value}});
      expect((label as HTMLInputElement).value).toBe(value);
    }
    expect(blockProp(block, 'label')).toBe('Number of months');
  });

  it('normalizes a variable name on blur, not during typing', () => {
    const {block} = renderSlider({name: 'months'});
    fireEvent.click(screen.getByRole('button', {name: 'Block settings'}));
    const name = screen.getByRole('textbox', {name: 'Variable name'});

    fireEvent.change(name, {target: {value: ' foo '}});
    expect((name as HTMLInputElement).value).toBe(' foo ');
    expect(blockProp(block, 'name')).toBe(' foo ');
    fireEvent.blur(name);

    expect(blockProp(block, 'name')).toBe('foo');
  });

  it('publishes a stored live-code name after trimming it at the read boundary', async () => {
    const doc = createDoc([{id: 'code', type: 'code', text: '6 * 7', props: {live: true, name: ' total '}}]);

    expect((await computeScopeAuthoritative(doc)).scope.total).toBe(42);
  });

  it('resolves an action-button target after trimming it at the read boundary', () => {
    const doc = createDoc([
      {id: 'count', type: 'number', props: {name: 'count', value: 1}},
      {id: 'button', type: 'actionbutton', props: {action: 'increment', target: ' count ', amount: 2}},
    ]);
    const button = findBlock(doc, 'button')!.block;

    setNamedNumber(doc, blockProp<string>(button, 'target')!, (value) => value + 2);

    expect(blockProp(findBlock(doc, 'count')!.block, 'value')).toBe(3);
  });

  it('normalizes a live code output name on blur, not during typing', () => {
    const doc = createDoc([{id: 'code', type: 'code', text: '42', props: {live: true, name: 'result'}}]);
    render(<BlockEditor doc={doc} />);
    const block = findBlock(doc, 'code')!.block;
    fireEvent.click(screen.getByRole('button', {name: 'Block settings'}));
    const name = screen.getByRole('textbox', {name: 'Output name'});

    fireEvent.change(name, {target: {value: ' total '}});
    expect((name as HTMLInputElement).value).toBe(' total ');
    expect(blockProp(block, 'name')).toBe(' total ');
    fireEvent.blur(name);

    expect(blockProp(block, 'name')).toBe('total');
  });
});
