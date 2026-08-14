import React from 'react';
import {act, cleanup, render, waitFor} from '@testing-library/react';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {DataClient, PageSnapshot} from '@book.dev/sdk';
import type * as Y from 'yjs';
import type {ConnectSaverOptions} from '@/blockeditor/saver';
import {blockText, createDoc, findBlock} from '@/blockeditor/model';
import {projectBlockPageSnapshot} from '@/blockeditor/saveProjection';
import {pageSaveStatus} from '@/lib/pageSaveStatus';

let loadedDoc: Y.Doc | null = null;
let saverOptions: ConnectSaverOptions | null = null;
let client: DataClient;

vi.mock('@/data', () => ({useData: () => client}));

vi.mock('@/providers', () => ({
  useConfirm: () => vi.fn(),
  useNavigation: () => ({blockAnchor: null, clearBlockAnchor: vi.fn(), primaryPageId: null}),
  usePreferences: () => ({
    preferences: {
      general: {spellcheck: true},
      profile: {displayName: 'Test Writer', name: 'Test Writer'},
    },
  }),
  useTheme: () => ({appearance: {dataColors: []}}),
  useTranslation: () => ({t: (key: string) => key}),
}));

vi.mock('@/lib/useCanWrite', () => ({useCanWrite: () => true}));

vi.mock('@/blockeditor/BlockEditor', () => ({
  BlockEditor: ({doc}: {doc: Y.Doc}) => {
    loadedDoc = doc;
    return <div data-testid="block-editor" />;
  },
}));

vi.mock('@/blockeditor/saver', () => ({
  connectPageSaver: (_doc: Y.Doc, _awareness: unknown, options: ConnectSaverOptions) => {
    saverOptions = options;
    return {disconnect: vi.fn(), isSaver: () => true};
  },
}));

vi.mock('@/blockeditor/provider', () => ({
  connectBroadcast: () => ({disconnect: vi.fn()}),
}));

vi.mock('@/blockeditor/relay', () => ({
  connectPageRelay: () => ({disconnect: vi.fn()}),
}));

vi.mock('@/blockeditor/awareness', () => ({
  blockSelection: vi.fn(),
  connectPageAwareness: () => ({awareness: {}, disconnect: vi.fn(), setSelection: vi.fn()}),
}));

vi.mock('@/lib/openAwareness', () => ({
  openAwareness: () => null,
  registerOpenAwareness: () => vi.fn(),
  subscribeOpenAwareness: () => vi.fn(),
}));

vi.mock('@/blockeditor/reactiveBlocks', () => ({registerReactiveBlocks: vi.fn()}));
vi.mock('@/blockeditor/kit', () => ({registerArtifactKit: vi.fn()}));
vi.mock('@/components/database/InlineDatabaseBlock', () => ({registerDatabaseBlock: vi.fn()}));
vi.mock('@/components/database/DatabaseFormBlock', () => ({registerDatabaseFormBlock: vi.fn()}));

vi.mock('@/blockeditor/FormBlockView', async () => {
  const {createContext} = await import('react');
  return {
    FormOriginContext: createContext<string | undefined>(undefined),
    formOriginUrl: () => undefined,
    registerFormBlock: vi.fn(),
  };
});

vi.mock('@/components/PageContextMenu', () => ({
  PageContextMenu: ({children}: {children: React.ReactNode}) => children,
}));
vi.mock('@/components/ExportBooksDialog', () => ({ExportBooksDialog: () => null}));
vi.mock('@/components/PageProperties', () => ({PageProperties: () => null}));
vi.mock('@/components/PageHeaderControls', () => ({PageHeaderControls: () => null}));
vi.mock('@/components/PageCover', () => ({PageCoverBanner: () => null}));
vi.mock('@/components/presence/PresenceAvatars', () => ({PresenceAvatars: () => null}));
vi.mock('@/components/presence/RemoteCursors', () => ({RemoteCursors: () => null}));
vi.mock('@/components/review/SuggestHost', () => ({SuggestHost: () => null}));
vi.mock('@/components/review/BlockReviewMarkers', () => ({BlockReviewMarkers: () => null}));
vi.mock('@/screens/pageChrome', () => ({PageHeader: () => null}));

