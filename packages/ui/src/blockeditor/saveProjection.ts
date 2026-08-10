import type {PageSnapshot} from '@book.dev/sdk';
import type * as Y from 'yjs';
import {projectSnapshotForExport} from './exportBlocks';
import {encodeSnapshot} from './model';
import {computeScopeAuthoritative} from './kit/scope';

/**
 * Build the durable block-page snapshot from one exact Y.Doc state.
 *
 * This is intentionally synchronous and separate from the render cache: save
 * and export are explicit checkpoints whose persisted values must never depend
 * on whether an asynchronous UI evaluation has finished.
 */
export function projectBlockPageSnapshot(doc: Y.Doc, base: PageSnapshot): PageSnapshot {
  const projected = projectSnapshotForExport({...base, editor: 'blocks', blockdoc: encodeSnapshot(doc)});
  const values = new Map(projected.values);
  const {results} = computeScopeAuthoritative(doc);
  for (const [, cellId] of projected.names) {
    if (values.has(cellId)) continue;
    const result = results.get(cellId);
    if (result && !result.error) values.set(cellId, result.value);
  }
  return {...projected, values: [...values]};
}
