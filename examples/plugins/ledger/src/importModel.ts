import {CsvLimitError, parseAmount, parseCsv} from '@book.dev/plugin-sdk';

/**
 * Pure bank-CSV import logic (LGR-10) — no React, no IO, no clock.
 *
 * Everything the importer DECIDES lives here so it is unit-testable through the
 * real plugin loader: column detection, money scale, sign convention, date
 * format, dedup, and the draft payloads. `importBlock.tsx` only renders this and
 * calls `api.ledger.*`.
 *
 * THE RULES THIS FILE EXISTS TO ENFORCE
 *
 *  1. MONEY SCALE IS NEVER GUESSED. `parseAmount` reads decimal-point-free text
 *     as whole MAJOR units, which is right for a human typing a form and wrong
 *     for a Stripe-style "amount in cents" feed by a factor of 100. So the
 *     importer always passes an EXPLICIT `bareDigits` chosen by profile
 *     detection, and when detection cannot establish the scale it passes
 *     `'reject'` — every bare row then fails loudly and the user must choose,
 *     instead of half a month of statements landing 100x too large.
 *  2. ALL amount text goes through the money core. No `Number()`, no
 *     `parseFloat`, no float arithmetic anywhere in the product's money path;
 *     the ONE integer division this file performs (the minor-unit rescale) is
 *     exact by construction and argued for at its call site.
 *  3. THE FILE IS HOSTILE. It arrived as an upload. Sizes are capped before
 *     parsing, text is stripped of control characters before it can reach a
 *     ledger row, and a malformed row degrades to a reported error rather than
 *     an exception.
 *
 * KNOWN RESIDUAL — TWO-STAGE SUPPRESSION (accepted for v1, stated here so the
 * next reader does not have to rediscover it). Dedup SUPPRESSES a row that
 * matches something already on the books, and matching is on (source, date,
 * amount, normalized description) — none of which is secret and all of which an
 * actor who can get one statement imported controls. So an actor able to
 * influence TWO imports can pre-seed a row with exactly those four values, and
 * the real row in the later statement is then marked `duplicate` and never
 * drafted: a transaction that silently does not appear in the books. NO HASH
 * COLLISION IS NEEDED for this — {@link importRowHash} is a convenience, not the
 * boundary, and replacing it with SHA-256 would not close anything. What limits
 * the damage is that suppression is REPORTED, per row and in the summary, and
 * that the near-duplicate rule (same day, same money, different wording) fires
 * loudly rather than silently for the near-miss case. Closing it properly means
 * matching on something the file cannot choose — a bank-supplied transaction id
 * — which is a v2 mapping, not a hash change.
 */

// ── Profile shape ────────────────────────────────────────────────────────────

/** Which CSV column carries what. `-1` means "not mapped". */
export interface ColumnMapping {
  date: number;
  amount: number;
  description: number;
}

/**
 * How the amount column's SIGN relates to the bank account's balance.
 *
 * - `outflow-negative` (the common case): money LEAVING the account is
 *   negative, so the column's sign is already the signed posting on the asset.
 * - `outflow-positive`: the export signs from the bank's point of view (a
 *   withdrawal is a positive "debit"), so the column must be negated.
 */
export type SignConvention = 'outflow-negative' | 'outflow-positive';

/**
 * What a bare integer in the amount column means. `null` is a real, terminal
 * state — "detection could not establish this" — and is NOT a default; it makes
 * bare rows reject until a human chooses. See rule 1 in the module doc.
 */
export type Denomination = 'major' | 'minor';

/** Recognised date shapes. `mdy`/`dmy` disambiguate the slash formats. */
export type DateFormat = 'iso' | 'mdy' | 'dmy' | 'dmy-dot';

/** Everything remembered about ONE bank/source, so a second import needs no re-mapping. */
export interface SourceProfile {
  /** Stable identity of the SOURCE — see {@link sourceIdForHeader}. */
  sourceId: string;
  /** Human label (the file name the profile was first learned from). */
  label: string;
  /** The ledger account this source IS: every row's bank-side posting. */
  accountId: string;
  mapping: ColumnMapping;
  dateFormat: DateFormat;
  sign: SignConvention;
  denomination: Denomination | null;
}

/**
 * One line of "here is what I decided and why".
 *
 * `severity` exists because a COIN FLIP and a CERTAINTY must not render
 * identically. "Dates read as ISO YYYY-MM-DD" is settled; "no day above 12, so
 * I assumed MM/DD" is a 50/50 guess that silently moves a transaction three
 * months — and as the third of four identical grey lines it read exactly like
 * the settled ones. `ask` is rendered loud. It does NOT block the import: the
 * preview shows every date already normalised to ISO, which is a real
 * mitigation, and blocking on a guess that is right half the time would train
 * people to click through it.
 */
export interface DetectionNote {
  text: string;
  /** `note` = settled fact. `ask` = a guess the user should confirm. */
  severity: 'note' | 'ask';
  /**
   * WHICH decision this line is about. Needed because a saved profile can
   * OVERRIDE a decision after detection has already written a sentence about it
   * — and a note whose premise has been overridden is worse than no note. See
   * {@link reconcileSavedProfile}.
   */
  topic: 'columns' | 'date' | 'scale' | 'sign';
}

/** What detection concluded, plus the sentences the UI shows the user. */
export interface Detection {
  mapping: ColumnMapping;
  dateFormat: DateFormat;
  sign: SignConvention;
  denomination: Denomination | null;
  /** Human-readable "here is what I decided and why", one line per decision. */
  notes: DetectionNote[];
}

// ── Hostile-input limits ─────────────────────────────────────────────────────

/**
 * Caps applied to an UPLOADED statement before it is parsed. A bank month is
 * hundreds of rows and a few hundred KB; these are two orders of magnitude of
 * headroom, and they exist so a 2 GB file (or a 40 MB single field) is a clear
 * error message instead of a dead tab. Exceeding one is reported, never
 * silently truncated — importing a prefix of someone's statement would look
 * exactly like a successful import.
 */
export const IMPORT_LIMITS = {
  maxLength: 8_000_000,
  maxRows: 50_000,
  maxFieldLength: 4_000,
  maxColumns: 128,
} as const;

