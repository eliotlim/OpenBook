/**
 * Pure helpers for the restore flow: validate a backup file, list the top-level
 * pages to offer as restore targets, and expand a selection of those into the
 * full set of pages + databases to send to the server (so a selected page always
 * brings its subtree, its hosted database, and that database's rows).
 */
import {BACKUP_VERSION, type SpaceBackup, type StoredDatabase, type StoredPage} from '@book.dev/sdk';

export function parseBackup(text: string): SpaceBackup {
  const parsed = JSON.parse(text) as Partial<SpaceBackup>;
  if (!parsed || !Array.isArray(parsed.pages) || !Array.isArray(parsed.databases)) {
    throw new Error('Not an OpenBook backup file.');
  }
  if (typeof parsed.version !== 'number' || parsed.version > BACKUP_VERSION) {
    throw new Error('This backup was made by a newer version of OpenBook.');
  }
  return {
    version: parsed.version,
    exportedAt: parsed.exportedAt ?? '',
    pages: parsed.pages,
    databases: parsed.databases,
    icons: parsed.icons ?? {},
  };
}

/**
 * The pages to show in the restore checklist: top-level documents — not database
 * rows, and not nested under another page that's also in the bundle.
 */
export function bundleRoots(bundle: SpaceBackup): StoredPage[] {
  const ids = new Set(bundle.pages.map((p) => p.id));
  return bundle.pages.filter((p) => !p.databaseId && (!p.parentId || !ids.has(p.parentId)));
}

/**
 * Expand selected root ids into the closure to import: each selected page plus
 * its descendants, the databases those pages host, and those databases' rows.
 */
export function closure(bundle: SpaceBackup, rootIds: Iterable<string>): {pages: StoredPage[]; databases: StoredDatabase[]} {
  const byId = new Map(bundle.pages.map((p) => [p.id, p]));
  const childrenByParent = new Map<string, StoredPage[]>();
  const rowsByDb = new Map<string, StoredPage[]>();
  for (const p of bundle.pages) {
    if (p.parentId) (childrenByParent.get(p.parentId) ?? childrenByParent.set(p.parentId, []).get(p.parentId)!).push(p);
    if (p.databaseId) (rowsByDb.get(p.databaseId) ?? rowsByDb.set(p.databaseId, []).get(p.databaseId)!).push(p);
  }
  const dbByHost = new Map(bundle.databases.map((d) => [d.pageId, d]));

  const pages = new Set<string>();
  const dbs = new Set<string>();
  const queue = [...rootIds];
  while (queue.length) {
    const id = queue.pop()!;
    if (pages.has(id) || !byId.has(id)) continue;
    pages.add(id);
    for (const child of childrenByParent.get(id) ?? []) queue.push(child.id);
    const db = dbByHost.get(id);
    if (db) {
      dbs.add(db.id);
      for (const row of rowsByDb.get(db.id) ?? []) queue.push(row.id);
    }
  }
  return {
    pages: bundle.pages.filter((p) => pages.has(p.id)),
    databases: bundle.databases.filter((d) => dbs.has(d.id)),
  };
}

/** How many of the closure's pages already exist in the current space (by id). */
export function overwriteCount(pages: StoredPage[], existingIds: Set<string>): number {
  return pages.filter((p) => existingIds.has(p.id)).length;
}
