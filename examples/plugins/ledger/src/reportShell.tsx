import React from 'react';
import {api, LEDGER_MAX_TRANSACTION_LIMIT} from '@book.dev/plugin-sdk';
import {formatWithSide, type ReportAccount, type ReportTransaction} from './reports';
import type {ReconcileStatement} from './reconcile';
import {setUpBooks} from './setup';

/**
 * Shared chrome for the read-only ledger report blocks (LGR-8): the live data
 * hook both of them read from, the block-prop helpers they persist their
 * controls through, and the style tokens that keep them looking like one
 * report family.
 *
 * THEMING: every colour is a host CSS variable (`--border`, `--card`,
 * `--foreground`, `--muted-foreground`, `--destructive`), so the blocks follow
 * the app's light/dark theme instead of pinning their own palette. Every
 * control is a NATIVE element (`select`, `input`, `button`), so keyboard
 * reachability and the visible focus ring come from the platform rather than
 * from a re-implementation that forgets one of them.
 */

// ── Block props (CRDT) ────────────────────────────────────────────────────────

export interface PropsMap {
  get(k: string): unknown;
  set(k: string, v: unknown): void;
  delete(k: string): void;
}

export interface BlockLike {
  get(k: string): unknown;
}

export interface EditorLike {
  doc: {transact(fn: () => void, origin: string): void};
  readOnly: boolean;
}

export function readProps(block: BlockLike): PropsMap | undefined {
  return block.get('props') as PropsMap | undefined;
}

export function readString(props: PropsMap | undefined, key: string, fallback = ''): string {
  const value = props?.get(key);
  return typeof value === 'string' ? value : fallback;
}

export function readBool(props: PropsMap | undefined, key: string, fallback = false): boolean {
  const value = props?.get(key);
  return typeof value === 'boolean' ? value : fallback;
}

/**
 * Persist one report control into the block's props map. Read-only PAGES write
 * nothing (a viewer may re-filter a report on screen; it must not edit the
 * document doing so).
 *
 * The gate is `pageLocked` — the DOCUMENT's lock, which each block derives once
 * from the host-supplied `pageReadOnly` — because the editor handed to an
 * interactive widget on a locked page deliberately reports `readOnly: false`
 * (LGR-6). The `editor.readOnly` arm exists only as the harness fallback for a
 * caller with no host to ask; every in-tree caller passes `pageLocked`.
 */
export function writeProp(block: BlockLike, editor: EditorLike, key: string, value: string | boolean, pageLocked?: boolean): void {
  const props = readProps(block);
  if (!props || (pageLocked ?? editor.readOnly)) return;
  editor.doc.transact(() => props.set(key, value), 'local');
}

// ── Live ledger data ──────────────────────────────────────────────────────────

/**
 * How many transactions a report reads: the server's own exported cap, NOT a
 * literal. A full page means "there may be more", so the blocks say the figures
 * are partial ({@link LedgerReportData.truncated}) rather than quietly totalling
 * a subset. Reading the shared constant is what keeps that inference sound — a
 * cap that dropped under a hard-coded request would clamp the read, leave
 * `truncated` permanently false, and render a partial total as a complete one.
 * Paged/streamed reporting for very large books is a later task.
 */
export const REPORT_TX_LIMIT = LEDGER_MAX_TRANSACTION_LIMIT;

export interface LedgerReportData {
  state: 'loading' | 'uninitialized' | 'ready' | 'error';
  accounts: ReportAccount[];
  transactions: ReportTransaction[];
  /**
   * Every statement reconciliation the book holds (LGR-11). Read alongside the
   * accounts and transactions, and subscribed to, because a `reconciled`
   * posting is only legible if the report can name the statement that froze it
   * — an id in a cell explains nothing.
   */
  reconciliations: ReconcileStatement[];
  /** The server returned a full page — older entries are NOT in these figures. */
  truncated: boolean;
  error: string | null;
  /** Re-run the whole boot (used by the "set up books" and retry paths). */
  reload: () => void;
}

