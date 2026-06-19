import React from 'react';
import {cn} from '@/lib/utils';

export interface DrawerProps {
  children: React.ReactNode;
  open: boolean;
  docked?: boolean;
}

export default function Drawer({children, ...props}: DrawerProps) {
  const classes = cn(
    'z-50 flex w-64 shrink-0 flex-col bg-sheet-1 text-sheet-1-foreground transition-transform duration-300 ease-out print:hidden',
    // Docked: no border — the divider belongs to the primary page pane on the
    // right (`.ob-sheet`'s left border), which binds flush against the sidebar.
    // Auto-hide: a floating overlay, so it carries its own edge + shadow.
    props.docked
      ? 'order-first h-full'
      : 'fixed left-0 top-14 h-[calc(100vh-3.5rem)] -translate-x-full rounded-r-xl border border-l-0 border-border shadow-overlay',
    props.open ? 'translate-x-0' : '',
  );

  return <div className={classes}>{children}</div>;
}
