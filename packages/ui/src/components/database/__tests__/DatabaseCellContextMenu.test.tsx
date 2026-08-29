import {afterEach, describe, expect, it, vi} from 'vitest';
import {cleanup, fireEvent, render, screen} from '@testing-library/react';
import type {DatabaseProperty, DatabaseRow, DatabaseView} from '@book.dev/sdk';
import {setLocale, t, type Locale} from '@/i18n';
import {CellContextMenu} from '../DatabaseView';
import type {UseDatabase} from '../useDatabase';

vi.mock('@/providers', () => ({
  useNavigation: () => ({setPageHint: vi.fn()}),
  useTranslation: () => ({t}),
}));
vi.mock('@/lib/useCopyPageLink', () => ({useCopyPageLink: () => vi.fn()}));

const view = {id: 'view-1', name: 'Table', type: 'table', filters: [], sorts: []} as DatabaseView;
const row = {id: 'row-1', name: 'Row', properties: {}} as unknown as DatabaseRow;
const db = {
  activeView: view,
  updateView: vi.fn().mockResolvedValue(undefined),
  openRow: vi.fn(),
  openRowIn: vi.fn(),
  addRowBefore: vi.fn(),
  addRowAfter: vi.fn(),
  duplicateRow: vi.fn(),
  deleteRow: vi.fn(),
} as unknown as UseDatabase;

afterEach(() => {
  cleanup();
  setLocale('en');
});

function openMenu(property: DatabaseProperty, value: unknown): void {
  render(
    <CellContextMenu db={db} view={view} row={row} property={property} value={value}>
      <span data-testid="cell">Value</span>
    </CellContextMenu>,
  );
  fireEvent.contextMenu(screen.getByTestId('cell'));
}

function statusProperty(): DatabaseProperty {
  return {id: 'status', name: 'Name', type: 'status', options: [{id: 'foo', label: 'Foo', color: 'blue'}]};
}

function expectLocalizedMenu(locale: Locale, filterLabel: string, dateLabel: string, datePreset: string): void {
  setLocale(locale);
  openMenu(statusProperty(), 'foo');
  expect(screen.getByText(filterLabel)).toBeTruthy();
  expect(screen.queryByText(/Filter:/)).toBeNull();

  cleanup();
  openMenu({id: 'date', name: 'Date', type: 'date'}, '2026-08-29');
  expect(screen.getByText(dateLabel)).toBeTruthy();
  expect(screen.queryByText('Filter by date')).toBeNull();
  fireEvent.click(screen.getByText(dateLabel));
  expect(screen.queryByText('This week')).toBeNull();
  expect(screen.getByText(datePreset)).toBeTruthy();
}

describe('DatabaseView cell context menu i18n', () => {
  it('keeps the English value-filter label unchanged', () => {
    openMenu(statusProperty(), 'foo');
    expect(screen.getByText('Filter: Name is Foo')).toBeTruthy();
  });

  it('localizes the German quick-filter block without English labels', () => {
    expectLocalizedMenu('de', 'Filtern: Name ist Foo', 'Nach Datum filtern', 'Diese Woche');
  });

  it('localizes the Japanese quick-filter block', () => {
    expectLocalizedMenu('ja', 'フィルター：NameがFoo', '日付でフィルター', '今週');
  });

  it('localizes the Chinese quick-filter block', () => {
    expectLocalizedMenu('zh', '筛选：Name是Foo', '按日期筛选', '本周');
  });
});
