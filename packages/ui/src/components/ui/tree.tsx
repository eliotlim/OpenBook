"use client";

/**
 * Tree component
 * https://github.com/shadcn-ui/ui/issues/355
 */

import React from "react";
import * as AccordionPrimitive from "@radix-ui/react-accordion";
import { ScrollArea } from "@/components/ui/scroll-area"
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/components/ui/context-menu"
import { cn } from "@/lib/utils";
import { ChevronRight, type LucideIcon } from "lucide-react";
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
    initialSlelectedItemId?: string,
    onSelectChange?: (item: TreeDataItem | undefined) => void,
    expandAll?: boolean,
    folderIcon?: LucideIcon,
    itemIcon?: LucideIcon,
    /** Right-click menu for a row (e.g. page actions). Rendered in a ContextMenuContent. */
    renderItemContextMenu?: (item: TreeDataItem) => React.ReactNode,
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

const Tree = React.forwardRef<
  HTMLDivElement,
  TreeProps
>(({
     data, initialSlelectedItemId, onSelectChange, expandAll,
     folderIcon,
     itemIcon,
     renderItemContextMenu,
     className, ...props
   }, ref) => {
  const [selectedItemId, setSelectedItemId] = React.useState<string | undefined>(initialSlelectedItemId)

  const handleSelectChange = React.useCallback((item: TreeDataItem | undefined) => {
    setSelectedItemId(item?.id);
    if (onSelectChange) {
      onSelectChange(item)
    }
  }, [onSelectChange]);

  const expandedItemIds = React.useMemo(() => {
    if (!initialSlelectedItemId) {
      return [] as string[]
    }

    const ids: string[] = []

    function walkTreeItems(items: TreeDataItem[] | TreeDataItem, targetId: string) {
      if (items instanceof Array) {
        // eslint-disable-next-line @typescript-eslint/prefer-for-of
        for (let i = 0; i < items.length; i++) {
          ids.push(items[i]!.id);
          if (walkTreeItems(items[i]!, targetId) && !expandAll) {
            return true;
          }
          if (!expandAll) ids.pop();
        }
        // expand all pages with multiple subpages
        return true;
      } else if (!expandAll && items.id === targetId) {
        return true;
      } else if (items.children) {
        return walkTreeItems(items.children, targetId)
      }
      // otherwise expand page
      return true;
    }

    walkTreeItems(data, initialSlelectedItemId)
    return ids;
  }, [data, initialSlelectedItemId])

  const { ref: refRoot, width, height } = useResizeObserver();

  return (
    <div ref={refRoot} className={cn("overflow-hidden", className)}>
      <ScrollArea style={{ width, height }}>
        <div className="relative">
          <TreeItem
            data={data}
            ref={ref}
            selectedItemId={selectedItemId}
            handleSelectChange={handleSelectChange}
            expandedItemIds={expandedItemIds}
            FolderIcon={folderIcon}
            ItemIcon={itemIcon}
            renderItemContextMenu={renderItemContextMenu}
            {...props}
          />
        </div>
      </ScrollArea>
    </div>
  )
})

type TreeItemProps =
  TreeProps &
  {
    selectedItemId?: string,
    handleSelectChange: (item: TreeDataItem | undefined) => void,
    expandedItemIds: string[],
    FolderIcon?: LucideIcon | string,
    ItemIcon?: LucideIcon | string,
  }

const TreeItem = React.forwardRef<
  HTMLDivElement,
  TreeItemProps
