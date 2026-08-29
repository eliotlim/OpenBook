import {describe, it, expect, vi, beforeEach} from 'vitest';
import type {AgentEditsMode, AgentEditsPolicy, PageInput, StoredPage, StoredSuggestion} from '@book.dev/sdk';
import {applyProposal, applyProposalToDoc, registerBlockEditorDoc, routeAiSuggestions, suggestionToProposal, type ApplyClient, type PolicyClient} from '../aiBridge';
import {blockChildren, blockText, blockType, createDoc, encodeSnapshot, findBlock, decodeSnapshot, rootBlocks} from '@/blockeditor/model';
import type {AgentProposal} from '@book.dev/sdk';

/**
 * AGED-4: the built-in AI's writes honor the resolved agent-edits policy, enforced
 * CLIENT-SIDE (the AI runs under the user's own identity — the server can't tell
 * its write from a human's). `routeAiSuggestions` resolves each suggestion's page
 * policy against the instance mode (AGED-1 `resolveAgentEdits`) and either applies
 * it directly through the editor bridge (deleting the shadow review row) or leaves
 * it for review.
 */

/** A minimal StoredSuggestion carrying an `update_block` payload for `pageId`. */
function makeSuggestion(id: string, pageId: string, blockId: string, text: string): StoredSuggestion {
  return {
    id,
    pageId,
    authorKind: 'ai',
    authorName: 'Assistant',
    kind: 'replace-text',
    target: {blockId},
    before: '',
    after: text,
    status: 'open',
    payload: {applyKind: 'update_block', pageId, blockId, text, summary: `edit ${blockId}`},
    createdAt: '',
    updatedAt: '',
  };
}

/**
 * A fake data client wired to a single stored page. Records the calls the policy
 * router makes (getPageAgentEdits per page, deleteSuggestion, savePage) so tests
 * can assert routing without a real server.
 */
function makeClient(opts: {
  instance?: AgentEditsMode;
  pagePolicy: (pageId: string) => AgentEditsPolicy;
  storedPage?: StoredPage;
  /** When set, `deleteSuggestion` rejects — exercises the best-effort cleanup fallback. */
  deleteThrows?: boolean;
}): ApplyClient & PolicyClient & {saved: PageInput[]; deleted: string[]; updated: Array<{id: string; status?: string}>} {
  const saved: PageInput[] = [];
  const deleted: string[] = [];
  const updated: Array<{id: string; status?: string}> = [];
  return {
    saved,
    deleted,
    updated,
    getInstanceInfo: vi.fn(async () => ({agentEdits: opts.instance}) as never),
    getPageAgentEdits: vi.fn(async (pageId: string) => opts.pagePolicy(pageId)),
    deleteSuggestion: vi.fn(async (id: string) => {
      if (opts.deleteThrows) throw new Error('delete failed');
      deleted.push(id);
      return true;
    }),
    updateSuggestion: vi.fn(async (id: string, patch: {status?: string}) => {
      updated.push({id, status: patch.status});
      return {} as never;
    }),
    updateRow: vi.fn(async () => ({}) as never),
    createDatabase: vi.fn(async () => ({}) as never),
    updateDatabase: vi.fn(async () => ({}) as never),
    deletePage: vi.fn(async () => true),
    getPage: vi.fn(async () => opts.storedPage ?? null),
    savePage: vi.fn(async (input: PageInput) => {
      saved.push(input);
      return {...(opts.storedPage as StoredPage), ...input} as StoredPage;
    }),
  };
}

describe('database suggestions: accept replays the recorded operation payload', () => {
  const suggestion = (applyKind: string, payload: Record<string, unknown>): StoredSuggestion => ({
    id: `s-${applyKind}`, pageId: 'host', authorKind: 'ai', authorName: 'Assistant', kind: 'database-op',
    target: {}, before: '', after: '', status: 'open', payload: {applyKind, ...payload}, createdAt: '', updatedAt: '',
  });

  it.each([
    ['create_database', 'createDatabase', {pageId: 'host', title: 'Tasks', schema: {properties: [], views: []}}, [{pageId: 'host', name: 'Tasks', schema: {properties: [], views: []}}]],
    ['update_database', 'updateDatabase', {databaseId: 'db', patch: {name: 'Renamed'}}, ['db', {name: 'Renamed'}]],
    ['create_property', 'updateDatabase', {databaseId: 'db', patch: {schema: {properties: [{id: 'p1'}]}}}, ['db', {schema: {properties: [{id: 'p1'}]}}]],
    ['update_property', 'updateDatabase', {databaseId: 'db', patch: {schema: {properties: [{id: 'p1', name: 'New'}]}}}, ['db', {schema: {properties: [{id: 'p1', name: 'New'}]}}]],
    ['update_row', 'updateRow', {databaseId: 'db', rowId: 'row', patch: {name: 'Done', properties: {p1: 3}}}, ['db', 'row', {name: 'Done', properties: {p1: 3}}]],
    ['delete_row', 'deletePage', {databaseId: 'db', rowId: 'row'}, ['row']],
  ] as const)('%s calls %s with the recorded payload', async (kind, method, payload, expectedArgs) => {
    const client = makeClient({pagePolicy: () => 'inherit'});
    await applyProposal(client, suggestionToProposal(suggestion(kind, payload)));
    expect(client[method]).toHaveBeenCalledWith(...expectedArgs);
  });
});

