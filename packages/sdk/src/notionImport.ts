/**
 * **Notion "Markdown & CSV" export → import IR.** Ingests the zip Notion produces
 * for *Export → Markdown & CSV* and emits the format-agnostic {@link ImportedDoc}
 * (see `import.ts`), so {@link importDoc} can land the whole tree through the
 * existing data paths (Strategy B — a bundle the server id-remaps, link-rewrites,
 * and name-dedups as one graph).
 *
 * **Export shape.** Notion writes a forest of folders + files; every page/database
 * filename is suffixed with the 32-hex Notion id (dashes stripped):
 *
 * ```
 *  Export-<uuid>/                         ← transparent wrapper (any non-page dir)
 *    Launch Plan <id>.md                  ← a page
 *    Launch Plan <id>/                     ← its child pages live here
 *      Sub Note <id>.md
 *    Team Tasks <id>.csv                  ← a database (schema + rows)
 *    Team Tasks <id>/                      ← the database's row pages (bodies)
 *      Ship v1 <id>.md
 * ```
 *
 *  - **Folder nesting → the page tree.** A `.md` at `A/B/C.md` whose sibling
 *    folder `A/B/C/` holds more `.md`/`.csv` becomes an {@link ImportedPage} with
 *    those as `children`. Titles drop the hash suffix.
 *  - **Each `.md` → blocks** via the merged Markdown importer
 *    ({@link markdownToImportedDoc}, T2) — reused verbatim, not reparsed.
 *  - **A `.csv` → an {@link ImportedDatabase}.** Column property types are inferred
 *    from the cell values (text / number / checkbox / date / select / multi_select
 *    / url / email — a comma-bearing cell ⇒ multi_select); each row links to its
 *    `.md` page in the sibling folder for the row body. **Scalar properties only**
 *    — a CSV cannot encode relation/rollup/formula targets, so those degrade to a
 *    plain scalar (never a dangling `relation`), the v1 owner decision.
 *  - **Internal links** (the hash-suffixed relative `.md`/`.csv` path Notion
 *    writes) resolve to an `@`-mention run when the target was imported; an
 *    unresolved internal link keeps its visible text (never dropped). External
 *    `http(s)`/`mailto:` links and file/asset refs are preserved as links.
 *  - **Icon** — a leading emoji on the page title is lifted to `sys_icon`.
 *  - **Images/files** — handled by the Markdown importer as the import core's
 *    {@link imagePlaceholderBlock} / a link run that preserves the ref.
 *  - **Toggles** — Notion flattens these to a heading/list in Markdown; the
 *    content survives via T2 (we do not reconstruct an `accordion`, whose
 *    structure does not survive the export).
 *
 * **Never silently drop.** Unknown constructs degrade to text (T2's contract);
 * any `.md`/`.csv` the tree walk somehow misses is appended as a top-level page;
 * a row with no matching body still lands with its properties.
 */

import {unzipSync, strFromU8} from 'fflate';
import {markdownToImportedDoc} from './markdownImport';
import {
  IMAGE_PLACEHOLDER_PROP,
  type ImportedBlock,
  type ImportedDatabase,
  type ImportedDoc,
  type ImportedPage,
  type ImportedRow,
  type ImportInlineAttrs,
  type ImportTextRun,
} from './import';
import {
  SELECT_COLORS,
  shortId,
  type DatabaseProperty,
  type DatabasePropertyType,
  type DatabaseSchema,
  type DatabaseSelectOption,
} from './database';

// ── Path helpers ─────────────────────────────────────────────────────────────

const baseName = (p: string): string => {
  const i = p.lastIndexOf('/');
  return i < 0 ? p : p.slice(i + 1);
};

const dirOf = (p: string): string => {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
};

/** Strip a trailing `.md` / `.csv` extension. */
const stripExt = (p: string): string => p.replace(/\.(md|csv)$/i, '');

/** The 32-hex Notion id embedded in a file's name, if any (the last such run). */
const NOTION_ID_G = /[0-9a-f]{32}/gi;
const idOf = (p: string): string | null => {
  const m = stripExt(baseName(p)).match(NOTION_ID_G);
  return m ? m[m.length - 1].toLowerCase() : null;
};

