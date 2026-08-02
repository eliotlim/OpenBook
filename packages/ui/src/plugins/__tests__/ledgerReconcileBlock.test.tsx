import React from 'react';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
// The REAL first-party ledger plugin, byte-for-byte — via the shared fixture,
// whose file list is DERIVED from the package by glob (never hand-listed).
import {storedLedgerPlugin as storedPlugin} from './ledgerPluginFixture';
import type {DataClient, LedgerReconciliation, LedgerTransaction} from '@book.dev/sdk';
import {syncPlugins} from '../host';
import {getCustomBlock} from '../../blockeditor/registry';

/**
 * LGR-22 — the reconcile BLOCK's sub-flow control flow, rendered.
 *
 * The fold is pinned next door in `ledgerReconcile.test.ts`. What lives here is
 * what a pure test cannot reach, and what review found broken twice elsewhere:
 *
 *  - FOCUS across sub-flow transitions. Opening Amend DISABLES the Amend
 *    button — the very element that is focused at that moment — and a browser
 *    answers a focused element going disabled by dumping focus on `<body>`.
 *    Every exit (Cancel, "Keep working on it", "Go back and check", Save,
 *    confirm-abandon) unmounts the focused button, with the same result. The
 *    assertions here are all taken AT the transition — press, then ask where
 *    focus IS — because asserting the target's mere existence stays green
 *    while focus sits on `<body>`, which is exactly how the register block's
 *    earlier tests missed this six times.
 *
 *  - THE FINISH CONFIRM against a double press. The first press opens the
 *    confirm and leaves the Finish button enabled and focused; a habitual
 *    double-click (or double Enter) then took the confirm branch and CERTIFIED
 *    THE BOOKS without the confirm ever being read. Only the confirm's own
 *    button may finish while it is open.
 */

const BANK = 'acct-bank';
const INCOME = 'acct-income';
const REC = 'rec-1';

/** One posted entry with a bank leg (`cleared`) and an income contra. */
const entry = (id: string, amountMinor: number, cleared: 'pending' | 'cleared', description: string): LedgerTransaction =>
  ({
    id,
    date: '2026-03-05',
    description,
    state: 'posted',
    postedAt: '2026-03-05T00:00:00.000Z',
    postedBy: 'tester',
    reverses: null,
    entryNo: 1,
    evidence: [],
    postings: [
      {id: `${id}-bank`, transactionId: id, accountId: BANK, amountMinor, cleared, reconciliationId: null, memo: null},
      {id: `${id}-other`, transactionId: id, accountId: INCOME, amountMinor: -amountMinor, cleared: 'pending', reconciliationId: null, memo: null},
    ],
    createdAt: '',
    updatedAt: '',
  }) as unknown as LedgerTransaction;

/**
 * A scripted ledger holding ONE open reconciliation that is balanced with one
 * unmatched posting — the exact state where Finish is live AND the confirm has
 * something to say. Mutation calls are spies that resolve (or reject, when
 * scripted) so the tests can drive every branch of the block's control flow.
 */
function fakeLedger(opts: {abandonFails?: boolean} = {}) {
  const finish = vi.fn(async () => ({
    reconciliation: {id: REC, accountId: BANK, statementDate: '2026-03-31', statementBalanceMinor: 100_000, status: 'finished', createdAt: '', updatedAt: ''},
    clearedBalanceMinor: 100_000,
    differenceMinor: 0,
    matchedPostingIds: ['tx-1-bank'],
  }));
  const amend = vi.fn(async () => ({
    reconciliation: {id: REC, accountId: BANK, statementDate: '2026-03-31', statementBalanceMinor: 100_000, status: 'open', createdAt: '', updatedAt: ''},
    clearedBalanceMinor: 100_000,
    differenceMinor: 0,
    matchedPostingIds: [],
  }));
  const abandon = vi.fn(async (): Promise<LedgerReconciliation> => {
    if (opts.abandonFails) throw new Error('the ledger refused the abandon');
    return {id: REC, accountId: BANK, statementDate: '2026-03-31', statementBalanceMinor: 100_000, status: 'abandoned', createdAt: '', updatedAt: ''};
  });
  const client = {
    listPlugins: async () => [storedPlugin()],
    subscribeRows: () => () => {},
    ledgerInfo: async () => ({
      exists: true,
      hostPageId: 'host',
      databases: {accounts: 'db-a', transactions: 'db-t', postings: 'db-p', reconciliations: 'db-r'},
    }),
    ledgerListAccounts: async () => [
      {id: BANK, name: 'Assets:Bank:Checking', type: 'asset', status: 'open', currency: 'USD', createdAt: '', updatedAt: ''},
      {id: INCOME, name: 'Income:Revenue', type: 'revenue', status: 'open', currency: 'USD', createdAt: '', updatedAt: ''},
    ],
    ledgerListTransactions: async () => [
      entry('tx-1', 100_000, 'cleared', 'Customer payment'),
      entry('tx-2', -95_000, 'pending', 'Rent — February'),
    ],
    ledgerListReconciliations: async () => [
      {id: REC, accountId: BANK, statementDate: '2026-03-31', statementBalanceMinor: 100_000, status: 'open', createdAt: '', updatedAt: ''},
    ],
    // LGR-12: the shared report hook reads periods alongside everything else.
    ledgerListPeriods: async () => [],
    ledgerFinishReconciliation: finish,
    ledgerAmendReconciliation: amend,
    ledgerAbandonReconciliation: abandon,
  } as unknown as DataClient;
  return {client, finish, amend, abandon};
}