/**
 * Read the ledger's accounts + transactions and keep them LIVE: the three
 * seeded ledger databases are subscribed through `api.databases.subscribeRows`,
 * so a posted entry, a renamed account or a cleared-state flip refreshes the
 * open report with no reload.
 *
 * CONCURRENCY (the rule this hook is arranged around): loads OVERLAP by design —
 * posting one entry mutates the transactions AND the postings database, so two
 * subscription callbacks fire for a single user action. Without a request token
 * the last response to SETTLE wins regardless of the order they were issued in,
 * and the report can silently come to rest on an OLDER book while still captioned
 * "In balance ✓". So every load carries a token and only the newest one may
 * write; anything else is dropped. A wrong number rendered confidently is the
 * worst outcome a ledger report has, worse than a spinner.
 *
 * LIFETIME: `cancelled` is a per-effect-run closure variable, NOT a shared ref.
 * A ref is a single cell across effect generations — cleanup sets it false and
 * the next run sets it true again, which resurrects an orphaned in-flight load
 * from the previous generation and lets it write. Subscriptions are registered
 * through {@link subscribe}, which stops one immediately if the effect was torn
 * down while the initial load was still in flight (otherwise the continuation
 * subscribes into an already-emptied cleanup list and leaks a live stream that
 * re-reads the whole book on every ledger mutation for the rest of the session).
 */
export function useLedgerReport(): LedgerReportData {
  const [state, setState] = React.useState<LedgerReportData['state']>('loading');
  const [accounts, setAccounts] = React.useState<ReportAccount[]>([]);
  const [transactions, setTransactions] = React.useState<ReportTransaction[]>([]);
  const [reconciliations, setReconciliations] = React.useState<ReconcileStatement[]>([]);
  const [truncated, setTruncated] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [generation, setGeneration] = React.useState(0);

  React.useEffect(() => {
    let cancelled = false;
    let issued = 0;
    const stops: Array<() => void> = [];

    const load = async (): Promise<void> => {
      const token = (issued += 1);
      try {
        const [accountList, txList, reconciliationList] = await Promise.all([
          api.ledger.listAccounts(),
          api.ledger.listTransactions({limit: REPORT_TX_LIMIT}),
          api.ledger.listReconciliations(),
        ]);
        // Torn down, or a newer load was issued while this one was in flight:
        // this answer is stale and must never reach the screen.
        if (cancelled || token !== issued) return;
        setAccounts(accountList as unknown as ReportAccount[]);
        setTransactions(txList as unknown as ReportTransaction[]);
        setReconciliations(reconciliationList as unknown as ReconcileStatement[]);
        setTruncated(txList.length >= REPORT_TX_LIMIT);
        setError(null);
        setState('ready');
      } catch (err) {
        // A REJECTION is an answer too, and the token rule applies to it
        // identically: a superseded load failing late would otherwise paint the
        // red "could not be loaded" box over a correct, freshly rendered report
        // and leave it there until the next successful load. Only the newest
        // load may write — whether it writes figures or a failure.
        if (cancelled || token !== issued) return;
        setError(err instanceof Error ? err.message : String(err));
        setState('error');
      }
    };

    /**
     * The boot failure — `api.ledger.info()` never reaching an answer. It
     * carries no token because it is not a load: nothing can supersede it.
     */
    const fail = (err: unknown): void => {
      if (cancelled) return;
      setError(err instanceof Error ? err.message : String(err));
      setState('error');
    };

    const subscribe = (databaseId: string): void => {
      const stop = api.databases.subscribeRows(databaseId, () => {
        void load();
      });
      // Registered after teardown (the initial load outlived the effect): stop
      // it now — `stops` has already been drained and will never be read again.
      if (cancelled) stop();
      else stops.push(stop);
    };

    void (async () => {
      try {
        const info = await api.ledger.info();
        if (cancelled) return;
        if (!info.exists || !info.databases) {
          setState('uninitialized');
          return;
        }
        await load();
        if (cancelled) return;
        for (const databaseId of [
          info.databases.accounts,
          info.databases.transactions,
          info.databases.postings,
          // LGR-11: finishing or reopening a statement changes what the register
          // shows about a posting without touching the posting rows in a way the
          // other three subscriptions would report on their own.
          info.databases.reconciliations,
        ]) {
          subscribe(databaseId);
        }
      } catch (err) {
        fail(err);
      }
    })();

    return () => {
      cancelled = true;
      for (const stop of stops) stop();
      stops.length = 0;
    };
  }, [generation]);

  return {
    state,
    accounts,
    transactions,
    reconciliations,
    truncated,
    error,
    reload: React.useCallback(() => setGeneration((n) => n + 1), []),
  };
}

