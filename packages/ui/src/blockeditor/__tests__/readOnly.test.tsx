import {describe, it, expect, afterEach} from 'vitest';
import {render, screen, cleanup} from '@testing-library/react';
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

  it('renders fully editable (gutter + contentEditable) when writable', () => {
    const doc = createDoc([{id: 'p', type: 'paragraph', text: [{t: 'Hello'}]}]);
    const {container} = render(<BlockEditor doc={doc} />);
    expect(container.querySelector('.obe-root.obe-readonly')).toBeNull();
    expect(screen.getByLabelText('Add a block below')).toBeTruthy();
    const text = container.querySelector('[data-block-text="p"]') as HTMLElement;
    expect(text.getAttribute('contenteditable')).toBe('true');
  });
});
