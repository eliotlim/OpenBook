import React, {useRef} from 'react';
import {t} from '@/i18n';
import {TABLE_COLUMN_MIN_WIDTH} from './model';

export const tableColumnLabel = (index: number): string => {
  let value = index + 1;
  let label = '';
  while (value > 0) {
    value -= 1;
    label = String.fromCharCode(65 + (value % 26)) + label;
    value = Math.floor(value / 26);
  }
  return label;
};

interface TableColResizerProps {
  columnIndex: number;
  width: number | null;
  spanCount: number;
  left: string;
  height: number;
  onPreview: (width: number | null) => void;
  onCommit: (width: number | null) => void;
}

/** TBL-12's isolated pointer/keyboard separator; the model commit happens once. */
export const TableColResizer: React.FC<TableColResizerProps> = ({columnIndex, width, spanCount, left, height, onPreview, onCommit}) => {
  const drag = useRef<{pointerId: number; startX: number; startWidth: number; moved: boolean} | null>(null);
  const handle = useRef<HTMLSpanElement>(null);
  const currentWidth = (): number => width ?? Math.max(
    TABLE_COLUMN_MIN_WIDTH,
    Math.round((handle.current?.parentElement?.getBoundingClientRect().width ?? TABLE_COLUMN_MIN_WIDTH) / spanCount),
  );
  const max = handle.current?.closest('table')?.getBoundingClientRect().width ?? 1e4;
  const resize = (next: number): number => Math.min(max, Math.max(TABLE_COLUMN_MIN_WIDTH, Math.round(next)));

  return (
    <span
      ref={handle}
      className="obe-table-col-resizer"
      contentEditable={false}
      data-table-col-resizer={columnIndex}
      role="separator"
      aria-orientation="vertical"
      aria-label={t('blockEditor.resizeColumn', {column: tableColumnLabel(columnIndex)})}
      aria-valuemin={TABLE_COLUMN_MIN_WIDTH}
      {...(width === null ? {'aria-valuetext': 'auto'} : {'aria-valuenow': width})}
      {...(max === 1e4 ? {} : {'aria-valuemax': max})}
      tabIndex={0}
      style={{left, height}}
      onDoubleClick={(event) => { event.preventDefault(); event.stopPropagation(); onCommit(null); }}
      onPointerDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
        const host = event.currentTarget.parentElement?.getBoundingClientRect();
        const startWidth = width ?? Math.max(TABLE_COLUMN_MIN_WIDTH, Math.round((host?.width ?? TABLE_COLUMN_MIN_WIDTH) / spanCount));
        drag.current = {pointerId: event.pointerId, startX: event.clientX, startWidth, moved: false};
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (drag.current?.pointerId !== event.pointerId) return;
        drag.current.moved = true;
        const dir = getComputedStyle(event.currentTarget).direction === 'rtl' ? -1 : 1;
        onPreview(resize(drag.current.startWidth + dir * (event.clientX - drag.current.startX)));
      }}
      onPointerUp={(event) => {
        if (drag.current?.pointerId !== event.pointerId) return;
        const s = drag.current;
        drag.current = null;
        event.currentTarget.releasePointerCapture(event.pointerId);
        if (!s.moved) return;
        const dir = getComputedStyle(event.currentTarget).direction === 'rtl' ? -1 : 1;
        onCommit(resize(s.startWidth + dir * (event.clientX - s.startX)));
      }}
      onPointerCancel={(event) => {
        if (drag.current?.pointerId !== event.pointerId) return;
        drag.current = null;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
        onPreview(null);
      }}
      onKeyDown={(event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault();
        event.stopPropagation();
        const delta = (event.shiftKey ? 32 : 8) * (event.key === 'ArrowRight' ? 1 : -1);
        onCommit(resize(currentWidth() + delta));
      }}
    />
  );
};