// ── Styles ────────────────────────────────────────────────────────────────────

export const frameStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.5rem',
  padding: '0.75rem',
  border: '1px solid hsl(var(--border))',
  borderRadius: 8,
  background: 'hsl(var(--card))',
  color: 'hsl(var(--foreground))',
  fontSize: '0.85rem',
};

export const titleStyle: React.CSSProperties = {
  fontSize: '0.95rem',
  fontWeight: 600,
};

/**
 * Secondary text colour for the reports.
 *
 * NOT `--muted-foreground`: that token measures 4.17:1 on `--card` (and 3.40:1
 * once it lands on the opening-balance row), which fails WCAG AA for body text —
 * and these are not decorative surfaces, they are column headers, account types,
 * cleared states, and the opening balance that seeds every running balance below
 * it. A translucent `--foreground` measures 5.33:1 light / 5.71:1 dark while
 * still reading as secondary. Defined ONCE here so the whole report family moves
 * together. (The underlying token defect is app-wide and tracked separately as
 * DS-1 — this is a local fix, the host token is untouched.)
 */
export const SECONDARY_TEXT = 'hsl(var(--foreground) / 0.72)';

export const mutedStyle: React.CSSProperties = {
  fontSize: '0.75rem',
  color: SECONDARY_TEXT,
};

export const controlStyle: React.CSSProperties = {
  borderWidth: 1,
  borderStyle: 'solid',
  borderColor: 'hsl(var(--border))',
  borderRadius: 6,
  padding: '0.3rem 0.5rem',
  background: 'hsl(var(--background))',
  color: 'hsl(var(--foreground))',
  fontSize: '0.85rem',
};

/**
 * LONGHAND border properties, not the `border` shorthand: the same element
 * swaps between this and {@link disabledButtonStyle} as a row's state changes,
 * and React warns (and can leave a stale edge behind) when a shorthand and a
 * longhand for the same box alternate across rerenders.
 */
export const buttonStyle: React.CSSProperties = {
  borderWidth: 1,
  borderStyle: 'solid',
  borderColor: 'hsl(var(--border))',
  borderRadius: 6,
  padding: '0.3rem 0.75rem',
  background: 'hsl(var(--card))',
  color: 'hsl(var(--foreground))',
  fontSize: '0.85rem',
  cursor: 'pointer',
};

/**
 * A button that is OFF, and looks it.
 *
 * `disabled` alone is not a visual state: the platform's default dimming is a
 * few percent of alpha on a bordered button, and a previous task shipped a
 * disabled control pixel-identical to its enabled twin. So the off state changes
 * SHAPE (a dashed border) as well as weight, which survives a forced-colours
 * mode and does not rely on the reader distinguishing two greys.
 *
 * The dash is drawn in {@link SECONDARY_TEXT}, NOT `--border`. That was the
 * whole mechanism failing quietly: `--border` measures ~1.24:1 against the card,
 * which is below any perceptual threshold, so a "shape" cue nobody could see
 * collapsed straight back into the two-greys problem it was meant to avoid —
 * and a test asserting `border-style: dashed` passed on an invisible border.
 * `SECONDARY_TEXT` measures 5.33:1 light / 5.71:1 dark and matches the label, so
 * the button reads as one deliberately-drawn off state.
 *
 * The reason is never carried by this style — it is rendered as text beside the
 * control (or once above the table for a block-wide reason), because `disabled`
 * also removes the button from the tab order and a `title` would be a
 * mouse-only explanation.
 */
