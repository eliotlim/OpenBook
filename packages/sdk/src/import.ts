/**
 * The **format-agnostic import core** — the spine every importer (Markdown,
 * HTML, Notion, …) targets. A parser's only job is to turn its source format
 * into an {@link ImportedDoc}; this module then writes that IR into the
 * workspace through the *existing* data paths, so importers never touch the
 * store, the CRDT, or the wire protocol directly.
 *
 * Two writers, picked by the document's size/shape (see {@link chooseStrategy}):
 *
 *  - **Strategy A — {@link writeViaCreateApis}** drives `savePage` /
 *    `createDatabase` / `createRow` directly, exactly like the template gallery
 *    (see `templates.ts`). Best for a single page / small tree: it streams
 *    creates and resolves parent links as it goes, with no whole-bundle staging.
 *
 *  - **Strategy B — {@link writeViaBundle}** maps the whole IR into a backup
 *    bundle (`{pages, databases}` native records) and hands it to
 *    `importLibrary(…, mode:'copy')`. That inherits — for free — the server's
 *    id-remap, `@`-mention link-rewrite, name de-dup, and idempotent-replay
 *    machinery (`remapBundle` / `importBundle`), plus the Restore dialog on the
 *    UI side. Best for a multi-page / database tree.
 *
 * **Assets (v1 decision).** A real asset store is a separate epic; until then an
 * image becomes a *placeholder* that preserves the original `ref` + `alt` rather
 * than being silently dropped — {@link imagePlaceholderBlock} for body content,
 * {@link imagePlaceholderCell} for a database cell. The "never silently drop
 * content" guarantee that the inbound HTML/EditorJS converters follow (see
 * `ui/blockeditor/model.ts`) holds end-to-end through import.
 *
 * **Why the SDK.** The writers speak `DataClient` and the backup bundle, both
 * SDK-owned; the block payload is the editor's plain JSON projection, which the
 * SDK already handles structurally (`content.ts`, `mtime.ts`). {@link
 * ImportedBlock} is the structural mirror of `@book.dev/ui`'s `BlockJSON`: a
 * parser's real `BlockJSON` (built with the UI's `htmlToBlocks` / `htmlToRuns`
 * helpers) is assignable straight into this IR — without the SDK taking a UI
 * dependency. The assignment is one-way *by design*: `ImportedBlock.id` is
 * OPTIONAL (import omits ids; the editor mints them on load via its
 * `jsonToNewBlock`), so the reverse — treating an `ImportedBlock` as a
 * `BlockJSON` — intentionally does not hold.
 */

import type {DataClient} from './client';
import type {ImportRequest, ImportResult} from './backup';
import type {DatabaseSchema, StoredDatabase} from './database';
import {emptyPageSnapshot, type PageSnapshot, type StoredPage} from './types';
import {ICON_PROPERTY_ID} from './pageProperties';
import {contentHash} from './mtime';

// ── The import IR (intermediate representation) ──────────────────────────────

/** Inline formatting on a run — the structural mirror of `@book.dev/ui`'s
 *  `InlineAttrs` (bold/italic/underline/strike/code, link href, mention, colours). */
export interface ImportInlineAttrs {
  b?: boolean;
  i?: boolean;
  u?: boolean;
  s?: boolean;
  c?: boolean;
  /** Link href. */
  a?: string;
  /** Mention: a page id. */
  m?: string;
  /** Text colour — a palette token. */
  tc?: string;
  /** Highlight colour — a palette token. */
  hl?: string;
}

/** One run of a block's rich text — mirror of `@book.dev/ui`'s `TextRun`. */
export interface ImportTextRun {
  t: string;
  a?: ImportInlineAttrs;
}

/**
 * A block in the IR — the structural mirror of `@book.dev/ui`'s `BlockJSON`.
 * `type` is any block type the editor ships (`paragraph` / `heading` / `list` /
 * `todo` / `quote` / `callout` / `code` / `table` / `columns` / `group` /
 * `tabs` / `accordion` / …); `text` carries rich runs, `children` nests
 * container blocks. `id` is optional — the editor mints one on load when absent.
 */
export interface ImportedBlock {
  id?: string;
  type: string;
  text?: ImportTextRun[];
  props?: Record<string, unknown>;
  children?: ImportedBlock[];
}

/**
 * A placeholder for an asset that import v1 cannot yet store (images today).
 * Carries enough to losslessly rehydrate once a real asset store lands: the
 * original `ref` (URL / path / data-uri / attachment id) and the `alt`/`title`.
 */