/** Ledger `description` / `memo` cap (mirrors the server's, LGR-3 F5 / LGR-16). */
const MAX_TEXT_LENGTH = 1000;

/**
 * The characters {@link sanitizeText} removes, as explicit escapes so the intent
 * survives every editor and every copy-paste — every one of them is invisible in
 * source, which is the whole reason they are dangerous.
 *
 *  - C0 (incl. NUL and ESC), DEL and C1 — render as nothing, break parsers.
 *  - SHY, MONGOLIAN VOWEL SEPARATOR.
 *  - ZWSP…RLM and ALM (U+061C, the Arabic twin of LRM/RLM): all `Bidi_Control`,
 *    all buying the same neutral-run reordering.
 *  - LRE…RLO and LRI…PDI — the embeddings and isolates that actually reverse a
 *    rendered line.
 *  - The word joiner, the invisible operators and the deprecated format
 *    characters — the WHOLE U+2060–U+206F block, unassigned code points
 *    included, because a hole in the range is a hole a future assignment walks
 *    straight through.
 *  - The interlinear annotation marks.
 *  - THE TAG BLOCK (U+E0000–U+E007F). Not a rendering problem at all: it is the
 *    standard channel for smuggling instructions past a human reader into an
 *    agent, and this ledger is MCP-readable, so a payee name is an injection
 *    surface. Needs the `u` flag to express as a range.
 */
// eslint-disable-next-line no-control-regex
const UNSAFE_TEXT = /[\u0000-\u001F\u007F-\u009F\u00AD\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFFF9-\uFFFB\u{E0000}-\u{E007F}]/gu;

/**
 * Make one CSV cell safe to store and to render.
 *
 * Strips two classes, collapses whitespace, and caps the length at the ledger's
 * own bound so a hostile cell is rejected HERE with a clear message rather than
 * by the server after a round trip:
 *
 *  1. C0/C1 CONTROL characters, DEL included. They render as nothing and have
 *     no legitimate place in a statement description.
 *  2. BIDI CONTROLS and INVISIBLE FORMATTING — RLO/LRO/PDF, the directional
 *     isolates, ZWSP, ZWJ/ZWNJ, the word joiner, SHY, the interlinear
 *     annotation marks. These are the ones that actually REORDER a rendered
 *     line: `Refund \u202E00.001-` displays as `Refund -100.00` while storing
 *     something else entirely, and the deception rides all the way through the
 *     description, the memo, a page name, the auditor's CSV export and the
 *     content hash. Stripping them costs nothing real — a bank statement line
 *     is not typeset.
 *
 * (No interaction with formula injection in either direction: a cell that
 * begins with a bidi control does not begin with `=`, so removing it can only
 * make the export's neutralisation MORE likely to fire, never less.)
 *
 * Deliberately NOT stripped: a leading `=`/`+`/`-`/`@`. Those are legitimate
 * characters in a payee name, and mangling stored data to protect a spreadsheet
 * is the wrong layer — the canonical CSV export neutralizes them on the way OUT
 * (see `ledgerCsv.ts`), injectively, so nothing is lost in the books.
 */
export function sanitizeText(raw: string): string {
  if (typeof raw !== 'string') return '';
  return raw.replace(UNSAFE_TEXT, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT_LENGTH);
}

/**
 * The comparison form of a description: case-folded, whitespace-collapsed,
 * punctuation-flattened. Used for BOTH dedup and the description-to-account
 * memory, so "SQ *BLUE BOTTLE  #12" and "Sq *Blue Bottle #12" are one payee.
 *
 * Sane default (noted): trailing reference NUMBERS are kept. Stripping them
 * would merge a payee's every transaction under one rule, which is usually what
 * you want — but it also merges genuinely different counterparties whose only
 * difference is the ref, and a wrong auto-categorisation is far more expensive
 * to find than a missing one.
 *
 * UNICODE, not ASCII. `\p{L}\p{N}` with the `u` flag (the same class
 * `packages/ui/src/lib/textMerge.ts` tokenizes with), preceded by an NFKC fold
 * so `café` written as `café` is the same payee as `café`. An
 * ASCII-only class does not merely lose fidelity — it erases non-Latin payees
 * to the EMPTY STRING, and an empty normalized description makes every entry
 * with the same date and amount look like the same transaction: a genuine
 * `Магазин` −5.00 is then silently marked a duplicate of a `Кофейня` −5.00 and
 * never imported. (It also collapsed every non-Latin HEADER to the same source
 * id, so two unrelated banks would share one saved profile — including its
 * accountId.) Nothing is persisted from this function, so there is no migration.
 */
