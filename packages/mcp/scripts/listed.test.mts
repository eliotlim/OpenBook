/** UP-2: MCP discovery tools inherit the underlying DataClient filters. This is
 * intentionally socket-free: the MCP server and client use a linked in-memory
 * transport, while the fake DataClient models the server having already removed
 * an unlisted page from list/search. MCP must not rebuild either enumeration. */
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import type {AiSearchResponse, PageMeta, StoredPage} from '@book.dev/sdk';
import {createOpenBookMcpServer} from '../src/index';

const visibleId = '11111111-1111-4111-8111-111111111111';
const hiddenId = '22222222-2222-4222-8222-222222222222';
const now = new Date(0).toISOString();

const meta = (id: string, name: string, listed: boolean): PageMeta => ({
  id,
  name,
  listed,
  icon: null,
  hostedDatabaseId: null,
  parentId: null,
  deletedAt: null,
  createdAt: now,
  updatedAt: now,
});

const hiddenPage: StoredPage = {
  id: hiddenId,
  name: 'Unlisted MCP note',
  data: {
    editorjs: {blocks: [{type: 'paragraph', data: {text: 'directly readable'}}]},
    values: [],
    names: [],
  },
  hostedDatabaseId: null,
  databaseId: null,
  parentId: null,
  properties: {},
  deletedAt: null,
  createdAt: now,
  updatedAt: now,
};

let listCalls = 0;
let searchCalls = 0;
const underlying = {
  async listPages(): Promise<PageMeta[]> {
    listCalls += 1;
    return [meta(visibleId, 'Discoverable MCP note', true)];
  },
  async aiSearch(): Promise<AiSearchResponse> {
    searchCalls += 1;
    return {
      mode: 'lexical',
      results: [{pageId: visibleId, title: 'Discoverable MCP note', snippet: 'listed result', score: 1}],
    };
  },
  async getPage(id: string): Promise<StoredPage | null> {
    return id === hiddenId ? hiddenPage : null;
  },
  async getEffectiveAgentEdits(): Promise<'suggest'> {
    return 'suggest';
  },
} as unknown as Parameters<typeof createOpenBookMcpServer>[0];

const resultText = (res: {content?: unknown}): string =>
  ((res.content as Array<{type: string; text?: string}> | undefined) ?? [])
    .filter((entry) => entry.type === 'text')
    .map((entry) => entry.text ?? '')
    .join('\n');

const server = createOpenBookMcpServer(underlying);
const client = new Client({name: 'openbook-mcp-listed-test', version: '0.0.0'});
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

try {
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const listed = resultText(await client.callTool({name: 'list_pages', arguments: {}}));
  assert.match(listed, new RegExp(visibleId));
  assert.doesNotMatch(listed, new RegExp(hiddenId));
  assert.equal(listCalls, 1, 'list_pages delegates once to DataClient.listPages');

  const searched = resultText(await client.callTool({name: 'search_notes', arguments: {query: 'note'}}));
  assert.match(searched, new RegExp(visibleId));
  assert.doesNotMatch(searched, new RegExp(hiddenId));
  assert.equal(searchCalls, 1, 'search_notes delegates once to DataClient.aiSearch');

  const direct = resultText(await client.callTool({name: 'read_page', arguments: {pageId: hiddenId}}));
  assert.match(direct, /Unlisted MCP note/);
  assert.match(direct, /directly readable/);
  console.log('✅ ALL 3 MCP LISTED CONTRACT CHECKS PASSED');
} finally {
  await client.close();
  await server.close();
}
