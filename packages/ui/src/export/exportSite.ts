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
  type LedgerExportSection,
  type PageSnapshot,
  type LibrarySnapshot,
  type StoredDatabase,
  type StoredPage,
} from '@book.dev/sdk';
import {projectSnapshotForExport} from '../blockeditor/exportBlocks';
import {resolveDbChartSeries, snapshotBlocks} from '../blockeditor/kit/chartData';
import {DEFAULT_PAGE_ICON, readPageIcon} from '@/lib/pageIcon';
import {formOriginUrl} from '@/blockeditor/formBlock';

// Future-surface fence: OG metadata, sitemaps, and RSS do not exist today; each MUST consult `listed` when built.

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
  /** Canonical app/web URL used by frozen forms in the standalone site. */
  originUrl?: string;
  /** Present when this page hosts a database (its rows are also pages in the bundle). */
  database?: SiteDatabase;
}

/** The exported mini-site: the root page plus every page reachable from it. */
export interface SiteBundle {
  rootId: string;
  pages: SitePage[];
  /** Number of unique unlisted pages omitted by the crawl. */
  hiddenPagesSkipped?: number;
  /**
   * The LOSSLESS source bundle — the raw {@link StoredPage}/{@link StoredDatabase}
   * records gathered during the crawl, in the `openbook.library.json` shape. This
   * is what the site export embeds as its source island (nesting + properties +
   * databases survive, which the flattened {@link SitePage}s don't carry). The
   * root uses the live in-memory snapshot so unsaved edits export faithfully.
   * Unlisted records and references are removed before this snapshot is emitted.
   */
  space: LibrarySnapshot;
  /**
   * LX-2: the machine-readable ledger records, present ONLY when the exporter
   * opted in AND could read the books through their own {@link DataClient}
   * (see the SDK's `gatherLedgerExportSection` — capture is fail-closed, so a
   * guest/viewer export never carries records they couldn't read via the API).
   * Rides the island under its own `ledger` key, never mixed into `space`.
   */
  ledger?: LedgerExportSection;
  /**
   * True when the crawl REACHED seeded ledger content (the restricted host
   * page, a managed database's host page, or a row page) via a subpage/database
   * block or an `@`-mention. That content is ALWAYS pruned from the generic
   * bundle (see {@link gatherSite}); this flag tells the export flow that
   * ledger records are implicated so it can run the SAME consent dialog it
   * shows for in-page ledger blocks — a crawled reference must never ship
   * records without the dialog, the toggle, and the fail-closed capture.
   */
  ledgerReached?: boolean;
}

/** A safety cap so a densely linked library can't produce a runaway file. */
const MAX_PAGES = 400;

const OMIT_REFERENCE = Symbol('omit-page-reference');

/** Remove links to skipped pages from both legacy export HTML and native block JSON. */
function scrubSkippedReferences(snapshot: PageSnapshot, skippedIds: ReadonlySet<string>): PageSnapshot {
  if (skippedIds.size === 0) return snapshot;

  const scrubString = (value: string): string => {
    let clean = value;
    for (const id of skippedIds) {
      const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      clean = clean.replace(new RegExp(`<a\\b[^>]*\\bdata-page-id=(["'])${escaped}\\1[^>]*>[\\s\\S]*?<\\/a>`, 'g'), '');
      clean = clean.split(id).join('');
    }
    return clean;
  };

  const scrub = (value: unknown): unknown | typeof OMIT_REFERENCE => {
    if (typeof value === 'string') return scrubString(value);
    if (Array.isArray(value)) {
      const clean: unknown[] = [];
      for (const child of value) {
        const next = scrub(child);
        if (next !== OMIT_REFERENCE) clean.push(next);
      }
      return clean;
    }
    if (!value || typeof value !== 'object') return value;

    const record = value as Record<string, unknown>;
    // Native mentions carry their label and page id in one atomic text run.
    const attrs = record.a as Record<string, unknown> | undefined;
    if (typeof record.t === 'string' && typeof attrs?.m === 'string' && skippedIds.has(attrs.m)) {
      return OMIT_REFERENCE;
    }
    // Legacy subpage/database blocks and native dbview blocks carry pageId in
    // data/props. Drop the whole block so neither its id nor its title survives.
    const data = record.data as Record<string, unknown> | undefined;
    const props = record.props as Record<string, unknown> | undefined;
    if (
      (typeof record.pageId === 'string' && skippedIds.has(record.pageId)) ||
      (typeof data?.pageId === 'string' && skippedIds.has(data.pageId)) ||
      (typeof props?.pageId === 'string' && skippedIds.has(props.pageId))
    ) {
      return OMIT_REFERENCE;
    }

    const clean: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(record)) {
      const next = scrub(child);
      if (next !== OMIT_REFERENCE) clean[key] = next;
    }
    return clean;
  };

  const clean = scrub(snapshot) as PageSnapshot;
  const blockdoc = clean.blockdoc as {update?: string; blocks?: unknown[]} | undefined;
  // The CRDT update is lossless but can still encode a removed mention. Force
  // import/viewer consumers through the scrubbed JSON projection instead.
  if (blockdoc) clean.blockdoc = {...blockdoc, update: ''} as PageSnapshot['blockdoc'];
  return clean;
}