export function normalizeDescription(raw: string): string {
  return sanitizeText(raw)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

// ── Source identity ──────────────────────────────────────────────────────────

/**
 * The stable id of a SOURCE, derived from the header row's shape.
 *
 * A bank's export format is its fingerprint: the same institution emits the
 * same columns in the same order every month. Keying the saved profile on that
 * means the SECOND import of the same bank needs no re-mapping and no naming
 * ceremony — the user is never asked to identify a source they already told us
 * about. (Sane default, noted: a bank that changes its column set reads as a new
 * source and asks once more, which is the safe direction to fail.)
 */
export function sourceIdForHeader(header: readonly string[]): string {
  return header.map((h) => normalizeDescription(h)).join('|') || 'unknown';
}

// ── Detection ────────────────────────────────────────────────────────────────

const DATE_HEADERS = ['date', 'transaction date', 'posted date', 'posting date', 'booking date', 'value date', 'trans date'];
const AMOUNT_HEADERS = ['amount', 'value', 'amt', 'transaction amount', 'amount cents', 'amount minor', 'amount in cents'];
const DESCRIPTION_HEADERS = ['description', 'details', 'narrative', 'payee', 'memo', 'reference', 'particulars', 'name', 'transaction description'];

/** Header names whose very NAME establishes a minor-unit scale. */
const MINOR_HEADER = /(^|\s)(cents|pence|minor|subunits?)(\s|$)/;

const headerIndex = (header: readonly string[], candidates: readonly string[]): number => {
  const norm = header.map(normalizeDescription);
  // Exact match first, then a containment fallback ("posted date (utc)").
  for (const candidate of candidates) {
    const at = norm.indexOf(normalizeDescription(candidate));
    if (at >= 0) return at;
  }
  for (const candidate of candidates) {
    const needle = normalizeDescription(candidate);
    const at = norm.findIndex((h) => h.includes(needle));
    if (at >= 0) return at;
  }
  return -1;
};

const SLASH_DATE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;
const DOT_DATE = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Detect the date format from the sampled cells of the date column. */
function detectDateFormat(samples: readonly string[]): {format: DateFormat; note: DetectionNote} {
  const settled = (format: DateFormat, text: string): {format: DateFormat; note: DetectionNote} => ({
    format,
    note: {text, severity: 'note', topic: 'date'},
  });
  const iso = samples.filter((s) => ISO_DATE.test(s)).length;
  const dot = samples.filter((s) => DOT_DATE.test(s)).length;
  const slash = samples.filter((s) => SLASH_DATE.test(s));
  if (iso >= dot && iso >= slash.length && iso > 0) return settled('iso', 'Dates read as ISO YYYY-MM-DD.');
  if (dot > slash.length) return settled('dmy-dot', 'Dates read as DD.MM.YYYY.');
  if (slash.length > 0) {
    // A component above 12 can only be a DAY, which settles the order outright.
    const firstOver12 = slash.some((s) => Number(SLASH_DATE.exec(s)![1]) > 12);
    const secondOver12 = slash.some((s) => Number(SLASH_DATE.exec(s)![2]) > 12);
    if (firstOver12 && !secondOver12) return settled('dmy', 'Dates read as DD/MM/YYYY (a day above 12 settled the order).');
    if (secondOver12 && !firstOver12) return settled('mdy', 'Dates read as MM/DD/YYYY (a day above 12 settled the order).');
    // Genuinely ambiguous (every component ≤ 12). Sane default (noted): MM/DD,
    // and the UI says so LOUDLY (severity `ask`), because 03/04 silently
    // becoming April is the kind of error nobody finds until reconciliation.
    return {
      format: 'mdy',
      note: {
        text: 'Dates are ambiguous (no day above 12) — assuming MM/DD/YYYY. Change this if your bank writes DD/MM. Check the dates in the preview below.',
        severity: 'ask',
        topic: 'date',
      },
    };
  }
  return {format: 'iso', note: {text: 'No recognisable date format — assuming ISO YYYY-MM-DD.', severity: 'ask', topic: 'date'}};
}

/**
 * Read a matrix's header + sample rows and decide the whole profile.
 *
 * Detection NEVER silently settles the money scale: if no sampled amount
 * carries a decimal point and no header names a minor unit, `denomination` is
 * `null` and the caller must ask.
 */
export function detectProfile(matrix: readonly (readonly string[])[]): Detection {
  const header = matrix[0] ?? [];
  const body = matrix.slice(1);
  const notes: DetectionNote[] = [];
  const say = (topic: DetectionNote['topic'], text: string, severity: 'note' | 'ask' = 'note'): void => {
    notes.push({text, severity, topic});
  };

  const mapping: ColumnMapping = {
    date: headerIndex(header, DATE_HEADERS),
    amount: headerIndex(header, AMOUNT_HEADERS),
    description: headerIndex(header, DESCRIPTION_HEADERS),
  };
  const named = (i: number): string => (i >= 0 ? `"${sanitizeText(header[i] ?? '')}"` : 'nothing');
  say('columns', `Date from ${named(mapping.date)}, amount from ${named(mapping.amount)}, description from ${named(mapping.description)}.`);

  /** Up to 200 non-empty cells of one column — enough to settle every question
   *  detection asks, and bounded so a 50 000-row file costs the same. */
  const sample = (index: number): string[] =>
    index < 0 ? [] : body.slice(0, 200).map((r) => (r[index] ?? '').trim()).filter((c) => c !== '');

  const dateSamples = sample(mapping.date);
  const {format, note} = detectDateFormat(dateSamples);
  notes.push(note);

  const amountSamples = sample(mapping.amount);
  const amountHeader = mapping.amount >= 0 ? normalizeDescription(header[mapping.amount] ?? '') : '';
  let denomination: Denomination | null;
  // EVERY sampled cell must carry a decimal point before the column is called
  // major. The asymmetry matters and used to run the wrong way: one decimal cell
  // in 200 concluded 'major' for the whole file, and every BARE cell then
  // imported 100x high. The reverse mistake does not exist — a cell with a
  // decimal point is unambiguous whatever the column is set to — so the
  // conservative direction is to refuse a MIXED column and ask.
  const withPoint = amountSamples.filter((s) => s.includes('.')).length;
  if (MINOR_HEADER.test(amountHeader)) {
    denomination = 'minor';
    say('scale', `Amounts read as MINOR units (cents) — the column is named ${named(mapping.amount)}.`);
  } else if (amountSamples.length === 0) {
    denomination = null;
    say('scale', 'No amounts to look at — choose whether this column is in dollars or cents.', 'ask');
  } else if (withPoint === amountSamples.length) {
    denomination = 'major';
    say('scale', 'Amounts read as major units (every sampled cell carries a decimal point).');
  } else if (withPoint > 0) {
    denomination = null;
    say(
      'scale',
      `This column MIXES shapes — ${withPoint} of ${amountSamples.length} sampled cells carry a decimal point and the rest do not, ` +
        'so what a bare number means here is unestablished. Choose dollars or cents; the cells that do carry a decimal point import either way.',
      'ask',
    );
  } else {
    denomination = null;
    say('scale', 'Amounts have NO decimal point, so dollars-vs-cents is ambiguous — choose one. Nothing is imported until you do.', 'ask');
  }

  // Sign: the column is taken at face value unless nothing is ever negative,
  // which usually means the export signs from the bank's side.
  const negatives = amountSamples.filter((s) => s.trim().startsWith('-') || s.trim().startsWith('(')).length;
  const sign: SignConvention = 'outflow-negative';
  if (negatives > 0) say('sign', 'Money out is NEGATIVE in this file (negative amounts are present).');
  else say('sign', 'No negative amounts seen — assuming money out is negative. Flip this if every row is a withdrawal.', 'ask');

  return {mapping, dateFormat: format, sign, denomination, notes};
}

// ── Stored profiles ──────────────────────────────────────────────────────────

const DATE_FORMATS: readonly DateFormat[] = ['iso', 'mdy', 'dmy', 'dmy-dot'];
const SIGN_CONVENTIONS: readonly SignConvention[] = ['outflow-negative', 'outflow-positive'];

const isIndex = (v: unknown, columns: number): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= -1 && v < columns;

/**
 * Validate a profile read back out of plugin STORAGE, before any of it is
 * believed.
 *
 * That storage is `localStorage`: shared with every other tab on the origin,
 * editable from a console, and carried across app versions whose profile shape
 * may differ. Trusting it unchecked means a column index pointing past the end
 * of the header (silently reading empty cells for every row), an `accountId`
 * naming an account that no longer exists or was never this user's, or a
 * `denomination` outside its union sailing straight into the money path.
 *
 * Anything that does not check out falls back to FRESH DETECTION, which is a
 * strictly safe direction: detection cannot establish a scale it cannot see, so
 * the worst case is the user being asked one more question.
 */
export function validateStoredProfile(
  raw: unknown,
  context: {sourceId: string; accountIds: readonly string[]; columnCount: number},
): SourceProfile | null {
  if (raw === null || typeof raw !== 'object') return null;
  const p = raw as Partial<SourceProfile>;
  const mapping = p.mapping;
  if (mapping === undefined || mapping === null || typeof mapping !== 'object') return null;
  if (!isIndex(mapping.date, context.columnCount)) return null;
  if (!isIndex(mapping.amount, context.columnCount)) return null;
  if (!isIndex(mapping.description, context.columnCount)) return null;
  if (typeof p.accountId !== 'string' || !context.accountIds.includes(p.accountId)) return null;
  if (!DATE_FORMATS.includes(p.dateFormat as DateFormat)) return null;
  if (!SIGN_CONVENTIONS.includes(p.sign as SignConvention)) return null;
  if (!(p.denomination === null || p.denomination === 'major' || p.denomination === 'minor')) return null;
  return {
    sourceId: context.sourceId,
    label: sanitizeText(typeof p.label === 'string' ? p.label : ''),
    accountId: p.accountId,
    mapping: {date: mapping.date, amount: mapping.amount, description: mapping.description},
    dateFormat: p.dateFormat as DateFormat,
    sign: p.sign as SignConvention,
    denomination: p.denomination,
  };
}

/**
 * Merge a validated SAVED profile with what detection just concluded about THIS
 * file, and say — out loud, every time — what that merge did.
 *
 * The bug this replaces: the saved branch computed detection and then threw it
 * away, replacing every note with "Nothing needed re-mapping." The profile key
 * is the header shape, and `Date,Amount,Description` is the modal retail-banking
 * header — so a bank that switches `-4.50` to `-450` without renaming a column
 * keeps the same source id, keeps the saved `major`, and puts every amount in
 * the statement 100x out, under a UI saying nothing needed checking.
 *
 * So: a saved decision that CONTRADICTS the evidence in the file loses. For the
 * money scale that means dropping back to `null`, which fires the same hard
 * block a fresh ambiguous file gets — the one decision this importer refuses to
 * make on the user's behalf. For the date format there is no `null` to drop to
 * and no block worth having (see {@link DetectionNote}), so the saved value
 * stands and the disagreement is raised at `ask` severity.
 *
 * THE INVARIANT, which is why {@link DetectionNote} carries a topic: this
 * function must never PRINT a detection note whose premise it has just
 * overridden. Narrating faithfully is only an improvement while every sentence
 * is still true of the profile actually in force — a detection line saying
 * "Nothing is imported until you do" above a live Create button is worse than
 * the silence it replaced, because the user now has a reason to trust it.
 */
export function reconcileSavedProfile(
  saved: SourceProfile,
  detected: Detection,
  accountName: string,
): {profile: SourceProfile; notes: DetectionNote[]} {
  const notes: DetectionNote[] = [];
  let denomination = saved.denomination;
  // Detection's own narration is ALWAYS shown — EXCEPT any line this function
  // has just made untrue. See the no-evidence branch below.
  let passthrough = detected.notes;

  if (detected.denomination !== null && detected.denomination !== saved.denomination) {
    // CONFLICT. The file's evidence contradicts the saved decision, so the
    // saved decision loses and the scale question re-opens — the same hard
    // block a fresh ambiguous file gets. Detection's own scale note stays: it
    // describes the FILE, and it is the evidence for this very message.
    denomination = null;
    notes.push({
      text:
        `This file's amounts look like ${detected.denomination === 'minor' ? 'CENTS' : 'DOLLARS'}, but the mapping saved for this ` +
        `source says ${saved.denomination === 'minor' ? 'cents' : saved.denomination === 'major' ? 'dollars' : 'unset'}. ` +
        'Choose again — getting this wrong is a hundredfold error that still balances.',
      severity: 'ask',
      topic: 'scale',
    });
  } else if (detected.denomination === null && saved.denomination !== null) {
    // NO EVIDENCE, and a saved answer. This is the case the whole conflict
    // check exists for and the one it used to miss: a bank that switches
    // "-4.50" to "-450" under an unchanged header produces a file with no
    // decimal point ANYWHERE, which detection reports as `null` — not as
    // `minor` — so the conflict branch never fired, the saved `major` stood,
    // and every row imported 100x high.
    //
    // The saved answer is still USED (an always-bare-integer bank must not be
    // re-interrogated every month), but detection's line about it must go:
    // "Nothing is imported until you do" printed above a live Create button is
    // a louder lie than the silence it replaced. Say what is actually
    // happening instead, and ask for one row to be checked.
    passthrough = detected.notes.filter((n) => n.topic !== 'scale');
    notes.push({
      text:
        'This file’s amounts have no decimal point. The saved mapping reads them as ' +
        `${saved.denomination === 'minor' ? 'cents' : 'dollars'} and that is what is being used — check one row against your ` +
        'statement before importing. A bank that changes this without renaming a column is a hundredfold error that still balances.',
      severity: 'ask',
      topic: 'scale',
    });
  }

  if (detected.dateFormat !== saved.dateFormat) {
    notes.push({
      text:
        `This file's dates look like ${DATE_FORMAT_LABEL[detected.dateFormat]}, but the saved mapping reads them as ` +
        `${DATE_FORMAT_LABEL[saved.dateFormat]}. The saved choice is being used — check the dates in the preview below.`,
      severity: 'ask',
      topic: 'date',
    });
  }
  notes.push({
    text: accountName === ''
      ? 'Using the mapping saved for this source. Check the account below before importing.'
      : `Using the mapping saved for this source, importing into ${accountName}. Change it if this statement is a different account.`,
    severity: 'note',
    topic: 'columns',
  });
  return {profile: {...saved, denomination}, notes: [...notes, ...passthrough]};
}

/** How each date format is written in a sentence to a human. */
const DATE_FORMAT_LABEL: Record<DateFormat, string> = {
  iso: 'YYYY-MM-DD',
  mdy: 'MM/DD/YYYY',
  dmy: 'DD/MM/YYYY',
  'dmy-dot': 'DD.MM.YYYY',
};

// ── Cell parsing ─────────────────────────────────────────────────────────────

const pad = (n: number): string => String(n).padStart(2, '0');

/** A real ISO calendar day (mirrors the server's `isValidLedgerDate`). */
export function isEntryDateString(date: string): boolean {
  if (!ISO_DATE.test(date)) return false;
  const parsed = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
}

/**
 * One date cell → an ISO `YYYY-MM-DD`, or `null` when it cannot be read in the
 * chosen format. Never throws and never falls back to `new Date(text)`, whose
 * host-dependent guessing is exactly how a statement silently lands in the
 * wrong month.
 */
export function parseRowDate(raw: string, format: DateFormat): string | null {
  const text = raw.trim();
  if (text === '') return null;
  let iso: string | null = null;
  if (format === 'iso') {
    iso = ISO_DATE.test(text) ? text : null;
  } else {
    const re = format === 'dmy-dot' ? DOT_DATE : SLASH_DATE;
    const m = re.exec(text);
    if (m) {
      const [day, month] = format === 'mdy' ? [Number(m[2]), Number(m[1])] : [Number(m[1]), Number(m[2])];
      iso = `${m[3]}-${pad(month)}-${pad(day)}`;
    }
  }
  return iso !== null && isEntryDateString(iso) ? iso : null;
}

/**
 * The `bareDigits` the money core is called with, for a given detected scale.
 * ALWAYS explicit — the importer never inherits the default (LGR-2 review).
 *
 * `null` (scale unestablished) maps to `'reject'`, which is the whole point of
 * that mode: a cell WITH a decimal point is unambiguous and still imports, and
 * a bare integer — the only genuinely ambiguous shape — fails with the money
 * core's own message instead of being guessed at.
 */
export function bareDigitsFor(denomination: Denomination | null): 'major' | 'reject' {
  return denomination === null ? 'reject' : 'major';
}

/** A readable amount, or the reason it could not be read. */
export type AmountResult = {ok: true; minor: number} | {ok: false; problem: string};

/**
 * One amount cell → SIGNED INTEGER MINOR UNITS on the bank account.
 *
 * Every path runs through `parseAmount`. For a MINOR-denominated column the
 * result is rescaled by an exact integer division: `parseAmount` of
 * decimal-point-free text is always a whole number of major units times 100, so
 * `n / 100` is exact in IEEE-754 for every value the parser can return (both
 * operands and the quotient are safe integers, and the quotient is the exact
 * mathematical result — no rounding step is involved). A decimal point in a
 * minor-unit column is a MIXED FILE and is rejected rather than reinterpreted.
 */
export function parseRowAmount(raw: string, denomination: Denomination | null, sign: SignConvention): AmountResult {
  const text = raw.trim();
  if (text === '') return {ok: false, problem: 'no amount in this row'};
  if (denomination === 'minor' && text.includes('.')) {
    return {ok: false, problem: 'this column is set to cents, but this cell has a decimal point — the file mixes scales'};
  }
  let parsed: number;
  try {
    parsed = parseAmount(text, {bareDigits: bareDigitsFor(denomination)});
  } catch (err) {
    return {ok: false, problem: err instanceof Error ? err.message : String(err)};
  }
  let minor = parsed;
  if (denomination === 'minor') {
    if (parsed % 100 !== 0) return {ok: false, problem: `cannot rescale ${text} to cents exactly`};
    minor = parsed / 100;
  }
  if (sign === 'outflow-positive') minor = minor === 0 ? 0 : -minor;
  if (!Number.isSafeInteger(minor)) return {ok: false, problem: 'amount is out of range'};
  return {ok: true, minor};
}

// ── Dedup ────────────────────────────────────────────────────────────────────

/**
 * A 64-bit non-cryptographic digest of the dedup key, as hex.
 *
 * FNV-1a-SHAPED, and deliberately not called FNV-1a-64: it folds the string
 * 16 bits at a time into a split 32/32 accumulator, so the low half matches
 * FNV-1a-32 while the high half does not match the real 64-bit function. That is
 * fine for what it does — a stable, fast, well-spread bucket key — but the next
 * reader must not expect it to agree with any other implementation's FNV-1a-64.
 *
 * NOT a security hash and deliberately not SHA-256: dedup runs per row while the
 * user watches, and WebCrypto's digest is async — an async hash would turn this
 * whole pure module into a promise-returning one for no benefit. Nor would a
 * stronger hash buy anything: suppression is driven by the four INPUT values
 * (see the two-stage residual in the module doc), so an actor who can influence
 * an import simply supplies them and never needs a collision.
 */
function dedupDigest(text: string): string {
  let hi = 0xcbf2_9ce4;
  let lo = 0x8422_2325;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    lo ^= code & 0xffff;
    hi ^= code >>> 16;
    // Multiply by the 64-bit FNV prime, split across two 32-bit halves.
    const loProduct = lo * 0x0000_01b3;
    const hiProduct = hi * 0x0000_01b3 + Math.floor(loProduct / 0x1_0000_0000);
    lo = loProduct >>> 0;
    hi = hiProduct >>> 0;
  }
  return (hi >>> 0).toString(16).padStart(8, '0') + (lo >>> 0).toString(16).padStart(8, '0');
}

