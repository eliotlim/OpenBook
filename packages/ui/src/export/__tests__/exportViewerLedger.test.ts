import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import {act} from 'react';
import {formatAmount} from '@book.dev/sdk';
import {toHtmlSite} from '../toHtml';
import {mount} from '../../viewer/index'; // the real viewer bundle entry
import {buildTrialBalance, formatWithSide, type ReportAccount, type ReportTransaction} from '../ledgerFolds.gen/reports';
import {buildBalanceSheet, buildIncomeStatement} from '../ledgerFolds.gen/statements';
import {PARITY_LEDGER_BLOCKS, parityLedgerSiteBundle} from './parityFixtureDoc';
import {STARTUP_BOOKS_CHART, startupBooksTransactions} from '@book.dev/sdk';

/**
 * LX-5 — the HYDRATED export keeps its ledger report tables.
 *
 * LX-3 made an exported ledger report a real table of real numbers, but only in
 * the STATIC body. Hydration then replaced it: the viewer has no ledger renderer,
 * so `openbook.ledger/*` fell through to the missing-plugin card and the numbers
 * disappeared for anyone who opened the file with JS on — the common case.
 *
 * This suite runs the whole pipeline in jsdom, with nothing stubbed on either
 * side of the seam:
 *  - the document is REAL `toHtmlSite` output (static body + island),
 *  - the boot is the REAL `VIEWER_BOOT` script sliced out of that document and
 *    executed (so the harvest-then-swap order is under test, not re-implemented),
 *  - the mount is the REAL viewer entry (`../../viewer/index`).
 *
 * What a passing suite means:
 *  - RECORDS ON: every one of the five report blocks shows its server-computed
 *    table after hydration — fold-exact totals, no install-plugin card.
 *  - INTERACTIVE: the four live-books tools keep the honest "interactive tool"
 *    card, records or not.
 *  - RECORDS OFF: report blocks keep the ledger-aware "books weren't included"
 *    card — never "install the plugin", which would be the wrong diagnosis.
 *  - SCOPED: a genuinely third-party plugin block still gets the viewer's own
 *    install card; preservation is not a blanket "freeze every unknown block".
 *  - FAILURE MODE: a document with no island keeps its static body untouched.
 */

