import type {StoredPage, PageSnapshot} from './types';
import type {StoredDatabase} from './database';
import {pageToBookHtml, bookHtmlToPage, slugify, BOOK_RUNTIME_FILE} from './bookfile';
import {islandScript, readIsland} from './island';

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

/** Lossless structured sidecar, parsed back by {@link parseBookFolder}. */
export const SPACE_BUNDLE_FILE = 'openbook.space.json';

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
}

/** Wrap a whole-space bundle as its source-island `<script>` (versioned, escaped). */
export function libraryIslandScript(
  rootId: string,
  space: LibrarySnapshot,
  opts: {attrs?: string; indent?: string} = {},
): string {
  return islandScript({version: 1, rootId, space}, opts);
}

/** Read a site export's space island back, or `null` when absent/corrupt. */
export function readLibraryIsland(html: string): LibraryIsland | null {
  const parsed = readIsland<Partial<LibraryIsland>>(html);
  if (!parsed || !parsed.space || !Array.isArray(parsed.space.pages)) return null;
  return {
    version: 1,
    rootId: parsed.rootId ?? '',
    space: {
      pages: parsed.space.pages,
      databases: Array.isArray(parsed.space.databases) ? parsed.space.databases : [],
    },
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

/**
 * Reconstruct a space from a folder's files. Prefers the lossless
 * {@link SPACE_BUNDLE_FILE} when present; otherwise falls back to parsing the
 * `.html` files into a flat list of pages (no databases, no nesting — the most
 * a human-readable folder can recover). Returns `null` if nothing parseable was
 * found, so the caller can surface "not an OpenBook folder".
 */
export function parseBookFolder(files: BookFolderFile[]): LibrarySnapshot | null {
  const bundle = files.find((f) => f.path === SPACE_BUNDLE_FILE || f.path.endsWith(`/${SPACE_BUNDLE_FILE}`));
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
