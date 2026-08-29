import type * as Y from 'yjs';
import {richTextRuns, type RichTextInput} from '@book.dev/sdk';
import {
  findBlock as findSnapshotBlock,
  insertBlocks as insertSnapshotBlocks,
  moveBlock as moveSnapshotBlock,
  resolveAgentEdits,
  resolveTableOp,
  tableOpError,
  tableShapeOf,
  TABLE_OP_KINDS,
  type AgentEditsMode,
  type AgentProposal,
  type AppendBlock,
  type DataClient,
  type SnapshotTableView,
  type StoredSuggestion,
  type TableOpAddress,
  type TableOpKind,
} from '@book.dev/sdk';
import {
  blockChildren,
  blockId,
  blockProp,
  blockText,
  blockType,
  cellPosition,
  coerceNewBlock,
  decodeSnapshot,
  encodeSnapshot,
  findBlock,
  insertBlock,
  makeBlock,
  moveBlock as moveEditorBlock,
  parentBlockOf,
  patchBlock,
  removeBlock,
  replaceText,
  rootBlocks,
  setTableColumnColor,
  setTableColumnWidth,
  setTableRowColor,
  tableDeleteColumn,
  tableDeleteRow,
  tableDuplicateRow,
  tableGrid,
  tableInsertColumn,
  tableInsertRow,
  tableMoveColumn,
  tableMoveRow,
  type BlockDocSnapshot,
  type BlockMap,
  type NewBlock,
} from '@/blockeditor/model';
import {findInput, setInputValue} from '@/blockeditor/kit/scope';
import {merge3} from '@/lib/textMerge';
import {readPageTheme, writePageTheme} from '@/lib/pageTheme';
import {COVER_GRADIENTS, writePageCover} from '@/lib/pageCover';
import type {AppearanceOverride} from '@/lib/themes';

/**
 * Bridge between the (provider-less) block editor and the app's AI client —
 * the same singleton pattern as `pageLinks`. The app installs it once
 * (DefaultLayout); editor slash items consult `ready` to decide whether to
 * appear and call through for completions / task breakdowns.
 *
 * The bridge also owns the agent's WRITE path. Write tools never mutate; the
 * agent returns a PROPOSED change set, the AgentPanel shows it for approval,
 * and on approve the bridge applies it. Two application paths:
 *
 *  1. CRDT path — when a live block editor for the target page has registered
 *     its Y.Doc (via {@link registerBlockEditorDoc}), the change is applied in
 *     ONE Y transaction (origin 'local') so it's undoable and broadcasts live,
 *     exactly like a kit click or a streamed token.
 *  2. Server fallback — otherwise the change is applied through the data client
 *     (savePage / updateRow). A live editor on that page merges it (CRDT union)
 *     on its next server push.
 *
 * Keeping the editor-doc handle in a singleton (rather than coupling the agent
 * to React) mirrors how `aiBridge.complete` already streams tokens into the
 * editor's CRDT without the agent knowing about React at all.
 */

export interface ProposalApplyResult {
  applied: number;
  failed: Array<{id: string; error: string}>;
}

export interface AiBridgeImpl {
  /** Engine is configured and was ready at the last status poll. */
  ready: () => boolean;
  complete: (text: string, onToken: (token: string) => void) => Promise<string>;
  tasks: (goal: string, context?: string) => Promise<string[]>;
  /** Apply an approved set of agent proposals. */
  applyProposals: (proposals: AgentProposal[]) => Promise<ProposalApplyResult>;
  /**
   * Apply one accepted suggestion to the document — the same CRDT-first /
   * savePage-fallback path as {@link applyProposals}, keyed off the suggestion's
   * `payload.applyKind`. Throws on failure (the caller keeps the suggestion open).
   */
  applySuggestion: (suggestion: StoredSuggestion) => Promise<void>;
}

/**
 * Convert a persisted suggestion back into the {@link AgentProposal} shape the
 * editor-bridge apply path understands. The suggestion's `payload` carries the
 * original write-tool kind as `applyKind`, so applying an AI suggestion and a
 * human suggestion go through identical code.
 */