/** The type prefix of every block the first-party ledger plugin registers. */
const LEDGER_BLOCK_PREFIX = 'openbook.ledger/';

/**
 * Whether a RAW snapshot contains any `openbook.ledger/*` block. Detection runs
 * on the raw block-doc (recursively — ledger blocks can sit inside columns/
 * toggles), NOT on the export projection, which flattens plugin blocks into
 * placeholder markup (LX-1) where the type only survives as an attribute.
 */
export function snapshotHasLedgerBlocks(snapshot: PageSnapshot | null | undefined): boolean {
  const doc = snapshot as {editor?: string; blockdoc?: {blocks?: unknown[]}} | null | undefined;
  if (!doc || doc.editor !== 'blocks' || !doc.blockdoc) return false;
  const hasLedger = (blocks: unknown[]): boolean =>
    blocks.some((b) => {
      const block = b as {type?: unknown; children?: unknown[]} | null;
      if (!block || typeof block !== 'object') return false;
      if (typeof block.type === 'string' && block.type.startsWith(LEDGER_BLOCK_PREFIX)) return true;
      return Array.isArray(block.children) && hasLedger(block.children);
    });
  return hasLedger(doc.blockdoc.blocks ?? []);
}

/** Whether any page in the (raw) export set contains a ledger block. */
export function bundleHasLedgerBlocks(space: LibrarySnapshot): boolean {
  return space.pages.some((p) => snapshotHasLedgerBlocks(p.data));
}

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
 * The seeded ledger's identity — the restricted root host page id plus the four
 * managed database ids — resolved through the exporting principal's OWN client
 * (the same `ledgerInfo` read LX-2's `gatherLedgerExportSection` starts from).
 * `null` when no ledger exists, or when the server hides it from this caller
 * (the existence-hiding body), or on transport failure. Identification is thus
 * exactly as good as the caller's own read authority — a principal the ledger
 * hides from can only ever crawl what their generic reads already serve, so no
 * escalation rides on a `null` here.
 */
async function resolveLedgerIds(client: DataClient): Promise<{hostPageId: string; databaseIds: Set<string>} | null> {
  try {
    const info = await client.ledgerInfo();
    if (!info.exists || !info.hostPageId || !info.databases) return null;
    return {hostPageId: info.hostPageId, databaseIds: new Set(Object.values(info.databases))};
  } catch {
    return null;
  }
}

/**
 * Crawl from `rootId` and return every reachable page. The root's live content is
 * supplied via `root` (so unsaved edits export faithfully); every other page is
 * fetched from the store. Hosted databases contribute their schema, rows, and the
 * row pages themselves.
 *
 * ## Ledger content is ALWAYS pruned from the crawl (LX-2 consent, Sasha #2)
 * A subpage/database block or `@`-mention can reach the ledger's host pages,
 * whose managed databases would otherwise pull the full books (schema + rows)
 * into the VISIBLE bundle and the source island — outside the consent dialog,
 * the toggle, and the fail-closed capture. So the crawl identifies ledger
 * content by the seeded ids ({@link resolveLedgerIds}) and drops it
 * unconditionally: the consent-gated {@link SiteBundle.ledger} section is the
 * ONE sanctioned carrier of ledger records (which also rules out double
 * embedding when the exporter opts in). Reaching ledger content sets
 * {@link SiteBundle.ledgerReached} so the export flow still asks for consent.
 * Edge case: when the ROOT itself is a ledger page (exporting a host page
 * directly) the page the user is looking at stays, but its managed database
 * (schema + rows) and every other ledger page are still pruned.
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
  const visited = new Set<string>();
  const hiddenIds = new Set<string>();

  const ledger = await resolveLedgerIds(client);
  /** Whether this crawled record is ledger content: the restricted root host
   *  page (by id, so even an unreadable reference is recognised), a managed
   *  database's host page, or one of its row pages. */
  const isLedgerPage = (id: string, stored: StoredPage | null): boolean =>
    ledger != null &&
    (id === ledger.hostPageId ||
      (stored?.hostedDatabaseId != null && ledger.databaseIds.has(stored.hostedDatabaseId)) ||
      (stored?.databaseId != null && ledger.databaseIds.has(stored.databaseId)));
  let ledgerReached = false;

  while (queue.length > 0 && pages.size < MAX_PAGES) {
    const id = queue.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);

    const stored = await client.getPage(id).catch(() => null);
    // Current stores carry `listed` on the page record, avoiding a second RPC
    // for every crawled page. Older/test clients may omit it, so retain the
    // settings-endpoint fallback. Only an explicit false is hidden.
    const storedListed = (stored as (StoredPage & {listed?: boolean}) | null)?.listed;
    const listed =
      storedListed ??
      (await Promise.resolve()
        .then(() => client.getPageVisibility(id))
        .catch(() => null))?.listed;
    // The root may be brand-new/unsaved; fall back to its live snapshot.
    const isRoot = id === rootId;
    // `listed` controls discovery/export reachability, not direct access. The
    // manager explicitly selected the root, so keep it; every reached unlisted
    // page is hard-skipped without prompting.
    if (!isRoot && listed === false) {
      hiddenIds.add(id);
      continue;
    }
    // Ledger content never rides the generic crawl (see the doc comment): flag
    // it (so the export flow asks for consent) and prune it. The root itself is
    // kept — the user is exporting the page in front of them — but its managed
    // database is still pruned below.
    if (isLedgerPage(id, stored)) {
      ledgerReached = true;
      if (!isRoot) continue;
    }
    if (!stored && !isRoot) continue;

    // Resolve any database-bound kit charts on this page to their series live,
    // via the same client, and thread them into the projection — the doc holds no
    // persisted snapshot (viewing never writes; export resolves fresh).
    const rawSnapshot = isRoot ? root.snapshot : stored!.data;
    const dbSeries = await resolveDbChartSeries(client, snapshotBlocks(rawSnapshot));
    const originUrl = formOriginUrl(id);
    const snapshot = projectSnapshotForExport(rawSnapshot, dbSeries, undefined, {originPageUrl: originUrl});
    const title = (isRoot ? root.title : stored!.name ?? '').trim() || 'Untitled';
    // Prefer the icon stored on the page record (it travels in properties now);
    // fall back to the in-memory cache / default for the unsaved root.
    const storedIcon = (stored?.properties[ICON_PROPERTY_ID] as string | undefined) || '';
    const page: SitePage = {
      id,
      title,
      icon: isRoot ? root.icon : storedIcon || readPageIcon(id) || DEFAULT_PAGE_ICON,
      snapshot,
      ...(originUrl ? {originUrl} : {}),
    };
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

    let databaseId = stored?.hostedDatabaseId ?? null;
    // A managed ledger database NEVER rides the generic crawl (schema + rows =
    // the whole book) — only the consent-gated section may carry it. Reachable
    // only via the kept root: every non-root ledger page was pruned above.
    if (databaseId && ledger?.databaseIds.has(databaseId)) {
      ledgerReached = true;
      databaseId = null;
    }
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

  // The content cap can leave referenced pages and database rows queued. They
  // still need visibility classification so unlisted ids/titles are scrubbed
  // from already-gathered snapshots and row metadata without fetching content.
  for (const id of queue) {
    if (visited.has(id)) continue;
    visited.add(id);
    const visibility = await client.getPageVisibility(id).catch(() => null);
    if (visibility?.listed === false) hiddenIds.add(id);
  }

  if (hiddenIds.size > 0) {
    for (const page of pages.values()) {
      page.snapshot = scrubSkippedReferences(page.snapshot, hiddenIds);
      if (page.database) {
        page.database.rows = page.database.rows
          .filter((row) => !hiddenIds.has(row.id))
          .map((row) => ({
            ...row,
            parentId: row.parentId && hiddenIds.has(row.parentId) ? null : row.parentId,
          }));
      }
    }
    for (const [id, page] of spacePages) {
      spacePages.set(id, {
        ...page,
        data: scrubSkippedReferences(page.data, hiddenIds),
        parentId: page.parentId && hiddenIds.has(page.parentId) ? null : page.parentId,
      });
    }
  }

  // Root first, so it is the page shown when the file opens.
  const ordered = [pages.get(rootId)!, ...[...pages.values()].filter((p) => p.id !== rootId)].filter(Boolean);
  const space: LibrarySnapshot = {pages: [...spacePages.values()], databases: [...spaceDatabases.values()]};
  return {
    rootId,
    pages: ordered,
    space,
    ...(hiddenIds.size > 0 ? {hiddenPagesSkipped: hiddenIds.size} : {}),
    ...(ledgerReached ? {ledgerReached: true} : {}),
  };
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
