import React from 'react';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
// The REAL first-party ledger plugin, byte-for-byte — via the shared fixture.
import {storedLedgerPlugin as storedPlugin} from './ledgerPluginFixture';
import type {DataClient, LedgerDraftPatch, LedgerTransaction} from '@book.dev/sdk';
import {syncPlugins} from '../host';
import {getCustomBlock} from '../../blockeditor/registry';

/**
 * LGR-14 — evidence in the two UI surfaces, rendered through the real plugin.
 *
 * What each test would catch, stated so a passing suite means something:
 *
 *  - The REGISTER badge tests query INSIDE a specific row (`[data-ledger-
 *    register-row=<postingId>]`), so they fail if the badge attaches to the
 *    wrong transaction — not merely if the markup exists somewhere.
 *  - The JOURNAL blocker tests pin both halves of the gate: the button is dead
 *    WITH its reason wired by `aria-describedby`, and the client-side negative
 *    — a press on the dead button calls NO post API. (The server-side negative
 *    lives in the store test and the e2e; this is the UI's share.)
 *  - The attach flow drives a real file through the input: upload → manifest
 *    patch → gate lifts → post goes through, each step asserted on the spies.
 */

const STRICT = 'acct-travel';
const CASH = 'acct-cash';
const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

const postedEntry = (
  id: string,
  entryNo: number,
  evidence: Array<{filename: string; sha256: string; size: number}>,
): LedgerTransaction =>
  ({
    id,
    date: '2026-08-01',
    description: `Entry ${entryNo}`,
    state: 'posted',
    postedAt: '2026-08-01T00:00:00.000Z',
    postedBy: 'tester',
    reverses: null,
    entryNo,
    evidence,
    postings: [
      {id: `${id}-cash`, transactionId: id, accountId: CASH, amountMinor: 5_000, cleared: 'pending', reconciliationId: null, memo: null},
      {id: `${id}-travel`, transactionId: id, accountId: STRICT, amountMinor: -5_000, cleared: 'pending', reconciliationId: null, memo: null},
    ],
    createdAt: '',
    updatedAt: '',
  }) as unknown as LedgerTransaction;

const accounts = [
  {id: CASH, name: 'Assets:Cash', type: 'asset', status: 'open', currency: 'USD', evidenceRequired: false, createdAt: '', updatedAt: ''},
  {id: STRICT, name: 'Expenses:Travel', type: 'expense', status: 'open', currency: 'USD', evidenceRequired: true, createdAt: '', updatedAt: ''},
];

function registerClient(overrides: Record<string, unknown> = {}): {client: DataClient; updateAccount: ReturnType<typeof vi.fn>} {
  const updateAccount = vi.fn(async (id: string, patch: Record<string, unknown>) => ({...accounts.find((a) => a.id === id)!, ...patch}));
  const client = {
    listPlugins: async () => [storedPlugin()],
    subscribeRows: () => () => {},
    ledgerInfo: async () => ({
      exists: true,
      hostPageId: 'host',
      databases: {accounts: 'db-a', transactions: 'db-t', postings: 'db-p', reconciliations: 'db-r'},
    }),
    ledgerListAccounts: async () => accounts,
    ledgerListTransactions: async () => [
      postedEntry('tx-with', 1, [
        {filename: 'receipt-1.pdf', sha256: SHA_A, size: 10},
        {filename: 'receipt-2.pdf', sha256: SHA_B, size: 20},
      ]),
      postedEntry('tx-without', 2, []),
    ],
    ledgerListReconciliations: async () => [],
    ledgerListPeriods: async () => [],
    ledgerUpdateAccount: updateAccount,
    ...overrides,
  } as unknown as DataClient;
  return {client, updateAccount};
}

async function mountRegister(client: DataClient, pageReadOnly = false): Promise<void> {
  await syncPlugins(client);
  const def = getCustomBlock('openbook.ledger/account-register');
  expect(def).toBeDefined();
  const props = new Map<string, unknown>([['ledgerRegAccount', CASH]]);
  const block = {get: (key: string) => (key === 'props' ? props : key === 'id' ? 'blk-reg' : undefined)} as never;
  const editor = {readOnly: false, doc: {transact: (fn: () => void) => fn()}} as never;
  render(React.createElement(def!.render, {block, editor, pageReadOnly}));
  await screen.findByText(/Account register/);
  await waitFor(() => expect(document.querySelector('[data-ledger-register-row]')).not.toBeNull());
}

const el = <T extends HTMLElement>(selector: string, root: ParentNode = document): T => {
  const found = root.querySelector<T>(selector);
  expect(found, selector).not.toBeNull();
  return found!;
};

