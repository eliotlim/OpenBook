import React from 'react';
import {LedgerError, api} from '@book.dev/plugin-sdk';
import {
  EmptyState,
  ReportError,
  SetupPrompt,
  buttonStyle,
  frameStyle,
  mutedStyle,
  noticeStyle,
  titleStyle,
  useLedgerReport,
  type BlockLike,
  type EditorLike,
} from './reportShell';

/**
 * The BEANCOUNT EXPORT block (LGR-13) — "Export & verify": download the whole
 * book as a Beancount journal, and run the ledger's own independent verifier,
 * reporting BOTH results side by side.
 *
 * WHY BOTH IN ONE PRESS: the journal is the ledger's external reference copy —
 * `bean-check`/Fava re-verify it with an independent implementation — and a
 * copy of a book the verifier has findings against is a copy of damage. The
 * action therefore always says what the verifier thought of the book it just
 * exported; a verify refusal (the report is admin-gated on shared servers)
 * downgrades to a named notice, never a silent skip.
 *
 * READ-ONLY PAGES: both halves of the action are READS — the export reads the
 * book, the verifier reads raw storage; neither writes a byte to the library —
 * so the button deliberately does NOT gate on `pageReadOnly` (the same posture
 * as the report blocks, which render on read-only pages). The one write
 * control on this surface is the uninitialized-state SetupPrompt, and that
 * gates on `pageLocked` exactly like every other block's.
 *
 * FOCUS: the one control disables while busy, and a browser answers disabling
 * the focused element by dumping focus on `<body>` — so completion restores
 * focus to the re-enabled button (the period-close block's retry-until-enabled
 * pattern).
 */

interface VerifyOutcome {
  state: 'clean' | 'findings' | 'unavailable';
  text: string;
  /** The first few findings, named (only when `state` is `'findings'`). */
  details: string[];
}

/** The downloaded file's name — also how the docs refer to the artifact. */
export const BEANCOUNT_EXPORT_FILENAME = 'ledger.beancount';

/** One `txn` block per reported transaction — the honest count to report. */
export function countBeancountTransactions(journal: string): number {
  return (journal.match(/^\d{4}-\d{2}-\d{2} \* /gm) ?? []).length;
}

/** The success sentence for the export half of the action. */
export function describeBeancountExport(journal: string): string {
  const bytes = new TextEncoder().encode(journal).length;
  const count = countBeancountTransactions(journal);
  const entries = count === 1 ? '1 transaction' : `${count} transactions`;
  return `Exported ${BEANCOUNT_EXPORT_FILENAME} — ${entries}, ${bytes.toLocaleString('en-US')} bytes. Check it with bean-check or open it in Fava.`;
}

/** The verifier's verdict as one sentence (plus named findings when red). */
export function describeVerifyOutcome(report: {
  initialized: boolean;
  checkedTransactions: number;
  checkedPostings: number;
  checkedAuditEvents: number;
  findings: Array<{code: string; message: string}>;
}): VerifyOutcome {
  if (!report.initialized) {
    return {state: 'clean', text: 'Verifier: the ledger is not initialized — nothing to check.', details: []};
  }
  if (report.findings.length === 0) {
    return {
      state: 'clean',
      text: `Verifier: clean — ${report.checkedTransactions} transactions, ${report.checkedPostings} postings and ${report.checkedAuditEvents} audit events checked against raw storage.`,
      details: [],
    };
  }
  const named = report.findings.slice(0, 3).map((f) => `${f.code}: ${f.message}`);
  const rest = report.findings.length - named.length;
  return {
    state: 'findings',
    text: `Verifier: ${report.findings.length} finding${report.findings.length === 1 ? '' : 's'} — this export is a copy of a damaged book.`,
    details: rest > 0 ? [...named, `+ ${rest} more`] : named,
  };
}

/** The named downgrade when the admin-gated report refuses this caller. */
export function describeVerifyUnavailable(err: unknown): VerifyOutcome {
  const detail = err instanceof Error ? err.message : String(err);
  return {
    state: 'unavailable',
    text: `Verifier unavailable to this account (it is owner/admin-gated) — the export completed without it. ${detail}`,
    details: [],
  };
}