export const suggestionToProposal = (s: StoredSuggestion): AgentProposal => {
  const payload = s.payload ?? {};
  const kind = (payload.applyKind as AgentProposal['kind']) ?? 'update_block';
  return {
    id: s.id,
    kind,
    summary: typeof payload.summary === 'string' ? payload.summary : `${s.kind} on ${s.pageId}`,
    pageId: s.pageId,
    before: s.before,
    after: s.after,
    payload,
  };
};

// ── Live block-editor doc registry (pageId → Y.Doc) ─────────────────────────────
// A mounted block editor registers its doc here so the agent's CRDT write path
// can reach it. Weakly scoped by page id; unregistered on unmount. Declared up
// here (before the apply path) so {@link applyProposal} can consult it.

const editorDocs = new Map<string, Y.Doc>();

/** A mounted block editor registers its live doc. Returns an unregister fn. */
export const registerBlockEditorDoc = (pageId: string, doc: Y.Doc): (() => void) => {
  editorDocs.set(pageId, doc);
  return () => {
    if (editorDocs.get(pageId) === doc) editorDocs.delete(pageId);
  };
};

/** The live editor doc for a page, when one is currently mounted. */
export const getBlockEditorDoc = (pageId: string | undefined): Y.Doc | null =>
  (pageId && editorDocs.get(pageId)) || null;

/** Reverse lookup: the page id a live editor doc is registered under, if any. */
export const getPageIdForDoc = (doc: Y.Doc): string | null => {
  for (const [pageId, registered] of editorDocs) {
    if (registered === doc) return pageId;
  }
  return null;
};

// ── The agent WRITE path (pure — no React) ──────────────────────────────────────
// Extracted here so both the React host (AiBridgeHost) and the client-side
// agent-edits policy router (AGED-4, below) share ONE apply implementation, and
// so the live-vs-stored branching is unit-testable against the doc registry.

/** The subset of the data client the agent write path calls. */
export type ApplyClient = Pick<DataClient, 'updateRow' | 'getPage' | 'savePage'>;

/**
 * When deleting `found` would empty its table, the id of the TABLE to delete
 * instead — matching the editor's rule that a table losing its last row/column
 * is removed whole (model.ts tableDeleteRow/tableDeleteColumn). Returns null for
 * an ordinary delete (any non-final row/cell, or a non-table block).
 */
const tableDeleteTarget = (
  doc: Y.Doc,
  found: {block: BlockMap; parent: Y.Array<BlockMap>; index: number},
): string | null => {
  const type = blockType(found.block);
  const parent = parentBlockOf(doc, found.parent);
  if (!parent) return null;
  // Last row of a table → the table empties, so remove the table.
  if (type === 'row' && blockType(parent) === 'table' && found.parent.length === 1) {
    return blockId(parent);
  }
  // Only cell of a row → if that row is the table's only row, the table empties.
  if (type === 'cell' && blockType(parent) === 'row' && found.parent.length === 1) {
    const row = findBlock(doc, blockId(parent));
    const table = row && parentBlockOf(doc, row.parent);
    if (row && table && blockType(table) === 'table' && (blockChildren(table)?.length ?? 0) === 1) {
      return blockId(table);
    }
  }
  return null;
};

// ── Table structure proposals (API-3) ───────────────────────────────────────────
// A `table_*` proposal is replayed by calling the editor's OWN op from
// `model.ts` — the same function the context menu calls — so there is exactly one
// implementation of "insert a row" in the live-document path. Coordinates and
// guards are shared with the MCP/snapshot path through the SDK
// (`resolveTableOp` + `tableOpError`), which is what keeps the three paths from
// drifting; see the invariant test in
// `packages/ui/src/blockeditor/__tests__/tableOpParity.test.ts`.

const TABLE_KINDS = new Set<string>(TABLE_OP_KINDS);

/** True for a proposal kind that is a table structure op. */
export const isTableProposalKind = (kind: string): kind is TableOpKind => TABLE_KINDS.has(kind);

/**
 * A {@link SnapshotTableView} over a LIVE table block, so the SDK's shared
 * addressing resolver and validator serve the CRDT path unchanged. Coordinates
 * are the SORTED (render) order of `tableGrid` — the same space as `cellPosition`.
 */
