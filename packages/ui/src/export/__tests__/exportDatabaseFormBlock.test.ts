import {describe, expect, it} from 'vitest';
import {blocksToHtml, blocksToMarkdown, projectBlocksForExport} from '@/blockeditor/exportBlocks';
import type {BlockJSON} from '@/blockeditor/model';

const block: BlockJSON = {
  id: 'dbform-1',
  type: 'dbform',
  props: {databaseId: 'db-contact', viewId: 'view-contact'},
};

describe('database form block export', () => {
  it('degrades static HTML to an Open form link carrying only the reference', () => {
    const html = blocksToHtml([block], {originPageUrl: 'https://openbook.test/?page=host'});
    expect(html).toContain('href="https://openbook.test/?page=host"');
    expect(html).toContain('>Open form</a>');
    expect(html).toContain('data-database-id="db-contact"');
    expect(html).toContain('data-form-view-id="view-contact"');
    expect(html).not.toMatch(/schema|capability|submissionKey|token/i);
  });

  it('degrades Markdown and the shared projection to a link, never a form/table', () => {
    expect(blocksToMarkdown([block])).toContain('[Open form](#database-form-db-contact-view-contact)');
    const projected = projectBlocksForExport([block]).blocks;
    expect(projected).toHaveLength(1);
    expect(projected[0].type).toBe('paragraph');
    expect(projected[0].data.text).toContain('>Open form</a>');
    expect(projected[0].data.text).not.toMatch(/<form|<table/i);
  });
});