export const disabledButtonStyle: React.CSSProperties = {
  borderWidth: 1,
  borderStyle: 'dashed',
  borderColor: SECONDARY_TEXT,
  borderRadius: 6,
  padding: '0.3rem 0.75rem',
  background: 'transparent',
  color: SECONDARY_TEXT,
  fontSize: '0.85rem',
  cursor: 'not-allowed',
};

export const tableStyle: React.CSSProperties = {
  width: '100%',
  borderCollapse: 'collapse',
  fontSize: '0.85rem',
};

/**
 * Wrapper for every report table. A register in a narrow column can want more
 * width than it has (hierarchical account names are long and unbreakable), and
 * a table that overflows its block CLIPS the rightmost column — which here is
 * the running balance, the one number the report exists to show. Scrolling the
 * table inside its own box keeps every column reachable and stops the page
 * itself from scrolling sideways.
 */
export const tableScrollStyle: React.CSSProperties = {
  width: '100%',
  overflowX: 'auto',
};

/** Long colon-delimited account names must be allowed to break, or they set an unshrinkable min-width. */
export const wrapStyle: React.CSSProperties = {
  overflowWrap: 'break-word',
};

export const thStyle: React.CSSProperties = {
  fontSize: '0.7rem',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  color: SECONDARY_TEXT,
  fontWeight: 500,
  textAlign: 'left',
  padding: '0.25rem 0.5rem',
  borderBottom: '1px solid hsl(var(--border))',
  whiteSpace: 'nowrap',
};

export const tdStyle: React.CSSProperties = {
  padding: '0.25rem 0.5rem',
  borderBottom: '1px solid hsl(var(--border) / 0.5)',
  verticalAlign: 'top',
};

/** Numeric cells are columns of digits, not proportional text. */
export const numericStyle: React.CSSProperties = {
  ...tdStyle,
  textAlign: 'right',
  fontVariantNumeric: 'tabular-nums',
  whiteSpace: 'nowrap',
};

export const numericHeadStyle: React.CSSProperties = {
  ...thStyle,
  textAlign: 'right',
};

/**
 * Notice surfaces, in THREE severities — the distinction is load-bearing, not
 * decorative.
 *
 * `alarm` is reserved for two things only: the books not balancing, and a report
 * that could not be computed. A standing condition that is merely a caveat —
 * truncation on a large book, postings on a deleted account — renders as `info`,
 * because a red 600-weight box that is permanently on screen for every big book
 * teaches the reader to ignore red, and then the one message that matters
 * arrives into an interface that has already been desensitised to it.
 *
 * The alarm colour carries on the BORDER and a soft fill; the sentence itself
 * uses `--foreground`, the only token guaranteed to clear 4.5:1 on the card in
 * both themes (`--destructive` is a fill/border token and measures ~4.4:1 as
 * body text).
 *
 * `info` also carries a LEADING RULE. Its fill measures 1.09:1 against the card
 * and it shares `--border` with `quiet` at 1.19:1, so a "Partial read" caveat
 * and an "In balance ✓" reassurance would otherwise stack at identical visual
 * weight — the reader cannot tell a qualification from a confirmation. The rule
 * is the same device the deleted-account row already uses, one step down in
 * colour: a caveat is not an alarm.
 */
