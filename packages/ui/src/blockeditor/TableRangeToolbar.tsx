import React, {useEffect, useLayoutEffect, useMemo, useRef, useState} from 'react';
import {Ellipsis, Palette} from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {MENU_COMPONENTS, MENU_DESTRUCTIVE_CLASS, MENU_WIDTH_MD} from '@/components/ui/menu-components';
import {t} from '../i18n';
import {INLINE_TOOLBAR_POSITION_OPTIONS, observePopupPosition, type PopupPosition} from './popupPosition';
import {
  RANGE_COLOUR_MENU,
  TableRangeMenuItems,
  rangeMenuItems,
  type RangeMenuActionItem,
  type RangeMenuColourItem,
  type TableRangeMenuContext,
} from './TableRangeMenuItems';

export function selectedCellRangeRect(table: HTMLTableElement): DOMRect | null {
  const cells = [...table.querySelectorAll<HTMLElement>('td.obe-cell-selected')];
  if (cells.length === 0) return null;
  const rects = cells.map((cell) => cell.getBoundingClientRect());
  const left = Math.min(...rects.map((rect) => rect.left));
  const top = Math.min(...rects.map((rect) => rect.top));
  const right = Math.max(...rects.map((rect) => rect.right));
  const bottom = Math.max(...rects.map((rect) => rect.bottom));
  return new DOMRect(left, top, right - left, bottom - top);
}

const useCoarsePointer = (): boolean => {
  const [coarse, setCoarse] = useState(false);
  useEffect(() => {
    const media = window.matchMedia?.('(pointer: coarse)');
    if (!media) return;
    const update = (): void => setCoarse(media.matches);
    update();
    media.addEventListener?.('change', update);
    return () => media.removeEventListener?.('change', update);
  }, []);
  return coarse;
};

export const TableRangeToolbar: React.FC<TableRangeMenuContext & {
  tableRef: React.RefObject<HTMLTableElement | null>;
  onDismiss: () => void;
}> = ({tableRef, onDismiss, ...ctx}) => {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<PopupPosition | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const coarse = useCoarsePointer();
  const rectKey = `${ctx.rect.top}:${ctx.rect.left}:${ctx.rect.bottom}:${ctx.rect.right}`;
  const items = useMemo(() => rangeMenuItems(ctx).filter(
    (item): item is RangeMenuActionItem | RangeMenuColourItem => item.toolbar,
  ), [ctx.editor, ctx.onClearRange, rectKey, ctx.tableId]);
  const actionableRange = ctx.rect.top !== ctx.rect.bottom || ctx.rect.left !== ctx.rect.right;
  const hidden = coarse || ctx.editor.readOnly || !actionableRange;

  useLayoutEffect(() => observePopupPosition({
    popup: () => ref.current,
    anchor: () => tableRef.current && selectedCellRangeRect(tableRef.current),
    boundary: () => tableRef.current?.closest<HTMLElement>('[data-radix-scroll-area-viewport]') ?? tableRef.current?.closest<HTMLElement>('.obe-editor-pane') ?? null,
    onPosition: setPosition,
    options: {
      ...INLINE_TOOLBAR_POSITION_OPTIONS,
      preferredPlacement: ctx.rect.top === 0 ? 'below' : 'above',
      clampHorizontallyToBoundary: true,
    },
  }), [tableRef, rectKey]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (hidden || !ref.current) return;
      if (event.key === 'Escape') {
        if (ref.current.querySelector('[data-state="open"]')) return;
        event.preventDefault();
        onDismiss();
        tableRef.current?.focus();
        return;
      }
      if (event.key === 'Tab' && !event.shiftKey && tableRef.current?.contains(document.activeElement) && !ref.current.contains(document.activeElement)) {
        event.preventDefault();
        setActiveIndex(0);
        ref.current.querySelector<HTMLElement>('[data-range-toolbar-button]')?.focus();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [hidden, onDismiss, tableRef]);

  if (hidden) return null;
  const move = (from: number, delta: number): void => {
    const next = (from + delta + items.length + 1) % (items.length + 1);
    setActiveIndex(next);
    ref.current?.querySelectorAll<HTMLElement>('[data-range-toolbar-button]')[next]?.focus();
  };
  const buttonKeyDown = (index: number) => (event: React.KeyboardEvent): void => {
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      event.preventDefault();
      move(index, 1);
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      event.preventDefault();
      move(index, -1);
    }
  };
  return (
    <div
      ref={ref}
      className="obe-range-toolbar"
      role="toolbar"
      aria-label={t('menu.table.rangeToolbar')}
      data-placement={position?.placement}
      style={position ? {left: position.left, top: position.top} : {left: 0, top: 0, visibility: 'hidden'}}
      onMouseDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      {items.map((item, index) => {
        if (item.kind === 'colour') return (
          <DropdownMenu key={item.id}>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="obe-range-toolbar-button"
                data-range-toolbar-button
                data-testid="range-action"
                tabIndex={activeIndex === index ? 0 : -1}
                aria-label={item.label}
                title={item.label}
                onPointerDown={(event) => event.preventDefault()}
                onKeyDown={buttonKeyDown(index)}
              >
                <Palette aria-hidden />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent onCloseAutoFocus={(event) => event.preventDefault()}>
              {RANGE_COLOUR_MENU.map((colour) => (
                <DropdownMenuItem key={colour.id ?? 'default'} onSelect={() => item.onPick(colour.id)}>
                  <span className={`obe-mi-sw obe-mi-sw-fill ${colour.id ? `obe-hl-${colour.id}` : 'obe-mi-sw-reset'}`} aria-hidden />
                  {t(colour.label)}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        );
        const Icon = item.icon;
        return (
          <button
            key={item.id}
            type="button"
            className={`obe-range-toolbar-button${item.destructive ? ` ${MENU_DESTRUCTIVE_CLASS}` : ''}`}
            data-range-toolbar-button
            data-testid="range-action"
            tabIndex={activeIndex === index ? 0 : -1}
            disabled={item.disabled}
            aria-label={item.label}
            title={item.label}
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => void item.onSelect()}
            onKeyDown={buttonKeyDown(index)}
          >
            <Icon aria-hidden />
          </button>
        );
      })}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="obe-range-toolbar-button"
            data-range-toolbar-button
            tabIndex={activeIndex === items.length ? 0 : -1}
            aria-label={t('menu.table.rangeToolbarMore')}
            title={t('menu.table.rangeToolbarMore')}
            onPointerDown={(event) => event.preventDefault()}
            onKeyDown={buttonKeyDown(items.length)}
          >
            <Ellipsis aria-hidden />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent className={MENU_WIDTH_MD} onCloseAutoFocus={(event) => event.preventDefault()}>
          <DropdownMenuLabel>{t('menu.table.sectionSelection')}</DropdownMenuLabel>
          <TableRangeMenuItems menu={MENU_COMPONENTS.dropdown} {...ctx} />
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
};
