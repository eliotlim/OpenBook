import {afterEach, describe, expect, it, vi} from 'vitest';
import {cleanup, render} from '@testing-library/react';
import type {DatabaseProperty, DatabaseRow, DatabaseView} from '@book.dev/sdk';
import {TimelineView} from '../databaseTimeline';
import type {UseDatabase} from '../useDatabase';

vi.mock('@/providers', async () => {
  const {t} = await import('@/i18n');
  return {
    useNavigation: () => ({setPageHint: vi.fn()}),
    useTranslation: () => ({t}),
  };
});
vi.mock('@/data', () => ({useData: () => ({listRows: vi.fn().mockResolvedValue([])})}));
vi.mock('@/lib/useCopyPageLink', () => ({useCopyPageLink: () => vi.fn()}));

const day = (): string => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
};

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('TimelineView', () => {
  it('keeps a one-day bar at its time-span width and lays out a readable label beside it', () => {
    const dateProperty: DatabaseProperty = {id: 'when', name: 'When', type: 'date'};
    const row: DatabaseRow = {
      id: 'row-1',
      name: 'Launch review',
      properties: {when: day()},
      exports: {},
      parentId: null,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    };
    const view: DatabaseView = {
      id: 'timeline-label-test',
      name: 'Timeline',
      type: 'timeline',
      filters: [],
      sorts: [],
      datePropertyId: dateProperty.id,
    };
    const db = {
      visibleRows: [row],
      rollupRows: [row],
      rollupProperties: [dateProperty],
      pendingRollups: new Set<string>(),
      openRow: vi.fn(),
    } as unknown as UseDatabase;

    const {container} = render(<TimelineView db={db} view={view} properties={[dateProperty]} />);

    const bar = container.querySelector<HTMLElement>('[title="Launch review — drag to reschedule"]');
    const label = container.querySelector<HTMLElement>('[data-timeline-bar-label="outside"]');
    expect(bar?.style.width).toBe('30px');
    expect(label?.textContent).toBe('Launch review');
    expect(label?.style.minWidth).toBe('72px');
  });
});
