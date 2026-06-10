import {useEffect, useMemo, useRef, useState, useSyncExternalStore} from 'react';
import * as Y from 'yjs';
import {
  blockText,
  blockToJSON,
  blockType,
  findBlock,
  insertBlock,
  makeBlock,
  mergeWithPrevious,
  moveBlock,
  removeBlock,
  rootBlocks,
  splitBlock,
  TEXT_BLOCKS,
  turnInto,
  walkBlocks,
  type BlockMap,
  type BlockType,
  type NewBlock,
} from './model';

/**
 * The editor's working state around a Y.Doc: one version counter that bumps
 * on every doc update (the whole tree re-renders; text blocks themselves
 * diff against the DOM so unchanged blocks are no-ops), an undo manager
 * scoped to local edits, a "pending focus" hand-off for structural edits
 * (split/merge/insert decide where the caret lands *after* React re-renders),
 * and the block-level selection used for multi-block operations.
 */

export interface CaretRequest {
  blockId: string;
  /** Linear offset, or 'end'. */
  offset: number | 'end';
}

export interface BlockEditorController {
  doc: Y.Doc;
  version: number;
  /** Undo/redo over local edits (a live wrapper — see useBlockEditor). */
  undo: {undo(): void; redo(): void};
  readOnly: boolean;

  /** Set by structural ops; consumed by the focused block after render. */
  pendingCaret: React.MutableRefObject<CaretRequest | null>;
  requestCaret(req: CaretRequest): void;

  /** Block-level selection (ids), for multi-block ops. */
  selection: ReadonlySet<string>;
  setSelection(ids: Iterable<string>): void;
  clearSelection(): void;

  /** The id of the text block that currently owns the DOM caret. */
  focusedId: string | null;
  setFocusedId(id: string | null): void;

  // Structural operations (each leaves the caret somewhere sensible).
  splitAt(blockId: string, offset: number): void;
  mergeUp(blockId: string): void;
  insertAfter(blockId: string | null, block: NewBlock): string | null;
  removeSelected(): void;
  turnInto(blockId: string, type: BlockType, props?: Record<string, unknown>): void;
  duplicateSelected(): void;
  moveSelected(delta: -1 | 1): void;

  /** Ordered top-level traversal of text blocks (arrow navigation). */
  textBlockIds(): string[];
}

