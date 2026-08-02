import React from 'react';
import {api, formatAmount, LedgerError} from '@book.dev/plugin-sdk';
import {
  ALL_CLEARED_STATES,
  CLEARED_LABEL,
  buildAccountRegister,
  correctionBlocker,
  describeCorrectionBlocker,
  describeCorrectionConfirm,
  describeCorrectionDone,
  describeCounterpart,
  describeDraftExclusion,
  describeImmutability,
  describeRegisterFilter,
  describeRegisterSummary,
  formatWithSide,
  isBlockWideBlocker,
  nameEntry,
  registerMatchesAccountBalance,
  type AccountRegister,
  type CorrectionBlocker,
  type CorrectionFailure,
  type RegisterRow,
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
  disabledButtonStyle,
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
  type PropsMap,
} from './reportShell';
import {JournalEntryBlock} from './block';

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
 *
 * CORRECTIONS (LGR-6) — the register is also where a mistake is FIXED, because
 * it is where a mistake is found. A posted entry is immutable in the store, so
 * there is no edit control on any row and the block says so out loud; the way
 * out is "Correct this entry", which posts the reversal the server has always
 * been able to make (`api.ledger.reverse`) and hands back an editable COPY of
 * the original — the real journal entry block (LGR-5), bound to a fresh draft.
 * Nothing is deleted, nothing is hidden, and every row in the resulting pair
 * points at its own counterpart — one hop along the chain — so the repair is
 * reachable from either end.
 *
 * Reversing a REVERSAL is deliberately allowed: a reversal is an ordinary posted
 * entry, and correcting one is how you undo an over-eager correction — it puts
 * the original entry's effect back. The confirmation says so before it happens,
 * and a row whose reverser has itself been reversed sends the reader to the
 * LATEST entry in the chain rather than to another dead control.
 */

const PROP_ACCOUNT = 'ledgerRegAccount';
const PROP_FROM = 'ledgerRegFrom';
const PROP_TO = 'ledgerRegTo';
const PROP_CLEARED = 'ledgerRegCleared';

/**
 * A correction in progress: the reversal has already been posted (permanently),
 * and the copy of the original is waiting as a draft.
 *
 * PERSISTED IN PLUGIN STORAGE, NOT IN THE DOCUMENT. It has to survive a reload,
 * because the reversal is irreversible and the draft is real server-side data —
 * a dropped panel strands both halves of a half-finished correction with nothing
 * on screen connecting them. But it must NOT travel to collaborators: the
 * block's other props are shared VIEW config (which account, which dates), and a
 * half-typed correction is not that. In the CRDT it opened a stranger's panel on
 * everyone's screen and — because a correction in progress blocks the others —
 * turned the only write affordance in the block into a shared lock. Plugin
 * storage is per browser profile, which is the same scope as the person doing
 * the work.
 *
 * It is not a second source of truth either: every field is an id or a number
 * the books already hold, and the panel is only restored once the stored draft
 * is confirmed to still BE a draft.
 */
interface Correction {
  originalId: string;
  originalEntryNo: number | null;
  reversalEntryNo: number | null;
  draftId: string;
}

/** This block's own id, or a shared fallback — for storage keys and DOM ids. */
const blockKey = (block: BlockLike): string => {
  const id = block.get('id');
  return typeof id === 'string' && id !== '' ? id : 'block';
};

/** Storage key — per BLOCK, so two registers on a page keep their own panels. */
const correctionKey = (block: BlockLike): string => `correction.${blockKey(block)}`;

