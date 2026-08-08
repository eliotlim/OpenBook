import {describe, expect, it} from 'vitest';
import {gatherLedgerExportSection, parseLedgerExportSection, type LedgerExportSection} from './ledgerExportSection';
import type {StoredPage} from './types';
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

// ── LX-4 — parseLedgerExportSection: the deep-validation boundary ─────────────
//
// The replay's parse gate, driven pure: a coherent hand-built book parses to a
// typed replay plan; every doctored invariant refuses TOTALLY (ok: false, a
// named reason) — never a partial book the writer would then trip over.

const row = (id: string, databaseId: string, properties: Record<string, unknown>, name: string | null = null, position = 0): StoredPage => ({
  id,
  name,
  data: {editorjs: {blocks: []}, values: [], names: []},
  hostedDatabaseId: null,
  databaseId,
  parentId: null,
  properties,
  deletedAt: null,
  position,
  createdAt: `2026-01-01T00:00:0${position}.000Z`,
  updatedAt: '2026-01-01T00:00:00.000Z',
});

/** A minimal coherent book: two accounts, one posted entry, one draft. */
function validSection(): LedgerExportSection {
  const db = (id: string, pageId: string) => ({id, pageId, name: id, schema: {properties: [], views: []}, createdAt: '', updatedAt: ''});
  return {
    settings: {
      ledgerDb: {
        hostPageId: 'host-root',
        ...IDS,
        hostPages: {accounts: 'host-a', transactions: 'host-t', postings: 'host-p', reconciliations: 'host-r'},
      },
    },
    library: {
      databases: [db(IDS.accounts, 'host-a'), db(IDS.transactions, 'host-t'), db(IDS.postings, 'host-p'), db(IDS.reconciliations, 'host-r')],
      pages: [
        row('acc-cash', IDS.accounts, {lp_type: 'asset', lp_status: 'open', lp_currency: 'USD'}, 'Assets:Cash'),
        row('acc-sales', IDS.accounts, {lp_type: 'revenue', lp_status: 'open', lp_currency: 'USD'}, 'Revenue:Sales'),
        row('tx-1', IDS.transactions, {lp_date: '2026-01-05', lp_description: 'sale', lp_state: 'posted', lp_entry_no: 1}),
        row('post-1', IDS.postings, {lp_transaction: 'tx-1', lp_account: 'acc-cash', lp_amount_minor: 500, lp_cleared: 'cleared'}, null, 0),
        row('post-2', IDS.postings, {lp_transaction: 'tx-1', lp_account: 'acc-sales', lp_amount_minor: -500, lp_cleared: 'pending'}, null, 1),
        row('tx-draft', IDS.transactions, {lp_date: '2026-01-06', lp_description: 'pending thing', lp_state: 'draft'}),
      ],
    },
    auditHead: {seq: 9, hash: 'f'.repeat(64)},
  };
}

/** Doctor a copy of the valid section and return the parse result. */
function parseDoctored(mutate: (section: LedgerExportSection) => void) {
  const section = structuredClone(validSection());
  mutate(section);
  return parseLedgerExportSection(section);
}

