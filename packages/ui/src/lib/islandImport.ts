/**
 * **Island-first HTML import** — the lossless half of the export round-trip.
 * Every standalone HTML export embeds its `application/openbook+json` source
 * island (see the SDK's `island.ts`); when an imported `.html` file carries one,
 * we restore from the ISLAND and skip the lossy `htmlToBlocks` conversion
 * entirely. Pure and string/regex-based throughout (island readers must never
 * DOM-parse — the reader contract), so everything here is unit-testable without
 * a DOM and immune to markup quirks in the visible body.
 *
 * Two island kinds, two landing paths:
 *  - a **page island** (`toHtml` / `toSlideDeck` exports, and `.book.html` sync
 *    files — same shape) lands through the `importDoc` IR path: the island's
 *    block-doc becomes the IR verbatim, so the create-strategy semantics apply
 *    (a FRESH page id, the plain name — duplicates are allowed since server
 *    migration 0015 — and the `(imported)` retry ladder only on failure).
 *    Re-importing into the same space therefore creates a sibling copy, never
 *    overwrites the original. The CRDT `update` is deliberately NOT carried — a
 *    copy gets a fresh CRDT identity; the JSON block projection is the
 *    structural source and round-trips ids/types/props/order losslessly.
 *  - a **space island** (`toHtmlSite` exports) lands through the copy-mode
 *    bundle path (`importLibrary`, the same path the book-folder restore uses):
 *    the server re-keys every page/database id, rewrites internal links and
 *    parent/row relationships, so nesting + databases arrive intact — again as
 *    a copy that never clobbers existing pages.
 *
 * ## Asset recovery (the export↔import asset contract)
 * The island's block-doc references image `assetId`s; the export's *visible*
 * HTML carries the resolved bytes as `data:` URIs on `<img data-asset-id="…">`
 * tags. At parse time we map assetId → bytes from those tags, and after landing
 * we `putAsset` each recovered blob — content addressing (the id IS the sha-256
 * of the bytes) restores the exact ids the island's blocks already reference,
 * so no block rewriting is needed and a same-space re-import dedups to a no-op.
 * An asset whose bytes are NOT in the file (e.g. an htmlArtifact's, which today
 * exports only a placeholder figure) degrades without dropping: the image block
 * keeps its assetId + alt, renders as the editor's visible alt-text placeholder,
 * and springs back to life if the asset already exists in the target space (or
 * is restored later). The byte map is deliberately decoupled from how it was
 * built ({@link readExportAssetMap} is just one producer), so the future
 * artifact-in-export task can feed additional sources into the same recovery.
 */
import {
  ICON_PROPERTY_ID,
  LedgerError,
  importDoc,
  parseLedgerExportSection,
  readIsland,
  readLibraryIsland,
  type AssetBytes,
  type BookPageRecord,
  type ImportedBlock,
  type ImportWriteClient,
  type LedgerExportSection,
  type LedgerSectionRestoreResult,
  type PageSnapshot,
  type LibraryIsland,
  type StoredPage,
} from '@book.dev/sdk';

/** What an island scan found in an HTML file (discriminated by island kind). */
export type HtmlIsland =
  | {kind: 'page'; record: BookPageRecord}
  | {kind: 'space'; island: LibraryIsland};

/** The client surface an island import drives (a real DataClient satisfies it). */
export type IslandImportClient = ImportWriteClient & {
  putAsset(bytes: Uint8Array, mime: string, pageId: string): Promise<{id: string}>;
  /** LX-4: restore an embedded ledger-records section through the server's
   *  ledger writer. Optional — a client without it simply cannot restore
   *  records, and the import reports that instead of silently dropping them. */
  ledgerRestoreSection?(section: LedgerExportSection): Promise<LedgerSectionRestoreResult>;
};

// ── Detection ─────────────────────────────────────────────────────────────────

/**
 * Scan an HTML string for an OpenBook source island — BEFORE any HTML→blocks
 * conversion. Returns the parsed island (space bundle preferred: it is the
 * richer shape and a site export carries exactly one island), a page record,
 * or `null` when the file has no island (foreign/legacy HTML → the caller
 * routes to the existing `htmlToImportedDoc` path).
 *
 * Unlike the sync-folder reader (`bookHtmlToPage`) this accepts an EMPTY page
 * id: an export of a never-saved page carries `id: ''`, and an import mints a
 * fresh id anyway.
 */