/** Storage is untrusted (it is the user's own localStorage): validate, never cast. */
function parseCorrection(raw: unknown): Correction | null {
  if (raw === null || typeof raw !== 'object') return null;
  const parsed = raw as Partial<Correction>;
  if (typeof parsed.originalId !== 'string' || typeof parsed.draftId !== 'string') return null;
  if (parsed.originalId === '' || parsed.draftId === '') return null;
  const entryNo = (value: unknown): number | null => (typeof value === 'number' && Number.isInteger(value) ? value : null);
  return {
    originalId: parsed.originalId,
    originalEntryNo: entryNo(parsed.originalEntryNo),
    reversalEntryNo: entryNo(parsed.reversalEntryNo),
    draftId: parsed.draftId,
  };
}

/** What was posted, once the corrected copy has gone onto the books. */
interface CorrectionDone {
  originalEntryNo: number | null;
  reversalEntryNo: number | null;
  correctedEntryNo: number | null;
}

/**
 * The block/editor pair the correction panel hands to the REAL journal entry
 * block (LGR-5).
 *
 * The journal block is the ledger's only human write surface and it already owns
 * everything a correction needs to get right — the Post gate, the money core,
 * and the stale-commit guard that re-verifies the server's postings against the
 * screen before committing something immutable. Re-implementing a "small" entry
 * form here would be re-implementing those, so the panel drives the real one and
 * seeds it with nothing but the draft id: the block boots, reads the draft back
 * from the books, and renders the copy through `formatAmount` like any other
 * restored draft.
 *
 * The props map is IN-MEMORY on purpose. The correction draft lives in the
 * ledger, not in the document, so mirroring its raw cell text into the register
 * block's CRDT would put a second copy of an entry into a report block.
 */
function correctionHost(draftId: string, readOnly: boolean): {block: BlockLike; editor: EditorLike} {
  const store = new Map<string, unknown>([['ledgerDraftId', draftId]]);
  const props: PropsMap = {
    get: (key) => store.get(key),
    set: (key, value) => {
      store.set(key, value);
    },
    delete: (key) => {
      store.delete(key);
    },
  };
  return {
    block: {get: (key) => (key === 'props' ? props : undefined)},
    editor: {doc: {transact: (fn: () => void) => fn()}, readOnly},
  };
}

/** The transaction fields the correction path reads back (types are stripped at load). */
interface OriginalLike {
  id: string;
  date: string;
  description: string;
  entryNo: number | null;
  postings: Array<{accountId: string; amountMinor: number; memo: string | null}>;
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

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

  // ── Corrections (LGR-6) ─────────────────────────────────────────────────────
  const storageKey = React.useMemo(() => correctionKey(block), [block]);
  // DOM ids are namespaced by block: two registers on one page must not hand
  // their disabled buttons the same `aria-describedby` target.
  const blockReasonId = React.useMemo(() => `ledger-correct-why-${blockKey(block)}`, [block]);
  const closeWhyId = React.useMemo(() => `ledger-close-why-${blockKey(block)}`, [block]);
  const [confirming, setConfirming] = React.useState<RegisterRow | null>(null);
  const [correction, setCorrection] = React.useState<Correction | null>(() => parseCorrection(api.storage.get(storageKey)));
  const [done, setDone] = React.useState<CorrectionDone | null>(null);
  const [actionError, setActionError] = React.useState<CorrectionFailure | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [highlight, setHighlight] = React.useState<string | null>(null);
  // A restored correction has to be checked against the books ONCE: the draft
  // may have been posted or emptied in another tab, and re-opening a panel
  // around a draft that no longer exists is a dangling claim.
  const restoreCheck = React.useRef(correction !== null);
  const confirmRef = React.useRef<HTMLButtonElement | null>(null);
  const panelRef = React.useRef<HTMLDivElement | null>(null);
  const dismissRef = React.useRef<HTMLButtonElement | null>(null);
  const errorRef = React.useRef<HTMLDivElement | null>(null);
  const counterpartRefs = React.useRef(new Map<string, HTMLButtonElement | null>());
  // Where focus goes back to when a correction fails or is dismissed — the
  // control the user actually pressed, not the top of the document.
  const correctRefs = React.useRef(new Map<string, HTMLButtonElement | null>());
  const lastAttemptRef = React.useRef<string | null>(null);

