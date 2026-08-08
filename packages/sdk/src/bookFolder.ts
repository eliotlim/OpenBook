import type {StoredPage, PageSnapshot} from './types';
import type {StoredDatabase} from './database';
import {pageToBookHtml, bookHtmlToPage, slugify, BOOK_RUNTIME_FILE} from './bookfile';
import {islandScript, readIsland} from './island';
import type {LedgerExportSection} from './ledgerExportSection';

/**
 * Whole-space → folder-of-files serialisation, shared by every "dump my books
 * to a folder" surface: the desktop's native folder export and the web app's
 * File System Access export both call {@link libraryToBookFiles}, and the layout
 * is byte-compatible with the server's on-disk {@link BookMirror} (OB-134) so a
 * folder written by one can be re-imported by the other.
 *
 * The layout is exactly two levels deep — `<book-folder>/<page>.html` — where
 * the book folder is named from the page's *root* ancestor. Each page renders to
 * the human-readable `.book.html` format (`pageToBookHtml`); alongside them a
 * single {@link SPACE_BUNDLE_FILE} carries the full structured bundle so an
 * import is lossless (parent/position/properties and databases survive, which
 * the flat HTML files alone don't capture).
 */

/** A relative file within the chosen folder (POSIX `/` separators). */
export interface BookFolderFile {
  path: string;
  contents: string;
}

/** Everything in a space, as returned by `DataClient.exportLibrary`. */
export interface LibrarySnapshot {
  pages: StoredPage[];
  databases: StoredDatabase[];
}

/**
 * Lossless structured sidecar filename that NEW exports write, parsed back by
 * {@link parseBookFolder}. Renamed from the legacy `openbook.space.json`
 * (LIB-4): the writer emits only this, while the reader also accepts
 * {@link LEGACY_SPACE_BUNDLE_FILE} so folders exported before the rename still
 * re-import losslessly.
 */
export const SPACE_BUNDLE_FILE = 'openbook.library.json';

/**
 * The pre-LIB-4 sidecar filename. READ-ONLY back-compat: {@link parseBookFolder}
 * falls back to it so already-exported book folders keep importing. The writer
 * never emits it.
 */
export const LEGACY_SPACE_BUNDLE_FILE = 'openbook.space.json';

/**
 * The whole-space **source-island** payload embedded in a standalone *site* HTML
 * export: the full {@link LibrarySnapshot} (pages + databases + nesting via each
 * page's `parentId`/`databaseId`) plus the root id shown first. Same structure as
 * {@link SPACE_BUNDLE_FILE}, so a site export re-imports with structure intact.
 */
export interface LibraryIsland {
  version: 1;
  rootId: string;
  space: LibrarySnapshot;
  /** LX-2: the embedded ledger records, when the export opted in (see
   *  {@link LedgerExportSection} for the shape + authorization contract). */
  ledger?: LedgerExportSection;
}

/**
 * The serialized island wire shape. NEW exports carry the bundle under the
 * `library` key (LIB-4); `space` is the legacy key {@link readLibraryIsland}
 * still reads so already-published `.book.html` / site bundles round-trip.
 */
interface LibraryIslandWire {
  version?: number;
  rootId?: string;
  /** Current key (LIB-4+). */
  library?: Partial<LibrarySnapshot>;
  /** @deprecated legacy key (pre-LIB-4). Read-only fallback — never written. */
  space?: Partial<LibrarySnapshot>;
  /** LX-2: ledger records (additive — absent on older exports and whenever the
   *  exporter opted out or could not read the books). */
  ledger?: LedgerExportSection;
}

/** Wrap a whole-space bundle as its source-island `<script>` (versioned, escaped).
 *  `opts.ledger` additionally embeds the LX-2 ledger records — pass it ONLY with
 *  a section captured through the exporting principal's own read paths
 *  ({@link gatherLedgerExportSection}). */
export function libraryIslandScript(
  rootId: string,
  space: LibrarySnapshot,
  opts: {attrs?: string; indent?: string; ledger?: LedgerExportSection} = {},
): string {
  // Writer emits ONLY the new `library` key; the reader dual-reads for back-compat.
  return islandScript({version: 1, rootId, library: space, ...(opts.ledger ? {ledger: opts.ledger} : {})}, opts);
}

