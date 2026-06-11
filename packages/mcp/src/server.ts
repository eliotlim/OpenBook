import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {z} from 'zod';
import {
  appendTextToSnapshot,
  snapshotText,
  textSnapshot,
  type DataClient,
} from '@open-book/sdk';

/**
 * The OpenBook MCP server: exposes a workspace to any MCP client (Claude
 * Desktop, Claude Code, …) as a set of tools over the same `@open-book/sdk`
 * contract the apps use. Read tools degrade gracefully (search is lexical
 * BM25 even with the AI engine off); write tools share the SDK's content
 * helpers with the in-app agent, so both honour the same rules (e.g. pages
 * owned by the collaborative editor are never appended to blindly).
 */

const clip = (s: string, n = 4000): string => (s.length > n ? `${s.slice(0, n)}…` : s);

const text = (value: string) => ({content: [{type: 'text' as const, text: value}]});
const failure = (value: string) => ({content: [{type: 'text' as const, text: value}], isError: true});

export function createOpenBookMcpServer(client: DataClient, version = '0.1.0'): McpServer {
  const server = new McpServer({name: 'openbook', version});

  server.registerTool(
    'list_pages',
    {
      title: 'List pages',
      description: 'List workspace pages (id and title), most recently updated first.',
      inputSchema: {},
    },
    async () => {
      const pages = await client.listPages();
      if (pages.length === 0) return text('The workspace has no pages yet.');
      return text(pages.map((p) => `- [${p.id}] ${p.name ?? 'Untitled'}`).join('\n'));
    },
  );

  server.registerTool(
    'read_page',
    {
      title: 'Read a page',
      description: 'Read the full text of one page by id.',
      inputSchema: {pageId: z.string().describe('The page id (from list_pages or search_notes).')},
    },
    async ({pageId}) => {
      const page = await client.getPage(pageId);
      if (!page) return failure('Page not found.');
      return text(`Title: ${page.name ?? 'Untitled'}\n\n${clip(snapshotText(page.data) || '(empty page)')}`);
    },
  );

  server.registerTool(
    'search_notes',
    {
      title: 'Search notes',
      description:
        'Search every note/page in the workspace; returns ranked matches with snippets. Works without an AI model (keyword ranking) and upgrades to semantic ranking when the server has one.',
      inputSchema: {
        query: z.string().describe('What to look for.'),
        limit: z.number().int().min(1).max(25).optional().describe('Max results (default 8).'),
      },
    },
    async ({query, limit}) => {
      const res = await client.aiSearch(query, limit ?? 8);
      if (res.results.length === 0) return text('No matching notes.');
      return text(res.results.map((r) => `- [${r.pageId}] ${r.title}: ${r.snippet}`).join('\n'));
    },
  );

  server.registerTool(
    'create_page',
    {
      title: 'Create a page',
      description: 'Create a new page with a title and optional text content (one paragraph per line).',
      inputSchema: {
        title: z.string().describe('The page title (must be unique in the workspace).'),
        content: z.string().optional().describe('Plain-text body; each line becomes a paragraph.'),
      },
    },
    async ({title, content}) => {
      const name = title.trim();
      if (!name) return failure('A title is required.');
      try {
        const page = await client.savePage({name, data: textSnapshot(content ?? '', 'mcp')});
        return text(`Created page "${name}" with id ${page.id}.`);
      } catch (err) {
        return failure(`Could not create the page: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );

  server.registerTool(
    'append_to_page',
    {
      title: 'Append to a page',
      description: 'Append text to the end of an existing page (one paragraph per line).',
      inputSchema: {
        pageId: z.string().describe('The page id.'),
        content: z.string().describe('Plain-text to append; each line becomes a paragraph.'),
      },
    },
    async ({pageId, content}) => {
      const page = await client.getPage(pageId);
      if (!page) return failure('Page not found.');
      const data = appendTextToSnapshot(page.data, content, `mcp-${Date.now().toString(36)}`);
      if (!data) {
        return failure('This page uses the collaborative editor and cannot be appended to from here — create a new page instead.');
      }
      if (data === page.data) return failure('Nothing to append.');
      await client.savePage({id: page.id, name: page.name, data});
      return text(`Appended to "${page.name ?? 'Untitled'}".`);
    },
  );

  server.registerTool(
    'list_database_rows',
    {
      title: 'List database rows',
      description: 'List the rows of the database hosted on a page (each row’s id, title, and properties).',
      inputSchema: {pageId: z.string().describe('The id of the page that hosts the database.')},
    },
    async ({pageId}) => {
      const database = await client.getPageDatabase(pageId);
      if (!database) return failure('That page hosts no database.');
      const rows = await client.listRows(database.id);
      if (rows.length === 0) return text(`Database "${database.name ?? 'Untitled'}" has no rows.`);
      const lines = rows.map((r) => `- [${r.id}] ${r.name ?? 'Untitled'} ${JSON.stringify(r.properties ?? {})}`);
      return text(`Database "${database.name ?? 'Untitled'}" (${database.id}):\n${lines.join('\n')}`);
    },
  );

  server.registerTool(
    'create_database_row',
    {
      title: 'Create a database row',
      description: 'Add a row to the database hosted on a page, optionally with a title and property values.',
      inputSchema: {
        pageId: z.string().describe('The id of the page that hosts the database.'),
        name: z.string().optional().describe('The row title.'),
        properties: z.record(z.unknown()).optional().describe('Property values keyed by property id.'),
      },
    },
    async ({pageId, name, properties}) => {
      const database = await client.getPageDatabase(pageId);
      if (!database) return failure('That page hosts no database.');
      const row = await client.createRow(database.id, {name: name ?? null, properties});
      return text(`Created row "${row.name ?? 'Untitled'}" with id ${row.id} in database "${database.name ?? 'Untitled'}".`);
    },
  );

  return server;
}
