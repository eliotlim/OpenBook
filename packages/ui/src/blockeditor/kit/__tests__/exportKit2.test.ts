import {describe, expect, it} from 'vitest';
import {createDoc, docToJSON} from '../../model';
import {blocksToEditorJs, blocksToHtml, blocksToMarkdown} from '../../exportBlocks';

const doc = () =>
  docToJSON(
    createDoc([
      {id: 'cc', type: 'choicecards', props: {name: 'plan', opts: [{label: 'Pro', value: 'pro'}], value: 'pro'}},
      {id: 'tg', type: 'tagfield', props: {name: 'topics', selected: ['ai', 'ml']}},
      {id: 'lt', type: 'longtext', props: {name: 'notes', value: 'hi'}},
      {id: 'rt', type: 'richtext', props: {name: 'bio', runs: [{t: 'Bold', a: {b: true}}]}},
      {id: 'pb', type: 'progressbar', props: {label: 'Done', source: 'plan === "pro" ? 1 : 0', max: 1}},
      {
        id: 'acc',
        type: 'accordion',
        props: {name: 'setup'},
        children: [
          {id: 's1', type: 'accordionsection', props: {label: 'A'}, children: [{id: 'i1', type: 'number', props: {name: 'q', value: 3}}]},
        ],
      },
    ]),
  );

describe('export of June-2026 inputs', () => {
  it('publishes new input values and tokenizes a progress expr', () => {
    const out = blocksToEditorJs(doc());
    expect(out.values).toEqual(
      expect.arrayContaining([['cc', 'pro'], ['tg', ['ai', 'ml']], ['lt', 'hi'], ['rt', 'Bold']]),
    );
    const expr = out.blocks.find((b) => b.type === 'expr' && (b.data as {name: string}).name === 'Done');
    expect((expr?.data as {source: string}).source).toContain('__C__{cc}__');
  });

  it('flattens the accordion children in reading order with section headings', () => {
    const out = blocksToEditorJs(doc());
    const header = out.blocks.find((b) => b.type === 'header' && (b.data as {text: string}).text.includes('A'));
    expect(header).toBeTruthy();
    // The number input inside the section still emits as a live slider.
    expect(out.blocks.find((b) => b.id === 'i1')).toBeTruthy();
  });

  it('renders readable HTML + Markdown for the new blocks', () => {
    const html = blocksToHtml(doc());
    expect(html).toContain('plan:');
    expect(html).toContain('<strong>Bold</strong>');
    expect(html).toContain('obe-x-accordion');
    const md = blocksToMarkdown(doc());
    expect(md).toContain('### A');
    expect(md).toContain('**Bold**');
  });
});