/** Keys that must never survive a parse of untrusted island JSON: an own
 *  `__proto__`/`constructor`/`prototype` data property (JSON.parse creates them
 *  as plain own properties) becomes a prototype-pollution gadget the moment a
 *  consumer deep-merges or `Object.assign`s the settings into a live object. */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Deep-copy a JSON value, dropping every {@link UNSAFE_KEYS} property. */
function stripUnsafeKeys<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => stripUnsafeKeys(v)) as unknown as T;
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      if (UNSAFE_KEYS.has(key)) continue;
      out[key] = stripUnsafeKeys((value as Record<string, unknown>)[key]);
    }
    return out as T;
  }
  return value;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Deep-validate the LX-2 `ledger` island key (the parse boundary LX-4's import
 * inherits — island text is UNTRUSTED input): `settings` a plain object (with
 * `__proto__`/`constructor`/`prototype` keys stripped, recursively), `library`
 * a real {@link LibrarySnapshot} (pages[] of records with a string `id`,
 * databases[] of records with string `id` + `pageId`), and `auditHead` either
 * `null` or `{seq: number, hash: string}`. Any mismatch drops the whole key
 * (returns `null`) — never a throw, and never a section import code can't trust.
 */
function readLedgerSection(raw: unknown): LedgerExportSection | null {
  if (!isPlainObject(raw)) return null;
  const {settings, library, auditHead} = raw as Partial<LedgerExportSection>;
  if (!isPlainObject(settings)) return null;
  if (!isPlainObject(library) || !Array.isArray(library.pages) || !Array.isArray(library.databases)) return null;
  if (!library.pages.every((p: unknown) => isPlainObject(p) && typeof p.id === 'string')) return null;
  if (!library.databases.every((d: unknown) => isPlainObject(d) && typeof d.id === 'string' && typeof d.pageId === 'string')) return null;
  let head: LedgerExportSection['auditHead'] = null;
  if (auditHead !== null && auditHead !== undefined) {
    if (!isPlainObject(auditHead) || typeof auditHead.seq !== 'number' || !Number.isFinite(auditHead.seq) || typeof auditHead.hash !== 'string') return null;
    head = {seq: auditHead.seq, hash: auditHead.hash};
  }
  return {
    settings: stripUnsafeKeys(settings),
    library: {pages: library.pages, databases: library.databases},
    auditHead: head,
  };
}

/**
 * Read a site export's space island back, or `null` when absent/corrupt.
 * Dual-read: prefer the new `library` key, fall back to the legacy `space` key
 * so bundles published before LIB-4 still import.
 */
export function readLibraryIsland(html: string): LibraryIsland | null {
  const parsed = readIsland<LibraryIslandWire>(html);
  const bundle = parsed?.library ?? parsed?.space;
  if (!bundle || !Array.isArray(bundle.pages)) return null;
  // Deep-validate the LX-2 ledger key (island text is untrusted input): carry
  // it only when it IS a real section, so import code can trust the type — a
  // malformed/hostile key is dropped, never thrown on (see readLedgerSection).
  const ledger = readLedgerSection(parsed?.ledger);
  return {
    version: 1,
    rootId: parsed?.rootId ?? '',
    space: {
      pages: bundle.pages,
      databases: Array.isArray(bundle.databases) ? bundle.databases : [],
    },
    ...(ledger ? {ledger} : {}),
  };
}

const MAX_DEPTH = 64;

const pageIcon = (page: StoredPage): string | null => {
  const icon = (page.properties as Record<string, unknown> | undefined)?.sys_icon;
  return typeof icon === 'string' ? icon : null;
};

const folderName = (root: StoredPage): string => `${slugify(root.name ?? 'untitled')}--${root.id.slice(0, 8)}`;
const fileName = (page: StoredPage): string => `${slugify(page.name ?? 'untitled')}--${page.id.slice(0, 8)}.html`;

/** Topmost ancestor: walk `parentId`, or a row's database-host page, to the root. */
function rootOf(
  page: StoredPage,
  byId: Map<string, StoredPage>,
  dbHost: Map<string, string>,
): StoredPage {
  let root = page;
  for (let depth = 0; depth < MAX_DEPTH; depth += 1) {
    let parentId: string | null = null;
    if (root.parentId) parentId = root.parentId;
    else if (root.databaseId) parentId = dbHost.get(root.databaseId) ?? null;
    const parent = parentId ? byId.get(parentId) : null;
    if (!parent) break;
    root = parent;
  }
  return root;
}