export const noticeStyle = (tone: 'alarm' | 'info' | 'quiet'): React.CSSProperties => {
  const edge = tone === 'alarm' ? 'hsl(var(--destructive))' : 'hsl(var(--border))';
  return {
    padding: '0.4rem 0.6rem',
    borderRadius: 6,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: edge,
    background: tone === 'alarm' ? 'hsl(var(--destructive) / 0.1)' : tone === 'info' ? 'hsl(var(--muted))' : 'transparent',
    color: 'hsl(var(--foreground))',
    fontSize: '0.85rem',
    fontWeight: tone === 'alarm' ? 600 : 400,
    // The leading rule is set as LONGHANDS, never a `borderLeft` shorthand
    // beside `borderWidth`/`borderColor`. A notice whose tone CHANGES between
    // renders (the LGR-11 difference readout flips quiet ⇄ info on every tick)
    // makes React remove the shorthand while the longhands remain, which it
    // warns about and which leaves the edge in an indeterminate state.
    borderLeftWidth: tone === 'info' ? 3 : 1,
    borderLeftColor: tone === 'info' ? 'hsl(var(--foreground) / 0.35)' : edge,
  };
};

/**
 * Text for screen readers only. The reports carry a few marks that are visually
 * obvious but semantically silent — the abnormal-balance ⚠, the reversed-entry
 * note — and `title` is not the answer: NVDA does not announce it on a
 * non-interactive cell by default, and it is unreachable by keyboard entirely.
 * The mark stays visual; this carries the same meaning as real text.
 */
export const srOnlyStyle: React.CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: 'hidden',
  clip: 'rect(0, 0, 0, 0)',
  whiteSpace: 'nowrap',
  borderWidth: 0,
};

/** Visually hidden text carrying a mark's meaning to assistive technology. */
export const SrOnly = ({children}: {children: React.ReactNode}) => <span style={srOnlyStyle}>{children}</span>;

/**
 * An amount in the reports' one notation: the magnitude, and the SIDE it is
 * actually on. Zero is the exception — it sits on neither side, so it renders
 * bare, which is the honest thing to print and the thing that breaks the column.
 *
 * In a right-aligned column of `1,250.00 Dr`, a bare `0.00` is pushed right by
 * exactly the suffix it lacks: measured, its decimal point lands ~18px outside
 * the column every other row shares — and this is the EVERYDAY state, the
 * balanced totals row and the register's opening balance, not an edge case. So
 * zero carries the mirror of {@link AbnormalMark}'s leading box: an aria-hidden,
 * empty inline-block the width of ` Dr`, holding the place the suffix would have
 * taken. The rendered text is still a bare zero — nothing is announced, nothing
 * is copied, and the decimals stay in the column.
 */
export const SideAmount = ({minor}: {minor: number}) => (
  <>
    {formatWithSide(minor)}
    {minor === 0 ? <span aria-hidden="true" style={{display: 'inline-block', width: '1.33em'}} /> : null}
  </>
);

// ── Shared pieces ─────────────────────────────────────────────────────────────

/**
 * The "books are not set up" state, with the same one-click seeding the journal
 * block offers — an empty report should hand you the next step, not a blank
 * grid.
 *
 * `readOnly` is the PAGE's lock (callers pass their derived `pageLocked`, never
 * `editor.readOnly` — LGR-23): on a read-only page the button is off in the
 * register's off vocabulary — dashed, out of the tab order, with the reason
 * rendered beside it and wired by `aria-describedby` — instead of a live-looking
 * control whose refusal the reader discovers from the server.
 */