const liveTableView = (table: BlockMap, tableId: string): SnapshotTableView => {
  const grid = tableGrid(table);
  return {
    tableId,
    header: blockProp<boolean>(table, 'header') === true,
    rows: grid.rows.length,
    cols: grid.width,
    rowIds: grid.rows.map(blockId),
    colIds: grid.colIds,
    cellIds: grid.cells.map((row) => row.map((c) => (c ? blockId(c) : null))),
    cells: grid.cells.map((row) => row.map((c) => (c ? (blockText(c)?.toString() ?? '') : ''))),
  };
};

/** The table a payload targets: an explicit `tableId`, or the table owning a `cellId`/`rowId`. */
const targetTable = (doc: Y.Doc, payload: Record<string, unknown>): {id: string; block: BlockMap} => {
  const explicit = typeof payload.tableId === 'string' ? payload.tableId : '';
  if (explicit) {
    const found = findBlock(doc, explicit);
    if (!found || blockType(found.block) !== 'table') throw new Error(`no table "${explicit}" on this page`);
    return {id: explicit, block: found.block};
  }
  if (typeof payload.cellId === 'string') {
    const pos = cellPosition(doc, payload.cellId);
    if (!pos) throw new Error(`no cell "${payload.cellId}" in a table on this page`);
    return {id: blockId(pos.table), block: pos.table};
  }
  if (typeof payload.rowId === 'string') {
    const row = findBlock(doc, payload.rowId);
    const table = row && parentBlockOf(doc, row.parent);
    if (!table || blockType(table) !== 'table') throw new Error(`no table row "${payload.rowId}" on this page`);
    return {id: blockId(table), block: table};
  }
  throw new Error('a table proposal needs a tableId (or a cellId / rowId inside one)');
};

/** The id-or-index address a `table_*` payload carries. */
const tableAddress = (payload: Record<string, unknown>): TableOpAddress => ({
  ...(typeof payload.rowIndex === 'number' ? {rowIndex: payload.rowIndex} : {}),
  ...(typeof payload.colIndex === 'number' ? {colIndex: payload.colIndex} : {}),
  ...(typeof payload.toIndex === 'number' ? {toIndex: payload.toIndex} : {}),
  ...(typeof payload.cellId === 'string' ? {cellId: payload.cellId} : {}),
  ...(typeof payload.rowId === 'string' ? {rowId: payload.rowId} : {}),
  ...(typeof payload.colId === 'string' ? {colId: payload.colId} : {}),
  ...(typeof payload.text === 'string' ? {text: payload.text} : {}),
  ...('color' in payload ? {color: typeof payload.color === 'string' ? payload.color : null} : {}),
  ...('width' in payload ? {width: typeof payload.width === 'number' ? payload.width : null} : {}),
});

/**
 * Replay one table structure proposal against a live doc. Call INSIDE the
 * proposal's transaction — each model op opens its own `doc.transact`, which Yjs
 * folds into the enclosing one, so the whole proposal stays ONE undo step.
 * Throws (with the shared message) on a bad address or an illegal op, so the
 * caller keeps the suggestion open rather than silently applying nothing.
 */