/** Options for {@link libraryToBookFiles}. */
export interface LibraryToBookFilesOptions {
  /** Include the lossless {@link SPACE_BUNDLE_FILE} sidecar. Default true. */
  includeBundle?: boolean;
  /**
   * The viewer runtime bundle's JS source (the compiled `OpenBookViewer` IIFE).
   * When provided, ONE copy is emitted at {@link BOOK_RUNTIME_FILE}
   * (`_openbook/viewer.js`) and every page file references it relatively, so a
   * `.book.html` opened straight from `file://` hydrates into the interactive
   * locked viewer with zero network — and the folder stays portable
   * (moved/zipped whole). Omit it (bundle unavailable) and the writer emits NO
   * reference: the files are the plain static articles, exactly as before.
   */
  runtime?: string;
}

/**
 * Serialise a space to its on-disk files. By default includes the lossless
 * {@link SPACE_BUNDLE_FILE}; pass `includeBundle: false` for the human-readable
 * HTML files only. Pass `runtime` (the viewer bundle source) to make the folder
 * self-hydrating — see {@link LibraryToBookFilesOptions.runtime}.
 */
export function libraryToBookFiles(snapshot: LibrarySnapshot, opts: LibraryToBookFilesOptions = {}): BookFolderFile[] {
  const {pages, databases} = snapshot;
  const byId = new Map(pages.map((p) => [p.id, p]));
  const dbHost = new Map(databases.map((d) => [d.id, d.pageId]));
  const runtimeRef = typeof opts.runtime === 'string' && opts.runtime.length > 0;

  const files: BookFolderFile[] = [];
  for (const page of pages) {
    const root = rootOf(page, byId, dbHost);
    const html = pageToBookHtml(
      {
        id: page.id,
        name: page.name,
        icon: pageIcon(page),
        updatedAt: page.updatedAt,
        data: page.data,
      },
      {runtimeRef},
    );
    files.push({path: `${folderName(root)}/${fileName(page)}`, contents: html});
  }

  if (runtimeRef) files.push({path: BOOK_RUNTIME_FILE, contents: opts.runtime!});
  if (opts.includeBundle !== false) {
    files.push({path: SPACE_BUNDLE_FILE, contents: JSON.stringify(snapshot, null, 2)});
  }
  return files;
}

/** Match a sidecar file by basename — the new name first, then the legacy one. */
const isSpaceBundleFile = (path: string): boolean =>
  path === SPACE_BUNDLE_FILE ||
  path.endsWith(`/${SPACE_BUNDLE_FILE}`) ||
  path === LEGACY_SPACE_BUNDLE_FILE ||
  path.endsWith(`/${LEGACY_SPACE_BUNDLE_FILE}`);

/**
 * Reconstruct a space from a folder's files. Prefers the lossless structured
 * sidecar ({@link SPACE_BUNDLE_FILE}, or the legacy {@link LEGACY_SPACE_BUNDLE_FILE}
 * for folders exported before LIB-4) when present; otherwise falls back to
 * parsing the `.html` files into a flat list of pages (no databases, no nesting
 * — the most a human-readable folder can recover). Returns `null` if nothing
 * parseable was found, so the caller can surface "not an OpenBook folder".
 */
export function parseBookFolder(files: BookFolderFile[]): LibrarySnapshot | null {
  const bundle = files.find((f) => isSpaceBundleFile(f.path));
  if (bundle) {
    try {
      const parsed = JSON.parse(bundle.contents) as Partial<LibrarySnapshot>;
      if (Array.isArray(parsed.pages)) {
        return {pages: parsed.pages, databases: Array.isArray(parsed.databases) ? parsed.databases : []};
      }
    } catch {
      // Corrupt bundle — fall through to the HTML files.
    }
  }

  const pages: StoredPage[] = [];
  for (const file of files) {
    if (!file.path.endsWith('.html')) continue;
    const record = bookHtmlToPage(file.contents);
    if (record) pages.push(recordToPage(record));
  }
  return pages.length ? {pages, databases: []} : null;
}

/** Inflate a parsed `.book.html` record into a minimal StoredPage for import. */
function recordToPage(record: {id: string; name: string | null; icon: string | null; updatedAt: string; data: PageSnapshot}): StoredPage {
  return {
    id: record.id,
    name: record.name,
    data: record.data,
    hostedDatabaseId: null,
    databaseId: null,
    parentId: null,
    properties: record.icon ? {sys_icon: record.icon} : {},
    deletedAt: null,
    createdAt: record.updatedAt,
    updatedAt: record.updatedAt,
  };
}
