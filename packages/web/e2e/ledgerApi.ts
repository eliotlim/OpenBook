import {expect} from './fixtures';
import {SERVER} from './seed';
import type {APIRequestContext, Page} from '@playwright/test';

/**
 * The ledger e2e harness: seeding through the REAL HTTP ledger API, and the
 * slash-menu insertion every report spec starts with.
 *
 * Shared by every ledger spec — reports (LGR-8), statements (LGR-9), journal
 * (LGR-5) and bank import (LGR-10) — for the same reason `ledgerPlugin.ts`
 * exists: two copies of a helper that talks to a versioned API is a
 * desynchronisation waiting to happen, and it surfaces as an unrelated red spec
 * in whichever file was not updated.
 */

export interface ApiAccount {
  id: string;
  name: string;
}
export interface ApiPosting {
  id: string;
  accountId: string;
  amountMinor: number;
  cleared: string;
}
export interface ApiTransaction {
  id: string;
  state: string;
  entryNo: number | null;
  postings: ApiPosting[];
}

export interface EntryInput {
  date: string;
  description: string;
  postings: Array<{accountId: string; amountMinor: number; cleared?: string}>;
}

/** Idempotent: accounts are keyed by their hierarchical name, exactly as setup is. */
export async function ensureAccount(request: APIRequestContext, name: string, type: string): Promise<string> {
  await request.post(`${SERVER}/api/ledger`);
  const existing = (await (await request.get(`${SERVER}/api/ledger/accounts`)).json()) as ApiAccount[];
  const found = existing.find((a) => a.name === name);
  if (found) return found.id;
  const res = await request.post(`${SERVER}/api/ledger/accounts`, {data: {name, type}});
  return ((await res.json()) as ApiAccount).id;
}

/** Create a draft and post it atomically — the same two ops the journal block uses. */
export async function postEntry(request: APIRequestContext, entry: EntryInput): Promise<ApiTransaction> {
  const draft = (await (await request.post(`${SERVER}/api/ledger/transactions`, {data: entry})).json()) as ApiTransaction;
  return (await (await request.post(`${SERVER}/api/ledger/transactions/${draft.id}/post`)).json()) as ApiTransaction;
}

export async function createDraft(request: APIRequestContext, entry: EntryInput): Promise<ApiTransaction> {
  return (await (await request.post(`${SERVER}/api/ledger/transactions`, {data: entry})).json()) as ApiTransaction;
}

export const draftCount = async (request: APIRequestContext): Promise<number> =>
  ((await (await request.get(`${SERVER}/api/ledger/transactions?state=draft`)).json()) as ApiTransaction[]).length;

/** Run a command-palette command by its exact title. */
export async function runPaletteCommand(page: Page, title: string): Promise<void> {
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByPlaceholder(/Search pages or run a command/).fill(title);
  await page.getByRole('option', {name: new RegExp(title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))}).click();
}

/** A fresh page hosting one report block, inserted through the slash menu. */
export async function pageWithBlock(page: Page, request: APIRequestContext, name: string, slash: string, label: string, marker: string): Promise<string> {
  const res = await request.post(`${SERVER}/api/pages`, {
    data: {name, data: {editor: 'blocks', blockdoc: {blocks: [{id: 'p1', type: 'paragraph', text: [{t: ''}]}]}, editorjs: {blocks: []}, values: [], names: []}},
  });
  const {id} = (await res.json()) as {id: string};
  await page.goto(`/?page=${id}`);
  await expect(page.locator('.obe-text').first()).toBeVisible();
  await page.locator('.obe-text').first().click();
  // Retry the slash insertion: right after hydration the first keystrokes can
  // land before the editor (or the plugin's slash contribution) is live.
  const item = page.locator('.obe-slash-item', {has: page.locator('.obe-slash-label', {hasText: label})});
  for (let attempt = 0; ; attempt += 1) {
    await page.keyboard.type(slash);
    try {
      await expect(item.first()).toBeVisible({timeout: 3000});
      break;
    } catch (err) {
      if (attempt >= 2) throw err;
      await page.keyboard.press('Escape');
      for (let i = 0; i < slash.length; i += 1) await page.keyboard.press('Backspace');
    }
  }
  await item.first().click();
  await expect(page.locator(marker)).toBeVisible();
  return id;
}

/**
 * A payload the server will never produce, served to the real block.
 *
 * The damaged/truncated states are unreachable through the API by construction —
 * the server refuses to post an unbalanced entry, exposes no account delete, and
 * the truncation cap needs a thousand entries — yet they are precisely the states
 * where a report either raises the alarm or fails to. Intercepting the
 * transaction LIST (nothing else) renders the real block and the real fold
 * against them.
 */
export async function serveTransactions(page: Page, transactions: unknown[]): Promise<void> {
  await page.route('**/api/ledger/transactions**', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    await route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify(transactions)});
  });
}

export const wirePosting = (id: string, accountId: string, amountMinor: number, cleared = 'pending') => ({
  id,
  transactionId: 't',
  accountId,
  amountMinor,
  cleared,
  reconciliationId: null,
});

export const wirePosted = (over: Record<string, unknown>) => ({
  id: 'tx',
  date: '2026-03-04',
  description: 'Entry',
  state: 'posted',
  postedAt: '2026-03-04T00:00:00.000Z',
  postedBy: 'tester',
  reverses: null,
  entryNo: 1,
  evidence: [],
  postings: [],
  createdAt: '2026-03-04T00:00:00.000Z',
  updatedAt: '2026-03-04T00:00:00.000Z',
  ...over,
});
