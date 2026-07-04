import {describe, it, expect, afterEach} from 'vitest';
import {act} from 'react';
import {render, cleanup, fireEvent, screen} from '@testing-library/react';
import {createDoc, encodeSnapshot} from '../../blockeditor/model';
import {mount} from '../index'; // also registers the reactive + kit blocks
import {ViewerApp} from '../ViewerApp';
import type {IslandPageJson, SpaceBundleJson, ViewerHandle} from '../types';

// Direct createRoot renders (the mount() test) run outside RTL's act wrapper.
(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => cleanup());

/** A real island: the Y.Doc is encoded to the base64 `update` (the primary
 *  decode path — the Playwright harness covers the JSON-projection fallback). */
function makeIsland(): IslandPageJson {
  const doc = createDoc([
    {id: 'h', type: 'heading', props: {level: 1}, text: [{t: 'Bundle test'}]},
    {id: 's', type: 'slider', props: {name: 'm', label: 'M', value: 10, min: 0, max: 100, step: 1}},
    {id: 'f', type: 'formula', props: {source: 'm * 2'}},
  ]);
  return {
    version: 1,
    id: 'island-1',
    name: 'Island page',
    icon: null,
    updatedAt: '2026-07-04T00:00:00.000Z',
    data: {editor: 'blocks', blockdoc: encodeSnapshot(doc)},
  };
}

describe('viewer', () => {
  it('renders an island from its base64 Y update, locked but interactive', () => {
    const island = makeIsland();
    const sourceBefore = JSON.stringify(island);
    const {container} = render(<ViewerApp source={island} />);

    // Content rendered from the CRDT update.
    expect(screen.getByRole('heading', {level: 1, name: /Island page/})).toBeTruthy();
    expect(container.textContent).toContain('Bundle test');

    // The slider is live (interactive exemption) and drives the formula.
    const slider = container.querySelector<HTMLInputElement>('input[type="range"]');
    expect(slider).toBeTruthy();
    expect(slider!.disabled).toBe(false);
    expect(container.querySelector('.obe-formula-out')?.textContent).toBe('20');
    fireEvent.change(slider!, {target: {value: '25'}});
    expect(container.querySelector('.obe-formula-out')?.textContent).toBe('50');

    // Locked semantics: no editable text, no inline-label inputs, and the
    // source object the host handed over is byte-identical afterwards.
    expect(container.querySelector('[contenteditable="true"]')).toBeNull();
    expect(container.querySelector('input.obe-kit-inline')).toBeNull();
    expect(JSON.stringify(island)).toBe(sourceBefore);
  });

  it('renders a space bundle with page navigation', () => {
    const bundle: SpaceBundleJson = {
      pages: [
        {id: 'a', name: 'Alpha', data: {editor: 'blocks', blockdoc: {v: 1, blocks: [{id: 'ap', type: 'paragraph', text: [{t: 'alpha body'}]}]}}},
        {id: 'b', name: 'Beta', data: {editor: 'blocks', blockdoc: {v: 1, blocks: [{id: 'bp', type: 'paragraph', text: [{t: 'beta body'}]}]}}},
      ],
      databases: [],
    };
    const {container} = render(<ViewerApp source={bundle} initialPage="b" />);
    // `initialPage` wins; the nav lists both pages.
    expect(container.querySelector('[data-viewer-page="b"]')).toBeTruthy();
    expect(container.textContent).toContain('beta body');
    expect(container.querySelectorAll('.ob-viewer-nav a').length).toBe(2);
  });

  it('mount() renders into a bare container and unmount() releases it', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    let handle!: ViewerHandle;
    act(() => {
      handle = mount(container, makeIsland());
    });
    expect(container.querySelector('.ob-viewer')).toBeTruthy();
    act(() => handle.unmount());
    expect(container.innerHTML).toBe('');
    container.remove();
  });
});
