import React from 'react';
import {formatAmount} from '@book.dev/plugin-sdk';
import {buildTrialBalance, describeDraftExclusion, describeTrialBalanceAssertion, type TrialBalance} from './reports';
import {
  AccountName,
  EmptyState,
  ReportError,
  SetupPrompt,
  SideAmount,
  SrOnly,
  TableRegion,
  TruncationNotice,
  frameStyle,
  mutedStyle,
  noticeStyle,
  numericHeadStyle,
  numericStyle,
  readBool,
  readProps,
  tableStyle,
  tdStyle,
  thStyle,
  titleStyle,
  useLedgerReport,
  wrapStyle,
  writeProp,
  type BlockLike,
  type EditorLike,
} from './reportShell';

/**
 * The TRIAL BALANCE block (LGR-8) — read-only, live, and computed entirely by
 * the pure folds in `./reports`.
 *
 * What it asserts: Σ debits − Σ credits = 0. That total is not decoration — it
 * is the report's whole reason to exist, so it is stated as an assertion and,
 * when it fails, said LOUDLY, specifically, and with the OFFENDING ENTRIES
 * NAMED: every posted entry is balance-enforced, so a nonzero total means
 * particular entries have lost postings, and the report already holds the data
 * to point at them. A nonzero total is a books-are-broken signal, never a UI
 * error.
 *
 * Sign display is account-type aware: assets/expenses are debit-normal,
 * liabilities/equity/revenue credit-normal, and a balance sitting on the wrong
 * side is marked — outside the numeric column, so the marker never pushes the
 * decimals of the one row a reader most wants to compare.
 *
 * Drafts are excluded (the server-enforced books are the POSTED books) and the
 * exclusion is labelled on every render, including when there are no drafts.
 */

const PROP_SHOW_ZERO = 'ledgerTbShowZero';

/**
 * The caption must not assert more than the read supports. It is a function of
 * BOTH flags: a truncated read has not seen every account, and with zero-balance
 * accounts hidden the table is not "every account with activity" either. It
 * renders below the truncation notice, so if it claimed completeness it would be
 * the last thing read — and it would win.
 */
export function describeTrialBalanceScope(report: TrialBalance, opts: {truncated: boolean; showZero: boolean}): string {
  const accounts = opts.showZero ? 'Every account' : 'Every account with a non-zero balance';
  const source = opts.truncated
    ? `from the ${report.postingCount} postings in the partial read below — NOT the whole book`
    : `from all ${report.postingCount} posted postings`;
  return `${accounts}, ${source}.`;
}

/** The abnormal-balance marker, kept OUT of the numeric flow (see D4). */
const AbnormalMark = ({row}: {row: TrialBalance['rows'][number]}) => (
  <span
    style={{
      // A fixed-width leading box, present on every row: the glyph can then
      // never add advance width to the number beside it, so the decimals of an
      // abnormal row stay in the same column as every other row's.
      display: 'inline-block',
      width: '1em',
      marginRight: '0.15rem',
      textAlign: 'left',
      color: 'hsl(var(--destructive))',
    }}
  >
    {row.abnormal ? (
      <>
        <span aria-hidden="true">⚠</span>
        <SrOnly>
          Abnormal: this {row.type ?? 'ledger'} balance sits on the {row.normalSide === 'debit' ? 'credit' : 'debit'} side.
        </SrOnly>
      </>
    ) : (
      ' '
    )}
  </span>
);