export const applyTableProposalToDoc = (doc: Y.Doc, kind: TableOpKind, payload: Record<string, unknown>): void => {
  const table = targetTable(doc, payload);
  const view = liveTableView(table.block, table.id);
  const resolved = resolveTableOp(view, kind, tableAddress(payload));
  if ('error' in resolved) throw new Error(resolved.error);
  const {op} = resolved;
  const bad = tableOpError(tableShapeOf(view), op);
  if (bad) throw new Error(bad);

  switch (kind) {
  case 'table_insert_row':
    tableInsertRow(doc, table.id, op.rowIndex!);
    return;
  case 'table_delete_row':
    tableDeleteRow(doc, table.id, op.rowIndex!);
    return;
  case 'table_duplicate_row':
    tableDuplicateRow(doc, table.id, op.rowIndex!);
    return;
  case 'table_insert_column':
    tableInsertColumn(doc, table.id, op.colIndex!);
    return;
  case 'table_delete_column':
    tableDeleteColumn(doc, table.id, op.colIndex!);
    return;
  case 'table_move_row':
    // The model op takes the row ID (not its index) so a concurrently reordered
    // table still moves the row the proposal meant.
    tableMoveRow(doc, table.id, view.rowIds[op.rowIndex!], op.toIndex!);
    return;
  case 'table_move_column':
    tableMoveColumn(doc, table.id, view.colIds[op.colIndex!], op.toIndex!);
    return;
  case 'table_set_cell': {
    // Re-read the grid: the ops above may have run earlier in this same
    // transaction, and `tableGrid` is only valid until the table changes.
    const grid = tableGrid(table.block);
    const runs = richTextRuns(op.text ?? '', op.plain);
    const cell = grid.cells[op.rowIndex!]?.[op.colIndex!];
    if (!cell) {
      // A merge gap has no cell node — materialize one bound to that column, so
      // set_cell can fill a ragged/legacy table instead of throwing on a hole.
      // Mirrors the snapshot path (tableSnapshot.ts `table_set_cell`): same
      // column binding, one plain run.
      const row = grid.rows[op.rowIndex!];
      const colId = grid.colIds[op.colIndex!];
      const rowCells = row && blockChildren(row);
      if (rowCells && colId) rowCells.push([makeBlock({type: 'cell', props: {col: colId}, text: runs})]);
      return;
    }
    const text = blockText(cell);
    if (!text) throw new Error(`row ${op.rowIndex} column ${op.colIndex} of table ${table.id} has no cell to write`);
    text.delete(0, text.length);
    let at = 0;
    for (const run of runs) {
      text.insert(at, run.t, run.a ?? {});
      at += run.t.length;
    }
    return;
  }
  case 'table_set_row_color':
    setTableRowColor(doc, table.id, view.rowIds[op.rowIndex!], op.color ?? null);
    return;
  case 'table_set_column_color':
    setTableColumnColor(doc, table.id, view.colIds[op.colIndex!], op.color ?? null);
    return;
  case 'table_set_column_width':
    setTableColumnWidth(doc, table.id, view.colIds[op.colIndex!], op.width ?? null);
    return;
  }
};

/** Mutate a live Y.Doc in one transaction (origin 'local' → tracked by the
 *  shared UndoManager, so an agent apply is undoable exactly like a manual edit). */
