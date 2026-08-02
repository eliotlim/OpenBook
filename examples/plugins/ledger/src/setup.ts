import type {api} from '@book.dev/plugin-sdk';
import {STARTER_CHART} from './model';

/**
 * "Ledger: set up books" — seed the ledger databases (server-side idempotent)
 * and the starter chart of accounts. IDEMPOTENT end to end: accounts are
 * keyed by their hierarchical name, so a re-run creates nothing new.
 */
export async function setUpBooks(ledger: (typeof api)['ledger']): Promise<{created: number}> {
  await ledger.init();
  const existing = new Set((await ledger.listAccounts()).map((account) => account.name));
  let created = 0;
  for (const starter of STARTER_CHART) {
    if (existing.has(starter.name)) continue;
    await ledger.createAccount({name: starter.name, type: starter.type});
    created += 1;
  }
  return {created};
}
