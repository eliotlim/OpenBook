import {aiBridge} from '@/lib/aiBridge';
import {blockPlainText, blockText, findBlock, rootBlocks, walkBlocks} from './model';
import type {BlockEditorController} from './useBlockEditor';

/**
 * The block editor's AI actions, exposed as slash-menu commands when the
 * engine is ready (registered alongside the custom-block registry but kept
 * separate — these insert *content*, not block types).
 *
 *  - Continue writing: streams a completion of the document into the
 *    current block, token by token (the CRDT broadcasts each step, so
 *    collaborators watch the text arrive live).
 *  - Break into tasks: sends the current block's text (or the document) to
 *    the engine and inserts the returned steps as to-do blocks.
 */

/** Plain text of the document up to (and including) `blockId`. */
function textBefore(editor: BlockEditorController, blockId: string): string {
  const parts: string[] = [];
  for (const {block} of walkBlocks(rootBlocks(editor.doc))) {
    parts.push(blockPlainText(block));
    if ((block.get('id') as string) === blockId) break;
  }
  return parts.filter(Boolean).join('\n');
}

export interface AiSlashItem {
  id: string;
  label: string;
  hint: string;
  keywords: string;
  apply: (editor: BlockEditorController, blockId: string) => void;
}

export function aiSlashItems(): AiSlashItem[] {
  if (!aiBridge.ready()) return [];
  return [
    {
      id: 'ai-continue',
      label: 'Continue writing',
      hint: 'AI continues from here',
      keywords: 'ai continue write complete generate',
      apply: (editor, blockId) => {
        const context = textBefore(editor, blockId);
        const found = findBlock(editor.doc, blockId);
        const text = found && blockText(found.block);
        if (!text) return;
        void aiBridge
          .complete(context, (token) => {
            // Stream straight into the CRDT — every keystrokeless token is a
            // real edit, merged and broadcast like typing.
            editor.doc.transact(() => text.insert(text.length, token, {}), 'local');
            editor.requestCaret({blockId, offset: 'end'});
          })
          .catch((err) => {
            editor.doc.transact(() => text.insert(text.length, ` ⚠ ${err instanceof Error ? err.message : String(err)}`, {}), 'local');
          });
      },
    },
    {
      id: 'ai-tasks',
      label: 'Break into tasks',
      hint: 'AI drafts to-dos for this',
      keywords: 'ai tasks break down todo plan steps',
      apply: (editor, blockId) => {
        const found = findBlock(editor.doc, blockId);
        const goal = (found && blockPlainText(found.block).trim()) || textBefore(editor, blockId).slice(-500);
        if (!goal) return;
        void aiBridge
          .tasks(goal)
          .then((tasks) => {
            let after: string | null = blockId;
            for (const task of tasks) {
              after = editor.insertAfter(after, {type: 'todo', text: task});
            }
          })
          .catch((err) => {
            editor.insertAfter(blockId, {
              type: 'callout',
              text: `⚠ ${err instanceof Error ? err.message : String(err)}`,
              props: {variant: 'warn'},
            });
          });
      },
    },
  ];
}