export const applyProposalToDoc = (doc: Y.Doc, p: AgentProposal): void => {
  doc.transact(() => {
    const payload = p.payload;
    const pageSnapshot = () => ({editor: 'blocks' as const, blockdoc: encodeSnapshot(doc), editorjs: {blocks: []}, values: [], names: []});
    if (p.kind === 'set_kit_value') {
      const block = findInput(doc, String(payload.name));
      if (block) setInputValue(block, payload.value);
    } else if (p.kind === 'update_block') {
      const found = findBlock(doc, String(payload.blockId));
      const text = found && blockText(found.block);
      if (text) {
        const input = payload.text as RichTextInput;
        const runs = richTextRuns(input, payload.plain === true);
        const theirs = runs.map((run) => run.t).join('');
        // `payload.before` is the block text when the suggestion was made.
        // Merging against it (rather than replacing wholesale) means a second
        // suggestion accepted on the same block keeps the first one's edit
        // instead of clobbering it; with no base we fall back to a replace.
        const base = typeof payload.before === 'string' ? payload.before : null;
        const rich = typeof input !== 'string' || runs.some((run) => run.a);
        if (rich) {
          text.delete(0, text.length);
          let at = 0;
          for (const run of runs) {
            text.insert(at, run.t, run.a ?? {});
            at += run.t.length;
          }
        } else {
          const next = base === null ? theirs : merge3(base, text.toString(), theirs);
          replaceText(text, next);
        }
      }
    } else if (p.kind === 'append_blocks') {
      const list = rootBlocks(doc);
      const raw = Array.isArray(payload.blocks) ? payload.blocks : [];
      const built = raw
        .map(coerceNewBlock)
        .filter((b): b is NewBlock => b !== null)
        .map(makeBlock);
      if (built.length > 0) list.push(built);
    } else if (p.kind === 'move_block') {
      const blockId = String(payload.blockId);
      const parentId = typeof payload.parentId === 'string' ? payload.parentId : undefined;
      const request = {
        blockId,
        ...(parentId === undefined ? {} : {parentId}),
        ...(typeof payload.index === 'number' ? {index: payload.index} : {}),
        ...(typeof payload.afterId === 'string' ? {afterId: payload.afterId} : {}),
      };
      // Let the shared snapshot twin validate table ownership, parent contracts,
      // cycles, and addressing before touching the live CRDT.
      const projected = moveSnapshotBlock(pageSnapshot(), request);
      const destination = findSnapshotBlock(projected, blockId);
      const source = findBlock(doc, blockId);
      if (!destination || !source) throw new Error(`no block "${blockId}" on this page`);
      const target = parentId === undefined ? rootBlocks(doc) : blockChildren(findBlock(doc, parentId)?.block as BlockMap);
      if (!target) throw new Error(`no destination block "${parentId}" on this page`);
      const anchorId = destination.index > 0 ? destination.siblings[destination.index - 1].id : null;
      const anchorAt = anchorId === null ? -1 : target.toArray().findIndex((b) => b.get('id') === anchorId);
      const modelIndex = anchorAt + 1;
      moveEditorBlock(doc, blockId, parentId ?? null, modelIndex);
    } else if (p.kind === 'insert_blocks') {
      const parentId = typeof payload.parentId === 'string' ? payload.parentId : undefined;
      const raw = Array.isArray(payload.blocks) ? payload.blocks as AppendBlock[] : [];
      const built = raw.map(coerceNewBlock).filter((block): block is NewBlock => block !== null);
      const request = {
        ...(parentId === undefined ? {} : {parentId}),
        ...(typeof payload.index === 'number' ? {index: payload.index} : {}),
        ...(typeof payload.afterId === 'string' ? {afterId: payload.afterId} : {}),
        blocks: raw,
        idPrefix: '__ai_insert__',
      };
      const projected = insertSnapshotBlocks(pageSnapshot(), request);
      const target = parentId === undefined ? rootBlocks(doc) : blockChildren(findBlock(doc, parentId)?.block as BlockMap);
      if (!target) throw new Error(`no destination block "${parentId}" on this page`);
      const beforeLength = target.length;
      const projectedTarget = parentId === undefined
        ? (projected.blockdoc as {blocks?: Array<{id?: string}>}).blocks ?? []
        : findSnapshotBlock(projected, parentId)?.block.children ?? [];
      const at = projectedTarget.length - beforeLength === built.length
        ? projectedTarget.findIndex((block) => block.id?.startsWith('__ai_insert__-'))
        : -1;
      if (at < 0) throw new Error('could not resolve the insertion position');
      built.forEach((block, offset) => insertBlock(doc, target, at + offset, block));
    } else if (p.kind === 'delete_block') {
      const id = String(payload.blockId);
      const found = findBlock(doc, id);
      // Delete through the model's removeBlock (prunes empty columns, keeps the
      // doc non-empty), and honor the table rule: a table that would lose its
      // LAST row — or the only cell of its only row — is removed WHOLE, matching
      // the editor's tableDeleteRow/tableDeleteColumn (a table can't be rowless).
      if (found) removeBlock(doc, tableDeleteTarget(doc, found) ?? id);
    } else if (p.kind === 'set_block_props') {
      const found = findBlock(doc, String(payload.blockId));
      if (found) {
        patchBlock(found.block, {
          type: typeof payload.type === 'string' ? payload.type : undefined,
          props: payload.props && typeof payload.props === 'object' ? (payload.props as Record<string, unknown>) : undefined,
        });
      }
    } else if (isTableProposalKind(p.kind)) {
      // Table structure ops delegate to the editor's own model ops. Each opens a
      // nested `doc.transact`, which Yjs folds into this one — so the proposal is
      // still a single undo step. Validation runs BEFORE any mutation, so a
      // rejected op leaves the document (and this transaction) untouched.
      applyTableProposalToDoc(doc, p.kind, payload);
    }
  }, 'local');
};

