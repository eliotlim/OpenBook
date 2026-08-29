export interface ClipboardGridData {
  html?: string;
  text?: string;
}

export interface ClipboardGridCell {text: string; color?: string}
export type ClipboardGrid = Array<Array<string | ClipboardGridCell>>;

const htmlCellText = (cell: Element): string => {
  const copy = cell.cloneNode(true) as Element;
  for (const br of copy.querySelectorAll('br')) br.replaceWith('\n');
  return (copy.textContent ?? '').trim();
};

const colorByCss = new Map(Object.entries(COLOR_EXPORT_HEX).map(([token, value]) => [value.hl.toLowerCase(), token]));
const cellColor = (cell: Element): string | undefined => {
  const raw = (cell as HTMLElement).style.backgroundColor || (cell as HTMLElement).style.background;
  if (!raw) return undefined;
  if (colorByCss.has(raw.toLowerCase())) return colorByCss.get(raw.toLowerCase());
  const match = raw.match(/^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/i);
  const hex = match ? `#${match.slice(1).map((n) => Number(n).toString(16).padStart(2, '0')).join('')}` : '';
  return colorByCss.get(hex);
};

const parseHtmlTable = (html: string): ClipboardGrid | null => {
  if (!html.trim()) return null;
  const table = new DOMParser().parseFromString(html, 'text/html').querySelector('table');
  if (!table) return null;
  const grid: ClipboardGrid = [];
  const rows = Array.from(table.querySelectorAll('tr')).filter((row) => row.closest('table') === table);
  for (let r = 0; r < rows.length; r += 1) {
    grid[r] ??= [];
    let c = 0;
    const cells = Array.from(rows[r].children).filter((child) => child.matches('td,th'));
    for (const cell of cells) {
      while (grid[r][c] !== undefined) c += 1;
      const colspan = Math.max(1, Number.parseInt(cell.getAttribute('colspan') ?? '1', 10) || 1);
      const rowspan = Math.max(1, Number.parseInt(cell.getAttribute('rowspan') ?? '1', 10) || 1);
      for (let rr = r; rr < r + rowspan; rr += 1) {
        grid[rr] ??= [];
        for (let cc = c; cc < c + colspan; cc += 1) {
          if (rr === r && cc === c) {
            const color = cellColor(cell);
            grid[rr][cc] = color ? {text: htmlCellText(cell), color} : htmlCellText(cell);
          } else grid[rr][cc] = '';
        }
      }
      c += colspan;
    }
  }
  const width = grid.reduce((max, row) => Math.max(max, row.length), 0);
  return width === 0 ? null : grid.map((row) => Array.from({length: width}, (_, c) => row[c] ?? ''));
};

const parseTsv = (text: string): string[][] => {
  const rows: string[][] = [[]];
  let value = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        value += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else value += ch;
    } else if (ch === '"' && value.length === 0) quoted = true;
    else if (ch === '\t') {
      rows[rows.length - 1].push(value);
      value = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      rows[rows.length - 1].push(value);
      rows.push([]);
      value = '';
    } else value += ch;
  }
  rows[rows.length - 1].push(value);
  return rows;
};

/** Parse a spreadsheet-shaped clipboard payload, preferring its first HTML table. */
export function parseClipboardGrid(data: ClipboardGridData): ClipboardGrid | null {
  const htmlGrid = parseHtmlTable(data.html ?? '');
  if (htmlGrid) return htmlGrid;
  const text = (data.text ?? '').replace(/\r\n$|[\r\n]$/, '');
  if (!text || (!text.includes('\t') && !text.includes('\n') && !text.includes('\r'))) return null;
  return parseTsv(text);
}
import {COLOR_EXPORT_HEX} from './colors';
