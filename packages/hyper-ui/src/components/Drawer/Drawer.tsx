import React from 'react';
import {
  Modal,
  ModalProps,
  modalClasses,
  Sheet,
} from '@mui/joy';

export interface DrawerProps extends Omit<ModalProps, 'children'> {
  children: React.ReactNode;
  size?: number | string;
  position?: 'left' | 'right' | 'top' | 'bottom';
  docked?: boolean;
}

export default function Drawer({
  children,
  position = 'left',
  size = 'clamp(256px, 30vw, 378px)',
  sx,
  ...props
}: DrawerProps) {
  return (
    <Modal
      keepMounted
      sx={[
        {
          paddingTop: props.docked ? 5 : 0,
          transitionProperty: 'visibility',
          transitionDelay: props.open ? '0s' : '300ms',
          [`& .${modalClasses.backdrop}`]: {
            opacity: props.open ? (props.docked ? 0 : 1) : 0,
            transition: 'opacity 0.3s ease'
          }
        },
        ...(Array.isArray(sx) ? sx : [sx])
      ]}
      {...props}
    >
      <Sheet
        sx={{
          px: 0.5,
          py: 0.5,
          boxSizing: 'border-box',
          position: 'fixed',
          overflow: 'auto',
          ...(position === 'left' && {
            left: 0,
            transform: props.open ? 'translateX(0)' : 'translateX(-100%)'
          }),
          ...(position === 'right' && {
            right: 0,
            transform: props.open ? 'translateX(0)' : 'translateX(100%)'
          }),
          ...(position === 'top' && {
            top: 0,
            transform: props.open ? 'translateY(0)' : 'translateY(-100%)'
          }),
          ...(position === 'bottom' && {
            bottom: 0,
            transform: props.open ? 'translateY(0)' : 'translateY(100%)'
          }),
          height: position.match(/(left|right)/) ? '100%' : size,
          width: position.match(/(top|bottom)/) ? '100vw' : size,
          boxShadow: 'md',
          transition: 'transform 0.3s ease'
        }}
      >
        {children}
      </Sheet>
    </Modal>
  );
}