afterEach(async () => {
  cleanup();
  await syncPlugins({listPlugins: async () => []} as unknown as DataClient);
  vi.restoreAllMocks();
});

describe('LGR-14 — register evidence badge', () => {
  it('the "no evidence" badge sits on exactly the evidence-less transaction', async () => {
    const {client} = registerClient();
    await mountRegister(client);
    const bare = el('[data-ledger-register-row="tx-without-cash"]');
    const documented = el('[data-ledger-register-row="tx-with-cash"]');
    // Presence FOR THE RIGHT TRANSACTION — scoped to each row, so a badge on
    // every row (or on the wrong one) fails this rather than passing it.
    expect(bare.querySelector('[data-ledger-no-evidence]')).not.toBeNull();
    expect(documented.querySelector('[data-ledger-no-evidence]')).toBeNull();
    // And the documented entry states its count instead.
    expect(el('[data-ledger-evidence-count]', documented).getAttribute('data-ledger-evidence-count')).toBe('2');
    expect(bare.querySelector('[data-ledger-evidence-count]')).toBeNull();
  });

  it('the badge is informational — muted register voice, no alarm colouring', async () => {
    const {client} = registerClient();
    await mountRegister(client);
    const badge = el('[data-ledger-no-evidence]');
    // The badge must not borrow the destructive/alarm token: an entry without
    // a receipt is legal on an ordinary account.
    expect(badge.getAttribute('style') ?? '').not.toContain('destructive');
  });
});

describe('LGR-14 — register evidence-required toggle', () => {
  it('reflects the account and writes the patch through the ledger API', async () => {
    const {client, updateAccount} = registerClient();
    await mountRegister(client);
    const toggle = el<HTMLInputElement>('[data-ledger-evidence-required]');
    expect(toggle.checked).toBe(false); // Assets:Cash does not require evidence
    fireEvent.click(toggle);
    await waitFor(() => expect(updateAccount).toHaveBeenCalledWith(CASH, {evidenceRequired: true}));
  });

  it('is dead on a read-only page, with the reason wired to it', async () => {
    const {client, updateAccount} = registerClient();
    await mountRegister(client, true);
    const toggle = el<HTMLInputElement>('[data-ledger-evidence-required]');
    expect(toggle.disabled).toBe(true);
    const whyId = toggle.getAttribute('aria-describedby');
    expect(whyId).toBeTruthy();
    expect(document.getElementById(whyId!)?.textContent).toMatch(/read-only/);
    fireEvent.click(toggle);
    expect(updateAccount).not.toHaveBeenCalled();
  });
});

