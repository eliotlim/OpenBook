import React from 'react';
import {
  ContextMenuCheckboxItem,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from '@/components/ui/context-menu';
import {
  DropdownMenuCheckboxItem,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '@/components/ui/dropdown-menu';

export {MenuDensityProvider, useMenuDensity, type MenuDensity} from '@/components/ui/menu-density';

/** Shared styling for destructive actions in either Radix menu family. */
export const MENU_DESTRUCTIVE_CLASS = 'text-destructive hover:text-destructive focus:text-destructive';

/** Canonical widths for menu content and submenus. */
export const MENU_WIDTH_SM = 'w-40';
export const MENU_WIDTH_MD = 'w-52';
export const MENU_WIDTH_LG = 'w-60';

/**
 * The two Radix menu families expose the same item/checkbox/sub/separator shape,
 * so one canonical item list can render through whichever bundle its host
 * provides — a right-click ContextMenu or a click-triggered dropdown. Typed as
 * {@link React.ElementType} because consumers only lean on the props both
 * families share (onSelect/checked/disabled/children).
 *
 * The single-source menu lists ({@link PageMenuItems}, the database's
 * {@link RowMenuItems}/{@link ColumnMenuItems}) all render through this table.
 */
export interface MenuComponentSet {
  Item: React.ElementType;
  CheckboxItem: React.ElementType;
  Separator: React.ElementType;
  Shortcut: React.ElementType;
  Sub: React.ElementType;
  SubTrigger: React.ElementType;
  SubContent: React.ElementType;
}

export const MENU_COMPONENTS: Record<'context' | 'dropdown', MenuComponentSet> = {
  context: {
    Item: ContextMenuItem,
    CheckboxItem: ContextMenuCheckboxItem,
    Separator: ContextMenuSeparator,
    Shortcut: ContextMenuShortcut,
    Sub: ContextMenuSub,
    SubTrigger: ContextMenuSubTrigger,
    SubContent: ContextMenuSubContent,
  },
  dropdown: {
    Item: DropdownMenuItem,
    CheckboxItem: DropdownMenuCheckboxItem,
    Separator: DropdownMenuSeparator,
    Shortcut: DropdownMenuShortcut,
    Sub: DropdownMenuSub,
    SubTrigger: DropdownMenuSubTrigger,
    SubContent: DropdownMenuSubContent,
  },
};
