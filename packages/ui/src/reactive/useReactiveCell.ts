import {useEffect} from 'react';
import {store} from './ReactiveStore';

/**
 * Registers a block's cellId in the store with its display name on mount,
 * and calls store.deleteCell(cellId) on unmount.
 *
 * Centralizes the mount/unmount contract that every reactive block needs.
 * StrictMode-safe: Signal identity is stable by cellId in the store, so the
 * double-mount cycle (mount → unmount → mount) preserves downstream
 * subscriptions.
 *
 * Implementation note: the two effects are deliberately separate so that a
 * NAME change does not run the deleteCell cleanup. If they were a single
 * effect with `[cellId, name]` deps, every keystroke in a block's name
 * field would clear the cell value momentarily (cleanup runs before the
 * next effect run). Splitting means setName re-fires on name change while
 * deleteCell only fires on cellId change or unmount.
 */
export function useReactiveCell(cellId: string, name: string): void {
  // Track name. Re-fires when cellId or name changes. No cleanup beyond
  // what setName itself does (last-writer-wins on the name index).
  useEffect(() => {
    store.setName(cellId, name);
  }, [cellId, name]);

  // Mount/unmount cleanup. Re-fires only when cellId changes (which is
  // effectively never — the block's cellId is fixed at construction).
  useEffect(() => {
    return () => {
      store.deleteCell(cellId);
    };
  }, [cellId]);
}
