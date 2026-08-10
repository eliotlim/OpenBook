import type {PageSnapshot} from '@book.dev/sdk';
import type * as Y from 'yjs';
import {projectSnapshotForExport} from './exportBlocks';
import {encodeSnapshot} from './model';
import {computeExportCells} from './kit/scope';

/**
 * Build the durable block-page snapshot from one exact Y.Doc state.
 *
 * This is separate from the render cache: save and export are explicit
 * checkpoints whose persisted values come from this exact document through
 * the sandbox, never from a potentially stale UI snapshot.
 */
export function projectBlockPageSnapshot(doc: Y.Doc, base: PageSnapshot): PageSnapshot {
  const computed = computeExportCells(doc);
  const projected = projectSnapshotForExport(
    {...base, editor: 'blocks', blockdoc: encodeSnapshot(doc)},
    undefined,
    computed,
  );
  const values = new Map(projected.values);
  for (const [, cellId] of projected.names) {
    if (values.has(cellId)) continue;
    const cell = computed.get(cellId);
    if (cell) values.set(cellId, cell.value);
  }
  return {...projected, values: [...values]};
}