/** The dedup key of one imported row: source + date + amount + normalized description. */
export function importRowHash(parts: {sourceId: string; date: string; amountMinor: number; normalizedDescription: string}): string {
  return dedupDigest(`${parts.sourceId}\u0000${parts.date}\u0000${parts.amountMinor}\u0000${parts.normalizedDescription}`);
}

/** The looser key behind the near-duplicate WARNING: same day, same money. */
export function nearDuplicateKey(parts: {sourceId: string; date: string; amountMinor: number}): string {
  return `${parts.sourceId}\u0000${parts.date}\u0000${parts.amountMinor}`;
}

/**
 * What is already on the books, as the importer needs to see it.
 *
 * `counts` is a MULTISET, not a set, so a statement that genuinely contains the
 * same transaction twice (two £3.20 coffees on one day) imports both — while a
 * re-import of that same file still creates nothing, because the file's second
 * occurrence is matched against the ledger's second occurrence.
 */
export interface KnownImports {
  /** Occurrences that are ON THE BOOKS — posted, and not voided since. */
  counts: Record<string, number>;
  /**
   * Occurrences sitting in an UNFINISHED DRAFT. Counted for dedup exactly like
   * the posted ones (re-importing must still create nothing), but reported
   * separately: telling a user a row is "already on the books" when it is
   * actually a half-finished draft sends them looking in the register for an
   * entry that is not there, and hides the 288 rows they still have to
   * categorise.
   */
  draftCounts: Record<string, number>;
  /**
   * Same day + same money, indexed for the near-duplicate warning. BOTH forms
   * of the description are kept: the normalized one is what the comparison uses,
   * the original is what the user is shown — quoting a flattened
   * "sq blue bottle 12" back at somebody as if it were the entry's text makes
   * the warning read like a bug.
   */
  descriptionsByDateAmount: Record<string, Array<{normalized: string; original: string}>>;
}

