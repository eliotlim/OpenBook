/**
 * The block-type catalogue (API-2): internal consistency, type validation
 * (core/kit/plugin), the consolidated structure rules (children-carrier,
 * child-only placement, square tables, caps), permissive-but-typed prop
 * validation, and the generated tool text every type must appear in.
 */
import {describe, expect, it} from 'vitest';
import {
  addBlocksGuidance,
  BLOCK_TYPE_CATALOGUE,
  BLOCK_PROP_JSON_SCHEMAS,
  BLOCK_PROP_SCHEMAS,
  blockCatalogueText,
  blockTreeError,
  blockTypeInfo,
  CHILD_ONLY_PARENT,
  CONTAINER_BLOCK_TYPES,
  findUnknownBlockType,
  invalidBlockProps,
  isPluginBlockType,
  KNOWN_BLOCK_TYPE_IDS,
  MAX_BLOCK_DEPTH,
  MAX_BLOCK_NODES,
  pluginIdOfBlockType,
  TEXT_BLOCK_TYPES,
  unknownBlockTypeMessage,
} from './blockCatalogue';

describe('catalogue integrity', () => {
  it('has unique type ids', () => {
    const ids = BLOCK_TYPE_CATALOGUE.map((e) => e.type);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every child-only parent is itself a catalogued container', () => {
    for (const [child, parent] of Object.entries(CHILD_ONLY_PARENT)) {
      expect(blockTypeInfo(child), child).toBeDefined();
      expect(blockTypeInfo(parent)?.nature, `${child} → ${parent}`).toBe('container');
    }
  });

  it('kit-value publishers are kit-category void blocks with a name prop', () => {
    for (const e of BLOCK_TYPE_CATALOGUE.filter((x) => x.kitValue)) {
      expect(e.category, e.type).toBe('kit');
      expect(e.nature, e.type).toBe('void');
      expect(e.props?.name, e.type).toBe('string');
    }
  });

  it('derived sets partition by nature', () => {
    for (const e of BLOCK_TYPE_CATALOGUE) {
      expect(CONTAINER_BLOCK_TYPES.has(e.type as never), e.type).toBe(e.nature === 'container');
      expect(TEXT_BLOCK_TYPES.has(e.type as never), e.type).toBe(e.nature === 'text');
    }
  });
});

describe('type validation', () => {
  it('accepts every catalogued type, nested or not', () => {
    for (const e of BLOCK_TYPE_CATALOGUE) {
      expect(findUnknownBlockType([{type: e.type}]), e.type).toBeNull();
    }
    expect(findUnknownBlockType([{type: 'group', children: [{type: 'kitchart'}]}])).toBeNull();
  });

  it('rejects unknown and missing types (nested too), with the tool pointer', () => {
    expect(findUnknownBlockType([{type: 'paragraf'}])).toEqual({type: 'paragraf', reason: 'unknown'});
    expect(findUnknownBlockType([{type: 'group', children: [{type: 'blink'}]}])?.type).toBe('blink');
    expect(findUnknownBlockType([{}])?.type).toBe('(missing type)');
    expect(findUnknownBlockType(['nope'])?.type).toBe('(not a block)');
    expect(unknownBlockTypeMessage(findUnknownBlockType([{type: 'blink'}]))).toContain('list_block_types');
  });

  it('plugin types pass by pattern without a listing, and by lookup with one', () => {
    expect(isPluginBlockType('openbook.ledger/journal-entry')).toBe(true);
    expect(isPluginBlockType('paragraph')).toBe(false);
    expect(pluginIdOfBlockType('openbook.ledger/journal-entry')).toBe('openbook.ledger');
    // No listing available → accepted opaquely (as the apply layer always has).
    expect(findUnknownBlockType([{type: 'openbook.ledger/journal-entry'}])).toBeNull();
    // Listing available → the plugin must actually be installed.
    const installed = new Set(['openbook.ledger']);
    expect(findUnknownBlockType([{type: 'openbook.ledger/journal-entry'}], {installedPluginIds: installed})).toBeNull();
    const bad = findUnknownBlockType([{type: 'acme.books/widget'}], {installedPluginIds: installed});
    expect(bad).toEqual({type: 'acme.books/widget', reason: 'plugin-not-installed'});
    expect(unknownBlockTypeMessage(bad)).toContain('not installed');
  });
});

