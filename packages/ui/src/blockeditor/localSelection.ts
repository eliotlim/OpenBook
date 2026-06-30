import {throttle} from '@/lib/throttle';

/**
 * The local caret → presence plumbing (Collab T5), factored out of BlockEditor so
 * the throttle/clear contract is unit-testable. The editor reports its live
 * selection here; the reporter rate-limits the broadcast and — crucially — routes
 * the blur "clear" through the SAME throttle so it can cancel a still-pending
 * trailing emit. Otherwise a caret move <100ms before a blur would fire its
 * trailing emit AFTER the null, leaving a stale peer caret with nothing to clear it.
 */

/** Local caret broadcast rate into awareness (~10Hz): live-feeling, not flooding. */
export const LOCAL_SELECTION_THROTTLE_MS = 100;

/** The local caret reported to peers: focused block + directional offsets (the
 *  `head` is where the visible caret sits, so a right-to-left range is honoured). */
export interface LocalSelection {
  blockId: string;
  anchor: number;
  head: number;
}

export interface SelectionReporter {
  /** Report the live caret (throttled, leading + trailing). */
  emit(sel: LocalSelection): void;
  /** Clear the caret now AND cancel any pending trailing emit (blur / unmount). */
  clear(): void;
}

/**
 * Build a reporter around `report` (which publishes into awareness). `emit` is
 * throttled; `clear` cancels the pending trailing emit before publishing null, so
 * the blur path can never be overtaken by a late caret-move emit.
 */
export function createSelectionReporter(report: (sel: LocalSelection | null) => void): SelectionReporter {
  const throttled = throttle((sel: LocalSelection | null) => report(sel), LOCAL_SELECTION_THROTTLE_MS);
  return {
    emit: (sel) => throttled(sel),
    clear: () => {
      throttled.cancel();
      report(null);
    },
  };
}
