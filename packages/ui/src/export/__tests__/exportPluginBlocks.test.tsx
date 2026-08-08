import {describe, it, expect, afterEach} from 'vitest';
import {render, cleanup} from '@testing-library/react';
import type {PageSnapshot} from '@book.dev/sdk';
import {createDoc, decodeSnapshot, docToJSON, type BlockJSON} from '../../blockeditor/model';
import {projectSnapshotForExport, blocksToHtml, blocksToMarkdown} from '../../blockeditor/exportBlocks';
import {describeUnknownBlock} from '../../blockeditor/unknownBlock';
import {detectHtmlIsland} from '../../lib/islandImport';
import {buildDocumentModel} from '../documentModel';
import {toHtml, toSlideDeck} from '../toHtml';
import {toMarkdown} from '../toMarkdown';
import {ViewerApp} from '../../viewer/ViewerApp';
import type {IslandPageJson} from '../../viewer/types';
import {
  LEDGER_BLOCK_TYPES,
  PARITY_PLUGIN_BLOCKS,
  parityRawSnapshot,
  parityExportSnapshot,
} from './parityFixtureDoc';

/**
 * **LX-1 — plugin blocks must survive an export.**
 *
 * Every block whose type no exporter knows (the nine Ledger plugin blocks, and
 * forward-compatibility types from a newer version) used to be relabelled
 * `paragraph` by the export projection, which erased its type AND its props;
 * because such blocks carry no text, the reader got a literal empty `<p></p>`
 * in HTML/PDF and a blank line in Markdown. These guard the replacement
 * contract: identity preserved in the projection, a visibly labelled
 * placeholder in every rendered surface, and a lossless island round-trip.
 */

afterEach(() => cleanup());

const rawSnapshot = parityRawSnapshot(PARITY_PLUGIN_BLOCKS);
const snapshot = parityExportSnapshot(PARITY_PLUGIN_BLOCKS);
const meta = {id: 'lx-root', updatedAt: '2026-07-04T00:00:00.000Z'};

/** A hand-built projection (what a legacy/foreign snapshot looks like): the only
 *  way an unknown block carries text, since `makeBlock` gives a Y.Text to core
 *  text types only. Its content must survive alongside the placeholder. */
const textyProjection = {
  editorjs: {blocks: [{id: 'u', type: 'acme.reports/kpi-grid', data: {props: {span: 3}, text: 'carried by an unknown block'}}]},
  values: [],
  names: [],
} as unknown as PageSnapshot;

/** The projected export blocks (what every exporter consumes). */
const projected = (snap: PageSnapshot): Array<{id?: string; type?: string; data?: Record<string, unknown>}> =>
  ((snap.editorjs as {blocks?: Array<{id?: string; type?: string; data?: Record<string, unknown>}>}).blocks ?? []);

/** The visible body of an export — everything before the source island. */
const bodyOf = (html: string): string => html.slice(0, html.indexOf('<script type="application/openbook+json"'));

describe('export projection preserves plugin block identity', () => {
  it('keeps the verbatim type and the props of every plugin block', () => {
    const blocks = projected(snapshot);
    for (const type of LEDGER_BLOCK_TYPES) {
      const block = blocks.find((b) => b.type === type);
      expect(block, `projection kept ${type}`).toBeDefined();
      const source = PARITY_PLUGIN_BLOCKS.find((b) => b.type === type)!;
      expect(block!.id).toBe(source.id);
      expect(block!.data?.props).toEqual(source.props);
    }
    // The old flatten: nothing may be relabelled `paragraph` but the real ones.
    expect(blocks.filter((b) => b.type === 'paragraph')).toHaveLength(1);
  });

  it('still projects core text blocks as paragraphs (no false placeholders)', () => {
    const core = projectSnapshotForExport(
      parityRawSnapshot([
        {id: 'p', type: 'paragraph', text: [{t: 'plain text'}]},
        {id: 'c', type: 'cell', text: [{t: 'orphaned cell'}]},
      ]),
    );
    expect(projected(core).map((b) => b.type)).toEqual(['paragraph', 'paragraph']);
  });
});