/** Apply a per-page appearance proposal (theme + optional cover gradient). */
const applyPageAppearance = (pageId: string, payload: Record<string, unknown>): void => {
  if (payload.theme && typeof payload.theme === 'object') {
    // Merge over any existing override so we only change the named knobs.
    writePageTheme(pageId, {...readPageTheme(pageId), ...(payload.theme as AppearanceOverride)});
  }
  if (typeof payload.coverGradientId === 'string' && payload.coverGradientId) {
    const gradient = COVER_GRADIENTS.find((c) => c.id === payload.coverGradientId);
    if (gradient) writePageCover(pageId, {kind: 'gradient', css: gradient.css});
  }
};

/** Fallback: fetch, mutate the stored snapshot's block doc, and save. */
const applyToStoredPage = async (client: ApplyClient, pageId: string, p: AgentProposal): Promise<void> => {
  const page = await client.getPage(pageId);
  if (!page) throw new Error('page not found');
  const blockdoc = page.data.blockdoc as BlockDocSnapshot | undefined;
  // Rebuild a Y.Doc from the stored snapshot, mutate it, re-encode. This keeps
  // the CRDT history coherent for the next reader rather than hand-editing the
  // JSON projection.
  const doc = decodeSnapshot(blockdoc);
  applyProposalToDoc(doc, p);
  await client.savePage({
    id: page.id,
    name: page.name,
    data: {...page.data, editor: 'blocks', blockdoc: encodeSnapshot(doc)},
  });
};

/**
 * Apply ONE proposal (CRDT-first, server fallback). DB cells are page
 * properties (never in the editor CRDT); appearance is a per-page localStorage
 * preference; everything else mutates the block doc — live when the page's
 * editor is mounted, otherwise the stored snapshot.
 */
export const applyProposal = async (client: ApplyClient, p: AgentProposal): Promise<void> => {
  const payload = p.payload;
  if (p.kind === 'set_db_cell') {
    // DB cells are manual page properties — never in the editor CRDT.
    await client.updateRow(String(payload.databaseId), String(payload.rowId), {
      properties: {[String(payload.propertyId)]: payload.value},
    });
    return;
  }

  const pageId = String(payload.pageId ?? p.pageId ?? '');
  if (!pageId) throw new Error('proposal has no target page');

  if (p.kind === 'set_page_theme') {
    // Appearance is a per-page viewing preference (localStorage), not CRDT
    // content — apply it directly here on the client.
    applyPageAppearance(pageId, payload);
    return;
  }

  const liveDoc = getBlockEditorDoc(pageId);
  if (liveDoc) {
    applyProposalToDoc(liveDoc, p);
    return;
  }
  // No live editor — mutate the stored snapshot and save (merged on reopen).
  await applyToStoredPage(client, pageId, p);
};

// ── Agent-edits policy router (AGED-4) ──────────────────────────────────────────

/** The outcome of routing a batch of AI suggestions through the resolved policy. */
export interface AiSuggestionRouting {
  /** How many suggestions were applied directly (and their review rows removed). */
  applied: number;
  /** Suggestions kept for human review (resolved policy was `suggest`). */
  suggested: StoredSuggestion[];
  /** Direct applies that threw — their review rows are left intact. */
  failed: Array<{id: string; error: string}>;
}

/** The data-client surface the policy router needs (on top of {@link ApplyClient}). */
export type PolicyClient = Pick<DataClient, 'getInstanceInfo' | 'getPageAgentEdits' | 'deleteSuggestion' | 'updateSuggestion'>;

