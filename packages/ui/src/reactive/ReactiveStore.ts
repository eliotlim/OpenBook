import {signal, type Signal} from '@preact/signals-core';

/**
 * ReactiveStore — cellId-keyed reactive store for OpenBook v0 reactive blocks.
 *
 *  Cell identity contract:
 *  ┌──────────────────────────────────────────────────────────────────┐
 *  │  cellId  →  Signal<unknown>     (stable identity, never dropped) │
 *  │  cellId  ↔  name                (1:1 via two maps, mutable)      │
 *  └──────────────────────────────────────────────────────────────────┘
 *
 *  - Signal objects are stable by cellId for the life of the store. `deleteCell`
 *    sets the value to undefined and removes the cellId from the name index
 *    but does NOT drop the Signal object. This is required for React 18 +
 *    StrictMode (which double-mounts every component in dev): downstream
 *    effects that subscribed to a cellId keep their subscription valid across
 *    a block's unmount → remount cycle.
 *  - `getByCellId` lazy-creates a Signal at undefined if the cellId is unknown.
 *    This is how cold-start ordering works without a DAG: a consumer that
 *    reads a not-yet-set cellId subscribes to the empty Signal, then
 *    auto-re-fires when the first producer's setByCellId arrives.
 *  - JSON serialization tokenizes cellIds as strings (Map → array of pairs).
 */
export class ReactiveStore {
  private valueByCellId = new Map<string, Signal<unknown>>();
  private cellIdByName = new Map<string, string>();
  private nameByCellId = new Map<string, string>();
  // Bumped whenever the name index changes. ExprBlock components subscribe to
  // this signal so their contenteditable re-renders token-span display names
  // when a rename happens elsewhere.
  readonly namesVersion: Signal<number> = signal(0);

  private ensureSignal(cellId: string): Signal<unknown> {
    let s = this.valueByCellId.get(cellId);
    if (s === undefined) {
      s = signal<unknown>(undefined);
      this.valueByCellId.set(cellId, s);
    }
    return s;
  }

  // --- cellId-keyed primary API ---

  setByCellId(cellId: string, value: unknown): void {
    this.ensureSignal(cellId).value = value;
  }

  /**
   * Reads the value at cellId, lazy-creating an undefined-valued Signal if
   * the cellId is new. Auto-subscribes the calling reactive scope to this
   * cellId via `@preact/signals-core`'s tracking.
   */
  getByCellId(cellId: string): unknown {
    return this.ensureSignal(cellId).value;
  }

  /**
   * Clears the value at cellId to undefined and removes the cellId from the
   * name index. The Signal object itself is RETAINED — see class doc for why.
   */
  deleteCell(cellId: string): void {
    const s = this.valueByCellId.get(cellId);
    if (s !== undefined) {
      s.value = undefined;
    }
    const name = this.nameByCellId.get(cellId);
    if (name !== undefined) {
      this.nameByCellId.delete(cellId);
      // Only delete the name → cellId mapping if it still points here. A
      // setName call may have re-pointed the name elsewhere; we must not
      // clobber that.
      if (this.cellIdByName.get(name) === cellId) {
        this.cellIdByName.delete(name);
      }
      this.namesVersion.value = this.namesVersion.value + 1;
    }
  }

  // --- name index ---

  setName(cellId: string, name: string): void {
    const previousName = this.nameByCellId.get(cellId);
    if (previousName === name) return;
    // Remove old reverse mapping, if any.
    if (previousName !== undefined && this.cellIdByName.get(previousName) === cellId) {
      this.cellIdByName.delete(previousName);
    }
    // If some other cellId currently owns this name, evict it (last-writer
    // wins). Its block will get undefined from any lookup-by-name and the
    // user will see the broken reference. v0 cuts: no rename collision UX.
    const previousOwner = this.cellIdByName.get(name);
    if (previousOwner !== undefined && previousOwner !== cellId) {
      this.nameByCellId.delete(previousOwner);
    }
    this.cellIdByName.set(name, cellId);
    this.nameByCellId.set(cellId, name);
    this.namesVersion.value = this.namesVersion.value + 1;
  }

  getName(cellId: string): string | undefined {
    return this.nameByCellId.get(cellId);
  }

  getIdByName(name: string): string | undefined {
    return this.cellIdByName.get(name);
  }

  // --- serialization ---

  snapshot(): {values: Array<[string, unknown]>; names: Array<[string, string]>} {
    const values: Array<[string, unknown]> = [];
    for (const [cellId, s] of this.valueByCellId) {
      values.push([cellId, s.value]);
    }
    const names: Array<[string, string]> = [];
    for (const [name, cellId] of this.cellIdByName) {
      names.push([name, cellId]);
    }
    return {values, names};
  }

  hydrate(snap: {values: Array<[string, unknown]>; names: Array<[string, string]>}): void {
    // Clear current state without dropping any existing Signal identities.
    // (In a fresh store there are none to preserve; in a re-hydrate scenario
    // we still want to keep Signal identity stable.)
    for (const [cellId] of this.valueByCellId) {
      this.ensureSignal(cellId).value = undefined;
    }
    this.cellIdByName.clear();
    this.nameByCellId.clear();
    for (const [cellId, value] of snap.values) {
      this.ensureSignal(cellId).value = value;
    }
    for (const [name, cellId] of snap.names) {
      this.cellIdByName.set(name, cellId);
      this.nameByCellId.set(cellId, name);
    }
    this.namesVersion.value = this.namesVersion.value + 1;
  }
}

// Module-level singleton. All blocks and the persistence layer import this.
export const store = new ReactiveStore();
