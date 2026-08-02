import React from 'react';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {storedLedgerPlugin as storedPlugin, loadLedgerPlugin} from './ledgerPluginFixture';
import type {DataClient, LedgerVerifyReport} from '@book.dev/sdk';
import {LedgerError} from '@book.dev/sdk';
import {syncPlugins} from '../host';
import {getCustomBlock} from '../../blockeditor/registry';

/**
 * LGR-13 — the Beancount EXPORT & VERIFY block, through the REAL loader on the
 * SHIPPED sources.
 *
 * Pinned here (the export bytes themselves are the sdk/server suites' job):
 *  - one press runs BOTH halves and reports both: the journal downloads and
 *    the verifier's verdict renders beside the export notice;
 *  - a verify REFUSAL (the report is admin-gated on shared servers) downgrades
 *    to a named notice — the export still completes, nothing is silent;
 *  - verifier FINDINGS render as an alert naming the damage;
 *  - a refused export (the corrupt-book stance) is an alert, and no download
 *    is delivered;
 *  - the uninitialized state gates its ONE write control (SetupPrompt) on
 *    `pageReadOnly` — the document's real lock, not `editor.readOnly`.
 */

const CLEAN_REPORT: LedgerVerifyReport = {
  initialized: true,
  checkedTransactions: 3,
  checkedPostings: 6,
  checkedAccounts: 4,
  checkedAuditEvents: 9,
  checkedPeriods: 1,
  checkedEvidence: 0,
  findings: [],
};

const JOURNAL = [
  '; OpenBook ledger — Beancount export (LGR-13).',
  'option "title" "OpenBook ledger"',
  '',
  '2026-01-01 open Assets:Cash USD',
  '',
  '2026-01-05 * "Invoice 1"',
  '  Assets:Cash  100.00 USD',
  '  Income:Sales  -100.00 USD',
  '',
].join('\n');

function fakeClient(opts: {exportFails?: boolean; verifyFails?: boolean; report?: LedgerVerifyReport; initialized?: boolean} = {}) {
  const exportBeancount = vi.fn(async () => JOURNAL);
  if (opts.exportFails) {
    exportBeancount.mockRejectedValue(
      new LedgerError('account-not-found', 'posting p-9 references unknown account a-9 — run the ledger verifier'),
    );
  }
  const verify = vi.fn(async () => opts.report ?? CLEAN_REPORT);
  if (opts.verifyFails) verify.mockRejectedValue(new Error('OpenBook request failed (403 Forbidden): only the instance owner or an admin can export or import the whole library'));
  const client = {
    listPlugins: async () => [storedPlugin()],
    subscribeRows: () => () => {},
    ledgerInfo: async () =>
      opts.initialized === false
        ? {exists: false, hostPageId: null, databases: null}
        : {exists: true, hostPageId: 'host', databases: {accounts: 'db-a', transactions: 'db-t', postings: 'db-p', reconciliations: 'db-r'}},
    ledgerListAccounts: async () => [
      {id: 'cash', name: 'Assets:Cash', type: 'asset', status: 'open', currency: 'USD', createdAt: '', updatedAt: ''},
    ],
    ledgerListTransactions: async () => [
      {id: 't1', date: '2026-01-05', description: 'Invoice 1', state: 'posted', entryNo: 1, postings: []},
    ],
    ledgerListReconciliations: async () => [],
    ledgerListPeriods: async () => [],
    ledgerExportBeancount: exportBeancount,
    ledgerVerify: verify,
  } as unknown as DataClient;
  return {client, exportBeancount, verify};
}

/** happy-dom has no object URLs; stub the whole download delivery path. */
function stubDownload() {
  const createObjectURL = vi.fn(() => 'blob:stub');
  const revokeObjectURL = vi.fn();
  (URL as unknown as Record<string, unknown>).createObjectURL = createObjectURL;
  (URL as unknown as Record<string, unknown>).revokeObjectURL = revokeObjectURL;
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  return {createObjectURL, revokeObjectURL, click};
}

async function mountBlock(client: DataClient, pageReadOnly = false): Promise<void> {
  await syncPlugins(client);
  const def = getCustomBlock('openbook.ledger/beancount-export');
  expect(def).toBeDefined();
  const props = new Map<string, unknown>();
  const block = {get: (key: string) => (key === 'props' ? props : key === 'id' ? 'blk-beancount' : undefined)} as never;
  // `editor.readOnly` is FALSE on purpose: the document's real lock arrives as
  // `pageReadOnly` (the LGR-23 rule this suite keeps every block honest on).
  const editor = {readOnly: false, doc: {transact: (fn: () => void) => fn()}} as never;
  render(React.createElement(def!.render, {block, editor, pageReadOnly}));
}

const el = <T extends HTMLElement>(selector: string): T => {
  const found = document.querySelector<T>(selector);
  expect(found, selector).not.toBeNull();
  return found!;
};

afterEach(async () => {
  cleanup();
  // Dispose the plugin between tests: `syncPlugins` caches by plugin id, so a
  // second mount would otherwise keep the FIRST test's client (and its mocks).
  await syncPlugins({listPlugins: async () => []} as unknown as DataClient);
  vi.restoreAllMocks();
});