export const SetupPrompt = ({label, readOnly, onDone}: {label: string; readOnly: boolean; onDone: () => void}) => {
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  // Per instance: two set-up prompts on one page must not hand their disabled
  // buttons the same `aria-describedby` target.
  const whyId = React.useId();
  return (
    <div style={{display: 'flex', flexDirection: 'column', gap: '0.5rem'}}>
      <div style={{display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap'}}>
        <span>📒 The books are not set up yet — there is nothing to report on.</span>
        <button
          type="button"
          data-ledger-setup-button
          style={readOnly ? disabledButtonStyle : buttonStyle}
          disabled={readOnly || busy}
          aria-describedby={readOnly ? whyId : undefined}
          onClick={() => {
            if (busy) return;
            setBusy(true);
            setError(null);
            void setUpBooks(api.ledger)
              .then(() => onDone())
              .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
              .finally(() => setBusy(false));
          }}
        >
          {busy ? 'Setting up…' : label}
        </button>
        {readOnly && (
          <span id={whyId} data-ledger-setup-why="read-only" style={mutedStyle}>
            This page is read-only, so the books cannot be set up from it.
          </span>
        )}
      </div>
      {error !== null && (
        <div data-ledger-error role="status" aria-live="polite" style={noticeStyle('alarm')}>
          {error}
        </div>
      )}
    </div>
  );
};

/**
 * A hierarchical account name with a break opportunity after every colon, so a
 * narrow column wraps at the hierarchy boundary (`Equity:` / `OpeningBalances`)
 * rather than mid-word. `<wbr>` is a break OPPORTUNITY, not a character: the
 * rendered text, the accessible name and anything copied out are still exactly
 * the account's name.
 */
export const AccountName = ({name}: {name: string}) => (
  <>
    {name.split(':').map((segment, i) => (
      <React.Fragment key={i}>
        {i > 0 ? ':' : ''}
        {i > 0 ? <wbr /> : null}
        {segment}
      </React.Fragment>
    ))}
  </>
);

/**
 * An empty-state sentence: what is missing, and what to do about it. Inherits
 * `--foreground` — when this is the ONLY content on screen it must not also be
 * the least legible thing on it.
 */
export const EmptyState = ({children}: {children: React.ReactNode}) => (
  <div data-ledger-empty role="status" aria-live="polite" style={noticeStyle('quiet')}>
    {children}
  </div>
);

/**
 * The truncation caveat — shown ONLY when the read actually hit the cap.
 *
 * `info`, not `alarm`: on a book past the cap this is permanently on screen, and
 * a standing red box would train the reader to ignore the colour the imbalance
 * assertion needs. `detail` lets each report say what truncation costs IT — a
 * missing total is not the same failure as a running balance computed from an
 * incomplete opening figure.
 */
export const TruncationNotice = ({shown, detail}: {shown: boolean; detail: string}) =>
  shown ? (
    <div data-ledger-truncated role="status" aria-live="polite" style={noticeStyle('info')}>
      Partial read — only the {REPORT_TX_LIMIT} most recently ENTERED transactions were loaded (newest first by entry time, not by date). {detail}
    </div>
  ) : null;

/**
 * A report-level failure, in a human sentence with the raw cause demoted.
 *
 * The two failures are not the same and must not offer the same affordance: a
 * host/transport error is worth retrying, whereas a fold error means a stored
 * amount cannot be totalled at all — retrying re-reads the same damaged entry,
 * so offering a Retry there is a dead end dressed as a way out.
 */
export const ReportError = ({kind, detail, onRetry}: {kind: 'host' | 'fold'; detail: string; onRetry: () => void}) => (
  <div data-ledger-error={kind} role="status" aria-live="polite" style={noticeStyle('alarm')}>
    <div>
      {kind === 'host'
        ? 'This report could not be loaded.'
        : 'This report could not be computed — an entry stores an amount outside the range the ledger can total. The book has a damaged entry.'}
      {kind === 'host' && (
        <button type="button" data-ledger-retry style={{...buttonStyle, marginLeft: '0.5rem', fontWeight: 400}} onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
    <div style={{...mutedStyle, fontWeight: 400, marginTop: '0.25rem'}}>{detail}</div>
  </div>
);

/**
 * The scroll container every report table sits in.
 *
 * `tabIndex={0}` is not optional (WCAG 2.1.1): a scrollable div that cannot take
 * focus cannot be scrolled by keyboard in Safari at all — and the column that
 * scrolls out of view is the running balance. Focusable + labelled also gives
 * each table a navigable landmark, which the blocks otherwise lack.
 */
export const TableRegion = ({label, children}: {label: string; children: React.ReactNode}) => (
  <div tabIndex={0} role="region" aria-label={label} style={tableScrollStyle}>
    {children}
  </div>
);
