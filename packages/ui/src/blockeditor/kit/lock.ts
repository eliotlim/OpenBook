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

/**
 * Whether the whole page is read-only (a viewer who can't write). Set ONCE at
 * the editor root and never re-provided by groups, so it survives nesting —
 * unlike {@link KitLockContext}, which a locked group flips on for its subtree.
 *
 * Interactive widgets revive under a page lock (their control gets a `liveEditor`
 * with `readOnly:false`), which would otherwise make their kit chrome — the
 * inline label / description — editable again. The {@link KitInlineText} chrome
 * consults this so the control stays live while the label/config text stays
 * frozen for the reader.
 */
export const KitPageLockContext = createContext(false);

/** Whether the whole page is read-only (viewer / can't-write). */
export const useKitPageLock = (): boolean => useContext(KitPageLockContext);
