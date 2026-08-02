import React from 'react';
import {LedgerError, api} from '@book.dev/plugin-sdk';
import {
  EmptyState,
  ReportError,
  SECONDARY_TEXT,
  SetupPrompt,
  TableRegion,
  buttonStyle,
  controlStyle,
  frameStyle,
  mutedStyle,
  noticeStyle,
  readString,
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
import {
  defaultCloseRange,
  describeCloseConfirm,
  describeOpenReconciliationWarning,
  describePeriodStatus,
  describeReopenConfirm,
  formatPeriodRange,
  type ReportPeriod,
} from './periods';
import {todayIso} from './model';

/**
 * The PERIOD CLOSE block (LGR-12) — the ledger's period-settings surface: the
 * list of every closed (and reopened) period, the close flow, and the audited
 * reopen.
 *
 * WHAT IS ENFORCED WHERE: everything binding happens in the store. Closing
 * posts the closing entry and locks the range in one server transaction;
 * reopening voids the entry via a reversal and unlocks it; a posting dated
 * inside a closed period is rejected `period-closed` no matter which surface
 * sends it. This block is presentation and intent: it names what a close will
 * do before it is done, WARNS about open reconciliations (a notice with names
 * in it — never a gate: LGR-12's warn-not-block ruling), and confirms both
 * destructive-looking actions in words rather than a bare "Are you sure?".
 *
 * READ-ONLY PAGES: every write control is gated on `pageReadOnly` — the
 * document's real lock, passed by the host — with `editor.readOnly` as the
 * fallback when driven directly by a test harness (the register's pattern: a
 * custom block on a read-only page receives an OPERABLE editor, so
 * `editor.readOnly` alone is false exactly where the controls must be off).
 * Disabled controls use the shared dead-button face and carry an
 * `aria-describedby` reason, so the OFF state is visible and explained.
 *
 * FOCUS across sub-flow transitions (the reconcile block's paid-for lesson,
 * `FocusTarget` there): every transition here either unmounts or disables the
 * element that is focused at the moment of the press — the Close trigger
 * unmounts when its confirm opens, both Cancels unmount themselves, success
 * unmounts the confirm box, and a refusal disables the focused confirm while
 * `busy` — and a browser answers all of those by dumping focus on `<body>`,
 * stranding keyboard and screen-reader users. So each handler records an
 * INTENT (a selector inside this block's root) and the after-commit effect
 * performs it once the target exists and is enabled: open → the confirm's
 * primary; cancel → the re-mounted invoker; refusal → the confirm's primary
 * after it re-enables; success → the Close trigger, the one control that
 * survives the reload (a reopened row's own button unmounts with the status
 * flip, on the reload's timetable, so focus returned there would be dumped
 * moments later anyway).
 */

const PROP_START = 'ledgerPeriodStart';
const PROP_END = 'ledgerPeriodEnd';

/** The dead-look button face (the reconcile block's lesson, same treatment). */
const buttonFace = (dead: boolean, extra: React.CSSProperties = {}): React.CSSProperties => ({
  ...buttonStyle,
  ...extra,
  ...(dead ? {color: SECONDARY_TEXT, background: 'hsl(var(--muted))', cursor: 'not-allowed'} : {}),
});

/** A stable per-block DOM id namespace (two blocks on one page must not share). */
const blockKey = (block: BlockLike): string => {
  const id = block.get('id');
  return typeof id === 'string' ? id : 'periods';
};

type Mode = 'none' | 'confirm-close' | `confirm-reopen:${string}`;

export const PeriodCloseBlock = ({block, editor, pageReadOnly}: {block: BlockLike; editor: EditorLike; pageReadOnly?: boolean}) => {
  const data = useLedgerReport();
  const pageLocked = pageReadOnly ?? editor.readOnly;
  const props = readProps(block);
  const defaults = React.useMemo(() => defaultCloseRange(data.periods, todayIso()), [data.periods]);
  const [start, setStart] = React.useState<string>(() => readString(props, PROP_START));
  const [end, setEnd] = React.useState<string>(() => readString(props, PROP_END));
  const [mode, setMode] = React.useState<Mode>('none');
  const [busy, setBusy] = React.useState(false);
  const [actionError, setActionError] = React.useState<string | null>(null);
  const [done, setDone] = React.useState<string | null>(null);
  const lockedWhyId = `ledger-period-locked-${blockKey(block)}`;

  // Where focus must land after the NEXT commit — a selector scoped to this
  // block's root (two blocks on one page must not steal each other's focus).
  // The effect retries until the target exists AND is enabled: the refusal
  // path re-enables the confirm on the same commit that clears `busy`, and
  // focusing a still-disabled button is the silent no-op that stranded the
  // reconcile block's users on `<body>`.
  const rootRef = React.useRef<HTMLDivElement | null>(null);
  const pendingFocus = React.useRef<string | null>(null);
  const focusAfterRender = (selector: string): void => {
    pendingFocus.current = selector;
  };
  React.useEffect(() => {
    if (pendingFocus.current === null) return;
    const target = rootRef.current?.querySelector<HTMLElement>(pendingFocus.current) ?? null;
    if (target === null || (target as HTMLButtonElement).disabled === true) return; // retry next commit
    pendingFocus.current = null;
    target.focus();
  });

  const effectiveStart = start !== '' ? start : defaults.start;
  const effectiveEnd = end !== '' ? end : defaults.end;

  const accountName = React.useCallback(
    (id: string): string => data.accounts.find((a) => a.id === id)?.name ?? id,
    [data.accounts],
  );

  // The warn-not-block notice: open reconciliations whose statement is dated
  // on or before the close's end. Recomputed live from the same read the rest
  // of the block uses; the SERVER's close result re-asserts it authoritatively.
  const openWarning = describeOpenReconciliationWarning(
    data.reconciliations
      .filter((r) => r.status === 'open' && r.statementDate <= effectiveEnd)
      .map((r) => ({statementDate: r.statementDate, accountName: accountName(r.accountId)})),
  );

  const fail = (err: unknown): void => {
    setActionError(err instanceof LedgerError ? err.message : err instanceof Error ? err.message : String(err));
  };

  const close = async (): Promise<void> => {
    setBusy(true);
    setActionError(null);
    setDone(null);
    try {
      const result = await api.ledger.closePeriod({start: effectiveStart, end: effectiveEnd});
      setMode('none');
      // The RESULT's open-reconciliation list is the authoritative one — it
      // was computed inside the close's own transaction, so a reconciliation
      // opened while the confirm sat on screen is named HERE even though the
      // pre-close notice never saw it.
      const stillOpen = result.openReconciliations.map((r) => `${accountName(r.accountId)} (statement ${r.statementDate})`);
      const closedAs = result.closingEntry
        ? `Closed ${formatPeriodRange(result.period)} — closing entry #${result.closingEntry.entryNo ?? ''} posted to retained earnings.`
        : `Closed ${formatPeriodRange(result.period)} — nothing to close; the range is locked.`;
      setDone(stillOpen.length > 0 ? `${closedAs} Still open in the range: ${stillOpen.join(', ')}.` : closedAs);
      focusAfterRender('[data-ledger-period-close]'); // the confirm box unmounts under the presser
      data.reload();
    } catch (err) {
      fail(err);
      focusAfterRender('[data-ledger-period-close-confirm]'); // back to the re-enabled primary
    } finally {
      setBusy(false);
    }
  };

  const reopen = async (period: ReportPeriod): Promise<void> => {
    setBusy(true);
    setActionError(null);
    setDone(null);
    try {
      const result = await api.ledger.reopenPeriod(period.id);
      setMode('none');
      setDone(
        result.reversal
          ? `Reopened ${formatPeriodRange(result.period)} — closing entry voided by reversal #${result.reversal.entryNo ?? ''}.`
          : `Reopened ${formatPeriodRange(result.period)}.`,
      );
      // The row's Reopen button unmounts with the status flip — land on the
      // one control that survives the reload.
      focusAfterRender('[data-ledger-period-close]');
      data.reload();
    } catch (err) {
      fail(err);
      focusAfterRender(`[data-ledger-period-reopen-confirm="${period.id}"]`);
    } finally {
      setBusy(false);
    }
  };

  if (data.state === 'loading') {
    return <div style={frameStyle} data-ledger-periods><span style={mutedStyle}>Loading periods…</span></div>;
  }
  if (data.state === 'uninitialized') {
    return (
      <div style={frameStyle} data-ledger-periods>
        <div style={titleStyle}>Period close</div>
        <SetupPrompt label="period close" readOnly={pageLocked} onDone={data.reload} />
      </div>
    );
  }
  if (data.state === 'error') {
    return (
      <div style={frameStyle} data-ledger-periods>
        <div style={titleStyle}>Period close</div>
        <ReportError kind="host" detail={data.error ?? 'unknown error'} onRetry={data.reload} />
      </div>
    );
  }

  const controlsDead = busy || pageLocked;
  const confirmingReopen = mode.startsWith('confirm-reopen:') ? mode.slice('confirm-reopen:'.length) : null;
  const sorted = [...data.periods].sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : a.id < b.id ? -1 : 1));

  return (
    <div style={frameStyle} data-ledger-periods ref={rootRef}>
      <div style={titleStyle}>Period close</div>
      <div style={mutedStyle}>
        Closing a period sweeps revenue and expenses into retained earnings and locks the range — the server
        rejects any entry or reversal dated inside a closed period, from every surface.
      </div>

      {pageLocked && (
        <div id={lockedWhyId} style={noticeStyle('quiet')} data-ledger-periods-locked>
          This page is read-only — closing and reopening periods is disabled here.
        </div>
      )}
      {done !== null && (
        <div style={noticeStyle('info')} role="status" data-ledger-periods-done>{done}</div>
      )}
      {actionError !== null && (
        <div style={noticeStyle('alarm')} role="alert" data-ledger-periods-error>{actionError}</div>
      )}

      {sorted.length === 0
        ? <EmptyState>No period has been closed in this book yet.</EmptyState>
        : (
          <div style={wrapStyle}>
            <TableRegion label="Closed periods">
              <table style={tableStyle}>
                <thead>
                  <tr>
                    <th style={thStyle} scope="col">Period</th>
                    <th style={thStyle} scope="col">Status</th>
                    <th style={thStyle} scope="col">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((period) => (
                    <tr key={period.id} data-ledger-period-row={period.id}>
                      <td style={tdStyle}>{formatPeriodRange(period)}</td>
                      <td style={tdStyle}>{describePeriodStatus(period)}</td>
                      <td style={tdStyle}>
                        {period.status === 'closed' && confirmingReopen !== period.id && (
                          <button
                            type="button"
                            data-ledger-period-reopen={period.id}
                            style={buttonFace(controlsDead)}
                            disabled={controlsDead}
                            aria-describedby={pageLocked ? lockedWhyId : undefined}
                            onClick={() => {
                              setMode(`confirm-reopen:${period.id}`);
                              setActionError(null);
                              setDone(null);
                              // The invoker unmounts on this commit — land on
                              // the confirm's primary, not <body>.
                              focusAfterRender(`[data-ledger-period-reopen-confirm="${period.id}"]`);
                            }}
                          >
                            Reopen…
                          </button>
                        )}
                        {confirmingReopen === period.id && (
                          <span style={{display: 'inline-flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap'}}>
                            <span style={mutedStyle}>{describeReopenConfirm(period)}</span>
                            <button
                              type="button"
                              data-ledger-period-reopen-confirm={period.id}
                              style={buttonFace(controlsDead, {fontWeight: 600})}
                              disabled={controlsDead}
                              onClick={() => void reopen(period)}
                            >
                              Reopen period
                            </button>
                            <button
                              type="button"
                              data-ledger-period-reopen-cancel={period.id}
                              style={buttonFace(busy)}
                              disabled={busy}
                              onClick={() => {
                                setMode('none');
                                // Cancel unmounts itself — return to the
                                // re-mounted invoker.
                                focusAfterRender(`[data-ledger-period-reopen="${period.id}"]`);
                              }}
                            >
                              Cancel
                            </button>
                          </span>
                        )}
                        {period.status === 'reopened' && <span style={mutedStyle}>—</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableRegion>
          </div>
        )}

      <div style={{display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap'}}>
        <label style={mutedStyle}>
          From{' '}
          <input
            type="date"
            data-ledger-period-start
            style={controlStyle}
            value={effectiveStart}
            disabled={controlsDead}
            aria-describedby={pageLocked ? lockedWhyId : undefined}
            onChange={(e) => {
              setStart(e.target.value);
              writeProp(block, editor, PROP_START, e.target.value, pageLocked);
            }}
          />
        </label>
        <label style={mutedStyle}>
          through{' '}
          <input
            type="date"
            data-ledger-period-end
            style={controlStyle}
            value={effectiveEnd}
            disabled={controlsDead}
            aria-describedby={pageLocked ? lockedWhyId : undefined}
            onChange={(e) => {
              setEnd(e.target.value);
              writeProp(block, editor, PROP_END, e.target.value, pageLocked);
            }}
          />
        </label>
        {mode !== 'confirm-close' && (
          <button
            type="button"
            data-ledger-period-close
            style={buttonFace(controlsDead)}
            disabled={controlsDead}
            aria-describedby={pageLocked ? lockedWhyId : undefined}
            onClick={() => {
              setMode('confirm-close');
              setActionError(null);
              setDone(null);
              // The trigger unmounts on this commit — land on the confirm.
              focusAfterRender('[data-ledger-period-close-confirm]');
            }}
          >
            Close period…
          </button>
        )}
      </div>

      {/* Warn-not-block: the notice renders WITH the confirm step, and the
          confirm button stays enabled — the user proceeds informed. */}
      {mode === 'confirm-close' && (
        <div style={noticeStyle('info')} data-ledger-period-close-confirm-box>
          <div>{describeCloseConfirm({start: effectiveStart, end: effectiveEnd})}</div>
          {openWarning !== null && (
            <div style={{marginTop: '0.35rem'}} role="status" data-ledger-period-open-recs>{openWarning}</div>
          )}
          <div style={{display: 'flex', gap: '0.5rem', marginTop: '0.5rem'}}>
            <button
              type="button"
              data-ledger-period-close-confirm
              style={buttonFace(controlsDead, {fontWeight: 600})}
              disabled={controlsDead}
              onClick={() => void close()}
            >
              Close the period
            </button>
            <button
              type="button"
              data-ledger-period-close-cancel
              style={buttonFace(busy)}
              disabled={busy}
              onClick={() => {
                setMode('none');
                // Cancel unmounts itself — return to the re-mounted trigger.
                focusAfterRender('[data-ledger-period-close]');
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