describe('parseLedgerExportSection — the deep-validation boundary (LX-4)', () => {
  it('parses a coherent book to a typed replay plan (order: entry number, drafts last)', () => {
    const result = parseLedgerExportSection(validSection());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.book.accounts.map((a) => a.name).sort()).toEqual(['Assets:Cash', 'Revenue:Sales']);
    expect(result.book.transactions.map((t) => t.id)).toEqual(['tx-1', 'tx-draft']);
    expect(result.book.transactions[0].postings.map((p) => p.id)).toEqual(['post-1', 'post-2']);
    expect(result.book.auditHead).toEqual({seq: 9, hash: 'f'.repeat(64)});
    expect(result.book.evidenceDropped).toBe(0);
  });

  it('refuses a section that does not carry a database its settings name', () => {
    const result = parseDoctored((s) => {
      s.library.databases = s.library.databases.filter((d) => d.id !== IDS.postings);
    });
    expect(result).toMatchObject({ok: false, reason: expect.stringContaining('postings database')});
  });

  it('refuses an unbalanced posted entry', () => {
    const result = parseDoctored((s) => {
      (s.library.pages.find((p) => p.id === 'post-1')!.properties as Record<string, unknown>).lp_amount_minor = 501;
    });
    expect(result).toMatchObject({ok: false, reason: expect.stringContaining('balance')});
  });

  it('refuses a posting onto an unknown account', () => {
    const result = parseDoctored((s) => {
      (s.library.pages.find((p) => p.id === 'post-1')!.properties as Record<string, unknown>).lp_account = 'acc-nope';
    });
    expect(result).toMatchObject({ok: false, reason: expect.stringContaining('unknown account')});
  });

  it('refuses a row smuggled in under a foreign database id', () => {
    const result = parseDoctored((s) => {
      s.library.pages.push(row('sneak', 'db-foreign', {}));
    });
    expect(result).toMatchObject({ok: false, reason: expect.stringContaining('not one of the four')});
  });

  it('refuses a void entry with no reversal, and a reversal that does not negate leg for leg', () => {
    const voidNoReversal = parseDoctored((s) => {
      (s.library.pages.find((p) => p.id === 'tx-1')!.properties as Record<string, unknown>).lp_state = 'void';
    });
    expect(voidNoReversal).toMatchObject({ok: false, reason: expect.stringContaining('exactly one reversal')});

    const badReversal = parseDoctored((s) => {
      (s.library.pages.find((p) => p.id === 'tx-1')!.properties as Record<string, unknown>).lp_state = 'void';
      s.library.pages.push(
        row('tx-rev', IDS.transactions, {lp_date: '2026-01-07', lp_description: 'undo', lp_state: 'posted', lp_entry_no: 2, lp_reverses: 'tx-1'}),
        row('post-3', IDS.postings, {lp_transaction: 'tx-rev', lp_account: 'acc-cash', lp_amount_minor: -400, lp_cleared: 'pending'}),
        row('post-4', IDS.postings, {lp_transaction: 'tx-rev', lp_account: 'acc-sales', lp_amount_minor: 400, lp_cleared: 'pending'}),
      );
    });
    expect(badReversal).toMatchObject({ok: false, reason: expect.stringContaining('leg for leg')});
  });

  it('refuses the reconciled↔frozen invariant broken in either direction', () => {
    const reconciledUnowned = parseDoctored((s) => {
      (s.library.pages.find((p) => p.id === 'post-1')!.properties as Record<string, unknown>).lp_cleared = 'reconciled';
    });
    expect(reconciledUnowned).toMatchObject({ok: false, reason: expect.stringContaining('reconciled')});

    const frozenByOpen = parseDoctored((s) => {
      s.library.pages.push(row('rec-1', IDS.reconciliations, {lp_account: 'acc-cash', lp_statement_date: '2026-01-31', lp_statement_balance_minor: 500, lp_status: 'open'}));
      const props = s.library.pages.find((p) => p.id === 'post-1')!.properties as Record<string, unknown>;
      props.lp_cleared = 'reconciled';
      props.lp_reconciliation = 'rec-1';
    });
    expect(frozenByOpen).toMatchObject({ok: false, reason: expect.stringContaining('not finished')});
  });

  it('refuses two OPEN reconciliations on one account', () => {
    const result = parseDoctored((s) => {
      s.library.pages.push(
        row('rec-1', IDS.reconciliations, {lp_account: 'acc-cash', lp_statement_date: '2026-01-31', lp_statement_balance_minor: 0, lp_status: 'open'}),
        row('rec-2', IDS.reconciliations, {lp_account: 'acc-cash', lp_statement_date: '2026-02-28', lp_statement_balance_minor: 0, lp_status: 'open'}),
      );
    });
    expect(result).toMatchObject({ok: false, reason: expect.stringContaining('more than one open reconciliation')});
  });

  it('refuses a closing entry no period record claims, and overlapping closed periods', () => {
    const orphanClosing = parseDoctored((s) => {
      (s.library.pages.find((p) => p.id === 'tx-1')!.properties as Record<string, unknown>).lp_kind = 'closing';
    });
    expect(orphanClosing).toMatchObject({ok: false, reason: expect.stringContaining('not referenced by any period')});

    const overlapping = parseDoctored((s) => {
      s.settings.ledgerPeriods = [
        {id: 'per-1', start: '2026-01-01', end: '2026-01-31', status: 'closed', closingEntryId: null, reopenEntryId: null, closedAt: '', closedBy: '', reopenedAt: null, reopenedBy: null},
        {id: 'per-2', start: '2026-01-15', end: '2026-02-15', status: 'closed', closingEntryId: null, reopenEntryId: null, closedAt: '', closedBy: '', reopenedAt: null, reopenedBy: null},
      ];
    });
    expect(overlapping).toMatchObject({ok: false, reason: expect.stringContaining('overlap')});
  });

  it('counts the evidence an HTML export cannot carry (dropped, surfaced, never silent)', () => {
    const section = structuredClone(validSection());
    (section.library.pages.find((p) => p.id === 'tx-1')!.properties as Record<string, unknown>).lp_evidence = [
      {filename: 'receipt.pdf', sha256: 'a'.repeat(64), size: 10},
    ];
    const result = parseLedgerExportSection(section);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.book.evidenceDropped).toBe(1);
  });

  it('refuses a book over the export-section entry ceiling', () => {
    const result = parseDoctored((s) => {
      for (let i = 0; i < 1001; i += 1) {
        s.library.pages.push(row(`tx-bulk-${i}`, IDS.transactions, {lp_date: '2026-01-06', lp_state: 'draft'}));
      }
    });
    expect(result).toMatchObject({ok: false, reason: expect.stringContaining('ceiling')});
  });

  // ── The total-refusal contract holes the review closed (Sasha F1/F2, Quinn 4) ──

  it('refuses an unexpected envelope key — the hiding place for unhashed junk', () => {
    expect(parseDoctored((s) => {
      (s as unknown as Record<string, unknown>).junk = {deep: true};
    })).toMatchObject({ok: false, reason: expect.stringContaining('unexpected section key "junk"')});
    expect(parseDoctored((s) => {
      (s.settings as Record<string, unknown>).ledgerEntrySeq = 42;
    })).toMatchObject({ok: false, reason: expect.stringContaining('unexpected settings key')});
    expect(parseDoctored((s) => {
      (s.library as unknown as Record<string, unknown>).extra = [];
    })).toMatchObject({ok: false, reason: expect.stringContaining('unexpected library key')});
  });

  it('refuses non-record elements in pages[] / databases[] instead of dereferencing them', () => {
    expect(parseDoctored((s) => {
      (s.library.pages as unknown[]).push(null);
    })).toMatchObject({ok: false, reason: expect.stringContaining('page entry')});
    expect(parseDoctored((s) => {
      (s.library.databases as unknown[]).push('nope');
    })).toMatchObject({ok: false, reason: expect.stringContaining('database entry')});
  });

  it('bounds the auditHead: a multi-megabyte "hash" or a junk seq refuses', () => {
    expect(parseDoctored((s) => {
      s.auditHead = {seq: 1, hash: 'f'.repeat(1024 * 1024)};
    })).toMatchObject({ok: false, reason: expect.stringContaining('auditHead')});
    expect(parseDoctored((s) => {
      s.auditHead = {seq: -3, hash: 'f'.repeat(64)};
    })).toMatchObject({ok: false, reason: expect.stringContaining('auditHead')});
    expect(parseDoctored((s) => {
      s.auditHead = {seq: 1.5, hash: 'F'.repeat(64)};
    })).toMatchObject({ok: false, reason: expect.stringContaining('auditHead')});
  });

  it('refuses a posted entry whose postings overflow the safe integer range (never a thrown MoneyError)', () => {
    const near = Number.MAX_SAFE_INTEGER - 1;
    const result = parseDoctored((s) => {
      (s.library.pages.find((p) => p.id === 'post-1')!.properties as Record<string, unknown>).lp_amount_minor = near;
      (s.library.pages.find((p) => p.id === 'post-2')!.properties as Record<string, unknown>).lp_amount_minor = near;
      s.library.pages.push(
        row('post-3', IDS.postings, {lp_transaction: 'tx-1', lp_account: 'acc-sales', lp_amount_minor: -near, lp_cleared: 'pending'}, null, 2),
        row('post-4', IDS.postings, {lp_transaction: 'tx-1', lp_account: 'acc-sales', lp_amount_minor: -near, lp_cleared: 'pending'}, null, 3),
      );
    });
    expect(result).toMatchObject({ok: false, reason: expect.stringContaining('overflow')});
  });
});

