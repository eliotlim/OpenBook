import {describe, it, expect, afterEach, beforeEach, vi} from 'vitest';
import {render, screen, cleanup, fireEvent} from '@testing-library/react';
import {LinkPicker} from '../LinkPicker';
import {setPageLinkBridge, type PageLinkResult} from '@/lib/pageLinks';

const PAGES: Array<PageLinkResult & {db: boolean}> = [
  {id: 'p1', label: 'Roadmap', icon: '📄', db: false},
  {id: 'p2', label: 'Tasks', icon: '🗃', db: true},
  {id: 'p3', label: 'Notes', icon: '📄', db: false},
];

beforeEach(() => {
  setPageLinkBridge({
    createSubpage: async () => 'x',
    openPage: () => {},
    label: (id) => PAGES.find((p) => p.id === id)?.label ?? 'Untitled',
    icon: () => '📄',
    createPage: async () => 'x',
    searchPages: (query, opts) =>
      PAGES.filter((p) => (!opts?.databasesOnly || p.db) && p.label.toLowerCase().includes(query.toLowerCase())).map(
        ({id, label, icon}) => ({id, label, icon}),
      ),
  });
});
afterEach(() => {
  cleanup();
  setPageLinkBridge(null);
});

describe('LinkPicker', () => {
  it('lists all pages and picks one', () => {
    const onPick = vi.fn();
    render(<LinkPicker kind="page" anchorEl={null} onPick={onPick} onClose={() => {}} />);
    expect(screen.getByText('Roadmap')).toBeTruthy();
    expect(screen.getByText('Tasks')).toBeTruthy();
    fireEvent.mouseDown(screen.getByText('Roadmap'));
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({id: 'p1', label: 'Roadmap'}));
  });

  it('restricts to databases when kind is database', () => {
    render(<LinkPicker kind="database" anchorEl={null} onPick={() => {}} onClose={() => {}} />);
    expect(screen.getByText('Tasks')).toBeTruthy(); // the only database
    expect(screen.queryByText('Roadmap')).toBeNull();
    expect(screen.queryByText('Notes')).toBeNull();
  });

  it('filters by the search query', () => {
    render(<LinkPicker kind="page" anchorEl={null} onPick={() => {}} onClose={() => {}} />);
    fireEvent.change(screen.getByRole('textbox'), {target: {value: 'note'}});
    expect(screen.getByText('Notes')).toBeTruthy();
    expect(screen.queryByText('Roadmap')).toBeNull();
  });
});