export function detectHtmlIsland(html: string): HtmlIsland | null {
  const space = readLibraryIsland(html);
  if (space) return {kind: 'space', island: space};
  const page = readIsland<Partial<BookPageRecord>>(html);
  if (page && page.data && typeof page.data === 'object') {
    return {
      kind: 'page',
      record: {
        id: page.id ?? '',
        name: page.name ?? null,
        icon: page.icon ?? null,
        updatedAt: page.updatedAt ?? '',
        data: page.data,
      },
    };
  }
  return null;
}

// ── Asset byte recovery from the export's visible HTML ───────────────────────

/** Decode a base64 `data:` URI to bytes + mime, or `null` when it isn't one. */
export function dataUriToBytes(uri: string): AssetBytes | null {
  const m = /^data:([^;,]*);base64,([\s\S]*)$/i.exec(uri);
  if (!m) return null; // exports always emit base64 data-URIs (bytesToDataUri)
  try {
    const binary = atob(m[2]);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return {bytes, mime: m[1] || 'application/octet-stream'};
  } catch {
    return null;
  }
}

/**
 * Build the assetId → bytes map from an export's visible `<img>` tags (the
 * `data-asset-id` attribute the exporter stamps on every store-resolved image).
 * String/regex-based — attribute order independent, no DOM. Tags without a
 * `data:` src (remote URLs, missing images) contribute nothing; their assets
 * simply aren't recoverable from this file.
 */
export function readExportAssetMap(html: string): Map<string, AssetBytes> {
  const map = new Map<string, AssetBytes>();
  for (const tag of html.match(/<img\b[^>]*>/gi) ?? []) {
    const id = /\bdata-asset-id="([^"]+)"/i.exec(tag)?.[1];
    if (!id || map.has(id)) continue;
    const src = /\bsrc="([^"]+)"/i.exec(tag)?.[1];
    if (!src) continue;
    const decoded = dataUriToBytes(src);
    if (decoded) map.set(id, decoded);
  }
  return map;
}

// ── Asset reference collection (island block-docs, both snapshot shapes) ─────

/** Recursively collect `image` blocks' `assetId`s from block-editor JSON. */
function collectFromBlocks(blocks: ImportedBlock[] | undefined, into: Set<string>): void {
  for (const b of blocks ?? []) {
    const assetId = (b.props as {assetId?: unknown} | undefined)?.assetId;
    if (b.type === 'image' && typeof assetId === 'string' && assetId) into.add(assetId);
    collectFromBlocks(b.children, into);
  }
}

/** Every image `assetId` a snapshot references (blockdoc and legacy `editorjs` shapes). */
export function snapshotAssetIds(data: PageSnapshot): string[] {
  const ids = new Set<string>();
  collectFromBlocks((data.blockdoc as {blocks?: ImportedBlock[]} | undefined)?.blocks, ids);
  for (const b of (data.editorjs as {blocks?: Array<{type?: string; data?: {assetId?: unknown}}>} | undefined)?.blocks ?? []) {
    if (b.type === 'image' && typeof b.data?.assetId === 'string' && b.data.assetId) ids.add(b.data.assetId);
  }
  return [...ids];
}

// ── Summary (for the import dialog preview) ──────────────────────────────────

/** The preview tally for an island import (shape-compatible with ImportSummary). */
export interface IslandSummary {
  pages: number;
  databases: number;
  rows: number;
  images: number;
}

/** Tally what an island will land — pages/databases/rows plus referenced images. */
export function summarizeHtmlIsland(found: HtmlIsland): IslandSummary {
  if (found.kind === 'page') {
    return {pages: 1, databases: 0, rows: 0, images: snapshotAssetIds(found.record.data).length};
  }
  const {pages, databases} = found.island.space;
  const rows = pages.filter((p) => p.databaseId !== null).length;
  const images = new Set(pages.flatMap((p) => snapshotAssetIds(p.data))).size;
  return {pages: pages.length - rows, databases: databases.length, rows, images};
}

