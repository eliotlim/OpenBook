import {describe, it, expect, afterEach} from 'vitest';
import {render, screen, cleanup} from '@testing-library/react';
import type {DataClient, StoredEdit} from '@book.dev/sdk';
import {LastEditedBy} from '../LastEditedBy';
import {DataProvider} from '@/data/DataProvider';
import {I18nProvider} from '@/providers';

const edit = (over: Partial<StoredEdit> = {}): StoredEdit => ({
  id: 'e1',
  pageId: 'p1',
  authorSubject: 'guest:Caryl',
  authorIssuer: '',
  authorName: 'Caryl',
  verifiedVia: 'jws',
  kind: 'page.save',
  assertionKid: null,
  assertionJti: null,
  summary: '',
  createdAt: new Date().toISOString(),
  ...over,
});

const wrap = (client: Partial<DataClient>) =>
  render(
    <I18nProvider>
      <DataProvider client={client as DataClient}>
        <LastEditedBy pageId="p1" />
      </DataProvider>
    </I18nProvider>,
  );

afterEach(() => cleanup());

describe('LastEditedBy', () => {
  it('shows the latest editor from the provenance log', async () => {
    const client: Partial<DataClient> = {
      listPageEdits: async () => [edit({authorName: 'Caryl'})],
      subscribePage: () => () => {},
    };
    wrap(client);
    expect(await screen.findByText(/Edited by Caryl/)).toBeTruthy();
  });

  it('labels an anonymous guest edit', async () => {
    const client: Partial<DataClient> = {
      listPageEdits: async () => [edit({authorName: '', verifiedVia: 'guest'})],
      subscribePage: () => () => {},
    };
    wrap(client);
    expect(await screen.findByText(/Edited by a guest/)).toBeTruthy();
  });

  it('renders nothing when the server has no edit log', async () => {
    const client: Partial<DataClient> = {
      listPageEdits: async () => {
        throw new Error('404');
      },
      subscribePage: () => () => {},
    };
    const {container} = wrap(client);
    await new Promise((r) => setTimeout(r, 10));
    expect(container.textContent).toBe('');
  });

  it('renders nothing when the page has no recorded edits', async () => {
    const client: Partial<DataClient> = {
      listPageEdits: async () => [],
      subscribePage: () => () => {},
    };
    const {container} = wrap(client);
    await new Promise((r) => setTimeout(r, 10));
    expect(container.textContent).toBe('');
  });
});
