import {closedPeriodContaining, closedPeriodsOverlapping} from '@book.dev/plugin-sdk';

/**
 * Pure period-close model (LGR-12) — no React, no IO, no host calls.
 *
 * The CONTAINMENT and OVERLAP predicates are NOT re-implemented here: they are
 * imported from `@book.dev/plugin-sdk`, which hands the plugin the very same
 * pure functions the server's date-lock guard runs (`closedPeriodContaining`,
 * `closedPeriodsOverlapping`). This module only adds the words around them —
 * the display-only closed-period marker the reports render, the close-form
 * defaults, and the warn-not-block sentences of the close flow. The LOCK
 * itself lives in the store: a block that forgot to disable its button still
 * gets a typed `period-closed` rejection, and everything here is presentation
 * over that fact, never a second copy of it.
 */

/** The period fields the plugin needs (a structural slice of `LedgerPeriod`). */
export interface ReportPeriod {
  id: string;
  /** Inclusive ISO date bounds. */
  start: string;
  end: string;
  status: 'closed' | 'reopened';
  closingEntryId: string | null;
  reopenEntryId?: string | null;
  closedAt?: string;
  reopenedAt?: string | null;
}

/** Re-exported for blocks that already import from `./periods`. */
export {closedPeriodContaining, closedPeriodsOverlapping};

/** One period's range, in the notation every period sentence uses. */
export function formatPeriodRange(period: {start: string; end: string}): string {
  return `${period.start} – ${period.end}`;
}

/**
 * The display-only closed-period marker for a report whose range is
 * `[from, to]` (`''` = open end): names every closed period the range crosses,
 * or `null` when it crosses none. DISPLAY-ONLY by design — the marker informs,
 * the store enforces; a report never gates anything on it.
 */
export function describeClosedPeriodMarker(periods: readonly ReportPeriod[], from: string, to: string): string | null {
  const crossed = closedPeriodsOverlapping(periods, from, to);
  if (crossed.length === 0) return null;
  const ranges = crossed.map(formatPeriodRange).join(', ');
  const label = crossed.length === 1 ? 'a closed period' : `${crossed.length} closed periods`;
  return `This range crosses ${label} (${ranges}): the books dated inside are locked — new entries and reversals there are rejected until the period is reopened.`;
}

/**
 * The latest closed-period end at or before `asOf` (`''` = no bound), or
 * `null`. This is the date the balance sheet's "current earnings" line has
 * been swept up to: a close dated AFTER the report's as-of has not zeroed
 * anything this report can see, so it must not be counted.
 */
export function latestCloseThrough(periods: readonly ReportPeriod[], asOf: string): string | null {
  let latest: string | null = null;
  for (const period of periods) {
    if (period.status !== 'closed') continue;
    if (asOf !== '' && period.end > asOf) continue;
    if (latest === null || period.end > latest) latest = period.end;
  }
  return latest;
}

/** The day after an ISO date, as an ISO date (calendar-correct via UTC). */
export function nextDayIso(date: string): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return date;
  parsed.setUTCDate(parsed.getUTCDate() + 1);
  return parsed.toISOString().slice(0, 10);
}

/**
 * The close form's default range: from the day after the latest CLOSED
 * period's end (the books pick up where they were last closed), or January 1st
 * of `today`'s year on a never-closed book; through `today`. A default, not a
 * rule — both ends stay editable, and the store validates whatever is sent.
 */
export function defaultCloseRange(periods: readonly ReportPeriod[], today: string): {start: string; end: string} {
  let latestEnd: string | null = null;
  for (const period of periods) {
    if (period.status !== 'closed') continue;
    if (latestEnd === null || period.end > latestEnd) latestEnd = period.end;
  }
  return {start: latestEnd !== null ? nextDayIso(latestEnd) : `${today.slice(0, 4)}-01-01`, end: today};
}

/**
 * The warn-not-block sentence (LGR-12's reconciliation assertion): names the
 * reconciliations still open with statements dated inside the close, or `null`
 * when there is nothing to warn about. The close button stays enabled either
 * way — this is a notice with names in it, never a gate.
 */
export function describeOpenReconciliationWarning(
  open: ReadonlyArray<{statementDate: string; accountName: string}>,
): string | null {
  if (open.length === 0) return null;
  const named = open.map((r) => `${r.accountName} (statement ${r.statementDate})`).join(', ');
  const lead = open.length === 1 ? 'A reconciliation is still open' : `${open.length} reconciliations are still open`;
  return `${lead} in this range: ${named}. Closing does not wait for them — but a statement matched after the close cannot correct entries dated inside it without a reopen.`;
}

/** One period row's status, in words, for the closed-periods list. */
export function describePeriodStatus(period: ReportPeriod): string {
  if (period.status === 'reopened') {
    return period.reopenEntryId != null
      ? `Reopened — closing entry voided by reversal ${period.reopenEntryId.slice(0, 8)}`
      : 'Reopened';
  }
  return period.closingEntryId != null ? 'Closed — closing entry posted' : 'Closed — nothing to close (range locked)';
}

/**
 * What pressing Close will do, stated before it is done: the range, where the
 * income-statement balances go, and that the range locks. The confirm step
 * reads this back instead of a bare "Are you sure?".
 */
export function describeCloseConfirm(range: {start: string; end: string}): string {
  return `Close ${formatPeriodRange(range)}: income-statement balances as of ${range.end} are swept into Equity:RetainedEarnings by a posted closing entry, and no entry or reversal may be dated inside the range until it is reopened.`;
}

/** What pressing Reopen will do — the explicit, audited inverse. */
export function describeReopenConfirm(period: ReportPeriod): string {
  return period.closingEntryId != null
    ? `Reopen ${formatPeriodRange(period)}: the closing entry is voided by a reversal and the range accepts entries again. Both steps are recorded in the audit log.`
    : `Reopen ${formatPeriodRange(period)}: the range accepts entries again (this period had no closing entry). The reopen is recorded in the audit log.`;
}
