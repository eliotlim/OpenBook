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

export function registerCustomBlock(def: CustomBlockDef): () => void {
  registry.set(def.type, def);
  subscribers.forEach((cb) => cb());
  return () => {
    if (registry.get(def.type) === def) {
      registry.delete(def.type);
      subscribers.forEach((cb) => cb());
    }
  };
}

export const getCustomBlock = (type: string): CustomBlockDef | undefined => registry.get(type);

export const customSlashItems = (): CustomBlockDef[] => [...registry.values()].filter((d) => d.slash);

export const subscribeRegistry = (cb: () => void): (() => void) => {
  subscribers.add(cb);
  return () => subscribers.delete(cb);
};