export const emptyKnownImports = (): KnownImports => ({counts: {}, draftCounts: {}, descriptionsByDateAmount: {}});

/** A transaction as the importer reads it back off the ledger. */
export interface LedgerTransactionLike {
  id: string;
  date: string;
  description: string;
  /**
   * `draft` | `posted` | `void`. Load-bearing: a VOID entry is not in the books
   * and must not suppress the re-import of its row, and a DRAFT is a different
   * verdict from a posted one. An unrecognised value is treated as on-the-books,
   * which fails in the safe direction (suppress, and say so).
   */
  state: string;
  postings: Array<{accountId: string; amountMinor: number}>;
}

/**
 * Rebuild {@link KnownImports} from what the LEDGER actually holds, rather than
 * trusting a local record of past imports. Plugin storage is per browser
 * profile and can be cleared; the books are the truth, so dedup must survive a
 * new machine, a cleared cache, or a restore from backup.
 */
export function knownFromTransactions(
  transactions: readonly LedgerTransactionLike[],
  source: {sourceId: string; accountId: string},
): KnownImports {
  const known = emptyKnownImports();
  for (const tx of transactions) {
    // A VOIDED entry (including one reversed away) is no longer in the books.
    // Counting it would suppress the re-import of a row the user deliberately
    // removed — the one case where re-importing IS the intended repair.
    if (tx.state === 'void') continue;
    for (const posting of tx.postings) {
      if (posting.accountId !== source.accountId) continue;
      const normalizedDescription = normalizeDescription(tx.description);
      const hash = importRowHash({sourceId: source.sourceId, date: tx.date, amountMinor: posting.amountMinor, normalizedDescription});
      const bucket = tx.state === 'draft' ? known.draftCounts : known.counts;
      bucket[hash] = (bucket[hash] ?? 0) + 1;
      const near = nearDuplicateKey({sourceId: source.sourceId, date: tx.date, amountMinor: posting.amountMinor});
      (known.descriptionsByDateAmount[near] ??= []).push({normalized: normalizedDescription, original: sanitizeText(tx.description)});
    }
  }
  return known;
}

