import React from 'react';
import {describeDraftExclusion} from './reports';
import {
  CURRENT_EARNINGS_LABEL,
  buildBalanceSheet,
  describeAsOfExclusion,
  describeBalanceSheetAssertion,
  describeBalanceSheetScope,
  describeCurrentEarnings,
  flattenHierarchy,
  hierarchyParentPaths,
  latestReportedDate,
  leafRows,
  type BalanceSheet,
  type StatementSection,
} from './statements';
import {ShapeControls, StatementTable, parseCollapsed, serializeCollapsed, type StatementLine} from './statementShell';
import {
  EmptyState,
  ReportError,
  SetupPrompt,
  TruncationNotice,
  buttonStyle,
  controlStyle,
  frameStyle,
  mutedStyle,
  noticeStyle,
  readBool,
  readProps,
  readString,
  titleStyle,
  useLedgerReport,
  writeProp,
  type BlockLike,
  type EditorLike,
} from './reportShell';
import {todayIso} from './model';

/**
 * The BALANCE SHEET block (LGR-9) — the ledger's position AS OF A DATE, with
 * the colon hierarchy rolled up, read-only and live.
 *
 * What it asserts: ASSETS = LIABILITIES + EQUITY. That identity is the report's
 * reason to exist, so — exactly like the trial balance's zero total — it is
 * stated as an assertion and, when it fails, said LOUDLY and with the CAUSE
 * NAMED. A nonzero difference is never a UI failure: every posted entry is
 * balance-enforced by the server, so it means specific entries have lost
 * postings (named via `findUnbalancedEntries`) or a posting is stranded on a
 * deleted account (named separately, because it is a different repair).
 *
 * Equity includes a computed CURRENT EARNINGS line — revenue less expenses to
 * the as-of date. Without it the identity is out by the period's profit on every
 * real book, and a balance sheet that never balances teaches its reader to
 * ignore the one line they should never ignore.
 *
 * All arithmetic lives in `./statements`; this file renders strings and never
 * adds two amounts together.
 */

const PROP_AS_OF = 'ledgerBsAsOf';
const PROP_ROLLED = 'ledgerBsRolled';
const PROP_COLLAPSED = 'ledgerBsCollapsed';

/**
 * The as-of date the block opens on when the document has not pinned one: TODAY.
 *
 * Not "the latest posted entry", which this block used to do. Two reasons, and
 * the first kills the argument the old default was built on:
 *
 *  · `transactionsAsOf` is `tx.date <= asOf`, so a balance sheet dated today on a
 *    book last touched months ago is FULLY POPULATED and numerically identical
 *    to the latest-entry version. "Today opens empty" is only true when EVERY
 *    entry is future-dated — which is what the empty state below is for.
 *  · `latestReportedDate` maxes over reported entries INCLUDING future-dated
 *    ones, so a single post-dated invoice silently pulled money that has not
 *    happened yet into the default position.
 *
 * The income statement defaults to today's year-to-date for the same reason and
 * on the same clock, so a balance sheet and a P&L in one document are never on
 * two different dates with a silently disagreeing equity figure between them.
 *
 * When the defaulted window really is empty, the empty state offers a one-click
 * PIN of the latest period — recovery as an explicit, recorded choice rather
 * than a default nobody asked for.
 */
export function defaultAsOf(): string {
  return todayIso();
}

/** A section as statement lines, in whichever shape the reader asked for. */
function sectionLines(section: StatementSection, rolled: boolean, collapsed: ReadonlySet<string>, emptyText: string): StatementLine {
  return {
    kind: 'section',
    key: section.key,
    title: section.title,
    rows: rolled ? flattenHierarchy(section.nodes, collapsed) : leafRows(section.nodes),
    emptyText,
  };
}

