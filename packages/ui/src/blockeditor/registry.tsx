import type React from 'react';
import type {BlockMap, NewBlock} from './model';
import type {BlockEditorController} from './useBlockEditor';

/**
 * The custom-block extension point. Anything the core editor doesn't know
 * (reactive widgets, embeds, app-specific views) registers here: a renderer
 * keyed by block `type`, optionally with a slash-menu entry. The registry is
 * a module-level singleton — same pattern as the app's pageLinks bridge — so
 * registration works from any layer without threading React context.
 *
 * Custom blocks receive the raw block Y.Map and the editor controller; they
 * own their props via `blockProp`/`setBlockProp` (CRDT-synced like
 * everything else) and are rendered inside the standard row (gutter, drag,
 * selection all behave normally).
 */

export interface CustomBlockProps {
  block: BlockMap;
  editor: BlockEditorController;
  /**
   * Whether the DOCUMENT is read-only — a viewer who cannot write, or present
   * mode — regardless of whether this widget is still live.
   *
   * `editor.readOnly` cannot answer that question for a custom block. An
   * interactive widget on a read-only page is deliberately handed an editor
   * with `readOnly: false` so it stays operable for the reader (its state just
   * never persists), which means every block asking `editor.readOnly` sees
   * `false` on exactly the page where the answer matters. A widget that merely
   * moves a slider does not care; one that offers to WRITE somewhere else —
   * the ledger's "Correct this entry" is the first — has to be able to tell the
   * difference, or it advertises an action the reader cannot take.
   *
   * Read it as "may this reader change the document?", not "is this widget
   * frozen?" — for the latter, `editor.readOnly` is still the right question.
   */
  pageReadOnly: boolean;
}

export interface CustomBlockDef {
  /** The block `type` this renders (must not collide with core types). */
  type: string;
  render: React.FC<CustomBlockProps>;
  /** Optional slash-menu entry that inserts this block. */
  slash?: {
    label: string;
    hint: string;
    keywords: string;
    make: () => NewBlock;
    /** Slash-menu category. Built-ins set `interactive`; third-party blocks
     *  default to `extensions`. */
    group?: 'interactive' | 'extensions';
  };
}

const registry = new Map<string, CustomBlockDef>();
const subscribers = new Set<() => void>();

/** Monotonic version counter — increments on every register/unregister so
 *  `useSyncExternalStore` can detect changes cheaply. */
let registryVersion = 0;

export function registerCustomBlock(def: CustomBlockDef): () => void {
  registry.set(def.type, def);
  registryVersion += 1;
  subscribers.forEach((cb) => cb());
  return () => {
    if (registry.get(def.type) === def) {
      registry.delete(def.type);
      registryVersion += 1;
      subscribers.forEach((cb) => cb());
    }
  };
}

/** Snapshot for `useSyncExternalStore` — returns the current version counter. */
export const getRegistrySnapshot = (): number => registryVersion;

export const getCustomBlock = (type: string): CustomBlockDef | undefined => registry.get(type);

/** Every registered custom block type id (drift-guard tests enumerate this
 *  against the SDK block-type catalogue). */
export const registeredBlockTypes = (): string[] => [...registry.keys()];

export const customSlashItems = (): CustomBlockDef[] => [...registry.values()].filter((d) => d.slash);

export const subscribeRegistry = (cb: () => void): (() => void) => {
  subscribers.add(cb);
  return () => subscribers.delete(cb);
};
