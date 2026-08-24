import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import type {DataClient, PageMeta} from '@book.dev/sdk';
import {DataProvider} from '../../data/DataProvider';
import {NavigationProvider} from '../../providers/NavigationProvider';
import DocumentArea from '../DocumentArea';

vi.mock('@/screens', () => ({
  ConnectedPageDocument: ({pageId}: {pageId: string}) => <div>Page {pageId}</div>,
  HomeScreen: () => <div>Home screen</div>,
  TrashScreen: () => <div>Trash screen</div>,
}));

const mockLibrary = vi.hoisted(() => ({
  id: 'remote',
  icon: '🌐',
  name: 'Team Library',
  serverUrl: 'https://library-team.book.cloud' as string | undefined,
}));

vi.mock('@/providers/LibraryProvider', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/providers/LibraryProvider')>();
  return {
    ...original,
    useLibrary: () => ({
      library: mockLibrary,
    }),
  };
});

const clientWithLoads = (loads: Array<PageMeta[] | Error>) => {
  const listPages = vi.fn(async () => {
    const result = loads.shift() ?? [];
    if (result instanceof Error) throw result;
    return result;
  });
  const client = {
    listPages,
    getPage: async () => null,
    subscribePages: () => () => undefined,
  } as unknown as DataClient;
  return {client, listPages};
};

const mount = (client: DataClient) => render(
  <DataProvider client={client}>
    <NavigationProvider>
      <DocumentArea />
    </NavigationProvider>
  </DataProvider>,
);

describe('DocumentArea initial library load', () => {
  beforeEach(() => {
    mockLibrary.serverUrl = 'https://library-team.book.cloud';
    localStorage.clear();
    sessionStorage.clear();
    window.history.replaceState(null, '', '/');
  });
  afterEach(cleanup);

  it('renders an unreachable panel with the library name and host', async () => {
    const {client} = clientWithLoads([new TypeError('Failed to fetch')]);
    mount(client);

    expect(await screen.findByRole('heading', {name: 'Can\'t reach this library'})).toBeTruthy();
    expect(screen.getByText('The device that publishes this library may be offline or unreachable.')).toBeTruthy();
    expect(screen.getByText('Team Library · library-team.book.cloud')).toBeTruthy();
  });

  it('renders local-service copy for a serverUrl-less library', async () => {
    mockLibrary.serverUrl = undefined;
    const {client} = clientWithLoads([new TypeError('Failed to fetch')]);
    mount(client);

    expect(await screen.findByText('This library\'s local service isn\'t responding.')).toBeTruthy();
  });

  it('maps a relay 502 to site-offline copy and Retry re-runs the initial load', async () => {
    const {client, listPages} = clientWithLoads([
      new Error('OpenBook request failed (502 Bad Gateway): site offline'),
      [],
    ]);
    mount(client);

    expect(await screen.findByText('The device that publishes this library is offline right now.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', {name: 'Retry'}));

    await waitFor(() => expect(listPages).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('Home screen')).toBeTruthy();
  });

  it('leaves the normal initial-load path unchanged', async () => {
    const page = {id: 'page-1', name: 'Welcome'} as PageMeta;
    const {client} = clientWithLoads([[page]]);
    mount(client);

    expect(await screen.findByText('Page page-1')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