export interface ImportedAsset {
  /** Asset kind — only `image` is produced in v1. */
  kind: 'image';
  /** The original source reference, preserved verbatim. */
  ref: string;
  /** Alt text, preserved alongside the ref. */
  alt?: string;
  /** Original title attribute, if any. */
  title?: string;
}

/** A row of an {@link ImportedDatabase} — becomes a page inside the database. */
export interface ImportedRow {
  /**
   * A stable synthetic id for this row's page, honored by the **bundle** writer
   * ({@link buildImportBundle}) so a cross-page `@`-mention (an `m` run) can point
   * at the row before the server re-keys it. Optional — when omitted the bundle
   * mints one. The create writer ignores it (the store assigns the id there).
   */
  id?: string;
  /** The row's page title. */
  title: string;
  /** Manual property values, keyed by schema property id. */
  properties?: Record<string, unknown>;
  /** The row page's own document body, if any. */
  blocks?: ImportedBlock[];
  /** Sub-item rows nested under this one (same database). */
  children?: ImportedRow[];
}

/** A database hosted by an {@link ImportedPage}: its schema plus its rows. */
export interface ImportedDatabase {
  /** Display name (defaults to the host page's title when omitted). */
  name?: string;
  schema: DatabaseSchema;
  rows: ImportedRow[];
}

/**
 * A page in the imported tree: a title, an optional emoji icon, a block body,
 * an optional hosted database, and nested child pages. The recursive
 * `children` + per-page `database` is the whole shape an importer builds.
 */
export interface ImportedPage {
  /**
   * A stable synthetic id, honored by the **bundle** writer
   * ({@link buildImportBundle}) so cross-page `@`-mentions resolve to this page
   * before the server re-keys the whole graph. Optional — the bundle mints one
   * when omitted; the create writer ignores it (the store assigns the id there).
   */
  id?: string;
  title: string;
  icon?: string;
  blocks: ImportedBlock[];
  children?: ImportedPage[];
  /** A database this page hosts (its rows become row pages of the database). */
  database?: ImportedDatabase;
}

/** The format-agnostic target every parser emits: a forest of pages. */
export interface ImportedDoc {
  pages: ImportedPage[];
}

// ── Image-placeholder shim (v1 assets decision) ──────────────────────────────

/**
 * The `props.kind` marker on a placeholder block, and the `props` key the
 * structured {@link ImportedAsset} is stashed under. A future real-asset epic
 * can query for `props[IMAGE_PLACEHOLDER_PROP]` to find and rehydrate every
 * placeholder a past import left behind.
 */
export const IMAGE_PLACEHOLDER_KIND = 'import-image-placeholder';
export const IMAGE_PLACEHOLDER_PROP = 'importedAsset';

/**
 * Turn an image asset into a real, visible **callout** block that preserves the
 * original ref (as a clickable link run) and the alt/title text — never a
 * silent drop. The structured {@link ImportedAsset} is stashed in `props` so the
 * asset can be rehydrated later. Mirrors the "honest visible marker" pattern the
 * EditorJS migration uses for not-yet-supported blocks (`model.ts`). Pure: the
 * id is derived from the asset, so the same image always yields the same block
 * id (deterministic re-imports, no module-global counter).
 */
export function imagePlaceholderBlock(asset: ImportedAsset): ImportedBlock {
  const label = asset.alt?.trim() || asset.title?.trim() || asset.ref;
  return {
    id: `imp_img_${contentHash(`${asset.ref}|${asset.alt ?? ''}`)}`,
    type: 'callout',
    text: [{t: '🖼 '}, {t: label, a: {a: asset.ref}}],
    props: {
      variant: 'info',
      [IMAGE_PLACEHOLDER_PROP]: {
        kind: IMAGE_PLACEHOLDER_KIND,
        assetKind: asset.kind,
        ref: asset.ref,
        ...(asset.alt ? {alt: asset.alt} : {}),
        ...(asset.title ? {title: asset.title} : {}),
      },
    },
  };
}

/**
 * The placeholder *cell* value for a `files` / `url` database property: the
 * original ref, so the cell still renders and resolves the image (`firstImageUrl`
 * / `coverImageUrl` read it). Alt, when present, is preserved at block
 * granularity via {@link imagePlaceholderBlock} on the row's body.
 */
export function imagePlaceholderCell(asset: ImportedAsset): string {
  return asset.ref;
}

// ── HTML-artifact pending shim (run-as-artifact import) ──────────────────────

