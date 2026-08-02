import React from 'react';
import {describeDraftExclusion} from './reports';
import {
  buildIncomeStatement,
  describeClosingExclusion,
  describeIncomeScope,
  describeIncomeUnclassified,
  describeNetIncome,
  describeReconciliation,
  flattenHierarchy,
  hierarchyParentPaths,
  latestPeriod,
  leafRows,
  reconcileNetIncome,
  startOfYear,
  type IncomeStatement,
  type NetIncomeReconciliation,
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
import {describeClosedPeriodMarker} from './periods';
import {todayIso} from './model';

/**
 * The INCOME STATEMENT block (LGR-9) — revenue and expenses OVER A DATE RANGE
 * with the colon hierarchy rolled up, a net income line, and the sentence that
 * ties that line back to the balance sheet.
 *
 * THE RECONCILIATION is the point of the footer: total equity as of the end of
 * the period, less total equity immediately before it, equals net income plus
 * whatever was posted directly to equity accounts. That is an identity, not an
 * approximation, so the footer can state it as a fact — and when nothing was
 * contributed or drawn, it collapses to "the equity movement IS this net
 * income", which is the check a reader can run across the two blocks by eye.
 *
 * All arithmetic lives in `./statements`; this file renders strings and never
 * adds two amounts together.
 */

const PROP_FROM = 'ledgerIsFrom';
const PROP_TO = 'ledgerIsTo';
const PROP_ROLLED = 'ledgerIsRolled';
const PROP_COLLAPSED = 'ledgerIsCollapsed';

/**
 * The period the block opens on when the document has not pinned one: TODAY's
 * year to date (1 January through today).
 *
 * On the same wall clock as the balance sheet's as-at default, deliberately. A
 * genuinely empty year-to-date window IS reachable here in a way it is not on
 * the balance sheet (every January, on any book) — but splitting the defaults
 * would put a balance sheet and a P&L in one document on two different dates,
 * with the P&L's closing equity disagreeing with Total equity on screen for no
 * visible reason. The empty window is handled where it happens instead: the
 * empty state offers a one-click PIN of the latest period.
 */
export function defaultPeriod(): {from: string; to: string} {
  const today = todayIso();
  return {from: startOfYear(today), to: today};
}

function sectionLines(section: StatementSection, rolled: boolean, collapsed: ReadonlySet<string>, emptyText: string): StatementLine {
  return {
    kind: 'section',
    key: section.key,
    title: section.title,
    rows: rolled ? flattenHierarchy(section.nodes, collapsed) : leafRows(section.nodes),
    emptyText,
  };
}

export const IncomeStatementBlock = ({block, editor, pageReadOnly}: {block: BlockLike; editor: EditorLike; pageReadOnly?: boolean}) => {
  const data = useLedgerReport();
  // MAY THIS READER WRITE? Not "is this widget frozen?". The editor handed to a
  // custom block on a read-only page deliberately reports `readOnly: false` so
  // the report stays browsable, so `editor.readOnly` is FALSE on exactly the
  // page where the setup control must be off and the period must not persist —
  // the host passes the document's real lock separately. (Optional, and
  // defaulted, for a test harness with no host to ask.)
  const pageLocked = pageReadOnly ?? editor.readOnly;
  const props = readProps(block);
  const [fromProp, setFromProp] = React.useState<string>(() => readString(props, PROP_FROM));
  const [toProp, setToProp] = React.useState<string>(() => readString(props, PROP_TO));
  const [rolled, setRolled] = React.useState<boolean>(() => readBool(readProps(block), PROP_ROLLED, true));
  const [collapsed, setCollapsed] = React.useState<Set<string>>(() => parseCollapsed(readString(props, PROP_COLLAPSED)));

  const today = todayIso();
  const defaults = defaultPeriod();
  const defaulted = fromProp === '' && toProp === '';
  const from = fromProp === '' ? defaults.from : fromProp;
  const to = toProp === '' ? defaults.to : toProp;
  // Used ONLY by the empty state's recovery action and the off-today notices —
  // never as a default.
  const latest = latestPeriod(data.transactions);
  const periodIsLatest = latest !== null && latest.from === from && latest.to === to;

  /**
   * Pin the period AS A UNIT: whichever end the reader touched, the other end's
   * currently RESOLVED value is written too.
   *
   * Writing only the edited end left the block in a state it could not describe:
   * `defaulted` went false (so the "year to date" notice vanished) while the
   * untouched end was still a live default. Both boxes showed a date, Reset was
   * offered, and nothing said one end still floated — so posting an entry in a
   * later year moved `From` underneath the reader while `To` stayed put, and the
   * period silently rescoped. Pinning as a unit is what makes this block's own
   * promise — that it stops moving the moment a date is picked — true.
   */
  const pinPeriod = (nextFrom: string, nextTo: string): void => {
    setFromProp(nextFrom);
    setToProp(nextTo);
    writeProp(block, editor, PROP_FROM, nextFrom, pageLocked);
    writeProp(block, editor, PROP_TO, nextTo, pageLocked);
  };

  const updateCollapsed = (next: Set<string>): void => {
    setCollapsed(next);
    writeProp(block, editor, PROP_COLLAPSED, serializeCollapsed(next), pageLocked);
  };

  const toggle = (path: string): void => {
    const next = new Set(collapsed);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    updateCollapsed(next);
  };

  let statement: IncomeStatement | null = null;
  let reconciliation: NetIncomeReconciliation | null = null;
  let foldError: string | null = null;
  try {
    statement = buildIncomeStatement(data.accounts, data.transactions, {from, to});
    reconciliation = reconcileNetIncome(data.accounts, data.transactions, {from, to});
  } catch (err) {
    foldError = err instanceof Error ? err.message : String(err);
  }

  if (data.state === 'loading') {
    return (
      <div data-ledger-income-statement data-ledger-loading contentEditable={false} style={frameStyle}>
        <span style={mutedStyle}>Loading income statement…</span>
      </div>
    );
  }

  if (data.state === 'uninitialized') {
    return (
      <div data-ledger-income-statement data-ledger-setup contentEditable={false} style={frameStyle}>
        <h3 style={titleStyle}>
          <span aria-hidden="true">📒 </span>Income statement
        </h3>
        <SetupPrompt label="Set up books" readOnly={pageLocked} onDone={data.reload} />
      </div>
    );
  }

  const parentPaths = statement === null ? [] : [...hierarchyParentPaths(statement.revenue.nodes), ...hierarchyParentPaths(statement.expenses.nodes)];
  const incomeUnclassified = statement !== null ? describeIncomeUnclassified(statement) : null;

  const lines: StatementLine[] = [];
  if (statement !== null) {
    lines.push(sectionLines(statement.revenue, rolled, collapsed, 'No revenue accounts.'));
    lines.push({kind: 'line', key: 'revenue', label: 'Total revenue', minor: statement.totalRevenueMinor, rule: true});
    lines.push(sectionLines(statement.expenses, rolled, collapsed, 'No expense accounts.'));
    lines.push({kind: 'line', key: 'expenses', label: 'Total expenses', minor: statement.totalExpensesMinor, rule: true});
    // THE BOTTOM LINE, INSIDE THE TABLE — the same `strong + rule` pattern the
    // balance sheet uses for "Total liabilities and equity".
    //
    // It used to be a flex `<div>` below the table, which put the one number the
    // report exists to produce 7–8px right of the column of 16 amounts directly
    // above it, on exactly the vertical scan a reader runs from Total expenses.
    // It also sat outside `TableRegion`, so in a narrow block the column could
    // scroll away from underneath it. In the table it inherits `numericStyle`'s
    // padding, the scroll container, and real `<th scope="row">`/`<td>`
    // semantics — one move, three problems.
    //
    // A profit is a CREDIT to equity, rendered from the fold's debit-positive
    // `netIncomeDebitMinor`: the view never re-signs an amount to draw it.
    lines.push({
      kind: 'line',
      key: 'net-income',
      label: statement.profit ? 'Net income' : 'Net loss',
      minor: statement.netIncomeDebitMinor,
      strong: true,
      rule: true,
    });
  }

  return (
    <div data-ledger-income-statement contentEditable={false} style={frameStyle}>
      <div style={{display: 'flex', alignItems: 'flex-end', gap: '0.75rem', flexWrap: 'wrap'}}>
        <h3 style={{...titleStyle, lineHeight: '1.9rem'}}>
          <span aria-hidden="true">📒 </span>Income statement
        </h3>
        <label style={{display: 'flex', flexDirection: 'column', gap: '0.2rem'}}>
          <span style={mutedStyle}>From</span>
          <input type="date" data-ledger-period-from style={controlStyle} value={from} onChange={(e) => pinPeriod(e.target.value, to)} />
        </label>
        <label style={{display: 'flex', flexDirection: 'column', gap: '0.2rem'}}>
          <span style={mutedStyle}>To</span>
          <input type="date" data-ledger-period-to style={controlStyle} value={to} onChange={(e) => pinPeriod(from, e.target.value)} />
        </label>
        {!defaulted && (
          <button type="button" data-ledger-reset-period style={buttonStyle} onClick={() => pinPeriod('', '')}>
            Back to this year
          </button>
        )}
      </div>

      {defaulted && (
        <div data-ledger-period-defaulted style={mutedStyle}>
          This year to date ({from} → {to}). Pick dates above to pin the period.
        </div>
      )}

      {/* Same rule, and both directions, as the balance sheet's: a pinned period
          that is not the current one is a report of another time, and it must
          not be mistaken for "now" in either direction. */}
      {!defaulted && to < today && (
        <div data-ledger-period-backdated style={mutedStyle}>
          {periodIsLatest ? `Your latest posted period (${from} → ${to})` : `Period ${from} → ${to}`} — ends before today ({today}).
        </div>
      )}
      {!defaulted && to > today && (
        <div data-ledger-period-ahead style={mutedStyle}>
          {periodIsLatest ? `Your latest posted period (${from} → ${to})` : `Period ${from} → ${to}`} — runs past today ({today}); it includes entries that have not happened yet.
        </div>
      )}

      <div data-ledger-drafts-excluded={statement !== null ? statement.draftCount : 0} style={mutedStyle}>
        {describeDraftExclusion(statement !== null ? statement.draftCount : 0)}
        {statement !== null && statement.outsideCount > 0 && (
          <span data-ledger-outside-period>
            {' '}
            {statement.outsideCount === 1 ? '1 posted entry is' : `${statement.outsideCount} posted entries are`} outside this period.
          </span>
        )}
      </div>

      {/* LGR-12, display-only: the range crossing a closed period is a fact a
          reader needs (entries there are locked), and the closing-entry
          exclusion is a disclosure the figures owe. Neither gates anything —
          the store enforces the lock. */}
      {describeClosedPeriodMarker(data.periods, from, to) !== null && (
        <div data-ledger-closed-periods style={mutedStyle}>{describeClosedPeriodMarker(data.periods, from, to)}</div>
      )}
      {statement !== null && describeClosingExclusion(statement.closingCount) !== null && (
        <div data-ledger-closing-excluded={statement.closingCount} style={mutedStyle}>{describeClosingExclusion(statement.closingCount)}</div>
      )}

      <TruncationNotice shown={data.truncated} detail="Older entries are missing, so revenue, expenses and the net income below are a subset of the period." />

      {data.error !== null && <ReportError kind="host" detail={data.error} onRetry={data.reload} />}
      {foldError !== null && <ReportError kind="fold" detail={foldError} onRetry={data.reload} />}

      {statement !== null && (
        <>
          {/* The bottom line, above the table as well as in it: it is what the
              report is read for, and a reader should not have to scroll a long
              chart of accounts to find out whether the period made money. */}
          <div
            data-ledger-net-income={statement.netIncomeMinor}
            data-ledger-profit={statement.profit ? 'true' : 'false'}
            role="status"
            aria-live="polite"
            style={noticeStyle('quiet')}
          >
            {describeNetIncome(statement)}
          </div>

          {/* What deleted accounts cost THESE figures — not just the tie. `info`,
              never `alarm`: a damaged chart is a standing caveat, and the alarm
              tone stays reserved for a book that does not balance. */}
          {incomeUnclassified !== null && (
            <div data-ledger-income-unclassified role="status" aria-live="polite" style={noticeStyle('info')}>
              {incomeUnclassified}
            </div>
          )}

          {statement.postingCount === 0 ? (
            <EmptyState>
              {/* The recovery PINS the latest period, so a stale report is
                  always a choice the reader made — and the backdating notice
                  above then says so. */}
              {latest !== null && (latest.to > to || latest.to < from) ? (
                <>
                  Nothing was posted to a revenue or expense account between {from} and {to} — this book’s latest posted entry is {latest.to}.{' '}
                  <button type="button" data-ledger-show-latest style={{...buttonStyle, marginLeft: '0.25rem'}} onClick={() => pinPeriod(latest.from, latest.to)}>
                    Show your latest period instead — through {latest.to}
                  </button>
                </>
              ) : (
                'No posted revenue or expense entries yet — post a journal entry touching an income or expense account and it appears here.'
              )}
            </EmptyState>
          ) : (
            <>
              <ShapeControls
                rolled={rolled}
                onRolled={(next) => {
                  setRolled(next);
                  writeProp(block, editor, PROP_ROLLED, next, pageLocked);
                }}
                onCollapseAll={() => updateCollapsed(new Set(parentPaths))}
                onExpandAll={() => updateCollapsed(new Set())}
                parentCount={parentPaths.length}
              />
              <StatementTable
                label="Income statement table"
                caption={describeIncomeScope(statement, {truncated: data.truncated, rolled, unclassified: statement.unknownAccountIds.length > 0})}
                lines={lines}
                onToggle={toggle}
              />
            </>
          )}

          {reconciliation !== null && (
            <div data-ledger-reconciliation data-ledger-reconciles={reconciliation.reconciles ? 'true' : 'false'} style={mutedStyle}>
              {describeReconciliation(reconciliation)}
              {reconciliation.unclassifiedMinor !== 0 && (
                <span data-ledger-reconciliation-caveat> Balances on deleted accounts sit in neither figure, so the tie is approximate until the chart of accounts is repaired.</span>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
};
