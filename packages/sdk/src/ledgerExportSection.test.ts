import {describe, expect, it} from 'vitest';
import {gatherLedgerExportSection} from './ledgerExportSection';
import type {DataClient} from './client';

/**
 * LX-2 — the capture's fail-closed edges, driven through a stub client (the
 * golden-path and principal-bound authz runs live in the server package, where
 * a real store exists: `packages/server/src/ledgerExportSection.test.ts`).
 */

/** A minimal seeded world the stub answers from. */
const IDS = {accounts: 'db-a', transactions: 'db-t', postings: 'db-p', reconciliations: 'db-r'};

function stubClient(overrides: Partial<Record<keyof DataClient, unknown>> = {}): DataClient {
  const page = (id: string, databaseId: string | null = null) => ({
    id, name: id, data: {editorjs: {blocks: []}, values: [], names: []}, hostedDatabaseId: null,
    databaseId, parentId: null, properties: {}, deletedAt: null, createdAt: '', updatedAt: '',
  });
  const base = {
    ledgerInfo: async () => ({exists: true, hostPageId: 'host-root', databases: IDS}),
    getPage: async (id: string) => page(id, id.startsWith('row-') ? `db-${id.split('-')[1]}` : null),
    getDatabase: async (id: string) => ({id, pageId: `host-${id}`, name: id, schema: {properties: [], views: []}, createdAt: '', updatedAt: ''}),
    listRows: async (dbId: string) => (dbId === IDS.accounts ? [{id: 'row-a-1', name: 'Assets:Cash', properties: {}, exports: {}, parentId: null, createdAt: '', updatedAt: ''}] : []),
    ledgerListAccounts: async () => [{id: 'row-a-1'}],
    ledgerListTransactions: async () => [],
    ledgerListReconciliations: async () => [],
    ledgerListPeriods: async () => [],
    ledgerListAudit: async () => [],
  };
  return {...base, ...overrides} as unknown as DataClient;
}

describe('gatherLedgerExportSection — fail-closed edges', () => {
  it('captures a complete section from a consistent world', async () => {
    const section = await gatherLedgerExportSection(stubClient());
    expect(section).not.toBeNull();
    expect(section!.library.databases).toHaveLength(4);
    expect(section!.library.pages.filter((p) => p.databaseId === IDS.accounts)).toHaveLength(1);
    expect(section!.auditHead).toBeNull(); // empty audit stream ⇒ no anchor, still a valid section
  });

  it('existence-hiding body (guest posture) ⇒ null, never an error', async () => {
    const client = stubClient({ledgerInfo: async () => ({exists: false, hostPageId: null, databases: null})});
    expect(await gatherLedgerExportSection(client)).toBeNull();
  });

  it('a mid-capture read failure (revocation / transport) ⇒ null, never half a book', async () => {
    const client = stubClient({
      getPage: async (id: string) => {
        if (id === 'row-a-1') throw new Error('403 mid-flight');
        return {id, name: id, data: {editorjs: {blocks: []}, values: [], names: []}, hostedDatabaseId: null, databaseId: null, parentId: null, properties: {}, deletedAt: null, createdAt: '', updatedAt: ''};
      },
    });
    expect(await gatherLedgerExportSection(client)).toBeNull();
  });

  it('read-FILTERED rows (host grant without row reads) trip the count parity ⇒ null', async () => {
    // listRows silently returns nothing while the typed read still sees the
    // account: the completeness tripwire must refuse the row-less "book".
    const client = stubClient({listRows: async () => []});
    expect(await gatherLedgerExportSection(client)).toBeNull();
  });

  it('a book AT the transaction cap fails CLOSED — even with a partial row grant (Sasha #1)', async () => {
    // The typed read returns exactly the cap: completeness of the tx/posting
    // parity can no longer be proven, and the generic row read is FILTERED
    // (999 of >=1000 row pages readable). Without the cap guard this would
    // ship a complete chart of accounts + a silently partial journal.
    const atCap = Array.from({length: 1000}, (_, i) => ({id: `tx-${i}`, postings: []}));
    const rows = (n: number, dbId: string) =>
      Array.from({length: n}, (_, i) => ({id: `row-${dbId}-${i}`, name: '', properties: {}, exports: {}, parentId: null, createdAt: '', updatedAt: ''}));
    const client = stubClient({
      ledgerListTransactions: async () => atCap,
      listRows: async (dbId: string) => {
        if (dbId === IDS.accounts) return rows(1, 'a');
        if (dbId === IDS.transactions) return rows(999, 't'); // partial grant
        return [];
      },
      ledgerListAccounts: async () => [{id: 'row-a-0'}],
    });
    expect(await gatherLedgerExportSection(client)).toBeNull();
  });

  it('at the cap, even EXACT row parity fails closed (completeness is unprovable)', async () => {
    const atCap = Array.from({length: 1000}, (_, i) => ({id: `tx-${i}`, postings: []}));
    const rows = (n: number, dbId: string) =>
      Array.from({length: n}, (_, i) => ({id: `row-${dbId}-${i}`, name: '', properties: {}, exports: {}, parentId: null, createdAt: '', updatedAt: ''}));
    const client = stubClient({
      ledgerListTransactions: async () => atCap,
      listRows: async (dbId: string) => {
        if (dbId === IDS.accounts) return rows(1, 'a');
        if (dbId === IDS.transactions) return rows(1000, 't'); // parity holds, but the cap hides any excess
        return [];
      },
      ledgerListAccounts: async () => [{id: 'row-a-0'}],
    });
    expect(await gatherLedgerExportSection(client)).toBeNull();
  });

  it('strictly under the cap, matching parity still captures (the guard is at-cap only)', async () => {
    const under = Array.from({length: 3}, (_, i) => ({id: `tx-${i}`, postings: []}));
    const rows = (n: number, dbId: string) =>
      Array.from({length: n}, (_, i) => ({id: `row-${dbId}-${i}`, name: '', properties: {}, exports: {}, parentId: null, createdAt: '', updatedAt: ''}));
    const client = stubClient({
      ledgerListTransactions: async () => under,
      listRows: async (dbId: string) => {
        if (dbId === IDS.accounts) return rows(1, 'a');
        if (dbId === IDS.transactions) return rows(3, 't');
        return [];
      },
      ledgerListAccounts: async () => [{id: 'row-a-0'}],
    });
    const section = await gatherLedgerExportSection(client);
    expect(section).not.toBeNull();
    expect(section!.library.pages.filter((p) => p.databaseId === IDS.transactions)).toHaveLength(3);
  });
});