/** A bundle id pinned from a Notion id, so a mention and its target agree. */
const syntheticId = (notionId: string): string => `imp_n_${notionId}`;

/** A human title: the basename minus its extension, a trailing `_all` view
 *  marker (a database exported as its complete view; see {@link dbKeyOf}), and a
 *  trailing ` <32hex>` Notion id. Stripping `_all` keeps the database name clean
 *  ("Reading List", not "Reading List <id>_all") when the `_all` view is chosen. */
const titleOf = (p: string): string => {
  const stem = stripExt(baseName(p)).replace(/_all$/i, '');
  return stem.replace(/\s+[0-9a-f]{32}$/i, '').trim() || stem;
};

/** Junk the OS / Notion leaves in a zip that is not page content. */
const isJunk = (p: string): boolean =>
  p.startsWith('__MACOSX/') || baseName(p) === '.DS_Store' || baseName(p).startsWith('._');

// ── Leading-emoji icon ───────────────────────────────────────────────────────

// A leading emoji (with any variation-selector / ZWJ-joined parts) then whitespace.
const ICON_RE = /^(\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*)\s+([\s\S]+)$/u;

/** Split a leading emoji off a title → `{icon, title}` (icon undefined if none). */
function splitIcon(title: string): {icon?: string; title: string} {
  const m = ICON_RE.exec(title);
  if (!m) return {title};
  return {icon: m[1], title: m[2].trim()};
}

// ── CSV parsing ──────────────────────────────────────────────────────────────

/**
 * RFC-4180-ish CSV → a matrix of rows. Handles quoted fields containing commas
 * and newlines, doubled `""` escapes, and CRLF — everything Notion emits.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0; // skip a BOM
  const n = text.length;
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
      row.push(field);
      field = '';
      i += 1;
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i += 1;
    } else if (ch === '\r') {
      i += 1;
    } else {
      field += ch;
      i += 1;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

// ── Column type inference ────────────────────────────────────────────────────

const isBoolish = (v: string): boolean => /^(yes|no|true|false)$/i.test(v);
const isNumeric = (v: string): boolean => /^[+-]?(\d+(\.\d+)?|\.\d+)$/.test(v);
const isUrl = (v: string): boolean => /^https?:\/\//i.test(v);
const isEmail = (v: string): boolean => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
const isDateish = (v: string): boolean =>
  /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2})?$/.test(v) || /^[A-Za-z]{3,9}\.?\s+\d{1,2},\s+\d{4}/.test(v);

const all = (xs: string[], pred: (x: string) => boolean): boolean => xs.length > 0 && xs.every(pred);

/** Infer a scalar property type from a column's non-empty cell values. */
function inferType(values: string[]): DatabasePropertyType {
  if (values.length === 0) return 'text';
  if (all(values, isBoolish)) return 'checkbox';
  if (all(values, isNumeric)) return 'number';
  if (all(values, isDateish)) return 'date';
  if (all(values, isUrl)) return 'url';
  if (all(values, isEmail)) return 'email';
  // A comma-bearing cell is a multi-value list → multi_select.
  if (values.some((v) => v.includes(','))) return 'multi_select';
  // Low-cardinality with repeats reads as a single-select; all-distinct is freeform.
  const distinct = new Set(values);
  if (distinct.size < values.length && distinct.size <= 25) return 'select';
  return 'text';
}

const splitMulti = (v: string): string[] =>
  v
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');

/** Build {@link DatabaseSelectOption}s for a select/multi_select column. */
function buildOptions(labels: string[]): DatabaseSelectOption[] {
  return labels.map((label, i) => ({id: shortId('opt'), label, color: SELECT_COLORS[i % SELECT_COLORS.length]}));
}

/** A normalised `YYYY-MM-DD` for a date cell, or the raw text if unparseable. */
function toIsoDate(raw: string): string {
  const iso = /^(\d{4}-\d{2}-\d{2})/.exec(raw);
  if (iso) return iso[1];
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? raw : d.toISOString().slice(0, 10);
}

