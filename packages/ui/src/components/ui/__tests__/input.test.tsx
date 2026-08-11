import {afterEach, describe, expect, it} from 'vitest';
import {cleanup, render, screen} from '@testing-library/react';
import {SETTINGS_CONTROL_CLASS} from '@/components/settings/primitives';
import {Button} from '../button';
import {Input, inputVariants} from '../input';
import {Select} from '../select';

afterEach(() => cleanup());

function expectClasses(element: HTMLElement, classes: string[]): void {
  for (const className of classes) expect(element.classList.contains(className)).toBe(true);
}

describe('input control variants', () => {
  it('renders the default panel-field recipe', () => {
    render(<Input aria-label="Default input" />);

    expectClasses(screen.getByRole('textbox', {name: 'Default input'}), ['h-control-md', 'px-3', 'py-2']);
  });

  it('renders the sm dense-field recipe', () => {
    render(<Input inputSize="sm" aria-label="Dense input" />);

    expectClasses(screen.getByRole('textbox', {name: 'Dense input'}), ['h-control-sm', 'px-2.5', 'py-1.5']);
  });

  it('keeps settings controls on the sm input variant', () => {
    expect(SETTINGS_CONTROL_CLASS).toBe(inputVariants({inputSize: 'sm'}));
  });

  it('applies input variant classes to a styled Select', () => {
    render(
      <Select inputSize="sm" value="dense" aria-label="Dense select">
        <option value="dense">Dense</option>
      </Select>,
    );

    expectClasses(screen.getByRole('combobox', {name: 'Dense select'}), inputVariants({inputSize: 'sm'}).split(' '));
  });

  it('renders the xs Button recipe for dense rows', () => {
    render(<Button size="xs">Save</Button>);

    expectClasses(screen.getByRole('button', {name: 'Save'}), ['h-control-sm', 'px-2.5', 'text-xs']);
  });
});