describe('exported HTML labels every unrenderable block', () => {
  const html = toHtml(rawSnapshot, 'Ledger plugin blocks', '📒', new Map(), meta);
  const body = bodyOf(html);

  it('emits no empty paragraphs (the LX-1 regression)', () => {
    expect(body).not.toMatch(/<p>\s*<\/p>/);
    expect(body).not.toMatch(/<p>\s*&nbsp;\s*<\/p>/);
  });

  it('renders one labelled placeholder per plugin block, naming block and plugin', () => {
    for (const type of LEDGER_BLOCK_TYPES) {
      expect(body).toContain(`data-block-type="${type}"`);
      expect(body).toContain(`<p class="ob-plugin-block-label">${describeUnknownBlock(type).label}</p>`);
    }
    expect((body.match(/class="ob-plugin-block"/g) ?? []).length).toBe(LEDGER_BLOCK_TYPES.length + 2);
    // Ledger blocks are FIRST-PARTY: the report blocks say the books weren't
    // included (not "install the plugin"), the live tools say "interactive";
    // only a genuinely foreign plugin type keeps the install hint.
    expect(body).toContain('the books weren\'t included in this export');
    expect(body).toContain('Interactive ledger tool');
    expect(body).toContain('requires the Future plugin');
    expect(body).not.toContain('requires the Ledger plugin');
    expect(html).toContain('.ob-plugin-block {'); // the placeholder is styled, incl. the PDF path
    expect(html).toContain('page-break-inside: avoid');
  });

  it('keeps any text an unknown block carried', () => {
    const carried = bodyOf(toHtml(textyProjection, 'Legacy', '', new Map(), meta));
    expect(carried).toContain('<p class="ob-plugin-block-label">Kpi grid</p>');
    expect(carried).toContain('requires the Reports plugin');
    expect(carried).toContain('<p class="ob-plugin-block-text">carried by an unknown block</p>');
  });

  it('labels them in a slide deck too (no hydration there)', () => {
    const deck = bodyOf(toSlideDeck(rawSnapshot, 'Deck', '📒', new Map(), meta));
    expect(deck).toContain('the books weren\'t included in this export');
    expect(deck).toContain('Interactive ledger tool');
  });
});

describe('exported Markdown labels every unrenderable block', () => {
  const md = toMarkdown(buildDocumentModel({title: 'Ledger plugin blocks', icon: '📒', snapshot}));

  it('names each block and its plugin instead of a bare type dump', () => {
    for (const type of LEDGER_BLOCK_TYPES) {
      // Block name on the title line, the requirement on its own blockquote line.
      expect(md).toContain(`> **${describeUnknownBlock(type).label}**\n>\n> This block requires the Ledger plugin`);
    }
    expect(md).toContain('install the plugin in OpenBook to see it.');
    expect(md).not.toContain('block)_'); // the old `_(type block)_` fallback
  });

  it('carries an unknown block’s text', () => {
    const carried = toMarkdown(buildDocumentModel({title: 'Legacy', icon: '', snapshot: textyProjection}));
    expect(carried).toContain('> **Kpi grid**\n>\n> This block requires the Reports plugin');
    expect(carried).toContain('> carried by an unknown block');
  });

  it('escapes a hostile hint so an unknown block type cannot inject markup', () => {
    // The verbatim block type rides in the hint; a passthrough .md → HTML
    // pipeline must never see it as live markup.
    const hostile = {
      editorjs: {blocks: [{id: 'x', type: '<img src=x onerror=alert(1)>', data: {props: {}}}]},
      values: [],
      names: [],
    } as unknown as PageSnapshot;
    const out = toMarkdown(buildDocumentModel({title: 'Hostile', icon: '', snapshot: hostile}));
    expect(out).toContain('\\<img src=x onerror=alert(1)\\>');
    expect(out).not.toMatch(/[^\\]<img/); // no unescaped tag
  });

  it('leaves no blank body lines where a plugin block was', () => {
    const bodyLines = md.split('\n').slice(1);
    expect(bodyLines.filter((l) => l.trim() === '').length).toBe(bodyLines.length - bodyLines.filter((l) => l.trim()).length);
    expect(md).not.toMatch(/\n\n\n\n/); // an empty paragraph would triple-space
  });
});

