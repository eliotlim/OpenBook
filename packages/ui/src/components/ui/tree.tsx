"use client";

/**
 * Tree component
 * https://github.com/shadcn-ui/ui/issues/355
 *
 * Expansion and selection are fully controlled here (a lifted `expandedIds`
 * set), so navigating to a page never collapses folders the user opened by hand
 * — selecting a page only *adds* its ancestors to the open set. Rows support
 * native HTML5 drag-and-drop (reorder among siblings + nest); the move maths
 * live in `lib/treeMove.ts`.
 */

import React from "react";
import { ScrollArea } from "@/components/ui/scroll-area"
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/components/ui/context-menu"
import { cn } from "@/lib/utils";
import { ChevronRight, type LucideIcon } from "lucide-react";
import type { DropWhere } from "@/lib/treeMove";
import useResizeObserver from "use-resize-observer";

interface TreeDataItem {
  id: string;
  name: string;
  icon?: LucideIcon | string,
  children?: TreeDataItem[];
}

type TreeProps =
  React.HTMLAttributes<HTMLDivElement> &
  {
    data: TreeDataItem[] | TreeDataItem,
    selectedItemId?: string,
    onSelectChange?: (item: TreeDataItem | undefined) => void,
    expandAll?: boolean,
    folderIcon?: LucideIcon,
    itemIcon?: LucideIcon,
    /** Right-click menu for a row (e.g. page actions). Rendered in a ContextMenuContent. */
    renderItemContextMenu?: (item: TreeDataItem) => React.ReactNode,
    /** Trailing controls revealed on row hover/focus (e.g. add / ⋯). `openMenu`
     *  opens the row's context menu at the row, so a button can mirror right-click. */
    renderRowActions?: (item: TreeDataItem, helpers: {openMenu: () => void}) => React.ReactNode,
    /** Called when a row is dropped on another (drag-to-reorder / drag-to-nest). */
    onMove?: (draggedId: string, targetId: string, where: DropWhere) => void,
  }

const asArray = (data: TreeDataItem[] | TreeDataItem): TreeDataItem[] =>
  data instanceof Array ? data : [data];

/** Ids of the ancestors leading to `targetId` (excluding it), or `[]` if absent. */
function ancestorPath(data: TreeDataItem[] | TreeDataItem, targetId: string): string[] {
  const walk = (items: TreeDataItem[], acc: string[]): string[] | null => {
    for (const item of items) {
      if (item.id === targetId) return acc;
      if (item.children) {
        const found = walk(item.children, [...acc, item.id]);
        if (found) return found;
      }
    }
    return null;
  };
  return walk(asArray(data), []) ?? [];
}

/** Every id in the tree that has children (used by `expandAll`). */
function allFolderIds(data: TreeDataItem[] | TreeDataItem): string[] {
  const ids: string[] = [];
  const walk = (items: TreeDataItem[]): void => {
    for (const item of items) {
      if (item.children && item.children.length > 0) {
        ids.push(item.id);
        walk(item.children);
      }
    }
  };
  walk(asArray(data));
  return ids;
}

/** Wrap a row so right-clicking it opens `menu` (no-op when there's no menu). */
function WithRowMenu({menu, children}: {menu?: React.ReactNode; children: React.ReactElement}) {
  if (!menu) return children;
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-52">{menu}</ContextMenuContent>
    </ContextMenu>
  );
}

interface DndState {
  enabled: boolean;
  draggedId: string | null;
  dropTarget: {id: string; where: DropWhere} | null;
  onDragStart: (e: React.DragEvent, id: string) => void;
  onDragOver: (e: React.DragEvent, id: string) => void;
  onDrop: (e: React.DragEvent, id: string) => void;
  onDragEnd: () => void;
}

const Tree = React.forwardRef<
  HTMLDivElement,
  TreeProps
