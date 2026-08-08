/**
 * API-1 + API-4: NESTED block payloads over MCP, and the `delete_block` /
 * `update_block_props` write tools.
 *
 * Boots a real OpenBook server and drives `src/bin.ts` over stdio (the same
 * harness as `suggestions.test.mts`), proving:
 *
 *  API-1 — `append_blocks` accepts `children` recursively and the payload SURVIVES
 *    the whole write path (zod schema → suggestion payload / snapshot projection):
 *      · a columns→column→group→paragraph layout materializes as a real tree;
 *      · a table→row→cell payload lands as a 3×3 table whose cells are addressable;
 *      · the depth and total-node caps are refused with an actionable message;
 *      · a SUGGESTED nested append keeps `children` in the stored payload (the
 *        pre-fix zod object silently STRIPPED them, so review replayed an empty
 *        container).
 *
 *  API-4 — the two new write tools, at any depth:
 *      · `delete_block` removes a nested block / a table row (with its subtree);
 *      · `update_block_props` shallow-merges props and REMOVES a key passed as null;
 *      · both are policy-gated exactly like the existing writes (suggest by default,
 *        with agent-parity `applyKind` so the review bridge replays them), and both
 *        report a clean error for an unknown block id.
 *
 * Run: pnpm --filter @book.dev/mcp test
 */
import assert from 'node:assert/strict';
import {rmSync} from 'node:fs';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {HttpDataClient} from '@book.dev/sdk';
import {startServer} from '@book.dev/server';

const DATA_DIR = '/tmp/openbook-mcp-blocks-test';

let passed = 0;
function check(label: string, cond: boolean): void {
  assert.ok(cond, `FAILED: ${label}`);
  passed += 1;
  console.log(`  ✓ ${label}`);
}

const resultText = (res: {content?: unknown}): string =>
  ((res.content as Array<{type: string; text?: string}> | undefined) ?? [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text ?? '')
    .join('\n');

const isError = (res: {isError?: unknown}): boolean => res.isError === true;

/** Spawn `src/bin.ts` over stdio against `url`. */
async function connect(url: string): Promise<{client: Client; close: () => Promise<void>}> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', 'src/bin.ts'],
    env: {...(process.env as Record<string, string>), OPENBOOK_URL: url},
    stderr: 'pipe',
  });
  const client = new Client({name: 'openbook-mcp-blocks-test', version: '0.0.0'});
  await client.connect(transport);
  return {client, close: () => client.close()};
}

/** One line of `inspect_page_structure` output, with its indent depth. */
interface TreeLine {
  depth: number;
  id: string;
  type: string;
  text: string;
  raw: string;
}

const parseTree = (out: string): TreeLine[] =>
  out
    .split('\n')
    .map((raw) => {
      const m = /^(\s*)- \[([^\]]+)\] (\S+?)(?::\s(.*?))?(?:\s+props=.*)?$/.exec(raw);
      if (!m) return null;
      return {depth: m[1].length / 2, id: m[2], type: m[3], text: m[4] ?? '', raw};
    })
    .filter((l): l is TreeLine => l !== null);

/** A `group → group → … → paragraph` chain `depth` levels deep. */
const deepChain = (depth: number): unknown => {
  let node: unknown = {type: 'paragraph', text: 'bottom'};
  for (let i = 1; i < depth; i += 1) node = {type: 'group', children: [node]};
  return node;
};

const NESTED_LAYOUT = [
  {
    type: 'columns',
    children: [
      {type: 'column', props: {span: 5}, children: [{type: 'slider', props: {name: 'spent', value: 80, min: 0, max: 200}}]},
      {type: 'column', props: {span: 7}, children: [{type: 'group', children: [{type: 'paragraph', text: 'deep leaf'}]}]},
    ],
  },
];

const TABLE_PAYLOAD = [
  {
    type: 'table',
    props: {header: true},
    children: [
      {type: 'row', props: {header: true}, children: [{type: 'cell', text: 'Item'}, {type: 'cell', text: 'Qty'}, {type: 'cell', text: 'Price'}]},
      {type: 'row', children: [{type: 'cell', text: 'Apples'}, {type: 'cell', text: '3'}, {type: 'cell', text: '1.20'}]},
      {type: 'row', children: [{type: 'cell', text: 'Pears'}, {type: 'cell', text: '5'}, {type: 'cell', text: '2.40'}]},
    ],
  },
];

