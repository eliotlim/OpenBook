import {describe, it, expect, afterEach} from 'vitest';
import {render, screen, cleanup} from '@testing-library/react';
import {registerDatabaseBlock} from '../InlineDatabaseBlock';
import {getCustomBlock} from '@/blockeditor/registry';
import {createDoc, rootBlocks, type BlockMap} from '@/blockeditor/model';
import type {BlockEditorController} from '@/blockeditor/useBlockEditor';

afterEach(() => cleanup());

describe('inline database block (dbview)', () => {
  it('registers a dbview custom block', () => {
    registerDatabaseBlock();
    expect(getCustomBlock('dbview')).toBeDefined();
  });

  it('shows a fallback when no database is linked', () => {
    registerDatabaseBlock();
    const Render = getCustomBlock('dbview')!.render;
    const doc = createDoc([{id: 'd', type: 'dbview', props: {}}]);
    const block: BlockMap = rootBlocks(doc).get(0);
    const editor = {doc, readOnly: false} as unknown as BlockEditorController;
    render(<Render block={block} editor={editor} />);
    expect(screen.getByText('No database linked')).toBeTruthy();
  });
});
