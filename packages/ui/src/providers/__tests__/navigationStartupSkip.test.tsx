import React from 'react';
import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import {render, cleanup, waitFor} from '@testing-library/react';
import type {DataClient} from '@book.dev/sdk';
import type {PageMeta} from '@book.dev/sdk';
import {DataProvider} from '../../data/DataProvider';
import {NavigationProvider, useNavigation} from '../NavigationProvider';
import {markPageCrashed} from '../../lib/crashRecovery';
import {pageLinks} from '../../lib/pageLinks';

const LAST_PAGE_KEY = 'openbook.currentPageId';

// A minimal client stub covering only what NavigationProvider touches at mount:
// list the pages, subscribe to the live list, and probe unknown ids.
type PageFixture = {id: string; name: string; listed?: boolean};

const makeClient = (pages: PageFixture[]): DataClient =>
  ({
    listPages: async () => pages as unknown as PageMeta[],
    getPage: async (id: string) => (pages.some((p) => p.id === id) ? ({id} as never) : null),
    subscribePages: () => () => undefined,
  }) as unknown as DataClient;

const Probe: React.FC<{onReady: (id: string | null) => void}> = ({onReady}) => {
  const {primaryPageId} = useNavigation();
  if (primaryPageId) onReady(primaryPageId);
  return null;
};

const mount = (pages: PageFixture[]) => {
  let resolved: string | null = null;
  render(
    <DataProvider client={makeClient(pages)}>
      <NavigationProvider>
        <Probe onReady={(id) => (resolved = id)} />
      </NavigationProvider>
    </DataProvider>,
  );
  return () => resolved;
};

const DiscoveryProbe: React.FC<{onReady: (pageIds: string[]) => void}> = ({onReady}) => {
  const {pages} = useNavigation();
  onReady(pages.map((page) => page.id));
  return null;
};

describe('NavigationProvider startup crash-skip', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    window.history.replaceState(null, '', '/'); // no ?page= in the URL
  });
  afterEach(cleanup);

  it('re-opens the last page normally when it has not crashed', async () => {
    localStorage.setItem(LAST_PAGE_KEY, 'good');
    const get = mount([
      {id: 'good', name: 'Good'},
      {id: 'other', name: 'Other'},
    ]);
    await waitFor(() => expect(get()).toBe('good'));
  });

  it('skips a quarantined last page and lands on the first healthy page', async () => {
    localStorage.setItem(LAST_PAGE_KEY, 'poison');
    markPageCrashed('poison'); // it blew up on the previous load
    const get = mount([
      {id: 'poison', name: 'Poison'},
      {id: 'good', name: 'Good'},
    ]);
    await waitFor(() => expect(get()).toBe('good'));
  });

  it('lands on Home when every page (including the first) is quarantined', async () => {
    localStorage.setItem(LAST_PAGE_KEY, 'poison');
    markPageCrashed('poison');
    markPageCrashed('good');
    const get = mount([
      {id: 'poison', name: 'Poison'},
      {id: 'good', name: 'Good'},
    ]);
    await waitFor(() => expect(get()).toBe('home'));
  });

  it('keeps listed:false pages in owner palette input and @-mention search without assuming they exist', async () => {
    let pageIds: string[] = [];
    render(
      <DataProvider client={makeClient([
        {id: 'visible', name: 'Visible', listed: true},
        {id: 'hidden', name: 'Hidden planning', listed: false},
      ])}>
        <NavigationProvider>
          <DiscoveryProbe onReady={(value) => (pageIds = value)} />
        </NavigationProvider>
      </DataProvider>,
    );

    await waitFor(() => expect(pageIds).toContain('hidden'));
    await waitFor(() => expect(pageLinks.searchPages('Hidden').map((page) => page.id)).toEqual(['hidden']));
    expect(pageIds).not.toContain('visitor-filtered-page');
    expect(pageLinks.searchPages('visitor-filtered-page')).toEqual([]);
  });
});