/**
 * The marker prop on an `htmlArtifact` block whose document bytes have not been
 * uploaded yet. The run-as-artifact import lands the page FIRST (`putAsset`
 * needs the landed page id for the asset's read-gate ref), then uploads the
 * file's bytes and rewrites the pending block to a real `assetId` — the same
 * land-then-rehydrate order as {@link IMAGE_PLACEHOLDER_PROP} images. A block
 * still carrying the marker (upload failed) renders as the editor's visible
 * "add an artifact" placeholder — degraded, never dropped.
 */
export const HTML_ARTIFACT_PENDING_PROP = 'importedArtifactPending';

/**
 * An `htmlArtifact` IR block awaiting its document upload — the run-as-artifact
 * counterpart of {@link imagePlaceholderBlock}, minimal by design: the bytes
 * live outside the IR (they go straight to the asset store), so the block only
 * carries the display title and the pending marker. Pure: the id derives from
 * the title, so the same import always yields the same block id.
 */
export function htmlArtifactPendingBlock(title?: string): ImportedBlock {
  const clean = title?.trim() ?? '';
  return {
    id: `imp_art_${contentHash(clean)}`,
    type: 'htmlArtifact',
    props: {...(clean ? {title: clean} : {}), [HTML_ARTIFACT_PENDING_PROP]: true},
  };
}

// ── Snapshot construction ────────────────────────────────────────────────────

/**
 * Wrap a block list in a page snapshot the block editor reads — the same shape
 * `templates.ts` ships (`editor:'blocks'`, blocks in `blockdoc.blocks`, NO CRDT
 * `update`). The editor rebuilds the Y.Doc from the JSON projection on load
 * (`decodeSnapshot` falls back to it), so importers never touch yjs.
 */
export function importedBlocksToSnapshot(blocks: ImportedBlock[]): PageSnapshot {
  return {
    editorjs: {blocks: []},
    values: [],
    names: [],
    editor: 'blocks',
    blockdoc: {blocks},
  };
}

const rowSnapshot = (row: ImportedRow): PageSnapshot =>
  row.blocks && row.blocks.length > 0 ? importedBlocksToSnapshot(row.blocks) : emptyPageSnapshot();

// ── Strategy selection ───────────────────────────────────────────────────────

export type ImportStrategy = 'create' | 'bundle';

const pageIsSimple = (page: ImportedPage): boolean => !page.database && !(page.children && page.children.length > 0);

/**
 * Pick a writer by the document's shape: a lone, childless, database-less page
 * → **Strategy A** (stream creates); anything bigger — multiple pages, nested
 * children, or a hosted database — → **Strategy B** (stage a bundle and let the
 * server remap/rewrite/dedup the whole tree at once).
 */
export function chooseStrategy(doc: ImportedDoc): ImportStrategy {
  return doc.pages.length === 1 && pageIsSimple(doc.pages[0]) ? 'create' : 'bundle';
}

// ── Writers ──────────────────────────────────────────────────────────────────

/** The slice of {@link DataClient} the import writers use (a real client satisfies it). */
export type ImportWriteClient = Pick<
  DataClient,
  'savePage' | 'setPageProperties' | 'createDatabase' | 'createRow' | 'importLibrary'
>;

/** Options shared by both writers. */
export interface ImportOptions {
  /**
   * Attach the imported roots under this existing page. Honored by
   * {@link writeViaCreateApis} only — the bundle writer always lands at the top
   * level, since copy-mode remap nulls any parent that isn't itself in the
   * bundle (a deliberate server-side rule).
   */
  parentId?: string | null;
}

/** Options for {@link buildImportBundle} / {@link writeViaBundle}. */
export interface BundleOptions extends ImportOptions {
  /** Mint an id for a synthetic bundle record. Defaults to a deterministic
   *  counter (`imp_p1`, `imp_d2`, …) — the server re-keys everything in copy mode. */
  newId?: () => string;
  /** ISO timestamp stamped on every synthetic record (defaults to now). */
  now?: string;
}

/** What an import write produced. */
export interface ImportWriteResult {
  strategy: ImportStrategy;
  /** Ordinary page ids created (Strategy A) / new page ids from the id-map (Strategy B). */
  pageIds: string[];
  /** Database ids created (Strategy A only — bundles re-key server-side). */
  databaseIds: string[];
  /** Row page ids created (Strategy A only). */
  rowIds: string[];
  /** The server's `ImportResult` (Strategy B only). */
  importResult?: ImportResult;
  /**
   * Landed page ids whose block body still holds an **image placeholder** after
   * the write (URL / `data:` images are rewritten to real `image` blocks *before*
   * landing, so these are refs that still need their bytes uploaded — e.g. Notion
   * zip images). The post-import rehydration pass ({@link rehydrateStoredImages})
   * targets exactly these, so a large import re-reads/re-saves only image-bearing
   * pages rather than the whole tree.
   */
  placeholderPageIds: string[];
}