  const forgetCorrection = React.useCallback((): void => {
    setCorrection(null);
    api.storage.set(storageKey, null);
  }, [storageKey]);

  /** Hand focus back to the Correct button the flow started from. */
  const returnFocus = React.useCallback((): void => {
    const id = lastAttemptRef.current;
    if (id !== null) correctRefs.current.get(id)?.focus();
  }, []);

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

  // A restored panel is checked against the books exactly once, as soon as they
  // are readable: the stored draft may have been posted or emptied elsewhere.
  React.useEffect(() => {
    if (data.state !== 'ready' || !restoreCheck.current || correction === null) return;
    restoreCheck.current = false;
    const stored = data.transactions.find((tx) => tx.id === correction.draftId);
    if (stored !== undefined && stored.state === 'draft') return;
    forgetCorrection();
    if (stored !== undefined) {
      // Posted while we were away — the correction finished, so say so rather
      // than silently dropping the panel.
      setDone({originalEntryNo: correction.originalEntryNo, reversalEntryNo: correction.reversalEntryNo, correctedEntryNo: stored.entryNo});
      return;
    }
    // DELETED while we were away — the only path that ends with a permanent
    // reversal, no copy and (until now) no message. It is reachable by ordinary
    // use: emptying the hosted entry makes the journal block delete its draft.
    setActionError({
      lead: `The reversal of ${nameEntry(correction.originalEntryNo)} is on the books, but the corrected copy is gone`,
      detail: 'Nothing else changed — enter the corrected version in a journal entry block.',
      code: null,
    });
  }, [data.state, data.transactions, correction, forgetCorrection]);

  // The correction is FINISHED when its draft stops being a draft. The books
  // themselves say so (the live subscription already re-reads them on every
  // mutation), which is also where the corrected entry's number comes from — the
  // panel never has to be told by the journal block it is hosting.
  //
  // A draft that has VANISHED while the panel is open is deliberately not
  // treated as finished: the user may have emptied it mid-edit, and the journal
  // block handles that by starting a fresh one. Closing the panel underneath
  // them would look like a crash. (A draft that was already gone when the panel
  // was RESTORED is the other case, handled above and reported below.)
  React.useEffect(() => {
    if (correction === null) return;
    const draft = data.transactions.find((tx) => tx.id === correction.draftId);
    if (draft === undefined || draft.state === 'draft') return;
    setDone({originalEntryNo: correction.originalEntryNo, reversalEntryNo: correction.reversalEntryNo, correctedEntryNo: draft.entryNo});
    forgetCorrection();
  }, [data.transactions, correction, forgetCorrection]);

  // The confirmation is a decision point, so it takes focus: a keyboard user
  // must not have to hunt for the buttons that appeared somewhere on the page.
  React.useEffect(() => {
    if (confirming !== null) confirmRef.current?.focus();
  }, [confirming]);

  // FOCUS FOLLOWS THE FLOW. Every one of these moves replaces a drop to <body>:
  // the panel mounts (and it renders above a table the row may be far down in,
  // so it is scrolled to as well), the correction completes, or it fails. The
  // most consequential control in the ledger must not teleport its user.
  React.useEffect(() => {
    if (correction === null) return;
    panelRef.current?.scrollIntoView({block: 'nearest'});
    panelRef.current?.focus({preventScroll: true});
  }, [correction?.draftId]);

  React.useEffect(() => {
    if (done !== null) dismissRef.current?.focus();
  }, [done]);

  React.useEffect(() => {
    if (actionError !== null) errorRef.current?.focus();
  }, [actionError]);

