import React from 'react';
import {api, formatAmount, getPageIdForDoc, LedgerError} from '@book.dev/plugin-sdk';
import {
  computeEntryStatus,
  describeImbalance,
  describeProblem,
  describeTotals,
  emptyRow,
  mergeMemosFromDraft,
  normalizeCell,
  rowsToPostings,
  todayIso,
  type JournalRow,
  type PostingInput,
} from './model';
import {setUpBooks} from './setup';
// The shared OFF-state face (LGR-6): dashed, secondary-text border, out of the
// two-indistinguishable-greys trap. Imported rather than re-drawn so the
// journal block's read-only presentation cannot drift from the register's.
import {disabledButtonStyle} from './reportShell';

/**
 * The journal entry block — the ONLY human write surface for the books.
 *
 * - N debit/credit rows (account picker · debit · credit · memo), a date, live
 *   totals per keystroke, Post gated by the pure {@link computeEntryStatus}
 *   with the reason always spelled out ({@link describeProblem}).
 * - The draft persists through the LGR-3 draft ops (create/update draft) so a
 *   half-entered entry survives reload. The RAW CELL TEXT mirrors into block
 *   props (CRDT) — "2,500.00" has no home in a ledger that stores integers —
 *   alongside a CACHE of each memo. Since LGR-16 the memo is real posting data
 *   and the books own it, but they can only answer for rows that are already
 *   postings and only once the debounced sync has landed; see {@link StoredRow}
 *   for why dropping the local copy destroyed memos rather than de-duplicating
 *   them.
 * - All amount text goes through `parseAmount`/`formatAmount` (host money
 *   core); the wire only ever carries signed INTEGER minor units.
 * - Keyboard-first: Tab walks the cells, Enter adds a row, Alt+Backspace
 *   removes the current one.
 *
 * SAFETY (the rule the whole file is arranged around): the block NEVER posts a
 * draft it has not just proved to match what is on screen. A failed sync
 * throws (it never degrades to "post whatever the server last stored"), and
 * post() re-verifies the server's postings against the rows before committing
 * — a posted transaction is immutable, audited and entry-numbered, so a stale
 * commit is unrecoverable by design.
 */

interface PropsMap {
  get(k: string): unknown;
  set(k: string, v: unknown): void;
  delete(k: string): void;
}

interface BlockLike {
  get(k: string): unknown;
}

interface EditorLike {
  doc: {transact(fn: () => void, origin: string): void};
  readOnly: boolean;
}

interface AccountOption {
  id: string;
  name: string;
  /** LGR-14: this account refuses a post from an entry with no evidence. */
  evidenceRequired: boolean;
}

/** One attached receipt as the books store it (LGR-14). */
interface EvidenceItem {
  filename: string;
  sha256: string;
  size: number;
}

/** The shape of a draft this block cares about (types are stripped at load). */
interface DraftLike {
  id: string;
  date: string;
  description: string;
  state: string;
  entryNo: number | null;
  postings: Array<{accountId: string; amountMinor: number; memo: string | null}>;
  /** Optional defensively: an older server omits it, which reads as "none". */
  evidence?: EvidenceItem[];
}

const PROP_ROWS = 'ledgerRows';
const PROP_DESC = 'ledgerDescription';
const PROP_DATE = 'ledgerDate';
const PROP_DRAFT = 'ledgerDraftId';
const SYNC_DELAY_MS = 350;

// Longhand border properties (not the `border` shorthand): the invalid-cell
// state overrides `borderColor` alone, and React warns when a shorthand and a
// longhand for the same box are mixed across rerenders.
const cellStyle: React.CSSProperties = {
  borderWidth: 1,
  borderStyle: 'solid',
  borderColor: 'hsl(var(--border))',
  borderRadius: 6,
  padding: '0.3rem 0.5rem',
  background: 'hsl(var(--background))',
  color: 'hsl(var(--foreground))',
  fontSize: '0.85rem',
  // Amounts read as columns of digits, not proportional text.
  fontVariantNumeric: 'tabular-nums',
  minWidth: 0,
  width: '100%',
};

