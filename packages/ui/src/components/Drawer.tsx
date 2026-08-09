import React from 'react';
import {cn} from '@/lib/utils';

export interface DrawerProps {
  children: React.ReactNode;
  open: boolean;
  docked?: boolean;
}

export default function Drawer({children, ...props}: DrawerProps) {
  const classes = cn(
    'ob-accent-chrome fixed left-0 top-14 z-50 flex h-[calc(100vh-3.5rem)] w-64 shrink-0 -translate-x-full flex-col rounded-r-xl border border-l-0 border-border bg-sheet-1 text-sheet-1-foreground shadow-overlay transition-transform duration-300 ease-out print:hidden',
    // Below `md`, even a persisted docked preference is presented as the same
    // floating drawer. At `md` and up, docked returns to the document flow; the
    // divider then belongs to the primary page pane on its right.
    props.docked && 'md:static md:order-first md:h-full md:translate-x-0 md:rounded-none md:border-0 md:shadow-none',
    props.open ? 'translate-x-0' : '',
  );

  return <div className={classes} data-sidebar-drawer>{children}</div>;
}