describe('structure validation (children-carrier + child-only + square tables)', () => {
  it('accepts a real nested layout', () => {
    expect(
      blockTreeError([
        {
          type: 'columns',
          children: [
            {type: 'column', props: {span: 6}, children: [{type: 'slider', props: {name: 'x'}}]},
            {type: 'column', props: {span: 6}, children: [{type: 'group', children: [{type: 'paragraph', text: 'hi'}]}]},
          ],
        },
      ]),
    ).toBeNull();
  });

  it('rejects children on a non-container (they would be silently dropped)', () => {
    expect(blockTreeError([{type: 'paragraph', children: [{type: 'paragraph'}]}])).toContain('can\'t hold children');
    // `cell` is a TEXT leaf, not a container.
    expect(
      blockTreeError([
        {type: 'table', children: [{type: 'row', children: [{type: 'cell', children: [{type: 'paragraph'}]}]}]},
      ]),
    ).toContain('"cell"');
  });

  it('rejects a child-only type outside its parent', () => {
    expect(blockTreeError([{type: 'row', children: [{type: 'cell'}]}])).toContain('can\'t be top-level');
    expect(blockTreeError([{type: 'table', children: [{type: 'cell'}]}])).toContain('direct child of a "row"');
  });

  it('rejects a ragged table and names the offending row', () => {
    const err = blockTreeError([
      {
        type: 'table',
        children: [
          {type: 'row', children: [{type: 'cell', text: 'a'}, {type: 'cell', text: 'b'}]},
          {type: 'row', children: [{type: 'cell', text: 'only'}]},
        ],
      },
    ]);
    expect(err).toContain('same number of cells');
    expect(err).toContain('row 2 has 1');
    // A square table (and a childless one) is fine.
    expect(
      blockTreeError([
        {
          type: 'table',
          children: [
            {type: 'row', children: [{type: 'cell'}, {type: 'cell'}]},
            {type: 'row', children: [{type: 'cell'}, {type: 'cell'}]},
          ],
        },
        {type: 'table', children: []},
      ]),
    ).toBeNull();
  });

  it('enforces the depth and node caps', () => {
    let deep: Record<string, unknown> = {type: 'paragraph'};
    for (let i = 0; i < MAX_BLOCK_DEPTH; i += 1) deep = {type: 'group', children: [deep]};
    expect(blockTreeError([deep])).toContain('nested too deeply');
    const wide = Array.from({length: MAX_BLOCK_NODES + 1}, () => ({type: 'paragraph'}));
    expect(blockTreeError(wide)).toContain('Too many blocks');
    // Caps are overridable per caller.
    expect(blockTreeError(wide, {maxNodes: MAX_BLOCK_NODES + 1})).toBeNull();
  });
});

