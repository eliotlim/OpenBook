import type * as Y from 'yjs';
import {
  captureScopeProgram,
  evaluateScopeProgram,
  newFunctionEvalBackend,
  type ComputedScope,
  type EvalBackend,
  type EvalRequest,
  type EvalResult,
} from './scope';

/** A synchronously readable external-store snapshot. While `pending`, `value`
 * is the last completed document scope (when one exists). */
export interface CachedScopeSnapshot {
  value?: ComputedScope;
  error?: string;
  pending: boolean;
  version: number;
}

export interface CachedInputScopeSnapshot {
  value?: Record<string, unknown>;
  pending: boolean;
  version: number;
}

/** A per-cell external-store snapshot. A version change retains the previous
 * result while the replacement is pending, so render never waits on eval. */
export interface CachedEvalSnapshot extends EvalResult {
  pending: boolean;
  version: number;
}

interface CellRequest {
  version: number;
  kind: EvalRequest['kind'];
  source: string;
  runGeneration?: number;
}

const INITIAL_SCOPE: CachedScopeSnapshot = {pending: true, version: -1};
const INITIAL_INPUT_SCOPE: CachedInputScopeSnapshot = {pending: true, version: -1};
const INITIAL_CELL: CachedEvalSnapshot = {pending: true, version: -1};

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

/**
 * Version-keyed reactive evaluation cache. React consumers subscribe with
 * `useSyncExternalStore`; all document and expression evaluation starts from
 * effects/event handlers and completes asynchronously through `EvalBackend`.
 */
export class ReactiveEvalCache {
  private readonly listeners = new Set<() => void>();
  private readonly cellSnapshots = new Map<string, CachedEvalSnapshot>();
  private readonly cellRequests = new Map<string, CellRequest>();
  private scopeSnapshot: CachedScopeSnapshot = INITIAL_SCOPE;
  private inputScopeSnapshot: CachedInputScopeSnapshot = INITIAL_INPUT_SCOPE;
  private requestedVersion = -1;
  private generation = 0;
  private disposed = false;
  private disposePending = false;

  constructor(
    private readonly doc: Y.Doc,
    private readonly backend: EvalBackend = newFunctionEvalBackend,
  ) {}

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getScopeSnapshot = (): CachedScopeSnapshot => this.scopeSnapshot;

  readonly getInputScopeSnapshot = (): CachedInputScopeSnapshot => this.inputScopeSnapshot;

  getCellSnapshot = (cellId: string): CachedEvalSnapshot => this.cellSnapshots.get(cellId) ?? INITIAL_CELL;

  /** React StrictMode replays effect setup after cleanup on the same instance —
   * but child effects run before parent effects on BOTH the simulated
   * teardown and the remount, so a consumer's remount-effect (e.g.
   * `useCachedCell`'s `requestVersion`) can fire before this controller's own
   * `activate()` clears `disposed`. Cancels a pending `dispose()` so that
   * request isn't silently dropped — see `dispose()`. */
  activate(): void {
    this.disposePending = false;
    this.disposed = false;
  }

  /** Request the current document version. Repeated reads of one version share
   * one ordered scope pass (the SBX-0 memo guarantee, now asynchronous). */
  requestVersion(version: number): void {
    if (this.disposed || version <= this.requestedVersion) return;
    this.startVersion(version);
  }

  /** Explicit rerun for the code block's Run command, without a document edit. */
  refresh(version: number): void {
    if (this.disposed || version < this.requestedVersion) return;
    this.startVersion(version);
  }

  /** Register/update an expression consumer. `cellId` is the stable block id,
   * making its cache entry specific to (document version, cell). */
  requestCell(version: number, cellId: string, source: string, kind: EvalRequest['kind'] = 'expression'): void {
    if (this.disposed) return;
    this.requestVersion(version);
    const current = this.cellRequests.get(cellId);
    if (current?.version === version && current.kind === kind && current.source === source) return;

    const request: CellRequest = {version, kind, source};
    this.cellRequests.set(cellId, request);
    const previous = this.cellSnapshots.get(cellId);
    this.cellSnapshots.set(cellId, {...previous, pending: true, version});
    this.emit();
    this.runCell(cellId, request);
  }

