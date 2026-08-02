import {api} from '@book.dev/plugin-sdk';
import {JournalEntryBlock} from './block';
import {AccountRegisterBlock} from './register';
import {BalanceSheetBlock} from './balanceSheet';
import {IncomeStatementBlock} from './incomeStatement';
import {TrialBalanceBlock} from './trialBalance';
import {BankImportBlock} from './importBlock';
import {ReconcileBlock} from './reconcileBlock';
import {setUpBooks} from './setup';

/**
 * The first-party ledger extension: registers the JOURNAL ENTRY block (LGR-5 —
 * the sole human write surface for the double-entry books), the four read-only
 * REPORT blocks (LGR-8: trial balance, account register; LGR-9: balance sheet,
 * income statement), the BANK IMPORT block (LGR-10 — the surface that keeps the
 * books being used past month two), the RECONCILE block (LGR-11 — the surface
 * that proves the books agree with the bank), and the idempotent "Ledger: set
 * up books" palette command.
 *
 * The pure Σ/validity logic, the report and statement folds, the import model
 * and the setup routine are all re-exported so the host test-suite can drive
 * them through the real plugin loader.
 */
export {
  computeEntryStatus,
  describeImbalance,
  describeProblem,
  mergeMemosFromDraft,
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
  correctionBlocker,
  countDrafts,
  describeContra,
  describeCorrectionBlocker,
  describeCorrectionConfirm,
  describeCorrectionDone,
  describeCounterpart,
  describeCulprits,
  describeDraftExclusion,
  describeImmutability,
  describeRegisterFilter,
  describeRegisterSummary,
  describeTrialBalanceAssertion,
  describeUnbalancedEntry,
  findUnbalancedEntries,
  formatWithSide,
  isBlockWideBlocker,
  isReported,
  nameEntry,
  normalSideFor,
  registerMatchesAccountBalance,
} from './reports';
// The LGR-9 statement folds: the colon-hierarchy rollup, the balance sheet, the
// income statement, and the net-income ⇄ equity reconciliation that ties them.
export {
  CURRENT_EARNINGS_LABEL,
  HIERARCHY_SEPARATOR,
  buildBalanceSheet,
  buildHierarchy,
  buildIncomeStatement,
  describeAsOfExclusion,
  describeBalanceSheetAssertion,
  describeBalanceSheetScope,
  describeCurrentEarnings,
  describeIncomeScope,
  describeIncomeUnclassified,
  describeNetIncome,
  describePeriod,
  describeReconciliation,
  describeUnclassified,
  directPostingsLabel,
  flattenHierarchy,
  formatCredit,
  hierarchyLeafTotal,
  hierarchyLeaves,
  hierarchyParentPaths,
  hierarchyRolledTotal,
  latestPeriod,
  latestReportedDate,
  leafRows,
  reconcileNetIncome,
  splitAccountPath,
  startOfYear,
  transactionsAsOf,
  transactionsBefore,
  transactionsInRange,
} from './statements';
// The LGR-11 reconciliation fold: the statement-matching arithmetic, the
// normal-side balance parser, and the sentences that narrate the difference.
export {
  RECONCILIATION_STATUS_LABEL,
  RECONCILE_STATES,
  buildReconcileSheet,
  describeBalanceEcho,
  describeBalanceLabel,
  describeDifference,
  describeFinishBlock,
  describeFrozenElsewhere,
  describeGap,
  describeOutstandingHeading,
  describeOutstandingIntro,
  describePositiveMeans,
  describeReconcileSummary,
  describeRowLabel,
  describeSingleCulprit,
  describeUnmatchedCaveat,
  formatOnNormalSide,
  isOutstanding,
  isRowLocked,
  parseStatementBalance,
  statementBalanceInput,
} from './reconcile';
export {parseCollapsed, serializeCollapsed} from './statementShell';
export {defaultAsOf} from './balanceSheet';
export {defaultPeriod} from './incomeStatement';
// The live-data hook is exported for the host test-suite: its staleness and
// teardown behaviour under overlapping loads is correctness, not presentation,
// so it is driven directly rather than inferred from a rendered block.
export {useLedgerReport, REPORT_TX_LIMIT} from './reportShell';
export {
  bareDigitsFor,
  buildConfirmPatch,
  buildConfirmPatchFor,
  buildDraftInput,
  describeImport,
  describePreviewLimit,
  detectProfile,
  emptyKnownImports,
  importableRows,
  importRowHash,
  IMPORT_LIMITS,
  knownFromTransactions,
  learnRule,
  nearDuplicateKey,
  normalizeDescription,
  parseRowAmount,
  parseRowDate,
  prepareImport,
  previewRows,
  readImportCsv,
  reconcileSavedProfile,
  sanitizeText,
  sourceIdForHeader,
  strandedDrafts,
  validateStoredProfile,
} from './importModel';
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
      // props CRDT map, and the raw-cell-text / draft-id persistence would have
      // nowhere to write (makeBlock only creates the map for non-empty props).
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

  a.blocks.register({
    type: 'bank-import',
    render: BankImportBlock,
    slash: {
      label: 'Bank import',
      hint: 'Turn a bank CSV into draft entries, without doubling anything up',
      keywords: 'ledger bank import csv statement transactions reconcile drafts',
      // The import block keeps no CRDT state of its own — the mapping lives in
      // plugin storage (per source) and the drafts live in the ledger — but the
      // props map must still be non-empty for the host to create one.
      make: () => ({type: 'openbook.ledger/bank-import', props: {ledgerImport: '1'}}),
    },
  });

  // The reconcile surface (LGR-11). Not a report: it is the one place the books
  // are checked AGAINST something outside them, which is what makes a month's
  // bookkeeping finished rather than merely entered.
  a.blocks.register({
    type: 'reconcile',
    render: ReconcileBlock,
    slash: {
      label: 'Reconcile',
      hint: 'Match an account against a bank statement, down to a 0.00 difference',
      keywords: 'ledger reconcile reconciliation bank statement match difference clear cleared balance books',
      make: () => ({type: 'openbook.ledger/reconcile', props: {ledgerRecId: ''}}),
    },
  });

  // The two statements a business actually reports (LGR-9). Both roll the
  // colon hierarchy up in a pure fold (`./statements`) for the same reason the
  // LGR-8 reports fold in JS: the platform cannot aggregate across rows, let
  // alone across a name hierarchy.
  a.blocks.register({
    type: 'balance-sheet',
    render: BalanceSheetBlock,
    slash: {
      label: 'Balance sheet',
      hint: 'Assets, liabilities and equity as at a date',
      keywords: 'ledger balance sheet report accounting assets liabilities equity position statement',
      make: () => ({type: 'openbook.ledger/balance-sheet', props: {ledgerBsAsOf: ''}}),
    },
  });

  a.blocks.register({
    type: 'income-statement',
    render: IncomeStatementBlock,
    slash: {
      label: 'Income statement',
      hint: 'Revenue less expenses over a period, with net income',
      keywords: 'ledger income statement profit loss p&l report accounting revenue expenses earnings',
      make: () => ({type: 'openbook.ledger/income-statement', props: {ledgerIsFrom: ''}}),
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