const blockPage = (name: string) => ({
  name,
  data: {
    editor: 'blocks',
    blockdoc: {blocks: [{id: 'b1', type: 'paragraph', text: [{t: 'seed'}]}]},
    editorjs: {blocks: []},
    values: [],
    names: [],
  },
});

async function main(): Promise<void> {
  rmSync(DATA_DIR, {recursive: true, force: true});
  const server = await startServer({dataDir: DATA_DIR, host: '127.0.0.1', port: 4411});
  console.log(`\nOpenBook server up at ${server.url}`);
  const seed = new HttpDataClient(server.url);

  // ── DIRECT mode: the payload must materialize in the STORED page. ─────────────
  await seed.setInstancePolicy({agentEdits: 'direct'});
  const page = await seed.savePage(blockPage('Nested target'));
  const mcp = await connect(server.url);

  console.log('\nAPI-1: tool catalogue exposes nested children + the new write tools');
  const tools = await mcp.client.listTools();
  const byName = new Map(tools.tools.map((t) => [t.name, t]));
  check('the catalogue includes delete_block and update_block_props', byName.has('delete_block') && byName.has('update_block_props'));
  const appendSchema = JSON.stringify(byName.get('append_blocks')?.inputSchema ?? {});
  check('append_blocks advertises a recursive `children` array in its JSON Schema',
    appendSchema.includes('"children"') && appendSchema.includes('$ref'));
  check('append_blocks documents the table and columns shapes',
    /table/.test(byName.get('append_blocks')?.description ?? '') && /columns/.test(byName.get('append_blocks')?.description ?? ''));

  console.log('\nAPI-1: a nested columns/group payload lands as a real tree');
  const appended = await mcp.client.callTool({name: 'append_blocks', arguments: {pageId: page.id, blocks: NESTED_LAYOUT}});
  check('append_blocks confirms a direct write and counts the nested blocks',
    resultText(appended).includes('directly') && resultText(appended).includes('including nested'));
  const tree = parseTree(resultText(await mcp.client.callTool({name: 'inspect_page_structure', arguments: {pageId: page.id}})));
  const columns = tree.find((l) => l.type === 'columns');
  const leaf = tree.find((l) => l.text === 'deep leaf');
  const slider = tree.find((l) => l.type === 'slider');
  check('the tree contains columns → column → group → paragraph at increasing depth',
    Boolean(columns && leaf) && leaf!.depth === columns!.depth + 3);
  check('a nested kit input kept its props', Boolean(slider) && /"name":"spent"/.test(slider!.raw));
  check('nested block ids are unique and addressable', new Set(tree.map((l) => l.id)).size === tree.length);
  check('read_page projects the nested text', resultText(await mcp.client.callTool({name: 'read_page', arguments: {pageId: page.id}})).includes('deep leaf'));

  console.log('\nAPI-1: a table → row → cell payload lands as a 3×3 table');
  await mcp.client.callTool({name: 'append_blocks', arguments: {pageId: page.id, blocks: TABLE_PAYLOAD}});
  const tTree = parseTree(resultText(await mcp.client.callTool({name: 'inspect_page_structure', arguments: {pageId: page.id}})));
  const table = tTree.find((l) => l.type === 'table')!;
  const rows = tTree.filter((l) => l.type === 'row' && l.depth === table.depth + 1);
  const cells = tTree.filter((l) => l.type === 'cell' && l.depth === table.depth + 2);
  check('the table has 3 rows and 9 cells nested under it', rows.length === 3 && cells.length === 9);
  check('every cell kept its text in payload order',
    cells.map((c) => c.text).join('|') === 'Item|Qty|Price|Apples|3|1.20|Pears|5|2.40');
  check('the header row kept its props', /"header":true/.test(rows[0].raw));

  console.log('\nAPI-1: structural caps are refused with an actionable message');
  const tooDeep = await mcp.client.callTool({name: 'append_blocks', arguments: {pageId: page.id, blocks: [deepChain(9)]}});
  check('a 9-level payload is refused (max 8) with an explicit depth error',
    isError(tooDeep) && /nested too deeply/i.test(resultText(tooDeep)) && /max 8/.test(resultText(tooDeep)));
  const atLimit = await mcp.client.callTool({name: 'append_blocks', arguments: {pageId: page.id, blocks: [deepChain(8)]}});
  check('an 8-level payload (exactly at the cap) is accepted', !isError(atLimit));
  const tooMany = await mcp.client.callTool({
    name: 'append_blocks',
    arguments: {pageId: page.id, blocks: [{type: 'group', children: Array.from({length: 400}, (_, i) => ({type: 'paragraph', text: `p${i}`}))}]},
  });
  check('a 401-node payload is refused (max 400) counting nested children',
    isError(tooMany) && /Too many blocks/i.test(resultText(tooMany)) && /401/.test(resultText(tooMany)));

  console.log('\nAPI-1 (should-fix 1.1): the container parent/child contract is enforced (no silent drop)');
  const leafChildren = await mcp.client.callTool({
    name: 'append_blocks',
    arguments: {pageId: page.id, blocks: [{type: 'paragraph', text: 'p', children: [{type: 'paragraph', text: 'nested'}]}]},
  });
  check('children on a non-container leaf are refused, naming the offending type',
    isError(leafChildren) && /"paragraph" block can't hold children/.test(resultText(leafChildren)));
  const looseRow = await mcp.client.callTool({
    name: 'append_blocks',
    arguments: {pageId: page.id, blocks: [{type: 'row', children: [{type: 'cell', text: 'x'}]}]},
  });
  check('a top-level row (no table parent) is refused — this is the wall-of-placeholders bug',
    isError(looseRow) && /"row" block/.test(resultText(looseRow)) && /table/.test(resultText(looseRow)));
  const looseCell = await mcp.client.callTool({
    name: 'append_blocks',
    arguments: {pageId: page.id, blocks: [{type: 'table', children: [{type: 'cell', text: 'x'}]}]},
  });
  check('a cell directly under a table (skipping row) is refused',
    isError(looseCell) && /"cell" block must be a direct child of a "row"/.test(resultText(looseCell)));
  const afterGuard = await seed.getPage(page.id);
  check('NONE of the rejected structural payloads mutated the page',
    !JSON.stringify(afterGuard?.data).includes('nested'));

  console.log('\nAPI-1 (should-fix 7.1/7.2): create_artifact_page accepts a NESTED payload and rejects a nested typo / bad structure');
  const artRes = await mcp.client.callTool({name: 'create_artifact_page', arguments: {title: 'Artifact nested', blocks: NESTED_LAYOUT}});
  check('create_artifact_page confirms creation of a nested layout', !isError(artRes) && /Created artifact page/.test(resultText(artRes)));
  const artId = /id (\S+?)[\s)]/.exec(resultText(artRes))?.[1];
  check('create_artifact_page returned a new page id', Boolean(artId));
  const artTree = parseTree(resultText(await mcp.client.callTool({name: 'inspect_page_structure', arguments: {pageId: artId}})));
  check('the artifact page materialized columns → column → group → paragraph',
    Boolean(artTree.find((l) => l.type === 'columns')) && Boolean(artTree.find((l) => l.text === 'deep leaf')));
  const artTypo = await mcp.client.callTool({
    name: 'create_artifact_page',
    arguments: {title: 'Typo', blocks: [{type: 'columns', children: [{type: 'column', props: {span: 12}, children: [{type: 'paragrpah', text: 'x'}]}]}]},
  });
  check('create_artifact_page rejects a NESTED typo type, naming it', isError(artTypo) && /paragrpah/.test(resultText(artTypo)));
  const artBadStruct = await mcp.client.callTool({
    name: 'create_artifact_page',
    arguments: {title: 'BadStruct', blocks: [{type: 'row', children: [{type: 'cell', text: 'x'}]}]},
  });
  check('create_artifact_page rejects a top-level row (same structural guard as append_blocks)',
    isError(artBadStruct) && /"row" block/.test(resultText(artBadStruct)));

  // ── API-4 (direct): delete_block + update_block_props at depth. ───────────────
  console.log('\nAPI-4 (direct): update_block_props merges shallowly and null removes a key');
  const propsPage = await seed.savePage({
    ...blockPage('Props target'),
    data: {
      editor: 'blocks',
      blockdoc: {
        blocks: [
          {id: 'img1', type: 'image', props: {src: 'data:image/png;base64,AAA', alt: 'old', width: 320}},
          {id: 'grp', type: 'group', children: [{id: 'call1', type: 'callout', text: [{t: 'heads up'}], props: {variant: 'info', bg: 'amber'}}]},
        ],
      },
      editorjs: {blocks: []},
      values: [],
      names: [],
    },
  });
  const imgUpd = await mcp.client.callTool({name: 'update_block_props', arguments: {pageId: propsPage.id, blockId: 'img1', props: {alt: 'a chart', width: 640}}});
  check('update_block_props confirms a direct write on an image block', !isError(imgUpd) && resultText(imgUpd).includes('directly'));
  const imgLine = parseTree(resultText(await mcp.client.callTool({name: 'inspect_page_structure', arguments: {pageId: propsPage.id}}))).find((l) => l.id === 'img1')!;
  check('the passed props were merged and the untouched ones survived',
    /"alt":"a chart"/.test(imgLine.raw) && /"width":640/.test(imgLine.raw) && /"src":"data:image/.test(imgLine.raw));

  const calloutUpd = await mcp.client.callTool({name: 'update_block_props', arguments: {pageId: propsPage.id, blockId: 'call1', props: {variant: 'warn', bg: null}}});
  check('update_block_props reaches a NESTED block (inside a group)', !isError(calloutUpd));
  const calloutLine = parseTree(resultText(await mcp.client.callTool({name: 'inspect_page_structure', arguments: {pageId: propsPage.id}}))).find((l) => l.id === 'call1')!;
  check('an explicit null REMOVED the key (and did not store a null)',
    /"variant":"warn"/.test(calloutLine.raw) && !/"bg"/.test(calloutLine.raw));
  check('the block text is untouched by a props update', calloutLine.text === 'heads up');

  const badProps = await mcp.client.callTool({name: 'update_block_props', arguments: {pageId: propsPage.id, blockId: 'nope', props: {level: 2}}});
  check('update_block_props on an unknown id is a clean error naming inspect_page_structure',
    isError(badProps) && /No block "nope"/.test(resultText(badProps)) && /inspect_page_structure/.test(resultText(badProps)));
  const emptyProps = await mcp.client.callTool({name: 'update_block_props', arguments: {pageId: propsPage.id, blockId: 'img1', props: {}}});
  check('update_block_props with no props is refused', isError(emptyProps));

  // should-fix 5.1: the table order-contract private keys (ord/col/col:/colbg:) corrupt a
  // table if written via generic props — refuse them and point at the table tools (API-3 owns those).
  const ordKey = await mcp.client.callTool({name: 'update_block_props', arguments: {pageId: propsPage.id, blockId: 'img1', props: {ord: 'a0'}}});
  check('update_block_props refuses the table `ord` key, pointing at the table tools',
    isError(ordKey) && /ord/.test(resultText(ordKey)) && /table tools/.test(resultText(ordKey)));
  const colKey = await mcp.client.callTool({name: 'update_block_props', arguments: {pageId: propsPage.id, blockId: 'img1', props: {col: 'c1'}}});
  check('update_block_props refuses the cell `col` key', isError(colKey) && /table tools/.test(resultText(colKey)));
  const colRegKey = await mcp.client.callTool({name: 'update_block_props', arguments: {pageId: propsPage.id, blockId: 'img1', props: {'col:abc': 'a0'}}});
  check('update_block_props refuses a `col:` column-registry key', isError(colRegKey) && /table tools/.test(resultText(colRegKey)));
  const colbgKey = await mcp.client.callTool({name: 'update_block_props', arguments: {pageId: propsPage.id, blockId: 'img1', props: {'colbg:abc': 'amber'}}});
  check('update_block_props refuses a `colbg:` column-tint key', isError(colbgKey) && /table tools/.test(resultText(colbgKey)));
  const unchangedByKeyGuard = parseTree(resultText(await mcp.client.callTool({name: 'inspect_page_structure', arguments: {pageId: propsPage.id}}))).find((l) => l.id === 'img1')!;
  check('a refused table-key write left the block untouched',
    !/"ord"/.test(unchangedByKeyGuard.raw) && !/"col"/.test(unchangedByKeyGuard.raw));

  console.log('\nAPI-4 (direct): delete_block removes nested blocks, table rows, and whole containers');
  const rowId = rows[1].id; // the "Apples" row, nested under the table
  const delRow = await mcp.client.callTool({name: 'delete_block', arguments: {pageId: page.id, blockId: rowId}});
  check('delete_block removes a nested table ROW directly', !isError(delRow) && resultText(delRow).includes('directly'));
  const afterRow = parseTree(resultText(await mcp.client.callTool({name: 'inspect_page_structure', arguments: {pageId: page.id}})));
  check('the row and its 3 cells are gone (subtree removed)',
    !afterRow.some((l) => l.id === rowId) && !afterRow.some((l) => l.text === 'Apples') && afterRow.filter((l) => l.type === 'cell').length === 6);
  check('the sibling rows survived', afterRow.some((l) => l.text === 'Pears') && afterRow.some((l) => l.text === 'Item'));

  const delCall = await mcp.client.callTool({name: 'delete_block', arguments: {pageId: propsPage.id, blockId: 'call1'}});
  check('delete_block removes a block nested inside a group', !isError(delCall));
  const delContainer = await mcp.client.callTool({name: 'delete_block', arguments: {pageId: propsPage.id, blockId: 'grp'}});
  check('delete_block removes a whole container', !isError(delContainer));
  const afterDel = parseTree(resultText(await mcp.client.callTool({name: 'inspect_page_structure', arguments: {pageId: propsPage.id}})));
  check('only the image block remains', afterDel.length === 1 && afterDel[0].id === 'img1');

  const badDel = await mcp.client.callTool({name: 'delete_block', arguments: {pageId: propsPage.id, blockId: 'ghost'}});
  check('delete_block on an unknown id is a clean error (nothing deleted)',
    isError(badDel) && /No block "ghost"/.test(resultText(badDel)) && (await seed.getPage(propsPage.id)) !== null);
  const badPage = await mcp.client.callTool({name: 'delete_block', arguments: {pageId: '00000000-0000-0000-0000-000000000000', blockId: 'x'}});
  check('delete_block on an unknown page reports "Page not found"', isError(badPage) && /Page not found/.test(resultText(badPage)));

  // ── should-fix 4.1: a table that loses its LAST row/cell is removed WHOLE. ─────
  console.log('\nAPI-4 (should-fix 4.1): deleting a table\'s last row/cell removes the table (keyed + legacy)');
  const keyedTablePage = await seed.savePage({
    ...blockPage('Keyed table'),
    data: {
      editor: 'blocks',
      blockdoc: {blocks: [
        {id: 'kt', type: 'table', props: {'col:c1': 'a0', 'col:c2': 'a1'}, children: [
          {id: 'kr', type: 'row', props: {ord: 'a0'}, children: [
            {id: 'kc1', type: 'cell', props: {col: 'c1'}, text: [{t: 'A'}]},
            {id: 'kc2', type: 'cell', props: {col: 'c2'}, text: [{t: 'B'}]},
          ]},
        ]},
        {id: 'kp', type: 'paragraph', text: [{t: 'after'}]},
      ]},
      editorjs: {blocks: []}, values: [], names: [],
    },
  });
  const delKeyedRow = await mcp.client.callTool({name: 'delete_block', arguments: {pageId: keyedTablePage.id, blockId: 'kr'}});
  check('deleting the last row of a KEYED table succeeds', !isError(delKeyedRow));
  const kt2 = parseTree(resultText(await mcp.client.callTool({name: 'inspect_page_structure', arguments: {pageId: keyedTablePage.id}})));
  check('the keyed table is removed WHOLE, the sibling paragraph survives',
    !kt2.some((l) => l.type === 'table') && kt2.some((l) => l.text === 'after'));

  const legacyTablePage = await seed.savePage({
    ...blockPage('Legacy table'),
    data: {
      editor: 'blocks',
      blockdoc: {blocks: [
        {id: 'lt', type: 'table', children: [
          {id: 'lr', type: 'row', children: [{id: 'lc1', type: 'cell', text: [{t: 'X'}]}, {id: 'lc2', type: 'cell', text: [{t: 'Y'}]}]},
        ]},
      ]},
      editorjs: {blocks: []}, values: [], names: [],
    },
  });
  const delLegacyRow = await mcp.client.callTool({name: 'delete_block', arguments: {pageId: legacyTablePage.id, blockId: 'lr'}});
  check('deleting the last row of a LEGACY table succeeds', !isError(delLegacyRow));
  const lt2 = parseTree(resultText(await mcp.client.callTool({name: 'inspect_page_structure', arguments: {pageId: legacyTablePage.id}})));
  check('the legacy table is gone and the doc self-heals to one paragraph (never zero-root)',
    !lt2.some((l) => l.type === 'table') && lt2.length === 1 && lt2[0].type === 'paragraph');

  const cellPage = await seed.savePage({
    ...blockPage('1x1 table'),
    data: {
      editor: 'blocks',
      blockdoc: {blocks: [
        {id: 'ct', type: 'table', children: [{id: 'cr', type: 'row', children: [{id: 'cc', type: 'cell', text: [{t: 'solo'}]}]}]},
        {id: 'cp', type: 'paragraph', text: [{t: 'keep'}]},
      ]},
      editorjs: {blocks: []}, values: [], names: [],
    },
  });
  const delCell = await mcp.client.callTool({name: 'delete_block', arguments: {pageId: cellPage.id, blockId: 'cc'}});
  check('deleting the only cell of the only row succeeds', !isError(delCell));
  const ct2 = parseTree(resultText(await mcp.client.callTool({name: 'inspect_page_structure', arguments: {pageId: cellPage.id}})));
  check('the 1×1 table is removed whole, the sibling paragraph survives',
    !ct2.some((l) => l.type === 'table') && ct2.some((l) => l.text === 'keep'));

  // ── should-fix 4.2: delete self-heals empty columns / a zero-root document. ────
  console.log('\nAPI-4 (should-fix 4.2): delete prunes empty containers and never leaves a zero-root doc');
  const colPage = await seed.savePage({
    ...blockPage('Columns prune'),
    data: {
      editor: 'blocks',
      blockdoc: {blocks: [
        {id: 'cols', type: 'columns', children: [
          {id: 'col1', type: 'column', props: {span: 6}, children: [{id: 'left', type: 'paragraph', text: [{t: 'left'}]}]},
          {id: 'col2', type: 'column', props: {span: 6}, children: [{id: 'right', type: 'paragraph', text: [{t: 'right'}]}]},
        ]},
      ]},
      editorjs: {blocks: []}, values: [], names: [],
    },
  });
  const delLeft = await mcp.client.callTool({name: 'delete_block', arguments: {pageId: colPage.id, blockId: 'left'}});
  check('deleting the only block in a column succeeds', !isError(delLeft));
  const cp2 = parseTree(resultText(await mcp.client.callTool({name: 'inspect_page_structure', arguments: {pageId: colPage.id}})));
  check('the emptied column is pruned and the single-column layout is unwrapped',
    !cp2.some((l) => l.type === 'columns') && !cp2.some((l) => l.type === 'column') && cp2.some((l) => l.text === 'right'));

  const onlyPage = await seed.savePage({
    ...blockPage('Only block'),
    data: {editor: 'blocks', blockdoc: {blocks: [{id: 'solo', type: 'paragraph', text: [{t: 'lonely'}]}]}, editorjs: {blocks: []}, values: [], names: []},
  });
  const delOnly = await mcp.client.callTool({name: 'delete_block', arguments: {pageId: onlyPage.id, blockId: 'solo'}});
  check('deleting a page\'s only block succeeds', !isError(delOnly));
  const op2 = parseTree(resultText(await mcp.client.callTool({name: 'inspect_page_structure', arguments: {pageId: onlyPage.id}})));
  check('the page self-heals to exactly one paragraph', op2.length === 1 && op2[0].type === 'paragraph');

  await mcp.close();

  // ── SUGGEST mode: the review-layer parity for all three write paths. ──────────
  console.log('\nPolicy gate: the new tools + nested payloads go through review under suggest');
  await seed.setInstancePolicy({agentEdits: 'suggest'});
  const rPage = await seed.savePage({
    ...blockPage('Review target'),
    data: {
      editor: 'blocks',
      blockdoc: {blocks: [{id: 'r1', type: 'callout', text: [{t: 'review me'}], props: {variant: 'info'}}]},
      editorjs: {blocks: []},
      values: [],
      names: [],
    },
  });
  const sug = await connect(server.url);

  const sAppend = await sug.client.callTool({name: 'append_blocks', arguments: {pageId: rPage.id, blocks: TABLE_PAYLOAD}});
  check('a nested append under suggest is queued, not applied', resultText(sAppend).includes('Suggested for review'));
  const sDel = await sug.client.callTool({name: 'delete_block', arguments: {pageId: rPage.id, blockId: 'r1'}});
  check('delete_block under suggest is queued, not applied', resultText(sDel).includes('Suggested for review'));
  const sProps = await sug.client.callTool({name: 'update_block_props', arguments: {pageId: rPage.id, blockId: 'r1', props: {variant: 'warn'}}});
  check('update_block_props under suggest is queued, not applied', resultText(sProps).includes('Suggested for review'));

  const stored = await seed.listSuggestions(rPage.id);
  const kindOf = (applyKind: string) => stored.find((s) => (s.payload as {applyKind?: string}).applyKind === applyKind);
  const insert = kindOf('append_blocks');
  const del = kindOf('delete_block');
  const props = kindOf('set_block_props');
  check('three suggestions were recorded', stored.length === 3 && Boolean(insert && del && props));
  // THE API-1 regression: the flat zod object used to STRIP `children`, so review
  // replayed a table with no rows. The stored payload must carry the full tree.
  const payloadBlocks = (insert!.payload as {blocks?: Array<{children?: Array<{children?: unknown[]}>}>}).blocks ?? [];
  check('the queued nested payload kept its children (3 rows × 3 cells)',
    payloadBlocks[0]?.children?.length === 3 && payloadBlocks[0]?.children?.[0]?.children?.length === 3);
  check('delete_block maps to the `delete` suggestion kind and targets the block',
    del!.kind === 'delete' && del!.target.blockId === 'r1' && (del!.payload as {blockId?: string}).blockId === 'r1');
  check('update_block_props maps to `replace-text` with applyKind set_block_props (the bridge\'s patchBlock)',
    props!.kind === 'replace-text' && props!.target.blockId === 'r1' &&
    JSON.stringify((props!.payload as {props?: unknown}).props) === '{"variant":"warn"}');
  check('both new suggestions are authored by the MCP client',
    del!.authorKind === 'ai' && del!.authorName === 'MCP client' && props!.authorName === 'MCP client');
  check('the diff card shows a before/after for each',
    del!.before.includes('review me') && del!.after === '' && props!.before.includes('info') && props!.after.includes('warn'));

  const untouched = await seed.getPage(rPage.id);
  check('NOTHING was mutated under suggest (block still there, props unchanged)',
    JSON.stringify(untouched?.data).includes('review me') &&
    JSON.stringify(untouched?.data).includes('"variant":"info"') &&
    !JSON.stringify(untouched?.data).includes('Apples'));

  // A cap violation is refused BEFORE the policy branch, so nothing is queued.
  const sTooDeep = await sug.client.callTool({name: 'append_blocks', arguments: {pageId: rPage.id, blocks: [deepChain(12)]}});
  check('a cap violation errors under suggest too, queueing nothing',
    isError(sTooDeep) && (await seed.listSuggestions(rPage.id)).length === 3);

  await sug.close();
  await server.close();
  rmSync(DATA_DIR, {recursive: true, force: true});
  console.log(`\n✅ ALL ${passed} CHECKS PASSED — nested children over MCP + delete_block / update_block_props.`);
}

main().catch((err: unknown) => {
  console.error('\n❌ MCP nested-blocks test failed:', err);
  process.exit(1);
});