// ── Ledger records (LX-4) ─────────────────────────────────────────────────────

/** What the import preview can say about an island's embedded ledger records. */
export type IslandLedgerPreview =
  /** A coherent book: the tallies the preview shows. */
  | {ok: true; accounts: number; entries: number; evidenceDropped: number}
  /** Present but incoherent — offered as "cannot be restored", never landed. */
  | {ok: false; reason: string};

/**
 * Preview the LX-2 ledger records a space island embeds, or `null` when it
 * carries none. Runs the SAME deep validation the server runs before writing
 * (`parseLedgerExportSection` — one validator, two callers), so the dialog
 * can say "these records cannot be restored" BEFORE the user commits.
 */
export function summarizeIslandLedger(found: HtmlIsland): IslandLedgerPreview | null {
  if (found.kind !== 'space' || !found.island.ledger) return null;
  const parsed = parseLedgerExportSection(found.island.ledger);
  if (!parsed.ok) return {ok: false, reason: parsed.reason};
  return {
    ok: true,
    accounts: parsed.book.accounts.length,
    entries: parsed.book.transactions.length,
    evidenceDropped: parsed.book.evidenceDropped,
  };
}

/** How the ledger half of an island import ended. */
export type IslandLedgerOutcome =
  /** Replayed into the target's (empty) ledger. */
  | {status: 'restored'; result: LedgerSectionRestoreResult}
  /** The target already keeps books — the server refused (merge is out of
   *  scope); `message` is the server's actionable refusal. Pages still landed. */
  | {status: 'refused'; message: string}
  /** Anything else (validation, transport, a client with no restore surface). */
  | {status: 'failed'; message: string};

// ── Landing ──────────────────────────────────────────────────────────────────

/** What an island import landed, plus honest asset-recovery stats. */
export interface IslandImportResult {
  /** Landed page ids (fresh, server-assigned). */
  pageIds: string[];
  /** Assets whose bytes were recovered from the file and re-stored (same ids). */
  assetsRestored: number;
  /**
   * Referenced assetIds whose bytes were NOT recoverable from the file. Their
   * image blocks are left intact (assetId + alt preserved — the editor renders
   * a visible alt placeholder, and the reference resolves if the asset already
   * exists in the target space). Degraded, never dropped.
   */
  assetsMissing: string[];
  /** LX-4: how the embedded ledger records landed, when the caller asked for
   *  them (`restoreLedger`) and the island carried any. Absent otherwise. */
  ledger?: IslandLedgerOutcome;
}

/** A synthesized one-page space, for a page island that isn't block-editor
 *  shaped (legacy EditorJS snapshot): the copy-mode bundle lands the RAW
 *  snapshot untouched, so even that round-trips losslessly. */
function pageRecordAsStoredPage(record: BookPageRecord): StoredPage {
  return {
    id: record.id || 'island_page',
    name: record.name,
    data: record.data,
    hostedDatabaseId: null,
    databaseId: null,
    parentId: null,
    properties: record.icon ? {[ICON_PROPERTY_ID]: record.icon} : {},
    deletedAt: null,
    createdAt: record.updatedAt || new Date().toISOString(),
    updatedAt: record.updatedAt || new Date().toISOString(),
  };
}

/**
 * Land an island (page or space) and recover its assets from the export file's
 * byte map. Returns the landed page ids (for the "view imported" jump) plus
 * asset stats. Id semantics: ALWAYS a copy — the page-island path creates a
 * fresh page via `importDoc`, the space-island path re-keys everything via
 * `importLibrary({mode: 'copy'})` — so importing an export back into its source
 * space duplicates rather than overwrites.
 */