/**
 * Does this block tree hold an image placeholder (a callout carrying
 * {@link IMAGE_PLACEHOLDER_PROP})? Used by the writers to record which landed
 * pages the post-import rehydration pass must revisit (see
 * {@link ImportWriteResult.placeholderPageIds}). Recurses container children.
 */
export function blocksHaveImagePlaceholder(blocks: ImportedBlock[] | undefined): boolean {
  for (const b of blocks ?? []) {
    if (b.props?.[IMAGE_PLACEHOLDER_PROP]) return true;
    if (b.children && blocksHaveImagePlaceholder(b.children)) return true;
  }
  return false;
}

/** How many `(imported)`-suffixed names to try before falling back to untitled. */
const NAME_SUFFIX_ATTEMPTS = 5;

/**
 * Run a name-bearing create (page or row) with a retry ladder so an import
 * **never hard-fails on a single record**. Names are not unique (server
 * migration 0015), so the plain title normally lands on the first attempt; the
 * `"<title> (imported)"` / numbered candidates remain as a retry path for
 * transient failures — consistent with the server's copy-mode ` (imported)`
 * suffix so Strategy A and B stay convergent — with an untitled record as the
 * last resort. A genuine persistent failure surfaces once the untitled
 * fallback also throws.
 */
async function createDeduped<T>(title: string, create: (name: string | null) => Promise<T>): Promise<T> {
  const candidates: string[] = [];
  if (title) {
    candidates.push(title, `${title} (imported)`);
    for (let n = 2; n <= NAME_SUFFIX_ATTEMPTS; n += 1) candidates.push(`${title} (imported) ${n}`);
  }
  for (const name of candidates) {
    try {
      return await create(name);
    } catch {
      // Name taken (or transient) — step the suffix and retry the next candidate.
    }
  }
  // Empty title, or every suffix exhausted: land it untitled rather than abort.
  return create(null);
}

/**
 * **Strategy A.** Write the tree by driving the create APIs directly, the way
 * the template gallery does: each page is `savePage`d (parent resolved from the
 * already-created ancestor), a hosted database is `createDatabase`d on it, and
 * every row — including nested sub-items — is `createRow`d. Each create runs
 * through the {@link createDeduped} retry ladder so one failing record degrades
 * (suffixed, then untitled) instead of aborting the import. Returns the ids it
 * minted, in creation order.
 */
export async function writeViaCreateApis(
  client: ImportWriteClient,
  doc: ImportedDoc,
  opts: ImportOptions = {},
): Promise<ImportWriteResult> {
  const result: ImportWriteResult = {strategy: 'create', pageIds: [], databaseIds: [], rowIds: [], placeholderPageIds: []};

  const writeRows = async (databaseId: string, rows: ImportedRow[], parentRowId: string | null): Promise<void> => {
    for (const row of rows) {
      const data = row.blocks && row.blocks.length > 0 ? importedBlocksToSnapshot(row.blocks) : undefined;
      const stored = await createDeduped(row.title, (name) =>
        client.createRow(databaseId, {name, properties: row.properties, data, parentId: parentRowId}),
      );
      result.rowIds.push(stored.id);
      if (blocksHaveImagePlaceholder(row.blocks)) result.placeholderPageIds.push(stored.id);
      if (row.children && row.children.length > 0) await writeRows(databaseId, row.children, stored.id);
    }
  };

  const writePage = async (page: ImportedPage, parentId: string | null): Promise<void> => {
    const stored = await createDeduped(page.title, (name) =>
      client.savePage({name, data: importedBlocksToSnapshot(page.blocks), parentId}),
    );
    result.pageIds.push(stored.id);
    if (blocksHaveImagePlaceholder(page.blocks)) result.placeholderPageIds.push(stored.id);
    if (page.icon) await client.setPageProperties(stored.id, {[ICON_PROPERTY_ID]: page.icon});
    if (page.database) {
      const db = await client.createDatabase({
        pageId: stored.id,
        name: page.database.name ?? page.title ?? null,
        schema: page.database.schema,
      });
      result.databaseIds.push(db.id);
      await writeRows(db.id, page.database.rows, null);
    }
    for (const child of page.children ?? []) await writePage(child, stored.id);
  };

  for (const page of doc.pages) await writePage(page, opts.parentId ?? null);
  return result;
}

