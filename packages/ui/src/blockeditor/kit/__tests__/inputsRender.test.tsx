import {describe, it, expect, afterEach} from 'vitest';
import {render, screen, cleanup, within} from '@testing-library/react';
import {createDoc, rootBlocks, type BlockMap} from '../../model';
import type {BlockEditorController} from '../../useBlockEditor';
import {INPUT_BLOCKS} from '../inputs';
import {hasKitConfig} from '../kitConfig';

/** Render a kit input block with a minimal (non-interactive) editor stub. */
function renderInput(type: string, props: Record<string, unknown>) {
  const doc = createDoc([{id: 'x', type, props}]);
  const block: BlockMap = rootBlocks(doc).get(0);
  const def = INPUT_BLOCKS.find((d) => d.type === type)!;
  const Comp = def.render;
  const editor = {doc, readOnly: false} as unknown as BlockEditorController;
  return render(<Comp block={block} editor={editor} />);
}

afterEach(() => cleanup());

describe('kit input rendering', () => {
  it('renders choice options full-width by default, with a settings affordance', () => {
    const {container} = renderInput('radio', {name: 'mode', opts: [{label: 'One'}, {label: 'Two'}]});
    const root = container.querySelector('.obe-kit-radio')!;
    expect(root.classList.contains('obe-kit-wide')).toBe(true); // full-width is the default
    expect(screen.getByLabelText('Configure block')).toBeTruthy();
    const group = screen.getByRole('radiogroup');
    expect(within(group).getByText('One')).toBeTruthy();
    expect(within(group).getByText('Two')).toBeTruthy();
  });

  it('opts into the compact layout when asked', () => {
    const {container} = renderInput('radio', {name: 'mode', compact: true, opts: [{label: 'One'}]});
    expect(container.querySelector('.obe-kit-radio')!.classList.contains('obe-kit-wide')).toBe(false);
  });

  it('shows the display label and serialises the option value (decoupled)', () => {
    // Display "Option A", value "a"; the stored value is the value, shown label.
    renderInput('radio', {name: 'choice', opts: [{label: 'Option A', value: 'a'}], value: 'a'});
    const selected = screen.getByRole('radio', {checked: true});
    expect(selected.textContent).toContain('Option A');
  });

  it('uses the display name in the header, decoupled from the variable symbol', () => {
    renderInput('toggle', {name: 'darkMode', label: 'Dark mode', value: false});
    // The header shows the friendly label as an edit-in-place field (WYSIWYG)…
    expect(screen.getByDisplayValue('Dark mode')).toBeTruthy();
    // …not the `darkMode` symbol (that lives in the closed config popover).
    expect(screen.queryByText('darkMode')).toBeNull();
    expect(screen.queryByDisplayValue('darkMode')).toBeNull();
  });

  it('registers a config opener so the context menu can "Configure" it', () => {
    renderInput('radio', {name: 'mode', opts: [{label: 'One'}]});
    expect(hasKitConfig('x')).toBe(true); // the block id used by renderInput
  });
});
