import React, {StrictMode} from 'react';
import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import {render, cleanup} from '@testing-library/react';
import {useReactiveCell} from '../useReactiveCell';
import {store} from '../ReactiveStore';

// Trivial test component that registers a cell on mount.
const Probe: React.FC<{cellId: string; name: string}> = ({cellId, name}) => {
  useReactiveCell(cellId, name);
  return <div>probe</div>;
};

describe('useReactiveCell', () => {
  beforeEach(() => {
    // Reset the singleton store between tests (hydrate with empty snapshot).
    store.hydrate({values: [], names: []});
  });

  afterEach(() => {
    cleanup();
  });

  it('mount registers the name in the store', () => {
    render(<Probe cellId="cell-mount" name="alpha" />);
    expect(store.getName('cell-mount')).toBe('alpha');
    expect(store.getIdByName('alpha')).toBe('cell-mount');
  });

  it('unmount calls deleteCell (value becomes undefined; Signal identity stays)', () => {
    store.setByCellId('cell-unmount', 42);
    const {unmount} = render(<Probe cellId="cell-unmount" name="beta" />);
    expect(store.getName('cell-unmount')).toBe('beta');
    unmount();
    // Name index cleared.
    expect(store.getName('cell-unmount')).toBeUndefined();
    expect(store.getIdByName('beta')).toBeUndefined();
    // Value cleared. (Signal itself remains, so a fresh re-setByCellId
    // reaches the same subscriber — see ReactiveStore test for that guard.)
    expect(store.getByCellId('cell-unmount')).toBeUndefined();
  });

  it('StrictMode double-mount works: name set, deleted, set again, store remains consistent', () => {
    // React 18 StrictMode runs effects twice in dev:
    //   mount → effect → unmount → effect cleanup → mount → effect
    // This used to be a real bug class for stores that drop Signal objects
    // on cleanup. With our keep-Signal-alive contract, the final state is
    // the same as a single mount.
    render(
      <StrictMode>
        <Probe cellId="cell-strict" name="gamma" />
      </StrictMode>,
    );
    expect(store.getName('cell-strict')).toBe('gamma');
    expect(store.getIdByName('gamma')).toBe('cell-strict');
    // No Signal-identity assertion needed here — the
    // 'deleteCell keeps Signal' test in ReactiveStore.test.ts covers
    // that the subscriber would survive a delete+resurrect cycle, which
    // is what StrictMode's mount→unmount→mount triggers under the hood.
  });
});
