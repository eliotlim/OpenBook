import {describe, expect, it} from 'vitest';
import {parseClipboardGrid} from '../tablePaste';

describe('parseClipboardGrid', () => {
  it('parses the first HTML table and preserves br as a newline', () => {
    expect(parseClipboardGrid({html: '<p>before</p><table><tr><th> A<br>B </th><th>C</th></tr></table><table><tr><td>ignored</td></tr></table>'})).toEqual([
      ['A\nB', 'C'],
    ]);
  });

  it('expands HTML colspan and rowspan with empty covered slots', () => {
    expect(parseClipboardGrid({html: '<table><tr><td colspan="2" rowspan="2">A</td><td>B</td></tr><tr><td>C</td></tr></table>'})).toEqual([
      ['A', '', 'B'],
      ['', '', 'C'],
    ]);
  });

  it('parses TSV rows and columns', () => {
    expect(parseClipboardGrid({text: 'A\tB\nC\tD'})).toEqual([
      ['A', 'B'],
      ['C', 'D'],
    ]);
  });

  it('parses quoted tabs/newlines and escaped quotes', () => {
    expect(parseClipboardGrid({text: '"a\tb"\t"line 1\nline 2 and ""quote"""'})).toEqual([['a\tb', 'line 1\nline 2 and "quote"']]);
  });

  it('returns null for a single plain value and empty input', () => {
    expect(parseClipboardGrid({text: 'plain'})).toBeNull();
    expect(parseClipboardGrid({text: ''})).toBeNull();
    expect(parseClipboardGrid({})).toBeNull();
  });
});
