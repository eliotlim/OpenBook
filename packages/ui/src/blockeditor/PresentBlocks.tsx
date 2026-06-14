import React, {useMemo} from 'react';
import * as Y from 'yjs';
import {BlockRow, type EditorUI, type RowShared} from './BlockEditor';
import {KitLockContext} from './kit/lock';
import {useBlockEditor} from './useBlockEditor';
import {blockId, type BlockMap} from './model';

/** Slash/mention start closed; present-mode text is locked so they never open. */
const CLOSED: EditorUI['slash'] = {open: false, blockId: '', anchorOffset: 0, query: '', index: 0};

/** A no-op editor UI for the read-only present surface. */
const READONLY_UI: EditorUI = {
  slash: CLOSED,
  mention: CLOSED,
  spellcheck: false,
  openSlash() {},
  updateSlash() {},
  closeSlash() {},
  slashKey() {},
  openMention() {},
  updateMention() {},
  closeMention() {},
  mentionKey() {},
  toggleFormat() {},
  scheduleToolbar() {},
};

/**
 * Render a list of blocks from a page's live doc, read-only but with interactive
 * widgets still operable — the surface Present mode uses for slides, the next-
 * slide preview, and the speaker-notes panel.
 *
 * It reuses the editor's {@link BlockRow} (every block type, widgets, reactivity)
 * inside a locked {@link KitLockContext}: `BlockBody` makes text and structure
 * read-only while widgets carrying `interactive` (the default) stay live.
 * Reactivity is doc-global (`computeScope` reads the doc), so charts and formulas
 * track widget changes across the whole deck. Editing chrome (gutters, the kit
 * gear, slash) is hidden by `.ob-present` CSS.
 */
export const PresentBlocks: React.FC<{doc: Y.Doc; blocks: BlockMap[]; className?: string}> = ({
  doc,
  blocks,
  className,
}) => {
  const editor = useBlockEditor(doc, false);
  const shared = useMemo<RowShared>(
    () => ({
      editor,
      ui: READONLY_UI,
      drag: null,
      setDrag: (() => undefined) as RowShared['setDrag'],
      performDrop: () => undefined,
      computeRegion: () => 'below',
      depth: 0,
      container: null,
    }),
    [editor],
  );
  return (
    <KitLockContext.Provider value={{locked: true}}>
      <div className={['obe-present-blocks', className].filter(Boolean).join(' ')}>
        {blocks.map((b) => (
          <BlockRow key={blockId(b)} block={b} {...shared} />
        ))}
      </div>
    </KitLockContext.Provider>
  );
};

export default PresentBlocks;