/** Hand the journal to the browser as a file download. */
function deliverDownload(text: string): void {
  const url = URL.createObjectURL(new Blob([text], {type: 'text/plain;charset=utf-8'}));
  try {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = BEANCOUNT_EXPORT_FILENAME;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
}

export const BeancountExportBlock = ({editor, pageReadOnly}: {block: BlockLike; editor: EditorLike; pageReadOnly?: boolean}) => {
  const data = useLedgerReport();
  const pageLocked = pageReadOnly ?? editor.readOnly;
  const [busy, setBusy] = React.useState(false);
  const [exported, setExported] = React.useState<string | null>(null);
  const [verify, setVerify] = React.useState<VerifyOutcome | null>(null);
  const [actionError, setActionError] = React.useState<string | null>(null);

  // Completion re-enables the one button this block has; put focus back on it
  // (disabling the focused element dumped it on <body>).
  const rootRef = React.useRef<HTMLDivElement | null>(null);
  const restoreFocus = React.useRef(false);
  React.useEffect(() => {
    if (!restoreFocus.current || busy) return;
    restoreFocus.current = false;
    rootRef.current?.querySelector<HTMLElement>('[data-ledger-beancount-run]')?.focus();
  }, [busy]);

  const run = async (): Promise<void> => {
    setBusy(true);
    restoreFocus.current = true;
    setActionError(null);
    setExported(null);
    setVerify(null);
    let journal: string;
    try {
      journal = await api.ledger.exportBeancount();
    } catch (err) {
      // The reference export REFUSES a corrupt book (typed error) rather than
      // serializing plausible-but-wrong directives — say so, with the reason.
      setActionError(err instanceof LedgerError || err instanceof Error ? err.message : String(err));
      setBusy(false);
      return;
    }
    setExported(describeBeancountExport(journal));
    try {
      deliverDownload(journal);
    } catch {
      setActionError('Your browser refused the file download — the export text was built, but could not be saved.');
    }
    try {
      setVerify(describeVerifyOutcome(await api.ledger.verify()));
    } catch (err) {
      setVerify(describeVerifyUnavailable(err));
    }
    setBusy(false);
  };

  if (data.state === 'loading') {
    return <div style={frameStyle} data-ledger-beancount><span style={mutedStyle}>Loading ledger…</span></div>;
  }
  if (data.state === 'uninitialized') {
    return (
      <div style={frameStyle} data-ledger-beancount>
        <div style={titleStyle}>Beancount export</div>
        <SetupPrompt label="Beancount export" readOnly={pageLocked} onDone={data.reload} />
      </div>
    );
  }
  if (data.state === 'error') {
    return (
      <div style={frameStyle} data-ledger-beancount>
        <div style={titleStyle}>Beancount export</div>
        <ReportError kind="host" detail={data.error ?? 'unknown error'} onRetry={data.reload} />
      </div>
    );
  }

  return (
    <div style={frameStyle} data-ledger-beancount ref={rootRef}>
      <div style={titleStyle}>Beancount export</div>
      <div style={mutedStyle}>
        Download the whole book as a Beancount journal — a plain-text format an independent accounting
        toolchain (bean-check, Fava) can re-verify — and run the ledger&rsquo;s own integrity verifier on the
        same book, so the copy leaves with a verdict attached.
      </div>

      <div>
        <button
          type="button"
          data-ledger-beancount-run
          style={{...buttonStyle, ...(busy ? {cursor: 'wait'} : {})}}
          disabled={busy}
          onClick={() => void run()}
        >
          {busy ? 'Exporting…' : 'Export & verify'}
        </button>
      </div>

      {actionError !== null && (
        <div style={noticeStyle('alarm')} role="alert" data-ledger-beancount-error>{actionError}</div>
      )}
      {exported !== null && (
        <div style={noticeStyle('info')} role="status" data-ledger-beancount-done>{exported}</div>
      )}
      {verify !== null && (
        <div
          style={noticeStyle(verify.state === 'findings' ? 'alarm' : verify.state === 'unavailable' ? 'quiet' : 'info')}
          role={verify.state === 'findings' ? 'alert' : 'status'}
          data-ledger-beancount-verify={verify.state}
        >
          <div>{verify.text}</div>
          {verify.details.length > 0 && (
            <ul style={{margin: '0.35rem 0 0', paddingLeft: '1.2rem'}}>
              {verify.details.map((line) => <li key={line}>{line}</li>)}
            </ul>
          )}
        </div>
      )}
      {data.transactions.length === 0 && exported === null && (
        <EmptyState>The book has no entries yet — the export would carry only the chart of accounts.</EmptyState>
      )}
    </div>
  );
};
