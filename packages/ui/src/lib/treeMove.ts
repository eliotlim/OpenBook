/**
 * Pure logic for sidebar drag-and-drop: given the flat page list and a drop
 * (drag page X onto page Y, `before` / `after` / `inside`), compute the new
 * parent and the reordered sibling list to send to the server's `movePage`.
 *
 * Kept free of React/DOM so it can be unit-tested directly (`treeMove.test.ts`);
 * the DnD glue lives in `components/ui/tree.tsx`.
 */
import type {PageMeta} from '@book.dev/sdk';

/** Where a row was dropped relative to the target row. */
export type DropWhere = 'before' | 'after' | 'inside';

export interface MovePlan {
  /** The dragged page's new parent (`null` = top level). */
  parentId: string | null;
  /** The full ordered list of sibling ids under `parentId`, including the dragged page. */
  orderedIds: string[];
}

/**
 * Resolve the move, or `null` when it's invalid (dropping a page onto itself, or
 * nesting it inside its own subtree — which would create a cycle). The server
 * enforces the same cycle rule; this just avoids a doomed round-trip and lets
 * the UI suppress the drop indicator.
 */
export function planTreeMove(
  pages: PageMeta[],
  draggedId: string,
  targetId: string,
  where: DropWhere,
): MovePlan | null {
  if (draggedId === targetId) return null;
  const byId = new Map(pages.map((p) => [p.id, p]));
  if (!byId.has(draggedId) || !byId.has(targetId)) return null;

  // A page whose parent isn't in the list is shown at the root (see buildTree),
  // so treat its effective parent as null for grouping and ancestry.
  const effParent = (id: string): string | null => {
    const parentId = byId.get(id)?.parentId ?? null;
    return parentId !== null && byId.has(parentId) ? parentId : null;
  };

  // Is `id` the dragged page, or somewhere inside its subtree? Walking up from
  // `id` and hitting `draggedId` means dropping there would nest the page under
  // itself.
  const insideDraggedSubtree = (id: string | null): boolean => {
    const seen = new Set<string>();
    let cur = id;
    while (cur !== null) {
      if (cur === draggedId) return true;
      if (seen.has(cur)) break;
      seen.add(cur);
      cur = effParent(cur);
    }
    return false;
  };

  const newParentId = where === 'inside' ? targetId : effParent(targetId);
  if (insideDraggedSubtree(newParentId)) return null;

  // Current children of the destination parent, in list order, minus the page
  // being moved (it may already live here).
  const siblings = pages
    .filter((p) => effParent(p.id) === newParentId && p.id !== draggedId)
    .map((p) => p.id);

  let index: number;
  if (where === 'inside') {
    index = siblings.length; // append to the end of the new parent's children
  } else {
    const targetIdx = siblings.indexOf(targetId);
    index = where === 'before' ? targetIdx : targetIdx + 1;
  }

  const orderedIds = [...siblings.slice(0, index), draggedId, ...siblings.slice(index)];
  return {parentId: newParentId, orderedIds};
}