>(({
     data, selectedItemId, onSelectChange, expandAll,
     folderIcon,
     itemIcon,
     renderItemContextMenu,
     renderRowActions,
     onMove,
     className, ...props
   }, ref) => {
  const [selected, setSelected] = React.useState<string | undefined>(selectedItemId);
  const [expandedIds, setExpandedIds] = React.useState<Set<string>>(() =>
    expandAll
      ? new Set(allFolderIds(data))
      : new Set(selectedItemId ? ancestorPath(data, selectedItemId) : []),
  );
  const [draggedId, setDraggedId] = React.useState<string | null>(null);
  const [dropTarget, setDropTarget] = React.useState<{id: string; where: DropWhere} | null>(null);

  // Keep selection in sync with the controlled prop (e.g. navigating elsewhere).
  React.useEffect(() => setSelected(selectedItemId), [selectedItemId]);

  // Reveal the active page by opening its ancestors — additively, so folders the
  // user opened (or closed) by hand are left as they are.
  React.useEffect(() => {
    if (!selectedItemId) return;
    const path = ancestorPath(data, selectedItemId);
    if (path.length === 0) return;
    setExpandedIds((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const id of path) if (!next.has(id)) {
        next.add(id);
        changed = true;
      }
      return changed ? next : prev;
    });
  }, [selectedItemId, data]);

  const handleSelectChange = React.useCallback((item: TreeDataItem | undefined) => {
    setSelected(item?.id);
    onSelectChange?.(item);
  }, [onSelectChange]);

  const toggleExpand = React.useCallback((id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const dnd: DndState = {
    enabled: !!onMove,
    draggedId,
    dropTarget,
    onDragStart: (e, id) => {
      e.dataTransfer.setData("text/plain", id);
      e.dataTransfer.effectAllowed = "move";
      setDraggedId(id);
    },
    onDragOver: (e, id) => {
      if (!draggedId || draggedId === id) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      const rect = e.currentTarget.getBoundingClientRect();
      const ratio = (e.clientY - rect.top) / rect.height;
      const where: DropWhere = ratio < 0.3 ? "before" : ratio > 0.7 ? "after" : "inside";
      setDropTarget((prev) => (prev && prev.id === id && prev.where === where ? prev : {id, where}));
    },
    onDrop: (e, id) => {
      e.preventDefault();
      const dragged = draggedId;
      const target = dropTarget;
      setDraggedId(null);
      setDropTarget(null);
      if (dragged && target && target.id === id) onMove?.(dragged, target.id, target.where);
    },
    onDragEnd: () => {
      setDraggedId(null);
      setDropTarget(null);
    },
  };

  const { ref: refRoot, width, height } = useResizeObserver();

  return (
    <div ref={refRoot} className={cn("overflow-hidden", className)} {...props}>
      <ScrollArea style={{ width, height }}>
        <div className="relative" ref={ref}>
          <TreeItem
            data={data}
            depth={0}
            selectedItemId={selected}
            handleSelectChange={handleSelectChange}
            expandedIds={expandedIds}
            toggleExpand={toggleExpand}
            FolderIcon={folderIcon}
            ItemIcon={itemIcon}
            renderItemContextMenu={renderItemContextMenu}
            renderRowActions={renderRowActions}
            dnd={dnd}
          />
        </div>
      </ScrollArea>
    </div>
  )
})
Tree.displayName = "Tree";

interface TreeItemProps {
  data: TreeDataItem[] | TreeDataItem;
  depth: number;
  selectedItemId?: string;
  handleSelectChange: (item: TreeDataItem | undefined) => void;
  expandedIds: Set<string>;
  toggleExpand: (id: string) => void;
  FolderIcon?: LucideIcon;
  ItemIcon?: LucideIcon;
  renderItemContextMenu?: (item: TreeDataItem) => React.ReactNode;
  renderRowActions?: (item: TreeDataItem, helpers: {openMenu: () => void}) => React.ReactNode;
  dnd: DndState;
}

function TreeItem({
  data, depth, selectedItemId, handleSelectChange, expandedIds, toggleExpand,
  FolderIcon, ItemIcon, renderItemContextMenu, renderRowActions, dnd,
}: TreeItemProps) {
  return (
    <ul role={depth === 0 ? "tree" : "group"}>
      {asArray(data).map((item) => {
        const isFolder = !!item.children && item.children.length > 0;
        const isExpanded = expandedIds.has(item.id);
        return (
          <li key={item.id}>
            <WithRowMenu menu={renderItemContextMenu?.(item)}>
              <TreeRow
                item={item}
                depth={depth}
                isFolder={isFolder}
                isExpanded={isExpanded}
                isSelected={selectedItemId === item.id}
                onSelect={() => handleSelectChange(item)}
                onToggle={() => toggleExpand(item.id)}
                Icon={isFolder ? FolderIcon : ItemIcon}
                renderRowActions={renderRowActions}
                dnd={dnd}
              />
            </WithRowMenu>
            {isFolder && isExpanded && (
              <TreeItem
                data={item.children!}
                depth={depth + 1}
                selectedItemId={selectedItemId}
                handleSelectChange={handleSelectChange}
                expandedIds={expandedIds}
                toggleExpand={toggleExpand}
                FolderIcon={FolderIcon}
                ItemIcon={ItemIcon}
                renderItemContextMenu={renderItemContextMenu}
                renderRowActions={renderRowActions}
                dnd={dnd}
              />
            )}
          </li>
        );
      })}
    </ul>
  );
}

interface TreeRowProps {
  item: TreeDataItem;
  depth: number;
  isFolder: boolean;
  isExpanded: boolean;
  isSelected: boolean;
  onSelect: () => void;
  onToggle: () => void;
  Icon?: LucideIcon;
  renderRowActions?: (item: TreeDataItem, helpers: {openMenu: () => void}) => React.ReactNode;
  dnd: DndState;
}

const TreeRow = React.forwardRef<HTMLDivElement, TreeRowProps & React.HTMLAttributes<HTMLDivElement>>(function TreeRow(
  { item, depth, isFolder, isExpanded, isSelected, onSelect, onToggle, Icon, renderRowActions, dnd, ...rest },
  ref,
) {
  const isDropTarget = dnd.dropTarget?.id === item.id;
  const where = isDropTarget ? dnd.dropTarget?.where : undefined;
  const isDragged = dnd.draggedId === item.id;

  // Keep our own handle to the row so a hover action (the ⋯ button) can re-open
  // the same context menu, while still satisfying the forwarded ref the wrapping
  // ContextMenuTrigger needs.
  const rowRef = React.useRef<HTMLDivElement | null>(null);
  const setRefs = React.useCallback(
    (el: HTMLDivElement | null) => {
      rowRef.current = el;
      if (typeof ref === "function") ref(el);
      else if (ref) (ref as React.MutableRefObject<HTMLDivElement | null>).current = el;
    },
    [ref],
  );
  const openMenu = React.useCallback(() => {
    const el = rowRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    el.dispatchEvent(
      new MouseEvent("contextmenu", {bubbles: true, cancelable: true, clientX: rect.right - 16, clientY: rect.bottom}),
    );
  }, []);

  return (
    <div className="relative">
      {where === "before" && <div className="pointer-events-none absolute inset-x-1 top-0 z-10 h-0.5 rounded-full bg-primary" />}
      <div
        ref={setRefs}
        role="treeitem"
        // `rest` carries the handlers a wrapping ContextMenuTrigger injects via
        // `asChild` (notably `onContextMenu`) — spread them so right-clicking a
        // row opens its page menu instead of the browser default.
        {...rest}
        draggable={dnd.enabled}
        onClick={onSelect}
        onDragStart={dnd.enabled ? (e) => dnd.onDragStart(e, item.id) : undefined}
        onDragOver={dnd.enabled ? (e) => dnd.onDragOver(e, item.id) : undefined}
        onDrop={dnd.enabled ? (e) => dnd.onDrop(e, item.id) : undefined}
        onDragEnd={dnd.enabled ? dnd.onDragEnd : undefined}
        style={{ paddingLeft: depth * 12 + 4 }}
        className={cn(
          "group/row flex items-center mx-1 py-1 pr-1.5 rounded-md cursor-pointer text-sm text-foreground/75 transition-colors hover:bg-hover",
          isSelected && "bg-hover-strong text-foreground font-medium",
          where === "inside" && "ring-2 ring-inset ring-primary bg-hover",
          isDragged && "opacity-50",
        )}
      >
        {isFolder ? (
          <button
            type="button"
            aria-label={isExpanded ? "Collapse" : "Expand"}
            onClick={(e) => {
              e.stopPropagation();
              onToggle();
            }}
            className="mr-1 shrink-0 rounded-md p-0.5 hover:bg-muted-foreground/30"
          >
            <ChevronRight
              className={cn(
                "h-4 w-4 shrink-0 text-accent-foreground/50 transition-transform duration-200",
                isExpanded && "rotate-90",
              )}
            />
          </button>
        ) : (
          <span className="mr-1 h-4 w-4 shrink-0 p-0.5" aria-hidden="true" />
        )}
        <RowIcon icon={item.icon} Fallback={Icon} />
        <span className="grow truncate text-sm">{item.name}</span>
        {renderRowActions && (
          <span
            // Revealed on hover or when something inside has focus; doesn't shift
            // the row on hover (it overlays the trailing padding).
            className="ml-1 flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover/row:opacity-100 focus-within:opacity-100"
            // Don't let clicks on the actions select/navigate the row.
            onClick={(e) => e.stopPropagation()}
          >
            {renderRowActions(item, {openMenu})}
          </span>
        )}
      </div>
      {where === "after" && <div className="pointer-events-none absolute inset-x-1 bottom-0 z-10 h-0.5 rounded-full bg-primary" />}
    </div>
  );
});

/** A row's leading glyph: the page's emoji (string), a Lucide icon, or a fallback. */
function RowIcon({icon, Fallback}: {icon?: LucideIcon | string; Fallback?: LucideIcon}) {
  if (typeof icon === "string") {
    return <span className="mr-2 h-4 w-4 shrink-0 text-center text-xs leading-4" aria-hidden="true">{icon}</span>;
  }
  if (typeof icon === "function") {
    const Icon = icon;
    return <Icon className="mr-2 h-4 w-4 shrink-0 text-accent-foreground/50" aria-hidden="true" />;
  }
  if (Fallback) return <Fallback className="mr-2 h-4 w-4 shrink-0 text-accent-foreground/50" aria-hidden="true" />;
  return null;
}

export { Tree, type TreeDataItem }
