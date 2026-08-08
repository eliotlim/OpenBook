import {afterEach, describe, expect, it, vi} from 'vitest';
import {cleanup, fireEvent, render, screen} from '@testing-library/react';
import {ExportBooksDialog, type ExportBooksChoice} from '../ExportBooksDialog';
import {I18nProvider} from '@/providers';

/**
 * LX-2 — the export dialog's "Include your books" surface. Pins the owner
 * decision and the no-escalation posture at the UI layer:
 *  - toggle VISIBLE and DEFAULT ON when the exporter can read the books, with
 *    the plain warning that the file will contain financial records;
 *  - unchecking swaps the warning for the "books excluded" notice and resolves
 *    `includeBooks: false`;
 *  - a principal who cannot read the books gets NO toggle at all — only the
 *    excluded notice — and the dialog can never resolve `includeBooks: true`;
 *  - cancel (button or dialog dismiss) resolves null so no file is produced.
 */

function mount(canInclude: boolean) {
  const onClose = vi.fn<(choice: ExportBooksChoice) => void>();
  render(
    <I18nProvider>
      <ExportBooksDialog open canInclude={canInclude} onClose={onClose} />
    </I18nProvider>,
  );
  return onClose;
}

afterEach(() => cleanup());

describe('ExportBooksDialog', () => {
  it('owner: toggle visible, DEFAULT ON, warning shown; confirm resolves includeBooks: true', () => {
    const onClose = mount(true);
    const toggle = screen.getByTestId('export-books-toggle') as HTMLInputElement;
    expect(toggle.checked).toBe(true); // the owner default
    expect(screen.getByTestId('export-books-warning').textContent).toContain('financial records');
    expect(screen.queryByTestId('export-books-excluded')).toBeNull();
    fireEvent.click(screen.getByTestId('export-books-confirm'));
    expect(onClose).toHaveBeenCalledWith({includeBooks: true});
  });

  it('unchecking shows the excluded notice and resolves includeBooks: false', () => {
    const onClose = mount(true);
    fireEvent.click(screen.getByTestId('export-books-toggle'));
    expect(screen.getByTestId('export-books-excluded').textContent).toContain('not be included');
    expect(screen.queryByTestId('export-books-warning')).toBeNull();
    fireEvent.click(screen.getByTestId('export-books-confirm'));
    expect(onClose).toHaveBeenCalledWith({includeBooks: false});
  });

  it('reader without access: no toggle, only the excluded notice; confirm can never include', () => {
    const onClose = mount(false);
    expect(screen.queryByTestId('export-books-toggle')).toBeNull();
    expect(screen.getByTestId('export-books-excluded').textContent).toContain('can’t be included');
    fireEvent.click(screen.getByTestId('export-books-confirm'));
    expect(onClose).toHaveBeenCalledWith({includeBooks: false});
  });

  it('cancel resolves null (export aborted)', () => {
    const onClose = mount(true);
    fireEvent.click(screen.getByText('Cancel'));
    expect(onClose).toHaveBeenCalledWith(null);
  });
});
