/**
 * A tiny bridge so the block context menu can open an interactive block's
 * settings popover. Each mounted {@link KitFrame} registers an opener keyed by
 * its block id; the "Configure" context-menu item calls {@link openKitConfig}.
 * A module singleton — the menu and the block never reference each other.
 */
const openers = new Map<string, () => void>();

export function registerKitConfig(blockId: string, open: () => void): () => void {
  openers.set(blockId, open);
  return () => {
    if (openers.get(blockId) === open) openers.delete(blockId);
  };
}

/** Whether a block has a registered config affordance (i.e. is configurable). */
export const hasKitConfig = (blockId: string): boolean => openers.has(blockId);

/** Open a block's config popover. Returns false if the block has none. */
export function openKitConfig(blockId: string): boolean {
  const open = openers.get(blockId);
  if (!open) return false;
  open();
  return true;
}
