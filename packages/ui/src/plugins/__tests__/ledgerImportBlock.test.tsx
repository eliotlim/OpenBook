import React from 'react';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {act, cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
// The REAL first-party ledger plugin, byte-for-byte (vite `?raw`) — via the
// shared fixture, whose file list is DERIVED from the package by glob. A
// hand-listed map here would silently omit modules `src/index.ts` imports
// (the LGR-8 report modules did exactly that), and the plugin would then fail
// to ACTIVATE, surfacing as every block in this file being undefined.
import {storedLedgerPlugin as storedPlugin} from './ledgerPluginFixture';
import type {DataClient, LedgerTransaction} from '@book.dev/sdk';
import {syncPlugins} from '../host';
import {getCustomBlock} from '../../blockeditor/registry';

/**
 * LGR-10 — the bank-import BLOCK itself, rendered, driven through the REAL
 * plugin loader against a scripted ledger client.
 *
 * The pure model is pinned next door in `ledgerPlugin.test.ts`. What lives here
 * is the thing a pure test cannot reach: the block's IO control flow, and in
 * particular the two failures that stranded a user's data.
 *
 *  - A MID-LOOP `createDraft` REJECT. Drafts are created one row at a time, so
 *    a reject at row k leaves rows 1..k-1 on the SERVER. If the accumulator is
 *    scoped inside the try, the catch cannot see them: nothing is listed, the
 *    dedup set stays stale, the button re-arms — and the next press creates
 *    every row a SECOND time.
 *  - DRAFTS THAT OUTLIVE THE TAB. A one-legged draft is in no register and no
 *    trial balance, and no other surface can adopt it. If the confirm list is
 *    only React state, closing the tab loses them for good.
 */

const BANK = 'acct-bank';
const COFFEE = 'acct-coffee';
const SAVINGS = 'acct-savings';

const CSV = ['Date,Description,Amount', '2026-03-01,ROW ONE,-1.00', '2026-03-02,ROW TWO,-2.00', '2026-03-03,ROW THREE,-3.00'].join('\n');

/** A scripted ledger: real transaction shapes, an injectable createDraft fault. */
function fakeLedger(opts: {failOnCall?: number; listFailsFrom?: number; failFirstLists?: number; seed?: LedgerTransaction[]} = {}) {
  const transactions: LedgerTransaction[] = [...(opts.seed ?? [])];
  const patches: Array<{postings: Array<{accountId: string; amountMinor: number}>}> = [];
  let calls = 0;
  let listCalls = 0;
  const client = {
    listPlugins: async () => [storedPlugin()],
    ledgerInfo: async () => ({exists: true, hostPageId: 'host', databases: null}),
    ledgerListAccounts: async () => [
      {id: BANK, name: 'Assets:Bank:Checking', type: 'asset', status: 'open', currency: 'USD', createdAt: '', updatedAt: ''},
      {id: COFFEE, name: 'Expenses:Coffee', type: 'expense', status: 'open', currency: 'USD', createdAt: '', updatedAt: ''},
      {id: SAVINGS, name: 'Assets:Bank:Savings', type: 'asset', status: 'open', currency: 'USD', createdAt: '', updatedAt: ''},
    ],
    // Mirrors the server: `state` is applied BEFORE the limit slice.
    ledgerListTransactions: async (o?: {state?: string; limit?: number}) => {
      listCalls += 1;
      // A TRANSIENT list outage: the first n reads fail, everything after works.
      if (opts.failFirstLists !== undefined && listCalls <= opts.failFirstLists) throw new Error('the ledger is unreachable');
      if (opts.listFailsFrom !== undefined && calls >= opts.listFailsFrom) throw new Error('the ledger is unreachable');
      let out = [...transactions].reverse();
      if (o?.state) out = out.filter((t) => t.state === o.state);
      return out.slice(0, o?.limit ?? 500);
    },
    ledgerCreateDraft: async (input: {date: string; description: string; postings: Array<{accountId: string; amountMinor: number; memo: string | null}>}) => {
      calls += 1;
      if (opts.failOnCall === calls) throw new Error('the network gave up');
      const tx = {
        id: `tx-${calls}`,
        date: input.date,
        description: input.description,
        state: 'draft',
        postedAt: null,
        postedBy: null,
        reverses: null,
        entryNo: null,
        evidence: [],
        postings: input.postings.map((p, i) => ({id: `p-${calls}-${i}`, transactionId: `tx-${calls}`, ...p, cleared: 'pending', reconciliationId: null})),
        createdAt: '',
        updatedAt: '',
      } as unknown as LedgerTransaction;
      transactions.push(tx);
      return tx;
    },
    ledgerUpdateDraft: async (id: string, patch: {postings: Array<{accountId: string; amountMinor: number; memo: string | null}>}) => {
      patches.push(patch);
      const at = transactions.findIndex((t) => t.id === id);
      transactions[at] = {
        ...transactions[at],
        postings: patch.postings.map((p, i) => ({id: `p-${id}-${i}`, transactionId: id, ...p, cleared: 'pending', reconciliationId: null})),
      } as unknown as LedgerTransaction;
      return transactions[at];
    },
  } as unknown as DataClient;
  return {client, transactions, createCalls: () => calls, listCalls: () => listCalls, patches};
}

/** A one-legged draft sitting on `accountId`, as the ledger hands it back. */
const strandedTx = (id: string, accountId: string, amountMinor: number, description: string): LedgerTransaction =>
  ({
    id,
    date: '2026-02-01',
    description,
    state: 'draft',
    postedAt: null,
    postedBy: null,
    reverses: null,
    entryNo: null,
    evidence: [],
    postings: [{id: `p-${id}`, transactionId: id, accountId, amountMinor, cleared: 'pending', reconciliationId: null, memo: description}],
    createdAt: '',
    updatedAt: '',
  }) as unknown as LedgerTransaction;

/** Render the registered bank-import block with the minimum host it touches. */
async function mountBlock(client: DataClient): Promise<void> {
  await syncPlugins(client);
  const def = getCustomBlock('openbook.ledger/bank-import');
  expect(def).toBeDefined();
  const block = {get: () => undefined} as never;
  const editor = {readOnly: false, doc: {transact: (fn: () => void) => fn()}} as never;
  render(React.createElement(def!.render, {block, editor, pageReadOnly: false}));
  await screen.findByLabelText('Bank statement CSV');
}

const uploadCsv = async (text: string, name = 'march.csv'): Promise<void> => {
  const input = screen.getByLabelText('Bank statement CSV');
  fireEvent.change(input, {target: {files: [new File([text], name, {type: 'text/csv'})]}});
  await waitFor(() => expect(document.querySelector('[data-import-summary]')).not.toBeNull());
};

const chooseBank = async (): Promise<void> => {
  fireEvent.change(document.querySelector('[data-import-source-account]')!, {target: {value: BANK}});
  await waitFor(() => expect(runButton().disabled).toBe(false));
};

const runButton = (): HTMLButtonElement => document.querySelector('[data-import-run]') as HTMLButtonElement;

/** Plugin-scoped storage keys, as the host namespaces them. */
const PROFILE_KEY = 'openbook.plugin.openbook.ledger.importProfiles';

beforeEach(() => {
  localStorage.clear();
});

afterEach(async () => {
  cleanup();
  await syncPlugins({listPlugins: async () => []} as unknown as DataClient);
  vi.restoreAllMocks();
});

describe('LGR-10 — the bank-import block under failure and after a reload', () => {
  it('a mid-loop createDraft failure shows what DID land, and the retry imports only the rest', async () => {
    const ledger = fakeLedger({failOnCall: 3});
    await mountBlock(ledger.client);
    await uploadCsv(CSV);
    await chooseBank();

    fireEvent.click(runButton());

    // The failure is reported…
    await screen.findByText(/the network gave up/);
    // …and the two rows that DID land are on screen, not lost with the throw.
    await waitFor(() => expect(document.querySelectorAll('[data-import-draft]')).toHaveLength(2));
    expect(ledger.transactions).toHaveLength(2);

    // The dedup set was re-read from the ledger, so the retry offers ONLY the
    // row that never made it. Before the fix the button said "Create 3 drafts"
    // and pressing it wrote rows one and two a second time.
    await waitFor(() => expect(runButton().textContent).toBe('Create 1 draft'));
    expect(document.querySelectorAll('[data-import-row][data-import-status="duplicate-draft"]')).toHaveLength(2);

    fireEvent.click(runButton());
    await waitFor(() => expect(ledger.transactions).toHaveLength(3));
    expect(ledger.transactions.map((t) => t.description)).toEqual(['ROW ONE', 'ROW TWO', 'ROW THREE']);
  });

  it('drafts left unfinished come back on a fresh block — the data is not stranded', async () => {
    const first = fakeLedger();
    await mountBlock(first.client);
    await uploadCsv(CSV);
    await chooseBank();
    fireEvent.click(runButton());
    await waitFor(() => expect(first.transactions).toHaveLength(3));

    // Categorise ONE of the three, then walk away.
    const categories = document.querySelectorAll('[data-import-category]');
    fireEvent.change(categories[0], {target: {value: COFFEE}});
    const saves = document.querySelectorAll<HTMLButtonElement>('[data-import-confirm]');
    await waitFor(() => expect(saves[0].disabled).toBe(false));
    fireEvent.click(saves[0]);
    await waitFor(() => expect(first.transactions[0].postings).toHaveLength(2));

    // A brand-new block, same books: the two unfinished drafts are REACHABLE.
    // (The account comes back with the saved profile, so nothing is re-chosen.)
    cleanup();
    await mountBlock(first.client);
    await uploadCsv(CSV);

    await waitFor(() => expect(document.querySelector('[data-import-stranded]')).not.toBeNull());
    expect(document.querySelector('[data-import-stranded]')?.getAttribute('data-import-stranded')).toBe('2');
    // …and re-importing still creates nothing, whatever else changed.
    expect(runButton().disabled).toBe(true);
  });
});

describe('LGR-10 — a listed draft is never confirmed against the wrong account', () => {
  const RULE_KEY = 'openbook.plugin.openbook.ledger.importRules';

  it('flipping the bank account drops the stranded list instead of re-aiming its Save', async () => {
    // A remembered rule pre-fills the category, so the stranded row's Save is
    // LIVE the moment it renders — no further interaction needed to fire it.
    localStorage.setItem(RULE_KEY, JSON.stringify({'date|description|amount': {'old coffee': COFFEE}}));
    const ledger = fakeLedger({seed: [strandedTx('old-1', BANK, -900, 'OLD COFFEE')]});
    await mountBlock(ledger.client);
    await uploadCsv(CSV);
    await chooseBank();

    await waitFor(() => expect(document.querySelector('[data-import-stranded]')).not.toBeNull());
    const save = () => document.querySelector<HTMLButtonElement>('[data-import-confirm="old-1"]');
    expect(save()?.disabled).toBe(false); // armed, from the remembered rule

    // Flip the account. `setProfile` lands NOW; the ledger re-read does not.
    fireEvent.change(document.querySelector('[data-import-source-account]')!, {target: {value: SAVINGS}});
    // The row is gone in the same commit — there is no window in which a Save
    // exists for a draft the account picker no longer describes.
    expect(document.querySelector('[data-import-stranded]')).toBeNull();
    expect(save()).toBeNull();

    // And the draft on the books is untouched: still one leg, still on BANK.
    await waitFor(() => expect(ledger.patches).toHaveLength(0));
    expect(ledger.transactions.find((t) => t.id === 'old-1')?.postings.map((p) => p.accountId)).toEqual([BANK]);
  });

  it('a stranded draft confirms against ITS OWN account, whatever the picker says', async () => {
    const ledger = fakeLedger({seed: [strandedTx('old-2', BANK, -900, 'OLD COFFEE')]});
    await mountBlock(ledger.client);
    await uploadCsv(CSV);
    await chooseBank();
    await waitFor(() => expect(document.querySelector('[data-import-stranded]')).not.toBeNull());

    fireEvent.change(document.querySelector('[data-import-category="old-2"]')!, {target: {value: COFFEE}});
    fireEvent.click(document.querySelector('[data-import-confirm="old-2"]')!);
    await waitFor(() => expect(ledger.patches).toHaveLength(1));

    // The bank leg comes from the DRAFT, not from live UI state — so the
    // original posting is preserved and the entry balances.
    expect(ledger.patches[0].postings.map((p) => p.accountId)).toEqual([BANK, COFFEE]);
    expect(ledger.patches[0].postings.reduce((n, p) => n + p.amountMinor, 0)).toBe(0);
  });

  it('a remembered rule naming a deleted account is dropped, not pre-filled into a posting', async () => {
    // Plugin storage is shared with every tab on the origin and editable from a
    // console; these values become the accountId of a real posting.
    localStorage.setItem(RULE_KEY, JSON.stringify({'date|description|amount': {'old coffee': 'acct-deleted'}}));
    const ledger = fakeLedger({seed: [strandedTx('old-3', BANK, -900, 'OLD COFFEE')]});
    await mountBlock(ledger.client);
    await uploadCsv(CSV);
    await chooseBank();
    await waitFor(() => expect(document.querySelector('[data-import-stranded]')).not.toBeNull());

    expect(document.querySelector<HTMLSelectElement>('[data-import-category="old-3"]')!.value).toBe('');
    expect(document.querySelector<HTMLButtonElement>('[data-import-confirm="old-3"]')!.disabled).toBe(true);
  });

  it('a SATURATED ledger still lists the stranded drafts, which is the whole point of them', async () => {
    // The server applies `state` BEFORE the limit slice. So an unfiltered
    // {limit: 1000} read returns the newest 1000 transactions of ANY kind — and
    // on a busy book the stranded draft is not among them. It then appears in no
    // panel at all: exactly the permanent loss this panel exists to prevent.
    const older = strandedTx('old-5', BANK, -900, 'OLD COFFEE');
    const newer = Array.from({length: 1000}, (_, i) => {
      const tx = strandedTx(`posted-${i}`, BANK, -100 - i, `POSTED ${i}`) as unknown as {state: string};
      tx.state = 'posted';
      return tx as unknown as LedgerTransaction;
    });
    const ledger = fakeLedger({seed: [older, ...newer]});
    await mountBlock(ledger.client);

    fireEvent.change(document.querySelector('[data-import-drafts-account]')!, {target: {value: BANK}});
    await waitFor(() => expect(document.querySelector('[data-import-stranded]')).not.toBeNull());
    expect(document.querySelector('[data-import-confirm="old-5"]')).not.toBeNull();
  });

  it('the stranded panel is reachable with NO statement open', async () => {
    // A user who deleted last month's export was back in the original
    // condition: drafts on the books that no surface would show them.
    const ledger = fakeLedger({seed: [strandedTx('old-4', BANK, -900, 'OLD COFFEE')]});
    await mountBlock(ledger.client);
    expect(document.querySelector('[data-import-stranded]')).toBeNull();

    fireEvent.change(document.querySelector('[data-import-drafts-account]')!, {target: {value: BANK}});
    await waitFor(() => expect(document.querySelector('[data-import-stranded]')).not.toBeNull());
    // On THIS path there is no preview above to date the row, and the picker
    // "this account" would point at sits below the panel — so the row carries
    // its own date and the heading names the account outright.
    expect(document.querySelector('[data-import-draft-date]')?.textContent).toContain('2026-02-01');
    expect(document.querySelector('[data-import-stranded]')?.textContent).toContain('Assets:Bank:Checking');
    // …and it is finishable from there, against the draft's own account.
    fireEvent.change(document.querySelector('[data-import-category="old-4"]')!, {target: {value: COFFEE}});
    fireEvent.click(document.querySelector('[data-import-confirm="old-4"]')!);
    await waitFor(() => expect(ledger.patches).toHaveLength(1));
    expect(ledger.patches[0].postings.map((p) => p.accountId)).toEqual([BANK, COFFEE]);
  });
});

describe('LGR-10 — a dedup set that could not be refreshed disarms the button', () => {
  it('a CORRELATED outage (create fails, list fails too) does not re-arm over a stale answer', async () => {
    // One outage takes out both calls. The refresh used to throw straight
    // through run()'s catch — escaping the component as an unhandled rejection
    // — leaving `known` at its pre-import value while `finally` cleared `busy`.
    // The button re-armed reading "Create 3 drafts" with zero duplicate rows,
    // and one press wrote ROW ONE and ROW TWO into the books a second time.
    const ledger = fakeLedger({failOnCall: 3, listFailsFrom: 3});
    await mountBlock(ledger.client);
    await uploadCsv(CSV);
    await chooseBank();

    fireEvent.click(runButton());
    await screen.findByText(/the network gave up/);
    // The two rows that landed are still shown…
    await waitFor(() => expect(document.querySelectorAll('[data-import-draft]')).toHaveLength(2));
    expect(ledger.transactions).toHaveLength(2);

    // …and the button is DEAD, with the reason stated. Refusing to import over
    // an unknown dedup set is the only safe direction — the alternative writes
    // duplicate rows into a ledger.
    await waitFor(() => expect(runButton().disabled).toBe(true));
    expect(document.querySelector('[data-import-dedup-stale]')).not.toBeNull();

    fireEvent.click(runButton());
    await new Promise((r) => setTimeout(r, 50));
    expect(ledger.transactions.map((t) => t.description)).toEqual(['ROW ONE', 'ROW TWO']);
  });

  it('a LATER successful read re-arms it — one bad list does not kill the importer for the session', async () => {
    // The upload path reads the ledger DIRECTLY, bypassing `refreshLedger`, so
    // it is a third call site that has to disarm the flag itself. Sequence:
    // one failed read from the drafts-account picker, then a perfectly good
    // CSV on a SAVED mapping — so the account is pre-filled and the user never
    // touches the source picker, the only other thing that cleared the flag.
    // Before the fix the read succeeded, the preview rendered, the mapping was
    // reused… and Create was dead behind "reload the page", for good.
    localStorage.setItem(
      PROFILE_KEY,
      JSON.stringify({
        'date|description|amount': {
          sourceId: 'date|description|amount',
          label: 'march.csv',
          accountId: BANK,
          mapping: {date: 0, description: 1, amount: 2},
          dateFormat: 'iso',
          sign: 'outflow-negative',
          denomination: 'major',
        },
      }),
    );
    const ledger = fakeLedger({failFirstLists: 1});
    await mountBlock(ledger.client);

    // The one failed read, from the no-statement drafts picker. Settled fully
    // before the upload starts — the ORDER is what is being pinned.
    fireEvent.change(document.querySelector('[data-import-drafts-account]')!, {target: {value: BANK}});
    await waitFor(() => expect(ledger.listCalls()).toBe(1));
    await act(async () => void (await new Promise((r) => setTimeout(r, 0))));

    // Now the good upload. Its own read succeeds, and the saved mapping fills
    // the account in — no dropdown is touched.
    await uploadCsv(CSV);
    expect(document.querySelector<HTMLSelectElement>('[data-import-source-account]')!.value).toBe(BANK);
    expect(document.querySelector('[data-import-saved-mapping]')).not.toBeNull();

    // So the banner is gone and the button is ALIVE.
    await waitFor(() => expect(runButton().disabled).toBe(false));
    expect(document.querySelector('[data-import-dedup-stale]')).toBeNull();
    expect(runButton().textContent).toBe('Create 3 drafts');

    // …and it really imports, rather than merely looking enabled.
    fireEvent.click(runButton());
    await waitFor(() => expect(ledger.transactions).toHaveLength(3));
  });

  it('a refresh that fails AFTER a fully successful import is not reported as an import failure', async () => {
    const ledger = fakeLedger({listFailsFrom: 3});
    await mountBlock(ledger.client);
    await uploadCsv(CSV);
    await chooseBank();

    fireEvent.click(runButton());
    await waitFor(() => expect(ledger.transactions).toHaveLength(3));
    // All three drafts exist and are listed for categorising…
    await waitFor(() => expect(document.querySelectorAll('[data-import-draft]')).toHaveLength(3));
    // …the message says what actually happened…
    await screen.findByText(/import finished, but the duplicate check could not be refreshed/);
    // …and the button is disarmed rather than inviting a second pass.
    expect(runButton().disabled).toBe(true);
  });
});

/**
 * LGR-16 — the journal block's MEMO round trip.
 *
 * The ledger owns a memo, and the block must not keep a second source of truth
 * for it. But "not a second source of truth" is not the same as "no local copy":
 * `writeProps` is synchronous while the draft sync is debounced, so the local
 * rows and the stored postings routinely disagree on COUNT, and
 * `mergeMemosFromDraft` then merges nothing by design. With no local copy at
 * all, that no-op rendered every memo BLANK — and the next keystroke wrote the
 * blank straight back to the server as `memo: null`.
 */
describe('LGR-16 — a memo survives the paths where the ledger cannot answer', () => {
  const propsFor = (seed: Record<string, string>) => {
    const map = new Map<string, unknown>(Object.entries(seed));
    return {
      map,
      api: {
        get: (k: string) => map.get(k),
        set: (k: string, v: unknown) => void map.set(k, v),
        delete: (k: string) => void map.delete(k),
      },
    };
  };

  const journalClient = (draft: unknown, onUpdate: (patch: unknown) => void) =>
    ({
      listPlugins: async () => [storedPlugin()],
      ledgerInfo: async () => ({exists: true, hostPageId: 'host', databases: {accounts: 'db-a', transactions: 'db-t', postings: 'db-p'}}),
      ledgerListAccounts: async () => [
        {id: BANK, name: 'Assets:Bank:Checking', type: 'asset', status: 'open', currency: 'USD', createdAt: '', updatedAt: ''},
        {id: COFFEE, name: 'Expenses:Coffee', type: 'expense', status: 'open', currency: 'USD', createdAt: '', updatedAt: ''},
      ],
      subscribeRows: () => () => undefined,
      ledgerGetTransaction: async () => draft,
      ledgerUpdateDraft: async (_id: string, patch: unknown) => {
        onUpdate(patch);
        return draft;
      },
      ledgerCreateDraft: async () => draft,
    }) as unknown as DataClient;

  const mountJournal = async (client: DataClient, props: {get: (k: string) => unknown}): Promise<void> => {
    await syncPlugins(client);
    const def = getCustomBlock('openbook.ledger/journal-entry');
    const block = {get: (k: string) => (k === 'props' ? props : undefined)} as never;
    const editor = {readOnly: false, doc: {transact: (fn: () => void) => fn()}} as never;
    render(React.createElement(def!.render, {block, editor, pageReadOnly: false}));
    await waitFor(() => expect(document.querySelectorAll('[data-ledger-memo]').length).toBeGreaterThan(0));
  };

  it('keeps rendering memos when the draft and the rows disagree — and never writes the blank back', async () => {
    // THREE complete rows locally, TWO postings stored: the debounce window
    // every keystroke passes through. mergeMemosFromDraft merges nothing.
    const props = propsFor({
      ledgerRows: JSON.stringify([
        {accountId: BANK, debit: '10.00', credit: '', memo: 'gross'},
        {accountId: COFFEE, debit: '', credit: '4.00', memo: 'net'},
        {accountId: COFFEE, debit: '', credit: '6.00', memo: 'withheld'},
      ]),
      ledgerDescription: 'Payday',
      ledgerDate: '2026-03-01',
      ledgerDraftId: 'draft-1',
    });
    const patches: Array<{postings: Array<{memo: string | null}>}> = [];
    const draft = {
      id: 'draft-1',
      date: '2026-03-01',
      description: 'Payday',
      state: 'draft',
      entryNo: null,
      postings: [
        {accountId: BANK, amountMinor: 1000, memo: 'gross'},
        {accountId: COFFEE, amountMinor: -1000, memo: 'net'},
      ],
    };
    await mountJournal(journalClient(draft, (p) => patches.push(p as never)), props.api);

    // The memos are ON SCREEN, from the local cache, because the books could
    // not line the rows up. Before the fix all three rendered empty.
    const memos = () => Array.from(document.querySelectorAll<HTMLInputElement>('[data-ledger-memo]')).map((i) => i.value);
    expect(memos()).toEqual(['gross', 'net', 'withheld']);

    // …and a keystroke somewhere else does not push those blanks to the server.
    fireEvent.change(document.querySelectorAll('[data-ledger-memo]')[2], {target: {value: 'withheld tax'}});
    await waitFor(() => expect(patches.length).toBeGreaterThan(0), {timeout: 3000});
    expect(patches[patches.length - 1].postings.map((p) => p.memo)).toEqual(['gross', 'net', 'withheld tax']);

    // That keystroke also re-wrote block props. Reload against the SAME props
    // and the same lagging two-posting draft: the memos must still be there.
    // When props stripped them, this render was blank — and the keystroke after
    // it sent `memo: null` for legs the server had perfectly good memos for.
    cleanup();
    await mountJournal(journalClient(draft, (p) => patches.push(p as never)), props.api);
    expect(memos()).toEqual(['gross', 'net', 'withheld tax']);
    fireEvent.change(document.querySelectorAll('[data-ledger-memo]')[0], {target: {value: 'gross pay'}});
    await waitFor(() => expect(patches.length).toBeGreaterThan(1), {timeout: 3000});
    expect(patches[patches.length - 1].postings.map((p) => p.memo)).toEqual(['gross pay', 'net', 'withheld tax']);
  });

  it('a memo typed on an INCOMPLETE row reaches a store instead of vanishing', async () => {
    // No amount ⇒ not a posting ⇒ the ledger cannot hold this memo at all. If
    // props drop it too, it is written nowhere and dies with the tab.
    const props = propsFor({
      ledgerRows: JSON.stringify([
        {accountId: BANK, debit: '10.00', credit: '', memo: ''},
        {accountId: '', debit: '', credit: '', memo: ''},
      ]),
      ledgerDescription: 'Half typed',
      ledgerDate: '2026-03-01',
    });
    await mountJournal(journalClient(null, () => undefined), props.api);

    fireEvent.change(document.querySelectorAll('[data-ledger-memo]')[1], {target: {value: 'ask accounts about this'}});
    await waitFor(() => {
      const stored = JSON.parse(String(props.map.get('ledgerRows'))) as Array<{memo?: string}>;
      expect(stored[1].memo).toBe('ask accounts about this');
    }, {timeout: 3000});
  });
});