/** Render the registered reconcile block, resumed onto the open statement. */
async function mountBlock(client: DataClient): Promise<void> {
  await syncPlugins(client);
  const def = getCustomBlock('openbook.ledger/reconcile');
  expect(def).toBeDefined();
  const props = new Map<string, unknown>([['ledgerRecId', REC]]);
  const block = {get: (key: string) => (key === 'props' ? props : undefined)} as never;
  const editor = {readOnly: false, doc: {transact: (fn: () => void) => fn()}} as never;
  render(React.createElement(def!.render, {block, editor, pageReadOnly: false}));
  await screen.findByText(/this statement is fully explained/);
}

const el = <T extends HTMLElement>(selector: string): T => {
  const found = document.querySelector<T>(selector);
  expect(found, selector).not.toBeNull();
  return found!;
};

/** Focus THEN click — the sequence a keyboard user actually produces, and the
 *  one that exposes the focused-element-goes-disabled drop. */
const press = (button: HTMLElement): void => {
  button.focus();
  fireEvent.click(button);
};

afterEach(async () => {
  cleanup();
  await syncPlugins({listPlugins: async () => []} as unknown as DataClient);
  vi.restoreAllMocks();
});

describe('LGR-22 — reconcile block focus management across sub-flows', () => {
  it('opening Amend moves focus INTO the form at the moment the invoker is disabled', async () => {
    const {client} = fakeLedger();
    await mountBlock(client);
    press(el('[data-ledger-amend]'));
    // The invoker just went disabled under the user's focus. Without the
    // recorded intent, focus is on <body> now — the assertion is the
    // activeElement, not the form's existence, for exactly that reason.
    expect(el<HTMLButtonElement>('[data-ledger-amend]').disabled).toBe(true);
    await waitFor(() => expect(document.activeElement).toBe(el('[data-ledger-amend-date]')));
  });

  it('Cancel unmounts itself and returns focus to the RE-ENABLED invoker', async () => {
    const {client} = fakeLedger();
    await mountBlock(client);
    press(el('[data-ledger-amend]'));
    await waitFor(() => expect(document.activeElement).toBe(el('[data-ledger-amend-date]')));
    press(el('[data-ledger-amend-cancel]'));
    // The focused Cancel button no longer exists; the invoker is enabled again
    // and holds focus. `.focus()` on a still-disabled element is a silent
    // no-op, so this assertion is also what proves the re-enable happened
    // before the focus call, not after.
    await waitFor(() => {
      expect(document.querySelector('[data-ledger-amend-form]')).toBeNull();
      const invoker = el<HTMLButtonElement>('[data-ledger-amend]');
      expect(invoker.disabled).toBe(false);
      expect(document.activeElement).toBe(invoker);
    });
  });

  it('a saved amend closes the form and lands focus back on Amend, with the patch on the wire', async () => {
    const {client, amend} = fakeLedger();
    await mountBlock(client);
    press(el('[data-ledger-amend]'));
    await waitFor(() => expect(document.activeElement).toBe(el('[data-ledger-amend-date]')));
    fireEvent.change(el('[data-ledger-amend-balance]'), {target: {value: '1,250.00'}});
    press(el('[data-ledger-amend-save]'));
    await waitFor(() => {
      expect(amend).toHaveBeenCalledWith(REC, {statementDate: '2026-03-31', statementBalanceMinor: 125_000});
      expect(document.querySelector('[data-ledger-amend-form]')).toBeNull();
      expect(document.activeElement).toBe(el('[data-ledger-amend]'));
    });
  });

  it('opening Abandon focuses the confirm; declining returns to the invoker; confirming targets the survivor', async () => {
    const {client, abandon} = fakeLedger();
    await mountBlock(client);
    press(el('[data-ledger-abandon]'));
    expect(el<HTMLButtonElement>('[data-ledger-abandon]').disabled).toBe(true);
    await waitFor(() => expect(document.activeElement).toBe(el('[data-ledger-abandon-confirm-yes]')));

    press(el('[data-ledger-abandon-confirm-no]'));
    await waitFor(() => {
      expect(document.querySelector('[data-ledger-abandon-confirm]')).toBeNull();
      expect(document.activeElement).toBe(el('[data-ledger-abandon]'));
    });
    expect(abandon).not.toHaveBeenCalled();

    // Confirm for real. Success targets "Pick another statement" — the one
    // control every status renders — because the Abandon button itself
    // unmounts when the reloaded `abandoned` status lands, on a timetable the
    // component does not control; focus returned there would be dumped on
    // <body> moments later.
    press(el('[data-ledger-abandon]'));
    await waitFor(() => expect(document.activeElement).toBe(el('[data-ledger-abandon-confirm-yes]')));
    press(el('[data-ledger-abandon-confirm-yes]'));
    await waitFor(() => {
      expect(abandon).toHaveBeenCalledTimes(1);
      expect(document.activeElement).toBe(el('[data-ledger-reconcile-close]'));
    });
  });

  it('a REFUSED abandon keeps the confirm open, reports, and re-focuses its primary', async () => {
    const {client, abandon} = fakeLedger({abandonFails: true});
    await mountBlock(client);
    press(el('[data-ledger-abandon]'));
    await waitFor(() => expect(document.activeElement).toBe(el('[data-ledger-abandon-confirm-yes]')));
    press(el('[data-ledger-abandon-confirm-yes]'));
    await screen.findByText(/the ledger refused the abandon/);
    expect(abandon).toHaveBeenCalledTimes(1);
    // The confirm survives the refusal (the user may retry or decline), and
    // its primary — disabled while busy, which dropped focus — is focused
    // again now that it is re-enabled.
    expect(document.querySelector('[data-ledger-abandon-confirm]')).not.toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(el('[data-ledger-abandon-confirm-yes]')));
  });
});

