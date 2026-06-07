import React, {useCallback, useState} from 'react';
import {ArrowDown, ArrowUp, AppWindow, Copy, ExternalLink, FilePlus2, Table2, Trash2} from 'lucide-react';
import type EditorJS from '@editorjs/editorjs';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import {useConfirm, useNavigation} from '@/providers';

/**
 * The right-click actions for a page, shared by the sidebar tree rows and the
 * page body. Rendered inside a {@link ContextMenuContent}.
 */
export function PageMenuItems({pageId}: {pageId: string}) {
  const {openInNew, createSubpage, deletePage, selectPage} = useNavigation();
  const confirm = useConfirm();

  const onDelete = useCallback(async () => {
    const ok = await confirm({
      title: 'Move this page to the trash?',
      description: 'You can restore it later from the trash.',
      confirmText: 'Move to trash',
      destructive: true,
    });
    if (ok) void deletePage(pageId);
  }, [confirm, deletePage, pageId]);

  return (
    <>
      <ContextMenuItem onSelect={() => openInNew(pageId, 'tab')}>
        <ExternalLink className="mr-2 h-4 w-4" />
        Open in new tab
      </ContextMenuItem>
      <ContextMenuItem onSelect={() => openInNew(pageId, 'window')}>
        <AppWindow className="mr-2 h-4 w-4" />
        Open in new window
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onSelect={() => void createSubpage(pageId, 'page').then(selectPage)}>
        <FilePlus2 className="mr-2 h-4 w-4" />
        Add subpage
      </ContextMenuItem>
      <ContextMenuItem onSelect={() => void createSubpage(pageId, 'database').then(selectPage)}>
        <Table2 className="mr-2 h-4 w-4" />
        Add database
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onSelect={() => void onDelete()} className="text-destructive focus:text-destructive">
        <Trash2 className="mr-2 h-4 w-4" />
        Move to trash
      </ContextMenuItem>
    </>
  );
}

/**
 * Right-click actions for a single editor block, driven by the EditorJS block
 * API. These mutations fire `block-moved` / `block-added` / `block-removed`,
 * which the document treats as persist-worthy edits, so the change autosaves.
 */
export function BlockMenuItems({
  editorRef,
  blockId,
}: {
  editorRef: React.RefObject<EditorJS | null>;
  blockId: string;
}) {
  const indexOf = (): number => editorRef.current?.blocks.getBlockIndex(blockId) ?? -1;

  const moveUp = () => {
    const inst = editorRef.current;
    const i = indexOf();
    if (inst && i > 0) inst.blocks.move(i - 1, i);
  };

  const moveDown = () => {
    const inst = editorRef.current;
    const i = indexOf();
    if (inst && i >= 0 && i < inst.blocks.getBlocksCount() - 1) inst.blocks.move(i + 1, i);
  };

  const duplicate = async () => {
    const inst = editorRef.current;
    const i = indexOf();
    if (!inst || i < 0) return;
    const saved = await inst.blocks.getById(blockId)?.save();
    if (!saved) return;
    inst.blocks.insert(saved.tool, saved.data, undefined, i + 1, false);
  };

  const remove = () => {
    const inst = editorRef.current;
    const i = indexOf();
    if (inst && i >= 0) inst.blocks.delete(i);
  };

  return (
    <>
      <ContextMenuItem onSelect={moveUp}>
        <ArrowUp className="mr-2 h-4 w-4" />
        Move up
      </ContextMenuItem>
      <ContextMenuItem onSelect={moveDown}>
        <ArrowDown className="mr-2 h-4 w-4" />
        Move down
      </ContextMenuItem>
      <ContextMenuItem onSelect={() => void duplicate()}>
        <Copy className="mr-2 h-4 w-4" />
        Duplicate
      </ContextMenuItem>
      <ContextMenuItem onSelect={remove} className="text-destructive focus:text-destructive">
        <Trash2 className="mr-2 h-4 w-4" />
        Delete block
      </ContextMenuItem>
    </>
  );
}

/**
 * Wrap the page body so right-clicking it opens a context menu. When `editorRef`
 * is supplied and the click lands on an editor block (`.ce-block`), block
 * actions are shown above the page actions; clicking empty space (or any page
 * without an editor) shows the page actions alone. The sidebar tree wires
 * {@link PageMenuItems} in directly.
 */
export function PageContextMenu({
  pageId,
  editorRef,
  children,
}: {
  pageId: string;
  editorRef?: React.RefObject<EditorJS | null>;
  children: React.ReactNode;
}) {
  const [blockId, setBlockId] = useState<string | null>(null);

  const onContextMenu = (e: React.MouseEvent) => {
    if (!editorRef) {
      setBlockId(null);
      return;
    }
    const block = (e.target as HTMLElement).closest('.ce-block');
    setBlockId(block?.getAttribute('data-id') ?? null);
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div className="contents" onContextMenu={onContextMenu}>
          {children}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-52">
        {editorRef && blockId && (
          <>
            <BlockMenuItems editorRef={editorRef} blockId={blockId} />
            <ContextMenuSeparator />
          </>
        )}
        <PageMenuItems pageId={pageId} />
      </ContextMenuContent>
    </ContextMenu>
  );
}
