import React from 'react';
import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import {render, cleanup, waitFor} from '@testing-library/react';
import type {DataClient} from '@book.dev/sdk';
import type {PageMeta} from '@book.dev/sdk';
import {DataProvider} from '../../data/DataProvider';
import {NavigationProvider, useNavigation} from '../NavigationProvider';
import {markPageCrashed} from '../../lib/crashRecovery';

const LAST_PAGE_KEY = 'openbook.currentPageId';

// A minimal client stub covering only what NavigationProvider touches at mount:
// list the pages, subscribe to the live list, and probe unknown ids.
const makeClient = (pages: Array<{id: string; name: string}>): DataClient =>
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

const mount = (pages: Array<{id: string; name: string}>) => {
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
});