describe('AGED-4 routeAiSuggestions: resolved-direct applies immediately', () => {
  it('OPEN editor → mutates the live doc and deletes the review row (no suggestion kept)', async () => {
    const doc = createDoc([{id: 'b1', type: 'paragraph', text: 'old'}]);
    const unregister = registerBlockEditorDoc('p1', doc);
    try {
      const client = makeClient({instance: 'direct', pagePolicy: () => 'inherit'});
      const routing = await routeAiSuggestions(client, [makeSuggestion('s1', 'p1', 'b1', 'new text')]);

      expect(routing.applied).toBe(1);
      expect(routing.suggested).toHaveLength(0);
      expect(routing.failed).toHaveLength(0);
      // The live doc actually changed…
      expect(blockText(findBlock(doc, 'b1')!.block)!.toString()).toBe('new text');
      // …and the shadow suggestion row the server persisted was removed.
      expect(client.deleted).toEqual(['s1']);
      // No stored-page fallback when a live editor is present.
      expect(client.savePage).not.toHaveBeenCalled();
    } finally {
      unregister();
    }
  });

  it('CLOSED page (no live editor) → applyToStoredPage persists via savePage, deletes the row', async () => {
    const stored = createDoc([{id: 'b1', type: 'paragraph', text: 'old'}]);
    const page: StoredPage = {
      id: 'p2',
      name: 'Page 2',
      data: {editorjs: null, values: [], names: [], editor: 'blocks', blockdoc: encodeSnapshot(stored)},
      hostedDatabaseId: null,
      databaseId: null,
      parentId: null,
      properties: {},
      deletedAt: null,
      createdAt: '',
      updatedAt: '',
    };
    const client = makeClient({instance: 'direct', pagePolicy: () => 'inherit', storedPage: page});
    const routing = await routeAiSuggestions(client, [makeSuggestion('s2', 'p2', 'b1', 'saved text')]);

    expect(routing.applied).toBe(1);
    expect(client.savePage).toHaveBeenCalledTimes(1);
    // The saved snapshot carries the applied edit.
    const savedDoc = decodeSnapshot(client.saved[0].data.blockdoc as never);
    expect(blockText(findBlock(savedDoc, 'b1')!.block)!.toString()).toBe('saved text');
    expect(client.deleted).toEqual(['s2']);
  });

  it('apply succeeds but deleteSuggestion rejects → still counts applied, falls back to accepted (row never re-surfaces)', async () => {
    const doc = createDoc([{id: 'b1', type: 'paragraph', text: 'old'}]);
    const unregister = registerBlockEditorDoc('p8', doc);
    try {
      const client = makeClient({instance: 'direct', pagePolicy: () => 'inherit', deleteThrows: true});
      const routing = await routeAiSuggestions(client, [makeSuggestion('s8', 'p8', 'b1', 'landed')]);

      // The edit landed, so it's reported applied — NOT failed — even though the
      // row cleanup delete threw.
      expect(routing.applied).toBe(1);
      expect(routing.failed).toHaveLength(0);
      expect(blockText(findBlock(doc, 'b1')!.block)!.toString()).toBe('landed');
      // Delete threw (nothing recorded), and the fallback marked the row accepted
      // so it can never re-surface as an open, re-acceptable card.
      expect(client.deleted).toHaveLength(0);
      expect(client.updated).toEqual([{id: 's8', status: 'accepted'}]);
    } finally {
      unregister();
    }
  });
});