// ── Row preparation ──────────────────────────────────────────────────────────

/**
 * `duplicate` is on the books; `duplicate-draft` is an unfinished draft this
 * importer already created. Both create nothing — but only one of them means
 * "done", and conflating them is what turned an interrupted import into a dead
 * end ("already on the books", Create 0 drafts, no way back to the rows).
 */
export type ImportRowStatus = 'new' | 'duplicate' | 'duplicate-draft' | 'near-duplicate' | 'error';

export interface PreparedRow {
  /** 1-based data-row number as the user sees it in their spreadsheet. */
  line: number;
  date: string | null;
  amountMinor: number | null;
  /**
   * The amount CELL exactly as the file wrote it. Shown beside the parsed value
   * (`450` → `$4.50`) because that pairing is the cheapest possible check on the
   * one decision this importer cannot make safely: a scale error is invisible in
   * the parsed column alone, and obvious the moment the raw cell sits next to it.
   */
  rawAmount: string;
  description: string;
  normalizedDescription: string;
  hash: string | null;
  status: ImportRowStatus;
  /** Why it errored, or what the near-duplicate collides with. `null` when clean. */
  problem: string | null;
  /** The account last used for this payee, when one is remembered. */
  suggestedAccountId: string | null;
}

export interface PreparedImport {
  rows: PreparedRow[];
  counts: Record<ImportRowStatus, number>;
  /** True when at least one row is importable. */
  importable: boolean;
}

/**
 * Turn a parsed matrix into per-row verdicts. Total: EVERY data row comes back
 * with a status, so a bad row is a line the user can see and fix rather than an
 * exception that loses the other 300.
 */
