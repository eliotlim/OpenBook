import React from 'react';
import {api} from '@book.dev/plugin-sdk';
import {CLEARED_LABEL, describeDraftExclusion, normalSideFor, type NormalSide} from './reports';
import {
  RECONCILIATION_STATUS_LABEL,
  buildReconcileSheet,
  describeBalanceEcho,
  describeBalanceLabel,
  describeDifference,
  describeFinishBlock,
  describeFrozenElsewhere,
  describeGap,
  describeOutstandingHeading,
  describeOutstandingIntro,
  describeReconcileSummary,
  describeRowLabel,
  describeSingleCulprit,
  describeUnmatchedCaveat,
  formatOnNormalSide,
  isOutstanding,
  isRowLocked,
  parseStatementBalance,
  statementBalanceInput,
  type ReconcileRow,
  type ReconcileSheet,
  type ReconcileStatus,
} from './reconcile';
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
  SECONDARY_TEXT,
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
 * The RECONCILE block (LGR-11) — the surface that turns "the import probably
 * worked" into "these books agree with the bank, to the penny, as at this date".
 *
 * It is the account register plus two things: a TARGET (what the statement says
 * the balance is) and a DIFFERENCE (what is left to explain). You tick the
 * postings that appear on the statement; the difference moves; when it reads
 * exactly 0.00 the Finish control comes alive, and finishing freezes what you
 * matched so a later edit cannot quietly undo the reconciliation.
 *
 * THE GATE IS NOT THIS BUTTON. `finish` is refused by the server at any nonzero
 * difference, so the disabled state here is an explanation, not an enforcement
 * — see `LedgerStore.finishReconciliation`. That separation is deliberate: a
 * bookkeeping control that only exists in a React component is not a control.
 *
 * All arithmetic lives in `./reconcile`; this file renders strings and never
 * adds two amounts together.
 */

const PROP_RECONCILIATION = 'ledgerRecId';
const PROP_ACCOUNT = 'ledgerRecAccount';
const PROP_DATE = 'ledgerRecDate';
const PROP_BALANCE = 'ledgerRecBalance';

/** The busy/error state every host call in this block shares. */
interface Action {
  busy: boolean;
  error: string | null;
}

const IDLE: Action = {busy: false, error: null};

/**
 * An unconfirmed tick: what the user asked for (`want`), and what the books said
 * at the moment they asked (`seen`).
 *
 * `seen` is what makes retirement correct. Dropping the guess only when the fold
 * MATCHES it leaves a stale box pinned forever if a third party moves the
 * posting the other way — the checkbox would then show one thing over a total
 * that counts another. Any movement retires the guess; the truth renders.
 */
interface OptimisticTick {
  want: boolean;
  seen: boolean;
}

/** Remove one key from an optimistic-tick map, without mutating it. */
const dropKey = (map: Record<string, OptimisticTick>, key: string): Record<string, OptimisticTick> => {
  if (!(key in map)) return map;
  const next = {...map};
  delete next[key];
  return next;
};

/**
 * What the block is asking for, beyond the checklist itself.
 *
 * `amend` and `abandon` are LGR-22's two exits from a reconciliation that can
 * never balance — a mistyped closing balance is otherwise terminal for the
 * account, because Finish needs a zero difference that a wrong target makes
 * unreachable and Start refuses a second open statement. `confirm-finish` is
 * the notice shown when finishing would leave postings unaccounted for; it is a
 * step, never a gate.
 */
type Mode = 'none' | 'amend' | 'abandon' | 'confirm-finish';

/**
 * A button face that LOOKS dead when it is dead.
 *
 * `buttonStyle` sets colour and background inline, which beats the UA's
 * `:disabled` rule entirely — measured on the Finish button, the dead and the
 * live control were pixel-identical down to the label's darkest pixel, so the
 * gate read as live and a click did nothing. That fix then sat on Finish ALONE
 * while every button added since (Amend, Abandon, Save, both confirms') shipped
 * the same defect on plain `buttonStyle` — the exact one-fact-two-places drift
 * this helper ends. Still legible when dead (5.14:1 light / 5.37:1 dark):
 * disabled is not a reason to be unreadable.
 */
const buttonFace = (dead: boolean, extra: React.CSSProperties = {}): React.CSSProperties => ({
  ...buttonStyle,
  ...extra,
  ...(dead ? {color: SECONDARY_TEXT, background: 'hsl(var(--muted))', cursor: 'not-allowed'} : {}),
});

/**
 * Where keyboard focus must land after the NEXT render.
 *
 * Every sub-flow transition here either disables or unmounts the element that
 * is focused at the moment of the press — opening Amend disables the Amend
 * button, every Cancel unmounts itself — and a browser answers both by dumping
 * focus on `<body>`, which strands a keyboard or screen-reader user at the top
 * of the document. The element to focus instead often does not EXIST until the
 * re-render commits (the form being opened) or is disabled until it (the
 * invoker being returned to), so the handler records an intent and the
 * after-render effect performs it.
 *
 * The SUCCESS paths of finish and abandon deliberately target the one control
 * that survives the status change (`close` — "Pick another statement"): the
 * invoking button unmounts when the reloaded status lands, on a timetable this
 * component does not control, and focus returned to it would be dumped on
 * `<body>` moments later anyway.
 */
type FocusTarget =
  | 'amend-open' // the amend form's first field
  | 'amend-invoker' // the Amend button
  | 'amend-save' // the form's Save (after a refused save re-enables it)
  | 'abandon-open' // the abandon confirm's primary button
  | 'abandon-invoker' // the Abandon button
  | 'finish-confirm' // the finish confirm's primary button
  | 'finish-invoker' // the Finish button
  | 'close'; // "Pick another statement" — present in every status

