/**
 * API-2: the agent's block-type validation is DERIVED from the SDK catalogue
 * (the hand-written KNOWN_BLOCK_TYPES allowlist is gone).
 *
 *  - COVERAGE (the drift bug this task fixes): EVERY catalogued type — core,
 *    container, table parts, media, and every kit block — is creatable through
 *    `add_blocks`. The old allowlist silently rejected table/row/cell, image,
 *    notes, htmlArtifact, actionbutton, tooltipcard, richtext, dbview. This is
 *    the enumeration harness (API-6 can extend it end-to-end); it enumerates
 *    the catalogue rather than naming types, so a new registry type is covered
 *    the day it's catalogued — and the UI drift test forces cataloguing.
 *  - Plugin types: `<pluginId>/<type>` is accepted when the plugin is
 *    installed (the real bundled ledger manifest), rejected with a clear
 *    message when it is not.
 *  - Structure: the children-carrier rule and the table cell-count rule are
 *    the catalogue's (shared with MCP), enforced on add_blocks.
 *  - Props: update_block_props validates declared prop VALUE types
 *    (permissive: unknown props pass), and validates a type change.
 *  - list_block_types returns the whole catalogue including installed
 *    plugins' declared blocks.
 *
 * Scripted-engine harness mirrors agentLoop.test.ts.
 */