// ── LX-4 review batch — period entries and the closing-sweep simulation ───────

/** The valid book extended with a CLOSED January period and its closing entry
 *  (sweeping tx-1's −500 revenue into retained earnings). */
function periodSection(): LedgerExportSection {
  const s = structuredClone(validSection());
  s.library.pages.push(
    row('acc-re', IDS.accounts, {lp_type: 'equity', lp_status: 'open', lp_currency: 'USD'}, 'Equity:RetainedEarnings'),
    row('tx-close', IDS.transactions, {lp_date: '2026-01-31', lp_description: 'Closing entry — 2026-01-01 to 2026-01-31', lp_state: 'posted', lp_entry_no: 2, lp_kind: 'closing'}),
    row('post-c1', IDS.postings, {lp_transaction: 'tx-close', lp_account: 'acc-sales', lp_amount_minor: 500, lp_cleared: 'pending'}, null, 0),
    row('post-c2', IDS.postings, {lp_transaction: 'tx-close', lp_account: 'acc-re', lp_amount_minor: -500, lp_cleared: 'pending'}, null, 1),
  );
  s.settings.ledgerPeriods = [
    {id: 'per-1', start: '2026-01-01', end: '2026-01-31', status: 'closed', closingEntryId: 'tx-close', reopenEntryId: null, closedAt: '2026-02-01T00:00:00.000Z', closedBy: 'k', reopenedAt: null, reopenedBy: null},
  ];
  return s;
}

