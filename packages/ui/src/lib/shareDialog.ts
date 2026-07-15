/**
 * Imperative open-request store for the per-page Share dialog. The dialog is a
 * modal (not a split pane), so the menu / command-palette surfaces can't just
 * `openInSplit` to it — they publish the target page id here and a single mounted
 * {@link ShareDialogHost} renders the dialog for it. Mirrors the target-store
 * pattern used by the customise / review / history panes.
 */
let target: string | null = null;
const subscribers = new Set<() => void>();
let version = 0;

const notify = (): void => {
  version += 1;
  subscribers.forEach((cb) => cb());
};

/** Open the Share dialog for a page (from a menu item or command). */
export function requestShareDialog(pageId: string): void {
  target = pageId;
  notify();
}

/** Close the Share dialog (host calls this when the dialog dismisses). */
export function clearShareTarget(): void {
  if (target !== null) {
    target = null;
    notify();
  }
}

export const readShareTarget = (): string | null => target;

export const subscribeShareDialog = (cb: () => void): (() => void) => {
  subscribers.add(cb);
  return () => subscribers.delete(cb);
};

/** Monotonic change counter — pair with useSyncExternalStore. */
export const shareDialogVersion = (): number => version;