describe('LGR-14 — journal block evidence gate + attach flow', () => {
  /**
   * A scripted ledger around ONE stored draft on the evidence-required account.
   * `updateDraft` merges patches into the stored draft (echoing postings back,
   * as the real server does) so the block's stale-commit guard sees agreement.
   */
  function journalClient() {
    const draft: Record<string, unknown> = {
      id: 'draft-1',
      date: '2026-08-01',
      description: 'Team travel',
      state: 'draft',
      entryNo: null,
      evidence: [] as unknown[],
      postings: [
        {id: 'p-1', transactionId: 'draft-1', accountId: CASH, amountMinor: 5_000, cleared: 'pending', reconciliationId: null, memo: null},
        {id: 'p-2', transactionId: 'draft-1', accountId: STRICT, amountMinor: -5_000, cleared: 'pending', reconciliationId: null, memo: null},
      ],
    };
    const putAsset = vi.fn(async () => ({id: SHA_A}));
    const updateDraft = vi.fn(async (_id: string, patch: LedgerDraftPatch) => {
      if (patch.date !== undefined) draft.date = patch.date;
      if (patch.description !== undefined) draft.description = patch.description;
      if (patch.postings !== undefined) {
        draft.postings = patch.postings.map((p, i) => ({
          id: `p-${i}`,
          transactionId: 'draft-1',
          accountId: p.accountId,
          amountMinor: p.amountMinor,
          cleared: p.cleared ?? 'pending',
          reconciliationId: null,
          memo: p.memo ?? null,
        }));
      }
      if (patch.evidence !== undefined) {
        draft.evidence = patch.evidence.map((e) => ({filename: e.filename, sha256: e.sha256, size: 42}));
      }
      return {...draft} as unknown as LedgerTransaction;
    });
    const post = vi.fn(async () => ({...draft, state: 'posted', entryNo: 7} as unknown as LedgerTransaction));
    const client = {
      listPlugins: async () => [storedPlugin()],
      subscribeRows: () => () => {},
      ledgerInfo: async () => ({
        exists: true,
        hostPageId: 'host',
        databases: {accounts: 'db-a', transactions: 'db-t', postings: 'db-p', reconciliations: 'db-r'},
      }),
      ledgerListAccounts: async () => accounts,
      ledgerGetTransaction: async () => ({...draft} as unknown as LedgerTransaction),
      ledgerUpdateDraft: updateDraft,
      ledgerPostTransaction: post,
      putAsset,
    } as unknown as DataClient;
    return {client, putAsset, updateDraft, post};
  }

  async function mountJournal(client: DataClient): Promise<void> {
    await syncPlugins(client);
    const def = getCustomBlock('openbook.ledger/journal-entry');
    expect(def).toBeDefined();
    const props = new Map<string, unknown>([['ledgerDraftId', 'draft-1']]);
    const block = {get: (key: string) => (key === 'props' ? props : undefined)} as never;
    const editor = {readOnly: false, doc: {transact: (fn: () => void) => fn()}} as never;
    // `uploadPageId` names the page the upload refs — the host binding a real
    // page supplies; a test harness passes it explicitly.
    render(React.createElement(def!.render, {block, editor, pageReadOnly: false, uploadPageId: 'page-1'} as never));
    await waitFor(() => expect(document.querySelector('[data-ledger-post]')).not.toBeNull());
    // The stored draft has been read back (rows populated from postings).
    await waitFor(() => expect(document.querySelectorAll('[data-ledger-account]').length).toBe(2));
  }

  it('a balanced entry into an evidence-required account is dead until a receipt is attached — and posts after', async () => {
    const {client, putAsset, updateDraft, post} = journalClient();
    await mountJournal(client);

    // The gate: dead button, its reason wired, and the reason names the account.
    const postButton = el<HTMLButtonElement>('[data-ledger-post]');
    await waitFor(() => expect(postButton.disabled).toBe(true));
    expect(postButton.getAttribute('data-ledger-post-off')).toBe('evidence-required');
    const whyId = postButton.getAttribute('aria-describedby');
    expect(whyId).toBeTruthy();
    const why = document.getElementById(whyId!);
    expect(why?.textContent).toContain('Expenses:Travel');
    expect(why?.textContent).toMatch(/attach a receipt/i);

    // The client-side negative: pressing the dead button posts nothing.
    fireEvent.click(postButton);
    expect(post).not.toHaveBeenCalled();

    // Attach a real file through the input.
    const input = el<HTMLInputElement>('[data-ledger-evidence-file]');
    const file = new File([new Uint8Array([1, 2, 3])], 'receipt.pdf', {type: 'application/pdf'});
    fireEvent.change(input, {target: {files: [file]}});

    await waitFor(() => expect(putAsset).toHaveBeenCalled());
    // The manifest patch carried the content hash + display name, nothing else.
    await waitFor(() =>
      expect(updateDraft).toHaveBeenCalledWith('draft-1', {evidence: [{sha256: SHA_A, filename: 'receipt.pdf'}]}),
    );
    // The attachment renders, and the gate lifts.
    await screen.findByText('receipt.pdf');
    await waitFor(() => expect(el<HTMLButtonElement>('[data-ledger-post]').disabled).toBe(false));

    fireEvent.click(el('[data-ledger-post]'));
    await waitFor(() => expect(post).toHaveBeenCalledWith('draft-1'));
    // Posted: the block resets, evidence list included.
    await screen.findByText(/Posted as entry #7/);
    expect(document.querySelector('[data-ledger-evidence-item]')).toBeNull();
  });

  it('detaching the only receipt drops the gate back down', async () => {
    const {client, updateDraft} = journalClient();
    await mountJournal(client);
    const input = el<HTMLInputElement>('[data-ledger-evidence-file]');
    fireEvent.change(input, {target: {files: [new File([new Uint8Array([1])], 'r.pdf', {type: 'application/pdf'})]}});
    await screen.findByText('r.pdf');
    await waitFor(() => expect(el<HTMLButtonElement>('[data-ledger-post]').disabled).toBe(false));

    fireEvent.click(el(`[data-ledger-evidence-detach="${SHA_A}"]`));
    await waitFor(() => expect(updateDraft).toHaveBeenCalledWith('draft-1', {evidence: []}));
    await waitFor(() => expect(el<HTMLButtonElement>('[data-ledger-post]').disabled).toBe(true));
    expect(el('[data-ledger-post]').getAttribute('data-ledger-post-off')).toBe('evidence-required');
  });
});