describe('parseLedgerExportSection — period entries + the closing-sweep simulation (Quinn 1/2)', () => {
  it('a coherent closed period parses (the sweep simulation matches the recorded entry)', () => {
    expect(parseLedgerExportSection(periodSection()).ok).toBe(true);
  });

  it('refuses a closing entry carrying a cleared tick (the replay would silently drop it)', () => {
    const s = periodSection();
    (s.library.pages.find((p) => p.id === 'post-c1')!.properties as Record<string, unknown>).lp_cleared = 'cleared';
    expect(parseLedgerExportSection(s)).toMatchObject({ok: false, reason: expect.stringContaining('backup bundle')});
  });

  it('refuses a closing leg frozen by a finished reconciliation (the replay would abort midway)', () => {
    const s = periodSection();
    // A finished reconciliation on the RETAINED-EARNINGS account — reachable
    // live (startReconciliation has no account-type restriction) — freezing
    // the closing entry's equity leg.
    s.library.pages.push(
      row('rec-re', IDS.reconciliations, {lp_account: 'acc-re', lp_statement_date: '2026-01-31', lp_statement_balance_minor: -500, lp_status: 'finished'}),
    );
    const leg = s.library.pages.find((p) => p.id === 'post-c2')!.properties as Record<string, unknown>;
    leg.lp_cleared = 'reconciled';
    leg.lp_reconciliation = 'rec-re';
    expect(parseLedgerExportSection(s)).toMatchObject({ok: false, reason: expect.stringContaining('backup bundle')});
  });

  it('refuses when income dated inside a closed period was posted AFTER its close (sweep divergence)', () => {
    const s = periodSection();
    // Income the recorded closing entry never swept, dated ≤ the period end:
    // the replayed close would sweep −600 where the section records −500.
    // (The real-world producer of this shape is legal live history — close
    // February, then post JANUARY-dated income; the server e2e covers that
    // exact sequence — but the refusal is the same for any divergence.)
    s.library.pages.push(
      row('tx-late', IDS.transactions, {lp_date: '2026-01-20', lp_description: 'late income', lp_state: 'posted', lp_entry_no: 3}),
      row('post-l1', IDS.postings, {lp_transaction: 'tx-late', lp_account: 'acc-cash', lp_amount_minor: 100, lp_cleared: 'pending'}, null, 0),
      row('post-l2', IDS.postings, {lp_transaction: 'tx-late', lp_account: 'acc-sales', lp_amount_minor: -100, lp_cleared: 'pending'}, null, 1),
    );
    expect(parseLedgerExportSection(s)).toMatchObject({
      ok: false,
      reason: expect.stringContaining('does not match the sweep'),
    });
  });

  it('refuses a period that recorded NO closing entry over books that hold income to sweep', () => {
    const s = periodSection();
    // Detach the closing entry from the period record (and drop the entry so
    // it is not an orphan): the range now claims "nothing to sweep" while
    // tx-1's revenue stands.
    s.library.pages = s.library.pages.filter((p) => !['tx-close', 'post-c1', 'post-c2'].includes(p.id));
    (s.settings.ledgerPeriods as Array<Record<string, unknown>>)[0].closingEntryId = null;
    expect(parseLedgerExportSection(s)).toMatchObject({ok: false, reason: expect.stringContaining('does not match the sweep')});
  });
});
