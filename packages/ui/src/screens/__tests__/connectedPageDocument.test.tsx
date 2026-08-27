import {act, fireEvent, render, screen} from '@testing-library/react';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import type {PageSubscription, StoredPage} from '@book.dev/sdk';

const mocks = vi.hoisted(() => ({
  subscription: undefined as PageSubscription | undefined,
  titleHints: {} as Record<string, string>,
  renamePage: vi.fn(),
  setPageHint: vi.fn((id: string, name: string | null) => {
    mocks.titleHints[id] = name ?? 'Untitled';
    document.title = mocks.titleHints[id];
  }),
}));

vi.mock('@/data', () => ({useData: () => ({
  getPage: vi.fn().mockResolvedValue(null),
  savePage: vi.fn(),
  renamePage: mocks.renamePage,
  subscribePage: (_id: string, handlers: PageSubscription) => {
    mocks.subscription = handlers;
    return () => undefined;
  },
})}));
vi.mock('@/providers', () => ({
  clearLastPage: vi.fn(),
  useConfirm: () => vi.fn(),
  usePreferences: () => ({preferences: {general: {confirmOnTrash: false}}}),
  useTranslation: () => ({t: (key: string) => key}),
  useNavigation: () => ({
    pages: [{id: 'p1', name: 'Before', updatedAt: '2026-01-01T00:00:01.000Z', hostedDatabaseId: null}],
    deletePage: vi.fn(), setPageHint: mocks.setPageHint, closePage: vi.fn(), selectPage: vi.fn(),
  }),
}));
vi.mock('@/lib/pageIcon', () => ({hydratePageIcons: vi.fn(), usePageIcon: () => null, writePageIcon: vi.fn()}));
vi.mock('@/lib/crashRecovery', () => ({markPageCrashed: vi.fn()}));
vi.mock('@/lib/pageSaveStatus', () => ({pageSaveStatus: () => 'saved', setPageSaveStatus: vi.fn()}));
vi.mock('@/components/database/DatabaseView', () => ({DatabaseView: () => null}));
vi.mock('../BlockPageDocument', () => ({default: ({title, onTitleChange, onTitleActiveChange}: {
  title: string; onTitleChange: (value: string) => void; onTitleActiveChange: (active: boolean) => void;
}) => <input aria-label="page title" value={title} onChange={(event) => onTitleChange(event.target.value)}
  onFocus={() => onTitleActiveChange(true)} onBlur={() => onTitleActiveChange(false)} />}));

import {ConnectedPageDocument} from '../ConnectedPageDocument';

const page = (name: string, updatedAt = '2026-01-01T00:00:01.000Z'): StoredPage => ({
  id: 'p1', name, updatedAt, createdAt: '2026-01-01T00:00:00.000Z',
  data: {editorjs: {blocks: []}, values: [], names: []}, hostedDatabaseId: null,
  databaseId: null, parentId: null, properties: {}, deletedAt: null,
});

describe('ConnectedPageDocument live title metadata', () => {
  beforeEach(() => {
    mocks.subscription = undefined;
    mocks.titleHints = {};
    mocks.renamePage.mockReset();
    mocks.setPageHint.mockClear();
    document.title = '';
  });

  it('applies a changed name and title hint when its timestamp equals the content watermark', () => {
    render(<ConnectedPageDocument pageId="p1" />);
    act(() => mocks.subscription?.onPage?.(page('After')));
    expect((screen.getByLabelText('page title') as HTMLInputElement).value).toBe('After');
    expect(mocks.titleHints.p1).toBe('After');
    expect(document.title).toBe('After');
  });

  it('does not clobber typing with either its echo or an older-name stale echo', () => {
    render(<ConnectedPageDocument pageId="p1" />);
    const input = screen.getByLabelText('page title');
    act(() => mocks.subscription?.onPage?.(page('Newest', '2026-01-01T00:00:03.000Z')));
    act(() => mocks.subscription?.onPage?.(page('Older', '2026-01-01T00:00:02.000Z')));
    expect((input as HTMLInputElement).value).toBe('Newest');
    fireEvent.focus(input);
    fireEvent.change(input, {target: {value: 'Hello'}});
    act(() => mocks.subscription?.onPage?.(page('Hello', '2026-01-01T00:00:02.000Z')));
    expect((input as HTMLInputElement).value).toBe('Hello');
    fireEvent.change(input, {target: {value: 'Hello!'}});
    act(() => mocks.subscription?.onPage?.(page('Before', '2026-01-01T00:00:03.000Z')));
    expect((input as HTMLInputElement).value).toBe('Hello!');
  });
});