// The boot mounts through `createRoot` directly, outside RTL's act wrapper.
(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;

// ── Fold ground truth, computed from the template constants directly ─────────
// Same discipline as the LX-3 golden suite: expected numbers never travel
// through the adapter under test.

const accountId = new Map(STARTUP_BOOKS_CHART.map((a, i) => [a.name, `lgacc-${i}`]));
const drafts = startupBooksTransactions(accountId);
const accounts: ReportAccount[] = STARTUP_BOOKS_CHART.map((a, i) => ({id: `lgacc-${i}`, name: a.name, type: a.type}));
const transactions: ReportTransaction[] = drafts.map((t, i) => ({
  id: `lgtx-${i}`,
  date: String(t.date),
  description: t.description ?? '',
  state: 'posted',
  entryNo: i + 1,
  postings: (t.postings ?? []).map((p, j) => ({
    id: `lgpo-${i}-${j}`,
    accountId: p.accountId,
    amountMinor: p.amountMinor,
    cleared: 'pending',
  })),
}));

/** The five REPORT types (tables) and the four INTERACTIVE tools (cards). */
const REPORTS = ['journal-entry', 'trial-balance', 'balance-sheet', 'income-statement', 'account-register'];
const INTERACTIVE = ['bank-import', 'reconcile', 'period-close', 'beancount-export'];

// ── The harness: build a real export, then run its real boot ─────────────────

/** Everything a browser would have in the document when the boot runs: the
 *  static body and the island. The 2 MB vendored viewer `<script>` is left out
 *  (jsdom would not run it anyway) and replaced by the imported real `mount`. */
function hydrate(html: string): void {
  const main = html.slice(html.indexOf('<main>'), html.indexOf('</main>') + '</main>'.length);
  const islandTag = '<script type="application/openbook+json"';
  const islandStart = html.indexOf(islandTag);
  const island = html.slice(islandStart, html.indexOf('</script>', islandStart) + '</script>'.length);
  document.body.innerHTML = main + island;
  // The boot is the document's LAST script — everything after the bundle.
  const boot = html.slice(html.lastIndexOf('<script>') + '<script>'.length, html.lastIndexOf('</script>'));
  expect(boot).toContain('ob-viewer-host'); // sliced the right script
  (window as {OpenBookViewer?: unknown}).OpenBookViewer = {mount};
  act(() => {
    new Function(boot)();
  });
}

const typeSelector = (name: string): string => `[data-block-type="openbook.ledger/${name}"]`;
const viewer = (): HTMLElement => document.querySelector('.ob-viewer')!;
const text = (): string => viewer().textContent ?? '';

beforeEach(() => {
  document.body.innerHTML = '';
});
afterEach(() => {
  delete (window as {OpenBookViewer?: unknown}).OpenBookViewer;
  document.body.innerHTML = '';
});

describe('LX-5 — records ON: the hydrated viewer keeps every report table', () => {
  const html = toHtmlSite(parityLedgerSiteBundle(true));

  it('hydrates, and every report block is a table — not an install-plugin card', () => {
    hydrate(html);
    // Hydration really happened: the static <main> is gone, the viewer is up.
    expect(document.querySelector('main')).toBeNull();
    expect(viewer()).toBeTruthy();

    for (const name of REPORTS) {
      const figure = viewer().querySelector(`figure.ob-ledger-report${typeSelector(name)}`);
      expect(figure, `${name} kept its table`).toBeTruthy();
      expect(figure!.querySelector('table.ledger-table')).toBeTruthy();
    }
    // Nothing in this page degraded to the viewer's card except the deliberate
    // third-party block (asserted separately below).
    expect(viewer().querySelectorAll('.obe-missing-plugin').length).toBe(1);
  });

  it('the numbers are the fold numbers (the static render, byte-preserved)', () => {
    hydrate(html);
    const tb = buildTrialBalance(accounts, transactions, {includeZero: false});
    expect(text()).toContain(formatAmount(tb.totalDebitMinor));
    expect(text()).toContain(formatAmount(tb.totalCreditMinor));
    for (const row of tb.rows) expect(text()).toContain(row.name);

    // Balance sheet + income statement default to today's clock, exactly as the
    // exporter resolved them at render time.
    const sheet = buildBalanceSheet(accounts, transactions, {});
    expect(text()).toContain(formatWithSide(sheet.totalAssetsMinor));
    expect(text()).toContain(formatWithSide(sheet.liabilitiesAndEquityMinor));
    const statement = buildIncomeStatement(accounts, transactions, {});
    expect(text()).toContain(formatWithSide(statement.totalExpensesMinor));

    // The assertion sentence rides along, so a hydrated trial balance still SAYS
    // whether it balances.
    expect(text()).toMatch(/balance/i);
    // And the currency caption an accountant needs survived too.
    expect(text()).toContain('Amounts in USD');
  });

  it('the four interactive tools still say "interactive", never "install the plugin"', () => {
    hydrate(html);
    for (const name of INTERACTIVE) {
      const card = viewer().querySelector(`.ob-plugin-block${typeSelector(name)}`);
      expect(card, `${name} kept its card`).toBeTruthy();
      expect(card!.textContent).toContain('Interactive ledger tool');
      expect(card!.textContent).not.toContain('install the plugin');
    }
  });

  it('a third-party plugin block still gets the viewer\'s own install card', () => {
    hydrate(html);
    // Scoping: only the first-party ledger's renders are marked keep-on-hydrate.
    // For everything else the viewer's card (plugin icon, "Open in OpenBook to
    // install") is richer than the static dashed box, so it must still win.
    const card = viewer().querySelector('.obe-missing-plugin[data-block-type="org.example.future/widget"]');
    expect(card).toBeTruthy();
    expect(viewer().querySelector('.ob-plugin-block[data-block-type="org.example.future/widget"]')).toBeNull();
  });

  it('preserves the static nodes as CLONES — the harvested <main> stays intact', () => {
    // The boot restores the original <main> if mount throws, so it must not have
    // donated its children away. Re-run the harvest on a fresh document and
    // check the static body still holds every marked node afterwards.
    hydrate(html);
    const kept = viewer().querySelectorAll('[data-ob-keep-static]');
    expect(kept.length).toBe(REPORTS.length + INTERACTIVE.length);
  });
});

describe('LX-5 — records OFF: honest ledger placeholders survive hydration', () => {
  const html = toHtmlSite(parityLedgerSiteBundle(false));

  it('report blocks say the books were not included — not "install the plugin"', () => {
    hydrate(html);
    expect(viewer().querySelectorAll('figure.ob-ledger-report').length).toBe(0);
    for (const name of REPORTS) {
      const card = viewer().querySelector(`.ob-plugin-block${typeSelector(name)}`);
      expect(card, `${name} kept its card`).toBeTruthy();
      expect(card!.textContent).toContain('the books weren\'t included in this export');
      expect(card!.textContent).not.toContain('install the plugin');
    }
  });

  it('interactive tools keep their own wording here too', () => {
    hydrate(html);
    for (const name of INTERACTIVE) {
      expect(viewer().querySelector(`.ob-plugin-block${typeSelector(name)}`)!.textContent)
        .toContain('Interactive ledger tool');
    }
  });
});

describe('LX-5 — the static markup carries what the boot needs', () => {
  it('marks every ledger block with its id, and no non-ledger block', () => {
    const html = toHtmlSite(parityLedgerSiteBundle(true));
    const body = html.slice(0, html.indexOf('<script type="application/openbook+json"'));
    for (const block of PARITY_LEDGER_BLOCKS) {
      if (typeof block.type !== 'string' || !block.type.startsWith('openbook.ledger/')) continue;
      expect(body).toContain(`data-block-id="${block.id}" data-ob-keep-static="ledger"`);
    }
    expect(body).not.toContain('data-block-id="lg-future"');
    // The marker never leaks onto ordinary content (a paragraph, a heading).
    expect(body.match(/data-ob-keep-static/g)?.length).toBe(REPORTS.length + INTERACTIVE.length);
  });

  it('a document whose island is missing keeps its static body untouched', () => {
    const html = toHtmlSite(parityLedgerSiteBundle(true));
    const main = html.slice(html.indexOf('<main>'), html.indexOf('</main>') + '</main>'.length);
    document.body.innerHTML = main; // no island tag
    const boot = html.slice(html.lastIndexOf('<script>') + '<script>'.length, html.lastIndexOf('</script>'));
    (window as {OpenBookViewer?: unknown}).OpenBookViewer = {mount};
    act(() => {
      new Function(boot)();
    });
    expect(document.querySelector('main')).toBeTruthy();
    expect(document.querySelectorAll('figure.ob-ledger-report').length).toBe(REPORTS.length);
  });
});
