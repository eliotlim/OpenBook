import React from 'react';
import {blockProp} from '@/blockeditor/model';
import {registerCustomBlock, type CustomBlockProps} from '@/blockeditor/registry';
import {DatabaseView} from './DatabaseView';

/**
 * The block editor's **inline database** block (`dbview`): embeds a live
 * {@link DatabaseView} for an existing database page, right inside the
 * document. The "Link to database" command inserts one (referencing the chosen
 * database's hosting page id).
 *
 * The block editor renders custom blocks inside the main React tree (and thus
 * inside the data/navigation providers), so the view renders here directly.
 */
const DbViewBlock: React.FC<CustomBlockProps> = ({block}) => {
  const pageId = blockProp<string>(block, 'pageId');
  if (!pageId) {
    return (
      <div className="obe-unknown" contentEditable={false}>
        No database linked
      </div>
    );
  }
  return (
    <div className="obe-dbview" contentEditable={false}>
      <DatabaseView pageId={pageId} inline />
    </div>
  );
};

/** Register the inline database block. Called from BlockPageDocument, where the
 *  data/navigation providers the embedded view needs are in scope. */
export function registerDatabaseBlock(): void {
  registerCustomBlock({type: 'dbview', render: DbViewBlock});
}