  /**
   * The escape hatch: reverse the entry, then hand back an editable copy.
   *
   * ORDER IS THE CONTRACT. The reversal goes first, so a refusal (a leg into a
   * CLOSED account is the one the store enforces) leaves the books completely
   * untouched — no orphan draft claiming a correction that never happened. Once
   * the reversal lands it is permanent, so the failure of the copy that follows
   * is reported as exactly that: what WAS written, what was not, and what to do.
   */
  const runCorrection = (row: RegisterRow): void => {
    if (busy) return;
    lastAttemptRef.current = row.transactionId;
    setBusy(true);
    setActionError(null);
    setDone(null);
    void (async () => {
      try {
        const original = (await api.ledger.getTransaction(row.transactionId)) as OriginalLike | null;
        if (original === null) throw new Error('that entry is no longer in the books');
        const reversal = (await api.ledger.reverse(row.transactionId)) as OriginalLike;
        setConfirming(null);
        try {
          const draft = (await api.ledger.createDraft({
            date: original.date,
            description: original.description,
            // A straight copy — every leg, unchanged, memos included. No amount
            // is read, rounded or recombined here: the integer minor units the
            // books already hold are handed straight back to them.
            postings: original.postings.map((p) => ({accountId: p.accountId, amountMinor: p.amountMinor, memo: p.memo})),
          })) as OriginalLike;
          const next: Correction = {
            originalId: row.transactionId,
            originalEntryNo: row.entryNo,
            reversalEntryNo: reversal.entryNo,
            draftId: draft.id,
          };
          setCorrection(next);
          api.storage.set(storageKey, next);
        } catch (err) {
          // Half-done, and said so. The reversal cannot be taken back, so the
          // only honest message names it and points at the surface that can
          // finish the job by hand.
          setActionError({
            lead: `The reversal was posted as ${nameEntry(reversal.entryNo)}, but the editable copy could not be created`,
            detail: `${messageOf(err)}. The books are still consistent — enter the corrected version in a journal entry block.`,
            code: err instanceof LedgerError ? err.code : null,
          });
        }
      } catch (err) {
        const code = err instanceof LedgerError ? err.code : null;
        // The one refusal the store makes on purpose deserves its own sentence:
        // "posting references a closed account" is true but says nothing about
        // why a REVERSAL is subject to it, or what to do next.
        const why =
          code === 'account-closed'
            ? ' A reversal is a real posting like any other, so it cannot go into a closed account — reopen the account, then correct the entry.'
            : '';
        setActionError({lead: 'Nothing was reversed', detail: `${messageOf(err)}.${why}`, code});
      } finally {
        setBusy(false);
      }
    })();
  };

  /**
   * The hosted journal block's props map must SURVIVE rerenders — the register
   * rerenders on every ledger mutation, and a map rebuilt each time would throw
   * away the draft id the block writes back into it after a recovery.
   */
  const correctionDraftId = correction === null ? null : correction.draftId;
  const hosted = React.useMemo(
    () => (correctionDraftId === null ? null : correctionHost(correctionDraftId, editor.readOnly)),
    [correctionDraftId, editor.readOnly],
  );

  /** Move to the other half of a reversal pair, and say where you landed. */
  const jumpToCounterpart = (postingId: string): void => {
    setHighlight(postingId);
    const target = counterpartRefs.current.get(postingId);
    // ONE scroll: `focus()` scrolls too, so letting both run made the row jump
    // twice. `scrollIntoView` chooses the framing; focus only takes the ring.
    target?.scrollIntoView({block: 'center'});
    // Focus lands on the counterpart's OWN link, which points at ITS counterpart
    // — one hop along the chain. On an ordinary pair that is the way back; on a
    // longer chain it continues outward (see `linkReversalPairs`).
    target?.focus({preventScroll: true});
  };

