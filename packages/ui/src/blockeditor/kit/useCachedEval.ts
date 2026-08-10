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
  const snapshot = useSyncExternalStore(cache.subscribe, cache.getScopeSnapshot, cache.getScopeSnapshot);
  useEffect(() => cache.requestVersion(editor.version), [cache, editor.version]);
  return snapshot;
}

/** Read named input/container values from the cache (no live-code outputs). */
export function useCachedInputScope(editor: BlockEditorController): CachedInputScopeSnapshot {
  const cache = editor.evalCache;
  const snapshot = useSyncExternalStore(cache.subscribe, cache.getInputScopeSnapshot, cache.getInputScopeSnapshot);
  useEffect(() => cache.requestVersion(editor.version), [cache, editor.version]);
  return snapshot;
}

/** Read one core formula/live-code cell from the document scope cache. */
export function useCachedCell(editor: BlockEditorController, cellId: string, enabled = true): CachedEvalSnapshot {
  const cache = editor.evalCache;
  const getSnapshot = useCallback(() => cache.getCellSnapshot(cellId), [cache, cellId]);
  const snapshot = useSyncExternalStore(cache.subscribe, getSnapshot, getSnapshot);
  useEffect(() => {
    if (enabled) cache.requestVersion(editor.version);
  }, [cache, editor.version, enabled]);
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
  enabled = true,
): CachedEvalSnapshot {
  const cache = editor.evalCache;
  const getSnapshot = useCallback(() => cache.getCellSnapshot(cellId), [cache, cellId]);
  const snapshot = useSyncExternalStore(cache.subscribe, getSnapshot, getSnapshot);
  useEffect(() => {
    if (!enabled) return;
    cache.requestCell(editor.version, cellId, source, kind);
    return () => cache.releaseCell(editor.version, cellId, source, kind);
  }, [cache, cellId, editor.version, kind, source, enabled]);
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
