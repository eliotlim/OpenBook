import {afterEach, describe, expect, it, vi} from 'vitest';
import {cleanup, fireEvent, render, screen} from '@testing-library/react';
import type {MouseEvent as ReactMouseEvent} from 'react';

const {activatePage, copyLink, focusPane, openInSplit} = vi.hoisted(() => ({
  activatePage: vi.fn(),
  copyLink: vi.fn(),
  focusPane: vi.fn(),
  openInSplit: vi.fn(),
}));

vi.mock('@xyflow/react', () => ({
  Background: () => null,
  BackgroundVariant: {Dots: 'dots'},
  Controls: () => null,
  Handle: () => null,
  Position: {Left: 'left', Right: 'right'},
  ReactFlow: ({
    nodes,
    onNodeContextMenu,
  }: {
    nodes: Array<{id: string; data: {node: {name?: string}}}>;
    onNodeContextMenu?: (event: ReactMouseEvent, node: {id: string; data: {node: {name?: string}}}) => void;
  }) => (
    <div>
      {nodes.map((node) => (
        <button
          key={node.id}
          type="button"
          className="react-flow__node"
          onContextMenu={(event) => onNodeContextMenu?.(event, node)}
        >
          {node.data.node.name}
        </button>
      ))}
    </div>
  ),
}));

vi.mock('@/blockeditor/kit/dataflow', () => ({
  layeredLayout: () => new Map([['page-1', {x: 0, y: 0}], ['page-2', {x: 100, y: 0}]]),
}));

vi.mock('@/data', () => ({
  useData: () => ({
    pageGraph: async () => ({
      nodes: [
        {id: 'page-1', name: 'Node one'},
        {id: 'page-2', name: 'Node two'},
      ],
      edges: [{from: 'page-1', to: 'page-2', kind: 'mention'}],
    }),
    subscribePages: () => () => undefined,
  }),
}));

vi.mock('@/providers', async () => {
  const {t} = await import('@/i18n');
  return {
    useNavigation: () => ({
      closeSplit: vi.fn(),
      focusPane,
      openInSplit,
      pageLabel: (id: string) => id,
      selectPage: activatePage,
    }),
    useTheme: () => ({colorScheme: 'light'}),
    useTranslation: () => ({t}),
  };
});

vi.mock('@/lib/useCopyPageLink', () => ({useCopyPageLink: () => copyLink}));

import {GraphPaneBody} from '../GraphPaneBody';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('GraphPaneBody node context menu', () => {
  it('renders node actions and routes Open through the existing activation handler', async () => {
    render(<GraphPaneBody />);

    fireEvent.contextMenu(await screen.findByText('Node one'));

    expect(screen.getByText('Open in split view')).toBeTruthy();
    expect(screen.getByText('Copy link')).toBeTruthy();
    fireEvent.click(screen.getByText('Open'));

    expect(focusPane).toHaveBeenCalledWith('primary');
    expect(activatePage).toHaveBeenCalledWith('page-1');
  });
});