export function prepareImport(
  matrix: readonly (readonly string[])[],
  profile: SourceProfile,
  known: KnownImports = emptyKnownImports(),
  rules: Readonly<Record<string, string>> = {},
): PreparedImport {
  const rows: PreparedRow[] = [];
  const counts: Record<ImportRowStatus, number> = {new: 0, duplicate: 0, 'duplicate-draft': 0, 'near-duplicate': 0, error: 0};
  // Occurrences of each hash SO FAR in this file, so the n-th identical row is
  // matched against the n-th already-imported one.
  const seen: Record<string, number> = {};

  for (let i = 1; i < matrix.length; i += 1) {
    const raw = matrix[i];
    // A ragged row is normal (trailing empty columns get dropped by exporters);
    // out-of-range indices simply read as empty.
    const cell = (index: number): string => (index >= 0 ? (raw[index] ?? '') : '');
    const line = i;
    const description = sanitizeText(cell(profile.mapping.description));
    const normalizedDescription = normalizeDescription(description);
    const rawAmount = sanitizeText(cell(profile.mapping.amount));

    // A row that is entirely empty is skipped, not reported: exporters emit
    // them and they are not an error the user needs to act on.
    if (raw.every((c) => c.trim() === '')) continue;

    const date = parseRowDate(cell(profile.mapping.date), profile.dateFormat);
    const amount = parseRowAmount(cell(profile.mapping.amount), profile.denomination, profile.sign);

    // Two blocks rather than one: the date failure is reported in preference to
    // the amount failure (it is the one the user can usually fix in the export
    // settings), and split this way the narrowing is real rather than asserted.
    if (date === null) {
      const problem = `unreadable date ${JSON.stringify(sanitizeText(cell(profile.mapping.date)))}`;
      rows.push({line, date, amountMinor: amount.ok ? amount.minor : null, rawAmount, description, normalizedDescription, hash: null, status: 'error', problem, suggestedAccountId: null});
      counts.error += 1;
      continue;
    }
    if (!amount.ok) {
      rows.push({line, date, amountMinor: null, rawAmount, description, normalizedDescription, hash: null, status: 'error', problem: amount.problem, suggestedAccountId: null});
      counts.error += 1;
      continue;
    }

    const hash = importRowHash({sourceId: profile.sourceId, date, amountMinor: amount.minor, normalizedDescription});
    const occurrence = seen[hash] ?? 0;
    seen[hash] = occurrence + 1;
    const suggestedAccountId = rules[normalizedDescription] ?? null;

    // Posted occurrences are consumed first, then drafted ones, so the n-th
    // identical row in the file gets the truthful verdict for the n-th match.
    const posted = known.counts[hash] ?? 0;
    const drafted = known.draftCounts[hash] ?? 0;
    if (occurrence < posted + drafted) {
      const asDraft = occurrence >= posted;
      rows.push({
        line,
        date,
        amountMinor: amount.minor,
        rawAmount,
        description,
        normalizedDescription,
        hash,
        status: asDraft ? 'duplicate-draft' : 'duplicate',
        problem: asDraft ? 'a draft for this row is already waiting to be categorised' : 'already imported',
        suggestedAccountId,
      });
      counts[asDraft ? 'duplicate-draft' : 'duplicate'] += 1;
      continue;
    }

    // Same day, same money, DIFFERENT wording. Allowed — a bank that rewords a
    // pending charge on settlement is normal, and refusing it would silently
    // drop a real transaction — but worth saying out loud before it doubles up.
    const nearby = known.descriptionsByDateAmount[nearDuplicateKey({sourceId: profile.sourceId, date, amountMinor: amount.minor})] ?? [];
    const collision = nearby.find((d) => d.normalized !== normalizedDescription);
    if (collision !== undefined) {
      rows.push({
        line,
        date,
        amountMinor: amount.minor,
        rawAmount,
        description,
        normalizedDescription,
        hash,
        status: 'near-duplicate',
        problem: `same date and amount as an existing entry described "${collision.original}" — importing anyway`,
        suggestedAccountId,
      });
      counts['near-duplicate'] += 1;
      continue;
    }

    rows.push({line, date, amountMinor: amount.minor, rawAmount, description, normalizedDescription, hash, status: 'new', problem: null, suggestedAccountId});
    counts.new += 1;
  }

  return {rows, counts, importable: counts.new + counts['near-duplicate'] > 0};
}

/**
 * The one-legged DRAFTS this importer left behind on `source.accountId`, as
 * rows the confirm panel can render.
 *
 * Why this exists at all: a draft created by the importer is reachable from NO
 * other surface. It is excluded from the register and the trial balance (it does
 * not balance), the journal block cannot adopt it, and the confirm list was
 * React state — so closing the tab after categorising 12 of 300 rows stranded
 * the other 288 permanently, and the natural recovery (re-upload) reported them
 * as already handled. Reading them back from the LEDGER, the same way dedup is,
 * is what makes the flow resumable; nothing is kept in block props.
 *
 * ONE posting only, on this account: that is the exact shape this importer
 * creates and never touches again once a category leg is added. A two-legged
 * draft is somebody else's entry (or one already categorised here) and is left
 * strictly alone.
 *
 * ASSUMPTION, NOT INVARIANT (LGR-19): nothing marks a draft as this importer's,
 * so "one leg on this account" also matches a draft the journal block — or an
 * agent holding a PAT — is part-way through writing, and confirming replaces
 * the whole postings array. A provenance marker on the draft is the real fix
 * and is tracked separately; do not read this filter as proof of ownership.
 */
export function strandedDrafts(
  transactions: readonly LedgerTransactionLike[],
  source: {sourceId: string; accountId: string},
  rules: Readonly<Record<string, string>> = {},
): Array<{draftId: string; bankAccountId: string; row: PreparedRow}> {
  if (source.accountId === '') return [];
  const out: Array<{draftId: string; bankAccountId: string; row: PreparedRow}> = [];
  for (const tx of transactions) {
    if (tx.state !== 'draft' || tx.postings.length !== 1) continue;
    const posting = tx.postings[0];
    if (posting.accountId !== source.accountId) continue;
    const description = sanitizeText(tx.description);
    const normalizedDescription = normalizeDescription(description);
    out.push({
      draftId: tx.id,
      // The draft's OWN account, not the profile's — see `buildConfirmPatchFor`.
      bankAccountId: posting.accountId,
      row: {
        // No CSV line: this row came back from the books, not from a file.
        line: 0,
        date: tx.date,
        amountMinor: posting.amountMinor,
        // No file, so no raw cell — the books ARE the source.
        rawAmount: '',
        description,
        normalizedDescription,
        hash: importRowHash({sourceId: source.sourceId, date: tx.date, amountMinor: posting.amountMinor, normalizedDescription}),
        status: 'duplicate-draft',
        problem: null,
        suggestedAccountId: rules[normalizedDescription] ?? null,
      },
    });
  }
  return out;
}

