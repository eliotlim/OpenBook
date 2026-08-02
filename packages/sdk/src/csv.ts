/**
 * The shared RFC-4180 CSV reader.
 *
 * ONE parser for every CSV that enters the product — the Notion export importer
 * (its original home, `notionImport.ts`) and the LGR-10 bank-statement importer.
 * A second implementation would mean a second set of quoting bugs, and the
 * corpus of nasty inputs the existing tests pin (quoted commas, doubled `""`
 * escapes, embedded newlines, CRLF, BOM) is exactly what a hand-rolled split
 * gets wrong.
 *
 * The parser is DEFENSIVE about size but not about content: it returns whatever
 * text the file holds, and callers are responsible for what they do with it
 * (see the ledger CSV's formula neutralization for the other half of that).
 */

/** A CSV whose SIZE exceeds the caller's limits — never a silent truncation. */
export class CsvLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CsvLimitError';
  }
}

/** Size limits for {@link parseCsv}. Every limit is OFF unless the caller sets it. */
export interface ParseCsvOptions {
  /** Maximum characters of input. */
  maxLength?: number;
  /** Maximum rows to produce (the header counts). */
  maxRows?: number;
  /** Maximum characters in ONE field. */
  maxFieldLength?: number;
  /** Maximum fields in ONE row. */
  maxColumns?: number;
}

/**
 * RFC-4180-ish CSV → a matrix of rows. Handles quoted fields containing commas
 * and newlines, doubled `""` escapes, CRLF, and a leading BOM — everything
 * Notion emits, and everything a bank's export server does.
 *
 * Lenient by design about STRUCTURE: ragged rows are returned ragged (the
 * caller decides whether a short row is an error), an unterminated quote runs
 * to end-of-input rather than throwing, and a trailing newline does not produce
 * a phantom empty row. Nothing here rejects a file for being malformed — a
 * half-broken statement should still show the user the rows it could read.
 *
 * SIZE, on the other hand, is a caller-set contract: an UNTRUSTED file (an
 * upload) must pass {@link ParseCsvOptions} limits, because the matrix is built
 * fully in memory and a 2 GB single-field file would otherwise take the tab
 * down. Exceeding a limit throws {@link CsvLimitError} — loudly, so the user is
 * told the file is too big instead of silently importing a prefix of their bank
 * statement. Omitting the options preserves the original unbounded behaviour
 * for trusted, already-in-memory input.
 */
export function parseCsv(text: string, opts: ParseCsvOptions = {}): string[][] {
  const {maxLength, maxRows, maxFieldLength, maxColumns} = opts;
  if (maxLength !== undefined && text.length > maxLength) {
    throw new CsvLimitError(`CSV is too large: ${text.length} characters (limit ${maxLength})`);
  }
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0; // skip a BOM
  const n = text.length;

  // Peak memory is bounded by `maxLength` alone: every accumulated field and
  // the whole matrix are slices of the input, so a caller that caps the input
  // cannot be made to allocate unboundedly whatever the file's shape. The
  // per-field / per-row / per-column caps below are about producing a SENSIBLE
  // error ("this column is 40 000 characters wide") rather than about safety.
  const endField = (): void => {
    if (maxFieldLength !== undefined && field.length > maxFieldLength) {
      throw new CsvLimitError(`CSV field is too long: ${field.length} characters (limit ${maxFieldLength})`);
    }
    row.push(field);
    field = '';
    if (maxColumns !== undefined && row.length > maxColumns) {
      throw new CsvLimitError(`CSV row has too many columns: ${row.length} (limit ${maxColumns})`);
    }
  };
  const endRow = (): void => {
    endField();
    rows.push(row);
    row = [];
    if (maxRows !== undefined && rows.length > maxRows) {
      throw new CsvLimitError(`CSV has too many rows: ${rows.length} (limit ${maxRows})`);
    }
  };

  while (i < n) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      quoted = true;
      i += 1;
    } else if (ch === ',') {
      endField();
      i += 1;
    } else if (ch === '\n') {
      endRow();
      i += 1;
    } else if (ch === '\r') {
      i += 1;
    } else {
      field += ch;
      i += 1;
    }
  }
  if (field !== '' || row.length > 0) endRow();
  return rows;
}