/**
 * Route the built-in AI's proposed suggestions through the resolved agent-edits
 * policy (AGED-1 `resolveAgentEdits`). The built-in AI runs under the USER's own
 * session identity, so the server cannot tell its writes from a human's — the
 * suggest-vs-direct decision is therefore enforced HERE on the client, not by a
 * server gate.
 *
 *  - `direct` → apply immediately through the SAME editor-bridge path an accepted
 *    suggestion takes (live doc when open, stored snapshot otherwise) and DELETE
 *    the review row the server persisted optimistically, so no shadow suggestion
 *    lingers. Audit trail stays in edit_log + block authorship.
 *  - `suggest` → leave the suggestion for review (returned in `suggested`).
 *
 * Instance mode is instance-wide, so it's read ONCE per batch; the page policy
 * must bite immediately, so it's re-read per suggestion at apply time (never
 * cached). Any policy-read failure falls back to the safe `suggest` default.
 */
export async function routeAiSuggestions(
  client: ApplyClient & PolicyClient,
  suggestions: StoredSuggestion[],
): Promise<AiSuggestionRouting> {
  let instanceMode: AgentEditsMode | undefined;
  try {
    instanceMode = (await client.getInstanceInfo()).agentEdits;
  } catch {
    instanceMode = undefined; // pre-AGED / unreachable instance → resolve() defaults to 'suggest'
  }

  const suggested: StoredSuggestion[] = [];
  const failed: Array<{id: string; error: string}> = [];
  let applied = 0;

  for (const s of suggestions) {
    let mode: AgentEditsMode;
    try {
      mode = resolveAgentEdits(await client.getPageAgentEdits(s.pageId), instanceMode);
    } catch {
      mode = 'suggest'; // fail safe: keep for review if the page policy can't be read
    }
    if (mode !== 'direct') {
      suggested.push(s);
      continue;
    }
    try {
      // Attribution: a direct AI apply saves under the USER's session identity
      // (recorded in edit_log + block authorship) — the built-in AI has no
      // separate principal, and the server can't distinguish its write from a
      // human's. Acceptable for v1; the per-page override to 'suggest' is the
      // user's recourse if they want AI edits held for review.
      await applyProposal(client, suggestionToProposal(s));
      // The edit has LANDED (live doc mutated or savePage done). Commit the
      // applied count NOW — before touching the review row — so a failure while
      // cleaning up the row can never flip an already-applied edit to `failed`
      // (which would drop the count AND leave the row re-acceptable → duplicate
      // content on a re-accept of an `append_blocks` suggestion).
      applied += 1;
      // Direct mode leaves NO shadow suggestion. The server persisted this row
      // before the client resolved the policy (it can't know the resolution), so
      // remove it now — best-effort: if the delete fails, fall back to marking it
      // `accepted` so it can never re-surface as an open, re-acceptable card.
      try {
        await client.deleteSuggestion(s.id);
      } catch {
        try {
          await client.updateSuggestion(s.id, {status: 'accepted'});
        } catch {
          // Both row-cleanup paths failed. The edit already landed, so we do NOT
          // fail the apply; the row may briefly re-surface but the audit trail
          // (edit_log + block authorship) already reflects the applied change.
        }
      }
    } catch (err) {
      failed.push({id: s.id, error: err instanceof Error ? err.message : String(err)});
    }
  }
  return {applied, suggested, failed};
}

let bridge: AiBridgeImpl | null = null;
const subscribers = new Set<() => void>();

export const setAiBridge = (next: AiBridgeImpl | null): void => {
  bridge = next;
  subscribers.forEach((cb) => cb());
};

export const subscribeAiBridge = (cb: () => void): (() => void) => {
  subscribers.add(cb);
  return () => subscribers.delete(cb);
};

export const aiBridge = {
  ready: (): boolean => bridge?.ready() ?? false,
  complete: (text: string, onToken: (token: string) => void): Promise<string> =>
    bridge ? bridge.complete(text, onToken) : Promise.reject(new Error('AI not available')),
  tasks: (goal: string, context?: string): Promise<string[]> =>
    bridge ? bridge.tasks(goal, context) : Promise.reject(new Error('AI not available')),
  applyProposals: (proposals: AgentProposal[]): Promise<ProposalApplyResult> =>
    bridge ? bridge.applyProposals(proposals) : Promise.reject(new Error('AI not available')),
  applySuggestion: (suggestion: StoredSuggestion): Promise<void> =>
    bridge ? bridge.applySuggestion(suggestion) : Promise.reject(new Error('editor bridge not available')),
};