describe('LGR-22 — the Finish confirm is not double-press-able', () => {
  it('a second press of Finish while the confirm is open does NOT certify the books', async () => {
    const {client, finish} = fakeLedger();
    await mountBlock(client);

    // First press: the confirm opens, nothing is finished, and focus moves to
    // the confirm's primary so Enter now means "I have read this".
    press(el('[data-ledger-finish]'));
    expect(finish).not.toHaveBeenCalled();
    expect(document.querySelector('[data-ledger-finish-confirm]')).not.toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(el('[data-ledger-finish-confirm-yes]')));

    // The double press — the habitual second click, or the second Enter of a
    // double-tap on the still-enabled Finish button. It must be a no-op that
    // routes focus back to the confirm, never the commit branch: this is the
    // press that used to finish the books with the confirm unread.
    press(el('[data-ledger-finish]'));
    press(el('[data-ledger-finish]'));
    expect(finish).not.toHaveBeenCalled();
    expect(document.querySelector('[data-ledger-finish-confirm]')).not.toBeNull();
    expect(document.activeElement).toBe(el('[data-ledger-finish-confirm-yes]'));

    // Only the confirm's own button finishes — once.
    press(el('[data-ledger-finish-confirm-yes]'));
    await waitFor(() => expect(finish).toHaveBeenCalledTimes(1));
    // Success targets the surviving control, ahead of the reloaded `finished`
    // status unmounting the Finish button.
    await waitFor(() => expect(document.activeElement).toBe(el('[data-ledger-reconcile-close]')));
  });

  it('"Go back and check" closes the confirm without finishing and returns focus to Finish', async () => {
    const {client, finish} = fakeLedger();
    await mountBlock(client);
    press(el('[data-ledger-finish]'));
    await waitFor(() => expect(document.activeElement).toBe(el('[data-ledger-finish-confirm-yes]')));
    press(el('[data-ledger-finish-confirm-no]'));
    await waitFor(() => {
      expect(document.querySelector('[data-ledger-finish-confirm]')).toBeNull();
      expect(document.activeElement).toBe(el('[data-ledger-finish]'));
    });
    expect(finish).not.toHaveBeenCalled();
  });
});