describe('AGED-4 routeAiSuggestions: resolved-suggest leaves the suggestion for review', () => {
  it('does not apply and does not delete — the review row survives unchanged', async () => {
    const doc = createDoc([{id: 'b1', type: 'paragraph', text: 'old'}]);
    const unregister = registerBlockEditorDoc('p3', doc);
    try {
      const client = makeClient({instance: 'suggest', pagePolicy: () => 'inherit'});
      const s = makeSuggestion('s3', 'p3', 'b1', 'should not apply');
      const routing = await routeAiSuggestions(client, [s]);

      expect(routing.applied).toBe(0);
      expect(routing.suggested).toEqual([s]);
      expect(blockText(findBlock(doc, 'b1')!.block)!.toString()).toBe('old'); // untouched
      expect(client.deleted).toHaveLength(0);
    } finally {
      unregister();
    }
  });

  it('defaults to suggest when neither instance mode nor page policy is set', async () => {
    const doc = createDoc([{id: 'b1', type: 'paragraph', text: 'old'}]);
    const unregister = registerBlockEditorDoc('p4', doc);
    try {
      const client = makeClient({instance: undefined, pagePolicy: () => 'inherit'});
      const routing = await routeAiSuggestions(client, [makeSuggestion('s4', 'p4', 'b1', 'x')]);
      expect(routing.applied).toBe(0);
      expect(routing.suggested).toHaveLength(1);
    } finally {
      unregister();
    }
  });
});

describe('AGED-4 routeAiSuggestions: the page override beats the instance mode both directions', () => {
  it('page=direct on instance=suggest → applies', async () => {
    const doc = createDoc([{id: 'b1', type: 'paragraph', text: 'old'}]);
    const unregister = registerBlockEditorDoc('p5', doc);
    try {
      const client = makeClient({instance: 'suggest', pagePolicy: () => 'direct'});
      const routing = await routeAiSuggestions(client, [makeSuggestion('s5', 'p5', 'b1', 'applied')]);
      expect(routing.applied).toBe(1);
      expect(blockText(findBlock(doc, 'b1')!.block)!.toString()).toBe('applied');
      expect(client.deleted).toEqual(['s5']);
    } finally {
      unregister();
    }
  });

  it('page=suggest on instance=direct → suggests (override bites immediately)', async () => {
    const doc = createDoc([{id: 'b1', type: 'paragraph', text: 'old'}]);
    const unregister = registerBlockEditorDoc('p6', doc);
    try {
      const client = makeClient({instance: 'direct', pagePolicy: () => 'suggest'});
      const s = makeSuggestion('s6', 'p6', 'b1', 'held');
      const routing = await routeAiSuggestions(client, [s]);
      expect(routing.applied).toBe(0);
      expect(routing.suggested).toEqual([s]);
      expect(blockText(findBlock(doc, 'b1')!.block)!.toString()).toBe('old');
      expect(client.deleted).toHaveLength(0);
    } finally {
      unregister();
    }
  });

  it('reads the page policy at apply time (per-suggestion), so a page override is never cached', async () => {
    const doc1 = createDoc([{id: 'b1', type: 'paragraph', text: 'a'}]);
    const doc2 = createDoc([{id: 'b1', type: 'paragraph', text: 'b'}]);
    const u1 = registerBlockEditorDoc('pa', doc1);
    const u2 = registerBlockEditorDoc('pb', doc2);
    try {
      // Same instance mode, divergent per-page overrides in one batch.
      const client = makeClient({
        instance: 'suggest',
        pagePolicy: (pageId) => (pageId === 'pa' ? 'direct' : 'suggest'),
      });
      const routing = await routeAiSuggestions(client, [
        makeSuggestion('sa', 'pa', 'b1', 'A!'),
        makeSuggestion('sb', 'pb', 'b1', 'B!'),
      ]);
      expect(routing.applied).toBe(1);
      expect(routing.suggested.map((s) => s.id)).toEqual(['sb']);
      expect(blockText(findBlock(doc1, 'b1')!.block)!.toString()).toBe('A!'); // direct page applied
      expect(blockText(findBlock(doc2, 'b1')!.block)!.toString()).toBe('b'); // suggest page untouched
      expect(client.getPageAgentEdits).toHaveBeenCalledTimes(2); // read per suggestion
    } finally {
      u1();
      u2();
    }
  });
});

