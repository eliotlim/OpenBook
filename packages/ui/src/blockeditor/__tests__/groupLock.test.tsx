import {describe, it, expect, afterEach} from 'vitest';
import {render, screen, cleanup} from '@testing-library/react';
import {createDoc} from '../model';
import {registerArtifactKit} from '../kit';
import {BlockEditor} from '../BlockEditor';

afterEach(() => cleanup());

registerArtifactKit(); // registers the toggle (and the rest of the kit)

/**
 * A locked group makes its widgets read-only for text and structure, but
 * widgets stay operable for the reader by default — that's the point of an
 * interactive artifact. An author opts a widget *out* with `interactive: false`.
 * The lock is applied in `BlockBody` by swapping in a read-only editor.
 */
describe('group lock', () => {
  it('keeps widgets interactive by default but disables an opted-out one', () => {
    const doc = createDoc([
      {
        id: 'g',
        type: 'group',
        props: {name: 'Panel', locked: true},
        children: [
          {id: 'optout', type: 'toggle', props: {name: 'optout', value: false, interactive: false}},
          {id: 'live', type: 'toggle', props: {name: 'live', value: false}},
        ],
      },
    ]);
    render(<BlockEditor doc={doc} />);
    const switches = screen.getAllByRole('switch') as HTMLButtonElement[];
    expect(switches).toHaveLength(2);
    expect(switches[0].disabled).toBe(true); // locked + explicitly opted out
    expect(switches[1].disabled).toBe(false); // default — stays interactive
  });

  it('leaves widgets editable when the group is unlocked', () => {
    const doc = createDoc([
      {
        id: 'g',
        type: 'group',
        props: {name: 'Panel'},
        children: [{id: 'plain', type: 'toggle', props: {name: 'plain', value: false}}],
      },
    ]);
    render(<BlockEditor doc={doc} />);
    expect((screen.getByRole('switch') as HTMLButtonElement).disabled).toBe(false);
  });
});
