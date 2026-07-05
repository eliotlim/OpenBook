import {describe, it, expect, afterEach} from 'vitest';
import {render, screen, cleanup, fireEvent} from '@testing-library/react';
import {createDoc} from '../model';
import {registerArtifactKit} from '../kit';
import {BlockEditor} from '../BlockEditor';

afterEach(() => cleanup());

registerArtifactKit(); // registers the toggle (and the rest of the kit)

/**
 * Whole-document read-only (OB-205): a viewer who can't write reads the page
 * locked — no edit chrome (gutter, block menu, drag handle, empty-block
 * placeholder), text frozen — but interactive widgets stay LIVE, exactly the
 * present-mode treatment. Driven entirely by `<BlockEditor readOnly>`.
 */
describe('BlockEditor read-only (viewer rendering)', () => {
  it('drops edit chrome and freezes text, but keeps interactive widgets live', () => {
    const doc = createDoc([
      {id: 'p', type: 'paragraph', text: [{t: 'Hello'}]},
      {id: 'live', type: 'toggle', props: {name: 'live', value: false}},
      {id: 'optout', type: 'toggle', props: {name: 'optout', value: false, interactive: false}},
    ]);
    const {container} = render(<BlockEditor doc={doc} readOnly />);

    // The read-only root carries its marker class (drives the CSS that hides the
    // few always-rendered affordances — the kit ⚙, code actions).
    expect(container.querySelector('.obe-root.obe-readonly')).not.toBeNull();

    // No gutter / add-block affordance anywhere.
    expect(screen.queryByLabelText('Add a block below')).toBeNull();
    expect(screen.queryByLabelText('Drag to move, click for actions')).toBeNull();
    expect(container.querySelector('.obe-gutter')).toBeNull();

    // The paragraph is not editable, and shows no placeholder to a viewer.
    const text = container.querySelector('[data-block-text="p"]') as HTMLElement;
    expect(text).not.toBeNull();
    expect(text.getAttribute('contenteditable')).toBe('false');
    expect(text.getAttribute('data-placeholder')).toBeNull();

    // Interactive widgets stay live; an author-opted-out one freezes.
    const switches = screen.getAllByRole('switch') as HTMLButtonElement[];
    expect(switches).toHaveLength(2);
    expect(switches[0].disabled).toBe(false); // default — stays interactive for the reader
    expect(switches[1].disabled).toBe(true); // interactive: false — frozen
  });

  it('keeps accordion sections toggleable for a read-only viewer, contents frozen', () => {
    const doc = createDoc([
      {id: 'acc', type: 'accordion', children: [
        {id: 's1', type: 'accordionsection', props: {label: 'One'}, children: [
          {id: 'sp', type: 'paragraph', text: [{t: 'inside section'}]},
        ]},
      ]},
    ]);
    const {container} = render(<BlockEditor doc={doc} readOnly />);

    // The section starts expanded and its toggle stays operable — collapse is
    // reader navigation, not an edit (only gating / an author-locked group
    // force-collapses; see AccordionView).
    const toggle = container.querySelector('.obe-acc-toggle') as HTMLButtonElement;
    expect(toggle).not.toBeNull();
    expect(toggle.disabled).toBe(false);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const body = (): HTMLElement | null => container.querySelector('.obe-acc-body');
    expect(body()?.textContent).toContain('inside section');

    // But the section's CONTENTS are frozen for the reader.
    const text = container.querySelector('[data-block-text="sp"]') as HTMLElement;
    expect(text.getAttribute('contenteditable')).toBe('false');

    // Toggling collapses and re-expands the section.
    fireEvent.click(toggle);
    expect(container.querySelector('.obe-acc-toggle')?.getAttribute('aria-expanded')).toBe('false');
    expect(body()).toBeNull();
    fireEvent.click(container.querySelector('.obe-acc-toggle') as HTMLButtonElement);
    expect(body()?.textContent).toContain('inside section');
  });

  it('freezes table cells under a locked group (TableView applies the lock swap)', () => {
    // Regression coverage for the TableView lock leak: cells render
    // TextBlockView directly (not through BlockBody), so the table must apply
    // the lock swap itself — in a WRITABLE editor, a locked group's table
    // cells were left contenteditable while everything around them froze.
    const doc = createDoc([
      {id: 'free', type: 'paragraph', text: [{t: 'outside'}]},
      {id: 'grp', type: 'group', props: {name: 'Box', locked: true}, children: [
        {id: 'tbl', type: 'table', children: [
          {id: 'row', type: 'row', children: [{id: 'cell', type: 'cell', text: [{t: 'locked cell'}]}]},
        ]},
      ]},
    ]);
    const {container} = render(<BlockEditor doc={doc} />); // writable editor
    const outside = container.querySelector('[data-block-text="free"]') as HTMLElement;
    expect(outside.getAttribute('contenteditable')).toBe('true'); // page itself is editable
    const cell = container.querySelector('[data-block-text="cell"]') as HTMLElement;
    expect(cell).not.toBeNull();
    expect(cell.getAttribute('contenteditable')).toBe('false'); // the locked group freezes the cell
  });

  it('renders fully editable (gutter + contentEditable) when writable', () => {
    const doc = createDoc([{id: 'p', type: 'paragraph', text: [{t: 'Hello'}]}]);
    const {container} = render(<BlockEditor doc={doc} />);
    expect(container.querySelector('.obe-root.obe-readonly')).toBeNull();
    expect(screen.getByLabelText('Add a block below')).toBeTruthy();
    const text = container.querySelector('[data-block-text="p"]') as HTMLElement;
    expect(text.getAttribute('contenteditable')).toBe('true');
  });
});
