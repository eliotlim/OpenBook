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

  return (
    <div
      className={'fixed top-12 left-0 z-20 w-64 h-full transition-transform duration-500 transform -translate-x-full bg-background text-foreground shadow-lg' + (props.open ? ' translate-x-0' : '')}
    >
      {children}
    </div>
  );
}