describe('LGR-13 — Beancount export block', () => {
  it('one press exports (download delivered) AND verifies, reporting both', async () => {
    const download = stubDownload();
    const {client, exportBeancount, verify} = fakeClient();
    await mountBlock(client);
    await screen.findByText(/Download the whole book as a Beancount journal/);

    fireEvent.click(el('[data-ledger-beancount-run]'));
    await waitFor(() => expect(el('[data-ledger-beancount-done]')).toBeTruthy());
    expect(exportBeancount).toHaveBeenCalledTimes(1);
    expect(verify).toHaveBeenCalledTimes(1);
    expect(el('[data-ledger-beancount-done]').textContent).toMatch(/Exported ledger\.beancount — 1 transaction, [\d,]+ bytes/);
    await waitFor(() => expect(el('[data-ledger-beancount-verify]')).toBeTruthy());
    expect(el('[data-ledger-beancount-verify]').getAttribute('data-ledger-beancount-verify')).toBe('clean');
    expect(el('[data-ledger-beancount-verify]').textContent).toMatch(/Verifier: clean — 3 transactions, 6 postings and 9 audit events/);
    expect(download.createObjectURL).toHaveBeenCalledTimes(1);
    expect(download.click).toHaveBeenCalledTimes(1);
    expect(download.revokeObjectURL).toHaveBeenCalledTimes(1);
  });

  it('a verify refusal downgrades to a NAMED notice while the export still completes', async () => {
    stubDownload();
    const {client} = fakeClient({verifyFails: true});
    await mountBlock(client);
    await screen.findByText(/Download the whole book/);

    fireEvent.click(el('[data-ledger-beancount-run]'));
    await waitFor(() => expect(el('[data-ledger-beancount-done]')).toBeTruthy());
    const verdict = el('[data-ledger-beancount-verify]');
    expect(verdict.getAttribute('data-ledger-beancount-verify')).toBe('unavailable');
    expect(verdict.textContent).toMatch(/Verifier unavailable to this account/);
    expect(verdict.textContent).toMatch(/export completed without it/);
  });

  it('verifier FINDINGS render as an alert naming the damage', async () => {
    stubDownload();
    const {client} = fakeClient({
      report: {
        ...CLEAN_REPORT,
        findings: [
          {code: 'unbalanced', message: 'transaction t-3 sums to 500'},
          {code: 'entry-no-gap', message: 'entry numbers skip 7'},
        ],
      },
    });
    await mountBlock(client);
    await screen.findByText(/Download the whole book/);

    fireEvent.click(el('[data-ledger-beancount-run]'));
    await waitFor(() => expect(el('[data-ledger-beancount-verify]')).toBeTruthy());
    const verdict = el('[data-ledger-beancount-verify]');
    expect(verdict.getAttribute('data-ledger-beancount-verify')).toBe('findings');
    expect(verdict.getAttribute('role')).toBe('alert');
    expect(verdict.textContent).toMatch(/2 findings — this export is a copy of a damaged book/);
    expect(verdict.textContent).toContain('unbalanced: transaction t-3 sums to 500');
  });

  it('a refused export (corrupt book) is an alert, and no download is delivered', async () => {
    const download = stubDownload();
    const {client, verify} = fakeClient({exportFails: true});
    await mountBlock(client);
    await screen.findByText(/Download the whole book/);

    fireEvent.click(el('[data-ledger-beancount-run]'));
    await waitFor(() => expect(el('[data-ledger-beancount-error]')).toBeTruthy());
    expect(el('[data-ledger-beancount-error]').textContent).toMatch(/unknown account a-9/);
    expect(download.createObjectURL).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
    expect(document.querySelector('[data-ledger-beancount-done]')).toBeNull();
  });

  it('uninitialized: the SetupPrompt gates on pageReadOnly (the LGR-23 rule)', async () => {
    const {client} = fakeClient({initialized: false});
    await mountBlock(client, true);
    await screen.findByText(/The books are not set up yet/);
    const setup = el<HTMLButtonElement>('[data-ledger-setup-button]');
    expect(setup.disabled).toBe(true);
    expect(document.querySelector('[data-ledger-setup-why="read-only"]')).not.toBeNull();
  });

  it('the sentence builders hold their shapes (through the real loader)', () => {
    const plugin = loadLedgerPlugin().exports as {
      countBeancountTransactions: (j: string) => number;
      describeBeancountExport: (j: string) => string;
      describeVerifyOutcome: (r: LedgerVerifyReport) => {state: string; text: string; details: string[]};
    };
    expect(plugin.countBeancountTransactions(JOURNAL)).toBe(1);
    expect(plugin.describeBeancountExport(JOURNAL)).toMatch(/1 transaction, [\d,]+ bytes/);
    const many = plugin.describeVerifyOutcome({
      ...CLEAN_REPORT,
      findings: Array.from({length: 5}, (_, i) => ({code: 'unbalanced', message: `t-${i}`})),
    });
    expect(many.state).toBe('findings');
    expect(many.details).toHaveLength(4); // three named + "+ 2 more"
    expect(many.details[3]).toBe('+ 2 more');
  });
});
