import {describe, it, expect, afterEach} from 'vitest';
import {render, screen, cleanup} from '@testing-library/react';
import {createDoc} from '../model';
import {registerArtifactKit} from '../kit';
import {BlockEditor} from '../BlockEditor';

afterEach(() => cleanup());

registerArtifactKit(); // registers the toggle (and the rest of the kit)

/**
 * A locked group makes its widgets read-only — except those flagged
 * `interactive`, which a reader keeps operating. The lock is applied in
 * `BlockBody` by swapping in a read-only editor for descendant blocks.
 */
describe('group lock', () => {
  it('disables a non-interactive widget but exempts an interactive one', () => {
    const doc = createDoc([
      {
        id: 'g',
        type: 'group',
        props: {name: 'Panel', locked: true},
        children: [
          {id: 'plain', type: 'toggle', props: {name: 'plain', value: false}},
          {id: 'live', type: 'toggle', props: {name: 'live', value: false, interactive: true}},
        ],
      },
    ]);
    render(<BlockEditor doc={doc} />);
    const switches = screen.getAllByRole('switch') as HTMLButtonElement[];
    expect(switches).toHaveLength(2);
    expect(switches[0].disabled).toBe(true); // locked, not interactive
    expect(switches[1].disabled).toBe(false); // interactive — stays live
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