export function useBlockEditor(doc: Y.Doc, readOnly = false): BlockEditorController {
  const [, force] = useState(0);
  const versionRef = useRef(0);

  const subscribe = useMemo(() => {
    return (cb: () => void) => {
      const handler = (): void => {
        versionRef.current += 1;
        cb();
      };
      doc.on('update', handler);
      return () => doc.off('update', handler);
    };
  }, [doc]);
  const version = useSyncExternalStore(
    subscribe,
    () => versionRef.current,
    () => versionRef.current,
  );

  // The UndoManager lives in an effect: StrictMode's mount-cycle cleanup
  // would otherwise destroy a useMemo-created instance and leave the editor
  // holding a dead manager (undoStack frozen at 0). The controller exposes a
  // stable wrapper that always talks to the live instance.
  const undoRef = useRef<Y.UndoManager | null>(null);
  useEffect(() => {
    const manager = new Y.UndoManager(rootBlocks(doc), {
      trackedOrigins: new Set(['local']),
      captureTimeout: 400,
    });
    undoRef.current = manager;
    return () => {
      manager.destroy();
      if (undoRef.current === manager) undoRef.current = null;
    };
  }, [doc]);
  const undo = useMemo(
    () => ({
      undo: () => undoRef.current?.undo(),
      redo: () => undoRef.current?.redo(),
    }),
    [],
  );

  const pendingCaret = useRef<CaretRequest | null>(null);
  const [selection, setSelectionState] = useState<ReadonlySet<string>>(new Set());
  const [focusedId, setFocusedId] = useState<string | null>(null);

  return useMemo<BlockEditorController>(() => {
    const requestCaret = (req: CaretRequest): void => {
      pendingCaret.current = req;
      force((n) => n + 1); // ensure a render even if the doc didn't change
    };

    const setSelection = (ids: Iterable<string>): void => setSelectionState(new Set(ids));

    const orderedIds = (): string[] => {
      const ids: string[] = [];
      for (const {block} of walkBlocks(rootBlocks(doc))) ids.push(block.get('id') as string);
      return ids;
    };

    return {
      doc,
      version,
      undo,
      readOnly,
      pendingCaret,
      requestCaret,
      selection,
      setSelection,
      clearSelection: () => setSelectionState(new Set()),
      focusedId,
      setFocusedId,

      splitAt(blockId, offset) {
        const newId = splitBlock(doc, blockId, offset);
        if (newId) requestCaret({blockId: newId, offset: 0});
      },

      mergeUp(blockId) {
        const found = findBlock(doc, blockId);
        if (!found) return;
        // A non-paragraph at its start first downgrades to a paragraph; a
        // second Backspace then merges — mirrors how block editors feel.
        const type = blockType(found.block);
        if (type !== 'paragraph' && type !== 'cell' && type !== 'code' && TEXT_BLOCKS.has(type)) {
          turnInto(doc, blockId, 'paragraph');
          requestCaret({blockId, offset: 0});
          return;
        }
        const merged = mergeWithPrevious(doc, blockId);
        if (merged) requestCaret({blockId: merged.id, offset: merged.offset});
      },

      insertAfter(blockId, block) {
        if (blockId === null) {
          const id = insertBlock(doc, rootBlocks(doc), rootBlocks(doc).length, block);
          requestCaret({blockId: id, offset: 0});
          return id;
        }
        const found = findBlock(doc, blockId);
        if (!found) return null;
        const id = insertBlock(doc, found.parent, found.index + 1, block);
        requestCaret({blockId: id, offset: 0});
        return id;
      },

      removeSelected() {
        if (selection.size === 0) return;
        const all = orderedIds();
        const first = all.find((id) => selection.has(id));
        doc.transact(() => {
          for (const id of selection) removeBlock(doc, id);
        }, 'local');
        setSelectionState(new Set());
        // Land the caret on the block that took the deleted range's place.
        const after = orderedIds();
        const anchor = first ? after[Math.min(all.indexOf(first), after.length - 1)] : after[0];
        if (anchor) requestCaret({blockId: anchor, offset: 0});
      },

      turnInto(blockId, type, props) {
        turnInto(doc, blockId, type, props);
        requestCaret({blockId, offset: 'end'});
      },

      duplicateSelected() {
        if (selection.size === 0) return;
        doc.transact(() => {
          // Duplicate each selected block right below itself (fresh ids).
          for (const id of [...selection]) {
            const found = findBlock(doc, id);
            if (!found) continue;
            const json = JSON.parse(JSON.stringify(toNewBlock(found.block)));
            stripIds(json);
            found.parent.insert(found.index + 1, [makeFrom(json)]);
          }
        }, 'local');
      },

      moveSelected(delta) {
        if (selection.size !== 1) return;
        const id = [...selection][0];
        const found = findBlock(doc, id);
        if (!found) return;
        const to = found.index + (delta === 1 ? 2 : -1);
        if (to < 0 || to > found.parent.length) return;
        // moveBlock interprets the index without the moved block.
        moveWithin(doc, id, delta === 1 ? found.index + 1 : found.index - 1);
      },

      textBlockIds() {
        const ids: string[] = [];
        for (const {block} of walkBlocks(rootBlocks(doc))) {
          if (TEXT_BLOCKS.has(blockType(block)) && blockText(block)) ids.push(block.get('id') as string);
        }
        return ids;
      },
    };
  }, [doc, version, undo, readOnly, selection, focusedId]);
}

// Helpers kept module-local (the controller stays a plain object).

function toNewBlock(b: BlockMap): NewBlock {
  return blockToJSON(b) as unknown as NewBlock;
}

function stripIds(node: {id?: string; children?: unknown[]}): void {
  delete node.id;
  (node.children as {id?: string; children?: unknown[]}[] | undefined)?.forEach(stripIds);
}

function makeFrom(json: NewBlock): BlockMap {
  return makeBlock(json);
}

function moveWithin(doc: Y.Doc, id: string, toIndex: number): void {
  const found = findBlock(doc, id);
  if (!found) return;
  const parent = found.parent;
  const parentBlock = parentIdOf(doc, parent);
  moveBlock(doc, id, parentBlock, toIndex);
}

function parentIdOf(doc: Y.Doc, arr: Y.Array<BlockMap>): string | null {
  if (arr === rootBlocks(doc)) return null;
  for (const {block} of walkBlocks(rootBlocks(doc))) {
    if ((block.get('children') as Y.Array<BlockMap> | undefined) === arr) return block.get('id') as string;
  }
  return null;
}