/** A column's full definition plus the label→optionId map used to coerce cells. */
interface Column {
  property: DatabaseProperty;
  optionByLabel: Map<string, string>;
}

function buildColumn(name: string, values: string[]): Column {
  const nonEmpty = values.filter((v) => v !== '');
  const type = inferType(nonEmpty);
  const property: DatabaseProperty = {id: shortId('prop'), name: name || 'Untitled', type};
  const optionByLabel = new Map<string, string>();
  if (type === 'select' || type === 'multi_select') {
    const labels =
      type === 'multi_select'
        ? [...new Set(nonEmpty.flatMap(splitMulti))]
        : [...new Set(nonEmpty.map((v) => v.trim()))];
    property.options = buildOptions(labels);
    for (const o of property.options) optionByLabel.set(o.label, o.id);
  }
  return {property, optionByLabel};
}

/** Coerce a raw cell string into the stored value for its column's type. */
function coerceCell(raw: string, col: Column): unknown {
  const v = raw.trim();
  if (v === '') return undefined;
  switch (col.property.type) {
  case 'number':
    return Number(v);
  case 'checkbox':
    return /^(yes|true)$/i.test(v);
  case 'date':
    return toIsoDate(v);
  case 'select':
    return col.optionByLabel.get(v);
  case 'multi_select':
    return splitMulti(v)
      .map((label) => col.optionByLabel.get(label))
      .filter((id): id is string => typeof id === 'string');
  default:
    return v; // text / url / email
  }
}

// ── Internal-link resolution ─────────────────────────────────────────────────

/** A relative href has no URI scheme and is not an in-page anchor. */
const isRelative = (href: string): boolean => !/^[a-z][a-z0-9+.-]*:/i.test(href) && !href.startsWith('#');

const safeDecode = (s: string): string => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/**
 * Resolve a single href against the imported id set. `change:false` leaves the
 * run as-is (external URL or file/asset ref — the link, and its ref, are kept).
 * `change:true` rewrites it: to an `@`-mention when the target was imported, or
 * to plain text (dropping a dead internal href) when it was not. `attrs` is the
 * run's existing formatting (bold/italic/…), which is preserved either way.
 */
function resolveHref(
  attrs: ImportInlineAttrs,
  href: string,
  knownIds: Set<string>,
  titleById: Map<string, string>,
): {change: boolean; attrs?: ImportInlineAttrs; text?: string} {
  if (!isRelative(href)) return {change: false}; // external URL — leave as-is
  const path = safeDecode(href).split('#')[0].split('?')[0];
  const pointsAtPage = /\.(md|csv)$/i.test(path) || /[0-9a-f]{32}$/i.test(path);
  if (!pointsAtPage) return {change: false}; // file/asset ref — keep the link, preserve the ref
  const ids = path.match(NOTION_ID_G);
  const id = ids ? ids[ids.length - 1].toLowerCase() : null;
  const rest = {...attrs};
  delete rest.a;
  if (id && knownIds.has(id)) {
    return {change: true, attrs: {...rest, m: syntheticId(id)}, text: titleById.get(id)};
  }
  // Internal, but the target was not imported: keep the visible text, drop the
  // dead relative href (never a click-to-nowhere link).
  return {change: true, attrs: Object.keys(rest).length > 0 ? rest : undefined};
}

/** Rewrite link runs across a run list (mentions / preserved links). */
function resolveRuns(runs: ImportTextRun[], knownIds: Set<string>, titleById: Map<string, string>): ImportTextRun[] {
  return runs.map((run) => {
    const href = run.a?.a;
    if (!href) return run;
    const {change, attrs, text} = resolveHref(run.a!, href, knownIds, titleById);
    if (!change) return run; // external URL / asset ref — keep the link + ref
    const t = run.t !== '' ? run.t : text ?? run.t;
    return attrs ? {t, a: attrs} : {t};
  });
}

