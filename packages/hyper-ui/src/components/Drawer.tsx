import React from 'react';

export interface DrawerProps {
  children: React.ReactNode;
  open: boolean;
  docked?: boolean;
}

export default function Drawer({
  children,
  ...props
}: DrawerProps) {

  // class names
  const classes = [
    'left-0 z-50 w-64 transition-transform duration-500 transform -translate-x-full',
    'bg-popover text-foreground',
    'p-1',
    'flex flex-col',
    'border-r dark:border-gray-700 shadow-lg dark:shadow-lg dark:shadow-black',
    props.docked ? 'order-first' : 'fixed rounded-tr-lg rounded-br-lg border-t border-b top-16 h-[calc(100%-8rem)]',
    props.open ? ' translate-x-0' : ''
  ];

  return (
    <div
      className={classes.join(' ')}
    >
      {children}
    </div>
  );
}