vi.mock('@/components/appearance/PageCustomiseBody', () => ({
  usePageHasBackground: () => false,
  usePageThemeStyle: () => undefined,
}));
vi.mock('@/lib/pageFullWidth', () => ({usePageFullWidth: () => false}));
vi.mock('@/lib/pageFont', () => ({pageFontStyle: () => undefined, usePageFonts: () => undefined}));
vi.mock('@/plugins', () => ({pageHasPluginManifest: () => false}));
vi.mock('@/lib/pageDocActions', () => ({registerPageDocActions: () => vi.fn()}));
vi.mock('@/lib/openDocs', () => ({registerOpenDoc: () => vi.fn()}));
vi.mock('@/lib/aiBridge', () => ({registerBlockEditorDoc: () => vi.fn()}));

import BlockPageDocument from '../BlockPageDocument';

const emptySnapshot = (): PageSnapshot => ({editorjs: {blocks: []}, values: [], names: []});

async function snapshotWithParagraph(text = ''): Promise<PageSnapshot> {
  return projectBlockPageSnapshot(
    createDoc([{id: 'p', type: 'paragraph', text}]),
    emptySnapshot(),
  );
}

async function renderDocument(pageId: string, initial: PageSnapshot, onSave: (snapshot: PageSnapshot) => Promise<void>): Promise<void> {
  render(
    <BlockPageDocument
      pageId={pageId}
      onLoad={() => Promise.resolve(initial)}
      onSave={onSave}
    />,
  );
  await waitFor(() => {
    expect(loadedDoc).not.toBeNull();
    expect(saverOptions).not.toBeNull();
  });
}

beforeEach(() => {
  loadedDoc = null;
  saverOptions = null;
  client = {
    getInstanceInfo: vi.fn().mockResolvedValue({
      guestAccess: 'write',
      ownerSubject: null,
      you: {name: 'Test Writer', subject: 'test-writer', verifiedVia: 'local'},
      youRole: 'owner',
    }),
  } as unknown as DataClient;
});

afterEach(() => cleanup());

describe('BlockPageDocument save checkpoint', () => {
  it('re-sends a rejected snapshot and reports Saved only after the retry persists', async () => {
    const initial = await snapshotWithParagraph();
    const failure = new Error('transient save failure');
    let resolveRetry!: () => void;
    const onSave = vi
      .fn<(snapshot: PageSnapshot) => Promise<void>>()
      .mockRejectedValueOnce(failure)
      .mockImplementationOnce(() => new Promise<void>((resolve) => {
        resolveRetry = resolve;
      }));
    await renderDocument('retry-page', initial, onSave);

    act(() => {
      const text = blockText(findBlock(loadedDoc!, 'p')!.block)!;
      loadedDoc!.transact(() => text.insert(text.length, 'x'), 'local');
    });

    let rejected: unknown;
    await act(async () => {
      try {
        await Promise.resolve(saverOptions!.save());
      } catch (error) {
        rejected = error;
      }
    });
    expect(rejected).toBe(failure);
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(pageSaveStatus('retry-page')).toBe('save failed');

    let retry!: Promise<void>;
    act(() => {
      retry = Promise.resolve(saverOptions!.save());
    });
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
    expect(onSave.mock.calls[1][0]).toEqual(onSave.mock.calls[0][0]);
    expect(pageSaveStatus('retry-page')).toBe('saving');

    await act(async () => {
      resolveRetry();
      await retry;
    });
    expect(pageSaveStatus('retry-page')).toBe('saved');
  });

  it('keeps the genuine identical-snapshot no-op skip', async () => {
    const initial = await snapshotWithParagraph('unchanged');
    const onSave = vi.fn<(snapshot: PageSnapshot) => Promise<void>>().mockResolvedValue(undefined);
    await renderDocument('no-op-page', initial, onSave);

    await act(async () => {
      await Promise.resolve(saverOptions!.save());
    });

    expect(onSave).not.toHaveBeenCalled();
    expect(pageSaveStatus('no-op-page')).toBe('saved');
  });
});