/** Resolve links throughout a block tree (skipping synthetic image placeholders). */
function resolveLinks(blocks: ImportedBlock[], knownIds: Set<string>, titleById: Map<string, string>): ImportedBlock[] {
  return blocks.map((b) => {
    if (b.props?.[IMAGE_PLACEHOLDER_PROP]) return b; // the placeholder's link is a real ref, not a page link
    const next: ImportedBlock = {...b};
    if (b.text) next.text = resolveRuns(b.text, knownIds, titleById);
    if (b.children) next.children = resolveLinks(b.children, knownIds, titleById);
    return next;
  });
}

// ── The walk ─────────────────────────────────────────────────────────────────

/** Everything the recursive builders need, gathered once from the zip. */
interface Corpus {
  text: (path: string) => string;
  mdPaths: string[];
  /** dbKey (`Dir/Name <id>`) → the chosen csv path (prefers a `_all` variant). */
  csvByKey: Map<string, string>;
  knownIds: Set<string>;
  titleById: Map<string, string>;
  consumed: Set<string>;
  /** Does the zip hold this exact entry path? (Used to resolve image refs to bytes.) */
  hasEntry: (path: string) => boolean;
}

/** Resolve `rel` against directory `dir`, collapsing `.`/`..` (a tiny posix-join). */
function joinPath(dir: string, rel: string): string {
  const out: string[] = [];
  for (const part of (dir ? dir.split('/') : []).concat(rel.split('/'))) {
    if (part === '' || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
}

/**
 * Rewrite each image placeholder's `ref` from the Markdown importer's relative
 * `src` (e.g. `Page%20abc/image.png`) to the **absolute in-zip path** of the
 * bytes (`Export-x/Page abc/image.png`), resolved against the source `.md`'s
 * directory — but only when that entry actually exists in the zip. This lets the
 * post-import rehydration pass ({@link notionAssetResolver}) find each image's
 * bytes by a plain `entries[ref]` lookup. An external URL, or a relative ref that
 * matches no entry, is left untouched (it degrades to a placeholder, ref intact).
 */
function resolveImageRefs(blocks: ImportedBlock[], baseDir: string, hasEntry: (p: string) => boolean): void {
  for (const b of blocks) {
    const meta = b.props?.[IMAGE_PLACEHOLDER_PROP] as {ref?: string} | undefined;
    if (meta?.ref && isRelative(meta.ref)) {
      const decoded = safeDecode(meta.ref).split('#')[0].split('?')[0];
      const candidate = joinPath(baseDir, decoded);
      if (hasEntry(candidate)) meta.ref = candidate;
      else if (hasEntry(decoded)) meta.ref = decoded;
    }
    if (b.children) resolveImageRefs(b.children, baseDir, hasEntry);
  }
}

/** The row folder a csv's rows live in (a `_all` view shares the plain folder). */
const dbKeyOf = (csvPath: string): string => stripExt(csvPath).replace(/_all$/i, '');

/** Direct child `.md` pages of a folder. */
const childMd = (c: Corpus, folder: string): string[] => c.mdPaths.filter((p) => dirOf(p) === folder);

/** Direct child databases (chosen csvs) of a folder. */
const childDb = (c: Corpus, folder: string): string[] =>
  [...c.csvByKey.values()].filter((p) => dirOf(p) === folder);

/** Parse a `.md` file → `{icon, title, blocks}` with links resolved. */
function readPage(c: Corpus, mdPath: string): {icon?: string; title: string; blocks: ImportedBlock[]} {
  c.consumed.add(mdPath);
  const doc = markdownToImportedDoc(c.text(mdPath), {defaultTitle: titleOf(mdPath)});
  const page = doc.pages[0];
  const {icon, title} = splitIcon(page.title);
  const blocks = resolveLinks(page.blocks, c.knownIds, c.titleById);
  // Point each embedded image at its absolute in-zip path (relative to this .md),
  // so its bytes can be rehydrated into the asset store after import.
  resolveImageRefs(blocks, dirOf(mdPath), c.hasEntry);
  return {icon, title, blocks};
}

/** A database row's body: its own blocks plus any sub-pages/sub-dbs flattened in
 *  (so a row's nested content is never dropped, even though the row IR has no
 *  child-page slot). */
function rowBody(c: Corpus, mdPath: string): ImportedBlock[] {
  const blocks = readPage(c, mdPath).blocks;
  const folder = stripExt(mdPath);
  for (const sub of childMd(c, folder)) {
    const page = readPage(c, sub);
    blocks.push({type: 'divider'});
    blocks.push({type: 'heading', props: {level: 3}, text: [{t: page.title}]});
    blocks.push(...page.blocks);
  }
  for (const csv of childDb(c, folder)) {
    c.consumed.add(csv);
    const {name, rows} = readDatabase(c, csv);
    blocks.push({type: 'heading', props: {level: 3}, text: [{t: name}]});
    for (const r of rows) blocks.push({type: 'list', props: {kind: 'bullet'}, text: [{t: r.title}]});
  }
  return blocks;
}

/** Parse a csv (+ its row folder) into a name, schema, and rows. */
function readDatabase(c: Corpus, csvPath: string): {name: string; schema: DatabaseSchema; rows: ImportedRow[]} {
  const name = titleOf(csvPath);
  const matrix = parseCsv(c.text(csvPath));
  const header = matrix[0] ?? [];
  const dataRows = matrix.slice(1).filter((r) => r.some((cell) => cell.trim() !== ''));

  // Columns: the first column is the row title; the rest become properties.
  const columns: Column[] = [];
  for (let j = 1; j < header.length; j += 1) {
    columns.push(buildColumn(header[j], dataRows.map((r) => r[j] ?? '')));
  }
  const properties = columns.map((col) => col.property);
  const schema: DatabaseSchema = {
    properties,
    views: [{id: shortId('view'), name: 'Table', type: 'table', filters: [], sorts: []}],
  };

  // Row bodies: the `.md` pages directly in the database's folder, matched by title.
  const folder = dbKeyOf(csvPath);
  const bodyByTitle = new Map<string, string[]>();
  for (const md of childMd(c, folder)) {
    const key = titleOf(md).toLowerCase();
    const list = bodyByTitle.get(key);
    if (list) list.push(md);
    else bodyByTitle.set(key, [md]);
  }
  const used = new Set<string>();
  const takeBody = (title: string): string | undefined => {
    const candidates = bodyByTitle.get(title.trim().toLowerCase());
    const md = candidates?.find((p) => !used.has(p));
    if (md) used.add(md);
    return md;
  };

  const rows: ImportedRow[] = dataRows.map((r) => {
    const title = (r[0] ?? '').trim();
    const props: Record<string, unknown> = {};
    columns.forEach((col, k) => {
      const value = coerceCell(r[k + 1] ?? '', col);
      if (value !== undefined && !(Array.isArray(value) && value.length === 0)) props[col.property.id] = value;
    });
    const md = takeBody(title);
    const row: ImportedRow = {title, properties: props, blocks: md ? rowBody(c, md) : []};
    const nid = md ? idOf(md) : null;
    if (nid) row.id = syntheticId(nid);
    return row;
  });

  // Any row page with no CSV counterpart still lands (never dropped).
  for (const md of childMd(c, folder)) {
    if (used.has(md)) continue;
    used.add(md);
    const row: ImportedRow = {title: titleOf(md), properties: {}, blocks: rowBody(c, md)};
    const nid = idOf(md);
    if (nid) row.id = syntheticId(nid);
    rows.push(row);
  }
  return {name, schema, rows};
}

/** Build a regular page node (recursing its child pages and databases). */
function buildPage(c: Corpus, mdPath: string): ImportedPage {
  const {icon, title, blocks} = readPage(c, mdPath);
  const folder = stripExt(mdPath);
  const children: ImportedPage[] = [
    ...childMd(c, folder).map((p) => buildPage(c, p)),
    ...childDb(c, folder).map((p) => buildDatabasePage(c, p)),
  ];
  const page: ImportedPage = {title, blocks};
  const nid = idOf(mdPath);
  if (nid) page.id = syntheticId(nid);
  if (icon) page.icon = icon;
  if (children.length > 0) page.children = children;
  return page;
}

/** Build the host page that carries a database. */
function buildDatabasePage(c: Corpus, csvPath: string): ImportedPage {
  c.consumed.add(csvPath);
  const {name, schema, rows} = readDatabase(c, csvPath);
  const database: ImportedDatabase = {name, schema, rows};
  const page: ImportedPage = {title: name, blocks: [], database};
  const nid = idOf(csvPath);
  if (nid) page.id = syntheticId(nid);
  return page;
}

// ── Entry point ──────────────────────────────────────────────────────────────

/**
 * Parse a Notion *Markdown & CSV* export zip into an {@link ImportedDoc} ready for
 * {@link importDoc}. Pure (no client, no I/O beyond the in-memory unzip), so it is
 * directly unit-testable. Throws only when the bytes are not a readable zip.
 */
export function notionExportToImportedDoc(zipBytes: Uint8Array): ImportedDoc {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(zipBytes);
  } catch {
    throw new Error('not a readable Notion export zip');
  }

  const paths = Object.keys(entries).filter((p) => !p.endsWith('/') && !isJunk(p));
  const text = (path: string): string => strFromU8(entries[path]);
  const mdPaths = paths.filter((p) => /\.md$/i.test(p));
  const csvPaths = paths.filter((p) => /\.csv$/i.test(p));

  // One database per row folder; prefer a `_all` view (it carries every column).
  const csvByKey = new Map<string, string>();
  for (const csv of csvPaths) {
    const key = dbKeyOf(csv);
    const current = csvByKey.get(key);
    if (!current || /_all$/i.test(stripExt(csv))) csvByKey.set(key, csv);
  }

  const pageFolders = new Set(mdPaths.map(stripExt));
  const dbFolders = new Set(csvByKey.keys());

  // A page/db is a "row descendant" (flattened into its row, not a standalone
  // node) when it lives *below* a database's row folder rather than directly in
  // it. Only standalone nodes are mention targets.
  const isRowDescendant = (p: string): boolean =>
    [...dbFolders].some((d) => p.startsWith(`${d}/`) && dirOf(p) !== d);

  const knownIds = new Set<string>();
  const titleById = new Map<string, string>();
  const addNode = (p: string): void => {
    const id = idOf(p);
    if (!id) return;
    titleById.set(id, titleOf(p));
    if (!isRowDescendant(p)) knownIds.add(id);
  };
  mdPaths.forEach(addNode);
  for (const csv of csvByKey.values()) addNode(csv);

  const consumed = new Set<string>();
  const hasEntry = (p: string): boolean => Object.prototype.hasOwnProperty.call(entries, p);
  const corpus: Corpus = {text, mdPaths, csvByKey, knownIds, titleById, consumed, hasEntry};

  // Roots: pages/dbs whose parent dir is neither a page folder nor a database
  // folder — i.e. top-level items (a wrapper like `Export-<uuid>/` is transparent).
  const isRoot = (p: string): boolean => !pageFolders.has(dirOf(p)) && !dbFolders.has(dirOf(p));
  const pages: ImportedPage[] = [];
  for (const md of mdPaths) if (isRoot(md)) pages.push(buildPage(corpus, md));
  for (const csv of csvByKey.values()) if (isRoot(csv)) pages.push(buildDatabasePage(corpus, csv));

  // Safety net: never silently drop a page/db the walk somehow missed.
  for (const md of mdPaths) {
    if (consumed.has(md)) continue;
    const {icon, title, blocks} = readPage(corpus, md);
    const page: ImportedPage = {title, blocks};
    const nid = idOf(md);
    if (nid) page.id = syntheticId(nid);
    if (icon) page.icon = icon;
    pages.push(page);
  }
  for (const csv of csvByKey.values()) {
    if (!consumed.has(csv)) pages.push(buildDatabasePage(corpus, csv));
  }

  return {pages};
}