export const TrialBalanceBlock = ({block, editor, pageReadOnly}: {block: BlockLike; editor: EditorLike; pageReadOnly?: boolean}) => {
  const data = useLedgerReport();
  // MAY THIS READER WRITE? Not "is this widget frozen?". The editor handed to a
  // custom block on a read-only page deliberately reports `readOnly: false` so
  // the report stays browsable, so `editor.readOnly` is FALSE on exactly the
  // page where the setup control must be off and the zero-rows toggle must not
  // persist — the host passes the document's real lock separately. (Optional,
  // and defaulted, for a test harness with no host to ask.)
  const pageLocked = pageReadOnly ?? editor.readOnly;
  const [showZero, setShowZero] = React.useState<boolean>(() => readBool(readProps(block), PROP_SHOW_ZERO, false));

  const toggleZero = (next: boolean): void => {
    setShowZero(next);
    writeProp(block, editor, PROP_SHOW_ZERO, next, pageLocked);
  };

  // The fold can reject stored data that is not a safe integer of minor units
  // (the money core refuses to total what it cannot add exactly). Surface that
  // as a report failure instead of tearing the document's render down.
  let report: TrialBalance | null = null;
  let foldError: string | null = null;
  try {
    report = buildTrialBalance(data.accounts, data.transactions, {includeZero: showZero});
  } catch (err) {
    foldError = err instanceof Error ? err.message : String(err);
  }

  if (data.state === 'loading') {
    return (
      <div data-ledger-trial-balance data-ledger-loading contentEditable={false} style={frameStyle}>
        <span style={mutedStyle}>Loading trial balance…</span>
      </div>
    );
  }

  if (data.state === 'uninitialized') {
    return (
      <div data-ledger-trial-balance data-ledger-setup contentEditable={false} style={frameStyle}>
        <h3 style={titleStyle}>
          <span aria-hidden="true">📒 </span>Trial balance
        </h3>
        <SetupPrompt label="Set up books" readOnly={pageLocked} onDone={data.reload} />
      </div>
    );
  }

  const assertion = report !== null ? describeTrialBalanceAssertion(report) : null;
  const anyAbnormal = report !== null && report.rows.some((r) => r.abnormal);

  return (
    <div data-ledger-trial-balance contentEditable={false} style={frameStyle}>
      <div style={{display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap'}}>
        <h3 style={titleStyle}>
          <span aria-hidden="true">📒 </span>Trial balance
        </h3>
        <label style={{...mutedStyle, marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '0.35rem', cursor: 'pointer'}}>
          <input type="checkbox" data-ledger-show-zero checked={showZero} onChange={(e) => toggleZero(e.target.checked)} />
          Show zero-balance accounts
        </label>
      </div>

      {/* The exclusion is stated on EVERY render — a report you cannot tie back
          to what you typed is worse than no report. */}
      <div data-ledger-drafts-excluded={report !== null ? report.draftCount : 0} style={mutedStyle}>
        {describeDraftExclusion(report !== null ? report.draftCount : 0)}
      </div>

      <TruncationNotice shown={data.truncated} detail="Older entries are missing from these balances, so the totals are a subset of the book." />

      {data.error !== null && <ReportError kind="host" detail={data.error} onRetry={data.reload} />}
      {foldError !== null && <ReportError kind="fold" detail={foldError} onRetry={data.reload} />}

      {report !== null && assertion !== null && (
        <>
          {/* aria-live polite (never `alert`): this line re-renders on every
              ledger change, and an assertive region would interrupt constantly. */}
          <div data-ledger-assertion data-ledger-balanced={assertion.ok ? 'true' : 'false'} role="status" aria-live="polite" style={noticeStyle(assertion.ok ? 'quiet' : 'alarm')}>
            <div>{assertion.text}</div>
            {assertion.culprits != null && (
              <div data-ledger-culprits style={{marginTop: '0.35rem', fontWeight: 400}}>
                {assertion.culprits}
              </div>
            )}
          </div>

          {/* Directly above the table it explains — the row it is about is the
              FIRST one, and an explanation hundreds of pixels below it reads as
              a rendering bug rather than a finding. */}
          {report.unknownAccountIds.length > 0 && (
            <div data-ledger-unknown-accounts={report.unknownAccountIds.length} role="status" aria-live="polite" style={noticeStyle('info')}>
              {/* Both sentences branch on the count, not just the first: one
                  deleted account has one balance, and "Their balances are" over
                  a single row reads as a rendering bug in a report whose whole
                  claim is that it is careful with numbers. */}
              {report.unknownAccountIds.length === 1
                ? 'One account was deleted while postings still referenced it. Its balance is listed below and included in the totals, so the assertion stays honest.'
                : `${report.unknownAccountIds.length} accounts were deleted while postings still referenced them. Their balances are listed below and included in the totals, so the assertion stays honest.`}
            </div>
          )}

          {report.rows.length === 0 ? (
            <EmptyState>
              {report.postingCount === 0
                ? 'No posted entries yet — post a journal entry and its balances appear here.'
                : 'Every account nets to zero. Tick “Show zero-balance accounts” to list them anyway.'}
            </EmptyState>
          ) : (
            <TableRegion label="Trial balance table">
              <table style={tableStyle}>
                <caption style={{...mutedStyle, textAlign: 'left', paddingBottom: '0.25rem'}}>
                  {describeTrialBalanceScope(report, {truncated: data.truncated, showZero})}
                </caption>
                <thead>
                  <tr>
                    <th scope="col" style={thStyle}>
                      Account
                    </th>
                    <th scope="col" style={thStyle}>
                      Type
                    </th>
                    <th scope="col" style={numericHeadStyle}>
                      Debit
                    </th>
                    <th scope="col" style={numericHeadStyle}>
                      Credit
                    </th>
                    <th scope="col" style={numericHeadStyle}>
                      Balance
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {report.rows.map((row) => (
                    <tr key={row.accountId} data-ledger-tb-row={row.accountId} {...(row.known ? {} : {'data-ledger-unknown-account': true})}>
                      <th
                        scope="row"
                        style={{
                          ...tdStyle,
                          ...wrapStyle,
                          fontWeight: 400,
                          textAlign: 'left',
                          // A deleted account is a real finding, so the row
                          // carries a finding's weight instead of looking like
                          // a stray id someone forgot to resolve.
                          ...(row.known ? {} : {borderLeft: '3px solid hsl(var(--destructive))', paddingLeft: '0.35rem'}),
                        }}
                      >
                        <AccountName name={row.name} />
                      </th>
                      <td style={{...tdStyle, ...mutedStyle}}>{row.type ?? '—'}</td>
                      <td data-ledger-tb-debit style={numericStyle}>{row.debitMinor === 0 ? '' : formatAmount(row.debitMinor)}</td>
                      <td data-ledger-tb-credit style={numericStyle}>{row.creditMinor === 0 ? '' : formatAmount(row.creditMinor)}</td>
                      <td data-ledger-tb-balance {...(row.abnormal ? {'data-ledger-abnormal': true} : {})} style={numericStyle}>
                        <AbnormalMark row={row} />
                        {/* The side the balance is ACTUALLY on, always. Projecting
                            onto the account's normal side instead rendered an
                            overdrawn asset as “-1,950.00 Dr” — a negative on the
                            side it is not on — and an unknown-type account as
                            “-7.00 Cr” for a 7.00 debit. The type-awareness is
                            carried by the ⚠ and its legend, which is what makes
                            it legible; the number just says where the money is. */}
                        <SideAmount minor={row.balanceMinor} />
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr data-ledger-tb-totals>
                    <th scope="row" colSpan={2} style={{...tdStyle, textAlign: 'left', fontWeight: 600, borderTop: '2px solid hsl(var(--border))', borderBottom: 'none'}}>
                      Totals
                    </th>
                    <td data-ledger-total-debit style={{...numericStyle, fontWeight: 600, borderTop: '2px solid hsl(var(--border))', borderBottom: 'none'}}>
                      {formatAmount(report.totalDebitMinor)}
                    </td>
                    <td data-ledger-total-credit style={{...numericStyle, fontWeight: 600, borderTop: '2px solid hsl(var(--border))', borderBottom: 'none'}}>
                      {formatAmount(report.totalCreditMinor)}
                    </td>
                    {/* Same grammar as the column above it: the difference is a
                        signed quantity, and rendering it bare made it read as a
                        magnitude in a column of side-labelled ones — while its
                        decimals sat 17px off the column they belong to. The
                        BALANCED case is a zero, so it needs the trailing box
                        too (see {@link SideAmount}) or the everyday state is
                        the one that breaks the column. */}
                    <td data-ledger-difference={report.differenceMinor} style={{...numericStyle, fontWeight: 600, borderTop: '2px solid hsl(var(--border))', borderBottom: 'none'}}>
                      <span style={{display: 'inline-block', width: '1em', marginRight: '0.15rem'}} aria-hidden="true">
                        {' '}
                      </span>
                      <SideAmount minor={report.differenceMinor} />
                    </td>
                  </tr>
                </tfoot>
              </table>
            </TableRegion>
          )}

          {report.hiddenZeroCount > 0 && (
            <div data-ledger-hidden-zero={report.hiddenZeroCount} style={mutedStyle}>
              {report.hiddenZeroCount === 1 ? '1 zero-balance account hidden.' : `${report.hiddenZeroCount} zero-balance accounts hidden.`}
            </div>
          )}
          {/* The ⚠ is a mark, not a legend — so when any row carries one, say
              what it means in words rather than leaving a glyph to be guessed. */}
          {anyAbnormal && (
            <div data-ledger-abnormal-legend style={mutedStyle}>
              ⚠ marks a balance on the opposite side to the account type’s normal side (for example an overdrawn asset).
            </div>
          )}
        </>
      )}
    </div>
  );
};