/**
 * Preview ORDER. The rows a human has to act on come first, because the preview
 * is capped and the cap is reached exactly when per-row reporting matters most:
 * at 5 000 rows the four unreadable ones were silently below the fold, and the
 * footer cheerfully said "All of them import."
 */
const PREVIEW_RANK: Record<ImportRowStatus, number> = {
  error: 0,
  'near-duplicate': 1,
  new: 2,
  'duplicate-draft': 3,
  duplicate: 4,
};

/** The first `limit` rows of the preview, worst first, file order within a rank. */
export function previewRows(prepared: PreparedImport, limit: number): PreparedRow[] {
  return [...prepared.rows].sort((a, b) => PREVIEW_RANK[a.status] - PREVIEW_RANK[b.status] || a.line - b.line).slice(0, limit);
}

/**
 * The truthful footer under a TRUNCATED preview. The old one said "Showing the
 * first 200 of N rows. All of them import." — false the moment a single row is
 * unreadable or a duplicate, which is most real statements.
 */
export function describePreviewLimit(prepared: PreparedImport, shown: number): string {
  const total = prepared.rows.length;
  const willImport = prepared.counts.new + prepared.counts['near-duplicate'];
  return (
    `Showing ${shown} of ${total} rows, the ones needing attention first. ` +
    `${willImport} of ${total} will import; ${total - willImport} will not.`
  );
}

/** Rows that should actually become drafts (duplicates and errors never do). */
export const importableRows = (prepared: PreparedImport): PreparedRow[] =>
  prepared.rows.filter((r) => r.status === 'new' || r.status === 'near-duplicate');

// ── Draft payloads ───────────────────────────────────────────────────────────

/** A ledger draft input, in the shape `api.ledger.createDraft` takes. */
export interface DraftInput {
  date: string;
  description: string;
  postings: Array<{accountId: string; amountMinor: number; memo: string | null}>;
}

/**
 * The draft ONE bank row becomes: the bank side pre-filled, the category side
 * still to be chosen. Deliberately a one-legged draft — a draft need not
 * balance, and inventing a suspense account would put a guess in the books that
 * somebody has to find and undo later. The raw statement line rides along as
 * the leg's MEMO (LGR-16), which is what makes the entry legible next month.
 */
export function buildDraftInput(row: PreparedRow, profile: SourceProfile): DraftInput {
  if (row.date === null || row.amountMinor === null) {
    throw new Error(`row ${row.line} is not importable`);
  }
  return {
    date: row.date,
    description: row.description,
    postings: [{accountId: profile.accountId, amountMinor: row.amountMinor, memo: row.description || null}],
  };
}

/**
 * The patch that CONFIRMS a draft: the category leg is added so the entry
 * balances exactly, by construction, at the same magnitude as the bank leg.
 *
 * The bank account is passed EXPLICITLY rather than read from a profile,
 * because the profile is live UI state and the draft is not. A draft rehydrated
 * from the books belongs to the account its own posting names; if the user
 * changes the account dropdown, a confirm that took its bank leg from the
 * current profile would REWRITE that leg to a different account — deleting the
 * original posting and silently moving money between two accounts' balances.
 * The draft carries its own answer, so it is the one used.
 */
export function buildConfirmPatchFor(row: PreparedRow, bankAccountId: string, categoryAccountId: string): {postings: DraftInput['postings']} {
  if (row.date === null || row.amountMinor === null) throw new Error(`row ${row.line} is not confirmable`);
  const bank = {accountId: bankAccountId, amountMinor: row.amountMinor, memo: row.description || null};
  return {
    postings: [bank, {accountId: categoryAccountId, amountMinor: bank.amountMinor === 0 ? 0 : -bank.amountMinor, memo: row.description || null}],
  };
}

/** {@link buildConfirmPatchFor} for a row whose bank account IS the profile's. */
export function buildConfirmPatch(row: PreparedRow, profile: SourceProfile, categoryAccountId: string): {postings: DraftInput['postings']} {
  return buildConfirmPatchFor(row, profile.accountId, categoryAccountId);
}

/**
 * Learn a description→account rule from a confirmation. Last one wins: a payee
 * that moves to a different account should follow the user's most recent
 * decision, not argue with it.
 */
export function learnRule(
  rules: Readonly<Record<string, string>>,
  normalizedDescription: string,
  accountId: string,
): Record<string, string> {
  if (normalizedDescription === '' || accountId === '') return {...rules};
  return {...rules, [normalizedDescription]: accountId};
}

// ── File reading ─────────────────────────────────────────────────────────────

/** A parsed upload, or the reason it could not be read. */
export type ReadResult = {ok: true; matrix: string[][]} | {ok: false; problem: string};

/**
 * Parse uploaded CSV TEXT under the hostile-input limits. Wraps the shared
 * reader so every size failure comes back as a sentence for the user rather
 * than an exception crossing the render boundary.
 */
export function readImportCsv(text: string): ReadResult {
  try {
    const matrix = parseCsv(text, IMPORT_LIMITS);
    if (matrix.length === 0) return {ok: false, problem: 'That file has no rows.'};
    if (matrix.length === 1) return {ok: false, problem: 'That file has a header but no transactions.'};
    return {ok: true, matrix};
  } catch (err) {
    if (err instanceof CsvLimitError) return {ok: false, problem: `${err.message}. Split the statement and import it in parts.`};
    return {ok: false, problem: err instanceof Error ? err.message : String(err)};
  }
}

/** A one-line summary of a prepared import, for the live region. */
export function describeImport(prepared: PreparedImport): string {
  const {counts} = prepared;
  const parts = [`${counts.new} new`];
  if (counts['near-duplicate'] > 0) parts.push(`${counts['near-duplicate']} possible duplicate${counts['near-duplicate'] === 1 ? '' : 's'}`);
  if (counts['duplicate-draft'] > 0) parts.push(`${counts['duplicate-draft']} already drafted`);
  if (counts.duplicate > 0) parts.push(`${counts.duplicate} already imported`);
  if (counts.error > 0) parts.push(`${counts.error} unreadable`);
  return `${parts.join(' · ')}.`;
}