// LONGHAND border properties (not the `border` shorthand): the same element
// swaps between this and the dashed {@link disabledButtonStyle} when the page
// lock changes, and React warns (and can leave a stale edge) when a shorthand
// and a longhand for the same box alternate across rerenders.
const buttonStyle: React.CSSProperties = {
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

const headerStyle: React.CSSProperties = {
  fontSize: '0.7rem',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  color: 'hsl(var(--muted-foreground))',
};

// Notice surfaces. The alarm colour carries on the BORDER and a soft fill;
// the sentence itself uses --foreground, the only token guaranteed to clear
// 4.5:1 on the card in both themes (--destructive is a fill/border token and
// measures ~4.4:1 as body text).
const noticeStyle = (tone: 'alarm' | 'quiet'): React.CSSProperties => ({
  padding: '0.4rem 0.6rem',
  borderRadius: 6,
  borderWidth: 1,
  borderStyle: 'solid',
  borderColor: tone === 'alarm' ? 'hsl(var(--destructive))' : 'hsl(var(--border))',
  background: tone === 'alarm' ? 'hsl(var(--destructive) / 0.1)' : 'transparent',
  color: 'hsl(var(--foreground))',
  fontSize: '0.85rem',
  fontWeight: tone === 'alarm' ? 600 : 400,
});

function readProps(block: BlockLike): PropsMap | undefined {
  return block.get('props') as PropsMap | undefined;
}

function readString(props: PropsMap | undefined, key: string): string {
  const value = props?.get(key);
  return typeof value === 'string' ? value : '';
}

/**
 * The rows kept in block props: the raw cell text AND a LOCAL CACHE of the memo.
 *
 * The ledger is the source of truth for a memo (LGR-16) and still wins whenever
 * it can speak — {@link mergeMemosFromDraft} overwrites this copy on boot from
 * the stored postings. But props cannot simply DROP it, because two ordinary
 * situations leave the ledger unable to answer:
 *
 *  - a memo typed on a row that is not yet a complete posting (no account, or
 *    no amount) is not in any draft, so stripping it here meant it reached
 *    NEITHER store and vanished on reload — a straight regression from the
 *    props-carried behaviour;
 *  - `writeProps` is synchronous while the draft sync is debounced, so the two
 *    routinely disagree on posting COUNT, and mergeMemosFromDraft then
 *    (correctly) merges nothing. With no local copy the memos rendered blank —
 *    and the next keystroke wrote that blank back as `memo: null`, DESTROYING
 *    the stored memo server-side.
 *
 * So: cache, not second source of truth. The books overwrite it whenever they
 * can; it only answers when they cannot.
 */
type StoredRow = JournalRow;

function loadRows(props: PropsMap | undefined): JournalRow[] | null {
  const raw = props?.get(PROP_ROWS);
  if (typeof raw !== 'string' || raw === '') return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return null;
    return parsed.map((r) => {
      const row = r as Partial<JournalRow>;
      return {
        accountId: typeof row.accountId === 'string' ? row.accountId : '',
        debit: typeof row.debit === 'string' ? row.debit : '',
        credit: typeof row.credit === 'string' ? row.credit : '',
        // The local cache (see {@link StoredRow}). The draft's stored memo wins
        // on boot whenever the merge can line the rows up.
        memo: typeof row.memo === 'string' ? row.memo : '',
      };
    });
  } catch {
    return null;
  }
}

/** Persist the rows as they stand, memo cache included (see {@link StoredRow}). */
const toStoredRows = (rows: JournalRow[]): StoredRow[] =>
  rows.map(({accountId, debit, credit, memo}) => ({accountId, debit, credit, memo}));

/**
 * Order-insensitive equality of two posting lists — accountId, minor units AND
 * memo. The memo is in the key because this is the stale-commit guard: a memo
 * edit that failed to reach the server must block the post exactly like an
 * amount edit would, rather than committing a leg whose note says something
 * the user already replaced. Posting is immutable, so there is no fixing it
 * afterwards.
 */
function samePostings(a: PostingInput[], b: PostingInput[]): boolean {
  if (a.length !== b.length) return false;
  const key = (p: PostingInput): string => `${p.accountId}:${p.amountMinor}:${p.memo ?? ''}`;
  const left = a.map(key).sort();
  const right = b.map(key).sort();
  return left.every((k, i) => k === right[i]);
}

