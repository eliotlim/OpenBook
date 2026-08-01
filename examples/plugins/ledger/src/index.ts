import {api} from '@book.dev/plugin-sdk';
import {JournalEntryBlock} from './block';
import {setUpBooks} from './setup';

/**
 * The first-party ledger extension (LGR-5): registers the JOURNAL ENTRY
 * block — the sole human write surface for the double-entry books — and the
 * idempotent "Ledger: set up books" palette command.
 *
 * The pure Σ/validity logic and the setup routine are re-exported so the
 * host test-suite can drive them through the real plugin loader.
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

  a.commands.register({
    id: 'setup-books',
    title: 'Ledger: set up books',
    keywords: 'ledger accounting books setup init chart of accounts',
    run: () => {
      void setUpBooks(a.ledger);
    },
  });
}