export async function runIslandImport(
  client: IslandImportClient,
  found: HtmlIsland,
  assetBytes: Map<string, AssetBytes>,
  opts: {
    /** LX-4: also restore the space island's embedded ledger records (when it
     *  carries any) through the server's ledger writer. The PAGE landing is a
     *  copy and always proceeds; the ledger half restores only into an empty
     *  ledger and reports `refused` otherwise — it never aborts the pages. */
    restoreLedger?: boolean;
  } = {},
): Promise<IslandImportResult> {
  // assetId → the ISLAND page that references it (its landed id anchors the
  // asset's read-gate ref; the first referencing page suffices).
  const assetToIslandPage = new Map<string, string>();
  let pageIds: string[];
  // island page id → landed id. The single-page create path has no id-map (the
  // island page, whatever its id, landed as the one fresh page).
  let landedIdOf: (islandPageId: string) => string | undefined;

  if (found.kind === 'page') {
    const {record} = found;
    for (const assetId of snapshotAssetIds(record.data)) assetToIslandPage.set(assetId, record.id);
    const blockdoc = record.data.blockdoc as {blocks?: ImportedBlock[]} | undefined;
    if (record.data.editor === 'blocks' && Array.isArray(blockdoc?.blocks)) {
      // The canonical path: the island's block JSON IS the IR (same shape), so
      // importDoc lands it via the create strategy — fresh id, faithful blocks.
      const result = await importDoc(client, {
        pages: [
          {
            title: (record.name ?? '').trim() || 'Untitled',
            ...(record.icon ? {icon: record.icon} : {}),
            blocks: blockdoc.blocks,
          },
        ],
      });
      pageIds = result.pageIds;
    } else {
      // Not block-editor shaped (legacy EditorJS island): land the RAW snapshot
      // through the copy-mode bundle so nothing is projected away.
      const page = pageRecordAsStoredPage(record);
      const imported = await client.importLibrary({pages: [page], databases: [], mode: 'copy'});
      pageIds = Object.values(imported.idMap);
    }
    const only = pageIds[0];
    landedIdOf = () => only;
  } else {
    const {space} = found.island;
    for (const page of space.pages) {
      for (const assetId of snapshotAssetIds(page.data)) {
        if (!assetToIslandPage.has(assetId)) assetToIslandPage.set(assetId, page.id);
      }
    }
    // The book-folder restore path: server-side re-key + link rewrite keeps
    // nesting, mentions, and database membership intact — as a copy.
    const imported = await client.importLibrary({pages: space.pages, databases: space.databases, mode: 'copy'});
    const idMap = imported.idMap;
    pageIds = Object.values(idMap);
    landedIdOf = (id) => idMap[id];
  }

  // ── Asset recovery: re-store recovered bytes; content addressing restores
  // the island's exact ids, so the landed blocks' references just work.
  let assetsRestored = 0;
  const assetsMissing: string[] = [];
  for (const [assetId, islandPageId] of assetToIslandPage) {
    const entry = assetBytes.get(assetId);
    const refPage = landedIdOf(islandPageId) ?? pageIds[0];
    if (!entry || !refPage) {
      assetsMissing.push(assetId);
      continue;
    }
    try {
      const {id} = await client.putAsset(entry.bytes, entry.mime, refPage);
      // Content addressing: identical bytes MUST yield the island's id. A drift
      // means the blob in the file wasn't the original bytes — count it missing
      // (the block still references the island id).
      if (id === assetId) assetsRestored += 1;
      else assetsMissing.push(assetId);
    } catch {
      assetsMissing.push(assetId); // degrade, never abort the import
    }
  }

  // ── Ledger records (LX-4): AFTER the pages landed — a refused ledger must
  // never cost the user their document import, and the two surfaces are
  // independent (the ledger lives outside the document tree).
  let ledger: IslandLedgerOutcome | undefined;
  if (opts.restoreLedger && found.kind === 'space' && found.island.ledger) {
    ledger = await restoreIslandLedger(client, found.island.ledger);
  }
  return {pageIds, assetsRestored, assetsMissing, ...(ledger ? {ledger} : {})};
}

/** The ledger half of an island import, as a typed outcome (never a throw). */
async function restoreIslandLedger(client: IslandImportClient, section: LedgerExportSection): Promise<IslandLedgerOutcome> {
  if (!client.ledgerRestoreSection) {
    return {status: 'failed', message: 'this connection has no ledger-restore surface'};
  }
  try {
    return {status: 'restored', result: await client.ledgerRestoreSection(section)};
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // The one EXPECTED refusal: the target already keeps books (the server's
    // empty-ledger gate, typed `invalid-state`). Everything else is a failure.
    if (e instanceof LedgerError && e.code === 'invalid-state') return {status: 'refused', message};
    return {status: 'failed', message};
  }
}