export const BalanceSheetBlock = ({block, editor}: {block: BlockLike; editor: EditorLike}) => {
  const data = useLedgerReport();
  const props = readProps(block);
  const [asOfProp, setAsOfProp] = React.useState<string>(() => readString(props, PROP_AS_OF));
  const [rolled, setRolled] = React.useState<boolean>(() => readBool(readProps(block), PROP_ROLLED, true));
  const [collapsed, setCollapsed] = React.useState<Set<string>>(() => parseCollapsed(readString(props, PROP_COLLAPSED)));

  const today = todayIso();
  const defaulted = asOfProp === '';
  const asOf = defaulted ? defaultAsOf() : asOfProp;
  // The book's latest posted entry — used ONLY by the empty state's recovery
  // action and by the backdating notice, never as a default.
  const latest = latestReportedDate(data.transactions);

  const updateAsOf = (value: string): void => {
    setAsOfProp(value);
    writeProp(block, editor, PROP_AS_OF, value);
  };

  const updateCollapsed = (next: Set<string>): void => {
    setCollapsed(next);
    writeProp(block, editor, PROP_COLLAPSED, serializeCollapsed(next));
  };

  const toggle = (path: string): void => {
    const next = new Set(collapsed);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    updateCollapsed(next);
  };

  // Same discipline as LGR-8: a stored amount the money core refuses to add is a
  // report failure, not a crashed document.
  let sheet: BalanceSheet | null = null;
  let foldError: string | null = null;
  try {
    sheet = buildBalanceSheet(data.accounts, data.transactions, {asOf});
  } catch (err) {
    foldError = err instanceof Error ? err.message : String(err);
  }

  if (data.state === 'loading') {
    return (
      <div data-ledger-balance-sheet data-ledger-loading contentEditable={false} style={frameStyle}>
        <span style={mutedStyle}>Loading balance sheet…</span>
      </div>
    );
  }

  if (data.state === 'uninitialized') {
    return (
      <div data-ledger-balance-sheet data-ledger-setup contentEditable={false} style={frameStyle}>
        <h3 style={titleStyle}>
          <span aria-hidden="true">📒 </span>Balance sheet
        </h3>
        <SetupPrompt label="Set up books" readOnly={editor.readOnly} onDone={data.reload} />
      </div>
    );
  }

  const assertion = sheet !== null ? describeBalanceSheetAssertion(sheet, {truncated: data.truncated}) : null;
  const parentPaths = sheet === null ? [] : [...hierarchyParentPaths(sheet.assets.nodes), ...hierarchyParentPaths(sheet.liabilities.nodes), ...hierarchyParentPaths(sheet.equity.nodes)];
  const asOfNote = sheet !== null ? describeAsOfExclusion(sheet) : null;

  const lines: StatementLine[] = [];
  if (sheet !== null) {
    lines.push(sectionLines(sheet.assets, rolled, collapsed, 'No asset accounts.'));
    lines.push({kind: 'line', key: 'assets', label: 'Total assets', minor: sheet.totalAssetsMinor, rule: true});
    lines.push(sectionLines(sheet.liabilities, rolled, collapsed, 'No liability accounts.'));
    lines.push({kind: 'line', key: 'liabilities', label: 'Total liabilities', minor: sheet.totalLiabilitiesMinor, rule: true});
    lines.push(sectionLines(sheet.equity, rolled, collapsed, 'No equity accounts.'));
    lines.push({
      kind: 'line',
      key: 'current-earnings',
      label: CURRENT_EARNINGS_LABEL,
      minor: sheet.currentEarningsMinor,
      // Computed, not stored — and the starter chart ships a real
      // `Equity:RetainedEarnings` account, so saying which is which matters.
      // The note also states the SPAN, because "current" is a period word and
      // this figure has no period until closing entries exist (LGR-12) — and the
      // span is truncation-aware, because a partial read drops the OLDEST
      // entries, i.e. exactly the ones "from the first posted entry" names.
      note: describeCurrentEarnings(sheet, {truncated: data.truncated}),
    });
    lines.push({kind: 'line', key: 'equity', label: 'Total equity', minor: sheet.totalEquityMinor, rule: true});
    if (sheet.unclassified.accountCount > 0) {
      lines.push(sectionLines(sheet.unclassified, rolled, collapsed, 'None.'));
      lines.push({kind: 'line', key: 'unclassified', label: 'Total unclassified', minor: sheet.unclassifiedMinor, note: 'Outside the identity above — these balances have no account.', rule: true});
    }
    lines.push({kind: 'line', key: 'liabilities-and-equity', label: 'Total liabilities and equity', minor: sheet.liabilitiesAndEquityMinor, strong: true, rule: true});
  }

  return (
    <div data-ledger-balance-sheet contentEditable={false} style={frameStyle}>
      <div style={{display: 'flex', alignItems: 'flex-end', gap: '0.75rem', flexWrap: 'wrap'}}>
        <h3 style={{...titleStyle, lineHeight: '1.9rem'}}>
          <span aria-hidden="true">📒 </span>Balance sheet
        </h3>
        <label style={{display: 'flex', flexDirection: 'column', gap: '0.2rem'}}>
          <span style={mutedStyle}>As at</span>
          <input type="date" data-ledger-as-of style={controlStyle} value={asOf} onChange={(e) => updateAsOf(e.target.value)} />
        </label>
        {!defaulted && (
          <button type="button" data-ledger-reset-as-of style={{...mutedStyle, border: 'none', background: 'transparent', padding: 0, textDecoration: 'underline', cursor: 'pointer'}} onClick={() => updateAsOf('')}>
            Back to today
          </button>
        )}
      </div>

      {/* A defaulted date is a CHOICE the reader did not make — say so. */}
      {defaulted && (
        <div data-ledger-as-of-defaulted style={mutedStyle}>
          Dated to today ({asOf}). Pick a date above to pin it.
        </div>
      )}

      {/* OFF TODAY, in EITHER direction — the most misreadable state this block
          has: a fully-populated position that is not today's, with nothing on
          screen saying so. Behind the clock it is stale; AHEAD of it, it counts
          money that has not happened yet — which is precisely the trap the old
          latest-entry default walked into, since a single post-dated invoice
          moved the whole position. Say which, whenever it applies. */}
      {!defaulted && asOf < today && (
        <div data-ledger-as-of-backdated style={mutedStyle}>
          {latest === asOf ? `Dated to your latest posted entry (${asOf})` : `Dated ${asOf}`} — not today ({today}).
        </div>
      )}
      {!defaulted && asOf > today && (
        <div data-ledger-as-of-ahead style={mutedStyle}>
          {latest === asOf ? `Dated to your latest posted entry (${asOf})` : `Dated ${asOf}`} — ahead of today ({today}); this position includes entries that have not happened yet.
        </div>
      )}

      <div data-ledger-drafts-excluded={sheet !== null ? sheet.draftCount : 0} style={mutedStyle}>
        {describeDraftExclusion(sheet !== null ? sheet.draftCount : 0)}
        {asOfNote !== null && <span data-ledger-as-of-excluded> {asOfNote}</span>}
      </div>

      <TruncationNotice shown={data.truncated} detail="Older entries are missing from these balances, so every figure below — and the identity itself — covers only part of the book." />

      {data.error !== null && <ReportError kind="host" detail={data.error} onRetry={data.reload} />}
      {foldError !== null && <ReportError kind="fold" detail={foldError} onRetry={data.reload} />}

      {sheet !== null && assertion !== null && (
        <>
          {/* polite, never `alert`: this line re-renders on every ledger change. */}
          <div data-ledger-identity data-ledger-balanced={assertion.ok ? 'true' : 'false'} role="status" aria-live="polite" style={noticeStyle(assertion.ok ? 'quiet' : 'alarm')}>
            <div>{assertion.text}</div>
            {assertion.culprits != null && (
              <div data-ledger-culprits style={{marginTop: '0.35rem', fontWeight: 400}}>
                {assertion.culprits}
              </div>
            )}
            {assertion.unclassified != null && (
              <div data-ledger-unclassified-cause style={{marginTop: '0.35rem', fontWeight: 400}}>
                {assertion.unclassified}
              </div>
            )}
          </div>

          {sheet.postingCount === 0 ? (
            <EmptyState>
              {/* The recovery, not a redirect: clicking PINS the latest period,
                  so a stale position is always a choice the reader made and can
                  see they made (the backdating notice above says so). */}
              {latest !== null && latest > asOf ? (
                <>
                  Nothing was posted on or before {asOf} — this book’s latest posted entry is {latest}.{' '}
                  <button type="button" data-ledger-show-latest style={{...buttonStyle, marginLeft: '0.25rem'}} onClick={() => updateAsOf(latest)}>
                    Show your latest period instead — through {latest}
                  </button>
                </>
              ) : (
                'No posted entries yet — post a journal entry and this position appears here.'
              )}
            </EmptyState>
          ) : (
            <>
              <ShapeControls
                rolled={rolled}
                onRolled={(next) => {
                  setRolled(next);
                  writeProp(block, editor, PROP_ROLLED, next);
                }}
                onCollapseAll={() => updateCollapsed(new Set(parentPaths))}
                onExpandAll={() => updateCollapsed(new Set())}
                parentCount={parentPaths.length}
              />
              <StatementTable label="Balance sheet table" caption={describeBalanceSheetScope(sheet, {truncated: data.truncated, rolled})} lines={lines} onToggle={toggle} />
            </>
          )}
        </>
      )}
    </div>
  );
};
