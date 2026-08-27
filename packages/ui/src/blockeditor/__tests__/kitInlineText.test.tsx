import {cleanup, fireEvent, render, screen} from '@testing-library/react';
import {afterEach, beforeAll, describe, expect, it} from 'vitest';
import {BlockEditor} from '../BlockEditor';
import {blockProp, createDoc, findBlock} from '../model';
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

  it('keeps the settings-popover Display name behavior unchanged', () => {
    const {block} = renderSlider({label: 'Old label'});
    fireEvent.click(screen.getByRole('button', {name: 'Block settings'}));
    const [, popoverLabel] = screen.getAllByRole('textbox', {name: 'Display name'});

    fireEvent.change(popoverLabel, {target: {value: 'New friendly name'}});

    expect((popoverLabel as HTMLInputElement).value).toBe('New friendly name');
    expect(blockProp(block, 'label')).toBe('New friendly name');
  });
});