describe('typed prop schemas', () => {
  it('checks declared props, passes unknown props, null removals, and unknown types', () => {
    expect(invalidBlockProps('heading', {level: 2})).toBeNull();
    expect(invalidBlockProps('heading', {level: 'two'})).toContain('"level"');
    expect(invalidBlockProps('todo', {checked: 'yes'})).toContain('boolean');
    expect(invalidBlockProps('slider', {value: '50'})).toContain('number');
    expect(invalidBlockProps('checklist', {selected: 'a,b'})).toContain('array');
    expect(invalidBlockProps('column', {span: 6})).toBeNull();
    // Unknown props pass — the editor ignores what it doesn't know.
    expect(invalidBlockProps('heading', {mystery: {deep: true}})).toBeNull();
    // null removes a key, so it always passes.
    expect(invalidBlockProps('heading', {level: null})).toBeNull();
    // Common block chrome is typed everywhere.
    expect(invalidBlockProps('paragraph', {bg: 42})).toContain('"bg"');
    // Plugin/unknown types pass entirely (their props are theirs).
    expect(invalidBlockProps('openbook.ledger/journal-entry', {ledgerRows: 7})).toBeNull();
  });

  it('image width is a CSS length STRING (the editor writes "30%"/"60%", never numbers)', () => {
    expect(invalidBlockProps('image', {width: '60%'})).toBeNull();
    expect(invalidBlockProps('image', {width: 60})).toContain('"width"');
    expect(invalidBlockProps('image', {width: 'auto'})).toContain('CSS length');
    expect(blockTypeInfo('image')?.hint).toContain('"60%"');
    // htmlArtifact height stays numeric (CSS pixels from the resize handle).
    expect(invalidBlockProps('htmlArtifact', {height: 320})).toBeNull();
  });

  it('validates structured kit props, rich runs, and bounded pixel dimensions', () => {
    expect(invalidBlockProps('radio', {opts: [{label: 'One', value: 'one'}]})).toBeNull();
    expect(invalidBlockProps('radio', {opts: ['x']})).toContain('"opts"');
    expect(invalidBlockProps('checklist', {selected: ['one']})).toBeNull();
    expect(invalidBlockProps('checklist', {selected: [1]})).toContain('"selected"');
    expect(invalidBlockProps('richtext', {runs: [{t: 'bold', a: {b: true}}]})).toBeNull();
    expect(invalidBlockProps('richtext', {runs: [{text: 'wrong'}]})).toContain('"runs"');
    expect(invalidBlockProps('image', {width: '640px'})).toBeNull();
    expect(invalidBlockProps('image', {width: 640})).toContain('"width"');
    expect(invalidBlockProps('htmlArtifact', {height: 320})).toBeNull();
    expect(invalidBlockProps('htmlArtifact', {height: 40})).toContain('"height"');
  });

  it('catalogues dbform as a plain database-form reference', () => {
    expect(blockTypeInfo('dbform')?.props).toEqual({databaseId: 'string', viewId: 'string'});
    expect(invalidBlockProps('dbform', {databaseId: 'db-1', viewId: 'form-1'})).toBeNull();
    expect(invalidBlockProps('dbform', {databaseId: 'db-1', viewId: 1})).toContain('"viewId"');
  });

  it('props named after Object.prototype members read as undeclared, not inherited', () => {
    expect(invalidBlockProps('paragraph', {toString: 'x'})).toBeNull();
    expect(invalidBlockProps('heading', {constructor: 1, hasOwnProperty: true})).toBeNull();
  });

  it('registers a Zod and JSON schema for every catalogue entry', () => {
    for (const {type} of BLOCK_TYPE_CATALOGUE) {
      expect(BLOCK_PROP_SCHEMAS[type as keyof typeof BLOCK_PROP_SCHEMAS]).toBeDefined();
      expect(BLOCK_PROP_JSON_SCHEMAS[type as keyof typeof BLOCK_PROP_JSON_SCHEMAS]?.additionalProperties).toBe(true);
    }
  });
});

describe('pathological depth (stack-exhaustion guards)', () => {
  it('a tens-of-thousands-deep payload is refused cleanly, not with a RangeError', () => {
    let deep: Record<string, unknown> = {type: 'paragraph'};
    for (let i = 0; i < 40_000; i += 1) deep = {type: 'group', children: [deep]};
    expect(blockTreeError([deep])).toContain('nested too deeply');
    expect(findUnknownBlockType([deep])).toBeNull(); // stops descending, never throws
  });
});

describe('generated tool text', () => {
  it('list_block_types text covers every catalogued type and declared plugin blocks', () => {
    const catalogue = JSON.parse(blockCatalogueText([
      {manifest: {id: 'openbook.ledger', name: 'Ledger', blocks: [{type: 'journal-entry', description: 'Record a transaction'}]}, enabled: true},
    ]));
    for (const e of BLOCK_TYPE_CATALOGUE) {
      const item = catalogue.blocks.find((b: {type: string}) => b.type === e.type);
      expect(item.description).toBeTruthy();
      expect(item.propsSchema.type).toBe('object');
    }
    expect(catalogue.pluginBlocks[0].type).toBe('openbook.ledger/journal-entry');
    expect(JSON.parse(blockCatalogueText()).pluginListingAvailable).toBe(false);
    expect(JSON.parse(blockCatalogueText([])).pluginBlocks).toEqual([]);
  });

  it('add_blocks guidance names every catalogued type (the old prose drifted)', () => {
    const guidance = addBlocksGuidance();
    for (const type of KNOWN_BLOCK_TYPE_IDS) expect(guidance).toContain(type);
  });
});
