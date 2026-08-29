import * as Y from 'yjs';
import {describe, expect, it} from 'vitest';
import {parseMiniMarkdown} from '@book.dev/sdk';
import {blocksToMarkdown} from '../exportBlocks';
import {runsToHtml} from '../richtext';

describe('SDK rich-text input parity', () => {
  it('renders SDK runs with editor marks and links', () => {
    const doc = new Y.Doc();
    const text = doc.getText('text');
    let at = 0;
    for (const run of parseMiniMarkdown('**a** [b](https://x.test)')) {
      text.insert(at, run.t, run.a ?? {});
      at += run.t.length;
    }
    expect(runsToHtml(text)).toBe('<strong>a</strong> <a class="obe-link" href="https://x.test" target="_blank" rel="noreferrer">b</a>');
  });

  it('exports MCP-created runs to markdown that parses to the same runs', () => {
    const runs = parseMiniMarkdown('**a** [b](https://x.test)');
    const markdown = blocksToMarkdown([{id: 'p', type: 'paragraph', text: runs}]);
    expect(parseMiniMarkdown(markdown.trim())).toEqual(runs);
  });
});