describe('clipboard/standalone block exporters', () => {
  const json: BlockJSON[] = docToJSON(createDoc(PARITY_PLUGIN_BLOCKS));

  it('labels plugin blocks in clipboard HTML', () => {
    const html = blocksToHtml(json);
    expect(html).toContain('data-block-type="openbook.ledger/trial-balance"');
    expect(html).toContain('Trial balance');
    expect(html).toContain('requires the Ledger plugin');
  });

  it('labels plugin blocks in clipboard Markdown', () => {
    const md = blocksToMarkdown(json);
    expect(md).toContain('> **Beancount export**\n>\n> This block requires the Ledger plugin');
  });

  it('leaves non-plugin types on their historical plain-text path', () => {
    // Deliberately narrow: core kit blocks fall through this exporter's switch
    // too, and labelling a slider “unsupported” in a paste would be a lie.
    expect(blocksToMarkdown(json)).not.toContain('Unsupported block type');
    expect(blocksToHtml([{id: 's', type: 'slider', props: {name: 'm', value: 1}}])).toBe('<p>&nbsp;</p>');
  });

  it('keeps text a hand-built unknown block carried', () => {
    const carried: BlockJSON[] = [{id: 'u', type: 'acme.reports/kpi-grid', text: [{t: 'carried'}], props: {}}];
    expect(blocksToHtml(carried)).toContain('<p class="obe-x-plugin-text">carried</p>');
    expect(blocksToMarkdown(carried)).toContain('> carried');
  });
});

describe('island round-trip', () => {
  it('restores every plugin block’s exact type and props from the exported file', () => {
    const html = toHtml(rawSnapshot, 'Ledger plugin blocks', '📒', new Map(), meta);
    const found = detectHtmlIsland(html);
    expect(found?.kind).toBe('page');
    const data = (found as {kind: 'page'; record: {data: PageSnapshot}}).record.data;
    // The island carries the lossless block-doc, not the flattened render.
    expect(data).toEqual(rawSnapshot);
    const restored = docToJSON(decodeSnapshot(data.blockdoc as never));
    for (const source of PARITY_PLUGIN_BLOCKS) {
      const block = restored.find((b) => b.id === source.id)!;
      expect(block.type).toBe(source.type);
      expect(block.props ?? {}).toEqual(source.props ?? {});
    }
  });
});

describe('viewer hydration of unknown types', () => {
  const island: IslandPageJson = {
    version: 1,
    id: 'lx-root',
    name: 'Ledger plugin blocks',
    icon: null,
    updatedAt: '2026-07-04T00:00:00.000Z',
    data: rawSnapshot as unknown as IslandPageJson['data'],
  };

  it('renders a page of plugin blocks without a data client and without crashing', () => {
    // The vendored viewer has no DataProvider: a throw from the missing-plugin
    // fallback would kill the whole mount, losing every live widget on the page.
    const {container} = render(<ViewerApp source={island} />);
    expect(container.querySelectorAll('.obe-missing-plugin').length).toBe(LEDGER_BLOCK_TYPES.length + 1);
    for (const type of LEDGER_BLOCK_TYPES) {
      const card = container.querySelector(`.obe-missing-plugin[data-block-type="${type}"]`);
      expect(card).not.toBeNull();
      // The card leads with the block name — the same words the HTML/Markdown
      // exports lead with — not the plugin requirement (LX-1 review, Devon 1).
      expect(card?.querySelector('.obe-missing-plugin-title')?.textContent).toBe(describeUnknownBlock(type).label);
    }
    expect(container.querySelector('.obe-missing-plugin[data-block-type="openbook.ledger/trial-balance"]')?.textContent).toContain('Trial balance');
    expect(container.textContent).toContain('Requires the Ledger plugin');
    expect(container.querySelector('.obe-unknown')?.textContent).toContain('not-a-plugin-type');
    // No install affordance without a client — nowhere to install to.
    expect(container.querySelector('.obe-missing-plugin-install')).toBeNull();
    expect(container.textContent).toContain('Open in OpenBook to install');
  });
});
