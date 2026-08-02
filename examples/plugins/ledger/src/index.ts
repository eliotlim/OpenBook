import {api} from '@book.dev/plugin-sdk';
import {JournalEntryBlock} from './block';
import {AccountRegisterBlock} from './register';
import {TrialBalanceBlock} from './trialBalance';
import {setUpBooks} from './setup';

/**
 * The first-party ledger extension: registers the JOURNAL ENTRY block — the
 * sole human write surface for the double-entry books (LGR-5) — the two
 * read-only REPORT blocks (LGR-8: trial balance, account register), and the
 * idempotent "Ledger: set up books" palette command.
 *
 * The pure Σ/validity logic, the report folds and the setup routine are all
 * re-exported so the host test-suite can drive them through the real plugin
 * loader.
 */
export {
  computeEntryStatus,
  describeImbalance,
  describeProblem,
  normalizeCell,
  isEntryDate,
  parseCell,
  rowsToPostings,
  emptyRow,
  todayIso,
  STARTER_CHART,
} from './model';
export {
  ALL_CLEARED_STATES,
  CLEARED_LABEL,
  MAX_NAMED_CULPRITS,
  REPORTED_STATES,
  accountBalances,
  buildAccountRegister,
  buildTrialBalance,
  countDrafts,
  describeContra,
  describeCulprits,
  describeDraftExclusion,
  describeRegisterFilter,
  describeRegisterSummary,
  describeTrialBalanceAssertion,
  describeUnbalancedEntry,
  findUnbalancedEntries,
  formatWithSide,
  isReported,
  normalSideFor,
  registerMatchesAccountBalance,
} from './reports';
// The live-data hook is exported for the host test-suite: its staleness and
// teardown behaviour under overlapping loads is correctness, not presentation,
// so it is driven directly rather than inferred from a rendered block.
export {useLedgerReport, REPORT_TX_LIMIT} from './reportShell';
export {setUpBooks} from './setup';

export default function activate(a: typeof api) {
  a.blocks.register({
    type: 'journal-entry',
    render: JournalEntryBlock,
    slash: {
      label: 'Journal entry',
      hint: 'Record a balanced double-entry transaction',
      keywords: 'ledger journal entry debit credit books accounting transaction',
      // Non-empty seed props: an empty object would leave the block without a
      // props CRDT map, and the draft/memo persistence would have nowhere to
      // write (makeBlock only creates the map for non-empty props).
      make: () => ({type: 'openbook.ledger/journal-entry', props: {ledgerRows: ''}}),
    },
  });

  // The read-only reports (LGR-8). Both are computed from postings by the pure
  // folds in `./reports` — `expr`/rollup cannot aggregate across rows (see
  // docs/ledger/platform-audit.md), so reports are plugin-rendered by design.
  a.blocks.register({
    type: 'trial-balance',
    render: TrialBalanceBlock,
    slash: {
      label: 'Trial balance',
      hint: 'Every account’s balance, asserted to sum to zero',
      keywords: 'ledger trial balance report accounting debits credits books',
      // Non-empty seed props: an empty object leaves the block without a props
      // CRDT map, and the report's controls would have nowhere to persist.
      make: () => ({type: 'openbook.ledger/trial-balance', props: {ledgerTbShowZero: false}}),
    },
  });

  a.blocks.register({
    type: 'account-register',
    render: AccountRegisterBlock,
    slash: {
      label: 'Account register',
      hint: 'One account’s postings with a running balance',
      keywords: 'ledger account register report postings running balance statement reconcile',
      make: () => ({type: 'openbook.ledger/account-register', props: {ledgerRegAccount: ''}}),
    },
  });

  a.commands.register({
    id: 'setup-books',
    title: 'Ledger: set up books',
    keywords: 'ledger accounting books setup init chart of accounts',
    run: () => {
      void setUpBooks(a.ledger);
    },
  });
}