describe('AGED-4 routeAiSuggestions: instance mode is read once per batch', () => {
  beforeEach(() => vi.clearAllMocks());
  it('resolves the whole batch against a single getInstanceInfo call', async () => {
    const doc = createDoc([{id: 'b1', type: 'paragraph', text: 'old'}]);
    const unregister = registerBlockEditorDoc('p7', doc);
    try {
      const client = makeClient({instance: 'direct', pagePolicy: () => 'inherit'});
      await routeAiSuggestions(client, [
        makeSuggestion('s7a', 'p7', 'b1', 'one'),
        makeSuggestion('s7b', 'p7', 'b1', 'two'),
      ]);
      expect(client.getInstanceInfo).toHaveBeenCalledTimes(1);
    } finally {
      unregister();
    }
  });
});

describe('applyProposalToDoc delete_block (should-fix 4.1/4.2): table last-row rule + self-heal', () => {
  const del = (blockId: string): AgentProposal => ({
    id: `d-${blockId}`,
    kind: 'delete_block',
    summary: `delete ${blockId}`,
    pageId: 'p',
    before: '',
    after: '',
    payload: {pageId: 'p', blockId},
  });

  const rootTypes = (doc: ReturnType<typeof createDoc>): string[] => {
    const root = rootBlocks(doc);
    const out: string[] = [];
    for (let i = 0; i < root.length; i += 1) out.push(blockType(root.get(i)));
    return out;
  };

  it('deleting the last row of a KEYED table removes the whole table (sibling survives)', () => {
    const doc = createDoc([
      {
        id: 'kt', type: 'table', props: {'col:c1': 'a0'},
        children: [{id: 'kr', type: 'row', props: {ord: 'a0'}, children: [{id: 'kc', type: 'cell', text: 'A', props: {col: 'c1'}}]}],
      },
      {id: 'p1', type: 'paragraph', text: 'after'},
    ]);
    applyProposalToDoc(doc, del('kr'));
    expect(rootTypes(doc)).toEqual(['paragraph']);
    expect(blockText(rootBlocks(doc).get(0))?.toString()).toBe('after');
  });

  it('deleting the last row of a LEGACY table removes the table; the doc self-heals to a paragraph', () => {
    const doc = createDoc([
      {id: 'lt', type: 'table', children: [{id: 'lr', type: 'row', children: [{id: 'lc', type: 'cell', text: 'X'}]}]},
    ]);
    applyProposalToDoc(doc, del('lr'));
    // Table gone AND the document never renders zero-root (ensureNotEmpty).
    expect(rootTypes(doc)).toEqual(['paragraph']);
  });

  it('deleting the only cell of the only row removes the whole table', () => {
    const doc = createDoc([
      {id: 'ct', type: 'table', children: [{id: 'cr', type: 'row', children: [{id: 'cc', type: 'cell', text: 'solo'}]}]},
      {id: 'kp', type: 'paragraph', text: 'keep'},
    ]);
    applyProposalToDoc(doc, del('cc'));
    expect(rootTypes(doc)).toEqual(['paragraph']);
    expect(blockText(rootBlocks(doc).get(0))?.toString()).toBe('keep');
  });

  it('a NON-final row is an ordinary delete (the table stays)', () => {
    const doc = createDoc([
      {
        id: 't', type: 'table',
        children: [
          {id: 'r1', type: 'row', children: [{id: 'a', type: 'cell', text: '1'}]},
          {id: 'r2', type: 'row', children: [{id: 'b', type: 'cell', text: '2'}]},
        ],
      },
    ]);
    applyProposalToDoc(doc, del('r1'));
    const table = findBlock(doc, 't');
    expect(table).not.toBeNull();
    expect(blockChildren(table!.block)?.length).toBe(1);
  });

  it('deleting the only block in a column prunes the empty column and unwraps the layout', () => {
    const doc = createDoc([
      {
        id: 'cols', type: 'columns',
        children: [
          {id: 'col1', type: 'column', props: {span: 6}, children: [{id: 'left', type: 'paragraph', text: 'left'}]},
          {id: 'col2', type: 'column', props: {span: 6}, children: [{id: 'right', type: 'paragraph', text: 'right'}]},
        ],
      },
    ]);
    applyProposalToDoc(doc, del('left'));
    // The emptied column is pruned; the single-column layout is unwrapped to the root.
    expect(rootTypes(doc)).toEqual(['paragraph']);
    expect(blockText(rootBlocks(doc).get(0))?.toString()).toBe('right');
  });

  it('deleting a page\'s only block self-heals to one paragraph (never a zero-root doc)', () => {
    const doc = createDoc([{id: 'solo', type: 'paragraph', text: 'lonely'}]);
    applyProposalToDoc(doc, del('solo'));
    expect(rootBlocks(doc).length).toBe(1);
    expect(blockType(rootBlocks(doc).get(0))).toBe('paragraph');
  });
});
