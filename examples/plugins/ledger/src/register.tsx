import React from 'react';
import {formatAmount} from '@book.dev/plugin-sdk';
import {
  ALL_CLEARED_STATES,
  CLEARED_LABEL,
  buildAccountRegister,
  describeDraftExclusion,
  describeRegisterFilter,
  describeRegisterSummary,
  formatWithSide,
  registerMatchesAccountBalance,
  type AccountRegister,
  type ReportClearedState,
} from './reports';
import {
  AccountName,
  EmptyState,
  ReportError,
  SetupPrompt,
  SideAmount,
  SrOnly,
  TableRegion,
  TruncationNotice,
  buttonStyle,
  controlStyle,
  frameStyle,
  mutedStyle,
  noticeStyle,
  numericHeadStyle,
  numericStyle,
  readProps,
  readString,
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
 * The ACCOUNT REGISTER block (LGR-8) — one account's postings in date order
 * with a running balance, read-only and live.
 *
 * Filters are DATE RANGE and CLEARED STATE, and neither one is allowed to lie
 * about the running balance: postings before the range are carried in as an
 * opening balance, and the footer states plainly when the closing figure is a
 * filtered subset rather than the account's real posted balance (the number the
 * trial balance shows). Drafts are excluded and the exclusion is labelled.
 *
 * All arithmetic lives in `./reports`; this file renders strings and never adds
 * two amounts together.
 */

const PROP_ACCOUNT = 'ledgerRegAccount';
const PROP_FROM = 'ledgerRegFrom';
const PROP_TO = 'ledgerRegTo';
const PROP_CLEARED = 'ledgerRegCleared';

/** `"cleared,reconciled"` ⇄ the typed state list (unknown words are dropped). */
function parseClearedProp(raw: string): ReportClearedState[] {
  const wanted = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  const kept = ALL_CLEARED_STATES.filter((state) => wanted.includes(state));
  return kept.length > 0 ? [...kept] : [...ALL_CLEARED_STATES];
}