export const ReconcileBlock = ({block, editor}: {block: BlockLike; editor: EditorLike}) => {
  const data = useLedgerReport();
  const props = readProps(block);
  const [reconciliationId, setReconciliationId] = React.useState<string>(() => readString(props, PROP_RECONCILIATION));
  const [accountId, setAccountId] = React.useState<string>(() => readString(props, PROP_ACCOUNT));
  const [statementDate, setStatementDate] = React.useState<string>(() => readString(props, PROP_DATE));
  const [balanceText, setBalanceText] = React.useState<string>(() => readString(props, PROP_BALANCE));
  const [action, setAction] = React.useState<Action>(IDLE);
  /**
   * Ticks the user has made that the books have not confirmed yet.
   *
   * The checkbox is CONTROLLED by the folded data, and the fold only changes
   * once the server has committed and the subscription has fired — so without
   * this the box visibly snaps back on click and the tick reads as broken. The
   * optimistic value wins until the book agrees with it, and is dropped (back
   * to the truth) the moment it does or the moment the write fails.
   */
  const [optimistic, setOptimistic] = React.useState<Record<string, OptimisticTick>>({});
  /**
   * The open sub-flow, and the amend form's draft.
   *
   * The draft is NOT written to the block props. `PROP_DATE`/`PROP_BALANCE` are
   * the START form's memory of what to open next; an amend edits a statement
   * that already exists on the server, and letting the two share a cell meant
   * cancelling an amend silently rewrote what the next Start would propose.
   */
  const [mode, setMode] = React.useState<Mode>('none');
  const [amendDate, setAmendDate] = React.useState('');
  const [amendBalance, setAmendBalance] = React.useState('');

  // Focus management (see {@link FocusTarget}): the intent is a ref, not
  // state — recording it must never itself schedule a render.
  const pendingFocus = React.useRef<FocusTarget | null>(null);
  const amendButtonRef = React.useRef<HTMLButtonElement | null>(null);
  const amendDateRef = React.useRef<HTMLInputElement | null>(null);
  const amendSaveRef = React.useRef<HTMLButtonElement | null>(null);
  const abandonButtonRef = React.useRef<HTMLButtonElement | null>(null);
  const abandonYesRef = React.useRef<HTMLButtonElement | null>(null);
  const finishButtonRef = React.useRef<HTMLButtonElement | null>(null);
  const finishYesRef = React.useRef<HTMLButtonElement | null>(null);
  const closeButtonRef = React.useRef<HTMLButtonElement | null>(null);

  /** Record where focus must land once the pending render has committed. */
  const focusNext = (target: FocusTarget): void => {
    pendingFocus.current = target;
  };

  // After EVERY commit, perform the recorded focus intent. After the commit,
  // and not in the handler, because the element is only now mounted (an opening
  // form) or only now re-enabled (a returned-to invoker) — `.focus()` on a
  // disabled element is a silent no-op, which is how the earlier attempt at
  // this in the register block stayed green while doing nothing.
  React.useEffect(() => {
    if (pendingFocus.current === null) return;
    const target = pendingFocus.current;
    pendingFocus.current = null;
    const el =
      target === 'amend-open' ? amendDateRef.current
        : target === 'amend-invoker' ? amendButtonRef.current
          : target === 'amend-save' ? amendSaveRef.current
            : target === 'abandon-open' ? abandonYesRef.current
              : target === 'abandon-invoker' ? abandonButtonRef.current
                : target === 'finish-confirm' ? finishYesRef.current
                  : target === 'finish-invoker' ? finishButtonRef.current
                    : closeButtonRef.current;
    // A vanished target (the reload landed first and unmounted it) falls back
    // to the one control every status renders, never to <body>.
    (el ?? closeButtonRef.current)?.focus();
  });

  const update = (key: string, value: string, apply: (v: string) => void): void => {
    apply(value);
    writeProp(block, editor, key, value);
  };

  /**
   * Run one ledger mutation, surfacing its failure as a sentence rather than an
   * unhandled rejection. Typed `LedgerError`s already carry a human message —
   * "a reconciliation can only be finished at a difference of exactly 0.00" is
   * exactly what belongs on screen, so nothing is rewritten here.
   */
  const run = async (fn: () => Promise<unknown>): Promise<boolean> => {
    setAction({busy: true, error: null});
    try {
      await fn();
      setAction(IDLE);
      return true;
    } catch (err) {
      setAction({busy: false, error: err instanceof Error ? err.message : String(err)});
      return false;
    }
  };

  const statement = data.reconciliations.find((r) => r.id === reconciliationId) ?? null;
  /**
   * A remembered reconciliation the book no longer has. Deleting the ledger, or
   * opening this page against a different library, otherwise left the block
   * silently back on the start form with the stale id still in its props —
   * clicking Start would then fail on the duplicate. Say what happened and drop
   * the id.
   */
  const stranded = reconciliationId !== '' && statement === null && data.state === 'ready';
  const sortedAccounts = [...data.accounts].sort((a, b) => a.name.localeCompare(b.name));
  // The normal side of the account being STARTED, so the balance box can say
  // which way its number is read before a reconciliation exists at all.
  const startSide: NormalSide = normalSideFor(sortedAccounts.find((a) => a.id === accountId)?.type ?? null);
  const parsedBalance = parseStatementBalance(balanceText, startSide);

  // Same discipline as every other report block: a stored amount the money core
  // refuses to add is a fold failure, not a crashed document.
  let sheet: ReconcileSheet | null = null;
  let foldError: string | null = null;
  try {
    sheet = statement === null ? null : buildReconcileSheet(statement, data.accounts, data.transactions, data.reconciliations);
  } catch (err) {
    foldError = err instanceof Error ? err.message : String(err);
  }

  // Each of these was being recomputed two or three times per render (once to
  // test for null, once to render). One call, one value.
  const finishReason = sheet !== null ? describeFinishBlock(sheet) : null;
  const gap = sheet !== null ? describeGap(sheet) : null;
  const culprit = sheet !== null ? describeSingleCulprit(sheet) : null;
  const unmatchedCaveat = sheet !== null ? describeUnmatchedCaveat(sheet) : null;
  const frozenElsewhere = sheet !== null ? describeFrozenElsewhere(sheet) : null;
  const finishDead = sheet === null || !sheet.canFinish || action.busy || editor.readOnly;
  const finishHintId = `ledger-finish-hint-${reconciliationId}`;
  const outstandingHeading = sheet !== null ? describeOutstandingHeading(sheet) : null;
  /** The amend draft, read through the SAME parser the start form uses. */
  const amendParsed = parseStatementBalance(amendBalance, sheet?.normalSide ?? 'debit');

  /** Open the amend form on the statement as it currently stands. */
  const beginAmend = (): void => {
    if (sheet === null) return;
    setAction(IDLE);
    setAmendDate(sheet.statementDate);
    setAmendBalance(statementBalanceInput(sheet.statementBalanceMinor, sheet.normalSide));
    focusNext('amend-open');
    setMode('amend');
  };

  const saveAmend = (): void => {
    if (statement === null || !amendParsed.ok || amendDate === '') return;
    void run(async () => {
      await api.ledger.amendReconciliation(statement.id, {
        statementDate: amendDate,
        statementBalanceMinor: amendParsed.minor,
      });
      data.reload();
    }).then((ok) => {
      // A REFUSED amend keeps the form open with what was typed still in it:
      // closing it would throw the correction away and leave only the error
      // message, and the whole point of this control is to not have to retype.
      // Focus goes back to Save either way — pressing it disabled it (busy),
      // which dropped focus to <body>; on success Save is about to unmount, so
      // the target is the re-enabled invoker instead.
      focusNext(ok ? 'amend-invoker' : 'amend-save');
      if (ok) setMode('none');
    });
  };

  const cancelAmend = (): void => {
    focusNext('amend-invoker');
    setMode('none');
  };

  const beginAbandon = (): void => {
    setAction(IDLE);
    focusNext('abandon-open');
    setMode('abandon');
  };

  const abandon = (): void => {
    if (statement === null) return;
    void run(async () => {
      await api.ledger.abandonReconciliation(statement.id);
      data.reload();
    }).then((ok) => {
      // Success unmounts the whole action set when the abandoned status lands,
      // so the target is the one control that survives it (`close`), never the
      // Abandon button that is about to disappear.
      focusNext(ok ? 'close' : 'abandon-open');
      if (ok) setMode('none');
    });
  };

  const cancelAbandon = (): void => {
    focusNext('abandon-invoker');
    setMode('none');
  };

  /**
   * The Finish PRESS — via the unmatched notice when there is one to show.
   *
   * The notice is a STEP, not a gate: `confirm-finish` renders the same sentence
   * the standing caveat does and offers "Finish anyway" right there. Unticked
   * postings are frequently just money that has not reached the bank, so
   * blocking would be wrong; being silent about a possible duplicate at the
   * moment the books are being certified would be worse.
   *
   * A SECOND press while the confirm is open must NOT finish. The version that
   * fell through to the commit branch turned a habitual double-click — or a
   * double Enter on the still-focused button — into certification without the
   * confirm ever being read, which unmakes the confirm's entire reason to
   * exist. It routes focus to the confirm instead: the press means "finish",
   * and the confirm's own button is now the only thing that does that.
   */
  const requestFinish = (): void => {
    if (statement === null) return;
    if (mode === 'confirm-finish') {
      // Already mounted, so no render is pending — focus it directly.
      finishYesRef.current?.focus();
      return;
    }
    if (unmatchedCaveat !== null) {
      setAction(IDLE);
      focusNext('finish-confirm');
      setMode('confirm-finish');
      return;
    }
    commitFinish();
  };

  /** The COMMIT — reached from a clean press, or from the confirm's own button. */
  const commitFinish = (): void => {
    if (statement === null) return;
    void run(() => api.ledger.finishReconciliation(statement.id)).then((ok) => {
      // Success: the Finish button unmounts when the finished status lands —
      // target the control that survives. Refusal with the confirm open: the
      // confirm stays (its button re-enables); without it, back to Finish.
      focusNext(ok ? 'close' : mode === 'confirm-finish' ? 'finish-confirm' : 'finish-invoker');
      if (ok) setMode('none');
    });
  };

  const cancelFinishConfirm = (): void => {
    focusNext('finish-invoker');
    setMode('none');
  };

  const start = (): void => {
    if (!parsedBalance.ok) return;
    void run(async () => {
      const created = await api.ledger.startReconciliation({
        accountId,
        statementDate,
        statementBalanceMinor: parsedBalance.minor,
      });
      update(PROP_RECONCILIATION, created.id, setReconciliationId);
      data.reload();
    });
  };

  const toggle = (postingId: string, matched: boolean): void => {
    if (statement === null) return;
    const seen = sheet?.rows.find((r) => r.postingId === postingId)?.matched ?? !matched;
    setOptimistic((o) => ({...o, [postingId]: {want: matched, seen}}));
    void run(() => api.ledger.toggleReconciliationPosting(statement.id, postingId, matched ? 'cleared' : 'pending')).then((ok) => {
      // A rejected tick must not leave the box showing a state the books do not
      // hold — drop the guess and let the truth render.
      if (!ok) setOptimistic((o) => dropKey(o, postingId));
    });
  };

  /**
   * Retire each optimistic tick as soon as the books MOVE — not only when they
   * arrive at the guessed value.
   *
   * Waiting for a match pins the guess forever in the case that matters: a
   * second client (or a reopen elsewhere) puts the posting back, the fold
   * reports the opposite of what was asked for, and the box keeps rendering the
   * local answer over a total that counts the real one. Comparing against what
   * the fold said WHEN THE GUESS WAS MADE retires it either way.
   */
  // A sub-flow belongs to ONE statement. Switching statements (Pick another,
  // Resume, or the stranded-id reset) must not leave an amend form holding the
  // previous statement's date and balance over a different account's checklist.
  React.useEffect(() => {
    setMode('none');
  }, [reconciliationId]);

  React.useEffect(() => {
    if (sheet === null) return;
    const moved = sheet.rows.filter((r) => r.postingId in optimistic && optimistic[r.postingId].seen !== r.matched).map((r) => r.postingId);
    const vanished = Object.keys(optimistic).filter((id) => !sheet.rows.some((r) => r.postingId === id));
    const stale = [...moved, ...vanished];
    if (stale.length > 0) setOptimistic((o) => stale.reduce(dropKey, o));
  }, [sheet, optimistic]);

  if (data.state === 'loading') {
    return (
      <div data-ledger-reconcile data-ledger-loading contentEditable={false} style={frameStyle}>
        <span style={mutedStyle}>Loading reconciliation…</span>
      </div>
    );
  }

  if (data.state === 'uninitialized') {
    return (
      <div data-ledger-reconcile data-ledger-setup contentEditable={false} style={frameStyle}>
        <h3 style={titleStyle}>
          <span aria-hidden="true">🧾 </span>Reconcile
        </h3>
        <SetupPrompt label="Set up books" readOnly={editor.readOnly} onDone={data.reload} />
      </div>
    );
  }

  return (
    <div data-ledger-reconcile data-ledger-reconcile-status={sheet !== null ? sheet.status : 'none'} contentEditable={false} style={frameStyle}>
      <div style={{display: 'flex', alignItems: 'flex-end', gap: '0.5rem', flexWrap: 'wrap'}}>
        <h3 style={{...titleStyle, lineHeight: '1.9rem'}}>
          <span aria-hidden="true">🧾 </span>Reconcile
        </h3>
        {sheet !== null && (
          <span data-ledger-reconcile-heading style={mutedStyle}>
            <AccountName name={sheet.accountName} /> · statement {sheet.statementDate} · {RECONCILIATION_STATUS_LABEL[sheet.status]}
          </span>
        )}
      </div>

      {data.error !== null && <ReportError kind="host" detail={data.error} onRetry={data.reload} />}
      {foldError !== null && <ReportError kind="fold" detail={foldError} onRetry={data.reload} />}

      {/* A failed host call is a real failure and says so — but it is not the
          books being broken, so it never wears the alarm tone reserved for that. */}
      {action.error !== null && (
        <div data-ledger-action-error role="status" aria-live="polite" style={noticeStyle('info')}>
          {action.error}
        </div>
      )}

      {stranded && (
        <div data-ledger-reconcile-stranded role="status" aria-live="polite" style={noticeStyle('info')}>
          The reconciliation this block was working on is no longer in this library.{' '}
          <button
            type="button"
            data-ledger-reconcile-forget
            style={{...buttonStyle, marginLeft: '0.25rem'}}
            onClick={() => update(PROP_RECONCILIATION, '', setReconciliationId)}
          >
            Start a new one
          </button>
        </div>
      )}

      {sheet === null && foldError === null && (
        <StartForm
          accounts={sortedAccounts}
          accountId={accountId}
          statementDate={statementDate}
          balanceText={balanceText}
          balance={parsedBalance}
          normalSide={startSide}
          busy={action.busy}
          readOnly={editor.readOnly}
          onAccount={(v) => update(PROP_ACCOUNT, v, setAccountId)}
          onDate={(v) => update(PROP_DATE, v, setStatementDate)}
          onBalance={(v) => update(PROP_BALANCE, v, setBalanceText)}
          onStart={start}
          existing={data.reconciliations}
          accountNameFor={(id) => sortedAccounts.find((a) => a.id === id)?.name ?? id}
          onResume={(id) => update(PROP_RECONCILIATION, id, setReconciliationId)}
        />
      )}

      {sheet !== null && statement !== null && (
        <>
          <TruncationNotice
            shown={data.truncated}
            detail="Postings older than that window are NOT in the checklist below, so the cleared balance — and therefore the difference — is understated. Do not finish a reconciliation from a partial read."
          />

          {!sheet.exists ? (
            <EmptyState>That account no longer exists. This reconciliation cannot be matched.</EmptyState>
          ) : (
            <>
              <Arithmetic sheet={sheet} />

              {/* OUTSIDE the live region (see `Arithmetic`): guidance changes
                  only when the difference flips direction, so re-announcing it
                  on every tick — ~40 words a time — buries the number that did
                  change under the paragraph that did not. */}
              {gap !== null && (
                <div data-ledger-gap style={mutedStyle}>
                  {gap}
                  {culprit !== null && <span data-ledger-single-culprit> {culprit}</span>}
                </div>
              )}

              {/* Reaching zero explains the STATEMENT, not the books. A posting
                  the statement never mentions is unresolved, not excluded — and
                  on the canonical fixture it is the duplicate. `info`: a caveat,
                  not a broken book. */}
              {unmatchedCaveat !== null && (
                <div data-ledger-unmatched-caveat={sheet.unmatchedCount} role="status" aria-live="polite" style={noticeStyle('info')}>
                  {unmatchedCaveat}
                </div>
              )}

              <div style={{display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center'}}>
                {sheet.status === 'open' && (
                  <button
                    type="button"
                    data-ledger-finish
                    ref={finishButtonRef}
                    style={buttonFace(finishDead, {fontWeight: 600})}
                    disabled={finishDead}
                    aria-describedby={finishReason !== null ? finishHintId : undefined}
                    onClick={requestFinish}
                  >
                    {action.busy ? 'Working…' : 'Finish'}
                  </button>
                )}
                {sheet.status === 'finished' && (
                  <button
                    type="button"
                    data-ledger-reopen
                    style={buttonFace(action.busy || editor.readOnly)}
                    disabled={action.busy || editor.readOnly}
                    onClick={() => void run(() => api.ledger.reopenReconciliation(statement.id))}
                  >
                    {action.busy ? 'Working…' : 'Reopen'}
                  </button>
                )}
                {/* AMEND + ABANDON (LGR-22) — offered only while open, which is
                    the only state the server accepts them in. Amend is first
                    and is not styled as a destructive escape: correcting a
                    mistyped closing balance is the ordinary case, and before
                    this control the only ways out of it were posting a fake
                    entry to force the difference to zero or editing the
                    database by hand. Each is disabled while ITS panel is open —
                    pressing it again would re-open what is already on screen —
                    and the focus intents recorded on open/close are what keep
                    that disabling from stranding keyboard focus on <body>. */}
                {sheet.status === 'open' && (
                  <>
                    <button
                      type="button"
                      data-ledger-amend
                      ref={amendButtonRef}
                      style={buttonFace(action.busy || editor.readOnly || mode === 'amend')}
                      disabled={action.busy || editor.readOnly || mode === 'amend'}
                      onClick={beginAmend}
                    >
                      Amend statement
                    </button>
                    <button
                      type="button"
                      data-ledger-abandon
                      ref={abandonButtonRef}
                      style={buttonFace(action.busy || editor.readOnly || mode === 'abandon')}
                      disabled={action.busy || editor.readOnly || mode === 'abandon'}
                      onClick={beginAbandon}
                    >
                      Abandon
                    </button>
                  </>
                )}
                {/* Immediately after the control it is about, and wired to it:
                    a disabled button is out of the tab order, so a reason
                    sitting past an unrelated button is unreachable by keyboard
                    and never announced. */}
                {finishReason !== null && (
                  <span id={finishHintId} data-ledger-finish-hint style={mutedStyle}>
                    {finishReason.rule}
                    {/* The live figure is inside the described element, so the
                        accessible description carries it — but it is not
                        printed again for a reader who has it two lines above. */}
                    {finishReason.live !== null && <SrOnly> {finishReason.live}</SrOnly>}
                  </span>
                )}
                <button
                  type="button"
                  data-ledger-reconcile-close
                  ref={closeButtonRef}
                  style={buttonFace(action.busy)}
                  disabled={action.busy}
                  onClick={() => update(PROP_RECONCILIATION, '', setReconciliationId)}
                >
                  Pick another statement
                </button>
              </div>

              {/* Finishing with postings the statement never accounted for. The
                  sentence is `describeUnmatchedCaveat` — the SAME string as the
                  standing notice above, because a confirm that reworded the
                  fact would be a second copy free to drift, and this is the one
                  people actually read. Guarded on `canFinish` too, so a tick
                  that lands while this is open cannot leave a confirm offering
                  an action the server would now refuse. */}
              {mode === 'confirm-finish' && unmatchedCaveat !== null && sheet.canFinish && (
                <div data-ledger-finish-confirm role="status" aria-live="polite" style={noticeStyle('info')}>
                  {unmatchedCaveat}
                  <div style={{display: 'flex', gap: '0.5rem', marginTop: '0.4rem', flexWrap: 'wrap'}}>
                    <button
                      type="button"
                      data-ledger-finish-confirm-yes
                      ref={finishYesRef}
                      style={buttonFace(action.busy, {fontWeight: 600})}
                      disabled={action.busy}
                      onClick={commitFinish}
                    >
                      {action.busy ? 'Working…' : 'Finish anyway'}
                    </button>
                    <button type="button" data-ledger-finish-confirm-no style={buttonFace(action.busy)} disabled={action.busy} onClick={cancelFinishConfirm}>
                      Go back and check
                    </button>
                  </div>
                </div>
              )}

              {mode === 'amend' && (
                <AmendForm
                  idBase={`ledger-amend-${reconciliationId}`}
                  normalSide={sheet.normalSide}
                  date={amendDate}
                  balanceText={amendBalance}
                  balance={amendParsed}
                  busy={action.busy}
                  dateRef={amendDateRef}
                  saveRef={amendSaveRef}
                  onDate={setAmendDate}
                  onBalance={setAmendBalance}
                  onSave={saveAmend}
                  onCancel={cancelAmend}
                />
              )}

              {mode === 'abandon' && (
                <div data-ledger-abandon-confirm role="status" aria-live="polite" style={noticeStyle('info')}>
                  {/* What abandoning DOES, in the two facts a person needs
                      before they press it: nothing is posted, and no tick is
                      undone. Both are guarantees of the store, not of this
                      screen — stated here because the person deciding cannot
                      read the store. */}
                  Abandon the {sheet.statementDate} statement? It stays on record as abandoned, nothing is posted to the books, and every posting keeps the
                  cleared state it has now. This account is then free for a new reconciliation — but this one cannot be resumed.
                  <div style={{display: 'flex', gap: '0.5rem', marginTop: '0.4rem', flexWrap: 'wrap'}}>
                    <button
                      type="button"
                      data-ledger-abandon-confirm-yes
                      ref={abandonYesRef}
                      style={buttonFace(action.busy, {fontWeight: 600})}
                      disabled={action.busy}
                      onClick={abandon}
                    >
                      {action.busy ? 'Working…' : 'Abandon this statement'}
                    </button>
                    <button type="button" data-ledger-abandon-confirm-no style={buttonFace(action.busy)} disabled={action.busy} onClick={cancelAbandon}>
                      Keep working on it
                    </button>
                  </div>
                </div>
              )}

              <div data-ledger-drafts-excluded={sheet.draftCount} style={mutedStyle}>
                {describeDraftExclusion(sheet.draftCount)}
              </div>

              {frozenElsewhere !== null && (
                <div data-ledger-frozen-elsewhere={sheet.frozenElsewhereCount} role="status" aria-live="polite" style={noticeStyle('info')}>
                  {frozenElsewhere}
                </div>
              )}

              {sheet.rows.length === 0 ? (
                <EmptyState>No posted entries touch {sheet.accountName} yet — there is nothing to match against this statement.</EmptyState>
              ) : (
                <Checklist sheet={sheet} optimistic={optimistic} readOnly={editor.readOnly} onToggle={toggle} truncated={data.truncated} />
              )}

              <div data-ledger-reconcile-summary style={mutedStyle}>
                {describeReconcileSummary(sheet)}
              </div>

              {/* AFTER FINISHING, the leftovers stop being a live figure and
                  become a standing to-do — so they get a named section with the
                  rows in it, not a 0.75rem grey count under a table. The
                  heading carries the count AND the total, because "1
                  outstanding" and "1 · 950.00 Cr" are different pieces of news.
                  Before finishing this is null: the difference readout and the
                  caveat above are already saying it against a number that
                  moves. */}
              {outstandingHeading !== null && (
                <OutstandingItems sheet={sheet} heading={outstandingHeading} headingId={`ledger-outstanding-${reconciliationId}`} />
              )}
            </>
          )}
        </>
      )}
    </div>
  );
};

/**
 * The three numbers, in the order a bookkeeper checks them. A `<dl>` rather
 * than a table: this is three labelled figures, not a grid, and a table with
 * one data row makes a screen reader announce dimensions that mean nothing.
 *
 * The DIFFERENCE line is the live region. `role="status"` + `aria-live="polite"`
 * and never `role="alert"`: it changes on every single tick, and an assertive
 * region would interrupt a screen-reader user continuously while they work
 * down the checklist — the exact behaviour that teaches people to turn live
 * regions off.
 */
const Arithmetic = ({sheet}: {sheet: ReconcileSheet}) => {
  /**
   * The three figures share ONE decimal column. Three things have to agree for
   * that, and right-alignment alone was only the first:
   *
   *  - the notice box's own padding + border, given back by the two plain cells;
   *  - the `1.33em` aria-hidden gutter `SideAmount` appends when the amount is
   *    ZERO to stand in for a missing ` Dr`/` Cr`. Under right alignment that
   *    spacer pads the RIGHT and pushes `0.00` ~18px left of the figures above
   *    — so the two plain cells must reserve the same gutter, or the balanced
   *    state (the one this screen drives to) is the one that never lines up;
   *  - one font size AND weight across all three, since tabular-nums equalises
   *    digit advance within a face and weight, not across them.
   */
  const figure: React.CSSProperties = {
    margin: 0,
    textAlign: 'right',
    fontVariantNumeric: 'tabular-nums',
    fontSize: '0.85rem',
    fontWeight: 600,
    paddingRight: 'calc(0.6rem + 1px + 1.33em)',
  };
  return (
    <dl data-ledger-arithmetic style={{display: 'grid', gridTemplateColumns: 'auto max-content', gap: '0.15rem 0.75rem', margin: 0, justifyContent: 'start'}}>
      <dt style={{...mutedStyle, alignSelf: 'center'}}>Statement balance</dt>
      {/* The data attribute marks exactly the FIGURE; the screen-reader note is
          its sibling, so a selector for the number never picks up the prose.
          Both figures carry the note — it was on the statement balance only,
          which left the cleared balance's side unstated in the one place the
          two are meant to be compared. */}
      <dd style={figure}>
        <span data-ledger-statement-balance>{formatOnNormalSide(sheet.statementBalanceMinor, sheet.normalSide)}</span>
        <SrOnly> on the {sheet.normalSide} side, this account’s normal side.</SrOnly>
      </dd>
      <dt style={{...mutedStyle, alignSelf: 'center'}}>Cleared balance</dt>
      <dd style={figure}>
        <span data-ledger-cleared-balance>{formatOnNormalSide(sheet.clearedBalanceMinor, sheet.normalSide)}</span>
        <SrOnly> on the {sheet.normalSide} side, this account’s normal side.</SrOnly>
      </dd>
      <dt style={{...mutedStyle, fontWeight: 600, alignSelf: 'center'}}>Difference</dt>
      <dd style={{margin: 0}}>
        {/* The live region is the FIGURE and its one sentence — nothing else.
            Wrapping the guidance paragraph in here too meant ~55 words
            re-announced on every tick, so an eleven-row checklist queued some
            600 words of speech to convey eleven number changes. Politeness is
            not enough on its own; scope is the other half. */}
        <div
          data-ledger-difference
          data-ledger-balanced={sheet.balanced ? 'true' : 'false'}
          role="status"
          aria-live="polite"
          style={{...noticeStyle(sheet.balanced ? 'quiet' : 'info'), fontVariantNumeric: 'tabular-nums', textAlign: 'right'}}
        >
          <div data-ledger-difference-amount style={{fontSize: '0.85rem', fontWeight: 600}}>
            <SideAmount minor={sheet.differenceMinor} />
          </div>
          <div data-ledger-difference-text style={{fontWeight: 400, marginTop: '0.15rem', textAlign: 'left'}}>
            {describeDifference(sheet)}
            {/* The tick is decoration: inside a live region a screen reader
                announces "check mark" on every single re-render. */}
            {sheet.balanced ? <span aria-hidden="true"> ✓</span> : null}
          </div>
        </div>
      </dd>
    </dl>
  );
};

/**
 * Correcting the statement an OPEN reconciliation is matched against (LGR-22).
 *
 * The same three controls the start form uses for date and balance, and the
 * SAME parser — `parseStatementBalance` — so a balance that could not have been
 * started with cannot be amended into either, and the normal-side conversion
 * still happens in exactly one place. What it deliberately does NOT offer is the
 * account: changing that would leave every tick already made pointing at another
 * account's postings, which is not a correction but a different reconciliation.
 */
const AmendForm = ({
  idBase,
  normalSide,
  date,
  balanceText,
  balance,
  busy,
  dateRef,
  saveRef,
  onDate,
  onBalance,
  onSave,
  onCancel,
}: {
  /** Unique per block instance + statement — two reconcile blocks on one page
   *  must not mint the same element ids, or every `aria-describedby` on the
   *  second block resolves to the FIRST block's text. */
  idBase: string;
  normalSide: NormalSide;
  date: string;
  balanceText: string;
  balance: ReturnType<typeof parseStatementBalance>;
  busy: boolean;
  dateRef: React.Ref<HTMLInputElement>;
  saveRef: React.Ref<HTMLButtonElement>;
  onDate: (v: string) => void;
  onBalance: (v: string) => void;
  onSave: () => void;
  onCancel: () => void;
}) => {
  const echoId = `${idBase}-echo`;
  const problemId = `${idBase}-problem`;
  const problem = date === '' ? 'Enter the date the statement closes on.' : !balance.ok ? balance.problem : null;
  // The problem is about ONE input; the live region announces it, but the
  // `aria-describedby` wiring is what lets a user who lands ON that input
  // (or returns to it later) hear why it is the one holding Save closed.
  const dateProblem = date === '';
  const balanceProblem = !dateProblem && !balance.ok;
  return (
    <div data-ledger-amend-form style={{...noticeStyle('quiet'), display: 'flex', flexDirection: 'column', gap: '0.5rem'}}>
      {/* Says what this changes and — the part that matters — what it does not.
          Someone reaching for this has already ticked rows, and the fear that
          stops them using it is losing that work. */}
      <div style={mutedStyle}>Correct what the statement says. Your ticks are kept and nothing is posted to the books; only the difference is recalculated.</div>
      <div style={{display: 'flex', alignItems: 'flex-end', gap: '0.5rem', flexWrap: 'wrap'}}>
        <label style={{display: 'flex', flexDirection: 'column', gap: '0.2rem'}}>
          <span style={mutedStyle}>Statement date</span>
          <input
            type="date"
            data-ledger-amend-date
            ref={dateRef}
            aria-describedby={dateProblem ? problemId : undefined}
            style={controlStyle}
            value={date}
            onChange={(e) => onDate(e.target.value)}
          />
        </label>
        <label style={{display: 'flex', flexDirection: 'column', gap: '0.2rem'}}>
          <span style={mutedStyle}>{describeBalanceLabel(normalSide)}</span>
          <input
            type="text"
            inputMode="decimal"
            data-ledger-amend-balance
            aria-describedby={balanceProblem ? problemId : balance.ok && balanceText.trim() !== '' ? echoId : undefined}
            style={{...controlStyle, minWidth: '9rem', textAlign: 'right'}}
            placeholder="0.00"
            value={balanceText}
            onChange={(e) => onBalance(e.target.value)}
          />
          {balance.ok && balanceText.trim() !== '' && (
            <span id={echoId} data-ledger-amend-echo style={{...mutedStyle, maxWidth: '18rem'}}>
              {describeBalanceEcho(balance.minor, normalSide)}
            </span>
          )}
        </label>
        <button
          type="button"
          data-ledger-amend-save
          ref={saveRef}
          style={buttonFace(problem !== null || busy, {fontWeight: 600})}
          disabled={problem !== null || busy}
          onClick={onSave}
        >
          {busy ? 'Saving…' : 'Save statement'}
        </button>
        <button type="button" data-ledger-amend-cancel style={buttonFace(busy)} disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
      {problem !== null && (
        <div id={problemId} data-ledger-amend-hint role="status" aria-live="polite" style={mutedStyle}>
          {problem}
        </div>
      )}
    </div>
  );
};

/**
 * What a finished statement left behind: the postings on the books that it never
 * accounted for.
 *
 * Rows come from {@link isOutstanding}, the same predicate `buildReconcileSheet`
 * counted with — so the heading's "1 · 950.00 Cr" and the list under it can
 * never describe different sets, which is exactly what a locally re-typed
 * `!row.matched` filter would eventually allow.
 */
const OutstandingItems = ({sheet, heading, headingId}: {sheet: ReconcileSheet; heading: string; headingId: string}) => (
  <section data-ledger-outstanding={sheet.unmatchedCount} aria-labelledby={headingId} style={{...noticeStyle('info'), display: 'flex', flexDirection: 'column', gap: '0.35rem'}}>
    <h4 id={headingId} data-ledger-outstanding-heading style={{...titleStyle, fontSize: '0.85rem', margin: 0}}>
      {heading}
    </h4>
    <div style={mutedStyle}>{describeOutstandingIntro(sheet)}</div>
    <ul data-ledger-outstanding-list style={{margin: 0, paddingLeft: '1.1rem', display: 'flex', flexDirection: 'column', gap: '0.2rem'}}>
      {sheet.rows.filter(isOutstanding).map((row: ReconcileRow) => (
        <li key={row.postingId} data-ledger-outstanding-row={row.postingId}>
          <span style={{fontVariantNumeric: 'tabular-nums'}}>{row.date}</span>
          {row.entryNo !== null && <span style={{...mutedStyle, marginLeft: '0.35rem'}}>#{row.entryNo}</span>}{' '}
          {row.description.trim() === '' ? <span style={mutedStyle}>(no description)</span> : row.description} —{' '}
          <SideAmount minor={row.amountMinor} />
        </li>
      ))}
    </ul>
  </section>
);

/** The candidate postings, with the tick that moves the difference. */
const Checklist = ({
  sheet,
  optimistic,
  readOnly,
  onToggle,
  truncated,
}: {
  sheet: ReconcileSheet;
  optimistic: Record<string, OptimisticTick>;
  readOnly: boolean;
  onToggle: (postingId: string, matched: boolean) => void;
  truncated: boolean;
}) => (
  <TableRegion label="Reconciliation checklist">
    <table data-ledger-reconcile-table style={tableStyle}>
      {/* The caption must never assert completeness the truncation notice
          above has just denied — on a partial read it says so itself, rather
          than describing a checklist that is missing rows. */}
      <caption style={{...mutedStyle, textAlign: 'left', paddingBottom: '0.25rem'}}>
        Every posted entry on <AccountName name={sheet.accountName} />
        {/* Sentence case, not caps: a screen reader announces a fully
            capitalised phrase letter by letter in several common
            configurations, and this is the clause that says the list is
            incomplete — the one that most needs to be understood. */}
        {truncated ? ' within this partial read' : ''} — tick the ones that appear on the {sheet.statementDate} statement.
        Debits and credits are marked Dr/Cr; this account is {sheet.normalSide}-normal.
      </caption>
      <thead>
        <tr>
          <th scope="col" style={thStyle}>
            On statement
          </th>
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
            State
          </th>
          <th scope="col" style={numericHeadStyle}>
            Amount
          </th>
        </tr>
      </thead>
      <tbody>
        {sheet.rows.map((row) => {
          const locked = isRowLocked(sheet, row);
          // The user's own tick wins until the books confirm or refuse it.
          const checked = row.postingId in optimistic ? optimistic[row.postingId].want : row.matched;
          return (
            <tr key={row.postingId} data-ledger-reconcile-row={row.postingId} data-ledger-matched={checked ? 'true' : 'false'}>
              <td style={tdStyle}>
                {/* Entry number, date, description AND amount — the two halves
                    of a duplicated payment otherwise carry byte-identical
                    names, and telling the duplicate from the original is the
                    one distinction this whole workflow turns on. The lock
                    reason is IN the label, not beside it: a disabled checkbox
                    is out of the tab order, so a sibling note never reaches
                    the people it is for. */}
                <input
                  type="checkbox"
                  data-ledger-match={row.postingId}
                  checked={checked}
                  disabled={locked || readOnly}
                  onChange={(e) => onToggle(row.postingId, e.target.checked)}
                  aria-label={describeRowLabel(sheet, row)}
                />
              </td>
              <td style={{...tdStyle, ...mutedStyle, fontVariantNumeric: 'tabular-nums'}}>{row.entryNo === null ? '—' : `#${row.entryNo}`}</td>
              <td style={{...tdStyle, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums'}}>{row.date}</td>
              <td style={{...tdStyle, ...wrapStyle}}>
                {row.description === '' ? <span style={mutedStyle}>(no description)</span> : row.description}
                {row.reversed && (
                  <span style={{...mutedStyle, marginLeft: '0.35rem'}}>
                    (reversed)
                    <SrOnly> — this entry was reversed; its reversing entry appears in this checklist too.</SrOnly>
                  </span>
                )}
              </td>
              <td data-ledger-contra style={{...tdStyle, ...wrapStyle}}>
                <AccountName name={row.contra} />
              </td>
              <td data-ledger-cleared-cell={row.cleared} style={{...tdStyle, ...mutedStyle}}>
                {CLEARED_LABEL[row.cleared]}
                {row.frozen && row.frozenStatementDate !== null && (
                  // `nowrap`: an ISO date broken across lines as `2026-03-` /
                  // `31` reads as two fragments, not one date.
                  <span
                    data-ledger-reconciled-statement={row.frozenStatementDate}
                    style={{display: 'block', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums'}}
                  >
                    {row.frozenStatementDate}
                  </span>
                )}
              </td>
              <td data-ledger-amount style={numericStyle}>
                <SideAmount minor={row.amountMinor} />
              </td>
            </tr>
          );
        })}
      </tbody>
      <tfoot>
        <tr data-ledger-reconcile-totals>
          <th scope="row" colSpan={6} style={{...tdStyle, textAlign: 'left', fontWeight: 600, borderTop: '2px solid hsl(var(--border))', borderBottom: 'none'}}>
            Cleared balance (ticked only)
          </th>
          <td data-ledger-cleared-total style={{...numericStyle, fontWeight: 600, borderTop: '2px solid hsl(var(--border))', borderBottom: 'none'}}>
            <SideAmount minor={sheet.clearedBalanceMinor} />
          </td>
        </tr>
      </tfoot>
    </table>
  </TableRegion>
);

/**
 * Starting a reconciliation, and resuming one already in progress.
 *
 * The Start control stays disabled until all three inputs are usable, and the
 * reason is on screen rather than in a tooltip — a disabled button with no
 * stated cause is the single most common dead end in a form like this.
 */
const StartForm = ({
  accounts,
  accountId,
  statementDate,
  balanceText,
  balance,
  normalSide,
  busy,
  readOnly,
  onAccount,
  onDate,
  onBalance,
  onStart,
  existing,
  accountNameFor,
  onResume,
}: {
  accounts: ReadonlyArray<{id: string; name: string}>;
  accountId: string;
  statementDate: string;
  balanceText: string;
  balance: ReturnType<typeof parseStatementBalance>;
  normalSide: NormalSide;
  busy: boolean;
  readOnly: boolean;
  onAccount: (v: string) => void;
  onDate: (v: string) => void;
  onBalance: (v: string) => void;
  onStart: () => void;
  existing: ReadonlyArray<{id: string; accountId: string; statementDate: string; status: ReconcileStatus}>;
  accountNameFor: (id: string) => string;
  onResume: (id: string) => void;
}) => {
  const balanceHintId = 'ledger-balance-hint';
  const problem =
    accounts.length === 0
      ? 'No accounts yet — run “Ledger: set up books” to seed a chart of accounts.'
      : accountId === ''
        ? 'Pick the account this statement belongs to.'
        : statementDate === ''
          ? 'Enter the date the statement closes on.'
          : !balance.ok
            ? balance.problem
            : null;
  return (
    <>
      <div style={{display: 'flex', alignItems: 'flex-end', gap: '0.5rem', flexWrap: 'wrap'}}>
        <label style={{display: 'flex', flexDirection: 'column', gap: '0.2rem'}}>
          <span style={mutedStyle}>Account</span>
          <select data-ledger-reconcile-account style={{...controlStyle, minWidth: '12rem'}} value={accountId} onChange={(e) => onAccount(e.target.value)}>
            <option value="">Select account…</option>
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.name}
              </option>
            ))}
          </select>
        </label>
        <label style={{display: 'flex', flexDirection: 'column', gap: '0.2rem'}}>
          <span style={mutedStyle}>Statement date</span>
          <input type="date" data-ledger-statement-date style={controlStyle} value={statementDate} onChange={(e) => onDate(e.target.value)} />
        </label>
        <label style={{display: 'flex', flexDirection: 'column', gap: '0.2rem'}}>
          {/* THE LABEL IS THE INSTRUCTION. "Closing balance (credit-normal
              account)" stated a true fact about the account and left the reader
              to derive what to type from it — backwards, at the one moment on
              this screen where the wrong answer costs a difference of exactly
              twice the balance. It now says what to type; the hint below is the
              LIVE echo of what the typed number was taken to mean, which is a
              different thing and not a second copy of this one. */}
          <span style={mutedStyle}>{describeBalanceLabel(normalSide)}</span>
          <input
            type="text"
            inputMode="decimal"
            data-ledger-statement-balance-input
            aria-describedby={balance.ok && balanceText.trim() !== '' ? balanceHintId : undefined}
            style={{...controlStyle, minWidth: '9rem', textAlign: 'right'}}
            placeholder="0.00"
            value={balanceText}
            onChange={(e) => onBalance(e.target.value)}
          />
          {balance.ok && balanceText.trim() !== '' && (
            <span id={balanceHintId} data-ledger-balance-hint style={{...mutedStyle, maxWidth: '18rem'}}>
              <strong data-ledger-balance-echo>{describeBalanceEcho(balance.minor, normalSide)}</strong>
            </span>
          )}
        </label>
        <button type="button" data-ledger-reconcile-start style={buttonStyle} disabled={problem !== null || busy || readOnly} onClick={onStart}>
          {busy ? 'Starting…' : 'Start reconciling'}
        </button>
      </div>

      {problem !== null && (
        <div data-ledger-start-hint role="status" aria-live="polite" style={noticeStyle('quiet')}>
          {problem}
        </div>
      )}

      {existing.length > 0 && (
        <TableRegion label="Reconciliations on this book">
          <table data-ledger-reconcile-list style={tableStyle}>
            <caption style={{...mutedStyle, textAlign: 'left', paddingBottom: '0.25rem'}}>Statements already started on this book.</caption>
            <thead>
              <tr>
                <th scope="col" style={thStyle}>
                  Account
                </th>
                <th scope="col" style={thStyle}>
                  Statement
                </th>
                <th scope="col" style={thStyle}>
                  Status
                </th>
                <th scope="col" style={thStyle}>
                  <SrOnly>Open</SrOnly>
                </th>
              </tr>
            </thead>
            <tbody>
              {existing.map((r) => (
                <tr key={r.id} data-ledger-reconcile-list-row={r.id}>
                  <td style={{...tdStyle, ...wrapStyle}}>
                    <AccountName name={accountNameFor(r.accountId)} />
                  </td>
                  <td style={{...tdStyle, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums'}}>{r.statementDate}</td>
                  <td style={{...tdStyle, ...mutedStyle}}>{RECONCILIATION_STATUS_LABEL[r.status]}</td>
                  <td style={tdStyle}>
                    <button type="button" data-ledger-reconcile-resume={r.id} style={buttonStyle} onClick={() => onResume(r.id)}>
                      {r.status === 'open' ? 'Resume' : 'View'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableRegion>
      )}
    </>
  );
};
