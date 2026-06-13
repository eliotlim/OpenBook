import {createContext, useContext} from 'react';

/**
 * Group lock state, provided by a `group` block to everything rendered inside
 * it. A locked group makes its contents read-only — `BlockEditor` swaps in a
 * read-only editor for descendant blocks — except interactive widgets a reader
 * is meant to keep operating (those carry `props.interactive`).
 */
export interface KitLockState {
  locked: boolean;
}

export const KitLockContext = createContext<KitLockState>({locked: false});

/** Whether the nearest enclosing group is locked. */
export const useKitLock = (): boolean => useContext(KitLockContext).locked;