export const AccountRegisterBlock = ({block, editor}: {block: BlockLike; editor: EditorLike}) => {
  const data = useLedgerReport();
  const props = readProps(block);
  const [accountId, setAccountId] = React.useState<string>(() => readString(props, PROP_ACCOUNT));
  const [from, setFrom] = React.useState<string>(() => readString(props, PROP_FROM));
  const [to, setTo] = React.useState<string>(() => readString(props, PROP_TO));
  const [cleared, setCleared] = React.useState<ReportClearedState[]>(() => parseClearedProp(readString(props, PROP_CLEARED)));

  const update = (key: string, value: string, apply: (v: string) => void): void => {
    apply(value);
    writeProp(block, editor, key, value);
  };

  const toggleCleared = (state: ReportClearedState, on: boolean): void => {
    // Keep the canonical workflow order regardless of click order, so the
    // persisted value (and the filter sentence) is stable.
    const next = ALL_CLEARED_STATES.filter((s) => (s === state ? on : cleared.includes(s)));
    // Emptying the filter is not a state the UI offers: the fold reads an empty
    // list as "no filter" (never "no rows"), so an all-unticked box would show
    // EVERYTHING — which reads as a broken control. The last ticked box is
    // disabled instead, so what you see always matches what is ticked.
    if (next.length === 0) return;
    setCleared([...next]);
    writeProp(block, editor, PROP_CLEARED, next.join(','));
  };

  const clearFilters = (): void => {
    update(PROP_FROM, '', setFrom);
    update(PROP_TO, '', setTo);
    setCleared([...ALL_CLEARED_STATES]);
    writeProp(block, editor, PROP_CLEARED, ALL_CLEARED_STATES.join(','));
  };

  // Same discipline as the trial balance: a stored amount the money core
  // refuses to add is a report failure, not a crashed document.
  let register: AccountRegister | null = null;
  let foldError: string | null = null;
  try {
    register = accountId === '' ? null : buildAccountRegister(accountId, data.accounts, data.transactions, {from, to, cleared}, data.reconciliations);
  } catch (err) {
    foldError = err instanceof Error ? err.message : String(err);
  }

  if (data.state === 'loading') {
    return (
      <div data-ledger-register data-ledger-loading contentEditable={false} style={frameStyle}>
        <span style={mutedStyle}>Loading account register…</span>
      </div>
    );
  }

  if (data.state === 'uninitialized') {
    return (
      <div data-ledger-register data-ledger-setup contentEditable={false} style={frameStyle}>
        <h3 style={titleStyle}>
          <span aria-hidden="true">📒 </span>Account register
        </h3>
        <SetupPrompt label="Set up books" readOnly={editor.readOnly} onDone={data.reload} />
      </div>
    );
  }

  const sortedAccounts = [...data.accounts].sort((a, b) => a.name.localeCompare(b.name));
  const filtered = from !== '' || to !== '' || cleared.length !== ALL_CLEARED_STATES.length;

  return (
    <div data-ledger-register contentEditable={false} style={frameStyle}>
      <div style={{display: 'flex', alignItems: 'flex-end', gap: '0.5rem', flexWrap: 'wrap'}}>
        <h3 style={{...titleStyle, lineHeight: '1.9rem'}}>
          <span aria-hidden="true">📒 </span>Account register
        </h3>
        <label style={{display: 'flex', flexDirection: 'column', gap: '0.2rem'}}>
          <span style={mutedStyle}>Account</span>
          <select data-ledger-register-account style={{...controlStyle, minWidth: '12rem'}} value={accountId} onChange={(e) => update(PROP_ACCOUNT, e.target.value, setAccountId)}>
            <option value="">Select account…</option>
            {sortedAccounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.name}
              </option>
            ))}
          </select>
        </label>
        <label style={{display: 'flex', flexDirection: 'column', gap: '0.2rem'}}>
          <span style={mutedStyle}>From</span>
          <input type="date" data-ledger-from style={controlStyle} value={from} onChange={(e) => update(PROP_FROM, e.target.value, setFrom)} />
        </label>
        <label style={{display: 'flex', flexDirection: 'column', gap: '0.2rem'}}>
          <span style={mutedStyle}>To</span>
          <input type="date" data-ledger-to style={controlStyle} value={to} onChange={(e) => update(PROP_TO, e.target.value, setTo)} />
        </label>
        <fieldset style={{border: '1px solid hsl(var(--border))', borderRadius: 6, padding: '0.15rem 0.5rem 0.35rem', display: 'flex', gap: '0.6rem', alignItems: 'center'}}>
          <legend style={mutedStyle}>Cleared state</legend>
          {ALL_CLEARED_STATES.map((state) => {
            const on = cleared.includes(state);
            const last = on && cleared.length === 1;
            return (
              <label key={state} style={{...mutedStyle, display: 'flex', alignItems: 'center', gap: '0.25rem', cursor: last ? 'default' : 'pointer'}}>
                <input type="checkbox" data-ledger-cleared={state} checked={on} disabled={last} onChange={(e) => toggleCleared(state, e.target.checked)} />
                {CLEARED_LABEL[state]}
              </label>
            );
          })}
          {/* Rendered ALWAYS, not on hover and not only when the limit bites:
              `disabled` drops the last box out of the tab order, so a keyboard
              user would otherwise watch a control silently disappear with the
              explanation living in a mouse-only tooltip. */}
          <span data-ledger-cleared-hint style={{...mutedStyle, fontStyle: 'italic'}}>
            At least one state must be shown.
          </span>
        </fieldset>
        {filtered && (
          <button type="button" data-ledger-clear-filters style={buttonStyle} onClick={clearFilters}>
            Clear filters
          </button>
        )}
      </div>

      <div data-ledger-drafts-excluded={register !== null ? register.draftCount : 0} style={mutedStyle}>
        {describeDraftExclusion(register !== null ? register.draftCount : 0)}
      </div>

      <TruncationNotice
        shown={data.truncated}
        detail="Postings before that window are missing from the opening balance, so EVERY running balance below is understated by the same amount — not just the total."
      />

      {data.error !== null && <ReportError kind="host" detail={data.error} onRetry={data.reload} />}
      {foldError !== null && <ReportError kind="fold" detail={foldError} onRetry={data.reload} />}

      {sortedAccounts.length === 0 && <EmptyState>No accounts yet — run “Ledger: set up books” to seed a chart of accounts.</EmptyState>}

      {sortedAccounts.length > 0 && register === null && foldError === null && <EmptyState>Pick an account above to see its postings and running balance.</EmptyState>}

      {register !== null && (
        <>
          {!register.exists ? (
            <EmptyState>That account no longer exists. Pick another one.</EmptyState>
          ) : register.rows.length === 0 ? (
            <EmptyState>
              {register.postingCount === 0 ? (
                `No posted entries touch ${register.accountName} yet.`
              ) : (
                <>
                  No postings match this filter — {register.filteredOutCount} on this account are outside it.{' '}
                  <button type="button" data-ledger-clear-filters-inline style={{...buttonStyle, marginLeft: '0.25rem'}} onClick={clearFilters}>
                    Clear filters
                  </button>
                </>
              )}
            </EmptyState>
          ) : (
            <TableRegion label="Account register table">
              <table style={tableStyle}>
                <caption style={{...mutedStyle, textAlign: 'left', paddingBottom: '0.25rem'}}>
                  {/* What the columns actually SHOW. "Debit-positive" is the
                      fold's internal sign convention and no signed number
                      appears on screen any more — every amount is a magnitude
                      with its side marked, so the caption must describe that. */}
                  <AccountName name={register.accountName} /> · debits and credits are marked Dr/Cr; this account is {register.normalSide}-normal.
                </caption>
                <thead>
                  <tr>
                    <th scope="col" style={thStyle}>
                    Entry
                    </th>
                    <th scope="col" style={thStyle}>
                    Date
                    </th>
                    <th scope="col" style={thStyle}>
                    Description
                    </th>
                    <th scope="col" style={thStyle}>
                    Contra account
                    </th>
                    <th scope="col" style={thStyle}>
                    Cleared
                    </th>
                    <th scope="col" style={numericHeadStyle}>
                    Amount
                    </th>
                    <th scope="col" style={numericHeadStyle}>
                    Balance
                    </th>
                  </tr>
                </thead>
                <tbody>
                  <tr data-ledger-opening>
                    <th scope="row" colSpan={6} style={{...tdStyle, ...mutedStyle, textAlign: 'left', fontWeight: 400}}>
                    Opening balance{register.filter.from !== null ? ` before ${register.filter.from}` : ''}
                    </th>
                    <td data-ledger-opening-balance style={{...numericStyle, ...mutedStyle}}>
                      <SideAmount minor={register.openingMinor} />
                    </td>
                  </tr>
                  {register.rows.map((row) => (
                    <tr key={row.postingId} data-ledger-register-row={row.postingId} {...(row.reversed ? {'data-ledger-reversed': true} : {})}>
                      <td style={{...tdStyle, ...mutedStyle, fontVariantNumeric: 'tabular-nums'}}>{row.entryNo === null ? '—' : `#${row.entryNo}`}</td>
                      <td style={{...tdStyle, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums'}}>{row.date}</td>
                      <td style={{...tdStyle, ...wrapStyle}}>
                        {row.description === '' ? <span style={mutedStyle}>(no description)</span> : row.description}
                        {row.reversed && (
                          <span style={{...mutedStyle, marginLeft: '0.35rem'}}>
                          (reversed)
                            <SrOnly> — this entry was reversed; its reversing entry appears in this register too.</SrOnly>
                          </span>
                        )}
                      </td>
                      <td data-ledger-contra style={{...tdStyle, ...wrapStyle}}><AccountName name={row.contra} /></td>
                      <td data-ledger-cleared-cell={row.cleared} style={{...tdStyle, ...mutedStyle}}>
                        {CLEARED_LABEL[row.cleared]}
                        {/* A reconciled posting is frozen against a SPECIFIC
                            statement (LGR-11). Naming it is what turns "you
                            cannot change this" into "this was matched to the
                            2026-03-31 statement" — the difference between a
                            locked cell and an auditable one. */}
                        {row.cleared === 'reconciled' && (
                          // `nowrap`: an ISO date broken across lines as
                          // `2026-03-` / `31` reads as two fragments.
                          <span
                            data-ledger-reconciled-statement={row.reconciledStatementDate ?? ''}
                            style={{display: 'block', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums'}}
                          >
                            {row.reconciledStatementDate !== null ? (
                              <>
                                {row.reconciledStatementDate}
                                <SrOnly> — matched to the statement dated {row.reconciledStatementDate}.</SrOnly>
                              </>
                            ) : (
                              <>
                                (statement unknown)
                                <SrOnly> — this posting is reconciled, but the statement it was matched to is not in this read.</SrOnly>
                              </>
                            )}
                          </span>
                        )}
                      </td>
                      <td data-ledger-amount style={numericStyle}><SideAmount minor={row.amountMinor} /></td>
                      <td data-ledger-running style={numericStyle}><SideAmount minor={row.runningMinor} /></td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr data-ledger-register-totals>
                    <th scope="row" colSpan={5} style={{...tdStyle, textAlign: 'left', fontWeight: 600, borderTop: '2px solid hsl(var(--border))', borderBottom: 'none'}}>
                    Closing balance
                    </th>
                    <td style={{...numericStyle, borderTop: '2px solid hsl(var(--border))', borderBottom: 'none', ...mutedStyle}}>
                      {formatAmount(register.totalDebitMinor)} Dr / {formatAmount(register.totalCreditMinor)} Cr
                    </td>
                    <td data-ledger-closing style={{...numericStyle, fontWeight: 600, borderTop: '2px solid hsl(var(--border))', borderBottom: 'none'}}>
                      <SideAmount minor={register.closingMinor} />
                    </td>
                  </tr>
                </tfoot>
              </table>
            </TableRegion>
          )}

          {register.exists && (
            <div data-ledger-register-summary style={mutedStyle}>
              {describeRegisterSummary(register)} · {describeRegisterFilter(register)}
            </div>
          )}

          {/* A filtered closing balance is NOT the account's balance. Say so,
              with the real figure, rather than letting the two be confused. */}
          {register.exists && !registerMatchesAccountBalance(register) && (
            <div data-ledger-filtered-balance role="status" aria-live="polite" style={noticeStyle('quiet')}>
              Filtered view — this account’s {data.truncated ? 'posted balance ACROSS THE PARTIAL READ ABOVE' : 'full posted balance'} is{' '}
              {formatWithSide(register.accountBalanceMinor)}
              {data.truncated ? ' (not the trial-balance figure — the read is truncated).' : ' (the trial-balance figure).'}
            </div>
          )}
        </>
      )}
    </div>
  );
};