  // Same discipline as the trial balance: a stored amount the money core
  // refuses to add is a report failure, not a crashed document.
  let register: AccountRegister | null = null;
  let foldError: string | null = null;
  try {
    register = accountId === '' ? null : buildAccountRegister(accountId, data.accounts, data.transactions, {from, to, cleared});
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
  // The two blockers that are true of the whole block, resolved once. Rows still
  // ask `correctionBlocker` (it also answers the row-specific ones and settles
  // precedence); this only decides where the SENTENCE is rendered.
  const correctionOpen = correction !== null || busy;
  const blockBlocker: CorrectionBlocker | null = editor.readOnly ? 'read-only' : correctionOpen ? 'correction-open' : null;

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

      {/* The immutability contract, stated ONCE and always — not discovered by
          trying. There is no edit control anywhere on a posted row, and a rule
          with no visible affordance behind it has to be written down or it reads
          as an oversight. It names the way out in the same breath, because a
          prohibition with no next step is what LGR-4 shipped and LGR-6 is here
          to finish — except on a read-only page, where instructing the reader to
          use a control they cannot press would be worse than saying nothing. */}
      <div data-ledger-immutable style={mutedStyle}>{describeImmutability(editor.readOnly)}</div>

      {/* The BLOCK-WIDE off reason, said once. It is identical on every row, so
          forty copies of it in forty cells was forty repetitions of one fact and
          roughly double the row height. Every disabled button points here. */}
      {blockBlocker !== null && (
        <div id={blockReasonId} data-ledger-correct-why={blockBlocker} style={mutedStyle}>
          {describeCorrectionBlocker(blockBlocker, null)}
        </div>
      )}

      {done !== null && (
        <div data-ledger-correction-done role="status" aria-live="polite" style={noticeStyle('quiet')}>
          {describeCorrectionDone(done.originalEntryNo, done.reversalEntryNo, done.correctedEntryNo)}{' '}
          <button
            type="button"
            ref={dismissRef}
            data-ledger-correction-dismiss
            style={{...buttonStyle, marginLeft: '0.25rem', fontWeight: 400}}
            onClick={() => {
              setDone(null);
              returnFocus();
            }}
          >
            Dismiss
          </button>
        </div>
      )}

      {actionError !== null && (
        // INFO, not alarm. The alarm tone belongs to "the books do not balance"
        // and to a report that could not be computed; a refused or half-finished
        // correction is neither, and borrowing that colour for an everyday
        // rejection is how a reader learns to stop seeing it.
        //
        // But this can share the screen with the confirmation it just refused,
        // which wears the SAME tone — so the difference is carried by WEIGHT on
        // the lead clause rather than by a second colour. `alarm` stays reserved.
        <div
          ref={errorRef}
          tabIndex={-1}
          data-ledger-correct-error={actionError.code ?? 'error'}
          role="status"
          aria-live="polite"
          style={noticeStyle('info')}
        >
          <span data-ledger-correct-error-lead style={{fontWeight: 600}}>{actionError.lead}</span> — {actionError.detail}
          {actionError.code !== null && (
            <span style={{...mutedStyle, marginLeft: '0.4rem'}} title={`Ledger error code: ${actionError.code}`}>
              ({actionError.code})
            </span>
          )}
          <button
            type="button"
            data-ledger-correct-error-dismiss
            style={{...buttonStyle, marginLeft: '0.5rem'}}
            onClick={() => {
              setActionError(null);
              returnFocus();
            }}
          >
            Dismiss
          </button>
        </div>
      )}

      {confirming !== null && (
        <div data-ledger-correct-confirm={confirming.transactionId} role="status" aria-live="polite" style={noticeStyle('info')}>
          <div>{describeCorrectionConfirm(confirming)}</div>
          <div style={{display: 'flex', gap: '0.5rem', marginTop: '0.4rem', flexWrap: 'wrap'}}>
            {/* NOT disabled while the reversal is in flight. `runCorrection`
                already refuses re-entry, and disabling the button the user is
                standing on blurs them to <body> — on the ledger's single most
                consequential control, every single time. The label carries the
                state instead, with `aria-busy` for anyone not reading it. */}
            <button type="button" ref={confirmRef} data-ledger-correct-go aria-busy={busy} style={buttonStyle} onClick={() => runCorrection(confirming)}>
              {busy ? 'Posting the reversal…' : 'Post the reversal'}
            </button>
            {/* Cancel IS disabled in flight — the reversal cannot be called back,
                so the control would be a lie. The reason is the live label
                immediately to its left, not a tooltip. */}
            <button type="button" data-ledger-correct-cancel style={busy ? disabledButtonStyle : buttonStyle} disabled={busy} onClick={() => setConfirming(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {correction !== null && (
        <div
          ref={panelRef}
          tabIndex={-1}
          data-ledger-correction={correction.originalId}
          style={{border: '1px solid hsl(var(--border))', borderRadius: 8, padding: '0.5rem', display: 'flex', flexDirection: 'column', gap: '0.5rem'}}
        >
          <div style={{display: 'flex', alignItems: 'flex-start', gap: '0.5rem', flexWrap: 'wrap'}}>
            <div data-ledger-correction-head role="status" aria-live="polite" style={{flex: '1 1 20rem'}}>
              Correcting {nameEntry(correction.originalEntryNo)} — reversed by {nameEntry(correction.reversalEntryNo)}, which is now permanent. Below is a copy of the original: fix
              it and post it.
            </div>
            {/* The consequence of closing sits WITH the Close button. At the
                bottom of the panel it was below the whole journal form, so the
                one person who needed it — someone bailing out — never scrolled
                far enough to read it. */}
            <div style={{display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap'}}>
              <button type="button" data-ledger-correction-close aria-describedby={closeWhyId} style={buttonStyle} onClick={forgetCorrection}>
                Close
              </button>
              <span id={closeWhyId} data-ledger-correction-close-why style={{...mutedStyle, maxWidth: '14rem'}}>
                Closing leaves the copy as an unposted draft — out of every report until you post it.
              </span>
            </div>
          </div>
          {/* The REAL journal entry block (LGR-5) — the ledger's only human write
              surface — bound to the copy. See {@link correctionHost}. */}
          {hosted !== null && <JournalEntryBlock block={hosted.block} editor={hosted.editor} />}
        </div>
      )}

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
                    {/* FIRST, not last. At the block's default width the column
                        was clipped to "CORRE" — and once the counterpart chips
                        widened the rows it fell off the scroll entirely. The one
                        control this feature exists to ship cannot be the one
                        thing you have to scroll to find. */}
                    <th scope="col" style={thStyle}>
                    Correct
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
                    <th scope="row" colSpan={7} style={{...tdStyle, ...mutedStyle, textAlign: 'left', fontWeight: 400}}>
                    Opening balance{register.filter.from !== null ? ` before ${register.filter.from}` : ''}
                    </th>
                    <td data-ledger-opening-balance style={{...numericStyle, ...mutedStyle}}>
                      <SideAmount minor={register.openingMinor} />
                    </td>
                  </tr>
                  {register.rows.map((row) => {
                    const blocker = correctionBlocker(row, {readOnly: editor.readOnly, correctionOpen});
                    // A block-wide reason is stated once above the table; only a
                    // row-specific one is rendered in the cell.
                    const rowReason = blocker !== null && !isBlockWideBlocker(blocker) ? blocker : null;
                    const reasonId = rowReason !== null ? `${blockReasonId}-${row.postingId}` : blockReasonId;
                    const counterpart = row.counterpart;
                    const jump = counterpart !== null && counterpart.where === 'visible' ? counterpart.postingId : null;
                    return (
                      <tr
                        key={row.postingId}
                        data-ledger-register-row={row.postingId}
                        {...(row.reversed ? {'data-ledger-reversed': true} : {})}
                        {...(highlight === row.postingId ? {'data-ledger-highlight': 'true'} : {})}
                        // A cue at 1.13:1 is not a cue; at 0.15 it reads, and it
                        // CLEARS when the link it followed loses focus, so the
                        // register never sits in a tinted state nobody can explain.
                        style={highlight === row.postingId ? {background: 'hsl(var(--foreground) / 0.15)'} : undefined}
                      >
                        {/* The button stays on ONE line and the column takes the
                            width it needs — the table scrolls inside its own
                            region, and a three-line button turned every row of
                            the register into a paragraph. The REASON wraps,
                            bounded, because it is a sentence. */}
                        <td style={{...tdStyle, whiteSpace: 'nowrap'}}>
                          {blocker === null ? (
                            <button
                              type="button"
                              data-ledger-correct={row.transactionId}
                              // The visible text is a prefix of the accessible
                              // name (WCAG 2.5.3): the rest only DISAMBIGUATES
                              // the twenty identical buttons a screen-reader user
                              // would otherwise hear in a row.
                              aria-label={`Correct this entry — ${nameEntry(row.entryNo)}`}
                              style={buttonStyle}
                              ref={(el) => {
                                correctRefs.current.set(row.transactionId, el);
                              }}
                              onClick={() => setConfirming(row)}
                            >
                              Correct
                            </button>
                          ) : (
                            <>
                              <button type="button" data-ledger-correct-off={blocker} style={disabledButtonStyle} disabled aria-describedby={reasonId}>
                                Correct
                              </button>
                              {rowReason !== null && (
                                <div id={reasonId} data-ledger-correct-why={rowReason} style={{...mutedStyle, ...wrapStyle, marginTop: '0.2rem', whiteSpace: 'normal', maxWidth: '13rem'}}>
                                  {describeCorrectionBlocker(rowReason, counterpart)}
                                </div>
                              )}
                            </>
                          )}
                        </td>
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
                          {/* The pair, NAVIGABLE. "(reversed)" alone leaves the
                              reader to find the other half by eye; the two rows
                              point at each other, and a counterpart the filter
                              or the read cannot show says so instead of offering
                              a control that goes nowhere. */}
                          {counterpart !== null && (
                            <div data-ledger-counterpart={counterpart.relation} style={{marginTop: '0.15rem'}}>
                              {jump !== null ? (
                                <button
                                  type="button"
                                  ref={(el) => {
                                    counterpartRefs.current.set(row.postingId, el);
                                  }}
                                  data-ledger-counterpart-link={jump}
                                  // One line: "Reversed by entry #2" broken over
                                  // three lines reads as a paragraph, not a link.
                                  style={{...buttonStyle, ...mutedStyle, padding: '0.1rem 0.4rem', cursor: 'pointer', whiteSpace: 'nowrap'}}
                                  onClick={() => jumpToCounterpart(jump)}
                                  onBlur={() => setHighlight((current) => (current === row.postingId ? null : current))}
                                >
                                  {/* The glyph is decoration; inside the
                                      accessible name it is read aloud as "up
                                      down arrow" in the middle of a sentence. */}
                                  {describeCounterpart(counterpart)} <span aria-hidden="true">↕</span>
                                </button>
                              ) : (
                                <span style={mutedStyle}>{describeCounterpart(counterpart)}</span>
                              )}
                            </div>
                          )}
                        </td>
                        <td data-ledger-contra style={{...tdStyle, ...wrapStyle}}><AccountName name={row.contra} /></td>
                        <td style={{...tdStyle, ...mutedStyle}}>{CLEARED_LABEL[row.cleared]}</td>
                        <td data-ledger-amount style={numericStyle}><SideAmount minor={row.amountMinor} /></td>
                        <td data-ledger-running style={numericStyle}><SideAmount minor={row.runningMinor} /></td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr data-ledger-register-totals>
                    <th scope="row" colSpan={6} style={{...tdStyle, textAlign: 'left', fontWeight: 600, borderTop: '2px solid hsl(var(--border))', borderBottom: 'none'}}>
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
