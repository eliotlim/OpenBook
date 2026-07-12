/**
 * Gather a page and everything reachable from it into a self-contained bundle for
 * the interactive HTML export: the page, its nested subpages, the databases it
 * hosts (with their rows — which are themselves pages), and every page those link
 * to. A breadth-first crawl from the root, deduped by id and capped, so a single
 * exported file carries a whole navigable mini-site.
 */
import {
  ICON_PROPERTY_ID,
  type DataClient,
  type DatabaseRow,
  type DatabaseSchema,
  type PageSnapshot,
  type LibrarySnapshot,
  type StoredDatabase,
  type StoredPage,
} from '@book.dev/sdk';
import {projectSnapshotForExport} from '../blockeditor/exportBlocks';
import {DEFAULT_PAGE_ICON, readPageIcon} from '@/lib/pageIcon';

/** A database hosted by a page, projected for static rendering. */
export interface SiteDatabase {
  schema: DatabaseSchema;
  rows: DatabaseRow[];
}

/** One page in the exported bundle. */
export interface SitePage {
  id: string;
  title: string;
  icon: string;
  snapshot: PageSnapshot;
  /** Present when this page hosts a database (its rows are also pages in the bundle). */
  database?: SiteDatabase;
}

/** The exported mini-site: the root page plus every page reachable from it. */
export interface SiteBundle {
  rootId: string;
  pages: SitePage[];
  /**
   * The LOSSLESS source bundle — the raw {@link StoredPage}/{@link StoredDatabase}
   * records gathered during the crawl, in the `openbook.space.json` shape. This
   * is what the site export embeds as its source island (nesting + properties +
   * databases survive, which the flattened {@link SitePage}s don't carry). The
   * root uses the live in-memory snapshot so unsaved edits export faithfully.
   */
  space: LibrarySnapshot;
}

/** A safety cap so a densely linked workspace can't produce a runaway file. */
const MAX_PAGES = 400;

/** Page ids a snapshot references: subpage/database blocks and inline `@`-mentions. */
export function referencedPageIds(rawSnapshot: PageSnapshot): string[] {
  const snapshot = projectSnapshotForExport(rawSnapshot);
  const ids = new Set<string>();
  const blocks = (snapshot.editorjs as {blocks?: Array<{type?: string; data?: Record<string, unknown>}>} | undefined)?.blocks ?? [];
  const fromStrings = (v: unknown): void => {
    if (typeof v === 'string') {
      for (const m of v.matchAll(/data-page-id="([^"]+)"/g)) ids.add(m[1]);
    } else if (Array.isArray(v)) {
      v.forEach(fromStrings);
    } else if (v && typeof v === 'object') {
      Object.values(v).forEach(fromStrings);
    }
  };
  for (const block of blocks) {
    const d = block.data ?? {};
    if ((block.type === 'subpage' || block.type === 'database') && typeof d.pageId === 'string') ids.add(d.pageId);
    fromStrings(d);
  }
  return [...ids];
}

/**
 * Crawl from `rootId` and return every reachable page. The root's live content is
 * supplied via `root` (so unsaved edits export faithfully); every other page is
 * fetched from the store. Hosted databases contribute their schema, rows, and the
 * row pages themselves.
 */
export async function gatherSite(
  client: DataClient,
  rootId: string,
  root: {snapshot: PageSnapshot; title: string; icon: string},
): Promise<SiteBundle> {
  const pages = new Map<string, SitePage>();
  // Raw stored records, in crawl order, for the lossless source island. Keyed so
  // a page/database is carried once even when reached by several links.
  const spacePages = new Map<string, StoredPage>();
  const spaceDatabases = new Map<string, StoredDatabase>();
  const queue: string[] = [rootId];

  while (queue.length > 0 && pages.size < MAX_PAGES) {
    const id = queue.shift()!;
    if (pages.has(id)) continue;

    const stored = await client.getPage(id).catch(() => null);
    // The root may be brand-new/unsaved; fall back to its live snapshot.
    const isRoot = id === rootId;
    if (!stored && !isRoot) continue;

    const snapshot = projectSnapshotForExport(isRoot ? root.snapshot : stored!.data);
    const title = (isRoot ? root.title : stored!.name ?? '').trim() || 'Untitled';
    // Prefer the icon stored on the page record (it travels in properties now);
    // fall back to the in-memory cache / default for the unsaved root.
    const storedIcon = (stored?.properties[ICON_PROPERTY_ID] as string | undefined) || '';
    const page: SitePage = {id, title, icon: isRoot ? root.icon : storedIcon || readPageIcon(id) || DEFAULT_PAGE_ICON, snapshot};
    pages.set(id, page);

    // The island carries the raw record. For the root, override `data` with the
    // LIVE in-memory snapshot so unsaved edits export losslessly (the persisted
    // copy may be stale); synthesize a record if the root was never saved.
    if (isRoot) {
      spacePages.set(id, storedRoot(id, stored, root));
    } else {
      spacePages.set(id, stored!);
    }

    for (const ref of referencedPageIds(snapshot)) if (!pages.has(ref)) queue.push(ref);

    const databaseId = stored?.hostedDatabaseId ?? null;
    if (databaseId) {
      const [db, rows] = await Promise.all([
        client.getDatabase(databaseId).catch(() => null),
        client.listRows(databaseId).catch(() => [] as DatabaseRow[]),
      ]);
      if (db) {
        page.database = {schema: db.schema, rows};
        spaceDatabases.set(db.id, db);
        for (const r of rows) if (!pages.has(r.id)) queue.push(r.id);
      }
    }
  }

  // Root first, so it is the page shown when the file opens.
  const ordered = [pages.get(rootId)!, ...[...pages.values()].filter((p) => p.id !== rootId)].filter(Boolean);
  const space: LibrarySnapshot = {pages: [...spacePages.values()], databases: [...spaceDatabases.values()]};
  return {rootId, pages: ordered, space};
}

/** The root's raw record for the island: the persisted page with its `data`
 *  replaced by the live snapshot, or a minimal synthesized record when the root
 *  was never saved. Keeps the island faithful to what was actually exported. */
function storedRoot(
  id: string,
  stored: StoredPage | null,
  root: {snapshot: PageSnapshot; title: string; icon: string},
): StoredPage {
  if (stored) return {...stored, data: root.snapshot};
  return {
    id,
    name: root.title,
    data: root.snapshot,
    hostedDatabaseId: null,
    databaseId: null,
    parentId: null,
    properties: root.icon ? {[ICON_PROPERTY_ID]: root.icon} : {},
    deletedAt: null,
    createdAt: '',
    updatedAt: '',
  };
}
