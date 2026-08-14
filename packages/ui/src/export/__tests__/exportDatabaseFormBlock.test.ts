import {describe, expect, it} from 'vitest';
import {blocksToHtml, blocksToMarkdown, projectBlocksForExport} from '@/blockeditor/exportBlocks';
import type {BlockJSON} from '@/blockeditor/model';

const block: BlockJSON = {
  id: 'dbform-1',
  type: 'dbform',
  props: {databaseId: 'db-contact', viewId: 'view-contact'},
};

describe('database form block export', () => {
  it('links all static paths only when the known origin is safe', () => {
    const origin = 'https://openbook.test/?page=host';
    const html = blocksToHtml([block], {originPageUrl: origin});
    expect(html).toContain(`href="${origin}"`);
    expect(html).toContain('>Open form</a>');

    expect(blocksToMarkdown([block], {originPageUrl: origin})).toContain(`[Open form](${origin})`);
    const projected = projectBlocksForExport([block], undefined, undefined, {originPageUrl: origin}).blocks;
    expect(projected[0].data.text).toContain(`href="${origin}"`);
    expect(projected[0].data.text).toContain('>Open form</a>');
  });

  it('degrades all paths without an origin to a labelled, inert placeholder', () => {
    const html = blocksToHtml([block]);
    expect(html).toContain('<span class="ob-dbform-placeholder"');
    expect(html).toContain('>📋 Database form</span>');
    expect(html).not.toContain('<a ');
    expect(html).toContain('data-database-id="db-contact"');
    expect(html).toContain('data-form-view-id="view-contact"');

    const markdown = blocksToMarkdown([block]);
    expect(markdown).toContain('**📋 Database form**');
    expect(markdown).not.toContain('[Open form]');

    const projected = projectBlocksForExport([block]).blocks;
    expect(projected).toHaveLength(1);
    expect(projected[0].type).toBe('paragraph');
    expect(projected[0].data.text).toContain('<span class="ob-dbform-placeholder"');
    expect(projected[0].data.text).toContain('data-database-id="db-contact"');
    expect(projected[0].data.text).not.toContain('<a ');
    expect(projected[0].data.text).not.toMatch(/<form|<table/i);
    expect(html).not.toMatch(/schema|capability|submissionKey|token/i);
  });

  it('rejects unsafe origins in all three paths', () => {
    const opts = {originPageUrl: 'javascript:alert(1)'};
    expect(blocksToHtml([block], opts)).not.toContain('<a ');
    expect(blocksToMarkdown([block], opts)).toBe('**📋 Database form**');
    expect(projectBlocksForExport([block], undefined, undefined, opts).blocks[0].data.text)
      .not.toContain('<a ');
  });
});
