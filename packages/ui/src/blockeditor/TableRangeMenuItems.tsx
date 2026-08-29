import React from 'react';
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ClipboardPaste,
  Copy,
  Eraser,
  Scissors,
  TableCellsMerge,
  TableCellsSplit,
  Trash2,
  type LucideIcon,
} from 'lucide-react';
import {
  blockId,
  blockType,
  clearCellRange,
  findBlock,
  setTableCellRangeColor,
  tableCellOwnColor,
  tableDeleteColumnRange,
  tableDeleteRowRange,
  tableGrid,
  tableInsertColumn,
  tableInsertRow,
  tableMergeCells,
  tableRangeCells,
  tableSplitCell,
  type BlockMap,
  type CellRect,
} from './model';
import {cellRangeExportToHtml, cellRangeToTsv} from './exportBlocks';
import {parseClipboardGrid} from './tablePaste';
import {tablePasteGrid, tableRangeExport, tableRangeRuns} from './model';
import type {BlockEditorController} from './useBlockEditor';
import {COLOR_TOKENS} from './colors';
import {t, type TKey} from '../i18n';
import {
  MENU_COMPONENTS,
  MENU_DESTRUCTIVE_CLASS,
  MENU_WIDTH_SM,
  type MenuComponentSet,
} from '@/components/ui/menu-components';
import {Check} from 'lucide-react';

export interface TableRangeMenuContext {
  rect: CellRect;
  tableId: string;
  editor: BlockEditorController;
  onClearRange?: () => void;
}

export interface RangeMenuActionItem {
  kind: 'action';
  id: string;
  label: string;
  icon: LucideIcon;
  onSelect: () => void | Promise<void>;
  disabled?: boolean;
  destructive?: boolean;
  toolbar: boolean;
}

export interface RangeMenuColourItem {
  kind: 'colour';
  id: 'tint';
  label: string;
  current: string | null;
  onPick: (token: string | null) => void;
  toolbar: true;
}

export interface RangeMenuSeparatorItem {
  kind: 'separator';
  id: string;
  toolbar: false;
}

export type RangeMenuItem = RangeMenuActionItem | RangeMenuColourItem | RangeMenuSeparatorItem;

/** Both native copy/cut events and range-menu commands use this payload. */
export function tableRangeClipboardPayload(
  doc: BlockEditorController['doc'],
  tableId: string,
  rect: CellRect,
): {text: string; html: string} {
  return {
    text: cellRangeToTsv(tableRangeRuns(doc, tableId, rect)),
    html: cellRangeExportToHtml(tableRangeExport(doc, tableId, rect)),
  };
}