  /** Stop recomputing a render-only expression after its consumer unmounts or
   * switches to a non-expression mode. Identity guards protect a newer request
   * from an older effect cleanup. */
  releaseCell(version: number, cellId: string, source: string, kind: EvalRequest['kind'] = 'expression'): void {
    const current = this.cellRequests.get(cellId);
    if (current?.version === version && current.source === source && current.kind === kind) this.cellRequests.delete(cellId);
  }

  /**
   * Deferred by one microtask, not synchronous. On initial mount React 18
   * StrictMode simulates an immediate unmount + remount of this same
   * instance (`useBlockEditor`'s owning effect calls `dispose()` then
   * `activate()`), and effects fire child-before-parent on *both* passes.
   * That means a formula/live-code consumer's remount-effect can call
   * `requestVersion`/`requestCell` before this controller's own remount
   * effect reaches `activate()` — if `dispose()` set `disposed` synchronously,
   * that request would see the cache as disposed and silently no-op, with
   * nothing left to retry it: a freshly loaded, never-edited page never fires
   * another document update to trigger a second attempt (its formula stayed
   * "—" forever — the SBX-1 regression this method fixes). Deferring lets
   * `activate()` cancel a StrictMode-only teardown before it ever takes
   * effect; a genuine unmount (no matching `activate()`) still disposes, one
   * microtask later, same as before.
   */
  dispose(): void {
    this.disposePending = true;
    queueMicrotask(() => {
      if (!this.disposePending) return;
      this.disposed = true;
      this.requestedVersion = -1;
      this.generation += 1;
    });
  }

  private startVersion(version: number): void {
    this.requestedVersion = version;
    const generation = ++this.generation;
    this.scopeSnapshot = {...this.scopeSnapshot, error: undefined, pending: true, version};
    this.inputScopeSnapshot = {...this.inputScopeSnapshot, pending: true, version};
    for (const [id, snapshot] of this.cellSnapshots) {
      this.cellSnapshots.set(id, {...snapshot, pending: true, version});
    }
    this.emit();

    // Capture mutable Yjs state outside render, before the asynchronous backend
    // hop. A later document update gets a new generation and discards this run.
    const program = captureScopeProgram(this.doc);
    this.inputScopeSnapshot = {value: program.input, pending: false, version};
    this.emit();
    queueMicrotask(() => {
      if (this.disposed || generation !== this.generation) return;
      void evaluateScopeProgram(program, this.backend).then(
        (computed) => {
          if (this.disposed || generation !== this.generation) return;
          this.scopeSnapshot = {value: computed, pending: false, version};
          for (const [id, result] of computed.results) {
            this.cellSnapshots.set(id, {...result, pending: false, version});
          }
          this.emit();
          for (const [id, request] of this.cellRequests) this.runCell(id, request);
        },
        (error: unknown) => {
          if (this.disposed || generation !== this.generation) return;
          const message = errorMessage(error);
          this.scopeSnapshot = {...this.scopeSnapshot, error: message, pending: false, version};
          for (const [id, snapshot] of this.cellSnapshots) {
            this.cellSnapshots.set(id, {...snapshot, error: message, pending: false, version});
          }
          this.emit();
        },
      );
    });
  }

  private runCell(cellId: string, request: CellRequest): void {
    const scope = this.scopeSnapshot;
    const generation = this.generation;
    if (
      this.disposed
      || request.version !== this.requestedVersion
      || scope.pending
      || !scope.value
      || request.runGeneration === generation
    ) return;
    request.runGeneration = generation;
    void this.backend.evaluate({kind: request.kind, source: request.source, scope: scope.value.scope}).then(
      (result) => {
        if (
          this.disposed
          || generation !== this.generation
          || this.cellRequests.get(cellId) !== request
        ) return;
        this.cellSnapshots.set(cellId, {...result, pending: false, version: request.version});
        this.emit();
      },
      (error: unknown) => {
        if (
          this.disposed
          || generation !== this.generation
          || this.cellRequests.get(cellId) !== request
        ) return;
        this.cellSnapshots.set(cellId, {error: errorMessage(error), pending: false, version: request.version});
        this.emit();
      },
    );
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
