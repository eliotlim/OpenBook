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
  vi.restoreAllMocks();
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

  it('preserves arrow-key navigation and Enter selection', () => {
    const onPick = vi.fn();
    render(<LinkPicker kind="page" anchorEl={null} onPick={onPick} onClose={() => {}} />);
    const input = screen.getByRole('textbox');

    fireEvent.keyDown(input, {key: 'ArrowDown'});
    fireEvent.keyDown(input, {key: 'Enter'});

    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({id: 'p2', label: 'Tasks'}));
  });

  it('measures its rendered size, flips above, clamps, and repositions on resize', () => {
    let viewportWidth = 1000;
    vi.spyOn(window, 'innerWidth', 'get').mockImplementation(() => viewportWidth);
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(720);
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(288);
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(300);
    const anchor = document.createElement('div');
    vi.spyOn(anchor, 'getBoundingClientRect').mockReturnValue({
      left: 900,
      right: 940,
      top: 680,
      bottom: 700,
      width: 40,
      height: 20,
      x: 900,
      y: 680,
      toJSON: () => ({}),
    });

    render(<LinkPicker kind="page" anchorEl={anchor} onPick={() => {}} onClose={() => {}} />);
    const picker = screen.getByRole('dialog');
    expect(picker.style.left).toBe('704px');
    expect(picker.style.top).toBe('374px');
    expect(picker.style.maxHeight).toBe('300px');

    viewportWidth = 600;
    fireEvent.resize(window);
    expect(picker.style.left).toBe('304px');
  });

  it('remeasures unconstrained when filtered results expand again', () => {
    let naturalHeight = 300;
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(900);
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
      if (this.getAttribute('role') !== 'dialog') return 0;
      return this.style.maxHeight ? Number.parseFloat(this.style.maxHeight) : naturalHeight;
    });
    render(<LinkPicker kind="page" anchorEl={null} onPick={() => {}} onClose={() => {}} />);
    const picker = screen.getByRole('dialog');

    naturalHeight = 100;
    fireEvent.change(screen.getByRole('textbox'), {target: {value: 'note'}});
    expect(picker.style.maxHeight).toBe('120px');

    naturalHeight = 300;
    fireEvent.change(screen.getByRole('textbox'), {target: {value: ''}});
    expect(picker.style.maxHeight).toBe('300px');
  });

  it('uses menu-family surface, row, and state styles', () => {
    render(<LinkPicker kind="page" anchorEl={null} onPick={() => {}} onClose={() => {}} />);
    const picker = screen.getByRole('dialog');
    const active = screen.getByRole('option', {name: /Roadmap/});

    expect(picker.dataset.state).toBe('open');
    expect(picker.className).toContain('rounded-md');
    expect(picker.className).toContain('p-1');
    expect(picker.className).toContain('shadow-menu');
    expect(picker.className).toContain('data-[state=open]:fade-in-0');
    expect(picker.className).toContain('data-[state=open]:zoom-in-95');
    expect(active.className.split(/\s+/)).toContain('bg-hover');
    expect(screen.getByRole('option', {name: /Tasks/}).className.split(/\s+/)).not.toContain('bg-hover');
    expect(active.className).not.toContain('bg-accent');
  });

  it('closes on outside click, Escape, and outside scroll but not list scroll', () => {
    const onClose = vi.fn();
    render(<LinkPicker kind="page" anchorEl={null} onPick={() => {}} onClose={onClose} />);

    fireEvent.scroll(screen.getByRole('listbox'));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.scroll(window);
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(screen.getByRole('textbox'), {key: 'Escape'});
    expect(onClose).toHaveBeenCalledTimes(2);
    fireEvent.mouseDown(document.body);
    expect(onClose).toHaveBeenCalledTimes(3);
  });
});