>(({ className, data, selectedItemId, handleSelectChange, expandedItemIds, FolderIcon, ItemIcon, renderItemContextMenu, ...props }, ref) => {
  return (
    <div ref={ref} role="tree" className={className} {...props}><ul>
      {data instanceof Array ? (
        data.map((item) => (
          <li key={item.id}>
            {item.children ? (
              <AccordionPrimitive.Root type="multiple" defaultValue={expandedItemIds}>
                <AccordionPrimitive.Item value={item.id}>
                  <WithRowMenu menu={renderItemContextMenu?.(item)}>
                  <AccordionTrigger
                    className={cn(
                      "px-1 rounded-md hover:bg-accent",
                      selectedItemId === item.id && "bg-accent"
                    )}
                    onClick={() => handleSelectChange(item)}
                  >
                    {item.icon && typeof item.icon === "string" &&
                      <span
                        className="h-4 w-4 shrink-0 mr-2 text-xs"
                        aria-hidden="true"
                      >
                        {item.icon}
                      </span>
                    }
                    {item.icon && typeof item.icon === "function" &&
                      <item.icon
                        className="h-4 w-4 shrink-0 mr-2 text-accent-foreground/50"
                        aria-hidden="true"
                      />
                    }
                    {!item.icon && FolderIcon &&
                      <FolderIcon
                        className="h-4 w-4 shrink-0 mr-2 text-accent-foreground/50"
                        aria-hidden="true"
                      />
                    }
                    <span className="text-sm truncate">{item.name}</span>
                  </AccordionTrigger>
                  </WithRowMenu>
                  <AccordionContent className="pl-5">
                    <TreeItem
                      data={item.children ? item.children : item}
                      selectedItemId={selectedItemId}
                      handleSelectChange={handleSelectChange}
                      expandedItemIds={expandedItemIds}
                      FolderIcon={FolderIcon}
                      ItemIcon={ItemIcon}
                      renderItemContextMenu={renderItemContextMenu}
                    />
                  </AccordionContent>
                </AccordionPrimitive.Item>
              </AccordionPrimitive.Root>
            ) : (
              <WithRowMenu menu={renderItemContextMenu?.(item)}>
                <Leaf
                  item={item}
                  isSelected={selectedItemId === item.id}
                  onClick={() => handleSelectChange(item)}
                  Icon={ItemIcon}
                />
              </WithRowMenu>
            )}
          </li>
        ))
      ) : (
        <li>
          <WithRowMenu menu={renderItemContextMenu?.(data)}>
            <Leaf
              item={data}
              isSelected={selectedItemId === data.id}
              onClick={() => handleSelectChange(data)}
              Icon={ItemIcon}
            />
          </WithRowMenu>
        </li>
      )}
    </ul></div>
  );
})

const Leaf = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & {
  item: TreeDataItem, isSelected?: boolean,
  Icon?: LucideIcon | string
}
>(({ className, item, isSelected, Icon, ...props }, ref) => {
  return (
    <div
      ref={ref}
      className={cn(
        "flex items-center mx-1 py-1 px-2 rounded-md cursor-pointer text-sm text-foreground/75 transition-colors hover:bg-accent",
        className,
        isSelected && "bg-accent text-foreground font-medium"
      )}
      {...props}
    >
      {item.icon && typeof item.icon === "string" &&
        <span
          className="h-4 w-4 shrink-0 ml-5 mr-2 text-xs"
          aria-hidden="true"
        >
          {item.icon}
        </span>
      }
      {item.icon && typeof item.icon === "function" &&
        <item.icon
          className="h-4 w-4 shrink-0 mr-2 text-accent-foreground/50"
          aria-hidden="true"
        />
      }
      {!item.icon && Icon && <Icon className="h-4 w-4 shrink-0 mr-2 text-accent-foreground/50" aria-hidden="true" />}
      <span className="grow text-sm truncate">{item.name}</span>
    </div>
  );
})

const AccordionTrigger = React.forwardRef<
  React.ElementRef<typeof AccordionPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof AccordionPrimitive.Trigger>
>(({ className, children, onContextMenu, ...props }, ref) => (
  <AccordionPrimitive.Header>
    {/* `onContextMenu` (injected by a ContextMenuTrigger wrapping this row) lives
        on the whole row, so right-click works anywhere on it — not just the
        chevron, which is the only actual AccordionPrimitive.Trigger. */}
    <div
      className={cn(
        "flex flex-1 w-full items-center py-0.5",
        className,
      )}
      onContextMenu={onContextMenu as React.MouseEventHandler<HTMLDivElement> | undefined}
    >
      <AccordionPrimitive.Trigger
        ref={ref}
        className={cn(
          "transition-all rounded-md hover:bg-muted-foreground/40 p-0.5 mr-1 [&[data-state=open]>svg]:first:rotate-90",
        )}
        {...props}
      >
        <ChevronRight className="h-4 w-4 shrink-0 transition-transform duration-200 text-accent-foreground/50" />
      </AccordionPrimitive.Trigger>
      {children}
    </div>
  </AccordionPrimitive.Header>
));
AccordionTrigger.displayName = AccordionPrimitive.Trigger.displayName;

const AccordionContent = React.forwardRef<
  React.ElementRef<typeof AccordionPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof AccordionPrimitive.Content>
>(({ className, children, ...props }, ref) => (
  <AccordionPrimitive.Content
    ref={ref}
    className={cn(
      "overflow-hidden text-sm transition-all data-[state=closed]:animate-accordion-up data-[state=open]:animate-accordion-down",
      className
    )}
    {...props}
  >
    <div className="pb-0 pt-0">{children}</div>
  </AccordionPrimitive.Content>
));
AccordionContent.displayName = AccordionPrimitive.Content.displayName;

export { Tree, type TreeDataItem }
