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
  onPreview: (width: number) => void;
  onCommit: (width: number | null) => void;
}

/** TBL-12's isolated pointer/keyboard separator; the model commit happens once. */
export const TableColResizer: React.FC<TableColResizerProps> = ({columnIndex, width, spanCount, left, onPreview, onCommit}) => {
  const drag = useRef<{pointerId: number; startX: number; startWidth: number} | null>(null);
  const handle = useRef<HTMLSpanElement>(null);
  const currentWidth = (): number => width ?? Math.max(
    TABLE_COLUMN_MIN_WIDTH,
    Math.round((handle.current?.parentElement?.getBoundingClientRect().width ?? TABLE_COLUMN_MIN_WIDTH) / spanCount),
  );
  const resize = (next: number): number => Math.max(TABLE_COLUMN_MIN_WIDTH, Math.round(next));

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
      aria-valuenow={width ?? TABLE_COLUMN_MIN_WIDTH}
      tabIndex={0}
      style={{left}}
      onDoubleClick={(event) => { event.preventDefault(); event.stopPropagation(); onCommit(null); }}
      onPointerDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
        const host = event.currentTarget.parentElement?.getBoundingClientRect();
        const startWidth = width ?? Math.max(TABLE_COLUMN_MIN_WIDTH, Math.round((host?.width ?? TABLE_COLUMN_MIN_WIDTH) / spanCount));
        drag.current = {pointerId: event.pointerId, startX: event.clientX, startWidth};
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (drag.current?.pointerId !== event.pointerId) return;
        onPreview(resize(drag.current.startWidth + event.clientX - drag.current.startX));
      }}
      onPointerUp={(event) => {
        if (drag.current?.pointerId !== event.pointerId) return;
        const next = resize(drag.current.startWidth + event.clientX - drag.current.startX);
        drag.current = null;
        event.currentTarget.releasePointerCapture(event.pointerId);
        onCommit(next);
      }}
      onPointerCancel={() => { drag.current = null; }}
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