export const JournalEntryBlock = ({block, editor, pageReadOnly, uploadPageId}: {block: BlockLike; editor: EditorLike; pageReadOnly?: boolean; uploadPageId?: string | null}) => {
  // MAY THIS READER WRITE? Not "is this widget frozen?". A custom block on a
  // read-only page is deliberately handed an editor with `readOnly: false` so it
  // stays operable for the reader, so `editor.readOnly` is FALSE on exactly the
  // page where the entry form must be inert — the host passes the document's
  // real lock separately. (Optional, and defaulted, so the block still renders
  // correctly when driven directly by a test harness.)
  const pageLocked = pageReadOnly ?? editor.readOnly;
  const props = readProps(block);
  const [ledgerState, setLedgerState] = React.useState<'loading' | 'uninitialized' | 'ready'>('loading');
  const [accounts, setAccounts] = React.useState<AccountOption[]>([]);
  const [rows, setRows] = React.useState<JournalRow[]>(() => loadRows(props) ?? [emptyRow(), emptyRow()]);
  const [description, setDescription] = React.useState<string>(() => readString(props, PROP_DESC));
  const [date, setDate] = React.useState<string>(() => readString(props, PROP_DATE) || todayIso());
  const [error, setError] = React.useState<string | null>(null);
  const [errorCode, setErrorCode] = React.useState<string | null>(null);
  const [postedNo, setPostedNo] = React.useState<number | null>(null);
  const [busy, setBusy] = React.useState(false);
  // LGR-14: the receipts attached to the CURRENT draft. Server state, mirrored
  // — every change round-trips through `updateDraft` and re-reads the answer,
  // so this list never claims an attachment the books did not accept.
  const [evidence, setEvidence] = React.useState<EvidenceItem[]>([]);
  const [evidenceBusy, setEvidenceBusy] = React.useState(false);

  const draftIdRef = React.useRef<string | null>(readString(props, PROP_DRAFT) || null);
  const syncTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestRef = React.useRef({rows, description, date});
  latestRef.current = {rows, description, date};
  const latestEvidenceRef = React.useRef(evidence);
  latestEvidenceRef.current = evidence;
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const mountedRef = React.useRef(true);

  const status = computeEntryStatus(rows, date);
  const problem = describeProblem(status);
  const imbalance = describeImbalance(status);
  const locked = pageLocked || busy;
  // Per instance: two journal blocks on one page must not hand their disabled
  // controls the same `aria-describedby` target.
  const lockedWhyId = React.useId();
  const evidenceWhyId = React.useId();

  // LGR-14: does any account this entry touches require evidence? A PRE-FLIGHT
  // courtesy — the store rejects `evidence-required` regardless, this only
  // turns the refusal into a disabled button with the reason beside it.
  const evidenceRequiredNames = [...new Set(rows.map((r) => r.accountId).filter((id) => id !== ''))]
    .map((id) => accounts.find((a) => a.id === id))
    .filter((a): a is AccountOption => a !== undefined && a.evidenceRequired)
    .map((a) => a.name);
  const evidenceBlocked = evidenceRequiredNames.length > 0 && evidence.length === 0;

  const refreshAccounts = React.useCallback(async (): Promise<void> => {
    const list = await api.ledger.listAccounts();
    if (!mountedRef.current) return;
    setAccounts(
      list
        .filter((a) => a.status === 'open')
        .map((a) => ({id: a.id, name: a.name, evidenceRequired: (a as {evidenceRequired?: boolean}).evidenceRequired === true}))
        .sort((a, b) => a.name.localeCompare(b.name)),
    );
  }, []);

  const focusRow = React.useCallback((index: number): void => {
    requestAnimationFrame(() => {
      const pickers = containerRef.current?.querySelectorAll<HTMLSelectElement>('[data-ledger-account]');
      if (!pickers || pickers.length === 0) return;
      pickers[Math.max(0, Math.min(index, pickers.length - 1))]?.focus();
    });
  }, []);

  // Boot: ledger presence, accounts (live via the seeded accounts database),
  // and the stored draft id. The draft is re-checked on EVERY boot, not only
  // when the rows are empty: a draft posted from another tab (or restored by
  // an undo of the post) must never come back as an editable draft, or the
  // same entry could be posted twice.
  React.useEffect(() => {
    mountedRef.current = true;
    let unsubscribe: (() => void) | undefined;
    void (async () => {
      try {
        const info = await api.ledger.info();
        if (!mountedRef.current) return;
        if (!info.exists || !info.databases) {
          setLedgerState('uninitialized');
          return;
        }
        setLedgerState('ready');
        await refreshAccounts();
        unsubscribe = api.databases.subscribeRows(info.databases.accounts, () => {
          void refreshAccounts();
        });

        if (!draftIdRef.current) return;
        const draft = (await api.ledger.getTransaction(draftIdRef.current)) as DraftLike | null;
        if (!mountedRef.current) return;
        if (!draft || draft.state !== 'draft') {
          // Missing, posted, or void: detach. Whatever is on screen becomes a
          // NEW draft on the next edit.
          draftIdRef.current = null;
          const p = readProps(block);
          if (p && !pageLocked) editor.doc.transact(() => p.delete(PROP_DRAFT), 'local');
          return;
        }
        // LGR-14: the draft's attachments come back with it — the books are the
        // only source of truth for evidence (nothing is cached in block props).
        setEvidence(Array.isArray(draft.evidence) ? draft.evidence : []);
        const storedRows = loadRows(readProps(block));
        if (storedRows === null) {
          // No local text at all (a fresh device, or props were dropped): the
          // draft IS the entry — amounts render back through the money core.
          setDescription(draft.description);
          setDate(draft.date);
          if (draft.postings.length > 0) {
            setRows(
              draft.postings.map((p) => ({
                accountId: p.accountId,
                debit: p.amountMinor > 0 ? formatAmount(p.amountMinor) : '',
                credit: p.amountMinor < 0 ? formatAmount(-p.amountMinor) : '',
                memo: p.memo ?? '',
              })),
            );
          }
        } else {
          // Local raw text wins for the AMOUNT cells (it is the only copy of
          // what was typed). The memos come from the POSTINGS whenever the rows
          // line up — the books are the source of truth for anything they store
          // (LGR-16) — and `mergeMemosFromDraft` returns the rows UNCHANGED when
          // they do not, which is exactly when the local cache must answer
          // instead. Handing it rows with no memo made that fallback render
          // blank, and the next keystroke then wrote the blank back to the
          // server as `memo: null`.
          setRows(mergeMemosFromDraft(storedRows, draft.postings));
        }
      } catch {
        if (mountedRef.current) setLedgerState('uninitialized');
      }
    })();
    return () => {
      mountedRef.current = false;
      unsubscribe?.();
      if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
    };
    // Intentional empty deps: boot exactly once per block instance
    // (block/draft restore included).
  }, []);

  const writeProps = React.useCallback(
    (next: {rows: JournalRow[]; description: string; date: string} | null): void => {
      const p = readProps(block);
      // The DOCUMENT's lock, not the widget's (see `pageLocked` above): the
      // widget-live editor on a read-only page must not write cell text into
      // the locked document.
      if (!p || pageLocked) return;
      editor.doc.transact(() => {
        if (next === null) {
          p.delete(PROP_ROWS);
          p.delete(PROP_DESC);
          p.delete(PROP_DATE);
          p.delete(PROP_DRAFT);
        } else {
          p.set(PROP_ROWS, JSON.stringify(toStoredRows(next.rows)));
          p.set(PROP_DESC, next.description);
          p.set(PROP_DATE, next.date);
          if (draftIdRef.current) p.set(PROP_DRAFT, draftIdRef.current);
          else p.delete(PROP_DRAFT);
        }
      }, 'local');
    },
    [block, editor, pageLocked],
  );

  /**
   * Push the current rows/description/date into the server-side draft.
   *
   * THROWS on any failure (typed LedgerError or transport/5xx alike) after
   * surfacing it. It must never answer with the previous draft id: the caller
   * would take that for a successful sync and could post amounts the user has
   * already replaced on screen. Returns `null` when there is nothing worth
   * storing (an emptied entry, whose abandoned draft is deleted rather than
   * left orphaned on the server).
   */
  const syncDraft = React.useCallback(async (): Promise<DraftLike | null> => {
    if (ledgerState !== 'ready') return null;
    const {rows: r, description: d, date: dt} = latestRef.current;
    const postings = rowsToPostings(r);
    try {
      if (postings.length === 0 && d.trim() === '') {
        if (draftIdRef.current) {
          await api.ledger.deleteDraft(draftIdRef.current);
          draftIdRef.current = null;
          // The draft owned its attachments; emptying the entry discards them.
          setEvidence([]);
        }
        writeProps({rows: r, description: d, date: dt});
        return null;
      }
      // LGR-14: a (re)created draft carries the on-screen attachments along, so
      // a recovered draft does not silently shed receipts the list still shows.
      const carried = latestEvidenceRef.current.map(({sha256, filename}) => ({sha256, filename}));
      const createInput = {date: dt, description: d, postings, ...(carried.length > 0 ? {evidence: carried} : {})};
      let draft: DraftLike;
      if (!draftIdRef.current) {
        draft = (await api.ledger.createDraft(createInput)) as DraftLike;
        draftIdRef.current = draft.id;
      } else {
        try {
          draft = (await api.ledger.updateDraft(draftIdRef.current, {date: dt, description: d, postings})) as DraftLike;
        } catch (err) {
          // The stored draft is gone: start a new one. `immutable` is NOT
          // recovered here — see the caller; auto-recreating a posted entry
          // would double-enter the books.
          if (err instanceof LedgerError && err.code === 'not-found') {
            draft = (await api.ledger.createDraft(createInput)) as DraftLike;
            draftIdRef.current = draft.id;
          } else {
            throw err;
          }
        }
      }
      if (mountedRef.current) setEvidence(Array.isArray(draft.evidence) ? draft.evidence : []);
      writeProps({rows: r, description: d, date: dt});
      return draft;
    } catch (err) {
      if (err instanceof LedgerError) {
        setError(err.message);
        setErrorCode(err.code);
      } else {
        setError(err instanceof Error ? err.message : String(err));
        setErrorCode(null);
      }
      throw err;
    }
  }, [ledgerState, writeProps]);

  const scheduleSync = React.useCallback((): void => {
    if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
    syncTimerRef.current = setTimeout(() => {
      syncTimerRef.current = null;
      // Background sync: the banner is already set by syncDraft. A draft that
      // turned immutable underneath us (posted in another tab) is detached so
      // the block keeps working instead of wedging on every keystroke.
      void syncDraft().catch((err) => {
        if (err instanceof LedgerError && err.code === 'immutable') draftIdRef.current = null;
      });
    }, SYNC_DELAY_MS);
  }, [syncDraft]);

  const edit = (next: {rows?: JournalRow[]; description?: string; date?: string}): void => {
    const nextRows = next.rows ?? rows;
    const nextDescription = next.description ?? description;
    const nextDate = next.date ?? date;
    setRows(nextRows);
    setDescription(nextDescription);
    setDate(nextDate);
    setPostedNo(null);
    setError(null);
    setErrorCode(null);
    latestRef.current = {rows: nextRows, description: nextDescription, date: nextDate};
    writeProps({rows: nextRows, description: nextDescription, date: nextDate});
    scheduleSync();
  };

  const setCell = (index: number, patch: Partial<JournalRow>): void => {
    edit({rows: rows.map((row, i) => (i === index ? {...row, ...patch} : row))});
  };

  /** Blur normalisation: a readable amount settles into its canonical display. */
  const normalizeAt = (index: number, column: 'debit' | 'credit'): void => {
    const raw = rows[index]?.[column] ?? '';
    const tidy = normalizeCell(raw);
    if (tidy !== raw) setCell(index, {[column]: tidy} as Partial<JournalRow>);
  };

  const addRow = (): void => {
    edit({rows: [...rows, emptyRow()]});
    focusRow(rows.length);
  };

  const removeRow = (index: number): void => {
    if (rows.length <= 2) return;
    edit({rows: rows.filter((_, i) => i !== index)});
    // Keyboard focus must land somewhere deliberate, not on <body>.
    focusRow(Math.min(index, rows.length - 2));
  };

  /** Surface any error through the block's one error slot, typed when it is. */
  const showError = (err: unknown): void => {
    if (err instanceof LedgerError) {
      setError(err.message);
      setErrorCode(err.code);
    } else {
      setError(err instanceof Error ? err.message : String(err));
      setErrorCode(null);
    }
  };

  /**
   * Attach ONE receipt (LGR-14): upload the bytes into the content-addressed
   * asset store (the id IS the SHA-256 of the bytes), then record
   * `{sha256, filename}` on the draft — the server resolves the byte count and
   * refs the asset to the entry's own row, so the manifest can never claim a
   * file the store does not hold. Re-attaching identical bytes replaces the
   * existing item (same hash — the manifest is a set of distinct files).
   */
  const attachEvidence = async (file: File): Promise<void> => {
    if (locked || evidenceBusy) return;
    setEvidenceBusy(true);
    setError(null);
    setErrorCode(null);
    try {
      const draft = await syncDraft();
      if (!draft) throw new Error('Enter the journal entry first — evidence attaches to the entry.');
      // The page hosting this block is what the upload is ref'd to (the host
      // knows the doc → page binding; a hosting panel passes it explicitly).
      const pageId = uploadPageId ?? getPageIdForDoc((editor as {doc: unknown}).doc);
      if (!pageId) throw new Error('This entry form is not on a saved page, so a file cannot be uploaded from it.');
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (bytes.byteLength === 0) throw new Error('That file is empty — nothing to attach.');
      const {id} = await api.assets.put(bytes, file.type || 'application/octet-stream', pageId);
      const filename = file.name || 'receipt';
      const next = [...latestEvidenceRef.current.filter((e) => e.sha256 !== id).map(({sha256, filename: f}) => ({sha256, filename: f})), {sha256: id, filename}];
      const updated = (await api.ledger.updateDraft(draft.id, {evidence: next})) as DraftLike;
      if (mountedRef.current) setEvidence(Array.isArray(updated.evidence) ? updated.evidence : []);
    } catch (err) {
      if (mountedRef.current) showError(err);
    } finally {
      if (mountedRef.current) setEvidenceBusy(false);
    }
  };

  /** Detach one receipt from the draft — wholesale replacement minus one. */
  const detachEvidence = async (sha256: string): Promise<void> => {
    if (locked || evidenceBusy || !draftIdRef.current) return;
    setEvidenceBusy(true);
    setError(null);
    setErrorCode(null);
    try {
      const next = latestEvidenceRef.current.filter((e) => e.sha256 !== sha256).map(({sha256: s, filename}) => ({sha256: s, filename}));
      const updated = (await api.ledger.updateDraft(draftIdRef.current, {evidence: next})) as DraftLike;
      if (mountedRef.current) setEvidence(Array.isArray(updated.evidence) ? updated.evidence : []);
    } catch (err) {
      if (mountedRef.current) showError(err);
    } finally {
      if (mountedRef.current) setEvidenceBusy(false);
    }
  };

  const post = async (): Promise<void> => {
    if (!status.canPost || busy || pageLocked || evidenceBlocked) return;
    setBusy(true);
    setError(null);
    setErrorCode(null);
    if (syncTimerRef.current) {
      clearTimeout(syncTimerRef.current);
      syncTimerRef.current = null;
    }
    try {
      const draft = await syncDraft();
      if (!draft) throw new Error('Nothing to post yet.');
      // Last line of defence: only commit what is demonstrably on screen — the
      // whole entry, date and description included, not just the postings. The
      // server cannot catch a stale-but-balanced draft — posting is immutable.
      const onScreen = latestRef.current;
      if (!samePostings(draft.postings, rowsToPostings(onScreen.rows)) || draft.date !== onScreen.date || draft.description !== onScreen.description) {
        throw new Error('The saved entry no longer matches what is on screen. Edit a cell and try again.');
      }
      const posted = (await api.ledger.post(draft.id)) as DraftLike;
      draftIdRef.current = null;
      setRows([emptyRow(), emptyRow()]);
      setDescription('');
      setDate(todayIso());
      setEvidence([]); // the manifest went onto the books with the entry
      setError(null);
      setErrorCode(null);
      setPostedNo(posted.entryNo);
      writeProps(null);
      focusRow(0);
    } catch (err) {
      if (err instanceof LedgerError) {
        // `immutable` means this entry was already posted elsewhere. Do NOT
        // recreate-and-retry: that would enter the same transaction twice.
        if (err.code === 'immutable') {
          draftIdRef.current = null;
          setError('This entry was already posted somewhere else. Nothing was posted again.');
        } else {
          setError(err.message);
        }
        setErrorCode(err.code);
      } else {
        setError(err instanceof Error ? err.message : String(err));
        setErrorCode(null);
      }
      setPostedNo(null);
    } finally {
      // A keystroke that slipped in during the round-trips must not leave a
      // timer pointed at rows this post has already cleared.
      if (syncTimerRef.current) {
        clearTimeout(syncTimerRef.current);
        syncTimerRef.current = null;
      }
      setBusy(false);
    }
  };

  const runSetup = (): void => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setErrorCode(null);
    void setUpBooks(api.ledger)
      .then(async () => {
        if (!mountedRef.current) return;
        setLedgerState('ready');
        await refreshAccounts();
      })
      .catch((err: unknown) => {
        if (!mountedRef.current) return;
        setError(err instanceof Error ? err.message : String(err));
        setErrorCode(err instanceof LedgerError ? err.code : null);
      })
      .finally(() => {
        if (mountedRef.current) setBusy(false);
      });
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    // Escape and app shortcuts (⌘/Ctrl…) belong to the host — only the keys
    // this block actually handles are stopped from reaching the editor.
    if (e.key === 'Escape' || e.metaKey || e.ctrlKey) return;
    const target = e.target as HTMLElement;
    const cell = target.closest('[data-ledger-row]') as HTMLElement | null;
    if (!cell) return; // the description/date inputs are not row cells
    e.stopPropagation();
    if (locked) return;
    const index = Number(cell.getAttribute('data-ledger-row') ?? '0');
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      addRow();
    } else if (e.key === 'Backspace' && e.altKey) {
      // The documented keyboard path for removing a row (the × button is
      // deliberately out of the typing tab order).
      e.preventDefault();
      removeRow(index);
    }
  };

  if (ledgerState === 'loading') {
    return (
      <div data-ledger-journal data-ledger-loading contentEditable={false} style={{padding: '0.75rem', border: '1px solid hsl(var(--border))', borderRadius: 8, fontSize: '0.85rem', color: 'hsl(var(--muted-foreground))'}}>
        Loading ledger…
      </div>
    );
  }

  if (ledgerState === 'uninitialized') {
    return (
      <div data-ledger-journal data-ledger-setup contentEditable={false} style={{display: 'flex', flexDirection: 'column', gap: '0.5rem', padding: '0.75rem', border: '1px solid hsl(var(--border))', borderRadius: 8, fontSize: '0.85rem'}}>
        <div style={{display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap'}}>
          <span>📒 The books are not set up yet.</span>
          <button
            type="button"
            style={pageLocked ? disabledButtonStyle : buttonStyle}
            disabled={pageLocked || busy}
            aria-describedby={pageLocked ? lockedWhyId : undefined}
            data-ledger-setup-button
            onClick={runSetup}
          >
            {busy ? 'Setting up…' : 'Set up books'}
          </button>
          {pageLocked && (
            <span id={lockedWhyId} data-ledger-setup-why="read-only" style={{fontSize: '0.75rem', color: 'hsl(var(--foreground) / 0.72)'}}>
              This page is read-only, so the books cannot be set up from it.
            </span>
          )}
        </div>
        {error && (
          <div data-ledger-error={errorCode ?? 'error'} role="status" aria-live="polite" style={noticeStyle('alarm')}>
            {error}
            {errorCode && <span style={{marginLeft: '0.4rem', fontWeight: 400, color: 'hsl(var(--muted-foreground))'}} title={`Ledger error code: ${errorCode}`}>({errorCode})</span>}
          </div>
        )}
      </div>
    );
  }

  const untouched = status.valuedRowCount === 0 && description.trim() === '';

  return (
    <div
      data-ledger-journal
      ref={containerRef}
      contentEditable={false}
      onKeyDown={onKeyDown}
      style={{display: 'flex', flexDirection: 'column', gap: '0.5rem', padding: '0.75rem', border: '1px solid hsl(var(--border))', borderRadius: 8, background: 'hsl(var(--card))'}}
    >
      <div style={{display: 'flex', alignItems: 'flex-end', gap: '0.5rem'}}>
        <span style={{fontSize: '0.95rem', lineHeight: '1.7rem'}}>📒</span>
        <input
          data-ledger-description
          aria-label="Entry description"
          style={{...cellStyle, fontWeight: 600}}
          placeholder="Journal entry description"
          value={description}
          disabled={locked}
          onChange={(e) => edit({description: e.target.value})}
        />
        {/* Visible caption in the grid's header voice: every column below has
            one, and a native date input can carry no placeholder. */}
        <div style={{display: 'flex', flexDirection: 'column', gap: '0.35rem', flexShrink: 0}}>
          <span style={headerStyle}>Date</span>
          <input
            data-ledger-date
            aria-label="Entry date"
            type="date"
            // Wide enough for the full localized date + the picker affordance;
            // the native control clips its own text otherwise.
            style={{...cellStyle, width: 'auto', minWidth: '9.5rem'}}
            value={date}
            disabled={locked}
            onChange={(e) => edit({date: e.target.value})}
          />
        </div>
      </div>

      <div style={{display: 'grid', gridTemplateColumns: 'minmax(10rem, 2fr) 1fr 1fr minmax(8rem, 1.5fr) auto', gap: '0.35rem', alignItems: 'center'}}>
        <span style={headerStyle}>Account</span>
        <span style={{...headerStyle, textAlign: 'right', paddingRight: '0.5rem'}}>Debit</span>
        <span style={{...headerStyle, textAlign: 'right', paddingRight: '0.5rem'}}>Credit</span>
        <span style={{...headerStyle, paddingLeft: '0.5rem'}}>Memo</span>
        <span />
        {rows.map((row, i) => {
          const rowStatus = status.rows[i];
          const bothColumns = rowStatus?.reason === 'both-columns';
          const badDebit = bothColumns || (rowStatus?.invalid && row.debit.trim() !== '');
          const badCredit = bothColumns || (rowStatus?.invalid && row.credit.trim() !== '');
          return (
            <React.Fragment key={i}>
              <select
                data-ledger-account
                data-ledger-row={i}
                aria-label={`Row ${i + 1} account`}
                style={cellStyle}
                value={row.accountId}
                disabled={locked}
                onChange={(e) => setCell(i, {accountId: e.target.value})}
              >
                <option value="">Select account…</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
              <input
                data-ledger-debit
                data-ledger-row={i}
                aria-label={`Row ${i + 1} debit`}
                aria-invalid={badDebit ? true : undefined}
                inputMode="decimal"
                placeholder="0.00"
                style={{...cellStyle, textAlign: 'right', ...(badDebit ? {borderColor: 'hsl(var(--destructive))'} : {})}}
                value={row.debit}
                disabled={locked}
                onChange={(e) => setCell(i, {debit: e.target.value})}
                onBlur={() => normalizeAt(i, 'debit')}
              />
              <input
                data-ledger-credit
                data-ledger-row={i}
                aria-label={`Row ${i + 1} credit`}
                aria-invalid={badCredit ? true : undefined}
                inputMode="decimal"
                placeholder="0.00"
                style={{...cellStyle, textAlign: 'right', ...(badCredit ? {borderColor: 'hsl(var(--destructive))'} : {})}}
                value={row.credit}
                disabled={locked}
                onChange={(e) => setCell(i, {credit: e.target.value})}
                onBlur={() => normalizeAt(i, 'credit')}
              />
              <input
                data-ledger-memo
                data-ledger-row={i}
                aria-label={`Row ${i + 1} memo`}
                placeholder="Memo"
                style={cellStyle}
                value={row.memo}
                disabled={locked}
                onChange={(e) => setCell(i, {memo: e.target.value})}
              />
              <button
                type="button"
                data-ledger-remove-row
                // Out of the typing tab order on purpose: Tab walks cells, and
                // a destructive control between rows is too easy to trigger by
                // reflex. Keyboard path: Alt+Backspace inside the row.
                tabIndex={-1}
                aria-label={`Remove row ${i + 1} (or press Alt+Backspace in the row)`}
                title="Remove row — or Alt+Backspace in the row"
                style={{...(pageLocked ? disabledButtonStyle : buttonStyle), padding: '0.3rem 0.5rem', visibility: rows.length > 2 ? 'visible' : 'hidden'}}
                aria-describedby={pageLocked ? lockedWhyId : undefined}
                disabled={locked || rows.length <= 2}
                onClick={() => removeRow(i)}
              >
                ×
              </button>
            </React.Fragment>
          );
        })}
      </div>

      {/* LGR-14 — the entry's receipts. One line: what is attached (each
          removable), then the attach control. The "(optional)" tail is dropped
          the moment a selected account makes evidence mandatory — the
          affordance must not contradict the gate under it. */}
      <div data-ledger-evidence style={{display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap'}}>
        <span style={headerStyle}>Evidence</span>
        {evidence.map((item) => (
          <span
            key={item.sha256}
            data-ledger-evidence-item={item.sha256}
            title={`${item.filename} — ${item.size} bytes, SHA-256 ${item.sha256}`}
            style={{display: 'inline-flex', alignItems: 'center', gap: '0.3rem', border: '1px solid hsl(var(--border))', borderRadius: 6, padding: '0.15rem 0.45rem', fontSize: '0.8rem'}}
          >
            <span aria-hidden="true">📎</span>
            {item.filename}
            <button
              type="button"
              data-ledger-evidence-detach={item.sha256}
              aria-label={`Detach ${item.filename}`}
              title={`Detach ${item.filename}`}
              style={{...(pageLocked ? disabledButtonStyle : buttonStyle), padding: '0 0.35rem', fontSize: '0.8rem'}}
              disabled={locked || evidenceBusy}
              aria-describedby={pageLocked ? lockedWhyId : undefined}
              onClick={() => void detachEvidence(item.sha256)}
            >
              ×
            </button>
          </span>
        ))}
        {evidence.length === 0 && (
          <span data-ledger-evidence-none style={{fontSize: '0.8rem', color: 'hsl(var(--muted-foreground))'}}>
            None attached{evidenceRequiredNames.length === 0 ? ' (optional)' : ''}.
          </span>
        )}
        <label style={{display: 'inline-flex'}}>
          <input
            type="file"
            data-ledger-evidence-file
            style={{display: 'none'}}
            disabled={locked || evidenceBusy}
            onChange={(e) => {
              const file = e.target.files?.[0];
              // Reset so choosing the same file twice re-fires onChange.
              e.target.value = '';
              if (file) void attachEvidence(file);
            }}
          />
          <span
            role="button"
            tabIndex={locked || evidenceBusy ? -1 : 0}
            data-ledger-evidence-attach
            aria-disabled={locked || evidenceBusy ? true : undefined}
            aria-describedby={pageLocked ? lockedWhyId : undefined}
            style={{...(pageLocked ? disabledButtonStyle : buttonStyle), ...(locked || evidenceBusy ? {cursor: 'not-allowed'} : {})}}
            onKeyDown={(e) => {
              if ((e.key === 'Enter' || e.key === ' ') && !(locked || evidenceBusy)) {
                e.preventDefault();
                (e.currentTarget.parentElement?.querySelector('input[type="file"]') as HTMLInputElement | null)?.click();
              }
            }}
            onClick={(e) => {
              if (locked || evidenceBusy) e.preventDefault();
              else (e.currentTarget.parentElement?.querySelector('input[type="file"]') as HTMLInputElement | null)?.click();
            }}
          >
            {evidenceBusy ? 'Attaching…' : 'Attach receipt'}
          </span>
        </label>
      </div>

      <div style={{display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap'}}>
        <button
          type="button"
          data-ledger-add-row
          style={pageLocked ? disabledButtonStyle : buttonStyle}
          disabled={locked}
          aria-describedby={pageLocked ? lockedWhyId : undefined}
          onClick={addRow}
        >
          + Add row
        </button>
        <span
          data-ledger-sum
          data-ledger-balanced={status.balanced ? 'true' : 'false'}
          style={{fontSize: '0.8rem', color: 'hsl(var(--foreground))', marginLeft: 'auto', fontVariantNumeric: 'tabular-nums'}}
        >
          {describeTotals(status)}
        </span>
        <button
          type="button"
          data-ledger-post
          {...(evidenceBlocked && !pageLocked ? {'data-ledger-post-off': 'evidence-required'} : {})}
          // The page lock outranks the Σ-gate's own colouring: on a read-only
          // page Post wears the same dashed off face as every other dead
          // control, whatever the totals say — the reader cannot post a
          // balanced entry any more than an unbalanced one. The LGR-14
          // evidence gate wears the same face: a balanced entry into an
          // evidence-required account is just as unpostable until a receipt is
          // attached, and the reason sits beside the button (aria-describedby).
          style={
            pageLocked || (evidenceBlocked && status.canPost)
              ? disabledButtonStyle
              : {...buttonStyle, background: status.canPost ? 'hsl(var(--primary))' : 'hsl(var(--muted))', color: status.canPost ? 'hsl(var(--primary-foreground))' : 'hsl(var(--muted-foreground))', cursor: status.canPost ? 'pointer' : 'not-allowed'}
          }
          disabled={!status.canPost || busy || pageLocked || evidenceBlocked}
          aria-describedby={pageLocked ? lockedWhyId : evidenceBlocked ? evidenceWhyId : undefined}
          onClick={() => void post()}
        >
          {busy ? 'Posting…' : 'Post'}
        </button>
      </div>

      {/* The LGR-14 gate's reason — quiet, not alarming: nothing is wrong with
          the entry, it is simply not complete without its receipt. Suppressed
          under the page lock (the lock sentence covers every control) and
          while the entry has its own problems to report first. */}
      {evidenceBlocked && !pageLocked && status.canPost && (
        <div id={evidenceWhyId} data-ledger-evidence-required-why role="status" aria-live="polite" style={noticeStyle('quiet')}>
          {evidenceRequiredNames.join(', ')} requires evidence — attach a receipt above before posting.
        </div>
      )}

      {/* One status slot: on an untouched block, the first-run hint; otherwise
          why Post is off — loud only once the entry is genuinely out of
          balance, quiet while it is still being filled in.

          On a read-only page the slot carries the LOCK instead, stated once and
          pointed at by every disabled control's `aria-describedby` — and the
          first-run hint is dropped entirely: instructing a reader to enter
          debits into cells they cannot type in is worse than saying nothing. */}
      {pageLocked && (
        <div id={lockedWhyId} data-ledger-journal-why="read-only" style={{fontSize: '0.8rem', color: 'hsl(var(--foreground) / 0.72)'}}>
          This page is read-only, so no entry can be posted from it.
        </div>
      )}
      {untouched && !pageLocked && (
        <div data-ledger-hint style={{fontSize: '0.8rem', color: 'hsl(var(--muted-foreground))'}}>
          Enter what moved and where: debits on the left, credits on the right. Post unlocks when they balance. Enter adds a row, Alt+Backspace removes one.
        </div>
      )}
      {!untouched && problem && (
        <div
          data-ledger-problem={status.problem ?? ''}
          {...(imbalance ? {'data-ledger-imbalance': true} : {})}
          role="status"
          aria-live="polite"
          style={noticeStyle(imbalance ? 'alarm' : 'quiet')}
        >
          {problem}
        </div>
      )}
      {error && (
        <div data-ledger-error={errorCode ?? 'error'} role="status" aria-live="polite" style={noticeStyle('alarm')}>
          {error}
          {errorCode && (
            <span style={{marginLeft: '0.4rem', fontWeight: 400, color: 'hsl(var(--muted-foreground))'}} title={`Ledger error code: ${errorCode}`}>
              ({errorCode})
            </span>
          )}
        </div>
      )}
      {postedNo !== null && (
        <div data-ledger-posted={postedNo} role="status" aria-live="polite" style={noticeStyle('quiet')}>
          Posted as entry #{postedNo}. Fresh draft ready.
        </div>
      )}
    </div>
  );
};
