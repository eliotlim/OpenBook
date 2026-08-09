import React from 'react';
import {cn} from '@/lib/utils';
import {useTranslation} from '@/providers';

export interface DrawerProps {
  children: React.ReactNode;
  open: boolean;
  docked?: boolean;
}

export default function Drawer({children, ...props}: DrawerProps) {
  const {t} = useTranslation();
  const drawerRef = React.useRef<HTMLDivElement>(null);
  const returnFocusRef = React.useRef<HTMLElement | null>(null);
  const [narrow, setNarrow] = React.useState(false);

  React.useEffect(() => {
    const media = window.matchMedia('(max-width: 767px)');
    const onChange = () => setNarrow(media.matches);
    onChange();
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  React.useEffect(() => {
    if (!props.open || !narrow) return;
    const active = document.activeElement;
    const visibleToggle = Array.from(document.querySelectorAll<HTMLElement>('[data-sidebar-toggle]'))
      .find((toggle) => toggle.getClientRects().length > 0);
    returnFocusRef.current = active instanceof HTMLElement && active.matches('[data-sidebar-toggle]')
      ? active
      : visibleToggle ?? null;
    drawerRef.current?.focus({preventScroll: true});
    return () => {
      if (returnFocusRef.current?.isConnected) returnFocusRef.current.focus({preventScroll: true});
      returnFocusRef.current = null;
    };
  }, [narrow, props.open]);

  const classes = cn(
    'ob-accent-chrome fixed left-0 top-[calc(var(--ob-titlebar-height,0px)+3.5rem)] z-drawer flex h-[calc(100vh-var(--ob-titlebar-height,0px)-3.5rem)] w-64 shrink-0 -translate-x-full flex-col rounded-r-xl border border-l-0 border-border bg-sheet-1 text-sheet-1-foreground shadow-overlay transition-transform duration-300 ease-out print:hidden',
    // Below `md`, even a persisted docked preference is presented as the same
    // floating drawer. At `md` and up, docked returns to the document flow; the
    // divider then belongs to the primary page pane on its right.
    props.docked && 'md:static md:order-first md:h-full md:translate-x-0 md:rounded-none md:border-0 md:shadow-none',
    props.open ? 'translate-x-0' : '',
  );

  const overlayOpen = narrow && props.open;
  return (
    <div
      ref={drawerRef}
      className={classes}
      data-sidebar-drawer
      role={overlayOpen ? 'dialog' : undefined}
      aria-modal={overlayOpen ? true : undefined}
      aria-label={overlayOpen ? t('nav.sidebar') : undefined}
      tabIndex={overlayOpen ? -1 : undefined}
    >
      {children}
    </div>
  );
}