/** Canonical range action definitions, consumed by both menu surfaces. */
export function rangeMenuItems(ctx: TableRangeMenuContext): RangeMenuItem[] {
  const {rect, tableId, editor, onClearRange} = ctx;
  const doc = editor.doc;
  const found = findBlock(doc, tableId);
  if (!found || blockType(found.block) !== 'table') return [];
  const grid = tableGrid(found.block);
  const rowFrom = Math.max(0, Math.min(rect.top, rect.bottom));
  const rowTo = Math.min(grid.rows.length - 1, Math.max(rect.top, rect.bottom));
  const colFrom = Math.max(0, Math.min(rect.left, rect.right));
  const colTo = Math.min(grid.width - 1, Math.max(rect.left, rect.right));
  const rowCount = Math.max(0, rowTo - rowFrom + 1);
  const colCount = Math.max(0, colTo - colFrom + 1);
  const deletesAllRows = grid.rows.length > 0 && rowCount === grid.rows.length;
  const deletesAllColumns = grid.width > 0 && colCount === grid.width;
  const cells = tableRangeCells(doc, tableId, rect).flat().filter((cell): cell is BlockMap => cell !== null);
  const uniqueCells = [...new Map(cells.map((cell) => [blockId(cell), cell])).values()];
  const first = cells.length > 0 ? tableCellOwnColor(cells[0]) : null;
  const current = cells.length > 0 && cells.every((cell) => tableCellOwnColor(cell) === first) ? first : null;
  const splitCell = uniqueCells.length === 1 && (rowCount > 1 || colCount > 1) ? uniqueCells[0] : null;
  const clipboard: Partial<Clipboard> | undefined = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
  const canWriteClipboard = !!clipboard?.write && typeof ClipboardItem !== 'undefined';
  const canPasteClipboard = !!clipboard && (!!clipboard.read || !!clipboard.readText);
  const copyRange = async (cut: boolean): Promise<void> => {
    if (!canWriteClipboard) return;
    try {
      const payload = tableRangeClipboardPayload(doc, tableId, rect);
      await clipboard!.write!([new ClipboardItem({
        'text/plain': new Blob([payload.text], {type: 'text/plain'}),
        'text/html': new Blob([payload.html], {type: 'text/html'}),
      })]);
      if (cut) clearCellRange(doc, tableId, rect);
    } catch {
      // Clipboard permission can be denied between menu open and selection.
    }
  };
  const pasteRange = async (): Promise<void> => {
    if (!canPasteClipboard) return;
    try {
      let html = '';
      let text = '';
      if (clipboard!.read) {
        const clipboardItems = await clipboard!.read();
        const item = clipboardItems[0];
        if (item?.types.includes('text/html')) html = await (await item.getType('text/html')).text();
        if (item?.types.includes('text/plain')) text = await (await item.getType('text/plain')).text();
      } else if (clipboard!.readText) text = await clipboard!.readText();
      const source = parseClipboardGrid({html, text});
      if (source) tablePasteGrid(doc, tableId, {row: rowFrom, col: colFrom}, source, {
        range: {tableId, anchor: {row: rowFrom, col: colFrom}, focus: {row: rowTo, col: colTo}},
      });
    } catch {
      // Unsupported/denied clipboard reads leave the document untouched.
    }
  };
  const insertRows = (at: number): void => doc.transact(() => {
    for (let i = 0; i < rowCount; i += 1) tableInsertRow(doc, tableId, at);
  }, 'local');
  const insertColumns = (at: number): void => doc.transact(() => {
    for (let i = 0; i < colCount; i += 1) tableInsertColumn(doc, tableId, at);
  }, 'local');
  return [
    {kind: 'action', id: 'copy', label: t('menu.clipboard.copy'), icon: Copy, disabled: !canWriteClipboard, toolbar: false, onSelect: () => copyRange(false)},
    {kind: 'action', id: 'cut', label: t('menu.clipboard.cut'), icon: Scissors, disabled: !canWriteClipboard, toolbar: false, onSelect: () => copyRange(true)},
    {kind: 'action', id: 'paste', label: t('menu.clipboard.paste'), icon: ClipboardPaste, disabled: !canPasteClipboard, toolbar: false, onSelect: pasteRange},
    {kind: 'separator', id: 'clipboard-separator', toolbar: false},
    {kind: 'action', id: 'insert-rows-above', label: rowCount === 1 ? t('menu.table.insertRowAbove') : t('menu.table.insertRowsAboveN', {n: rowCount}), icon: ArrowUp, toolbar: true, onSelect: () => insertRows(rowFrom)},
    {kind: 'action', id: 'insert-rows-below', label: rowCount === 1 ? t('menu.table.insertRowBelow') : t('menu.table.insertRowsBelowN', {n: rowCount}), icon: ArrowDown, toolbar: true, onSelect: () => insertRows(rowTo + 1)},
    {kind: 'action', id: 'insert-columns-left', label: colCount === 1 ? t('menu.table.insertColumnLeft') : t('menu.table.insertColumnsLeftN', {n: colCount}), icon: ArrowLeft, toolbar: true, onSelect: () => insertColumns(colFrom)},
    {kind: 'action', id: 'insert-columns-right', label: colCount === 1 ? t('menu.table.insertColumnRight') : t('menu.table.insertColumnsRightN', {n: colCount}), icon: ArrowRight, toolbar: true, onSelect: () => insertColumns(colTo + 1)},
    {kind: 'separator', id: 'insert-separator', toolbar: false},
    {kind: 'action', id: 'clear', label: t('menu.table.clearCells'), icon: Eraser, toolbar: true, onSelect: () => clearCellRange(doc, tableId, rect)},
    splitCell
      ? {kind: 'action', id: 'split', label: t('menu.table.splitCell'), icon: TableCellsSplit, toolbar: true, onSelect: () => { tableSplitCell(doc, blockId(splitCell)); onClearRange?.(); }}
      : {kind: 'action', id: 'merge', label: t('menu.table.mergeCells'), icon: TableCellsMerge, toolbar: true, onSelect: () => { tableMergeCells(doc, tableId, rect); onClearRange?.(); }},
    {kind: 'colour', id: 'tint', label: t('menu.table.tintCells'), current, toolbar: true, onPick: (token) => setTableCellRangeColor(doc, tableId, rect, token)},
    {kind: 'separator', id: 'delete-separator', toolbar: false},
    {kind: 'action', id: 'delete-rows', label: deletesAllRows ? t('menu.table.deleteTable') : rowCount === 1 ? t('menu.table.deleteRow') : t('menu.table.deleteRowsN', {n: rowCount}), icon: Trash2, destructive: true, toolbar: true, onSelect: () => { tableDeleteRowRange(doc, tableId, rect.top, rect.bottom); onClearRange?.(); }},
    {kind: 'action', id: 'delete-columns', label: deletesAllColumns ? t('menu.table.deleteTable') : colCount === 1 ? t('menu.table.deleteColumn') : t('menu.table.deleteColumnsN', {n: colCount}), icon: Trash2, destructive: true, toolbar: true, onSelect: () => { tableDeleteColumnRange(doc, tableId, rect.left, rect.right); onClearRange?.(); }},
  ];
}

const COLOUR_MENU: Array<{id: string | null; label: TKey}> = [
  {id: null, label: 'menu.colour.default'},
  ...COLOR_TOKENS.map((colour) => ({id: colour.id, label: `menu.colour.${colour.id}` as TKey})),
];

export const TableRangeMenuItems: React.FC<TableRangeMenuContext & {menu?: MenuComponentSet}> = ({menu = MENU_COMPONENTS.context, ...ctx}) => {
  const {Item, Separator, Sub, SubContent, SubTrigger} = menu;
  return rangeMenuItems(ctx).map((item) => {
    if (item.kind === 'separator') return <Separator key={item.id} />;
    if (item.kind === 'colour') return (
      <Sub key={item.id}>
        <SubTrigger>{item.label}</SubTrigger>
        <SubContent className={MENU_WIDTH_SM}>
          {COLOUR_MENU.map((colour) => (
            <Item key={colour.id ?? 'default'} onSelect={() => item.onPick(colour.id)}>
              <span className={`obe-mi-sw obe-mi-sw-fill ${colour.id ? `obe-hl-${colour.id}` : 'obe-mi-sw-reset'}`} aria-hidden />
              {t(colour.label)}
              {(colour.id ?? null) === item.current && <Check className="ml-auto h-3.5 w-3.5" />}
            </Item>
          ))}
        </SubContent>
      </Sub>
    );
    const Icon = item.icon;
    return (
      <Item key={item.id} disabled={item.disabled} className={item.destructive ? MENU_DESTRUCTIVE_CLASS : undefined} onSelect={() => void item.onSelect()}>
        <Icon className="mr-2 h-3.5 w-3.5" /> {item.label}
      </Item>
    );
  });
};