/**
 * Map an {@link ImportedDoc} to a copy-mode backup bundle: native `StoredPage` /
 * `StoredDatabase` records with internally-consistent **synthetic** ids (the
 * server re-keys every id on import). The host page's `hostedDatabaseId`, the
 * database's `pageId`, each row's `databaseId`, and sub-item / child `parentId`
 * links are all wired up so `remapBundle` can rewrite them as one graph. Pure —
 * no client, no I/O — so it is directly unit-testable.
 */
export function buildImportBundle(
  doc: ImportedDoc,
  opts: BundleOptions = {},
): {pages: StoredPage[]; databases: StoredDatabase[]} {
  const now = opts.now ?? new Date().toISOString();
  let counter = 0;
  const newId = opts.newId ?? (() => `imp_${++counter}`);

  const pages: StoredPage[] = [];
  const databases: StoredDatabase[] = [];

  const emitRows = (rows: ImportedRow[], databaseId: string, parentRowId: string | null): void => {
    for (const row of rows) {
      // A parser may pin a stable id (so cross-page mentions resolve); else mint one.
      const id = row.id ?? newId();
      pages.push({
        id,
        name: row.title || null,
        data: rowSnapshot(row),
        hostedDatabaseId: null,
        databaseId,
        parentId: parentRowId,
        properties: row.properties ?? {},
        deletedAt: null,
        createdAt: now,
        updatedAt: now,
      });
      if (row.children && row.children.length > 0) emitRows(row.children, databaseId, id);
    }
  };

  const emitPage = (page: ImportedPage, parentId: string | null): void => {
    // A parser may pin a stable id (so cross-page mentions resolve); else mint one.
    const id = page.id ?? newId();
    const hostedDatabaseId = page.database ? newId() : null;
    pages.push({
      id,
      name: page.title || null,
      data: importedBlocksToSnapshot(page.blocks),
      hostedDatabaseId,
      databaseId: null,
      parentId,
      properties: page.icon ? {[ICON_PROPERTY_ID]: page.icon} : {},
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    });
    if (page.database && hostedDatabaseId) {
      databases.push({
        id: hostedDatabaseId,
        pageId: id,
        name: page.database.name ?? page.title ?? null,
        schema: page.database.schema,
        createdAt: now,
        updatedAt: now,
      });
      emitRows(page.database.rows, hostedDatabaseId, null);
    }
    for (const child of page.children ?? []) emitPage(child, id);
  };

  // Bundle roots land at the top level: copy-mode remap nulls any parent not in
  // the bundle, so an external `parentId` would be dropped anyway — don't set it.
  for (const page of doc.pages) emitPage(page, null);
  return {pages, databases};
}

/**
 * **Strategy B.** Build the copy-mode bundle ({@link buildImportBundle}) and
 * hand it to `importLibrary`, inheriting the server's id-remap, link-rewrite,
 * name-dedup, and idempotent-replay handling. Surfaces the server's
 * {@link ImportResult} (and its `idMap` as the new page ids).
 */
export async function writeViaBundle(
  client: ImportWriteClient,
  doc: ImportedDoc,
  opts: BundleOptions = {},
): Promise<ImportWriteResult> {
  const {pages, databases} = buildImportBundle(doc, opts);
  const req: ImportRequest = {pages, databases, mode: 'copy'};
  const importResult = await client.importLibrary(req);
  // Map the bundle pages that carry an image placeholder to their server-assigned
  // ids (via the id-map) so the post-import rehydration pass revisits only those.
  const placeholderPageIds: string[] = [];
  for (const page of pages) {
    const blocks = (page.data.blockdoc as {blocks?: ImportedBlock[]} | undefined)?.blocks;
    if (!blocksHaveImagePlaceholder(blocks)) continue;
    const landed = importResult.idMap[page.id];
    if (landed) placeholderPageIds.push(landed);
  }
  return {
    strategy: 'bundle',
    pageIds: Object.values(importResult.idMap),
    databaseIds: [],
    rowIds: [],
    importResult,
    placeholderPageIds,
  };
}

/**
 * Import a document, picking the writer by {@link chooseStrategy}. The single
 * entry point a parser calls once it has built its {@link ImportedDoc}.
 */
export function importDoc(
  client: ImportWriteClient,
  doc: ImportedDoc,
  opts: BundleOptions = {},
): Promise<ImportWriteResult> {
  return chooseStrategy(doc) === 'create' ? writeViaCreateApis(client, doc, opts) : writeViaBundle(client, doc, opts);
}