import {readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {BLOCK_TYPE_CATALOGUE, CHILD_ONLY_PARENT, guestPrincipal, type PluginManifest} from '@book.dev/sdk';
import {PgliteDb} from '../db';
import {PageStore} from '../store';
import {AiService} from './service';
import {AgentRunner, type AgentEvent} from './agent';
import type {AiEngine} from './providers';

let store: PageStore;
let db: PgliteDb;
let dir: string;
let seq = 0;

/** A 2-turn JSON-protocol engine: call `tool(args)` once, then answer "ok". */
const scriptEngine = (tool: string, args: Record<string, unknown>): AiEngine => ({
  kind: 'mock',
  async ensureReady() {
    /* always ready */
  },
  async generate(prompt, opts) {
    const out = prompt.includes('TOOL RESULT') ? JSON.stringify({final: 'ok'}) : JSON.stringify({tool, args});
    opts.onToken(out);
    return out;
  },
  async dispose() {
    /* nothing to release */
  },
});

class ScriptedAi extends AiService {
  scripted: AiEngine = scriptEngine('list_pages', {});
  async engineForRequest(): Promise<{engine: AiEngine; transient: boolean}> {
    return {engine: this.scripted, transient: false};
  }
}

const runTool = async (tool: string, args: Record<string, unknown>): Promise<{result: string; events: AgentEvent[]}> => {
  const ai = new ScriptedAi(db, join(dir, 'models'));
  ai.scripted = scriptEngine(tool, args);
  const runner = new AgentRunner(ai, store, {principal: guestPrincipal(), thinking: false});
  const events: AgentEvent[] = [];
  await runner.run([{role: 'user', content: 'go'}], (ev) => {
    events.push(ev);
  });
  const ev = events.find((e) => e.type === 'tool_result' && e.name === tool);
  return {result: ev && ev.type === 'tool_result' ? ev.result : '', events};
};

/** A minimal creatable instance of `type`, wrapped in its required ancestors
 *  (cell → row → table, column → columns, …) purely from the catalogue. */
const minimalBlock = (type: string): Record<string, unknown> => {
  let block: Record<string, unknown> = {type};
  for (let t = type; CHILD_ONLY_PARENT[t]; t = CHILD_ONLY_PARENT[t]) {
    block = {type: CHILD_ONLY_PARENT[t], children: [block]};
  }
  return block;
};

/** The real bundled ledger plugin manifest (examples/plugins/ledger). */
const ledgerManifest = (): PluginManifest =>
  JSON.parse(readFileSync(resolve(__dirname, '../../../../examples/plugins/ledger/openbook.json'), 'utf-8')) as PluginManifest;

const blockPage = async (name: string) =>
  store.upsertPage({
    name,
    data: {
      editor: 'blocks',
      blockdoc: {blocks: [{id: 'b1', type: 'heading', text: [{t: 'seed'}], props: {level: 1}}]},
      editorjs: {blocks: []},
      values: [],
      names: [],
    },
  });

beforeEach(async () => {
  seq += 1;
  dir = join(tmpdir(), `ob-agentblocks-${process.pid}-${seq}`);
  rmSync(dir, {recursive: true, force: true});
  db = await PgliteDb.create(dir);
  store = new PageStore(db);
  await store.migrate();
});

afterEach(async () => {
  await store.close();
  rmSync(dir, {recursive: true, force: true});
});

describe('add_blocks accepts EVERY catalogued type (the coverage assertion)', () => {
  it('every core + kit type in the catalogue is creatable', async () => {
    const page = await blockPage(`coverage-${seq}`);
    for (const entry of BLOCK_TYPE_CATALOGUE) {
      const {result, events} = await runTool('add_blocks', {pageId: page.id, blocks: [minimalBlock(entry.type)]});
      expect(result, `${entry.type}: ${result}`).toContain('SUGGESTED for review');
      expect(events.some((e) => e.type === 'suggestions'), entry.type).toBe(true);
    }
  }, 120_000);
});

describe('add_blocks: plugin block types', () => {
  it('accepts an installed plugin\'s namespaced type and rejects an uninstalled one', async () => {
    const page = await blockPage(`plug-${seq}`);
    await store.upsertPlugin({manifest: ledgerManifest(), files: {'src/index.ts': ''}});
    const ok = await runTool('add_blocks', {pageId: page.id, blocks: [{type: 'openbook.ledger/journal-entry', props: {ledgerRows: ''}}]});
    expect(ok.result).toContain('SUGGESTED for review');
    const bad = await runTool('add_blocks', {pageId: page.id, blocks: [{type: 'acme.rocks/widget'}]});
    expect(bad.result).toContain('not installed');
    expect(bad.events.some((e) => e.type === 'suggestions')).toBe(false);
  });

  it('rejects a typo\'d type with a pointer at list_block_types', async () => {
    const page = await blockPage(`typo-${seq}`);
    const {result} = await runTool('add_blocks', {pageId: page.id, blocks: [{type: 'paragraf', text: 'x'}]});
    expect(result).toContain('Unsupported block type "paragraf"');
    expect(result).toContain('list_block_types');
  });
});

describe('add_blocks: catalogue-derived structure rules (shared with MCP)', () => {
  it('children on a non-container are refused (they would be silently dropped)', async () => {
    const page = await blockPage(`carrier-${seq}`);
    const {result} = await runTool('add_blocks', {pageId: page.id, blocks: [{type: 'paragraph', children: [{type: 'paragraph'}]}]});
    expect(result).toContain('can\'t hold children');
  });

  it('a ragged table is refused with the offending row named', async () => {
    const page = await blockPage(`ragged-${seq}`);
    const table = {
      type: 'table',
      children: [
        {type: 'row', children: [{type: 'cell', text: 'a'}, {type: 'cell', text: 'b'}]},
        {type: 'row', children: [{type: 'cell', text: 'only'}]},
      ],
    };
    const {result} = await runTool('add_blocks', {pageId: page.id, blocks: [table]});
    expect(result).toContain('same number of cells');
  });
});

describe('update_block_props: catalogue-typed props and type changes', () => {
  it('rejects a declared prop with the wrong value type, names prop and type', async () => {
    const page = await blockPage(`props-${seq}`);
    const {result, events} = await runTool('update_block_props', {pageId: page.id, blockId: 'b1', props: {level: 'two'}});
    expect(result).toContain('"level"');
    expect(result).toContain('must be a number');
    expect(events.some((e) => e.type === 'suggestions')).toBe(false);
  });

  it('accepts declared props of the right type, unknown props, and null removals', async () => {
    const page = await blockPage(`props-ok-${seq}`);
    const {result} = await runTool('update_block_props', {pageId: page.id, blockId: 'b1', props: {level: 2, mystery: {x: 1}, bg: null}});
    expect(result).toContain('SUGGESTED for review');
  });

  it('refuses the private table order-contract keys with the shared table-tools message', async () => {
    const page = await blockPage(`ordkey-${seq}`);
    for (const props of [{ord: 'a0'}, {col: 'c1'}, {'col:abc': 'a0'}, {'colbg:abc': 'amber'}]) {
      const {result, events} = await runTool('update_block_props', {pageId: page.id, blockId: 'b1', props});
      expect(result, JSON.stringify(props)).toContain('private table order-contract key');
      expect(result).toContain('table tools');
      expect(events.some((e) => e.type === 'suggestions')).toBe(false);
    }
  });

  it('refuses retyping to a child-only type outside its parent, and container→leaf with children', async () => {
    const page = await store.upsertPage({
      name: `retype-guard-${seq}`,
      data: {
        editor: 'blocks',
        blockdoc: {
          blocks: [
            {id: 'p1', type: 'paragraph', text: [{t: 'top-level'}]},
            {id: 'g1', type: 'group', children: [{id: 'p2', type: 'paragraph', text: [{t: 'inside'}]}]},
            {id: 't1', type: 'table', children: [{id: 'r1', type: 'row', children: [{id: 'c1', type: 'cell', text: [{t: 'x'}]}]}]},
          ],
        },
        editorjs: {blocks: []},
        values: [],
        names: [],
      },
    });
    // A top-level paragraph cannot become a cell (its parent is not a row).
    const toCell = await runTool('update_block_props', {pageId: page.id, blockId: 'p1', type: 'cell'});
    expect(toCell.result).toContain('must sit directly inside a "row"');
    // A table holding rows cannot silently become a paragraph (children dropped).
    const toLeaf = await runTool('update_block_props', {pageId: page.id, blockId: 't1', type: 'paragraph'});
    expect(toLeaf.result).toContain('would silently drop');
    // A row keeping the right parent CAN be retyped among containers... but the
    // legitimate everyday case: retyping a childless paragraph works.
    const ok = await runTool('update_block_props', {pageId: page.id, blockId: 'p2', type: 'todo'});
    expect(ok.result).toContain('SUGGESTED for review');
  });

  it('validates a TYPE change against the catalogue (and props against the NEW type)', async () => {
    const page = await blockPage(`retype-${seq}`);
    const bad = await runTool('update_block_props', {pageId: page.id, blockId: 'b1', type: 'blink'});
    expect(bad.result).toContain('Unsupported block type "blink"');
    const badProp = await runTool('update_block_props', {pageId: page.id, blockId: 'b1', type: 'todo', props: {checked: 'yes'}});
    expect(badProp.result).toContain('"checked"');
    const ok = await runTool('update_block_props', {pageId: page.id, blockId: 'b1', type: 'todo', props: {checked: true}});
    expect(ok.result).toContain('SUGGESTED for review');
  });
});

describe('list_block_types', () => {
  it('returns the full catalogue, and installed plugins\' declared blocks', async () => {
    const before = await runTool('list_block_types', {});
    for (const entry of BLOCK_TYPE_CATALOGUE) expect(before.result).toContain(`- ${entry.type} (`);
    expect(before.result).toContain('Installed plugin blocks: none.');

    await store.upsertPlugin({manifest: ledgerManifest(), files: {'src/index.ts': ''}});
    const after = await runTool('list_block_types', {});
    expect(after.result).toContain('openbook.ledger/journal-entry');
    expect(after.result).toContain('openbook.ledger/beancount-export');
    expect(after.result).toContain('(plugin: Ledger');
  });
});
