import {useCallback, useEffect, useMemo, useSyncExternalStore} from 'react';
import type * as Y from 'yjs';
import type {BlockEditorController} from '../useBlockEditor';
import {
  ReactiveEvalCache,
  type CachedEvalSnapshot,
  type CachedInputScopeSnapshot,
  type CachedScopeSnapshot,
} from './evalCache';
import type {EvalRequest} from './scope';

const EMPTY_SCOPE: CachedScopeSnapshot = {pending: true, version: -1};

/** Read the latest completed document scope without evaluating during render. */
export function useCachedScope(editor: BlockEditorController): CachedScopeSnapshot {
  const cache = editor.evalCache;
  return useSyncExternalStore(cache.subscribe, cache.getScopeSnapshot, cache.getScopeSnapshot);
}

/** Read named input/container values from the cache (no live-code outputs). */
export function useCachedInputScope(editor: BlockEditorController): CachedInputScopeSnapshot {
  const cache = editor.evalCache;
  return useSyncExternalStore(cache.subscribe, cache.getInputScopeSnapshot, cache.getInputScopeSnapshot);
}

/** Read one core formula/live-code cell from the document scope cache. */
export function useCachedCell(editor: BlockEditorController, cellId: string): CachedEvalSnapshot {
  const cache = editor.evalCache;
  const getSnapshot = useCallback(() => cache.getCellSnapshot(cellId), [cache, cellId]);
  const snapshot = useSyncExternalStore(cache.subscribe, getSnapshot, getSnapshot);
  useEffect(() => cache.requestVersion(editor.version), [cache, editor.version]);
  return snapshot;
}

/**
 * Async-or-cached render contract for an expression consumer.
 *
 * The returned `{value?, error?, pending, version}` is synchronously readable.
 * Registration/evaluation happens after render; while pending it retains the
 * last completed result for this cell when available.
 */
export function useCachedEval(
  editor: BlockEditorController,
  cellId: string,
  source: string,
  kind: EvalRequest['kind'] = 'expression',
): CachedEvalSnapshot {
  const cache = editor.evalCache;
  const getSnapshot = useCallback(() => cache.getCellSnapshot(cellId), [cache, cellId]);
  const snapshot = useSyncExternalStore(cache.subscribe, getSnapshot, getSnapshot);
  useEffect(() => cache.requestCell(editor.version, cellId, source, kind), [cache, cellId, editor.version, kind, source]);
  return snapshot;
}

/** Standalone document consumer (the dataflow pane has no editor controller). */
export function useDocumentCachedScope(doc: Y.Doc | undefined): CachedScopeSnapshot {
  const cache = useMemo(() => doc ? new ReactiveEvalCache(doc) : null, [doc]);
  const subscribe = useCallback((listener: () => void) => cache?.subscribe(listener) ?? (() => undefined), [cache]);
  const getSnapshot = useCallback(() => cache?.getScopeSnapshot() ?? EMPTY_SCOPE, [cache]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    if (!cache || !doc) return;
    cache.activate();
    let version = 0;
    const update = (): void => cache.requestVersion(++version);
    doc.on('update', update);
    cache.requestVersion(version);
    return () => {
      doc.off('update', update);
      cache.dispose();
    };
  }, [cache, doc]);

  return snapshot;
}
